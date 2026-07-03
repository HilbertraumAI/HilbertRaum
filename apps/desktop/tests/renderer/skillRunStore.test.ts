// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  startSkillRun,
  getActiveSkillRun,
  getActiveSkillRunConversationId,
  getActiveSkillRunDocumentId,
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

// U3 (audit ux-6): the store also remembers the run's RESOLVED target document, so the routed-run
// relay can pin its chat answer to that document even after a screen unmount lost the React state.
describe('skill-run store — routed-run document pin', () => {
  it('is null before any run starts', () => {
    expect(getActiveSkillRunDocumentId()).toBeNull()
  })

  it('remembers the resolved target document id and clears it on acknowledge', async () => {
    const run = doneRun()
    stubApi(run)
    await startSkillRun({
      skillInstallId: 'app:bank-statement',
      toolName: 'summarize_cashflow',
      conversationId: 'conv-42',
      documentId: 'doc-7'
    })
    expect(getActiveSkillRunDocumentId()).toBe('doc-7')
    acknowledgeSkillRun()
    expect(getActiveSkillRunDocumentId()).toBeNull()
  })

  it('is null when the run carried no resolved target (main defaults to first-in-scope)', async () => {
    const run = doneRun()
    stubApi(run)
    await startSkillRun({
      skillInstallId: 'app:bank-statement',
      toolName: 'categorize_transactions',
      conversationId: 'conv-42'
    })
    expect(getActiveSkillRunDocumentId()).toBeNull()
  })
})
