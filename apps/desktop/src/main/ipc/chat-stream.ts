import type { IpcMainInvokeEvent } from 'electron'
import { STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { DOC_TASK_BUSY_MESSAGE, type Conversation, type Message } from '../../shared/types'
import { getConversation } from '../services/chat'
import type { ModelRuntime } from '../services/runtime'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { inFlightStreams } from './inflight'

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
export function assertChatStreamReady(
  ctx: AppContext,
  conversationId: string
): { conv: Conversation; runtime: ModelRuntime } {
  const conv = getConversation(ctx.db, conversationId)
  if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)

  const runtime = ctx.runtime.active()
  if (!runtime) {
    // Ephemeral IPC guard → tMain (i18n record §3.3); DOC_TASK_BUSY_MESSAGE stays
    // canonical English on the wire (renderer exact-match + display map).
    throw new Error(tMain('main.noModelRunning'))
  }
  // Strict one-at-a-time vs document tasks: the one local model serves either a chat
  // answer or a task, never both.
  if (ctx.docTasks?.hasActiveTask()) {
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

/**
 * Run a streaming generation under the LOCKED streaming contract: register an
 * AbortController in the shared in-flight registry, run `runFn` (handed the abort signal
 * and a guarded token sender), emit `chat:done:<id>` with the final Message on success or
 * `chat:error:<id>` (+ log under `logLabel`) on failure, and always clear our own registry
 * entry. Returns the final assistant Message so the invoke can resolve with it.
 */
export async function withChatStream(
  event: IpcMainInvokeEvent,
  conversationId: string,
  logLabel: string,
  runFn: (signal: AbortSignal, sendToken: SendToken) => Promise<Message>
): Promise<Message> {
  const controller = new AbortController()
  inFlightStreams.set(conversationId, controller)
  const sendToken: SendToken = (token) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.token(conversationId), token)
    }
  }
  try {
    const assistant = await runFn(controller.signal, sendToken)
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.done(conversationId), assistant)
    }
    return assistant
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(logLabel, { conversationId, message })
    if (!event.sender.isDestroyed()) {
      event.sender.send(STREAM.error(conversationId), message)
    }
    throw err
  } finally {
    // Only clear our own entry — a later stream may already own this key.
    if (inFlightStreams.get(conversationId) === controller) inFlightStreams.delete(conversationId)
  }
}
