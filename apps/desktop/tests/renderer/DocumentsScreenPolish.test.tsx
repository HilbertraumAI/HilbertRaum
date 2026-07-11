// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act, fireEvent, within } from '@testing-library/react'
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

// ---- CODE-32 (full-audit 2026-07-11): preview installs are seq-ordered -------------------
describe('DocumentsScreen — CODE-32 preview install ordering', () => {
  it('slow-first-resolves-last: the modal shows the SECOND clicked document', async () => {
    const resolvers = new Map<string, (p: DocumentPreview) => void>()
    const previewDocument = vi.fn(
      (id: string) => new Promise<DocumentPreview>((res) => { resolvers.set(id, res) })
    )
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

    const [aBtn, bBtn] = screen.getAllByRole('button', { name: 'Preview' })
    fireEvent.click(aBtn) // A first (its IPC will resolve LAST)
    fireEvent.click(bBtn) // then B — the newer request
    await waitFor(() => expect(resolvers.size).toBe(2))

    // B (newer) resolves FIRST and opens the modal…
    await act(async () => {
      resolvers.get('d2')!(
        firstPage({ id: 'd2', title: 'beta.pdf', segments: [{ text: 'Beta text.', pageNumber: 1, sectionLabel: null }], nextOffset: null })
      )
    })
    // …then A (older) resolves LAST — its stamp is stale, so it must be dropped.
    await act(async () => {
      resolvers.get('d1')!(
        firstPage({ id: 'd1', title: 'alpha.pdf', segments: [{ text: 'Alpha text.', pageNumber: 1, sectionLabel: null }], nextOffset: null })
      )
    })

    // TEETH: without the seq stamp, last-resolved wins → the modal flips to alpha.pdf here.
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('beta.pdf')).toBeInTheDocument()
    expect(within(dialog).queryByText(/Alpha text/)).not.toBeInTheDocument()
  })
})

// ---- CODE-33 (full-audit 2026-07-11): right-click respects the busy gate ------------------
describe('DocumentsScreen — CODE-33 context menu busy gate', () => {
  it('right-click does NOT open the row menu while a busy op runs', async () => {
    // The DR-5 recover path latches busy='reindex-all' on mount — the same gate that disables
    // the "⋯" trigger, which right-click used to bypass.
    const getReindexAllJob = vi.fn(async () => ({
      jobId: 'r1', total: 3, completed: 1, failed: 0, done: false, cancelled: false
    }))
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), getReindexAllJob })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import files' })).toBeDisabled())

    fireEvent.contextMenu(screen.getByText('contract.pdf'))

    // TEETH: pre-fix the overflow opened and Delete/Re-index were clickable mid-op.
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Re-index' })).not.toBeInTheDocument()
  })
})

// ---- CODE-35 (full-audit 2026-07-11): "Show more" failure shows INSIDE the modal ----------
describe('DocumentsScreen — CODE-35 preview load-more error placement', () => {
  it('a rejected page fetch surfaces inside the open modal, not under its overlay', async () => {
    const user = userEvent.setup()
    const previewDocument = vi.fn(async () => firstPage())
    const previewDocumentPage = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'docs:previewPage': Error: The workspace is locked. Unlock it to continue."
      )
    })
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), previewDocument, previewDocumentPage })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await user.click(screen.getByRole('button', { name: /preview/i }))
    expect(await screen.findByText(/First page clause/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show more/i }))

    // TEETH: pre-fix the failure went to the SCREEN banner (under the dialog overlay) — inside
    // the dialog nothing appeared and the button just looked dead.
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByText(/workspace is locked/i)).toBeInTheDocument()
    // The modal stays open with its content intact, ready for a retry.
    expect(within(dialog).getByText(/First page clause/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /show more/i })).toBeEnabled()
  })
})

// ---- CODE-38 (full-audit 2026-07-11): collections refresh — seq + keep-on-failure ---------
describe('DocumentsScreen — CODE-38 collections refresh', () => {
  it('keeps the prior collections when a later listCollections fails (never empties the rail)', async () => {
    let fail = false
    const listCollections = vi.fn(async () => {
      if (fail) throw new Error('The workspace is locked. Unlock it to continue.')
      return [coll({ id: 'p1', name: 'Cases' })]
    })
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), listCollections })
    render(<DocumentsScreen />)
    expect(await screen.findByRole('button', { name: 'Cases' })).toBeInTheDocument()

    fail = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(1))

    // TEETH: pre-fix the catch ran `setCollections([])` — the Projects rail emptied here.
    expect(screen.getByRole('button', { name: 'Cases' })).toBeInTheDocument()
  })

  it('a stale listCollections resolving last does not overwrite the newer snapshot', async () => {
    const collResolvers: Array<(v: Collection[]) => void> = []
    const listCollections = vi.fn(
      () => new Promise<Collection[]>((res) => { collResolvers.push(res) })
    )
    stubApi({ listDocuments: vi.fn(async () => [doc({})]), listCollections })
    render(<DocumentsScreen />)
    await screen.findByText('contract.pdf')
    await waitFor(() => expect(collResolvers.length).toBe(1)) // the mount refresh's read

    // Two overlapping manual refreshes: their collections reads carry seq 2 (STALE) and 3 (FRESH).
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(collResolvers.length).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(collResolvers.length).toBe(3))

    // The NEWEST resolves first with the fresh project…
    await act(async () => { collResolvers[2]([coll({ id: 'p2', name: 'Fresh' })]) })
    // …then the STALE one resolves last — without the seq gate it would clobber 'Fresh'.
    await act(async () => { collResolvers[1]([coll({ id: 'p1', name: 'Stale' })]) })
    await act(async () => { collResolvers[0]([]) }) // settle the mount read (stale too — dropped)

    expect(screen.getByRole('button', { name: 'Fresh' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stale' })).not.toBeInTheDocument()
  })
})

// ---- CODE-39 (full-audit 2026-07-11): done-task completions surface their failures --------
describe('DocumentsScreen — CODE-39 done-task auto-open failure', () => {
  it('a failed result auto-open after a done summary lands on the banner (not swallowed)', async () => {
    vi.useFakeTimers()
    try {
      const done: DocTaskStatus = {
        jobId: 'j1',
        kind: 'summary',
        documentIds: ['d1'],
        state: 'done',
        progress: { stepsDone: 1, stepsTotal: 1 },
        error: null,
        resultRef: null
      }
      const previewDocument = vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'docs:preview': Error: The workspace is locked. Unlock it to continue."
        )
      })
      stubApi({
        listDocuments: vi.fn(async () => [doc({})]),
        startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
        getDocTask: vi.fn(async () => done),
        previewDocument
      })
      const flush = async (): Promise<void> => {
        await act(async () => {
          for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
        })
      }
      render(<DocumentsScreen />)
      await flush() // mount refresh
      await act(async () => {
        await startTask('summary', 'd1')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400) // first poll → terminal done → auto-open fires
      })
      await flush()

      // TEETH: pre-fix the `.catch(() => undefined)` swallowed this — no banner, outcome lost.
      expect(screen.getByText(/workspace is locked/i)).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    } finally {
      resetDocTaskStoreForTests()
      vi.useRealTimers()
    }
  })
})

// ---- F2 rider (CODE-6 follow-up): the state-unknown task row is labelled + dismissable ----
describe('DocumentsScreen — state-unknown task row (F2 rider)', () => {
  it('after the store gives up polling, the row shows the labelled state and Dismiss clears it', async () => {
    vi.useFakeTimers()
    try {
      const getDocTask = vi.fn(async () => {
        throw new Error('ipc gone')
      })
      stubApi({
        listDocuments: vi.fn(async () => [doc({})]),
        startDocTask: vi.fn(async () => ({ jobId: 'j1' })),
        getDocTask
      })
      const flush = async (): Promise<void> => {
        await act(async () => {
          for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
        })
      }
      render(<DocumentsScreen />)
      await flush()
      await act(async () => {
        await startTask('summary', 'd1')
      })
      // Three consecutive poll failures (MAX_POLL_FAILURES) → the store latches stateUnknown.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1300)
      })
      await flush()

      // TEETH: pre-rider the row kept the busy/Cancel pair until reload — no label, no way out.
      expect(
        screen.getByText("Couldn't check on this task — it may still be running.")
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      await flush()
      expect(
        screen.queryByText("Couldn't check on this task — it may still be running.")
      ).not.toBeInTheDocument()
      // The row is interactive again (the normal Preview action is back).
      expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
    } finally {
      resetDocTaskStoreForTests()
      vi.useRealTimers()
    }
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
