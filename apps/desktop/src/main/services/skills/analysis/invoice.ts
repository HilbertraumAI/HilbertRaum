import type { Db } from '../../db'
import type { Citation, CoverageInfo, RetrievalScope } from '../../../../shared/types'
import type { MessageKey, MessageParams } from '../../../../shared/i18n'
import { documentsInScope } from '../scope-documents'
import { documentChunkCount } from '../../analysis/coverage'
import { getSkill, skillInstallId } from '../registry'
import { matchesSkillDocSignals } from '../selector'
import { routeMatch } from '../vocabulary'
import {
  isInvoiceStale,
  latestInvoiceId,
  runInvoiceExtraction,
  runInvoiceTotalsValidation,
  type InvoiceRunArgs,
  type InvoiceRunDeps
} from '../invoice-run'
import { withDocumentLock } from '../doc-lock'
import {
  buildInvoiceJson,
  buildInvoiceXml,
  lineItemsToCsv,
  validateInvoiceTotals,
  type InvoiceInput,
  type InvoiceTotalsResult
} from '../tools/invoice'
import type { SkillAnalysisContext, SkillAnalysisHandler, SkillAnalysisInput, SkillAnalysisResult } from './types'

// The invoice analysis handler (full-doc-skills plan §3.1/§3.4, Phase 4 / D49 fast-follow). It mirrors
// `bank-statement.ts` for the SECOND Tier-2 content class: on an analysis-shaped invoice question over a
// single in-scope document it AUTO-RUNS the read-only invoice tools through the existing run seam
// (`extract_invoice` → `validate_invoice_totals`) for their persistence + `skill_runs` lifecycle +
// ids/counts audit, then synthesises a deterministic, localized answer whose FIGURES are read from the
// persisted invoice rows (the run seams surface only counts). It NEVER imports/runs
// `runInvoiceCsvExport` (export stays confirm-gated — excluded by construction). The answer honours
// `app-skills/invoice/SKILL.md`: quote the printed figures, surface any failed totals check BEFORE the
// headline gross, never invent a number the invoice does not state. No model call — deterministic copy.

/** The bundled invoice skill's install id (`"app:invoice"`) — the registry key. */
export const INVOICE_INSTALL_ID = skillInstallId('app', 'invoice')

// Analysis-shaped intent now reads the ONE canonical invoice vocabulary (W5, audit §3.2/§4.1): its
// `route|both` entries — invoice/billing words, EN + DE — matched word-boundary for single tokens (`tax` no
// longer intercepts "syntax", `sum` no longer "assume", `steuer` no longer "Steuerberatung") and substring
// for phrases/German stems. The vocabulary is single-sourced with the SKILL.md suggestion keywords
// (parity-tested), so routing and offers no longer drift. Conservative — an off-topic question with the
// invoice skill active keeps the relevance path.
function isAnalysisShaped(question: string): boolean {
  return routeMatch('invoice', question)
}

// Format-transformation intent (invoice-format-2026-07-01): "… als JSON", "as CSV", "im xml format".
// When present, the handler serializes the ALREADY-extracted invoice DETERMINISTICALLY (no model call,
// no invented figure — a serializer cannot read a number the parser did not) instead of the prose
// template. `applies()` stays TRUE (an invoice keyword still owns the turn), so a format ask never leaks
// the raw invoice into the generic RAG/LLM path. Word-bounded so `json`/`csv`/`xml` match only as
// standalone tokens. JSON is checked first (the most common request).
type OutputFormat = 'json' | 'csv' | 'xml'
function detectFormat(question: string): OutputFormat | null {
  const q = question.toLowerCase()
  if (/\bjson\b/.test(q)) return 'json'
  if (/\bxml\b/.test(q)) return 'xml'
  if (/\bcsv\b/.test(q)) return 'csv'
  return null
}

// W3 answer-shape routing (audit §3.1/§8.1). The question selects the ANSWER SHAPE, not document access
// (all three shapes read the same extracted invoice): a summary/reconcile/list ask keeps the
// high-stakes deterministic TEMPLATE; everything else that passed `applies()` streams a model answer over
// the verified data (grounded-data — the new default). A narrow, explicit stem list (the plan's ~10),
// substring-matched (already inside an invoice-shaped `applies()`, so `sum`⊂`assume` over-fire is out of
// reach) — deliberately NOT the broad ANALYSIS_KEYWORDS, so "who is the vendor?" / "wann ist sie fällig?"
// fall through to grounded-data rather than the totals template.
const SUMMARY_KEYWORDS: readonly string[] = [
  'summar', // summary / summarize / summarise
  'overview',
  'überblick',
  'zusammenfass', // Zusammenfassung / zusammenfassen
  'reconcil', // reconcile / reconciliation / reconciled (the shorter stem subsumes the longer)
  'aufstellung',
  'list the item',
  'list the line item',
  'positionen auflisten',
  'alle positionen'
]

// The German reconcile ask "Stimmen die Summen?" / "Stimmt die Summe?" (do the totals add up?). WORD-
// anchored, NOT a bare `stimmen` substring: `stimmen` ⊂ bestimmen / abstimmen / übereinstimmen — all
// plausible in an invoice conversation, and a bare match would over-fire them to the template and rob them
// of the grounded-data model answer the plan intends for non-summary asks.
const RECONCILE_STIMMT_RE = /\bstimm(en|t)\b/

// A WHY / explanatory marker escapes the summary shape even when a summary stem is present: the template
// can only PRINT figures, never EXPLAIN, so "Warum stimmen die Summen nicht?" is a grounded-data question
// (the audit §3.1 / W4 follow-up case — a repeat "summe" intercept must NOT re-serve the byte-identical
// template). Word-bounded so it never fires inside an unrelated word.
const EXPLANATORY_RE = /\b(?:warum|wieso|weshalb|why)\b|\bhow come\b/

function isSummaryShaped(question: string): boolean {
  const q = question.toLowerCase()
  if (EXPLANATORY_RE.test(q)) return false
  return SUMMARY_KEYWORDS.some((k) => q.includes(k)) || RECONCILE_STIMMT_RE.test(q)
}

/** The single in-scope ANSWERABLE document, or null when the scope is not exactly one (R2). The chat
 *  analysis path reads the stored `chunks`, so it requires them (`requireChunks: true`) — an indexed
 *  but unchunked document is runnable via the button but not answerable here (X-1, the shared helper).
 *  Carries `mimeType` too so the W2 plausibility gate can test the doc against the skill's signals. */
function singleInScopeDocument(
  db: Db,
  scope: RetrievalScope
): { id: string; title: string; mimeType: string | null } | null {
  const docs = documentsInScope(db, scope, { requireChunks: true })
  return docs.length === 1 ? { id: docs[0].id, title: docs[0].title, mimeType: docs[0].mimeType } : null
}

/**
 * W2 document-plausibility gate (audit §4.5): after a ZERO-CONTENT extraction, should the turn abandon
 * the empty template and fall through to the ordinary grounded path? Only when the skill DECLARES doc
 * signals (filenamePatterns/MIME) and the document matches NONE of them — positive evidence it isn't an
 * invoice at all (a contract or statement in scope with the invoice skill sticky). Absent signals — an
 * unsignalled skill, or the anomaly where the skill row can't be read — give NO basis to judge, so we
 * KEEP the honest empty answer (mirrors the bank handler's D56 posture). Deterministic; no model call.
 */
function shouldFallThroughOnEmpty(
  db: Db,
  skillInstallId: string,
  doc: { title: string; mimeType: string | null }
): boolean {
  const triggers = getSkill(db, skillInstallId)?.manifest.triggers
  if (!triggers) return false
  const hasAnySignal =
    triggers.mimeTypes.some((m) => m.trim().length > 0) ||
    triggers.filenamePatterns.some((p) => p.trim().length > 0)
  if (!hasAnySignal) return false
  return !matchesSkillDocSignals(triggers, doc)
}

/**
 * Reconstruct the structured invoice from its persisted rows (mirrors invoice-run.ts `loadInvoice`):
 * the pure tool functions take the strict schema shape, so null columns are OMITTED, not passed.
 */
function loadInvoice(db: Db, invoiceId: string): InvoiceInput {
  const inv = db
    .prepare(
      `SELECT vendor, invoice_number AS invoiceNumber, invoice_date AS invoiceDate, due_date AS dueDate,
              currency, net_total AS netTotal, tax_total AS taxTotal, tax_rate AS taxRatePercent,
              gross_total AS grossTotal
       FROM invoices WHERE id = ?`
    )
    .get(invoiceId) as {
    vendor: string | null
    invoiceNumber: string | null
    invoiceDate: string | null
    dueDate: string | null
    currency: string | null
    netTotal: number | null
    taxTotal: number | null
    taxRatePercent: number | null
    grossTotal: number | null
  }
  const header: InvoiceInput['header'] = {}
  if (inv.vendor != null) header.vendor = inv.vendor
  if (inv.invoiceNumber != null) header.invoiceNumber = inv.invoiceNumber
  if (inv.invoiceDate != null) header.invoiceDate = inv.invoiceDate
  if (inv.dueDate != null) header.dueDate = inv.dueDate
  if (inv.currency != null) header.currency = inv.currency
  const totals: InvoiceInput['totals'] = {}
  if (inv.netTotal != null) totals.netTotal = inv.netTotal
  if (inv.taxTotal != null) totals.taxTotal = inv.taxTotal
  if (inv.taxRatePercent != null) totals.taxRatePercent = inv.taxRatePercent
  if (inv.grossTotal != null) totals.grossTotal = inv.grossTotal

  const rows = db
    .prepare(
      `SELECT description, quantity, unit_price AS unitPrice, line_total AS lineTotal, currency
       FROM invoice_line_items WHERE invoice_id = ? ORDER BY row_index`
    )
    .all(invoiceId) as Array<{
    description: string
    quantity: number | null
    unitPrice: number | null
    lineTotal: number
    currency: string
  }>
  const lineItems = rows.map((r) => {
    const li: InvoiceInput['lineItems'][number] = {
      description: r.description,
      lineTotal: r.lineTotal,
      currency: r.currency
    }
    if (r.quantity != null) li.quantity = r.quantity
    if (r.unitPrice != null) li.unitPrice = r.unitPrice
    return li
  })
  return { header, lineItems, totals }
}

/** The persisted date-order provenance flag (R5, audit §5.7) — drives the one honest date caveat, or null. */
function loadDateOrderInferred(db: Db, invoiceId: string): 'evidence' | 'default' | null {
  const row = db
    .prepare('SELECT date_order_inferred AS flag FROM invoices WHERE id = ?')
    .get(invoiceId) as { flag: string | null } | undefined
  return row?.flag === 'default' ? 'default' : row?.flag === 'evidence' ? 'evidence' : null
}

/** The persisted count of money-bearing lines the extractor could NOT parse (U1, audit §2.3) — gates the
 *  "whole invoice" answer claim. 0 (or NULL, a pre-U1 row → treated as "no gate") when nothing was dropped. */
function loadDroppedRowCount(db: Db, invoiceId: string): number {
  const row = db
    .prepare('SELECT dropped_row_count AS n FROM invoices WHERE id = ?')
    .get(invoiceId) as { n: number | null } | undefined
  return row?.n ?? 0
}

const MAX_CITATIONS = 12

/** Cap the inline line-item listing (an invoice with hundreds of positions stays readable; the rest is
 *  one CSV export away). Mirrors the bank handler's `MAX_LISTED_TRANSACTIONS`. */
const MAX_LISTED_ITEMS = 20

interface ChunkRow {
  chunk_index: number
  text: string
  source_label: string | null
  page_number: number | null
  section_label: string | null
}

/**
 * Real source chunks behind the figures (M2-safe) — never a synthesised total. The invoice schema does
 * not record a per-figure source page (unlike `bank_transactions.source_page`), so we cite the
 * document's actual leading `chunks` rows where the header/line items/totals are printed; `[Sn]`
 * labelling matches the rest of the app.
 */
function buildInvoiceCitations(db: Db, documentId: string, title: string): Citation[] {
  const all = db
    .prepare(
      `SELECT chunk_index, text, source_label, page_number, section_label
       FROM chunks WHERE document_id = ? ORDER BY chunk_index`
    )
    .all(documentId) as unknown as ChunkRow[]
  return all.slice(0, MAX_CITATIONS).map((c, i) => ({
    label: `S${i + 1}`,
    sourceTitle: c.source_label ?? title,
    pageNumber: c.page_number,
    section: c.section_label,
    snippet: c.text.length > 280 ? `${c.text.slice(0, 280)}…` : c.text
  }))
}

/** Honest extract coverage (D48): every chunk scanned; `fullyChunked` gates the "whole document" wording. */
function computeCoverage(db: Db, documentId: string): CoverageInfo {
  const chunksTotal = documentChunkCount(db, documentId)
  const row = db
    .prepare('SELECT fully_chunked FROM documents WHERE id = ?')
    .get(documentId) as { fully_chunked: string | null } | undefined
  return {
    mode: 'extract',
    chunksCovered: chunksTotal, // the tool read every chunk
    chunksTotal,
    fullyChunked: row?.fully_chunked != null // NULL (legacy/truncated) → false
  }
}

type Tr = (key: MessageKey, params?: MessageParams) => string

/** Format a parsed figure as a stable 2-dp decimal — the verbatim numeric (matches the CSV export). */
function fmt(n: number): string {
  return n.toFixed(2)
}

/** Map a mismatched check to its localized, content-free explanation (the printed figure stays in totals). */
function checkMessage(tr: Tr, name: InvoiceTotalsResult['checks'][number]['name']): string {
  switch (name) {
    case 'lineItemsSumToNet':
      return tr('skills.invoiceAnalysis.checkLineItemsSumToNet')
    case 'netPlusTaxIsGross':
      return tr('skills.invoiceAnalysis.checkNetPlusTaxIsGross')
    case 'taxMatchesRate':
      return tr('skills.invoiceAnalysis.checkTaxMatchesRate')
  }
}

/**
 * Render the extracted invoice as JSON/CSV/XML inside a fenced code block, with a short honest intro
 * (invoice-format-2026-07-01). Pure serialization of the SAME structured object the extractor produced —
 * the figures are the parser's, so nothing here can invent or transpose a number (the §22-D1 posture
 * holds by construction; a serializer cannot read a figure the parser did not). CSV reuses the existing
 * `lineItemsToCsv` (line items only, matching the CSV export); JSON/XML carry the full header + totals.
 */
export function buildFormatAnswer(tr: Tr, format: OutputFormat, invoice: InvoiceInput): string {
  const content =
    format === 'json'
      ? buildInvoiceJson(invoice)
      : format === 'xml'
        ? buildInvoiceXml(invoice)
        : lineItemsToCsv(invoice.lineItems)
  // §3.6-low (W4): CSV carries the line items ONLY — the header + totals are omitted (they ride in
  // JSON/XML), so the CSV intro says so honestly instead of the generic "the invoice as CSV" claim.
  const intro =
    format === 'csv'
      ? tr('skills.invoiceAnalysis.formatIntroCsv')
      : tr('skills.invoiceAnalysis.formatIntro', { format: format.toUpperCase() })
  return `${intro}\n\n\`\`\`${format}\n${content}\n\`\`\``
}

/** The line-item cap for the grounded-data block (W3 §8.1 4096-ctx guard): totals + header ALWAYS stay
 *  (the fields questions ask about); items past this are dropped from the block with an honest "…and N
 *  more" note. A coarse structural bound — the skill fence is then pre-sized around the block downstream. */
const MAX_DATA_BLOCK_ITEMS = 150

/**
 * Serialize the VERIFIED invoice as the grounded-data block (W3, audit §8.1): the extractor's own JSON +
 * the deterministic reconciliation results + a one-line provenance note. This is authoritative context
 * the model NARRATES (never computes over) — `buildInvoiceJson` emits the parser's figures, so nothing
 * here can invent or transpose a number. Line items past `MAX_DATA_BLOCK_ITEMS` are omitted from the block
 * with an honest count (header + totals always kept). Fixed English, model-facing (rides in the user turn).
 */
export function buildInvoiceDataBlock(invoice: InvoiceInput, validation: InvoiceTotalsResult): string {
  const omitted = Math.max(0, invoice.lineItems.length - MAX_DATA_BLOCK_ITEMS)
  const capped: InvoiceInput =
    omitted > 0 ? { ...invoice, lineItems: invoice.lineItems.slice(0, MAX_DATA_BLOCK_ITEMS) } : invoice
  const lines: string[] = ['Invoice (JSON):', buildInvoiceJson(capped)]
  if (omitted > 0) {
    lines.push(`(${omitted} further line item(s) were parsed but omitted from this block for length.)`)
  }
  lines.push(
    '',
    'Totals reconciliation (computed deterministically by the extractor — do NOT recompute):',
    ...validation.checks.map((c) => `- ${c.name}: ${c.status}`),
    `- overall: ${validation.reconciled ? 'reconciled' : 'NOT reconciled'}`,
    '',
    'Provenance: every value above was parsed and reconciled from the whole document by a deterministic ' +
      'offline extractor. Quote these figures verbatim; do not add, total, convert, or derive any number.'
  )
  return lines.join('\n')
}

/**
 * The deterministic figure echo appended UNDER a grounded-data model answer (W3 §8.1 caveat): the parsed
 * net/tax/gross, verbatim, so a model misquote is immediately contradicted. Localized wrapper + labels;
 * the amounts are the parser's own 2-dp figures. Returns '' when the extraction carried none of the three
 * totals (nothing to echo) — the streaming path then appends nothing.
 */
export function buildTotalsPostscript(tr: Tr, invoice: InvoiceInput): string {
  const { header, lineItems, totals } = invoice
  const currency = header.currency ?? lineItems[0]?.currency ?? ''
  const parts: string[] = []
  if (totals.netTotal !== undefined) {
    parts.push(tr('skills.invoiceAnalysis.figureEchoNet', { amount: fmt(totals.netTotal), currency }))
  }
  if (totals.taxTotal !== undefined) {
    parts.push(tr('skills.invoiceAnalysis.figureEchoTax', { amount: fmt(totals.taxTotal), currency }))
  }
  if (totals.grossTotal !== undefined) {
    parts.push(tr('skills.invoiceAnalysis.figureEchoGross', { amount: fmt(totals.grossTotal), currency }))
  }
  if (parts.length === 0) return ''
  return tr('skills.invoiceAnalysis.figureEcho', { figures: parts.join(' · ') })
}

/**
 * Build the deterministic, localized answer (Markdown, 0 model calls) — the precedent is
 * `analysis/bank-statement.ts`. Failed reconciliation checks lead (SKILL.md "show any uncertain or
 * unreconciled figures before presenting a total"); the totals print only the figures the invoice
 * actually states (a field that could not be parsed is left out, never invented).
 */
export function buildInvoiceAnswer(
  tr: Tr,
  data: {
    invoice: InvoiceInput
    validation: InvoiceTotalsResult
    /** The persisted date-order provenance (R5, audit §5.7). 'default' appends ONE honest date caveat. */
    dateOrderInferred?: 'evidence' | 'default' | null
    /**
     * How many money-bearing lines the extractor could NOT parse (U1, audit §2.3). When > 0 the headline
     * "I read the whole invoice" claim is replaced with an honest "**{count}** read; **{dropped}** line(s)
     * with figures I couldn't parse" — the extractor scanned every section, but did not turn every figure
     * into a line item, and must not assert exhaustiveness while dropping figures silently.
     */
    droppedRowCount?: number
  }
): string {
  const { invoice, validation, dateOrderInferred } = data
  const { header, lineItems, totals } = invoice
  const hasTotals =
    totals.netTotal !== undefined || totals.taxTotal !== undefined || totals.grossTotal !== undefined
  if (lineItems.length === 0 && !hasTotals) return tr('skills.invoiceAnalysis.empty')

  // U1 (audit §2.3): gate the "whole invoice" headline on the dropped-figure count — honest exhaustiveness.
  const dropped = data.droppedRowCount ?? 0
  const lines: string[] = [
    dropped > 0
      ? tr('skills.invoiceAnalysis.countPartial', { count: lineItems.length, dropped })
      : tr('skills.invoiceAnalysis.count', { count: lineItems.length })
  ]

  // W3 (audit §3.1): the loaded header fields as a small "Details" block, so the vendor / invoice-number /
  // date / due-date questions are answered even on the deterministic template path (they were parsed and
  // persisted but never surfaced before). Only a field the invoice actually STATES appears — a missing one
  // is omitted, never invented. The values are the document's own content, quoted verbatim as params.
  const details: string[] = []
  if (header.vendor !== undefined) {
    details.push(tr('skills.invoiceAnalysis.detailVendor', { vendor: header.vendor }))
  }
  if (header.invoiceNumber !== undefined) {
    details.push(tr('skills.invoiceAnalysis.detailInvoiceNumber', { number: header.invoiceNumber }))
  }
  if (header.invoiceDate !== undefined) {
    details.push(tr('skills.invoiceAnalysis.detailInvoiceDate', { date: header.invoiceDate }))
  }
  if (header.dueDate !== undefined) {
    details.push(tr('skills.invoiceAnalysis.detailDueDate', { date: header.dueDate }))
  }
  if (details.length > 0) {
    lines.push('', tr('skills.invoiceAnalysis.detailsHeading'), ...details)
  }

  // Surface FAILED reconciliation checks BEFORE the headline gross (SKILL.md honesty posture).
  const mismatches = validation.checks.filter((c) => c.status === 'mismatch')
  if (mismatches.length > 0) {
    lines.push('', tr('skills.invoiceAnalysis.unreconciledHeading'))
    for (const m of mismatches) {
      lines.push(tr('skills.invoiceAnalysis.unreconciledItem', { check: checkMessage(tr, m.name) }))
    }
  }

  // Totals — print only the figures the invoice states, each verbatim, with the document currency.
  const currency = header.currency ?? lineItems[0]?.currency ?? ''
  if (hasTotals) {
    lines.push('', tr('skills.invoiceAnalysis.totalsHeading'))
    if (totals.netTotal !== undefined) {
      lines.push(tr('skills.invoiceAnalysis.net', { amount: fmt(totals.netTotal), currency }))
    }
    if (totals.taxTotal !== undefined) {
      lines.push(
        totals.taxRatePercent !== undefined
          ? tr('skills.invoiceAnalysis.taxWithRate', {
              amount: fmt(totals.taxTotal),
              currency,
              rate: String(totals.taxRatePercent)
            })
          : tr('skills.invoiceAnalysis.tax', { amount: fmt(totals.taxTotal), currency })
      )
    }
    if (totals.grossTotal !== undefined) {
      lines.push(tr('skills.invoiceAnalysis.gross', { amount: fmt(totals.grossTotal), currency }))
    }
  } else {
    lines.push('', tr('skills.invoiceAnalysis.noTotals'))
  }

  // A bounded line-item listing so "give me the positions" is answerable in EVERY non-empty case (it is
  // just the rows read, each figure quoted verbatim) — mirrors the bank handler's transaction listing.
  // Without it the handler only ever printed a COUNT, so a direct "Gib mir die Positionen" went
  // unanswered.
  if (lineItems.length > 0) {
    lines.push('', tr('skills.invoiceAnalysis.positionsHeading'))
    for (const li of lineItems.slice(0, MAX_LISTED_ITEMS)) {
      lines.push(
        tr('skills.invoiceAnalysis.positionItem', {
          description: li.description,
          amount: fmt(li.lineTotal),
          currency: li.currency
        })
      )
    }
    if (lineItems.length > MAX_LISTED_ITEMS) {
      lines.push(
        tr('skills.invoiceAnalysis.positionsMore', { count: lineItems.length - MAX_LISTED_ITEMS })
      )
    }
  }

  lines.push('', tr('skills.invoiceAnalysis.caveat'))
  // One honest date caveat (R5, audit §5.7): with no evidence of day- vs month-first, the invoice's dotted/
  // slashed dates were read day-first (the de-AT default). A trailing note — never a figure.
  if (dateOrderInferred === 'default') lines.push('', tr('skills.invoiceAnalysis.dateOrderCaveat'))
  return lines.join('\n')
}

export const invoiceAnalysisHandler: SkillAnalysisHandler = {
  // The doc-count-agnostic intent (W2, audit §2.1): an analysis-shaped invoice question, regardless of
  // how many documents are in scope. `applies()` = this AND a single in-scope doc; when it fails ONLY on
  // the count, the chat path narrows to the best-matching invoice or routes (never a silent fall-through).
  intends(input: SkillAnalysisInput): boolean {
    return isAnalysisShaped(input.question)
  },

  applies(input: SkillAnalysisInput): boolean {
    // Cheap pre-flight (R2): a well-defined single in-scope doc + an analysis-shaped invoice question.
    // The refuse / not-fully-chunked routing gate lives in registerRagIpc (Phase 3), not here.
    if (!isAnalysisShaped(input.question)) return false
    return singleInScopeDocument(input.db, input.scope) !== null
  },

  async run(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult> {
    const { db } = ctx
    const target = singleInScopeDocument(db, ctx.scope)
    if (!target) {
      // Defensive: `run` is only reached after `applies()` (which requires one doc); honest fallback.
      return { answer: ctx.tr('skills.invoiceAnalysis.couldNotRead'), citations: [], coverage: computeCoverage(db, '') }
    }

    // Serialize the WHOLE extract→validate→read-back sequence per document (audit PC-1): the seams
    // self-lock, but one outer lock spanning the sequence keeps a re-extract from ANOTHER lane from
    // replacing the invoice BETWEEN this handler's own steps. Re-entrant (inner locks become no-ops);
    // unrelated documents still answer concurrently.
    return withDocumentLock(target.id, async () => {
      const args: InvoiceRunArgs = {
        skillInstallId: ctx.skillInstallId,
        conversationId: ctx.conversationId ?? null,
        documentId: target.id
      }
      const deps: InvoiceRunDeps = {
        audit: ctx.audit,
        signal: ctx.signal,
        now: ctx.now,
        readDocumentSegments: ctx.readDocumentSegments
      }

      // Auto-run the READ-ONLY tools through the run seam (D46). REUSE the latest extracted invoice when
      // one exists and is FRESH (extraction is deterministic, so reusing avoids a duplicate — F5, the
      // parity with the bank path). Re-extract only when NONE exists yet, OR when the latest was produced
      // by an outdated extractor (`isInvoiceStale`): a since-fixed parser bug must not keep serving
      // mis-read figures. A re-extract REPLACES the stale invoice in place (`replaceExisting`) — the old
      // `totals_reconciled` flag goes with it (the validate seam below recomputes it). Export is excluded
      // by construction (`runInvoiceCsvExport` is never imported).
      let invoiceId = latestInvoiceId(db, target.id)
      if (!invoiceId || isInvoiceStale(db, invoiceId)) {
        const extraction = await runInvoiceExtraction(db, args, { ...deps, replaceExisting: true })
        if (!extraction.ok || !extraction.invoiceId) {
          return { answer: ctx.tr('skills.invoiceAnalysis.couldNotRead'), citations: [], coverage: computeCoverage(db, target.id) }
        }
        invoiceId = extraction.invoiceId
      }

      // Reconstruct the invoice ONCE from the persisted rows (the single invoice read — audit P-1), hand
      // it to the validation seam as `preloaded` so it doesn't re-load, and REUSE its validated output
      // instead of recomputing the same pure function (the seam keeps its lifecycle + ids/counts audit).
      // A failed seam returns no `output`; fall back to a pure recompute, preserving the prior answer.
      const invoice = loadInvoice(db, invoiceId)

      // A machine-FORMAT request ("als JSON"/"as CSV"/"xml") is answered by SERIALIZING the already-
      // extracted invoice — deterministic, 0 model calls, no reconciliation needed. Guarded to a
      // non-empty invoice so an empty extraction still gets the honest prose fallback below (never an
      // empty JSON husk dressed up as an answer).
      const format = detectFormat(ctx.question)
      const hasContent =
        invoice.lineItems.length > 0 ||
        invoice.totals.netTotal !== undefined ||
        invoice.totals.taxTotal !== undefined ||
        invoice.totals.grossTotal !== undefined

      // W2 plausibility gate (audit §4.5): the extractor found NO line items or totals. If this document
      // doesn't even look like an invoice by the skill's own manifest signals (filename/MIME), it almost
      // certainly isn't one (a contract in scope with the invoice skill sticky) — fall through to the
      // ordinary grounded path so the LLM answers the user's ACTUAL question, instead of the honest-but-
      // useless "I read the whole invoice but couldn't find any line items or totals" template. A zero-
      // content read on a doc that DOES look like an invoice keeps that honest empty answer. No model.
      if (!hasContent && shouldFallThroughOnEmpty(db, ctx.skillInstallId, target)) {
        return { answer: '', citations: [], fallThrough: true }
      }

      if (format && hasContent) {
        return {
          answer: buildFormatAnswer(ctx.tr, format, invoice),
          citations: buildInvoiceCitations(db, target.id, target.title),
          coverage: computeCoverage(db, target.id)
        }
      }

      const validateResult = await runInvoiceTotalsValidation(db, args, deps, invoice)
      const validation = validateResult.output ?? validateInvoiceTotals(invoice)

      // Citations + coverage are the SAME for the template and grounded-data shapes (both read the whole
      // extracted invoice); the deterministic extractor is the source of truth for figures on both paths.
      const citations = buildInvoiceCitations(db, target.id, target.title)
      const coverage = computeCoverage(db, target.id)

      // W3 answer-shape routing (audit §3.1/§8.1): a summary/reconcile/list ask keeps the high-stakes
      // deterministic TEMPLATE (the plan's "keep for the high-stakes summary shapes"); everything else
      // that passed applies() — "who is the vendor?", "wann ist sie fällig?", "warum stimmt das nicht?" —
      // streams a model answer that NARRATES the verified data object (grounded-data), with the parsed
      // totals echoed deterministically beneath it. The LLM never computes a figure; it reads the data.
      // An EMPTY extraction that reached here (a real invoice with no readable rows/totals — not a
      // fall-through non-invoice) also stays on the template: it owns the honest "couldn't find anything"
      // answer, and there is no verified data to hand a model.
      const dateOrderInferred = loadDateOrderInferred(db, invoiceId)
      const droppedRowCount = loadDroppedRowCount(db, invoiceId)
      if (isSummaryShaped(ctx.question) || !hasContent) {
        const answer = buildInvoiceAnswer(ctx.tr, { invoice, validation, dateOrderInferred, droppedRowCount })
        return { answer, citations, coverage }
      }
      // The grounded-data postscript is the deterministic totals echo (§8.1) PLUS the R5 honest date caveat
      // when the dates were read day-first with no evidence. That caveat is a template appendix (R5, audit
      // §5.7) — and a due-date question ("wann ist die Rechnung fällig?") now routes HERE, so it must ride
      // the grounded-data answer too, else W3 would silently drop R5's honesty for exactly the date
      // questions that need it. Both are deterministic, content-free (beyond the parser's own figures).
      const postscriptParts: string[] = []
      const totalsEcho = buildTotalsPostscript(ctx.tr, invoice)
      if (totalsEcho) postscriptParts.push(totalsEcho)
      if (dateOrderInferred === 'default') postscriptParts.push(ctx.tr('skills.invoiceAnalysis.dateOrderCaveat'))
      return {
        answer: '',
        mode: 'grounded-data',
        dataBlock: buildInvoiceDataBlock(invoice, validation),
        postscript: postscriptParts.join('\n\n'),
        citations,
        coverage
      }
    })
  }
}
