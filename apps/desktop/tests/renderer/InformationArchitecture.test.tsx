// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/App'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { resolveNavTarget } from '../../src/renderer/navigation'
import { DEFAULT_SETTINGS, type PolicyStatus, type WorkspaceStateInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 26 information architecture (guidelines §2): 5 nav destinations (4 everyday +
// Settings), Privacy/Diagnostics folded into Settings tabs, and the navigate() virtual
// targets — including the legacy 'privacy'/'diagnostics' aliases every pre-26 entry
// point still uses.

afterEach(cleanup)

describe('resolveNavTarget — virtual targets + legacy aliases', () => {
  it('maps the five real destinations to themselves', () => {
    expect(resolveNavTarget('home')).toEqual({ screen: 'home' })
    expect(resolveNavTarget('documents')).toEqual({ screen: 'documents' })
    expect(resolveNavTarget('models')).toEqual({ screen: 'models' })
    expect(resolveNavTarget('chat')).toEqual({ screen: 'chat', chatMode: 'chat' })
    expect(resolveNavTarget('settings')).toEqual({ screen: 'settings', settingsTab: 'general' })
  })

  it('routes the settings:* virtual targets to the right tab', () => {
    expect(resolveNavTarget('settings:privacy')).toEqual({ screen: 'settings', settingsTab: 'privacy' })
    expect(resolveNavTarget('settings:diagnostics')).toEqual({
      screen: 'settings',
      settingsTab: 'diagnostics'
    })
  })

  it('keeps the legacy privacy/diagnostics targets working as aliases', () => {
    expect(resolveNavTarget('privacy')).toEqual(resolveNavTarget('settings:privacy'))
    expect(resolveNavTarget('diagnostics')).toEqual(resolveNavTarget('settings:diagnostics'))
  })

  it('opens the documents chat for ask-documents and falls back to home on junk', () => {
    expect(resolveNavTarget('ask-documents')).toEqual({ screen: 'chat', chatMode: 'documents' })
    expect(resolveNavTarget('no-such-screen')).toEqual({ screen: 'home' })
  })
})

// ---- App shell -------------------------------------------------------------------

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
    // Home (the default screen) readiness data:
    getAppStatus: vi.fn(async () => ({
      appName: 'x',
      appVersion: '0',
      offlineMode: true,
      networkAllowed: false,
      activeModelId: null,
      hardwareProfile: 'UNKNOWN' as const,
      workspaceMode: 'plaintext_dev' as const,
      workspaceReady: true,
      machineRamGb: 16
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
    // Settings tabs (visited via the offline badge):
    getDriveStatus: vi.fn(async () => ({}) as never),
    getRuntimeInstall: vi.fn(async () => null),
    getLogTail: vi.fn(async () => [])
  } as never)
}

describe('App shell — 5-item nav (Phase 26)', () => {
  it('renders exactly Home · Chat · Documents · AI Model ‖ Settings — no Privacy/Diagnostics items', async () => {
    stubAppShell()
    render(<App />)
    const nav = await screen.findByRole('navigation')
    const items = within(nav)
      .getAllByRole('button')
      .filter((b) => b.className.includes('nav-item'))
    expect(items.map((b) => b.textContent)).toEqual([
      '🏠Home',
      '💬Chat',
      '📄Documents',
      '🧠AI Model',
      '⚙️Settings'
    ])
    expect(within(nav).queryByText(/privacy/i)).not.toBeInTheDocument()
    expect(within(nav).queryByText(/diagnostics/i)).not.toBeInTheDocument()
  })

  it('routes the sidebar "Local · Offline" indicator to Settings → Privacy & data', async () => {
    // Phase 27: the offline badge evolved into the ambient indicator — same route.
    const user = userEvent.setup()
    stubAppShell()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Local · Offline' }))

    // The Settings screen opens with the Privacy & data tab selected…
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Privacy & data' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    // …showing the absorbed Privacy content (the spec §18.1 offline statement).
    expect(await screen.findByText('● Offline Mode: ON')).toBeInTheDocument()
  })

  it('opens the AI Model screen from the nav', async () => {
    const user = userEvent.setup()
    stubAppShell()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /AI Model/ }))
    expect(await screen.findByRole('heading', { name: 'AI Model' })).toBeInTheDocument()
  })
})

describe('SettingsScreen — tabs (Phase 26)', () => {
  function stubSettings(): void {
    stubApi({
      getSettings: vi.fn(async () => DEFAULT_SETTINGS),
      getPolicy: vi.fn(async () => offlinePolicy),
      getDriveStatus: vi.fn(async () => ({}) as never),
      getAppStatus: vi.fn(async () => ({}) as never),
      getRuntimeStatus: vi.fn(async () => ({
        running: false,
        modelId: null,
        port: null,
        healthy: false,
        message: 'Stopped'
      })),
      getRuntimeInstall: vi.fn(async () => null),
      getLogTail: vi.fn(async () => [])
    } as never)
  }

  it('opens on General and switches between the three tabs', async () => {
    const user = userEvent.setup()
    stubSettings()
    render(<SettingsScreen />)

    // General is the default: the Appearance card is there.
    expect(screen.getByRole('radio', { name: 'General' })).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByText('Appearance')).toBeInTheDocument()

    // Privacy & data absorbs the former Privacy screen.
    await user.click(screen.getByRole('radio', { name: 'Privacy & data' }))
    expect(await screen.findByText('Where your data lives')).toBeInTheDocument()
    expect(screen.queryByText('Appearance')).not.toBeInTheDocument()

    // Diagnostics (advanced) absorbs the former Diagnostics screen.
    await user.click(screen.getByRole('radio', { name: 'Diagnostics (advanced)' }))
    expect(await screen.findByText(/local-only diagnostics/i)).toBeInTheDocument()
    expect(screen.getByText('Hardware benchmark')).toBeInTheDocument()
    expect(screen.queryByText('Where your data lives')).not.toBeInTheDocument()
  })

  it('honors the controlled tab from App routing', async () => {
    stubSettings()
    render(<SettingsScreen tab="diagnostics" />)
    expect(screen.getByRole('radio', { name: 'Diagnostics (advanced)' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(await screen.findByText(/local-only diagnostics/i)).toBeInTheDocument()
  })
})
