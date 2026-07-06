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
  effectiveContextWindow,
  hasRegenerableAssistantReply,
  listMessages,
  maybeSetTitleFromFirstMessage
} from '../services/chat'
import { resolveScope } from '../services/collections'
import { buildScopeFilter } from '../services/retrieval-scope'
import {
  detectFilenameScope,
  documentApproxTokenTotal,
  generateGroundedAnswer,
  generateGroundedDataAnswer,
  ragSettingsFrom,
  wholeDocumentFitBudgetTokens
} from '../services/rag'
import { resolveTurnSkillFromRegistry } from '../services/skills/turn'
import { getSkillAnalysisHandler, manifestAnalysisHandler } from '../services/skills/analysis'
import { documentsInScope } from '../services/skills/scope-documents'
import { getSkill } from '../services/skills/registry'
import { matchesSkillDocSignals } from '../services/skills/selector'
import { isNeedleShaped, isSmallTalk } from '../services/skills/vocabulary'
import { toSkillToolAudit } from '../services/skills/tool-runs'
import { saveResultTable } from '../services/tables/store'
import { log } from '../services/logging'
import { buildDocumentSegmentReader } from './documentSegments'
import { aggregateExtractions, SCAN_MARKER_TYPE } from '../services/analysis/extract'
import { routeQuestion } from '../services/analysis/router'
import { buildListingAnswer } from '../services/analysis/listing-answer'
import { getSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { assertChatStreamReady, withChatStream, withRegenerateGuard } from './chat-stream'
import type { Db } from '../services/db'

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
      regenerate?: boolean,
      pinnedDocumentId?: string | null
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

      // U3 routed-run relay pin (audit ux-6): a Summarize/Categorize button routes its question into
      // the transcript pinned to the run's document, so the answer can't scatter across a multi-doc
      // scope. The id is UNTRUSTED (renderer-supplied) — re-validate it against the in-scope, indexed
      // set (the run-start `documentId` precedent) and narrow ONLY to a real member; an id outside
      // scope is ignored (the ordinary scope stands). `hasExplicitDocSelection` marks it a deliberate
      // pick so the filename auto-scope below defers to it. NOT a routing-engine change — the same
      // handler dispatch runs, only over one document.
      if (typeof pinnedDocumentId === 'string' && pinnedDocumentId.length > 0) {
        const inScope = documentsInScope(ctx.db, scope, { requireChunks: true })
        if (inScope.some((d) => d.id === pinnedDocumentId)) {
          scope = { ...scope, collectionIds: null, documentIds: [pinnedDocumentId], hasExplicitDocSelection: true }
        }
      }

      // Filename auto-scope narrows WITHIN the resolved scope (plan §10.1 rule 5): when the
      // question names indexed file(s) visible in scope, restrict retrieval to them. Skipped
      // only when the user hand-picked specific docs (N2 — keyed off hasExplicitDocSelection,
      // NOT the merged documentIds). Only ever narrows; a live notice names the file(s).
      if (!scope.hasExplicitDocSelection) {
        const detected = detectFilenameScope(text, documentsInScope(ctx.db, scope, { requireChunks: true }))
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

      // Full-doc-skills Phase 3 (§3.2/D44/D46/D47) + A3 (audit §6.3/§8.2): the turn skill's analysis
      // handler. It comes from TWO sources, in precedence order:
      //   1. the app REGISTRY (`getSkillAnalysisHandler`) — the bank/invoice TOOL skills' exhaustive
      //      handlers, redaction's routing handler, and the bundled instruction skills' whole-doc/compare
      //      singletons. Tool handlers are app-only (SEC-1); the registry is that gate.
      //   2. A3 fallback: for a skill WITHOUT a registered handler, the MANIFEST's `analysis` engine
      //      (`manifestAnalysisHandler`) — so a user-imported INSTRUCTION skill declaring
      //      `analysis: whole-doc`/`compare` reaches the same engine (the fix for "a user-imported skill
      //      silently gets top-k-with-fence", §6.3). Honored only for `kind:'instruction'`; a user tool
      //      skill resolves to `undefined` here (it declares no analysis engine and runs no tools — SEC-1).
      // When neither yields a handler, or `applies()` is false (off-topic / multi-doc), this whole block is
      // skipped and the relevance + coverage-extract paths below run BYTE-UNCHANGED (R5).
      const skillRecord = skill ? getSkill(ctx.db, skill.installId) : null
      const analysisHandler = skill
        ? getSkillAnalysisHandler(skill.installId) ??
          (skillRecord ? manifestAnalysisHandler(skillRecord.kind, skillRecord.manifest.analysis) : undefined)
        : undefined

      // W2 doc-count-fallthrough routing (audit §2.1/§3.4): a tool/whole-doc skill reads ONE document
      // (two, for compare) at a time, so a multi-document scope can't be analysed exhaustively. When the
      // turn skill HAS a handler and the question is INTENT-shaped (`intends()`) but `applies()` fails —
      // which, given `intends()` is true, can ONLY be the document count — do NOT fall through silently to
      // top-k retrieval. Instead narrow to the one document the skill's manifest signals best match (with
      // an honest scope notice) or emit a deterministic routing answer. Deterministic, ZERO model calls.
      // `intends()` absent (redaction, whose `applies()` already accepts any count ≥ 1) opts out entirely.
      let scopeNotice: string | null = null
      if (
        skill &&
        analysisHandler &&
        analysisHandler.intends?.({ question: text, scope, db: ctx.db }) &&
        !analysisHandler.applies({ question: text, scope, db: ctx.db })
      ) {
        const turnSkill = skill
        const inScope = documentsInScope(ctx.db, scope, { requireChunks: true })
        // A deterministic routing answer over the LOCKED stream (skill-stamped, no coverage/citations —
        // it makes no document claim). Same shape as the refuse/listing paths; no model call.
        const routeAnswer = (label: string, answer: string): Promise<Message> =>
          withChatStream(
            event,
            conversationId,
            label,
            withRegenerateGuard(ctx.db, conversationId, isRegenerate, async (_signal, sendToken): Promise<Message> => {
              sendToken(answer)
              return appendMessage(ctx.db, {
                conversationId,
                role: 'assistant',
                content: answer,
                skillId: turnSkill.installId,
                autoFired: turnSkill.autoFired === true
              })
            }),
            (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
          )

        if (analysisHandler.mode === 'grounded-whole-doc-compare') {
          // what-changed at ≠ 2 docs (audit §3.4): ask for exactly two — the app owns the scope, so this
          // replaces the SKILL.md's ask-the-model policing (the model can't see the count). 0 docs stays
          // on the ordinary relevance path (its own "no documents" honesty).
          if (inScope.length >= 1) {
            return routeAnswer('Document compare routing', tMain('skills.analysis.selectTwo', { count: inScope.length }))
          }
        } else if (inScope.length >= 2) {
          // A single-doc handler over TOO MANY docs: narrow to the ONE the skill's manifest doc signals
          // (filenamePatterns/MIME) match. We only narrow to a doc we can ACTUALLY answer exhaustively —
          // i.e. one that is FULLY chunked — so the "I answered from «title»" notice is never a lie: a
          // sole match that is legacy/partly-chunked would otherwise fall into the refusePartial branch
          // below, discarding the notice and implying a single-doc scope the user never chose. In that
          // case (or 0 / several matches) we ask the user to pick one instead — the user's pick then
          // hits the honest single-doc refusal on its own. Deterministic; no model call.
          const triggers = getSkill(ctx.db, turnSkill.installId)?.manifest.triggers
          const candidates = triggers ? inScope.filter((d) => matchesSkillDocSignals(triggers, d)) : []
          const chosen = candidates.length === 1 ? candidates[0] : null
          const narrowedScope = chosen ? { ...scope, collectionIds: null, documentIds: [chosen.id] } : null
          if (chosen && narrowedScope && allInScopeDocsFullyChunked(ctx.db, narrowedScope)) {
            // Narrow WITHIN the resolved scope (mirrors the filename auto-scope above). `applies()` below
            // is now true and the fully-chunked gate passes, so the ordinary dispatch runs and prepends
            // `scopeNotice` to its answer (the grounded path carries it via `answerPrefix`).
            scope = narrowedScope
            scopeNotice = tMain('skills.analysis.scopeNarrowed', { title: chosen.title, count: inScope.length - 1 })
          } else {
            return routeAnswer('Document analysis routing', tMain('skills.analysis.selectOne', { count: inScope.length }))
          }
        }
      }

      // A4 (SKA-7 structural, audit §3.2/§8.2): does the turn skill's engine ENGAGE this (possibly
      // W2-narrowed) scope? TWO ways in:
      //   (1) `applies()` — the ordinary gate (a bank/invoice VOCABULARY question, or A3's any-non-chatter
      //       whole-doc/compare question, over the right doc count); OR
      //   (2) the TOOL-skill single-doc INVERSION: `applies()` is false (a phrasing MISS) but the ONE
      //       in-scope FULLY-CHUNKED document plausibly belongs to the skill's class (`classMatches` —
      //       manifest doc signals or a prior extraction) and the question is NOT small talk. This finishes
      //       the inversion for bank/invoice: an on-topic money question that misses the ~45-term vocabulary
      //       is answered from the VERIFIED extract (grounded-data narrates; post-W6 it honestly declines an
      //       off-data question) instead of silently degrading to raw top-k chunks + model arithmetic (the
      //       pre-W3 incident class). Only the exhaustive tool handlers define `classMatches`; requiring
      //       fully-chunked here means a phrasing miss over a legacy/partly-chunked doc falls through to
      //       relevance (its pre-A4 behaviour), never a refusal. A doc matching NO signal (and with no prior
      //       extraction) keeps the phrasing gate (the W2 plausibility posture, inverted). No new capability
      //       and no new model call (SEC-1): it changes WHICH questions reach an already-app-owned handler.
      const analysisApplies =
        skill != null && analysisHandler != null && analysisHandler.applies({ question: text, scope, db: ctx.db })
      const toolSkillInverts =
        skill != null &&
        analysisHandler != null &&
        typeof analysisHandler.classMatches === 'function' &&
        !analysisApplies &&
        !isSmallTalk(text) &&
        allInScopeDocsFullyChunked(ctx.db, scope) &&
        analysisHandler.classMatches({ question: text, scope, db: ctx.db }, skill.installId)

      if (skill && analysisHandler && (analysisApplies || toolSkillInverts)) {
        const turnSkill = skill
        // The D45/R4 exhaustiveness refusal (fixed localized message + the Re-index affordance, no model,
        // no partial answer), skill-stamped so the user sees which skill declined. Closured so BOTH the
        // grounded-whole-doc branch (which enforces it only for a non-downgraded whole read — SKA-23) and
        // the exhaustive/compare branch reuse one body. A `routing` handler is EXEMPT: it reads no content.
        // F2: on regenerate the destructive delete runs inside the runFn (slot held), restored on a
        // non-abort failure — symmetric with the chat channel.
        const refusePartial = (): Promise<Message> =>
          withChatStream(
            event,
            conversationId,
            'Document analysis refused',
            withRegenerateGuard(ctx.db, conversationId, isRegenerate, async (_signal, sendToken): Promise<Message> => {
              const refusal = tMain('skills.analysis.refusePartial')
              sendToken(refusal)
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

        // `grounded-whole-doc` (skill-whole-doc engine, Wave 2): an INSTRUCTION skill whose deliverable is
        // the MODEL's answer over the WHOLE document, formatted to the SKILL.md body (minutes, contract
        // brief, …). Stream a grounded answer where the context is the single in-scope document read IN
        // ORDER (not top-k) with the fence applied; coverage is the honest `capped` mode. `applies()`
        // guaranteed a single in-scope doc. SKA-23 (A4): the D45 refusal is evaluated INSIDE this branch,
        // AFTER the needle downgrade — so a downgraded needle reaches top-k rather than a refusal.
        if (analysisHandler.mode === 'grounded-whole-doc') {
          const target = documentsInScope(ctx.db, scope, { requireChunks: true })[0]
          if (target) {
            const documentId = target.id
            // A3 needle-vs-deliverable downgrade (audit §8.2 (b)) + SKA-12/SKA-23 (A4). The whole-doc engine
            // is the DEFAULT, but a targeted single-fact LOOKUP over a document that would OVERFLOW the
            // whole-doc budget is better served by top-k — a needle past the truncation cut would be missed,
            // where relevance retrieval finds the passage wherever it sits. Reuses W1's exact budget calculus
            // (the de-overlapped token total vs `wholeDocumentFitBudgetTokens`). A DELIVERABLE ask never
            // downgrades — it keeps the whole read (W1's honest capped/tree path).
            //   - SKA-12: the `readyTreeCountInScope === 0` conjunct is GONE. A needle prefers top-k whenever
            //     the whole read would truncate, TREE OR NO TREE: a ~13-call map-reduce over lossy node
            //     summaries is worse for a single-fact lookup than one top-k retrieval (the tree keeps
            //     rescuing DELIVERABLES, which never reach this downgrade).
            //   - SKA-23: this is evaluated BEFORE the D45 fully-chunked refusal below. A downgraded needle
            //     takes the relevance path, which makes NO whole-document claim, so D45's premise (a partial
            //     WHOLE read passed off as complete) doesn't apply — a needle over a not-fully-chunked doc is
            //     served by top-k, not refused. A DELIVERABLE keeps the whole read and DOES hit the refusal.
            const needleDowngrade =
              isNeedleShaped(text) &&
              documentApproxTokenTotal(ctx.db, documentId) >
                wholeDocumentFitBudgetTokens(effectiveContextWindow(runtime, getSettings(ctx.db)), text, turnSkill)
            if (!needleDowngrade) {
              // Only a whole (capped/tree) read makes the whole-document claim → enforce the D45 refusal now.
              if (!allInScopeDocsFullyChunked(ctx.db, scope)) return refusePartial()
              return withChatStream(
                event,
                conversationId,
                'Document answer failed',
                withRegenerateGuard(ctx.db, conversationId, isRegenerate, (signal, sendToken, _sendReasoning, sendCompaction, sendUsage) =>
                  generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
                    signal,
                    onCompactionStart: sendCompaction,
                    // The real assembled-prompt usage (incl. the whole-document block) for the meter.
                    onPromptUsage: sendUsage,
                    scope,
                    reranker: ctx.reranker,
                    // The turn's skill fence rides in the grounded USER turn; the whole document is the
                    // context, so the assistant row carries the skill stamp + `capped` coverage.
                    skill: turnSkill,
                    wholeDocument: { documentId },
                    // U2 (audit §3.5): share-safe review injects a deterministic whole-document PII count
                    // summary into the prompt and gates its low-risk verdict on non-truncated coverage.
                    wholeDocumentPiiScan: analysisHandler.injectPiiScan === true,
                    onToken: sendToken,
                    // W2 (§2.1): when the scope was auto-narrowed to this doc, lead the streamed + persisted
                    // answer with the honest scope notice (undefined ⇒ byte-unchanged).
                    answerPrefix: scopeNotice ? `${scopeNotice}\n\n` : undefined
                  })),
                (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
              )
            }
            // needleDowngrade: fall through to the relevance (top-k) path below — no refusal (SKA-23).
          }
          // Defensive: applies() requires a single in-scope doc, so a missing target is unreachable; fall
          // through to the relevance path rather than fail the turn.
        } else {
          // exhaustive (bank/invoice) / compare / routing: the D45 refusal gates FIRST (routing exempt — it
          // reads no content), then the mode dispatch. (grounded-whole-doc handled its own refusal above.)
          if (analysisHandler.mode !== 'routing' && !allInScopeDocsFullyChunked(ctx.db, scope)) {
            return refusePartial()
          }

          // `grounded-whole-doc-compare` (Follow-up B, what-changed): a compare-shaped request over
          // EXACTLY TWO in-scope docs streams a model answer over BOTH documents read whole (budget
          // split across them) with the fence applied; coverage is `capped` (truncated when either
          // overflowed). `applies()` guaranteed exactly two in-scope docs; the fully-chunked refusal
          // above already gated both. (Needle downgrade stays single-doc — compare keeps its whole-both
          // read; existing residual, audit §3.3.)
          if (analysisHandler.mode === 'grounded-whole-doc-compare') {
            // The shared helper's deterministic `ORDER BY created_at, id` fixes the compare PAIR order
            // (audit §5.1): `[0]`→Document A, `[1]`→Document B is now import-order-stable, not the
            // undefined SQL row order the old private query left it. The prompt labels the pair A/B by
            // title + import date and NEVER asserts which is the older/newer version, so a wrong guess
            // can no longer invert a whole report.
            const documentIds = documentsInScope(ctx.db, scope, { requireChunks: true }).map((d) => d.id)
            if (documentIds.length === 2) {
              return withChatStream(
                event,
                conversationId,
                'Document answer failed',
                withRegenerateGuard(ctx.db, conversationId, isRegenerate, (signal, sendToken, _sendReasoning, sendCompaction, sendUsage) =>
                  generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
                    signal,
                    onCompactionStart: sendCompaction,
                    onPromptUsage: sendUsage,
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
            const notice = scopeNotice
            return withChatStream(
              event,
              conversationId,
              'Document analysis failed',
              withRegenerateGuard(ctx.db, conversationId, isRegenerate, async (signal, sendToken, _sendReasoning, sendCompaction, sendUsage): Promise<Message> => {
                // U5 (audit §3.6): the exhaustive path runs a potentially long, SILENT deterministic
                // extraction before the first token — a "one-blob" answer that reads as a hang. Fire the
                // ephemeral "reading the document…" notice up front (the compaction-notice channel, an
                // 'analysis' kind); the renderer clears it on the first answer token, exactly like the
                // compaction hint. Ephemeral (R14) — never buffered, never persisted.
                sendCompaction('analysis')
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
                  readDocumentSegments,
                  // The chat slot's runtime — for the one sanctioned inline model sub-step (a
                  // prompt-supplied custom category set, result-tables Phase 1.5); see the ctx type.
                  runtime
                })
                // W2 plausibility gate (audit §4.5): the extractor found nothing on a document that doesn't
                // look like this skill's type — answer the user's ACTUAL question via the ordinary grounded
                // (relevance) path in the SAME locked slot, instead of the misleading empty template. The
                // turn's skill fence still rides along (parity with the ordinary document path below).
                if (result.fallThrough) {
                  return generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
                    signal,
                    onCompactionStart: sendCompaction,
                    onPromptUsage: sendUsage,
                    scope,
                    reranker: ctx.reranker,
                    skill: turnSkill,
                    onToken: sendToken
                  })
                }
                // W3 THIRD answer mode (audit §3.1/§8.1): the question is neither a format ask nor a
                // summary/reconcile/list shape, so instead of the fixed template the handler returned the
                // serialized VERIFIED extract — stream a model answer that NARRATES it (strict verbatim
                // rules, in the SAME locked slot), with the deterministic totals echoed beneath it. The
                // turn's skill fence + honest extract coverage/citations ride along (parity with the paths
                // above). The LLM never computes a figure; it reads the data the deterministic tools built.
                if (result.mode === 'grounded-data') {
                  return generateGroundedDataAnswer(
                    ctx.db,
                    runtime,
                    conversationId,
                    text,
                    {
                      dataBlock: result.dataBlock ?? '',
                      postscript: result.postscript ?? '',
                      citations: result.citations,
                      coverage: result.coverage
                    },
                    {
                      signal,
                      onCompactionStart: sendCompaction,
                      onPromptUsage: sendUsage,
                      onToken: sendToken,
                      skill: turnSkill,
                      // W2 (§2.1): carry the auto-narrow scope notice into the grounded-data path too.
                      answerPrefix: notice ? `${notice}\n\n` : undefined
                    }
                  )
                }
                // W2 (§2.1): when the scope was auto-narrowed to this doc, prepend the honest notice.
                const answer = notice ? `${notice}\n\n${result.answer}` : result.answer
                sendToken(answer)
                const msg = appendMessage(ctx.db, {
                  conversationId,
                  role: 'assistant',
                  content: answer,
                  citations: result.citations,
                  coverage: result.coverage,
                  skillId: turnSkill.installId,
                  autoFired: turnSkill.autoFired === true
                })
                // Phase 2 (result-tables §4): persist the answer's structured table keyed by the
                // just-appended message and light the flag on the returned object, so the renderer's
                // "Export CSV" action shows without a reload. Best-effort — a table that fails to
                // persist (over-cap / serialization fault) never blocks the answer itself.
                if (result.table) {
                  try {
                    if (saveResultTable(ctx.db, {
                      messageId: msg.id,
                      conversationId,
                      table: result.table,
                      source: turnSkill.installId
                    })) {
                      msg.hasResultTable = true
                    }
                  } catch {
                    log.warn('Result-table persist failed', { messageId: msg.id })
                  }
                }
                return msg
              }),
              (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
            )
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
        documentCount: documentsInScope(ctx.db, scope, { requireChunks: true }).length,
        treeAvailable: readyTreeCountInScope(ctx.db, scope) > 0,
        extractAvailable: extractionsExistInScope(ctx.db, scope)
      })
      if (decision.engine === 'coverage-extract' && decision.recordType) {
        const recordType: ExtractRecordType = decision.recordType
        const listing = aggregateExtractions(ctx.db, scope, recordType)
        // A3: a needle ask under an active whole-doc skill can be DOWNGRADED off the whole-doc engine
        // (grounded-whole-doc block above) and land HERE — and it may have been auto-narrowed by the W2
        // pre-pass first (`scopeNotice` set, `scope` reduced to one doc). Lead the honest scope notice so a
        // per-doc count never reads as covering the whole multi-doc scope, and stamp the skill so the turn
        // keeps its provenance glyph (A1). `scopeNotice` is null and `skill` undefined on every ordinary
        // (non-skill / non-narrowed) coverage-extract turn, so this is byte-unchanged there.
        const listingAnswer = buildListingAnswer(ctx.db, listing, (key, params) => tMain(key, params))
        const answer = scopeNotice ? `${scopeNotice}\n\n${listingAnswer}` : listingAnswer
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
              content: answer,
              skillId: skill?.installId,
              autoFired: skill?.autoFired === true
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
        withRegenerateGuard(ctx.db, conversationId, isRegenerate, (signal, sendToken, _sendReasoning, sendCompaction, sendUsage) =>
          generateGroundedAnswer(ctx.db, runtime, ctx.embedder, conversationId, text, settings, {
            signal,
            // One-shot ephemeral "summarizing…" notice when the compaction pre-pass starts (§5.2);
            // isDestroyed-guarded inside withChatStream, never buffered (R14).
            onCompactionStart: sendCompaction,
            // The real assembled-prompt usage (incl. the retrieved excerpt block) for the meter.
            onPromptUsage: sendUsage,
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
            // A3: a needle ask that was auto-narrowed to one doc (W2) and then downgraded off the
            // whole-doc engine reaches HERE — lead the honest scope notice so the narrowing stays
            // visible. `scopeNotice` is null on every other route into this path (byte-unchanged).
            answerPrefix: scopeNotice ? `${scopeNotice}\n\n` : undefined,
            onToken: sendToken
          })),
        (signal) => ctx.docTasks?.acquireChatSlot(signal) ?? Promise.resolve(() => {})
      )
    }
  )
}
