import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import {
  extractTransactionsTool,
  BANK_EXTRACTOR_VERSION,
  type ExtractTransactionsOutput
} from '../../src/main/services/skills/tools/bank-statement'
import {
  extractInvoiceTool,
  validateInvoiceTotals,
  INVOICE_EXTRACTOR_VERSION,
  type ExtractedInvoice
} from '../../src/main/services/skills/tools/invoice'
import type { DocumentChunkRead, SkillTool } from '../../src/shared/types'
import { tempRoot } from '../helpers/db-fixtures'
import { makeColumnarPdfPages } from '../helpers/fixtures'
import { makeToolCtx } from '../helpers/skill-contexts'
import {
  ALL_FIXTURES,
  BANK_FIXTURES,
  GEOMETRY_BANK_FIXTURES,
  GEOMETRY_INVOICE_FIXTURES,
  INVOICE_FIXTURES,
  INCIDENT_CLASSES,
  type BankFixture,
  type GeometryBankFixture,
  type GeometryInvoiceFixture,
  type GeometryWord,
  type InvoiceFixture
} from '../fixtures/real-layouts/corpus'

// Real-layout extractor tests (skills-remediation T1, audit §7 recs 1 + 2). TWO guards over the ONE
// committed real-layout corpus (tests/fixtures/real-layouts/corpus.ts):
//   1. Real-world extraction — the constructed incident-class layouts run through the PRODUCTION extract
//      tools (`extract_transactions` / `extract_invoice`, their own `run`) and the parsed FIGURES are
//      asserted: signs, grouped amounts, dd.mm.yy/cross-year dates, wrapped payees survive, the
//      Steuerberatung label theft stays dead, phantom summary lines never become items.
//   2. Output snapshot — a per-fixture hash of the full extractor output, committed and keyed by extractor
//      version. Any change to the parsed output FAILS the run unless the affected extractor version was
//      bumped AND the snapshot regenerated — the mechanical backstop for "every extractor behaviour change
//      bumps the version" (plan §0), which green synthetic fixtures did not enforce (INVOICE-TOTALS-1).
// The geometry fixtures are written as real PDFs and read by the production layout parser (#687: this suite
// used to copy the parser's page loop and the tools' bodies; an eval measures production, not a copy of it).
// Offline: no DB, no runtime, no network — runs in the default `npm test`.

// ---- Production extraction (the tools' own `run`, so the corpus sees what users see) -------------------

function toChunks(texts: string[]): DocumentChunkRead[] {
  return texts.map((text, index) => ({ text, page: index + 1, index }))
}

/** Run a production extract tool over one in-scope document serving `chunks`, as the run seam does. */
async function runTool(tool: SkillTool, chunks: DocumentChunkRead[]): Promise<unknown> {
  const { ctx } = makeToolCtx(chunks)
  const result = await tool.run({ documentId: 'd1' }, ctx)
  if (!result.ok) throw new Error(`${tool.name} failed on the corpus: ${result.error}`)
  return result.output
}

/** The corpus geometry is laid out on A4 (its headers sit at y=800, above a US Letter page's 792). */
const A4: readonly [number, number] = [595, 842]

/**
 * A geometry fixture's positioned words written as a real PDF (one A4 page each) and read back by the
 * production layout parser — the year/month carry, trimming and empty-page drop included — mapped to
 * chunks as the skills segment reader maps parser segments. (The parser itself: the stored-copy read and
 * ingestion limits that wrap it in the app are not part of the corpus.) Snapshot-keyed on
 * BANK_EXTRACTOR_VERSION for the bank fixtures: its bump policy explicitly covers `pdf-layout.ts`
 * reconstruction changes — and so a pdf.js change that moves a geometry output demands a bump too, which
 * is right: a statement already extracted under the old read would re-extract differently.
 */
async function layoutChunks(pages: GeometryWord[][]): Promise<DocumentChunkRead[]> {
  // pdf.js drops text above the page box, so an off-page corpus word would vanish without a trace.
  for (const w of pages.flat()) {
    if (w.x < 0 || w.x >= A4[0] || w.y < 0 || w.y >= A4[1]) throw new Error(`corpus word "${w.str}" lies off the A4 page`)
  }
  const path = join(tempRoot('extractor-corpus'), 'fixture.pdf')
  const cells = pages.map((words) => words.map(({ str, x, y }) => ({ text: str, x, y })))
  writeFileSync(path, makeColumnarPdfPages(cells, 10, A4))
  const { segments } = await PdfParser.parse(path, { layout: true })
  return segments.map((s, index) => ({ text: s.text, page: s.pageNumber ?? null, index }))
}

type CorpusFixture = BankFixture | InvoiceFixture | GeometryBankFixture | GeometryInvoiceFixture

interface CorpusRun {
  kind: 'bank' | 'invoice'
  /** The fixture's INPUT, as hashed for the snapshot (its chunks, or its geometry pages). */
  input: unknown
  output: unknown
  /** Why production threw for this fixture: its rows fail by name instead of the whole file failing to collect. */
  error?: string
}

/** Every fixture through production ONCE — the figure assertions and the snapshot read the same run. */
async function runCorpus(): Promise<Map<string, CorpusRun>> {
  const runs = new Map<string, CorpusRun>()
  // Collection-time work (the snapshot rows are built from these runs): a fixture whose run throws is recorded,
  // not rethrown, so one broken fixture fails its own rows by name and the rest of the corpus still runs.
  const run = async (kind: CorpusRun['kind'], input: unknown, produce: () => Promise<unknown>): Promise<CorpusRun> => {
    try {
      return { kind, input, output: await produce() }
    } catch (e) {
      return { kind, input, output: null, error: e instanceof Error ? e.message : String(e) }
    }
  }
  for (const fx of BANK_FIXTURES) {
    runs.set(fx.id, await run('bank', fx.chunks, () => runTool(extractTransactionsTool, toChunks(fx.chunks))))
  }
  // Geometry fixtures snapshot as 'bank': their output is keyed on BANK_EXTRACTOR_VERSION, whose bump
  // policy explicitly covers the `pdf-layout.ts` reconstruction (see the constant's docstring).
  for (const fx of GEOMETRY_BANK_FIXTURES) {
    runs.set(fx.id, await run('bank', fx.pages, async () => runTool(extractTransactionsTool, await layoutChunks(fx.pages))))
  }
  for (const fx of INVOICE_FIXTURES) {
    runs.set(fx.id, await run('invoice', fx.chunks, () => runTool(extractInvoiceTool, toChunks(fx.chunks))))
  }
  // Geometry invoice fixtures snapshot as 'invoice' (invoice-hardening P4): keyed on the INVOICE
  // extractor version; `reconstructPage` changes ride the bank version's bump policy (see above). The
  // layout read is the production shape of the P3 suspect-retry (`analysis/invoice.ts` re-reads a soup
  // document via the layout segment reader).
  for (const fx of GEOMETRY_INVOICE_FIXTURES) {
    runs.set(fx.id, await run('invoice', fx.pages, async () => runTool(extractInvoiceTool, await layoutChunks(fx.pages))))
  }
  return runs
}

const RUNS = await runCorpus()

function outputOf(fx: CorpusFixture): unknown {
  const run = RUNS.get(fx.id)
  if (!run) throw new Error(`no production run for fixture "${fx.id}"`)
  if (run.error !== undefined) throw new Error(`the production run for fixture "${fx.id}" threw: ${run.error}`)
  return run.output
}
const bankOut = (fx: BankFixture | GeometryBankFixture): ExtractTransactionsOutput =>
  outputOf(fx) as ExtractTransactionsOutput
const invoiceOut = (fx: InvoiceFixture | GeometryInvoiceFixture): ExtractedInvoice => outputOf(fx) as ExtractedInvoice

// ---- Snapshot plumbing (stable serialization + hash) ---------------------------------------------------

const SNAPSHOT_PATH = resolve(__dirname, '../fixtures/real-layouts/extractor-output.snapshot.json')
const UPDATE = process.env.UPDATE_EXTRACTOR_SNAPSHOT === '1'
const REGENERATE = 'UPDATE_EXTRACTOR_SNAPSHOT=1 npx vitest run tests/integration/skills-extractor-corpus.test.ts'

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
  for (const [id, { kind, input, output, error }] of RUNS) {
    // A run that threw snapshots as its error, so the per-fixture comparison names it (and regeneration refuses it).
    const out = error === undefined ? output : { productionRunFailed: error }
    fixtures[id] = { kind, inputHash: sha256(stableStringify(input)), hash: sha256(stableStringify(out)), output: out }
  }
  return {
    $comment:
      'GENERATED — do not hand-edit. Committed output-snapshot for the real-layout corpus, keyed by ' +
      `extractor version. Regenerate in the SAME commit as any extractor version bump: ${REGENERATE}`,
    bankExtractorVersion: BANK_EXTRACTOR_VERSION,
    invoiceExtractorVersion: INVOICE_EXTRACTOR_VERSION,
    fixtures
  }
}

// ---- 1. Real-world extraction assertions --------------------------------------------------------------

describe('real-layout corpus — figures parse correctly through the production extract tools', () => {
  it('fixture ids are unique across the plain and geometry corpora (a collision would silently shadow a snapshot entry)', () => {
    const ids = [...ALL_FIXTURES, ...GEOMETRY_BANK_FIXTURES, ...GEOMETRY_INVOICE_FIXTURES].map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the corpus exercises every incident class (audit §7 rec 1 consolidation)', () => {
    const covered = new Set(
      [...ALL_FIXTURES, ...GEOMETRY_BANK_FIXTURES, ...GEOMETRY_INVOICE_FIXTURES].flatMap((f) => f.incidentClasses)
    )
    for (const cls of INCIDENT_CLASSES) {
      expect(covered.has(cls), `no fixture exercises incident class "${cls}"`).toBe(true)
    }
  })

  it('bank-at-elba: NBSP grouping, U+2212 signs, cross-year + dd.mm.yy dates, wrapped SEPA payee, balances', () => {
    const out = bankOut(BANK_FIXTURES[0])
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
    const out = bankOut(BANK_FIXTURES[1])
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

  it('bank-at-ddmmyy: period lines invent NO transaction; dd.mm.yy trailing dates are not the balances (R7, SKA-1/2)', () => {
    const out = bankOut(BANK_FIXTURES[2])
    expect(out.currency).toBe('EUR')
    // The two period lines (`01.03.2026 bis 31.03.2026`, `15.03.26 bis 31.03.26 Zinsperiode`) used to
    // invent {description: "bis", amount: 30.04 / 3103.26} rows — exactly 3 REAL rows survive, none "bis".
    expect(out.transactions).toHaveLength(3)
    expect(out.transactions.map((t) => t.description)).toEqual([
      'Kartenzahlung REWE',
      'SEPA-Gutschrift Miete Anteil',
      'Dauerauftrag Sparen'
    ])
    expect(out.transactions.map((t) => t.amount)).toEqual([-19.15, 250, -100])
    // The dd.mm.yy row completes against the 2026-03 anchor (R5 still holds through the blanked scan).
    expect(out.transactions[1].date).toBe('2026-03-05')
    // Balance lines: the printed figures win over their dd.mm.yy trailing dates (were 103.26 / 3103.26).
    expect(out.openingBalance).toBe(1000)
    expect(out.closingBalance).toBe(1130.85)
    // Money-less dd.mm.yy period lines are NOT money-bearing → the whole-statement claim stands.
    expect(out.droppedRowCount).toBe(0)
  })

  it('bank-at-ocr-dropped-row: an invalid-date money-bearing row is dropped AND counted — droppedRowCount 1 (T2, U1)', () => {
    // T2 (skills-audit-2026-07-03 §5): the corpus finally carries a droppedRowCount > 0 statement. The
    // `31.02.2026` Rücklastschrift line is date-SHAPED (LEADING_DATE_SHAPE) and money-bearing
    // (hasMoneyToken) but cannot parse (Feb 31) — it must be counted, never silently vanish.
    // Teeth: revert U1's droppedWithFigure counting (or the R7 SHAPE gate) → dropped reads 0 → red.
    const out = bankOut(BANK_FIXTURES[3])
    expect(out.currency).toBe('EUR')
    expect(out.transactions).toHaveLength(2)
    expect(out.transactions.map((t) => t.description)).toEqual(['Kartenzahlung REWE', 'SEPA-Gutschrift Gehalt'])
    // NBSP grouping + U+2212 signs still hold on the kept rows (R1) — the dropped line stole nothing.
    expect(out.transactions.map((t) => t.amount)).toEqual([-19.15, 2100])
    // The one unreadable money-bearing line is COUNTED (the honesty signal the analysis gate consumes).
    expect(out.droppedRowCount).toBe(1)
    // A listing prints no opening/closing balance — nothing may invent one.
    expect(out.openingBalance).toBeUndefined()
    expect(out.closingBalance).toBeUndefined()
  })

  it('bank-de-contradicted-closing: rows + printed balances all parse; the refuted Endsaldo is served AS PRINTED (T2, D56)', () => {
    // The extractor is a faithful reader: it reports the printed opening/closing VERBATIM even when the
    // rows refute them — the 'contradicted' verdict is the ANALYSIS layer's (assessCompleteness), pinned
    // end-to-end in skills-analysis-bank.test.ts. Here: both rows parse (dropped 0), opening 500,
    // closing 999.99 (the refuted print), Σ(rows) = 80 ≠ 499.99.
    const out = bankOut(BANK_FIXTURES[4])
    expect(out.currency).toBe('EUR')
    expect(out.transactions).toHaveLength(2)
    expect(out.transactions.map((t) => t.amount)).toEqual([-20, 100])
    expect(out.droppedRowCount).toBe(0)
    expect(out.openingBalance).toBe(500)
    expect(out.closingBalance).toBe(999.99)
  })

  it('bank-ch-geometry-dot-decimal: d.dd amounts survive the geometry path; in-band d.dd stays the date (R7, SKA-13)', () => {
    const out = bankOut(GEOMETRY_BANK_FIXTURES[0])
    expect(out.currency).toBe('CHF')
    // Before: `5.04`/`1.12` were eaten as out-of-column DATES → each row's only figure was its running
    // balance (balance-as-amount, the cardinal harm). Now the amounts are the amounts.
    expect(out.transactions).toHaveLength(5)
    expect(out.transactions.map((t) => t.amount)).toEqual([5.04, 1.12, 20, 3.5, 10])
    expect(out.transactions.map((t) => t.balanceAfter)).toEqual([1209.44, 1210.56, 1230.56, 1234.06, 1244.06])
    // The IN-band yearless `7.02` is still the booking DATE, completed by the page year.
    expect(out.transactions[3].date).toBe('2026-02-07')
    // Page 2 has no year header: its row completes against the CARRIED document year (the parser's
    // carry — pinned on segment text in pdf-bank-layout, since the extractor's own anchor would complete
    // the date too), and its wrapped-payee continuation absorbs (the d.dd annotation `13.02` is dropped).
    expect(out.transactions[4].date).toBe('2026-02-12')
    expect(out.transactions[4].description).toBe('Gutschrift Ausgleich Wert:')
    // Opening + Σamounts == closing — the tie proves no row lost its amount to the date classifier.
    expect(out.openingBalance).toBe(1204.4)
    expect(out.closingBalance).toBe(1244.06)
    expect(out.droppedRowCount).toBe(0)
  })

  it('invoice-de-ddmmyy-money-headers: money-bearing header lines stay items byte-exact; dd.mm.yy scrubbed (R7, SKA-14/2/1)', () => {
    const inv = invoiceOut(INVOICE_FIXTURES[3])
    const descs = inv.lineItems.map((l) => l.description)
    // SKA-14: the vendor/number label lines with figures are LINE ITEMS (nothing vanished behind a
    // header), and their descriptions carry the untouched mid-line dates BYTE-EXACT (the SKA-1
    // same-length-scrub pin: description slicing off the original text, dates intact).
    expect(descs).toContain('Rechnung Nr. 2026-14 vom 03.05.2026 über')
    expect(descs).toContain('From 01.06.2026 to 30.06.2026 Hosting')
    expect(inv.lineItems.find((l) => l.description.endsWith('über'))?.lineTotal).toBe(390)
    expect(inv.lineItems.find((l) => l.description.endsWith('Hosting'))?.lineTotal).toBe(49)
    // …and the garbage header captures are gone (no vendor/number label line without money exists).
    expect(inv.header.vendor).toBeUndefined()
    expect(inv.header.invoiceNumber).toBeUndefined()
    // SKA-2: `Datum: 15.03.26` is the header date (anchored by 03.05.2026), NOT a 1503.26 phantom item…
    expect(inv.header.invoiceDate).toBe('2026-03-15')
    expect(descs).not.toContain('Datum:')
    // …and the totals line reads its printed figure, not its trailing dd.mm.yy date (was 3006.26).
    expect(inv.totals.grossTotal).toBe(390)
    expect(inv.totals.netTotal).toBe(325)
    expect(inv.totals.taxTotal).toBe(65)
    expect(inv.totals.taxRatePercent).toBe(20)
    expect(inv.lineItems).toHaveLength(3)
    expect(inv.droppedRowCount).toBe(0)
  })

  it('invoice-at-steuerberatung: label theft dead (Steuerberatung stays an item), Steuer→tax, Summe labels, NBSP', () => {
    const inv = invoiceOut(INVOICE_FIXTURES[0])
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
    const inv = invoiceOut(INVOICE_FIXTURES[1])
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
    const inv = invoiceOut(INVOICE_FIXTURES[2])
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

  it('invoice-us-glyph-soup: suspect textQuality stamped; every uncorroborated weak total retracted (P2/P3)', () => {
    const inv = invoiceOut(INVOICE_FIXTURES[4])
    // P3: the fragmented text layer is flagged — the answer layer keys its refusal/retry on this.
    expect(inv.textQuality).toBe('suspect')
    // P2: the incident's confident garbage (net 4 / tax 0 / gross 914, all bare-integer weak reads that
    // contradict the strong 2-dp items) is RETRACTED — the extract carries NO totals.
    expect(inv.totals).toEqual({})
    // The strong 2-dp figures still parse as items (drop-don't-guess applies to the weak reads only).
    expect(inv.lineItems.length).toBeGreaterThan(0)
  })

  it('invoice-de-unreconcilable-totals: printed 2-dp totals kept VERBATIM; the validator reports the mismatch', () => {
    const inv = invoiceOut(INVOICE_FIXTURES[5])
    // Strong decimal-shaped figures are the document's own print — never retracted (the answer layer
    // gates their presentation; P2 touches only weak bare-integer reads).
    expect(inv.totals).toEqual({ netTotal: 300, taxTotal: 60, taxRatePercent: 20, grossTotal: 999 })
    const validation = validateInvoiceTotals(inv)
    expect(validation.reconciled).toBe(false)
    expect(validation.checks.find((c) => c.name === 'lineItemsSumToNet')?.status).toBe('mismatch') // 270 ≠ 300
    expect(validation.checks.find((c) => c.name === 'netPlusTaxIsGross')?.status).toBe('mismatch') // 360 ≠ 999
  })

  it('invoice-de-geometry-columns: a columnar invoice PDF reconstructs and parses CLEANLY through the layout parser (P3 retry path)', () => {
    const inv = invoiceOut(GEOMETRY_INVOICE_FIXTURES[0])
    expect(inv.textQuality).toBeUndefined() // the reconstructed text is NOT soup
    expect(inv.header.invoiceNumber).toBe('G-2026-3')
    expect(inv.header.invoiceDate).toBe('2026-03-15')
    expect(inv.header.currency).toBe('EUR')
    expect(inv.lineItems).toHaveLength(2)
    expect(inv.lineItems.map((l) => l.lineTotal)).toEqual([200, 50])
    expect(inv.totals).toEqual({ netTotal: 250, taxTotal: 50, taxRatePercent: 20, grossTotal: 300 })
    expect(validateInvoiceTotals(inv).reconciled).toBe(true)
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
      // Never commit a fixture whose production run threw.
      expect([...RUNS].filter(([, r]) => r.error !== undefined).map(([id, r]) => `${id}: ${r.error}`)).toEqual([])
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

    // T2 (skills-audit-2026-07-03, §5 closing bullet) — the guard's SELF-CHECKS. The per-fixture
    // comparison below trusts two committed artifacts it never verified: (a) each entry's `hash` field —
    // hand-editing it to match a drifted output would silence the version-bump rule while the committed
    // `output` quietly lies; and (b) the file's recorded extractor versions — after a bump whose fixtures
    // all kept byte-identical output, a stale snapshot would stay green forever, disarming the
    // "bump ⇒ regenerate in the SAME commit" rule at exactly the moment output next moves.
    // Teeth-checked (T2): flip one hex digit of a committed hash → (a) reds; set the snapshot's
    // bankExtractorVersion to CURRENT−1 → (b) reds.
    // ACCEPTED (recorded, not closed): the same-commit INPUT-edit exemption stands — an edited fixture
    // exempts its OWN output change from the bump (`inputHash` differs ⇒ corpus upkeep, not an extractor
    // change). That exemption is inherent to legitimate corpus maintenance; smuggling an extractor change
    // through it would require also editing a fixture, which the corpus half of the diff makes visible.
    it('self-check (a): every committed hash equals sha256(stableStringify(output)) — a hand-edited hash fails', () => {
      for (const [id, entry] of Object.entries(committed.fixtures)) {
        expect(
          sha256(stableStringify(entry.output)),
          `snapshot entry "${id}": the committed hash does not match its own committed output — ` +
            'the snapshot file was hand-edited; regenerate it instead'
        ).toBe(entry.hash)
      }
    })

    it('self-check (b): the snapshot records the CURRENT extractor versions — a stale snapshot after a bump fails loudly', () => {
      expect(
        committed.bankExtractorVersion,
        'BANK_EXTRACTOR_VERSION moved but the committed snapshot was not regenerated in the same commit'
      ).toBe(BANK_EXTRACTOR_VERSION)
      expect(
        committed.invoiceExtractorVersion,
        'INVOICE_EXTRACTOR_VERSION moved but the committed snapshot was not regenerated in the same commit'
      ).toBe(INVOICE_EXTRACTOR_VERSION)
    })

    // (#687) The per-fixture rows below compare input hashes only once an output moved. Without this check a
    // fixture edit that left its output alone keeps a STALE committed input hash, and the next output move on
    // that fixture (an extractor change, in a commit touching no fixture) reads as a corpus edit and escapes
    // the bump rule — the ACCEPTED exemption above, minus the visible corpus diff.
    it('self-check (c): every committed inputHash is the current fixture input — an edit that left the output alone still regenerates', () => {
      for (const [id, cur] of Object.entries(fresh.fixtures)) {
        expect(
          committed.fixtures[id]?.inputHash,
          `snapshot entry "${id}": the fixture input changed since the snapshot was written — regenerate:\n  ${REGENERATE}`
        ).toBe(cur.inputHash)
      }
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
        // The fixture INPUT hash tells a corpus edit apart from a real extractor change: only the latter
        // (output moved for UNCHANGED input) must bump the version.
        if (prev.inputHash !== cur.inputHash) {
          throw new Error(
            `Fixture "${id}" was EDITED (its input changed), so its parsed output moved. This is a corpus ` +
              `change, not an extractor change — no version bump needed. Regenerate the snapshot:\n  ${REGENERATE}`
          )
        }
        throw new Error(
          curVer > prevVer
            ? `Extractor output changed for "${id}" (unchanged input) and ${constName} was bumped ` +
              `(${prevVer} → ${curVer}) — GOOD. Regenerate the committed snapshot in this commit:\n  ${REGENERATE}`
            : `Extractor output changed for "${id}" (unchanged fixture input — an extractor change) but ` +
              `${constName} is still ${curVer}. Every extractor behaviour change must bump the version by ` +
              `exactly 1 (plan §0) so stale rows re-extract. Either revert, or bump ${constName} AND ` +
              `regenerate the snapshot:\n  ${REGENERATE}`
        )
      })
    }
  }
})
