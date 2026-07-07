// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentsScreen, __docRowRenderCounts } from '../../src/renderer/screens/DocumentsScreen'
import { formatSize } from '../../src/renderer/screens/documents/format'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { startTask, resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import { en } from '../../src/shared/i18n'
import type { Collection, DocTaskStatus, DocumentInfo, DocumentPreview } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Session 3 (chat-docs remediation) — Documents renderer polish, DR-1…DR-9. Each test has
// TEETH: reverting its fix reddens exactly the named assertion. DR-1/DR-2 are the two races and
// were revert-and-rerun confirmed by hand; the rest are single-assertion characterizations.

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

function firstPage(over: Partial<DocumentPreview> = {}): DocumentPreview {
  return {
    id: 'd1',
    title: 'contract.pdf',
    mimeType: 'application/pdf',
    segments: [{ text: 'First page clause.', pageNumber: 1, sectionLabel: null }],
    totalSegments: 2,
    nextOffset: 1,
    ...over
  }
}

afterEach(() => {
  cleanup()
  resetDocTaskStoreForTests()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

// ---- DR-1: a late "Show more" page must not resurrect a closed modal --------------------
describe('DocumentsScreen — DR-1 preview load-more late-response guard', () => {
  it('drops the late page instead of re-opening a modal closed mid-load', async () => {
    const user = userEvent.setup()
    let resolvePage: ((p: DocumentPreview) => void) | null = null
    const previewDocument = vi.fn(async () => firstPage())
    const previewDocumentPage = vi.fn(
      () => new Promise<DocumentPreview>((res) => { resolvePage = res })
    )
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), previewDocument, previewDocumentPage })
    render(<DocumentsScreen />)

    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /preview/i }))
    expect(await screen.findByText(/First page clause/)).toBeInTheDocument()

    // Click "Show more" (parks the page IPC), THEN close the modal before it resolves.
    await user.click(screen.getByRole('button', { name: /show more/i }))
    expect(resolvePage).not.toBeNull()
    await user.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Now the late page resolves — with `preview === null` the updater must return `cur` (drop it),
    // NOT install `next` (which would resurrect the closed modal on a mid-document slice).
    await act(async () => {
      resolvePage!({ ...firstPage(), segments: [{ text: 'Second page clause.', pageNumber: 2, sectionLabel: null }], nextOffset: null })
      await Promise.resolve()
    })
    // TEETH: revert to `: next` → the dialog re-appears here and the second page shows.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/Second page clause/)).not.toBeInTheDocument()
  })
})

// ---- DR-2: an out-of-order refresh cannot clobber a newer snapshot ----------------------
describe('DocumentsScreen — DR-2 refresh ordering guard', () => {
  it('a stale listDocuments resolving last does not overwrite the newer one', async () => {
    const resolvers: Array<(v: DocumentInfo[]) => void> = []
    const listDocuments = vi.fn(() => new Promise<DocumentInfo[]>((res) => { resolvers.push(res) }))
    stubApi({ listDocuments, listCollections: vi.fn(async () => []) })
    render(<DocumentsScreen />)

    // Mount refresh (seq 1) → resolve with alpha so the screen renders.
    await act(async () => { resolvers[0]([doc({ id: 'd1', title: 'alpha.pdf' })]) })
    expect(await screen.findByText('alpha.pdf')).toBeInTheDocument()

    // Two overlapping manual refreshes: A (seq 2, will carry the STALE snapshot) then B (seq 3, FRESH).
    const refreshBtn = screen.getByRole('button', { name: 'Refresh' })
    await act(async () => { fireEvent.click(refreshBtn) })
    await act(async () => { fireEvent.click(refreshBtn) })
    expect(resolvers.length).toBe(3)

    // B (the newer, seq 3) resolves FIRST → beta sticks…
    await act(async () => { resolvers[2]([doc({ id: 'd2', title: 'beta.pdf' })]) })
    // …then A (older, seq 2) resolves LAST with gamma — its seq no longer matches, so it's dropped.
    await act(async () => { resolvers[1]([doc({ id: 'd3', title: 'gamma.pdf' })]) })

    // TEETH: remove the `seq !== refreshSeq.current` gate → gamma (the older snapshot) clobbers beta.
    expect(screen.getByText('beta.pdf')).toBeInTheDocument()
    expect(screen.queryByText('gamma.pdf')).not.toBeInTheDocument()
  })
})

// ---- DR-3: the toolbar Refresh rejection surfaces as the banner -------------------------
describe('DocumentsScreen — DR-3 toolbar refresh error handling', () => {
  it('a listDocuments rejection on toolbar Refresh shows the error banner', async () => {
    let first = true
    const listDocuments = vi.fn(async () => {
      if (first) {
        first = false
        return [doc({})]
      }
      throw new Error('The workspace is locked. Unlock it to continue.')
    })
    stubApi({ listDocuments })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    // TEETH: revert to `void refresh()` → unhandled rejection, no banner → this findByText times out.
    expect(await screen.findByText(/workspace is locked/i)).toBeInTheDocument()
  })
})

// ---- DR-4: per-row preview-loading (the memo tightens, not loosens) ---------------------
describe('DocumentsScreen — DR-4 per-row preview loading', () => {
  it('opening one row’s preview does not disable/relabel or re-render the other rows', async () => {
    const previewDocument = vi.fn(() => new Promise<DocumentPreview>(() => {})) // parked → loading holds
    stubApi({
      listCollections: vi.fn(async () => []),
      listDocuments: vi.fn(async () => [
        doc({ id: 'd1', title: 'alpha.pdf' }),
        doc({ id: 'd2', title: 'beta.pdf' })
      ]),
      previewDocument
    })
    render(<DocumentsScreen />)
    await screen.findByText('alpha.pdf')
    await screen.findByText('beta.pdf')

    const [aBtn, bBtn] = screen.getAllByRole('button', { name: 'Preview' })
    const before = new Map(__docRowRenderCounts)

    fireEvent.click(aBtn) // opens row A (d1)'s preview — its IPC is parked, so loading persists

    // Row A reflects the loading state; row B is untouched — not disabled, not relabeled.
    await waitFor(() => expect(aBtn).toHaveTextContent('Opening…'))
    expect(aBtn).toBeDisabled()
    expect(bBtn).toHaveTextContent('Preview')
    expect(bBtn).not.toBeDisabled()

    // TEETH: with the old screen-global `previewLoading`, B's prop flips too → B re-renders (delta > 0)
    // AND B reads "Opening…"/disabled. The per-row `previewLoadingId === d.id` keeps B's memo intact.
    const delta = (id: string): number => (__docRowRenderCounts.get(id) ?? 0) - (before.get(id) ?? 0)
    expect(delta('d2')).toBe(0)
  })
})

// ---- DR-5: Import is gated during ANY busy op (e.g. a bulk re-index) --------------------
describe('DocumentsScreen — DR-5 import gate', () => {
  it('disables Import while a bulk re-index recovered on mount is running', async () => {
    const getReindexAllJob = vi.fn(async () => ({
      jobId: 'r1',
      total: 3,
      completed: 1,
      failed: 0,
      done: false,
      cancelled: false
    }))
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), getReindexAllJob })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')

    // The recover effect sets busy='reindex-all'; the Import gate is `busy !== null`.
    // TEETH: revert to `busy === 'import'` → the button is enabled during the reindex (this fails).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import files' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Import folder' })).toBeDisabled()
  })
})

// ---- DR-6: an archived project shows the active/selected state --------------------------
describe('DocumentsScreen — DR-6 archived-project active state', () => {
  it('selecting an archived project marks its rail item active + aria-current', async () => {
    const user = userEvent.setup()
    const archived = coll({ id: 'old', name: 'OldCase', archivedAt: '2026-02-01T00:00:00Z' })
    stubApi({
      listCollections: vi.fn(async () => [archived]),
      listDocuments: vi.fn(async () => [doc({})])
    })
    render(<DocumentsScreen />)

    const railBtn = await screen.findByRole('button', { name: 'OldCase' })
    await user.click(railBtn)

    // TEETH: without the DR-6 branch the archived wrapper stays `docs-rail-project archived` with no
    // aria-current, so both of these assertions fail.
    expect(screen.getByRole('button', { name: 'OldCase' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'OldCase' }).closest('.docs-rail-project')).toHaveClass('active')
  })
})

// ---- DR-7: a failed doc-task error is localized in the banner ---------------------------
describe('DocumentsScreen — DR-7 localized doc-task failure copy', () => {
  it('localizes a canonical-English task error for the German UI', async () => {
    vi.useFakeTimers()
    try {
      window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
      const status: DocTaskStatus = {
        jobId: 'j1',
        kind: 'summary',
        documentIds: ['d1'],
        state: 'failed',
        progress: { stepsDone: 0, stepsTotal: 0 },
        error: en['main.ingest.sourceMissing'], // persist-canonical English
        resultRef: null
      }
      stubApi({
        listDocuments: vi.fn(async () => [doc({})]),
        startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
        getDocTask: vi.fn(async () => status)
      })
      const flush = async (): Promise<void> => {
        await act(async () => {
          for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
        })
      }
      render(
        <I18nProvider>
          <DocumentsScreen />
        </I18nProvider>
      )
      await flush() // mount refresh
      await act(async () => {
        await startTask('summary', 'd1')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400) // first poll → terminal failed status
      })
      await flush()

      // TEETH: revert to `setError(status.error)` → the raw English constant shows, not the German.
      expect(screen.getByText('Die Quelldatei wurde nicht gefunden.')).toBeInTheDocument()
      expect(screen.queryByText('Source file not found on disk.')).not.toBeInTheDocument()
    } finally {
      resetDocTaskStoreForTests()
      vi.useRealTimers()
    }
  })
})

// ---- DR-8: first-mount loading spinner --------------------------------------------------
describe('DocumentsScreen — DR-8 first-mount loading state', () => {
  it('shows a status spinner while the initial listDocuments is in flight, then clears it', async () => {
    let resolveList: ((v: DocumentInfo[]) => void) | null = null
    const listDocuments = vi.fn(() => new Promise<DocumentInfo[]>((res) => { resolveList = res }))
    stubApi({ listDocuments })
    render(<DocumentsScreen />)

    // docs === null && error === null → the loading region is present.
    expect(screen.getByRole('status')).toHaveTextContent('Loading documents…')

    await act(async () => { resolveList!([doc({})]) })
    await screen.findByText('contract.pdf')
    // TEETH: remove the branch → nothing renders here (blank list) and the spinner never showed.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

// ---- DR-9: formatSize GB tier -----------------------------------------------------------
describe('formatSize — DR-9 GB tier', () => {
  it('formats GB-scale sizes with the locale decimal', () => {
    // TEETH: without the GB tier these return "2048.0 MB" / "1536,0 MB".
    expect(formatSize(2 * 1024 ** 3, 'en')).toBe('2.0 GB')
    expect(formatSize(1.5 * 1024 ** 3, 'de')).toBe('1,5 GB')
    // The lower tiers are unchanged.
    expect(formatSize(2048, 'en')).toBe('2.0 KB')
    expect(formatSize(5 * 1024 * 1024, 'en')).toBe('5.0 MB')
  })
})
