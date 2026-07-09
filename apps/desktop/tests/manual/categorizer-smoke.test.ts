import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import {
  CATEGORIZER_CATEGORIES,
  CATEGORIZER_BATCH_SIZE,
  categorizeTransactions,
  prefilterCategory
} from '../../src/main/services/skills/categorizer'
import type { TransactionInput } from '../../src/main/services/skills/tools/bank-statement'

// MANUAL smoke for the bank-statement LLM categorizer (Phase 33) — NOT CI.
//
// Every categorizer UNIT/INTEGRATION test uses a scripted/mock runtime that IGNORES
// `responseSchema`, so the grammar-constrained `json_schema` ENUM path through the real
// llama-server (the D55 plumbing) is never exercised in CI. This drives the SHIPPING
// `categorizeTransactions` over representative SYNTHETIC transactions against a real model
// and records, for the Phase-33 findings:
//   1. the cardinal property — EVERY assigned category is in the fixed set (the enum held;
//      the model could not invent a label), even for a deliberately nonsense description;
//   2. the prefilter vs model split + batching across the 20-row boundary (two model calls);
//   3. how many rows dropped to Uncategorized (parse/uncertainty), per-category distribution;
//   4. plausibility — a hand-labelled expectation per row (logged, not asserted: a mislabel is
//      not a figure, so the smoke records accuracy rather than gating on it).
//
// All transactions are SYNTHETIC (D57 — never real statement data). CI stays
// zero-network/zero-model/zero-binary; skipped unless HILBERTRAUM_CATEGORIZER_SMOKE points at a
// provisioned drive root (the HILBERTRAUM_TRANSLATEGEMMA_SMOKE shape — a locally provisioned smoke drive):
//
//   HILBERTRAUM_CATEGORIZER_SMOKE=<root> npx vitest run tests/manual/categorizer-smoke.test.ts
//
// By default it auto-picks the SMALLEST GGUF under <root>/models/chat. To target a SPECIFIC model
// (e.g. when the smallest is a truncated/partial download), set HILBERTRAUM_CATEGORIZER_MODEL to its
// absolute path:
//
//   HILBERTRAUM_CATEGORIZER_MODEL=D:\models\chat\good-model.gguf  (alongside the _SMOKE root)

const ROOT = process.env.HILBERTRAUM_CATEGORIZER_SMOKE?.trim() ?? ''
const MODEL_OVERRIDE = process.env.HILBERTRAUM_CATEGORIZER_MODEL?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

const PATIENT_MS = 240_000
const CTX = 4096

/** The explicit model override when given (and present), else the smallest GGUF under models/chat. */
function pickChatModel(root: string): string | null {
  if (MODEL_OVERRIDE.length > 0) return existsSync(MODEL_OVERRIDE) ? MODEL_OVERRIDE : null
  const dir = join(root, 'models', 'chat')
  if (!existsSync(dir)) return null
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs[0]?.path ?? null
}

function tx(description: string, amount: number, expected: string): TransactionInput & { expected: string } {
  return { date: '2026-03-01', description, amount, currency: 'EUR', expected }
}

// Representative SYNTHETIC transactions (DE + EN), hand-labelled with the plausible category. Sized
// past CATEGORIZER_BATCH_SIZE so the model is called in more than one batch. A deliberately nonsense
// row probes that the enum is inescapable (the model must still pick an in-set value).
const ROWS: Array<TransactionInput & { expected: string }> = [
  tx('REWE SAGT DANKE 12345', -45.9, 'Groceries'),
  tx('BILLA Filiale 0815 Wien', -23.4, 'Groceries'),
  tx('Restaurant Zur Post', -38.5, 'Dining'),
  tx('McDonalds 442', -11.2, 'Dining'),
  tx('OMV Tankstelle A1', -72.0, 'Transport'),
  tx('Wiener Linien Jahreskarte', -365.0, 'Transport'),
  tx('Stadtwerke Strom Abschlag', -89.0, 'Utilities'),
  tx('A1 Telekom Internet', -39.99, 'Utilities'),
  tx('Hausverwaltung Miete Maerz', -980.0, 'Rent'),
  tx('Allianz Versicherung Beitrag', -54.3, 'Insurance'),
  tx('Netflix Abo', -17.99, 'Subscriptions'),
  tx('Spotify Premium', -10.99, 'Subscriptions'),
  tx('Apotheke zum Hirschen', -24.5, 'Health'),
  tx('Dr. med. Steiner Honorar', -120.0, 'Health'),
  tx('Amazon Bestellung 702-99', -64.2, 'Shopping'),
  tx('MediaMarkt Kopfhoerer', -89.0, 'Shopping'),
  tx('Gehalt ACME GmbH', 2850.0, 'Income'),
  tx('Lohn Maerz', 1900.0, 'Income'),
  tx('Ueberweisung an Max Muster', -100.0, 'Transfer'),
  tx('SEPA Dauerauftrag Sparen', -200.0, 'Transfer'),
  tx('Kontofuehrungsgebuehr', -3.9, 'Fees'),
  tx('Bankgebuehr Auslandseinsatz', -2.5, 'Fees'),
  tx('Bargeldbehebung ATM Bankomat', -150.0, 'Cash'),
  tx('Finanzamt Steuer Nachzahlung', -430.0, 'Tax'),
  tx('IKEA Restaurant Koettbullar', -14.8, 'Dining'),
  tx('xq7 zzz frobnicate 9981', -5.0, 'Uncategorized') // nonsense — the enum must still hold
]

const SET = new Set(CATEGORIZER_CATEGORIES)

describe.skipIf(!enabled)('categorizer smoke: real grammar-constrained enum over a chat GGUF (manual)', () => {
  it(
    'assigns only in-set categories through the real json_schema enum, and records accuracy',
    { timeout: 1_200_000 },
    async () => {
      const binPath = resolveLlamaServerPath(ROOT, process.platform, {})
      const modelPath = pickChatModel(ROOT)
      expect(binPath, 'llama-server binary on the drive').toBeTruthy()
      expect(
        modelPath,
        MODEL_OVERRIDE
          ? `HILBERTRAUM_CATEGORIZER_MODEL points at an existing file (${MODEL_OVERRIDE})`
          : 'a chat GGUF under models/chat'
      ).toBeTruthy()

      const runtime = createLlamaRuntime(
        { modelId: 'categorizer-smoke', modelPath: modelPath!, contextTokens: CTX },
        { binPath: binPath!, healthTimeoutMs: PATIENT_MS }
      )
      await runtime.start()
      try {
        const health = await runtime.health()
        expect(health.healthy).toBe(true)
        console.log(`smoke: server healthy on port ${health.port}, model=${modelPath}`)

        // The prefilter (skip-the-model) split — logged so the model-bound count is visible.
        const prefiltered = ROWS.filter((r) => prefilterCategory(r) != null).length
        const modelBound = ROWS.length - prefiltered
        const batches = Math.ceil(modelBound / CATEGORIZER_BATCH_SIZE)
        console.log(
          `rows=${ROWS.length} prefiltered=${prefiltered} model-bound=${modelBound} ` +
            `→ expected model batches=${batches} (batch size=${CATEGORIZER_BATCH_SIZE})`
        )
        expect(batches).toBeGreaterThanOrEqual(2) // the harness is sized to cross the batch boundary

        const started = Date.now()
        const { assignments, modelAssisted } = await categorizeTransactions(ROWS, {
          runtime,
          signal: new AbortController().signal
        })
        const secs = ((Date.now() - started) / 1000).toFixed(1)

        // 1. CARDINAL: the enum is inescapable — every assignment is in the fixed set.
        expect(assignments).toHaveLength(ROWS.length)
        expect(modelAssisted).toBe(true)
        const offSet = assignments.filter((a) => !SET.has(a.category))
        console.log(`off-set categories (must be 0): ${offSet.length}`)
        expect(offSet).toHaveLength(0)

        // 2. Distribution + drop-to-Uncategorized count.
        const dist = new Map<string, number>()
        for (const a of assignments) dist.set(a.category, (dist.get(a.category) ?? 0) + 1)
        const dropped = dist.get('Uncategorized') ?? 0
        console.log(`(${secs}s) Uncategorized=${dropped} / ${ROWS.length}`)
        console.log(`distribution: ${JSON.stringify(Object.fromEntries([...dist].sort()))}`)

        // 3. Plausibility — logged, NOT asserted (a category is not a figure; a mislabel is acceptable
        //    and never moves a total). Records accuracy vs the hand labels for the findings table.
        let agree = 0
        const misses: string[] = []
        assignments.forEach((a, i) => {
          const exp = ROWS[i].expected
          if (a.category === exp) agree += 1
          else misses.push(`"${ROWS[i].description}" → got ${a.category}, expected ${exp}`)
        })
        console.log(`plausible-label agreement: ${agree}/${ROWS.length} (${((agree / ROWS.length) * 100).toFixed(0)}%)`)
        if (misses.length) console.log(`mismatches:\n  ${misses.join('\n  ')}`)

        // The nonsense row must still be in-set (the enum held even with no sensible category).
        const nonsense = assignments[assignments.length - 1]
        console.log(`nonsense row → ${nonsense.category} (in-set: ${SET.has(nonsense.category)})`)
        expect(SET.has(nonsense.category)).toBe(true)
      } finally {
        await runtime.stop()
      }
    }
  )
})
