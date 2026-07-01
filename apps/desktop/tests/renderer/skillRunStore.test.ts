// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  startSkillRun,
  getActiveSkillRun,
  getActiveSkillRunConversationId,
  acknowledgeSkillRun,
  resetSkillRunStoreForTests
} from '../../src/renderer/lib/skillruns'
import type { SkillRunState } from '../../src/shared/types'

// Regression for the view-switch bug: navigating away from Chat while a "categorize transactions"
// run is in flight and back landed the user on a NEW empty chat while the badge still spun. The
// module-level store survives the unmount but carried no conversationId, so nothing could re-select
// the run's document chat. It now remembers the origin conversation (`getActiveSkillRunConversationId`).

function doneRun(): SkillRunState {
  return {
    runHandle: 'h1',
    skillInstallId: 'app:bank-statement',
    toolName: 'categorize_transactions',
    documentCount: 1,
    state: 'done',
    progress: { done: 1, total: 1 },
    transactionCount: 1
  }
}

function stubApi(run: SkillRunState): void {
  ;(window as unknown as { api: unknown }).api = {
    startSkillRun: vi.fn(async () => ({ started: true, run })),
    getSkillRun: vi.fn(async () => run),
    clearSkillRun: vi.fn(async () => undefined)
  }
}

afterEach(() => {
  resetSkillRunStoreForTests() // stops polling BEFORE the api stub is removed
  delete (window as unknown as { api?: unknown }).api
})

describe('skill-run store — origin conversation', () => {
  it('is null before any run starts', () => {
    expect(getActiveSkillRunConversationId()).toBeNull()
  })

  it('remembers the conversation that started the run (survives a screen unmount)', async () => {
    const run = doneRun()
    stubApi(run)
    const outcome = await startSkillRun({
      skillInstallId: 'app:bank-statement',
      toolName: 'categorize_transactions',
      conversationId: 'conv-42'
    })
    expect(outcome).toEqual({ started: true })
    expect(getActiveSkillRun()).toBe(run)
    expect(getActiveSkillRunConversationId()).toBe('conv-42')
  })

  it('clears the origin conversation once the terminal run is acknowledged', async () => {
    const run = doneRun()
    stubApi(run)
    await startSkillRun({
      skillInstallId: 'app:bank-statement',
      toolName: 'categorize_transactions',
      conversationId: 'conv-42'
    })
    acknowledgeSkillRun()
    expect(getActiveSkillRun()).toBeNull()
    expect(getActiveSkillRunConversationId()).toBeNull()
  })
})
