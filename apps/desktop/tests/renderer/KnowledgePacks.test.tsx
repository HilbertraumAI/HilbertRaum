// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PacksPanel } from '../../src/renderer/screens/documents/PacksPanel'
import { ArticleModal } from '../../src/renderer/chat/ArticleModal'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { I18nProvider } from '../../src/renderer/i18n'
import type { Collection, DocumentInfo, DocumentScope, KnowledgePack } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Knowledge packs (ZIM wave) renderer surfaces: the PacksPanel management list, the
// ScopePopover pack sources (incl. packIds preservation on unrelated toggles), and the
// offline ArticleModal's honest states.

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
      getKnowledgePackStatus: async () => ({ toolsInstalled: true }),
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
      getKnowledgePackStatus: async () => ({ toolsInstalled: false }),
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
      getKnowledgePackStatus: async () => ({ toolsInstalled: true }),
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
      getKnowledgePackStatus: async () => ({ toolsInstalled: true }),
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
        ]
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
