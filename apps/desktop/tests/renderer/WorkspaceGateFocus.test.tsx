// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceGate } from '../../src/renderer/screens/WorkspaceGate'
import type { WorkspaceStateInfo, WorkspaceActionResult, ModelInfo } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { LOCKED_ENCRYPTED_WORKSPACE, UNLOCKED_ENCRYPTED_WORKSPACE } from '../helpers/app-shell'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'

// F20 (audit full-audit-2026-06-29 postmerge): the CREATE flow swaps the whole card per
// `phase` (welcome → password → finishing → starter). A keyboard / screen-reader user who
// advances a step must land ON the new step's primary control, not have focus reset to
// <body> (WCAG 2.4.3 Focus Order / 3.2.2). The welcome CTA keeps its mount-time autoFocus;
// every later transition is driven by a `useEffect(..., [phase])`. The most security-
// sensitive transition is welcome → password (the password-creation field); the `finishing`
// step had NO focus target at all before the fix.

const UNINITIALIZED: WorkspaceStateInfo = {
  state: 'uninitialized',
  mode: null,
  plaintextAllowed: false,
  encryptionRequired: true
}

const okCreate = (): Mock =>
  vi.fn(async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED_ENCRYPTED_WORKSPACE }))

/** Advance create: welcome → password → submit a valid password (lands on finishing). */
async function submitValidPassword(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /get started/i }))
  await user.type(await screen.findByPlaceholderText('Password'), 'longenough')
  await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
  await user.click(screen.getByRole('button', { name: /create workspace/i }))
}

// #832: a window.api call no row stubbed fails that row (cleanup first, so one failure cannot cascade).
afterEach(() => {
  try {
    cleanup()
  } finally {
    assertNoUnexpectedApiCalls()
  }
})

describe('WorkspaceGate — F20 phase-change focus management (WCAG 2.4.3)', () => {
  it('moves focus to the password field on welcome → password', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /get started/i }))
    const pw = await screen.findByPlaceholderText('Password')
    await waitFor(() => expect(document.activeElement).toBe(pw))
  })

  it('moves focus to the Skip control on password → finishing (it had none before)', async () => {
    const user = userEvent.setup()
    // listModels parks → the gate stays on the 'finishing' step so focus is observable. After a successful create the
    // gate subscribes to first-run verify progress (the preload returns an unsubscribe), as in the next row.
    const listModels = vi.fn(() => new Promise<ModelInfo[]>(() => {}))
    stubApi({ createWorkspace: okCreate(), listModels, onModelVerifyProgress: vi.fn(() => () => {}) })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    await submitValidPassword(user)
    const skip = await screen.findByRole('button', { name: /skip/i })
    await waitFor(() => expect(document.activeElement).toBe(skip))
  })

  it('moves focus to the primary action on finishing → starter (no model installed)', async () => {
    const user = userEvent.setup()
    stubApi({
      createWorkspace: okCreate(),
      listModels: vi.fn(async (): Promise<ModelInfo[]> => []),
      onModelVerifyProgress: vi.fn(() => () => {})
    })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    await submitValidPassword(user)
    const choose = await screen.findByRole('button', { name: /choose your ai model/i })
    await waitFor(() => expect(document.activeElement).toBe(choose))
  })
})

// SH-12 + SH-2 (frontend audit 2026-08-09, #145): a WRONG password empties the field and
// disables the submit button focus was sitting on — the retry path must steer focus back to
// the field, and the error must live in an ALWAYS-mounted alert region so the FIRST failure
// is announced (a freshly inserted role="alert" element is missed by many screen readers).
// A failed CREATE is the same keyboard dead end on the password step (#860 R2).
describe('WorkspaceGate — failed unlock or create: focus + announcement (SH-2/SH-12)', () => {
  it.each([
    ['unlock', 'wrong_password', 'main.workspace.wrongPassword'],
    ['create', 'error', 'main.workspace.createFailed']
  ] as const)(
    're-focuses the password field after a failed %s (SH-12), the error in the always-mounted alert region (SH-2)',
    async (call, reason, shown) => {
      const user = userEvent.setup()
      const answer = vi.fn(async (): Promise<WorkspaceActionResult> => ({ ok: false, reason, message: 'It failed.' }))
      stubApi(call === 'unlock' ? { unlockWorkspace: answer } : { createWorkspace: answer })
      render(<WorkspaceGate state={call === 'unlock' ? LOCKED_ENCRYPTED_WORKSPACE : UNINITIALIZED} onUnlocked={vi.fn()} />)
      if (call === 'create') await user.click(screen.getByRole('button', { name: /get started/i }))

      const pw = await screen.findByPlaceholderText('Password')
      // The alert region is there, empty, BEFORE any failure: that makes the first message a text swap inside a live
      // region (announced) instead of a freshly inserted, pre-filled alert (missed by many screen readers).
      const region = screen.getByRole('alert')
      expect(region).toBeEmptyDOMElement()
      if (call === 'unlock') {
        await user.type(pw, 'nope')
        await user.click(screen.getByRole('button', { name: /unlock/i }))
      } else {
        await user.type(pw, 'longenough')
        await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
        await user.click(screen.getByRole('button', { name: /create workspace/i }))
      }

      // The field emptied, the error shows in that same region, and focus is back ON the field for the retry
      // (pre-fix it stayed on the now-disabled submit button — a keyboard dead end).
      // The gate shows its own copy for the reason, not main's `message` (UI-languages owner call D-17 (a)).
      await screen.findByText(t('en', shown))
      expect(screen.getByRole('alert')).toBe(region)
      expect(region).toHaveTextContent(t('en', shown))
      expect((pw as HTMLInputElement).value).toBe('')
      await waitFor(() => expect(document.activeElement).toBe(pw))
    }
  )
})
