import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { ChatOptions, Conversation, Message } from '../../shared/types'
import {
  appendMessage,
  createConversation,
  deleteLastAssistantMessage,
  generateAssistantMessage,
  getConversation,
  listConversations,
  listMessages,
  maybeSetTitleFromFirstMessage
} from '../services/chat'
import { log } from '../services/logging'
import { inFlightStreams } from './inflight'

// Phase 3 IPC: conversation CRUD + streaming chat (spec §9.1, §7.6).
//
// Streaming contract (locked in BUILD_STATE §"Streaming contract"): tokens are
// pushed to the renderer over per-conversation event channels keyed by the
// conversation id — chat:token:<id> / chat:done:<id> / chat:error:<id>. The
// `sendChatMessage` invoke also resolves with the final assistant Message so a
// caller can simply await it. Cancellation: stopGeneration(id) aborts the in-flight
// AbortController; the partial reply is persisted and a normal `done` is emitted.
//
// Decision (documented): sendChatMessage does NOT auto-start a runtime. A chat
// needs an explicitly-started model (Models screen → "Start runtime"); with no
// active runtime it throws so the renderer can show the "start a model" empty state.
// Rationale: starting the real llama.cpp sidecar (Phase 10) is heavy and is an
// explicit user action — keeping it explicit keeps the service boundary clean.

export function registerChatIpc(ctx: AppContext): void {
  // Active stream cancellers (shared with the RAG path so stopGeneration cancels either).
  const inFlight = inFlightStreams

  ipcMain.handle(
    IPC.createConversation,
    (_e, opts?: { title?: string; mode?: 'chat' | 'documents' }): Conversation => {
      const conv = createConversation(ctx.db, {
        title: opts?.title,
        mode: opts?.mode,
        modelId: ctx.runtime.activeModelId()
      })
      log.info('Conversation created', { id: conv.id, mode: conv.mode })
      return conv
    }
  )

  ipcMain.handle(IPC.listConversations, (): Conversation[] => listConversations(ctx.db))

  ipcMain.handle(IPC.listMessages, (_e, conversationId: string): Message[] =>
    listMessages(ctx.db, conversationId)
  )

  ipcMain.handle(
    IPC.sendChatMessage,
    async (
      event: IpcMainInvokeEvent,
      conversationId: string,
      content: string,
      options?: ChatOptions
    ): Promise<Message> => {
      const conv = getConversation(ctx.db, conversationId)
      if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)

      const runtime = ctx.runtime.active()
      if (!runtime) {
        // No model loaded — surface a clear, recoverable error to the renderer.
        throw new Error('No model is running. Select and start a model on the Models screen first.')
      }

      const regenerate = options?.regenerate === true
      if (regenerate) {
        // Re-answer the last user turn: drop the previous assistant reply, keep history.
        deleteLastAssistantMessage(ctx.db, conversationId)
      } else {
        const text = content.trim()
        if (!text) throw new Error('Cannot send an empty message.')
        appendMessage(ctx.db, { conversationId, role: 'user', content: text })
        maybeSetTitleFromFirstMessage(ctx.db, conversationId, text)
      }

      const controller = new AbortController()
      inFlight.set(conversationId, controller)
      try {
        const assistant = await generateAssistantMessage(ctx.db, runtime, conversationId, {
          signal: controller.signal,
          onToken: (token) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send(STREAM.token(conversationId), token)
            }
          }
        })
        if (!event.sender.isDestroyed()) {
          event.sender.send(STREAM.done(conversationId), assistant)
        }
        return assistant
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('Chat generation failed', { conversationId, message })
        if (!event.sender.isDestroyed()) {
          event.sender.send(STREAM.error(conversationId), message)
        }
        throw err
      } finally {
        inFlight.delete(conversationId)
      }
    }
  )

  ipcMain.handle(IPC.stopGeneration, (_e, conversationId: string): void => {
    const controller = inFlight.get(conversationId)
    if (controller) {
      log.info('Stop generation', { conversationId })
      controller.abort()
    }
  })
}
