import type { IpcMainInvokeEvent } from 'electron'
import { STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { DOC_TASK_BUSY_MESSAGE, type Conversation, type Message } from '../../shared/types'
import { getConversation } from '../services/chat'
import type { ModelRuntime } from '../services/runtime'
import { isExceedContextError } from '../services/runtime/llama'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { inFlightStreams, streamBuffers } from './inflight'

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
  runFn: (signal: AbortSignal, sendToken: SendToken, sendReasoning: SendReasoning) => Promise<Message>,
  /**
   * Optional model-slot claim (plan §4.1/H10): when a yielding deep-index build holds the
   * one chat runtime, this requests a pause and resolves once the builder parks (≈ one
   * node), returning a release fn that resumes the build. Called AFTER the in-flight entry
   * is registered and ALWAYS released in `finally`, so a build can never be left paused by
   * a failed/aborted chat turn. With no build active it resolves to a no-op immediately.
   */
  acquireSlot?: () => Promise<() => void>
): Promise<Message> {
  const controller = new AbortController()
  inFlightStreams.set(conversationId, controller)
  streamBuffers.set(conversationId, { content: '', reasoning: '' })
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
  try {
    // Hand the model slot off from a yielding build before any model call (no-op when none).
    if (acquireSlot) releaseSlot = await acquireSlot()
    const assistant = await runFn(controller.signal, sendToken, sendReasoning)
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.done(conversationId), assistant)
    }
    return assistant
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // A grounded answer whose retrieved context overflows the model is an HTTP 400; show
    // the actionable "too large for this model" copy to the user (the raw reason still
    // goes to the local log).
    const message = isExceedContextError(err) ? tMain('main.model.contextExceeded') : raw
    log.error(logLabel, { conversationId, message: raw })
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.error(conversationId), message)
    }
    throw err
  } finally {
    // Resume any paused deep-index build first (idempotent; no-op when none was paused).
    releaseSlot()
    // Only clear our own entry — a later stream may already own this key. The buffer is
    // cleared in lockstep so `getActiveStream` reports "done" the instant the stream ends.
    if (inFlightStreams.get(conversationId) === controller) {
      inFlightStreams.delete(conversationId)
      streamBuffers.delete(conversationId)
    }
  }
}
