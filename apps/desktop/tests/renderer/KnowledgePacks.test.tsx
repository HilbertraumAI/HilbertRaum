// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PacksPanel } from '../../src/renderer/screens/documents/PacksPanel'
import { ArticleModal } from '../../src/renderer/chat/ArticleModal'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { I18nProvider } from '../../src/renderer/i18n'
import type {
  Collection,
  DocumentInfo,
  DocumentScope,
  KnowledgePack,
  KnowledgePacksChangedEvent
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Knowledge packs (ZIM wave) renderer surfaces: the PacksPanel management list, the
// ScopePopover pack sources (incl. packIds preservation on unrelated toggles), and the
// offline ArticleModal's honest states.

/** A controllable `onKnowledgePacksChanged` stand-in (#301 P3b, finding L7): the test holds
 *  `emit` and calls it whenever the "main process" would broadcast the event. */
function packsEventEmitter(): {
  onKnowledgePacksChanged: (cb: (event: KnowledgePacksChangedEvent) => void) => () => void
  emit: (event: KnowledgePacksChangedEvent) => void
} {
  let cb: ((event: KnowledgePacksChangedEvent) => void) | null = null
  return {
    onKnowledgePacksChanged: (fn) => {
      cb = fn
      return () => {
        cb = null
      }
    },
    emit: (event) => cb?.(event)
  }
}

function pack(over: Partial<KnowledgePack> = {}): KnowledgePack {
  return {
    id: 'uuid-climate',
    title: 'Klimawandel von Wikipedia',
    description: 'Offline-Auszug',
    language: 'deu',
    zimDate: '2026-07-01',
    articleCount: 4102,
    sizeBytes: 27 * 1024 * 1024,
    leaf: 'wikipedia_de_climate.zim',
    enabled: true,
    available: true,
    // #301 P3b (M5): additive and NON-optional on `KnowledgePack` — null whenever the pack is
    // available; 'missing' / 'identity-mismatch' say WHY it is not. P6 owns the badge copy.
    unavailableReason: null,
    addedAt: '2026-09-01T00:00:00Z',
    ...over
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('PacksPanel', () => {
  it('lists packs with state badges and meta; missing file shows the honest badge', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack(),
        pack({ id: 'uuid-gone', title: 'Chemie von Wikipedia', available: false, enabled: true })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    expect(screen.getByText('File missing')).toBeInTheDocument()
    expect(screen.getAllByText(/4102 articles/).length).toBeGreaterThan(0)
  })

  it('shows the tools-missing hint and disables adding when kiwix-tools is absent', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: false, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => []
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText(/kiwix-tools binaries are not installed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add packs…' })).toBeDisabled()
  })

  it('add flow calls the main-side dialog channel and refreshes on success', async () => {
    let added = false
    const addKnowledgePacks = vi.fn(async () => {
      added = true
      return [pack()]
    })
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => (added ? [pack()] : []),
      addKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('No knowledge packs yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add packs…' }))
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(addKnowledgePacks).toHaveBeenCalledTimes(1)
  })

  it('remove asks for confirmation and says the file is untouched', async () => {
    const removeKnowledgePack = vi.fn(async () => undefined)
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [pack()],
      removeKnowledgePack
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByText(/archive file on disk is not touched/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove pack' }))
    await waitFor(() => expect(removeKnowledgePack).toHaveBeenCalledWith('uuid-climate'))
  })

  // #301 P3b, finding L7: DB-only list, live refresh state, and the pack-update event.
  it('shows the refreshing line while status.refreshing, and a reconcile-end event clears it and refetches', async () => {
    const emitter = packsEventEmitter()
    let listCalls = 0
    const listKnowledgePacks = vi.fn(async () => {
      listCalls++
      return listCalls === 1 ? [] : [pack()]
    })
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: true, revision: 0 }),
      listKnowledgePacks,
      onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Checking the drive for packs…')).toBeInTheDocument()
    act(() => emitter.emit({ epoch: 1, revision: 1, refreshing: false, reason: 'reconcile-end' }))
    await waitFor(() =>
      expect(screen.queryByText('Checking the drive for packs…')).not.toBeInTheDocument()
    )
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(listKnowledgePacks).toHaveBeenCalledTimes(2)
  })

  it('Refresh calls packs:refresh', async () => {
    const refreshKnowledgePacks = vi.fn(async () => ({ started: true }))
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [pack()],
      refreshKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await user.click(await screen.findByRole('button', { name: 'Refresh' }))
    expect(refreshKnowledgePacks).toHaveBeenCalledTimes(1)
  })

  it('ignores a packs:changed event whose epoch is below the last one seen', async () => {
    const emitter = packsEventEmitter()
    const listKnowledgePacks = vi.fn(async () => [pack()])
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks,
      onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await screen.findByText('Klimawandel von Wikipedia')
    expect(listKnowledgePacks).toHaveBeenCalledTimes(1)
    // A newer epoch first advances what counts as "last seen"…
    act(() => emitter.emit({ epoch: 5, revision: 2, refreshing: false, reason: 'mutation' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
    // …then an OLDER epoch (an old session's late announcement) must change nothing: no
    // refetch, and the refreshing line never appears from a stale reconcile-start.
    act(() => emitter.emit({ epoch: 3, revision: 3, refreshing: true, reason: 'reconcile-start' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(listKnowledgePacks).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Checking the drive for packs…')).not.toBeInTheDocument()
  })

  it('shows the identity-mismatch badge for a pack replaced by a different archive', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack({ available: false, unavailableReason: 'identity-mismatch' })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Different archive')).toBeInTheDocument()
  })
})

describe('ScopePopover — knowledge packs', () => {
  const collections: Collection[] = [
    {
      id: 'lib',
      name: 'Library',
      type: 'library',
      description: null,
      builtin: true,
      color: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      archivedAt: null
    } as Collection
  ]
  const doc = {
    id: 'd1',
    title: 'contract.pdf',
    status: 'indexed',
    chunkCount: 1
  } as DocumentInfo

  it('renders the packs section, toggles a pack, and an unavailable pack is not tickable', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack(), pack({ id: 'uuid-gone', title: 'Chemie von Wikipedia', available: false })]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText('Knowledge packs')).toBeInTheDocument()
    const packBox = screen.getByRole('checkbox', { name: /Klimawandel von Wikipedia/ })
    const goneBox = screen.getByRole('checkbox', { name: /Chemie von Wikipedia/ })
    expect(goneBox).toBeDisabled()
    await user.click(packBox)
    expect(emitted.at(-1)).toEqual({
      collectionIds: [],
      documentIds: [],
      packIds: ['uuid-climate']
    })
  })

  it('keeps the picker for a pack-only corpus (no documents imported yet)', async () => {
    // Regression: the empty-corpus early return used to collapse the picker into the
    // "Add documents" jump, making the packs section unreachable in a fresh workspace
    // with an offline Wikipedia added but nothing imported (found in the live demo).
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    await user.click(await screen.findByRole('checkbox', { name: /Klimawandel von Wikipedia/ }))
    expect(emitted.at(-1)?.packIds).toEqual(['uuid-climate'])
  })

  it('preserves packIds when an unrelated source is toggled (spread-preservation)', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [], packIds: ['uuid-climate'] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    await user.click(await screen.findByRole('checkbox', { name: /Library/ }))
    expect(emitted.at(-1)?.packIds).toEqual(['uuid-climate'])
    expect(emitted.at(-1)?.collectionIds).toEqual(['lib'])
  })
})

describe('ArticleModal', () => {
  it('renders the article sections from the main-resolved plain text', async () => {
    stubApi({
      getPackArticle: async () => ({
        title: 'Treibhausgas',
        sections: [
          { label: null, text: 'Treibhausgase sind Spurengase.' },
          { label: 'Landwirtschaft', text: 'Methan entsteht in der Landwirtschaft.' }
        ],
        partial: false
      })
    })
    render(
      <I18nProvider>
        <ArticleModal
          target={{ packId: 'uuid-climate', articlePath: 'Treibhausgas', archiveTitle: 'Klimawandel von Wikipedia' }}
          onClose={() => {}}
        />
      </I18nProvider>
    )
    expect(await screen.findByText('Treibhausgase sind Spurengase.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Landwirtschaft' })).toBeInTheDocument()
    expect(screen.getByText(/From Klimawandel von Wikipedia/)).toBeInTheDocument()
  })

  it('warns that only the first part is shown when the conversion was partial (H1 truncation)', async () => {
    stubApi({
      getPackArticle: async () => ({
        title: 'Treibhausgas',
        sections: [{ label: null, text: 'Treibhausgase sind Spurengase.' }],
        partial: true
      })
    })
    render(
      <I18nProvider>
        <ArticleModal
          target={{ packId: 'uuid-climate', articlePath: 'Treibhausgas' }}
          onClose={() => {}}
        />
      </I18nProvider>
    )
    expect(await screen.findByText(/Only the first part of this article could be shown/)).toBeInTheDocument()
    // The partial text itself is still shown — a partial extraction beats an empty viewer.
    expect(screen.getByText('Treibhausgase sind Spurengase.')).toBeInTheDocument()
  })

  it('shows the honest unavailable state on a null article', async () => {
    stubApi({ getPackArticle: async () => null })
    render(
      <I18nProvider>
        <ArticleModal target={{ packId: 'x', articlePath: 'Gone' }} onClose={() => {}} />
      </I18nProvider>
    )
    expect(await screen.findByText(/not available right now/)).toBeInTheDocument()
  })
})
