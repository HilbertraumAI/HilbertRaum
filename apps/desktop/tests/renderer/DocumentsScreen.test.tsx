// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
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

  it('deletes a document and refreshes the list', async () => {
    const user = userEvent.setup()
    const listDocuments = vi
      .fn<() => Promise<DocumentInfo[]>>()
      .mockResolvedValueOnce([doc({})]) // initial mount
      .mockResolvedValue([]) // after delete
    const deleteDocument = vi.fn(async () => {})
    stubApi({ listDocuments, deleteDocument })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /^delete$/i }))

    expect(deleteDocument).toHaveBeenCalledWith('d1')
    await waitFor(() => expect(screen.queryByText('contract.pdf')).not.toBeInTheDocument())
  })
})
