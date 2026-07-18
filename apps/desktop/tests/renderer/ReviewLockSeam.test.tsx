// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import {
  editReviewItem,
  getReviewSessionSnapshot,
  openReviewSession,
  resetReviewSessionForTests
} from '../../src/renderer/lib/reviewSession'
import {
  DEFAULT_SETTINGS,
  type AppStatus,
  type EvidenceReviewItemPatch,
  type PolicyStatus,
  type PreflightResult,
  type WorkspaceStateInfo
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { makeDetail, makeItem } from '../helpers/evidenceReview'

// EP-1 Phase 2 review FIX-3 — the review store's LOCK SEAM, pinned end-to-end through the
// real `App.lockNow`. The wiring under test (App.tsx + lockPurge.ts):
//   1. flushReviewSession()  — pending review edits are WRITTEN while the vault is still
//                              writable (a flush after lockWorkspace would be refused);
//   2. window.api.lockWorkspace()
//   3. purgeSessionStores()  — the resident decrypted review content is dropped.
// Deleting the purge, or moving the flush after the lock, must redden THIS suite — before
// it, the whole suite stayed green with either mutation.

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
const offlinePolicy = { offlineMode: true } as PolicyStatus

afterEach(() => {
  cleanup()
  resetReviewSessionForTests()
  vi.restoreAllMocks()
})

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

describe('App.lockNow — review auto-save flushes BEFORE the vault locks, then purges (FIX-3)', () => {
  it('a note pending just before lock is SAVED (flush → lockWorkspace → purge, in that order)', async () => {
    const lockWorkspace = vi.fn(async () => lockedState)
    const updateEvidenceReviewItem = vi.fn(
      async (id: string, patch: EvidenceReviewItemPatch) => makeItem({ id, ...patch })
    )
    stubApi({
      getWorkspaceState: vi.fn(async () => unlockedEncrypted),
      getPolicy: vi.fn(async () => offlinePolicy),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      onRuntimeNotice: vi.fn(() => () => {}),
      lockWorkspace,
      getAppStatus: vi.fn(async () => ({ workspaceReady: true }) as unknown as AppStatus),
      getRuntimeStatus: vi.fn(async () => ({
        running: false,
        modelId: null,
        port: null,
        healthy: false,
        message: 'Stopped'
      })),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(
        async () =>
          ({
            ok: true,
            rootPath: '/d',
            writable: true,
            freeBytes: 1e9,
            slowDriveWarning: null,
            problems: []
          }) as unknown as PreflightResult
      ),
      getEvidenceReview: vi.fn(async () => makeDetail()),
      updateEvidenceReviewItem
    })

    const user = userEvent.setup()
    render(<App />)
    const nav = await screen.findByRole('navigation')
    const lockBtn = within(nav).getByRole('button', { name: 'Lock now' })

    // Seed the module-level review store the way the review screen would: an open review
    // with a note edit still inside the debounce window (pending, NOT yet written).
    await openReviewSession({ reviewId: 'r1' })
    editReviewItem('i1', { reviewerNote: 'typed just before lock' })
    expect(getReviewSessionSnapshot().saveState).toBe('pending')
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()

    await user.click(lockBtn)

    // The pending note was WRITTEN (not lost) — and written BEFORE the vault locked.
    expect(updateEvidenceReviewItem).toHaveBeenCalledWith('i1', {
      reviewerNote: 'typed just before lock'
    })
    expect(lockWorkspace).toHaveBeenCalledTimes(1)
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
    stubApi({
      getWorkspaceState: vi.fn(async () => unlockedEncrypted),
      getPolicy: vi.fn(async () => offlinePolicy),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      onRuntimeNotice: vi.fn(() => () => {}),
      lockWorkspace,
      getAppStatus: vi.fn(async () => ({ workspaceReady: true }) as unknown as AppStatus),
      getRuntimeStatus: vi.fn(async () => ({
        running: false,
        modelId: null,
        port: null,
        healthy: false,
        message: 'Stopped'
      })),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(
        async () =>
          ({
            ok: true,
            rootPath: '/d',
            writable: true,
            freeBytes: 1e9,
            slowDriveWarning: null,
            problems: []
          }) as unknown as PreflightResult
      ),
      getEvidenceReview: vi.fn(async () => makeDetail()),
      updateEvidenceReviewItem: vi.fn(async () => {
        throw new Error('disk full')
      })
    })

    const user = userEvent.setup()
    render(<App />)
    const nav = await screen.findByRole('navigation')

    await openReviewSession({ reviewId: 'r1' })
    editReviewItem('i1', { reviewerNote: 'will fail to save' })

    await user.click(within(nav).getByRole('button', { name: 'Lock now' }))
    expect(lockWorkspace).toHaveBeenCalledTimes(1)
    // The store is still purged — nothing resident after lock, even on a failed flush.
    await waitFor(() => expect(getReviewSessionSnapshot().detail).toBeNull())
  })
})
