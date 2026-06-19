// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CoverageMeter } from '../../src/renderer/components'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { I18nProvider } from '../../src/renderer/i18n'
import { resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import { t } from '../../src/shared/i18n'
import type {
  CoverageInfo,
  DocTaskStatus,
  DocumentCoverage,
  DocumentInfo,
  Message
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Whole-document-analysis Phase 2 renderer tests: the coverage meter's HONESTY (breadth ≠
// fidelity, never "100%" unless a deep index is ready), the "Build deep index" / "Re-index
// first" row action (C4 gate), and the relevance label on a grounded chat answer.

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

function meter(coverage: CoverageInfo): JSX.Element {
  return (
    <I18nProvider>
      <CoverageMeter coverage={coverage} />
    </I18nProvider>
  )
}

describe('CoverageMeter — breadth ≠ fidelity honesty (C1/L2)', () => {
  it('a relevance answer is labelled "not the whole document"', () => {
    render(meter({ mode: 'relevance', chunksCovered: 0, chunksTotal: 0 }))
    expect(screen.getByText(t('en', 'coverage.relevance'))).toBeInTheDocument()
  })

  it('a ready deep index shows "whole document (deeply indexed)" PLUS the tier depth', () => {
    render(
      meter({ mode: 'tree', treeStatus: 'ready', chunksCovered: 10, chunksTotal: 10, tier: 1, treeLevels: 2 })
    )
    expect(screen.getByText(t('en', 'coverage.tree.whole'))).toBeInTheDocument()
    expect(
      screen.getByText(t('en', 'coverage.depth', { label: t('en', 'coverage.tier.1') }))
    ).toBeInTheDocument()
  })

  it('a BUILDING deep index shows the partial fraction, NEVER the whole-document claim', () => {
    render(meter({ mode: 'tree', treeStatus: 'building', chunksCovered: 3, chunksTotal: 10, truncated: true }))
    expect(
      screen.getByText(t('en', 'coverage.tree.partial', { covered: 3, total: 10 }))
    ).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'coverage.tree.whole'))).not.toBeInTheDocument()
  })

  it('a capped summary never renders as complete (covers the beginning when truncated)', () => {
    render(meter({ mode: 'capped', chunksCovered: 7, chunksTotal: 7, truncated: true }))
    expect(screen.getByText(t('en', 'coverage.capped.beginning'))).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'coverage.tree.whole'))).not.toBeInTheDocument()
  })

  // Phase 3 — structured-extract listing honesty (H7): "sections scanned (k unparsed)",
  // gated whole-document wording, NEVER "complete".
  it('an extract listing over a fully-indexed doc says "whole document", never "complete"', () => {
    render(meter({ mode: 'extract', chunksCovered: 213, chunksTotal: 213, fullyChunked: true }))
    expect(
      screen.getByText(t('en', 'coverage.extract.whole', { scanned: 213 }))
    ).toBeInTheDocument()
    expect(screen.queryByText(/complete/i)).not.toBeInTheDocument()
  })

  it('an extract listing surfaces unparsed sections and never claims the whole document when not fully chunked', () => {
    render(
      meter({ mode: 'extract', chunksCovered: 50, chunksTotal: 50, unparsedChunks: 3, fullyChunked: false })
    )
    expect(
      screen.getByText(t('en', 'coverage.extract.sectionsUnparsed', { scanned: 50, unparsed: 3 }))
    ).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'coverage.extract.whole', { scanned: 50 }))).not.toBeInTheDocument()
  })
})

describe('Transcript — a grounded answer is labelled relevance-based', () => {
  function transcript(messages: Message[]): JSX.Element {
    return (
      <I18nProvider>
        <Transcript
          messages={messages}
          streamingHere={false}
          streamText=""
          streamThinking=""
          thinkingOpen={false}
          onThinkingOpenChange={() => {}}
          emptyState={null}
          onCopy={() => {}}
          onSave={() => {}}
          actionsDisabled={false}
        />
      </I18nProvider>
    )
  }

  it('renders the "most relevant passages — not the whole document" label under the answer', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'assistant',
        content: 'The payment is due in 30 days [S1].',
        createdAt: '2026-01-01T00:00:00Z',
        citations: [{ label: 'S1', sourceTitle: 'contract.pdf', pageNumber: 2, snippet: 'due in 30 days' }]
      }
    ]
    render(transcript(messages))
    expect(screen.getByText(t('en', 'coverage.relevance'))).toBeInTheDocument()
  })

  // Full-doc-skills Phase 1 (D48): the meter is data-driven. A message carrying a PERSISTED
  // coverage renders THAT breadth; a citation-bearing message with no coverage (NULL / pre-migration)
  // still falls back to the relevance label — byte-identical to the pre-Phase-1 hardcoded behaviour.
  it('renders the PERSISTED coverage when a message carries one (extract → whole document)', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'assistant',
        content: 'There are 213 transactions [S1].',
        createdAt: '2026-01-01T00:00:00Z',
        citations: [{ label: 'S1', sourceTitle: 'statement.pdf', snippet: 'row' }],
        coverage: { mode: 'extract', chunksCovered: 213, chunksTotal: 213, fullyChunked: true }
      }
    ]
    render(transcript(messages))
    expect(screen.getByText(t('en', 'coverage.extract.whole', { scanned: 213 }))).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'coverage.relevance'))).not.toBeInTheDocument()
  })

  it('does not label a plain (citation-free) answer', () => {
    const messages: Message[] = [
      { id: 'm1', conversationId: 'c1', role: 'assistant', content: 'Hello there.', createdAt: '2026-01-01T00:00:00Z' }
    ]
    render(transcript(messages))
    expect(screen.queryByText(t('en', 'coverage.relevance'))).not.toBeInTheDocument()
  })
})

describe('DocumentsScreen — Build deep index + C4 gate', () => {
  function doc(over: Partial<DocumentInfo> = {}): DocumentInfo {
    return {
      id: 'd1',
      title: 'report.pdf',
      originalPath: null,
      mimeType: 'application/pdf',
      sizeBytes: 4096,
      status: 'indexed',
      errorMessage: null,
      chunkCount: 40,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      ...over
    }
  }
  function task(over: Partial<DocTaskStatus> = {}): DocTaskStatus {
    return {
      jobId: 'j1',
      kind: 'tree',
      documentIds: ['d1'],
      state: 'running',
      progress: { stepsDone: 0, stepsTotal: 0 },
      error: null,
      resultRef: null,
      ...over
    }
  }

  it('offers "Build deep index" on a fully-chunked doc with no tree, and starts a tree task', async () => {
    const user = userEvent.setup()
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    stubApi({
      listDocuments: vi.fn(async () => [doc({ fullyChunked: true, treeStatus: null })]),
      startDocTask,
      getDocTask: vi.fn(async () => task({ state: 'running' }))
    })
    render(<DocumentsScreen />)
    await screen.findByText('report.pdf')
    // "Build deep index" now lives in the per-row "⋯" overflow (§11.6).
    await user.click(screen.getByRole('button', { name: t('en', 'docs.moreActions', { title: 'report.pdf' }) }))
    await user.click(await screen.findByRole('menuitem', { name: t('en', 'docs.deepIndex.build') }))
    expect(startDocTask).toHaveBeenCalledWith({ kind: 'tree', documentIds: ['d1'] })
  })

  it('C4: a legacy (not fully-chunked) doc offers "Re-index first" and re-indexes, not a dead build', async () => {
    const user = userEvent.setup()
    const reindexDocument = vi.fn(async () => doc({ fullyChunked: true }))
    const startDocTask = vi.fn(async () => ({ jobId: 'j1' }))
    stubApi({
      listDocuments: vi.fn(async () => [doc({ fullyChunked: false, treeStatus: null })]),
      reindexDocument,
      startDocTask
    })
    render(<DocumentsScreen />)
    await screen.findByText('report.pdf')
    await user.click(screen.getByRole('button', { name: t('en', 'docs.moreActions', { title: 'report.pdf' }) }))
    // The C4 gate surfaces "Re-index for deep index", NOT a "Build deep index" item.
    expect(screen.queryByRole('menuitem', { name: t('en', 'docs.deepIndex.build') })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('menuitem', { name: t('en', 'docs.deepIndex.reindexFirst') }))
    expect(reindexDocument).toHaveBeenCalledWith('d1')
    expect(startDocTask).not.toHaveBeenCalled()
  })

  it('a ready deep index shows the "Deeply indexed" badge and no build action', async () => {
    stubApi({
      listDocuments: vi.fn(async () => [doc({ fullyChunked: true, treeStatus: 'ready' })])
    })
    render(<DocumentsScreen />)
    await screen.findByText('report.pdf')
    expect(screen.getByText(t('en', 'docs.deepIndex.ready'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('en', 'docs.deepIndex.build') })).not.toBeInTheDocument()
  })

  it('the preview meter renders the coverage from analysis:coverage', async () => {
    const user = userEvent.setup()
    const coverage: DocumentCoverage = {
      coverage: { mode: 'tree', treeStatus: 'ready', chunksCovered: 40, chunksTotal: 40, tier: 1, treeLevels: 2 },
      provenance: [{ label: 'S1', sourceTitle: 'report.pdf', pageNumber: 1, snippet: 'intro' }]
    }
    stubApi({
      listDocuments: vi.fn(async () => [
        doc({
          fullyChunked: true,
          treeStatus: 'ready',
          summary: { text: 'A whole-document overview.', modelId: 'm', createdAt: '2026-01-01T00:00:00Z', truncated: false, tier: 1 }
        })
      ]),
      previewDocument: vi.fn(async () => ({
        id: 'd1',
        title: 'report.pdf',
        mimeType: 'application/pdf',
        segments: [{ text: 'body', pageNumber: 1, sectionLabel: null }]
      })),
      documentCoverage: vi.fn(async () => coverage)
    })
    render(<DocumentsScreen />)
    await screen.findByText('report.pdf')
    await user.click(screen.getByRole('button', { name: /^preview$/i }))
    await waitFor(() =>
      expect(screen.getByText(t('en', 'coverage.tree.whole'))).toBeInTheDocument()
    )
    // The tier selector is offered (ready deep index) and the source provenance is exposed.
    expect(
      screen.getByRole('button', { name: new RegExp(t('en', 'coverage.tier.1'), 'i') })
    ).toBeInTheDocument()
  })
})
