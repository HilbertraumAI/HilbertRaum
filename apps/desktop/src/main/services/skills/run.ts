import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { DocumentChunkRead, SkillToolAudit, SkillToolContext } from '../../../shared/types'
import { getRegisteredTool, runSkillTool } from './tool-registry'
import {
  BANK_EXTRACTOR_VERSION,
  BUILTIN_CATEGORIES,
  BUILTIN_CATEGORY_RULES,
  type CashflowSummary,
  type CategorizationRow,
  type ExtractTransactionsOutput,
  type ReconcileResult,
  type TransactionInput
} from './tools/bank-statement'
import { CATEGORIZER_CATEGORIES } from './categorizer'
import { withDocumentLock } from './doc-lock'
import type { RedactDocumentOutput } from './tools/redaction'

// The app-orchestrated run seam (architecture.md "Skills — design record" §8, Phase S11a). This is the exact
// function S11b's IPC/UI will call: it is invoked by the APP from a user action (DS4), never by the
// model parsing tool_calls. It builds the NARROW `SkillToolContext` (frozen scope + the only content
// reach, `readDocumentChunks`), runs `extract_transactions` THROUGH the S10 gate (`runSkillTool` —
// validate→run→validate), and on success persists the rows. No IPC/renderer in S11a.
//
// Two sinks, deliberately distinct:
//   - the GATE brackets the TOOL run on the ids/counts-only AUDIT sink (skill_run_started/done/failed);
//   - this SEAM owns the `skill_runs` TABLE row (the run-history lifecycle) + the content-class bank
//     data tables. The table never stores content: document_ids_json is ids, result_ref is the
//     bank_statements id, error is friendly/technical (skills-plan §8.2/§9.5).
// A persist failure ROLLBACKs so NO partial bank rows survive (no-partial-persist, §12.2).

const EXTRACT_TOOL_NAME = 'extract_transactions'

export interface BankExtractionArgs {
  /** The requesting skill's `install_id` ("<source>:<id>") — for the run row + ids/counts audit. */
  skillInstallId: string
  /** The conversation the run belongs to, if any (a doc-action run may not be a chat). */
  conversationId?: string | null
  /** The single selected document to extract from (becomes the frozen one-id scope). */
  documentId: string
}

export interface BankExtractionDeps {
  /** ids/counts-only audit sink (the app's recorder adapter; a capturing fn in tests). */
  audit: SkillToolAudit
  /** Cooperative cancellation (S11b wires the Cancel affordance to this). */
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
  readDocumentSegments?: (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
  /**
   * Request geometry-aware layout reconstruction from the segment reader (PDF geometry-extraction plan
   * §3.1, D58 — bank-statement only). Threaded into `resolveDocumentReader`; the redaction/invoice
   * seams leave it unset and get byte-unchanged reading-order text.
   */
  layout?: boolean
  /**
   * Re-extraction (A9): when set, DELETE every prior `bank_statements` row (and its transactions /
   * corrections) for the document inside the persist transaction BEFORE inserting the fresh one. The
   * reuse paths pass it when the latest statement is STALE (`isBankStatementStale`) so a since-fixed
   * parser bug's rows are replaced — and so re-extraction never accumulates duplicate statements. The
   * persisted categories on the old rows are intentionally NOT carried over (the rows changed precisely
   * because the parser changed them — the honest move is to recompute, which the breakdown's
   * deterministic pass / the next categorize run does). Unset (the default) = the additive behaviour.
   */
  replaceExisting?: boolean
}

export interface BankExtractionResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure, so the lifecycle is recorded). */
  runId: string
  /** The created `bank_statements.id` on success. */
  statementId?: string
  transactionCount?: number
  /**
   * True when the run ended because it was CANCELLED (vs a genuine failure). The seam is the
   * authority on this — the controller must not re-derive it from a late `signal.aborted` (B2).
   */
  cancelled?: boolean
  /** A content-free failure reason CODE the renderer localizes (I1) — e.g. 'unavailable'. */
  errorCode?: string
  /** A friendly, content-free reason on failure. */
  error?: string
}

/**
 * Build the scope-bounded content read for the context (skills-plan §12 / S11a). It is the WHOLE of
 * a tool's content reach: a per-document chunk read confined to the `allowed` id set — an id outside
 * the frozen scope returns `[]`. NOT a general Db/SQL/FS handle (the closure is the only capability).
 */
export function buildReadDocumentChunks(db: Db, allowed: ReadonlySet<string>): SkillToolContext['readDocumentChunks'] {
  const stmt = db.prepare(
    'SELECT text, page_number AS page, chunk_index AS idx FROM chunks WHERE document_id = ? ORDER BY chunk_index'
  )
  return (documentId: string): DocumentChunkRead[] => {
    if (!allowed.has(documentId)) return [] // scope-bounded: an out-of-scope id is refused
    const rows = stmt.all(documentId) as unknown as Array<{ text: string; page: number | null; idx: number }>
    return rows.map((r) => ({ text: r.text, page: r.page ?? null, index: r.idx }))
  }
}

/**
 * Resolve a content-reading tool's `readDocumentChunks`. The CORRECT source is the document's
 * ordered, non-overlapping, newline-preserving parser SEGMENTS (`readDocumentSegments`, injected by
 * the IPC via `extractDocumentPreview`). The stored `chunks` table is the WRONG source for these
 * tools: those are retrieval windows that collapse every newline into a space and overlap by ~80
 * tokens, so the line-oriented bank/invoice extractors see one giant "line" (near-zero rows) and the
 * redaction copy comes out de-formatted with duplicated overlap regions. When no segment reader is
 * injected (legacy/test callers that seed the `chunks` table directly), fall back to the chunk-table
 * reader. Either way the reach stays FROZEN to the single in-scope id (the §14 ceiling is unchanged —
 * the seam, not the tool, holds the FS/cipher capability via the injected closure).
 */
export async function resolveDocumentReader(
  db: Db,
  documentId: string,
  deps: {
    readDocumentSegments?: (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
    layout?: boolean
  }
): Promise<SkillToolContext['readDocumentChunks']> {
  if (!deps.readDocumentSegments) return buildReadDocumentChunks(db, new Set([documentId]))
  let segments: DocumentChunkRead[]
  try {
    // Layout reconstruction is requested only for the bank-statement skill (D58); other callers leave
    // `deps.layout` unset and receive byte-unchanged reading-order segments.
    segments = await deps.readDocumentSegments(documentId, { layout: deps.layout })
  } catch {
    // Re-extraction failed (the stored copy is gone, or encrypted with no cipher). Surface it
    // through the tool's OWN "could not be read" path: a reader that refuses the in-scope id, so
    // the tool returns its friendly content-free error and the seam records a terminal 'failed'.
    return (id: string): DocumentChunkRead[] => {
      if (id === documentId) throw new Error('document re-extraction failed')
      return []
    }
  }
  return (id: string): DocumentChunkRead[] => (id === documentId ? segments : [])
}

export function finishRun(
  db: Db,
  runId: string,
  status: 'done' | 'failed' | 'cancelled',
  completedAt: string,
  resultRef: string | null,
  error: string | null
): void {
  db.prepare(
    'UPDATE skill_runs SET status = ?, completed_at = ?, result_ref = ?, error = ? WHERE id = ?'
  ).run(status, completedAt, resultRef, error, runId)
}

// =====================================================================================
// The generic domain-run ENGINE (A1, audit §6.1 + §6.4 plumbing bullet). `invoice-run.ts` used to be a
// ~500-line layer-for-layer COPY of the bank seam below (the class that caused the "45 vs 22" incident:
// two drifted readers + a missed `replaceExisting`). Both content domains now drive the SAME engine
// through a per-domain `DomainRunConfig` (the plan's config object): `runDomainExtractionInner` (the
// extract→persist lifecycle), `prepareDomainRun` (the downstream-tool prefix incl. R3's ONE staleness
// re-extraction path), `domainPersistFailure`, and `runDomainFileExport` (the confirm-gated export tail).
// The engine is STRICTLY behavior-preserving: every difference the copies had is a config value/function,
// so it can reproduce each domain byte-for-byte. The domain adapters (`runBankExtraction` below,
// `runInvoiceExtraction` in invoice-run.ts) own the per-document lock + reshape the generic result to
// their named id/count fields, so the public surface is unchanged.
// =====================================================================================

/** The frozen one-document scope + audit routing every domain run shares (bank + invoice identical). */
export interface DomainRunArgs {
  /** The requesting skill's `install_id` ("<source>:<id>") — for the run row + ids/counts audit. */
  skillInstallId: string
  /** The conversation the run belongs to, if any (a doc-action run may not be a chat). */
  conversationId?: string | null
  /** The single selected document to extract from (becomes the frozen one-id scope). */
  documentId: string
}

/** The MAIN-side capabilities + knobs every domain run shares (a superset of both domains' deps). */
export interface DomainRunDeps {
  /** ids/counts-only audit sink (the app's recorder adapter; a capturing fn in tests). */
  audit: SkillToolAudit
  /** Cooperative cancellation (S11b wires the Cancel affordance to this). */
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
  readDocumentSegments?: (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
  /**
   * Request geometry-aware layout reconstruction from the segment reader (D58 — bank-statement only).
   * The invoice domain leaves it unset and gets byte-unchanged reading-order text.
   */
  layout?: boolean
  /**
   * Re-extraction (A9/F5): when set, DELETE the document's prior rows (via `config.deleteForDocument`)
   * inside the persist transaction BEFORE inserting the fresh one, so a re-extract never accumulates
   * duplicates and the swap is atomic. Unset (the default) = the additive behaviour.
   */
  replaceExisting?: boolean
}

/** The normalized re-extraction outcome `prepareDomainRun`'s staleness path consumes (a domain adapter
 *  wraps its self-locking `run…Extraction` into this so the id/cancel signals read uniformly). */
export interface DomainReExtractResult {
  ok: boolean
  /** The created parent-row id on success (statement/invoice). */
  resultRef?: string
  /** True when the re-extraction ended because it was CANCELLED (a calm outcome, not a failure). */
  cancelled?: boolean
  error?: string
}

/** The generic extraction result — the domain adapter reshapes `resultRef`/`count` to its named fields. */
export interface DomainExtractionResult {
  ok: boolean
  runId: string
  resultRef?: string
  count?: number
  cancelled?: boolean
  errorCode?: string
  error?: string
}

/** The content-free failure envelope every downstream tool shares (no `resultRef`/`count` on failure). */
export interface DomainRunFailure {
  ok: false
  runId: string
  cancelled?: boolean
  errorCode?: string
  error?: string
}

/** What `prepareDomainRun` hands back on success — the run to finalize + the loaded rows + tool output. */
export interface PreparedDomainRun<TLoaded> {
  runId: string
  /** The parent-row id (statement/invoice) the downstream persist finalizes against. */
  resultRef: string
  /** The rows the caller reuses for its persist (the SAME shape `config.load` returns). */
  loaded: TLoaded
  output: unknown
  completedAt: string
}

/** The content-free domain nouns for the run seam's messages/logs (never cross to renderer/audit). */
export interface DomainRunMessages {
  /** 'This {noun} could not be saved. Nothing was changed.' (the inner + outer persist catch). */
  persistFailed: string
  /** 'Read the {noun} first, then run this tool.' (missing / failed-re-extraction). */
  needsExtraction: string
  /** '[skills] {domain} extraction failed to persist' (local technical log — the inner persist catch). */
  extractPersistLog: string
  /** '[skills] {domain} extraction failed unexpectedly' (local technical log — the outer B4 catch). */
  extractUnexpectedLog: string
  /** '[skills] {domain} run failed unexpectedly' (the downstream-prefix B4 catch). */
  prepareUnexpectedLog: string
}

/**
 * The per-domain values + functions that drive the generic engine (A1). Everything the bank/invoice
 * seams differed by is here: the extract tool name, the latest/stale/delete/load/persist functions, the
 * child-count reader, the tool-input adapter, the downstream ctx-reader builder (PRESERVING the bank
 * lazy-chunk vs invoice eager-segment construction — see `buildDownstreamReader`), and the nouns.
 */
export interface DomainRunConfig<TOutput, TLoaded> {
  /** Registry tool name for the extraction tool ('extract_transactions' / 'extract_invoice'). */
  extractToolName: string
  /** Newest persisted row id for a document, or null (`latestBankStatementId` / `latestInvoiceId`). */
  latestId(db: Db, documentId: string): string | null
  /** Whether the latest persisted row is from an outdated extractor (`isBankStatementStale` / …). */
  isStale(db: Db, id: string): boolean
  /**
   * Self-locking re-extraction (the public `run…Extraction`, normalized) — used ONLY on the staleness
   * path inside `prepareDomainRun`. It MUST be the self-locking adapter (not the raw inner) so a
   * future caller cannot forget the lock; since R9 (SKA-28) EVERY downstream seam holds an outer
   * per-document lock across prepare+load, so this self-lock is a re-entrant no-op in practice — the
   * belt under the outer braces (R3 / audit PC-1).
   */
  reExtract(db: Db, args: DomainRunArgs, deps: DomainRunDeps): Promise<DomainReExtractResult>
  /** Delete the document's prior rows in FK order (inside the caller's transaction; `replaceExisting`). */
  deleteForDocument(db: Db, documentId: string): void
  /**
   * Persist the schema-validated extraction output (parent + child rows) inside the OPEN transaction the
   * engine holds; returns the created parent-row id. The engine owns BEGIN/COMMIT/ROLLBACK + the
   * `skill_runs` 'done' update + the `replaceExisting` delete, so this is JUST the domain INSERTs.
   */
  insertExtraction(db: Db, p: { output: TOutput; documentId: string; runId: string; completedAt: string }): string
  /** The child-row count surfaced as the extraction result count (transactions / line items length). */
  countOf(output: TOutput): number
  /** Load the persisted rows into the pure tool's structured input (`loadTransactions` / `loadInvoice`). */
  load(db: Db, id: string): TLoaded
  /** Adapt the loaded rows into the `runSkillTool` input payload (bank wraps `{transactions}`; invoice
   *  passes the `InvoiceInput` through unchanged). */
  toToolInput(loaded: TLoaded): unknown
  /**
   * Build the DOWNSTREAM-run ctx reader. The downstream tools take structured rows and never read
   * chunks, so this reader is inert. Both domains now bind the SAME lazy `buildReadDocumentChunks`
   * (sync, no I/O). A1 originally preserved an incidental difference here — invoice awaited the
   * segment-preferring `resolveDocumentReader`, doing an eager, discarded decrypt+parse read on the real
   * IPC path — and left unifying it "to a follow-up"; IA-5 (audit P-4) closed that follow-up, because
   * the eager read dominated the deterministic answer path and held the per-document lock across a full
   * re-parse. The EXTRACTION path (`resolveDocumentReader` at :357 / the staleness re-extract) is
   * unchanged: those legitimately read segments.
   */
  buildDownstreamReader(db: Db, documentId: string, deps: DomainRunDeps): Promise<SkillToolContext['readDocumentChunks']>
  messages: DomainRunMessages
}

/** Record the run as started BEFORE the gate (committed; survives a later ROLLBACK of the domain rows). */
function insertStartedRun(db: Db, runId: string, args: DomainRunArgs, now: () => string): void {
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify([args.documentId]), now())
}

/**
 * Run the extraction tool on one selected document through the gate and persist the result atomically —
 * the SINGLE copy of the extract→persist lifecycle (was `runBankExtractionInner` + its invoice twin).
 * Returns the GENERIC result; the domain adapter owns the per-document lock and reshapes it. A persist
 * failure ROLLBACKs so NO partial rows survive; the 'started' row always reaches a terminal status (B4).
 */
export async function runDomainExtractionInner<TOutput, TLoaded>(
  db: Db,
  args: DomainRunArgs,
  deps: DomainRunDeps,
  config: DomainRunConfig<TOutput, TLoaded>
): Promise<DomainExtractionResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]
  insertStartedRun(db, runId, args, now)

  // Everything after the 'started' insert is guarded (B4): any UNEXPECTED throw must still drive a
  // terminal status — never leave the run stranded at 'started'.
  try {
    const tool = getRegisteredTool(config.extractToolName)
    if (!tool) {
      // No run happened ⇒ no audit event (matches the gate's "pre-run refusals are not audited").
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
    const output = result.output as TOutput
    const completedAt = now()
    let resultRef: string
    try {
      db.exec('BEGIN')
      // Re-extraction (A9/F5): replace the document's prior (stale) rows in the SAME transaction, so a
      // re-extract never accumulates duplicates and the swap is atomic (a failure rolls back to the old).
      if (deps.replaceExisting) config.deleteForDocument(db, args.documentId)
      resultRef = config.insertExtraction(db, { output, documentId: args.documentId, runId, completedAt })
      db.prepare(
        `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
      ).run(completedAt, resultRef, runId)
      db.exec('COMMIT')
    } catch {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* keep the original failure */
      }
      // Technical reason to the local log only — never the renderer/audit (§22-M1).
      console.error(config.messages.extractPersistLog)
      const msg = config.messages.persistFailed
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'persistFailed', error: msg }
    }

    return { ok: true, runId, resultRef, count: config.countOf(output) }
  } catch {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* no active transaction */
    }
    console.error(config.messages.extractUnexpectedLog)
    const msg = config.messages.persistFailed
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'persistFailed', error: msg }
  }
}

/**
 * The shared prefix for every DOWNSTREAM tool (was `prepareStatementRun` + `prepareInvoiceRun`): record
 * the run started, locate the latest row, RE-EXTRACT it in place when stale (R3 / audit §5.6), load it,
 * and run the PURE tool through the gate with the rows as structured input. Returns the gate output for
 * the caller to persist, or a finished failure. The run row is left `started` on success — the caller
 * finalizes it inside its own persist transaction. Guarded (B4) so an unexpected throw still terminates.
 */
export async function prepareDomainRun<TOutput, TLoaded>(
  db: Db,
  toolName: string,
  args: DomainRunArgs,
  deps: DomainRunDeps,
  config: DomainRunConfig<TOutput, TLoaded>,
  confirmed?: boolean,
  // When the caller has ALREADY loaded the rows (the analysis handler loads them once for the answer),
  // pass them here so this prefix skips its own `config.load` — the single-load audit P-1 collapses — AND
  // skips the staleness re-extraction (the analysis lane already re-extracted, and re-extracting here
  // would DELETE the very rows it handed us). Same shape `config.load` returns.
  preloaded?: TLoaded
): Promise<{ prepared: PreparedDomainRun<TLoaded> } | { failed: DomainRunFailure }> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]
  insertStartedRun(db, runId, args, now)

  // Guarded like the extraction (B4): an unexpected throw between the 'started' insert and a terminal
  // result (e.g. a DB error in latestId/load) must not strand the run at 'started'.
  try {
    const tool = getRegisteredTool(toolName)
    if (!tool) {
      const msg = 'This tool is not available.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { failed: { ok: false, runId, errorCode: 'unavailable', error: msg } }
    }

    let resultRef = config.latestId(db, args.documentId)
    if (!resultRef) {
      // Honest, friendly: the downstream tools need an extraction first (no figure invented).
      const msg = config.messages.needsExtraction
      finishRun(db, runId, 'failed', now(), null, msg)
      return { failed: { ok: false, runId, errorCode: 'needsExtraction', error: msg } }
    }

    // Staleness re-extraction (R3 / audit §5.6): a run-bar button OR an export must NEVER serve rows a
    // since-fixed parser produced. Re-extract in place (`replaceExisting`) before loading. The domain's
    // self-locking `reExtract` re-enters the same document lock, so this nests safely under a downstream
    // seam that already holds it. Skip when the caller supplied `preloaded` — the analysis lane already
    // re-extracted any stale row and re-extracting here would DELETE the very rows it handed us.
    if (preloaded === undefined && config.isStale(db, resultRef)) {
      const extraction = await config.reExtract(db, args, { ...deps, replaceExisting: true })
      if (!extraction.ok || !extraction.resultRef) {
        // A user CANCEL mid-re-extraction is a calm outcome, not a failure — record 'cancelled', not a
        // 'failed' run with the misleading needsExtraction message. The seam is the authority on cancel (B2).
        if (extraction.cancelled) {
          finishRun(db, runId, 'cancelled', now(), null, null)
          return { failed: { ok: false, runId, cancelled: true, error: extraction.error } }
        }
        // Re-extraction genuinely failed (source gone / unreadable): fail with the SAME code the missing-
        // extraction branch uses, so the renderer tells the user to read again (never a bad figure).
        const msg = config.messages.needsExtraction
        finishRun(db, runId, 'failed', now(), null, msg)
        return { failed: { ok: false, runId, errorCode: 'needsExtraction', error: msg } }
      }
      resultRef = extraction.resultRef
    }

    // Reuse the caller's already-loaded rows when provided (audit P-1); otherwise load them here (the
    // run-bar/IPC path). Branch on `undefined` explicitly so a genuinely empty load is honoured.
    const loaded = preloaded !== undefined ? preloaded : config.load(db, resultRef)
    const signal = deps.signal ?? new AbortController().signal
    const ctx: SkillToolContext = {
      documentIds,
      readDocumentChunks: await config.buildDownstreamReader(db, args.documentId, deps),
      signal,
      onProgress: deps.onProgress,
      audit: deps.audit
    }

    const result = await runSkillTool(tool, {
      skillId: args.skillInstallId,
      input: config.toToolInput(loaded),
      ctx,
      confirmed
    })
    if (!result.ok) {
      const cancelled = signal.aborted
      finishRun(db, runId, cancelled ? 'cancelled' : 'failed', now(), null, result.error)
      return { failed: { ok: false, runId, cancelled, error: result.error } }
    }
    return {
      prepared: { runId, resultRef, loaded, output: result.output, completedAt: now() }
    }
  } catch {
    console.error(config.messages.prepareUnexpectedLog)
    const msg = 'This could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { failed: { ok: false, runId, errorCode: 'persistFailed', error: msg } }
  }
}

/** Roll back a downstream persist failure and mark the run failed — no partial annotations survive.
 *  Shared by both domains (was a private `persistFailure` copy in each); only the local log text differs. */
export function domainPersistFailure(db: Db, runId: string, now: () => string, log: string): DomainRunFailure {
  try {
    db.exec('ROLLBACK')
  } catch {
    /* keep the original failure */
  }
  console.error(log)
  const msg = 'This could not be saved. Nothing was changed.'
  finishRun(db, runId, 'failed', now(), null, msg)
  return { ok: false, runId, errorCode: 'persistFailed', error: msg }
}

/**
 * The confirm-gated file-export TAIL (was `runCsvExport` + `runInvoiceCsvExport` + `runInvoiceFileExport`).
 * Produce the serialized text via the pure tool (through `prepareDomainRun`) and write it MAIN-side to a
 * user-chosen path. A cancel writes nothing and reports it calmly (B2). The content + the chosen path
 * never touch any log/audit; only "saved N rows" (a count) is surfaced. `readOutput` pulls the serialized
 * text out of the tool output (CSV tools expose `csv`; the JSON/XML tools expose `content`).
 *
 * Lock scope (SKA-28): prepare + load + serialization run under ONE per-document hold — this seam held
 * no outer lock, so a competing `replaceExisting` extract could interleave between the R3 staleness
 * re-extraction (self-locked, released) and the row load, and the export wrote an EMPTY file reported
 * "saved 0 rows". The hold is RELEASED before the save dialog: the serialized text is already
 * materialized, so a later re-extract cannot corrupt it — while holding a per-document lock across a
 * minutes-open user dialog would block the categorize doctask and chat analysis on that document for
 * the whole duration. Abort-aware while parked (SKA-24) — an export queued behind a long categorize is
 * cancellable.
 *
 * Terminal tail (SKA-27, the B4 pattern the sibling seams already hold): every `finishRun` after the
 * prepare is guarded — the dialog can sit open for minutes and the workspace can lock underneath it, and
 * an unguarded terminal write both stranded the `skill_runs` row at 'started' forever AND told the user
 * "failed. Nothing was changed." after the file WAS written. The returned outcome is decided by what
 * happened to the FILE, never by bookkeeping; 'done' is stamped at the actual write time, not the
 * pre-dialog prepare time.
 */
export async function runDomainFileExport<TOutput, TLoaded>(
  db: Db,
  args: DomainRunArgs,
  deps: DomainRunDeps & {
    saveTextFile: (defaultFileName: string, content: string) => Promise<boolean>
    confirmed?: boolean
  },
  config: DomainRunConfig<TOutput, TLoaded>,
  opts: {
    toolName: string
    defaultFileName: string
    readOutput: (output: unknown) => { text: string; rowCount: number }
    writeFailLog: string
  }
): Promise<{ ok: boolean; runId: string; count?: number; cancelled?: boolean; errorCode?: string; error?: string }> {
  const now = deps.now ?? (() => new Date().toISOString())
  // SKA-28: one hold across prepare (incl. the R3 staleness re-extract, re-entrant) + load + serialize.
  const prep = await withDocumentLock(
    args.documentId,
    async () => {
      const p = await prepareDomainRun(db, opts.toolName, args, deps, config, deps.confirmed)
      if ('failed' in p) return p
      // Serialize INSIDE the hold — after release only this materialized text is used, never the rows.
      return { serialized: { runId: p.prepared.runId, ...opts.readOutput(p.prepared.output) } }
    },
    deps.signal
  )
  if ('failed' in prep) return prep.failed
  const { runId, text, rowCount } = prep.serialized

  // SKA-27 (B4): a guarded terminal write for everything past the prepare. A transiently-failing
  // UPDATE (the workspace-locked-mid-dialog class) gets ONE retry so the row doesn't strand at
  // 'started'; a still-failing write is logged (content-free) and the outcome stands — the caller's
  // result reports what happened to the file, which no bookkeeping failure can change.
  const finishTail = (status: 'done' | 'failed' | 'cancelled', error: string | null): void => {
    try {
      finishRun(db, runId, status, now(), null, error)
    } catch {
      console.error('[skills] export run bookkeeping failed')
      try {
        finishRun(db, runId, status, now(), null, error)
      } catch {
        /* the DB is genuinely unwritable — the file outcome stands (SKA-27) */
      }
    }
  }

  // Cancelled after the tool produced the text but before the write — don't even open the save dialog,
  // and report it as cancelled (not failed), so nothing is written under a cancel (B2).
  if (deps.signal?.aborted) {
    finishTail('cancelled', null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  let saved: boolean
  try {
    saved = await deps.saveTextFile(opts.defaultFileName, text)
  } catch {
    console.error(opts.writeFailLog)
    const msg = 'The file could not be saved. Nothing was changed.'
    finishTail('failed', msg)
    return { ok: false, runId, errorCode: 'exportWriteFailed', error: msg }
  }
  if (!saved) {
    // The user cancelled the save dialog — a calm, non-error outcome (history records it cancelled).
    finishTail('cancelled', null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  // result_ref stays NULL — the export produces no DB artifact, and the path is never recorded.
  // 'done' is stamped NOW (the write just happened), not at the pre-dialog prepare (SKA-27) — run
  // history no longer timestamps the export minutes early.
  finishTail('done', null)
  return { ok: true, runId, count: rowCount }
}

/**
 * Run `extract_transactions` on one selected document through the gate and persist the result.
 * Returns ids/counts only — never the extracted content (which lives only in the bank data tables).
 *
 * Serialized per document (audit PC-1): the whole run — including the `replaceExisting` DELETE+INSERT —
 * holds the per-document lock so a concurrent run/categorize on the SAME statement (any lane) cannot
 * race the delete (re-entrant when a lane already holds it; unrelated documents stay concurrent).
 * Abort-aware while parked (SKA-24): a cancel rejects the queued run instead of a dead spinner.
 */
export async function runBankExtraction(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps
): Promise<BankExtractionResult> {
  return withDocumentLock(args.documentId, async () => {
    const r = await runDomainExtractionInner(db, args, deps, BANK_RUN_CONFIG)
    // The generic failure object already carries the exact original key set (no resultRef/count on
    // failure), so return it verbatim; only success is reshaped to the bank-named id/count fields.
    if (!r.ok) return r
    return { ok: true, runId: r.runId, statementId: r.resultRef, transactionCount: r.count }
  }, deps.signal)
}

/**
 * Persist a schema-validated `extract_transactions` output — the statement row + its transactions —
 * inside the engine's OPEN transaction; returns the new `bank_statements.id`. The engine owns
 * BEGIN/COMMIT/ROLLBACK + the `replaceExisting` delete + the `skill_runs` 'done' update, so this is JUST
 * the domain INSERTs (the bank half of the config's `insertExtraction`).
 */
function insertBankExtraction(
  db: Db,
  { output, documentId, runId, completedAt }: {
    output: ExtractTransactionsOutput
    documentId: string
    runId: string
    completedAt: string
  }
): string {
  const statementId = randomUUID()
  db.prepare(
    `INSERT INTO bank_statements
       (id, document_id, run_id, period_start, period_end, currency, opening_balance, closing_balance,
        extractor_version, date_order_inferred, dropped_row_count, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    statementId,
    documentId,
    runId,
    output.currency ?? null,
    output.openingBalance ?? null,
    output.closingBalance ?? null,
    BANK_EXTRACTOR_VERSION,
    output.dateOrderInferred ?? null,
    output.droppedRowCount ?? null,
    completedAt
  )
  const insertTx = db.prepare(
    `INSERT INTO bank_transactions
      (id, statement_id, run_id, row_index, date, value_date, description, amount, currency, balance_after, source_page, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  output.transactions.forEach((t, i) => {
    insertTx.run(
      randomUUID(),
      statementId,
      runId,
      i,
      t.date,
      t.valueDate ?? null,
      t.description,
      t.amount,
      t.currency,
      t.balanceAfter ?? null,
      t.sourcePage ?? null,
      completedAt
    )
  })
  return statementId
}

/**
 * The bank domain's engine config (A1) — the values/functions that specialize the generic run seam for
 * the bank-statement content class. Everything `invoice-run.ts`'s copy differed by lives here.
 */
const BANK_RUN_CONFIG: DomainRunConfig<ExtractTransactionsOutput, LoadedTransaction[]> = {
  extractToolName: EXTRACT_TOOL_NAME,
  latestId: latestBankStatementId,
  isStale: isBankStatementStale,
  // Self-locking re-extraction (re-entrant under a downstream seam's own hold), normalized for the
  // staleness path. Reuses the public `runBankExtraction` so the lock + reshape stay in one place.
  reExtract: async (db, args, deps) => {
    const r = await runBankExtraction(db, args, deps)
    return { ok: r.ok, resultRef: r.statementId, cancelled: r.cancelled, error: r.error }
  },
  deleteForDocument: deleteBankStatementsForDocument,
  insertExtraction: insertBankExtraction,
  countOf: (output) => output.transactions.length,
  load: loadTransactions,
  toToolInput,
  // Bank downstream prefix binds the SYNC chunk-table reader (lazy, no I/O — inert for structured-input
  // tools). PRESERVED as-is by A1 (differs from invoice's eager segment read; see the config field doc).
  buildDownstreamReader: async (db, documentId) => buildReadDocumentChunks(db, new Set([documentId])),
  messages: {
    persistFailed: 'This statement could not be saved. Nothing was changed.',
    needsExtraction: 'Read the statement first, then run this tool.',
    extractPersistLog: '[skills] bank extraction failed to persist',
    extractUnexpectedLog: '[skills] bank extraction failed unexpectedly',
    prepareUnexpectedLog: '[skills] statement run failed unexpectedly'
  }
}

// =====================================================================================
// S11c — the downstream run seams (validate / categorize / summarize / export).
//
// These tools operate on the ALREADY-EXTRACTED rows, not document chunks. The seam loads the
// LATEST statement for the in-scope document (deterministic target — architecture.md "Skills — design record" §8
// S11c) and passes the rows to the PURE tool as STRUCTURED INPUT (no new SkillToolContext accessor;
// the §14 ceiling is unchanged). Persistence (reconciled flags / category assignments) stays here,
// atomically (no-partial-persist). `summarize_cashflow` is read-only (no persist). The CSV export
// is the first FS-write from a skill tool: the tool only *produces* the CSV; the seam writes it via
// a MAIN-side, user-chosen save — the path + content are NEVER logged/audited (ids/counts only).
// =====================================================================================

const VALIDATE_TOOL_NAME = 'validate_statement_balances'
const CATEGORIZE_TOOL_NAME = 'categorize_transactions'
const SUMMARIZE_TOOL_NAME = 'summarize_cashflow'
const EXPORT_TOOL_NAME = 'export_transactions_csv'

/**
 * A transaction loaded from the DB — the tool input fields plus the ids the seam persists against.
 * Exported so the analysis handler can load the rows ONCE (with ids) and hand them to the downstream
 * seams as `preloaded` (audit P-1), instead of each seam re-querying `bank_transactions`.
 */
export interface LoadedTransaction extends TransactionInput {
  id: string
  rowIndex: number
}

export interface StatementToolResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure). */
  runId: string
  /** A content-free count the renderer surfaces (rows touched / not reconciling / saved). */
  count?: number
  /** A content-free outcome discriminator (validate: 'reconciled'|'unreconciled'|'unchecked'). */
  resultKind?: string
  /**
   * The already-validated structured tool output (`summarize_cashflow` → `CashflowSummary`,
   * `validate_statement_balances` → `ReconcileResult`) for IN-PROCESS reuse by the analysis handler
   * (audit P-1: it reuses this instead of recomputing the same pure function over a re-queried row
   * set). These are FIGURES (content): the handler keeps them in-process and they must NEVER cross
   * into `ToolRunOutcome`/IPC — the run-bar dispatch (`tool-runs.ts`) maps only counts, never `output`.
   */
  output?: CashflowSummary | ReconcileResult
  /**
   * True when the run ended because it was CANCELLED (vs a genuine failure) — e.g. the user
   * dismissed the CSV save dialog, or Cancel landed before the work persisted (B1/B2). The
   * controller surfaces this directly instead of re-deriving it from `signal.aborted`.
   */
  cancelled?: boolean
  /** A content-free failure reason CODE the renderer localizes (I1) — e.g. 'needsExtraction'. */
  errorCode?: string
  /** A friendly, content-free reason on failure. */
  error?: string
}

/**
 * The newest statement id for a document, or null if none has been extracted. The single source of
 * truth for "the latest statement" across the three call sites — the run seam (here), the `categorize`
 * doctask (`doctasks/manager.ts`) and the analysis read-back (`analysis/bank-statement.ts`). The
 * `created_at DESC, id DESC` tie-break is LOAD-BEARING: it decides which statement gets categorized vs.
 * read back, so all three MUST resolve the SAME row — hence one shared helper, not three copies.
 */
export function latestBankStatementId(db: Db, documentId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(documentId) as { id: string } | undefined
  return row?.id ?? null
}

/**
 * Whether a statement was produced by a DIFFERENT extractor than the one running (A9). True when its
 * `extractor_version` is NULL (extracted before versioning) or NOT EQUAL to the current
 * `BANK_EXTRACTOR_VERSION` — older rows may carry a since-fixed parser bug (a mis-signed amount, a
 * lost payee), and NEWER rows (SKA-26, skills-audit-2026-07-03 §3.3) are the downgrade case: the app
 * runs from the portable drive so it normally roams WITH the workspace, and a version mismatch in
 * either direction means a deliberate rollback (where the newer extractor IS the suspected bug — the
 * one moment serving its rows as fresh would be worst) or a second install against the same workspace.
 * Deterministic extractors make `!==` safe: same version ⇒ same rows, so re-extraction never loops.
 * The accepted cost (BUILD_STATE R9): a workspace alternating between two app versions re-extracts on
 * every switch, and each `replaceExisting` re-extract drops the persisted per-row categories — but the
 * rows changed with the parser, so recomputing them is the honest move (the `replaceExisting` doctrine).
 * The reuse paths (analysis read-back + categorize doctask) re-extract a stale statement
 * (with `replaceExisting`) instead of serving its rows. A statement at the current version is fresh.
 */
export function isBankStatementStale(db: Db, statementId: string): boolean {
  const row = db
    .prepare('SELECT extractor_version AS v FROM bank_statements WHERE id = ?')
    .get(statementId) as { v: number | null } | undefined
  if (!row) return false // unknown id — nothing to re-extract (callers handle the missing case)
  return row.v == null || row.v !== BANK_EXTRACTOR_VERSION
}

/**
 * Delete every `bank_statements` row for a document plus its dependent rows (transactions, and any
 * corrections on them) in FK order — the "replace" half of a re-extraction (A9). Runs inside the
 * caller's transaction. `bank_corrections` carries no writes yet (schema-only), but is cleared
 * defensively so a future correction can never be orphaned onto a deleted transaction.
 */
function deleteBankStatementsForDocument(db: Db, documentId: string): void {
  db.prepare(
    `DELETE FROM bank_corrections WHERE transaction_id IN (
       SELECT t.id FROM bank_transactions t
       JOIN bank_statements s ON s.id = t.statement_id
       WHERE s.document_id = ?)`
  ).run(documentId)
  db.prepare(
    `DELETE FROM bank_transactions WHERE statement_id IN (
       SELECT id FROM bank_statements WHERE document_id = ?)`
  ).run(documentId)
  db.prepare('DELETE FROM bank_statements WHERE document_id = ?').run(documentId)
}

/**
 * Delete every `invoices` row for a document plus its line items in FK order. Mirrors
 * `deleteBankStatementsForDocument` for the second Tier-2 content domain. Used by document teardown
 * (`purgeSkillDataForDocument`) AND by the invoice re-extraction "replace" half (F5 — `invoice-run.ts`
 * `runInvoiceExtraction` with `replaceExisting`, the parity with the bank path). Exported so the single
 * authoritative ordered delete is shared by both call sites — never copied. Runs inside the caller's
 * transaction.
 */
export function deleteInvoicesForDocument(db: Db, documentId: string): void {
  db.prepare(
    `DELETE FROM invoice_line_items WHERE invoice_id IN (
       SELECT id FROM invoices WHERE document_id = ?)`
  ).run(documentId)
  db.prepare('DELETE FROM invoices WHERE document_id = ?').run(documentId)
}

/**
 * Delete ALL Tier-2 skill extraction rows (bank statements + invoices and their dependent
 * transactions / corrections / line items) for a document, in FK order. The single authoritative
 * list of skill-domain rows that hang off a document, so document teardown
 * (`ingestion/index.ts` `purgeDocumentDerivatives`) can't orphan them or hit an FK violation on the
 * final `DELETE FROM documents` (audit DATA-1 / MAINT-1). The bank/invoice→documents FKs carry NO
 * `ON DELETE CASCADE` on drives created before that fix, so this explicit ordered delete — not a
 * cascade — is what keeps deletion safe there. Runs inside the caller's transaction; touches
 * ids/figures only (the CONTENT-CLASS rows are never logged/audited).
 */
export function purgeSkillDataForDocument(db: Db, documentId: string): void {
  deleteBankStatementsForDocument(db, documentId)
  deleteInvoicesForDocument(db, documentId)
}

/** Load a statement's transactions in stable row order (null columns omitted, not passed as null).
 *  Carries each row's PERSISTED category name when a categorize run assigned one (result-tables plan
 *  §3, D61) — the confirm-gated CSV export serializes whatever the rows carry, so a categorized
 *  statement exports its category column and a never-categorized one keeps the prior 7-column shape
 *  (presence gate, D62). The downstream tools that don't read `category` are unaffected. */
function loadTransactions(db: Db, statementId: string): LoadedTransaction[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.row_index AS rowIndex, t.date, t.value_date AS valueDate, t.description,
              t.amount, t.currency, t.balance_after AS balanceAfter, t.source_page AS sourcePage,
              c.name AS category
       FROM bank_transactions t
       LEFT JOIN bank_categories c ON c.id = t.category_id
       WHERE t.statement_id = ? ORDER BY t.row_index`
    )
    .all(statementId) as Array<{
    id: string
    rowIndex: number
    date: string
    valueDate: string | null
    description: string
    amount: number
    currency: string
    balanceAfter: number | null
    sourcePage: number | null
    category: string | null
  }>
  return rows.map((r) => {
    const t: LoadedTransaction = {
      id: r.id,
      rowIndex: r.rowIndex,
      date: r.date,
      description: r.description,
      amount: r.amount,
      currency: r.currency
    }
    if (r.valueDate != null) t.valueDate = r.valueDate
    if (r.balanceAfter != null) t.balanceAfter = r.balanceAfter
    if (r.sourcePage != null) t.sourcePage = r.sourcePage
    if (r.category != null) t.category = r.category
    return t
  })
}

/** Strip the persistence-only ids before handing the rows to the pure tool (schema is strict). */
function toToolInput(txs: LoadedTransaction[]): { transactions: TransactionInput[] } {
  return {
    transactions: txs.map(({ id: _id, rowIndex: _rowIndex, ...rest }) => rest)
  }
}

// The bank domain's downstream prefix + persist-failure are the shared engine helpers `prepareDomainRun`
// / `domainPersistFailure` driven by `BANK_RUN_CONFIG` (A1) — the per-tool seams below call them, then do
// their own domain-specific persist (`reconciled` flags / `category_id`). The single staleness
// re-extraction path (R3 / audit §5.6) now lives in `prepareDomainRun`, not a bank-only copy.

/** `prepareDomainRun` specialized to the bank config (the downstream seams' single prefix). */
function prepareStatementRun(
  db: Db,
  toolName: string,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  confirmed?: boolean,
  preloaded?: LoadedTransaction[]
): Promise<{ prepared: PreparedDomainRun<LoadedTransaction[]> } | { failed: DomainRunFailure }> {
  return prepareDomainRun(db, toolName, args, deps, BANK_RUN_CONFIG, confirmed, preloaded)
}

/**
 * `validate_statement_balances` — reconcile printed vs computed running balances and persist the
 * per-row `reconciled` flag (1 ok / 0 mismatch / NULL unchecked). The `count` is the number of rows
 * that DON'T reconcile; `resultKind` distinguishes a clean pass from "nothing could be checked".
 */
export async function runBalanceValidation(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  preloaded?: LoadedTransaction[]
): Promise<StatementToolResult> {
  // Serialized per document (audit PC-1): the `reconciled` persist must not run against a statement a
  // concurrent re-extract is deleting. Re-entrant when the analysis lane already holds the doc lock;
  // abort-aware while parked behind another lane (SKA-24).
  return withDocumentLock(args.documentId, () => runBalanceValidationInner(db, args, deps, preloaded), deps.signal)
}

async function runBalanceValidationInner(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  preloaded?: LoadedTransaction[]
): Promise<StatementToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareStatementRun(db, VALIDATE_TOOL_NAME, args, deps, undefined, preloaded)
  if ('failed' in prep) return prep.failed
  const { runId, resultRef: statementId, loaded: transactions, output, completedAt } = prep.prepared
  const reconcile = output as ReconcileResult
  const mismatchCount = reconcile.rows.filter((r) => r.status === 'mismatch').length
  const checkedAny = reconcile.rows.some((r) => r.status !== 'unknown')
  const resultKind = reconcile.reconciled ? 'reconciled' : checkedAny ? 'unreconciled' : 'unchecked'
  try {
    db.exec('BEGIN')
    const upd = db.prepare('UPDATE bank_transactions SET reconciled = ? WHERE id = ?')
    for (const row of reconcile.rows) {
      const tx = transactions[row.index]
      if (!tx) continue
      const flag = row.status === 'ok' ? 1 : row.status === 'mismatch' ? 0 : null
      upd.run(flag, tx.id)
    }
    db.prepare(
      `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
    ).run(completedAt, statementId, runId)
    db.exec('COMMIT')
  } catch {
    return domainPersistFailure(db, runId, now, '[skills] statement tool failed to persist')
  }
  // Surface the validated `ReconcileResult` for in-process reuse (audit P-1) — the analysis handler
  // reuses it instead of recomputing `reconcileBalances` over a re-queried row set. Content (figures):
  // in-process only, never mapped into `ToolRunOutcome`/IPC.
  return { ok: true, runId, count: mismatchCount, resultKind, output: reconcile }
}

/**
 * Get (seeding once) the built-in `bank_categories` ids by name, plus seed the rules they use.
 * The seeded NAMES are the union of the deterministic-rule categories (`BUILTIN_CATEGORIES`) and the
 * richer LLM-categorizer taxonomy (`CATEGORIZER_CATEGORIES`, Phase 33), so a model-assigned category
 * (e.g. "Groceries") always maps to a seeded row. Only the deterministic categories carry RULES.
 * Exported so the `'categorize'` doctask (the LLM categorizer's lane) reuses the exact same seed.
 */
export function ensureBuiltinCategories(db: Db, now: string): Map<string, string> {
  const existing = db.prepare('SELECT id, name FROM bank_categories WHERE builtin = 1').all() as Array<{
    id: string
    name: string
  }>
  const byName = new Map(existing.map((c) => [c.name, c.id]))
  const insertCat = db.prepare(
    'INSERT INTO bank_categories (id, name, builtin, created_at) VALUES (?, ?, 1, ?)'
  )
  for (const name of [...new Set([...BUILTIN_CATEGORIES, ...CATEGORIZER_CATEGORIES])]) {
    if (!byName.has(name)) {
      const id = randomUUID()
      insertCat.run(id, name, now)
      byName.set(name, id)
    }
  }
  // Seed the deterministic rules once (transparency: the rules the tool applied are stored too).
  const ruleCount = (db.prepare('SELECT COUNT(*) AS n FROM bank_category_rules').get() as { n: number }).n
  if (ruleCount === 0) {
    const insertRule = db.prepare(
      'INSERT INTO bank_category_rules (id, category_id, match_kind, pattern, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const rule of BUILTIN_CATEGORY_RULES) {
      const catId = byName.get(rule.category)
      if (catId) insertRule.run(randomUUID(), catId, rule.matchKind, rule.pattern, now)
    }
  }
  return byName
}

/**
 * `categorize_transactions` — assign each row a built-in category (deterministic rules) and persist
 * `bank_transactions.category_id`, seeding the built-in categories/rules on first use. The `count`
 * is the number of rows categorized.
 */
export async function runCategorization(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  preloaded?: LoadedTransaction[]
): Promise<StatementToolResult> {
  // Serialized per document (audit PC-1): the `category_id` persist must not run against a statement a
  // concurrent re-extract is deleting. Re-entrant when the analysis lane already holds the doc lock;
  // abort-aware while parked behind another lane (SKA-24).
  return withDocumentLock(args.documentId, () => runCategorizationInner(db, args, deps, preloaded), deps.signal)
}

async function runCategorizationInner(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  preloaded?: LoadedTransaction[]
): Promise<StatementToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareStatementRun(db, CATEGORIZE_TOOL_NAME, args, deps, undefined, preloaded)
  if ('failed' in prep) return prep.failed
  const { runId, resultRef: statementId, loaded: transactions, output, completedAt } = prep.prepared
  const { categories } = output as { categories: CategorizationRow[] }
  try {
    db.exec('BEGIN')
    const byName = ensureBuiltinCategories(db, completedAt)
    const upd = db.prepare('UPDATE bank_transactions SET category_id = ? WHERE id = ?')
    for (const assignment of categories) {
      const tx = transactions[assignment.index]
      const catId = byName.get(assignment.category)
      if (tx && catId) upd.run(catId, tx.id)
    }
    db.prepare(
      `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
    ).run(completedAt, statementId, runId)
    db.exec('COMMIT')
  } catch {
    return domainPersistFailure(db, runId, now, '[skills] statement tool failed to persist')
  }
  return { ok: true, runId, count: categories.length }
}

/**
 * Persist a categorizer result (assignments + the authoritative `categorized_by_model` flag)
 * atomically — the chat-lane twin of the categorize doctask's persist step (result-tables plan,
 * Phase 1.5: a prompt-supplied CUSTOM category set runs inline in the chat slot). Labels outside the
 * seeded taxonomy (the user's own categories) are inserted as NON-builtin `bank_categories` rows on
 * first use, looked up across ALL existing rows (names carry no UNIQUE constraint — a prior custom
 * run's row is reused, never duplicated). Rolls back on failure so no partial annotation survives.
 * Content posture: category NAMES are content-class (they live only in the data tables, never in a
 * log/audit — same as every other bank row).
 */
export function persistCategorization(
  db: Db,
  statementId: string,
  loaded: readonly LoadedTransaction[],
  assignments: readonly CategorizationRow[],
  modelAssisted: boolean,
  now?: () => string
): void {
  const at = (now ?? (() => new Date().toISOString()))()
  db.exec('BEGIN')
  try {
    const byName = ensureBuiltinCategories(db, at)
    const all = db.prepare('SELECT id, name FROM bank_categories').all() as Array<{ id: string; name: string }>
    for (const c of all) if (!byName.has(c.name)) byName.set(c.name, c.id)
    const insert = db.prepare('INSERT INTO bank_categories (id, name, builtin, created_at) VALUES (?, ?, 0, ?)')
    const upd = db.prepare('UPDATE bank_transactions SET category_id = ? WHERE id = ?')
    for (const a of assignments) {
      let catId = byName.get(a.category)
      if (!catId) {
        catId = randomUUID()
        insert.run(catId, a.category, at)
        byName.set(a.category, catId)
      }
      const tx = loaded[a.index]
      if (tx) upd.run(catId, tx.id)
    }
    db.prepare('UPDATE bank_statements SET categorized_by_model = ? WHERE id = ?').run(
      modelAssisted ? 1 : 0,
      statementId
    )
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* keep the original failure */
    }
    throw err
  }
}

/**
 * `summarize_cashflow` — compute inflow/outflow/net totals (read-only; nothing persists). The
 * figures are content and are NOT surfaced in v1 (the busy row stays ids/counts only — a dedicated
 * view / the model-explains step is a later wave); the run proves the pipeline + reports the count.
 */
export async function runCashflowSummary(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  preloaded?: LoadedTransaction[]
): Promise<StatementToolResult> {
  // Serialized per document (audit PC-1 / SKA-28): this seam held NO outer lock, so the R3 staleness
  // re-extraction inside `prepareStatementRun` (self-locked) RELEASED before the subsequent row load —
  // a competing `replaceExisting` extract could interleave in that gap and the summary would read the
  // rows of a just-deleted statement (0 rows). One re-entrant hold across prepare+load closes it and
  // makes the design comment above `prepareStatementRun` true by construction. Abort-aware while
  // parked behind another lane (SKA-24). Cheap: no dialog/model call anywhere under this hold.
  return withDocumentLock(
    args.documentId,
    () => runCashflowSummaryInner(db, args, deps, preloaded),
    deps.signal
  )
}

async function runCashflowSummaryInner(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  preloaded?: LoadedTransaction[]
): Promise<StatementToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareStatementRun(db, SUMMARIZE_TOOL_NAME, args, deps, undefined, preloaded)
  if ('failed' in prep) return prep.failed
  const { runId, resultRef: statementId, output, completedAt } = prep.prepared
  const summary = output as CashflowSummary
  // No data table for a summary (no overbuild, §13) — record the run done, persist no figures.
  // Guard the terminal write: `prepareStatementRun` leaves the row at 'started', so an unexpected
  // throw here (e.g. a transiently-locked DB) must still drive a terminal 'failed' status rather
  // than stranding the run at 'started' forever (B4 — the invariant the sibling seams hold via
  // domainPersistFailure; this is the one downstream seam with no surrounding transaction).
  try {
    finishRun(db, runId, 'done', completedAt, statementId, null)
  } catch {
    return domainPersistFailure(db, runId, now, '[skills] statement tool failed to persist')
  }
  // Surface the validated `CashflowSummary` for in-process reuse (audit P-1/P-2) — the analysis handler
  // reuses it instead of recomputing `summarizeCashflow` over a re-queried row set. The summary still
  // persists nothing; this is the same value the run already computed (content: in-process only).
  return { ok: true, runId, count: summary.count, output: summary }
}

export interface CsvExportDeps extends BankExtractionDeps {
  /**
   * Save CSV text to a user-chosen path (MAIN-side: a save dialog + write). Returns true once
   * written, false if the user cancelled the dialog. The path + content are NEVER logged/audited —
   * the seam only learns whether the user saved (ids/counts boundary, §9.5/§22-M1).
   */
  saveTextFile: (defaultFileName: string, content: string) => Promise<boolean>
  /** True once the user accepted the write/export confirm modal (the gate also enforces it). */
  confirmed?: boolean
}

/**
 * `export_transactions_csv` — produce the CSV (pure tool, confirm-gated `export-file`) and write it
 * MAIN-side to a user-chosen path. The CSV content + the chosen path never touch any log/audit; only
 * "saved N rows" (a count) is surfaced. A cancelled save persists nothing and reports it calmly.
 */
export async function runCsvExport(
  db: Db,
  args: BankExtractionArgs,
  deps: CsvExportDeps
): Promise<StatementToolResult> {
  return runDomainFileExport(db, args, deps, BANK_RUN_CONFIG, {
    toolName: EXPORT_TOOL_NAME,
    defaultFileName: 'transactions.csv',
    readOutput: (output) => {
      const { csv, rowCount } = output as { csv: string; rowCount: number }
      return { text: csv, rowCount }
    },
    writeFailLog: '[skills] CSV export failed to write'
  })
}

// =====================================================================================
// S11d — document redaction: the read-transform-export Tier-2 shape (architecture.md "Skills —
// design record" §8).
//
// Unlike the bank/invoice domains there is NO content-class data table and NO BEGIN/COMMIT: the
// deliverable is a FILE, not rows, so the seam records only the `skill_runs` lifecycle row
// (started → terminal; result_ref stays NULL) and writes the redacted text MAIN-side to a
// user-chosen path. The tool reads the selected document's chunks (the only content reach) and
// produces the redacted text + per-category counts; this seam writes that text via the SAME
// `saveTextFile` boundary the CSV export uses, gated on the `export-file` confirm (the gate also
// enforces it). PRIVACY: the redacted text is written ONLY to the user-chosen file (the deliberate,
// user-initiated exception); the detected personal-data values never reach any log/audit/run row —
// only the COUNT + a 'redacted'/'clean' discriminator are surfaced. The cancelled-before-write guard
// (B2) reports a cancel and writes nothing; the 'started' row always reaches a terminal status (B4).
// =====================================================================================

const REDACT_TOOL_NAME = 'redact_document'

export interface RedactionDeps extends BankExtractionDeps {
  /**
   * Save the redacted text to a user-chosen path (MAIN-side: a save dialog + write). Returns true
   * once written, false if the user cancelled. The path + content are NEVER logged/audited — the
   * seam only learns whether the user saved (ids/counts boundary, §9.5/§22-M1).
   */
  saveTextFile: (defaultFileName: string, content: string) => Promise<boolean>
  /** True once the user accepted the write/export confirm modal (the gate also enforces it). */
  confirmed?: boolean
}

export interface RedactionResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure, so the lifecycle is recorded). */
  runId: string
  /** The number of personal-data items masked (a content-free count the renderer surfaces). */
  redactionCount?: number
  /** A content-free outcome discriminator: 'redacted' when something was masked, else 'clean'. */
  resultKind?: string
  /** True when the run ended because it was CANCELLED (vs a genuine failure) — the seam is authority (B2). */
  cancelled?: boolean
  /** A content-free failure reason CODE the renderer localizes (I1). */
  errorCode?: string
  /** A friendly, content-free reason on failure. */
  error?: string
}

/**
 * `redact_document` — read the selected document, mask the detectable personal data (pure tool,
 * confirm-gated `export-file`), and write the redacted copy MAIN-side to a user-chosen path. The
 * redacted content + the chosen path never touch any log/audit; only "N items hidden" (a count) and a
 * 'redacted'/'clean' discriminator are surfaced. A cancelled save persists nothing and reports it
 * calmly. No data table, no BEGIN/COMMIT — only the `skill_runs` lifecycle row is recorded.
 */
export async function runDocumentRedaction(
  db: Db,
  args: BankExtractionArgs,
  deps: RedactionDeps
): Promise<RedactionResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]

  // Record the run as started BEFORE the gate; it always reaches a terminal status (B4).
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify(documentIds), now())

  try {
    const tool = getRegisteredTool(REDACT_TOOL_NAME)
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
      ctx,
      confirmed: deps.confirmed
    })
    if (!result.ok) {
      const cancelled = signal.aborted
      finishRun(db, runId, cancelled ? 'cancelled' : 'failed', now(), null, result.error)
      return { ok: false, runId, cancelled, error: result.error }
    }

    const output = result.output as RedactDocumentOutput
    const resultKind = output.totalRedactions > 0 ? 'redacted' : 'clean'

    // Cancelled after the tool produced the text but before the write — don't open the save dialog,
    // and report it as cancelled (not failed), so nothing is written under a cancel (B2).
    if (signal.aborted) {
      finishRun(db, runId, 'cancelled', now(), null, null)
      return { ok: false, runId, cancelled: true, error: 'Redaction cancelled. Nothing was saved.' }
    }
    let saved: boolean
    try {
      saved = await deps.saveTextFile('redacted.txt', output.redactedText)
    } catch {
      console.error('[skills] redaction failed to write')
      const msg = 'The file could not be saved. Nothing was changed.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'exportWriteFailed', error: msg }
    }
    if (!saved) {
      // The user cancelled the save dialog — a calm, non-error outcome (B1).
      finishRun(db, runId, 'cancelled', now(), null, null)
      return { ok: false, runId, cancelled: true, error: 'Redaction cancelled. Nothing was saved.' }
    }
    // result_ref stays NULL — redaction produces no DB artifact, and the path is never recorded.
    // SKA-27 rider (R9 review): redaction is the OTHER dialog-shaped seam — this terminal 'done' runs
    // after a minutes-open dialog too, and an unguarded throw here fell into the outer B4 catch, which
    // stamped the run 'failed' and told the user "Nothing was changed." after the redacted copy WAS
    // written. Same treatment as the export tail: one guarded retry, and past this point the outcome
    // reports what happened to the FILE — a bookkeeping failure can only log, never flip it.
    try {
      finishRun(db, runId, 'done', now(), null, null)
    } catch {
      console.error('[skills] redaction run bookkeeping failed')
      try {
        finishRun(db, runId, 'done', now(), null, null)
      } catch {
        /* the DB is genuinely unwritable — the file outcome stands */
      }
    }
    return { ok: true, runId, redactionCount: output.totalRedactions, resultKind }
  } catch {
    console.error('[skills] redaction failed unexpectedly')
    const msg = 'This could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'persistFailed', error: msg }
  }
}
