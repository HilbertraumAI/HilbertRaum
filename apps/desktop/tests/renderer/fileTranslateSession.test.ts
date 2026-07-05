// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getFileTranslate,
  translateDroppedFiles,
  translatePickedFile,
  cancelFileTranslation,
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
import type { DocTaskStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Unit test for the document-translation store (TG-5, plan §2 D7): drop/pick → import as Temporary
// → translation doc-task → materialized Markdown, with the reject/guard paths. Polling is real; we
// wait on the module snapshot with vi.waitFor.

afterEach(() => {
  resetFileTranslateSessionForTests()
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
