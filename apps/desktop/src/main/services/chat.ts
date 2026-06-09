import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import type { Citation, Conversation, Message } from '../../shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from './runtime'

// Chat service (spec §7.6): create conversations, append user/assistant messages,
// build the system prompt + message list for the runtime, stream the response, and
// persist history. All local — no network. IDs are UUID v4, timestamps ISO-8601 UTC
// (BUILD_STATE §7 conventions). The system prompt is built per-request and NOT
// persisted; the messages table holds only user/assistant turns.

const DEFAULT_TITLE = 'New chat'

// Base system prompt — verbatim from spec §7.6. RAG context injection (Phase 6)
// appends source-labelled chunks after this preamble.
export const BASE_SYSTEM_PROMPT = `You are Private AI Drive Lite, a local offline assistant running on the user's laptop.
You must be helpful, accurate, and honest about uncertainty.
You do not have internet access.
You must not claim to have accessed external services.
When using provided document context, answer only from the context when the question is about those documents.
If the context is insufficient, say what is missing.
For document answers, include citations using the provided source labels.`

/** Build the system prompt for a request. RAG context is appended in Phase 6. */
export function buildSystemPrompt(): string {
  return BASE_SYSTEM_PROMPT
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
}

function rowToConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    modelId: r.model_id,
    mode: r.mode === 'documents' ? 'documents' : 'chat'
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
}

function rowToMessage(r: MessageRow): Message {
  let citations: Citation[] | undefined
  if (r.citations_json) {
    try {
      citations = JSON.parse(r.citations_json) as Citation[]
    } catch {
      citations = undefined
    }
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role === 'user' || r.role === 'assistant' ? r.role : 'system',
    content: r.content,
    createdAt: r.created_at,
    tokenCount: r.token_count,
    citations
  }
}

export interface CreateConversationOptions {
  title?: string
  modelId?: string | null
  mode?: 'chat' | 'documents'
}

/** Create a new conversation and persist it. */
export function createConversation(db: Db, opts: CreateConversationOptions = {}): Conversation {
  const now = nowIso()
  const conv: Conversation = {
    id: randomUUID(),
    title: opts.title?.trim() || DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    modelId: opts.modelId ?? null,
    mode: opts.mode ?? 'chat'
  }
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, model_id, mode)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(conv.id, conv.title, conv.createdAt, conv.updatedAt, conv.modelId, conv.mode)
  return conv
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
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC'
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
}

/** Append a message and bump the conversation's updated_at. */
export function appendMessage(db: Db, input: AppendMessageInput): Message {
  const now = nowIso()
  const tokenCount = input.tokenCount ?? null
  const citationsJson = input.citations ? JSON.stringify(input.citations) : null
  const msg: Message = {
    id: randomUUID(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAt: now,
    tokenCount,
    citations: input.citations ?? undefined
  }
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at, token_count, citations_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(msg.id, msg.conversationId, msg.role, msg.content, msg.createdAt, tokenCount, citationsJson)
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId)
  return msg
}

/**
 * Remove the conversation's last message IF it is an assistant turn (used by
 * "regenerate"). Returns true if one was deleted.
 *
 * Deliberately scoped to the LAST message, not the last *assistant* message (M1): after
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
 * Set the conversation title from its first user message when it is still the
 * default. Keeps the sidebar readable without a separate "rename" step.
 */
export function maybeSetTitleFromFirstMessage(db: Db, conversationId: string, content: string): void {
  const conv = getConversation(db, conversationId)
  if (!conv || conv.title !== DEFAULT_TITLE) return
  const title = content.trim().replace(/\s+/g, ' ').slice(0, 60) || DEFAULT_TITLE
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId)
}

/** Build the runtime message list: system prompt + persisted history in order. */
export function buildChatMessages(db: Db, conversationId: string): ChatMessage[] {
  const history = listMessages(db, conversationId)
  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }]
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content })
    }
  }
  return messages
}

export interface GenerateOptions {
  signal?: AbortSignal
  /** Called with each streamed token so the IPC layer can forward it to the renderer. */
  onToken?: (token: string) => void
  runtimeOptions?: Pick<RuntimeChatOptions, 'maxTokens' | 'temperature'>
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
  const messages = buildChatMessages(db, conversationId)
  let content = ''
  const stream = runtime.chatStream(messages, {
    signal: opts.signal,
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
  // Persist whatever was produced — on a stop, that is the partial text so far.
  return appendMessage(db, { conversationId, role: 'assistant', content })
}
