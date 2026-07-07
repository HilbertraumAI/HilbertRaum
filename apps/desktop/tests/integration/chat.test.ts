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
  COMPACTION_SUMMARY_ACK,
  createConversation,
  deleteLastAssistantMessage,
  effectiveContextWindow,
  fitMessagesToContext,
  generateAssistantMessage,
  getLatestMessage,
  hasRegenerableAssistantReply,
  listConversations,
  listMessages,
  maybeSetTitleFromFirstMessage,
  restoreMessage,
  stripThinkBlocks,
  writeCheckpoint
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

  it('the no-runtime fallback honours the user context-size override before the legacy setting', () => {
    expect(
      effectiveContextWindow({}, { contextTokens: 4096, contextTokensOverride: 16384 })
    ).toBe(16384)
    // A reported window still wins — the launched --ctx-size is the authority (§L0).
    expect(
      effectiveContextWindow({ contextWindow: () => 8192 }, { contextTokens: 4096, contextTokensOverride: 16384 })
    ).toBe(8192)
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

// CB-1 (chat-docs audit 2026-07-07) — after a trim, the kept tail must be user-first. A contiguous
// suffix preserves ALTERNATION but not first-role parity: an even-length kept run ends `user` and so
// BEGINS `assistant`, which strict templates (Mistral-family) reject with HTTP 500. fitMessagesToContext
// drops leading assistant turns in the trimmed branch only; the no-trim identity path stays byte-identical.
describe('fitMessagesToContext — user-first normalization (CB-1)', () => {
  const sys = { role: 'system' as const, content: words(10) }
  // `tag` counts as one word (≤ ONE_TOKEN_WORD_CHARS) so every turn is exactly `n` approx-tokens,
  // making the trim boundary predictable while keeping each turn uniquely identifiable.
  const tagged = (tag: string, n: number): string => [tag, ...Array(n - 1).fill('word')].join(' ')

  it('drops a leading assistant when an even-length tail would otherwise be assistant-first', () => {
    // 5 turns; each 100 words ≈ 203 tokens, sys ≈ 28. Budget 900 (reserve 0) keeps u4,a3,u2,a1 (four
    // turns, even) → without the fix the tail is [a1,u2,a3,u4] (assistant-first). The fix drops a1.
    const u0 = { role: 'user' as const, content: tagged('U0', 100) }
    const a1 = { role: 'assistant' as const, content: tagged('A1', 100) }
    const u2 = { role: 'user' as const, content: tagged('U2', 100) }
    const a3 = { role: 'assistant' as const, content: tagged('A3', 100) }
    const u4 = { role: 'user' as const, content: tagged('U4', 100) }
    const fitted = fitMessagesToContext([sys, u0, a1, u2, a3, u4], 900, 0)

    expect(fitted[0]).toBe(sys)
    expect(fitted[1].role).toBe('user') // user-first after system
    expect(fitted.map((m) => m.content)).not.toContain(a1.content) // the leading assistant is gone
    expect(fitted.at(-1)).toBe(u4) // the mandatory final user turn is kept
    // Only the one leading assistant is dropped — the rest of the recent tail survives.
    expect(fitted.slice(1)).toEqual([u2, a3, u4])
  })

  it('never replays the compaction summary ack without its intro (pair never split)', () => {
    // The synthetic pair leads: intro(user) → ack(assistant) → final(user). A budget that keeps the
    // ack but drops the intro would replay a bare "Understood — I'll continue…" with no summary.
    const intro = { role: 'user' as const, content: tagged('INTRO', 100) }
    const ack = { role: 'assistant' as const, content: COMPACTION_SUMMARY_ACK }
    const q = { role: 'user' as const, content: tagged('QUESTION', 100) }
    // sys 28 + q 203 = 231; +ack(≈26)=257 keeps ack; +intro(203)=460 would drop it. Budget 300.
    const fitted = fitMessagesToContext([sys, intro, ack, q], 300, 0)

    expect(fitted[1].role).toBe('user')
    // The ack never appears leading/bare; if it survived at all its predecessor would be the intro.
    const ackIdx = fitted.findIndex((m) => m.content === COMPACTION_SUMMARY_ACK)
    if (ackIdx !== -1) expect(fitted[ackIdx - 1]).toBe(intro)
    else expect(fitted.map((m) => m.content)).not.toContain(COMPACTION_SUMMARY_ACK)
  })

  it('a solo oversize final turn is preserved — the length-1 guard never empties the tail', () => {
    const old = { role: 'assistant' as const, content: tagged('OLD', 20) }
    const finalQ = { role: 'user' as const, content: tagged('FINAL', 5000) }
    const fitted = fitMessagesToContext([sys, old, finalQ], 1000, 0)
    // Only the mandatory final turn fits; it is kept even though it alone exceeds the budget.
    expect(fitted).toEqual([sys, finalQ])
  })
})

// CB-6 (chat-docs audit 2026-07-07) — getLatestMessage is a LIMIT-1 twin of listMessages used by
// buildTurnFence to size a turn against just the final message instead of paging the whole history.
// It MUST be byte-identical to listMessages(...).at(-1) or the fence content would silently change.
describe('getLatestMessage — LIMIT-1 twin of listMessages (CB-6)', () => {
  it('returns the tail message, byte-identical to listMessages(...).at(-1)', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'final question' })
    expect(getLatestMessage(db, conv.id)).toEqual(listMessages(db, conv.id).at(-1))
    expect(getLatestMessage(db, conv.id)?.content).toBe('final question')
  })

  it('excludes a compaction checkpoint row (the tail is the last real turn, not the summary)', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
    const last = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' })
    // A checkpoint is written AFTER the last real turn (higher rowid) — it must not become the tail.
    writeCheckpoint(db, { conversationId: conv.id, summary: 'SUMMARY body', coversThroughRowid: 0 })
    const latest = getLatestMessage(db, conv.id)
    expect(latest?.id).toBe(last.id)
    expect(latest?.content).toBe('a1')
    expect(latest).toEqual(listMessages(db, conv.id).at(-1))
  })

  it('returns null for an empty conversation', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    expect(getLatestMessage(db, conv.id)).toBeNull()
  })
})

// CB-6 — buildChatMessages takes the §5.4 compaction toggle as a threaded param (default = a fresh
// read, so every existing caller is byte-identical). generateAssistantMessage passes its single
// per-turn getSettings read through it. Prove the threaded boolean is honored.
describe('buildChatMessages — threaded compactionOn param (CB-6)', () => {
  it('passing compactionOn=false ignores an existing checkpoint (replays full history)', () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'a1' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2' })
    writeCheckpoint(db, { conversationId: conv.id, summary: 'SUMMARY body', coversThroughRowid: 0 })

    // Default (compaction on): the checkpoint's synthetic summary pair is injected.
    const withPair = buildChatMessages(db, conv.id)
    expect(withPair.some((m) => m.content.includes('SUMMARY body'))).toBe(true)

    // Threaded false: the checkpoint is ignored and the full history replays (no summary pair).
    const noPair = buildChatMessages(db, conv.id, undefined, undefined, false)
    expect(noPair.some((m) => m.content.includes('SUMMARY body'))).toBe(false)
    expect(noPair.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['q1', 'a1', 'q2'])
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
  it('the plain-chat base prompt answers from the model’s own knowledge and carries no grounding rules', () => {
    const p = buildSystemPrompt()
    expect(p).toContain('You are HilbertRaum')
    // Plain chat answers general questions directly (no offline/no-internet boilerplate every turn).
    expect(p).toContain('from your own knowledge')
    // Document-grounding rules belong to GROUNDED_SYSTEM_PROMPT (rag), NEVER the plain-chat prompt —
    // leaking them made plain chat refuse general questions and push "upload a document" (D:\ testing).
    expect(p).not.toContain('include citations using the provided source labels')
    expect(p).not.toContain('answer only from the context')
    // And no standalone "no internet access" line for the model to parrot on every turn.
    expect(p).not.toContain('You do not have internet access.')
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

  it('a clean reply (mock reports finish_reason "stop") is NOT flagged truncated', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })

    const msg = await generateAssistantMessage(db, runtime(), conv.id, {})
    expect(msg.truncated).toBeUndefined()
    expect(listMessages(db, conv.id).at(-1)?.truncated).toBeUndefined()
  })

  it('flags + persists truncated when the runtime reports finish_reason "length"', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'tell me everything' })

    // A runtime that streams a couple of tokens then stops at the context ceiling.
    const cutOffRuntime: ModelRuntime = {
      modelId: 'cutoff',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      contextWindow: () => 2048,
      async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
        yield 'a partial answer that runs'
        yield ' right into the wall'
        options?.onFinish?.('length')
      }
    }

    const msg = await generateAssistantMessage(db, cutOffRuntime, conv.id, {})
    expect(msg.truncated).toBe(true)
    // Round-trips through the DB read (messages.truncated → Message.truncated).
    expect(listMessages(db, conv.id).at(-1)?.truncated).toBe(true)
  })

  // 2026-07-04 user report: a Fast-mode reply that hit the FAST_MAX_TOKENS cap also finishes with
  // 'length', and the badge then claimed "reached the model's context limit" while the meter
  // (truthfully) sat at single-digit percent. A capped run must NOT wear the context-limit badge.
  it('does NOT flag truncated when finish_reason "length" came from a max_tokens cap (Fast mode)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'tell me everything' })

    const cappedRuntime: ModelRuntime = {
      modelId: 'capped',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      contextWindow: () => 2048,
      async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
        yield 'a quick answer that hits'
        yield ' the fast-mode token cap'
        options?.onFinish?.('length')
      }
    }

    // Fast mode maps to a max_tokens cap inside the runtime — 'length' here means "cap", not window.
    const fast = await generateAssistantMessage(db, cappedRuntime, conv.id, { mode: 'fast' })
    expect(fast.truncated).toBeUndefined()

    // An explicit runtimeOptions cap counts the same way.
    const conv2 = createConversation(db, {})
    appendMessage(db, { conversationId: conv2.id, role: 'user', content: 'again' })
    const capped = await generateAssistantMessage(db, cappedRuntime, conv2.id, {
      runtimeOptions: { maxTokens: 64 }
    })
    expect(capped.truncated).toBeUndefined()
  })

  // Meter honesty: the assembled prompt (system + fitted history) is reported over the LAUNCHED
  // window so the live meter mirrors what the model actually received — not a renderer guess.
  it('reports the real assembled-prompt usage via onPromptUsage', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping pong ping pong' })

    let usage: { usedTokens: number; window: number } | null = null
    await generateAssistantMessage(db, runtime(), conv.id, {
      onPromptUsage: (u) => {
        usage = u
      }
    })
    expect(usage).not.toBeNull()
    // The launched window (mock runtime contextTokens), not settings.contextTokens.
    expect(usage!.window).toBe(2048)
    // System prompt + the user turn are both counted — well above the bare question's words.
    expect(usage!.usedTokens).toBeGreaterThan(4)
  })

  it('a user Stop is NOT flagged truncated even though the reply is partial (no finish_reason)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'ping' })

    const controller = new AbortController()
    let n = 0
    const msg = await generateAssistantMessage(db, runtime(), conv.id, {
      signal: controller.signal,
      onToken: () => {
        if (++n === 2) controller.abort()
      }
    })
    // The abort carries no finish reason, so the intentional partial is not a length-truncation.
    expect(msg.truncated).toBeUndefined()
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
    expect(deleted).not.toBeNull() // returns the snapshot it deleted (F2 — restorable on failure)
    expect(deleted?.content).toBe(first.content)
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
    expect(deleted).toBeNull() // last turn is a user message — nothing to delete
    const history = listMessages(db, conv.id)
    expect(history).toHaveLength(3)
    expect(history.some((m) => m.id === answer.id)).toBe(true) // the earlier answer survives
  })

  // F2 (post-merge audit): the regenerate guard restores the prior reply byte-faithfully on a
  // non-abort failure. The delete returns a snapshot; restoreMessage re-inserts it exactly so
  // citations / coverage / the skill stamp / the original id all survive a failed regenerate.
  it('delete → restore round-trips a rich assistant reply (id, citations, coverage, skill stamp)', () => {
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

    const snapshot = deleteLastAssistantMessage(db, conv.id)
    expect(snapshot).not.toBeNull()
    expect(hasRegenerableAssistantReply(db, conv.id)).toBe(false) // gone — back to the user turn
    expect(listMessages(db, conv.id)).toHaveLength(1)

    restoreMessage(db, snapshot!)
    const restored = listMessages(db, conv.id).at(-1)
    expect(restored?.id).toBe(original.id) // same identity
    expect(restored?.content).toBe('a grounded answer [S1]')
    expect(restored?.createdAt).toBe(original.createdAt) // sorts back to the tail
    expect(restored?.citations).toEqual(original.citations)
    // Coverage survives the round-trip (the re-read fills the count defaults via parseCoverage).
    expect(restored?.coverage?.mode).toBe('extract')
    expect(restored?.coverage?.fullyChunked).toBe(true)
    expect(restored?.coverage?.chunksCovered).toBe(3)
    expect(restored?.coverage?.chunksTotal).toBe(3)
    // The skill stamp survives at the column level (listMessages resolves skillId via a LEFT JOIN
    // on the skills table, which is empty here — so assert the restored columns directly).
    const raw = db
      .prepare('SELECT skill_id, auto_fired FROM messages WHERE id = ?')
      .get(original.id) as { skill_id: string | null; auto_fired: number | null }
    expect(raw.skill_id).toBe('app:bank-statement')
    expect(raw.auto_fired).toBe(1)
    expect(hasRegenerableAssistantReply(db, conv.id)).toBe(true) // a regenerable reply again
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
