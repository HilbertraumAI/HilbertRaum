// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, waitFor, fireEvent } from '@testing-library/react'
import type { PreloadApi } from '../../src/preload'
import { App } from '../../src/renderer/App'
import {
  REVIEW_LOCK_FLUSH_BOUND_MS,
  bulkClearDecisions,
  editReviewItem,
  getReviewSessionSnapshot,
  openReviewSession,
  purgeReviewSession
} from '../../src/renderer/lib/reviewSession'
import {
  type EvidenceReviewItemPatch,
  type WorkspaceStateInfo
} from '../../src/shared/types'

import { makeDetail, makeItem, stubReviewApi } from '../helpers/evidenceReview'
import { appShellStubs } from '../helpers/app-shell'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'

// EP-1 Phase 2 review FIX-3 — the review store's LOCK SEAM, pinned end-to-end through the
// real `App.lockNow`. The wiring under test (App.tsx + lockPurge.ts):
//   1. flushReviewSession()  — pending review edits are WRITTEN while the vault is still
//                              writable (a flush after lockWorkspace would be refused);
//   2. window.api.lockWorkspace()
//   3. purgeSessionStores()  — the resident decrypted review content is dropped.
// Deleting the purge, or moving the flush after the lock, must redden THIS suite — before
// it, the whole suite stayed green with either mutation.
// The order is asserted synchronously after `fireEvent.click`: nothing awaits between the edit
// and the click, so the 600 ms debounce timer can never be the writer. #832: the suite runs
// `assertNoUnexpectedApiCalls()`; the one call App makes beyond `appShellStubs` is the gate's
// `perfMark('gate_visible')`, stubbed locally.

const unlockedEncrypted: WorkspaceStateInfo = {
  state: 'unlocked',
  mode: 'encrypted',
  plaintextAllowed: false,
  encryptionRequired: true
}
const lockedState: WorkspaceStateInfo = {
  state: 'locked',
  mode: 'encrypted',
  plaintextAllowed: false,
  encryptionRequired: true
}
// #832: once the lock shows the gate, App marks it (App.tsx:231-233). Local on purpose: appShellStubs stays unchanged
// (AppLock and I18n reach the same call outside this group).
const gateMark: Partial<PreloadApi> = { perfMark: () => {} }

afterEach(() => {
  try {
    cleanup()
    assertNoUnexpectedApiCalls()
  } finally {
    purgeReviewSession()
    vi.restoreAllMocks()
  }
})

describe('App.lockNow — review auto-save flushes BEFORE the vault locks, then purges (FIX-3)', () => {
  it('a note pending just before lock is SAVED (flush → lockWorkspace → purge, in that order)', async () => {
    const lockWorkspace = vi.fn(async () => lockedState)
    const updateEvidenceReviewItem = vi.fn(
      async (id: string, patch: EvidenceReviewItemPatch) => makeItem({ id, ...patch })
    )
    stubReviewApi(
      appShellStubs({
        ...gateMark,
        getWorkspaceState: vi.fn(async () => unlockedEncrypted),
        lockWorkspace,
        getEvidenceReview: vi.fn(async () => makeDetail()),
        updateEvidenceReviewItem
      })
    )

    render(<App />)
    const nav = await screen.findByRole('navigation')
    const lockBtn = within(nav).getByRole('button', { name: 'Lock now' })

    // Seed the module-level review store the way the review screen would: an open review
    // with a note edit still inside the debounce window (pending, NOT yet written).
    await openReviewSession({ reviewId: 'r1' })
    editReviewItem('i1', { reviewerNote: 'typed just before lock' })
    // Guard → synchronous trigger → synchronous assert (no await between the edit and the click).
    expect(getReviewSessionSnapshot().saveState).toBe('pending')
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
    fireEvent.click(lockBtn)
    // lockNow's flush reached the IPC before any await; the lock has not been asked yet. The
    // pending note was WRITTEN (not lost) — and written BEFORE the vault locked.
    expect(updateEvidenceReviewItem).toHaveBeenCalledWith('i1', { reviewerNote: 'typed just before lock' })
    expect(lockWorkspace).not.toHaveBeenCalled()
    await waitFor(() => expect(lockWorkspace).toHaveBeenCalledTimes(1))
    expect(Math.max(...updateEvidenceReviewItem.mock.invocationCallOrder)).toBeLessThan(
      lockWorkspace.mock.invocationCallOrder[0]
    )
    // …and after the lock the resident review content is PURGED (nothing pending either).
    await waitFor(() => {
      expect(getReviewSessionSnapshot()).toMatchObject({
        detail: null,
        saveState: 'idle',
        saveError: null
      })
    })
    // The shell swapped to the locked gate.
    expect(
      await screen.findByRole('heading', { name: /unlock your workspace/i })
    ).toBeInTheDocument()
  })

  it('a failed pre-lock flush never blocks the lock (the security action wins)', async () => {
    const lockWorkspace = vi.fn(async () => lockedState)
    const updateEvidenceReviewItem = vi.fn(async () => {
      throw new Error('disk full')
    })
    stubReviewApi(
      appShellStubs({
        ...gateMark,
        getWorkspaceState: vi.fn(async () => unlockedEncrypted),
        lockWorkspace,
        getEvidenceReview: vi.fn(async () => makeDetail()),
        updateEvidenceReviewItem
      })
    )

    render(<App />)
    const nav = await screen.findByRole('navigation')

    await openReviewSession({ reviewId: 'r1' })
    editReviewItem('i1', { reviewerNote: 'will fail to save' })

    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
    fireEvent.click(within(nav).getByRole('button', { name: 'Lock now' }))
    // The pre-lock flush WAS attempted (the title's premise), before the lock.
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)
    expect(lockWorkspace).not.toHaveBeenCalled()
    await waitFor(() => expect(lockWorkspace).toHaveBeenCalledTimes(1))
    // The store is still purged — nothing resident after lock, even on a failed flush.
    await waitFor(() => expect(getReviewSessionSnapshot().detail).toBeNull())
    // #832: end on the gate, so its `gate_visible` mark is always part of the run.
    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
  })

  // #837 review round 5: the pre-lock flush waits for a running bulk sweep (the one write lane). A sweep whose call
  // never answers must not hold the lock hostage: the flush gives up at REVIEW_LOCK_FLUSH_BOUND_MS and the lock runs.
  it('a hung bulk sweep never blocks the lock: the pre-lock flush gives up at its bound', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const lockWorkspace = vi.fn(async () => lockedState)
      const applyEvidenceReviewBulkAction = vi.fn(() => new Promise<never>(() => {}))
      const updateEvidenceReviewItem = vi.fn(
        async (id: string, patch: EvidenceReviewItemPatch) => makeItem({ id, ...patch })
      )
      stubReviewApi(
        appShellStubs({
          ...gateMark,
          getWorkspaceState: vi.fn(async () => unlockedEncrypted),
          lockWorkspace,
          getEvidenceReview: vi.fn(async () =>
            makeDetail({ items: [makeItem({ id: 'i1', decision: 'supported' }), makeItem({ id: 'i2', ordinal: 1 })] })
          ),
          applyEvidenceReviewBulkAction,
          updateEvidenceReviewItem
        })
      )

      render(<App />)
      const nav = await screen.findByRole('navigation')
      await openReviewSession({ reviewId: 'r1' })
      void bulkClearDecisions() // its call never answers
      await waitFor(() => expect(applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1))
      editReviewItem('i2', { reviewerNote: 'typed during the hung sweep' })

      fireEvent.click(within(nav).getByRole('button', { name: 'Lock now' }))
      await vi.advanceTimersByTimeAsync(REVIEW_LOCK_FLUSH_BOUND_MS - 100)
      expect(lockWorkspace).not.toHaveBeenCalled() // still giving the flush its chance…
      await vi.advanceTimersByTimeAsync(200)
      await waitFor(() => expect(lockWorkspace).toHaveBeenCalledTimes(1)) // …then the lock wins
      await waitFor(() => expect(getReviewSessionSnapshot().detail).toBeNull())
      expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
