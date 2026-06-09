import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { Message } from '../../shared/types'
import { appendMessage, getConversation, maybeSetTitleFromFirstMessage } from '../services/chat'
import { generateGroundedAnswer, ragSettingsFrom } from '../services/rag'
import { getSettings } from '../services/settings'
import { log } from '../services/logging'
import { inFlightStreams } from './inflight'

// Phase 6 IPC: RAG chat with citations (spec §9.1, §7.8, Milestone 6).
//
// `askDocuments(conversationId, question)` is the document-grounded sibling of
// `sendChatMessage`. It REUSES the locked Phase-3 streaming contract — tokens go out on
// `chat:token/done/error:<conversationId>` and the invoke resolves with the final
// assistant Message — so the renderer subscribes exactly as it does for plain chat.
//
// Differences from sendChatMessage: the answer is grounded in retrieved document chunks
// and the assistant turn is persisted WITH citations (→ messages.citations_json). When no
// usable context is retrieved, a fixed "not found in your documents" answer is returned
// without calling the model (grounding rule, spec §7.8). Cancellation reuses the shared
// in-flight registry, so `stopGeneration(conversationId)` cancels a document answer too.
//
// Like sendChatMessage, this does NOT auto-start a runtime — a model must be started on
// the Models screen first; with none active the handler throws so the renderer can show
// the "start a model" empty state.

export function registerRagIpc(ctx: AppContext): void {
  ipcMain.handle(
    IPC.askDocuments,
    async (event: IpcMainInvokeEvent, conversationId: string, question: string): Promise<Message> => {
      const conv = getConversation(ctx.db, conversationId)
      if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)

      const runtime = ctx.runtime.active()
      if (!runtime) {
        throw new Error('No model is running. Select and start a model on the Models screen first.')
      }

      const text = question.trim()
      if (!text) throw new Error('Cannot send an empty question.')
      appendMessage(ctx.db, { conversationId, role: 'user', content: text })
      maybeSetTitleFromFirstMessage(ctx.db, conversationId, text)

      const settings = ragSettingsFrom(getSettings(ctx.db))
      const controller = new AbortController()
      inFlightStreams.set(conversationId, controller)
      try {
        const assistant = await generateGroundedAnswer(
          ctx.db,
          runtime,
          ctx.embedder,
          conversationId,
          text,
          settings,
          {
            signal: controller.signal,
            onToken: (token) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send(STREAM.token(conversationId), token)
              }
            }
          }
        )
        if (!event.sender.isDestroyed()) {
          event.sender.send(STREAM.done(conversationId), assistant)
        }
        return assistant
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('Document answer failed', { conversationId, message })
        if (!event.sender.isDestroyed()) {
          event.sender.send(STREAM.error(conversationId), message)
        }
        throw err
      } finally {
        inFlightStreams.delete(conversationId)
      }
    }
  )
}
