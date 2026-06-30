import { randomUUID } from 'node:crypto'
import { t, type MessageKey } from '../../../shared/i18n'
import { tMain } from '../i18n'
import type {
  CoverageTier,
  DocTaskKind,
  DocTaskStatus,
  StartDocTaskRequest,
  TranslationTargetLang
} from '../../../shared/types'
import type { ChatMessage, ModelRuntime } from '../runtime'
import { isExceedContextError } from '../runtime/llama'
import { getDocument } from '../ingestion'
import { isPdfPath } from '../ingestion/parsers'
import { isAbortError, stripThinkBlocks } from '../chat'
import { ModelSlotArbiter } from '../analysis/model-slot-arbiter'
import { planSummaryWindows } from './summary'
import { log } from '../logging'
import type { DocTaskCtx, DocTaskDeps, InternalTask } from './context'
import { MODEL_TASK_HANDLERS, runCategorize, runOcr } from './handlers'

// `DocTaskDeps` lives in `./context` now (the per-kind handlers need it too); re-exported here so
// every existing `from '../services/doctasks'` importer is byte-for-byte unaffected.
export type { DocTaskDeps } from './context'

// The document-task manager (architecture.md "Document tasks"; wave-3 plan §6–§8, now in
// architecture.md "Functionality wave 3 — design record") — the shared engine for summary,
// translation, and compare: an async-with-polling job state machine. The window-math + prompt
// templates for each pipeline live in the sibling summary/translation/compare modules (audit
// M-A4); the per-kind WORK lives in the `handlers/` modules keyed by a registry (DX-1,
// full-audit-2026-06-29 follow-up Phase 8). THIS file is the orchestration: queue/pump, the
// model-slot arbiter handshake, the model loop (`generate`/`generateWithRetry` retry), and the
// dispatch wrapper that records success/failure/cancel.
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
  /** The narrow orchestration handle handed to each per-kind handler (DX-1). */
  private readonly ctx: DocTaskCtx

  constructor(private readonly deps: DocTaskDeps) {
    this.ctx = {
      deps,
      arbiter: this.arbiter,
      generate: (runtime, systemPrompt, prompt, maxTokens, temperature, signal) =>
        this.generate(runtime, systemPrompt, prompt, maxTokens, temperature, signal),
      generateWithRetry: (runtime, systemPrompt, prompt, maxTokens, temperature, signal) =>
        this.generateWithRetry(runtime, systemPrompt, prompt, maxTokens, temperature, signal)
    }
  }

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
   * no build active it resolves immediately to a no-op. Idempotent release. REL-3: the chat
   * turn's abort `signal` is threaded through so a "Stop" during the park unwinds at once.
   */
  acquireChatSlot(signal?: AbortSignal): Promise<() => void> {
    return this.arbiter.acquireForChat(signal)
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

  /**
   * Dispatch one task to its per-kind handler (the registry), then record success/failure/
   * cancel. The orchestration wrapper — state transitions, audit events, friendly-error
   * mapping — lives here; the kind-specific work lives in `handlers/`.
   */
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
        resultId = await runOcr(task, this.ctx)
      } else if (kind === 'categorize') {
        // The bank-statement LLM categorizer (Phase 33) — model-OPTIONAL: a null runtime degrades to
        // the deterministic rule pass inside runCategorize (so it never fails for "no model").
        resultId = await runCategorize(task, this.deps.getRuntime(), this.ctx)
      } else {
        // Re-check at dequeue time: the runtime may have been stopped while queued.
        const runtime = this.deps.getRuntime()
        if (!runtime) throw new Error(tMain('main.noModelRunning'))
        // Registry dispatch (DX-1): every runtime-requiring kind is a one-line entry in
        // `MODEL_TASK_HANDLERS`, not another `else if` branch here.
        resultId = await MODEL_TASK_HANDLERS[kind](task, runtime, this.ctx)
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
