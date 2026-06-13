import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { DOC_TASK_BUSY_MESSAGE, type Message } from '../../shared/types'
import { appendMessage, getConversation, maybeSetTitleFromFirstMessage } from '../services/chat'
import { detectFilenameScope, generateGroundedAnswer, ragSettingsFrom } from '../services/rag'
import { listDocuments } from '../services/ingestion'
import { getSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { inFlightStreams } from './inflight'

// IPC for RAG chat with citations (spec §9.1, §7.8).
//
// `askDocuments(conversationId, question)` is the document-grounded sibling of
// `sendChatMessage`. It REUSES the LOCKED streaming contract — tokens go out on
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
// the AI Model screen first; with none active the handler throws so the renderer can show
// the "start a model" empty state.

export function registerRagIpc(ctx: AppContext): void {
  ipcMain.handle(
    IPC.askDocuments,
    async (event: IpcMainInvokeEvent, conversationId: string, question: string): Promise<Message> => {
      const conv = getConversation(ctx.db, conversationId)
      if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)

      const runtime = ctx.runtime.active()
      if (!runtime) {
        // Ephemeral IPC guard → tMain (i18n record §3.3); DOC_TASK_BUSY_MESSAGE below
        // stays canonical English on the wire (renderer exact-match + display map).
        throw new Error(tMain('main.noModelRunning'))
      }

      // Strict one-at-a-time vs document tasks (see registerChatIpc).
      if (ctx.docTasks?.hasActiveTask()) {
        throw new Error(DOC_TASK_BUSY_MESSAGE)
      }

      // One active stream per conversation (shared registry with plain chat).
      if (inFlightStreams.has(conversationId)) {
        throw new Error(tMain('main.chat.streamInFlight'))
      }

      const text = question.trim()
      if (!text) throw new Error(tMain('main.chat.emptyQuestion'))
      appendMessage(ctx.db, { conversationId, role: 'user', content: text })
      maybeSetTitleFromFirstMessage(ctx.db, conversationId, text)

      const settings = ragSettingsFrom(getSettings(ctx.db))

      // Filename auto-scope: when the conversation has NO explicit "ask selected
      // documents" scope but the question names indexed file(s), restrict retrieval to
      // them so other documents are not surfaced as sources. Only ever narrows; a live
      // (non-persisted) notice tells the user which file(s) the answer is grounded in.
      let scopeDocumentIds = conv.scopeDocumentIds
      if (!scopeDocumentIds || scopeDocumentIds.length === 0) {
        const candidates = listDocuments(ctx.db)
          .filter((d) => d.status === 'indexed' && d.chunkCount > 0)
          .map((d) => ({ id: d.id, title: d.title }))
        const detected = detectFilenameScope(text, candidates)
        if (detected) {
          scopeDocumentIds = detected.ids
          if (!event.sender.isDestroyed()) {
            event.sender.send(STREAM.scope(conversationId), { titles: detected.titles })
          }
        }
      }

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
            // "Ask selected documents": the conversation's persisted scope restricts
            // retrieval; null scope = whole corpus. When no explicit scope was set,
            // this may carry the filename auto-scope derived from the question above.
            scopeDocumentIds,
            // Retrieval reranker: null when no reranker is provisioned — retrieval
            // then keeps the unreranked ordering byte-identical.
            reranker: ctx.reranker,
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
        // Only clear our own entry — a later stream may already own this key.
        if (inFlightStreams.get(conversationId) === controller) inFlightStreams.delete(conversationId)
      }
    }
  )
}
