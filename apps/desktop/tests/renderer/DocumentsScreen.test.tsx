// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  DocumentsScreen,
  friendlyMimeLabel,
  isRetryableFailure,
  RAIL_COLLAPSED_KEY,
  VIEWS_MORE_KEY
} from '../../src/renderer/screens/DocumentsScreen'
import { t as translate } from '../../src/shared/i18n'
import type { Collection, DocumentInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Renderer test (jsdom + RTL) for the Documents screen: list rendering + status, the
// stale-embedding re-index banner (M7), the failed-document error, the empty state, and
// the delete action's refresh.

function doc(over: Partial<DocumentInfo>): DocumentInfo {
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

function coll(over: Partial<Collection>): Collection {
  return {
    id: 'c1',
    name: 'Project',
    type: 'project',
    description: null,
    builtin: false,
    color: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    ...over
  }
}

afterEach(cleanup)

// ---- Document organization: section rail + chips + project management (plan §12) ----
describe('DocumentsScreen — organization', () => {
  it('renders the section rail and filters the list by the selected project', async () => {
    const user = userEvent.setup()
    const library = coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })
    const tax = coll({ id: 'tax', name: 'Tax 2025' })
    stubApi({
      listCollections: vi.fn(async () => [library, tax]),
      listDocuments: vi.fn(async () => [
        doc({ id: 'd1', title: 'policy.pdf', collections: [{ id: 'lib', name: 'Library', type: 'library', role: 'source' }] }),
        doc({ id: 'd2', title: 'return.pdf', collections: [{ id: 'tax', name: 'Tax 2025', type: 'project', role: 'source' }] })
      ])
    })
    render(<DocumentsScreen />)
    // Rail sections are present.
    expect(await screen.findByRole('button', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tax 2025' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generated' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archived' })).toBeInTheDocument()
    // Both docs show under "All documents" (default section).
    expect(screen.getByText('policy.pdf')).toBeInTheDocument()
    expect(screen.getByText('return.pdf')).toBeInTheDocument()
    // Selecting the project filters to its member.
    await user.click(screen.getByRole('button', { name: 'Tax 2025' }))
    expect(screen.getByText('return.pdf')).toBeInTheDocument()
    expect(screen.queryByText('policy.pdf')).not.toBeInTheDocument()
  })

  it('creates a project from the rail "+" and selects it', async () => {
    const user = userEvent.setup()
    const library = coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })
    const created = coll({ id: 'new', name: 'Lawsuit' })
    const createCollection = vi.fn(async () => created)
    const listCollections = vi
      .fn<() => Promise<Collection[]>>()
      .mockResolvedValueOnce([library])
      .mockResolvedValue([library, created])
    stubApi({ listCollections, listDocuments: vi.fn(async () => [doc({})]), createCollection })
    render(<DocumentsScreen />)
    await user.click(await screen.findByRole('button', { name: 'New project' }))
    await user.type(await screen.findByLabelText('Project name'), 'Lawsuit')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createCollection).toHaveBeenCalledWith('Lawsuit'))
  })

  it('shows collection chips on a document row', async () => {
    stubApi({
      listCollections: vi.fn(async () => [coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })]),
      listDocuments: vi.fn(async () => [
        doc({ collections: [{ id: 'lib', name: 'Library', type: 'library', role: 'source' }] })
      ])
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    // The Library membership renders as a chip (localized by type).
    expect(screen.getAllByText('Library').length).toBeGreaterThan(0)
  })

  // ---- Phase E: smart views + generated-staleness badge (plan §7.6/§12.1/§15.3) ------

  it('renders the smart-view rail entries and filters by the selected view', async () => {
    const user = userEvent.setup()
    const library = coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })
    const tax = coll({ id: 'tax', name: 'Tax 2025' })
    stubApi({
      listCollections: vi.fn(async () => [library, tax]),
      listDocuments: vi.fn(async () => [
        doc({ id: 'd1', title: 'libonly.pdf', collections: [{ id: 'lib', name: 'Library', type: 'library', role: 'source' }] }),
        doc({ id: 'd2', title: 'filed.pdf', collections: [{ id: 'tax', name: 'Tax 2025', type: 'project', role: 'source' }] }),
        doc({ id: 'd3', title: 'broken.xyz', status: 'failed', errorMessage: 'Unsupported file type: .xyz', chunkCount: 0 })
      ])
    })
    render(<DocumentsScreen />)

    // "Failed imports" is a rare diagnostic view folded behind the Views "More" disclosure (§11.6).
    await screen.findByRole('button', { name: 'Library' })
    expect(screen.queryByRole('button', { name: 'Failed imports' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More' }))
    // Failed imports → only the failed doc.
    await user.click(await screen.findByRole('button', { name: 'Failed imports' }))
    expect(screen.getByText('broken.xyz')).toBeInTheDocument()
    expect(screen.queryByText('libonly.pdf')).not.toBeInTheDocument()
    expect(screen.queryByText('filed.pdf')).not.toBeInTheDocument()

    // Unfiled is a common view, always visible (no "More" needed) → the Library-only doc,
    // never the project-filed one (Library isn't "filed").
    await user.click(screen.getByRole('button', { name: 'Unfiled' }))
    expect(screen.getByText('libonly.pdf')).toBeInTheDocument()
    expect(screen.queryByText('filed.pdf')).not.toBeInTheDocument()
  })

  it('shows a quiet staleness badge on a generated row whose source changed, but not a fresh one', async () => {
    const user = userEvent.setup()
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [
        // Source re-indexed (updatedAt) AFTER the translation was made → stale.
        doc({ id: 's1', title: 'report.pdf', updatedAt: '2026-05-01T00:00:00Z' }),
        doc({
          id: 'staleGen',
          title: 'report.de.md',
          origin: { kind: 'translation', sourceDocumentIds: ['s1'], createdAt: '2026-01-01T00:00:00Z' }
        }),
        // Source untouched since the output was made → fresh.
        doc({ id: 's2', title: 'memo.pdf', updatedAt: '2026-01-01T00:00:00Z' }),
        doc({
          id: 'freshGen',
          title: 'memo.de.md',
          origin: { kind: 'translation', sourceDocumentIds: ['s2'], createdAt: '2026-02-01T00:00:00Z' }
        })
      ])
    })
    render(<DocumentsScreen />)

    // In the Generated view both generated docs show; exactly one is flagged stale.
    await user.click(await screen.findByRole('button', { name: 'Generated' }))
    expect(screen.getByText('report.de.md')).toBeInTheDocument()
    expect(screen.getByText('memo.de.md')).toBeInTheDocument()
    expect(screen.getAllByText('Outdated')).toHaveLength(1)
    expect(screen.getByText(/re-run to update/i)).toBeInTheDocument()
  })

  // ---- Phase C: Temporary lifecycle actions (plan §14.1) ----------------------------
  function tempStubs(extra: Record<string, unknown> = {}): {
    addToCollection: ReturnType<typeof vi.fn>
    setDocumentLifecycle: ReturnType<typeof vi.fn>
    removeFromCollection: ReturnType<typeof vi.fn>
  } {
    const library = coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })
    const temp = coll({ id: 'temp', name: 'Temporary', type: 'temporary', builtin: true })
    const tax = coll({ id: 'tax', name: 'Tax 2025' })
    const addToCollection = vi.fn(async () => {})
    const setDocumentLifecycle = vi.fn(async () => [])
    const removeFromCollection = vi.fn(async () => {})
    stubApi({
      listCollections: vi.fn(async () => [library, temp, tax]),
      listDocuments: vi.fn(async () => [
        doc({
          id: 'd1',
          title: 'invoice.pdf',
          lifecycle: 'temporary',
          collections: [{ id: 'temp', name: 'Temporary', type: 'temporary', role: 'source' }]
        })
      ]),
      addToCollection,
      setDocumentLifecycle,
      removeFromCollection,
      ...extra
    })
    return { addToCollection, setDocumentLifecycle, removeFromCollection }
  }

  it('"Keep in Library" adds Library, sets permanent, and drops Temporary', async () => {
    const user = userEvent.setup()
    const { addToCollection, setDocumentLifecycle, removeFromCollection } = tempStubs()
    render(<DocumentsScreen />)
    await screen.findByText('invoice.pdf')
    // Organize actions now live in the per-row "⋯" overflow (§11.6).
    await user.click(screen.getByRole('button', { name: 'More actions for invoice.pdf' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Keep in Library' }))
    await waitFor(() => expect(addToCollection).toHaveBeenCalledWith(['d1'], 'lib'))
    expect(setDocumentLifecycle).toHaveBeenCalledWith(['d1'], 'permanent')
    expect(removeFromCollection).toHaveBeenCalledWith(['d1'], 'temp')
  })

  it('"Move to project" on a Temporary doc adds the project, sets permanent, and drops Temporary', async () => {
    const user = userEvent.setup()
    const { addToCollection, setDocumentLifecycle, removeFromCollection } = tempStubs()
    render(<DocumentsScreen />)
    await screen.findByText('invoice.pdf')
    await user.click(screen.getByRole('button', { name: 'More actions for invoice.pdf' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Move to project…' }))
    await user.click(await screen.findByRole('button', { name: 'Tax 2025' }))
    await waitFor(() => expect(addToCollection).toHaveBeenCalledWith(['d1'], 'tax'))
    expect(setDocumentLifecycle).toHaveBeenCalledWith(['d1'], 'permanent')
    expect(removeFromCollection).toHaveBeenCalledWith(['d1'], 'temp')
  })

  // ---- Suggested-project feature REMOVED: no suggestion UI must remain (the IPC is gone from
  //      the preload Api type, so a `filingSuggestions` stub would not even typecheck) --------
  it('renders no project-suggestion chip on an unfiled doc that a rule would have matched', async () => {
    stubApi({
      listCollections: vi.fn(async () => [coll({ id: 'tax', name: 'Tax 2025' })]),
      // An unfiled doc whose folder label a folder-name rule WOULD have matched, to be sure
      // nothing surfaces.
      listDocuments: vi.fn(async () => [doc({ id: 'd1', title: 'return.pdf', sourceFolderLabel: 'Tax 2025' })])
    })
    render(<DocumentsScreen />)
    await screen.findByText('return.pdf')
    // No suggestion chip, no Apply/Dismiss affordance.
    expect(screen.queryByText(/suggested project|suggested new project/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^apply$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^dismiss$/i })).not.toBeInTheDocument()
  })
})

describe('DocumentsScreen', () => {
  it('lists documents with their status and chunk count', async () => {
    stubApi({ listDocuments: vi.fn(async () => [doc({})]) })
    render(<DocumentsScreen />)
    expect(await screen.findByText('contract.pdf')).toBeInTheDocument()
    // Status reads as a Badge (icon + word), never a button (Task 2).
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ready' })).not.toBeInTheDocument()
    // The muted meta strip shows the friendly type, size, and section count (Task 5).
    expect(screen.getByText('PDF · 2.0 KB · 7 sections')).toBeInTheDocument()
    // The raw MIME type is never shown.
    expect(screen.queryByText('application/pdf')).not.toBeInTheDocument()
  })

  it('shows the re-index banner for a document with stale embeddings (M7)', async () => {
    stubApi({ listDocuments: vi.fn(async () => [doc({ staleEmbeddings: true })]) })
    render(<DocumentsScreen />)
    expect(await screen.findByText(/different search model/i)).toBeInTheDocument()
  })

  it('does NOT show the re-index banner when embeddings are current', async () => {
    stubApi({ listDocuments: vi.fn(async () => [doc({ staleEmbeddings: false })]) })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    expect(screen.queryByText(/different search model/i)).not.toBeInTheDocument()
  })

  it('surfaces a localized, softened error for a failed import; offers Remove not Preview (Task B/C)', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [
        // The legacy raw literal is still recognized by the display map and re-rendered as the
        // friendly copy (no raw English leak), keeping the offending extension.
        doc({ status: 'failed', errorMessage: 'Unsupported file type: .xyz', chunkCount: 0 })
      ])
    })
    render(<DocumentsScreen />)
    // Softened §7 copy — the raw "Unsupported file type" phrasing is gone, the extension shows.
    expect(await screen.findByText(/isn't supported/i)).toBeInTheDocument()
    expect(screen.getByText(/\.xyz/)).toBeInTheDocument()
    expect(screen.queryByText(/Unsupported file type/i)).not.toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    // Failed rows expose Remove, never Preview/overflow; an unsupported type is NOT retryable.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument()
  })

  it('offers Try again + Remove on a RETRYABLE failure; Remove clears it via the delete handler (Task C)', async () => {
    const user = userEvent.setup()
    const listDocuments = vi
      .fn<() => Promise<DocumentInfo[]>>()
      .mockResolvedValueOnce([
        doc({ id: 'd9', title: 'broken.pdf', status: 'failed', errorMessage: 'EIO: i/o error, read', chunkCount: 0 })
      ])
      .mockResolvedValue([]) // after remove
    const deleteDocument = vi.fn(async () => {})
    stubApi({ listDocuments, deleteDocument })
    render(<DocumentsScreen />)
    await screen.findByText('broken.pdf')
    // A transient read error IS retryable → Try again offered alongside Remove; never Preview.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('d9'))
  })

  it('isRetryableFailure: intrinsic failures are not retryable, transient ones are', () => {
    // Unsupported type (current + legacy wording) and size-cap failures are intrinsic → no retry.
    expect(isRetryableFailure(translate('en', 'main.ingest.unsupportedType', { ext: '.xyz' }))).toBe(false)
    expect(isRetryableFailure('Unsupported file type: .heic')).toBe(false)
    expect(isRetryableFailure(translate('en', 'main.ingest.fileTooLarge'))).toBe(false)
    expect(isRetryableFailure(translate('en', 'main.ingest.tooManyChunks'))).toBe(false)
    // A read/parse error or an unknown cause → retryable.
    expect(isRetryableFailure('EIO: i/o error, read')).toBe(true)
    expect(isRetryableFailure(null)).toBe(true)
  })

  it('renders the empty state when there are no documents', async () => {
    stubApi({ listDocuments: vi.fn(async () => []) })
    render(<DocumentsScreen />)
    expect(await screen.findByText(/No documents yet/i)).toBeInTheDocument()
  })

  it('deletes a document after the ConfirmDialog confirms, and refreshes the list', async () => {
    const user = userEvent.setup()
    const listDocuments = vi
      .fn<() => Promise<DocumentInfo[]>>()
      .mockResolvedValueOnce([doc({})]) // initial mount
      .mockResolvedValue([]) // after delete
    const deleteDocument = vi.fn(async () => {})
    stubApi({ listDocuments, deleteDocument })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    // Delete is a destructive item inside the per-row "⋯" overflow (§11.6), and still goes
    // through a ConfirmDialog (Phase 24) — never an equal-weight surface button.
    await user.click(screen.getByRole('button', { name: 'More actions for contract.pdf' }))
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
    expect(deleteDocument).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/Delete "contract.pdf"\?/)
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }))

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('d1'))
    await waitFor(() => expect(screen.queryByText('contract.pdf')).not.toBeInTheDocument())
  })

  it('does not delete when the ConfirmDialog is cancelled', async () => {
    const user = userEvent.setup()
    const deleteDocument = vi.fn(async () => {})
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), deleteDocument })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: 'More actions for contract.pdf' }))
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deleteDocument).not.toHaveBeenCalled()
    expect(screen.getByText('contract.pdf')).toBeInTheDocument()
  })

  it('opens the read-only preview modal with the extracted text and closes it', async () => {
    const user = userEvent.setup()
    const previewDocument = vi.fn(async () => ({
      id: 'd1',
      title: 'contract.pdf',
      mimeType: 'application/pdf',
      segments: [
        { text: 'Clause 7: severance terms apply.', pageNumber: 3, sectionLabel: null },
        { text: 'Appendix text.', pageNumber: null, sectionLabel: 'Appendix' }
      ]
    }))
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), previewDocument })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /preview/i }))

    expect(previewDocument).toHaveBeenCalledWith('d1')
    expect(await screen.findByText(/Clause 7: severance terms apply/)).toBeInTheDocument()
    expect(screen.getByText('Page 3')).toBeInTheDocument()
    expect(screen.getByText('Appendix')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('paginates the preview: reveals the next page on "Show more" (FE-6)', async () => {
    const user = userEvent.setup()
    // First page carries a cursor (nextOffset) + the true total; page 2 exhausts it.
    const previewDocument = vi.fn(async () => ({
      id: 'd1',
      title: 'contract.pdf',
      mimeType: 'application/pdf',
      segments: [{ text: 'First page clause.', pageNumber: 1, sectionLabel: null }],
      totalSegments: 2,
      nextOffset: 1
    }))
    const previewDocumentPage = vi.fn(async () => ({
      id: 'd1',
      title: 'contract.pdf',
      mimeType: 'application/pdf',
      segments: [{ text: 'Second page clause.', pageNumber: 2, sectionLabel: null }],
      totalSegments: 2,
      nextOffset: null
    }))
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), previewDocument, previewDocumentPage })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /preview/i }))

    expect(await screen.findByText(/First page clause/)).toBeInTheDocument()
    // The second page is NOT mounted yet — that's the whole point of FE-6.
    expect(screen.queryByText(/Second page clause/)).not.toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show more/i }))

    expect(previewDocumentPage).toHaveBeenCalledWith('d1', 1, 50)
    expect(await screen.findByText(/Second page clause/)).toBeInTheDocument()
    // The first page stays mounted (accumulated), and the exhausted cursor hides the button.
    expect(screen.getByText(/First page clause/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument()
  })

  it('surfaces a preview failure as the screen error', async () => {
    const user = userEvent.setup()
    stubApi({
      listDocuments: vi.fn(async () => [doc({})]),
      previewDocument: vi.fn(async () => {
        throw new Error('The document file is no longer on disk. Re-import it to preview.')
      })
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /preview/i }))
    expect(await screen.findByText(/no longer on disk/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // ---- "Ask these documents" + Re-index all (Phase 17) ---------------------------

  it('selecting indexed documents enables "Ask these documents" with the selected ids', async () => {
    const user = userEvent.setup()
    const onAskSelected = vi.fn()
    stubApi({
      listDocuments: vi.fn(async () => [
        doc({}),
        doc({ id: 'd2', title: 'terms.docx' }),
        doc({ id: 'd3', title: 'broken.xyz', status: 'failed', chunkCount: 0 })
      ])
    })
    render(<DocumentsScreen onAskSelected={onAskSelected} />)
    await screen.findByText('contract.pdf')

    // Failed documents get no checkbox; nothing selected → no Ask button yet.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /ask these documents/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /select contract.pdf/i }))
    await user.click(screen.getByRole('checkbox', { name: /select terms.docx/i }))
    await user.click(screen.getByRole('button', { name: /ask these documents \(2\)/i }))
    expect(onAskSelected).toHaveBeenCalledWith(expect.arrayContaining(['d1', 'd2']))
  })

  // ---- Audio (Phase 36): formats line, Transcribing badge, D35 size confirm ------

  it('advertises the verified audio formats on the Supported line', async () => {
    stubApi({ listDocuments: vi.fn(async () => []) })
    render(<DocumentsScreen />)
    expect(await screen.findByText(/WAV, MP3, FLAC,\s*OGG/)).toBeInTheDocument()
  })

  it('shows "Transcribing…" with the percent for an audio document being read', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [
        doc({
          title: 'meeting.mp3',
          mimeType: 'audio/mpeg',
          status: 'extracting',
          transcriptionProgress: 42,
          chunkCount: 0
        })
      ])
    })
    render(<DocumentsScreen />)
    expect(await screen.findByText(/Transcribing… 42%/)).toBeInTheDocument()
    // A TEXT document in `extracting` keeps the plain "Reading" label.
    cleanup()
    stubApi({ listDocuments: vi.fn(async () => [doc({ status: 'extracting', chunkCount: 0 })]) })
    render(<DocumentsScreen />)
    expect(await screen.findByText('Reading')).toBeInTheDocument()
  })

  it('asks before importing large audio (D35) and imports only on confirm', async () => {
    const user = userEvent.setup()
    const importDocuments = vi.fn(async () => ({ jobId: 'j1', documentIds: ['d9'] }))
    stubApi({
      listDocuments: vi.fn(async () => [doc({})]),
      pickDocuments: vi.fn(async () => ({ token: 'tok1', paths: ['/u/long-meeting.wav'] })),
      importPreflight: vi.fn(async () => ({
        fileCount: 1,
        audioFileCount: 1,
        audioBytes: 600 * 1024 * 1024
      })),
      importDocuments,
      getImportJob: vi.fn(async () => ({ jobId: 'j1', total: 1, completed: 1, failed: 0, done: true }))
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')

    await user.click(screen.getByRole('button', { name: /import files/i }))
    // The confirm came up FIRST — nothing imported yet.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/Import large audio\?/)
    expect(dialog).toHaveTextContent(/600\.0 MB/)
    expect(importDocuments).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: /import and transcribe/i }))
    // D1: the picker capability token is carried through the confirm dialog into the import.
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/u/long-meeting.wav'], { pickerToken: 'tok1' })
    )
  })

  it('cancelling the large-audio confirm imports nothing', async () => {
    const user = userEvent.setup()
    const importDocuments = vi.fn(async () => ({ jobId: 'j1', documentIds: [] }))
    stubApi({
      listDocuments: vi.fn(async () => [doc({})]),
      pickDocuments: vi.fn(async () => ({ token: 'tok1', paths: ['/u/long-meeting.wav'] })),
      importPreflight: vi.fn(async () => ({
        fileCount: 1,
        audioFileCount: 1,
        audioBytes: 600 * 1024 * 1024
      })),
      importDocuments
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /import files/i }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importDocuments).not.toHaveBeenCalled()
  })

  it('small/text selections import directly with no confirm', async () => {
    const user = userEvent.setup()
    const importDocuments = vi.fn(async () => ({ jobId: 'j1', documentIds: ['d9'] }))
    stubApi({
      listDocuments: vi.fn(async () => [doc({})]),
      pickDocuments: vi.fn(async () => ({ token: 'tok2', paths: ['/u/note.txt'] })),
      importPreflight: vi.fn(async () => ({ fileCount: 1, audioFileCount: 0, audioBytes: 0 })),
      importDocuments,
      getImportJob: vi.fn(async () => ({ jobId: 'j1', total: 1, completed: 1, failed: 0, done: true }))
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /import files/i }))
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['/u/note.txt'], { pickerToken: 'tok2' })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Re-index all" confirms first, then re-indexes every stale document (M-U6)', async () => {
    const user = userEvent.setup()
    const stale = [
      doc({ id: 'd1', staleEmbeddings: true }),
      doc({ id: 'd2', title: 'terms.docx', staleEmbeddings: true })
    ]
    const listDocuments = vi
      .fn<() => Promise<DocumentInfo[]>>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(stale.map((d) => ({ ...d, staleEmbeddings: false })))
    const reindexDocument = vi.fn(async (id: string) => doc({ id, staleEmbeddings: false }))
    stubApi({ listDocuments, reindexDocument })
    render(<DocumentsScreen />)

    // The toolbar button opens a ConfirmDialog — nothing runs until it is confirmed (M-U6).
    await user.click(await screen.findByRole('button', { name: /re-index all \(2\)/i }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/re-index 2 documents\?/i)).toBeInTheDocument()
    expect(reindexDocument).not.toHaveBeenCalled()

    await user.click(dialog.getByRole('button', { name: /^re-index all$/i }))
    await waitFor(() => expect(reindexDocument).toHaveBeenCalledTimes(2))
    expect(reindexDocument).toHaveBeenCalledWith('d1')
    expect(reindexDocument).toHaveBeenCalledWith('d2')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /re-index all/i })).not.toBeInTheDocument()
    )
  })

  // ---- FE-7: poll job status only during import; refresh the list on a transition -------
  it('during import polls getImportJob each tick but refreshes the full list only on a file completion', async () => {
    vi.useFakeTimers()
    try {
      // fireEvent + advanceTimersByTimeAsync only — NO userEvent here (userEvent's internal real
      // delays fight fake timers and can hang, leaking fake timers into the rest of the file).
      const listDocuments = vi.fn(async () => [doc({})])
      let completed = 0
      const getImportJob = vi.fn(async () => ({
        jobId: 'j1',
        total: 2,
        completed,
        failed: 0,
        done: completed >= 2
      }))
      stubApi({
        listDocuments,
        pickDocuments: vi.fn(async () => ({ token: 'tok3', paths: ['/u/a.pdf', '/u/b.pdf'] })),
        importPreflight: vi.fn(async () => ({ fileCount: 2, audioFileCount: 0, audioBytes: 0 })),
        importDocuments: vi.fn(async () => ({ jobId: 'j1', documentIds: ['d1', 'd2'] })),
        getImportJob
      })
      const flush = async (): Promise<void> => {
        await act(async () => {
          for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
        })
      }
      render(<DocumentsScreen />)
      await flush() // mount refresh + ocr status
      // Start the import (synchronous click; the async pick → preflight → import → watchJob chain
      // is flushed below).
      fireEvent.click(screen.getByRole('button', { name: /import files/i }))
      await flush()
      const listAfterStart = listDocuments.mock.calls.length
      const jobAfterStart = getImportJob.mock.calls.length

      // Three ticks with NO new completion: getImportJob keeps polling, but the heavy
      // listDocuments refresh runs only once (the first tick's -1 → 0 transition), not per tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200)
      })
      expect(getImportJob.mock.calls.length).toBeGreaterThanOrEqual(jobAfterStart + 3)
      expect(listDocuments.mock.calls.length).toBe(listAfterStart + 1)

      // A file finishes (completed 0 → 2): the next tick transitions, so the list refreshes again
      // and, being done, the poll stops.
      completed = 2
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(listDocuments.mock.calls.length).toBe(listAfterStart + 2)
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- FE-4: a late import-poll tick after unmount must not refresh the list ----------
  it('drops an in-flight import-poll tick after unmount — no list refresh on a dead component', async () => {
    vi.useFakeTimers()
    try {
      const listDocuments = vi.fn(async () => [doc({})])
      // getImportJob parks on its FIRST poll call: it hands back a promise we resolve BY HAND, so
      // the tick goes in-flight, straddles the unmount, and THEN resolves with a transition
      // (completed -1 → 2) that would normally trigger refresh() — exercising the post-await guard.
      type Job = { jobId: string; total: number; completed: number; failed: number; done: boolean }
      let release: (() => void) | null = null
      const getImportJob = vi.fn(
        (): Promise<Job> =>
          new Promise<Job>((res) => {
            release = () => res({ jobId: 'j1', total: 2, completed: 2, failed: 0, done: false })
          })
      )
      stubApi({
        listDocuments,
        pickDocuments: vi.fn(async () => ({ token: 't', paths: ['/u/a.pdf', '/u/b.pdf'] })),
        importPreflight: vi.fn(async () => ({ fileCount: 2, audioFileCount: 0, audioBytes: 0 })),
        importDocuments: vi.fn(async () => ({ jobId: 'j1', documentIds: ['d1', 'd2'] })),
        getImportJob
      })
      const flush = async (): Promise<void> => {
        await act(async () => {
          for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
        })
      }
      const { unmount } = render(<DocumentsScreen />)
      await flush() // mount refresh
      fireEvent.click(screen.getByRole('button', { name: /import files/i }))
      await flush() // pick → preflight → import → watchJob armed (no tick yet)

      // Fire the first poll tick → getImportJob parks mid-await (in-flight).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(release).not.toBeNull()
      const listBefore = listDocuments.mock.calls.length

      // Unmount mid-poll (clears the interval), THEN resolve the parked tick. The post-await guard
      // drops it: no extra listDocuments refresh on the dead component (teeth: without the guard the
      // -1 → 2 transition would call refresh() → listDocuments again).
      unmount()
      await act(async () => {
        release!()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(listDocuments.mock.calls.length).toBe(listBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('"Re-index all" can be cancelled without running anything (M-U6)', async () => {
    const user = userEvent.setup()
    const stale = [
      doc({ id: 'd1', staleEmbeddings: true }),
      doc({ id: 'd2', title: 'terms.docx', staleEmbeddings: true })
    ]
    const reindexDocument = vi.fn(async (id: string) => doc({ id, staleEmbeddings: false }))
    stubApi({ listDocuments: vi.fn(async () => stale), reindexDocument })
    render(<DocumentsScreen />)

    await user.click(await screen.findByRole('button', { name: /re-index all \(2\)/i }))
    const dialog = within(await screen.findByRole('dialog'))
    await user.click(dialog.getByRole('button', { name: /cancel/i }))
    expect(reindexDocument).not.toHaveBeenCalled()
  })
})

// ---- §11.6 refinement: action overflow, MIME→label, selection toolbar, status badges ----
describe('DocumentsScreen — action overflow + selection toolbar (§11.6)', () => {
  it('friendlyMimeLabel maps known MIME types to friendly labels', () => {
    expect(friendlyMimeLabel('application/pdf')).toBe('PDF')
    expect(friendlyMimeLabel('text/markdown')).toBe('Markdown')
    expect(friendlyMimeLabel('text/csv')).toBe('CSV')
    expect(friendlyMimeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Word')
    expect(friendlyMimeLabel('audio/mpeg')).toBe('MP3')
    expect(friendlyMimeLabel('image/png')).toBe('PNG')
    expect(friendlyMimeLabel('audio/aac')).toBe('Audio')
    expect(friendlyMimeLabel('application/zip')).toBe('ZIP')
    expect(friendlyMimeLabel(null)).toBe('—')
  })

  it('the "⋯" overflow exposes Summarize/Translate/Re-index/Build deep index/Add to project + a destructive Delete that opens ConfirmDialog', async () => {
    const user = userEvent.setup()
    stubApi({
      listCollections: vi.fn(async () => [coll({ id: 'tax', name: 'Tax 2025' })]),
      listDocuments: vi.fn(async () => [doc({ fullyChunked: true, treeStatus: null })])
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    // Only ONE inline action (Preview) sits on the row; everything else is behind "⋯".
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^summarize$/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'More actions for contract.pdf' }))
    expect(await screen.findByRole('menuitem', { name: 'Summarize' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Translate' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Re-index' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Build deep index' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Move to project…' })).toBeInTheDocument()

    const del = screen.getByRole('menuitem', { name: /delete/i })
    expect(del).toBeInTheDocument()
    await user.click(del)
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Delete "contract.pdf"\?/)
  })

  it('the selection toolbar appears only on selection and its bulk Delete confirms then deletes', async () => {
    const user = userEvent.setup()
    const listDocuments = vi
      .fn<() => Promise<DocumentInfo[]>>()
      .mockResolvedValueOnce([doc({ id: 'd1' }), doc({ id: 'd2', title: 'terms.docx' })])
      .mockResolvedValue([doc({ id: 'd2', title: 'terms.docx' })])
    const deleteDocument = vi.fn(async () => {})
    stubApi({ listDocuments, deleteDocument })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('contract.pdf')

    expect(
      screen.queryByRole('group', { name: /actions for the selected documents/i })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /select contract.pdf/i }))
    const bar = await screen.findByRole('group', { name: /actions for the selected documents/i })
    expect(within(bar).getByText('1 selected')).toBeInTheDocument()

    await user.click(within(bar).getByRole('button', { name: /^delete$/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/Delete 1 document\?/)
    expect(deleteDocument).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('d1'))
  })

  it('Compare in the selection toolbar is enabled ONLY at exactly two selections', async () => {
    const user = userEvent.setup()
    stubApi({
      listDocuments: vi.fn(async () => [
        doc({ id: 'd1' }),
        doc({ id: 'd2', title: 'terms.docx' }),
        doc({ id: 'd3', title: 'memo.pdf' })
      ])
    })
    render(<DocumentsScreen onAskSelected={() => {}} />)
    await screen.findByText('contract.pdf')

    await user.click(screen.getByRole('checkbox', { name: /select contract.pdf/i }))
    expect(screen.getByRole('button', { name: /compare \(2\)/i })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /select terms.docx/i }))
    expect(screen.getByRole('button', { name: /compare \(2\)/i })).toBeEnabled()
    await user.click(screen.getByRole('checkbox', { name: /select memo.pdf/i }))
    expect(screen.getByRole('button', { name: /compare \(2\)/i })).toBeDisabled()
  })

  it('a ready deep index reads as the "Deeply indexed" badge (not a button), and Build is gone from the overflow', async () => {
    const user = userEvent.setup()
    stubApi({ listDocuments: vi.fn(async () => [doc({ fullyChunked: true, treeStatus: 'ready' })]) })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    expect(screen.getByText('Deeply indexed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deeply indexed' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions for contract.pdf' }))
    await screen.findByRole('menuitem', { name: 'Summarize' })
    expect(screen.queryByRole('menuitem', { name: 'Build deep index' })).not.toBeInTheDocument()
  })

  // ---- §11.6 follow-up refinement: reading column, right-aligned cluster, quiet chips,
  //      one-green status hierarchy, keyboard-reachable "⋯" ----------------------------------

  it('lays the row out as a flex-filling name column + a right-aligned trailing cluster', async () => {
    const summary = { text: 's', modelId: 'm', createdAt: '2026-01-01T00:00:00Z', truncated: false }
    stubApi({
      listCollections: vi.fn(async () => [coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })]),
      listDocuments: vi.fn(async () => [
        doc({
          fullyChunked: true,
          treeStatus: 'ready',
          summary,
          collections: [{ id: 'lib', name: 'Library', type: 'library', role: 'source' }]
        })
      ])
    })
    const { container } = render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')

    // The name column fills the flex space and the title line ellipsizes only on overflow.
    const main = container.querySelector('.doc-row-main')
    expect(main).toBeInTheDocument()
    const title = container.querySelector('.doc-row-title')
    expect(title).toHaveTextContent('contract.pdf')

    // One right-aligned trailing cluster holds chips, badges, then the actions — in that order.
    const trailing = container.querySelector('.doc-row-trailing')
    expect(trailing).toBeInTheDocument()
    const children = Array.from(trailing!.children)
    expect(children[0]).toHaveClass('doc-row-chips')
    expect(children[1]).toHaveClass('doc-row-badges')
    expect(children[2]).toHaveClass('doc-row-actions')
    // Preview + "⋯" are the rightmost group, so they align in a column down the list.
    const actions = trailing!.querySelector('.doc-row-actions')!
    expect(within(actions as HTMLElement).getByRole('button', { name: /^preview$/i })).toBeInTheDocument()
    expect(within(actions as HTMLElement).getByRole('button', { name: /more actions/i })).toBeInTheDocument()
  })

  it('renders tag chips as a distinct quieter element from the bordered Preview button', async () => {
    stubApi({
      listCollections: vi.fn(async () => [coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })]),
      listDocuments: vi.fn(async () => [
        doc({ collections: [{ id: 'lib', name: 'Library', type: 'library', role: 'source' }] })
      ])
    })
    const { container } = render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    // The tag is a non-interactive Chip inside the chips group — not a button, not the Preview.
    const chipGroup = container.querySelector('.doc-row-chips')!
    const chip = within(chipGroup as HTMLElement).getByText('Library')
    expect(chip.closest('.chip')).toBeInTheDocument()
    expect(chip.closest('button')).toBeNull()
    // Preview is a separate <button>, so a tag can never read as that action.
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeInTheDocument()
  })

  it('keeps readiness as the only green badge — Summary + Deeply indexed are neutral', async () => {
    const summary = { text: 's', modelId: 'm', createdAt: '2026-01-01T00:00:00Z', truncated: false }
    stubApi({
      listDocuments: vi.fn(async () => [doc({ fullyChunked: true, treeStatus: 'ready', summary })])
    })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    // Readiness = success (green).
    expect(screen.getByText('Ready').closest('.pill')).toHaveClass('pill-success')
    // Capability badges = neutral (grey), each keeping icon + word (1.4.1).
    expect(screen.getByText('Summary').closest('.pill')).toHaveClass('pill-neutral')
    expect(screen.getByText('Deeply indexed').closest('.pill')).toHaveClass('pill-neutral')
    // Exactly one success badge on the row.
    expect(document.querySelectorAll('.doc-row .pill-success')).toHaveLength(1)
  })

  it('the "⋯" trigger is keyboard-focusable even though it is hover-revealed', async () => {
    stubApi({ listDocuments: vi.fn(async () => [doc({})]) })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    const trigger = screen.getByRole('button', { name: 'More actions for contract.pdf' })
    trigger.focus()
    expect(trigger).toHaveFocus()
    expect(trigger).not.toHaveAttribute('tabindex', '-1')
  })
})

// ---- §11.6 sub-nav regroup: four headed groups, "More" disclosure, active aria-current,
//      collapsible panel ----------------------------------------------------------------
describe('DocumentsScreen — sub-nav (section rail) regroup', () => {
  afterEach(() => {
    try {
      window.localStorage.clear()
    } catch {
      /* jsdom */
    }
  })

  it('renders the four groups in order: All documents · Projects · Locations · Views', async () => {
    stubApi({
      listCollections: vi.fn(async () => [coll({ id: 'tax', name: 'Tax 2025' })]),
      listDocuments: vi.fn(async () => [doc({})])
    })
    render(<DocumentsScreen />)
    const all = await screen.findByRole('button', { name: 'All documents' })
    const projects = screen.getByText('Projects')
    const locations = screen.getByText('Locations')
    const views = screen.getByText('Views')
    // DOM order: All documents → Projects → Locations → Views (Node.DOCUMENT_POSITION_FOLLOWING = 4).
    expect(all.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(projects.compareDocumentPosition(locations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(locations.compareDocumentPosition(views) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The system buckets live under Locations (all four present as nav rows).
    for (const name of ['Library', 'Temporary', 'Generated', 'Archived']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('the active item carries aria-current and uses the fill (not a ring); selection moves it', async () => {
    const user = userEvent.setup()
    stubApi({
      listCollections: vi.fn(async () => [coll({ id: 'lib', name: 'Library', type: 'library', builtin: true })]),
      listDocuments: vi.fn(async () => [doc({})])
    })
    render(<DocumentsScreen />)
    // Default landing = All documents, marked current.
    const all = await screen.findByRole('button', { name: 'All documents' })
    expect(all).toHaveAttribute('aria-current', 'true')
    expect(all).toHaveClass('active')
    // Selecting Library moves aria-current there; All documents drops it.
    await user.click(screen.getByRole('button', { name: 'Library' }))
    expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'All documents' })).not.toHaveAttribute('aria-current')
  })

  it('folds the rare views behind a "More" disclosure that toggles via keyboard with aria-expanded', async () => {
    const user = userEvent.setup()
    stubApi({
      listCollections: vi.fn(async () => []),
      // One large + one audio doc, so those rare views are non-empty (and thus offered).
      listDocuments: vi.fn(async () => [
        doc({ id: 'd1', sizeBytes: 200 * 1024 * 1024 }),
        doc({ id: 'd2', title: 'talk.mp3', mimeType: 'audio/mpeg' })
      ])
    })
    render(<DocumentsScreen />)
    // Common views always visible; the rare ones are hidden until "More" is expanded.
    expect(await screen.findByRole('button', { name: 'Recently added' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Needs re-index' })).toBeInTheDocument()
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Large files' })).not.toBeInTheDocument()
    // Keyboard: focus + Enter expands.
    more.focus()
    await user.keyboard('{Enter}')
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Large files' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Audio' })).toBeInTheDocument()
    // The expanded state persists across sessions.
    expect(window.localStorage.getItem(VIEWS_MORE_KEY)).toBe('1')
    // Space collapses it again.
    await user.keyboard(' ')
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(window.localStorage.getItem(VIEWS_MORE_KEY)).toBe('0')
  })

  it('hides an empty rare view entirely (no Failed imports when nothing failed)', async () => {
    const user = userEvent.setup()
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [doc({ id: 'd1', sizeBytes: 200 * 1024 * 1024 })])
    })
    render(<DocumentsScreen />)
    await user.click(await screen.findByRole('button', { name: 'More' }))
    expect(screen.getByRole('button', { name: 'Large files' })).toBeInTheDocument()
    // No failed / audio / scan docs ⇒ those rare views are not even offered.
    expect(screen.queryByRole('button', { name: 'Failed imports' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Audio' })).not.toBeInTheDocument()
  })

  it('collapses and expands the whole sub-nav, remembering the state; collapsed → no rail', async () => {
    const user = userEvent.setup()
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [doc({})])
    })
    render(<DocumentsScreen />)
    // Expanded by default: the rail and its "All documents" row are present.
    expect(await screen.findByRole('button', { name: 'All documents' })).toBeInTheDocument()
    // Collapse via the "«" handle.
    await user.click(screen.getByRole('button', { name: 'Hide sections' }))
    expect(screen.queryByRole('button', { name: 'All documents' })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('1')
    // A "»" handle re-opens it.
    const show = screen.getByRole('button', { name: 'Show sections' })
    expect(show).toBeInTheDocument()
    await user.click(show)
    expect(screen.getByRole('button', { name: 'All documents' })).toBeInTheDocument()
    expect(window.localStorage.getItem(RAIL_COLLAPSED_KEY)).toBe('0')
  })
})
