// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import {
  adoptActiveJob,
  getTranslateSession,
  resetTranslateSessionForTests
} from '../../src/renderer/lib/translateSession'
import {
  getFileTranslate,
  translateDroppedFiles,
  resetFileTranslateSessionForTests
} from '../../src/renderer/lib/fileTranslateSession'
import {
  getVisionSession,
  loadSession,
  resetVisionSessionForTests
} from '../../src/renderer/lib/visionSession'
import { DEFAULT_SETTINGS, type PolicyStatus, type WorkspaceStateInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// TA-2 / H3: the renderer session-store purge must fire at the REAL lock seam. A screen-effect
// purge was dead code (lock unmounts the screen before the effect could observe `locked`); the
// purge now lives in `App.lockNow`. This drives the real flow — seed all three module stores, click
// "Lock now" in the rail, and assert main's `lockWorkspace` ran and every store is back to EMPTY.

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

const CHOICE = { sourceLang: 'de', targetLang: 'en' } as const

afterEach(() => {
  cleanup()
  resetTranslateSessionForTests()
  resetFileTranslateSessionForTests()
  resetVisionSessionForTests()
  vi.restoreAllMocks()
})

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

describe('App.lockNow — purges the session stores at the real lock seam (TA-2)', () => {
  it('empties the text, document, and vision stores when the workspace locks', async () => {
    const lockWorkspace = vi.fn(async () => lockedState)
    stubApi({
      getWorkspaceState: vi.fn(async () => unlockedEncrypted),
      getPolicy: vi.fn(async () => offlinePolicy),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      onRuntimeNotice: vi.fn(() => () => {}) as never,
      lockWorkspace,
      // Home (default screen) readiness — keep the shell calm.
      getAppStatus: vi.fn(async () => ({ workspaceReady: true }) as never),
      getRuntimeStatus: vi.fn(async () => ({ running: false, modelId: null, port: null, healthy: false, message: 'Stopped' }) as never),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async () => ({ ok: true, rootPath: '/d', writable: true, freeBytes: 1e9, slowDriveWarning: null, problems: [] }) as never),
      // Seeds: a running text job to re-adopt + a never-resolving document import.
      getActiveTranslateJob: vi.fn(async () => ({ jobId: 'j9', state: 'translating', text: 'geheim' })),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {}),
      getDroppedFilePath: vi.fn(() => 'C:\\docs\\secret.pdf'),
      importDocuments: vi.fn(() => new Promise(() => {}))
    } as never)

    const user = userEvent.setup()
    render(<App />)

    // The rail (and its "Lock now" button, encrypted-mode only) is up once the shell renders.
    const nav = await screen.findByRole('navigation')
    const lockBtn = within(nav).getByRole('button', { name: 'Lock now' })

    // Seed all three stores non-idle. Document store FIRST (its start clears the text store), then
    // the text store, then the vision store — mirroring the real one-at-a-time reset order.
    void translateDroppedFiles([new File(['%PDF'], 'secret.pdf', { type: 'application/pdf' })], CHOICE)
    await adoptActiveJob()
    loadSession(
      { decoded: { dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png', width: 1, height: 1 } as never, name: 'secret.png', sizeBytes: 42 },
      [{ id: 't1', question: 'q', answer: 'a secret', state: 'done', error: null }],
      'sess1'
    )
    expect(getFileTranslate().busy).toBe(true)
    expect(getTranslateSession().output).toBe('geheim')
    expect(getVisionSession().selected).not.toBeNull()

    await user.click(lockBtn)

    expect(lockWorkspace).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(getTranslateSession().state).toBe('idle')
      expect(getTranslateSession().output).toBe('')
      expect(getFileTranslate().state).toBe('idle')
      expect(getFileTranslate().busy).toBe(false)
      expect(getVisionSession().selected).toBeNull()
      expect(getVisionSession().turns).toHaveLength(0)
    })
  })

  // full-audit 2026-07-11 CODE-26: a FAILED lock (main restored the unlocked vault, CODE-1a)
  // used to be an unhandled rejection — the shell silently stayed unlocked on the most
  // security-sensitive control. Now the friendly copy surfaces on a banner, the session
  // stores are NOT purged (the workspace really is still unlocked), and the shell stays up.
  it('surfaces a failed lock on a banner — stores kept, shell still unlocked (CODE-26)', async () => {
    const lockWorkspace = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'workspace:lock': Error: The workspace could not be locked — free some disk space and try again."
      )
    })
    stubApi({
      getWorkspaceState: vi.fn(async () => unlockedEncrypted),
      getPolicy: vi.fn(async () => offlinePolicy),
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      onRuntimeNotice: vi.fn(() => () => {}) as never,
      lockWorkspace,
      getAppStatus: vi.fn(async () => ({ workspaceReady: true }) as never),
      getRuntimeStatus: vi.fn(async () => ({ running: false, modelId: null, port: null, healthy: false, message: 'Stopped' }) as never),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async () => ({ ok: true, rootPath: '/d', writable: true, freeBytes: 1e9, slowDriveWarning: null, problems: [] }) as never)
    } as never)

    const user = userEvent.setup()
    render(<App />)
    const nav = await screen.findByRole('navigation')

    // Seed one session store so the "stores NOT purged" half has teeth.
    loadSession(
      { decoded: { dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png', width: 1, height: 1 } as never, name: 'secret.png', sizeBytes: 42 },
      [{ id: 't1', question: 'q', answer: 'a secret', state: 'done', error: null }],
      'sess1'
    )

    await user.click(within(nav).getByRole('button', { name: 'Lock now' }))
    expect(lockWorkspace).toHaveBeenCalledTimes(1)

    // The friendly main-process copy, stripped of the IPC transport prefix, on an alert banner.
    const banner = await screen.findByText(
      'The workspace could not be locked — free some disk space and try again.'
    )
    expect(banner.textContent).not.toContain('Error invoking remote method')

    // Shell still unlocked: the rail (with its Lock button) is up, not the WorkspaceGate.
    expect(within(nav).getByRole('button', { name: 'Lock now' })).toBeInTheDocument()
    // Stores NOT purged: the vault is still unlocked, so the resident session content stays.
    expect(getVisionSession().selected).not.toBeNull()
    expect(getVisionSession().turns).toHaveLength(1)

    // The banner is dismissible (retry stays available).
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(
      screen.queryByText('The workspace could not be locked — free some disk space and try again.')
    ).not.toBeInTheDocument()
  })
})
