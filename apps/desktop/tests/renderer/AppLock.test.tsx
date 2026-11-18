// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { getVisionSession, loadSession, clearVisionSession } from '../../src/renderer/lib/visionSession'
import type { WorkspaceStateInfo } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { appShellStubs } from '../helpers/app-shell'
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
    const lockWorkspace = vi.fn(async () => lockedState)
    // Once the lock shows the gate, App marks it for opt-in measurement runs (benchmark.md "gate_visible").
    const perfMark = vi.fn()
    stubApi(
      appShellStubs({
        getWorkspaceState: vi.fn(async () => unlockedEncrypted),
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
        getWorkspaceState: vi.fn(async () => unlockedEncrypted),
        lockWorkspace: vi.fn(async (): Promise<WorkspaceStateInfo> => ({ ...lockedState, lockNotice: 'working_copy_lost' })),
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
        getWorkspaceState: vi.fn(async () => unlockedEncrypted),
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
  // state App fetches on mount, with no lock in this session.
  it('shows the lost-changes notice on the gate at start, from the workspace state alone (#875)', async () => {
    const lockWorkspace = vi.fn(async () => lockedState)
    stubApi(
      appShellStubs({
        getWorkspaceState: vi.fn(async (): Promise<WorkspaceStateInfo> => ({ ...lockedState, lockNotice: 'working_copy_lost' })),
        lockWorkspace,
        perfMark: vi.fn()
      })
    )

    render(<App />)

    expect(await screen.findByRole('heading', { name: /unlock your workspace/i })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(t('en', 'gate.unlock.workingCopyLost'))
    expect(lockWorkspace).not.toHaveBeenCalled()
  })
})
