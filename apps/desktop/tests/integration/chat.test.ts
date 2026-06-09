import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/services/db'
import {
  appendMessage,
  buildChatMessages,
  buildSystemPrompt,
  createConversation,
  deleteLastAssistantMessage,
  generateAssistantMessage,
  listConversations,
  listMessages,
  maybeSetTitleFromFirstMessage
} from '../../src/main/services/chat'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import type { Db } from '../../src/main/services/db'
import type { ModelRuntime } from '../../src/main/services/runtime'

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'paid-chat-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

function runtime() {
  const r = createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 2048 })
  return r
}

describe('conversation persistence', () => {
  it('creates a conversation and lists it back', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'mock-chat' })
    expect(conv.id).toMatch(/[0-9a-f-]{36}/)
    expect(conv.title).toBe('New chat')
    expect(conv.mode).toBe('chat')

    const list = listConversations(db)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(conv.id)
    expect(list[0].modelId).toBe('mock-chat')
  })

  it('orders conversations by most recently updated', async () => {
    const db = freshDb()
    const a = createConversation(db, {})
    const b = createConversation(db, {})
    // Touch `a` so it becomes the most recently updated.
    await new Promise((r) => setTimeout(r, 5))
    appendMessage(db, { conversationId: a.id, role: 'user', content: 'hi' })
    const list = listConversations(db)
    expect(list[0].id).toBe(a.id)
    expect(list[1].id).toBe(b.id)
  })

  it('sets the title from the first user message', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'What is a vector store?' })
    maybeSetTitleFromFirstMessage(db, conv.id, 'What is a vector store?')
    expect(listConversations(db)[0].title).toBe('What is a vector store?')
    // A second message must not overwrite the established title.
    maybeSetTitleFromFirstMessage(db, conv.id, 'second question')
    expect(listConversations(db)[0].title).toBe('What is a vector store?')
  })
})

describe('message ordering', () => {
  it('returns messages in insertion order even at equal timestamps', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const contents = ['u1', 'a1', 'u2', 'a2', 'u3']
    const roles = ['user', 'assistant', 'user', 'assistant', 'user'] as const
    contents.forEach((c, i) => appendMessage(db, { conversationId: conv.id, role: roles[i], content: c }))

    const msgs = listMessages(db, conv.id)
    expect(msgs.map((m) => m.content)).toEqual(contents)
    expect(msgs.map((m) => m.role)).toEqual(roles)
  })

  it('scopes messages to their conversation', () => {
    const db = freshDb()
    const a = createConversation(db, {})
    const b = createConversation(db, {})
    appendMessage(db, { conversationId: a.id, role: 'user', content: 'in-a' })
    appendMessage(db, { conversationId: b.id, role: 'user', content: 'in-b' })
    expect(listMessages(db, a.id).map((m) => m.content)).toEqual(['in-a'])
    expect(listMessages(db, b.id).map((m) => m.content)).toEqual(['in-b'])
  })
})

describe('system prompt + message assembly', () => {
  it('matches the spec §7.6 base prompt', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('You are Private AI Drive Lite')
    expect(p).toContain('You do not have internet access.')
    expect(p).toContain('include citations using the provided source labels')
  })

  it('prepends a system message then history in order', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hello' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'hi there' })
    const built = buildChatMessages(db, conv.id)
    expect(built[0].role).toBe('system')
    expect(built.slice(1)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' }
    ])
  })
})

describe('generateAssistantMessage (streaming)', () => {
  it('streams tokens and persists the full assistant reply', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })

    const tokens: string[] = []
    const msg = await generateAssistantMessage(db, runtime(), conv.id, {
      onToken: (t) => tokens.push(t)
    })

    expect(tokens.length).toBeGreaterThan(1)
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe(tokens.join(''))
    // The persisted assistant message is the last in history.
    const history = listMessages(db, conv.id)
    expect(history.at(-1)?.content).toBe(msg.content)
    expect(history.at(-1)?.role).toBe('assistant')
  })

  it('stop cancels the stream and persists only the partial reply', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })

    const controller = new AbortController()
    const tokens: string[] = []
    const msg = await generateAssistantMessage(db, runtime(), conv.id, {
      signal: controller.signal,
      onToken: (t) => {
        tokens.push(t)
        if (tokens.length === 2) controller.abort()
      }
    })

    // Only the tokens emitted before abort are kept; the reply is truncated.
    expect(tokens.length).toBe(2)
    expect(msg.content).toBe(tokens.join(''))

    // Compare against an unabridged generation to prove it really stopped early.
    const conv2 = createConversation(db, {})
    appendMessage(db, { conversationId: conv2.id, role: 'user', content: 'ping' })
    const full = await generateAssistantMessage(db, runtime(), conv2.id, {})
    expect(msg.content.length).toBeLessThan(full.content.length)
  })

  it('persists the partial reply when a real-style runtime throws AbortError', async () => {
    // The mock returns cleanly on abort, but a real fetch-backed runtime REJECTS the
    // in-flight request with an AbortError. generateAssistantMessage must treat that as a
    // normal end (persist the partial) rather than letting it propagate (C1 regression).
    // NOTE: no signal is passed and the controller is NOT aborted, so this exercises the
    // `err.name === 'AbortError'` branch of isAbortError specifically — deleting that branch
    // must fail this test.
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })

    const throwingRuntime: ModelRuntime = {
      modelId: 'real-ish',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 1 }),
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        yield 'Partial '
        yield 'answer'
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }
    }

    const tokens: string[] = []
    const msg = await generateAssistantMessage(db, throwingRuntime, conv.id, {
      onToken: (t) => tokens.push(t)
    })
    expect(msg.content).toBe('Partial answer')
    expect(listMessages(db, conv.id).at(-1)?.content).toBe('Partial answer')
  })

  it('propagates a NON-abort runtime error instead of swallowing it', async () => {
    // Only aborts are treated as a normal end; a real failure must reject so the IPC layer
    // emits chat:error (guards against isAbortError being too permissive).
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })

    const failingRuntime: ModelRuntime = {
      modelId: 'real-ish',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 1 }),
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        yield 'partial'
        throw new Error('Chat request failed: HTTP 500')
      }
    }

    await expect(generateAssistantMessage(db, failingRuntime, conv.id, {})).rejects.toThrow(/HTTP 500/)
    // Nothing partial was persisted on a real failure.
    expect(listMessages(db, conv.id).filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('regenerate drops the last assistant message before re-streaming', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })
    const first = await generateAssistantMessage(db, runtime(), conv.id, {})
    expect(listMessages(db, conv.id)).toHaveLength(2)

    const deleted = deleteLastAssistantMessage(db, conv.id)
    expect(deleted).toBe(true)
    expect(listMessages(db, conv.id)).toHaveLength(1) // back to just the user turn

    const second = await generateAssistantMessage(db, runtime(), conv.id, {})
    const history = listMessages(db, conv.id)
    expect(history).toHaveLength(2)
    expect(history.at(-1)?.id).toBe(second.id)
    expect(history.at(-1)?.id).not.toBe(first.id)
  })

  // M1 (audit round 4): after a FAILED generation the conversation ends in a user turn.
  // Regenerate used to delete the most recent assistant message anywhere in history —
  // permanently destroying the answer to a *previous* question.
  it('regenerate never deletes an earlier answer when the last turn is a user message', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'first question' })
    const answer = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'first answer' })
    // A second question whose generation failed → no assistant turn follows it.
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'second question' })

    const deleted = deleteLastAssistantMessage(db, conv.id)
    expect(deleted).toBe(false) // last turn is a user message — nothing to delete
    const history = listMessages(db, conv.id)
    expect(history).toHaveLength(3)
    expect(history.some((m) => m.id === answer.id)).toBe(true) // the earlier answer survives
  })
})
