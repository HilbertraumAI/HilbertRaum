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

// #147 coverage add: the "Import folder" HAPPY PATH — only the disabled state was tested.
// Pins the D1 capability flow: pickDocuments mints the token, importPreflight gates audio,
// importDocuments carries the token, and the poll drives busy → done.
describe('DocumentsScreen — Import folder happy path (#147)', () => {
  it('picks a folder, imports via the picker token, and re-enables when the job settles', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const pickDocuments = vi.fn(async () => ({ token: 'cap-1', paths: ['D:/docs/a.pdf'] }))
    const importPreflight = vi.fn(async () => ({ fileCount: 1, audioFileCount: 0, audioBytes: 0 }))
    const importDocuments = vi.fn(async () => ({ jobId: 'j7', documentIds: ['d7'] }))
    const getImportJob = vi
      .fn<(jobId: string) => Promise<ImportJobStatus>>()
      .mockResolvedValueOnce({ jobId: 'j7', total: 1, completed: 0, failed: 0, done: false })
      .mockResolvedValue({ jobId: 'j7', total: 1, completed: 1, failed: 0, done: true })
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [doc({ id: 'd7', title: 'a.pdf', status: 'indexed', chunkCount: 2 })]),
      getActiveImportJob: vi.fn(async () => null),
      pickDocuments,
      importPreflight,
      importDocuments,
      getImportJob
    })
    render(
      <ToastProvider>
        <DocumentsScreen />
      </ToastProvider>
    )

    await user.click(await screen.findByRole('button', { name: 'Import folder' }))
    await waitFor(() => expect(pickDocuments).toHaveBeenCalledWith('folder'))
    // The import references the one-time capability token, never raw renderer-chosen paths (D1).
    await waitFor(() =>
      expect(importDocuments).toHaveBeenCalledWith(['D:/docs/a.pdf'], { pickerToken: 'cap-1' })
    )
    // Busy while the job runs…
    await waitFor(() => expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled())
    // …and the poll notices completion, re-enabling both entry points.
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Import files' })).toBeEnabled(),
      { timeout: 5000 }
    )
    expect(screen.getByRole('button', { name: 'Import folder' })).toBeEnabled()
  })
})
