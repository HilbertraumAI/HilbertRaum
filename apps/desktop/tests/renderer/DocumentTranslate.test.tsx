// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import type { AppStatus, DocTaskStatus, DocumentInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 34 renderer tests, reworked at TG-3 (translategemma plan D5/O2): the Translate row
// action now opens a SOURCE + TARGET select pair over the curated 10-language set
// (native-name labels), passes sourceLang in the startTask params, disables the primary
// button for a same-language pair, remembers the session's last choice, and — when the
// translation model is not installed — disables the row item and offers the install deep
// link to the AI Model screen. The polling busy state ("Translating… (n/m)") + cancel, the
// new document with its provenance line, and Export are unchanged.

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
    origin: { type: 'translation', translatedFrom: 'd1', targetLang: 'de' },
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

/** An AppStatus stub with the translation sidecar available unless overridden. */
function appStatus(over: Partial<AppStatus> = {}): AppStatus {
  return { ocrAvailable: false, translationAvailable: true, ...over } as AppStatus
}

/** Open the per-row "⋯" overflow and click Translate (the modal opens). */
async function openTranslateModal(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'More actions for contract.pdf' }))
  await user.click(await screen.findByRole('menuitem', { name: /^translate$/i }))
  expect(await screen.findByText(/Translate "contract.pdf"/)).toBeInTheDocument()
}

/** Pick the pair in the modal's selects (by language CODE) and hit Translate. */
async function chooseAndStart(
  user: ReturnType<typeof userEvent.setup>,
  sourceLang: string,
  targetLang: string
): Promise<void> {
  await user.selectOptions(screen.getByRole('combobox', { name: 'From' }), sourceLang)
  await user.selectOptions(screen.getByRole('combobox', { name: 'To' }), targetLang)
  await user.click(screen.getByRole('button', { name: /^translate$/i }))
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

describe('DocumentsScreen — Translate action (Phase 34, TG-3 selects)', () => {
  it('offers source+target selects, runs the busy flow, then reveals the new document with provenance', async () => {
    const user = userEvent.setup()
    let docs = [doc()]
    let status = task({ state: 'running', progress: { stepsDone: 1, stepsTotal: 4 } })
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    const getDocTask = vi.fn(async () => status)
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      listDocuments: vi.fn(async () => docs),
      startDocTask,
      getDocTask
    })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    await openTranslateModal(user)

    // The selects carry NATIVE names for the widened set (untranslated by design).
    const target = screen.getByRole('combobox', { name: 'To' })
    for (const label of ['Deutsch', 'English', 'Français', 'Українська']) {
      expect(target).toContainHTML(label)
    }
    // sourceLang rides in the params — TranslateGemma needs an explicit source.
    await chooseAndStart(user, 'en', 'de')
    expect(startDocTask).toHaveBeenCalledWith({
      kind: 'translation',
      documentIds: ['d1'],
      params: { sourceLang: 'en', targetLang: 'de' }
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

  it('passes any curated pair (fr → uk) through the params', async () => {
    const user = userEvent.setup()
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      listDocuments: vi.fn(async () => [doc()]),
      startDocTask,
      getDocTask: vi.fn(async () => task())
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await openTranslateModal(user)
    await chooseAndStart(user, 'fr', 'uk')
    expect(startDocTask).toHaveBeenCalledWith({
      kind: 'translation',
      documentIds: ['d1'],
      params: { sourceLang: 'fr', targetLang: 'uk' }
    })
  })

  it('disables Translate for a same-language pair and remembers the last choice on reopen', async () => {
    const user = userEvent.setup()
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      listDocuments: vi.fn(async () => [doc()])
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await openTranslateModal(user)

    // Same language on both ends: the primary disables and the hint explains why.
    await user.selectOptions(screen.getByRole('combobox', { name: 'From' }), 'pt')
    await user.selectOptions(screen.getByRole('combobox', { name: 'To' }), 'pt')
    expect(screen.getByRole('button', { name: /^translate$/i })).toBeDisabled()
    expect(screen.getByText('Pick two different languages.')).toBeInTheDocument()

    // A distinct target re-enables; cancel + reopen keeps the chosen pair (session memory).
    await user.selectOptions(screen.getByRole('combobox', { name: 'To' }), 'pl')
    expect(screen.getByRole('button', { name: /^translate$/i })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    await openTranslateModal(user)
    expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('pt')
    expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('pl')
  })

  it('cancelling the busy translation calls cancelDocTask', async () => {
    const user = userEvent.setup()
    const cancelDocTask = vi.fn(async () => {})
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      listDocuments: vi.fn(async () => [doc()]),
      startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
      getDocTask: vi.fn(async () => task({ state: 'running' })),
      cancelDocTask
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await openTranslateModal(user)
    await chooseAndStart(user, 'de', 'en')
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }))
    expect(cancelDocTask).toHaveBeenCalled()
  })

  it('surfaces the friendly failure copy (e.g. password change in progress)', async () => {
    const user = userEvent.setup()
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
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
    await openTranslateModal(user)
    await chooseAndStart(user, 'de', 'en')
    expect(
      await screen.findByText(/password is being changed/i, undefined, { timeout: 3000 })
    ).toBeInTheDocument()
  })

  it('model missing: Translate disables and the install item deep-links to the AI Model screen', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    stubApi({
      getAppStatus: vi.fn(async () => appStatus({ translationAvailable: false })),
      listDocuments: vi.fn(async () => [doc()])
    })
    render(<DocumentsScreen onNavigate={onNavigate} />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: 'More actions for contract.pdf' }))
    // Wait for the async availability read to settle into the menu state.
    const translateItem = await screen.findByRole('menuitem', { name: /^translate$/i })
    await waitFor(() => expect(translateItem).toHaveAttribute('aria-disabled', 'true'))
    // The friendly path: a sibling item that jumps to the AI Model screen.
    await user.click(screen.getByRole('menuitem', { name: /get the translation model/i }))
    expect(onNavigate).toHaveBeenCalledWith('models')
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
    // Export lives in the generated doc's "⋯" overflow (§11.6); the source doc's overflow has none.
    await user.click(screen.getByRole('button', { name: 'More actions for contract.pdf' }))
    expect(screen.queryByRole('menuitem', { name: /^export$/i })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'More actions for contract (Deutsch).md' }))
    const exportItem = await screen.findByRole('menuitem', { name: /^export$/i })
    await user.click(exportItem)
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

  it('renders the provenance label from the NEW structured GeneratedProvenance shape (Phase D)', async () => {
    // A row written by Phase-D generation: GeneratedProvenance (kind + sourceDocumentIds),
    // not the legacy translatedFrom shape. The label resolves the same way.
    const structured = translatedDoc({
      origin: {
        kind: 'translation',
        sourceDocumentIds: ['d1'],
        modelId: 'scripted-model',
        createdAt: '2026-06-14T00:00:00.000Z'
      }
    })
    stubApi({ listDocuments: vi.fn(async () => [doc(), structured]) })
    render(<DocumentsScreen />)
    await screen.findByText('contract (Deutsch).md')
    expect(screen.getByText(/Translated from/)).toBeInTheDocument()
    expect(screen.getByText('contract.pdf', { selector: 'b' })).toBeInTheDocument()
  })
})
