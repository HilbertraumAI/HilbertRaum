import { describe, it, expect } from 'vitest'
import type { Db } from '../../src/main/services/db'
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
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { openFreshDb } from '../helpers/db-fixtures'
import { appendTurns, compactionRuntime } from '../helpers/compaction-fixtures'
import { recordingRuntime } from '../helpers/scripted-runtime'

// Phase 2 UX (context-compaction plan §5.1/§5.3/§5.4): the resting context-usage read, the
// transcript summary-marker reader, and the settings toggle that gates compaction. All deterministic
// and offline (a scripted runtime, a temp DB) — no Electron, no network.

function freshDb(): Db {
  return openFreshDb('compaction-ux')
}

describe('getConversationContextUsage (§5.1)', () => {
  it('reports { usedTokens, window } over the launched window and grows with history', () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    const rt = compactionRuntime({ window: 8000 })

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
    const rt = compactionRuntime({ window: 2000 })

    await generateAssistantMessage(db, rt, conv.id)
    expect(rt.summaryCalls).toHaveLength(0)
    expect(getLatestCheckpoint(db, conv.id)).toBeNull()

    // CB-6 / §5.4: the turn threads its ONE settings read into assembly, so a checkpoint cut while compaction was on is
    // ignored by the prompt too.
    const conv2 = createConversation(db, { modelId: 'm' })
    appendTurns(db, conv2.id, 10, 20)
    writeCheckpoint(db, {
      conversationId: conv2.id,
      summary: 'CHECKPOINTMARKER summary',
      coversThroughRowid: listConversationTurns(db, conv2.id)[3].rowid
    })
    appendMessage(db, { conversationId: conv2.id, role: 'user', content: 'the next question' })
    const rec = recordingRuntime('answer', { contextWindow: 8000 }) // ~715 est. tokens: no L1 trim, under the trigger
    await generateAssistantMessage(db, rec, conv2.id)
    expect(rec.calls).toBe(1)
    expect(rec.lastMessages.some((m) => m.content.includes('CHECKPOINTMARKER'))).toBe(false)
    expect(rec.lastMessages.filter((m) => m.role !== 'system')).toHaveLength(11) // all 10 turns + the question, no pair
  })
})
