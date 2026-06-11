import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import type { ChatMessage } from '../../src/main/services/runtime'

// MANUAL R-T1 probe (Phase 33, wave-3 plan §14) — NOT CI.
//
// Question: what does the REAL pinned b9585 llama-server do, at our default spawn args
// (no `--parallel`), when a second /v1/chat/completions arrives while one is streaming?
// Queued? Served on a parallel slot? Rejected?
//
// INFORMATIONAL ONLY: D26 already resolved concurrency app-side (strict one-at-a-time —
// the app never sends two requests). This probe confirms the app-side guard is airtight
// (what WOULD happen if it weren't) and banks the facts for a future parallelism
// revisit. Record the findings in functionality-wave-3-plan §14.
//
// CI stays zero-network/zero-model/zero-binary, so this file is skipped unless
// PAID_CONCURRENCY_PROBE points at a provisioned drive root (the PAID_GPU_SMOKE shape):
//
//   PAID_CONCURRENCY_PROBE=<root with runtime/llama.cpp/<os>/llama-server + models/chat/*.gguf>
//   npx vitest run tests/manual/server-concurrency-probe.test.ts

const ROOT = process.env.PAID_CONCURRENCY_PROBE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

/** Generous health budget: weights may come from a cold USB drive. */
const PATIENT_MS = 240_000

/** The smallest chat GGUF on the drive (probe speed, not quality). */
function smallestChatModel(root: string): string | null {
  const dir = join(root, 'models', 'chat')
  if (!existsSync(dir)) return null
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs[0]?.path ?? null
}

interface StreamObservation {
  label: string
  startedAt: number
  firstTokenAt: number | null
  doneAt: number | null
  tokens: number
  error: string | null
}

describe.skipIf(!enabled)('R-T1: llama-server b9585 concurrent-request behavior (manual)', () => {
  it(
    'observes a second chat request issued while the first streams',
    { timeout: 600_000 },
    async () => {
      const binPath = resolveLlamaServerPath(ROOT, process.platform, {})
      const modelPath = smallestChatModel(ROOT)
      expect(binPath, 'llama-server binary on the drive').toBeTruthy()
      expect(modelPath, 'a chat GGUF under models/chat').toBeTruthy()

      const runtime = createLlamaRuntime(
        { modelId: 'concurrency-probe', modelPath: modelPath!, contextTokens: 4096 },
        { binPath: binPath!, healthTimeoutMs: PATIENT_MS }
      )
      await runtime.start()
      try {
        const health = await runtime.health()
        expect(health.healthy).toBe(true)
        console.log(`probe: server healthy on port ${health.port}`)

        const t0 = Date.now()
        const observe = async (
          label: string,
          prompt: string,
          maxTokens: number
        ): Promise<StreamObservation> => {
          const obs: StreamObservation = {
            label,
            startedAt: Date.now() - t0,
            firstTokenAt: null,
            doneAt: null,
            tokens: 0,
            error: null
          }
          const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
          try {
            for await (const _token of runtime.chatStream(messages, {
              maxTokens,
              temperature: 0.7
            })) {
              obs.tokens += 1
              if (obs.firstTokenAt === null) obs.firstTokenAt = Date.now() - t0
            }
            obs.doneAt = Date.now() - t0
          } catch (err) {
            obs.error = err instanceof Error ? err.message : String(err)
            obs.doneAt = Date.now() - t0
          }
          return obs
        }

        // Request A: a long generation. Request B: fired 1.5 s into A's stream.
        const aPromise = observe('A (long)', 'Count slowly from 1 to 200, one number per line.', 700)
        await new Promise((r) => setTimeout(r, 1500))
        const bPromise = observe('B (short, concurrent)', 'Say exactly: hello.', 32)
        const [a, b] = await Promise.all([aPromise, bPromise])

        console.log('--- R-T1 observations (ms since t0) ---')
        for (const o of [a, b]) {
          console.log(
            `${o.label}: started=${o.startedAt} firstToken=${o.firstTokenAt} done=${o.doneAt} ` +
              `tokens=${o.tokens} error=${o.error ?? 'none'}`
          )
        }

        // Interpretation, printed for the plan §14 record:
        if (b.error) {
          console.log('VERDICT: second request REJECTED while one streams.')
        } else if (a.doneAt != null && b.firstTokenAt != null && b.firstTokenAt >= a.doneAt - 50) {
          console.log('VERDICT: second request QUEUED — B’s first token only after A finished.')
        } else {
          console.log('VERDICT: PARALLEL slot — B streamed while A was still streaming.')
        }

        // The probe itself only asserts both requests eventually resolved sanely.
        expect(a.tokens).toBeGreaterThan(0)
        expect(b.error !== null || b.tokens > 0).toBe(true)
      } finally {
        await runtime.stop()
      }
    }
  )
})
