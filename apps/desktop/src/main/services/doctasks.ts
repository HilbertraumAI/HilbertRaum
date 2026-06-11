import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import type {
  DocTaskKind,
  DocTaskStatus,
  DocumentSummary,
  StartDocTaskRequest
} from '../../shared/types'
import type { ChatMessage, ModelRuntime } from './runtime'
import { approxTokenCount, tokenize } from './ingestion/chunker'
import { getDocument, setDocumentSummary } from './ingestion'
import { isAbortError, stripThinkBlocks } from './chat'
import type { AuditRecorder } from './audit'
import { log } from './logging'

// Document task service (Phase 33, wave-3 plan §6) — the shared engine for
// summary (this phase), translation (Phase 34), and compare (Phase 35): a job state
// machine on the Phase-4/18 async-with-polling precedent.
//
// Concurrency (decision D26, RESOLVED — strict one-at-a-time):
// - Tasks serialize among THEMSELVES: one FIFO queue, one running task.
// - A task REFUSES to start while a chat answer is streaming. The check reads the
//   per-conversation in-flight registry, but tasks get their OWN AbortController and
//   are NEVER entries in that map (fact §2.8) — `stopGeneration(conversationId)` must
//   not be able to kill a document task, and a task must not block a conversation key.
// - The inverse guard lives in the chat/RAG IPC handlers: a chat message sent while a
//   task is active gets DOC_TASK_BUSY_MESSAGE (with a renderer-side cancel option).
//
// Runtime use: tasks call the ACTIVE chat runtime via the same `chatStream` contract
// with EXPLICIT maxTokens/temperature — never the answer-depth modes. No runtime
// running → a friendly "start a model first" failure, never an auto-start surprise
// (consistent with the sendChatMessage decision).
//
// Vault-lease note (Phase 32): a summary task only READS chunk rows and WRITES the
// `documents.summary_json` column of the open DB — it never touches the `.enc`
// document sidecars on disk. It therefore deliberately does NOT take the
// `beginDocumentWork()` lease (which exists to keep sidecar writers and the vault
// password change mutually exclusive). Future task kinds that materialize documents
// (translation/compare, D27/D28) WILL need the lease — revisit there.
//
// Privacy: summaries are CONTENT. They are persisted only via `setDocumentSummary`
// (the possibly-encrypted DB) and the audit events carry `{ kind, documentId }` only.

/** Friendly copy (spec §11.4) for the guards + failure states. */
export const TASK_NEEDS_RUNTIME_MESSAGE =
  'No AI model is running. Open the AI Model screen and start one first.'
export const TASK_REFUSED_CHAT_STREAMING_MESSAGE =
  'An answer is being written right now. Wait for it to finish (or stop it), then try again.'
export const TASK_KIND_UNAVAILABLE_MESSAGE = 'This document task is not available yet.'
export const TASK_DOCUMENT_NOT_READY_MESSAGE =
  'This document has no readable text yet. Import or re-index it first, then try again.'
export const TASK_GENERIC_FAILURE_MESSAGE =
  'The task could not be finished. Make sure the model is still running, then try again.'
export const TASK_EXPIRED_MESSAGE = 'This task is no longer available.'

// ---- Summary window math (decision D25 — budget-driven two-level map-reduce) -------
//
// Budgets reuse the chunker's word≈token estimate (`approxTokenCount` = whitespace
// words). That estimate UNDERCOUNTS real model tokens (umlauts, punctuation, subword
// splits), so the input budget is derived in words via an explicit words→tokens safety
// factor: usable context tokens ÷ SUMMARY_TOKENS_PER_WORD. A window that fits the word
// budget then cannot overflow the model's real `contextTokens` window.

/** maxTokens for the single-pass and reduce calls (also the output reserve). */
export const SUMMARY_OUTPUT_TOKENS = 512
/** Reserved for the instruction template + chat chrome, in model tokens. */
export const SUMMARY_PROMPT_RESERVE_TOKENS = 300
/** Real-tokens-per-whitespace-word safety factor (German office text measures ~1.2–1.3). */
export const SUMMARY_TOKENS_PER_WORD = 1.3
/**
 * Hard ceiling on map calls (D25): ~12 windows ≈ a ~50-page document at the default
 * context. Beyond it the summary honestly covers the beginning (`truncated` flag).
 */
export const SUMMARY_MAP_CALL_CEILING = 12
/** Low temperature: summaries should be faithful, not creative. */
export const SUMMARY_TEMPERATURE = 0.3
/** Floor for a map call's output cap — below this, partials stop being useful. */
const SUMMARY_MAP_OUTPUT_FLOOR_TOKENS = 128

/** Usable model tokens for input text after the prompt + output reserves. */
function usableInputTokens(contextTokens: number): number {
  const ctx = Math.max(1024, Math.floor(contextTokens) || 0)
  return ctx - SUMMARY_OUTPUT_TOKENS - SUMMARY_PROMPT_RESERVE_TOKENS
}

/** The per-call input budget in WORDS (the chunker's token estimate unit). */
export function summaryBudgetWords(contextTokens: number): number {
  return Math.max(200, Math.floor(usableInputTokens(contextTokens) / SUMMARY_TOKENS_PER_WORD))
}

export interface SummaryPlan {
  /** Window texts, in document order. One window = single pass; more = map-reduce. */
  windows: string[]
  singlePass: boolean
  /** True when the map-call ceiling cut content: the summary covers the beginning. */
  truncated: boolean
  /** Output cap per map call, sized so ALL partials fit the reduce call's input budget. */
  mapMaxTokens: number
  /** Model calls planned: map windows (+ 1 reduce when not single-pass). */
  stepsTotal: number
}

/**
 * Plan the summary windows for a document's chunk texts (pure — unit-tested at the
 * boundaries). Chunks are packed greedily, in order, into windows of at most
 * `summaryBudgetWords` words; a single over-budget chunk (only possible when a small
 * `contextTokens` pushes the budget under the ~500-word chunk size) is SPLIT into
 * budget-sized pieces rather than truncated — no text silently dropped before the
 * ceiling. More windows than the ceiling → keep the first SUMMARY_MAP_CALL_CEILING
 * and mark the plan truncated.
 */
export function planSummaryWindows(chunkTexts: string[], contextTokens: number): SummaryPlan {
  const budgetWords = summaryBudgetWords(contextTokens)

  // Split any over-budget chunk into budget-sized pieces (document order kept).
  const pieces: Array<{ text: string; words: number }> = []
  for (const text of chunkTexts) {
    const words = tokenize(text)
    if (words.length === 0) continue
    if (words.length <= budgetWords) {
      pieces.push({ text, words: words.length })
    } else {
      for (let at = 0; at < words.length; at += budgetWords) {
        const slice = words.slice(at, at + budgetWords)
        pieces.push({ text: slice.join(' '), words: slice.length })
      }
    }
  }

  const windows: string[] = []
  let current: string[] = []
  let currentWords = 0
  const flush = (): void => {
    if (current.length > 0) {
      windows.push(current.join('\n\n'))
      current = []
      currentWords = 0
    }
  }
  for (const piece of pieces) {
    if (currentWords + piece.words > budgetWords) flush()
    current.push(piece.text)
    currentWords += piece.words
  }
  flush()

  let truncated = false
  let kept = windows
  if (windows.length > SUMMARY_MAP_CALL_CEILING) {
    kept = windows.slice(0, SUMMARY_MAP_CALL_CEILING)
    truncated = true
  }

  const singlePass = kept.length <= 1
  // Cap each partial so the reduce input (all partials together) provably fits the
  // input budget: windows × mapMaxTokens ≤ usable input tokens. The floor keeps tiny
  // contexts from degenerating; the reduce step additionally hard-truncates its input.
  const mapMaxTokens = singlePass
    ? SUMMARY_OUTPUT_TOKENS
    : Math.max(
        SUMMARY_MAP_OUTPUT_FLOOR_TOKENS,
        Math.min(SUMMARY_OUTPUT_TOKENS, Math.floor(usableInputTokens(contextTokens) / kept.length))
      )

  return {
    windows: kept,
    singlePass,
    truncated,
    mapMaxTokens,
    stepsTotal: singlePass ? 1 : kept.length + 1
  }
}

// ---- Prompts ------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT =
  'You are a careful assistant summarizing a document for its owner, fully offline. ' +
  'Use only the provided text. Never invent facts, names, or numbers. ' +
  'Write the summary in the same language as the document.'

function singlePassPrompt(title: string, text: string): string {
  return (
    `Summarize the document "${title}". Start with a short overview paragraph, then list ` +
    'the key points as bullets. Keep important names, numbers, and dates exact.\n\n' +
    `Document text:\n${text}`
  )
}

function mapPrompt(title: string, part: number, total: number, text: string): string {
  return (
    `Summarize part ${part} of ${total} of the document "${title}" in one concise paragraph. ` +
    'Keep important names, numbers, and dates exact.\n\n' +
    `Part text:\n${text}`
  )
}

function reducePrompt(title: string, partials: string[]): string {
  return (
    `Below are partial summaries of consecutive parts of the document "${title}". Combine ` +
    'them into one coherent summary: a short overview paragraph, then the key points as ' +
    'bullets. Keep important names, numbers, and dates exact. Do not mention the parts.\n\n' +
    partials.map((p, i) => `Part ${i + 1} summary:\n${p}`).join('\n\n')
  )
}

// ---- The task manager ----------------------------------------------------------------

/** Injected seams so the engine is testable without Electron and the IPC layer. */
export interface DocTaskDeps {
  /** The live workspace DB (the `ctx.db` getter — throws while locked). */
  getDb: () => Db
  /** The active chat runtime, or null when none is running. */
  getRuntime: () => ModelRuntime | null
  /** True while any chat/RAG answer is streaming (the in-flight registry, fact §2.8). */
  isChatStreaming: () => boolean
  /** The user's `contextTokens` setting (drives the window budget). */
  getContextTokens: () => number
  audit?: AuditRecorder
}

interface InternalTask {
  status: DocTaskStatus
  controller: AbortController
}

const TERMINAL: ReadonlySet<DocTaskStatus['state']> = new Set(['done', 'failed', 'cancelled'])

export class DocTaskManager {
  private readonly tasks = new Map<string, InternalTask>()
  private queue: string[] = []
  private runningId: string | null = null

  constructor(private readonly deps: DocTaskDeps) {}

  /**
   * Validate + enqueue a task. Throws friendly errors for the D26 guards (chat
   * streaming, no runtime) and for invalid requests; a queued/running task is reported
   * via `getDocTask` polling from then on.
   */
  startDocTask(req: StartDocTaskRequest): { jobId: string } {
    const kind = req?.kind as DocTaskKind
    if (kind !== 'summary' && kind !== 'translation' && kind !== 'compare') {
      throw new Error('Unknown document task.')
    }
    if (kind !== 'summary') {
      // The machine + IPC shapes are built for all three kinds; only summary ships in
      // Phase 33. Phases 34/35 replace this guard with their implementations.
      throw new Error(TASK_KIND_UNAVAILABLE_MESSAGE)
    }
    if (this.deps.isChatStreaming()) {
      throw new Error(TASK_REFUSED_CHAT_STREAMING_MESSAGE)
    }
    if (!this.deps.getRuntime()) {
      throw new Error(TASK_NEEDS_RUNTIME_MESSAGE)
    }
    const documentIds = (req.documentIds ?? []).filter((x) => typeof x === 'string' && x.length > 0)
    if (documentIds.length !== 1) {
      throw new Error('Pick exactly one document to summarize.')
    }
    const doc = getDocument(this.deps.getDb(), documentIds[0])
    if (!doc || doc.status !== 'indexed' || doc.chunkCount === 0) {
      throw new Error(TASK_DOCUMENT_NOT_READY_MESSAGE)
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
      controller: new AbortController()
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
      error: TASK_EXPIRED_MESSAGE,
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
  }

  /** True while a task is running or queued — the chat-side D26 guard reads this. */
  hasActiveTask(): boolean {
    return this.runningId !== null || this.queue.length > 0
  }

  /** True when an active (running/queued) task targets `documentId` — guards re-index/delete. */
  isDocumentBusy(documentId: string): boolean {
    const ids = [...(this.runningId ? [this.runningId] : []), ...this.queue]
    return ids.some((id) => this.tasks.get(id)?.status.documentIds.includes(documentId) ?? false)
  }

  /** Run the next queued task; tasks serialize among themselves (D26). */
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
    const documentId = task.status.documentIds[0]
    task.status.state = 'running'
    try {
      // Re-check at dequeue time: the runtime may have been stopped while queued.
      const runtime = this.deps.getRuntime()
      if (!runtime) throw new Error(TASK_NEEDS_RUNTIME_MESSAGE)
      await this.runSummary(task, runtime)
      task.status.state = 'done'
      task.status.resultRef = { documentId }
      this.deps.audit?.('document_task_completed', `Document task completed: ${kind}`, {
        kind,
        documentId
      })
      log.info('Document task completed', { jobId: task.status.jobId, kind, documentId })
    } catch (err) {
      if (isAbortError(err, task.controller.signal)) {
        task.status.state = 'cancelled'
        log.info('Document task cancelled', { jobId: task.status.jobId, kind, documentId })
        return
      }
      const raw = err instanceof Error ? err.message : String(err)
      // Friendly failures (§11.4): our own guard copy passes through; anything else
      // (runtime/HTTP/SQL errors) is replaced by the generic copy. The raw reason goes
      // to the local log only — never to the renderer, never to the audit log.
      task.status.state = 'failed'
      task.status.error = FRIENDLY_TASK_ERRORS.has(raw) ? raw : TASK_GENERIC_FAILURE_MESSAGE
      this.deps.audit?.('document_task_failed', `Document task failed: ${kind}`, {
        kind,
        documentId
      })
      log.error('Document task failed', { jobId: task.status.jobId, kind, documentId, error: raw })
    }
  }

  /** The Phase-33 summary task (D25): stored chunks in, `summary_json` out. */
  private async runSummary(task: InternalTask, runtime: ModelRuntime): Promise<void> {
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(TASK_DOCUMENT_NOT_READY_MESSAGE)

    // Input = the document's stored CHUNKS, in order (no re-parse — D25). Adjacent
    // chunks overlap by ~80 tokens (the chunker's retrieval overlap); the slight
    // repetition is harmless for summarization and accepted by the decision.
    const rows = db
      .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as unknown as Array<{ text: string }>
    const texts = rows.map((r) => r.text).filter((t) => t.trim().length > 0)
    if (texts.length === 0) throw new Error(TASK_DOCUMENT_NOT_READY_MESSAGE)

    const contextTokens = this.deps.getContextTokens()
    const plan = planSummaryWindows(texts, contextTokens)
    task.status.progress.stepsTotal = plan.stepsTotal
    const signal = task.controller.signal

    let summaryText: string
    if (plan.singlePass) {
      summaryText = await this.generate(
        runtime,
        singlePassPrompt(doc.title, plan.windows[0] ?? ''),
        SUMMARY_OUTPUT_TOKENS,
        signal
      )
      task.status.progress.stepsDone = 1
    } else {
      const partials: string[] = []
      for (let i = 0; i < plan.windows.length; i++) {
        const partial = await this.generate(
          runtime,
          mapPrompt(doc.title, i + 1, plan.windows.length, plan.windows[i]),
          plan.mapMaxTokens,
          signal
        )
        if (partial.length > 0) partials.push(partial)
        task.status.progress.stepsDone += 1
      }
      if (partials.length === 0) throw new Error(TASK_GENERIC_FAILURE_MESSAGE)
      // Belt for the reduce input: the map output caps already size partials to fit,
      // but a model that ignores maxTokens semantics must still not overflow.
      const budgetWords = summaryBudgetWords(contextTokens)
      let reduceInput = partials
      const totalWords = partials.reduce((n, p) => n + approxTokenCount(p), 0)
      if (totalWords > budgetWords) {
        const allWords = tokenize(partials.join('\n\n'))
        reduceInput = [allWords.slice(0, budgetWords).join(' ')]
      }
      summaryText = await this.generate(
        runtime,
        reducePrompt(doc.title, reduceInput),
        SUMMARY_OUTPUT_TOKENS,
        signal
      )
      task.status.progress.stepsDone += 1
    }

    if (summaryText.length === 0) throw new Error(TASK_GENERIC_FAILURE_MESSAGE)
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
  }

  /**
   * One model call over the locked Phase-3 streaming contract: explicit
   * maxTokens/temperature, NO depth mode, the task's own abort signal. Cancellation
   * must never persist a half summary — an abort throws instead of returning the
   * partial text (chat keeps partials; tasks do not).
   */
  private async generate(
    runtime: ModelRuntime,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
    let out = ''
    const stream = runtime.chatStream(messages, {
      signal,
      maxTokens,
      temperature: SUMMARY_TEMPERATURE
    })
    for await (const token of stream) {
      out += token
    }
    // The mock runtime returns cleanly on abort; the real one throws AbortError. Both
    // must land in the `cancelled` state, so normalize the clean return into a throw.
    if (signal.aborted) {
      throw new DOMException('Document task cancelled', 'AbortError')
    }
    return stripThinkBlocks(out).trim()
  }
}

/** Exact guard/validation copy that may pass through to the renderer on failure. */
const FRIENDLY_TASK_ERRORS: ReadonlySet<string> = new Set([
  TASK_NEEDS_RUNTIME_MESSAGE,
  TASK_REFUSED_CHAT_STREAMING_MESSAGE,
  TASK_KIND_UNAVAILABLE_MESSAGE,
  TASK_DOCUMENT_NOT_READY_MESSAGE,
  TASK_GENERIC_FAILURE_MESSAGE
])
