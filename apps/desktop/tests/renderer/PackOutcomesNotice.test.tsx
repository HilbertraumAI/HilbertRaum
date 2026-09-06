// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import type { UiLanguage } from '../../src/shared/i18n'
import type { Citation, KnowledgePackOutcome, Message } from '../../src/shared/types'

// Per-answer knowledge-pack outcomes in the transcript (#301 P4, findings M6/M7; plan §9.21
// (e)7). The point of the notice is the honesty gap it closes: a ticked pack that was disabled,
// unavailable, index-less, trimmed by the cap or whose search failed used to contribute nothing
// and SAY nothing. So the cases below deliberately include the turns with NO citation cards —
// the notice must not live inside `SourcesDisclosure`, which renders only with citations.

vi.mock('streamdown', () => ({
  Streamdown: vi.fn(({ children }) => <div data-testid="sd">{children}</div>),
  defaultRehypePlugins: { raw: () => undefined, sanitize: () => undefined }
}))

function outcome(over: Partial<KnowledgePackOutcome> = {}): KnowledgePackOutcome {
  return {
    packId: 'uuid-climate',
    title: 'Klimawandel von Wikipedia',
    status: 'searched',
    reason: null,
    found: 3,
    admitted: 2,
    ...over
  }
}

function assistantMsg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'An answer.',
    createdAt: '2026-01-01T00:00:00Z',
    ...over
  }
}

const archiveCitation: Citation = {
  label: 'S1',
  sourceTitle: 'Treibhausgas',
  pageNumber: null,
  section: 'Landwirtschaft',
  snippet: 'Methan …',
  sourceKind: 'archive',
  packId: 'uuid-climate',
  archiveTitle: 'Klimawandel von Wikipedia',
  articlePath: 'Treibhausgas'
}

const noop = (): void => {}

function renderTranscript(lang: UiLanguage, messages: Message[]) {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang)
  return render(
    <I18nProvider>
      <Transcript
        messages={messages}
        streamingHere={false}
        streamText=""
        streamThinking=""
        thinkingOpen={false}
        onThinkingOpenChange={noop}
        emptyState={null}
        onCopy={noop}
        onSave={noop}
        actionsDisabled={false}
      />
    </I18nProvider>
  )
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})
beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

describe('PackOutcomesNotice (#301 P4, M6/M7)', () => {
  it('summarizes searched vs not searched and expands to one row per pack (EN)', async () => {
    const user = userEvent.setup()
    renderTranscript('en', [
      assistantMsg({
        citations: [archiveCitation],
        packOutcomes: [
          outcome(),
          outcome({ packId: 'uuid-chem', title: 'Chemie', status: 'skipped', reason: 'disabled', found: 0, admitted: 0 }),
          outcome({ packId: 'uuid-bio', title: 'Biologie', status: 'failed', reason: 'timeout', found: 0, admitted: 0 })
        ]
      })
    ])
    const toggle = screen.getByRole('button', {
      name: /Knowledge packs: 1 searched · 2 not searched or failed/
    })
    // Collapsed by default — the rows are a detail, the summary is the honest headline.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('not searched: pack disabled')).not.toBeInTheDocument()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(screen.getByText('searched')).toBeInTheDocument()
    // `admitted`, not `found`: the passages that actually entered the ranking.
    expect(screen.getByText('2 passages')).toBeInTheDocument()
    expect(screen.getByText('not searched: pack disabled')).toBeInTheDocument()
    expect(screen.getByText('failed: timed out')).toBeInTheDocument()
    // A not-searched pack shows no passage count at all (0 would read as a search result).
    expect(screen.queryByText('0 passages')).not.toBeInTheDocument()
  })

  it('renders the German copy for the summary and every reason code', async () => {
    const user = userEvent.setup()
    renderTranscript('de', [
      assistantMsg({
        packOutcomes: [
          outcome({ admitted: 1 }),
          outcome({
            packId: 'uuid-old',
            title: 'Altes Paket',
            status: 'skipped',
            reason: 'selection-limit',
            found: 0,
            admitted: 0
          })
        ]
      })
    ])
    const toggle = screen.getByRole('button', {
      name: /Wissenspakete: 1 durchsucht · 1 nicht durchsucht oder fehlgeschlagen/
    })
    await user.click(toggle)
    expect(screen.getByText('durchsucht')).toBeInTheDocument()
    // The plural pair: one admitted passage takes the `.one` variant.
    expect(screen.getByText('1 Fundstelle')).toBeInTheDocument()
    expect(screen.getByText('nicht durchsucht: Auswahlgrenze (12 pro Chat)')).toBeInTheDocument()
  })

  it('renders on an answer with ZERO citation cards (the no-context turn)', async () => {
    // The turn the notice exists for: nothing was cited because every ticked pack was
    // unavailable. `SourcesDisclosure` renders nothing here, so a notice living inside it
    // would leave the user with a bare "I could not find that" and no explanation.
    const user = userEvent.setup()
    renderTranscript('en', [
      assistantMsg({
        content: "I couldn't find that in your documents.",
        packOutcomes: [
          outcome({ status: 'skipped', reason: 'file-missing', found: 0, admitted: 0 }),
          outcome({
            packId: 'uuid-chem',
            title: null,
            status: 'skipped',
            reason: 'removed',
            found: 0,
            admitted: 0
          })
        ]
      })
    ])
    expect(screen.queryByRole('button', { name: /Sources/ })).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', {
      name: /Knowledge packs: 0 searched · 2 not searched or failed/
    })
    await user.click(toggle)
    expect(screen.getByText('not searched: file missing')).toBeInTheDocument()
    // A null title is an id with no registration row at all — named, never shown as a raw UUID.
    expect(screen.getByText('a removed pack')).toBeInTheDocument()
    expect(screen.queryByText(/uuid-chem/)).not.toBeInTheDocument()
  })

  it('says so explicitly for a LEGACY archive answer that recorded no outcomes', () => {
    // Persisted before `pack_outcomes_json` existed: inventing "searched" would be a lie and
    // silence would read as "nothing to report", so the notice names the gap.
    renderTranscript('en', [assistantMsg({ citations: [archiveCitation] })])
    expect(
      screen.getByText('Knowledge packs: outcome not recorded for this older answer')
    ).toBeInTheDocument()
  })

  it('renders nothing for a plain answer with neither outcomes nor archive citations', () => {
    renderTranscript('en', [
      assistantMsg({
        citations: [
          {
            label: 'S1',
            sourceTitle: 'contract.pdf',
            pageNumber: 4,
            section: null,
            snippet: 'A clause.',
            documentId: 'd1',
            chunkId: 'c1'
          }
        ]
      })
    ])
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByText(/Knowledge packs/)).not.toBeInTheDocument()
  })
})
