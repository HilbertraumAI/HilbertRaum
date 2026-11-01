// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useEngineProblemsRead } from '../../src/renderer/lib/useEngineProblems'
import { stubApi } from '../helpers/renderer'
import { appStatus } from '../helpers/status'

afterEach(cleanup)

// The read's own contract. What the screens do with a verdict is pinned in EngineProblem.test.tsx; a row there cannot fail
// this read alone, because ModelsScreen's refresh reads the same channel and a rejection would stop that too.
describe('useEngineProblemsRead (#530)', () => {
  // The AI Model screen's deep-link scroll waits for `settled`, so a failed read that never settled would hold it for good.
  it('a failed read settles with no verdict', async () => {
    stubApi({
      getAppStatus: vi.fn(async () => {
        throw new Error('the read failed')
      }),
      onEngineProblemsChanged: vi.fn(() => () => {})
    })
    const { result } = renderHook(() => useEngineProblemsRead())
    expect(result.current).toEqual({ problems: null, settled: false })
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(result.current.problems).toBeNull()
  })

  it('stops listening for the push when it unmounts', async () => {
    const off = vi.fn()
    stubApi({ getAppStatus: vi.fn(async () => appStatus()), onEngineProblemsChanged: vi.fn(() => off) })
    const { result, unmount } = renderHook(() => useEngineProblemsRead())
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(off).not.toHaveBeenCalled()
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
