import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n'
import { type Db, prepareCached } from './db'
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type ChatDepthMode,
  type Citation,
  type Conversation,
  type ConversationSearchHit,
  type ContextUsage,
  type ConversationSearchResult,
  type CoverageInfo,
  type DocumentScope,
  type Message
} from '../../shared/types'
import { parseDocumentScope } from './collections'
import { buildFtsMatchQuery } from './fts'
import { approxTokenCount } from './ingestion/chunker'
import { getSettings } from './settings'
import {
  approxPromptTokens,
  buildSkillFence,
  composeSystemPromptWithSkill,
  logSkillFenceReduction,
  skillFenceBudgetTokens,
  stripSkillFenceEcho
} from './skills/prompt'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from './runtime'
import { requestParamsForMode } from './runtime/llama'
import { ensureCompacted } from './chat/compaction'
import { log } from './logging'

/**
 * The ONE skill resolved for a turn (skills plan §10) — the minimal shape the chat/RAG
 * generators need to assemble the fence + stamp `messages.skill_id`. Built by
 * `resolveTurnSkill` (services/skills/turn.ts); structurally compatible without an import.
 */
export interface TurnSkill {
  installId: string
  title: string
  body: string
  /**
   * True only when the app AUTO-FIRED this skill (S13b/D3) — the user set no skill and the resolver
   * filled the gap. `resolveAutoFireSkill` sets it; an explicit pick / sticky default leaves it
   * undefined. Carried so the assistant row can be stamped (`messages.auto_fired`) and the per-turn
   * "answer without it" undo (S13c) shows ONLY on an auto-fired turn.
   */
  autoFired?: boolean
}

// Chat service (spec §7.6): create conversations, append user/assistant messages,
// build the system prompt + message list for the runtime, stream the response, and
// persist history. All local — no network. IDs are UUID v4, timestamps ISO-8601 UTC
// (BUILD_STATE §7 conventions). The system prompt is built per-request and NOT
// persisted; the messages table holds only user/assistant turns.

// Persist-canonical English (i18n boundary rule 1): written into conversations.title
// AND exact-matched by maybeSetTitleFromFirstMessage below, so the value must never
// localize at persist time — the renderer display map translates it (D-L4).
const DEFAULT_TITLE = t('en', 'main.chat.defaultTitle')

// Base system prompt — the PLAIN-CHAT preamble. Revised 2026-07-01 (owner-approved, from D:\ chat
// testing) from the original spec §7.6 wording, which was destroying the chat UX: small local models
// latched onto its "You do not have internet access. / You must not claim to have accessed external
// services." lines and prefaced almost every answer with offline/no-internet/training-cutoff
// disclaimers, and its DOCUMENT-grounding lines ("answer only from the context… / include citations…")
// leaked into plain chat, so the model REFUSED general-knowledge questions and pushed "upload a
// document" (see the sample transcript). Those grounding rules belong ONLY to the grounded path and
// already live, in full, in rag/index.ts `GROUNDING_RULES` (appended to this base as
// `GROUNDED_SYSTEM_PROMPT`) — so removing them here loses nothing for RAG and fixes plain chat. This
// base now tells the model to answer general questions directly from its own knowledge, stay honest
// about uncertainty WITHOUT per-turn disclaimers, and keeps the one load-bearing guardrail (never
// claim to have browsed / accessed data it wasn't given). RAG still appends `GROUNDING_RULES`; a
// more-specific, later instruction, it governs document questions.
export const BASE_SYSTEM_PROMPT = `You are HilbertRaum, a private assistant that runs locally and offline on the user's own computer.
Be helpful, accurate, and honest about uncertainty.
Answer general questions directly and fully from your own knowledge. If a specific fact is uncertain or may be out of date, note that briefly where it matters.
Do not open answers with disclaimers about being offline, lacking internet access, or a training cutoff, and do not tell the user to upload documents — the user already knows this app runs locally and privately.
Never claim to have searched the web, browsed, or opened files you were not given — you have not.
Respond in the language the user writes in.`

/**
 * Build the plain-chat system prompt (document answers compose their own in rag/). When a
 * skill fence is supplied it is bracketed AFTER the base preamble — the base rules above, the
 * fence's own guard line as the last app-authored line below — so the untrusted skill text never
 * reads as a top-level rule (skills plan §11.2). `skillFence` null/omitted ⇒ the base preamble.
 */
export function buildSystemPrompt(skillFence?: string | null): string {
  return composeSystemPromptWithSkill(BASE_SYSTEM_PROMPT, skillFence ?? null)
}

/**
 * Remove `<think>…</think>` reasoning blocks (including an unclosed trailing block
 * from a stream stopped mid-thought) from assistant text (architecture.md "Chat &
 * streaming").
 *
 * Reasoning must never persist and must never be fed back as history (Qwen guidance:
 * think blocks confuse the model when replayed). The normal path already separates
 * reasoning out of the answer stream (`--reasoning-format deepseek` →
 * `delta.reasoning_content`), so this is defense-in-depth: it catches inline tags
 * from a differently configured server and scrubs any legacy persisted rows.
 * Untouched text returns as-is; when blocks were removed the seams are trimmed.
 */
export function stripThinkBlocks(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '')
  return stripped === text ? text : stripped.trim()
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * True when a streaming error is the result of a user Stop (an aborted signal)
 * rather than a real failure. The mock runtime returns cleanly on abort, but a real
 * `fetch`-backed runtime rejects the in-flight request with an `AbortError` — both
 * must be treated as a normal end so the partial reply is still persisted.
 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && err.name === 'AbortError'
}

interface ConversationRow {
  id: string
  title: string
  created_at: string
  updated_at: string
  model_id: string | null
  mode: string
  scope_json: string | null
  collection_id: string | null
  scope_v2_json: string | null
  active_skill_id: string | null
}

/** Parse a stored scope: a JSON array of document-id strings, else null (whole corpus). */
function parseScope(json: string | null): string[] | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    if (Array.isArray(v)) {
      const ids = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
      return ids.length > 0 ? ids : null
    }
  } catch {
    // Malformed scope must never break a conversation — fall through to unscoped.
  }
  return null
}

/** Normalize a caller-supplied scope: empty/non-string-bearing arrays become null. */
function normalizeScope(ids: string[] | null | undefined): string[] | null {
  if (!ids) return null
  const clean = ids.filter((x) => typeof x === 'string' && x.length > 0)
  return clean.length > 0 ? clean : null
}

/** Serialize a composite scope for `scope_v2_json` (null clears it). Empty scope persists. */
function serializeDocumentScope(scope: DocumentScope | null | undefined): string | null {
  if (!scope) return null
  return JSON.stringify({
    collectionIds: scope.collectionIds ?? [],
    documentIds: scope.documentIds ?? [],
    ...(scope.includeArchived ? { includeArchived: true } : {})
  })
}

function rowToConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    modelId: r.model_id,
    mode: r.mode === 'documents' ? 'documents' : 'chat',
    scopeDocumentIds: parseScope(r.scope_json),
    collectionId: r.collection_id ?? null,
    // Composite scope (D1) — tolerant parse, malformed ⇒ null (legacy fallback applies).
    scope: parseDocumentScope(r.scope_v2_json),
    activeSkillId: r.active_skill_id ?? null
  }
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  created_at: string
  token_count: number | null
  citations_json: string | null
  skill_id: string | null
  /** From the LEFT JOIN on `skills`: NULL when the stamped skill no longer exists (deleted). */
  skill_title: string | null
  /** S13c — 1 when the app auto-fired the stamped skill (else NULL/0). Powers the per-turn undo. */
  auto_fired: number | null
  /** Full-doc-skills Phase 1 — JSON-serialized `CoverageInfo` (D48), or NULL (legacy/no coverage). */
  coverage_json: string | null
  /** 1 when this assistant reply was cut off at the context ceiling (finish_reason 'length'); else NULL/0. */
  truncated: number | null
}

/**
 * Validate one parsed element against the `Citation` shape: `label`/`sourceTitle` required
 * strings, the rest optional. A structurally wrong-but-valid-JSON payload (e.g. a stale or
 * hand-edited row) must not flow untyped to the renderer (L6) — mirrors `parseScope`.
 */
function isCitation(v: unknown): v is Citation {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  if (typeof c.label !== 'string' || typeof c.sourceTitle !== 'string') return false
  if (c.pageNumber != null && typeof c.pageNumber !== 'number') return false
  if (c.section != null && typeof c.section !== 'string') return false
  if (c.snippet != null && typeof c.snippet !== 'string') return false
  return true
}

/** Parse stored citations: a JSON array of `Citation`s, else undefined. Validates shape. */
function parseCitations(json: string | null): Citation[] | undefined {
  if (!json) return undefined
  try {
    const v = JSON.parse(json) as unknown
    if (!Array.isArray(v)) return undefined
    const valid = v.filter(isCitation)
    return valid.length > 0 ? valid : undefined
  } catch {
    // A malformed payload must never break rendering a conversation — drop the citations.
    return undefined
  }
}

/**
 * Parse stored coverage: a JSON object carrying at least a `mode` string, else undefined. Mirrors
 * `parseCitations` — a malformed/legacy (NULL) payload must never break rendering a conversation, so
 * it degrades to undefined and the renderer falls back to the relevance badge. Counts default to 0 so
 * a partially-shaped payload still satisfies the `CoverageInfo` contract.
 */
function parseCoverage(json: string | null): CoverageInfo | undefined {
  if (!json) return undefined
  try {
    const v = JSON.parse(json) as unknown
    if (typeof v !== 'object' || v === null) return undefined
    const c = v as Record<string, unknown>
    if (typeof c.mode !== 'string') return undefined
    // Preserve any extra optional fields (treeStatus, tier, unparsedChunks, …) as-stored, but
    // guarantee the three required keys so a partial payload still satisfies the contract.
    return {
      ...(c as unknown as CoverageInfo),
      mode: c.mode as CoverageInfo['mode'],
      chunksCovered: typeof c.chunksCovered === 'number' ? c.chunksCovered : 0,
      chunksTotal: typeof c.chunksTotal === 'number' ? c.chunksTotal : 0
    }
  } catch {
    // A malformed payload must never break rendering a conversation — drop the coverage.
    return undefined
  }
}

/**
 * Serialize coverage for `messages.coverage_json` (the write side of `parseCoverage`). Null/omitted ⇒
 * NULL (the relevance fallback). Tolerant: a value that cannot stringify (cyclic/exotic) degrades to
 * NULL rather than failing the whole append — the answer itself must always persist.
 */
function serializeCoverage(coverage: CoverageInfo | null | undefined): string | null {
  if (!coverage) return null
  try {
    return JSON.stringify(coverage)
  } catch {
    return null
  }
}

function rowToMessage(r: MessageRow): Message {
  const citations = parseCitations(r.citations_json)
  const coverage = parseCoverage(r.coverage_json)
  // Resolve the stamped skill (DS16/§22-A5). SKA-38 (skills audit 2026-07-03, U6): key the provenance
  // off the PERSISTED `messages.skill_id`, NOT the JOIN-resolved title. `skillId` is the raw stamped
  // install id (present even when the skill row was later DELETED); `skillTitle` is the JOINed title,
  // NULL only when the skill is gone. The renderer renders a localized "(removed skill)" label for a
  // NULL-title-but-stamped turn — so deleting a skill no longer erases the glyph + the "answer without
  // it" undo from an already-stamped turn (a DISABLED skill already kept both — this makes DELETED
  // consistent). Auto-fire provenance follows the stamp, not the join.
  const hasStamp = r.skill_id != null
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role === 'user' || r.role === 'assistant' ? r.role : 'system',
    content: r.content,
    createdAt: r.created_at,
    tokenCount: r.token_count,
    citations,
    skillId: r.skill_id,
    skillTitle: r.skill_title,
    autoFired: hasStamp ? r.auto_fired === 1 : false,
    coverage,
    // Only surface truncation as a positive flag (undefined on complete replies / user turns), so a
    // pre-migration NULL row and a normal reply both read exactly as before.
    truncated: r.truncated === 1 ? true : undefined
  }
}

export interface CreateConversationOptions {
  title?: string
  modelId?: string | null
  mode?: 'chat' | 'documents'
  /**
   * "Ask selected documents" scope (spec §10.4): retrieval for this conversation
   * only searches these documents. Null/empty = the whole corpus. Only meaningful
   * for `mode: 'documents'`.
   */
  scopeDocumentIds?: string[] | null
  /**
   * Creation-anchor project (document-organization plan §13.4): the project a chat is
   * started inside. Persisted in `conversations.collection_id`; used for list grouping
   * and as the legacy single-project scope fallback.
   */
  collectionId?: string | null
  /**
   * The persisted composite source scope (D1). When given it is authoritative over the
   * legacy `scopeDocumentIds`/`collectionId` interpretation. An empty scope is the
   * explicit "All documents" choice.
   */
  scope?: DocumentScope | null
}

/** Create a new conversation and persist it. */
export function createConversation(db: Db, opts: CreateConversationOptions = {}): Conversation {
  const now = nowIso()
  const scope = normalizeScope(opts.scopeDocumentIds)
  const collectionId = opts.collectionId ?? null
  const compositeScope = opts.scope ?? null
  const conv: Conversation = {
    id: randomUUID(),
    title: opts.title?.trim() || DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    modelId: opts.modelId ?? null,
    mode: opts.mode ?? 'chat',
    scopeDocumentIds: scope,
    collectionId,
    scope: compositeScope,
    activeSkillId: null
  }
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, model_id, mode, scope_json, collection_id, scope_v2_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    conv.id,
    conv.title,
    conv.createdAt,
    conv.updatedAt,
    conv.modelId,
    conv.mode,
    scope ? JSON.stringify(scope) : null,
    collectionId,
    serializeDocumentScope(compositeScope)
  )
  return conv
}

/**
 * Persist a conversation's composite source scope (document-organization plan §8.3/D1) to
 * `scope_v2_json`. Null clears it (back to the legacy/Library interpretation); an empty
 * `DocumentScope` persists as the explicit "All documents" choice. Does NOT touch the
 * legacy `scope_json` (temp attachments never ride it — H4/C3). Returns the updated
 * conversation.
 */
export function setScope(
  db: Db,
  conversationId: string,
  scope: DocumentScope | null
): Conversation {
  const conv = getConversation(db, conversationId)
  if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)
  db.prepare('UPDATE conversations SET scope_v2_json = ? WHERE id = ?').run(
    serializeDocumentScope(scope),
    conversationId
  )
  return { ...conv, scope }
}

/**
 * Persist a conversation's creation-anchor project (plan §13.4) to `conversations.
 * collection_id`. Null clears it (an unscoped/Library chat). Returns the updated
 * conversation.
 */
export function setConversationCollection(
  db: Db,
  conversationId: string,
  collectionId: string | null
): Conversation {
  const conv = getConversation(db, conversationId)
  if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)
  db.prepare('UPDATE conversations SET collection_id = ? WHERE id = ?').run(
    collectionId,
    conversationId
  )
  return { ...conv, collectionId }
}

/**
 * Replace a conversation's document scope (chip removal in the UI). Null/empty clears
 * the scope back to "whole corpus". Returns the updated conversation.
 */
export function updateConversationScope(
  db: Db,
  conversationId: string,
  documentIds: string[] | null
): Conversation {
  const conv = getConversation(db, conversationId)
  if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)
  const scope = normalizeScope(documentIds)
  db.prepare('UPDATE conversations SET scope_json = ? WHERE id = ?').run(
    scope ? JSON.stringify(scope) : null,
    conversationId
  )
  return { ...conv, scopeDocumentIds: scope }
}

/** List conversations, most recently updated first. */
export function listConversations(db: Db): Conversation[] {
  const rows = prepareCached(db, 'SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC')
    .all() as unknown as ConversationRow[]
  return rows.map(rowToConversation)
}

export function getConversation(db: Db, conversationId: string): Conversation | null {
  const row = prepareCached(db, 'SELECT * FROM conversations WHERE id = ?')
    .get(conversationId) as unknown as ConversationRow | undefined
  return row ? rowToConversation(row) : null
}

/**
 * List a conversation's messages in insertion order. `created_at` may collide at
 * millisecond resolution, so `rowid` is the tiebreaker that guarantees turn order.
 *
 * Compaction checkpoint rows (`kind='compaction'`, context-compaction-plan §4.4) are
 * EXCLUDED: they are machine context, not user turns, so the renderer transcript, export,
 * and skill-fence sizing all see only real user/assistant messages (R8). The summary they
 * hold reaches the model only as the synthetic pair `buildChatMessages` injects.
 */
export function listMessages(db: Db, conversationId: string): Message[] {
  const rows = prepareCached(
    db,
    `SELECT m.*, s.title AS skill_title
       FROM messages m LEFT JOIN skills s ON s.install_id = m.skill_id
       WHERE m.conversation_id = ? AND m.kind IS NOT 'compaction'
       ORDER BY m.created_at ASC, m.rowid ASC`
  ).all(conversationId) as unknown as MessageRow[]
  return rows.map(rowToMessage)
}

/** One stored user/assistant turn with its `rowid` — the assembly/compaction unit (§4.4). */
export interface ConversationTurn {
  rowid: number
  role: 'user' | 'assistant'
  content: string
}

/**
 * A compaction checkpoint (context-compaction-plan §4.4): the cached summary of the older turns
 * it subsumes. `coversThroughRowid` is the max `messages.rowid` the summary replaces — assembly
 * replays only turns after it, and the next compaction folds this summary in (chained, §4.7).
 */
export interface Checkpoint {
  rowid: number
  summary: string
  coversThroughRowid: number
}

/**
 * Read a conversation's user/assistant turns (checkpoint rows excluded) in order, optionally only
 * those with `rowid > afterRowid` — the post-checkpoint replay window. Raw stored content (think
 * blocks are scrubbed by the caller at assembly/summarization time). Powers both the assembly path
 * and the compaction pre-pass; the checkpoint is always built from these STORED RAW turns (R-RAG),
 * never a transient grounded prompt.
 */
export function listConversationTurns(
  db: Db,
  conversationId: string,
  afterRowid = 0
): ConversationTurn[] {
  const rows = prepareCached(
    db,
    `SELECT m.rowid AS rowid, m.role AS role, m.content AS content
       FROM messages m
       WHERE m.conversation_id = ? AND m.rowid > ? AND m.kind IS NOT 'compaction'
       ORDER BY m.created_at ASC, m.rowid ASC`
  ).all(conversationId, afterRowid) as unknown as Array<{
    rowid: number
    role: string
    content: string
  }>
  return rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ rowid: r.rowid, role: r.role as 'user' | 'assistant', content: r.content }))
}

/** The latest compaction checkpoint for a conversation, or null when none has been cut. */
export function getLatestCheckpoint(db: Db, conversationId: string): Checkpoint | null {
  const row = prepareCached(
    db,
    `SELECT m.rowid AS rowid, m.content AS content, m.covers_through_rowid AS covers
       FROM messages m
       WHERE m.conversation_id = ? AND m.kind = 'compaction'
       ORDER BY m.rowid DESC LIMIT 1`
  ).get(conversationId) as unknown as
    | { rowid: number; content: string; covers: number | null }
    | undefined
  if (!row) return null
  return { rowid: row.rowid, summary: row.content, coversThroughRowid: row.covers ?? 0 }
}

/**
 * Persist a compaction checkpoint (context-compaction-plan §4.4). A dedicated `kind='compaction'`
 * row (role `system` semantics, never skill-stamped — R3) so history replay is a pure read. Does
 * NOT bump `conversations.updated_at`: a checkpoint is internal context, not a user action, and
 * must not reorder the sidebar.
 */
export function writeCheckpoint(
  db: Db,
  input: { conversationId: string; summary: string; coversThroughRowid: number }
): void {
  prepareCached(
    db,
    `INSERT INTO messages
       (id, conversation_id, role, content, created_at, token_count, citations_json,
        skill_id, auto_fired, coverage_json, kind, covers_through_rowid)
     VALUES (?, ?, 'system', ?, ?, NULL, NULL, NULL, NULL, NULL, 'compaction', ?)`
  ).run(randomUUID(), input.conversationId, input.summary, nowIso(), input.coversThroughRowid)
}

/**
 * Whether conversation compaction is enabled (context-compaction plan §5.4 / D-a, default true).
 * Gates BOTH the `ensureCompacted` pre-pass (no new checkpoints when off) and checkpoint reads in
 * assembly (`buildChatMessages` / `buildGroundedChatMessages` ignore any existing checkpoint when
 * off), so disabling reproduces the pre-feature L1-only behaviour exactly.
 */
export function compactionEnabled(db: Db): boolean {
  return getSettings(db).chatCompactionEnabled !== false
}

/**
 * Where the transcript summary marker sits (context-compaction plan §5.3, D-b). Returns the latest
 * checkpoint's summary text plus the id of the first RENDERED turn it does NOT subsume (the marker
 * renders before that message), or null when no checkpoint exists OR compaction is disabled (so the
 * marker never shows for a checkpoint the assembly is ignoring). `beforeMessageId` is null only when
 * the checkpoint covers every currently-rendered turn (degenerate; the renderer then omits it).
 */
export function getConversationSummaryMarker(
  db: Db,
  conversationId: string
): { summary: string; beforeMessageId: string | null } | null {
  if (!compactionEnabled(db)) return null
  const checkpoint = getLatestCheckpoint(db, conversationId)
  if (!checkpoint) return null
  const row = prepareCached(
    db,
    `SELECT id FROM messages
       WHERE conversation_id = ? AND kind IS NOT 'compaction' AND rowid > ?
       ORDER BY rowid ASC LIMIT 1`
  ).get(conversationId, checkpoint.coversThroughRowid) as unknown as { id: string } | undefined
  return { summary: checkpoint.summary, beforeMessageId: row?.id ?? null }
}

// §4.5 — a compaction summary is injected into the assembled prompt as a synthetic user→assistant
// pair, NOT a second leading `system` message (several local chat templates accept only one leading
// system block, and `collapseToAlternating` assumes leading-system-then-strict-alternation). The
// pair is alternation-safe and keeps the real leading system prompt BYTE-stable so its KV cache
// (`cache_prompt`, RT-2) is still reused. It is built at request time, NEVER persisted as real
// messages, and never skill-stamped (R3). Internal prompt text → English (not user-facing copy).
export const COMPACTION_SUMMARY_INTRO = 'Here is a summary of our earlier conversation so far:'
export const COMPACTION_SUMMARY_ACK = "Understood — I'll continue with that context in mind."

/** Build the synthetic summary pair (§4.5) injected at the start of the retained window. */
export function compactionSummaryPair(summary: string): ChatMessage[] {
  return [
    { role: 'user', content: `${COMPACTION_SUMMARY_INTRO}\n\n${summary}` },
    { role: 'assistant', content: COMPACTION_SUMMARY_ACK }
  ]
}

export interface AppendMessageInput {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  tokenCount?: number | null
  citations?: Citation[] | null
  /**
   * The skill that shaped THIS turn (skills plan §8.2/DS16) — stamped on the ASSISTANT row only,
   * and only when the fence was actually placed (the glyph corresponds 1:1 to a turn whose prompt
   * carried the skill — §22-A5). Omitted/null ⇒ no skill. No FK into `skills` (audit C3): a deleted
   * skill leaves this id dangling and the glyph read resolves it to NULL.
   */
  skillId?: string | null
  /**
   * S13c — true only when the app AUTO-FIRED `skillId` (the user set no skill). Stamped only alongside
   * a non-null `skillId`; surfaces the per-turn "answer without it" undo. Privacy-safe (a boolean).
   */
  autoFired?: boolean
  /**
   * The honest breadth behind an assistant answer (full-doc-skills plan §3.3/D48), persisted to
   * `messages.coverage_json`. Omitted/null ⇒ NULL, and the renderer falls back to the relevance
   * badge — so today's plain retrieval turns stay byte-identical. Counts/mode only, never content.
   */
  coverage?: CoverageInfo | null
  /**
   * True when this assistant reply was cut off at the token/context ceiling (finish_reason 'length',
   * §L0 honest-signal). Stamped on assistant rows only; omitted/false ⇒ NULL (complete reply). Never
   * set on a user-initiated Stop (that partial is intentional and user-known, not a length overflow).
   */
  truncated?: boolean
}

/** Append a message and bump the conversation's updated_at. */
export function appendMessage(db: Db, input: AppendMessageInput): Message {
  const now = nowIso()
  const tokenCount = input.tokenCount ?? null
  const citationsJson = input.citations ? JSON.stringify(input.citations) : null
  // Coverage is best-effort metadata: a serialization fault must never block persisting the answer
  // itself (the round-trip read is already tolerant). Stringify defensively → NULL on any failure.
  const coverageJson = serializeCoverage(input.coverage)
  const skillId = input.skillId ?? null
  // Stamp auto-fire provenance only when a skill is actually stamped; 1 = auto-fired, NULL otherwise.
  const autoFired = skillId != null && input.autoFired === true
  const truncated = input.truncated === true
  const msg: Message = {
    id: randomUUID(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAt: now,
    tokenCount,
    citations: input.citations ?? undefined,
    skillId,
    autoFired,
    coverage: input.coverage ?? undefined,
    truncated: truncated ? true : undefined
  }
  prepareCached(
    db,
    `INSERT INTO messages (id, conversation_id, role, content, created_at, token_count, citations_json, skill_id, auto_fired, coverage_json, truncated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    msg.id,
    msg.conversationId,
    msg.role,
    msg.content,
    msg.createdAt,
    tokenCount,
    citationsJson,
    skillId,
    autoFired ? 1 : null,
    coverageJson,
    truncated ? 1 : null
  )
  prepareCached(db, 'UPDATE conversations SET updated_at = ? WHERE id = ?').run(
    now,
    input.conversationId
  )
  return msg
}

/**
 * Read a conversation's STICKY DEFAULT skill (`conversations.active_skill_id`, skills plan §10.1) —
 * the install_id pre-filled for the next turn, or null when none is set. Not a hard pin: any turn
 * can override or clear it, and past turns keep their own stamped `messages.skill_id`.
 */
export function getConversationDefaultSkill(db: Db, conversationId: string): string | null {
  const row = db
    .prepare('SELECT active_skill_id FROM conversations WHERE id = ?')
    .get(conversationId) as unknown as { active_skill_id: string | null } | undefined
  return row?.active_skill_id ?? null
}

/**
 * Persist a conversation's sticky default skill (skills plan §10.1). Null clears it. No existence
 * check on the skill here — the resolver (`resolveTurnSkill`) skips a disabled/missing default
 * gracefully, and the IPC layer validates before calling this.
 */
export function setConversationDefaultSkill(
  db: Db,
  conversationId: string,
  installId: string | null
): void {
  db.prepare('UPDATE conversations SET active_skill_id = ? WHERE id = ?').run(
    installId ?? null,
    conversationId
  )
}

/**
 * A snapshot of a deleted message, sufficient to re-insert it byte-faithfully via
 * `restoreMessage`. Powers the regenerate data-loss guard (F2, post-merge audit): the
 * destructive regenerate delete runs only after the stream slot is held, and the prior reply
 * is restored from this snapshot if generation then fails for a non-abort reason — so a failed
 * regenerate never leaves the turn answer-less.
 */
export interface DeletedMessage {
  readonly id: string
  readonly conversationId: string
  readonly role: string
  readonly content: string
  readonly createdAt: string
  readonly tokenCount: number | null
  readonly citationsJson: string | null
  readonly skillId: string | null
  readonly autoFired: number | null
  readonly coverageJson: string | null
  readonly kind: string | null
  readonly coversThroughRowid: number | null
  readonly truncated: number | null
}

interface DeletedMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  created_at: string
  token_count: number | null
  citations_json: string | null
  skill_id: string | null
  auto_fired: number | null
  coverage_json: string | null
  kind: string | null
  covers_through_rowid: number | null
  truncated: number | null
}

/**
 * Read-only precondition for "regenerate": is the conversation's last message an assistant turn
 * (so there is a prior reply to drop and re-stream)? Mirrors `deleteLastAssistantMessage`'s
 * last-message-must-be-assistant rule so the pre-stream "nothing to regenerate" bail and the
 * in-stream delete (F2) agree. Non-destructive — safe to call before the stream slot is held.
 */
export function hasRegenerableAssistantReply(db: Db, conversationId: string): boolean {
  const row = db
    .prepare(
      `SELECT role FROM messages WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(conversationId) as unknown as { role: string } | undefined
  return row?.role === 'assistant'
}

/**
 * Remove the conversation's last message IF it is an assistant turn (used by "regenerate") and
 * return a snapshot `restoreMessage` can re-insert byte-faithfully; returns null when the last
 * message is not an assistant turn (nothing deleted).
 *
 * Deliberately scoped to the LAST message, not the last *assistant* message: after
 * a failed generation the conversation ends in a user turn — deleting the most recent
 * assistant message would then permanently destroy the answer to a *previous* question.
 * In that case regenerate just re-streams from history without deleting anything.
 */
export function deleteLastAssistantMessage(db: Db, conversationId: string): DeletedMessage | null {
  const row = db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at, token_count, citations_json,
              skill_id, auto_fired, coverage_json, kind, covers_through_rowid, truncated
       FROM messages WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(conversationId) as unknown as DeletedMessageRow | undefined
  if (!row || row.role !== 'assistant') return null
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    tokenCount: row.token_count,
    citationsJson: row.citations_json,
    skillId: row.skill_id,
    autoFired: row.auto_fired,
    coverageJson: row.coverage_json,
    kind: row.kind,
    coversThroughRowid: row.covers_through_rowid,
    truncated: row.truncated
  }
}

/**
 * Re-insert a previously-deleted message exactly (same id, timestamp, citations, coverage, skill
 * stamp). Restores a regenerate's prior reply after a non-abort generation failure (F2). The
 * row keeps its original `created_at`, so it sorts back to the tail of the transcript; the FTS
 * triggers re-index it on insert. A fresh rowid is assigned (rowid is identity-free here — no
 * checkpoint coverage points at a tail assistant reply).
 */
export function restoreMessage(db: Db, m: DeletedMessage): void {
  prepareCached(
    db,
    `INSERT INTO messages
       (id, conversation_id, role, content, created_at, token_count, citations_json,
        skill_id, auto_fired, coverage_json, kind, covers_through_rowid, truncated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    m.id,
    m.conversationId,
    m.role,
    m.content,
    m.createdAt,
    m.tokenCount,
    m.citationsJson,
    m.skillId,
    m.autoFired,
    m.coverageJson,
    m.kind,
    m.coversThroughRowid,
    m.truncated
  )
}

/**
 * Delete a conversation and all of its messages (chat and document Q&A alike — a
 * documents conversation only references documents via persisted citations, so the
 * documents/chunks/embeddings tables are untouched). Messages go first: the FK has
 * no ON DELETE CASCADE and foreign_keys is ON.
 *
 * Atomicity (REL-4, full audit 2026-06-28): both deletes run in ONE transaction so a crash /
 * lock / SQLITE_BUSY past the 5 s busy_timeout BETWEEN them rolls back instead of leaving the
 * messages gone but the conversation row surviving — an empty thread that can't be repopulated
 * (compaction checkpoint rows live in `messages` too). Mirrors `deleteDocument`'s DATA-1 wrap.
 * Returns true when a conversation row was deleted.
 */
export function deleteConversation(db: Db, conversationId: string): boolean {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
    const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
    db.exec('COMMIT')
    return Number(result.changes) > 0
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* keep the original failure as the thrown error */
    }
    throw err
  }
}

/** Most message hits one search returns (across all conversations). */
export const SEARCH_DEFAULT_LIMIT = 40

/** snippet() context: tokens shown around the matched term(s). */
const SNIPPET_CONTEXT_TOKENS = 12

interface SearchRow {
  conversationId: string
  conversationTitle: string
  messageId: string
  role: string
  snippet: string
  createdAt: string
}

/**
 * Full-text search across all conversations. The query is sanitized through the
 * shared `buildFtsMatchQuery` (FTS5 operators in user text never reach MATCH raw);
 * hits are ranked bm25 with a newest-first tie-break and grouped by conversation,
 * conversations ordered by their best hit. Snippets come from FTS5's snippet(),
 * matched terms wrapped in the SEARCH_MARK_* control characters for renderer-side
 * highlighting.
 *
 * Privacy: queries and snippets are CONTENT — callers must never log or audit them.
 */
export function searchMessages(
  db: Db,
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT
): ConversationSearchResult[] {
  if (limit <= 0) return []
  const match = buildFtsMatchQuery(query)
  if (!match) return []
  const rows = db
    .prepare(
      `SELECT m.conversation_id AS conversationId, c.title AS conversationTitle,
              m.id AS messageId, m.role AS role, m.created_at AS createdAt,
              snippet(messages_fts, 0, ?, ?, '…', ${SNIPPET_CONTEXT_TOKENS}) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.message_id
       JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ?
       ORDER BY bm25(messages_fts), m.created_at DESC, m.rowid DESC
       LIMIT ?`
    )
    .all(SEARCH_MARK_START, SEARCH_MARK_END, match, limit) as unknown as SearchRow[]

  // Group by conversation, preserving rank order: a conversation appears where its
  // best hit ranked, and hits within it stay in their own (bm25, newest-first) order.
  const byConversation = new Map<string, ConversationSearchResult>()
  for (const row of rows) {
    const hit: ConversationSearchHit = {
      messageId: row.messageId,
      role: row.role === 'user' ? 'user' : 'assistant',
      snippet: row.snippet,
      createdAt: row.createdAt
    }
    const existing = byConversation.get(row.conversationId)
    if (existing) {
      existing.hits.push(hit)
    } else {
      byConversation.set(row.conversationId, {
        conversationId: row.conversationId,
        conversationTitle: row.conversationTitle,
        hits: [hit]
      })
    }
  }
  return [...byConversation.values()]
}

/**
 * Set the conversation title from its first user message when it is still the
 * default. Keeps the sidebar readable without a separate "rename" step.
 */
export function maybeSetTitleFromFirstMessage(db: Db, conversationId: string, content: string): void {
  const conv = getConversation(db, conversationId)
  if (!conv || conv.title !== DEFAULT_TITLE) return
  const title = content.trim().replace(/\s+/g, ' ').slice(0, 60) || DEFAULT_TITLE
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId)
}

/**
 * Render a conversation as a Markdown transcript for export (spec §7.6 "export chat
 * transcript"). Pure string assembly; the IPC layer handles the save dialog.
 */
export function exportTranscript(db: Db, conversationId: string): { title: string; markdown: string } {
  const conv = getConversation(db, conversationId)
  if (!conv) throw new Error(`Unknown conversation: ${conversationId}`)
  const messages = listMessages(db, conversationId)

  const lines: string[] = []
  lines.push(`# ${conv.title}`)
  lines.push('')
  lines.push(`_Exported from HilbertRaum on ${nowIso()} — local transcript, never uploaded._`)
  lines.push('')
  for (const m of messages) {
    lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'} (${m.createdAt})`)
    lines.push('')
    lines.push(m.content)
    if (m.citations && m.citations.length > 0) {
      lines.push('')
      lines.push('Sources:')
      for (const c of m.citations) {
        const where =
          c.pageNumber != null ? `, p. ${c.pageNumber}` : c.section ? `, ${c.section}` : ''
        lines.push(`- [${c.label}] ${c.sourceTitle}${where}`)
      }
    }
    lines.push('')
  }
  return { title: conv.title, markdown: lines.join('\n') }
}

// ---- Context-window budget (chat + RAG prompt assembly) -----------------------------
// The chat and grounded-answer message lists replay the WHOLE persisted history. Left
// unbounded, an accumulating conversation (or a single grounded turn carrying a large
// retrieved-chunk block) eventually assembles a prompt larger than the model's context
// window, and llama-server rejects the request with HTTP 400 `exceed_context_size_error`
// — the prompt never even reaches generation. `fitMessagesToContext` is the single owner
// of trimming the history to fit, used by both `buildChatMessages` (plain chat) and
// `buildGroundedChatMessages` (RAG). Doc-task windows have their own context budgets
// (doctasks/summary.ts); this covers the conversational path those budgets never touched.

/** Model tokens reserved for the streamed answer + chat-template chrome (so a fitted
 *  prompt still leaves room to generate; below this an answer would be truncated). */
export const CHAT_RESPONSE_RESERVE_TOKENS = 1024
/**
 * DESIRED output reserve for a whole-document ANALYSIS deliverable — the streamed map-reduce reduce
 * step (whole-doc engine, wholedoc-truncation-fix-plan §4 / Phase 2). A structured brief (a 9-section
 * contract analysis, minutes, a share-safe review) needs far more room than a conversational reply, so
 * the reduce aims for this instead of `CHAT_RESPONSE_RESERVE_TOKENS`. It is only a TARGET: the reduce
 * budget (`computeReduceBudget`, whole-doc-tree.ts) yields it back toward `CHAT_RESPONSE_RESERVE_TOKENS`
 * (never below — never worse than today) so the actual notes + this cap provably fit the launched
 * `n_ctx` at every context size. On a large window (≥ ~8 k) the deliverable gets the full reserve; on a
 * small window (4 k) it shrinks so whole-document coverage survives (the "output cut" residual — Phase 4).
 */
export const ANALYSIS_RESPONSE_RESERVE_TOKENS = 3072
/** Base real-tokens-per-whitespace-word rate for typical English/Latin prose. */
const CHAT_TOKENS_PER_WORD = 1.3
/**
 * Subword-density safety multiplier on top of the base word rate. A German machine-generated reply
 * tokenizes at ~1.5–2 real BPE tokens/word, so the 1.3 base UNDER-counts it: `fitMessagesToContext`
 * then keeps too much history, the real prompt runs larger than estimated, and the balanced path
 * (which sends no `max_tokens`) truncates the answer mid-word at the context ceiling — the exact
 * failure in the D:\ testing report (2026-07-01). Mirrors the RAG grounded-answer budget's ÷1.5
 * German safety (rag-design §15.1): leaning the whole chat budget conservative makes German trim +
 * compact a touch sooner (and the usage meter read truthfully high) rather than overflow. English
 * reads slightly high — acceptable for a meter that is labelled approximate and designed to warn
 * before the cliff. Effective rate: 1.3 × 1.5 ≈ 1.95 real tokens/word. */
const CHAT_TOKENS_PER_WORD_SAFETY = 1.5
/** Per-message overhead for role markers / delimiters the chat template adds. */
const PER_MESSAGE_OVERHEAD_TOKENS = 8

/**
 * Estimated model tokens for one message (word estimate scaled up + template chrome).
 *
 * RAG-7 (perf audit 2026-06-18): memoized by message-object identity. The count is a pure
 * function of `m.content` (never mutated), and the same `ChatMessage` objects are summed several
 * times within one turn — `fitMessagesToContext` costs each, then `getConversationContextUsage`
 * re-sums the SAME objects it returns — so a `WeakMap` cache skips the repeated `approxTokenCount`
 * regex/split scans while staying byte-identical (and GC'ing with the messages).
 */
const messageTokenCache = new WeakMap<ChatMessage, number>()
export function messageTokens(m: ChatMessage): number {
  const cached = messageTokenCache.get(m)
  if (cached !== undefined) return cached
  const tokens =
    Math.ceil(approxTokenCount(m.content) * CHAT_TOKENS_PER_WORD * CHAT_TOKENS_PER_WORD_SAFETY) +
    PER_MESSAGE_OVERHEAD_TOKENS
  messageTokenCache.set(m, tokens)
  return tokens
}

/**
 * The REAL context-window budget for prompt assembly (§L0). The runtime is launched with
 * `manifest.recommendedContextTokens || settings.contextTokens` as llama-server's
 * `--ctx-size`, which can DIVERGE from `settings.contextTokens` — trimming against the
 * setting alone risks an over-window HTTP 400 (window larger than the setting → we'd trim
 * too tight, wasting capacity) or, the other way, an overflow. So we budget against the
 * value the runtime actually reports, falling back to the setting only when the runtime
 * can't report one (a bare test stub without `contextWindow()`).
 */
export function effectiveContextWindow(
  runtime: Pick<ModelRuntime, 'contextWindow'>,
  settings: { contextTokens: number; contextTokensOverride?: number | null }
): number {
  const reported = runtime.contextWindow?.()
  if (reported != null && reported > 0) return reported
  // No launched window to report (bare test stub): honour the user's context-size override
  // (the value the next start will launch with) before the legacy fallback.
  return settings.contextTokensOverride ?? settings.contextTokens
}

/**
 * Resting-state context-window usage for the composer meter (context-compaction plan §5.1). Pure
 * read, no model call: assembles the conversation exactly as a turn would (`buildChatMessages` —
 * which honours the compaction toggle + any checkpoint) over the real launched `window`, then sums
 * the per-message ESTIMATE. `usedTokens` is therefore the same over-counting estimate the budget
 * uses (labelled approximate in the UI). `runtime` may be null (no model running) — the window then
 * falls back to `settings.contextTokens`. The skill fence is intentionally omitted: at rest there is
 * no pending turn/skill, and the meter is approximate.
 */
export function getConversationContextUsage(
  db: Db,
  runtime: Pick<ModelRuntime, 'contextWindow'> | null,
  conversationId: string
): ContextUsage {
  const settings = getSettings(db)
  const window = runtime
    ? effectiveContextWindow(runtime, settings)
    : (settings.contextTokensOverride ?? settings.contextTokens)
  const messages = buildChatMessages(db, conversationId, window)
  const usedTokens = messages.reduce((sum, m) => sum + messageTokens(m), 0)
  return { usedTokens, window }
}

/**
 * Trim an assembled (already role-alternating) message list to fit `contextTokens`,
 * keeping a contiguous, most-recent suffix of the conversation. Invariants:
 *   - Every leading `system` message is always kept (and counted) — the instructions.
 *   - The FINAL turn is always kept, even if it alone exceeds the budget: it is the
 *     user's current question (or the grounded prompt). Dropping it would answer the
 *     wrong thing; an unavoidable overflow is left to the runtime, which surfaces the
 *     friendly "too large for this model" error (chat-stream.ts).
 *   - Older turns are dropped oldest-first until the estimate fits. Keeping a contiguous
 *     tail preserves the strict user/assistant alternation the templates require.
 * `reserveTokens` holds back room for the answer (CHAT_RESPONSE_RESERVE_TOKENS default).
 */
export function fitMessagesToContext(
  messages: ChatMessage[],
  contextTokens: number,
  reserveTokens: number = CHAT_RESPONSE_RESERVE_TOKENS
): ChatMessage[] {
  const budget = Math.max(256, (Math.floor(contextTokens) || 0) - reserveTokens)
  let firstNonSystem = 0
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === 'system') {
    firstNonSystem++
  }
  const system = messages.slice(0, firstNonSystem)
  const turns = messages.slice(firstNonSystem)
  if (turns.length === 0) return messages

  let used = system.reduce((sum, m) => sum + messageTokens(m), 0)
  // The final turn is mandatory — add it first, then fill older turns newest→oldest.
  const last = turns[turns.length - 1]
  used += messageTokens(last)
  const keptReversed: ChatMessage[] = [last]
  for (let i = turns.length - 2; i >= 0; i--) {
    const cost = messageTokens(turns[i])
    if (used + cost > budget) break
    used += cost
    keptReversed.push(turns[i])
  }
  // Nothing was dropped → return the original array unchanged (cheap identity for tests).
  if (keptReversed.length === turns.length) return messages
  return [...system, ...keptReversed.reverse()]
}

/**
 * Build the runtime message list: system prompt + persisted history in order. When
 * `contextTokens` is given, the history is trimmed to fit the model context
 * (`fitMessagesToContext`); omitted ⇒ the full history (the pure builder, for tests).
 */
export function buildChatMessages(
  db: Db,
  conversationId: string,
  contextTokens?: number,
  skillFence?: string | null
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(skillFence) }]
  // L2 (context compaction): when a checkpoint exists, inject its summary as a synthetic
  // user→assistant pair (§4.5) and replay only the turns AFTER it — the cached summary stands in
  // for everything older. No checkpoint ⇒ replay the whole history, byte-identical to before. The
  // checkpoint row itself is never a turn (kind-filtered by listConversationTurns). The §5.4 toggle
  // gates the READ as well as the write (compactionEnabled): when off, any existing checkpoint is
  // ignored and the FULL history replays — byte-identical to the pre-feature L1-only app.
  const checkpoint = compactionEnabled(db) ? getLatestCheckpoint(db, conversationId) : null
  if (checkpoint) messages.push(...compactionSummaryPair(checkpoint.summary))
  for (const turn of listConversationTurns(db, conversationId, checkpoint?.coversThroughRowid ?? 0)) {
    // Assistant turns are scrubbed of think blocks before being replayed —
    // replayed reasoning confuses the model (see stripThinkBlocks).
    messages.push({
      role: turn.role,
      content: turn.role === 'assistant' ? stripThinkBlocks(turn.content) : turn.content
    })
  }
  const collapsed = collapseToAlternating(messages)
  return contextTokens == null ? collapsed : fitMessagesToContext(collapsed, contextTokens)
}

/**
 * Force strict user/assistant alternation (after the leading system message) before the
 * messages reach the model. A turn whose role repeats the previous kept turn — e.g.
 * consecutive USER turns left behind when an answer failed and persisted no assistant
 * reply — collapses to the LATEST of that run (stale orphans dropped). Several chat
 * templates (Mistral, Qwen tool-style) RAISE on non-alternating roles, which surfaced as
 * an HTTP 500 on the next turn; this keeps the conversation answerable regardless.
 */
export function collapseToAlternating(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      out.push(m)
      continue
    }
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      out[out.length - 1] = m
    } else {
      out.push(m)
    }
  }
  return out
}

export interface GenerateOptions {
  signal?: AbortSignal
  /** Called with each streamed token so the IPC layer can forward it to the renderer. */
  onToken?: (token: string) => void
  /** Answer-depth mode, forwarded to the runtime. Omitted = 'balanced'. */
  mode?: ChatDepthMode
  /** Called with each reasoning delta (Deep mode) — live display only, never persisted. */
  onReasoning?: (delta: string) => void
  runtimeOptions?: Pick<RuntimeChatOptions, 'maxTokens' | 'temperature'>
  /**
   * The skill resolved for this turn (skills plan §10/§11). When set, its instructions are
   * assembled into a budgeted, guard-bracketed fence in the system message, and the assistant row
   * is stamped with the install_id — but ONLY when the fence actually fit (omitted-for-budget ⇒ no
   * fence, no stamp, so the glyph corresponds 1:1 to a prompt that carried the skill — §22-A5/A6).
   */
  skill?: TurnSkill | null
  /**
   * Fired exactly once if the context-compaction pre-pass starts a summarization for this turn
   * (it adds latency before the first answer token). Phase 1 only plumbs the callback; the
   * `STREAM.compaction` UX channel that consumes it is Phase 2.
   */
  onCompactionStart?: () => void
  /**
   * Fired exactly once with the REAL assembled prompt's usage (the same over-counting estimate
   * the budget trims with, over the launched window) right before generation starts. The IPC
   * layer forwards it to the composer meter so the live bar reflects what the model actually
   * received — for plain chat that includes the skill fence + any checkpoint pair the renderer
   * estimate can't see; for grounded answers (rag/index.ts) it includes the whole injected
   * excerpt/document block.
   */
  onPromptUsage?: (usage: ContextUsage) => void
}

/**
 * Stream an assistant reply from the runtime for `conversationId`, forwarding each
 * token via `onToken`, then persist the (possibly partial, if aborted) assistant
 * message. The conversation history must already include the triggering user
 * message. Returns the persisted assistant Message.
 */
export async function generateAssistantMessage(
  db: Db,
  runtime: ModelRuntime,
  conversationId: string,
  opts: GenerateOptions = {}
): Promise<Message> {
  // Trim history to the model's context window so an accumulating conversation never
  // assembles a prompt the runtime rejects (HTTP 400 exceed_context_size_error). Budget
  // against the REAL launched window the runtime reports (§L0), not settings.contextTokens
  // (which can diverge from the model's actual --ctx-size).
  const contextTokens = effectiveContextWindow(runtime, getSettings(db))
  // L2 (context compaction): when the history approaches the window, summarize the older turns into
  // a cached checkpoint so assembly replays a compact summary + recent turns instead of dropping the
  // old ones outright. A no-op below threshold; any failure/abort falls back to today's L1 trim with
  // no user-visible error. Runs on the already-claimed chat slot as part of this turn (R4), honouring
  // the turn's AbortSignal, BEFORE assembly so buildChatMessages picks up any fresh checkpoint. Gated
  // by the §5.4 toggle: when off, no checkpoint is created and assembly ignores any existing one.
  if (compactionEnabled(db)) {
    await ensureCompacted(db, runtime, conversationId, contextTokens, {
      signal: opts.signal,
      onStart: opts.onCompactionStart
    })
  }
  // Pre-size the skill fence (§11.3/A6) BEFORE it goes in the system message so it can never
  // starve the base preamble or the final user turn — fitMessagesToContext only drops older
  // history. Stamp the assistant row only when the fence actually fit (skill shaped the answer).
  const fence = buildTurnFence(db, conversationId, opts.skill, contextTokens)
  const messages = buildChatMessages(db, conversationId, contextTokens, fence)
  // Meter honesty: report what the model actually receives (fitted history + system/fence),
  // in the same estimate currency the budget uses, so the live meter never under-reads a turn.
  opts.onPromptUsage?.({
    usedTokens: messages.reduce((sum, m) => sum + messageTokens(m), 0),
    window: contextTokens
  })
  let content = ''
  // Capture the completion's finish reason so we can honestly flag a reply the model cut off at the
  // token/context ceiling ('length') instead of persisting the mid-word partial as if complete
  // (§L0 honest-signal). A user Stop aborts before any final chunk, so this stays null → not
  // truncated (the abort partial is intentional and user-known).
  let finishReason: string | null = null
  const stream = runtime.chatStream(messages, {
    signal: opts.signal,
    mode: opts.mode,
    onReasoning: opts.onReasoning,
    onFinish: (reason) => {
      finishReason = reason
    },
    ...opts.runtimeOptions
  })
  try {
    for await (const token of stream) {
      content += token
      opts.onToken?.(token)
    }
  } catch (err) {
    // A user Stop aborts the stream; persist the partial text and return normally.
    // Any other error is a real failure and propagates to the IPC layer.
    if (!isAbortError(err, opts.signal)) throw err
  }
  // 'length' = the reply hit a ceiling and is cut off — but llama-server reports the SAME reason
  // for two very different ceilings: the model's context window AND a per-request `max_tokens`
  // cap (Fast mode caps at FAST_MAX_TOKENS). The badge claims "reached the model's context
  // limit", so flag ONLY the uncapped case: with a cap in effect the cap is what fired (prompt
  // fitting reserved ≥ CHAT_RESPONSE_RESERVE_TOKENS ≥ the Fast cap of answer room), and showing
  // the context-limit badge at 7% meter usage is exactly the false "context is full" signal the
  // 2026-07-04 user report described.
  const capTokens = opts.runtimeOptions?.maxTokens ?? requestParamsForMode(opts.mode).maxTokens
  const truncated = finishReason === 'length' && capTokens == null
  // Reasoning never reaches the DB: the runtime already streams it separately,
  // and any inline think block that slipped into the answer is stripped here.
  content = stripThinkBlocks(content)
  // Drop any skill-fence framing the model echoed back (e.g. a trailing "--- END LOCAL SKILL ---").
  content = stripSkillFenceEcho(content)
  // Persist whatever was produced — on a stop, that is the partial text so far. A stop
  // BEFORE the first token produced nothing: persist nothing (a permanent empty
  // assistant bubble in the transcript otherwise) and return an unpersisted, empty
  // message to keep the resolve contract.
  if (content === '') return emptyAssistantMessage(conversationId)
  try {
    // Stamp the skill only when its fence was actually placed (DS16/§22-A5) — an omitted-for-budget
    // skill did not shape this answer, so it gets no glyph.
    return appendMessage(db, {
      conversationId,
      role: 'assistant',
      content,
      skillId: fence ? (opts.skill?.installId ?? null) : null,
      // Carry auto-fire provenance only when the fence was placed (the skill shaped the answer) — so the
      // S13c undo lines up 1:1 with the glyph (§22-A5).
      autoFired: fence ? opts.skill?.autoFired === true : false,
      // Honest-signal flag: mark a reply the model cut off at the context ceiling ('length').
      truncated
    })
  } catch (err) {
    // R1 (full-audit-2026-06-30, Phase C) — defense-in-depth guard. The lock/quit teardown now
    // deterministically awaits this stream's settle BEFORE closing the DB (so on the live path the
    // partial persists first), but if the signal was aborted AND the DB is already closed, this is
    // a teardown that closed `ctx.db` under an aborted partial-persist: swallow it cleanly (the
    // partial is lost, not a crash) instead of rejecting into the global unhandled-rejection
    // handler. A genuine open-DB persistence error (constraint/disk) still propagates. Content is
    // never logged — only the conversation id + the reason.
    if (opts.signal?.aborted && !db.isOpen) {
      log.warn('chat: dropped partial reply — workspace locked during persist', { conversationId })
      return emptyAssistantMessage(conversationId)
    }
    throw err
  }
}

/**
 * Build the plain-chat skill fence for a turn, pre-sized to leave room for the base preamble + the
 * final user turn (audit A6). Returns the fence string, or null when there is no skill or the fence
 * was omitted for budget. Shared between the initial call site and the stamp decision so they
 * cannot disagree.
 */
function buildTurnFence(
  db: Db,
  conversationId: string,
  skill: TurnSkill | null | undefined,
  contextTokens: number
): string | null {
  if (!skill) return null
  const history = listMessages(db, conversationId)
  const finalTurn = history.length > 0 ? history[history.length - 1].content : ''
  const fixedTokens =
    approxPromptTokens(BASE_SYSTEM_PROMPT) +
    approxPromptTokens(finalTurn) +
    2 * PER_MESSAGE_OVERHEAD_TOKENS
  const budget = skillFenceBudgetTokens({
    contextTokens,
    reserveTokens: CHAT_RESPONSE_RESERVE_TOKENS,
    fixedTokens
  })
  const fence = buildSkillFence({ title: skill.title, body: skill.body }, budget)
  // U1 (audit §3.6): log a budget-driven trim/omit (ids/counts only) — the flags were discarded before,
  // making a decapitated-rule turn undiagnosable. The SKILL.md bodies now lead with the honesty rules.
  logSkillFenceReduction(skill.installId, fence)
  return fence.text
}

/** An UNPERSISTED empty assistant message (the zero-token-stop case — see above). */
export function emptyAssistantMessage(conversationId: string): Message {
  return {
    id: randomUUID(),
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: nowIso(),
    tokenCount: null
  }
}
