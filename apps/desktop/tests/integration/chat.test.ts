import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/services/db'
import {
  appendMessage,
  buildChatMessages,
  buildSystemPrompt,
  collapseToAlternating,
  createConversation,
  deleteLastAssistantMessage,
  effectiveContextWindow,
  fitMessagesToContext,
  generateAssistantMessage,
  listConversations,
  listMessages,
  maybeSetTitleFromFirstMessage,
  stripThinkBlocks
} from '../../src/main/services/chat'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import type { Db } from '../../src/main/services/db'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import type { CoverageInfo } from '../../src/shared/types'

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-chat-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

function runtime() {
  const r = createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 2048 })
  return r
}

describe('effectiveContextWindow (§L0 — budget against the real launched window)', () => {
  it('uses the window the runtime reports over settings.contextTokens', () => {
    const runtime = { contextWindow: () => 8192 }
    expect(effectiveContextWindow(runtime, { contextTokens: 4096 })).toBe(8192)
  })

  it('falls back to settings.contextTokens when the runtime reports no window', () => {
    // A bare runtime without the optional accessor (an old test stub).
    expect(effectiveContextWindow({}, { contextTokens: 4096 })).toBe(4096)
  })

  it('falls back to settings when the reported window is zero/non-positive', () => {
    expect(effectiveContextWindow({ contextWindow: () => 0 }, { contextTokens: 4096 })).toBe(4096)
  })
})

describe('collapseToAlternating (orphan turns from failed answers)', () => {
  const sys = { role: 'system' as const, content: 's' }
  it('drops stale consecutive user turns, keeping the latest (no HTTP 500 from templates)', () => {
    // A conversation where 3 answers failed (each persisted a user turn, no assistant)
    // then a 4th question — the model must still see strictly alternating roles.
    const out = collapseToAlternating([
      sys,
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      { role: 'user', content: 'q4' }
    ])
    expect(out).toEqual([sys, { role: 'user', content: 'q4' }])
  })

  it('preserves a normal alternating history unchanged', () => {
    const msgs = [
      sys,
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'user' as const, content: 'q2' }
    ]
    expect(collapseToAlternating(msgs)).toEqual(msgs)
  })

  it('buildChatMessages collapses orphan user turns left by failed answers', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'mock-chat' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'first' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'second' })
    const built = buildChatMessages(db, conv.id)
    expect(built.filter((m) => m.role === 'user')).toEqual([{ role: 'user', content: 'second' }])
  })
})

// A block of `n` whitespace-separated words ≈ n approx-tokens (the prose path of
// approxTokenCount), so message sizes in these tests are predictable.
const words = (n: number): string => Array(n).fill('word').join(' ')

describe('fitMessagesToContext (history budget vs the model context window)', () => {
  const sys = { role: 'system' as const, content: words(10) }

  it('returns the SAME array (no copy) when the whole history already fits', () => {
    const msgs: ChatMessage[] = [
      sys,
      { role: 'user', content: words(5) },
      { role: 'assistant', content: words(5) },
      { role: 'user', content: words(5) }
    ]
    // Huge context → nothing to trim → identity (cheap, and asserts no needless churn).
    expect(fitMessagesToContext(msgs, 8192)).toBe(msgs)
  })

  it('drops the OLDEST turns, keeping the system message + a contiguous recent tail', () => {
    const turns: ChatMessage[] = []
    for (let i = 0; i < 6; i++) {
      turns.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: words(200) })
    }
    const msgs: ChatMessage[] = [sys, ...turns]
    // reserve 0 so the budget is exactly contextTokens; small ctx forces a trim.
    const fitted = fitMessagesToContext(msgs, 900, 0)

    expect(fitted.length).toBeLessThan(msgs.length)
    expect(fitted[0]).toBe(sys) // system always kept
    expect(fitted[fitted.length - 1]).toBe(turns[turns.length - 1]) // current turn always kept
    // What survives is a contiguous suffix of the original turns (preserves alternation).
    const keptTurns = fitted.slice(1)
    expect(keptTurns).toEqual(turns.slice(turns.length - keptTurns.length))
  })

  it('keeps the final turn even when it ALONE exceeds the budget (runtime maps the overflow)', () => {
    const old = { role: 'user' as const, content: words(20) }
    const huge = { role: 'user' as const, content: words(5000) }
    const fitted = fitMessagesToContext([sys, old, huge], 1000, 0)
    // The oversize current question is never dropped; only the older turn is.
    expect(fitted).toEqual([sys, huge])
  })

  it('buildChatMessages trims old history when given a small context window', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'mock-chat' })
    // A long, alternating conversation that would overflow a small context window.
    for (let i = 0; i < 10; i++) {
      appendMessage(db, { conversationId: conv.id, role: 'user', content: words(300) })
      appendMessage(db, { conversationId: conv.id, role: 'assistant', content: words(300) })
    }
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'FINAL QUESTION' })

    const full = buildChatMessages(db, conv.id) // no budget → whole history
    const fitted = buildChatMessages(db, conv.id, 2048) // budgeted to the model context

    expect(fitted.length).toBeLessThan(full.length)
    expect(fitted[0].role).toBe('system')
    // The current question is always the last message the model sees.
    expect(fitted[fitted.length - 1]).toEqual({ role: 'user', content: 'FINAL QUESTION' })
  })
})

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

// ---- Per-message coverage round-trip (full-doc-skills plan Phase 1, D48) -----------
// Phase 1 is pure plumbing: appendMessage persists a `CoverageInfo` to messages.coverage_json
// and rowToMessage parses it back; a message that recorded no coverage (NULL) reads back
// undefined so the renderer falls back to the relevance badge — today's behaviour, unchanged.
describe('message coverage persistence (full-doc-skills D48)', () => {
  it('round-trips a CoverageInfo through appendMessage → listMessages', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const coverage: CoverageInfo = {
      mode: 'extract',
      chunksCovered: 213,
      chunksTotal: 213,
      unparsedChunks: 2,
      fullyChunked: true
    }
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'analysed', coverage })
    expect(listMessages(db, conv.id).at(-1)?.coverage).toEqual(coverage)
  })

  it('a message that recorded no coverage reads back undefined (NULL → relevance fallback)', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'plain answer' })
    expect(listMessages(db, conv.id).at(-1)?.coverage).toBeUndefined()
  })

  it('a malformed/legacy coverage_json degrades to undefined (never breaks the conversation)', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const msg = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a' })
    // Simulate a hand-edited / pre-contract row: non-JSON garbage in the column.
    db.prepare('UPDATE messages SET coverage_json = ? WHERE id = ?').run('{not json', msg.id)
    expect(listMessages(db, conv.id).at(-1)?.coverage).toBeUndefined()
  })
})

describe('system prompt + message assembly', () => {
  it('matches the spec §7.6 base prompt', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('You are HilbertRaum')
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

  // L2 (audit round 4): a stop BEFORE the first token used to persist an empty assistant
  // message — a permanent blank bubble in the transcript.
  it('a stop before the first token persists nothing', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    const ac = new AbortController()
    ac.abort() // aborted before any token can stream
    const msg = await generateAssistantMessage(db, runtime(), conv.id, { signal: ac.signal })
    expect(msg.content).toBe('')
    expect(listMessages(db, conv.id)).toHaveLength(1) // only the user turn
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

// ---- Answer-depth modes: think-block hygiene + option threading (Phase 20) --------

describe('stripThinkBlocks (wave-1 decision D6 (architecture.md "Chat & streaming"))', () => {
  it('removes closed think blocks and trims the seams', () => {
    expect(stripThinkBlocks('<think>\nstep 1\nstep 2\n</think>\n\nThe answer.')).toBe('The answer.')
    expect(stripThinkBlocks('a <think>x</think> b <think>y</think> c')).toBe('a  b  c')
  })

  it('removes an unclosed trailing block (stream stopped mid-thought)', () => {
    expect(stripThinkBlocks('Partial answer.\n<think>half a thou')).toBe('Partial answer.')
    expect(stripThinkBlocks('<think>only thinking, no answer yet')).toBe('')
  })

  it('returns untouched text as-is (no trimming of normal replies)', () => {
    expect(stripThinkBlocks('  plain reply with spaces  ')).toBe('  plain reply with spaces  ')
    expect(stripThinkBlocks('')).toBe('')
  })
})

describe('answer-depth threading + persistence hygiene (Phase 20)', () => {
  /** A runtime that captures chatStream options and emits reasoning + inline think text. */
  function capturingRuntime(reply: string[]): {
    runtime: ModelRuntime
    seen: { options?: RuntimeChatOptions }
  } {
    const seen: { options?: RuntimeChatOptions } = {}
    const runtime: ModelRuntime = {
      modelId: 'capture',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 1 }),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        seen.options = options
        options?.onReasoning?.('thinking about it…')
        for (const t of reply) yield t
      }
    }
    return { runtime, seen }
  }

  it('forwards mode + onReasoning to the runtime and keeps reasoning out of the persisted reply', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })

    const { runtime: r, seen } = capturingRuntime(['The answer.'])
    const reasoning: string[] = []
    const msg = await generateAssistantMessage(db, r, conv.id, {
      mode: 'deep',
      onReasoning: (d) => reasoning.push(d)
    })

    expect(seen.options?.mode).toBe('deep')
    expect(reasoning).toEqual(['thinking about it…'])
    expect(msg.content).toBe('The answer.')
    expect(listMessages(db, conv.id).at(-1)?.content).toBe('The answer.')
  })

  it('strips inline think blocks before persisting (defense-in-depth, D6)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })

    const { runtime: r } = capturingRuntime(['<think>secret reasoning</think>\n\n', 'Clean answer.'])
    const msg = await generateAssistantMessage(db, r, conv.id, {})
    expect(msg.content).toBe('Clean answer.')
    const persisted = listMessages(db, conv.id).at(-1)
    expect(persisted?.content).toBe('Clean answer.')
    expect(persisted?.content).not.toContain('<think>')
  })

  it('a reply that was ONLY thinking persists nothing (like the zero-token stop)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })

    const { runtime: r } = capturingRuntime(['<think>aborted before the answer'])
    const msg = await generateAssistantMessage(db, r, conv.id, {})
    expect(msg.content).toBe('')
    expect(listMessages(db, conv.id)).toHaveLength(1) // only the user turn
  })

  it('buildChatMessages scrubs think blocks from replayed assistant turns only', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, {
      conversationId: conv.id,
      role: 'user',
      content: 'literal <think>user text</think> stays'
    })
    appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: '<think>legacy persisted reasoning</think>\n\nVisible answer'
    })
    const built = buildChatMessages(db, conv.id)
    expect(built[1].content).toBe('literal <think>user text</think> stays')
    expect(built[2].content).toBe('Visible answer')
  })
})
