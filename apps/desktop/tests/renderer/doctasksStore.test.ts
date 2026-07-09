// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getActiveDocTask,
  resetDocTaskStoreForTests,
  startTask
} from '../../src/renderer/lib/doctasks'
import type { DocTaskStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// The doc-task store's deep-index chain adoption (#38): "Build deep index" starts a 'tree'
// task with `withExtract`; the BACKEND chains an 'extract' task over the same document after
// the tree succeeds. The store must adopt that follow-up (same timer, new jobId) so the row
// busy state and the chat task banner stay truthful through both passes — and must keep the
// ordinary terminal handling byte-identical for every other task.

afterEach(() => {
  resetDocTaskStoreForTests()
})

function status(over: Partial<DocTaskStatus>): DocTaskStatus {
  return {
    jobId: 'jt',
    kind: 'tree',
    documentIds: ['d1'],
    state: 'running',
    progress: { stepsDone: 0, stepsTotal: 0 },
    error: null,
    resultRef: null,
    ...over
  }
}

/** Poll until `pred` holds (the store's own interval is 400 ms). */
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('doc-task store — deep-index chain adoption (#38)', () => {
  it('adopts the chained extract task after a withExtract tree completes', async () => {
    const treeDone = status({ jobId: 'jt', kind: 'tree', state: 'done' })
    const extractRunning = status({ jobId: 'jx', kind: 'extract', state: 'running' })
    const extractDone = status({ jobId: 'jx', kind: 'extract', state: 'done' })
    let extractPolls = 0
    stubApi({
      startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
      getDocTask: vi.fn(async (id: string) => {
        if (id === 'jt') return treeDone
        extractPolls += 1
        return extractPolls > 1 ? extractDone : extractRunning
      }),
      getActiveDocTask: vi.fn(async () => extractRunning)
    } as never)

    await startTask('tree', 'd1', { withExtract: true })
    // The store switches from the finished tree job to the chained extract job…
    await until(() => getActiveDocTask()?.jobId === 'jx')
    expect(getActiveDocTask()?.kind).toBe('extract')
    expect(getActiveDocTask()?.documentIds).toEqual(['d1'])
    // …and keeps polling it to ITS terminal state on the same timer.
    await until(() => getActiveDocTask()?.status?.state === 'done')
    expect(getActiveDocTask()?.jobId).toBe('jx')
  })

  it('keeps the ordinary terminal handling when the chain was dropped (no follow-up running)', async () => {
    stubApi({
      startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
      getDocTask: vi.fn(async () => status({ state: 'done' })),
      getActiveDocTask: vi.fn(async () => null)
    } as never)

    await startTask('tree', 'd1', { withExtract: true })
    await until(() => getActiveDocTask()?.status?.state === 'done')
    expect(getActiveDocTask()?.jobId).toBe('jt') // terminal stays visible for acknowledgement
  })

  it('never adopts on a plain task (no withExtract) — even when some other task is running', async () => {
    const getActive = vi.fn(async () => status({ jobId: 'other', kind: 'summary', state: 'running' }))
    stubApi({
      startDocTask: vi.fn(async () => ({ jobId: 'jt' })),
      getDocTask: vi.fn(async () => status({ state: 'done' })),
      getActiveDocTask: getActive
    } as never)

    await startTask('tree', 'd1')
    await until(() => getActiveDocTask()?.status?.state === 'done')
    expect(getActiveDocTask()?.jobId).toBe('jt')
    expect(getActive).not.toHaveBeenCalled() // byte-identical polling for every other task
  })
})
