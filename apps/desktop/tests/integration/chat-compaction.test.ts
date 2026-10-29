import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  appendMessage,
  BASE_SYSTEM_PROMPT,
  buildChatMessages,
  buildSystemPrompt,
  CHAT_RESPONSE_RESERVE_TOKENS,
  COMPACTION_SUMMARY_ACK,
  COMPACTION_SUMMARY_INTRO,
  compactionSummaryPair,
  createConversation,
  generateAssistantMessage,
  getLatestCheckpoint,
  listConversationTurns,
  listMessages,
  messageTokens,
  searchMessages,
  writeCheckpoint
} from '../../src/main/services/chat'
import {
  COMPACT_THRESHOLD,
  ensureCompacted,
  KEEP_RECENT_TURNS,
  MIN_COMPACTABLE_TURNS,
  selfSummaryPrompt
} from '../../src/main/services/chat/compaction'
import {
  buildGroundedChatMessages,
  EXCERPT_BEGIN,
  EXCERPT_END,
  EXCERPT_GUARD_LINE,
  GROUNDED_SYSTEM_PROMPT
} from '../../src/main/services/rag'
import { ChatStreamError } from '../../src/main/services/runtime/llama'
import { log } from '../../src/main/services/logging'
import type { ChatMessage, ModelRuntime } from '../../src/main/services/runtime'
import { legacyDbPath, openFreshDb } from '../helpers/db-fixtures'
import {
  appendTurns,
  compactionRuntime,
  type CompactionRuntimeOptions,
  words
} from '../helpers/compaction-fixtures'

afterEach(() => {
  vi.restoreAllMocks()
})

function freshDb(): Db {
  return openFreshDb('compaction')
}

describe('ensureCompacted — trigger boundaries (no needless model call)', () => {
  it('does NOT call the model when the history is below threshold', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 5) // tiny turns — well under 0.85 × 8000
    const rt = compactionRuntime({ window: 8000 })
    await ensureCompacted(db, rt, conv.id, 8000, {})
    expect(rt.summaryCalls).toHaveLength(0)
    expect(getLatestCheckpoint(db, conv.id)).toBeNull()
  })
})

// CB-3: the compaction trigger used to be a flat 0.85·window, which on a small window fires AFTER
// L1 (window − reserve) has already started silently dropping the oldest turns. The fix caps the
// trigger at the L1 floor and folds the previously-omitted fixed prompt costs into the estimate.
describe('ensureCompacted — CB-3 threshold cap + estimate fold-in', () => {
  const perTurn = (W: number): number => messageTokens({ role: 'user', content: words(W) })
  const sysTokens = (): number => messageTokens({ role: 'system', content: BASE_SYSTEM_PROMPT })

  it('a small window (4096) compacts in the band L1 would have silently dropped (old trigger would not fire)', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    // 14 turns × 113 words ⇒ Σ turnTokens ≈ 3206, which sits in the (window−1024=3072, 0.85·window=3482)
    // band: the OLD trigger (3482) never fires here so L1 begins dropping the oldest turns with no
    // checkpoint; CB-3 caps the trigger at the L1 floor (3072) so compaction fires FIRST.
    appendTurns(db, conv.id, 14, 113)
    const sum = 14 * perTurn(113)
    expect(sum).toBeGreaterThanOrEqual(4096 - CHAT_RESPONSE_RESERVE_TOKENS) // ≥ 3072 (the new, capped trigger)
    expect(sum).toBeLessThan(COMPACT_THRESHOLD * 4096) // < 3482 (the old flat trigger) — old code would NOT fire
    const rt = compactionRuntime({ window: 4096 })
    await ensureCompacted(db, rt, conv.id, 4096, {})
    expect(rt.summaryCalls).toHaveLength(1)
    expect(getLatestCheckpoint(db, conv.id)).not.toBeNull()
  })

  it('a large window (8192-class) keeps the exact 0.85·window trigger — the L1-floor cap is NOT the min', async () => {
    // For window ≥ 6827, 0.85·window ≤ window−1024, so min() selects 0.85·window BYTE-IDENTICAL to
    // pre-CB-3. Pin it with a ±1 window sweep across the fire boundary on the 0.85·window branch.
    const build = (): { db: Db; convId: string } => {
      const db = freshDb()
      const conv = createConversation(db, { modelId: 'm' })
      appendTurns(db, conv.id, 20, 200)
      return { db, convId: conv.id }
    }
    const estimated = sysTokens() + 20 * perTurn(200) // matches the code's no-checkpoint, no-fence estimate
    const fireWindow = Math.floor(estimated / COMPACT_THRESHOLD) // 0.85·window ≤ estimated ⇒ fires
    const noFireWindow = fireWindow + 1 // 0.85·window > estimated ⇒ returns
    expect(fireWindow).toBeGreaterThanOrEqual(6827) // the 0.85·window branch is the min at this scale

    const a = build()
    await ensureCompacted(a.db, compactionRuntime({ window: fireWindow }), a.convId, fireWindow, {})
    expect(getLatestCheckpoint(a.db, a.convId)).not.toBeNull() // estimated ≥ 0.85·window ⇒ compacts

    const b = build()
    const rtB = compactionRuntime({ window: noFireWindow })
    await ensureCompacted(b.db, rtB, b.convId, noFireWindow, {})
    expect(rtB.summaryCalls).toHaveLength(0) // estimated < 0.85·window ⇒ no compaction
    expect(getLatestCheckpoint(b.db, b.convId)).toBeNull()
  })

  it('the estimate fold-in (real summary pair + system prompt) fires a turn sooner than the bare old estimate', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    // A prior checkpoint over the first few turns, then a run of post-checkpoint turns.
    appendTurns(db, conv.id, 4, 5)
    const preTurns = listConversationTurns(db, conv.id)
    const summary = words(50)
    writeCheckpoint(db, {
      conversationId: conv.id,
      summary,
      coversThroughRowid: preTurns[preTurns.length - 1].rowid
    })
    appendTurns(db, conv.id, 14, 90) // 14 post-checkpoint turns (region 8 ≥ MIN)
    const postSum = 14 * perTurn(90)

    // OLD pre-pass counted a BARE summary + '' ack and no system prompt; CB-3 counts the real
    // compactionSummaryPair text (intro + ack) + the base system prompt → a larger, honest estimate.
    const oldPair =
      messageTokens({ role: 'user', content: summary }) +
      messageTokens({ role: 'assistant', content: '' })
    const newPair = compactionSummaryPair(summary).reduce((s, m) => s + messageTokens(m), 0)
    const oldEstimate = oldPair + postSum
    const newEstimate = newPair + sysTokens() + postSum
    expect(newEstimate).toBeGreaterThan(oldEstimate) // the fold-in is strictly larger

    // A small window whose L1-floor trigger sits EXACTLY at the NEW estimate: the new code fires
    // (estimated === threshold), the old bare estimate (< threshold) would not have.
    const window = newEstimate + CHAT_RESPONSE_RESERVE_TOKENS
    expect(window).toBeLessThan(6827) // floor branch active ⇒ threshold = window − reserve = newEstimate
    expect(oldEstimate).toBeLessThan(window - CHAT_RESPONSE_RESERVE_TOKENS) // old estimate is below threshold

    const rt = compactionRuntime({ window })
    await ensureCompacted(db, rt, conv.id, window, {})
    expect(rt.summaryCalls).toHaveLength(1)
    const cp = getLatestCheckpoint(db, conv.id)
    expect(cp?.coversThroughRowid).toBeGreaterThan(preTurns[preTurns.length - 1].rowid) // a new, rolling checkpoint
  })
})

// T-5 — the compaction boundaries were only asserted "by construction" before. These pin the two
// equality edges so an off-by-one (`<`↔`<=`, threshold ±1) reddens.
describe('T-5 — compaction boundaries (teeth on the equality edges)', () => {
  const perTurn = (W: number): number => messageTokens({ role: 'user', content: words(W) })

  it('Boundary-2: region.length === MIN_COMPACTABLE_TURNS proceeds; MIN−1 returns (teeth: flip <→<=)', async () => {
    const bigWords = 400 // huge turns so the SIZE trigger is never the reason for a no-op

    // A large region overflows the summarizer's own window (map/reduce ⇒ several summary calls), so
    // assert on the CHECKPOINT — written iff compaction proceeded — rather than the call count.
    const proceed = freshDb()
    const c1 = createConversation(proceed, { modelId: 'm' })
    appendTurns(proceed, c1.id, KEEP_RECENT_TURNS + MIN_COMPACTABLE_TURNS, bigWords) // region === MIN
    const rt1 = compactionRuntime({ window: 2000 })
    await ensureCompacted(proceed, rt1, c1.id, 2000, {})
    expect(getLatestCheckpoint(proceed, c1.id)).not.toBeNull() // region === MIN ⇒ compacts

    // MIN−1: the CODE-19 walk keeps an alternating region even, so the odd edge needs an orphan user turn (a failed
    // answer): [u, u, a, u, a, u | a, u, a, u, a, u] — regionEnd 6 walks back to 5 because index 5 is a user turn.
    const ret = freshDb()
    const c2 = createConversation(ret, { modelId: 'm' })
    appendMessage(ret, { conversationId: c2.id, role: 'user', content: words(bigWords) })
    appendTurns(ret, c2.id, KEEP_RECENT_TURNS + MIN_COMPACTABLE_TURNS - 1, bigWords)
    const rt2 = compactionRuntime({ window: 2000 })
    await ensureCompacted(ret, rt2, c2.id, 2000, {})
    expect(rt2.summaryCalls).toHaveLength(0)
    expect(getLatestCheckpoint(ret, c2.id)).toBeNull() // region === MIN−1 ⇒ no-op
  })

  it('Boundary-1: estimated === threshold proceeds; threshold−1 returns — min(0.85·window, window−reserve) (CB-3)', async () => {
    // Same conversation twice; sweep the window by 1 so the L1-floor threshold (window−reserve) lands
    // exactly at, then one above, the estimate. Ties CB-3's threshold expression to a hard equality.
    const build = (): { db: Db; convId: string } => {
      const db = freshDb()
      const conv = createConversation(db, { modelId: 'm' })
      appendTurns(db, conv.id, 14, 90)
      return { db, convId: conv.id }
    }
    const estimated = messageTokens({ role: 'system', content: BASE_SYSTEM_PROMPT }) + 14 * perTurn(90)
    const atWindow = estimated + CHAT_RESPONSE_RESERVE_TOKENS // threshold = window − reserve === estimated
    const belowWindow = atWindow + 1 // threshold = estimated + 1 > estimated
    expect(atWindow).toBeLessThan(6827) // floor branch (window−reserve) is the min for these windows
    expect(COMPACT_THRESHOLD * atWindow).toBeGreaterThan(estimated) // min() picks the floor, not 0.85·window

    const a = build()
    const rtA = compactionRuntime({ window: atWindow })
    await ensureCompacted(a.db, rtA, a.convId, atWindow, {})
    expect(rtA.summaryCalls).toHaveLength(1) // estimated === threshold ⇒ NOT (estimated < threshold) ⇒ proceeds

    const b = build()
    const rtB = compactionRuntime({ window: belowWindow })
    await ensureCompacted(b.db, rtB, b.convId, belowWindow, {})
    expect(rtB.summaryCalls).toHaveLength(0) // estimated === threshold−1 ⇒ estimated < threshold ⇒ returns
  })
})

// CODE-19 (full-audit 2026-07-11): the region boundary is exchange-aligned — it must end on an
// ASSISTANT turn. With an ODD compactable count the naive cut ends on a USER turn, so the first
// replayed post-checkpoint turn is the assistant ANSWER to a summarized-away question and
// `collapseToAlternating` (last-wins) silently REPLACES the synthetic summary ack with it.
describe('ensureCompacted — exchange-aligned region boundary (CODE-19)', () => {
  it('an odd compactable count still replays user-first: the ack survives assembly', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 15, 90) // ODD count; the naive region cut (15 − 6 = 9) ends on a USER turn
    const rt = compactionRuntime({ window: 2000 })
    await ensureCompacted(db, rt, conv.id, 2000, {})
    const cp = getLatestCheckpoint(db, conv.id)
    expect(cp).not.toBeNull()

    // The region boundary walked back to an ASSISTANT turn…
    const coveredRole = (
      db.prepare('SELECT role FROM messages WHERE rowid = ?').get(cp!.coversThroughRowid) as { role: string }
    ).role
    expect(coveredRole).toBe('assistant')
    // …so the first replayed post-checkpoint turn is a USER turn.
    const replayedTurns = listConversationTurns(db, conv.id, cp!.coversThroughRowid)
    expect(replayedTurns[0]?.role).toBe('user')

    // Assembly: the synthetic ack survives (pre-fix it was silently replaced by the stale answer
    // to a summarized-away question) and alternation holds from the summary pair onward.
    const built = buildChatMessages(db, conv.id)
    expect(built[2]).toEqual({ role: 'assistant', content: COMPACTION_SUMMARY_ACK })
    expect(built[3]?.role).toBe('user')
    for (let i = 2; i < built.length; i++) expect(built[i].role).not.toBe(built[i - 1].role)
  })

  it('an even compactable count is byte-identical to before (the walk is a no-op)', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 90) // EVEN — the naive cut already ends on an assistant turn
    const rt = compactionRuntime({ window: 2000 })
    await ensureCompacted(db, rt, conv.id, 2000, {})
    const cp = getLatestCheckpoint(db, conv.id)
    expect(cp).not.toBeNull()
    // The region still covers exactly the first 8 turns (14 − KEEP_RECENT_TURNS), ending assistant.
    const turns = listConversationTurns(db, conv.id)
    expect(cp!.coversThroughRowid).toBe(turns[14 - KEEP_RECENT_TURNS - 1].rowid)
  })
})

describe('ensureCompacted — checkpoint lifecycle', () => {
  it('writes ONE checkpoint over threshold and reuses it across later turns (summarize once)', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 90) // ≈ 2624 est tokens > 0.85 × 2000
    const rt = compactionRuntime({ window: 2000 })

    await ensureCompacted(db, rt, conv.id, 2000, {})
    const cp = getLatestCheckpoint(db, conv.id)
    expect(cp).not.toBeNull()
    expect(rt.summaryCalls).toHaveLength(1)

    // A second turn with no new content: the cached checkpoint already dropped us below threshold.
    await ensureCompacted(db, rt, conv.id, 2000, {})
    expect(rt.summaryCalls).toHaveLength(1) // NOT re-summarized
    expect(getLatestCheckpoint(db, conv.id)?.rowid).toBe(cp?.rowid)
  })

  it('chained re-compaction folds the PRIOR summary into the new one', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 90)
    const rt = compactionRuntime({ window: 2000, summary: 'PRIORMARKER earlier summary text.' })

    await ensureCompacted(db, rt, conv.id, 2000, {})
    expect(rt.summaryCalls).toHaveLength(1)
    const firstCp = getLatestCheckpoint(db, conv.id)

    // Enough new turns to re-cross the threshold over the post-checkpoint window.
    appendTurns(db, conv.id, 8, 90)
    await ensureCompacted(db, rt, conv.id, 2000, {})

    expect(rt.summaryCalls).toHaveLength(2)
    // The second summarizer call saw the prior summary as input (chained, §4.7).
    expect(rt.summaryCalls[1].input).toContain('PRIORMARKER')
    const secondCp = getLatestCheckpoint(db, conv.id)
    expect(secondCp?.rowid).not.toBe(firstCp?.rowid) // a new, rolling checkpoint
    expect(secondCp!.coversThroughRowid).toBeGreaterThan(firstCp!.coversThroughRowid)
  })
})

describe('ensureCompacted — fallback safety (a failure never breaks the turn)', () => {
  it('writes NO checkpoint when the turn is aborted mid-summary', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 90) // region 8 × 90 ≈ 728 approx-tokens ≤ summaryBudgetWords(2000) = 913: ONE summary call
    const ac = new AbortController()
    // The Stop lands after the first summary token: the partial is NON-empty, so only the post-summary abort check
    // (not the empty-summary check) can stop the checkpoint.
    const rt: ModelRuntime = {
      modelId: 'abort-mid-summary',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      async *chatStream(messages: ChatMessage[]) {
        if (messages[0]?.content !== selfSummaryPrompt) {
          yield 'answer'
          return
        }
        yield 'Goal: '
        ac.abort()
        yield 'testing.'
      }
    }
    await ensureCompacted(db, rt, conv.id, 2000, { signal: ac.signal })
    expect(ac.signal.aborted).toBe(true)
    expect(getLatestCheckpoint(db, conv.id)).toBeNull()
  })

  // F9 (post-merge audit): a NON-abort summarizer failure (a real bug — TypeError, malformed
  // checkpoint) used to be swallowed by an empty `catch {}`. On an offline, no-telemetry app a
  // repeatable summarizer bug then compacts NEVER, silently, forever — long-context quality
  // degrades with zero diagnostic surface. The fallback to L1 stays; the non-abort case now logs.
  it('logs a warning (and still falls back to L1) when the summarizer fails for a non-abort reason', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 90)
    const rt = compactionRuntime({ window: 2000, failSummary: true })

    await expect(ensureCompacted(db, rt, conv.id, 2000, {})).resolves.toBeUndefined()
    expect(getLatestCheckpoint(db, conv.id)).toBeNull() // fallback intact — no checkpoint
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, meta] = warnSpy.mock.calls[0]
    expect(message).toMatch(/compaction summary failed/i)
    // The diagnostic carries the conversation id + the underlying error message (no chat content).
    expect(meta).toMatchObject({ conversationId: conv.id, message: 'summary boom' })
  })

  it('does NOT log when the summary is abandoned by a user Stop (abort is expected, not a bug)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 90)
    // What a fetch-backed runtime does on a user Stop: it REJECTS with an AbortError, so the catch runs and only its
    // abort filter keeps the log quiet.
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const rt = compactionRuntime({ window: 2000, failSummaryMidStream: abortError })
    await expect(ensureCompacted(db, rt, conv.id, 2000, {})).resolves.toBeUndefined()
    expect(rt.summaryCalls).toHaveLength(1)
    expect(getLatestCheckpoint(db, conv.id)).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // R4: a failed summary never breaks the turn — the L1 fallback answers. F-02 (audit 2026-07-16)
  // consumer semantics: the summarizer stream FAILS MID-WAY with an in-band error frame (the fixed
  // readChatSSE throws ChatStreamError after some tokens). Pre-fix the reader ended cleanly and the
  // SILENTLY TRUNCATED summary was written as the conversation's compaction checkpoint, corrupting
  // every later turn's assembled context. The decided semantics: a failed summary must NEVER become
  // a checkpoint — the existing R4/R6 fallback (L1 trim, turn proceeds, non-abort logged) absorbs
  // the rejection.
  const failures: Array<[string, Partial<CompactionRuntimeOptions>]> = [
    ['the summarizer throws before its first token', { failSummary: true }],
    [
      'the summary stream fails MID-WAY with an in-band error frame (F-02)',
      { failSummaryMidStream: new ChatStreamError('slot error', 'server_error') }
    ]
  ]
  it.each(failures)('generateAssistantMessage still answers, writes NO checkpoint and logs once when %s', async (_label, failure) => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 14, 90)
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'the current question' })
    const rt = compactionRuntime({ window: 2000, ...failure })
    const msg = await generateAssistantMessage(db, rt, conv.id)
    expect(msg.role).toBe('assistant')
    expect(msg.content.length).toBeGreaterThan(0) // the turn proceeded on the L1 fallback
    expect(rt.answerCalls).toBe(1)
    expect(rt.summaryCalls).toHaveLength(1) // the summarizer ran and failed
    expect(getLatestCheckpoint(db, conv.id)).toBeNull() // the failed summary was NOT checkpointed
    expect(warnSpy).toHaveBeenCalledTimes(1) // a real (non-abort) failure is logged, content-free
  })
})

describe('assembly after a checkpoint (§4.5 synthetic pair)', () => {
  function withCheckpoint(): { db: Db; convId: string } {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 11, 8)
    // Cut a checkpoint covering through the 4th turn.
    const turns = listConversationTurns(db, conv.id)
    writeCheckpoint(db, {
      conversationId: conv.id,
      summary: 'SUMMARYBODY of the earlier turns.',
      coversThroughRowid: turns[3].rowid
    })
    return { db, convId: conv.id }
  }

  it('keeps the leading system prompt byte-identical and injects the summary pair', () => {
    const { db, convId } = withCheckpoint()
    const built = buildChatMessages(db, convId)
    expect(built[0]).toEqual({ role: 'system', content: buildSystemPrompt() })
    expect(built[1]).toEqual({
      role: 'user',
      content: `${COMPACTION_SUMMARY_INTRO}\n\nSUMMARYBODY of the earlier turns.`
    })
    expect(built[2]).toEqual({ role: 'assistant', content: COMPACTION_SUMMARY_ACK })
  })

  it('still fits the context window after compaction (L1 floor holds)', () => {
    const { db, convId } = withCheckpoint()
    const all = buildChatMessages(db, convId)
    const window = 1300 // budget 276; the untrimmed assembly is ~463, so the L1 trim must run
    const budget = window - CHAT_RESPONSE_RESERVE_TOKENS
    expect(all.reduce((s, m) => s + messageTokens(m), 0)).toBeGreaterThan(budget) // the precondition (was false at 1500)
    const fitted = buildChatMessages(db, convId, window)
    expect(fitted.length).toBeLessThan(all.length)
    expect(fitted.reduce((s, m) => s + messageTokens(m), 0)).toBeLessThanOrEqual(budget)
    expect(fitted[0].role).toBe('system')
    expect(fitted[1].role).toBe('user')
    // The final turn is always retained.
    expect(fitted[fitted.length - 1]).toEqual(all[all.length - 1])
  })
})

describe('RAG assembly — checkpoint from raw turns, live citations intact (R-RAG)', () => {
  it('injects the summary pair and keeps the grounded final turn (citations) untouched', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm', mode: 'documents' })
    appendTurns(db, conv.id, 11, 8)
    const turns = listConversationTurns(db, conv.id)
    writeCheckpoint(db, {
      conversationId: conv.id,
      summary: 'RAGSUMMARY earlier doc Q&A.',
      coversThroughRowid: turns[3].rowid
    })
    // The grounded turn as buildGroundedPrompt renders it (#228: the excerpt block is delimited + guarded).
    const grounded =
      'Question:\nWhat is X?\n\nDocument excerpts:\n' +
      `${EXCERPT_BEGIN}\n[S1] File: Doc | Page: 2\n"X is 42."\n${EXCERPT_END}\n${EXCERPT_GUARD_LINE}\n\nAnswer:`
    const built = buildGroundedChatMessages(db, conv.id, grounded, 4096)

    expect(built[0]).toEqual({ role: 'system', content: GROUNDED_SYSTEM_PROMPT })
    expect(built[1].content).toContain('RAGSUMMARY')
    // The live grounded turn (question + [S1] excerpt) is the final, mandatory message.
    expect(built[built.length - 1]).toEqual({ role: 'user', content: grounded })
  })
})

describe('migration (R13) + FTS exclusion (R8)', () => {
  function oldStyleDbPath(conversationId: string, messageId: string): string {
    return legacyDbPath('oldschema', (raw) => {
      raw.exec('PRAGMA foreign_keys = ON;')
      // The messages schema as it stood BEFORE the kind/covers columns existed, plus the OLD
      // FTS insert trigger (no kind guard) — exactly what an upgraded DB starts from.
      raw.exec(
        `CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL DEFAULT 'chat');`
      )
      raw.exec(
        `CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
           content TEXT NOT NULL, created_at TEXT NOT NULL, token_count INTEGER, citations_json TEXT,
           FOREIGN KEY (conversation_id) REFERENCES conversations(id));`
      )
      raw.exec('CREATE VIRTUAL TABLE messages_fts USING fts5(content, message_id UNINDEXED);')
      raw.exec(
        `CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
           INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
         END;`
      )
      const now = new Date().toISOString()
      raw.prepare(
        'INSERT INTO conversations (id, title, created_at, updated_at, mode) VALUES (?, ?, ?, ?, ?)'
      ).run(conversationId, 'Old chat', now, now, 'chat')
      raw.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(messageId, conversationId, 'user', 'legacy findme message', now)
    })
  }

  it('reads pre-migration messages as plain turns and upgrades the FTS trigger to exclude checkpoints', () => {
    const convId = randomUUID()
    const msgId = randomUUID()
    const db = openDatabase(oldStyleDbPath(convId, msgId))

    // Old row round-trips: kind is NULL ⇒ a plain message.
    const msgs = listMessages(db, convId)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('legacy findme message')
    expect(searchMessages(db, 'findme').length).toBe(1)

    // A checkpoint written post-upgrade is excluded from search (R8) AND from the rendered history.
    writeCheckpoint(db, {
      conversationId: convId,
      summary: 'SECRETCHECKPOINT body',
      coversThroughRowid: 1
    })
    expect(searchMessages(db, 'SECRETCHECKPOINT')).toHaveLength(0)
    expect(listMessages(db, convId)).toHaveLength(1) // still just the one real turn
  })
})
