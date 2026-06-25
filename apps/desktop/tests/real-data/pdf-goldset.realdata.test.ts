import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import {
  BANK_STATEMENT_INSTALL_ID,
  bankStatementAnalysisHandler
} from '../../src/main/services/skills/analysis/bank-statement'
import type { SkillAnalysisContext } from '../../src/main/services/skills/analysis/types'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { AuditEventType, DocumentChunkRead, RetrievalScope } from '../../src/shared/types'

// =====================================================================================================
// PDF GEOMETRY-EXTRACTION GOLD-SET HARNESS (Phase 31, plan §3.4 / §6 / D52 / D57) — LOCAL-ONLY.
//
// This is the MEASUREMENT step the Stage-2 gate (D52) depends on: it runs MY REAL German bank
// statements through the ACTUAL Stage-1 path — `PdfParser.parse({ layout:true, maxPages })` → the
// `bankStatementAnalysisHandler` (the same seam the chat path reaches via `readDocumentSegments`) —
// and reports AGGREGATE metrics only. It makes ZERO model calls (Stage 1 is fully deterministic; no
// runtime is constructed here), so recall can be measured with no model at all.
//
// HARD PRIVACY RULE (D57 + CLAUDE.md "never commit user data"): the statements and their per-file
// expectations live in a GITIGNORED corpus folder; ONLY this harness + the README are committed, and
// the harness prints ONLY aggregates — never a row, a figure tied to a statement, a description, or a
// filename excerpt. The only thing that ever leaves this folder is the summary table you copy by hand
// into BUILD_STATE.md / the design record.
//
// GATED behind `HILBERTRAUM_PDF_GOLDSET=1` via `describe.runIf`, so `npm test` NEVER runs it (it is
// COLLECTED — FullSuiteGuard-safe — but skipped without the flag). Run it with:
//   HILBERTRAUM_PDF_GOLDSET=1 npx vitest run tests/real-data/pdf-goldset.realdata.test.ts
//   (PowerShell:  $env:HILBERTRAUM_PDF_GOLDSET=1; npx vitest run tests/real-data/pdf-goldset.realdata.test.ts)
//
// Corpus location: $HILBERTRAUM_PDF_GOLDSET_DIR, else the gitignored `./corpus` next to this file.
// Drop `<name>.pdf` + `<name>.expected.json` pairs in there (schema in this folder's README.md).
// =====================================================================================================

const RUN = process.env.HILBERTRAUM_PDF_GOLDSET === '1'
const CORPUS_DIR = process.env.HILBERTRAUM_PDF_GOLDSET_DIR ?? join(__dirname, 'corpus')
const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

// The user-facing strings the D56 gate emits when it does NOT present any single-currency figure. A
// figure was shown iff NONE of these three appear — this mirrors the exact branches in `buildBankAnswer`.
const INCOMPLETE = tr('skills.bankAnalysis.incompleteNoTotal')
const NO_CURRENCY = tr('skills.bankAnalysis.noCurrency')
const EMPTY = tr('skills.bankAnalysis.empty')
// The D56 REFINEMENT: a presented figure is either a VERIFIED statement total (the gate proved
// opening + Σ == closing) or a clearly-LABELLED UNVERIFIED sum of the rows read (no balance to confirm
// completeness, nothing contradicting). The count-independent fragment of the unverified caveat tells
// the two apart — only a VERIFIED total carries the cardinal "no partial/hallucinated total" guarantee
// (an unverified sum is explicitly NOT a statement total, so it may honestly come from an over/under-
// extracted set; the honesty lives in the caveat, not in refusing the number).
const UNVERIFIED_MARK = 'not a verified statement total'

/** Per-statement ground truth (gitignored `<name>.expected.json`). Only `trueRowCount` is required
 *  (omittable when `imageOnly` — a scan has no text-layer rows to recall). */
interface Expectation {
  /** The true number of transaction rows printed on the statement (hand-counted). */
  trueRowCount?: number
  /**
   * The statement is an IMAGE-ONLY scan (no text layer) — e.g. a user "blacked out" / flattened it to
   * an image. Stage 1 reads the text layer, so it recovers nothing and `PdfParser.parse` raises the
   * scan-detected error. Marked statements are EXCLUDED from the recall/gate aggregates (recovering
   * them is the OCR path's job, not geometry) and instead SAFETY-asserted: 0 rows, no total, 0 model
   * calls — a user who blacks/scans a statement must never get a confident wrong total. The parse throw
   * is auto-detected too, so this flag is belt-and-braces / documentation of intent.
   */
  imageOnly?: boolean
  /** ISO-4217 currency, if you want to assert it; Stage 1 detects it either way. */
  currency?: string
  /** The printed opening balance (Anfangssaldo / balance brought forward), if the statement prints one. */
  openingBalance?: number
  /** The printed closing balance (Endsaldo / balance carried forward), if the statement prints one. */
  closingBalance?: number
  /** Page cap for the layout parse (defaults to 200 — generous for a statement). */
  maxPages?: number
  /** Free-text note (bank, period) — NEVER printed by this harness; for your own bookkeeping. */
  notes?: string
}

interface PerStatement {
  trueRows: number
  extractedRows: number
  /** Any single-currency figure was presented (a VERIFIED total OR an UNVERIFIED labelled sum). */
  totalPresented: boolean
  /** A VERIFIED statement total was presented (the gate PROVED opening + Σ == closing). */
  verifiedTotal: boolean
  /** A clearly-LABELLED UNVERIFIED sum was presented (no balance to confirm completeness — D56 refinement). */
  unverifiedTotal: boolean
  /** The presented net (Σ amounts) when any figure was shown, else null. */
  presentedNet: number | null
  /** The persisted opening/closing the gate tied against (from `bank_statements`). */
  persistedOpening: number | null
  persistedClosing: number | null
  expectedOpening: number | null
  expectedClosing: number | null
  modelCalls: number
  /** Image-only scan (no text layer): excluded from recall/gate, safety-asserted instead. */
  scanned: boolean
}

const MONEY_EPS = 0.005

/** Parse the statement's layout-mode segments — the SAME reader the bank seam reaches at analysis time. */
async function parseSegments(pdfPath: string, layout: boolean, maxPages: number): Promise<DocumentChunkRead[]> {
  const parsed = await PdfParser.parse(pdfPath, { layout, maxPages })
  return parsed.segments.map((s, index) => ({ text: s.text, page: s.pageNumber ?? null, index }))
}

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-pdfgold-db-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

/** Seed `documents` + one chunk per reconstructed line (citations/coverage read the chunks table). */
function seedDoc(db: Db, segments: DocumentChunkRead[]): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, 'statement.pdf', 'indexed', 'application/pdf', ?, ?, ?)`
  ).run(docId, now, now, now)
  let idx = 0
  for (const seg of segments) {
    for (const line of seg.text.split('\n')) {
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
         VALUES (?, ?, ?, ?, 'statement.pdf', ?, ?)`
      ).run(randomUUID(), docId, idx++, line, seg.page ?? 1, now)
    }
  }
  return docId
}

/** Build the analysis context — the bank handler sets `layout:true`, which arrives here as opts.layout. */
function ctxFor(
  db: Db,
  docId: string,
  pdfPath: string,
  maxPages: number,
  events: Array<{ type: AuditEventType; meta?: Record<string, unknown> }>
): SkillAnalysisContext {
  const scope: RetrievalScope = { documentIds: [docId] }
  return {
    db,
    scope,
    // An analysis-shaped question so the handler runs (any of the bank keywords works).
    question: 'summarize the transactions and the total',
    skillInstallId: BANK_STATEMENT_INSTALL_ID,
    conversationId: null,
    audit: (type, meta) => events.push({ type, meta }),
    tr,
    readDocumentSegments: (_id, opts) => parseSegments(pdfPath, opts?.layout === true, maxPages)
  }
}

/** Run one statement through the real Stage-1 path and pull the metrics from the PERSISTED result. */
async function measureOne(pdfPath: string, exp: Expectation): Promise<PerStatement> {
  const maxPages = exp.maxPages ?? 200
  /** A scan / image-only statement: 0 rows, no total, 0 model calls (the safe outcome). */
  const scannedResult = (): PerStatement => ({
    trueRows: exp.trueRowCount ?? 0,
    extractedRows: 0,
    totalPresented: false,
    verifiedTotal: false,
    unverifiedTotal: false,
    presentedNet: null,
    persistedOpening: null,
    persistedClosing: null,
    expectedOpening: exp.openingBalance ?? null,
    expectedClosing: exp.closingBalance ?? null,
    modelCalls: 0,
    scanned: true
  })
  const db = freshDb()
  let segments: DocumentChunkRead[]
  try {
    segments = await parseSegments(pdfPath, true, maxPages)
  } catch {
    // PdfParser raises the scan-detected error for an image-only PDF (no text layer) — the
    // user-blacks-out/scans case. Stage 1 reads the text layer, so it recovers nothing; record it as
    // a scanned statement (excluded from recall, safety-asserted below). NEVER a model call.
    return scannedResult()
  }
  if (exp.imageOnly) return scannedResult() // declared image-only (belt-and-braces if any text slipped in)
  const docId = seedDoc(db, segments)
  const events: Array<{ type: AuditEventType; meta?: Record<string, unknown> }> = []
  const res = await bankStatementAnalysisHandler.run!(ctxFor(db, docId, pdfPath, maxPages, events))

  // The persisted statement IS what the handler measured — read counts/balances straight from it.
  const stmt = db
    .prepare(
      `SELECT id, opening_balance AS opening, closing_balance AS closing
       FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(docId) as { id: string; opening: number | null; closing: number | null } | undefined
  const extractedRows = stmt
    ? (db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE statement_id = ?').get(stmt.id) as { n: number })
        .n
    : 0
  const sumRow = stmt
    ? (db
        .prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM bank_transactions WHERE statement_id = ?')
        .get(stmt.id) as { s: number })
    : { s: 0 }

  // Stage 1 runs ONLY the deterministic read-only bank tools (no runtime is constructed). Any other
  // tool firing — notably the confirm-gated `export_transactions_csv` — would mean the path did
  // something it must not; that proxies "this stayed a 0-model-call deterministic run".
  const READ_ONLY_TOOLS = new Set([
    'extract_transactions',
    'summarize_cashflow',
    'validate_statement_balances',
    'categorize_transactions'
  ])
  const modelCalls = events.filter(
    (e) => typeof e.meta?.toolName === 'string' && !READ_ONLY_TOOLS.has(e.meta.toolName as string)
  ).length

  const totalPresented =
    !res.answer.includes(INCOMPLETE) && !res.answer.includes(NO_CURRENCY) && !res.answer.includes(EMPTY)
  // A presented figure is VERIFIED only when it does NOT carry the unverified caveat (D56 refinement).
  const unverifiedTotal = totalPresented && res.answer.includes(UNVERIFIED_MARK)
  const verifiedTotal = totalPresented && !unverifiedTotal

  return {
    trueRows: exp.trueRowCount ?? 0,
    extractedRows,
    totalPresented,
    verifiedTotal,
    unverifiedTotal,
    presentedNet: totalPresented ? Math.round(sumRow.s * 100) / 100 : null,
    persistedOpening: stmt?.opening ?? null,
    persistedClosing: stmt?.closing ?? null,
    expectedOpening: exp.openingBalance ?? null,
    expectedClosing: exp.closingBalance ?? null,
    modelCalls,
    scanned: false
  }
}

/** Discover `<name>.pdf` files that have a sibling `<name>.expected.json`. */
function discover(dir: string): Array<{ pdf: string; exp: Expectation; name: string }> {
  if (!existsSync(dir)) return []
  const out: Array<{ pdf: string; exp: Expectation; name: string }> = []
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith('.pdf')) continue
    const stem = entry.slice(0, -4)
    const expPath = join(dir, `${stem}.expected.json`)
    if (!existsSync(expPath)) continue
    const exp = JSON.parse(readFileSync(expPath, 'utf8')) as Expectation
    out.push({ pdf: join(dir, entry), exp, name: stem })
  }
  return out
}

describe.runIf(RUN)('PDF geometry-extraction — Stage-1 gold-set measurement (local-only, D57)', () => {
  let corpus: Array<{ pdf: string; exp: Expectation; name: string }> = []

  beforeAll(() => {
    corpus = discover(CORPUS_DIR)
    // eslint-disable-next-line no-console
    console.log(
      `\n[pdf-goldset] corpus dir: ${CORPUS_DIR}\n[pdf-goldset] statements with expectations: ${corpus.length}\n`
    )
  })

  it('measures Stage-1 recall + the D56 completeness gate over the real corpus', async () => {
    if (corpus.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        '[pdf-goldset] No <name>.pdf + <name>.expected.json pairs found. Drop statements in the corpus ' +
          'dir (see tests/real-data/README.md) and re-run. Nothing measured.'
      )
      return
    }

    const all: PerStatement[] = []
    for (const { pdf, exp } of corpus) all.push(await measureOne(pdf, exp))

    // Image-only scans (no text layer — the user-blacks-out/scans case) are EXCLUDED from the recall
    // and gate aggregates: recovering them is the OCR path's job, not geometry, so folding them in would
    // measure "no OCR here", not column quality. They are safety-asserted separately below.
    const scanned = all.filter((r) => r.scanned)
    const results = all.filter((r) => !r.scanned)

    // ---- Aggregate metrics (the ONLY thing safe to surface; never per-statement content) ----------
    const n = results.length
    const sumTrue = results.reduce((a, r) => a + r.trueRows, 0)
    const sumExtracted = results.reduce((a, r) => a + r.extractedRows, 0)
    const microRecall = sumTrue > 0 ? sumExtracted / sumTrue : 0
    const macroRecall =
      n > 0 ? results.reduce((a, r) => a + (r.trueRows > 0 ? Math.min(r.extractedRows / r.trueRows, 1) : 0), 0) / n : 0
    const perfectRecall = results.filter((r) => r.extractedRows >= r.trueRows).length
    // Precision signal (audit M4): `perfectRecall` uses `>=` and macro caps each statement at 100%, so an
    // OVER-extracted statement reads as "full recall" in both — only THIS line and micro-recall (>100%)
    // surface the phantom rows the deferred money-column model will fix. A non-zero count is a precision
    // issue, not a safety one (over-extraction breaks the completeness tie → the gate downgrades).
    const overExtracted = results.filter((r) => r.extractedRows > r.trueRows).length

    // "Gate pass" = a VERIFIED total (the gate proved opening + Σ == closing). UNVERIFIED labelled sums
    // (no printed balance, nothing contradicting — the D56 refinement) are counted separately: they are
    // a legitimate presented figure, but NOT a completeness proof.
    const gatePass = results.filter((r) => r.verifiedTotal).length
    const gatePassRate = n > 0 ? gatePass / n : 0
    const unverifiedPresented = results.filter((r) => r.unverifiedTotal).length

    // Figure exact-match: of statements whose expectation prints opening/closing, how many did Stage 1
    // persist EXACTLY (the verbatim figures the gate ties against).
    const withBalances = results.filter((r) => r.expectedOpening != null && r.expectedClosing != null)
    const balanceExact = withBalances.filter(
      (r) =>
        r.persistedOpening != null &&
        r.persistedClosing != null &&
        Math.abs(r.persistedOpening - (r.expectedOpening as number)) < MONEY_EPS &&
        Math.abs(r.persistedClosing - (r.expectedClosing as number)) < MONEY_EPS
    ).length

    // ---- D56 cardinal safety invariants (these MUST hold on any data, scans INCLUDED) -------------
    // The guarantee applies to VERIFIED totals — the figure presented AS the whole statement total. An
    // UNVERIFIED labelled sum is explicitly "a sum of the rows read, NOT a verified statement total"
    // (D56 refinement), so it is allowed to come from an over/under-extracted set; the honesty is in the
    // caveat, not in refusing the number. Guarding `verifiedTotal` keeps the cardinal property exactly:
    // a number the user could mistake for THE statement total must never come from an incomplete read.
    //
    // Partial-total-presented: a VERIFIED total was shown but we did NOT extract every true row (a
    // confident whole-claiming total from an incomplete set — exactly what D56 forbids).
    const partialTotals = all.filter((r) => r.verifiedTotal && r.extractedRows < r.trueRows)
    // Hallucinated figure: a VERIFIED total whose net disagrees with the statement's true net
    // (closing − opening). For a deterministic Stage 1 this should be impossible (the gate proves
    // opening + Σ == closing), so a non-zero count is a real safety regression to investigate.
    const hallucinated = all.filter((r) => {
      if (!r.verifiedTotal || r.presentedNet == null) return false
      if (r.expectedOpening == null || r.expectedClosing == null) return false
      const expectedNet = r.expectedClosing - r.expectedOpening
      return Math.abs(r.presentedNet - expectedNet) >= MONEY_EPS
    })
    const totalModelCalls = all.reduce((a, r) => a + r.modelCalls, 0)
    // Hallucination invariant is ARMED only where a VERIFIED total was presented AND the expectation
    // supplied ground-truth opening/closing to check the net against (audit M5): for any other statement
    // the `hallucinated` predicate is vacuously false, so the "MUST be 0" guarantee is meaningful only
    // over this many statements. Print the armed count so the guarantee can't be silently weakened by
    // adding presented-total statements without ground-truth balances.
    const hallucinationArmed = all.filter(
      (r) => r.verifiedTotal && r.expectedOpening != null && r.expectedClosing != null
    ).length
    // Image-only safety: a scanned statement must extract NOTHING and present NO total (a user who
    // blacks/scans a statement must never get a confident wrong total) — and never a model call.
    const scanLeak = scanned.filter((r) => r.extractedRows > 0 || r.totalPresented || r.modelCalls > 0)

    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
    // eslint-disable-next-line no-console
    console.log(
      [
        '\n================ PDF GOLD-SET — STAGE-1 AGGREGATE METRICS ================',
        `statements measured ......... ${n}  (text-layer; ${scanned.length} image-only scan(s) excluded)`,
        `transaction recall (micro) .. ${pct(microRecall)}  (${sumExtracted}/${sumTrue} rows)`,
        `transaction recall (macro) .. ${pct(macroRecall)}  (mean per-statement, capped at 100%)`,
        `statements at full recall ... ${perfectRecall}/${n}  (recall ≥ 100%; over-extraction counts here)`,
        `over-extracted statements ... ${overExtracted}/${n}  (phantom rows — precision, not safety)`,
        `completeness-gate pass rate . ${pct(gatePassRate)}  (${gatePass}/${n} VERIFIED total: opening+Σ==closing)`,
        `unverified labelled sums ... ${unverifiedPresented}/${n}  (no printed balance, nothing contradicting — D56)`,
        `figure exact-match .......... ${
          withBalances.length > 0 ? `${pct(balanceExact / withBalances.length)} (${balanceExact}/${withBalances.length} with printed balances)` : 'n/a (no expected balances supplied)'
        }`,
        `image-only (scan) statements  ${scanned.length}   (0 rows each — OCR-scope, safe downgrade)`,
        `hallucinated-figure count ... ${hallucinated.length}   (MUST be 0; armed over ${hallucinationArmed}/${gatePass} presented totals w/ ground-truth balances)`,
        `partial-total-presented ..... ${partialTotals.length}   (MUST be 0 — D56)`,
        `model calls (Stage 1) ....... ${totalModelCalls}   (MUST be 0)`,
        '=========================================================================\n'
      ].join('\n')
    )

    // Stage 1 makes zero model calls.
    expect(totalModelCalls).toBe(0)
    // The two D56 cardinal safety invariants — a partial or wrong total presented as truth is the
    // harm the gate exists to prevent. These are hard failures on ANY corpus.
    expect(partialTotals.length, 'a total presented from an incomplete extraction (D56 violation)').toBe(0)
    expect(hallucinated.length, 'a presented total whose net disagrees with the printed balances').toBe(0)
    // Image-only / blacked statements must degrade safely: no rows, no total, no model call.
    expect(scanLeak.length, 'an image-only/blacked statement leaked a row or a total').toBe(0)
    // Recall + exact-match are MEASURED, not asserted — they are the input to the D52 Stage-2 decision.
  }, 600_000)
})
