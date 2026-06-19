import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  appendMessage,
  buildChatMessages,
  COMPACTION_SUMMARY_INTRO,
  createConversation,
  generateAssistantMessage,
  getConversationContextUsage,
  getConversationSummaryMarker,
  getLatestCheckpoint,
  listConversationTurns,
  listMessages,
  writeCheckpoint
} from '../../src/main/services/chat'
import { selfSummaryPrompt } from '../../src/main/services/chat/compaction'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// Phase 2 UX (context-compaction plan §5.1/§5.3/§5.4): the resting context-usage read, the
// transcript summary-marker reader, and the settings toggle that gates compaction. All deterministic
// and offline (a scripted runtime, a temp DB) — no Electron, no network.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-compaction-ux-')), 'test.sqlite'))
}

const words = (n: number): string => Array(n).fill('word').join(' ')

function appendTurns(db: Db, conversationId: string, n: number, wordsPerTurn: number): void {
  for (let i = 0; i < n; i++) {
    appendMessage(db, {
      conversationId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: words(wordsPerTurn)
    })
  }
}

interface ScriptedRuntime extends ModelRuntime {
  summaryCalls: number
}

/** A runtime that distinguishes the compaction summary call from a normal answer call. */
function scriptedRuntime(window: number): ScriptedRuntime {
  const rt: ScriptedRuntime = {
    modelId: 'scripted',
    summaryCalls: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    contextWindow: () => window,
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      if (messages[0]?.content === selfSummaryPrompt) {
        rt.summaryCalls += 1
        for (const tok of 'Goal: testing. Facts: value 42.'.match(/\S+\s*/g) ?? []) {
          if (options?.signal?.aborted) return
          yield tok
        }
        return
      }
      yield 'answer'
    }
  }
  return rt
}

describe('getConversationContextUsage (§5.1)', () => {
  it('reports { usedTokens, window } over the launched window and grows with history', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    const rt = scriptedRuntime(8000)

    appendTurns(db, conv.id, 4, 20)
    const small = getConversationContextUsage(db, rt, conv.id)
    expect(small.window).toBe(8000)
    expect(small.usedTokens).toBeGreaterThan(0)

    appendTurns(db, conv.id, 10, 50)
    const bigger = getConversationContextUsage(db, rt, conv.id)
    expect(bigger.window).toBe(8000)
    expect(bigger.usedTokens).toBeGreaterThan(small.usedTokens)
  })

  it('falls back to settings.contextTokens when no runtime reports a window', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 2, 10)
    const usage = getConversationContextUsage(db, null, conv.id)
    expect(usage.window).toBe(getSettings(db).contextTokens) // default 4096
  })
})

describe('getConversationSummaryMarker (§5.3, D-b)', () => {
  it('places the marker before the first turn the checkpoint does NOT subsume', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 10, 20)
    const turns = listConversationTurns(db, conv.id)
    // Summarize through the 4th turn (index 3); the 5th (index 4) is the first kept verbatim.
    const coversThroughRowid = turns[3].rowid
    writeCheckpoint(db, { conversationId: conv.id, summary: 'SUMMARY of earlier turns', coversThroughRowid })

    const marker = getConversationSummaryMarker(db, conv.id)
    expect(marker).not.toBeNull()
    expect(marker!.summary).toBe('SUMMARY of earlier turns')
    // listMessages excludes the checkpoint row and is in the same order as the turns.
    expect(marker!.beforeMessageId).toBe(listMessages(db, conv.id)[4].id)
  })

  it('returns null when no checkpoint has been cut', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 4, 20)
    expect(getConversationSummaryMarker(db, conv.id)).toBeNull()
  })

  it('returns null when compaction is disabled (the assembly is ignoring the checkpoint)', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 10, 20)
    writeCheckpoint(db, {
      conversationId: conv.id,
      summary: 'SUMMARY',
      coversThroughRowid: listConversationTurns(db, conv.id)[3].rowid
    })
    updateSettings(db, { chatCompactionEnabled: false })
    expect(getConversationSummaryMarker(db, conv.id)).toBeNull()
  })
})

describe('chatCompactionEnabled toggle (§5.4) — false reproduces L1-only behaviour', () => {
  it('buildChatMessages injects the summary pair when enabled, ignores the checkpoint when disabled', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv.id, 10, 20)
    const turns = listConversationTurns(db, conv.id)
    writeCheckpoint(db, {
      conversationId: conv.id,
      summary: 'CHECKPOINTMARKER summary',
      coversThroughRowid: turns[3].rowid
    })

    // Enabled (default): the synthetic summary pair is injected and only post-checkpoint turns replay.
    const enabled = buildChatMessages(db, conv.id)
    expect(enabled.some((m) => m.content.includes('CHECKPOINTMARKER'))).toBe(true)
    expect(enabled.some((m) => m.content.startsWith(COMPACTION_SUMMARY_INTRO))).toBe(true)
    const enabledTurns = enabled.filter((m) => m.role !== 'system')
    // summary pair (2) + the 6 post-checkpoint turns = 8 (vs 10 raw turns).
    expect(enabledTurns.length).toBe(2 + (turns.length - 4))

    // Disabled: no summary pair, FULL history replays — byte-identical to the pre-feature app.
    updateSettings(db, { chatCompactionEnabled: false })
    const disabled = buildChatMessages(db, conv.id)
    expect(disabled.some((m) => m.content.includes('CHECKPOINTMARKER'))).toBe(false)
    expect(disabled.filter((m) => m.role !== 'system').length).toBe(turns.length)
  })

  it('generateAssistantMessage creates NO checkpoint and never calls the summarizer when disabled', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    updateSettings(db, { chatCompactionEnabled: false })
    appendTurns(db, conv.id, 14, 90) // well over 0.85 × 2000 — would compact if enabled
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'the current question' })
    const rt = scriptedRuntime(2000)

    await generateAssistantMessage(db, rt, conv.id)
    expect(rt.summaryCalls).toBe(0)
    expect(getLatestCheckpoint(db, conv.id)).toBeNull()
  })
})
