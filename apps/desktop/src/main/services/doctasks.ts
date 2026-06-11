import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Db } from './db'
import type {
  DocTaskKind,
  DocTaskStatus,
  DocumentOrigin,
  DocumentSummary,
  StartDocTaskRequest,
  TranslationTargetLang
} from '../../shared/types'
import type { ChatMessage, ModelRuntime } from './runtime'
import { approxTokenCount, tokenize } from './ingestion/chunker'
import {
  createQueuedDocument,
  deleteDocument,
  extractDocumentPreview,
  getDocument,
  processDocument,
  setDocumentOrigin,
  setDocumentSummary,
  type IngestionDeps
} from './ingestion'
import { shredFile } from './workspace-vault'
import { isAbortError, stripThinkBlocks } from './chat'
import type { AuditRecorder } from './audit'
import { log } from './logging'

// Document task service (Phase 33/34, wave-3 plan §6/§7) — the shared engine for
// summary (Phase 33), translation (Phase 34), and compare (Phase 35): a job state
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
// password change mutually exclusive). A TRANSLATION task is the inverse: its
// materialize step writes a `.enc` sidecar through the normal import path, so that
// step — and ONLY that step — holds the lease. The long window-by-window translation
// loop runs lease-free so a password change is never blocked for minutes; a change
// landing mid-loop just makes the final materialize fail friendly (VaultBusyError).
//
// Privacy: summaries and translations are CONTENT. They are persisted only in the
// (possibly encrypted) workspace — `documents.summary_json` / the materialized `.enc`
// document — and the audit events carry `{ kind, documentId }` only.

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
export const TASK_TRANSLATION_TARGET_MESSAGE =
  'Choose a translation language: German or English.'
export const TASK_SOURCE_UNREADABLE_MESSAGE =
  'The stored copy of this document could not be read. Re-import the document, then try again.'

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
/**
 * Pack texts greedily, in order, into windows of at most `budgetWords` words. A single
 * over-budget text is SPLIT into budget-sized pieces rather than truncated — no text is
 * silently dropped by packing. Shared by the summary (chunks in) and translation
 * (segments in) planners.
 */
function packIntoWindows(texts: string[], budgetWords: number): string[] {
  // Split any over-budget text into budget-sized pieces (document order kept).
  const pieces: Array<{ text: string; words: number }> = []
  for (const text of texts) {
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
  return windows
}

export function planSummaryWindows(chunkTexts: string[], contextTokens: number): SummaryPlan {
  const budgetWords = summaryBudgetWords(contextTokens)
  const windows = packIntoWindows(chunkTexts, budgetWords)

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

// ---- Translation window math + templates (Phase 34, D36 + R-T2) ----------------------
//
// D36 (translation input): translate the parser's SEGMENTS, re-extracted from the
// stored copy via `extractDocumentPreview` — NOT the stored chunks. Chunks overlap by
// ~80 tokens (the retrieval overlap); naive in-order chunk concatenation would
// DUPLICATE text at every boundary in the translated output. A summary tolerates that
// repetition (D25 accepted it); a faithful translation cannot. The segments are
// ordered, non-overlapping, and exact; the cost is one re-parse of the stored copy —
// the same cost the in-app preview already pays, on the same code path (encrypted
// copies decrypt to a `.parse*` transient and are shredded inside). The alternative —
// trimming the overlap out of adjacent chunks — was rejected as fragile: chunk text is
// whitespace-normalized at the token level, so overlap-matching is heuristic where the
// re-parse is exact.
//
// Window sizing: unlike a summary (long in, short out), a translation's OUTPUT is
// roughly as long as its input — and in TOKENS it is heavier than the input estimate:
// the R-T2 smoke (plan §14) measured German output at ~2 real tokens per source word
// (subword-heavy compounds), and an early half-input/half-output split TRUNCATED a
// near-budget window mid-sentence when its German output hit the cap. The usable
// context is therefore split by measured weight: input claims 1.3 tokens/word
// (the D25 safety factor), output claims 2.0 — i.e. a window's input budget is
// usable/(1.3+2.0) words and the rest of the context is output headroom. There is NO
// window ceiling: a faithful translation may not silently truncate the document (the
// summary ceiling exists because a summary may honestly cover "the beginning"; a
// translation may not). Long documents simply take more windows — progress is visible
// and cancel always works.

/** Reserved for the instruction template + chat chrome, in model tokens. */
export const TRANSLATION_PROMPT_RESERVE_TOKENS = 300
/**
 * Estimated OUTPUT tokens per source word for DE↔EN (measured on the real pinned
 * b9585 + Qwen3-4B by the R-T2 smoke — German output is subword-heavy; 1.3× headroom
 * truncated a near-budget window, 2.0× leaves ~40% margin over the worst measurement).
 */
export const TRANSLATION_OUTPUT_TOKENS_PER_WORD = 2.0
/** Very low temperature: translation should be literal, not creative (R-T2). */
export const TRANSLATION_TEMPERATURE = 0.2
/** Floor for a window's output cap (degenerate tiny contexts). */
const TRANSLATION_MIN_OUTPUT_TOKENS = 256
/** Floor for the per-window input budget, in words. */
const TRANSLATION_MIN_BUDGET_WORDS = 120

/** Usable model tokens for a translation call after the prompt reserve. */
function translationUsableTokens(contextTokens: number): number {
  const ctx = Math.max(1024, Math.floor(contextTokens) || 0)
  return ctx - TRANSLATION_PROMPT_RESERVE_TOKENS
}

/** The per-window INPUT budget in WORDS (the input's share of the usable context). */
export function translationBudgetWords(contextTokens: number): number {
  return Math.max(
    TRANSLATION_MIN_BUDGET_WORDS,
    Math.floor(
      translationUsableTokens(contextTokens) /
        (SUMMARY_TOKENS_PER_WORD + TRANSLATION_OUTPUT_TOKENS_PER_WORD)
    )
  )
}

export interface TranslationPlan {
  /** Window texts, in document order (segments packed; over-budget segments split). */
  windows: string[]
  /** Output cap per window call: everything the input share leaves free. */
  windowMaxTokens: number
  /** Model calls (windows) + the final materialize step. */
  stepsTotal: number
}

/**
 * Plan the translation windows for a document's re-extracted SEGMENT texts (pure —
 * unit-tested at the boundaries). No ceiling and no reduce: every window is translated
 * in document order and concatenated.
 */
export function planTranslationWindows(
  segmentTexts: string[],
  contextTokens: number
): TranslationPlan {
  const usable = translationUsableTokens(contextTokens)
  const budgetWords = translationBudgetWords(contextTokens)
  const windows = packIntoWindows(segmentTexts, budgetWords)
  // Output headroom = the usable tokens the input share cannot consume — ≈2.0× the
  // input words by construction (TRANSLATION_OUTPUT_TOKENS_PER_WORD, R-T2-measured).
  const windowMaxTokens = Math.max(
    TRANSLATION_MIN_OUTPUT_TOKENS,
    usable - Math.ceil(budgetWords * SUMMARY_TOKENS_PER_WORD)
  )
  return { windows, windowMaxTokens, stepsTotal: windows.length + 1 }
}

const TARGET_LANG_NAME: Record<TranslationTargetLang, string> = {
  de: 'German',
  en: 'English'
}

/** The display label used in the materialized document's title. */
export const TARGET_LANG_TITLE_LABEL: Record<TranslationTargetLang, string> = {
  de: 'Deutsch',
  en: 'English'
}

/**
 * Strict translator instructions (R-T2-informed): translate, don't summarize; keep
 * the Markdown structure; numbers/names/dates verbatim; output only the translation
 * (the 4B-class models otherwise prepend "Here is the translation:" chatter).
 */
export function translationSystemPrompt(targetLang: TranslationTargetLang): string {
  const lang = TARGET_LANG_NAME[targetLang]
  return (
    `You are a professional translator working fully offline. Translate the user's text into ${lang}. ` +
    'Translate faithfully and completely — never summarize, shorten, or add anything. ' +
    'Preserve the Markdown structure: headings, lists, tables, and emphasis stay as they are. ' +
    'Keep numbers, dates, names, and codes exactly as written. ' +
    'Reply with ONLY the translation — no introduction, no notes, no explanations.'
  )
}

export function translationWindowPrompt(
  targetLang: TranslationTargetLang,
  part: number,
  total: number,
  text: string
): string {
  const lang = TARGET_LANG_NAME[targetLang]
  const partNote =
    total > 1 ? ` This is part ${part} of ${total} of a longer document; translate just this part.` : ''
  return (
    `Translate the following text into ${lang}.${partNote} ` +
    'Translate everything, keep numbers, names, and dates verbatim, and reply with only the translation.\n\n' +
    `Text:\n${text}`
  )
}

/**
 * Visible marker for a window the model refused/garbled after a retry (plan §7
 * honesty requirement, §11.4 copy): the output keeps the ORIGINAL text under the
 * notice — never a silent gap.
 */
export function failedWindowNotice(part: number, total: number): string {
  return (
    `> ⚠ This part (${part} of ${total}) could not be translated — ` +
    'the original text is kept below unchanged.'
  )
}

/** The honesty attribution prepended to every materialized translation (plan §7). */
export function translationAttributionLine(modelId: string): string {
  return `Machine-translated by ${modelId} — may contain errors.`
}

/** "report.pdf" + de → "report (Deutsch).md" (the materialized doc is Markdown). */
export function translatedDocumentTitle(
  sourceTitle: string,
  targetLang: TranslationTargetLang
): string {
  const ext = extname(sourceTitle)
  const base = (ext ? sourceTitle.slice(0, -ext.length) : sourceTitle).trim() || 'document'
  return `${base} (${TARGET_LANG_TITLE_LABEL[targetLang]}).md`
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
  /** `workspace/documents/` — where materialized documents (and their transients) live. */
  getStoreDir: () => string
  /** Ingestion deps (embedder + document cipher) for the materialize/import step. */
  getIngestionDeps: () => IngestionDeps
  /**
   * The Phase-32 vault lease (`WorkspaceController.beginDocumentWork`). Held ONLY
   * around the materialize step (it writes `.enc` sidecars); throws the friendly
   * `VaultBusyError` while a password change runs.
   */
  beginDocumentWork: () => () => void
  audit?: AuditRecorder
}

interface InternalTask {
  status: DocTaskStatus
  controller: AbortController
  /** Validated translation target (kind === 'translation' only). */
  targetLang?: TranslationTargetLang
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
    if (kind === 'compare') {
      // The machine + IPC shapes are built for all three kinds; compare ships in
      // Phase 35 and replaces this guard with its implementation.
      throw new Error(TASK_KIND_UNAVAILABLE_MESSAGE)
    }
    // Translation targets are a closed v1 set (plan §7): de | en only — a free-text
    // language field invites silent quality failures.
    let targetLang: TranslationTargetLang | undefined
    if (kind === 'translation') {
      const raw = req.params?.targetLang
      if (raw !== 'de' && raw !== 'en') {
        throw new Error(TASK_TRANSLATION_TARGET_MESSAGE)
      }
      targetLang = raw
    }
    if (this.deps.isChatStreaming()) {
      throw new Error(TASK_REFUSED_CHAT_STREAMING_MESSAGE)
    }
    if (!this.deps.getRuntime()) {
      throw new Error(TASK_NEEDS_RUNTIME_MESSAGE)
    }
    const documentIds = (req.documentIds ?? []).filter((x) => typeof x === 'string' && x.length > 0)
    if (documentIds.length !== 1) {
      throw new Error(
        kind === 'translation'
          ? 'Pick exactly one document to translate.'
          : 'Pick exactly one document to summarize.'
      )
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
      controller: new AbortController(),
      targetLang
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
    // The SOURCE document id — the audit events carry this one; a translation's OUTPUT
    // id travels in `resultRef` (and is appended to `documentIds` for the busy guard).
    const documentId = task.status.documentIds[0]
    task.status.state = 'running'
    try {
      // Re-check at dequeue time: the runtime may have been stopped while queued.
      const runtime = this.deps.getRuntime()
      if (!runtime) throw new Error(TASK_NEEDS_RUNTIME_MESSAGE)
      const resultId =
        kind === 'translation'
          ? await this.runTranslation(task, runtime)
          : await this.runSummary(task, runtime)
      task.status.state = 'done'
      task.status.resultRef = { documentId: resultId }
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
      // Friendly failures (§11.4): our own guard copy passes through (as does the
      // vault lease's VaultBusyError — its message is written for users); anything
      // else (runtime/HTTP/SQL errors) is replaced by the generic copy. The raw reason
      // goes to the local log only — never to the renderer, never to the audit log.
      const friendly =
        FRIENDLY_TASK_ERRORS.has(raw) || (err instanceof Error && err.name === 'VaultBusyError')
      task.status.state = 'failed'
      task.status.error = friendly ? raw : TASK_GENERIC_FAILURE_MESSAGE
      this.deps.audit?.('document_task_failed', `Document task failed: ${kind}`, {
        kind,
        documentId
      })
      log.error('Document task failed', { jobId: task.status.jobId, kind, documentId, error: raw })
    }
  }

  /** The Phase-33 summary task (D25): stored chunks in, `summary_json` out. */
  private async runSummary(task: InternalTask, runtime: ModelRuntime): Promise<string> {
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
        SUMMARY_SYSTEM_PROMPT,
        reducePrompt(doc.title, reduceInput),
        SUMMARY_OUTPUT_TOKENS,
        SUMMARY_TEMPERATURE,
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
    return documentId
  }

  /**
   * The Phase-34 translation task (D27/D36): re-extracted parser SEGMENTS in,
   * window-by-window translation in document order (no reduce), one NEW materialized
   * Markdown document out. Returns the new document's id (the `resultRef`).
   */
  private async runTranslation(task: InternalTask, runtime: ModelRuntime): Promise<string> {
    const db = this.deps.getDb()
    const documentId = task.status.documentIds[0]
    const targetLang = task.targetLang
    if (!targetLang) throw new Error(TASK_TRANSLATION_TARGET_MESSAGE)
    const doc = getDocument(db, documentId)
    if (!doc) throw new Error(TASK_DOCUMENT_NOT_READY_MESSAGE)

    // D36: the input is the parser's SEGMENTS re-extracted from the stored copy —
    // ordered and non-overlapping (see the module note above; stored chunks would
    // duplicate their ~80-token overlap into the translation). Encrypted copies
    // decrypt to a `.parse*` transient inside and are shredded on the way out.
    let segmentTexts: string[]
    try {
      const preview = await extractDocumentPreview(db, this.deps.getStoreDir(), documentId, {
        cipher: this.deps.getIngestionDeps().cipher ?? null
      })
      segmentTexts = preview.segments.map((s) => s.text).filter((t) => t.trim().length > 0)
    } catch (err) {
      log.warn('Translation source re-extraction failed', {
        documentId,
        error: err instanceof Error ? err.message : String(err)
      })
      throw new Error(TASK_SOURCE_UNREADABLE_MESSAGE)
    }
    if (segmentTexts.length === 0) throw new Error(TASK_DOCUMENT_NOT_READY_MESSAGE)

    const plan = planTranslationWindows(segmentTexts, this.deps.getContextTokens())
    task.status.progress.stepsTotal = plan.stepsTotal
    const signal = task.controller.signal

    // Map in document order — no reduce. A window the model refuses/garbles is
    // retried ONCE (R-T2 policy), then MARKED visibly with the original text kept;
    // it is never silently dropped. Only a fully-failed translation fails the task.
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
    if (failedWindows === plan.windows.length) throw new Error(TASK_GENERIC_FAILURE_MESSAGE)

    // Materialize ONLY now that every window succeeded (or is honestly marked) — a
    // cancelled task persists nothing, so the last cancellation point is here.
    if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
    const markdown = `> ${translationAttributionLine(runtime.modelId)}\n\n${parts.join('\n\n')}\n`
    const newDocId = await this.materializeDocument(
      task,
      markdown,
      translatedDocumentTitle(doc.title, targetLang),
      { translatedFrom: documentId, targetLang }
    )
    task.status.progress.stepsDone += 1
    return newDocId
  }

  /**
   * Write the generated Markdown to a transient file and run it through the NORMAL
   * import path (`createQueuedDocument` + `processDocument`) so the new document is
   * chunked, embedded, searchable, citable, and `.enc`-encrypted automatically (D27).
   * Holds the Phase-32 vault lease for exactly this step — it writes `.enc` sidecars
   * (`VaultBusyError` from a concurrent password change propagates as a friendly task
   * failure). The transient uses the `.parse` infix so the startup crash sweep shreds
   * it if we die mid-step; otherwise it is shredded here, success or failure.
   */
  private async materializeDocument(
    task: InternalTask,
    markdown: string,
    title: string,
    origin: DocumentOrigin
  ): Promise<string> {
    const release = this.deps.beginDocumentWork()
    const db = this.deps.getDb()
    const storeDir = this.deps.getStoreDir()
    const tempPath = join(storeDir, `${task.status.jobId}.parse.md`)
    let newDocId: string | null = null
    try {
      writeFileSync(tempPath, markdown, 'utf8')
      const info = createQueuedDocument(db, tempPath, title)
      newDocId = info.id
      // The output document is born inside the task — OUTSIDE registerDocsIpc's
      // `processing` set — so list it on the task: `isDocumentBusy` then covers it
      // and it cannot be deleted/re-indexed mid-materialize.
      task.status.documentIds.push(info.id)
      const result = await processDocument(db, storeDir, info.id, this.deps.getIngestionDeps())
      if (result.status !== 'indexed') {
        // processDocument never throws — but a translation must fully succeed or
        // persist nothing, so a failed import removes the half-born row again.
        log.error('Materialized translation failed to import', {
          jobId: task.status.jobId,
          status: result.status,
          error: result.errorMessage
        })
        throw new Error(TASK_GENERIC_FAILURE_MESSAGE)
      }
      setDocumentOrigin(db, info.id, origin)
      // A new corpus document must never appear without an audit trail (Phase 19;
      // filename + id only — the translated text is content).
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
   * One translation window with the R-T2 retry policy: a failed or empty generation
   * is retried once; a second failure returns null (the caller marks the window).
   * Aborts always propagate immediately — cancel must never look like a failed window.
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
   * One model call over the locked Phase-3 streaming contract: explicit
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
  TASK_GENERIC_FAILURE_MESSAGE,
  TASK_TRANSLATION_TARGET_MESSAGE,
  TASK_SOURCE_UNREADABLE_MESSAGE
])
