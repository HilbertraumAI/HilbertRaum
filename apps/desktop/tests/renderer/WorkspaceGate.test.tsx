// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceGate, passwordStrength } from '../../src/renderer/screens/WorkspaceGate'
import { t } from '../../src/shared/i18n'
import type {
  WorkspaceStateInfo,
  WorkspaceActionResult,
  ModelInfo,
  ModelVerifyProgress
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Renderer test (jsdom + RTL) for the pre-app gate. Phase 27 turned the CREATE path
// into the 3-step first run (welcome → password → optional starter step); this suite
// keeps everything the old one proved — the password floor + confirm match, create vs
// unlock, plaintext gating, the {ok:false} error mapping — and adds the step
// navigation, paste support (WCAG 3.3.8), the show-password toggle, the advisory
// strength meter, and the starter step's installed-model gate + landing targets.

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

/** A minimal installed chat model for the starter-step gate. */
function chatModel(state: ModelInfo['state']): ModelInfo {
  return {
    id: 'qwen3-4b-instruct-q4',
    displayName: 'Qwen3 4B',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama.cpp',
    license: 'apache-2.0',
    sizeOnDiskGb: 2.5,
    recommendedMinRamGb: 8,
    recommendedRamGb: 16,
    recommendedContextTokens: 8192,
    localPath: 'models/qwen3.gguf',
    state,
    recommended: true
  }
}

const okCreate = (): ReturnType<typeof vi.fn> =>
  vi.fn(async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED }))

/** Walk from the welcome step to the password step. */
async function toPasswordStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /get started/i }))
  await screen.findByRole('heading', { name: /create your password/i })
}

afterEach(cleanup)

describe('passwordStrength — advisory meter (hand-rolled, never a blocker)', () => {
  // Strength words are MessageKeys resolved at render (Phase 40); the English
  // catalog stays the assertion source of truth (D-L8).
  const label = (pw: string): string => {
    const key = passwordStrength(pw).labelKey
    return key == null ? '' : t('en', key)
  }
  it('scores by length with a variety bonus', () => {
    expect(passwordStrength('').score).toBe(0)
    expect(passwordStrength('').labelKey).toBeNull()
    expect(label('short')).toBe('Too short')
    expect(label('eightchr')).toBe('Weak') // ≥8 but short + one class
    expect(label('twelve chars')).toBe('Okay')
    expect(label('sixteen long pwd')).toBe('Strong')
    expect(label('C0rrect-horse-battery!')).toBe('Very strong')
  })
})

describe('WorkspaceGate — create (3-step first run)', () => {
  it('starts on the welcome step with the trust framing, no password fields yet', () => {
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    expect(screen.getByRole('heading', { name: /welcome/i })).toBeInTheDocument()
    expect(screen.getByText(/everything stays on this drive/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()
  })

  it('moves welcome → password and back', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)

    await toPasswordStep(user)
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByRole('heading', { name: /welcome/i })).toBeInTheDocument()
  })

  it('keeps Create disabled until the password is 8+ chars and matches confirm', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

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

  it('shows the strength meter as a hint that never disables Create', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    // A weak-but-valid password: meter says "Weak", the button stays enabled. The visible
    // word is plain text now (not a live region — audit L13), so query it by text.
    await user.type(screen.getByPlaceholderText('Password'), 'aaaaaaaa')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'aaaaaaaa')
    expect(screen.getByText('Weak')).toBeInTheDocument()
    expect(screen.getByText(/longer is stronger/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create workspace/i })).toBeEnabled()
  })

  it('allows paste into the password fields (WCAG 3.3.8 — password managers work)', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    const pw = screen.getByPlaceholderText('Password')
    await user.click(pw)
    await user.paste('pasted-passphrase')
    expect(pw).toHaveValue('pasted-passphrase')

    const confirm = screen.getByPlaceholderText('Confirm password')
    await user.click(confirm)
    await user.paste('pasted-passphrase')
    expect(confirm).toHaveValue('pasted-passphrase')
    expect(screen.getByRole('button', { name: /create workspace/i })).toBeEnabled()
  })

  it('reveals both fields with the Show toggle and hides them again', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    const pw = screen.getByPlaceholderText('Password')
    const confirm = screen.getByPlaceholderText('Confirm password')
    expect(pw).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: /show password/i }))
    expect(pw).toHaveAttribute('type', 'text')
    expect(confirm).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('button', { name: /hide password/i }))
    expect(pw).toHaveAttribute('type', 'password')
    expect(confirm).toHaveAttribute('type', 'password')
  })

  it('creates the workspace and lands on Chat when a chat model is already installed', async () => {
    const user = userEvent.setup()
    const createWorkspace = okCreate()
    const listModels = vi.fn(async (): Promise<ModelInfo[]> => [chatModel('installed')])
    const onUnlocked = vi.fn()
    stubApi({ createWorkspace, listModels })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={onUnlocked} />)
    await toPasswordStep(user)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(createWorkspace).toHaveBeenCalledWith('longenough', 'encrypted')
    // The step-3 check runs AFTER create succeeds (listModels needs an unlocked
    // workspace) and, with a model installed, skips the starter step entirely.
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED, 'chat'))
    expect(screen.queryByText(/no ai model is installed/i)).not.toBeInTheDocument()
  })

  it('shows the starter step when no chat model is installed, with every exit honest', async () => {
    const user = userEvent.setup()
    const onUnlocked = vi.fn()
    stubApi({
      createWorkspace: okCreate(),
      listModels: vi.fn(async (): Promise<ModelInfo[]> => [chatModel('missing')])
    })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={onUnlocked} />)
    await toPasswordStep(user)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    // The starter step renders; downloads stay behind the existing gates (the step
    // only ROUTES — the AI Model screen keeps policy ∧ setting ∧ confirmation).
    await screen.findByText(/no ai model is installed on this drive yet/i)
    expect(onUnlocked).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /choose your ai model/i }))
    expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED, 'models')
  })

  it('the starter step is skippable and ends on the Chat empty state', async () => {
    const user = userEvent.setup()
    const onUnlocked = vi.fn()
    stubApi({
      createWorkspace: okCreate(),
      listModels: vi.fn(async (): Promise<ModelInfo[]> => [])
    })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={onUnlocked} />)
    await toPasswordStep(user)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    await screen.findByText(/no ai model is installed on this drive yet/i)
    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED, 'chat')
  })

  it('never traps the user when the post-create model check fails', async () => {
    const user = userEvent.setup()
    const onUnlocked = vi.fn()
    stubApi({
      createWorkspace: okCreate(),
      listModels: vi.fn(async (): Promise<ModelInfo[]> => {
        throw new Error('boom')
      })
    })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={onUnlocked} />)
    await toPasswordStep(user)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED, 'chat'))
  })

  it('shows a determinate verification bar while first-run hashing runs, then unsubscribes', async () => {
    const user = userEvent.setup()
    let emit: ((p: ModelVerifyProgress) => void) | null = null
    const unsubscribe = vi.fn()
    let resolveList!: (m: ModelInfo[]) => void
    const listModels = vi.fn(() => new Promise<ModelInfo[]>((r) => (resolveList = r)))
    stubApi({
      createWorkspace: okCreate(),
      listModels,
      onModelVerifyProgress: (cb) => {
        emit = cb
        return unsubscribe
      }
    })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)
    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    // The gate subscribed before awaiting listModels; drive a mid-hash event.
    await waitFor(() => expect(emit).not.toBeNull())
    act(() =>
      emit!({
        modelIndex: 1,
        modelCount: 2,
        modelId: 'a',
        displayName: 'Qwen3 4B',
        overallBytesHashed: 50,
        overallBytesTotal: 100,
        done: false
      })
    )

    // The bare spinner gives way to a determinate bar with the "N of M" label + percent.
    expect(await screen.findByText(/checking ai model 1 of 2: qwen3 4b — 50%/i)).toBeInTheDocument()
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('value', '50')
    expect(bar).toHaveAttribute('max', '100')

    // Finishing the call tears down the subscription (no lingering listener).
    resolveList([])
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled())
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
    await toPasswordStep(user)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument()
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Password')).toHaveValue('') // fields reset
  })

  it('offers the plaintext toggle only when policy allows it', async () => {
    const user = userEvent.setup()
    stubApi({})
    const { unmount } = render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)
    expect(screen.queryByText(/plaintext developer workspace/i)).not.toBeInTheDocument()
    unmount()

    render(<WorkspaceGate state={{ ...UNINITIALIZED, plaintextAllowed: true }} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)
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
    stubApi({ createWorkspace, listModels: vi.fn(async (): Promise<ModelInfo[]> => []) })
    render(<WorkspaceGate state={{ ...UNINITIALIZED, plaintextAllowed: true }} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    // The plaintext toggle is a Switch (binary setting, guidelines §6).
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: /create workspace/i }))
    expect(createWorkspace).toHaveBeenCalledWith('', 'plaintext_dev')
  })
})

describe('WorkspaceGate — unlock (existing vault, single calm screen)', () => {
  it('unlocks with the entered password and stays a one-step screen', async () => {
    const user = userEvent.setup()
    const unlockWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED })
    )
    const onUnlocked = vi.fn()
    stubApi({ unlockWorkspace })
    render(<WorkspaceGate state={LOCKED} onUnlocked={onUnlocked} />)

    // No first-run steps on unlock: the password field is immediately there.
    expect(screen.getByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get started/i })).not.toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Password'), 'my-passphrase')
    await user.click(screen.getByRole('button', { name: /^unlock$/i }))

    expect(unlockWorkspace).toHaveBeenCalledWith('my-passphrase')
    // A plain unlock passes no landing target — the shell keeps its screen.
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED))
  })

  it('shows the error on a wrong password and does not advance', async () => {
    const user = userEvent.setup()
    const unlockWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({
        ok: false,
        reason: 'wrong_password',
        message: "That password didn't unlock your workspace. Check it and try again."
      })
    )
    const onUnlocked = vi.fn()
    stubApi({ unlockWorkspace })
    render(<WorkspaceGate state={LOCKED} onUnlocked={onUnlocked} />)

    await user.type(screen.getByPlaceholderText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: /^unlock$/i }))

    expect(await screen.findByText(/didn.t unlock your workspace/i)).toBeInTheDocument()
    expect(onUnlocked).not.toHaveBeenCalled()
  })
})
