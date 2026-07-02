import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { DocumentChunkRead, SkillToolAudit, SkillToolContext } from '../../../shared/types'
import { getRegisteredTool, runSkillTool } from './tool-registry'
import { deleteInvoicesForDocument, finishRun, resolveDocumentReader } from './run'
import { withDocumentLock } from './doc-lock'
import { INVOICE_EXTRACTOR_VERSION } from './tools/invoice'
import type {
  ExtractInvoiceOutput,
  InvoiceInput,
  InvoiceTotalsResult
} from './tools/invoice'

// The app-orchestrated run seam for the INVOICE Tier-2 domain (architecture.md "Skills — design
// record" §8). It mirrors `run.ts` (the bank seam) layer-for-layer for the second content class:
// build the NARROW `SkillToolContext` (frozen scope + the only content reach, `readDocumentChunks`),
// run the tool THROUGH the gate (`runSkillTool` — validate→run→validate), and persist atomically. The
// downstream tools operate on the ALREADY-EXTRACTED invoice — the seam loads the LATEST invoice for
// the in-scope document and passes it as STRUCTURED INPUT (no new SkillToolContext accessor; the §14
// ceiling is unchanged). The two generic seam helpers (`buildReadDocumentChunks`, `finishRun`) are
// shared with `run.ts`. A persist failure ROLLBACKs so NO partial invoice rows survive
// (no-partial-persist, §12.2); the run row is recorded 'started' before the gate and always reaches a
// terminal status (the B4 guard). The invoice_* tables are content-class: never logged/audited.

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
 * Run `extract_invoice` on one selected document through the gate and persist the structured invoice.
 * Returns ids/counts only — never the extracted content (which lives only in the invoice_* tables).
 *
 * Serialized per document (audit PC-1): the whole extract+persist — including the `replaceExisting`
 * DELETE+INSERT (F5) — holds the per-document lock so a concurrent run on the SAME document (any lane)
 * cannot race the delete (re-entrant when the analysis lane already holds it; unrelated documents stay
 * concurrent).
 */
export async function runInvoiceExtraction(
  db: Db,
  args: InvoiceRunArgs,
  deps: InvoiceRunDeps
): Promise<InvoiceExtractionResult> {
  return withDocumentLock(args.documentId, () => runInvoiceExtractionInner(db, args, deps))
}

async function runInvoiceExtractionInner(
  db: Db,
  args: InvoiceRunArgs,
  deps: InvoiceRunDeps
): Promise<InvoiceExtractionResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]

  // Record the run as started BEFORE the gate (committed; survives a later ROLLBACK of the invoice rows).
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify(documentIds), now())

  // Everything after the 'started' insert is guarded (B4): an unexpected throw must still drive a
  // terminal status — never leave the run stranded at 'started'.
  try {
    const tool = getRegisteredTool(EXTRACT_TOOL_NAME)
    if (!tool) {
      const msg = 'This tool is not available.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'unavailable', error: msg }
    }

    const signal = deps.signal ?? new AbortController().signal
    const ctx: SkillToolContext = {
      documentIds,
      readDocumentChunks: await resolveDocumentReader(db, args.documentId, deps),
      signal,
      onProgress: deps.onProgress,
      audit: deps.audit
    }

    const result = await runSkillTool(tool, {
      skillId: args.skillInstallId,
      input: { documentId: args.documentId },
      ctx
    })

    if (!result.ok) {
      const cancelled = signal.aborted
      finishRun(db, runId, cancelled ? 'cancelled' : 'failed', now(), null, result.error)
      return { ok: false, runId, cancelled, error: result.error }
    }

    // Persist the schema-validated output atomically — a failed write leaves NO partial rows.
    const invoice = result.output as ExtractInvoiceOutput
    const invoiceId = randomUUID()
    const completedAt = now()
    try {
      db.exec('BEGIN')
      // Re-extraction (F5): replace the document's prior (stale) invoices in the SAME transaction, so a
      // re-extract never accumulates duplicates and the swap is atomic (a failure rolls back to the old).
      if (deps.replaceExisting) deleteInvoicesForDocument(db, args.documentId)
      const h = invoice.header
      const t = invoice.totals
      db.prepare(
        `INSERT INTO invoices
          (id, document_id, run_id, vendor, invoice_number, invoice_date, due_date, currency,
           net_total, tax_total, tax_rate, gross_total, totals_reconciled, extractor_version,
           date_order_inferred, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      ).run(
        invoiceId,
        args.documentId,
        runId,
        h.vendor ?? null,
        h.invoiceNumber ?? null,
        h.invoiceDate ?? null,
        h.dueDate ?? null,
        h.currency ?? null,
        t.netTotal ?? null,
        t.taxTotal ?? null,
        t.taxRatePercent ?? null,
        t.grossTotal ?? null,
        INVOICE_EXTRACTOR_VERSION,
        invoice.dateOrderInferred ?? null,
        completedAt
      )
      const insertLi = db.prepare(
        `INSERT INTO invoice_line_items
          (id, invoice_id, run_id, row_index, description, quantity, unit_price, line_total, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      invoice.lineItems.forEach((li, i) => {
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
      db.prepare(
        `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
      ).run(completedAt, invoiceId, runId)
      db.exec('COMMIT')
    } catch {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* keep the original failure */
      }
      console.error('[skills] invoice extraction failed to persist')
      const msg = 'This invoice could not be saved. Nothing was changed.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'persistFailed', error: msg }
    }

    return { ok: true, runId, invoiceId, lineItemCount: invoice.lineItems.length }
  } catch {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* no active transaction */
    }
    console.error('[skills] invoice extraction failed unexpectedly')
    const msg = 'This invoice could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'persistFailed', error: msg }
  }
}

// ---- The downstream seams (validate / export) ----

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
 * Whether an invoice was produced by an OUTDATED extractor (F5 — mirrors `isBankStatementStale`). True
 * when its `extractor_version` is NULL (extracted before versioning / by an older parser) or LESS than
 * the current `INVOICE_EXTRACTOR_VERSION` — i.e. a since-fixed parser bug may have mis-read a figure in
 * these rows. The reuse path (analysis read-back) re-extracts a stale invoice (with `replaceExisting`)
 * instead of serving its rows. An invoice at the current version is fresh.
 */
export function isInvoiceStale(db: Db, invoiceId: string): boolean {
  const row = db
    .prepare('SELECT extractor_version AS v FROM invoices WHERE id = ?')
    .get(invoiceId) as { v: number | null } | undefined
  if (!row) return false // unknown id — nothing to re-extract (callers handle the missing case)
  return row.v == null || row.v < INVOICE_EXTRACTOR_VERSION
}

/** Reconstruct the structured invoice from its rows (null columns omitted — schema is strict). */
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

interface PreparedInvoiceRun {
  runId: string
  invoiceId: string
  invoice: InvoiceInput
  output: unknown
  completedAt: string
}

/**
 * The shared prefix for every downstream invoice tool: record the run started, locate the latest
 * invoice, load it, run the PURE tool through the gate with the invoice as structured input. Returns
 * the gate output for the caller to persist, or a finished failure result. Guarded like
 * runInvoiceExtraction (B4) so an unexpected throw still drives a terminal status.
 */
async function prepareInvoiceRun(
  db: Db,
  toolName: string,
  args: InvoiceRunArgs,
  deps: InvoiceRunDeps,
  confirmed?: boolean,
  // When the caller has ALREADY reconstructed the invoice (the analysis handler loads it once for the
  // answer), pass it here so this prefix skips its own `loadInvoice` — the single-load that audit P-1
  // collapses. The persist still targets the latest invoice's id (`latestInvoiceId`), unchanged.
  preloadedInvoice?: InvoiceInput
): Promise<{ prepared: PreparedInvoiceRun } | { failed: InvoiceToolResult }> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify(documentIds), now())

  try {
    const tool = getRegisteredTool(toolName)
    if (!tool) {
      const msg = 'This tool is not available.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { failed: { ok: false, runId, errorCode: 'unavailable', error: msg } }
    }

    let invoiceId = latestInvoiceId(db, args.documentId)
    if (!invoiceId) {
      // Honest, friendly: the downstream tools need an extraction first (no figure invented).
      const msg = 'Read the invoice first, then run this tool.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { failed: { ok: false, runId, errorCode: 'needsExtraction', error: msg } }
    }

    // Staleness re-extraction (R3 / audit §5.6 — mirrors the bank `prepareStatementRun`): a run-bar
    // button OR a JSON/CSV/XML export must NEVER serve figures a since-fixed parser mis-read. Mirror the
    // analysis handler (`analysis/invoice.ts`): re-extract in place (`replaceExisting`) before loading.
    // `runInvoiceExtraction` self-locks the same document re-entrantly, so this nests safely. Skip when
    // the caller passed a `preloadedInvoice` — the analysis lane already re-extracted any stale invoice
    // and re-extracting here would delete the very rows it handed us.
    if (preloadedInvoice === undefined && isInvoiceStale(db, invoiceId)) {
      const extraction = await runInvoiceExtraction(db, args, { ...deps, replaceExisting: true })
      if (!extraction.ok || !extraction.invoiceId) {
        // A user CANCEL mid-re-extraction is a calm outcome, not a failure (mirror the bank
        // `prepareStatementRun` + the downstream tool-failure branch below): record 'cancelled', not a
        // 'failed' run with the misleading needsExtraction message.
        if (extraction.cancelled) {
          finishRun(db, runId, 'cancelled', now(), null, null)
          return { failed: { ok: false, runId, cancelled: true, error: extraction.error } }
        }
        const msg = 'Read the invoice first, then run this tool.'
        finishRun(db, runId, 'failed', now(), null, msg)
        return { failed: { ok: false, runId, errorCode: 'needsExtraction', error: msg } }
      }
      invoiceId = extraction.invoiceId
    }

    // Reuse the caller's already-reconstructed invoice when provided (audit P-1); otherwise load it
    // here (the run-bar/IPC path, which has no invoice in hand).
    const invoice = preloadedInvoice ?? loadInvoice(db, invoiceId)
    const signal = deps.signal ?? new AbortController().signal
    const ctx: SkillToolContext = {
      documentIds,
      // Downstream invoice tools take structured rows and never read chunks; the reader is built
      // for ceiling-uniformity only (resolves to the verbatim/legacy reader, frozen to this id).
      readDocumentChunks: await resolveDocumentReader(db, args.documentId, deps),
      signal,
      onProgress: deps.onProgress,
      audit: deps.audit
    }

    const result = await runSkillTool(tool, {
      skillId: args.skillInstallId,
      input: invoice,
      ctx,
      confirmed
    })
    if (!result.ok) {
      const cancelled = signal.aborted
      finishRun(db, runId, cancelled ? 'cancelled' : 'failed', now(), null, result.error)
      return { failed: { ok: false, runId, cancelled, error: result.error } }
    }
    return {
      prepared: { runId, invoiceId, invoice, output: result.output, completedAt: now() }
    }
  } catch {
    console.error('[skills] invoice run failed unexpectedly')
    const msg = 'This could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { failed: { ok: false, runId, errorCode: 'persistFailed', error: msg } }
  }
}

/** Roll back a persist failure and mark the run failed — no partial annotations survive. */
function persistFailure(db: Db, runId: string, now: () => string): InvoiceToolResult {
  try {
    db.exec('ROLLBACK')
  } catch {
    /* keep the original failure */
  }
  console.error('[skills] invoice tool failed to persist')
  const msg = 'This could not be saved. Nothing was changed.'
  finishRun(db, runId, 'failed', now(), null, msg)
  return { ok: false, runId, errorCode: 'persistFailed', error: msg }
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
  // invoice a concurrent re-extract is replacing. Re-entrant when the analysis lane already holds it.
  return withDocumentLock(args.documentId, () =>
    runInvoiceTotalsValidationInner(db, args, deps, preloadedInvoice)
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
  const { runId, invoiceId, output, completedAt } = prep.prepared
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
    return persistFailure(db, runId, now)
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
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareInvoiceRun(db, EXPORT_TOOL_NAME, args, deps, deps.confirmed)
  if ('failed' in prep) return prep.failed
  const { runId, output, completedAt } = prep.prepared
  const { csv, rowCount } = output as { csv: string; rowCount: number }
  // Cancelled after the tool produced the CSV but before the write — don't even open the save dialog,
  // and report it as cancelled (not failed), so nothing is written under a cancel (B2).
  if (deps.signal?.aborted) {
    finishRun(db, runId, 'cancelled', now(), null, null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  let saved: boolean
  try {
    saved = await deps.saveTextFile('invoice-line-items.csv', csv)
  } catch {
    console.error('[skills] invoice CSV export failed to write')
    const msg = 'The file could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'exportWriteFailed', error: msg }
  }
  if (!saved) {
    finishRun(db, runId, 'cancelled', now(), null, null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  // result_ref stays NULL — the export produces no DB artifact, and the path is never recorded.
  finishRun(db, runId, 'done', completedAt, null, null)
  return { ok: true, runId, count: rowCount }
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
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareInvoiceRun(db, opts.toolName, args, deps, deps.confirmed)
  if ('failed' in prep) return prep.failed
  const { runId, output, completedAt } = prep.prepared
  const { content, rowCount } = output as { content: string; rowCount: number }
  // Cancelled after the tool produced the text but before the write — don't open the save dialog (B2).
  if (deps.signal?.aborted) {
    finishRun(db, runId, 'cancelled', now(), null, null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  let saved: boolean
  try {
    saved = await deps.saveTextFile(opts.defaultFileName, content)
  } catch {
    console.error('[skills] invoice file export failed to write')
    const msg = 'The file could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'exportWriteFailed', error: msg }
  }
  if (!saved) {
    finishRun(db, runId, 'cancelled', now(), null, null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  finishRun(db, runId, 'done', completedAt, null, null)
  return { ok: true, runId, count: rowCount }
}
