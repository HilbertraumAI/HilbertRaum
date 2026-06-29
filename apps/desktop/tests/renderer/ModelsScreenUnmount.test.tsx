// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ModelsScreen } from '../../src/renderer/screens/ModelsScreen'
import { DEFAULT_SETTINGS, type DownloadJob, type ModelInfo, type PolicyStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// F22 (audit full-audit-2026-06-29 postmerge): ModelsScreen was the lone hold-out from the
// FE-4 `mountedRef` discipline. Its download/engine poll callbacks ran `setJob(next)` and (on a
// live → terminal transition) `void refresh()` (a fan-out of setStates incl. listModels) with no
// mounted guard, so a `getDownloadJob` promise still in flight when the user navigates away
// resolved onto a dead component. This mirrors the DocumentsScreen FE-4 test: park the poll tick,
// unmount, then resolve it and assert no `refresh()` (no extra `listModels`) lands after unmount.
//
// Isolated in its own file so ModelsScreen's module-level `rememberedJob` starts fresh (null),
// independent of the live-job the main ModelsScreen suite deliberately leaves remembered.

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'qwen3-4b-instruct-q4',
    displayName: 'Qwen3 4B Instruct',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    sizeOnDiskGb: 2.7,
    recommendedMinRamGb: 8,
    recommendedRamGb: 16,
    recommendedContextTokens: 4096,
    localPath: 'models/chat/qwen3-4b-instruct-q4.gguf',
    state: 'missing',
    recommended: false,
    download: {
      url: 'https://example.test/qwen3-4b.gguf',
      sizeBytes: 2_900_000_000,
      licenseUrl: 'https://example.test/license',
      licenseApproved: true
    },
    ...over
  }
}

function policyAllowed(): PolicyStatus {
  return {
    policy: {
      network: { allowModelDownloads: true, allowUpdateChecks: false, allowTelemetry: false },
      workspace: { encryptionRequired: false, allowPlaintextDevMode: true },
      models: { allowUnverifiedModels: true, requireManifest: true, requireSha256Match: false }
    },
    policyFilePresent: true,
    driveFilePresent: true,
    allowNetworkSetting: true,
    networkAllowedByPolicy: true,
    networkAllowed: true,
    offlineMode: false,
    telemetryAllowed: false
  }
}

afterEach(cleanup)

describe('ModelsScreen — FE-4 setState-after-unmount guard (download poll)', () => {
  it('drops an in-flight download-poll tick after unmount — no refresh on a dead component', async () => {
    vi.useFakeTimers()
    try {
      const listModels = vi.fn(async () => [model()])
      // getDownloadJob PARKS on its poll call: it hands back a promise we resolve by hand, so the
      // tick straddles the unmount and THEN resolves with a live → terminal ('done') transition
      // that would normally fire refresh() — exercising the post-await guard.
      let release: (() => void) | null = null
      const getDownloadJob = vi.fn(
        (jobId: string): Promise<DownloadJob> =>
          new Promise<DownloadJob>((res) => {
            release = (): void =>
              res({
                jobId,
                modelId: 'qwen3-4b-instruct-q4',
                status: 'done',
                receivedBytes: 100,
                totalBytes: 100,
                unverified: false,
                error: null
              })
          })
      )
      const downloadModel = vi.fn(
        async (): Promise<DownloadJob> => ({
          jobId: 'jf',
          modelId: 'qwen3-4b-instruct-q4',
          status: 'downloading',
          receivedBytes: 0,
          totalBytes: 100,
          unverified: false,
          error: null
        })
      )
      stubApi({
        listModels,
        getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, activeModelId: null })),
        getPolicy: vi.fn(async () => policyAllowed()),
        getAppStatus: vi.fn(async () => ({ machineRamGb: 32 }) as never),
        downloadModel: downloadModel as never,
        getDownloadJob: getDownloadJob as never
      })

      const flush = async (): Promise<void> => {
        await act(async () => {
          for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
        })
      }

      const { unmount } = render(<ModelsScreen />)
      await flush() // mount refresh (listModels, etc.)

      // Start a download → setJob(live) → the download poll effect arms its interval.
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      fireEvent.click(screen.getByRole('button', { name: 'Start download' }))
      await flush() // downloadModel resolves → job becomes 'downloading' (live)

      // Fire the first poll tick (1 s) → getDownloadJob parks mid-await (in-flight).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(release).not.toBeNull()
      const listBefore = listModels.mock.calls.length

      // Unmount mid-poll (clears the interval), THEN resolve the parked tick with a terminal
      // status. The mounted guard drops it: no setJob / no refresh() on the dead component.
      // Teeth: without the guard, the live → 'done' transition calls refresh() → listModels rises.
      unmount()
      await act(async () => {
        release!()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(listModels.mock.calls.length).toBe(listBefore)
    } finally {
      vi.useRealTimers()
    }
  })
})
