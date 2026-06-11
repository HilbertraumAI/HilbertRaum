import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import { containsGold } from '../eval/score'

// MANUAL Phase-29 Gemma thinking-quality check (model-benchmarks.md §6 / the Gemma
// `supports_thinking_mode` flag decision) — NOT CI.
//
//   PAID_GEMMA_THINKING=<root with runtime/llama.cpp/<os>/llama-server + models/chat/gemma4-...gguf>
//   PAID_GEMMA_MODEL=gemma4-12b-it-qat-q4.gguf   # optional override
//   npx vitest run tests/manual/gemma-thinking.test.ts
//
// Gemma 4's chat template honours `enable_thinking` (Phase-28 bring-up), but it ships
// supports_thinking_mode:false. The flag should only be flipped if Deep mode actually IMPROVES
// answers. This runs a small set of reasoning items (incl. the classic traps where deliberation
// helps) BALANCED (thinking off) vs DEEP (thinking on) at temperature 0, scores each with the
// same containment check the RAG scorer uses, and reports balanced-vs-deep correctness + mean
// reasoning length. DECISION RULE: flip the flag iff Deep >= Balanced on correctness AND Deep
// emits real reasoning (a non-empty chain-of-thought) — i.e. thinking helps and isn't inert.

const ROOT = process.env.PAID_GEMMA_THINKING?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)
const PATIENT_MS = 300_000
const MODEL = process.env.PAID_GEMMA_MODEL?.trim() || 'gemma4-12b-it-qat-q4.gguf'

interface ReasoningItem {
  id: string
  question: string
  answer: string[] // accepted gold spans (containment match)
  trap?: boolean // a classic item where naive answering fails and deliberation helps
}

const ITEMS: ReasoningItem[] = [
  { id: 'train-arrival', question: 'Ein Zug fährt um 14:30 ab und die Fahrt dauert 1 Stunde und 45 Minuten. Wann kommt er an? Antworte nur mit der Uhrzeit.', answer: ['16:15'] },
  { id: 'discount', question: 'Ein Hemd kostet 80 Euro und wird um 25 % reduziert. Was ist der neue Preis?', answer: ['60 euro', '60'] },
  { id: 'multiply', question: 'What is 17 times 23? Give only the number.', answer: ['391'] },
  { id: 'syllogism', question: 'All roses are flowers. Some flowers fade quickly. Does it follow that all roses fade quickly? Answer yes or no, then explain briefly.', answer: ['no'], trap: true },
  { id: 'snail', question: 'Eine Schnecke klettert tagsüber 3 Meter hoch und rutscht nachts 2 Meter zurück. Wie viele Tage braucht sie, um aus einem 10 Meter tiefen Brunnen zu klettern?', answer: ['8', 'acht'], trap: true },
  { id: 'bat-ball', question: 'A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much does the ball cost?', answer: ['0.05', '5 cents', '0,05', '5 cent'], trap: true },
  { id: 'minutes', question: 'Wie viele Minuten sind 2,5 Stunden? Antworte nur mit der Zahl.', answer: ['150'] },
  { id: 'sort', question: 'Sortiere diese Zahlen aufsteigend: 8, 3, 11, 5.', answer: ['3 5 8 11'] }
]

async function answerOnce(
  runtime: ReturnType<typeof createLlamaRuntime>,
  question: string,
  mode?: 'deep'
): Promise<{ answer: string; reasoningChars: number }> {
  const reasoning: string[] = []
  const deltas: string[] = []
  const opts = mode
    ? { mode, onReasoning: (d: string) => reasoning.push(d), temperature: 0 as const }
    : { onReasoning: (d: string) => reasoning.push(d), temperature: 0 as const }
  for await (const t of runtime.chatStream([{ role: 'user', content: question }], opts)) {
    deltas.push(t)
  }
  return { answer: deltas.join(''), reasoningChars: reasoning.join('').length }
}

describe.skipIf(!enabled)('Phase-29 Gemma thinking-quality (manual, real b9585)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const modelPath = enabled ? join(ROOT, 'models', 'chat', MODEL) : ''

  it.skipIf(!(enabled && existsSync(modelPath)))(
    'measures whether Deep mode improves Gemma 4 answers (flip the flag iff Deep >= Balanced)',
    { timeout: 60 * 60 * 1000 },
    async () => {
      expect(binPath, 'llama-server binary not found').toBeTruthy()
      const runtime = createLlamaRuntime(
        { modelId: MODEL.replace(/\.gguf$/, ''), modelPath, contextTokens: 4096 },
        { binPath: binPath!, healthTimeoutMs: PATIENT_MS }
      )
      await runtime.start()
      const rows: Array<Record<string, unknown>> = []
      let balOk = 0
      let deepOk = 0
      let deepReasoningTotal = 0
      try {
        for (const item of ITEMS) {
          const bal = await answerOnce(runtime, item.question)
          const deep = await answerOnce(runtime, item.question, 'deep')
          const balCorrect = containsGold(bal.answer, item.answer)
          const deepCorrect = containsGold(deep.answer, item.answer)
          if (balCorrect) balOk++
          if (deepCorrect) deepOk++
          deepReasoningTotal += deep.reasoningChars
          // eslint-disable-next-line no-console
          console.log(
            `[${item.id}${item.trap ? ' (trap)' : ''}] balanced=${balCorrect ? 'OK' : 'X '} deep=${
              deepCorrect ? 'OK' : 'X '
            } | deep reasoning ${deep.reasoningChars} chars`
          )
          rows.push({
            id: item.id, trap: !!item.trap, balCorrect, deepCorrect,
            deepReasoningChars: deep.reasoningChars,
            balAnswer: bal.answer.slice(0, 300), deepAnswer: deep.answer.slice(0, 300)
          })
        }
      } finally {
        await runtime.stop()
      }

      const n = ITEMS.length
      const deepEmitsReasoning = deepReasoningTotal > 0
      const flipRecommended = deepOk >= balOk && deepEmitsReasoning
      // eslint-disable-next-line no-console
      console.log(
        `\nBalanced ${balOk}/${n} correct | Deep ${deepOk}/${n} correct | Deep emits reasoning: ${deepEmitsReasoning}` +
          `\nFLIP supports_thinking_mode -> ${flipRecommended ? 'YES' : 'NO'} (rule: Deep >= Balanced AND Deep deliberates)`
      )

      const outDir = resolve(__dirname, '../../../../eval/results')
      mkdirSync(outDir, { recursive: true })
      const machine = (process.env.PAID_EVAL_MACHINE?.trim() || hostname()).replace(/[^A-Za-z0-9._-]+/g, '_')
      writeFileSync(
        join(outDir, `gemma-thinking-${machine}.json`),
        JSON.stringify({ model: MODEL, balOk, deepOk, n, deepEmitsReasoning, flipRecommended, rows }, null, 2),
        'utf8'
      )
      // Bring-up already proved Deep yields a clean answer; assert only that it ran + deliberated.
      expect(deepEmitsReasoning, 'Deep mode emitted no reasoning — Gemma thinking not engaged').toBe(true)
    }
  )
})
