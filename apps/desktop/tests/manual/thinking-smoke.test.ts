import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import type { RuntimeStartOptions } from '../../src/main/services/runtime'

// MANUAL thinking-mode smoke (Phase 20, plan §13 D5 live verification) — NOT part of CI.
//
// CI stays zero-network/zero-model/zero-binary, so this file is skipped unless
// PAID_THINKING_SMOKE points at a provisioned drive root (same shape as PAID_GPU_SMOKE):
//
//   PAID_THINKING_SMOKE=<root with runtime/llama.cpp/<os>/llama-server + models/chat/*.gguf>
//   npx vitest run tests/manual/thinking-smoke.test.ts
//
// Against the REAL pinned b9585 build + a real Qwen3 GGUF this proves the D5 mechanism
// end-to-end: `chat_template_kwargs.enable_thinking` is honoured per request, Deep mode
// streams its reasoning as separate `delta.reasoning_content` frames (never inline
// `<think>` tags in the answer), and Balanced produces a direct answer with NO
// reasoning deltas at all.

const ROOT = process.env.PAID_THINKING_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

/** Generous health budget: the smoke loads a multi-GB model from a possibly-cold disk. */
const PATIENT_MS = 240_000

function firstChatModel(root: string): string | null {
  const dir = join(root, 'models', 'chat')
  if (!existsSync(dir)) return null
  // PAID_SMOKE_MODEL pins an explicit filename; otherwise prefer the SMALLEST chat model
  // so the smoke runs on modest laptops, not just the dev workstation — the thinking
  // mechanism (enable_thinking per request) doesn't depend on model size.
  const override = process.env.PAID_SMOKE_MODEL?.trim()
  if (override) {
    const p = join(dir, override)
    return existsSync(p) ? p : null
  }
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs.length ? ggufs[0].path : null
}

describe.skipIf(!enabled)('Thinking-mode smoke (manual, real b9585 + real Qwen3)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const modelPath = enabled ? firstChatModel(ROOT) : null
  const opts: RuntimeStartOptions = {
    modelId: 'smoke-thinking-model',
    modelPath: modelPath ?? '/missing.gguf',
    contextTokens: 2048
  }

  it('deep streams separate reasoning deltas; balanced streams none', { timeout: 600_000 }, async () => {
    expect(binPath).toBeTruthy()
    expect(modelPath).toBeTruthy()
    const runtime = createLlamaRuntime(opts, { binPath: binPath!, healthTimeoutMs: PATIENT_MS })
    await runtime.start()
    try {
      const question = 'Which is larger, 17 × 24 or 20 × 21? Answer in one short sentence.'

      // Deep: thinking ON → reasoning arrives via onReasoning, the answer stays clean.
      const deepReasoning: string[] = []
      const deepAnswer: string[] = []
      for await (const t of runtime.chatStream([{ role: 'user', content: question }], {
        mode: 'deep',
        onReasoning: (d) => deepReasoning.push(d)
      })) {
        deepAnswer.push(t)
      }
      console.log('deep reasoning chars:', deepReasoning.join('').length)
      console.log('deep answer:', JSON.stringify(deepAnswer.join('').slice(0, 200)))
      expect(deepReasoning.join('').length).toBeGreaterThan(0)
      expect(deepAnswer.join('').length).toBeGreaterThan(0)
      expect(deepAnswer.join('')).not.toContain('<think>')

      // Balanced: thinking explicitly OFF → a direct answer, zero reasoning deltas.
      const balReasoning: string[] = []
      const balAnswer: string[] = []
      for await (const t of runtime.chatStream([{ role: 'user', content: question }], {
        onReasoning: (d) => balReasoning.push(d)
      })) {
        balAnswer.push(t)
      }
      console.log('balanced answer:', JSON.stringify(balAnswer.join('').slice(0, 200)))
      expect(balReasoning.join('')).toBe('')
      expect(balAnswer.join('').length).toBeGreaterThan(0)
      expect(balAnswer.join('')).not.toContain('<think>')
    } finally {
      await runtime.stop()
    }
  })
})
