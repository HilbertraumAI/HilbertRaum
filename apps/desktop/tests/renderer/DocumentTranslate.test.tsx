// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import type { DocTaskStatus, DocumentInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 34 renderer tests: the Translate row action with its de/en target choice, the
// polling busy state ("Translating… (n/m)") + cancel, the new document appearing with
// its provenance line after completion, and the Export action for materialized
// documents.

function doc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    id: 'd1',
    title: 'contract.pdf',
    originalPath: '/u/contract.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 7,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over
  }
}

function translatedDoc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return doc({
    id: 'd2',
    title: 'contract (Deutsch).md',
    originalPath: null,
    mimeType: 'text/markdown',
    origin: { translatedFrom: 'd1', targetLang: 'de' },
    ...over
  })
}

function task(over: Partial<DocTaskStatus> = {}): DocTaskStatus {
  return {
    jobId: 'j1',
    kind: 'translation',
    documentIds: ['d1'],
    state: 'running',
    progress: { stepsDone: 0, stepsTotal: 0 },
    error: null,
    resultRef: null,
    ...over
  }
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  resetDocTaskStoreForTests()
  vi.restoreAllMocks()
})

describe('DocumentsScreen — Translate action (Phase 34)', () => {
  it('offers the de/en target choice, runs the busy flow, then reveals the new document with provenance', async () => {
    const user = userEvent.setup()
    let docs = [doc()]
    let status = task({ state: 'running', progress: { stepsDone: 1, stepsTotal: 4 } })
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    const getDocTask = vi.fn(async () => status)
    stubApi({
      listDocuments: vi.fn(async () => docs),
      startDocTask,
      getDocTask
    })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /^translate$/i }))

    // The target choice modal: v1 targets are German and English only.
    expect(await screen.findByText(/Translate "contract.pdf"/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /to german/i }))
    expect(startDocTask).toHaveBeenCalledWith({
      kind: 'translation',
      documentIds: ['d1'],
      params: { targetLang: 'de' }
    })

    // Busy state with window progress + a cancel affordance.
    expect(await screen.findByText(/Translating…\s*\(1\/4\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument()

    // The task finishes: the refreshed list reveals the new "(Deutsch)" document with
    // its quiet provenance line; no preview auto-opens for translations.
    docs = [doc(), translatedDoc()]
    status = task({
      state: 'done',
      progress: { stepsDone: 4, stepsTotal: 4 },
      resultRef: { documentId: 'd2' }
    })
    expect(await screen.findByText('contract (Deutsch).md', undefined, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText(/Translated from/)).toBeInTheDocument()
    expect(screen.queryByText(/Translating…/)).not.toBeInTheDocument()
  })

  it('passes targetLang "en" for the English choice', async () => {
    const user = userEvent.setup()
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    stubApi({
      listDocuments: vi.fn(async () => [doc()]),
      startDocTask,
      getDocTask: vi.fn(async () => task())
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /^translate$/i }))
    await user.click(await screen.findByRole('button', { name: /to english/i }))
    expect(startDocTask).toHaveBeenCalledWith({
      kind: 'translation',
      documentIds: ['d1'],
      params: { targetLang: 'en' }
    })
  })

  it('cancelling the busy translation calls cancelDocTask', async () => {
    const user = userEvent.setup()
    const cancelDocTask = vi.fn(async () => {})
    stubApi({
      listDocuments: vi.fn(async () => [doc()]),
      startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
      getDocTask: vi.fn(async () => task({ state: 'running' })),
      cancelDocTask
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /^translate$/i }))
    await user.click(await screen.findByRole('button', { name: /to german/i }))
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }))
    expect(cancelDocTask).toHaveBeenCalled()
  })

  it('surfaces the friendly failure copy (e.g. password change in progress)', async () => {
    const user = userEvent.setup()
    stubApi({
      listDocuments: vi.fn(async () => [doc()]),
      startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
      getDocTask: vi.fn(async () =>
        task({
          state: 'failed',
          error: 'The workspace password is being changed right now. Try again in a moment.'
        })
      )
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /^translate$/i }))
    await user.click(await screen.findByRole('button', { name: /to german/i }))
    expect(
      await screen.findByText(/password is being changed/i, undefined, { timeout: 3000 })
    ).toBeInTheDocument()
  })

  it('shows the provenance line and Export only on materialized documents; Export saves', async () => {
    const user = userEvent.setup()
    const exportDocument = vi.fn(async () => 'C:/exported.md')
    stubApi({
      listDocuments: vi.fn(async () => [doc(), translatedDoc()]),
      exportDocument
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract (Deutsch).md')
    // Provenance names the source document.
    expect(screen.getByText(/Translated from/)).toBeInTheDocument()
    expect(screen.getByText('contract.pdf', { selector: 'b' })).toBeInTheDocument()
    // Exactly one Export button (the materialized doc only).
    const exportButtons = screen.getAllByRole('button', { name: /^export$/i })
    expect(exportButtons).toHaveLength(1)
    await user.click(exportButtons[0])
    expect(exportDocument).toHaveBeenCalledWith('d2')
  })

  it('the preview shows the provenance line for a translated document', async () => {
    const user = userEvent.setup()
    stubApi({
      listDocuments: vi.fn(async () => [doc(), translatedDoc()]),
      previewDocument: vi.fn(async () => ({
        id: 'd2',
        title: 'contract (Deutsch).md',
        mimeType: 'text/markdown',
        segments: [{ text: 'Maschinell übersetzt …', pageNumber: null, sectionLabel: null }]
      }))
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract (Deutsch).md')
    const previewButtons = screen.getAllByRole('button', { name: /^preview$/i })
    await user.click(previewButtons[1])
    expect(await screen.findByText(/Maschinell übersetzt/)).toBeInTheDocument()
    // The provenance line appears in the preview too (row + modal render it).
    expect(screen.getAllByText(/Translated from/).length).toBeGreaterThanOrEqual(2)
  })

  it('the source row falls back gracefully when the source document was deleted', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [translatedDoc()]) // the source d1 is gone
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract (Deutsch).md')
    expect(screen.getByText('a removed document')).toBeInTheDocument()
  })
})
