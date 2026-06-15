import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { type ExtractRecordType, type Message, type RetrievalScope } from '../../shared/types'
import { appendMessage, maybeSetTitleFromFirstMessage } from '../services/chat'
import { resolveScope } from '../services/collections'
import { buildScopeFilter } from '../services/retrieval-scope'
import { detectFilenameScope, generateGroundedAnswer, ragSettingsFrom } from '../services/rag'
import { aggregateExtractions, SCAN_MARKER_TYPE } from '../services/analysis/extract'
import { routeQuestion } from '../services/analysis/router'
import { buildListingAnswer } from '../services/analysis/listing-answer'
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

/** Does any in-scope document have precomputed structured-extract data (a `__scan__` marker)?
 *  Gates the router's coverage-extract branch — without it we cannot honestly claim a complete
 *  list, so the question falls back to labelled relevance (plan §4.2/§4.4, H7). */
function extractionsExistInScope(db: Db, scope: RetrievalScope): boolean {
  const filter = buildScopeFilter(scope, 'document_id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const row = db
    .prepare(
      `SELECT 1 FROM extraction_records WHERE record_type = ?${where} LIMIT 1`
    )
    .get(SCAN_MARKER_TYPE, ...(filter ? filter.params : [])) as unknown as { 1: number } | undefined
  return row != null
}

/** Count in-scope documents with a READY deep-index tree (enables the tree-summary route). */
function readyTreeCountInScope(db: Db, scope: RetrievalScope): number {
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d WHERE d.tree_status = 'ready'${where}`
    )
    .get(...(filter ? filter.params : [])) as unknown as { n: number }
  return row?.n ?? 0
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
      // Shared guard preamble (M-A2): conv exists, runtime active, no blocking doc task /
      // stream already in flight (a yielding deep-index build is paused, not refused).
      const { runtime } = await assertChatStreamReady(ctx, conversationId)

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

      // Task router (whole-document-analysis plan §4.4, Phase 3): a "list every X / how many"
      // question over a mapped, PRE-EXTRACTED type is answered by the precomputed SQL
      // aggregation — exhaustive over indexed sections, with provenance, at ZERO query-time
      // model calls. Anything else (incl. an unmapped/ad-hoc {X} with no precomputed table)
      // falls through to the existing relevance path BYTE-UNCHANGED.
      const decision = routeQuestion({
        question: text,
        documentCount: documentsInScope(ctx.db, scope).length,
        treeAvailable: readyTreeCountInScope(ctx.db, scope) > 0,
        extractAvailable: extractionsExistInScope(ctx.db, scope)
      })
      if (decision.engine === 'coverage-extract' && decision.recordType) {
        const recordType: ExtractRecordType = decision.recordType
        const listing = aggregateExtractions(ctx.db, scope, recordType)
        const answer = buildListingAnswer(ctx.db, listing, (key, params) => tMain(key, params))
        return withChatStream(
          event,
          conversationId,
          'Document listing failed',
          async (_signal, sendToken): Promise<Message> => {
            // 0 model calls: emit the deterministic listing as one chunk, then persist it.
            sendToken(answer)
            return appendMessage(ctx.db, {
              conversationId,
              role: 'assistant',
              content: answer
            })
          },
          // Acquire the slot so a yielding deep-index build is paused/resumed cleanly even
          // though we make no model call (keeps the single locked contract).
          () => ctx.docTasks?.acquireChatSlot() ?? Promise.resolve(() => {})
        )
      }

      return withChatStream(
        event,
        conversationId,
        'Document answer failed',
        (signal, sendToken) =>
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
          }),
        () => ctx.docTasks?.acquireChatSlot() ?? Promise.resolve(() => {})
      )
    }
  )
}
