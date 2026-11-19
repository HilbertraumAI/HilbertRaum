// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { getVisionSession, loadSession, clearVisionSession } from '../../src/renderer/lib/visionSession'
import type { WorkspaceStateInfo } from '../../src/shared/types'
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

describe('the gate at start (#875)', () => {
  // #875: a lock at QUIT that finished at the last snapshot has no lock screen to return the notice to. Main keeps it
  // (a marker on the drive) and reports it in the workspace state, so the gate at the next start says it from the
  // state App fetches on mount, with no lock in this session. #892: so does a start whose sweep shredded the session an
  // unclean end left behind, in its own words (the working file was neither removed nor damaged), and with the
  // free-space advice when the drive was too full to lock. One banner per value, in that value's words only.
  const NOTICE_COPY = {
    working_copy_lost: 'gate.unlock.workingCopyLost',
    session_not_closed: 'gate.unlock.sessionNotClosed',
    session_not_closed_full: 'gate.unlock.sessionNotClosedFull'
  } as const
  it.each(Object.entries(NOTICE_COPY) as Array<[keyof typeof NOTICE_COPY, (typeof NOTICE_COPY)[keyof typeof NOTICE_COPY]]>)(
    'shows the %s notice on the gate at start, from the workspace state alone (#875, #892)',
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
  })
})
