// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { ToastProvider } from '../../src/renderer/components'
import type { DocumentInfo, ImportJobStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// DOC-1 (frontend audit 2026-08-09, #141): the import progress poll used to exist only as a
// component-local interval started by startImport. Navigating away and back left NO poll —
// rows froze at "Preparing…" until a manual refresh, and `busy` reset to null so both Import
// buttons re-enabled mid-import. The screen now recovers the in-flight job on mount via the
// parameterless getActiveImportJob (the getReindexAllJob recovery pattern).

function doc(over: Partial<DocumentInfo>): DocumentInfo {
  return {
    id: 'd1',
    title: 'contract.pdf',
    originalPath: '/u/contract.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    status: 'extracting',
    errorMessage: null,
    chunkCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DocumentsScreen — import poll re-attach on mount (DOC-1, #141)', () => {
  it('recovers a live import: buttons stay disabled and the poll drives completion', async () => {
    const live: ImportJobStatus = { jobId: 'j1', total: 1, completed: 0, failed: 0, done: false }
    const done: ImportJobStatus = { jobId: 'j1', total: 1, completed: 1, failed: 0, done: true }
    const getActiveImportJob = vi.fn(async () => live)
    // First poll tick reports the job still running; the next reports it settled.
    const getImportJob = vi
      .fn<(jobId: string) => Promise<ImportJobStatus>>()
      .mockResolvedValueOnce(live)
      .mockResolvedValue(done)
    const listDocuments = vi.fn(async () => [doc({})])
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments,
      getActiveImportJob,
      getImportJob
    })
    render(
      <ToastProvider>
        <DocumentsScreen />
      </ToastProvider>
    )

    // Mount recovery: the live job re-disables BOTH import buttons (pre-fix they re-enabled
    // mid-import, leaving main-side exclusivity as the only guard). The primary button reads
    // its busy label while `busy === 'import'`.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled()
    )
    expect(screen.getByRole('button', { name: 'Import folder' })).toBeDisabled()

    // …and the re-attached poll runs (pre-fix getImportJob was never called again after a
    // remount, so the screen never noticed the backend finishing).
    await waitFor(() => expect(getImportJob).toHaveBeenCalledWith('j1'), { timeout: 3000 })
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Import files' })).toBeEnabled(),
      { timeout: 5000 }
    )
  })

  it('does nothing when no import is in flight', async () => {
    const getImportJob = vi.fn(async (jobId: string) => ({
      jobId,
      total: 0,
      completed: 0,
      failed: 0,
      done: true
    }))
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [doc({ status: 'indexed', chunkCount: 3 })]),
      getActiveImportJob: vi.fn(async () => null),
      getImportJob
    })
    render(
      <ToastProvider>
        <DocumentsScreen />
      </ToastProvider>
    )
    expect(await screen.findByRole('button', { name: 'Import files' })).toBeEnabled()
    // No stray poll was started for a non-existent job.
    await new Promise((r) => setTimeout(r, 600))
    expect(getImportJob).not.toHaveBeenCalled()
  })
})
