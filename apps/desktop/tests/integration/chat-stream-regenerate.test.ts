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
  listMessages,
  persistAssistantMessage
} from '../../src/main/services/chat'
import { modelStopAbortReason } from '../../src/main/services/runtime/model-stop'
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

  it('a non-regenerate empty stop persists nothing and deletes nothing (no destructive delete when regenerate is false)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q0' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a0' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })

    const runFn: ChatStreamRunFn = async () => emptyAssistantMessage(conv.id)
    const result = await drive(withRegenerateGuard(db, conv.id, false, runFn))

    expect(result.content).toBe('')
    // The earlier answer stays and nothing new was persisted (#600 wraps every turn, so this pins the
    // behaviour — no delete, no persist — rather than the old identity passthrough).
    expect(listMessages(db, conv.id).map((m) => m.content)).toEqual(['q0', 'a0', 'q'])
  })
})

// #600 — the same guard carries the model-stop rules. A model stop ends the turn through its abort
// signal (`modelStopAbortReason`, the runtime's model-stop hook) before the sidecar is killed.
describe('withRegenerateGuard — a model stop, and an abort thrown before anything streamed (#600)', () => {
  function abortedWith(reason?: unknown): AbortSignal {
    const c = new AbortController()
    c.abort(reason)
    return c.signal
  }
  const noop = (): void => {}

  it('a model stop that cut a re-ask brings the previous complete answer back; the partial goes', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    const original = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'the full answer' })
    const signal = abortedWith(modelStopAbortReason())

    // The re-ask streamed a few words, then the model stop ended it: its partial is persisted
    // (persistAssistantMessage, as every answer path does) and the run resolves with it.
    const wrapped = withRegenerateGuard(db, conv.id, true, async (sig) =>
      persistAssistantMessage(db, { conversationId: conv.id, role: 'assistant', content: 'the fu' }, sig)
    )
    const result = await wrapped(signal, noop, noop, noop, noop)

    expect(result.id).toBe(original.id)
    expect(listMessages(db, conv.id).map((m) => m.content)).toEqual(['q', 'the full answer'])
  })

  it('a model-stopped re-ask whose restore fails keeps its partial — never neither answer', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    const original = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'the full answer' })
    // The re-insert of the previous answer is refused (any write failure would do).
    db.exec(`CREATE TEMP TRIGGER refuse_restore BEFORE INSERT ON messages WHEN NEW.id = '${original.id}'
             BEGIN SELECT RAISE(ABORT, 'refused'); END`)

    const wrapped = withRegenerateGuard(db, conv.id, true, async (sig) =>
      persistAssistantMessage(db, { conversationId: conv.id, role: 'assistant', content: 'the fu' }, sig)
    )
    const result = await wrapped(abortedWith(modelStopAbortReason()), noop, noop, noop, noop)

    expect(result.content).toBe('the fu')
    expect(listMessages(db, conv.id).map((m) => m.content)).toEqual(['q', 'the fu'])
  })

  it('a model stop that lands after the re-ask saved its COMPLETE answer keeps the new answer', async () => {
    // A document answer persists, then awaits post-answer steps; the stop lands in that gap.
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'the old answer' })
    const turn = new AbortController()

    const wrapped = withRegenerateGuard(db, conv.id, true, async (sig) => {
      const saved = persistAssistantMessage(db, { conversationId: conv.id, role: 'assistant', content: 'the new answer' }, sig)
      turn.abort(modelStopAbortReason())
      await Promise.resolve()
      return saved
    })
    const result = await wrapped(turn.signal, noop, noop, noop, noop)

    expect(result.endedEarly).toBeUndefined()
    expect(listMessages(db, conv.id).map((m) => m.content)).toEqual(['q', 'the new answer'])
  })

  it.each([
    ['the Stop button', undefined],
    ['a model stop', modelStopAbortReason()]
  ])('%s while documents are still being searched for a re-ask: the previous answer comes back', async (_l, reason) => {
    // Retrieval, the reranker and a knowledge-pack arm rethrow an abort (rag/index.ts) — nothing was
    // streamed or saved. The guard used to skip every abort here, so the previous answer was lost.
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    const original = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'kept' })
    const signal = abortedWith(reason)

    const wrapped = withRegenerateGuard(db, conv.id, true, async () => {
      const err = new Error('The operation was aborted.')
      err.name = 'AbortError'
      throw err
    })
    await expect(wrapped(signal, noop, noop, noop, noop)).rejects.toThrow('aborted')

    const history = listMessages(db, conv.id)
    expect(history.map((m) => m.id)).toEqual([history[0].id, original.id])
  })

  it('a model stop before the first word marks the question "Not answered"; the Stop button marks nothing', async () => {
    const db = freshDb()
    const run = async (reason: unknown): Promise<Message> => {
      const conv = createConversation(db, {})
      appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
      await withRegenerateGuard(db, conv.id, false, async () => emptyAssistantMessage(conv.id))(
        abortedWith(reason),
        noop,
        noop,
        noop,
        noop
      )
      return listMessages(db, conv.id)[0]
    }
    expect((await run(modelStopAbortReason())).endedEarly).toBe('model')
    expect((await run(undefined)).endedEarly).toBeUndefined() // the user's own Stop: #612
  })
})
