import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createConversation,
  appendMessage,
  generateAssistantMessage,
  listMessages
} from '../../src/main/services/chat'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// R1 (full-audit-2026-06-30, Phase C): a workspace LOCK / quit aborts an in-flight chat stream while
// its partial reply is still unwinding to `appendMessage`. Phase C makes the teardown await each
// stream's SETTLE so the partial persists while the DB is open (the deterministic primary fix,
// covered by the shutdown/workspace-ipc ordering tests). Here we pin the two end-state guarantees in
// `generateAssistantMessage` itself: (1) an aborted partial DOES persist on an open DB; (2) the
// defense-in-depth guard swallows a partial-persist against an already-CLOSED DB cleanly (no
// unhandled rejection) instead of crashing the teardown.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-lockpersist-')), 'test.sqlite'))
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * A runtime whose chatStream yields ONE token, then parks on `gate`. On release it observes the
 * abort and returns (the mock-runtime semantics) — so the test controls exactly when the
 * abort-unwind reaches `appendMessage`, modelling the lock racing the persistence.
 */
function gatedRuntime(gate: Promise<void>): ModelRuntime {
  return {
    modelId: 'mock',
    backend: 'mock',
    gpuName: null,
    async start() {},
    async stop() {},
    contextWindow: () => 2048,
    async health() {
      return { healthy: true, port: null, message: 'ok' }
    },
    async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
      yield 'partial '
      await gate // park until the test releases (the lock/quit window)
      if (options?.signal?.aborted) return // mock returns on abort; keep the streamed partial
      yield 'more'
    }
  } as unknown as ModelRuntime
}

describe('R1 — chat partial persistence vs a locking DB', () => {
  it('persists the aborted partial while the DB is still open', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'mock' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })

    const ctrl = new AbortController()
    let token = ''
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const p = generateAssistantMessage(db, gatedRuntime(gate), conv.id, {
      signal: ctrl.signal,
      onToken: (t) => (token += t)
    })
    while (!token) await tick() // the partial token streamed; the generator is parked at the gate

    ctrl.abort() // the lock/quit aborts the stream
    release() // …and the abort-unwind proceeds to appendMessage on the still-OPEN db
    const msg = await p

    expect(msg.content).toBe('partial ') // the partial was persisted
    const stored = listMessages(db, conv.id).filter((m) => m.role === 'assistant')
    expect(stored.map((m) => m.content)).toEqual(['partial '])
  })

  it('swallows a locked-DB partial-persist cleanly — no rejection escapes (R1 guard)', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'mock' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })

    const ctrl = new AbortController()
    let token = ''
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const p = generateAssistantMessage(db, gatedRuntime(gate), conv.id, {
      signal: ctrl.signal,
      onToken: (t) => (token += t)
    })
    while (!token) await tick()

    ctrl.abort()
    db.close() // the lock CLOSED the DB before the abort-unwind reached appendMessage
    release()

    // R1 guard: appendMessage against the closed DB during an ABORT partial-persist is swallowed →
    // an empty message, NOT a rejection (which would surface only as a global unhandled-rejection
    // log). Without the guard this REJECTS with "database is not open" and the assertion reds.
    await expect(p).resolves.toMatchObject({ content: '' })
  })

  it('a genuine persistence error on an OPEN DB still propagates (the guard is narrow)', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'mock' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })

    const ctrl = new AbortController()
    let token = ''
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // Drop the table so appendMessage throws a REAL error while the DB is open + signal aborted —
    // the guard (which keys on `!db.isOpen`) must NOT swallow this; it has to propagate.
    const p = generateAssistantMessage(db, gatedRuntime(gate), conv.id, {
      signal: ctrl.signal,
      onToken: (t) => (token += t)
    })
    while (!token) await tick()
    ctrl.abort()
    db.exec('DROP TABLE messages') // DB stays OPEN, but the insert will fail
    release()
    await expect(p).rejects.toThrow()
  })
})
