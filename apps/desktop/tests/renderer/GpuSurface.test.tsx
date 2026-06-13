// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AppStatus,
  type DriveStatus,
  type RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 16 GPU surface (architecture.md GPU record §8), re-homed by Phase 26: the Diagnostics
// surfaces live on Settings → "Diagnostics (advanced)", the GPU toggle on Settings →
// General. Same proofs as before the IA regroup: the "Acceleration" line, "Try GPU
// again" (the dedicated IPC, never a raw settings write), the runtime-build line, and
// the toggle. Friendly copy only — these tests also pin that no scary words leak in.

const RTX = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...over }
}

function runtimeStatus(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: false, modelId: null, port: null, healthy: false, message: 'Stopped', ...over }
}

const appStatus = {
  appName: 'HilbertRaum',
  appVersion: '0.1.0',
  activeModelId: null,
  hardwareProfile: 'UNKNOWN'
} as unknown as AppStatus

const driveStatus = {
  rootPath: 'E:\\',
  workspacePath: 'E:\\workspace',
  modelsPath: 'E:\\models',
  logsPath: 'E:\\logs',
  isPreparedDrive: true,
  writable: true,
  freeBytes: 64e9,
  platform: 'win32',
  arch: 'x64'
} as unknown as DriveStatus

function stubDiagnostics(opts: {
  settings?: AppSettings
  runtime?: RuntimeStatus
  install?: { version: string; backend: string; os: string; arch: string } | null
  updateSettings?: ReturnType<typeof vi.fn>
  tryGpuAgain?: ReturnType<typeof vi.fn>
}): void {
  stubApi({
    getAppStatus: vi.fn(async () => appStatus),
    getDriveStatus: vi.fn(async () => driveStatus),
    getRuntimeStatus: vi.fn(async () => opts.runtime ?? runtimeStatus()),
    getRuntimeInstall: vi.fn(async () => opts.install ?? null),
    getSettings: vi.fn(async () => opts.settings ?? settings()),
    updateSettings: (opts.updateSettings ??
      vi.fn(async (p: Partial<AppSettings>) => settings(p))) as never,
    tryGpuAgain: (opts.tryGpuAgain ??
      vi.fn(async () => settings({ gpuAutoDisabled: false, gpuLastError: null }))) as never,
    getLogTail: vi.fn(async () => []),
    runBenchmark: vi.fn()
  })
}

/** The Diagnostics surfaces now live on the Settings "Diagnostics (advanced)" tab. */
function renderDiagnostics(): void {
  render(<SettingsScreen tab="diagnostics" />)
}

afterEach(cleanup)

describe('Settings → Diagnostics (advanced) — Acceleration (Phase 16)', () => {
  it('shows the GPU name while a model runs on the GPU backend', async () => {
    stubDiagnostics({
      runtime: runtimeStatus({
        running: true,
        modelId: 'qwen3-4b-instruct-q4',
        healthy: true,
        backend: 'gpu',
        gpuName: 'NVIDIA GeForce RTX 3080 Ti'
      })
    })
    renderDiagnostics()
    expect(await screen.findByText('NVIDIA GeForce RTX 3080 Ti (GPU)')).toBeInTheDocument()
  })

  it('shows the probed GPU as available when nothing is running', async () => {
    stubDiagnostics({
      settings: settings({ gpuProbe: { devices: [RTX], probedAt: '2026-06-10T00:00:00Z' } })
    })
    renderDiagnostics()
    expect(
      await screen.findByText('NVIDIA GeForce RTX 3080 Ti (GPU available)')
    ).toBeInTheDocument()
  })

  it('reads simply "CPU" with no GPU probed (never scary copy)', async () => {
    stubDiagnostics({
      settings: settings({ gpuProbe: { devices: [], probedAt: '2026-06-10T00:00:00Z' } })
    })
    renderDiagnostics()
    expect(await screen.findByText('CPU')).toBeInTheDocument()
    expect(screen.queryByText(/fail|broken|bad/i)).not.toBeInTheDocument()
  })

  it('shows the installed runtime build from the .hilbertraum-runtime.json marker', async () => {
    stubDiagnostics({ install: { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' } })
    renderDiagnostics()
    expect(await screen.findByText('llama.cpp b9585 (vulkan)')).toBeInTheDocument()
  })

  it('offers "Try GPU again" when gpuAutoDisabled, calling the dedicated IPC (not the toggle)', async () => {
    // Audit fix: the button calls the tryGpuAgain IPC (which also invalidates the
    // session probe cache + re-probes in the main process) — NOT a raw settings write.
    const update = vi.fn(async (p: Partial<AppSettings>) => settings(p))
    const tryAgain = vi.fn(async () => settings({ gpuAutoDisabled: false, gpuLastError: null }))
    stubDiagnostics({
      settings: settings({ gpuAutoDisabled: true }),
      updateSettings: update,
      tryGpuAgain: tryAgain
    })
    renderDiagnostics()
    expect(await screen.findByText(/compatibility mode/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /try gpu again/i }))
    expect(tryAgain).toHaveBeenCalledTimes(1)
    // The user's gpuMode toggle is NOT touched (no raw settings write at all).
    expect(update).not.toHaveBeenCalled()
    // The notice disappears once the returned settings clear the flag.
    expect(screen.queryByRole('button', { name: /try gpu again/i })).not.toBeInTheDocument()
  })

  it('points to Settings instead of the button when the toggle is OFF', async () => {
    // Audit fix: with gpuMode 'off' the button would silently do nothing (rung 1 stays
    // skipped) — show where to re-enable instead.
    stubDiagnostics({ settings: settings({ gpuAutoDisabled: true, gpuMode: 'off' }) })
    renderDiagnostics()
    expect(await screen.findByText(/compatibility mode/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try gpu again/i })).not.toBeInTheDocument()
    expect(screen.getByText(/turned off in settings/i)).toBeInTheDocument()
  })

  it('shows no compatibility-mode note when GPU is fine', async () => {
    stubDiagnostics({})
    renderDiagnostics()
    await screen.findByText(/local-only diagnostics/i)
    expect(screen.queryByRole('button', { name: /try gpu again/i })).not.toBeInTheDocument()
  })
})

describe('Settings → General — Use GPU acceleration (Phase 16)', () => {
  it('renders ON by default (gpuMode auto) and patches gpuMode off when unchecked', async () => {
    const update = vi.fn(async (p: Partial<AppSettings>) => settings(p))
    stubApi({
      getSettings: vi.fn(async () => settings()),
      updateSettings: update as never
    })
    render(<SettingsScreen />)
    const toggle = (await screen.findByLabelText(/use gpu acceleration/i)) as HTMLInputElement
    expect(toggle.checked).toBe(true) // default ON — review decision Q2

    await userEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ gpuMode: 'off' })
  })

  it('re-enables via the same toggle', async () => {
    const update = vi.fn(async (p: Partial<AppSettings>) => settings({ ...p }))
    stubApi({
      getSettings: vi.fn(async () => settings({ gpuMode: 'off' })),
      updateSettings: update as never
    })
    render(<SettingsScreen />)
    const toggle = (await screen.findByLabelText(/use gpu acceleration/i)) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await userEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ gpuMode: 'auto' })
  })
})
