// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceGate } from '../../src/renderer/screens/WorkspaceGate'
import { passwordStrength } from '../../src/renderer/components'
import { t, UI_LANGUAGE_CODES, type MessageKey } from '../../src/shared/i18n'
import {
  MIN_PASSWORD_LENGTH,
  type WorkspaceStateInfo,
  type WorkspaceActionResult,
  type ModelInfo,
  type ModelVerifyProgress
} from '../../src/shared/types'
import { LOCKED_ENCRYPTED_WORKSPACE, UNLOCKED_ENCRYPTED_WORKSPACE } from '../helpers/app-shell'
import { catalogOf } from '../helpers/i18n-catalogs'
import { modelInfo } from '../helpers/model-fixtures'
import { renderInLanguage } from '../helpers/render-language'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import type { PreloadApi } from '../../src/preload'

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

/** A minimal installed chat model for the starter-step gate. */
const chatModel = (state: ModelInfo['state']): ModelInfo => modelInfo({ id: 'qwen3-4b-instruct-q4', state, recommended: true })

const okCreate = (): Mock =>
  vi.fn(async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED_ENCRYPTED_WORKSPACE }))

/** Stubs for a create that SUCCEEDS: the gate then subscribes to first-run verify progress (the preload returns an
 *  unsubscribe function) before it lists the models. */
function stubCreate(over: Partial<PreloadApi>): void {
  stubApi({ onModelVerifyProgress: vi.fn(() => () => {}), ...over })
}

/** Walk from the welcome step to the password step. */
async function toPasswordStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /get started/i }))
  await screen.findByRole('heading', { name: /create your password/i })
}

// #832: a window.api call no row stubbed fails that row (cleanup first, so one failure cannot cascade).
afterEach(() => {
  try {
    cleanup()
  } finally {
    assertNoUnexpectedApiCalls()
  }
})

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

  // "Too short" must mean "under the floor main refuses", or the meter and the submit button
  // disagree the day the floor moves (a copy of the literal 8 did, until the UI languages wave's code review).
  it('calls a password too short exactly below the shared floor (MIN_PASSWORD_LENGTH)', () => {
    expect(label('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('Too short')
    expect(label('a'.repeat(MIN_PASSWORD_LENGTH))).not.toBe('Too short')
  })

  // The hint under a too-short password names the floor main enforces, in every catalog (#805 S4):
  // the catalog value carries `{min}` and no figure of its own, and passwordStrength hands it
  // MIN_PASSWORD_LENGTH. A copied figure would leave the hint naming a length main doesn't
  // enforce the day the floor moves; a dropped param would render "{min}".
  it.each(UI_LANGUAGE_CODES)('%s: the too-short hint names the shared floor (MIN_PASSWORD_LENGTH)', (code) => {
    const { hintKey, hintParams } = passwordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1))
    expect(hintKey).not.toBeNull()
    const value = catalogOf(code)[hintKey!]
    expect(value).toContain('{min}')
    expect(value).not.toMatch(/\d/)
    expect(t(code, hintKey!, hintParams)).toMatch(new RegExp(`(^|\\D)${MIN_PASSWORD_LENGTH}(\\D|$)`))
  })
})

describe('WorkspaceGate — create (3-step first run)', () => {
  it('starts on the welcome step with the trust framing and no password fields, then moves welcome → password and back', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /welcome/i })).toBeInTheDocument()
    expect(screen.getByText(/everything stays on this drive/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()

    await toPasswordStep(user)
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByRole('heading', { name: /welcome/i })).toBeInTheDocument()
  })

  // The length floor is the next row's (MIN_PASSWORD_LENGTH, never a copied 8).
  it('keeps Create disabled while confirm differs, and enables it on a match', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    const create = screen.getByRole('button', { name: /create workspace/i })
    expect(create).toBeDisabled()

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'different')
    expect(create).toBeDisabled() // mismatch
    expect(screen.getByText(/don.?t match/i)).toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Confirm password'))
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    expect(create).toBeEnabled()
    expect(screen.queryByText(/don.?t match/i)).not.toBeInTheDocument()
  })

  // The floor is main's (`registerWorkspaceIpc` refuses under it), so main's too-short refusal
  // can never answer this gate; `workspace-ipc.test.ts`'s gate cross-check relies on that.
  it('enables Create exactly at the shared floor main enforces (MIN_PASSWORD_LENGTH)', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    const create = screen.getByRole('button', { name: /create workspace/i })
    const belowFloor = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)
    await user.type(screen.getByPlaceholderText('Password'), belowFloor)
    await user.type(screen.getByPlaceholderText('Confirm password'), belowFloor)
    expect(create).toBeDisabled()

    await user.type(screen.getByPlaceholderText('Password'), 'a')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'a')
    expect(create).toBeEnabled()
  })

  it('shows the strength meter as a hint that never disables Create', async () => {
    const user = userEvent.setup()
    stubApi({})
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    // A weak-but-valid password: meter says "Weak", the button stays enabled. The visible
    // word is plain text now (not a live region — audit L13), so query it by text. The sr-only
    // announcer repeats the word once typing has paused for 600 ms (Components.test.tsx owns that
    // debounce), which can land while the confirm field is still being typed: look past it.
    await user.type(screen.getByPlaceholderText('Password'), 'aaaaaaaa')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'aaaaaaaa')
    expect(screen.getByText('Weak', { ignore: 'script, style, [role="status"]' })).toBeInTheDocument()
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
    stubCreate({ createWorkspace, listModels })
    render(<WorkspaceGate state={UNINITIALIZED} onUnlocked={onUnlocked} />)
    await toPasswordStep(user)

    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(createWorkspace).toHaveBeenCalledWith('longenough', 'encrypted')
    // The step-3 check runs AFTER create succeeds (listModels needs an unlocked
    // workspace) and, with a model installed, skips the starter step entirely.
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED_ENCRYPTED_WORKSPACE, 'chat'))
    expect(screen.queryByText(/no ai model is installed/i)).not.toBeInTheDocument()
  })

  // Every exit of the starter step is honest: it hands the open workspace to the shell exactly once, on its own
  // screen (Skip ends on the teaching Chat empty state). A model listed but not installed still counts as none, and so
  // does an installed embedder: every Kit ships E5, so "no chat model" usually reads like this list (#860 R4).
  it.each<[MessageKey, string]>([
    ['gate.starter.skip', 'chat'],
    ['gate.starter.addDocuments', 'documents'],
    ['gate.starter.chooseModel', 'models']
  ])('shows the starter step when no chat model is installed; %s lands on %s', async (exit, landOn) => {
    const user = userEvent.setup()
    const onUnlocked = vi.fn()
    const embedder = modelInfo({ id: 'multilingual-e5-small-q8', role: 'embeddings', state: 'installed' })
    stubCreate({
      createWorkspace: okCreate(),
      listModels: vi.fn(async (): Promise<ModelInfo[]> => [chatModel('missing'), embedder])
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

    await user.click(screen.getByRole('button', { name: t('en', exit) }))
    expect(onUnlocked).toHaveBeenCalledTimes(1)
    expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED_ENCRYPTED_WORKSPACE, landOn)
  })

  // FE-E (full-audit-2026-06-29-followup, Phase 8): a THROWN model-listing/verify failure
  // (distinct from an empty list) must not drop the user silently on Chat's generic "no
  // model" empty state — it routes to the Models screen so the failure is surfaced once,
  // while still never trapping them in the gate (the workspace is open).
  it('routes to Models (not silently to Chat) when the post-create model check throws', async () => {
    const user = userEvent.setup()
    const onUnlocked = vi.fn()
    stubCreate({
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

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED_ENCRYPTED_WORKSPACE, 'models'))
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
        runId: 'run-1',
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
        state: { ...UNLOCKED_ENCRYPTED_WORKSPACE, mode: 'plaintext_dev' }
      })
    )
    stubCreate({ createWorkspace, listModels: vi.fn(async (): Promise<ModelInfo[]> => []) })
    render(<WorkspaceGate state={{ ...UNINITIALIZED, plaintextAllowed: true }} onUnlocked={vi.fn()} />)
    await toPasswordStep(user)

    // The plaintext toggle is a Switch (binary setting, guidelines §6). Encrypted stays the default even where
    // policy allows plaintext (CLAUDE.md: no plaintext workspace unless explicitly chosen), and the choice is
    // called out while it stands.
    const toggle = screen.getByRole('switch')
    expect(toggle).not.toBeChecked()
    expect(screen.queryByText(t('en', 'gate.create.plaintextWarning'))).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByText(t('en', 'gate.create.plaintextWarning'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /create workspace/i }))
    expect(createWorkspace).toHaveBeenCalledWith('', 'plaintext_dev')
  })
})

describe('WorkspaceGate — unlock (existing vault, single calm screen)', () => {
  it('unlocks with the entered password and stays a one-step screen', async () => {
    const user = userEvent.setup()
    const unlockWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED_ENCRYPTED_WORKSPACE })
    )
    const onUnlocked = vi.fn()
    stubApi({ unlockWorkspace })
    render(<WorkspaceGate state={LOCKED_ENCRYPTED_WORKSPACE} onUnlocked={onUnlocked} />)

    // No first-run steps on unlock: the password field is immediately there.
    expect(screen.getByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get started/i })).not.toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Password'), 'my-passphrase')
    await user.click(screen.getByRole('button', { name: /^unlock$/i }))

    expect(unlockWorkspace).toHaveBeenCalledWith('my-passphrase')
    // A plain unlock passes no landing target — the shell keeps its screen.
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(UNLOCKED_ENCRYPTED_WORKSPACE))
  })
})

// #955 item 3: a create refused because a workspace is on the drive after all (its key file copied back while the
// create form was up). The form used to stay until a restart, and its copy said "Restart HilbertRaum". Main now reads
// `locked` (its unlock runs the start's steps over that vault), so the gate re-reads the state and hands it to its parent,
// which shows the unlock form. Walk round: the create step and the unlock screen are one card, so the alert region the
// create step mounted is the very element that receives the refusal; a region mounted by the switch got its text in the
// same frame in the real app, which many screen readers miss (#436, M-U1).
describe('WorkspaceGate — a create refused because a workspace is on the drive (#955 item 3)', () => {
  /** The gate in a parent that keeps its state as App does, on the create step with a valid password typed; main
   *  answers the create with `workspace_exists` and reads `locked` afterwards. */
  async function onRefusableCreate(user: ReturnType<typeof userEvent.setup>) {
    const createWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({ ok: false, reason: 'workspace_exists', message: 'main’s text' })
    )
    const getWorkspaceState = vi.fn(async (): Promise<WorkspaceStateInfo> => LOCKED_ENCRYPTED_WORKSPACE)
    const onUnlocked = vi.fn()
    stubApi({ createWorkspace, getWorkspaceState })
    function Parent(): JSX.Element {
      const [state, setState] = useState<WorkspaceStateInfo>(UNINITIALIZED)
      return <WorkspaceGate state={state} onUnlocked={onUnlocked} onStateChange={setState} />
    }
    render(<Parent />)
    await toPasswordStep(user)
    await user.type(screen.getByPlaceholderText('Password'), 'longenough')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'longenough')
    return { getWorkspaceState, onUnlocked }
  }

  it('re-reads the state and shows the unlock form, the refusal arriving in its alert region, focus on its field', async () => {
    const user = userEvent.setup()
    const { getWorkspaceState, onUnlocked } = await onRefusableCreate(user)
    // The create step's own region, in the document and empty before the refusal.
    const region = screen.getByRole('alert')
    expect(region).toBeEmptyDOMElement()
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    // The same element after the switch, the refusal now inside it.
    expect(screen.getByRole('alert')).toBe(region)
    expect(region).toHaveTextContent(t('en', 'main.workspace.exists'))
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Password'))
    expect(getWorkspaceState).toHaveBeenCalledTimes(1)
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  // Review R F-2: the card keeps its state across the switch. "Show password" turned on at the create step left the
  // unlock field unmasked, so the other workspace's password was typed in clear text.
  it('starts the unlock field masked although "Show password" was on at the create step', async () => {
    const user = userEvent.setup()
    await onRefusableCreate(user)
    await user.click(screen.getByRole('button', { name: /show password/i }))
    expect(screen.getByPlaceholderText('Password')).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Password')).toHaveAttribute('type', 'password')
  })
})

// Second UI-languages wave owner call G-6 (2026-11-13): CSS uppercases the edition line
// (`.gate-brand-edition`), and uppercasing follows the element's language, so under a Turkish UI
// Chromium would show "HİLBERTRAUM LİTE". jsdom renders no text-transform; the row asserts the
// language the brand text resolves to, which is what Chromium's uppercasing reads.
describe('WorkspaceGate — the edition name stays English in a Turkish UI', () => {
  afterEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('lang')
  })

  it('"HilbertRaum Lite" resolves to lang="en" under <html lang="tr">', () => {
    stubApi({})
    renderInLanguage(<WorkspaceGate state={LOCKED_ENCRYPTED_WORKSPACE} onUnlocked={vi.fn()} />, 'tr')
    expect(document.documentElement.lang).toBe('tr')
    expect(screen.getByText('HilbertRaum Lite').closest('[lang]')?.getAttribute('lang')).toBe('en')
  })
})

// UI-languages owner call D-17 (a): before unlock the gate renders in the localStorage mirror's
// language, while main emits its failure `message` in its own cached language (the OS locale
// until settings are readable). Every row renders the gate in German and lets main answer in
// English, so a gate that showed `message` for a mapped reason turns its row red. Every failure
// also leaves the user on the gate: nothing reaches the shell, and a failed create empties both
// password fields for the retry (SH-12; the unlock field's reset and focus are WorkspaceGateFocus's).
describe('WorkspaceGate — unlock/create failures render in the gate’s language (UI-languages owner call D-17 (a))', () => {
  type Failure = Extract<WorkspaceActionResult, { ok: false }>

  afterEach(() => window.localStorage.clear())

  /** Render the gate in German, submit once, have main answer with `failure` (or the call reject with it), and expect
   *  `shown` on a gate that stayed up. #955 item 3: after a create's `workspace_exists` the gate re-reads main's state;
   *  here main still reads `uninitialized`, so the create form keeps the refusal (the switch to the unlock form when main
   *  reads `locked` is the next describe's). */
  async function failIn(call: 'unlock' | 'create', failure: Failure | Error, shown: string): Promise<void> {
    const user = userEvent.setup()
    const answer = vi.fn(async (): Promise<WorkspaceActionResult> => {
      if (failure instanceof Error) throw failure
      return failure
    })
    const onUnlocked = vi.fn()
    const onStateChange = vi.fn()
    stubApi(
      call === 'unlock'
        ? { unlockWorkspace: answer }
        : { createWorkspace: answer, getWorkspaceState: vi.fn(async (): Promise<WorkspaceStateInfo> => UNINITIALIZED) }
    )
    renderInLanguage(
      <WorkspaceGate
        state={call === 'unlock' ? LOCKED_ENCRYPTED_WORKSPACE : UNINITIALIZED}
        onUnlocked={onUnlocked}
        onStateChange={onStateChange}
      />,
      'de'
    )
    if (call === 'unlock') {
      await user.type(screen.getByPlaceholderText(t('de', 'gate.passwordPlaceholder')), 'nope')
      await user.click(screen.getByRole('button', { name: t('de', 'gate.unlock.submit') }))
    } else {
      // A valid encrypted password, as the gate always sends. Main's too-short refusal can't be the
      // answer to it, but a stubbed `refused` row still checks the copy the gate would show for one.
      await user.click(screen.getByRole('button', { name: t('de', 'gate.welcome.start') }))
      const password = await screen.findByPlaceholderText(t('de', 'gate.passwordPlaceholder'))
      await user.type(password, 'longenough')
      await user.type(screen.getByPlaceholderText(t('de', 'gate.create.confirmPlaceholder')), 'longenough')
      await user.click(screen.getByRole('button', { name: t('de', 'gate.create.submit') }))
      expect(answer).toHaveBeenCalledWith('longenough', 'encrypted')
    }
    expect(await screen.findByText(shown)).toBeInTheDocument()
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(onStateChange).not.toHaveBeenCalled()
    if (call === 'create' && !(failure instanceof Error)) {
      expect(screen.getByPlaceholderText(t('de', 'gate.passwordPlaceholder'))).toHaveValue('')
      expect(screen.getByPlaceholderText(t('de', 'gate.create.confirmPlaceholder'))).toHaveValue('')
    }
  }

  // The lookup itself, the most common failure, and one row per table (`error` reads "couldn't open" to unlock and
  // "couldn't create" to create). Which key every other reason maps to is tied to main's real handlers, in every
  // language, by workspace-ipc.test.ts's cross-check ("main says what the gate shows"), the D-17 record's guard.
  // #807: the reasons that replaced create's free-text `refused` (the vault's English sentence, shown as it came), the
  // too-short refusal that `refused` now only is, with the floor in its text (A2), and the missing descriptor (C-S2).
  it.each([
    ['unlock', 'wrong_password', 'main.workspace.wrongPassword'],
    ['unlock', 'error', 'main.workspace.openFailed'],
    ['create', 'error', 'main.workspace.createFailed'],
    ['create', 'workspace_exists', 'main.workspace.exists'],
    ['create', 'plaintext_not_allowed', 'main.workspace.plaintextNotAllowed'],
    ['create', 'refused', 'main.workspace.passwordTooShort'],
    ['unlock', 'vault_descriptor_missing', 'main.workspace.descriptorMissing'],
    // Review V F-3: a create over an unreadable key file with no `.enc` shows the unlock's copy, on the create form.
    ['create', 'vault_descriptor_unreadable', 'main.workspace.descriptorUnreadable']
  ] as const)('%s %s shows %s in German although main said it in English', async (call, reason, key) => {
    const params = { min: MIN_PASSWORD_LENGTH }
    await failIn(call, { ok: false, reason, message: t('en', key, params) }, t('de', key, params))
  })

  it.each([
    // A reason neither table has. The tables are typecheck-complete, so only a cast gets here;
    // the gate still says what main said instead of showing an empty banner.
    ['unlock', 'not_in_the_tables' as string as Failure['reason'], 'Something new went wrong.'],
    // A reason naming an inherited member: a plain `keys[reason]` read finds a function there
    // (found in the UI languages wave's code review).
    ['unlock', 'toString' as string as Failure['reason'], 'Something else went wrong.']
  ] as const)('%s %s shows main’s own message', async (call, reason, message) => {
    await failIn(call, { ok: false, reason, message }, message)
  })

  // #860 R1: a call that REJECTS (an IPC or main-side fault, not an answer) has no reason to map; the gate still says
  // something, in its own language, instead of leaving the user on a silent gate.
  it.each(['unlock', 'create'] as const)('%s: a call that rejects shows the generic failure in German', async (call) => {
    await failIn(call, new Error('ipc broke'), t('de', 'gate.error.generic'))
  })
})
