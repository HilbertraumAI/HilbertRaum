import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { writeFileSync } from 'node:fs'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { ChatOptions, Conversation, Message } from '../../shared/types'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  deleteLastAssistantMessage,
  exportTranscript,
  generateAssistantMessage,
  getConversation,
  listConversations,
  listMessages,
  maybeSetTitleFromFirstMessage,
  updateConversationScope
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
    (
      _e,
      opts?: { title?: string; mode?: 'chat' | 'documents'; scopeDocumentIds?: string[] | null }
    ): Conversation => {
      const conv = createConversation(ctx.db, {
        title: opts?.title,
        mode: opts?.mode,
        modelId: ctx.runtime.activeModelId(),
        scopeDocumentIds: opts?.scopeDocumentIds
      })
      log.info('Conversation created', {
        id: conv.id,
        mode: conv.mode,
        scopedDocuments: conv.scopeDocumentIds?.length ?? 0
      })
      return conv
    }
  )

  // Replace the "ask selected documents" scope (Phase 17, spec §10.4) — chip removal
  // in the UI. Null/empty clears back to whole-corpus retrieval.
  ipcMain.handle(
    IPC.updateConversationScope,
    (_e, conversationId: string, documentIds: string[] | null): Conversation => {
      const conv = updateConversationScope(ctx.db, conversationId, documentIds)
      log.info('Conversation scope updated', {
        conversationId,
        scopedDocuments: conv.scopeDocumentIds?.length ?? 0
      })
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

      // One active stream per conversation. The renderer guards this too, but a second
      // window / reload / non-UI caller must not clobber the in-flight canceller (which
      // would orphan the first stream and corrupt the transcript).
      if (inFlight.has(conversationId)) {
        throw new Error('A response is already being generated for this conversation.')
      }

      const regenerate = options?.regenerate === true
      if (regenerate) {
        // Re-answer the last user turn: drop the previous assistant reply, keep history.
        // With no prior assistant reply there is nothing to regenerate — bail rather than
        // re-prompting on stale context.
        if (!deleteLastAssistantMessage(ctx.db, conversationId)) {
          throw new Error('Nothing to regenerate yet.')
        }
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
        // Only clear our own entry — a later stream may already own this key.
        if (inFlight.get(conversationId) === controller) inFlight.delete(conversationId)
      }
    }
  )

  ipcMain.handle(IPC.deleteConversation, (_e, conversationId: string): void => {
    // A stream writing into this conversation would persist its assistant turn after
    // the delete (FK violation / resurrection) — refuse while one is in flight; the
    // renderer disables Delete during streaming, this guards other windows/callers.
    if (inFlight.has(conversationId)) {
      throw new Error('A response is still being generated for this conversation. Stop it first.')
    }
    deleteConversation(ctx.db, conversationId)
    log.info('Conversation deleted', { conversationId })
  })

  ipcMain.handle(IPC.stopGeneration, (_e, conversationId: string): void => {
    const controller = inFlight.get(conversationId)
    if (controller) {
      log.info('Stop generation', { conversationId })
      controller.abort()
    }
  })

  // Export a transcript to a user-chosen file (spec §7.6 — audit M13). The save dialog
  // runs in MAIN (the renderer has no fs/dialog access); returns the saved path, or
  // null when the user cancelled.
  ipcMain.handle(IPC.exportConversation, async (_e, conversationId: string): Promise<string | null> => {
    const { title, markdown } = exportTranscript(ctx.db, conversationId)
    const safeName = title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'chat'
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Export chat transcript',
      defaultPath: `${safeName}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] }
      ]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, markdown, 'utf8')
    log.info('Transcript exported', { conversationId })
    return result.filePath
  })
}
