import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { t, type MessageKey } from '../../../shared/i18n'
import { tMain } from '../i18n'
import type { Db } from '../db'
import type {
  CoverageTier,
  DocTaskKind,
  DocTaskStatus,
  DocumentChunkRead,
  DocumentSummary,
  GeneratedProvenance,
  SkillToolAudit,
  StartDocTaskRequest,
  TranslationTargetLang
} from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import {
  runBankExtraction,
  ensureBuiltinCategories,
  latestBankStatementId,
  isBankStatementStale
} from '../skills/run'
import { categorizeTransactions } from '../skills/categorizer'
import { skillInstallId } from '../skills/registry'
import type { TransactionInput } from '../skills/tools/bank-statement'
import { isExceedContextError } from '../runtime/llama'
import { approxTokenCount, truncateToApproxTokens } from '../ingestion/chunker'
import {
  createQueuedDocument,
  deleteDocument,
  extractDocumentPreview,
  getDocument,
  processDocument,
  reindexDocument,
  setDocumentOcr,
  setDocumentOrigin,
  setDocumentSummary,
  type IngestionDeps
} from '../ingestion'
import { isPdfPath } from '../ingestion/parsers'
import type { OcrEngine, OcrPage } from '../ocr'
import type { RasterizePdf } from '../ocr/rasterizer'
import { ENCRYPTED_DOC_SUFFIX, shredFile } from '../workspace-vault'
import { cosineSimilarity, decodeVector } from '../embeddings'
import { isAbortError, stripThinkBlocks } from '../chat'
import { collectionIdsForDocument } from '../collections'
import { ModelSlotArbiter } from '../analysis/model-slot-arbiter'
import { buildTree } from '../analysis/tree-build'
import { extractDocument } from '../analysis/extract'
import { maxTreeLevel, nodeSummariesAtLevel } from '../analysis/coverage'
import { ensureNodeEmbeddings, loadNodeVectors } from '../analysis/node-vectors'
import type { AuditRecorder } from '../audit'
import { log } from '../logging'
import {
  packIntoWindows,
  planSummaryWindows,
  summaryBudgetWords,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_TEMPERATURE,
  SUMMARY_SYSTEM_PROMPT,
  singlePassPrompt,
  mapPrompt,
  reducePrompt
} from './summary'
import {
  planTranslationWindows,
  TRANSLATION_TEMPERATURE,
  translationSystemPrompt,
  translationWindowPrompt,
  failedWindowNotice,
  translationAttributionLine,
  translatedDocumentTitle
} from './translation'
import {
  planCompareWindows,
  compareBudgetWords,
  compareFitsSinglePass,
  COMPARE_OUTPUT_TOKENS,
  COMPARE_TEMPERATURE,
  COMPARE_NEIGHBORS_PER_CHUNK,
  compareSystemPrompt,
  compareFullPrompt,
  comparePairPrompt,
  compareReducePrompt,
  compareAttributionLine,
  compareTruncationNotice,
  compareSymmetricTruncationNotice,
  compareAsymmetricNotice,
  compareNodePairPrompt,
  comparePairOutputCap,
  alignNodes,
  SYMMETRIC_COMPARE_CALL_CEILING,
  compareDocumentTitle
} from './compare'

// The document-task manager (docs/functionality-wave-3-plan.md §6–§8) — the shared engine
// for summary, translation, and compare: an async-with-polling job state machine. The
// window-math + prompt templates for each pipeline live in the sibling
// summary/translation/compare modules (audit M-A4); this file is the orchestration.
//
// Concurrency (strict one-at-a-time):
// - Tasks serialize among THEMSELVES: one FIFO queue, one running task.
// - A task REFUSES to start while a chat answer is streaming. The check reads the
//   per-conversation in-flight registry, but tasks get their OWN AbortController and
//   are NEVER entries in that map — `stopGeneration(conversationId)` must not be able
//   to kill a document task, and a task must not block a conversation key.
// - The inverse guard lives in the chat/RAG IPC handlers: a chat message sent while a
//   task is active gets DOC_TASK_BUSY_MESSAGE (with a renderer-side cancel option).
//
// Runtime use: tasks call the ACTIVE chat runtime via the same `chatStream` contract
// with EXPLICIT maxTokens/temperature — never the answer-depth modes. No runtime
// running → a friendly "start a model first" failure, never an auto-start surprise
// (same rule as sendChatMessage).
//
// Vault-lease note: a summary task only READS chunk rows and WRITES the
// `documents.summary_json` column of the open DB — it never touches the `.enc`
// document sidecars on disk. It therefore deliberately does NOT take the
// `beginDocumentWork()` lease (which exists to keep sidecar writers and the vault
// password change mutually exclusive). TRANSLATION and COMPARE tasks are the inverse:
// their materialize step writes a `.enc` sidecar through the normal import path, so
// that step — and ONLY that step — holds the lease. The long window-by-window model
// loop runs lease-free so a password change is never blocked for minutes; a change
// landing mid-loop just makes the final materialize fail friendly (VaultBusyError).
//
// Privacy: summaries, translations, and comparison reports are CONTENT. They are
// persisted only in the (possibly encrypted) workspace — `documents.summary_json` /
// the materialized `.enc` document — and the audit events carry ids and kinds only
// (`{ kind, documentId }`, plus `documentIdB` for a compare).

// Friendly copy (spec §11.4) for the guards + failure states. Task errors live ONLY in
// the in-memory polling status (never the DB — verified for the i18n boundary, plan §6
// fact-5 check), so the THROW sites localize via tMain() (i18n record §3.3 rule 2). The
// canonical-English constants stay exported for the exact-string tests (D-L8).
export const TASK_NEEDS_RUNTIME_MESSAGE = t('en', 'main.noModelRunning')
export const TASK_REFUSED_CHAT_STREAMING_MESSAGE = t('en', 'main.task.refusedChatStreaming')
export const TASK_COMPARE_PICK_TWO_MESSAGE = t('en', 'main.task.comparePickTwo')
export const TASK_COMPARE_REINDEX_MESSAGE = t('en', 'main.task.compareReindex')
export const TASK_DOCUMENT_NOT_READY_MESSAGE = t('en', 'main.task.documentNotReady')
export const TASK_GENERIC_FAILURE_MESSAGE = t('en', 'main.task.genericFailure')
export const TASK_EXPIRED_MESSAGE = t('en', 'main.task.expired')
export const TASK_TRANSLATION_TARGET_MESSAGE = t('en', 'main.task.translationTarget')
export const TASK_SOURCE_UNREADABLE_MESSAGE = t('en', 'main.task.sourceUnreadable')
export const TASK_NEEDS_OCR_MESSAGE = t('en', 'main.task.needsOcr')
export const TASK_OCR_NOT_A_SCAN_MESSAGE = t('en', 'main.task.ocrNotAScan')
export const TASK_OCR_NO_TEXT_MESSAGE = t('en', 'main.task.ocrNoText')
export const TASK_OCR_FAILED_MESSAGE = t('en', 'main.task.ocrFailed')

/** Injected seams so the engine is testable without Electron and the IPC layer. */
export interface DocTaskDeps {
  /** The live workspace DB (the `ctx.db` getter — throws while locked). */
  getDb: () => Db
  /** The active chat runtime, or null when none is running. */
  getRuntime: () => ModelRuntime | null
  /** True while any chat/RAG answer is streaming (the in-flight registry). */
  isChatStreaming: () => boolean
  /** The user's `contextTokens` setting (drives the window budget). */
  getContextTokens: () => number
  /** `workspace/documents/` — where materialized documents (and their transients) live. */
  getStoreDir: () => string
  /** Ingestion deps (embedder + document cipher) for the materialize/import step. */
  getIngestionDeps: () => IngestionDeps
  /**
   * The vault lease (`WorkspaceController.beginDocumentWork`). Held ONLY around the
   * materialize step (it writes `.enc` sidecars); throws the friendly
   * `VaultBusyError` while a password change runs.
   */
  beginDocumentWork: () => () => void
  /**
   * The local OCR engine, or null when the drive carries no language files. The
   * 'ocr' kind refuses to start without it (friendly copy) — every other kind
   * ignores it. Read per task (the assets can appear mid-session).
   */
  getOcrEngine?: () => OcrEngine | null
  /**
   * PDF → page-PNG rasterizer: the hidden-window renderer in the app, a fake in
   * tests. Only the 'ocr' kind uses it.
   */
  rasterizePdf?: RasterizePdf
  audit?: AuditRecorder
}

interface InternalTask {
  status: DocTaskStatus
  controller: AbortController
  /** Validated translation target (kind === 'translation' only). */
  targetLang?: TranslationTargetLang
  /**
   * Coverage tier for a `summary` task over a ready deep index (whole-document-analysis plan
   * §4.5). 1 (default) = the stored root verbatim, 0 model calls; 2 = one section-by-section
   * reduce; 3 = a detailed full-coverage reduce in budget batches. Ignored without a tree.
   */
  summaryTier?: CoverageTier
}

const TERMINAL: ReadonlySet<DocTaskStatus['state']> = new Set(['done', 'failed', 'cancelled'])

export class DocTaskManager {
  private readonly tasks = new Map<string, InternalTask>()
  private queue: string[] = []
  private runningId: string | null = null
  /**
   * The single model-slot owner for a YIELDING tree build (plan §4.1, H9/H10). Only a
   * running `tree` build registers with it; chat uses it to pause+hand-off, never to race.
   */
  private readonly arbiter = new ModelSlotArbiter()

  constructor(private readonly deps: DocTaskDeps) {}

  /**
   * True while a YIELDING build (currently `tree`) is running and holds the model slot.
   * The chat guard branches on this: a yielding build is PAUSED (chat acquires the slot
   * via `acquireChatSlot`); any other active task makes chat refuse with DOC_TASK_BUSY.
   */
  isYieldingBuildActive(): boolean {
    return this.arbiter.isBuildActive()
  }

  /**
   * Chat side: claim the model slot before streaming. If a yielding build holds it, this
   * requests a pause and resolves once the builder parks (worst case ≈ one node); returns
   * a release fn the caller MUST invoke when the stream ends (it resumes the build). With
   * no build active it resolves immediately to a no-op. Idempotent release.
   */
  acquireChatSlot(): Promise<() => void> {
    return this.arbiter.acquireForChat()
  }

  /**
   * Abort the running yielding build (workspace lock / app quit / cancel): abort its task
   * controller AND reject the arbiter's parked `reacquire`, so a build parked awaiting a
   * chat handoff unwinds to a resumable `tree_status='building'` instead of a hung await
   * (plan §4.1 M9/H10). No-op when the running task is not a yielding build.
   */
  abortActiveBuild(): void {
    if (!this.runningId) return
    const task = this.tasks.get(this.runningId)
    if (!task || !isYieldingKind(task.status.kind)) return
    log.info('Active deep-index build aborted', { jobId: task.status.jobId, kind: task.status.kind })
    task.controller.abort()
    this.arbiter.abort()
  }

  /**
   * Auto-enqueue a deep-index (tree) build for a freshly-indexed document when it is worth
   * it (plan Q1/Q4/§6). Gated and fire-and-forget — never throws into the import/reindex
   * path: skips generated docs (M6), legacy not-`fully_chunked` docs (C4), already-built/
   * building/pending trees, and documents the cheap capped summary already covers (size
   * gate). With a chat runtime up it enqueues a `tree` task; otherwise it records
   * `tree_status='pending'` for a later build. The "Build deep index" UI and coverage meter
   * are in the renderer (rag-design.md §14.4).
   */
  maybeEnqueueTreeBuild(documentId: string): void {
    try {
      const db = this.deps.getDb()
      const doc = getDocument(db, documentId)
      if (!doc || doc.status !== 'indexed' || doc.chunkCount === 0) return
      if (doc.origin) return // generated work-products are excluded from the corpus (M6)
      const row = db
        .prepare('SELECT fully_chunked, tree_status FROM documents WHERE id = ?')
        .get(documentId) as unknown as
        | { fully_chunked: string | null; tree_status: string | null }
        | undefined
      if (!row?.fully_chunked) return // legacy/truncated — must re-index first (C4)
      if (row.tree_status === 'ready' || row.tree_status === 'building' || row.tree_status === 'pending') {
        return
      }
      // Size gate (Q4): only docs the capped one-pass summary cannot fully cover benefit
      // from a deep index. `planSummaryWindows().truncated` is exactly "too big for the
      // 12-window ceiling" — the silent-truncation case the tree fixes.
      const texts = (
        db
          .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
          .all(documentId) as unknown as Array<{ text: string }>
      )
        .map((r) => r.text)
        .filter((t) => t.trim().length > 0)
      if (!planSummaryWindows(texts, this.deps.getContextTokens()).truncated) return

      if (!this.deps.getRuntime()) {
        db.prepare('UPDATE documents SET tree_status = ?, updated_at = ? WHERE id = ?').run(
          'pending',
          new Date().toISOString(),
          documentId
        )
        return
      }
      this.startDocTask({ kind: 'tree', documentIds: [documentId] })
    } catch (err) {
      // Auto-enqueue is best-effort: a refused start (chat streaming) or any error leaves
      // the doc without a tree (the user can build it manually). Never breaks ingestion.
      log.info('Deep-index auto-enqueue skipped', {
        documentId,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * Validate + enqueue a task. Throws friendly errors for the guards (chat
   * streaming, no runtime) and for invalid requests; a queued/running task is reported
   * via `getDocTask` polling from then on.
   */
  startDocTask(req: StartDocTaskRequest): { jobId: string } {
    const kind = req?.kind as DocTaskKind
    if (
      kind !== 'summary' &&
      kind !== 'translation' &&
      kind !== 'compare' &&
      kind !== 'ocr' &&
      kind !== 'tree' &&
      kind !== 'extract' &&
      kind !== 'categorize'
    ) {
      throw new Error(tMain('main.task.unknownKind'))
    }
    // Translation targets are a closed set: de | en only — a free-text language
    // field invites silent quality failures.
    let targetLang: TranslationTargetLang | undefined
    if (kind === 'translation') {
      const raw = req.params?.targetLang
      if (raw !== 'de' && raw !== 'en') {
        throw new Error(tMain('main.task.translationTarget'))
      }
      targetLang = raw
    }
    // Coverage tier for a summary (whole-document-analysis plan §4.5). Tolerant: any value
    // other than 2 or 3 (incl. absent — the one-click summary) means Tier 1 (the default,
    // 0 extra model calls when a tree is ready), so the existing call site is unchanged.
    let summaryTier: CoverageTier | undefined
    if (kind === 'summary') {
      const raw = req.params?.tier
      summaryTier = raw === 2 ? 2 : raw === 3 ? 3 : 1
    }
    if (this.deps.isChatStreaming()) {
      throw new Error(tMain('main.task.refusedChatStreaming'))
    }
    // OCR runs the local recognition engine, not the chat model — it needs the
    // vendored language files instead of a running runtime. `categorize` (Phase 33) is the one
    // model-OPTIONAL kind: with no runtime it degrades to the deterministic rule pass, so it must
    // be allowed to start regardless — the runtime is read (possibly null) at run time.
    if (kind === 'ocr') {
      if (!this.deps.getOcrEngine?.()) {
        throw new Error(tMain('main.task.needsOcr'))
      }
    } else if (kind !== 'categorize' && !this.deps.getRuntime()) {
      throw new Error(tMain('main.noModelRunning'))
    }
    // Compare runs over exactly TWO (distinct) documents; summary/translation/ocr over one.
    const documentIds = (req.documentIds ?? []).filter((x) => typeof x === 'string' && x.length > 0)
    const wanted = kind === 'compare' ? 2 : 1
    if (documentIds.length !== wanted || new Set(documentIds).size !== wanted) {
      throw new Error(
        kind === 'compare'
          ? tMain('main.task.comparePickTwo')
          : kind === 'translation'
            ? tMain('main.task.pickOneTranslate')
            : kind === 'ocr'
              ? tMain('main.task.pickOneOcr')
              : tMain('main.task.pickOneSummarize')
      )
    }
    if (kind === 'ocr') {
      // The target is a scan-DETECTED PDF (step 0 marked it), or an already-OCR'd PDF
      // being re-run (better assets / a bad first pass). Never an ordinary document.
      const doc = getDocument(this.deps.getDb(), documentIds[0])
      if (!doc || !isPdfPath(doc.title) || !(doc.scanDetected || doc.ocr)) {
        throw new Error(tMain('main.task.ocrNotAScan'))
      }
    } else {
      for (const id of documentIds) {
        const doc = getDocument(this.deps.getDb(), id)
        if (!doc || doc.status !== 'indexed' || doc.chunkCount === 0) {
          throw new Error(tMain('main.task.documentNotReady'))
        }
        // Deep-index precondition (C4): only a FULLY chunked document may be tree-built or
        // extract-scanned, so "whole document"/"100% coverage" can never be claimed over a
        // silently-truncated legacy chunk set. A legacy (NULL marker) doc must be re-indexed
        // first (which sets it or fails over-cap). Same gate for the extract pass (Phase 3).
        if (kind === 'tree' || kind === 'extract') {
          const row = this.deps
            .getDb()
            .prepare('SELECT fully_chunked FROM documents WHERE id = ?')
            .get(id) as unknown as { fully_chunked: string | null } | undefined
          if (!row?.fully_chunked) throw new Error(tMain('main.task.documentNotReady'))
        }
      }
    }

    const jobId = randomUUID()
    const task: InternalTask = {
      status: {
        jobId,
        kind,
        documentIds,
        state: 'queued',
        progress: { stepsDone: 0, stepsTotal: 0 },
        error: null,
        resultRef: null
      },
      controller: new AbortController(),
      targetLang,
      summaryTier
    }
    this.tasks.set(jobId, task)
    this.queue.push(jobId)
    log.info('Document task queued', { jobId, kind, documentId: documentIds[0] })
    this.pump()
    return { jobId }
  }

  /** Poll one task. Unknown/expired ids report a terminal state so pollers stop. */
  getDocTask(jobId: string): DocTaskStatus {
    const task = this.tasks.get(jobId)
    if (task) {
      // Return a copy — the renderer must not share mutable state with the engine.
      return { ...task.status, progress: { ...task.status.progress } }
    }
    return {
      jobId,
      kind: 'summary',
      documentIds: [],
      state: 'failed',
      progress: { stepsDone: 0, stepsTotal: 0 },
      error: tMain('main.task.expired'),
      resultRef: null
    }
  }

  /**
   * Cancel a task: a running one is aborted mid-stream, a queued one is dequeued.
   * With no jobId, cancels the currently active (running, else next queued) task —
   * the chat screen's "cancel the busy task" affordance.
   */
  cancelDocTask(jobId?: string | null): void {
    const id = jobId ?? this.runningId ?? this.queue[0] ?? null
    if (!id) return
    const task = this.tasks.get(id)
    if (!task || TERMINAL.has(task.status.state)) return
    log.info('Document task cancel requested', { jobId: id })
    if (task.status.state === 'queued') {
      this.queue = this.queue.filter((q) => q !== id)
      task.status.state = 'cancelled'
      return
    }
    task.controller.abort()
    // A running yielding build (tree/extract) may be PARKED on the arbiter (yielded to chat);
    // aborting its controller alone won't unstick that await, so reject the parked reacquire too.
    if (isYieldingKind(task.status.kind)) this.arbiter.abort()
  }

  /** True while a task is running or queued — the chat-side busy guard reads this. */
  hasActiveTask(): boolean {
    return this.runningId !== null || this.queue.length > 0
  }

  /** True when an active (running/queued) task targets `documentId` — guards re-index/delete. */
  isDocumentBusy(documentId: string): boolean {
    const ids = [...(this.runningId ? [this.runningId] : []), ...this.queue]
    return ids.some((id) => this.tasks.get(id)?.status.documentIds.includes(documentId) ?? false)
  }

  /** True when a running OR queued task of `kind` already targets `documentId` — the dedup guard the
   *  `extract` auto-offer uses so a re-run extract (or extract + a manual categorize) never enqueues a
   *  second `categorize` over the same statement (duplicate model work, overwriting the first's labels). */
  hasPendingKind(documentId: string, kind: DocTaskKind): boolean {
    const ids = [...(this.runningId ? [this.runningId] : []), ...this.queue]
    return ids.some((id) => {
      const t = this.tasks.get(id)
      return t != null && t.status.kind === kind && t.status.documentIds.includes(documentId)
    })
  }

  /** Run the next queued task; tasks serialize among themselves. */
  private pump(): void {
    if (this.runningId) return
    const next = this.queue.shift()
    if (!next) return
    const task = this.tasks.get(next)
    if (!task || task.status.state !== 'queued') {
      this.pump()
      return
    }
    this.runningId = next
    void this.run(task).finally(() => {
      this.runningId = null
      this.pump()
    })
  }

  private async run(task: InternalTask): Promise<void> {
    const { kind } = task.status
    // The SOURCE document id(s) — the audit events carry these; a generated OUTPUT id
    // travels in `resultRef` (and is appended to `documentIds` for the busy guard, so
    // capture the sources BEFORE the task runs). A compare's second source rides as
    // the additive ids-only `documentIdB`.
    const documentId = task.status.documentIds[0]
    const auditMeta: Record<string, unknown> = { kind, documentId }
    if (kind === 'compare' && task.status.documentIds[1]) {
      auditMeta.documentIdB = task.status.documentIds[1]
    }
    task.status.state = 'running'
    try {
      let resultId: string
      if (kind === 'ocr') {
        // OCR uses the recognition engine, not the chat runtime.
        resultId = await this.runOcr(task)
      } else if (kind === 'categorize') {
        // The bank-statement LLM categorizer (Phase 33) — model-OPTIONAL: a null runtime degrades to
        // the deterministic rule pass inside runCategorize (so it never fails for "no model").
        resultId = await this.runCategorize(task, this.deps.getRuntime())
      } else {
        // Re-check at dequeue time: the runtime may have been stopped while queued.
        const runtime = this.deps.getRuntime()
        if (!runtime) throw new Error(tMain('main.noModelRunning'))
        resultId =
          kind === 'compare'
            ? await this.runCompare(task, runtime)
            : kind === 'translation'
              ? await this.runTranslation(task, runtime)
              : kind === 'tree'
                ? await this.runTreeBuild(task, runtime)
                : kind === 'extract'
                  ? await this.runExtract(task, runtime)
                  : await this.runSummary(task, runtime)
      }
      task.status.state = 'done'
      task.status.resultRef = { documentId: resultId }
      this.deps.audit?.('document_task_completed', `Document task completed: ${kind}`, auditMeta)
      log.info('Document task completed', { jobId: task.status.jobId, kind, documentId })
    } catch (err) {
      if (isAbortError(err, task.controller.signal)) {
        task.status.state = 'cancelled'
        log.info('Document task cancelled', { jobId: task.status.jobId, kind, documentId })
        return
      }
      const raw = err instanceof Error ? err.message : String(err)
      // Friendly failures (§11.4): our own guard copy passes through (as does the
      // vault lease's VaultBusyError — its message is written for users); anything
      // else (runtime/HTTP/SQL errors) is replaced by the generic copy. The raw reason
      // goes to the local log only — never to the renderer, never to the audit log.
      const friendly =
        isFriendlyTaskError(raw) || (err instanceof Error && err.name === 'VaultBusyError')
      task.status.state = 'failed'
      task.status.error = friendly ? raw : tMain('main.task.genericFailure')
      this.deps.audit?.('document_task_failed', `Document task failed: ${kind}`, auditMeta)
      log.error('Document task failed', { jobId: task.status.jobId, kind, documentId, error: raw })
    }
  }

  /**
   * The deep-index (tree) build: the YIELDING background job that builds the document's
   * hierarchical summary tree (plan §4.1). Registers with the model-slot arbiter for the
   * duration so chat can pause it between nodes and it resumes in-session. Pins the build
   * to the current chat model (M12 — the cache is keyed by it, so a model change can't
   * yield a mixed-model tree). DB-only writer ⇒ no vault lease (L1).
   */
  private async runTreeBuild(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const documentId = task.status.documentIds[0]
    const signal = task.controller.signal
    this.arbiter.registerBuild(task.status.jobId)
    try {
      await buildTree(documentId, {
        db: this.deps.getDb(),
        modelId: runtime.modelId,
        contextTokens: this.deps.getContextTokens(),
        signal,
        arbiter: this.arbiter,
        jobId: task.status.jobId,
        generate: (systemPrompt, prompt, maxTokens, temperature, sig) =>
          this.generate(runtime, systemPrompt, prompt, maxTokens, temperature, sig),
        onProgress: (done, total) => {
          task.status.progress.stepsDone = done
          task.status.progress.stepsTotal = total
        }
      })
    } finally {
      // Always release the slot ownership — on success, abort, or error — so a later chat
      // never waits on a handoff from a build that is gone.
      this.arbiter.unregisterBuild(task.status.jobId)
    }
    return documentId
  }

  /**
   * The structured-extract pass (whole-document-analysis plan §4.2, Phase 3): the second
   * YIELDING background job. Per chunk it makes one model call to surface structured items,
   * stored in `extraction_records` so a later "list every X" answer is a pure SQL aggregation
   * (0 query-time model calls). Same arbiter handshake + yielding/cancel discipline as the
   * tree build; resumable (already-scanned chunks are skipped via their `__scan__` marker).
   * DB-only writer ⇒ no vault lease (L1). Content is never logged/audited.
   */
  private async runExtract(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const documentId = task.status.documentIds[0]
    const signal = task.controller.signal
    this.arbiter.registerBuild(task.status.jobId)
    try {
      await extractDocument(documentId, {
        db: this.deps.getDb(),
        modelId: runtime.modelId,
        signal,
        arbiter: this.arbiter,
        jobId: task.status.jobId,
        generate: (systemPrompt, prompt, maxTokens, temperature, sig) =>
          this.generate(runtime, systemPrompt, prompt, maxTokens, temperature, sig),
        onProgress: (done, total) => {
          task.status.progress.stepsDone = done
          task.status.progress.stepsTotal = total
        }
      })
    } finally {
      this.arbiter.unregisterBuild(task.status.jobId)
    }
    return documentId
  }

  /**
   * Serve a whole-document summary from a READY deep index at the chosen coverage tier
   * (whole-document-analysis plan §4.5). All tiers cover the whole document (`truncated:false`)
   * — they differ in DEPTH, not breadth. Returns the summary, or null to fall through to the
   * capped path. One model job at a time (we run inside the serialized summary task).
   * - Tier 1: the stored ROOT verbatim — 0 model calls (Q6).
   * - Tier 2: the root's children (the layer below the root, which fit ONE budget window by
   *   construction) reduced once → a richer section-by-section summary (1 model call).
   * - Tier 3: ALL level-1 nodes (the deepest summary layer, full leaf coverage) reduced in
   *   budget-bounded batches — bounded by NODE count, never by document size at query time.
   */
  private async summarizeFromTree(
    task: InternalTask,
    runtime: ModelRuntime,
    documentId: string,
    title: string,
    tier: CoverageTier
  ): Promise<DocumentSummary | null> {
    const db = this.deps.getDb()
    const root = db
      .prepare('SELECT summary_text, model_id FROM tree_nodes WHERE document_id = ? AND is_root = 1 LIMIT 1')
      .get(documentId) as unknown as { summary_text: string; model_id: string | null } | undefined
    if (!root || root.summary_text.length === 0) return null
    const now = (): string => new Date().toISOString()

    // Tier 1: the stored root verbatim — no model call (Q6).
    if (tier === 1) {
      task.status.progress.stepsTotal = 1
      task.status.progress.stepsDone = 1
      return { text: root.summary_text, modelId: root.model_id ?? runtime.modelId, createdAt: now(), truncated: false, tier: 1 }
    }

    // Tier 2/3 read precomputed node summaries and reduce them.
    const maxLevel = maxTreeLevel(db, documentId)
    const nodeTexts =
      tier === 3
        ? nodeSummariesAtLevel(db, documentId, 1)
        : maxLevel > 1
          ? nodeSummariesAtLevel(db, documentId, maxLevel - 1)
          : []
    // Degenerate tree (a single level, or an empty layer): nothing richer than the root.
    if (nodeTexts.length === 0) {
      task.status.progress.stepsTotal = 1
      task.status.progress.stepsDone = 1
      return { text: root.summary_text, modelId: root.model_id ?? runtime.modelId, createdAt: now(), truncated: false, tier }
    }

    const contextTokens = this.deps.getContextTokens()
    const budgetWords = summaryBudgetWords(contextTokens)
    const windows = packIntoWindows(nodeTexts, budgetWords)
    const signal = task.controller.signal
    task.status.progress.stepsTotal = windows.length <= 1 ? 1 : windows.length + 1

    let text: string
    if (windows.length <= 1) {
      // One reduce over the node summaries (Tier 2 always; Tier 3 when they fit one window).
      text = await this.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        reducePrompt(title, windows.length === 1 ? [windows[0]] : nodeTexts),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
        signal
      )
      task.status.progress.stepsDone = 1
    } else {
      // Tier 3 deep tree: reduce each batch (map), then reduce the batch summaries — bounded
      // by node count. Each batch was packed to fit the input budget.
      const partials: string[] = []
      for (const w of windows) {
        const partial = await this.generate(
          runtime,
          SUMMARY_SYSTEM_PROMPT,
          reducePrompt(title, [w]),
          SUMMARY_OUTPUT_TOKENS,
          SUMMARY_TEMPERATURE,
          signal
        )
        if (partial.length > 0) partials.push(partial)
        task.status.progress.stepsDone += 1
      }
      if (partials.length === 0) return null
      let reduceInput = partials
      const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
      if (totalWords > budgetWords) {
        reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
      }
      text = await this.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        reducePrompt(title, reduceInput),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
        signal
      )
      task.status.progress.stepsDone += 1
    }
    if (text.length === 0) return null
    return { text, modelId: runtime.modelId, createdAt: now(), truncated: false, tier }
  }

  /** The summary task: stored chunks in, `summary_json` out. */
  private async runSummary(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(tMain('main.task.documentNotReady'))

    // Tree-first (plan M1/§4.5): when a deep index is ready, serve from it at the requested
    // coverage TIER — Tier 1 (default) returns the stored ROOT verbatim at 0 extra model
    // calls (Q6), Tier 2/3 reduce precomputed node summaries (still whole-document, so
    // `truncated:false`). The existing summary_json / PreviewModal surface is unchanged.
    // Falls through to the capped map-reduce below when there is no ready tree (the fallback).
    const treeRow = db
      .prepare('SELECT tree_status, tree_meta_json FROM documents WHERE id = ?')
      .get(documentId) as unknown as
      | { tree_status: string | null; tree_meta_json: string | null }
      | undefined
    if (treeRow?.tree_status === 'ready' && treeRow.tree_meta_json) {
      const built = await this.summarizeFromTree(
        task,
        runtime,
        documentId,
        doc.title,
        task.summaryTier ?? 1
      )
      if (built) {
        setDocumentSummary(this.deps.getDb(), documentId, built)
        return documentId
      }
    }

    // Input = the document's stored CHUNKS, in order (no re-parse). Adjacent chunks
    // overlap by ~80 tokens (the chunker's retrieval overlap); the slight repetition
    // is harmless for summarization.
    const rows = db
      .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as unknown as Array<{ text: string }>
    const texts = rows.map((r) => r.text).filter((t) => t.trim().length > 0)
    if (texts.length === 0) throw new Error(tMain('main.task.documentNotReady'))

    const contextTokens = this.deps.getContextTokens()
    const plan = planSummaryWindows(texts, contextTokens)
    task.status.progress.stepsTotal = plan.stepsTotal
    const signal = task.controller.signal

    let summaryText: string
    if (plan.singlePass) {
      summaryText = await this.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        singlePassPrompt(doc.title, plan.windows[0] ?? ''),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
        signal
      )
      task.status.progress.stepsDone = 1
    } else {
      const partials: string[] = []
      for (let i = 0; i < plan.windows.length; i++) {
        const partial = await this.generate(
          runtime,
          SUMMARY_SYSTEM_PROMPT,
          mapPrompt(doc.title, i + 1, plan.windows.length, plan.windows[i]),
          plan.mapMaxTokens,
          SUMMARY_TEMPERATURE,
          signal
        )
        if (partial.length > 0) partials.push(partial)
        task.status.progress.stepsDone += 1
      }
      if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))
      // Belt for the reduce input: the map output caps already size partials to fit,
      // but a model that ignores maxTokens semantics must still not overflow.
      const budgetWords = summaryBudgetWords(contextTokens)
      let reduceInput = partials
      const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
      if (totalWords > budgetWords) {
        reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
      }
      summaryText = await this.generate(
        runtime,
        SUMMARY_SYSTEM_PROMPT,
        reducePrompt(doc.title, reduceInput),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
        signal
      )
      task.status.progress.stepsDone += 1
    }

    if (summaryText.length === 0) throw new Error(tMain('main.task.genericFailure'))
    const summary: DocumentSummary = {
      text: summaryText,
      modelId: runtime.modelId,
      createdAt: new Date().toISOString(),
      truncated: plan.truncated
    }
    // Re-read via a fresh getter: the document may have been deleted while we worked
    // (the IPC layer refuses re-index/delete on a busy document, but be safe anyway —
    // the UPDATE on a vanished row is a no-op).
    setDocumentSummary(this.deps.getDb(), documentId, summary)
    return documentId
  }

  /**
   * The OCR task ("Make searchable (OCR)", never automatic): rasterize the stored
   * PDF page by page in the hidden window, recognize each page PNG main-side with
   * the local engine, persist the recognition (`documents.ocr_json`, content → DB
   * only), then re-ingest — the PdfParser's ocrPages hook turns the recognition into
   * one segment per page, so page citations work unchanged.
   * Progress = pages recognized + the final re-ingest step; cancel persists NOTHING.
   */
  private async runOcr(task: InternalTask): Promise<string> {
    const engine = this.deps.getOcrEngine?.()
    const rasterize = this.deps.rasterizePdf
    if (!engine || !rasterize) throw new Error(tMain('main.task.needsOcr'))
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(tMain('main.task.ocrNotAScan'))
    const signal = task.controller.signal

    const pdf = await this.readStoredPdfBytes(documentId)
    const pages: OcrPage[] = []
    try {
      await rasterize(pdf, {
        signal,
        onPageCount: (n) => {
          // pages + persist/re-ingest as the final step.
          task.status.progress.stepsTotal = n + 1
        },
        onPage: async (pageNumber, png) => {
          // Backpressure: the next page is not rendered until this recognition ends.
          const result = await engine.recognize(png, { signal })
          pages.push({ pageNumber, text: result.text.trim() })
          task.status.progress.stepsDone += 1
          if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
        }
      })
    } catch (err) {
      if (isAbortError(err, signal)) throw err
      // §11.4: raw render/recognition errors go to the local log only.
      log.warn('OCR task failed while reading the scan', {
        documentId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw new Error(tMain('main.task.ocrFailed'))
    }
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    if (!pages.some((p) => p.text.length > 0)) {
      throw new Error(tMain('main.task.ocrNoText'))
    }

    // Persist the recognition, then re-ingest through the normal pipeline (chunks,
    // embeddings, FTS — the document becomes a first-class searchable corpus member).
    // The re-ingest may rewrite a legacy plaintext stored copy to `.enc`, so it holds
    // the vault lease like every sidecar writer (VaultBusyError → friendly fail).
    setDocumentOcr(db, documentId, {
      pages,
      engineId: engine.id,
      languages: [...engine.languages]
    })
    const release = this.deps.beginDocumentWork()
    try {
      const result = await reindexDocument(
        db,
        this.deps.getStoreDir(),
        documentId,
        this.deps.getIngestionDeps()
      )
      if (result.status !== 'indexed') {
        // The recognition stays persisted (it is real work); the document row keeps
        // the re-ingest failure message — Re-index retries with the stored pages.
        log.error('OCR re-ingest did not reach indexed', {
          documentId,
          status: result.status,
          error: result.errorMessage
        })
        throw new Error(tMain('main.task.ocrFailed'))
      }
    } finally {
      release()
    }
    task.status.progress.stepsDone += 1
    return documentId
  }

  /**
   * Read the stored PDF's plaintext bytes for rasterization. Encrypted copies decrypt
   * to a `.parse-ocr.pdf` transient (covered by the startup crash sweep) that is
   * shredded before returning — only the in-memory Buffer leaves this method.
   */
  private async readStoredPdfBytes(documentId: string): Promise<Buffer> {
    const db = this.deps.getDb()
    const row = db
      .prepare('SELECT title, stored_path, original_path FROM documents WHERE id = ?')
      .get(documentId) as unknown as
      | { title: string; stored_path: string | null; original_path: string | null }
      | undefined
    if (!row) throw new Error(tMain('main.task.sourceUnreadable'))
    const cipher = this.deps.getIngestionDeps().cipher ?? null
    try {
      // ING-8 (perf audit 2026-06-18): read the (potentially huge, up to ~1 GiB) PDF with async
      // `readFile` so the bytes stream off the main event loop instead of a blocking `readFileSync`.
      if (row.stored_path && existsSync(row.stored_path)) {
        if (row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)) {
          if (!cipher) throw new Error(tMain('main.task.sourceUnreadable'))
          const transient = join(this.deps.getStoreDir(), `${documentId}.parse-ocr.pdf`)
          try {
            cipher.decryptFile(row.stored_path, transient)
            return await readFile(transient)
          } finally {
            shredFile(transient)
          }
        }
        return await readFile(row.stored_path)
      }
      if (row.original_path && existsSync(row.original_path)) {
        return await readFile(row.original_path)
      }
    } catch (err) {
      log.warn('OCR source read failed', {
        documentId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw new Error(tMain('main.task.sourceUnreadable'))
    }
    throw new Error(tMain('main.task.sourceUnreadable'))
  }

  /**
   * The translation task: re-extracted parser SEGMENTS in, window-by-window
   * translation in document order (no reduce), one NEW materialized Markdown
   * document out. Returns the new document's id (the `resultRef`).
   */
  private async runTranslation(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const targetLang = task.targetLang
    if (!targetLang) throw new Error(tMain('main.task.translationTarget'))
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(tMain('main.task.documentNotReady'))

    // The input is the parser's SEGMENTS re-extracted from the stored copy —
    // ordered and non-overlapping (see the window-math note above; stored chunks
    // would duplicate their ~80-token overlap into the translation).
    const segmentTexts = await this.extractSegmentTexts(documentId)

    const plan = planTranslationWindows(segmentTexts, this.deps.getContextTokens())
    task.status.progress.stepsTotal = plan.stepsTotal
    const signal = task.controller.signal

    // Map in document order — no reduce. A window the model refuses/garbles is
    // retried ONCE, then MARKED visibly with the original text kept; it is never
    // silently dropped. Only a fully-failed translation fails the task.
    const parts: string[] = []
    let failedWindows = 0
    for (let i = 0; i < plan.windows.length; i++) {
      const translated = await this.generateWithRetry(
        runtime,
        translationSystemPrompt(targetLang),
        translationWindowPrompt(targetLang, i + 1, plan.windows.length, plan.windows[i]),
        plan.windowMaxTokens,
        TRANSLATION_TEMPERATURE,
        signal
      )
      if (translated !== null) {
        parts.push(translated)
      } else {
        failedWindows += 1
        parts.push(`${failedWindowNotice(i + 1, plan.windows.length)}\n\n${plan.windows[i]}`)
      }
      task.status.progress.stepsDone += 1
    }
    if (failedWindows === plan.windows.length) throw new Error(tMain('main.task.genericFailure'))

    // Materialize ONLY now that every window succeeded (or is honestly marked) — a
    // cancelled task persists nothing, so the last cancellation point is here.
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    const markdown = `> ${translationAttributionLine(runtime.modelId)}\n\n${parts.join('\n\n')}\n`
    const newDocId = await this.materializeDocument(
      task,
      markdown,
      translatedDocumentTitle(doc.title, targetLang),
      this.buildProvenance('translation', [documentId], runtime.modelId)
    )
    task.status.progress.stepsDone += 1
    return newDocId
  }

  /**
   * Re-extract a document's ordered, non-overlapping segment texts from its stored
   * copy (never the ~80-token-overlapping chunks). Encrypted copies decrypt to a
   * `.parse*` transient inside and are shredded on the way out.
   */
  private async extractSegmentTexts(documentId: string): Promise<string[]> {
    let texts: string[]
    try {
      const preview = await extractDocumentPreview(
        this.deps.getDb(),
        this.deps.getStoreDir(),
        documentId,
        { cipher: this.deps.getIngestionDeps().cipher ?? null }
      )
      texts = preview.segments.map((s) => s.text).filter((t) => t.trim().length > 0)
    } catch (err) {
      log.warn('Document task source re-extraction failed', {
        documentId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw new Error(tMain('main.task.sourceUnreadable'))
    }
    if (texts.length === 0) throw new Error(tMain('main.task.documentNotReady'))
    return texts
  }

  /**
   * The compare task: two documents in, one materialized "Comparison: A vs B.md"
   * report out. The strategy auto-switches on token math — mode (a) when both
   * re-extracted full texts fit one call, else mode (b) section-matched over the
   * stored chunks + vectors. Returns the new document's id.
   */
  private async runCompare(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const db = this.deps.getDb()
    const [idA, idB] = task.status.documentIds
    const docA = getDocument(db, idA)
    const docB = getDocument(db, idB)
    if (!docA || !docB) throw new Error(tMain('main.task.documentNotReady'))

    // The mode decision AND mode (a)'s input both use the re-extracted parser
    // segments — exact and non-overlapping. Deciding on stored chunks would inflate
    // the length by the ~80-token overlap (and mode (a) would show the model
    // duplicated text as phantom "shared" content).
    const textA = (await this.extractSegmentTexts(idA)).join('\n\n')
    const textB = (await this.extractSegmentTexts(idB)).join('\n\n')
    const contextTokens = this.deps.getContextTokens()
    const signal = task.controller.signal

    let report: string
    let truncated = false
    let asymmetric = false
    if (compareFitsSinglePass(approxTokenCount(textA), approxTokenCount(textB), contextTokens)) {
      // Mode (a): one structured-comparison call over both full texts — already symmetric.
      task.status.progress.stepsTotal = 2
      report = await this.generate(
        runtime,
        compareSystemPrompt(),
        compareFullPrompt(docA.title, textA, docB.title, textB),
        COMPARE_OUTPUT_TOKENS,
        COMPARE_TEMPERATURE,
        signal
      )
      if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
      task.status.progress.stepsDone = 1
    } else {
      // Large docs. Prefer the SYMMETRIC both-trees path when both documents are deeply
      // indexed (plan §4.3, H8): align level-1 sections by node-vector cosine and diff each
      // pair, so swapping A/B mirrors. Otherwise fall back to the A-driven mode (b), LABELLED
      // asymmetric (it may under-report content unique to B — the existing honesty note).
      const symmetric = this.bothTreesReadyForSymmetric(idA, idB)
        ? await this.runCompareSymmetricTrees(task, runtime, docA, docB)
        : null
      if (symmetric) {
        report = symmetric.report
        // A lopsided pair (few aligned sections but many Only-A/Only-B notes) can overflow
        // the reduce input; the belt then drops the tail (the Only-B notes are last), so the
        // symmetric report would silently under-report. Surface the same honest notice mode
        // (b) uses rather than implying a complete two-way comparison (H8).
        truncated = symmetric.truncated
      } else {
        const sectionMatched = await this.runCompareSectionMatched(task, runtime, docA, docB)
        report = sectionMatched.report
        truncated = sectionMatched.truncated
        asymmetric = true
      }
    }

    // Materialize: attribution + (honest) asymmetric/truncation notices + report.
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    const markdown =
      `> ${compareAttributionLine(runtime.modelId)}\n\n` +
      (asymmetric ? `${compareAsymmetricNotice(docB.title)}\n\n` : '') +
      (truncated
        ? `${asymmetric ? compareTruncationNotice(docA.title) : compareSymmetricTruncationNotice()}\n\n`
        : '') +
      `${report}\n`
    const newDocId = await this.materializeDocument(
      task,
      markdown,
      compareDocumentTitle(docA.title, docB.title),
      this.buildProvenance('compare', [idA, idB], runtime.modelId)
    )
    task.status.progress.stepsDone += 1
    return newDocId
  }

  /**
   * Mode (b) — section-matched compare: window doc A's stored chunks, retrieve each
   * window's nearest doc-B chunks (cosine over doc-B's stored vectors, decoded ONCE),
   * compare each matched pair (map), then reduce the notes into the report.
   */
  private async runCompareSectionMatched(
    task: InternalTask,
    runtime: ModelRuntime,
    docA: { id: string; title: string },
    docB: { id: string; title: string }
  ): Promise<{ report: string; truncated: boolean }> {
    const db = this.deps.getDb()
    const contextTokens = this.deps.getContextTokens()
    const signal = task.controller.signal

    // Embedder-visibility guard: the pairing reads stored vectors, so BOTH documents
    // must be visible to the ACTIVE embedder — a stale-embeddings document would
    // silently pair against nothing. Fail friendly with the actionable re-index copy
    // instead.
    const embedder = this.deps.getIngestionDeps().embedder
    if (!embedder) throw new Error(tMain('main.task.compareReindex'))
    const embeddedCount = (documentId: string): number => {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
           WHERE c.document_id = ? AND e.embedding_model_id = ?`
        )
        .get(documentId, embedder.id) as unknown as { n: number }
      return r.n
    }
    if (embeddedCount(docA.id) === 0 || embeddedCount(docB.id) === 0) {
      throw new Error(tMain('main.task.compareReindex'))
    }

    // Doc A's chunks in document order, with their STORED vectors (no re-embedding —
    // the pairing must be deterministic and cost nothing but cosine scans).
    const aRows = db
      .prepare(
        `SELECT c.id, c.text, e.vector_blob, e.dimensions
         FROM chunks c JOIN embeddings e ON e.chunk_id = c.id AND e.embedding_model_id = ?
         WHERE c.document_id = ? ORDER BY c.chunk_index`
      )
      .all(embedder.id, docA.id) as unknown as Array<{
      id: string
      text: string
      vector_blob: Uint8Array
      dimensions: number
    }>
    if (aRows.length === 0) throw new Error(tMain('main.task.compareReindex'))

    const plan = planCompareWindows(
      aRows.map((r) => ({ id: r.id, text: r.text })),
      contextTokens
    )
    if (plan.windows.length === 0) throw new Error(tMain('main.task.documentNotReady'))
    task.status.progress.stepsTotal = plan.stepsTotal

    const vectorByChunk = new Map(
      aRows.map((r) => [r.id, decodeVector(r.vector_blob, r.dimensions)])
    )
    // RAG-2/ING-1 (perf audit 2026-06-18): load doc-B's chunks ONCE — text, chunk_index AND
    // vector together — and decode each B vector a single time. The previous code ran
    // VectorIndex.search per A-chunk, which re-issued `SELECT … FROM embeddings WHERE chunk_id
    // IN (…doc B…)` and re-decoded EVERY doc-B vector for each A-chunk (O(N_A × N_B) redundant
    // decodes + N_A full re-scans), then re-fetched B's text with a fresh IN(…) per window.
    // Mirrors the alignNodes approach (compare.ts:349): pre-decode both sides, cosine in memory.
    const bChunks = (
      db
        .prepare(
          `SELECT c.id, c.text, c.chunk_index, e.vector_blob, e.dimensions
           FROM chunks c JOIN embeddings e ON e.chunk_id = c.id AND e.embedding_model_id = ?
           WHERE c.document_id = ? ORDER BY c.chunk_index`
        )
        .all(embedder.id, docB.id) as unknown as Array<{
        id: string
        text: string
        chunk_index: number
        vector_blob: Uint8Array
        dimensions: number
      }>
    ).map((r) => ({
      id: r.id,
      text: r.text,
      chunkIndex: r.chunk_index,
      vec: decodeVector(r.vector_blob, r.dimensions)
    }))
    const bById = new Map(bChunks.map((b) => [b.id, b]))
    // Top-`topK` doc-B neighbors of one A-vector, scored against the resident decoded vectors —
    // same ranking VectorIndex.search produced (descending cosine, slice topK), no DB round-trip.
    const nearestB = (vec: Float32Array, topK: number): Array<{ chunkId: string; score: number }> => {
      const hits: Array<{ chunkId: string; score: number }> = []
      for (const b of bChunks) {
        if (b.vec.length !== vec.length) continue
        hits.push({ chunkId: b.id, score: cosineSimilarity(vec, b.vec) })
      }
      hits.sort((x, y) => y.score - x.score)
      return hits.slice(0, topK)
    }

    const partials: string[] = []
    for (let i = 0; i < plan.windows.length; i++) {
      const window = plan.windows[i]
      // Union of each window chunk's top-N doc-B neighbors, best score kept.
      // Deterministic: scores come from stored vectors; ties break on chunk id.
      const scoreByB = new Map<string, number>()
      for (const chunkId of window.chunkIds) {
        const vec = vectorByChunk.get(chunkId)
        if (!vec) continue
        for (const hit of nearestB(vec, COMPARE_NEIGHBORS_PER_CHUNK)) {
          const prev = scoreByB.get(hit.chunkId)
          if (prev === undefined || hit.score > prev) scoreByB.set(hit.chunkId, hit.score)
        }
      }
      const candidates = [...scoreByB.entries()].sort(
        (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)
      )
      // Fill the B side best-first up to its word budget; present the picked excerpts
      // in doc-B document order (readability). The first excerpt always fits — a
      // degenerate tiny context hard-truncates it rather than sending nothing. The text +
      // chunk_index come from the resident `bById` map loaded once above (RAG-2: no per-window
      // IN(…) re-fetch).
      const picked: Array<{ text: string; chunkIndex: number }> = []
      let usedWords = 0
      for (const [chunkId] of candidates) {
        const row = bById.get(chunkId)
        if (!row) continue
        const rowWords = approxTokenCount(row.text)
        if (picked.length === 0 && rowWords > plan.pairBudgetWords) {
          picked.push({
            text: truncateToApproxTokens(row.text, plan.pairBudgetWords),
            chunkIndex: row.chunkIndex
          })
          usedWords = plan.pairBudgetWords
          continue
        }
        if (usedWords + rowWords > plan.pairBudgetWords) continue
        picked.push(row)
        usedWords += rowWords
      }
      picked.sort((x, y) => x.chunkIndex - y.chunkIndex)
      const excerptsB = picked.map((p) => p.text).join('\n\n')

      const partial = await this.generate(
        runtime,
        compareSystemPrompt(),
        comparePairPrompt(
          docA.title,
          docB.title,
          i + 1,
          plan.windows.length,
          window.text,
          excerptsB
        ),
        plan.mapMaxTokens,
        COMPARE_TEMPERATURE,
        signal
      )
      if (partial.length > 0) partials.push(partial)
      task.status.progress.stepsDone += 1
    }
    if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))

    // Belt for the reduce input: the map output caps already size the notes to fit,
    // but a model that ignores maxTokens must still not overflow. If it fires it cuts the
    // tail — i.e. the later doc-A windows — so flag it too (alongside the map-ceiling
    // coverage cut) and let the caller surface the honest notice (H8 — never imply full
    // coverage when content was dropped; mirrors the symmetric path).
    const budgetWords = compareBudgetWords(contextTokens)
    let reduceInput = partials
    let beltTruncated = false
    const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
    if (totalWords > budgetWords) {
      reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
      beltTruncated = true
    }
    const report = await this.generate(
      runtime,
      compareSystemPrompt(),
      compareReducePrompt(docA.title, docB.title, reduceInput),
      COMPARE_OUTPUT_TOKENS,
      COMPARE_TEMPERATURE,
      signal
    )
    if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
    task.status.progress.stepsDone += 1
    return { report, truncated: plan.truncated || beltTruncated }
  }

  /**
   * Both documents have a ready deep index AND the smaller one has few enough level-1
   * sections that a symmetric pair-by-pair diff stays CPU-bounded (the pair count never
   * exceeds the smaller section count). Gates the SYMMETRIC mode (c); otherwise compare
   * falls back to the labelled asymmetric mode (b).
   */
  private bothTreesReadyForSymmetric(idA: string, idB: string): boolean {
    const db = this.deps.getDb()
    const ready = (id: string): boolean => {
      const row = db.prepare('SELECT tree_status FROM documents WHERE id = ?').get(id) as
        | { tree_status: string | null }
        | undefined
      return row?.tree_status === 'ready'
    }
    if (!ready(idA) || !ready(idB)) return false
    const level1Count = (id: string): number =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ? AND level = 1')
          .get(id) as unknown as { n: number }
      ).n
    return Math.min(level1Count(idA), level1Count(idB)) <= SYMMETRIC_COMPARE_CALL_CEILING
  }

  /**
   * Mode (c) — SYMMETRIC both-trees compare (plan §4.3, H4/H8). Lazily embeds each tree's
   * nodes under the active embedder (the FIRST consumer of node vectors — L6; reused +
   * H5-staleness-guarded thereafter), aligns each document's level-1 summary SECTIONS by
   * node-vector cosine (`alignNodes`, greedy mutual-best-match with a swap-invariant
   * tie-break), diffs every aligned pair with one `generate` call, attributes unmatched
   * sections to Only-A / Only-B (no model call — node summaries are derived context, never
   * `[Sn]` citations, M2), and reduces the notes into the four-section report. Swapping A/B
   * yields the mirror-image report. Returns null to signal "not applicable — fall back to the
   * asymmetric path" (a degenerate tree with no level-1 vectors). The lazy embed runs on the
   * CPU embedder sidecar, NOT the chat slot, inside the (non-yielding) compare task — still
   * one model job at a time.
   */
  private async runCompareSymmetricTrees(
    task: InternalTask,
    runtime: ModelRuntime,
    docA: { id: string; title: string },
    docB: { id: string; title: string }
  ): Promise<{ report: string; truncated: boolean } | null> {
    const db = this.deps.getDb()
    const signal = task.controller.signal
    const contextTokens = this.deps.getContextTokens()

    // Node vectors are required; the embedder must be present (same friendly copy as mode (b)).
    const embedder = this.deps.getIngestionDeps().embedder
    if (!embedder) throw new Error(tMain('main.task.compareReindex'))

    // Lazy node embeddings [L6] under the active embedder; re-embeds any node under a
    // different embedder [H5]; 0 sidecar calls on the warm path.
    await ensureNodeEmbeddings(db, docA.id, embedder, signal)
    await ensureNodeEmbeddings(db, docB.id, embedder, signal)
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')

    const aNodes = loadNodeVectors(db, docA.id, 1, embedder.id)
    const bNodes = loadNodeVectors(db, docB.id, 1, embedder.id)
    if (aNodes.length === 0 || bNodes.length === 0) return null // degenerate → asymmetric fallback

    const alignment = alignNodes(aNodes, bNodes)
    // Diffs + reduce + the materialize step (consistent with mode (b)'s stepsTotal accounting).
    task.status.progress.stepsTotal = alignment.pairs.length + 2

    const aById = new Map(aNodes.map((n) => [n.id, n]))
    const bById = new Map(bNodes.map((n) => [n.id, n]))
    const pairCap = comparePairOutputCap(contextTokens, alignment.pairs.length)
    const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 400)

    const partials: string[] = []
    let part = 0
    for (const pair of alignment.pairs) {
      if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
      const sectionA = aById.get(pair.aId)?.summaryText ?? ''
      const sectionB = bById.get(pair.bId)?.summaryText ?? ''
      part += 1
      const note = await this.generate(
        runtime,
        compareSystemPrompt(),
        compareNodePairPrompt(docA.title, docB.title, part, alignment.pairs.length, sectionA, sectionB),
        pairCap,
        COMPARE_TEMPERATURE,
        signal
      )
      if (note.length > 0) partials.push(note)
      task.status.progress.stepsDone += 1
    }
    // Unmatched sections → Only-A / Only-B notes with NO model call (M2-safe: the node
    // summary is fed as a note for the reduce, never surfaced as a citation). INTERLEAVE the
    // two sides (A, B, A, B, …) rather than appending all Only-A then all Only-B: if the
    // reduce belt below cuts the tail, an interleaved order sheds both documents' unique
    // content roughly evenly, keeping the loss mirror-symmetric (swapping A/B drops the same
    // sections, off by at most one note at an odd boundary) instead of always sacrificing the
    // Only-B tail first.
    const onlyA = alignment.unmatchedA
      .map((id) => aById.get(id)?.summaryText)
      .filter((s): s is string => !!s && s.trim().length > 0)
      .map((s) => `- Only in A: ${oneLine(s)}`)
    const onlyB = alignment.unmatchedB
      .map((id) => bById.get(id)?.summaryText)
      .filter((s): s is string => !!s && s.trim().length > 0)
      .map((s) => `- Only in B: ${oneLine(s)}`)
    for (let i = 0; i < Math.max(onlyA.length, onlyB.length); i++) {
      if (i < onlyA.length) partials.push(onlyA[i])
      if (i < onlyB.length) partials.push(onlyB[i])
    }
    if (partials.length === 0) throw new Error(tMain('main.task.genericFailure'))

    // Belt for the reduce input (the per-pair caps already size the notes, but a model that
    // ignores maxTokens must still not overflow the reduce call's input budget).
    const budgetWords = compareBudgetWords(contextTokens)
    let reduceInput = partials
    // When the notes overflow the reduce budget, the belt cuts the tail — and the Only-B
    // notes are appended last, so a lopsided pair would silently lose B-unique content.
    // Flag it so the caller materializes the honest truncation notice (H8 — never imply a
    // complete two-way comparison when content was dropped).
    let truncated = false
    if (partials.reduce((n, p) => n + approxTokenCount(p), 0) > budgetWords) {
      reduceInput = [truncateToApproxTokens(partials.join('\n\n'), budgetWords)]
      truncated = true
    }
    const report = await this.generate(
      runtime,
      compareSystemPrompt(),
      compareReducePrompt(docA.title, docB.title, reduceInput),
      COMPARE_OUTPUT_TOKENS,
      COMPARE_TEMPERATURE,
      signal
    )
    if (report.length === 0) throw new Error(tMain('main.task.genericFailure'))
    task.status.progress.stepsDone += 1
    return { report, truncated }
  }

  /**
   * Build the structured provenance (plan §15.1) a materialized output carries: the
   * generation kind, its source ids, the model that produced it, and a snapshot of the
   * source(s)' collection memberships at creation time. NEW generations write this
   * `GeneratedProvenance`; the legacy `Translation/CompareOrigin` shapes still parse on
   * read (back-compat). A generated row is given NO `document_collections` membership of
   * its own (N1/D3 — handled by NOT filing it); `sourceCollectionIds` is provenance only.
   */
  private buildProvenance(
    kind: GeneratedProvenance['kind'],
    sourceDocumentIds: string[],
    modelId: string
  ): GeneratedProvenance {
    const db = this.deps.getDb()
    const sourceCollectionIds = [
      ...new Set(sourceDocumentIds.flatMap((id) => collectionIdsForDocument(db, id)))
    ]
    const prov: GeneratedProvenance = {
      kind,
      sourceDocumentIds,
      modelId,
      createdAt: new Date().toISOString()
    }
    if (sourceCollectionIds.length > 0) prov.sourceCollectionIds = sourceCollectionIds
    return prov
  }

  /**
   * Write the generated Markdown to a transient file and run it through the NORMAL
   * import path (`createQueuedDocument` + `processDocument`) so the new document is
   * chunked, embedded, searchable, citable, and `.enc`-encrypted automatically.
   * Holds the vault lease for exactly this step — it writes `.enc` sidecars
   * (`VaultBusyError` from a concurrent password change propagates as a friendly task
   * failure). The transient uses the `.parse` infix so the startup crash sweep shreds
   * it if we die mid-step; otherwise it is shredded here, success or failure.
   */
  private async materializeDocument(
    task: InternalTask,
    markdown: string,
    title: string,
    origin: GeneratedProvenance
  ): Promise<string> {
    const release = this.deps.beginDocumentWork()
    const db = this.deps.getDb()
    const storeDir = this.deps.getStoreDir()
    const tempPath = join(storeDir, `${task.status.jobId}.parse.md`)
    let newDocId: string | null = null
    try {
      // ING-6 (perf audit 2026-06-18): the in-RAM `markdown` is written to a temp `.parse.md`
      // and re-read/re-parsed/re-chunked by the canonical import path below. This disk round-trip
      // + redundant parse is DELIBERATE, not an oversight: routing the generated output through
      // the SAME `createQueuedDocument` → `processDocument` pipeline gets encryption-at-rest, the
      // FTS trigger, citations, and the crash-safe queue-time provenance stamp (DM-2) for free,
      // and keeps ONE import code path. An in-memory ingestion entry would duplicate all of that;
      // add it only if profiling shows this round-trip matters (the embed pass dominates anyway).
      writeFileSync(tempPath, markdown, 'utf8')
      // Stamp the generated provenance AT QUEUE TIME, before processDocument can flip the
      // row to `indexed`. A process kill between `indexed` and a later origin-write would
      // otherwise satisfy the Library backfill (`origin_json IS NULL` + no membership) and
      // wrongly file this work-product into Library, violating D3/N1 (DM-2).
      const info = createQueuedDocument(db, tempPath, { displayTitle: title, origin })
      newDocId = info.id
      // The output document is born inside the task — OUTSIDE registerDocsIpc's
      // `processing` set — so list it on the task: `isDocumentBusy` then covers it
      // and it cannot be deleted/re-indexed mid-materialize.
      task.status.documentIds.push(info.id)
      const result = await processDocument(db, storeDir, info.id, this.deps.getIngestionDeps())
      if (result.status !== 'indexed') {
        // processDocument never throws — but a materialized output must fully succeed
        // or persist nothing, so a failed import removes the half-born row again.
        log.error(`Materialized ${origin.kind} output failed to import`, {
          jobId: task.status.jobId,
          status: result.status,
          error: result.errorMessage
        })
        throw new Error(tMain('main.task.genericFailure'))
      }
      // origin_json was already stamped at queue time (DM-2); re-assert it post-success to
      // also clear original_path (the transient source is shredded in `finally`). Idempotent.
      setDocumentOrigin(db, info.id, origin)
      // A new corpus document must never appear without an audit trail (filename +
      // id only — the translated text is content, never audit-logged).
      this.deps.audit?.('document_imported', `Document imported: ${result.title}`, {
        documentId: info.id,
        status: result.status,
        chunkCount: result.chunkCount
      })
      return info.id
    } catch (err) {
      if (newDocId) deleteDocument(db, newDocId)
      throw err
    } finally {
      shredFile(tempPath)
      release()
    }
  }

  /**
   * The bank-statement LLM categorizer task (Phase 33; architecture.md §21). It lives in the doctask
   * lane PURELY for the chat↔task one-job-at-a-time exclusion (D26) — the `SkillRunController` and the
   * `ModelSlotArbiter` are separate lanes that wouldn't stop two `chatStream` calls hitting the one
   * llama-server at once. Steps: (1) locate the latest statement for the document and AUTO-EXTRACT it
   * first when none exists (fixes the (D) "categorize before extract" ordering failure); (2) run the
   * categorizer over the rows (`runtime` null ⇒ deterministic rule pass — model-OPTIONAL); (3) persist
   * `bank_transactions.category_id` ATOMICALLY (no partial annotations survive a failure). A category is
   * not a figure, so this never touches the verified total or the D56 gate — only the breakdown. The
   * source document id is the resultRef. Aborts propagate (a cancel lands in `cancelled`, nothing partial).
   */
  private async runCategorize(task: InternalTask, runtime: ModelRuntime | null): Promise<string> {
    const documentId = task.status.documentIds[0]
    const signal = task.controller.signal
    const db = this.deps.getDb()
    const nowIso = new Date().toISOString()

    // (1) The latest statement. Auto-extract first when the user clicked categorize before extract, OR
    // when the latest was produced by an outdated extractor (A9 — `isBankStatementStale`): categorizing
    // rows a since-fixed parser bug mis-signed / lost a payee on is wasted work, so re-extract (replacing
    // the stale statement) and categorize the corrected rows.
    let statementId = latestBankStatementId(db, documentId)
    if (!statementId || isBankStatementStale(db, statementId)) {
      const audit: SkillToolAudit = (type, meta) => this.deps.audit?.(type, type, meta)
      const ingestion = this.deps.getIngestionDeps()
      const storeDir = this.deps.getStoreDir()
      const readDocumentSegments = async (
        id: string,
        opts?: { layout?: boolean }
      ): Promise<DocumentChunkRead[]> => {
        const preview = await extractDocumentPreview(
          db,
          storeDir,
          id,
          { cipher: ingestion.cipher, ocrEngine: this.deps.getOcrEngine?.() ?? ingestion.ocrEngine },
          { layout: opts?.layout }
        )
        return preview.segments.map((s, index) => ({ text: s.text, page: s.pageNumber, index }))
      }
      const ext = await runBankExtraction(
        db,
        { skillInstallId: skillInstallId('app', 'bank-statement'), conversationId: null, documentId },
        { audit, signal, readDocumentSegments, layout: true, replaceExisting: true }
      )
      if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
      if (!ext.ok || !ext.statementId) throw new Error(tMain('main.task.documentNotReady'))
      statementId = ext.statementId
    }

    // (2) Load the rows (with ids, in stable order) and categorize them.
    const loaded = db
      .prepare(
        `SELECT id, date, description, amount, currency
         FROM bank_transactions WHERE statement_id = ? ORDER BY row_index`
      )
      .all(statementId) as Array<{ id: string; date: string; description: string; amount: number; currency: string }>
    const rows: TransactionInput[] = loaded.map((r) => ({
      date: r.date,
      description: r.description,
      amount: r.amount,
      currency: r.currency
    }))
    const { assignments, modelAssisted } = await categorizeTransactions(rows, {
      runtime,
      signal,
      onProgress: (done, total) => {
        task.status.progress.stepsDone = done
        task.status.progress.stepsTotal = total
      }
    })
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')

    // (3) Persist atomically — seed the categories (union of rule + LLM taxonomy), update each row, and
    // record whether the LLM was consulted (the authoritative model-assisted signal the read-back labels
    // the breakdown by — never re-derived from the category names). A failure ROLLBACKs so no partial
    // categorization survives (no-partial-persist).
    try {
      db.exec('BEGIN')
      const byName = ensureBuiltinCategories(db, nowIso)
      const upd = db.prepare('UPDATE bank_transactions SET category_id = ? WHERE id = ?')
      for (const a of assignments) {
        const tx = loaded[a.index]
        const catId = byName.get(a.category)
        if (tx && catId) upd.run(catId, tx.id)
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
    return documentId
  }

  /**
   * One translation window: a failed or empty generation is retried once; a second
   * failure returns null (the caller marks the window). Aborts always propagate
   * immediately — cancel must never look like a failed window.
   */
  private async generateWithRetry(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = await this.generate(runtime, systemPrompt, prompt, maxTokens, temperature, signal)
        if (out.length > 0) return out
        log.warn('Translation window came back empty', { attempt })
      } catch (err) {
        if (isAbortError(err, signal)) throw err
        log.warn('Translation window failed', {
          attempt,
          error: err instanceof Error ? err.message : String(err)
        })
      }
      if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    }
    return null
  }

  /**
   * One model call over the LOCKED `chatStream` contract: explicit
   * maxTokens/temperature, NO depth mode, the task's own abort signal. Cancellation
   * must never persist a half result — an abort throws instead of returning the
   * partial text (chat keeps partials; tasks do not).
   */
  private async generate(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ]
    let out = ''
    const stream = runtime.chatStream(messages, {
      signal,
      maxTokens,
      temperature
    })
    try {
      for await (const token of stream) {
        out += token
      }
    } catch (err) {
      // A document window that overflows the model context comes back as an HTTP 400.
      // Surface the actionable "too large for this model" copy (a friendly task error)
      // rather than the raw "Chat request failed: HTTP 400" the generic path would hide.
      if (isExceedContextError(err)) throw new Error(tMain('main.model.contextExceeded'))
      throw err
    }
    // The mock runtime returns cleanly on abort; the real one throws AbortError. Both
    // must land in the `cancelled` state, so normalize the clean return into a throw.
    if (signal.aborted) {
      throw new DOMException('Document task cancelled', 'AbortError')
    }
    return stripThinkBlocks(out).trim()
  }
}

/** The YIELDING build kinds (whole-document-analysis plan §4.1): they cede the model slot to
 *  chat via the arbiter and resume in-session, rather than refusing chat while active. */
function isYieldingKind(kind: DocTaskKind): boolean {
  return kind === 'tree' || kind === 'extract'
}

/** Keys of the guard/validation copy that may pass through to the renderer on failure. */
const FRIENDLY_TASK_ERROR_KEYS: readonly MessageKey[] = [
  'main.noModelRunning',
  'main.model.contextExceeded',
  'main.task.refusedChatStreaming',
  'main.task.documentNotReady',
  'main.task.genericFailure',
  'main.task.translationTarget',
  'main.task.sourceUnreadable',
  'main.task.comparePickTwo',
  'main.task.compareReindex',
  'main.task.needsOcr',
  'main.task.ocrNotAScan',
  'main.task.ocrNoText',
  'main.task.ocrFailed'
]

/**
 * True when a thrown message is our own friendly guard copy (exact match). The guards
 * throw via tMain(), so the message may be in EITHER language — and the cached language
 * can even change between a guard throwing and the failure being recorded — so both
 * catalogs are checked, not just the current one.
 */
export function isFriendlyTaskError(raw: string): boolean {
  return FRIENDLY_TASK_ERROR_KEYS.some((key) => raw === t('en', key) || raw === t('de', key))
}
