// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import { App } from '../../src/renderer/App'
import { t } from '../../src/shared/i18n'
import { DEFAULT_SETTINGS, type PolicyStatus, type WorkspaceStateInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Route-level code split (full-audit 2026-07-10 PF-6): Documents/Translate/Images/Models/
// Settings/Skills are React.lazy chunks behind the per-screen ErrorBoundary's Suspense.
// This pins the boundary's user-visible contract: navigating to a lazy screen first shows
// the quiet localized loading fallback, then the real screen replaces it. The other
// full-<App/> suites (AppLock, I18n, InformationArchitecture) keep covering that every
// destination still RENDERS; this one covers the fallback → content sequence itself.

afterEach(cleanup)

const unlockedWorkspace: WorkspaceStateInfo = {
  state: 'unlocked',
  mode: 'plaintext_dev',
  plaintextAllowed: true,
  encryptionRequired: false
}

const offlinePolicy = {
  policy: {
    network: { allowModelDownloads: false, allowUpdateChecks: false, allowTelemetry: false },
    workspace: { encryptionRequired: false, allowPlaintextDevMode: true },
    models: { allowUnverifiedModels: true, requireManifest: true, requireSha256Match: false }
  },
  policyFilePresent: false,
  driveFilePresent: false,
  allowNetworkSetting: false,
  networkAllowedByPolicy: false,
  networkAllowed: false,
  offlineMode: true,
  telemetryAllowed: false
} as PolicyStatus

function stubAppShell(): void {
  stubApi({
    getWorkspaceState: vi.fn(async () => unlockedWorkspace),
    getPolicy: vi.fn(async () => offlinePolicy),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    onRuntimeNotice: vi.fn(() => () => {}) as never,
    // Home (the default, eager screen) readiness data:
    getAppStatus: vi.fn(async () => ({
      appName: 'x',
      appVersion: '0',
      offlineMode: true,
      networkAllowed: false,
      activeModelId: null,
      hardwareProfile: 'UNKNOWN' as const,
      workspaceMode: 'plaintext_dev' as const,
      workspaceReady: true,
      machineRamGb: 16,
      dictationAvailable: false
    })),
    getRuntimeStatus: vi.fn(async () => ({
      running: false,
      modelId: null,
      port: null,
      healthy: false,
      message: 'Stopped'
    })),
    listDocuments: vi.fn(async () => []),
    runPreflight: vi.fn(async () => ({
      ok: true,
      rootPath: '/drive',
      writable: true,
      freeBytes: 1024 * 1024 * 1024,
      slowDriveWarning: null,
      problems: []
    })),
    // The lazy AI Model screen's data:
    listModels: vi.fn(async () => []),
    getRuntimeInstall: vi.fn(async () => null)
  } as never)
}

describe('lazy screens — suspense fallback → content (PF-6)', () => {
  it('navigating to a lazy screen shows the loading fallback, then the screen replaces it', async () => {
    stubAppShell()
    render(<App />)
    const nav = await screen.findByRole('navigation')

    // fireEvent, NOT userEvent: the synchronous dispatch is the deterministic gate here.
    // A dynamic import can never resolve synchronously, so immediately after the click the
    // lazy screen is guaranteed still suspended — no sleep, no race with the module cache.
    fireEvent.click(within(nav).getByRole('button', { name: t('en', 'nav.models') }))
    const fallback = screen.getByText(t('en', 'app.loadingScreen'))
    expect(fallback).toBeInTheDocument()
    // The quiet fallback is a busy .screen container (guidelines §6: no unlabeled spinner).
    expect(fallback.closest('.screen')).toHaveAttribute('aria-busy', 'true')

    // …then the chunk resolves and the real screen replaces the fallback.
    expect(
      await screen.findByRole('heading', { name: t('en', 'models.title') })
    ).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'app.loadingScreen'))).not.toBeInTheDocument()
  })
})
