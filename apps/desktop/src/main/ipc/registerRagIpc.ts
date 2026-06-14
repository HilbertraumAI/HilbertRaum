import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { type Message, type RetrievalScope } from '../../shared/types'
import { appendMessage, maybeSetTitleFromFirstMessage } from '../services/chat'
import { resolveScope } from '../services/collections'
import { buildScopeFilter } from '../services/retrieval-scope'
import { detectFilenameScope, generateGroundedAnswer, ragSettingsFrom } from '../services/rag'
import { getSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { assertChatStreamReady, withChatStream } from './chat-stream'
import type { Db } from '../services/db'

// The indexed, answerable documents WITHIN a resolved scope (id + title only — no vectors),
// for filename auto-scope (plan §10.1 rule 5 / N13: a bounded, indexed projection, not the
// whole corpus). The same membership/id/archived filter retrieval uses is applied here.
function documentsInScope(db: Db, scope: RetrievalScope): Array<{ id: string; title: string }> {
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const params = filter ? filter.params : []
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.title AS title FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)${where}`
    )
    .all(...params) as Array<{ id: string; title: string }>
  return rows
}

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
      // Shared guard preamble (M-A2): conv exists, runtime active, no doc task / stream
      // already in flight.
      const { runtime } = assertChatStreamReady(ctx, conversationId)

      const text = question.trim()
      if (!text) throw new Error(tMain('main.chat.emptyQuestion'))
      appendMessage(ctx.db, { conversationId, role: 'user', content: text })
      maybeSetTitleFromFirstMessage(ctx.db, conversationId, text)

      const settings = ragSettingsFrom(getSettings(ctx.db))

      // Resolve the conversation's composite scope (plan §10.1 / D1): the UNION of the
      // selected collections (Library / projects), specific docs, and chat attachments.
      let scope = resolveScope(ctx.db, conversationId)

      // Filename auto-scope narrows WITHIN the resolved scope (plan §10.1 rule 5): when the
      // question names indexed file(s) visible in scope, restrict retrieval to them. Skipped
      // only when the user hand-picked specific docs (N2 — keyed off hasExplicitDocSelection,
      // NOT the merged documentIds). Only ever narrows; a live notice names the file(s).
      if (!scope.hasExplicitDocSelection) {
        const detected = detectFilenameScope(text, documentsInScope(ctx.db, scope))
        if (detected) {
          // Narrow to exactly the matched docs (a subset of the resolved scope). `detected.ids`
          // come from `documentsInScope(scope)`, which already applied this scope's archived
          // filter, so inheriting `includeArchived` by spread keeps the narrowed scope
          // CONSISTENT with what surfaced the docs — it never widens visibility (RAG-2). The
          // same `buildScopeFilter` then guards retrieval, so there is no archived-leak path.
          scope = { ...scope, collectionIds: null, documentIds: detected.ids }
          if (!event.sender.isDestroyed()) {
            event.sender.send(STREAM.scope(conversationId), { titles: detected.titles })
          }
        }
      }

      return withChatStream(event, conversationId, 'Document answer failed', (signal, sendToken) =>
        generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
          signal,
          // Composite retrieval scope (plan §10.2): membership ∪ specific docs ∪ attachments,
          // archived excluded by default. Also makes the empty-context re-index check
          // scope-aware (M2). An empty resolved scope = whole corpus.
          scope,
          // Retrieval reranker: null when no reranker is provisioned — retrieval then
          // keeps the unreranked ordering byte-identical.
          reranker: ctx.reranker,
          onToken: sendToken
        })
      )
    }
  )
}
