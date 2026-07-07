import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  appendMessage,
  createConversation,
  emptyAssistantMessage,
  hasRegenerableAssistantReply,
  listMessages
} from '../../src/main/services/chat'
import { withRegenerateGuard } from '../../src/main/ipc/chat-stream'
import type { ChatStreamRunFn } from '../../src/main/ipc/chat-stream'
import type { CoverageInfo, Message } from '../../src/shared/types'

// CB-2 — a regenerate deletes the prior reply INSIDE the stream (F2) and, before this fix, restored
// it only on a NON-abort failure. A user Stop BEFORE the first token resolves (does not throw) with
// an unpersisted empty message, so the destructive delete stood with nothing in its place: two clicks
// (Regenerate, Stop) silently erased the answer. The guard now also restores on that empty resolve.

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-regenerate-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

/** Drive the guarded runFn with a real abort signal + inert senders (the guard ignores their output). */
function drive(wrapped: ChatStreamRunFn): Promise<Message> {
  const signal = new AbortController().signal
  const noop = (): void => {}
  return wrapped(signal, noop, noop, noop, noop)
}

describe('withRegenerateGuard — CB-2 (a produced-nothing regenerate never loses the prior answer)', () => {
  it('a Stop before the first token restores the prior reply byte-faithfully (id, citations, coverage, skill stamp)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'what does it say?' })
    const coverage: CoverageInfo = { mode: 'extract', fullyChunked: true, chunksCovered: 3, chunksTotal: 3 }
    const original = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'a grounded answer [S1]',
      citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 2 }],
      coverage,
      skillId: 'app:bank-statement',
      autoFired: true
    })

    // The run resolves with an unpersisted empty message — a Stop before the first token.
    const wrapped = withRegenerateGuard(db, conv.id, true, async () => emptyAssistantMessage(conv.id))
    const result = await drive(wrapped)

    // The prior reply is back (same identity), and chat:done carries it so the UI re-shows the answer.
    const history = listMessages(db, conv.id)
    expect(history).toHaveLength(2)
    expect(result.id).toBe(original.id)
    expect(result.content).toBe('a grounded answer [S1]')
    const restored = history.at(-1)
    expect(restored?.id).toBe(original.id)
    expect(restored?.createdAt).toBe(original.createdAt)
    expect(restored?.citations).toEqual(original.citations)
    expect(restored?.coverage?.chunksCovered).toBe(3)
    // The skill stamp survives at the column level (the skills table is empty here).
    const raw = db
      .prepare('SELECT skill_id, auto_fired FROM messages WHERE id = ?')
      .get(original.id) as { skill_id: string | null; auto_fired: number | null }
    expect(raw.skill_id).toBe('app:bank-statement')
    expect(raw.auto_fired).toBe(1)
    expect(hasRegenerableAssistantReply(db, conv.id)).toBe(true) // regenerable again
  })

  it('a successful regenerate keeps the delete (the new reply stands; ids differ)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })
    const original = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'old answer' })

    const wrapped = withRegenerateGuard(db, conv.id, true, async () =>
      appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'new answer' })
    )
    const result = await drive(wrapped)

    const history = listMessages(db, conv.id)
    expect(history).toHaveLength(2)
    expect(result.content).toBe('new answer')
    expect(history.at(-1)?.content).toBe('new answer')
    expect(history.at(-1)?.id).not.toBe(original.id) // the old reply was NOT restored
    expect(history.some((m) => m.id === original.id)).toBe(false)
  })

  it('a non-regenerate empty stop persists nothing (guard is a passthrough when regenerate is false)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })

    const runFn: ChatStreamRunFn = async () => emptyAssistantMessage(conv.id)
    const wrapped = withRegenerateGuard(db, conv.id, false, runFn)
    expect(wrapped).toBe(runFn) // no wrapping, no destructive delete
    const result = await drive(wrapped)

    expect(result.content).toBe('')
    expect(listMessages(db, conv.id)).toHaveLength(1) // only the user turn — nothing persisted
  })
})
