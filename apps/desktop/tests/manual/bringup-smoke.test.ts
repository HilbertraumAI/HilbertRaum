import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import type { RuntimeStartOptions } from '../../src/main/services/runtime'

// MANUAL Phase-28 challenger bring-up smoke (model-benchmarks.md §7.3) — NOT CI.
//
// CI stays zero-network/zero-model/zero-binary, so this file is skipped unless
// PAID_BRINGUP_SMOKE points at a provisioned drive root (same shape as the other manual
// smokes):
//
//   PAID_BRINGUP_SMOKE=<root with runtime/llama.cpp/<os>/llama-server + models/chat/*.gguf>
//   PAID_SMOKE_MODEL=<one .gguf filename>   # optional: smoke a single model
//   npx vitest run tests/manual/bringup-smoke.test.ts
//
// Against the REAL pinned b9585 build + a real challenger GGUF this proves the §4.3
// chat/depth bring-up per model:
//   - the GGUF loads and `/health` reports ready  -> the embedded chat template renders
//     through `--jinja` on b9585 (no runtime bump needed; the §3.1 claim, live)
//   - a German question is answered IN German with the correct fact, and streaming yields
//     tokens incrementally
//   - NO chat-template artifacts leak into the answer (role/turn markers for ChatML,
//     Gemma, and Mistral templates)
//   - Deep mode (enable_thinking ON) still yields a clean, non-empty answer and never
//     crashes. NOTE (bring-up finding 2026-06-10): plan §4.1 expected "Deep simply
//     behaves like Balanced" for every challenger, but Gemma 4's chat template DOES honour
//     `enable_thinking` and streams a chain-of-thought as `reasoning_content`; the other
//     three ignore the kwarg (zero reasoning). So whether Deep deliberates is RECORDED, not
//     asserted — and it is moot in-product anyway: the composer only offers "Thorough"
//     (Deep) for models with `supports_thinking_mode: true`, which none of these set.
//
// The RAG/citation + Models-screen-UI parts of §4.3 are exercised in the app, not here.

const ROOT = process.env.PAID_BRINGUP_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

/** Generous health budget: loads a multi-GB model from a possibly-cold disk on first run. */
const PATIENT_MS = 300_000

/** The four Phase-28 wave-1 challengers + the German fact each answer must contain. */
const CHALLENGERS = [
  { file: 'ministral3-8b-instruct-2512-q4.gguf', label: 'Ministral 3 8B 2512' },
  { file: 'granite-4.1-8b-q4.gguf', label: 'Granite 4.1 8B' },
  { file: 'gemma4-12b-it-qat-q4.gguf', label: 'Gemma 4 12B QAT' },
  { file: 'qwen3-4b-instruct-2507-q4.gguf', label: 'Qwen3 4B Instruct 2507' }
]

// Chat-template markers that must NEVER appear in answer text (ChatML / Gemma / Mistral).
const TEMPLATE_ARTIFACTS = [
  '<|im_start|>',
  '<|im_end|>',
  '<start_of_turn>',
  '<end_of_turn>',
  '<|start_header_id|>',
  '<think>',
  '</think>',
  '[INST]',
  '[/INST]'
]

// Common German function words — a cheap "answered in German, not English" signal.
const GERMAN_WORDS = ['ist', 'die', 'der', 'und', 'ein', 'eine', 'in', 'von', 'das', 'durch']

// A factual German prompt whose answer pins a proper noun (correctness) and forces German
// output. Vienna = Wien; the Danube = Donau flows through it.
const QUESTION =
  'Beantworte auf Deutsch in einem kurzen Satz: Was ist die Hauptstadt von Österreich, ' +
  'und wie heißt der große Fluss, der durch sie fließt?'
const EXPECTED_FACT = 'Wien'

const override = process.env.PAID_SMOKE_MODEL?.trim()
const models = override ? CHALLENGERS.filter((m) => m.file === override) : CHALLENGERS

function assertClean(answer: string): void {
  for (const a of TEMPLATE_ARTIFACTS) {
    expect(answer, `answer leaked template artifact ${a}`).not.toContain(a)
  }
}

describe.skipIf(!enabled)('Phase-28 challenger bring-up smoke (manual, real b9585)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null

  for (const model of models) {
    const modelPath = enabled ? join(ROOT, 'models', 'chat', model.file) : ''
    const present = enabled && existsSync(modelPath)

    it.skipIf(!present)(
      `${model.label}: loads, answers German, no template leak, Deep yields a clean answer`,
      { timeout: 600_000 },
      async () => {
        expect(binPath, 'llama-server binary not found on the drive').toBeTruthy()

        const opts: RuntimeStartOptions = {
          modelId: model.file.replace(/\.gguf$/, ''),
          modelPath,
          contextTokens: 2048
        }
        const runtime = createLlamaRuntime(opts, { binPath: binPath!, healthTimeoutMs: PATIENT_MS })
        await runtime.start() // throws if the GGUF won't load / template won't render on b9585
        try {
          // --- Balanced: thinking explicitly OFF -> direct German answer, zero reasoning.
          const balReasoning: string[] = []
          const balDeltas: string[] = []
          for await (const t of runtime.chatStream([{ role: 'user', content: QUESTION }], {
            onReasoning: (d) => balReasoning.push(d)
          })) {
            balDeltas.push(t)
          }
          const balAnswer = balDeltas.join('')
          console.log(`\n[${model.label}] balanced answer:`, JSON.stringify(balAnswer.slice(0, 400)))

          expect(balDeltas.length, 'no streamed deltas — streaming broken').toBeGreaterThan(0)
          expect(balAnswer.trim().length).toBeGreaterThan(0)
          assertClean(balAnswer)
          expect(balReasoning.join(''), 'balanced must emit no reasoning').toBe('')
          expect(balAnswer).toContain(EXPECTED_FACT) // German fact present (Wien)
          const germanHit = GERMAN_WORDS.some((w) =>
            new RegExp(`\\b${w}\\b`, 'i').test(balAnswer)
          )
          expect(germanHit, 'answer does not look German').toBe(true)

          // --- Deep: enable_thinking ON. Bring-up only requires a clean, non-empty answer
          // that never crashes; whether the model deliberates is recorded (see header note —
          // Gemma 4 honours the kwarg, the others ignore it), not asserted.
          const deepReasoning: string[] = []
          const deepDeltas: string[] = []
          for await (const t of runtime.chatStream([{ role: 'user', content: QUESTION }], {
            mode: 'deep',
            onReasoning: (d) => deepReasoning.push(d)
          })) {
            deepDeltas.push(t)
          }
          const deepAnswer = deepDeltas.join('')
          console.log(
            `[${model.label}] deep reasoning chars:`,
            deepReasoning.join('').length,
            '| deep answer:',
            JSON.stringify(deepAnswer.slice(0, 200))
          )
          expect(deepAnswer.trim().length).toBeGreaterThan(0)
          assertClean(deepAnswer)
        } finally {
          await runtime.stop()
        }
      }
    )
  }
})
