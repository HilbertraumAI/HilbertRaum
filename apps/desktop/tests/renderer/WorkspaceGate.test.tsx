// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceGate } from '../../src/renderer/screens/WorkspaceGate'
import type { WorkspaceStateInfo, WorkspaceActionResult } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Renderer test (jsdom + RTL) for the pre-app unlock/create gate. Drives the real
// component logic — the password floor + confirm match, the create vs unlock branch, the
// plaintext toggle visibility, and the {ok:false} error mapping — against a fake window.api.

const UNINITIALIZED: WorkspaceStateInfo = {
  state: 'uninitialized',
  mode: null,
  plaintextAllowed: false,
  encryptionRequired: true
}
const LOCKED: WorkspaceStateInfo = {
  state: 'locked',
  mode: 'encrypted',
  plaintextAllowed: false,
  encryptionRequired: true
}
const UNLOCKED: WorkspaceStateInfo = { ...UNINITIALIZED, state: 'unlocked', mode: 'encrypted' }

afterEach(cleanup)

describe('WorkspaceGate — create (first run)', () => {
  it('keeps Create disabled until the password is 8+ chars and matches confirm', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    const create = screen.getByRole('button', { name: /create workspace/i })
    expect(create).toBeDisabled()

    await user.type(screen.getByPlaceholderText('Password'), 'short')
    expect(create).toBeDisabled() // < 8 chars
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Password'))
    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'different')
    expect(create).toBeDisabled() // mismatch
    expect(screen.getByText(/don.?t match/i)).toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Confirm password'))
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    expect(create).toBeEnabled()
  })

  it('creates an encrypted workspace and reports back the new state', async () => {
    const user = userEvent.setup()
    const createWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED })
    )
    const onUnlocked = vi.fn()
    stubApi({ createWorkspace })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={onUnlocked} />)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(createWorkspace).toHaveBeenCalledWith('longenough', 'encrypted')
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED))
  })

  it('shows the error message and clears the fields when create is refused', async () => {
    const user = userEvent.setup()
    const createWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({
        ok: false,
        reason: 'refused',
        message: 'Password must be at least 8 characters.'
      })
    )
    const onUnlocked = vi.fn()
    stubApi({ createWorkspace })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={onUnlocked} />)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument()
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Password')).toHaveValue('') // fields reset
  })

  it('offers the plaintext toggle only when policy allows it', async () => {
    const { unmount } = render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    expect(screen.queryByText(/plaintext developer workspace/i)).not.toBeInTheDocument()
    unmount()

    render(<WorkspaceGate state={{ ...UNINITIALIZED, plaintextAllowed: true }} onUnlocked={vi.fn()} />)
    expect(screen.getByText(/plaintext developer workspace/i)).toBeInTheDocument()
  })

  it('creates a plaintext workspace with no password when toggled', async () => {
    const user = userEvent.setup()
    const createWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({
        ok: true,
        state: { ...UNLOCKED, mode: 'plaintext_dev' }
      })
    )
    stubApi({ createWorkspace })
    render(<WorkspaceGate state={{ ...UNINITIALIZED, plaintextAllowed: true }} onUnlocked={vi.fn()} />)

    // Phase 24: the plaintext toggle is a Switch (binary setting, guidelines §6).
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: /create workspace/i }))
    expect(createWorkspace).toHaveBeenCalledWith('', 'plaintext_dev')
  })
})

describe('WorkspaceGate — unlock (existing vault)', () => {
  it('unlocks with the entered password', async () => {
    const user = userEvent.setup()
    const unlockWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED })
    )
    const onUnlocked = vi.fn()
    stubApi({ unlockWorkspace })
    render(<WorkspaceGate state={LOCKED} onUnlocked={onUnlocked} />)

    expect(screen.getByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Password'), 'my-passphrase')
    await user.click(screen.getByRole('button', { name: /^unlock$/i }))

    expect(unlockWorkspace).toHaveBeenCalledWith('my-passphrase')
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED))
  })

  it('shows the error on a wrong password and does not advance', async () => {
    const user = userEvent.setup()
    const unlockWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({
        ok: false,
        reason: 'wrong_password',
        message: 'Incorrect password. Try again.'
      })
    )
    const onUnlocked = vi.fn()
    stubApi({ unlockWorkspace })
    render(<WorkspaceGate state={LOCKED} onUnlocked={onUnlocked} />)

    await user.type(screen.getByPlaceholderText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: /^unlock$/i }))

    expect(await screen.findByText(/incorrect password/i)).toBeInTheDocument()
    expect(onUnlocked).not.toHaveBeenCalled()
  })
})
