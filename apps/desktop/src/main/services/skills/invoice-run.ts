import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { DocumentChunkRead, SkillToolAudit } from '../../../shared/types'
import {
  buildReadDocumentChunks,
  deleteInvoicesForDocument,
  domainPersistFailure,
  prepareDomainRun,
  runDomainExtractionInner,
  runDomainFileExport,
  type DomainRunConfig,
  type DomainRunFailure,
  type PreparedDomainRun
} from './run'
import { withDocumentLock } from './doc-lock'
import { INVOICE_EXTRACTOR_VERSION } from './tools/invoice'
import type { ExtractInvoiceOutput, InvoiceInput, InvoiceTotalsResult } from './tools/invoice'

// The app-orchestrated run seam for the INVOICE Tier-2 domain (architecture.md "Skills — design
// record" §8). It USED to be a ~500-line layer-for-layer COPY of `run.ts` (audit §6.1); A1 collapsed
// that copy into a per-domain `DomainRunConfig` (`INVOICE_RUN_CONFIG`) over the SHARED engine in
// `run.ts` (`runDomainExtractionInner` / `prepareDomainRun` / `domainPersistFailure` /
// `runDomainFileExport`). This file is now just: the config, the domain persist/load helpers, and thin
// public adapters that own the per-document lock + reshape the generic result to the invoice-named
// `invoiceId`/`lineItemCount` fields. R3's staleness re-extraction lives in the ONE shared prepare path.
// A persist failure ROLLBACKs so NO partial invoice rows survive; the run row is recorded 'started'
// before the gate and always reaches a terminal status (B4). The invoice_* tables are content-class.

const EXTRACT_TOOL_NAME = 'extract_invoice'
const VALIDATE_TOOL_NAME = 'validate_invoice_totals'
const EXPORT_TOOL_NAME = 'export_invoice_csv'

export interface InvoiceRunArgs {
  /** The requesting skill's `install_id` ("<source>:<id>") — for the run row + ids/counts audit. */
  skillInstallId: string
  /** The conversation the run belongs to, if any (a doc-action run may not be a chat). */
  conversationId?: string | null
  /** The single selected document to extract from (becomes the frozen one-id scope). */
  documentId: string
}

export interface InvoiceRunDeps {
  /** ids/counts-only audit sink (the app's recorder adapter; a capturing fn in tests). */
  audit: SkillToolAudit
  /** Cooperative cancellation. */
  signal?: AbortSignal
  /** Optional progress, merged into the polling status by the app. */
  onProgress?: (p: { done: number; total: number }) => void
  /** Clock seam for deterministic tests. */
  now?: () => string
  /**
   * The verbatim content reach: a document's ordered, non-overlapping, newline-preserving parser
   * segments (the IPC injects `extractDocumentPreview`). Required for a FAITHFUL extraction — the
   * stored `chunks` table collapses newlines and overlaps (`resolveDocumentReader`). Absent ⇒ the
   * legacy chunk-table reader (the integration tests that seed `chunks` directly).
   */
  readDocumentSegments?: (documentId: string) => Promise<DocumentChunkRead[]>
  /**
   * Re-extraction (F5 — mirrors the bank `replaceExisting`): when set, DELETE every prior `invoices`
   * row (and its line items) for the document inside the persist transaction BEFORE inserting the fresh
   * one. The reuse path passes it when the latest invoice is STALE (`isInvoiceStale`) so a since-fixed
   * parser bug's rows are replaced — and so re-extraction never accumulates duplicate invoices. The
   * persisted `totals_reconciled` flag on the old row is intentionally NOT carried over (the rows
   * changed; the validate seam recomputes it). Unset (the default) = the additive behaviour.
   */
  replaceExisting?: boolean
}

export interface InvoiceExtractionResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure, so the lifecycle is recorded). */
  runId: string
  /** The created `invoices.id` on success. */
  invoiceId?: string
  /** The number of line items persisted (the content-free count the renderer surfaces). */
  lineItemCount?: number
  /** True when the run ended because it was CANCELLED (vs a genuine failure) — the seam is authority (B2). */
  cancelled?: boolean
  /** A content-free failure reason CODE the renderer localizes (I1). */
  errorCode?: string
  /** A friendly, content-free reason on failure. */
  error?: string
}

export interface InvoiceToolResult {
  ok: boolean
  runId: string
  /** A content-free count the renderer surfaces (checks not reconciling / line items saved). */
  count?: number
  /** A content-free outcome discriminator (validate: 'reconciled'|'unreconciled'|'unchecked'). */
  resultKind?: string
  /**
   * The already-validated structured tool output (`validate_invoice_totals` → `InvoiceTotalsResult`)
   * for IN-PROCESS reuse by the analysis handler (audit P-1: it reuses this instead of recomputing the
   * same pure function over a re-queried invoice). These are FIGURES (content): the handler keeps them
   * in-process and they must NEVER cross into `ToolRunOutcome`/IPC — `tool-runs.ts` maps only counts.
   */
  output?: InvoiceTotalsResult
  cancelled?: boolean
  errorCode?: string
  error?: string
}

/**
 * The newest invoice id for a document, or null if none has been extracted (mirrors
 * `latestBankStatementId`). The single source of truth for "the latest invoice" across both call
 * sites — the downstream run seam (`prepareInvoiceRun`) and the analysis read-back's reuse check
 * (`analysis/invoice.ts`) — so they always resolve the SAME row. The `created_at DESC, id DESC`
 * tie-break is LOAD-BEARING (it decides which invoice is reused / re-extracted).
 */
export function latestInvoiceId(db: Db, documentId: string): string | null {
  const row = db
    .prepare(`SELECT id FROM invoices WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(documentId) as { id: string } | undefined
  return row?.id ?? null
}

/**
 * Whether an invoice was produced by a DIFFERENT extractor than the one running (F5 — mirrors
 * `isBankStatementStale`, incl. the SKA-26 downgrade half). True when its `extractor_version` is NULL
 * (extracted before versioning) or NOT EQUAL to the current `INVOICE_EXTRACTOR_VERSION` — older rows
 * may carry a since-fixed parser bug, and NEWER rows are the rollback case (the roaming-drive
 * rationale + the accepted alternating-installs cost live on the bank twin's doc comment). The reuse
 * path (analysis read-back) re-extracts a stale invoice (with `replaceExisting`) instead of serving
 * its rows. An invoice at the current version is fresh.
 */
export function isInvoiceStale(db: Db, invoiceId: string): boolean {
  const row = db
    .prepare('SELECT extractor_version AS v FROM invoices WHERE id = ?')
    .get(invoiceId) as { v: number | null } | undefined
  if (!row) return false // unknown id — nothing to re-extract (callers handle the missing case)
  return row.v == null || row.v !== INVOICE_EXTRACTOR_VERSION
}

/**
 * Reconstruct the structured invoice from its persisted rows — the pure tool functions take the strict
 * schema shape, so null columns are OMITTED, not passed. This is the ONE authoritative loader (A1 /
 * audit §6.4): `analysis/invoice.ts` imports THIS instead of keeping its own byte-identical copy. It is
 * the invoice half of `INVOICE_RUN_CONFIG.load` (the bank half is `run.ts` `loadTransactions`).
 */
export function loadInvoice(db: Db, invoiceId: string): InvoiceInput {
  const inv = db
    .prepare(
      `SELECT vendor, recipient, invoice_number AS invoiceNumber, invoice_date AS invoiceDate,
              due_date AS dueDate, currency, net_total AS netTotal, tax_total AS taxTotal,
              tax_rate AS taxRatePercent, gross_total AS grossTotal
       FROM invoices WHERE id = ?`
    )
    .get(invoiceId) as {
    vendor: string | null
    recipient: string | null
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
  if (inv.recipient != null) header.recipient = inv.recipient // P3 (invoice-hardening-2026-07-04)
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

/**
 * Persist a schema-validated `extract_invoice` output — the invoice header/totals row + its line items —
 * inside the engine's OPEN transaction; returns the new `invoices.id`. The engine owns
 * BEGIN/COMMIT/ROLLBACK + the `replaceExisting` delete + the `skill_runs` 'done' update, so this is JUST
 * the domain INSERTs (the invoice half of the config's `insertExtraction`).
 */
function insertInvoiceExtraction(
  db: Db,
  { output, documentId, runId, completedAt }: {
    output: ExtractInvoiceOutput
    documentId: string
    runId: string
    completedAt: string
  }
): string {
  const invoiceId = randomUUID()
  const h = output.header
  const t = output.totals
  db.prepare(
    `INSERT INTO invoices
      (id, document_id, run_id, vendor, recipient, invoice_number, invoice_date, due_date, currency,
       net_total, tax_total, tax_rate, gross_total, totals_reconciled, extractor_version,
       date_order_inferred, dropped_row_count, text_quality, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  ).run(
    invoiceId,
    documentId,
    runId,
    h.vendor ?? null,
    h.recipient ?? null, // P3 (invoice-hardening-2026-07-04)
    h.invoiceNumber ?? null,
    h.invoiceDate ?? null,
    h.dueDate ?? null,
    h.currency ?? null,
    t.netTotal ?? null,
    t.taxTotal ?? null,
    t.taxRatePercent ?? null,
    t.grossTotal ?? null,
    INVOICE_EXTRACTOR_VERSION,
    output.dateOrderInferred ?? null,
    output.droppedRowCount ?? null,
    output.textQuality ?? null, // P3: 'suspect' when the text layer looked glyph-mangled
    completedAt
  )
  const insertLi = db.prepare(
    `INSERT INTO invoice_line_items
      (id, invoice_id, run_id, row_index, description, quantity, unit_price, line_total, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  output.lineItems.forEach((li, i) => {
    insertLi.run(
      randomUUID(),
      invoiceId,
      runId,
      i,
      li.description,
      li.quantity ?? null,
      li.unitPrice ?? null,
      li.lineTotal,
      li.currency,
      completedAt
    )
  })
  return invoiceId
}

/**
 * The invoice domain's engine config (A1) — the values/functions that specialize the generic run seam
 * for the invoice content class. Everything this file's former copy of `run.ts` differed by lives here.
 */
const INVOICE_RUN_CONFIG: DomainRunConfig<ExtractInvoiceOutput, InvoiceInput> = {
  extractToolName: EXTRACT_TOOL_NAME,
  latestId: latestInvoiceId,
  isStale: isInvoiceStale,
  // Self-locking re-extraction (re-entrant under a downstream seam's own hold), normalized for the
  // staleness path. Reuses the public `runInvoiceExtraction` so the lock + reshape stay in one place.
  reExtract: async (db, args, deps) => {
    const r = await runInvoiceExtraction(db, args, deps)
    return { ok: r.ok, resultRef: r.invoiceId, cancelled: r.cancelled, error: r.error }
  },
  deleteForDocument: deleteInvoicesForDocument,
  insertExtraction: insertInvoiceExtraction,
  countOf: (output) => output.lineItems.length,
  load: loadInvoice,
  // The invoice is already the strict tool-input shape (`InvoiceInput`) — hand it to the tool unchanged.
  toToolInput: (invoice) => invoice,
  // Invoice downstream prefix binds the SYNC chunk-table reader (lazy, no I/O — inert for the
  // structured-input downstream tools: `validate_invoice_totals` + the three exporters all take rows and
  // never read a chunk). IA-5 (audit P-4) unified this with the bank binding: it USED to await the
  // segment-preferring `resolveDocumentReader`, an EAGER decrypt + PDF-parse + OCR-page materialize on the
  // real IPC path whose result was discarded — a full re-parse held under the per-document lock on every
  // deterministic answer question. The EXTRACTION path (run.ts:357) and the staleness re-extract keep
  // `resolveDocumentReader` untouched; only this downstream reader is now lazy. (Formerly the A1 "left to
  // a follow-up" incidental difference; now closed.)
  buildDownstreamReader: async (db, documentId) => buildReadDocumentChunks(db, new Set([documentId])),
  messages: {
    persistFailed: 'This invoice could not be saved. Nothing was changed.',
    needsExtraction: 'Read the invoice first, then run this tool.',
    extractPersistLog: '[skills] invoice extraction failed to persist',
    extractUnexpectedLog: '[skills] invoice extraction failed unexpectedly',
    prepareUnexpectedLog: '[skills] invoice run failed unexpectedly'
  }
}

/**
 * Run `extract_invoice` on one selected document through the gate and persist the structured invoice.
 * Returns ids/counts only — never the extracted content (which lives only in the invoice_* tables).
 *
 * Serialized per document (audit PC-1): the whole extract+persist — including the `replaceExisting`
 * DELETE+INSERT (F5) — holds the per-document lock so a concurrent run on the SAME document (any lane)
 * cannot race the delete (re-entrant when the analysis lane already holds it; unrelated documents stay
 * concurrent). The lifecycle body is the shared `runDomainExtractionInner`; this adapter owns the lock +
 * reshapes the generic result to the invoice-named `invoiceId`/`lineItemCount` fields.
 */
export async function runInvoiceExtraction(
  db: Db,
  args: InvoiceRunArgs,
  deps: InvoiceRunDeps
): Promise<InvoiceExtractionResult> {
  return withDocumentLock(args.documentId, async () => {
    const r = await runDomainExtractionInner(db, args, deps, INVOICE_RUN_CONFIG)
    // The generic failure object already carries the exact original key set (no resultRef/count on
    // failure), so return it verbatim; only success is reshaped to the invoice-named id/count fields.
    if (!r.ok) return r
    return { ok: true, runId: r.runId, invoiceId: r.resultRef, lineItemCount: r.count }
  }, deps.signal)
}

// ---- The downstream seams (validate / export) ----

/** `prepareDomainRun` specialized to the invoice config (the downstream seams' single prefix). */
function prepareInvoiceRun(
  db: Db,
  toolName: string,
  args: InvoiceRunArgs,
  deps: InvoiceRunDeps,
  confirmed?: boolean,
  preloadedInvoice?: InvoiceInput
): Promise<{ prepared: PreparedDomainRun<InvoiceInput> } | { failed: DomainRunFailure }> {
  return prepareDomainRun(db, toolName, args, deps, INVOICE_RUN_CONFIG, confirmed, preloadedInvoice)
}

/**
 * `validate_invoice_totals` — reconcile the printed totals and persist the overall `totals_reconciled`
 * flag (1 reconciled / 0 not / NULL unchecked) on the invoice. The `count` is the number of checks
 * that DON'T reconcile; `resultKind` distinguishes a clean pass from "nothing could be checked".
 */
export async function runInvoiceTotalsValidation(
  db: Db,
  args: InvoiceRunArgs,
  deps: InvoiceRunDeps,
  preloadedInvoice?: InvoiceInput
): Promise<InvoiceToolResult> {
  // Serialized per document (audit PC-1): the `totals_reconciled` persist must not run against an
  // invoice a concurrent re-extract is replacing. Re-entrant when the analysis lane already holds it;
  // abort-aware while parked behind another lane (SKA-24).
  return withDocumentLock(
    args.documentId,
    () => runInvoiceTotalsValidationInner(db, args, deps, preloadedInvoice),
    deps.signal
  )
}

async function runInvoiceTotalsValidationInner(
  db: Db,
  args: InvoiceRunArgs,
  deps: InvoiceRunDeps,
  preloadedInvoice?: InvoiceInput
): Promise<InvoiceToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareInvoiceRun(db, VALIDATE_TOOL_NAME, args, deps, undefined, preloadedInvoice)
  if ('failed' in prep) return prep.failed
  const { runId, resultRef: invoiceId, output, completedAt } = prep.prepared
  const result = output as InvoiceTotalsResult
  const mismatchCount = result.checks.filter((c) => c.status === 'mismatch').length
  const checkedAny = result.checks.some((c) => c.status !== 'unknown')
  const resultKind = result.reconciled ? 'reconciled' : checkedAny ? 'unreconciled' : 'unchecked'
  try {
    db.exec('BEGIN')
    const flag = result.reconciled ? 1 : checkedAny ? 0 : null
    db.prepare('UPDATE invoices SET totals_reconciled = ? WHERE id = ?').run(flag, invoiceId)
    db.prepare(
      `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
    ).run(completedAt, invoiceId, runId)
    db.exec('COMMIT')
  } catch {
    return domainPersistFailure(db, runId, now, '[skills] invoice tool failed to persist')
  }
  // Surface the validated `InvoiceTotalsResult` for in-process reuse (audit P-1) — the analysis handler
  // reuses it instead of recomputing `validateInvoiceTotals` over a re-queried invoice. Content
  // (figures): in-process only, never mapped into `ToolRunOutcome`/IPC.
  return { ok: true, runId, count: mismatchCount, resultKind, output: result }
}

export interface InvoiceCsvExportDeps extends InvoiceRunDeps {
  /**
   * Save CSV text to a user-chosen path (MAIN-side: a save dialog + write). Returns true once written,
   * false if the user cancelled. The path + content are NEVER logged/audited — the seam only learns
   * whether the user saved (ids/counts boundary, §9.5/§22-M1).
   */
  saveTextFile: (defaultFileName: string, content: string) => Promise<boolean>
  /** True once the user accepted the write/export confirm modal (the gate also enforces it). */
  confirmed?: boolean
}

/**
 * `export_invoice_csv` — produce the CSV (pure tool, confirm-gated `export-file`) and write it
 * MAIN-side to a user-chosen path. The CSV content + the chosen path never touch any log/audit; only
 * "saved N rows" (a count) is surfaced. A cancelled save persists nothing and reports it calmly.
 */
export async function runInvoiceCsvExport(
  db: Db,
  args: InvoiceRunArgs,
  deps: InvoiceCsvExportDeps
): Promise<InvoiceToolResult> {
  return runDomainFileExport(db, args, deps, INVOICE_RUN_CONFIG, {
    toolName: EXPORT_TOOL_NAME,
    defaultFileName: 'invoice-line-items.csv',
    readOutput: (output) => {
      const { csv, rowCount } = output as { csv: string; rowCount: number }
      return { text: csv, rowCount }
    },
    writeFailLog: '[skills] invoice CSV export failed to write'
  })
}

export interface InvoiceFileExportDeps extends InvoiceRunDeps {
  /** Save serialized text to a user-chosen path (MAIN-side: a save dialog + write). Returns true once
   *  written, false if the user cancelled. Path + content are NEVER logged/audited (§9.5/§22-M1). */
  saveTextFile: (defaultFileName: string, content: string) => Promise<boolean>
  /** True once the user accepted the write/export confirm modal (the gate also enforces it). */
  confirmed?: boolean
}

/**
 * `export_invoice_json` / `export_invoice_xml` — the format-transformation exports (invoice-format-2026-07-01).
 * The generic sibling of `runInvoiceCsvExport`: produce the serialized text (pure tool, confirm-gated
 * `export-file`) and write it MAIN-side to a user-chosen path. Every tool of the uniform `{content,
 * rowCount}` output shape shares this seam — only the registry tool name + the default file name differ. The
 * content + the chosen path never touch any log/audit; only "saved N rows" (a count) is surfaced. A cancel
 * writes nothing and reports it calmly (B2), identical to the CSV path.
 */
export async function runInvoiceFileExport(
  db: Db,
  args: InvoiceRunArgs,
  deps: InvoiceFileExportDeps,
  opts: { toolName: string; defaultFileName: string }
): Promise<InvoiceToolResult> {
  return runDomainFileExport(db, args, deps, INVOICE_RUN_CONFIG, {
    toolName: opts.toolName,
    defaultFileName: opts.defaultFileName,
    readOutput: (output) => {
      const { content, rowCount } = output as { content: string; rowCount: number }
      return { text: content, rowCount }
    },
    writeFailLog: '[skills] invoice file export failed to write'
  })
}
