import type { Db } from '../../db'
import type { Citation, CoverageInfo, RetrievalScope } from '../../../../shared/types'
import type { MessageKey, MessageParams } from '../../../../shared/i18n'
import { documentsInScope } from '../scope-documents'
import { documentChunkCount } from '../../analysis/coverage'
import { skillInstallId } from '../registry'
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

// Analysis-shaped intent: invoice/billing words (EN + DE for the de-AT target). Conservative by design
// (plan §3.2) — an invoice skill answering an off-topic question keeps the relevance path. Bare,
// substring-ambiguous tokens are avoided (no bare "vat"→"private", "ust"→"August", "net"→"internet").
const ANALYSIS_KEYWORDS: readonly string[] = [
  'invoice', 'invoices', 'line item', 'line items', 'total', 'totals', 'subtotal',
  'net total', 'net amount', 'gross', 'amount due', 'tax', 'reconcile', 'reconciles',
  'reconciliation', 'vendor', 'sum', 'how much', 'how many', 'bill', 'billing',
  'rechnung', 'rechnungen', 'faktura', 'betrag', 'beträge', 'netto', 'brutto', 'steuer',
  'umsatzsteuer', 'mehrwertsteuer', 'mwst', 'gesamtbetrag', 'rechnungsbetrag', 'zwischensumme',
  'position', 'positionen', 'lieferant', 'summe', 'wie viel', 'wie viele'
]

function isAnalysisShaped(question: string): boolean {
  const q = question.toLowerCase()
  return ANALYSIS_KEYWORDS.some((k) => q.includes(k))
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

/** The single in-scope ANSWERABLE document, or null when the scope is not exactly one (R2). The chat
 *  analysis path reads the stored `chunks`, so it requires them (`requireChunks: true`) — an indexed
 *  but unchunked document is runnable via the button but not answerable here (X-1, the shared helper). */
function singleInScopeDocument(db: Db, scope: RetrievalScope): { id: string; title: string } | null {
  const docs = documentsInScope(db, scope, { requireChunks: true })
  return docs.length === 1 ? { id: docs[0].id, title: docs[0].title } : null
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
  const intro = tr('skills.invoiceAnalysis.formatIntro', { format: format.toUpperCase() })
  return `${intro}\n\n\`\`\`${format}\n${content}\n\`\`\``
}

/**
 * Build the deterministic, localized answer (Markdown, 0 model calls) — the precedent is
 * `analysis/bank-statement.ts`. Failed reconciliation checks lead (SKILL.md "show any uncertain or
 * unreconciled figures before presenting a total"); the totals print only the figures the invoice
 * actually states (a field that could not be parsed is left out, never invented).
 */
export function buildInvoiceAnswer(
  tr: Tr,
  data: { invoice: InvoiceInput; validation: InvoiceTotalsResult }
): string {
  const { invoice, validation } = data
  const { header, lineItems, totals } = invoice
  const hasTotals =
    totals.netTotal !== undefined || totals.taxTotal !== undefined || totals.grossTotal !== undefined
  if (lineItems.length === 0 && !hasTotals) return tr('skills.invoiceAnalysis.empty')

  const lines: string[] = [tr('skills.invoiceAnalysis.count', { count: lineItems.length })]

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
  return lines.join('\n')
}

export const invoiceAnalysisHandler: SkillAnalysisHandler = {
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
      if (format && hasContent) {
        return {
          answer: buildFormatAnswer(ctx.tr, format, invoice),
          citations: buildInvoiceCitations(db, target.id, target.title),
          coverage: computeCoverage(db, target.id)
        }
      }

      const validateResult = await runInvoiceTotalsValidation(db, args, deps, invoice)
      const validation = validateResult.output ?? validateInvoiceTotals(invoice)

      const answer = buildInvoiceAnswer(ctx.tr, { invoice, validation })
      const citations = buildInvoiceCitations(db, target.id, target.title)
      const coverage = computeCoverage(db, target.id)
      return { answer, citations, coverage }
    })
  }
}
