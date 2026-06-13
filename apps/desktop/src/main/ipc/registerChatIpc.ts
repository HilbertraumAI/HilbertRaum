import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import {
  type ActiveStreamSnapshot,
  type ChatOptions,
  type Conversation,
  type ConversationSearchResult,
  type Message
} from '../../shared/types'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  deleteLastAssistantMessage,
  exportTranscript,
  generateAssistantMessage,
  listConversations,
  listMessages,
  maybeSetTitleFromFirstMessage,
  searchMessages,
  updateConversationScope
} from '../services/chat'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { inFlightStreams, streamBuffers } from './inflight'
import { assertChatStreamReady, withChatStream } from './chat-stream'
import { saveTextExport } from './save-export'

// IPC for conversation CRUD + streaming chat (spec §9.1, §7.6).
//
// Streaming contract (LOCKED, additive changes only): tokens are pushed to the
// renderer over per-conversation event channels keyed by the conversation id —
// chat:token:<id> / chat:done:<id> / chat:error:<id>. The `sendChatMessage` invoke
// also resolves with the final assistant Message so a caller can simply await it.
// Cancellation: stopGeneration(id) aborts the in-flight AbortController; the partial
// reply is persisted and a normal `done` is emitted. Deep-mode reasoning deltas go
// out on chat:reasoning:<id> — a separate (additive) channel, so token events still
// carry only answer text.
//
// sendChatMessage does NOT auto-start a runtime. A chat needs an explicitly-started
// model (AI Model screen → "Start runtime"); with no active runtime it throws so the
// renderer can show the "start a model" empty state. Starting the real llama.cpp
// sidecar is heavy and is an explicit user action — keeping it explicit keeps the
// service boundary clean.

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

  // Replace the "ask selected documents" scope (spec §10.4) — chip removal
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

  // Full-text search across conversations. The query and the returned snippets are
  // chat CONTENT: this handler must never log them and never writes an audit event
  // (reads are not audited — the audit privacy rule).
  ipcMain.handle(IPC.searchConversations, (_e, query: string): ConversationSearchResult[] =>
    searchMessages(ctx.db, typeof query === 'string' ? query : '')
  )

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
      // Shared guard preamble + stream lifecycle (M-A2): conv exists, runtime active,
      // no doc task / stream in flight. The DOC_TASK_BUSY_MESSAGE stays canonical English
      // on the wire (renderer exact-match + display map).
      const { runtime } = assertChatStreamReady(ctx, conversationId)

      const regenerate = options?.regenerate === true
      if (regenerate) {
        // Re-answer the last user turn: drop the previous assistant reply, keep history.
        // With no prior assistant reply there is nothing to regenerate — bail rather than
        // re-prompting on stale context.
        if (!deleteLastAssistantMessage(ctx.db, conversationId)) {
          throw new Error(tMain('main.chat.nothingToRegenerate'))
        }
      } else {
        const text = content.trim()
        if (!text) throw new Error(tMain('main.chat.emptyMessage'))
        appendMessage(ctx.db, { conversationId, role: 'user', content: text })
        maybeSetTitleFromFirstMessage(ctx.db, conversationId, text)
      }

      // Answer-depth mode: enum-guarded like gpuMode — junk from a non-UI
      // caller degrades to the balanced default instead of reaching the runtime.
      const mode =
        options?.mode === 'fast' || options?.mode === 'balanced' || options?.mode === 'deep'
          ? options.mode
          : undefined

      return withChatStream(
        event,
        conversationId,
        'Chat generation failed',
        (signal, sendToken, sendReasoning) =>
          generateAssistantMessage(ctx.db, runtime, conversationId, {
            signal,
            mode,
            onToken: sendToken,
            // sendReasoning emits the reasoning event AND buffers it for stream recovery.
            onReasoning: sendReasoning
          })
      )
    }
  )

  ipcMain.handle(IPC.deleteConversation, (_e, conversationId: string): void => {
    // A stream writing into this conversation would persist its assistant turn after
    // the delete (FK violation / resurrection) — refuse while one is in flight; the
    // renderer disables Delete during streaming, this guards other windows/callers.
    if (inFlight.has(conversationId)) {
      throw new Error(tMain('main.chat.stopFirst'))
    }
    deleteConversation(ctx.db, conversationId)
    log.info('Conversation deleted', { conversationId })
    ctx.audit?.('conversation_deleted', 'Conversation deleted', { conversationId })
  })

  ipcMain.handle(IPC.stopGeneration, (_e, conversationId: string): void => {
    const controller = inFlight.get(conversationId)
    if (controller) {
      log.info('Generation stop requested', { conversationId })
      controller.abort()
    }
  })

  // Recover an in-flight generation after the Chat screen was unmounted (the user
  // navigated away and back). Returns the live accumulated answer/reasoning snapshot, or
  // null when nothing is generating for this conversation. Read-only; never mutates.
  ipcMain.handle(
    IPC.getActiveStream,
    (_e, conversationId: string): ActiveStreamSnapshot | null => {
      const buf = streamBuffers.get(conversationId)
      return buf ? { content: buf.content, reasoning: buf.reasoning } : null
    }
  )

  // Export a transcript to a user-chosen file (spec §7.6). The save dialog
  // runs in MAIN (the renderer has no fs/dialog access); returns the saved path, or
  // null when the user cancelled.
  ipcMain.handle(IPC.exportConversation, async (_e, conversationId: string): Promise<string | null> => {
    const { title, markdown } = exportTranscript(ctx.db, conversationId)
    const safeName = title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'chat'
    const filePath = await saveTextExport(
      {
        title: tMain('main.dialog.exportChat'),
        defaultPath: `${safeName}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] }
        ]
      },
      markdown
    )
    if (!filePath) return null
    log.info('Transcript exported', { conversationId })
    // Audit privacy rule: the id only — the chosen path/default filename derives
    // from the conversation TITLE, which is chat content.
    ctx.audit?.('conversation_exported', 'Conversation transcript exported to a file', {
      conversationId
    })
    return filePath
  })
}
