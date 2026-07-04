import type { IpcMainInvokeEvent } from 'electron'
import { STREAM, type CompactionNotice } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import {
  DOC_TASK_BUSY_MESSAGE,
  type ContextUsage,
  type Conversation,
  type Message
} from '../../shared/types'
import {
  deleteLastAssistantMessage,
  emptyAssistantMessage,
  getConversation,
  isAbortError,
  restoreMessage
} from '../services/chat'
import type { Db } from '../services/db'
import type { ModelRuntime } from '../services/runtime'
import { isExceedContextError } from '../services/runtime/llama'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { inFlightStreams, streamBuffers, streamSettled } from './inflight'

// M-A2 (audit-2026-06-13): the plain-chat (`sendChatMessage`) and RAG (`askDocuments`)
// handlers duplicated the entire stream lifecycle verbatim — the guard preamble plus the
// AbortController / inFlight registration / token-send-with-`isDestroyed`-guard /
// done-error-finally dance. That is the most safety-sensitive path in the app, and two
// hand-kept copies invite drift. These helpers are the single owner.

/**
 * Shared guard preamble: the conversation must exist, a runtime must be active, no doc
 * task may be running, and no stream may already be in flight for this conversation.
 * Throws the same friendly/ephemeral errors both handlers used. Returns the looked-up
 * conversation + the active runtime so the caller can proceed.
 */
export async function assertChatStreamReady(
  ctx: AppContext,
  conversationId: string
): Promise<{ conv: Conversation; runtime: ModelRuntime }> {
  const conv = getConversation(ctx.db, conversationId)
  if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)

  const runtime = ctx.runtime.active()
  if (!runtime) {
    // Ephemeral IPC guard → tMain (i18n record §3.3); DOC_TASK_BUSY_MESSAGE stays
    // canonical English on the wire (renderer exact-match + display map).
    throw new Error(tMain('main.noModelRunning'))
  }
  // Strict one-at-a-time vs document tasks: the one local model serves either a chat
  // answer or a task, never both. A YIELDING deep-index build is the exception — it cedes
  // the slot (chat pauses it via the model-slot arbiter inside `withChatStream`, then it
  // resumes in-session). Any OTHER active task (summary/translate/compare/ocr, or a tree
  // build that is only queued, not yet holding the slot) still refuses chat (plan §4.1/H10).
  if (ctx.docTasks?.hasActiveTask() && !ctx.docTasks.isYieldingBuildActive()) {
    throw new Error(DOC_TASK_BUSY_MESSAGE)
  }
  // One active stream per conversation (shared registry across plain chat + RAG).
  if (inFlightStreams.has(conversationId)) {
    throw new Error(tMain('main.chat.streamInFlight'))
  }
  return { conv, runtime }
}

/** A guarded token sender: a no-op once the renderer is gone (window closed mid-stream). */
export type SendToken = (token: string) => void
/** A guarded reasoning-delta sender (Deep mode); buffers like `SendToken`. */
export type SendReasoning = (delta: string) => void
/**
 * A guarded one-shot ephemeral notifier (context-compaction plan §5.2). Fired from the compaction
 * pre-pass's `onStart` (default `'compaction'` → "summarizing earlier messages…"), and reused by U5
 * for `'analysis'` → an exhaustive skill handler starting a long extraction ("reading the document…").
 * Unlike the token/reasoning senders it is EPHEMERAL (R14): never buffered into `streamBuffers`, so a
 * screen that remounts mid-stream simply misses the transient hint — acceptable, the answer still streams.
 */
export type SendCompaction = (kind?: CompactionNotice['kind']) => void
/**
 * A guarded one-shot sender for the REAL assembled-prompt context usage of the in-flight turn
 * (meter honesty): fired right after prompt assembly so the composer meter reflects what the
 * model actually received — including a document turn's injected excerpt/whole-document block,
 * which the renderer-side word estimate cannot see. EPHEMERAL like `SendCompaction` (R14):
 * never buffered; a remount misses it and the meter falls back to the resting estimate.
 */
export type SendUsage = (usage: ContextUsage) => void

/** The generation body run under the locked streaming contract — handed the turn's abort signal
 *  and the guarded senders, resolving with the persisted assistant Message. */
export type ChatStreamRunFn = (
  signal: AbortSignal,
  sendToken: SendToken,
  sendReasoning: SendReasoning,
  sendCompaction: SendCompaction,
  sendUsage: SendUsage
) => Promise<Message>

/**
 * F2 (post-merge audit) — make a regenerate turn's destructive delete safe. The previous
 * assistant reply must NOT be dropped until the stream slot is held: the old ordering committed
 * the delete (node:sqlite is synchronous) before `withChatStream` claimed the slot, so a
 * non-abort failure between the delete and the first persisted token — `acquireSlot` rejecting,
 * a sidecar that died mid-session, or (most reachably) an `exceed_context_size_error` HTTP 400
 * because regenerate replays the full history near the window — destroyed the prior answer with
 * nothing in its place.
 *
 * This wraps a `runFn` so the delete runs INSIDE the stream (slot held, controller registered)
 * and the snapshot is RESTORED if generation fails for a NON-abort reason. A user Stop (abort)
 * keeps the delete: the new partial/empty reply stands, exactly as before. A no-op passthrough
 * when `regenerate` is false — the only change is WHEN the regenerate delete runs. The caller is
 * expected to have already bailed (read-only `hasRegenerableAssistantReply`) when there is no
 * prior reply; the snapshot being null here is a benign race (nothing deleted, nothing to
 * restore).
 */
export function withRegenerateGuard(
  db: Db,
  conversationId: string,
  regenerate: boolean,
  runFn: ChatStreamRunFn
): ChatStreamRunFn {
  if (!regenerate) return runFn
  return async (signal, sendToken, sendReasoning, sendCompaction, sendUsage) => {
    const deleted = deleteLastAssistantMessage(db, conversationId)
    try {
      return await runFn(signal, sendToken, sendReasoning, sendCompaction, sendUsage)
    } catch (err) {
      // Restore the prior reply only on a real failure; a user Stop (abort) keeps the delete.
      if (deleted && !isAbortError(err, signal)) restoreMessage(db, deleted)
      throw err
    }
  }
}

/**
 * Run a streaming generation under the LOCKED streaming contract: register an
 * AbortController in the shared in-flight registry, run `runFn` (handed the abort signal,
 * a guarded token sender, and a guarded reasoning sender), emit `chat:done:<id>` with the
 * final Message on success or `chat:error:<id>` (+ log under `logLabel`) on failure, and
 * always clear our own registry entry. Returns the final assistant Message so the invoke
 * can resolve with it.
 *
 * Both senders also append to the shared `streamBuffers` snapshot, so a Chat screen that
 * unmounted mid-stream (navigated away) can recover the in-progress reply on remount via
 * the `getActiveStream` IPC instead of seeing an idle screen that still rejects new turns.
 */
export async function withChatStream(
  event: IpcMainInvokeEvent,
  conversationId: string,
  logLabel: string,
  runFn: ChatStreamRunFn,
  /**
   * Optional model-slot claim (plan §4.1/H10): when a yielding deep-index build holds the
   * one chat runtime, this requests a pause and resolves once the builder parks (≈ one
   * node), returning a release fn that resumes the build. Called AFTER the in-flight entry
   * is registered and ALWAYS released in `finally`, so a build can never be left paused by
   * a failed/aborted chat turn. With no build active it resolves to a no-op immediately.
   * Receives the turn's abort `signal` (REL-3) so a "Stop" while parked unwinds at once.
   */
  acquireSlot?: (signal: AbortSignal) => Promise<() => void>
): Promise<Message> {
  const controller = new AbortController()
  inFlightStreams.set(conversationId, controller)
  streamBuffers.set(conversationId, { content: '', reasoning: '' })
  // R1: publish a "settled" promise the lock/quit teardown can await so a partial reply
  // persists BEFORE the DB closes. Resolved (never rejected) in the `finally` below, AFTER
  // `runFn` (and thus its abort-driven `appendMessage`) has fully unwound.
  let markSettled: () => void = () => {}
  streamSettled.set(
    conversationId,
    new Promise<void>((resolve) => {
      markSettled = resolve
    })
  )
  let releaseSlot: () => void = () => {}
  const sendToken: SendToken = (token) => {
    const buf = streamBuffers.get(conversationId)
    if (buf) buf.content += token
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.token(conversationId), token)
    }
  }
  const sendReasoning: SendReasoning = (delta) => {
    const buf = streamBuffers.get(conversationId)
    if (buf) buf.reasoning += delta
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.reasoning(conversationId), delta)
    }
  }
  // One-shot, EPHEMERAL (R14): no `streamBuffers` write, isDestroyed-guarded like the senders. A bare
  // call keeps the original `{ phase: 'start' }` payload byte-for-byte (compaction); an explicit
  // `'analysis'` kind rides the same channel for the U5 exhaustive-handler notice.
  const sendCompaction: SendCompaction = (kind) => {
    if (!event.sender.isDestroyed()) {
      const notice: CompactionNotice = kind ? { phase: 'start', kind } : { phase: 'start' }
      event.sender.send(STREAM.compaction(conversationId), notice)
    }
  }
  // The real assembled-prompt usage for the meter (fired once, post-assembly). EPHEMERAL (R14):
  // no `streamBuffers` write, isDestroyed-guarded — a remounted screen simply falls back to the
  // resting estimate until the turn settles.
  const sendUsage: SendUsage = (usage) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.usage(conversationId), usage)
    }
  }
  try {
    // Hand the model slot off from a yielding build before any model call (no-op when none).
    // The abort signal is threaded in (REL-3) so a Stop while parked waiting for the build's
    // handoff rejects this acquire instead of blocking for up to one tree-node summarization.
    if (acquireSlot) releaseSlot = await acquireSlot(controller.signal)
    const assistant = await runFn(controller.signal, sendToken, sendReasoning, sendCompaction, sendUsage)
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.done(conversationId), assistant)
    }
    return assistant
  } catch (err) {
    // REL-3: a user Stop that landed while we were waiting to acquire the slot rejects the
    // acquire BEFORE generation began. That is a clean cancellation, not a failure: resolve
    // exactly like an in-generation Stop that produced no token — emit `done` with an empty
    // message, never `chat:error` (the renderer surfaces a toast on any invoke rejection).
    // An in-generation Stop never reaches here (generateAssistantMessage swallows the abort
    // and returns the partial); this only fires for a Stop during the pre-generation park.
    if (controller.signal.aborted) {
      const assistant = emptyAssistantMessage(conversationId)
      if (!event.sender.isDestroyed()) {
        event.sender.send(STREAM.done(conversationId), assistant)
      }
      return assistant
    }
    const raw = err instanceof Error ? err.message : String(err)
    // A grounded/chat answer whose prompt overflows the model is an HTTP 400; show the
    // actionable "too large for this model" copy to the user (the raw reason still goes to
    // the local log).
    const overflow = isExceedContextError(err)
    const message = overflow ? tMain('main.model.contextExceeded') : raw
    log.error(logLabel, { conversationId, message: raw })
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.error(conversationId), message)
    }
    // Reject the invoke with the SAME friendly text the stream channel carries: the
    // renderer surfaces the invoke REJECTION (not the chat:error event), so a raw rethrow
    // here is what leaked the unmapped "ChatRequestError: HTTP 400 …" string to users. For
    // any other failure (incl. aborts) rethrow the original error untouched so its type and
    // message are preserved upstream.
    throw overflow ? new Error(message) : err
  } finally {
    // Resume any paused deep-index build first (idempotent; no-op when none was paused).
    releaseSlot()
    // Only clear our own entry — a later stream may already own this key. The buffer is
    // cleared in lockstep so `getActiveStream` reports "done" the instant the stream ends.
    if (inFlightStreams.get(conversationId) === controller) {
      inFlightStreams.delete(conversationId)
      streamBuffers.delete(conversationId)
      streamSettled.delete(conversationId)
    }
    // R1: signal this stream has fully unwound (its partial — if any — is persisted). A
    // lock/quit teardown awaiting the settled promise can now safely close the DB. Resolve
    // unconditionally and last, after the entry is cleared.
    markSettled()
  }
}
