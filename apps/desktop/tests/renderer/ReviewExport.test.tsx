// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { EVIDENCE_PACK_OPTION_DEFAULTS } from '../../src/shared/evidence-review'
import { t } from '../../src/shared/i18n'
import type { EvidenceExportRecord } from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeItem } from '../helpers/evidenceReview'

// EP-1 Phase 3 (plan §8.4) — the summary's export surface: the "Create evidence pack"
// action beside Mark ready, the inline options panel (§16.2 checkboxes at the SHARED
// defaults + the §24.3 encryption-boundary warning), the IPC payload (flags + language
// frozen at generation), the P2-handoff store contract (successful export merges the
// returned record into detail.exports under the openToken guard — history renders real
// rows, status shows Last exported), cancel/failure semantics, flush-before-export, and
// export on a READY review. Same structural no-call tripwire as the other renderer files:
// `exportEvidencePack` is in the stub sets, and the afterEach fails on anything unmocked.

beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

beforeEach(() => {
  resetReviewSessionForTests()
})

afterEach(() => {
  cleanup()
  assertNoUnexpectedApiCalls()
})

function noop(): void {}

function makeExportRecord(over: Partial<EvidenceExportRecord> = {}): EvidenceExportRecord {
  return {
    id: 'x1',
    reviewId: 'r1',
    format: 'html',
    schemaVersion: 1,
    fileName: 'pack.html',
    fileSha256: 'aa'.repeat(32),
    options: { language: 'en', ...EVIDENCE_PACK_OPTION_DEFAULTS },
    createdAt: '2026-07-18T12:00:00.000Z',
    ...over
  }
}

async function openSummary(): Promise<HTMLElement> {
  // findByRole waits for the open-session load to resolve (the footer renders only once
  // the detail is in the store).
  fireEvent.click(await screen.findByRole('button', { name: t('en', 'review.footer.summary') }))
  return await screen.findByRole('dialog')
}

async function openExportPanel(dialog: HTMLElement): Promise<void> {
  fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.export.action') }))
  await within(dialog).findByText(t('en', 'review.export.encryptionWarning'))
}

describe('summary export panel (plan §8.4)', () => {
  it('opens with the §24.3 warning and the shared §16.2 defaults (technical OFF)', async () => {
    stubApi({ getEvidenceReview: vi.fn(async () => makeDetail()) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    const dialog = await openSummary()
    await openExportPanel(dialog)

    const boxes = within(dialog).getAllByRole('checkbox')
    expect(boxes).toHaveLength(5)
    const byLabel = (key: Parameters<typeof t>[1]): HTMLInputElement =>
      within(dialog).getByRole('checkbox', { name: t('en', key) })
    expect(byLabel('review.export.optNotes').checked).toBe(true)
    expect(byLabel('review.export.optExcerpts').checked).toBe(true)
    expect(byLabel('review.export.optHashes').checked).toBe(true)
    expect(byLabel('review.export.optUnreviewed').checked).toBe(true)
    // The one privacy-conservative default: technical details OFF.
    expect(byLabel('review.export.optTechnical').checked).toBe(false)
  })

  it('exports with the chosen flags + the CURRENT UI language, merges the record into the history, and shows Last exported', async () => {
    const record = makeExportRecord()
    const exportEvidencePack = vi.fn(async () => record)
    stubApi({ getEvidenceReview: vi.fn(async () => makeDetail()), exportEvidencePack })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    const dialog = await openSummary()
    await openExportPanel(dialog)

    // Flip one flag off — the payload must carry the edited set, not the defaults.
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: t('en', 'review.export.optNotes') })
    )
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.export.confirm') }))

    await waitFor(() =>
      expect(exportEvidencePack).toHaveBeenCalledWith('r1', {
        ...EVIDENCE_PACK_OPTION_DEFAULTS,
        includeReviewerNotes: false,
        language: 'en'
      })
    )
    // The store merged the returned record (P2 handoff: detail.exports refresh) — the
    // history section renders the real row and the status line shows Last exported.
    await within(dialog).findByText(t('en', 'review.summary.exports'))
    expect(within(dialog).getByText(/pack\.html/)).toBeInTheDocument()
    expect(within(dialog).getByText(new RegExp('Last exported'))).toBeInTheDocument()
    // Success collapses the panel.
    expect(
      within(dialog).queryByText(t('en', 'review.export.encryptionWarning'))
    ).not.toBeInTheDocument()
  })

  it('cancel (null result) keeps the panel open with NO history row and NO error', async () => {
    const exportEvidencePack = vi.fn(async () => null)
    stubApi({ getEvidenceReview: vi.fn(async () => makeDetail()), exportEvidencePack })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    const dialog = await openSummary()
    await openExportPanel(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.export.confirm') }))
    await waitFor(() => expect(exportEvidencePack).toHaveBeenCalled())

    expect(
      within(dialog).getByText(t('en', 'review.export.encryptionWarning'))
    ).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).queryByText(t('en', 'review.summary.exports'))).not.toBeInTheDocument()
  })

  it('a failed export shows the inline error and records nothing', async () => {
    const exportEvidencePack = vi.fn(async () => {
      throw new Error('disk full')
    })
    stubApi({ getEvidenceReview: vi.fn(async () => makeDetail()), exportEvidencePack })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    const dialog = await openSummary()
    await openExportPanel(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.export.confirm') }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('disk full')
    expect(within(dialog).queryByText(t('en', 'review.summary.exports'))).not.toBeInTheDocument()
  })

  it('flushes pending edits BEFORE exporting (the pack renders persisted data)', async () => {
    const detail = makeDetail()
    const updateEvidenceReviewItem = vi.fn(async (id: string) => makeItem({ id }))
    const exportEvidencePack = vi.fn(async () => makeExportRecord())
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      exportEvidencePack
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')
    // A note edit that is still inside the debounce window when Export is clicked.
    const items = screen.getAllByRole('listitem')
    fireEvent.change(
      within(items[0]!).getByPlaceholderText(t('en', 'review.item.notePlaceholder')),
      { target: { value: 'pending note' } }
    )
    const dialog = await openSummary()
    await openExportPanel(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.export.confirm') }))
    await waitFor(() => expect(exportEvidencePack).toHaveBeenCalled())
    expect(updateEvidenceReviewItem).toHaveBeenCalled()
    expect(updateEvidenceReviewItem.mock.invocationCallOrder[0]!).toBeLessThan(
      exportEvidencePack.mock.invocationCallOrder[0]!
    )
  })

  it('export WORKS on a ready review (the write-guard covers item mutations only)', async () => {
    const ready = makeDetail({
      status: 'ready',
      completedAt: '2026-07-18T11:00:00.000Z',
      items: [
        makeItem({ id: 'i1', decision: 'supported' }),
        makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta', decision: 'supported' })
      ]
    })
    const exportEvidencePack = vi.fn(async () => makeExportRecord())
    stubApi({ getEvidenceReview: vi.fn(async () => ready), exportEvidencePack })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    const dialog = await openSummary()
    await openExportPanel(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.export.confirm') }))
    await waitFor(() => expect(exportEvidencePack).toHaveBeenCalledWith('r1', expect.anything()))
    await within(dialog).findByText(t('en', 'review.summary.exports'))
  })

  it('renders existing export history rows and the status Last exported line on open', async () => {
    const detail = makeDetail({
      exports: [makeExportRecord({ id: 'x-old', fileName: 'older.html', createdAt: '2026-07-17T09:00:00.000Z' })]
    })
    stubApi({ getEvidenceReview: vi.fn(async () => detail) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    const dialog = await openSummary()
    expect(within(dialog).getByText(t('en', 'review.summary.exports'))).toBeInTheDocument()
    expect(within(dialog).getByText(/older\.html/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Last exported/)).toBeInTheDocument()
  })

  it('FIX-2: history rows show the recorded SHA-256 and copy the FULL hash (the docs/pack promise)', async () => {
    const hash = 'ab'.repeat(32)
    const detail = makeDetail({
      exports: [makeExportRecord({ id: 'x1', fileName: 'pack.html', fileSha256: hash })]
    })
    const copyToClipboard = vi.fn(async () => true)
    stubApi({ getEvidenceReview: vi.fn(async () => detail), copyToClipboard })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    const dialog = await openSummary()
    // Truncated display of the recorded hash…
    expect(within(dialog).getByText(`${hash.slice(0, 12)}…`)).toBeInTheDocument()
    // …and the copy affordance carries the FULL hash to the clipboard.
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: `${t('en', 'review.export.copyHash')}: pack.html`
      })
    )
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(hash))
  })

  it('FIX-3: a failed auto-save flush REFUSES the export — no pack of data the screen shows but storage lacks', async () => {
    const detail = makeDetail()
    // The flush write fails → saveState 'error' → exportReviewPack must refuse.
    const updateEvidenceReviewItem = vi.fn(async () => {
      throw new Error('write failed')
    })
    const exportEvidencePack = vi.fn(async () => makeExportRecord())
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      exportEvidencePack
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')
    const items = screen.getAllByRole('listitem')
    fireEvent.change(
      within(items[0]!).getByPlaceholderText(t('en', 'review.item.notePlaceholder')),
      { target: { value: 'unsaveable note' } }
    )
    const dialog = await openSummary()
    await openExportPanel(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.export.confirm') }))
    // The flush failed → the panel shows the generic error; the export IPC never fired.
    await within(dialog).findByText(t('en', 'review.export.error'))
    expect(updateEvidenceReviewItem).toHaveBeenCalled()
    expect(exportEvidencePack).not.toHaveBeenCalled()
  })
})
