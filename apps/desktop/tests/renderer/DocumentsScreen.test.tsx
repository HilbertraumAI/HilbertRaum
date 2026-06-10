// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import type { DocumentInfo } from '../../src/shared/types'
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

afterEach(cleanup)

describe('DocumentsScreen', () => {
  it('lists documents with their status and chunk count', async () => {
    stubApi({ listDocuments: vi.fn(async () => [doc({})]) })
    render(<DocumentsScreen />)
    expect(await screen.findByText('contract.pdf')).toBeInTheDocument()
    expect(screen.getByText('Indexed')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('shows the re-index banner for a document with stale embeddings (M7)', async () => {
    stubApi({ listDocuments: vi.fn(async () => [doc({ staleEmbeddings: true })]) })
    render(<DocumentsScreen />)
    expect(await screen.findByText(/different embedding model/i)).toBeInTheDocument()
  })

  it('does NOT show the re-index banner when embeddings are current', async () => {
    stubApi({ listDocuments: vi.fn(async () => [doc({ staleEmbeddings: false })]) })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    expect(screen.queryByText(/different embedding model/i)).not.toBeInTheDocument()
  })

  it('surfaces the error message for a failed document', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [
        doc({ status: 'failed', errorMessage: 'Unsupported file type: .xyz', chunkCount: 0 })
      ])
    })
    render(<DocumentsScreen />)
    expect(await screen.findByText(/Unsupported file type/i)).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
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
    // Phase 24: destructive delete goes through a ConfirmDialog, never straight through.
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
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
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
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

  it('"Re-index all" re-indexes every stale document', async () => {
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

    await user.click(await screen.findByRole('button', { name: /re-index all \(2\)/i }))
    await waitFor(() => expect(reindexDocument).toHaveBeenCalledTimes(2))
    expect(reindexDocument).toHaveBeenCalledWith('d1')
    expect(reindexDocument).toHaveBeenCalledWith('d2')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /re-index all/i })).not.toBeInTheDocument()
    )
  })
})
