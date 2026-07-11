// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiagnosticsTab } from '../../src/renderer/screens/settings/DiagnosticsTab'
import { I18nProvider } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components'
import { DEFAULT_SETTINGS, type AppStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Audit FE-8 — diagnostics copy must be fully localized: a benchmark failure routes through
// friendlyIpcError (no raw Electron transport / Error-class prefix in the localized line), and
// a missing hardware profile shows the localized t('diag.app.unknown'), not the literal 'UNKNOWN'.

afterEach(cleanup)

function renderTab(): void {
  render(
    <I18nProvider>
      <ToastProvider>
        <DiagnosticsTab />
      </ToastProvider>
    </I18nProvider>
  )
}

const appStatus = {
  appName: 'HilbertRaum',
  appVersion: '0.1.34',
  offlineMode: true,
  networkAllowed: false,
  activeModelId: 'qwen3-4b',
  // No hardware profile yet — the row must fall back to the localized "unknown".
  hardwareProfile: null,
  workspaceMode: 'plaintext_dev',
  workspaceReady: true,
  machineRamGb: 16,
  dictationAvailable: false
} as unknown as AppStatus

function stubDiag(
  over: {
    runBenchmark?: ReturnType<typeof vi.fn>
    settings?: typeof DEFAULT_SETTINGS
    tryGpuAgain?: ReturnType<typeof vi.fn>
  } = {}
): void {
  stubApi({
    getDriveStatus: vi.fn(async () => ({}) as never),
    getRuntimeInstall: vi.fn(async () => null),
    getSettings: vi.fn(async () => over.settings ?? DEFAULT_SETTINGS),
    getAppStatus: vi.fn(async () => appStatus),
    getRuntimeStatus: vi.fn(async () => ({
      running: false,
      modelId: null,
      port: null,
      healthy: false,
      message: 'Stopped'
    })),
    runBenchmark: (over.runBenchmark ?? vi.fn()) as never,
    tryGpuAgain: (over.tryGpuAgain ?? vi.fn()) as never
  } as never)
}

describe('DiagnosticsTab — localized errors (FE-8)', () => {
  it('shows a friendly benchmark error without the IPC transport / Error-class prefix', async () => {
    const user = userEvent.setup()
    const runBenchmark = vi.fn(async () => {
      throw new Error("Error invoking remote method 'runBenchmark': Error: benchmark exploded")
    })
    stubDiag({ runBenchmark })
    renderTab()
    await user.click(await screen.findByRole('button', { name: 'Run benchmark' }))

    const banner = await screen.findByText(/Benchmark failed:/)
    expect(banner).toHaveTextContent('Benchmark failed: benchmark exploded')
    // The transport prefix + Error-class name were stripped (the bug FE-8 fixes).
    expect(banner.textContent).not.toContain('Error invoking remote method')
    expect(banner.textContent).not.toContain('Error:')
  })

  // full-audit 2026-07-11 CODE-27: "Try GPU again" was the one handler in the file without a
  // try/catch — a rejecting re-probe was an unhandled promise rejection with zero feedback.
  it('surfaces a rejected "Try GPU again" on a banner (no unhandled rejection)', async () => {
    const user = userEvent.setup()
    const tryGpuAgain = vi.fn(async () => {
      throw new Error("Error invoking remote method 'tryGpuAgain': Error: gpu probe exploded")
    })
    stubDiag({
      settings: { ...DEFAULT_SETTINGS, gpuAutoDisabled: true },
      tryGpuAgain
    })
    renderTab()
    await user.click(await screen.findByRole('button', { name: /try gpu again/i }))
    expect(tryGpuAgain).toHaveBeenCalledTimes(1)

    // The failure line, with the friendly message only (transport prefix stripped).
    const banner = await screen.findByText(/didn’t work: gpu probe exploded/)
    expect(banner.textContent).not.toContain('Error invoking remote method')
    // The compatibility-mode banner (and its retry button) stays — the flag was not cleared.
    expect(screen.getByRole('button', { name: /try gpu again/i })).toBeInTheDocument()
  })

  it('renders the localized "unknown" hardware profile, not the literal UNKNOWN', async () => {
    stubDiag()
    renderTab()
    // The "Hardware profile" row falls back to t('diag.app.unknown') = "unknown" (localized),
    // never the old literal 'UNKNOWN' — scoped to that row's <dd> so other "unknown" fallbacks
    // don't muddy the assertion.
    const profileLabel = await screen.findByText('Hardware profile')
    expect(profileLabel.nextElementSibling?.textContent).toBe('unknown')
    // The teeth: the literal 'UNKNOWN' (the pre-fix value) appears nowhere.
    expect(screen.queryByText('UNKNOWN')).not.toBeInTheDocument()
  })
})
