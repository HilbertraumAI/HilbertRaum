// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import type { DocTaskStatus, DocumentInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 35 renderer tests: the "Compare (2)" action on the Phase-17 multi-select
// (visible at EXACTLY two selections), the polling busy state ("Comparing… (n/m)" on
// BOTH source rows) + cancel, the completion flow (the new report document appears
// with its both-sources provenance line and its preview auto-opens), friendly failure
// copy, and Export on the materialized report.

function doc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    id: 'd1',
    title: 'contract-v1.pdf',
    originalPath: '/u/contract-v1.pdf',
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

const DOC_B = doc({ id: 'd2', title: 'contract-v2.pdf', originalPath: '/u/contract-v2.pdf' })
const DOC_C = doc({ id: 'd3', title: 'unrelated.pdf', originalPath: '/u/unrelated.pdf' })

function comparisonDoc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return doc({
    id: 'd9',
    title: 'Comparison: contract-v1 vs contract-v2.md',
    originalPath: null,
    mimeType: 'text/markdown',
    origin: { type: 'compare', comparedFrom: ['d1', 'd2'] },
    ...over
  })
}

function task(over: Partial<DocTaskStatus> = {}): DocTaskStatus {
  return {
    jobId: 'j1',
    kind: 'compare',
    documentIds: ['d1', 'd2'],
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

describe('DocumentsScreen — Compare action (Phase 35)', () => {
  it('offers "Compare (2)" at EXACTLY two selections', async () => {
    const user = userEvent.setup()
    stubApi({ listDocuments: vi.fn(async () => [doc(), DOC_B, DOC_C]) })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('contract-v1.pdf')

    // The selection toolbar (§11.6) holds Compare; it is present whenever there is a
    // selection, but ENABLED only at exactly two.
    expect(screen.queryByRole('button', { name: /compare \(2\)/i })).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Select contract-v1.pdf for asking'))
    expect(screen.getByRole('button', { name: /compare \(2\)/i })).toBeDisabled()
    await user.click(screen.getByLabelText('Select contract-v2.pdf for asking'))
    expect(screen.getByRole('button', { name: /compare \(2\)/i })).toBeEnabled()
    await user.click(screen.getByLabelText('Select unrelated.pdf for asking'))
    expect(screen.getByRole('button', { name: /compare \(2\)/i })).toBeDisabled()
  })

  it('runs the busy flow on BOTH rows, then reveals the report with provenance and opens it', async () => {
    const user = userEvent.setup()
    let docs = [doc(), DOC_B]
    let status = task({ state: 'running', progress: { stepsDone: 1, stepsTotal: 4 } })
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    const previewDocument = vi.fn(async () => ({
      id: 'd9',
      title: 'Comparison: contract-v1 vs contract-v2.md',
      mimeType: 'text/markdown',
      segments: [{ text: 'What both documents share …', pageNumber: null, sectionLabel: null }]
    }))
    stubApi({
      listDocuments: vi.fn(async () => docs),
      startDocTask,
      getDocTask: vi.fn(async () => status),
      previewDocument
    })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('contract-v1.pdf')

    await user.click(screen.getByLabelText('Select contract-v1.pdf for asking'))
    await user.click(screen.getByLabelText('Select contract-v2.pdf for asking'))
    await user.click(screen.getByRole('button', { name: /compare \(2\)/i }))
    expect(startDocTask).toHaveBeenCalledWith({
      kind: 'compare',
      documentIds: ['d1', 'd2'],
      params: undefined
    })

    // Busy state with window progress on BOTH source rows + a cancel affordance.
    const busy = await screen.findAllByText(/Comparing…\s*\(1\/4\)/)
    expect(busy.length).toBe(2)
    expect(screen.getAllByRole('button', { name: /^cancel$/i }).length).toBeGreaterThanOrEqual(1)

    // The task finishes: the refreshed list reveals the report with its both-sources
    // provenance line, and the report's preview auto-opens.
    docs = [doc(), DOC_B, comparisonDoc()]
    status = task({
      state: 'done',
      progress: { stepsDone: 4, stepsTotal: 4 },
      resultRef: { documentId: 'd9' }
    })
    // The title appears on the new row AND in the auto-opened preview modal.
    expect(
      (
        await screen.findAllByText('Comparison: contract-v1 vs contract-v2.md', undefined, {
          timeout: 3000
        })
      ).length
    ).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/Comparison of/).length).toBeGreaterThanOrEqual(1)
    expect(previewDocument).toHaveBeenCalledWith('d9')
    expect(await screen.findByText(/What both documents share/)).toBeInTheDocument()
    expect(screen.queryByText(/Comparing…/)).not.toBeInTheDocument()
  })

  it('cancelling the busy comparison calls cancelDocTask', async () => {
    const user = userEvent.setup()
    const cancelDocTask = vi.fn(async () => {})
    stubApi({
      listDocuments: vi.fn(async () => [doc(), DOC_B]),
      startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
      getDocTask: vi.fn(async () => task({ state: 'running' })),
      cancelDocTask
    })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('contract-v1.pdf')
    await user.click(screen.getByLabelText('Select contract-v1.pdf for asking'))
    await user.click(screen.getByLabelText('Select contract-v2.pdf for asking'))
    await user.click(screen.getByRole('button', { name: /compare \(2\)/i }))
    await user.click((await screen.findAllByRole('button', { name: /^cancel$/i }))[0])
    expect(cancelDocTask).toHaveBeenCalled()
  })

  it('surfaces the friendly failure copy (e.g. the re-index-first guard)', async () => {
    const user = userEvent.setup()
    const reindexCopy =
      'These documents need a quick re-index before they can be compared — at least one was ' +
      'prepared with a different search model. Open the Documents screen and choose Re-index, ' +
      'then try again.'
    stubApi({
      listDocuments: vi.fn(async () => [doc(), DOC_B]),
      startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
      getDocTask: vi.fn(async () => task({ state: 'failed', error: reindexCopy }))
    })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('contract-v1.pdf')
    await user.click(screen.getByLabelText('Select contract-v1.pdf for asking'))
    await user.click(screen.getByLabelText('Select contract-v2.pdf for asking'))
    await user.click(screen.getByRole('button', { name: /compare \(2\)/i }))
    expect(
      await screen.findByText(/need a quick re-index/i, undefined, { timeout: 3000 })
    ).toBeInTheDocument()
  })

  it('shows the both-sources provenance line and Export on the materialized report', async () => {
    const user = userEvent.setup()
    const exportDocument = vi.fn(async () => 'C:/exported.md')
    stubApi({
      listDocuments: vi.fn(async () => [doc(), DOC_B, comparisonDoc()]),
      exportDocument
    })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('Comparison: contract-v1 vs contract-v2.md')
    expect(screen.getByText(/Comparison of/)).toBeInTheDocument()
    expect(screen.getByText('contract-v1.pdf', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText('contract-v2.pdf', { selector: 'b' })).toBeInTheDocument()
    // Export lives in the report's "⋯" overflow (§11.6).
    await user.click(screen.getByRole('button', { name: 'More actions for Comparison: contract-v1 vs contract-v2.md' }))
    await user.click(await screen.findByRole('menuitem', { name: /^export$/i }))
    expect(exportDocument).toHaveBeenCalledWith('d9')
  })

  it('falls back gracefully when a compared source was deleted', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [DOC_B, comparisonDoc()]) // d1 is gone
    })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('Comparison: contract-v1 vs contract-v2.md')
    expect(screen.getByText('a removed document')).toBeInTheDocument()
    expect(screen.getByText('contract-v2.pdf', { selector: 'b' })).toBeInTheDocument()
  })
})
