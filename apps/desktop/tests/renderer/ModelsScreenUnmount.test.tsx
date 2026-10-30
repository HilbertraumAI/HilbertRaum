// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ModelsScreen, __resetModelsScreenMemoryForTests } from '../../src/renderer/screens/ModelsScreen'
import type { DownloadJob, EngineDownloadJob } from '../../src/shared/types'
import { deferred } from '../helpers/deferred'
import {
  ENGINE_MISSING,
  OBTAINABLE_DOWNLOAD,
  downloadJob,
  engineJob,
  modelInfo,
  stubModelsApi
} from '../helpers/model-fixtures'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'

// F22 (audit full-audit-2026-06-29 postmerge): ModelsScreen was the lone hold-out from the FE-4
// `mountedRef` discipline. Its download and engine poll callbacks ran `setJob(next)` and (on a
// live → terminal transition) `void refresh()` (a fan-out of setStates incl. listModels) with no
// mounted guard, so a poll promise still in flight when the user navigates away resolved onto a dead
// component. Park the poll tick, unmount, resolve it, and assert no `refresh()` (no extra
// `listModels`) lands after unmount. Removing either guard makes its row red: that is the premise,
// the transition really does refresh.
//
// Each row ends with a live job in the module's memory, so the reset is what keeps them independent.

const MODEL_ID = 'qwen3-4b-instruct-q4'
const listModels = vi.fn()

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetModelsScreenMemoryForTests()
  listModels.mockReset()
  listModels.mockImplementation(async () => [
    modelInfo({ id: MODEL_ID, displayName: 'Qwen3 4B Instruct', download: OBTAINABLE_DOWNLOAD })
  ])
})

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

describe('ModelsScreen — FE-4 setState-after-unmount guard (download and engine polls)', () => {
  it('drops an in-flight download-poll tick after unmount — no refresh on a dead component', async () => {
    const parked = deferred<DownloadJob>()
    const getDownloadJob = vi.fn(() => parked.promise)
    stubModelsApi({
      listModels,
      downloadModel: vi.fn(async () => downloadJob({ jobId: 'jf', modelId: MODEL_ID })),
      getDownloadJob
    })

    const { unmount } = render(<ModelsScreen />)
    await flush() // mount refresh (listModels, etc.)

    // Start a download → setJob(live) → the download poll effect arms its interval.
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start download' }))
    await flush()

    // The first poll tick (1 s) parks mid-await.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(getDownloadJob).toHaveBeenCalledTimes(1)
    const listBefore = listModels.mock.calls.length

    unmount()
    await act(async () => {
      parked.resolve(downloadJob({ jobId: 'jf', modelId: MODEL_ID, status: 'done', receivedBytes: 100 }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(listModels.mock.calls.length).toBe(listBefore)
  })

  it('drops an in-flight engine-poll tick after unmount — no refresh on a dead component', async () => {
    const parked = deferred<EngineDownloadJob>()
    const getEngineJob = vi.fn(() => parked.promise)
    stubModelsApi({
      listModels,
      getEngineStatus: vi.fn(async () => ENGINE_MISSING),
      downloadEngine: vi.fn(async () => engineJob()),
      getEngineJob
    })

    const { unmount } = render(<ModelsScreen />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Install AI engine' }))
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(getEngineJob).toHaveBeenCalledTimes(1)
    const listBefore = listModels.mock.calls.length

    unmount()
    await act(async () => {
      parked.resolve(engineJob({ status: 'done' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(listModels.mock.calls.length).toBe(listBefore)
  })
})
