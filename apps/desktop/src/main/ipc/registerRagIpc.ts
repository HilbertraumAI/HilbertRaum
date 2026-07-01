import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, STREAM } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import {
  type ExtractRecordType,
  type Message,
  type RetrievalScope
} from '../../shared/types'
import {
  appendMessage,
  hasRegenerableAssistantReply,
  listMessages,
  maybeSetTitleFromFirstMessage
} from '../services/chat'
import { resolveScope } from '../services/collections'
import { buildScopeFilter } from '../services/retrieval-scope'
import { detectFilenameScope, generateGroundedAnswer, ragSettingsFrom } from '../services/rag'
import { resolveTurnSkillFromRegistry } from '../services/skills/turn'
import { getSkillAnalysisHandler } from '../services/skills/analysis'
import { toSkillToolAudit } from '../services/skills/tool-runs'
import { buildDocumentSegmentReader } from './documentSegments'
import { aggregateExtractions, SCAN_MARKER_TYPE } from '../services/analysis/extract'
import { routeQuestion } from '../services/analysis/router'
import { buildListingAnswer } from '../services/analysis/listing-answer'
import { getSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { assertChatStreamReady, withChatStream, withRegenerateGuard } from './chat-stream'
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

/**
 * Exhaustiveness precondition for a tool-skill analysis turn (full-doc-skills §3.2/D45/R4): is EVERY
 * indexed, answerable in-scope document `fully_chunked` RIGHT NOW? `documents.fully_chunked` is TEXT;
 * non-NULL = fully chunked (NULL = legacy/partly-chunked). Read at turn time (not a cached flag) so a
 * doc later edited stale refuses honestly. Mirrors the `documentsInScope` membership/index filter so
 * the set checked is exactly the set the handler would analyse. `applies()` already requires a single
 * in-scope doc, so this is effectively "is that one doc fully chunked".
 */
function allInScopeDocsFullyChunked(db: Db, scope: RetrievalScope): boolean {
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
         AND d.fully_chunked IS NULL${where}`
    )
    .get(...(filter ? filter.params : [])) as unknown as { n: number }
  return (row?.n ?? 0) === 0
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
  // The FAITHFUL content reach a tool-skill analysis handler needs (full-doc-skills §3.2): a
  // document's ordered, non-overlapping, newline-preserving parser segments, re-extracted from the
  // stored copy — the SAME reader the skills-run IPC injects (`documentSegments.ts`), so the chat
  // answer and the run-bar button agree on layout use. The `chunks` table is retrieval windows
  // (newlines collapsed, ~80-token overlap), which would give the line-oriented extractors near-zero
  // rows. Content stays main-side: only the tool ever sees it.
  const readDocumentSegments = buildDocumentSegmentReader(ctx)

  ipcMain.handle(
    IPC.askDocuments,
    async (
      event: IpcMainInvokeEvent,
      conversationId: string,
      question: string,
      skillInstallId?: string | null,
      regenerate?: boolean
    ): Promise<Message> => {
      // F16 (audit-postmerge-2026-06-29): rag:ask is the document-grounded sibling of
      // sendChatMessage and touches ctx.db throughout; gate it FIRST with the same localized chat
      // lock copy so a locked call refuses friendly instead of throwing the raw vault-getter string
      // deep inside assertChatStreamReady. (Generalized lock test covers this — subsumes T3.)
      if (!ctx.workspace.isUnlocked()) throw new Error(tMain('main.chat.locked'))
      // Shared guard preamble (M-A2): conv exists, runtime active, no blocking doc task /
      // stream already in flight (a yielding deep-index build is paused, not refused).
      const { runtime } = await assertChatStreamReady(ctx, conversationId)

      // Re-answer the last document turn (S13c "answer without it" undo, symmetric to chat's
      // regenerate): drop the previous assistant reply and RE-USE the existing last user turn as the
      // question — never append a duplicate user row. The renderer passes `skillInstallId: null` to
      // re-run skill-free; with no prior assistant reply there is nothing to regenerate.
      const isRegenerate = regenerate === true
      let text: string
      if (isRegenerate) {
        // Only CHECK (read-only) that a prior assistant reply exists, then recover the last USER
        // turn as the question. The DESTRUCTIVE delete is deferred into each withChatStream runFn
        // below via withRegenerateGuard (F2): committing it here, before the slot was claimed, lost
        // the prior answer on a non-abort failure. Finding the last user turn does NOT require
        // deleting the assistant reply first — the reverse-find skips the assistant row regardless.
        if (!hasRegenerableAssistantReply(ctx.db, conversationId)) {
          throw new Error(tMain('main.chat.nothingToRegenerate'))
        }
        const history = listMessages(ctx.db, conversationId)
        text = ([...history].reverse().find((m) => m.role === 'user')?.content ?? '').trim()
        if (!text) throw new Error(tMain('main.chat.emptyQuestion'))
      } else {
        text = question.trim()
        if (!text) throw new Error(tMain('main.chat.emptyQuestion'))
        appendMessage(ctx.db, { conversationId, role: 'user', content: text })
        maybeSetTitleFromFirstMessage(ctx.db, conversationId, text)
      }

      // Resolve the one skill for this DOCUMENT turn too (audit A1/§22-A1 — both channels carry the
      // skill, else a documents conversation silently gets none). Same resolver as plain chat. The
      // question is passed so the resolver can S13b AUTO-FIRE when the turn has no skill set (content —
      // scored, not logged; off by default).
      const skill = resolveTurnSkillFromRegistry(ctx.db, ctx.skills, conversationId, skillInstallId, text)

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

      // Full-doc-skills Phase 3 (§3.2/D44/D46/D47): a `kind:tool` skill with a REGISTERED analysis
      // handler that APPLIES to this question over this scope answers EXHAUSTIVELY via its
      // whole-document read-only tools, not top-k RAG. The registry is the opt-in (D49) — a registered
      // handler implies `kind:tool`, so no separate kind check is needed. When no handler is
      // registered for the turn skill, or `applies()` is false (off-topic / multi-doc), this whole
      // block is skipped and the relevance + coverage-extract paths below run BYTE-UNCHANGED (R5).
      const analysisHandler = skill ? getSkillAnalysisHandler(skill.installId) : undefined
      if (skill && analysisHandler && analysisHandler.applies({ question: text, scope, db: ctx.db })) {
        const turnSkill = skill
        // Exhaustiveness precondition (D45/R4): every in-scope doc must be FULLY chunked at turn time.
        // A legacy/partly-chunked doc cannot be analysed exhaustively, so we REFUSE — a fixed,
        // localized message + the existing Re-index affordance, no model call, no partial answer.
        // A `routing` handler is EXEMPT: it reads no content (it only points the user at the skill's
        // run affordance), so full chunking is irrelevant and the refusal must not fire.
        if (analysisHandler.mode !== 'routing' && !allInScopeDocsFullyChunked(ctx.db, scope)) {
          const refusal = tMain('skills.analysis.refusePartial')
          return withChatStream(
            event,
            conversationId,
            'Document analysis refused',
            // F2: on regenerate the destructive delete runs inside the runFn (slot held) and is
            // restored on a non-abort failure — symmetric with the chat channel.
            withRegenerateGuard(ctx.db, conversationId, isRegenerate, async (_signal, sendToken): Promise<Message> => {
              sendToken(refusal)
              // Honest coverage on a refusal: NULL (omitted) — we make NO breadth claim. Stamp the
              // skill (A1) so the re-routed turn still carries its glyph + auto-fire provenance.
              return appendMessage(ctx.db, {
                conversationId,
                role: 'assistant',
                content: refusal,
                skillId: turnSkill.installId,
                autoFired: turnSkill.autoFired === true
              })
            }),
            (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
          )
        }
        // `grounded-whole-doc` (skill-whole-doc engine, Wave 2): an INSTRUCTION skill whose
        // deliverable is the MODEL's answer over the WHOLE document, formatted to the SKILL.md body
        // (minutes, contract brief, …). Stream a grounded answer where the context is the single
        // in-scope document read IN ORDER (not top-k) with the fence applied; coverage is the honest
        // `capped` mode ("covers the whole document" / "the beginning" when truncated). `applies()`
        // guaranteed a single in-scope doc; the fully-chunked refusal above already gated it.
        if (analysisHandler.mode === 'grounded-whole-doc') {
          const target = documentsInScope(ctx.db, scope)[0]
          if (target) {
            const documentId = target.id
            return withChatStream(
              event,
              conversationId,
              'Document answer failed',
              withRegenerateGuard(ctx.db, conversationId, isRegenerate, (signal, sendToken, _sendReasoning, sendCompaction) =>
                generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
                  signal,
                  onCompactionStart: sendCompaction,
                  scope,
                  reranker: ctx.reranker,
                  // The turn's skill fence rides in the grounded USER turn; the whole document is the
                  // context, so the assistant row carries the skill stamp + `capped` coverage.
                  skill: turnSkill,
                  wholeDocument: { documentId },
                  onToken: sendToken
                })),
              (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
            )
          }
          // Defensive: applies() requires a single in-scope doc, so this is unreachable; fall through
          // to the relevance path rather than fail the turn.
        }

        // `grounded-whole-doc-compare` (Follow-up B, what-changed): a compare-shaped request over
        // EXACTLY TWO in-scope docs streams a model answer over BOTH documents read whole (budget
        // split across them) with the fence applied; coverage is `capped` (truncated when either
        // overflowed). `applies()` guaranteed exactly two in-scope docs; the fully-chunked refusal
        // above already gated both.
        if (analysisHandler.mode === 'grounded-whole-doc-compare') {
          const documentIds = documentsInScope(ctx.db, scope).map((d) => d.id)
          if (documentIds.length === 2) {
            return withChatStream(
              event,
              conversationId,
              'Document answer failed',
              withRegenerateGuard(ctx.db, conversationId, isRegenerate, (signal, sendToken, _sendReasoning, sendCompaction) =>
                generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
                  signal,
                  onCompactionStart: sendCompaction,
                  scope,
                  reranker: ctx.reranker,
                  skill: turnSkill,
                  wholeDocumentCompare: { documentIds },
                  onToken: sendToken
                })),
              (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
            )
          }
          // Defensive: applies() requires exactly two in-scope docs; otherwise fall through.
        }

        // `exhaustive` / `routing`: auto-run the read-only whole-document tools (D46) and persist the
        // exhaustive answer with its honest extract/whole coverage (D48) + real citations, OR (routing)
        // return the action-routing answer. NO model call — deterministic, localized copy (D47). A
        // `grounded-whole-doc` handler omits `run()` and returned above; the guard keeps types honest.
        if (analysisHandler.run) {
          const runHandler = analysisHandler.run.bind(analysisHandler)
          return withChatStream(
            event,
            conversationId,
            'Document analysis failed',
            withRegenerateGuard(ctx.db, conversationId, isRegenerate, async (signal, sendToken): Promise<Message> => {
              const result = await runHandler({
                db: ctx.db,
                question: text,
                scope,
                skillInstallId: turnSkill.installId,
                conversationId,
                // The app's real ids/counts-only audit sink (the skills-run adapter — never invent one).
                audit: toSkillToolAudit(ctx.audit),
                // Thread the chat slot's abort signal so Cancel stops the auto-run.
                signal,
                tr: (key, params) => tMain(key, params),
                // Faithful newline-preserving segments (not the overlap-collapsing chunks table).
                readDocumentSegments
              })
              sendToken(result.answer)
              return appendMessage(ctx.db, {
                conversationId,
                role: 'assistant',
                content: result.answer,
                citations: result.citations,
                coverage: result.coverage,
                skillId: turnSkill.installId,
                autoFired: turnSkill.autoFired === true
              })
            }),
            (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
          )
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
          withRegenerateGuard(ctx.db, conversationId, isRegenerate, async (_signal, sendToken): Promise<Message> => {
            // 0 model calls: emit the deterministic listing as one chunk, then persist it.
            sendToken(answer)
            return appendMessage(ctx.db, {
              conversationId,
              role: 'assistant',
              content: answer
            })
          }),
          // Acquire the slot so a yielding deep-index build is paused/resumed cleanly even
          // though we make no model call (keeps the single locked contract).
          (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
        )
      }

      return withChatStream(
        event,
        conversationId,
        'Document answer failed',
        // F2: defer the regenerate delete into the runFn (slot held) + restore on a non-abort failure.
        withRegenerateGuard(ctx.db, conversationId, isRegenerate, (signal, sendToken, _sendReasoning, sendCompaction) =>
          generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
            signal,
            // One-shot ephemeral "summarizing…" notice when the compaction pre-pass starts (§5.2);
            // isDestroyed-guarded inside withChatStream, never buffered (R14).
            onCompactionStart: sendCompaction,
            // Composite retrieval scope (plan §10.2): membership ∪ specific docs ∪ attachments,
            // archived excluded by default. Also makes the empty-context re-index check
            // scope-aware (M2). An empty resolved scope = whole corpus.
            scope,
            // Retrieval reranker: null when no reranker is provisioned — retrieval then
            // keeps the unreranked ordering byte-identical.
            reranker: ctx.reranker,
            // The turn's skill: its fence rides in the grounded user turn; the assistant row is
            // stamped only when the fence fit AND chunks were found (no-context ⇒ NULL).
            skill,
            onToken: sendToken
          })),
        (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
      )
    }
  )
}
