import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import {
  compareBudgetWords,
  compareFullPrompt,
  comparePairPrompt,
  compareReducePrompt,
  compareReportHeadings,
  compareSystemPrompt,
  COMPARE_OUTPUT_TOKENS,
  COMPARE_TEMPERATURE
} from '../../src/main/services/doctasks'
import { stripThinkBlocks } from '../../src/main/services/chat'
import type { ChatMessage } from '../../src/main/services/runtime'

// MANUAL R-T2 smoke, comparison half (Phase 35, wave-3 plan §14) — NOT CI.
//
// Runs the REAL pinned b9585 + a real chat GGUF (Qwen3-4B on the provisioned dev-box
// drive) over representative comparison calls USING THE SHIPPING PROMPTS
// (compareSystemPrompt / compareFullPrompt / comparePairPrompt / compareReducePrompt /
// COMPARE_TEMPERATURE) and records, for the plan §14 findings table:
//   1. format adherence of the four-section report (mode a) over two FULL short docs —
//      headings verbatim? bullets? refusal phrases / assistant chatter?
//   2. fact PLACEMENT: planted shared/differing/only-in-one facts land in the right
//      section, with names/numbers/dates exact?
//   3. German inputs: does the report body stay German, and what happens to the
//      dictated (English) headings?
//   4. mode (b) map step: does the 4B hold the compact prefixed-bullets format over a
//      matched section pair at a map-sized output cap (plan §8 flags that mode (b)
//      may need a smaller per-pair format — this probes the small format directly)?
//   5. reduce over several per-pair note sets: four sections back, duplicates merged,
//      facts faithful, nothing invented?
//   6. output length vs the COMPARE_OUTPUT_TOKENS cap (silent-truncation check — the
//      translation smoke caught exactly this class of bug).
//
// CI stays zero-network/zero-model/zero-binary; skipped unless HILBERTRAUM_COMPARE_SMOKE
// points at a provisioned drive root (the HILBERTRAUM_TRANSLATION_SMOKE shape — dev box: D:\):
//
//   HILBERTRAUM_COMPARE_SMOKE=<root> npx vitest run tests/manual/compare-smoke.test.ts

const ROOT = process.env.HILBERTRAUM_COMPARE_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

const PATIENT_MS = 240_000
const CTX = 4096

/** Phrases that mean the model talked ABOUT the task instead of doing it. */
const REFUSAL_MARKERS = [
  'i cannot',
  "i can't",
  "i'm sorry",
  'as an ai',
  'here is the comparison',
  'here is a comparison',
  'sure,',
  'certainly',
  'ich kann nicht',
  'es tut mir leid',
  'hier ist der vergleich',
  'gerne'
]

function smallestChatModel(root: string): string | null {
  const dir = join(root, 'models', 'chat')
  if (!existsSync(dir)) return null
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs[0]?.path ?? null
}

function words(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length
}

function refusalHits(out: string): string[] {
  const lower = out.toLowerCase()
  return REFUSAL_MARKERS.filter((m) => lower.includes(m))
}

/** Crude language scoring: which function-word set dominates a text sample. */
function languageScore(sample: string): { de: number; en: number } {
  const lower = ` ${sample.toLowerCase()} `
  const count = (list: string[]): number =>
    list.reduce((n, w) => n + (lower.match(new RegExp(`[^a-zä-ü]${w}[^a-zä-ü]`, 'g'))?.length ?? 0), 0)
  return {
    de: count(['und', 'der', 'die', 'das', 'nicht', 'ist', 'mit', 'für', 'wird', 'beide', 'nur']),
    en: count(['the', 'and', 'is', 'of', 'with', 'for', 'will', 'not', 'both', 'only'])
  }
}

/** Split a report into its four sections by the dictated headings (verbatim match). */
function splitByHeadings(report: string, headings: string[]): Map<string, string> {
  const sections = new Map<string, string>()
  for (let i = 0; i < headings.length; i++) {
    const at = report.indexOf(headings[i])
    if (at < 0) continue
    let end = report.length
    for (let j = 0; j < headings.length; j++) {
      const other = report.indexOf(headings[j])
      if (other > at && other < end) end = other
    }
    sections.set(headings[i], report.slice(at + headings[i].length, end))
  }
  return sections
}

/** Where (which dictated section) a planted fact token landed; null = nowhere. */
function placementOf(report: string, headings: string[], token: string): string | null {
  const sections = splitByHeadings(report, headings)
  for (const [h, body] of sections) {
    if (body.includes(token)) return h
  }
  return report.includes(token) ? '(outside all sections)' : null
}

// ---- Planted fixtures -----------------------------------------------------------------
// Two versions of an English supplier contract. Planted, greppable facts:
//   shared:   "Project Aurora", "Anna Berger", "1 February 2026"
//   differs:  unit price 39.90 EUR (A) vs 44.90 EUR (B); delivery 30 days (A) vs 45 (B)
//   only A:   late-delivery penalty "0.5 % per week"
//   only B:   annual maintenance fee "1,200 EUR"

const EN_DOC_A =
  'Supply Agreement — Project Aurora (draft v1)\n\n' +
  'This agreement is made between Nordlicht GmbH, represented by Anna Berger, and ' +
  'Carbide Systems Ltd. Deliveries under Project Aurora start on 1 February 2026.\n\n' +
  'The unit price for the RX-7b module is 39.90 EUR net. Carbide Systems will deliver ' +
  'within 30 days of each order. Payment is due within 30 days without deduction.\n\n' +
  'If a delivery is late, a late-delivery penalty of 0.5 % per week of the order value ' +
  'applies, capped at 5 % in total.\n\n' +
  'The agreement runs for two years and renews automatically unless terminated with ' +
  'three months notice. German law applies.'

const EN_DOC_B =
  'Supply Agreement — Project Aurora (draft v2)\n\n' +
  'This agreement is made between Nordlicht GmbH, represented by Anna Berger, and ' +
  'Carbide Systems Ltd. Deliveries under Project Aurora start on 1 February 2026.\n\n' +
  'The unit price for the RX-7b module is 44.90 EUR net. Carbide Systems will deliver ' +
  'within 45 days of each order. Payment is due within 30 days without deduction.\n\n' +
  'Carbide Systems provides ongoing support for an annual maintenance fee of 1,200 EUR, ' +
  'invoiced each January.\n\n' +
  'The agreement runs for two years and renews automatically unless terminated with ' +
  'three months notice. German law applies.'

// Two versions of a German quarterly memo. Planted facts:
//   gleich:   "DACH-Region", "Anna Berger"
//   anders:   87 Neukunden (A) vs 95 Neukunden (B)
//   nur A:    "Kündigungsquote von 2,1 %"
//   nur B:    "neue Niederlassung in Wien"

const DE_DOC_A =
  'Quartalsbericht Q1 2026 (Entwurf März)\n\n' +
  'Der wichtigste Markt bleibt die DACH-Region. Vertriebsleitung: Anna Berger.\n\n' +
  'Im ersten Quartal wurden 87 Neukunden gewonnen (Ziel: 75). Die Kündigungsquote von ' +
  '2,1 % liegt unter dem Branchenschnitt.\n\n' +
  'Alle Zahlen sind vorläufig; testiert wird im Mai.'

const DE_DOC_B =
  'Quartalsbericht Q1 2026 (Entwurf April)\n\n' +
  'Der wichtigste Markt bleibt die DACH-Region. Vertriebsleitung: Anna Berger.\n\n' +
  'Im ersten Quartal wurden 95 Neukunden gewonnen (Ziel: 75). Zum 1. Juni eröffnet eine ' +
  'neue Niederlassung in Wien mit zunächst sechs Mitarbeitern.\n\n' +
  'Alle Zahlen sind vorläufig; testiert wird im Mai.'

// A mode-(b) matched pair: one section of A with two related B excerpts (the price
// section pairs with B's price section AND B's unrelated-but-retrieved support clause).
const PAIR_WINDOW_A =
  'The unit price for the RX-7b module is 39.90 EUR net. Carbide Systems will deliver ' +
  'within 30 days of each order. Payment is due within 30 days without deduction. ' +
  'If a delivery is late, a late-delivery penalty of 0.5 % per week of the order value ' +
  'applies, capped at 5 % in total.'

const PAIR_EXCERPTS_B =
  'The unit price for the RX-7b module is 44.90 EUR net. Carbide Systems will deliver ' +
  'within 45 days of each order. Payment is due within 30 days without deduction.\n\n' +
  'Carbide Systems provides ongoing support for an annual maintenance fee of 1,200 EUR, ' +
  'invoiced each January.'

// Synthetic per-pair notes for the reduce probe: three note sets in the dictated
// bullet format, with a DUPLICATE shared fact (start date in notes 1+2), a split
// difference (price in 1, delivery in 2), and one only-in-each finding.
const REDUCE_NOTES = [
  '- Same: Deliveries under Project Aurora start on 1 February 2026.\n' +
    '- Same: The agreement is between Nordlicht GmbH (Anna Berger) and Carbide Systems Ltd.\n' +
    '- Different: The unit price is 39.90 EUR net in A but 44.90 EUR net in B.',
  '- Same: Deliveries under Project Aurora start on 1 February 2026.\n' +
    '- Different: Delivery is within 30 days in A but within 45 days in B.\n' +
    '- Only in A: A late-delivery penalty of 0.5 % per week, capped at 5 % in total.',
  '- Same: Payment is due within 30 days without deduction.\n' +
    '- Only in B: An annual maintenance fee of 1,200 EUR, invoiced each January.'
]

describe.skipIf(!enabled)('R-T2 (comparison half): real b9585 structured-compare behavior (manual)', () => {
  it(
    'runs the shipping prompts over representative comparisons and records the findings',
    { timeout: 1_200_000 },
    async () => {
      const binPath = resolveLlamaServerPath(ROOT, process.platform, {})
      const modelPath = smallestChatModel(ROOT)
      expect(binPath, 'llama-server binary on the drive').toBeTruthy()
      expect(modelPath, 'a chat GGUF under models/chat').toBeTruthy()

      const runtime = createLlamaRuntime(
        { modelId: 'compare-smoke', modelPath: modelPath!, contextTokens: CTX },
        { binPath: binPath!, healthTimeoutMs: PATIENT_MS }
      )
      await runtime.start()
      try {
        const health = await runtime.health()
        expect(health.healthy).toBe(true)
        console.log(`smoke: server healthy on port ${health.port}, model=${modelPath}`)
        console.log(
          `compare budget=${compareBudgetWords(CTX)} words (both docs), output cap=${COMPARE_OUTPUT_TOKENS}`
        )

        const generate = async (label: string, prompt: string, maxTokens: number): Promise<string> => {
          const messages: ChatMessage[] = [
            { role: 'system', content: compareSystemPrompt() },
            { role: 'user', content: prompt }
          ]
          const started = Date.now()
          let out = ''
          for await (const token of runtime.chatStream(messages, {
            maxTokens,
            temperature: COMPARE_TEMPERATURE
          })) {
            out += token
          }
          out = stripThinkBlocks(out).trim()
          const secs = ((Date.now() - started) / 1000).toFixed(1)
          console.log(`\n=== ${label} (${secs}s) ===`)
          console.log(`output words=${words(out)} (cap=${maxTokens} tokens)`)
          const hits = refusalHits(out)
          console.log(`refusal/chatter markers: ${hits.length ? hits.join(', ') : 'none'}`)
          console.log(out)
          return out
        }

        const checkReport = (report: string, titleA: string, titleB: string): void => {
          const headings = compareReportHeadings(titleA, titleB)
          for (const h of headings) {
            const count = report.split(h).length - 1
            console.log(`heading ${JSON.stringify(h)}: ${count === 1 ? 'PRESENT once' : `count=${count}`}`)
          }
          const bullets = report.match(/^\s*[-*] /gm)?.length ?? 0
          console.log(`bullet lines: ${bullets}`)
          const endsClean = /[.!?")\]»]$|Nothing notable\.$/m.test(report.trimEnd().slice(-80))
          console.log(`ends on sentence punctuation (truncation check): ${endsClean ? 'yes' : 'NO — CAPPED?'}`)
        }

        // 1+2+6. Mode (a) full compare, EN pair: format + fact placement + cap check.
        const enHead = compareReportHeadings('contract-v1.txt', 'contract-v2.txt')
        const enReport = await generate(
          'mode (a) full compare, EN contract pair',
          compareFullPrompt('contract-v1.txt', EN_DOC_A, 'contract-v2.txt', EN_DOC_B),
          COMPARE_OUTPUT_TOKENS
        )
        checkReport(enReport, 'contract-v1.txt', 'contract-v2.txt')
        for (const [fact, want] of [
          ['Project Aurora', enHead[0]],
          ['1 February 2026', enHead[0]],
          ['39.90', enHead[1]],
          ['44.90', enHead[1]],
          ['0.5 %', enHead[2]],
          ['1,200 EUR', enHead[3]]
        ] as const) {
          const at = placementOf(enReport, enHead, fact)
          console.log(
            `fact ${JSON.stringify(fact)}: ${at === want ? `PLACED correctly (${at})` : `at ${at ?? 'NOWHERE'} (wanted ${want})`}`
          )
        }

        // 3. Mode (a) full compare, DE pair: body language + heading behavior.
        const deReport = await generate(
          'mode (a) full compare, DE memo pair',
          compareFullPrompt('bericht-marz.txt', DE_DOC_A, 'bericht-april.txt', DE_DOC_B),
          COMPARE_OUTPUT_TOKENS
        )
        checkReport(deReport, 'bericht-marz.txt', 'bericht-april.txt')
        const deScore = languageScore(deReport)
        console.log(`report language: de=${deScore.de} en=${deScore.en} (body should be German-dominant)`)
        for (const fact of ['DACH-Region', '87', '95', '2,1 %', 'Wien']) {
          console.log(`fact ${JSON.stringify(fact)}: ${deReport.includes(fact) ? 'present' : 'MISSING'}`)
        }

        // 4. Mode (b) map step at a map-sized cap (12-window worst case ≈ 273 tokens).
        const pairOut = await generate(
          'mode (b) matched-pair map step',
          comparePairPrompt('contract-v1.txt', 'contract-v2.txt', 2, 5, PAIR_WINDOW_A, PAIR_EXCERPTS_B),
          256
        )
        const prefixed = pairOut.match(/^- (Same|Different|Only in A|Only in B):/gm)?.length ?? 0
        const unprefixed = (pairOut.match(/^\s*[-*] /gm)?.length ?? 0) - prefixed
        console.log(`prefixed bullets=${prefixed}, unprefixed bullets=${unprefixed}`)
        for (const fact of ['39.90', '44.90', '30 days', '45 days', '0.5 %', '1,200 EUR']) {
          console.log(`pair fact ${JSON.stringify(fact)}: ${pairOut.includes(fact) ? 'present' : 'MISSING'}`)
        }

        // 5. Reduce over synthetic per-pair notes: format, dedup, faithfulness.
        const redHead = compareReportHeadings('contract-v1.txt', 'contract-v2.txt')
        const reduceOut = await generate(
          'reduce over 3 per-pair note sets',
          compareReducePrompt('contract-v1.txt', 'contract-v2.txt', REDUCE_NOTES),
          COMPARE_OUTPUT_TOKENS
        )
        checkReport(reduceOut, 'contract-v1.txt', 'contract-v2.txt')
        const dupes = reduceOut.split('1 February 2026').length - 1
        console.log(`duplicate shared fact merged: "1 February 2026" appears ${dupes}× (want 1)`)
        for (const [fact, want] of [
          ['39.90', redHead[1]],
          ['45 days', redHead[1]],
          ['0.5 %', redHead[2]],
          ['1,200 EUR', redHead[3]]
        ] as const) {
          const at = placementOf(reduceOut, redHead, fact)
          console.log(
            `reduce fact ${JSON.stringify(fact)}: ${at === want ? `PLACED correctly (${at})` : `at ${at ?? 'NOWHERE'} (wanted ${want})`}`
          )
        }
        console.log(
          `reduce invention probe: mentions "maintenance" outside Only-in-B? ${
            placementOf(reduceOut, redHead, 'maintenance') === redHead[3] ? 'no' : 'CHECK MANUALLY'
          }`
        )

        // The smoke only asserts sane completion; the printed record is the artifact.
        expect(enReport.length).toBeGreaterThan(0)
        expect(deReport.length).toBeGreaterThan(0)
        expect(pairOut.length).toBeGreaterThan(0)
        expect(reduceOut.length).toBeGreaterThan(0)
      } finally {
        await runtime.stop()
      }
    }
  )
})
