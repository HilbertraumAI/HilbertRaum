// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getFileTranslate,
  translateDroppedFiles,
  translatePickedFile,
  cancelFileTranslation,
  adoptActiveFileTranslation,
  resetFileTranslation,
  clearFileTranslate,
  resetFileTranslateSessionForTests
} from '../../src/renderer/lib/fileTranslateSession'
import {
  startTask,
  getActiveDocTask,
  isDocTaskTerminal,
  resetDocTaskStoreForTests
} from '../../src/renderer/lib/doctasks'
import {
  translate,
  getTranslateSession,
  resetTranslateSessionForTests
} from '../../src/renderer/lib/translateSession'
import type { DocTaskStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Unit test for the document-translation store (TG-5, plan §2 D7): drop/pick → import as Temporary
// → translation doc-task → materialized Markdown, with the reject/guard paths. Polling is real; we
// wait on the module snapshot with vi.waitFor.

afterEach(() => {
  resetFileTranslateSessionForTests()
  resetTranslateSessionForTests()
  resetDocTaskStoreForTests()
  vi.restoreAllMocks()
})

const CHOICE = { sourceLang: 'de', targetLang: 'en' } as const

function docTask(over: Partial<DocTaskStatus> = {}): DocTaskStatus {
  return {
    jobId: 'task1',
    kind: 'translation',
    documentIds: ['d1'],
    state: 'running',
    progress: { stepsDone: 0, stepsTotal: 0 },
    ...over
  }
}

function happyApi() {
  let polls = 0
  return {
    getDroppedFilePath: vi.fn(() => 'C:\\docs\\a.pdf'),
    pickDocuments: vi.fn(async () => ({ token: 'tok1', paths: ['C:\\docs\\a.pdf'] })),
    importDocuments: vi.fn(async () => ({ jobId: 'imp1', documentIds: ['d1'] })),
    getImportJob: vi.fn(async () => ({ jobId: 'imp1', total: 1, completed: 1, failed: 0, done: true })),
    startDocTask: vi.fn(async () => ({ jobId: 'task1' })),
    getDocTask: vi.fn(async () => {
      polls += 1
      return polls === 1
        ? docTask({ progress: { stepsDone: 1, stepsTotal: 2 } })
        : docTask({ state: 'done', progress: { stepsDone: 2, stepsTotal: 2 }, resultRef: { documentId: 'gen1' } })
    }),
    previewDocument: vi.fn(async () => ({
      id: 'gen1',
      title: 'a (English)',
      mimeType: 'text/markdown',
      segments: [{ text: 'Hello world.', pageNumber: null, sectionLabel: null }],
      nextOffset: null
    }))
  }
}

describe('fileTranslateSession — happy path', () => {
  it('drops a file, imports it as Temporary, runs the doc-task, loads the materialized text', async () => {
    const api = happyApi()
    stubApi(api as never)
    const outcome = await translateDroppedFiles(
      [new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })],
      CHOICE
    )
    expect(outcome).toBe('started')
    expect(api.importDocuments).toHaveBeenCalledWith(['C:\\docs\\a.pdf'], {
      destination: { kind: 'temporary' }
    })

    await vi.waitFor(() => expect(getFileTranslate().state).toBe('done'), { timeout: 5000 })
    const snap = getFileTranslate()
    expect(snap.output).toBe('Hello world.')
    expect(snap.resultDocumentId).toBe('gen1')
    expect(snap.truncated).toBe(false)
    expect(snap.busy).toBe(false)
    expect(api.startDocTask).toHaveBeenCalledWith({
      kind: 'translation',
      documentIds: ['d1'],
      params: { sourceLang: 'de', targetLang: 'en' }
    })
  }, 8000)

  it('the picker path passes the capability token to the temporary import', async () => {
    const api = happyApi()
    stubApi(api as never)
    await translatePickedFile(CHOICE)
    await vi.waitFor(() => expect(api.importDocuments).toHaveBeenCalled(), { timeout: 5000 })
    expect(api.importDocuments).toHaveBeenCalledWith(['C:\\docs\\a.pdf'], {
      destination: { kind: 'temporary' },
      pickerToken: 'tok1'
    })
  }, 8000)
})

describe('fileTranslateSession — reject + guard paths', () => {
  it('rejects a multi-file drop without importing', async () => {
    const api = happyApi()
    stubApi(api as never)
    await translateDroppedFiles(
      [new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')],
      CHOICE
    )
    expect(getFileTranslate().error).toBe('multiDrop')
    expect(api.importDocuments).not.toHaveBeenCalled()
  })

  it('rejects a drop with no on-disk path (a browser-origin drag)', async () => {
    const api = { ...happyApi(), getDroppedFilePath: vi.fn(() => '') }
    stubApi(api as never)
    await translateDroppedFiles([new File(['x'], 'a.pdf')], CHOICE)
    expect(getFileTranslate().error).toBe('noPath')
    expect(api.importDocuments).not.toHaveBeenCalled()
  })

  it('surfaces an unsupported file (nothing imported) as a friendly error', async () => {
    const api = { ...happyApi(), importDocuments: vi.fn(async () => ({ jobId: 'imp1', documentIds: [] })) }
    stubApi(api as never)
    await translateDroppedFiles([new File(['x'], 'a.xyz')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().error).toBe('unsupported'), { timeout: 5000 })
    expect(api.startDocTask).not.toHaveBeenCalled()
  }, 8000)

  it('refuses while a foreign document task holds the lane (D9)', async () => {
    // Populate the GLOBAL doc-task store so getActiveDocTask() is non-null.
    const globalApi = {
      startDocTask: vi.fn(async () => ({ jobId: 'foreign' })),
      getDocTask: vi.fn(async () => docTask({ jobId: 'foreign' }))
    }
    stubApi(globalApi as never)
    await startTask('summary', 'doc9')

    const api = happyApi()
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    expect(getFileTranslate().error).toBe('docTaskBusy')
    expect(api.importDocuments).not.toHaveBeenCalled()
  })

  it('busy-rejects a second document translation while one runs', async () => {
    const api = happyApi()
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    // The first is now importing/translating (busy). A second returns 'busy' immediately.
    const second = await translateDroppedFiles([new File(['%PDF'], 'b.pdf')], CHOICE)
    expect(second).toBe('busy')
  }, 8000)

  it('does NOT block on a TERMINAL foreign doc task lingering in the global store (C4)', async () => {
    // Seed the GLOBAL store with a DONE (terminal) foreign task — it must NOT refuse a translation.
    const globalApi = {
      startDocTask: vi.fn(async () => ({ jobId: 'foreign' })),
      getDocTask: vi.fn(async () =>
        docTask({ jobId: 'foreign', state: 'done', progress: { stepsDone: 1, stepsTotal: 1 }, resultRef: { documentId: 'x' } })
      )
    }
    stubApi(globalApi as never)
    await startTask('summary', 'doc9')
    await vi.waitFor(() => expect(isDocTaskTerminal(getActiveDocTask()?.status ?? null)).toBe(true), { timeout: 3000 })

    const api = happyApi()
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    // Proceeds to import (not blocked with docTaskBusy).
    await vi.waitFor(() => expect(api.importDocuments).toHaveBeenCalled(), { timeout: 3000 })
    expect(getFileTranslate().error).not.toBe('docTaskBusy')
  }, 8000)

  it('cancels the orphan backend task when Stop lands during the startDocTask round-trip (C2/C3)', async () => {
    // Hold startDocTask pending so we can Stop while state is still 'importing'.
    let resolveStart: (v: { jobId: string }) => void = () => {}
    const startDocTask = vi.fn(() => new Promise((r) => { resolveStart = r }))
    const cancelDocTask = vi.fn(async () => {})
    const api = { ...happyApi(), startDocTask, cancelDocTask }
    stubApi(api as never)

    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(startDocTask).toHaveBeenCalled(), { timeout: 5000 })
    // The start round-trip is in flight; the panel is still 'importing' (translating is set AFTER).
    expect(getFileTranslate().state).toBe('importing')

    // User hits Stop in that window — the store must cancel the orphan once it materializes.
    cancelFileTranslation()
    expect(getFileTranslate().state).toBe('cancelled')
    resolveStart({ jobId: 'task1' })
    await vi.waitFor(() => expect(cancelDocTask).toHaveBeenCalled(), { timeout: 5000 })
  }, 8000)
})

describe('fileTranslateSession — lifecycle', () => {
  it('cancel + reset return the panel to idle', async () => {
    const api = happyApi()
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    cancelFileTranslation()
    expect(getFileTranslate().state).toBe('cancelled')
    expect(getFileTranslate().busy).toBe(false)
    resetFileTranslation()
    expect(getFileTranslate().state).toBe('idle')
  })

  it('clear drops all resident state on workspace lock', async () => {
    const api = happyApi()
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().state).toBe('done'), { timeout: 5000 })
    clearFileTranslate()
    const snap = getFileTranslate()
    expect(snap.state).toBe('idle')
    expect(snap.output).toBe('')
    expect(snap.resultDocumentId).toBe(null)
  }, 8000)
})

// ---- TA-3 hardening: H4 poll latch, M8 post-picker guard, doc-task terminal + failure edges ----

describe('fileTranslateSession — H4 per-timer poll latch', () => {
  it('does not double-fire startDocTask when a stale generation callback releases the poll latch', async () => {
    // Regression for H4: with a MODULE-level latch reset by stopPolling(), a stale generation's slow
    // import round-trip resolving after Stop + re-drop would free the NEW generation's in-flight
    // latch (its `finally { pollInFlight = false }` runs on the stale early-return), letting two
    // ticks fire concurrently → a double startDocTask (a zombie backend task on the one-at-a-time
    // lane). The per-timer latch keeps each generation's reentrancy guard private. Fake timers drive
    // the poll; deferred getImportJob calls model the slow round-trips.
    vi.useFakeTimers()
    try {
      const makeDeferred = (): { promise: Promise<unknown>; resolve: (v: unknown) => void } => {
        let resolve: (v: unknown) => void = () => {}
        const promise = new Promise<unknown>((r) => (resolve = r))
        return { promise, resolve }
      }
      const importCalls: Array<{ promise: Promise<unknown>; resolve: (v: unknown) => void }> = []
      const DONE = { jobId: 'imp1', total: 1, completed: 1, failed: 0, done: true }
      const api = {
        getDroppedFilePath: vi.fn(() => 'C:\\docs\\a.pdf'),
        importDocuments: vi.fn(async () => ({ jobId: 'imp1', documentIds: ['d1'] })),
        getImportJob: vi.fn(() => {
          const d = makeDeferred()
          importCalls.push(d)
          return d.promise
        }),
        startDocTask: vi.fn(async () => ({ jobId: 'task1' })),
        getDocTask: vi.fn(async () => docTask({ progress: { stepsDone: 0, stepsTotal: 1 } })),
        cancelDocTask: vi.fn(async () => {})
      }
      stubApi(api as never)

      // gen A: drop → import resolves → import poll timer installed.
      await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
      // gen A's first import tick fires and awaits a SLOW getImportJob (call #0, unresolved).
      await vi.advanceTimersByTimeAsync(400)
      expect(importCalls).toHaveLength(1)

      // Stop supersedes gen A (clears its timer; its tick's IPC is still in flight). A new drop
      // starts gen B with its OWN import timer.
      cancelFileTranslation()
      await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
      // gen B's first import tick fires and awaits its own SLOW getImportJob (call #1, unresolved).
      await vi.advanceTimersByTimeAsync(400)
      expect(importCalls).toHaveLength(2)

      // The STALE gen-A round-trip resolves. With a shared latch its `finally` would free gen B's
      // in-flight latch; the per-timer latch keeps gen B's tick reentrancy-guarded.
      importCalls[0].resolve(DONE)
      await Promise.resolve()
      await Promise.resolve()
      // A further tick would, under the bug, fire a SECOND concurrent gen-B import round-trip.
      await vi.advanceTimersByTimeAsync(400)

      // Resolve every outstanding import round-trip as done; under the bug BOTH gen-B ticks reach
      // startTranslationTask (two startDocTask calls). With the fix exactly one does.
      for (const d of importCalls) d.resolve(DONE)
      await vi.advanceTimersByTimeAsync(400)
      await vi.advanceTimersByTimeAsync(400)

      expect(api.startDocTask).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fileTranslateSession — M8 post-picker guard', () => {
  it('re-checks the start guard after the picker await; a text job that starts meanwhile makes it bail busy without touching the text session', async () => {
    let resolvePick: (v: { token: string; paths: string[] }) => void = () => {}
    const pickP = new Promise<{ token: string; paths: string[] }>((r) => (resolvePick = r))
    const api = {
      ...happyApi(),
      pickDocuments: vi.fn(() => pickP),
      translateStart: vi.fn(async () => ({ jobId: 't1', state: 'queued', text: '' })),
      translateCancel: vi.fn(async () => ({})),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(api as never)

    // Start the picker path — guardStart passes (nothing busy), then it awaits the OS dialog.
    const pickPromise = translatePickedFile(CHOICE)
    // While the dialog is open, a TEXT translation starts (the non-modal-dialog race).
    await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(getTranslateSession().translating).toBe(true)
    expect(getTranslateSession().activeJobId).toBe('t1')

    // The dialog now returns a file. The re-check must see the text job and bail busy.
    resolvePick({ token: 'tok1', paths: ['C:\\docs\\a.pdf'] })
    const outcome = await pickPromise
    expect(outcome).toBe('busy')
    // The text session is UNTOUCHED (never cleared): it still holds its job, still translating.
    expect(getTranslateSession().activeJobId).toBe('t1')
    expect(getTranslateSession().translating).toBe(true)
    expect(api.importDocuments).not.toHaveBeenCalled()
  })
})

describe('fileTranslateSession — doc-task terminal + failure edges', () => {
  it('surfaces a failed doc-task with the backend error message (failWith)', async () => {
    const api = { ...happyApi(), getDocTask: vi.fn(async () => docTask({ state: 'failed', error: 'Kaputt' })) }
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().state).toBe('failed'), { timeout: 5000 })
    expect(getFileTranslate().errorMessage).toBe('Kaputt')
    expect(getFileTranslate().busy).toBe(false)
  }, 8000)

  it('a failed doc-task with no error message falls back to the runtimeFailed code', async () => {
    const api = { ...happyApi(), getDocTask: vi.fn(async () => docTask({ state: 'failed' })) }
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().state).toBe('failed'), { timeout: 5000 })
    expect(getFileTranslate().error).toBe('runtimeFailed')
  }, 8000)

  it('a cancelled doc-task settles the panel to cancelled', async () => {
    const api = { ...happyApi(), getDocTask: vi.fn(async () => docTask({ state: 'cancelled' })) }
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().state).toBe('cancelled'), { timeout: 5000 })
    expect(getFileTranslate().busy).toBe(false)
  }, 8000)

  it('an import-poll rejection fails with a friendly message', async () => {
    const api = {
      ...happyApi(),
      getImportJob: vi.fn(async () => {
        throw new Error('import boom')
      })
    }
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().state).toBe('failed'), { timeout: 5000 })
    expect(getFileTranslate().errorMessage).toBeTruthy()
    expect(api.startDocTask).not.toHaveBeenCalled()
  }, 8000)

  it('a doc-task-poll rejection fails with a friendly message', async () => {
    const api = {
      ...happyApi(),
      getDocTask: vi.fn(async () => {
        throw new Error('task boom')
      })
    }
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().state).toBe('failed'), { timeout: 5000 })
    expect(getFileTranslate().errorMessage).toBeTruthy()
  }, 8000)

  it('a previewDocument failure surfaces as a friendly error (not a blank done panel)', async () => {
    const api = {
      ...happyApi(),
      previewDocument: vi.fn(async () => {
        throw new Error('locked')
      })
    }
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().state).toBe('failed'), { timeout: 5000 })
    expect(getFileTranslate().errorMessage).toBeTruthy()
  }, 8000)

  it('an import that ingests nothing (completed === 0) is unsupported', async () => {
    const api = {
      ...happyApi(),
      getImportJob: vi.fn(async () => ({ jobId: 'imp1', total: 1, completed: 0, failed: 1, done: true }))
    }
    stubApi(api as never)
    await translateDroppedFiles([new File(['%PDF'], 'a.pdf')], CHOICE)
    await vi.waitFor(() => expect(getFileTranslate().error).toBe('unsupported'), { timeout: 5000 })
    expect(api.startDocTask).not.toHaveBeenCalled()
  }, 8000)
})

// ---- FA-3 / F-3: reload adoption of a still-running document translation ----

describe('fileTranslateSession — adoptActiveFileTranslation (reload recovery)', () => {
  it('adopts a RUNNING translation doc-task, seeds progress with a null fileName, polls to done + loads the result', async () => {
    let polls = 0
    const api = {
      // A full reload lost the module store; main still has a running translation doc-task.
      getActiveDocTask: vi.fn(async () =>
        docTask({ jobId: 'task1', state: 'running', progress: { stepsDone: 2, stepsTotal: 5 } })
      ),
      getDocTask: vi.fn(async () => {
        polls += 1
        return polls === 1
          ? docTask({ jobId: 'task1', progress: { stepsDone: 3, stepsTotal: 5 } })
          : docTask({
              jobId: 'task1',
              state: 'done',
              progress: { stepsDone: 5, stepsTotal: 5 },
              resultRef: { documentId: 'gen1' }
            })
      }),
      previewDocument: vi.fn(async () => ({
        id: 'gen1',
        title: 'a (English)',
        mimeType: 'text/markdown',
        segments: [{ text: 'Adopted translation.', pageNumber: null, sectionLabel: null }],
        nextOffset: null
      }))
    }
    stubApi(api as never)

    await adoptActiveFileTranslation()
    // Seeds immediately from the doc-task status: translating, its progress, fileName tolerated null.
    const seeded = getFileTranslate()
    expect(seeded.state).toBe('translating')
    expect(seeded.busy).toBe(true)
    expect(seeded.fileName).toBe(null)
    expect(seeded.windowsDone).toBe(2)
    expect(seeded.windowsTotal).toBe(5)

    await vi.waitFor(() => expect(getFileTranslate().state).toBe('done'), { timeout: 5000 })
    const snap = getFileTranslate()
    expect(snap.output).toBe('Adopted translation.')
    expect(snap.resultDocumentId).toBe('gen1')
    expect(snap.busy).toBe(false)
  }, 8000)

  it('is a no-op when NO doc-task is active', async () => {
    const api = { getActiveDocTask: vi.fn(async () => null), getDocTask: vi.fn(async () => docTask()) }
    stubApi(api as never)
    await adoptActiveFileTranslation()
    expect(getFileTranslate().state).toBe('idle')
    expect(api.getDocTask).not.toHaveBeenCalled()
  })

  it('is a no-op when the active doc-task is NOT a translation (e.g. a summary)', async () => {
    const api = {
      getActiveDocTask: vi.fn(async () => docTask({ kind: 'summary', state: 'running' })),
      getDocTask: vi.fn(async () => docTask())
    }
    stubApi(api as never)
    await adoptActiveFileTranslation()
    expect(getFileTranslate().state).toBe('idle')
    expect(api.getDocTask).not.toHaveBeenCalled()
  })

  it('yields to a live TEXT job (precedence — the two adopts never both claim the panel)', async () => {
    // A text job is streaming (translateSession busy); the file adopt must not seed even if main
    // reported a running doc-task (it cannot in practice — the D9 lane — but precedence is enforced).
    const textApi = {
      translateStart: vi.fn(async () => ({ jobId: 't1', state: 'queued', text: '' })),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(textApi as never)
    await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(getTranslateSession().translating).toBe(true)

    const fileApi = {
      getActiveDocTask: vi.fn(async () => docTask({ jobId: 'task1', state: 'running' })),
      getDocTask: vi.fn(async () => docTask())
    }
    stubApi(fileApi as never)
    await adoptActiveFileTranslation()
    expect(getFileTranslate().state).toBe('idle')
    expect(fileApi.getActiveDocTask).not.toHaveBeenCalled()
  })
})
