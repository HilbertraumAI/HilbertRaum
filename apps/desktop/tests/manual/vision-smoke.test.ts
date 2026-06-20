import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { VisionRuntime } from '../../src/main/services/vision/runtime'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'

// MANUAL vision smoke (image-understanding plan §15 / §16 Phase V5) — NOT part of CI.
//
// CI stays zero-network/zero-model/zero-binary (the green gate: zero vision models ⇒
// available:false and the suite is green), so this whole file is skipped unless
// HILBERTRAUM_VISION_SMOKE points at a provisioned drive root carrying the REAL b9585
// llama-server PLUS the off-repo vision weights under models/vision/ (the GGUF + its mmproj):
//
//   HILBERTRAUM_VISION_SMOKE=<root with runtime/llama.cpp/<os>/llama-server + models/vision/*.gguf>
//   npx vitest run tests/manual/vision-smoke.test.ts
//
// Against the REAL pinned b9585 build + the real Qwen2.5-VL-3B-Instruct GGUF + f16 mmproj
// (the V1-chosen production candidate; SHAs/sizes in BUILD_STATE V1) this exercises the
// VisionRuntime end-to-end — the thing the fake-fetch unit tests cannot:
//   1. cold start: `--mmproj` loads multimodal on the pin (the V1 gate, re-proven live),
//   2. analyze a fixture image over loopback + STREAM the answer (real SSE → readChatSSE),
//   3. cache_prompt reuse across a follow-up on the SAME warm sidecar,
//   4. the RUNTIME-4 idle teardown fires after the (small, test-set) idle window, then a
//      fresh analyze cold-restarts cleanly.
// It records the headline numbers (cold-start, TTFA, decode tok/s) via console.log; peak RSS
// co-resident is captured separately with `scripts/measure-peak-rss.ps1` (model-benchmarks §C),
// and the numbers as measured land in docs/model-benchmarks.md §8.

const ROOT = process.env.HILBERTRAUM_VISION_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

/** Generous health budget: a ~3.3 GB two-file model loaded from a possibly-cold USB drive. */
const PATIENT_MS = 300_000

/** The committed synthetic, content-free fixture (tests/fixtures/vision/chart.png). */
const FIXTURE = join(__dirname, '..', 'fixtures', 'vision', 'chart.png')

/** Find the vision LM GGUF + its mmproj projector under models/vision/ (the V2 drive layout). */
function findVisionFiles(root: string): { modelPath: string; projectorPath: string } | null {
  const dir = join(root, 'models', 'vision')
  if (!existsSync(dir)) return null
  const ggufs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.gguf'))
  const projector = ggufs.find((f) => /mmproj/i.test(f))
  const model = ggufs.find((f) => !/mmproj/i.test(f))
  if (!model || !projector) return null
  return { modelPath: join(dir, model), projectorPath: join(dir, projector) }
}

describe.skipIf(!enabled)('Vision smoke (manual, real b9585 + real Qwen2.5-VL + mmproj)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, process.env) : null
  const files = enabled ? findVisionFiles(ROOT) : null

  it('cold-starts, analyzes a fixture image, streams an answer, reuses the prefill, and idle-tears-down then cold-restarts', { timeout: 600_000 }, async () => {
    expect(binPath).toBeTruthy()
    expect(files).toBeTruthy()
    expect(existsSync(FIXTURE)).toBe(true)
    const imageBytes = new Uint8Array(readFileSync(FIXTURE))
    console.log(`fixture: ${FIXTURE} (${imageBytes.byteLength} bytes)`)
    console.log(`model: ${files!.modelPath}`)
    console.log(`mmproj: ${files!.projectorPath}`)

    // A SMALL idle window so the teardown/cold-restart path runs in the smoke (production
    // default is DEFAULT_VISION_IDLE_MS / HILBERTRAUM_VISION_IDLE_MS, §19.13). 4 s is well
    // clear of an in-flight analyze and exercises the rearm-on-settle interlock.
    const IDLE_MS = 4_000
    const runtime = new VisionRuntime({
      modelId: 'smoke-vision',
      binPath: binPath!,
      modelPath: files!.modelPath,
      projectorPath: files!.projectorPath,
      contextTokens: 4096,
      healthTimeoutMs: PATIENT_MS,
      idleTimeoutMs: IDLE_MS
    })

    try {
      // (1) Cold start + first analyze: measure cold-start, TTFA, and decode rate.
      const t0 = Date.now()
      let firstTokenAt = 0
      let tokens = 0
      const answer = await runtime.analyze({
        imageBytes,
        mimeType: 'image/png',
        question: 'Explain what this chart appears to show. Mention the bars and any trend.',
        onToken: () => {
          if (firstTokenAt === 0) firstTokenAt = Date.now()
          tokens++
        }
      })
      const totalMs = Date.now() - t0
      const ttfaMs = firstTokenAt ? firstTokenAt - t0 : totalMs
      const decodeMs = firstTokenAt ? Date.now() - firstTokenAt : 0
      console.log(`first analyze: ${answer.length} chars, ${tokens} token-deltas`)
      console.log(`  cold-start+TTFA = ${ttfaMs} ms | total = ${totalMs} ms | decode ≈ ${
        decodeMs > 0 ? (tokens / (decodeMs / 1000)).toFixed(1) : 'n/a'
      } tok/s`)
      console.log(`  answer: ${JSON.stringify(answer.slice(0, 240))}`)
      expect(answer.trim().length).toBeGreaterThan(0)

      // (2) Follow-up on the WARM sidecar — the V1 cache_prompt reuse pays the image prefill
      //     ONCE, so this should be markedly faster to first token than the cold path.
      const w0 = Date.now()
      let warmFirstAt = 0
      const followUp = await runtime.analyze({
        imageBytes,
        mimeType: 'image/png',
        question: 'How many bars are there, and which is the tallest?',
        onToken: () => {
          if (warmFirstAt === 0) warmFirstAt = Date.now()
        }
      })
      console.log(`warm follow-up TTFA = ${(warmFirstAt || Date.now()) - w0} ms | ${followUp.length} chars`)
      expect(followUp.trim().length).toBeGreaterThan(0)

      // (3) Idle teardown (RUNTIME-4): leave the sidecar idle past IDLE_MS, then a fresh
      //     analyze must cold-restart a NEW child and still answer.
      await new Promise((r) => setTimeout(r, IDLE_MS + 2_000))
      const c0 = Date.now()
      const afterRestart = await runtime.analyze({
        imageBytes,
        mimeType: 'image/png',
        question: 'In one sentence, what kind of image is this?'
      })
      console.log(`post-idle cold-restart analyze = ${Date.now() - c0} ms | ${afterRestart.length} chars`)
      expect(afterRestart.trim().length).toBeGreaterThan(0)
    } finally {
      await runtime.stop()
    }
  })
})
