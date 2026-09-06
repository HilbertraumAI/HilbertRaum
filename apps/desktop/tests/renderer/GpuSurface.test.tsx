// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { ToastProvider } from '../../src/renderer/components'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AppStatus,
  type DriveStatus,
  type PerformanceSnapshot,
  type RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { performanceSnapshot } from '../helpers/status'

// Phase 16 GPU surface (architecture.md GPU record §8), re-homed by Phase 26: the Diagnostics
// surfaces live on Settings → "Diagnostics (advanced)", the GPU toggle on Settings →
// General. Same proofs as before the IA regroup: the "Acceleration" line, "Try GPU
// again" (the dedicated IPC, never a raw settings write), the runtime-build line, and
// the toggle. Friendly copy only — these tests also pin that no scary words leak in.
//
// #327: the Acceleration line's device is the snapshot's `currentGpu` — the ELIGIBLE probe's
// display device, resolved main-side against THIS machine's key — never `settings.gpuProbe`
// read raw. So the probe a test puts in `getSettings` is the compatibility-mode/toggle input,
// and `getPerformance` is what the line reads.

const RTX = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }
/** A hybrid laptop's FIRST enumerated device: integrated, reporting shared system memory. */
const IRIS = { id: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16384, freeMb: 12000 }
/** The snapshot's eligible display device for each of the two, as main would compute it. */
const RTX_CURRENT = { name: RTX.name, totalMb: RTX.totalMb, useful: true }
const IRIS_CURRENT = { name: IRIS.name, totalMb: IRIS.totalMb, useful: false }

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
  /** The eligible display device the snapshot reports (#327); default: none. */
  currentGpu?: PerformanceSnapshot['currentGpu']
  /** Replaces the whole `performance:get` stub — for the rejecting case. */
  getPerformance?: ReturnType<typeof vi.fn>
}): void {
  stubApi({
    getAppStatus: vi.fn(async () => appStatus),
    getDriveStatus: vi.fn(async () => driveStatus),
    getRuntimeStatus: vi.fn(async () => opts.runtime ?? runtimeStatus()),
    getRuntimeInstall: vi.fn(async () => opts.install ?? null),
    getSettings: vi.fn(async () => opts.settings ?? settings()),
    getPerformance:
      opts.getPerformance ??
      vi.fn(async () => performanceSnapshot({ currentGpu: opts.currentGpu ?? null })),
    updateSettings: (opts.updateSettings ??
      vi.fn(async (p: Partial<AppSettings>) => settings(p))),
    tryGpuAgain: (opts.tryGpuAgain ??
      vi.fn(async () => settings({ gpuAutoDisabled: false, gpuLastError: null }))),
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
      settings: settings({ gpuProbe: { devices: [RTX], probedAt: '2026-06-10T00:00:00Z' } }),
      currentGpu: RTX_CURRENT
    })
    renderDiagnostics()
    expect(
      await screen.findByText('NVIDIA GeForce RTX 3080 Ti (GPU available)')
    ).toBeInTheDocument()
  })

  it('names the DISPLAY device on a hybrid box, not the first enumerated one (PR #303 audit M8.2)', async () => {
    // A hybrid laptop enumerates the iGPU first while the model runs on the dGPU. The line
    // credits the device the shared `displayDevice` rule selects — the same one the start
    // ladder labels a GPU start with. Since #327 that selection is made MAIN-side and travels
    // as the snapshot's `currentGpu`, so the raw two-device probe below is only the input main
    // was given. Device SELECTION is untouched; this is a label.
    stubDiagnostics({
      settings: settings({ gpuProbe: { devices: [IRIS, RTX], probedAt: '2026-06-10T00:00:00Z' } }),
      currentGpu: RTX_CURRENT
    })
    renderDiagnostics()
    expect(await screen.findByText('NVIDIA GeForce RTX 3080 Ti (GPU available)')).toBeInTheDocument()
    expect(screen.queryByText(/Iris/)).not.toBeInTheDocument()
  })

  it('still names an integrated-only machine rather than falling silent', async () => {
    stubDiagnostics({
      settings: settings({ gpuProbe: { devices: [IRIS], probedAt: '2026-06-10T00:00:00Z' } }),
      currentGpu: IRIS_CURRENT
    })
    renderDiagnostics()
    expect(await screen.findByText('Intel(R) Iris(R) Xe Graphics (GPU available)')).toBeInTheDocument()
  })

  it('#327: a probe stamped for ANOTHER computer names no card — the line says CPU', async () => {
    // The moved-drive / restored-settings case. `settings.gpuProbe` still holds the office
    // desktop's RTX, stamped with ITS machineKey, so main's `eligibleGpuProbe` supplies
    // nothing and `currentGpu` is null. Before this fix the line read the probe RAW and
    // announced "NVIDIA GeForce RTX 3080 Ti (GPU available)" on a laptop with no such card,
    // while the Performance screen — which already used the eligible probe — said none.
    stubDiagnostics({
      settings: settings({
        gpuProbe: {
          devices: [RTX],
          probedAt: '2026-06-10T00:00:00Z',
          machineKey: 'win32|x64|Intel Core i9-13900K|32|64'
        }
      }),
      currentGpu: null
    })
    renderDiagnostics()
    expect(await screen.findByText('CPU')).toBeInTheDocument()
    expect(screen.queryByText(/NVIDIA|GPU available/)).not.toBeInTheDocument()
  })

  it('#327: a failed performance read leaves the line on the CPU wording, never a throw', async () => {
    stubDiagnostics({
      settings: settings({ gpuProbe: { devices: [RTX], probedAt: '2026-06-10T00:00:00Z' } }),
      getPerformance: vi.fn(async () => {
        throw new Error('Error: no snapshot')
      })
    })
    renderDiagnostics()
    // The rest of the card still renders — the read is best-effort, not load-bearing.
    expect(await screen.findByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('HilbertRaum 0.1.0')).toBeInTheDocument()
    expect(screen.queryByText(/GPU available/)).not.toBeInTheDocument()
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
    // The retry PERSISTS the cleared flags, and the tab re-reads its status afterwards (#327
    // follow-through), so the settings stub must reflect the persisted change like main does —
    // `stubDiagnostics` reads `opts.settings` on every call, so a mutable holder is enough.
    const stub = { settings: settings({ gpuAutoDisabled: true }), updateSettings: update, tryGpuAgain: undefined as ReturnType<typeof vi.fn> | undefined }
    const tryAgain = vi.fn(async () => {
      stub.settings = settings({ gpuAutoDisabled: false, gpuLastError: null })
      return stub.settings
    })
    stub.tryGpuAgain = tryAgain
    stubDiagnostics(stub)
    renderDiagnostics()
    expect(await screen.findByText(/compatibility mode/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /try gpu again/i }))
    expect(tryAgain).toHaveBeenCalledTimes(1)
    // The user's gpuMode toggle is NOT touched (no raw settings write at all).
    expect(update).not.toHaveBeenCalled()
    // The notice disappears once the returned settings clear the flag.
    expect(screen.queryByRole('button', { name: /try gpu again/i })).not.toBeInTheDocument()
  })

  it('#327 follow-through: a successful "Try GPU again" that finds a card names it at once', async () => {
    // P10 re-review: the Acceleration line reads the snapshot's eligible device, not the settings
    // the retry returns, so the tab must re-read the snapshot after the retry — before this, a
    // retry that found a card left the line on "CPU" until the next Refresh or remount.
    let found: PerformanceSnapshot['currentGpu'] = null
    const getPerformance = vi.fn(async () => performanceSnapshot({ currentGpu: found }))
    const tryAgain = vi.fn(async () => {
      found = RTX_CURRENT
      return settings({ gpuAutoDisabled: false, gpuLastError: null })
    })
    stubDiagnostics({ settings: settings({ gpuAutoDisabled: true }), tryGpuAgain: tryAgain, getPerformance })
    renderDiagnostics()
    expect(await screen.findByText(/compatibility mode/i)).toBeInTheDocument()
    expect(screen.queryByText('NVIDIA GeForce RTX 3080 Ti (GPU available)')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /try gpu again/i }))
    expect(tryAgain).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('NVIDIA GeForce RTX 3080 Ti (GPU available)')).toBeInTheDocument()
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
      updateSettings: update
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
      updateSettings: update
    })
    render(<SettingsScreen />)
    const toggle = (await screen.findByLabelText(/use gpu acceleration/i)) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await userEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ gpuMode: 'auto' })
  })

  // full-audit 2026-07-11 CODE-7: a refused save (the BE-1 write gate on a locked workspace)
  // used to be an unhandled rejection with zero feedback — the controlled Switch just snapped
  // back, a silent revert. Now a failure toast explains it and the control keeps showing the
  // server's (unchanged) state.
  it('toasts a failed save and keeps the switch on the server state (no unhandled rejection)', async () => {
    const update = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'settings:update': Error: The workspace is locked."
      )
    })
    stubApi({
      getSettings: vi.fn(async () => settings()), // server state: gpuMode 'auto' → ON
      updateSettings: update
    })
    render(
      <ToastProvider>
        <SettingsScreen />
      </ToastProvider>
    )
    const toggle = (await screen.findByLabelText(/use gpu acceleration/i)) as HTMLInputElement
    expect(toggle.checked).toBe(true)

    await userEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ gpuMode: 'off' })
    // The failure toast — never the success "Saved".
    expect(await screen.findByText('This setting couldn’t be saved. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    // The controlled Switch reflects the SERVER state (the save never landed): still ON.
    expect((screen.getByLabelText(/use gpu acceleration/i) as HTMLInputElement).checked).toBe(true)
  })
})
