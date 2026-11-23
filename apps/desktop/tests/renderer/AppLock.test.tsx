// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { getVisionSession, loadSession, clearVisionSession } from '../../src/renderer/lib/visionSession'
import type { WorkspaceActionResult, WorkspaceStateInfo } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { LOCKED_ENCRYPTED_WORKSPACE, UNLOCKED_ENCRYPTED_WORKSPACE, appShellStubs } from '../helpers/app-shell'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { selectedImage } from '../helpers/vision-fixtures'

// F-41 (audit-2026-07-16): the stubApi payloads are typed against the real PreloadApi bridge
// contract (no blanket `} as never)` erasure) — a rename of any mocked method now reddens
// typecheck.

// TA-2 / H3: the renderer session-store purge must fire at the REAL lock seam. A screen-effect
// purge was dead code (lock unmounts the screen before the effect could observe `locked`); the
// purge now lives in `App.lockNow`. This drives the real flow — seed a module store, click "Lock
// now" in the rail, and assert main's `lockWorkspace` ran, the store is back to EMPTY and the gate
// shows. What `purgeSessionStores` clears, store by store, is lockPurge.test.ts's; the review
// store's flush → lock → purge order is ReviewLockSeam.test.tsx's.

/** A resident vision session: an image and one answered turn, the content a lock must drop. */
function seedVisionSession(): void {
  loadSession(
    selectedImage('secret.png', { sizeBytes: 42 }),
    [{ id: 't1', question: 'q', answer: 'a secret', state: 'done', error: null }],
    'sess1'
  )
}

// #832: an unmocked window.api call fails the row (cleanup first; the stores clear whatever happens).
afterEach(() => {
  try {
    cleanup()
  } finally {
    try {
      assertNoUnexpectedApiCalls()
    } finally {
      clearVisionSession()
      vi.restoreAllMocks()
    }
  }
})

describe('App.lockNow — purges the session stores at the real lock seam (TA-2)', () => {
  it('runs the whole session-store purge when the workspace locks (the vision store emptied), then shows the gate', async () => {
    const lockWorkspace = vi.fn(async () => LOCKED_ENCRYPTED_WORKSPACE)
    // Once the lock shows the gate, App marks it for opt-in measurement runs (benchmark.md "gate_visible").
    const perfMark = vi.fn()
    stubApi(
      appShellStubs({
        getWorkspaceState: vi.fn(async () => UNLOCKED_ENCRYPTED_WORKSPACE),
        lockWorkspace,
        perfMark
      })
    )

    const user = userEvent.setup()
    render(<App />)

    // The rail (and its "Lock now" button, encrypted-mode only) is up once the shell renders.
    const nav = await screen.findByRole('navigation')
    const lockBtn = within(nav).getByRole('button', { name: 'Lock now' })

    // The vision store: not the review store, so it is emptied only if lockNow runs the WHOLE purge.
    seedVisionSession()
    expect(getVisionSession().selected).not.toBeNull()

    await user.click(lockBtn)

    expect(lockWorkspace).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(getVisionSession().selected).toBeNull()
      expect(getVisionSession().turns).toHaveLength(0)
    })
    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(perfMark).toHaveBeenCalledWith('gate_visible')
    // A plain lock carries no #855 notice, so the gate shows none.
    expect(screen.queryByText(t('en', 'gate.unlock.workingCopyLost'))).not.toBeInTheDocument()
  })

  // #855: a lock that finished at the last good snapshot because the working file was gone or no
  // longer a database resolves `locked` with a notice. The gate the lock lands on must say that
  // the changes since the previous lock are lost: the user would otherwise unlock into older data
  // with nothing to explain it.
  it('shows the gate with the lost-changes notice when the lock finished at the last snapshot (#855)', async () => {
    stubApi(
      appShellStubs({
        getWorkspaceState: vi.fn(async () => UNLOCKED_ENCRYPTED_WORKSPACE),
        lockWorkspace: vi.fn(async (): Promise<WorkspaceStateInfo> => ({ ...LOCKED_ENCRYPTED_WORKSPACE, lockNotice: 'working_copy_lost' })),
        perfMark: vi.fn()
      })
    )

    const user = userEvent.setup()
    render(<App />)
    const nav = await screen.findByRole('navigation')
    await user.click(within(nav).getByRole('button', { name: 'Lock now' }))

    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(t('en', 'gate.unlock.workingCopyLost'))
  })

  // full-audit 2026-07-11 CODE-26: a FAILED lock (main restored the unlocked vault, CODE-1a)
  // used to be an unhandled rejection — the shell silently stayed unlocked on the most
  // security-sensitive control. Now the friendly copy surfaces on a banner, the session
  // stores are NOT purged (the workspace really is still unlocked), and the shell stays up.
  it('surfaces a failed lock on a banner — stores kept, shell still unlocked (CODE-26)', async () => {
    // What main throws when the re-encrypt fails (registerWorkspaceIpc), behind Electron's IPC transport prefix.
    const lockFailed = t('en', 'main.workspace.lockFailed')
    const lockWorkspace = vi.fn(async () => {
      throw new Error(`Error invoking remote method 'workspace:lock': Error: ${lockFailed}`)
    })
    stubApi(
      appShellStubs({
        getWorkspaceState: vi.fn(async () => UNLOCKED_ENCRYPTED_WORKSPACE),
        lockWorkspace
      })
    )

    const user = userEvent.setup()
    render(<App />)
    const nav = await screen.findByRole('navigation')

    // Seed one session store so the "stores NOT purged" half has teeth.
    seedVisionSession()

    await user.click(within(nav).getByRole('button', { name: 'Lock now' }))
    expect(lockWorkspace).toHaveBeenCalledTimes(1)

    // The friendly main-process copy, stripped of the IPC transport prefix (an exact match: the prefix would fail it).
    expect(await screen.findByText(lockFailed)).toBeInTheDocument()

    // Shell still unlocked: the rail (with its Lock button) is up, not the WorkspaceGate.
    expect(within(nav).getByRole('button', { name: 'Lock now' })).toBeInTheDocument()
    // Stores NOT purged: the vault is still unlocked, so the resident session content stays.
    expect(getVisionSession().selected).not.toBeNull()
    expect(getVisionSession().turns).toHaveLength(1)

    // The banner is dismissible (retry stays available).
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(lockFailed)).not.toBeInTheDocument()
  })
})

// #1002 (S-4): main locks on its own at an OS session end and has no lock event to tell a window. A window that
// outlived the lock (a macOS shutdown another app cancelled) kept the unlocked shell, with decrypted content on screen
// and in the session stores, and every call failing. The shell now re-reads the state when the window gains focus.
describe('a lock main made on its own shows at the next focus (#1002)', () => {
  it('re-reads the state on focus: `locked` purges the stores and shows the gate; `uninitialized` or `unlocked` changes nothing', async () => {
    let state: WorkspaceStateInfo = UNLOCKED_ENCRYPTED_WORKSPACE
    const getWorkspaceState = vi.fn(async () => state)
    stubApi(appShellStubs({ getWorkspaceState }))
    render(<App />)
    const nav = await screen.findByRole('navigation')
    seedVisionSession()
    /** Focus the window and let the shell's re-read land. */
    const focusAndSettle = async (): Promise<void> => {
      const reads = getWorkspaceState.mock.calls.length
      act(() => void window.dispatchEvent(new Event('focus')))
      await waitFor(() => expect(getWorkspaceState).toHaveBeenCalledTimes(reads + 1))
      await act(async () => {})
    }

    // A `plaintext_dev` workspace whose database closed reads `uninitialized`: it has no gate, so nothing changes.
    state = { state: 'uninitialized', mode: null, plaintextAllowed: true, encryptionRequired: false }
    await focusAndSettle()
    state = UNLOCKED_ENCRYPTED_WORKSPACE
    await focusAndSettle()
    expect(within(nav).getByRole('button', { name: 'Lock now' })).toBeInTheDocument()
    expect(getVisionSession().selected).not.toBeNull()

    // Main locked on its own: the next focus ends the session in the window as Lock now does.
    state = LOCKED_ENCRYPTED_WORKSPACE
    await focusAndSettle()
    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(getVisionSession().selected).toBeNull()
    expect(getVisionSession().turns).toHaveLength(0)
  })

  // A window that kept the focus through the session end (nothing else took it) gets no `focus` event: the window
  // coming back from hidden, or the first press in it, re-reads instead. A burst of presses makes one call.
  it('a window that never lost focus re-reads when it becomes visible again or on a pointer press, one read per burst', async () => {
    let answer: () => Promise<WorkspaceStateInfo> = async () => UNLOCKED_ENCRYPTED_WORKSPACE
    const getWorkspaceState = vi.fn(() => answer())
    stubApi(appShellStubs({ getWorkspaceState }))
    render(<App />)
    await screen.findByRole('navigation')
    seedVisionSession()
    const reads = (): number => getWorkspaceState.mock.calls.length
    const visibility = vi.spyOn(document, 'visibilityState', 'get')

    // Hidden: no read. Visible again: one read, which still says unlocked, so nothing changes.
    const before = reads()
    visibility.mockReturnValue('hidden')
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => {})
    expect(reads()).toBe(before)
    visibility.mockReturnValue('visible')
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(getWorkspaceState).toHaveBeenCalledTimes(before + 1))
    await act(async () => {})
    expect(getVisionSession().selected).not.toBeNull()

    // Main locked on its own; its answer is held while the user presses three times: one read, then the gate.
    let release: (s: WorkspaceStateInfo) => void = () => {}
    answer = () => new Promise<WorkspaceStateInfo>((resolve) => void (release = resolve))
    const pressed = reads()
    act(() => {
      for (let i = 0; i < 3; i++) document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    await waitFor(() => expect(getWorkspaceState).toHaveBeenCalledTimes(pressed + 1))
    await act(async () => {})
    expect(reads()).toBe(pressed + 1)
    await act(async () => release(LOCKED_ENCRYPTED_WORKSPACE))
    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(getVisionSession().selected).toBeNull()
  })

  // A failed Lock now leaves its banner up (CODE-26). If main then locks on its own, that banner belongs to the session
  // the lock ended: it must not come back with the shell after the next unlock.
  it('a lock main made on its own clears an earlier "could not lock" banner: it is gone after the next unlock', async () => {
    const lockFailed = t('en', 'main.workspace.lockFailed')
    let state: WorkspaceStateInfo = UNLOCKED_ENCRYPTED_WORKSPACE
    const getWorkspaceState = vi.fn(async () => state)
    const lockWorkspace = vi.fn(async (): Promise<WorkspaceStateInfo> => {
      throw new Error(`Error invoking remote method 'workspace:lock': Error: ${lockFailed}`)
    })
    const unlockWorkspace = vi.fn(async (): Promise<WorkspaceActionResult> => ({ ok: true, state: UNLOCKED_ENCRYPTED_WORKSPACE }))
    stubApi(appShellStubs({ getWorkspaceState, lockWorkspace, unlockWorkspace }))
    const user = userEvent.setup()
    render(<App />)
    const nav = await screen.findByRole('navigation')
    await user.click(within(nav).getByRole('button', { name: 'Lock now' }))
    expect(await screen.findByText(lockFailed)).toBeInTheDocument()

    state = LOCKED_ENCRYPTED_WORKSPACE
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    state = UNLOCKED_ENCRYPTED_WORKSPACE // what main reports once the unlock below opened the workspace
    await user.type(screen.getByPlaceholderText(t('en', 'gate.passwordPlaceholder')), 'my-passphrase')
    await user.click(screen.getByRole('button', { name: t('en', 'gate.unlock.submit') }))

    expect(await screen.findByRole('navigation')).toBeInTheDocument()
    expect(unlockWorkspace).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(lockFailed)).not.toBeInTheDocument()
  })

  // The re-read is best effort: a read that fails (main busy, a closed channel) leaves the shell as it is, and the
  // next one runs.
  it('a re-read that fails changes nothing, and the next focus reads again', async () => {
    let answer: () => Promise<WorkspaceStateInfo> = async () => UNLOCKED_ENCRYPTED_WORKSPACE
    const getWorkspaceState = vi.fn(() => answer())
    stubApi(appShellStubs({ getWorkspaceState }))
    render(<App />)
    const nav = await screen.findByRole('navigation')
    seedVisionSession()

    answer = async () => {
      throw new Error('the workspace state could not be read')
    }
    const before = getWorkspaceState.mock.calls.length
    act(() => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(getWorkspaceState).toHaveBeenCalledTimes(before + 1))
    await act(async () => {})
    expect(within(nav).getByRole('button', { name: 'Lock now' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: t('en', 'app.fatal.title') })).not.toBeInTheDocument()
    expect(getVisionSession().selected).not.toBeNull()

    answer = async () => LOCKED_ENCRYPTED_WORKSPACE
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
  })
})

describe('the gate at start (#875)', () => {
  // #875: a lock at QUIT that finished at the last snapshot has no lock screen to return the notice to. Main keeps it
  // (a marker on the drive) and reports it in the workspace state, so the gate at the next start says it from the
  // state App fetches on mount, with no lock in this session. #892: so does a start whose sweep shredded the session an
  // unclean end left behind, in its own words (the working file was neither removed nor damaged), and with the
  // free-space advice when the drive was too full to lock. #911: so does a start that found the encrypted file missing
  // and kept the only copy, until the unlock encrypts it again. One banner per value, in that value's words only.
  const NOTICE_COPY = {
    working_copy_lost: 'gate.unlock.workingCopyLost',
    session_not_closed: 'gate.unlock.sessionNotClosed',
    session_not_closed_full: 'gate.unlock.sessionNotClosedFull',
    encrypted_file_missing: 'gate.unlock.encryptedFileMissing'
  } as const
  it.each(Object.entries(NOTICE_COPY) as Array<[keyof typeof NOTICE_COPY, (typeof NOTICE_COPY)[keyof typeof NOTICE_COPY]]>)(
    'shows the %s notice on the gate at start, from the workspace state alone (#875, #892, #911)',
    async (notice, key) => {
      const lockWorkspace = vi.fn(async () => LOCKED_ENCRYPTED_WORKSPACE)
      stubApi(
        appShellStubs({
          getWorkspaceState: vi.fn(async (): Promise<WorkspaceStateInfo> => ({ ...LOCKED_ENCRYPTED_WORKSPACE, lockNotice: notice })),
          lockWorkspace,
          perfMark: vi.fn()
        })
      )

      render(<App />)

      expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent(t('en', key))
      for (const other of Object.values(NOTICE_COPY).filter((k) => k !== key)) {
        expect(screen.queryByText(t('en', other))).not.toBeInTheDocument()
      }
      expect(lockWorkspace).not.toHaveBeenCalled()
    }
  )

  // The state crosses the IPC: a value the gate has no copy for shows no banner, also one that names a member every
  // object inherits (an own-property read, as for a failure's `reason`), instead of rendering garbage or crashing.
  it.each(['toString', 'a-later-notice'])('shows no notice for a value it has no copy for (%s)', async (notice) => {
    stubApi(
      appShellStubs({
        getWorkspaceState: vi.fn(
          async (): Promise<WorkspaceStateInfo> => ({ ...LOCKED_ENCRYPTED_WORKSPACE, lockNotice: notice as WorkspaceStateInfo['lockNotice'] })
        ),
        lockWorkspace: vi.fn(async () => LOCKED_ENCRYPTED_WORKSPACE),
        perfMark: vi.fn()
      })
    )

    render(<App />)

    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  // #860 A1: with no workspace state there is neither a gate nor a shell to show. The start says the app could not
  // start, with main's reason, instead of a blank window.
  it('shows the fatal screen with the reason when the workspace state cannot be read at start', async () => {
    stubApi(
      appShellStubs({
        getWorkspaceState: vi.fn(async (): Promise<WorkspaceStateInfo> => {
          throw new Error('workspace config unreadable')
        })
      })
    )

    render(<App />)

    expect(await screen.findByRole('heading', { name: t('en', 'app.fatal.title') })).toBeInTheDocument()
    expect(screen.getByText('workspace config unreadable')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()
    // #1024: what helps, and the troubleshooting guide; never `logs/app.log`, which an encrypted workspace does not
    // write before an unlock.
    expect(screen.getByText(t('en', 'gate.startFailed.other'))).toBeInTheDocument()
    expect(screen.getByText(t('en', 'gate.startFailed.help'))).toBeInTheDocument()
    expect(screen.queryByText(/app\.log/)).not.toBeInTheDocument()
  })

  // #1024: main's failure state (a back-end start that threw) is the gate's to show, not the shell's: the card with the
  // cause and its code, no navigation, no password field. The launch-to-password-prompt mark is not set: there is no
  // prompt. Review L-4: the bridge here is strict, exactly what main serves in that state (`getWorkspaceState`) plus the
  // listeners and the engine-problems read, which main refuses (no handler), as in the app; any other call the renderer
  // makes in this state, which main would refuse, fails the row.
  it('shows the start-failure card when main answers start_failed, and calls nothing else', async () => {
    const perfMark = vi.fn()
    stubApi({
      getWorkspaceState: vi.fn(
        async (): Promise<WorkspaceStateInfo> => ({
          state: 'start_failed',
          mode: null,
          plaintextAllowed: false,
          encryptionRequired: true,
          startFailure: { cause: 'drive_not_writable', code: 'EPERM' }
        })
      ),
      getAppStatus: vi.fn(async () => {
        throw new Error("Error invoking remote method 'app:getAppStatus': Error: No handler registered")
      }),
      onRuntimeNotice: vi.fn(() => () => {}),
      onEngineProblemsChanged: vi.fn(() => () => {}),
      perfMark
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: t('en', 'app.fatal.title') })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('en', 'gate.startFailed.notWritable')))
    expect(screen.getByText(t('en', 'gate.startFailed.code', { code: 'EPERM' }))).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()
    expect(perfMark).not.toHaveBeenCalledWith('gate_visible')
    expect(() => assertNoUnexpectedApiCalls()).not.toThrow()
  })
})

describe('the gate after a refused create (#955 item 3)', () => {
  // #955 item 3: App hands the gate main's new state. A create refused because a workspace is on the drive after all
  // (its key file copied back while the create form was up) shows the unlock form in the same session; App used to
  // give the gate only `onUnlocked`, so the create form stayed up until a restart.
  it('switches to the unlock form, with the refusal, when a create finds a workspace on the drive (#955 item 3)', async () => {
    const uninitialized: WorkspaceStateInfo = { state: 'uninitialized', mode: null, plaintextAllowed: false, encryptionRequired: true }
    let reads = 0
    const getWorkspaceState = vi.fn(
      async (): Promise<WorkspaceStateInfo> => (reads++ === 0 ? uninitialized : LOCKED_ENCRYPTED_WORKSPACE)
    )
    const createWorkspace = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({
        ok: false,
        reason: 'workspace_exists',
        message: t('en', 'main.workspace.exists')
      })
    )
    stubApi(appShellStubs({ getWorkspaceState, createWorkspace, perfMark: vi.fn() }))

    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: t('en', 'gate.welcome.start') }))
    await user.type(await screen.findByPlaceholderText(t('en', 'gate.passwordPlaceholder')), 'longenough')
    await user.type(screen.getByPlaceholderText(t('en', 'gate.create.confirmPlaceholder')), 'longenough')
    await user.click(screen.getByRole('button', { name: t('en', 'gate.create.submit') }))

    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(await screen.findByText(t('en', 'main.workspace.exists'))).toBeInTheDocument()
    expect(createWorkspace).toHaveBeenCalledTimes(1)
    expect(getWorkspaceState).toHaveBeenCalledTimes(2) // App's at start, the gate's after the refusal
  })
})
