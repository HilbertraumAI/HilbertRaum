// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceGate } from '../../src/renderer/screens/WorkspaceGate'
import type { WorkspaceStateInfo, WorkspaceActionResult, ModelInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

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
const UNLOCKED: WorkspaceStateInfo = { ...UNINITIALIZED, state: 'unlocked', mode: 'encrypted' }

const okCreate = (): ReturnType<typeof vi.fn> =>
  vi.fn(async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED }))

/** Advance create: welcome → password → submit a valid password (lands on finishing). */
async function submitValidPassword(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /get started/i }))
  await user.type(await screen.findByPlaceholderText('Password'), 'longenough')
  await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
  await user.click(screen.getByRole('button', { name: /create workspace/i }))
}

afterEach(cleanup)

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
    // listModels parks → the gate stays on the 'finishing' step so focus is observable.
    const listModels = vi.fn(() => new Promise<ModelInfo[]>(() => {}))
    stubApi({ createWorkspace: okCreate(), listModels })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    await submitValidPassword(user)
    const skip = await screen.findByRole('button', { name: /skip/i })
    await waitFor(() => expect(document.activeElement).toBe(skip))
  })

  it('moves focus to the primary action on finishing → starter (no model installed)', async () => {
    const user = userEvent.setup()
    stubApi({ createWorkspace: okCreate(), listModels: vi.fn(async (): Promise<ModelInfo[]> => []) })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    await submitValidPassword(user)
    const choose = await screen.findByRole('button', { name: /choose your ai model/i })
    await waitFor(() => expect(document.activeElement).toBe(choose))
  })
})
