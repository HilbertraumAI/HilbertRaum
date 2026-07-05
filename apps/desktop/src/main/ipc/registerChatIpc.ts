import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import {
  type ActiveStreamSnapshot,
  type ChatOptions,
  type Conversation,
  type ConversationSearchResult,
  type ConversationSummaryMarker,
  type ContextUsage,
  type DocumentScope,
  type Message
} from '../../shared/types'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  exportTranscript,
  generateAssistantMessage,
  getConversation,
  hasRegenerableAssistantReply,
  getConversationContextUsage,
  getConversationSummaryMarker,
  listConversations,
  listMessages,
  maybeSetTitleFromFirstMessage,
  searchMessages,
  setConversationCollection,
  setConversationDefaultSkill,
  setScope,
  updateConversationScope
} from '../services/chat'
import { resolveTurnSkillFromRegistry } from '../services/skills/turn'
import { conversationAttachmentIds } from '../services/collections'
import { listDocuments } from '../services/ingestion'
import type { DocumentInfo } from '../../shared/types'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { inFlightStreams, streamBuffers } from './inflight'
import { assertChatStreamReady, withChatStream, withRegenerateGuard } from './chat-stream'
import { saveTextExport } from './save-export'
import { tableToCsv } from '../services/tables'
import { loadResultTable } from '../services/tables/store'

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

  // DB-backed handlers require an unlocked workspace; surface the friendly localized message
  // instead of the raw English "Workspace is locked" the `ctx.db` getter throws mid-operation
  // (audit API-1 — matching the docs/collections/doctasks pattern). Guard throws are ephemeral
  // IPC emissions — localized via tMain (i18n record §3.3). The in-memory-only handlers
  // (stopGeneration, getActiveStream) are workspace-agnostic and intentionally skip this.
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) {
      throw new Error(tMain('main.chat.locked'))
    }
  }

  ipcMain.handle(
    IPC.createConversation,
    (
      _e,
      opts?: {
        title?: string
        mode?: 'chat' | 'documents'
        scopeDocumentIds?: string[] | null
        /** Creation-anchor project (plan §13.4). */
        collectionId?: string | null
        /** Initial composite source scope (plan D1). */
        scope?: DocumentScope | null
      }
    ): Conversation => {
      requireUnlocked()
      const conv = createConversation(ctx.db, {
        title: opts?.title,
        mode: opts?.mode,
        modelId: ctx.runtime.activeModelId(),
        scopeDocumentIds: opts?.scopeDocumentIds,
        collectionId: opts?.collectionId,
        scope: opts?.scope
      })
      log.info('Conversation created', {
        id: conv.id,
        mode: conv.mode,
        scopedDocuments: conv.scopeDocumentIds?.length ?? 0,
        anchored: conv.collectionId != null
      })
      return conv
    }
  )

  // Persist a conversation's composite source scope (plan D1 — the multi-select picker).
  // Null clears it; an empty DocumentScope is the explicit "All documents" choice.
  ipcMain.handle(
    IPC.setConversationScope,
    (_e, conversationId: string, scope: DocumentScope | null): Conversation => {
      requireUnlocked()
      const conv = setScope(ctx.db, conversationId, scope ?? null)
      log.info('Conversation scope set', {
        conversationId,
        collections: scope?.collectionIds?.length ?? 0,
        documents: scope?.documentIds?.length ?? 0
      })
      return conv
    }
  )

  // Persist a conversation's creation-anchor project (plan §13.4).
  ipcMain.handle(
    IPC.setConversationCollection,
    (_e, conversationId: string, collectionId: string | null): Conversation => {
      requireUnlocked()
      return setConversationCollection(ctx.db, conversationId, collectionId ?? null)
    }
  )

  // Replace the "ask selected documents" scope (spec §10.4) — chip removal
  // in the UI. Null/empty clears back to whole-corpus retrieval.
  ipcMain.handle(
    IPC.updateConversationScope,
    (_e, conversationId: string, documentIds: string[] | null): Conversation => {
      requireUnlocked()
      const conv = updateConversationScope(ctx.db, conversationId, documentIds)
      log.info('Conversation scope updated', {
        conversationId,
        scopedDocuments: conv.scopeDocumentIds?.length ?? 0
      })
      return conv
    }
  )

  // Persist a conversation's sticky default skill (skills plan §10.1 — the composer picker). Null
  // clears it. Validated against the registry: an unknown/disabled/unavailable id is rejected to
  // null so a stale pick never becomes the default (the resolver also skips it, but keep the
  // persisted value honest). App + user skills are both selectable.
  ipcMain.handle(
    IPC.setConversationDefaultSkill,
    (_e, conversationId: string, installId: string | null): void => {
      requireUnlocked()
      let next: string | null = null
      if (typeof installId === 'string' && installId.length > 0 && ctx.skills) {
        const record = ctx.skills.get(installId)
        if (record && record.enabled && record.unavailableAt == null) next = record.installId
      }
      setConversationDefaultSkill(ctx.db, conversationId, next)
    }
  )

  ipcMain.handle(IPC.listConversations, (): Conversation[] => {
    requireUnlocked()
    return listConversations(ctx.db)
  })

  // A conversation's temporary chat attachments (plan C3/§16 — `conversation_documents`):
  // the docs dropped/attached into THIS chat, for the composer's read-only "Files in this
  // chat" affordance. The link — not Temporary membership — is authoritative, so a doc the
  // user later Keeps in Library still shows here. Only indexed+linked docs appear; a
  // still-processing attachment is surfaced by the renderer's pending chip (import polling).
  ipcMain.handle(IPC.listAttachments, (_e, conversationId: string): DocumentInfo[] => {
    requireUnlocked()
    const ids = new Set(conversationAttachmentIds(ctx.db, conversationId))
    if (ids.size === 0) return []
    return listDocuments(ctx.db, ctx.embedder.id).filter((d) => ids.has(d.id))
  })

  // Full-text search across conversations. The query and the returned snippets are
  // chat CONTENT: this handler must never log them and never writes an audit event
  // (reads are not audited — the audit privacy rule).
  ipcMain.handle(IPC.searchConversations, (_e, query: string): ConversationSearchResult[] => {
    requireUnlocked()
    return searchMessages(ctx.db, typeof query === 'string' ? query : '')
  })

  ipcMain.handle(IPC.listMessages, (_e, conversationId: string): Message[] => {
    requireUnlocked()
    return listMessages(ctx.db, conversationId)
  })

  // Resting-state context-window usage for the composer meter (context-compaction plan §5.1).
  // Read-only, no model call: the assembled-prompt estimate over the launched window. Falls back to
  // settings.contextTokens when no runtime is up. Returns null for an unknown conversation so the
  // renderer hides the meter rather than showing a system-prompt-only sliver for a vanished chat.
  ipcMain.handle(
    IPC.getConversationContextUsage,
    (_e, conversationId: string): ContextUsage | null => {
      requireUnlocked()
      if (!getConversation(ctx.db, conversationId)) return null
      return getConversationContextUsage(ctx.db, ctx.runtime.active(), conversationId)
    }
  )

  // The transcript summary marker (context-compaction plan §5.3, D-b): the latest checkpoint's
  // summary + where the divider sits, or null when none / compaction is disabled. The summary is
  // local context — this read is never logged or audited (chat content, like listMessages).
  ipcMain.handle(
    IPC.getConversationSummary,
    (_e, conversationId: string): ConversationSummaryMarker | null => {
      requireUnlocked()
      return getConversationSummaryMarker(ctx.db, conversationId)
    }
  )

  ipcMain.handle(
    IPC.sendChatMessage,
    async (
      event: IpcMainInvokeEvent,
      conversationId: string,
      content: string,
      options?: ChatOptions
    ): Promise<Message> => {
      requireUnlocked()
      // Shared guard preamble + stream lifecycle (M-A2): conv exists, runtime active,
      // no blocking doc task / stream in flight. A yielding deep-index build is paused (not
      // refused) via the slot arbiter inside withChatStream. DOC_TASK_BUSY_MESSAGE stays
      // canonical English on the wire (renderer exact-match + display map).
      const { runtime } = await assertChatStreamReady(ctx, conversationId)

      const regenerate = options?.regenerate === true
      if (regenerate) {
        // Re-answer the last user turn: the previous assistant reply is dropped, history kept.
        // Only CHECK here (read-only) that a prior reply exists — with none there is nothing to
        // regenerate, so bail early with no stream churn. The DESTRUCTIVE delete is deferred into
        // withChatStream's runFn via withRegenerateGuard (F2): committing it here, before the slot
        // is claimed, lost the prior answer when generation then failed for a non-abort reason
        // (a context-exceeded 400, a dead sidecar) with nothing in its place.
        if (!hasRegenerableAssistantReply(ctx.db, conversationId)) {
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

      // Resolve the one skill for this turn (skills plan §10): the per-turn override or the sticky
      // default. A disabled/missing skill resolves to none (graceful). Shared with the RAG channel
      // via resolveTurnSkill so both carry the skill (audit A1). The message text is passed so the
      // resolver can S13b AUTO-FIRE when the turn has no skill set (it is content — scored, not
      // logged; off by default). On regenerate `content` is empty ⇒ no auto-fire (conservative).
      const skill = resolveTurnSkillFromRegistry(
        ctx.db,
        ctx.skills,
        conversationId,
        options?.skillInstallId,
        content
      )

      return withChatStream(
        event,
        conversationId,
        'Chat generation failed',
        // F2: on regenerate the destructive delete runs INSIDE this runFn (slot held) and is
        // restored on a non-abort failure, so a failed regenerate never leaves the turn answer-less.
        withRegenerateGuard(ctx.db, conversationId, regenerate, (signal, sendToken, sendReasoning, sendCompaction, sendUsage) =>
          generateAssistantMessage(ctx.db, runtime, conversationId, {
            signal,
            mode,
            skill,
            onToken: sendToken,
            // sendReasoning emits the reasoning event AND buffers it for stream recovery.
            onReasoning: sendReasoning,
            // Fires the one-shot ephemeral "summarizing…" notice when the compaction pre-pass
            // starts (§5.2); isDestroyed-guarded inside withChatStream, never buffered (R14).
            onCompactionStart: sendCompaction,
            // The real assembled-prompt usage for the live composer meter (ephemeral, R14).
            onPromptUsage: sendUsage
          })),
        (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
      )
    }
  )

  ipcMain.handle(IPC.deleteConversation, (_e, conversationId: string): void => {
    requireUnlocked()
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

  // Enumerate the conversations with a generation IN FLIGHT so a freshly-mounted Chat screen (the
  // user navigated away and back) can re-select the still-streaming one and re-attach via
  // getActiveStream — otherwise it forgets its conversation and shows an empty new chat while the
  // reply streams invisibly. In-memory only + workspace-agnostic, so it intentionally skips
  // requireUnlocked (like stopGeneration/getActiveStream). Insertion-ordered: the LAST id is the
  // most recently started stream. Returns [] when nothing is generating.
  ipcMain.handle(IPC.listActiveStreamConversations, (): string[] => [...inFlight.keys()])

  // Export a transcript to a user-chosen file (spec §7.6). The save dialog
  // runs in MAIN (the renderer has no fs/dialog access); returns the saved path, or
  // null when the user cancelled.
  ipcMain.handle(IPC.exportConversation, async (_e, conversationId: string): Promise<string | null> => {
    requireUnlocked()
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

  // Export the RESULT TABLE attached to one assistant message (result-tables plan §4, Phase 2) as
  // CSV to a user-chosen file — the chat-side closure of the "categorize … and export as CSV"
  // chaining gap. No skill tool runs; the persisted table is re-serialized through the ONE audited
  // CSV path (tableToCsv, incl. formula-injection neutralization) and the save dialog is the
  // consent, exactly like the transcript export above. Returns the saved path, or null when the
  // user cancelled or the message carries no (readable) table.
  ipcMain.handle(IPC.exportMessageTable, async (_e, messageId: string): Promise<string | null> => {
    requireUnlocked()
    if (typeof messageId !== 'string' || messageId.length === 0) return null
    const table = loadResultTable(ctx.db, messageId)
    if (!table) return null
    const filePath = await saveTextExport(
      {
        title: tMain('main.dialog.exportTableCsv'),
        defaultPath: 'table.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      },
      tableToCsv(table)
    )
    if (!filePath) return null
    log.info('Message table exported', { messageId })
    // Audit privacy rule: id + row count only — the table's columns/rows and the path are content.
    ctx.audit?.('message_table_exported', 'A message result table was exported to a file', {
      messageId,
      rows: table.rows.length
    })
    return filePath
  })
}
