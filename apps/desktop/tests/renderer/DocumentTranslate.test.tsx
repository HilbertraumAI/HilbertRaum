// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { clearDocTaskSession } from '../../src/renderer/lib/doctasks'
import type { AppStatus, DocTaskStatus, DocumentInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { hangBudgetMs } from '../helpers/hang-budget'
import { appStatus as baseAppStatus } from '../helpers/status'

// Phase 34 renderer tests, reworked at TG-3 (translategemma plan D5/O2): the Translate row
// action now opens a SOURCE + TARGET select pair over the curated 10-language set
// (native-name labels), passes sourceLang in the startTask params, disables the primary
// button for a same-language pair, keeps the chosen pair across a modal reopen, and — when the
// translation model is not installed — disables the row item and offers the install deep
// link to the AI Model screen. The polling busy state ("Translating… (n/m)"), the
// new document with its provenance line, and Export are unchanged. The row Cancel and the
// failed-task banner are kind-agnostic (DocumentSummary 'cancelling the busy task…',
// DocumentsScreenPolish DR-7).

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
const appStatus = (over: Partial<AppStatus> = {}): AppStatus => baseAppStatus({ translationAvailable: true, ...over })

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

afterEach(() => {
  cleanup()
  clearDocTaskSession()
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
    // '日本語' / 'العربية' are issue-#31 widened languages — regression teeth that the pickers
    // really offer the full 51-code set, not just the original curated 10.
    for (const label of ['Deutsch', 'English', 'Français', 'Українська', '日本語', 'العربية']) {
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
    expect(await screen.findByText('contract (Deutsch).md', undefined, { timeout: hangBudgetMs(3000) })).toBeInTheDocument()
    expect(screen.getByText(/Translated from/)).toBeInTheDocument()
    expect(screen.queryByText(/Translating…/)).not.toBeInTheDocument()
  })

  it('disables Translate for a same-language pair and keeps the chosen pair across a modal reopen', async () => {
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

    // A distinct target re-enables; cancel + reopen keeps the chosen pair (the screen's modal state —
    // the session memory is written only when a translation starts, DOC-7).
    await user.selectOptions(screen.getByRole('combobox', { name: 'To' }), 'pl')
    expect(screen.getByRole('button', { name: /^translate$/i })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    await openTranslateModal(user)
    expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('pt')
    expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('pl')
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
    // #539: on the translation model itself, not the screen's default view.
    expect(onNavigate).toHaveBeenCalledWith('models:translation')
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

// ---- DOC-7: one language-pair memory across the two translate surfaces (#682) ----
//
// The modal and the Translate screen both open on `initialTranslateChoice`: the session's last pair,
// else the UI-language default. That memory is module-level and nothing resets it, so these rows
// render both screens from a FRESH module graph: one new `translateSession` the two share, empty when
// the row starts, and gone with it (it never reaches another row's modal).

describe('Documents modal ↔ Translate screen — one language-pair memory (DOC-7, #682)', () => {
  async function freshScreens() {
    vi.resetModules()
    const [{ DocumentsScreen: Docs }, { TranslateScreen: Translate }, doctasks] = await Promise.all([
      import('../../src/renderer/screens/DocumentsScreen'),
      import('../../src/renderer/screens/TranslateScreen'),
      import('../../src/renderer/lib/doctasks')
    ])
    // The fresh doc-task store's poll, which the file's afterEach (the static graph's clear) cannot reach.
    onTestFinished(() => doctasks.clearDocTaskSession())
    return { Docs, Translate }
  }

  /** What the two screens read on mount — with no translation of either kind to re-adopt. */
  const mountApi = () => ({
    getAppStatus: vi.fn(async () => appStatus()),
    listDocuments: vi.fn(async () => [doc()]),
    getActiveTranslateJob: vi.fn(async () => null),
    listActiveDocTasks: vi.fn(async () => [])
  })

  it('a pair started from the Documents modal is the pair the Translate screen opens on', async () => {
    const { Docs, Translate } = await freshScreens()
    const user = userEvent.setup()
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    stubApi({ ...mountApi(), startDocTask, getDocTask: vi.fn(async () => task()) })
    render(<Docs />)
    await screen.findByText('contract.pdf')
    await openTranslateModal(user)
    await chooseAndStart(user, 'fr', 'pl')
    await waitFor(() => expect(startDocTask).toHaveBeenCalled())
    cleanup() // the user moves on to the Translate screen

    render(<Translate onNavigate={() => {}} />)
    expect(await screen.findByRole('combobox', { name: 'From' })).toHaveValue('fr')
    expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('pl')
  })

  it('a pair translated on the Translate screen is the pair the Documents modal opens on', async () => {
    const { Docs, Translate } = await freshScreens()
    const user = userEvent.setup()
    const translateStart = vi.fn(() => new Promise<never>(() => {})) // the translation stays in flight
    stubApi({ ...mountApi(), translateStart })
    render(<Translate onNavigate={() => {}} />)
    await user.selectOptions(await screen.findByRole('combobox', { name: 'From' }), 'en')
    await user.selectOptions(screen.getByRole('combobox', { name: 'To' }), 'uk')
    await user.type(screen.getByLabelText('Text to translate'), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Translate' }))
    await waitFor(() =>
      expect(translateStart).toHaveBeenCalledWith(expect.objectContaining({ sourceLang: 'en', targetLang: 'uk' }))
    )
    cleanup() // the user moves on to Documents

    render(<Docs />)
    await screen.findByText('contract.pdf')
    await openTranslateModal(user)
    expect(screen.getByRole('combobox', { name: 'From' })).toHaveValue('en')
    expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('uk')
  })
})
