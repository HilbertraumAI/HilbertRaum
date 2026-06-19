import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n'
import type { Db } from './db'
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type ChatDepthMode,
  type Citation,
  type Conversation,
  type ConversationSearchHit,
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
  skillFenceBudgetTokens
} from './skills/prompt'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from './runtime'

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

// Base system prompt — verbatim from spec §7.6. RAG context injection (rag/index.ts)
// appends source-labelled chunks after this preamble.
export const BASE_SYSTEM_PROMPT = `You are HilbertRaum, a local offline assistant running on the user's laptop.
You must be helpful, accurate, and honest about uncertainty.
You do not have internet access.
You must not claim to have accessed external services.
When using provided document context, answer only from the context when the question is about those documents.
If the context is insufficient, say what is missing.
For document answers, include citations using the provided source labels.`

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
  // Resolve the stamped skill (DS16/§22-A5): the LEFT JOIN yields skill_title only while the skill
  // row still exists. A DELETED skill (no join) ⇒ skillId/skillTitle NULL, so the glyph never
  // points at a vanished skill (the FK-less delete relies on this — audit C3).
  const skillResolved = r.skill_id != null && r.skill_title != null
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role === 'user' || r.role === 'assistant' ? r.role : 'system',
    content: r.content,
    createdAt: r.created_at,
    tokenCount: r.token_count,
    citations,
    skillId: skillResolved ? r.skill_id : null,
    skillTitle: skillResolved ? r.skill_title : null,
    // Auto-fire provenance (S13c) only means anything when a skill actually shaped (and still resolves
    // for) this turn; a deleted skill drops the glyph AND the undo together.
    autoFired: skillResolved ? r.auto_fired === 1 : false,
    coverage
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
  const rows = db
    .prepare('SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC')
    .all() as unknown as ConversationRow[]
  return rows.map(rowToConversation)
}

export function getConversation(db: Db, conversationId: string): Conversation | null {
  const row = db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(conversationId) as unknown as ConversationRow | undefined
  return row ? rowToConversation(row) : null
}

/**
 * List a conversation's messages in insertion order. `created_at` may collide at
 * millisecond resolution, so `rowid` is the tiebreaker that guarantees turn order.
 */
export function listMessages(db: Db, conversationId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT m.*, s.title AS skill_title
       FROM messages m LEFT JOIN skills s ON s.install_id = m.skill_id
       WHERE m.conversation_id = ? ORDER BY m.created_at ASC, m.rowid ASC`
    )
    .all(conversationId) as unknown as MessageRow[]
  return rows.map(rowToMessage)
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
    coverage: input.coverage ?? undefined
  }
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at, token_count, citations_json, skill_id, auto_fired, coverage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    coverageJson
  )
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId)
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
 * Remove the conversation's last message IF it is an assistant turn (used by
 * "regenerate"). Returns true if one was deleted.
 *
 * Deliberately scoped to the LAST message, not the last *assistant* message: after
 * a failed generation the conversation ends in a user turn — deleting the most recent
 * assistant message would then permanently destroy the answer to a *previous* question.
 * In that case regenerate just re-streams from history without deleting anything.
 */
export function deleteLastAssistantMessage(db: Db, conversationId: string): boolean {
  const row = db
    .prepare(
      `SELECT id, role FROM messages WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(conversationId) as unknown as { id: string; role: string } | undefined
  if (!row || row.role !== 'assistant') return false
  db.prepare('DELETE FROM messages WHERE id = ?').run(row.id)
  return true
}

/**
 * Delete a conversation and all of its messages (chat and document Q&A alike — a
 * documents conversation only references documents via persisted citations, so the
 * documents/chunks/embeddings tables are untouched). Messages go first: the FK has
 * no ON DELETE CASCADE and foreign_keys is ON. Returns true when a row was deleted.
 */
export function deleteConversation(db: Db, conversationId: string): boolean {
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
  return Number(result.changes) > 0
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
/** Real-tokens-per-whitespace-word safety factor (matches the doctask + RAG budgets). */
const CHAT_TOKENS_PER_WORD = 1.3
/** Per-message overhead for role markers / delimiters the chat template adds. */
const PER_MESSAGE_OVERHEAD_TOKENS = 8

/** Estimated model tokens for one message (word estimate scaled up + template chrome). */
function messageTokens(m: ChatMessage): number {
  return Math.ceil(approxTokenCount(m.content) * CHAT_TOKENS_PER_WORD) + PER_MESSAGE_OVERHEAD_TOKENS
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
  const history = listMessages(db, conversationId)
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(skillFence) }]
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      // Assistant turns are scrubbed of think blocks before being replayed —
      // replayed reasoning confuses the model (see stripThinkBlocks).
      messages.push({
        role: m.role,
        content: m.role === 'assistant' ? stripThinkBlocks(m.content) : m.content
      })
    }
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
  // assembles a prompt the runtime rejects (HTTP 400 exceed_context_size_error).
  const contextTokens = getSettings(db).contextTokens
  // Pre-size the skill fence (§11.3/A6) BEFORE it goes in the system message so it can never
  // starve the base preamble or the final user turn — fitMessagesToContext only drops older
  // history. Stamp the assistant row only when the fence actually fit (skill shaped the answer).
  const fence = buildTurnFence(db, conversationId, opts.skill, contextTokens)
  const messages = buildChatMessages(db, conversationId, contextTokens, fence)
  let content = ''
  const stream = runtime.chatStream(messages, {
    signal: opts.signal,
    mode: opts.mode,
    onReasoning: opts.onReasoning,
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
  // Reasoning never reaches the DB: the runtime already streams it separately,
  // and any inline think block that slipped into the answer is stripped here.
  content = stripThinkBlocks(content)
  // Persist whatever was produced — on a stop, that is the partial text so far. A stop
  // BEFORE the first token produced nothing: persist nothing (a permanent empty
  // assistant bubble in the transcript otherwise) and return an unpersisted, empty
  // message to keep the resolve contract.
  if (content === '') return emptyAssistantMessage(conversationId)
  // Stamp the skill only when its fence was actually placed (DS16/§22-A5) — an omitted-for-budget
  // skill did not shape this answer, so it gets no glyph.
  return appendMessage(db, {
    conversationId,
    role: 'assistant',
    content,
    skillId: fence ? (opts.skill?.installId ?? null) : null,
    // Carry auto-fire provenance only when the fence was placed (the skill shaped the answer) — so the
    // S13c undo lines up 1:1 with the glyph (§22-A5).
    autoFired: fence ? opts.skill?.autoFired === true : false
  })
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
  return buildSkillFence({ title: skill.title, body: skill.body }, budget).text
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
