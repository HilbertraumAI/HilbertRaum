import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  extractTransactionsWithStats,
  extractStatementBalances,
  BANK_EXTRACTOR_VERSION,
  type ExtractTransactionsOutput
} from '../../src/main/services/skills/tools/bank-statement'
import { extractInvoice, INVOICE_EXTRACTOR_VERSION, type ExtractedInvoice } from '../../src/main/services/skills/tools/invoice'
import {
  detectDocumentCurrency,
  inferDateOrderResult,
  inferDateAnchor,
  normalizeExtractionText
} from '../../src/main/services/skills/tools/money'
import type { DocumentChunkRead } from '../../src/shared/types'
import {
  ALL_FIXTURES,
  BANK_FIXTURES,
  INVOICE_FIXTURES,
  INCIDENT_CLASSES,
  type BankFixture,
  type InvoiceFixture
} from '../fixtures/real-layouts/corpus'

// Real-layout extractor tests (skills-remediation T1, audit §7 recs 1 + 2). TWO guards over the ONE
// committed real-layout corpus (tests/fixtures/real-layouts/corpus.ts):
//   1. Real-world extraction — the constructed incident-class layouts run through the REAL production
//      extractors (the same currency/order/anchor inference the tool does) and the parsed FIGURES are
//      asserted: signs, grouped amounts, dd.mm.yy/cross-year dates, wrapped payees survive, the
//      Steuerberatung label theft stays dead, phantom summary lines never become items.
//   2. Output snapshot — a per-fixture hash of the full extractor output, committed and keyed by extractor
//      version. Any change to the parsed output FAILS the run unless the affected extractor version was
//      bumped AND the snapshot regenerated — the mechanical backstop for "every extractor behaviour change
//      bumps the version" (plan §0), which green synthetic fixtures did not enforce (INVOICE-TOTALS-1).
// Pure + offline: no DB, no runtime, no network — runs in the default `npm test`.

// ---- Faithful production extraction (mirror of the tool's own call, so the corpus sees what users see) ----

function toChunks(texts: string[]): DocumentChunkRead[] {
  return texts.map((text, index) => ({ text, page: index + 1, index }))
}

/** Exactly what `extractTransactionsTool.run` assembles (currency vote + order/anchor + balances + stats). */
function runBank(fx: BankFixture): ExtractTransactionsOutput {
  const chunks = toChunks(fx.chunks)
  const joined = normalizeExtractionText(chunks.map((c) => c.text).join('\n'))
  const statementCurrency = detectDocumentCurrency(joined)
  const { order, inferred } = inferDateOrderResult(joined)
  const anchor = inferDateAnchor(joined, order)
  const { rows, droppedRowCount } = extractTransactionsWithStats(chunks, statementCurrency, order, anchor)
  const balances = extractStatementBalances(chunks, order, anchor)
  const output: ExtractTransactionsOutput = { transactions: rows, dateOrderInferred: inferred, droppedRowCount }
  if (statementCurrency) output.currency = statementCurrency
  if (balances.openingBalance !== undefined) output.openingBalance = balances.openingBalance
  if (balances.closingBalance !== undefined) output.closingBalance = balances.closingBalance
  return output
}

/** Exactly what `extractInvoiceTool.run` assembles (currency vote + order/anchor + dateOrderInferred stamp). */
function runInvoice(fx: InvoiceFixture): ExtractedInvoice {
  const chunks = toChunks(fx.chunks)
  const joined = normalizeExtractionText(chunks.map((c) => c.text).join('\n'))
  const currency = detectDocumentCurrency(joined)
  const { order, inferred } = inferDateOrderResult(joined)
  const anchor = inferDateAnchor(joined, order)
  const invoice = extractInvoice(chunks, currency, order, anchor)
  invoice.dateOrderInferred = inferred
  return invoice
}

// ---- Snapshot plumbing (stable serialization + hash) ---------------------------------------------------

const SNAPSHOT_PATH = resolve(__dirname, '../fixtures/real-layouts/extractor-output.snapshot.json')
const UPDATE = process.env.UPDATE_EXTRACTOR_SNAPSHOT === '1'

/** Deterministic JSON with sorted keys (property order + platform must never move the hash). The replacer
 *  runs on EVERY nested value, so nested objects (rows/line-items inside their arrays) get their keys sorted
 *  too, while arrays keep their (meaningful) order. Sort by CODE POINT (never `localeCompare`, which is
 *  ICU/locale-sensitive) so the hash is identical on every machine. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    }
    return v
  })
}
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

interface SnapshotEntry {
  kind: 'bank' | 'invoice'
  /** Hash of the fixture's INPUT text — lets the guard tell a fixture edit (input changed) apart from an
   *  EXTRACTOR change (input unchanged, output moved). Only the latter must bump the version. */
  inputHash: string
  /** Hash of the full extractor OUTPUT (keyed by extractor version). */
  hash: string
  output: unknown
}
interface SnapshotFile {
  $comment: string
  bankExtractorVersion: number
  invoiceExtractorVersion: number
  fixtures: Record<string, SnapshotEntry>
}

function currentSnapshot(): SnapshotFile {
  const fixtures: Record<string, SnapshotEntry> = {}
  for (const fx of BANK_FIXTURES) {
    const output = runBank(fx)
    fixtures[fx.id] = { kind: 'bank', inputHash: sha256(stableStringify(fx.chunks)), hash: sha256(stableStringify(output)), output }
  }
  for (const fx of INVOICE_FIXTURES) {
    const output = runInvoice(fx)
    fixtures[fx.id] = { kind: 'invoice', inputHash: sha256(stableStringify(fx.chunks)), hash: sha256(stableStringify(output)), output }
  }
  return {
    $comment:
      'GENERATED — do not hand-edit. Committed output-snapshot for the real-layout corpus, keyed by ' +
      'extractor version. Regenerate in the SAME commit as any extractor version bump: ' +
      'UPDATE_EXTRACTOR_SNAPSHOT=1 npx vitest run tests/integration/extractor-realworld.test.ts',
    bankExtractorVersion: BANK_EXTRACTOR_VERSION,
    invoiceExtractorVersion: INVOICE_EXTRACTOR_VERSION,
    fixtures
  }
}

// ---- 1. Real-world extraction assertions --------------------------------------------------------------

describe('real-layout corpus — figures parse correctly through the real extractors', () => {
  it('the corpus exercises every incident class (audit §7 rec 1 consolidation)', () => {
    const covered = new Set(ALL_FIXTURES.flatMap((f) => f.incidentClasses))
    for (const cls of INCIDENT_CLASSES) {
      expect(covered.has(cls), `no fixture exercises incident class "${cls}"`).toBe(true)
    }
  })

  it('bank-at-elba: NBSP grouping, U+2212 signs, cross-year + dd.mm.yy dates, wrapped SEPA payee, balances', () => {
    const out = runBank(BANK_FIXTURES[0])
    expect(out.currency).toBe('EUR')
    expect(out.droppedRowCount).toBe(0)
    const byDesc = new Map(out.transactions.map((t) => [t.description, t]))
    // NBSP thousands grouping survives (R1) — `2 500,00` reads 2500, not 500 / 2.
    expect(byDesc.get('SEPA-Gutschrift Gehalt')?.amount).toBe(2500)
    // dd.mm.yy completed against the January-2026 anchor (R5).
    expect(byDesc.get('SEPA-Gutschrift Gehalt')?.date).toBe('2026-01-06')
    // U+2212 minus signs a debit negative (R1).
    expect(byDesc.get('Bankomat Abhebung')?.amount).toBe(-200)
    // A bare `28.12.` December row on a January statement rolls to the PREVIOUS year (R5 cross-year).
    expect(byDesc.get('Dauerauftrag Miete')?.date).toBe('2025-12-28')
    expect(byDesc.get('Dauerauftrag Miete')?.amount).toBe(-900)
    // A wrapped SEPA payee on the next line survives into the description (R6).
    expect(byDesc.has('SEPA-Lastschrift NETFLIX INTERNATIONAL B.V.')).toBe(true)
    expect(byDesc.get('SEPA-Lastschrift NETFLIX INTERNATIONAL B.V.')?.amount).toBe(-12.99)
    // `Kontostand am` opening/closing balances (R2) — earliest = opening, latest = closing.
    expect(out.openingBalance).toBe(1000)
    expect(out.closingBalance).toBe(2387.01)
    expect(out.transactions).toHaveLength(4)
  })

  it('bank-de-sparkasse: en-dash debits, narrow-NBSP grouping, wrapped payee, running balances, order default', () => {
    const out = runBank(BANK_FIXTURES[1])
    expect(out.currency).toBe('EUR')
    const byDesc = new Map(out.transactions.map((t) => [t.description, t]))
    // en-dash (U+2013) signs the debit negative (R1).
    expect(byDesc.get('Kartenzahlung REWE')?.amount).toBe(-45.9)
    expect(byDesc.get('Kartenzahlung REWE')?.balanceAfter).toBe(954.1)
    // wrapped payee (R6).
    expect(byDesc.has('SEPA-Lastschrift STADTWERKE MUENCHEN')).toBe(true)
    // narrow-NBSP (U+202F) grouping survives on the credit + balance (R1).
    expect(byDesc.get('SEPA-Gutschrift Lohn')?.amount).toBe(2500)
    expect(byDesc.get('SEPA-Gutschrift Lohn')?.balanceAfter).toBe(3434.11)
    // A non-breaking-hyphen (U+2011) debit sign + figure-space (U+2007) grouped amount AND balance (R1).
    expect(byDesc.get('Dauerauftrag Sparplan')?.amount).toBe(-1000)
    expect(byDesc.get('Dauerauftrag Sparplan')?.balanceAfter).toBe(2434.11)
    // Every leading date is day≤12/month≤12 (ambiguous) → order defaults day-first WITHOUT evidence (R5).
    expect(out.dateOrderInferred).toBe('default')
    expect(out.transactions).toHaveLength(4)
  })

  it('invoice-at-steuerberatung: label theft dead (Steuerberatung stays an item), Steuer→tax, Summe labels, NBSP', () => {
    const inv = runInvoice(INVOICE_FIXTURES[0])
    const descs = inv.lineItems.map((l) => l.description)
    // The audit §5.2 CRITICAL: `Steuerberatung Jänner` must NOT be stolen into taxTotal by the `steuer` prefix.
    expect(descs).toContain('Steuerberatung Jänner')
    expect(inv.lineItems.find((l) => l.description === 'Steuerberatung Jänner')?.lineTotal).toBe(500)
    // NBSP grouping on the second item (R1).
    expect(inv.lineItems.find((l) => l.description === 'Netto-Miete Objekt 3')?.lineTotal).toBe(1000)
    // The genuine `Steuer 20%` totals line resolves to the tax total (boundary match), NOT a phantom item.
    expect(descs).not.toContain('Steuer 20%')
    // `Summe netto` → net, `Steuer` → tax (+rate), `Rechnungssumme inkl. USt` → gross (R2 §5.4 labels).
    expect(inv.totals.netTotal).toBe(1500)
    expect(inv.totals.taxTotal).toBe(300)
    expect(inv.totals.taxRatePercent).toBe(20)
    expect(inv.totals.grossTotal).toBe(1800)
    expect(inv.lineItems).toHaveLength(2)
  })

  it('invoice-ch-summe-apostrophe: Swiss U+2019 grouping, wrapped line-item description, Summe gross', () => {
    const inv = runInvoice(INVOICE_FIXTURES[1])
    expect(inv.header.currency).toBe('CHF')
    // Swiss `2’400.00` (U+2019 grouping) reads 2400, not 2 (R1); the wrapped `Onsite-Workshop Zürich`
    // continuation is appended to the first item's description (R6).
    const first = inv.lineItems[0]
    expect(first.lineTotal).toBe(2400)
    expect(first.description).toContain('Onsite-Workshop Zürich')
    expect(inv.lineItems.find((l) => l.description === 'Lizenz Jahresabo')?.lineTotal).toBe(600)
    // `Summe` → gross (R2 §5.4).
    expect(inv.totals.grossTotal).toBe(3000)
    expect(inv.lineItems).toHaveLength(2)
  })

  it('invoice-de-endbetrag-phantom: Zwischensumme/Endbetrag never become phantom items; en-dash credit stays', () => {
    const inv = runInvoice(INVOICE_FIXTURES[2])
    const descs = inv.lineItems.map((l) => l.description)
    // The phantom-item guard (R2): summary lines are NOT line items.
    expect(descs).not.toContain('Zwischensumme')
    expect(descs).not.toContain('Endbetrag')
    // A `–20,00` discount stays a real NEGATIVE line item (en-dash sign, R1).
    expect(inv.lineItems.find((l) => l.description === 'Rabatt')?.lineTotal).toBe(-20)
    // `Zwischensumme` → net, `Endbetrag` → gross (R2 §5.4).
    expect(inv.totals.netTotal).toBe(250)
    expect(inv.totals.grossTotal).toBe(250)
    expect(inv.lineItems).toHaveLength(3)
  })
})

// ---- 2. Output-snapshot / version-bump guard ----------------------------------------------------------

describe('extractor output snapshot — any output change forces a version bump + regenerate', () => {
  const fresh = currentSnapshot()

  if (UPDATE) {
    it('regenerates the committed snapshot (UPDATE_EXTRACTOR_SNAPSHOT=1) — refuses a silent no-bump rewrite', () => {
      // Regeneration must NOT be an escape hatch that silences the version-bump rule. Refuse to overwrite iff
      // a fixture's output moved WHILE ITS INPUT DID NOT (⇒ the EXTRACTOR changed) but the affected version
      // was NOT bumped — the bump has to land first (plan §0). A fixture EDIT (input hash changed) is a
      // corpus-maintenance change, needs no extractor bump, and regenerates freely. A first-time create (no
      // committed file) is exempt (bootstrap). This makes the guard actually FORCE the bump on a real
      // extractor change, not merely flag its absence, without blocking fixture upkeep.
      if (existsSync(SNAPSHOT_PATH)) {
        const prior: SnapshotFile = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
        for (const [id, cur] of Object.entries(fresh.fixtures)) {
          const before = prior.fixtures[id]
          if (!before || before.hash === cur.hash) continue // new fixture or unchanged output — fine
          if (before.inputHash !== cur.inputHash) continue // the FIXTURE was edited — no extractor bump owed
          const isBank = cur.kind === 'bank'
          const constName = isBank ? 'BANK_EXTRACTOR_VERSION' : 'INVOICE_EXTRACTOR_VERSION'
          const curVer = isBank ? fresh.bankExtractorVersion : fresh.invoiceExtractorVersion
          const priorVer = isBank ? prior.bankExtractorVersion : prior.invoiceExtractorVersion
          expect(
            curVer > priorVer,
            `Refusing to regenerate: "${id}" output changed for UNCHANGED input (an extractor change) but ` +
              `${constName} is still ${curVer} (was ${priorVer}). Bump ${constName} by exactly 1 first, THEN regenerate.`
          ).toBe(true)
        }
      }
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(fresh, null, 2) + '\n', 'utf8')
      expect(existsSync(SNAPSHOT_PATH)).toBe(true)
    })
  } else {
    const committed: SnapshotFile = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))

    it('the committed snapshot covers exactly the current corpus', () => {
      expect(Object.keys(committed.fixtures).sort()).toEqual(Object.keys(fresh.fixtures).sort())
    })

    for (const [id, cur] of Object.entries(fresh.fixtures)) {
      it(`${id}: output matches the snapshot (else a version bump + regenerate is required)`, () => {
        const prev = committed.fixtures[id]
        expect(prev, `no committed snapshot entry for "${id}" — regenerate the snapshot`).toBeDefined()
        if (cur.hash === prev.hash) return // output unchanged — the version is irrelevant

        const isBank = cur.kind === 'bank'
        const constName = isBank ? 'BANK_EXTRACTOR_VERSION' : 'INVOICE_EXTRACTOR_VERSION'
        const curVer = isBank ? fresh.bankExtractorVersion : fresh.invoiceExtractorVersion
        const prevVer = isBank ? committed.bankExtractorVersion : committed.invoiceExtractorVersion
        const regen =
          'UPDATE_EXTRACTOR_SNAPSHOT=1 npx vitest run tests/integration/extractor-realworld.test.ts'
        // The fixture INPUT hash tells a corpus edit apart from a real extractor change: only the latter
        // (output moved for UNCHANGED input) must bump the version.
        if (prev.inputHash !== cur.inputHash) {
          throw new Error(
            `Fixture "${id}" was EDITED (its input changed), so its parsed output moved. This is a corpus ` +
              `change, not an extractor change — no version bump needed. Regenerate the snapshot:\n  ${regen}`
          )
        }
        throw new Error(
          curVer > prevVer
            ? `Extractor output changed for "${id}" (unchanged input) and ${constName} was bumped ` +
              `(${prevVer} → ${curVer}) — GOOD. Regenerate the committed snapshot in this commit:\n  ${regen}`
            : `Extractor output changed for "${id}" (unchanged fixture input — an extractor change) but ` +
              `${constName} is still ${curVer}. Every extractor behaviour change must bump the version by ` +
              `exactly 1 (plan §0) so stale rows re-extract. Either revert, or bump ${constName} AND ` +
              `regenerate the snapshot:\n  ${regen}`
        )
      })
    }
  }
})
