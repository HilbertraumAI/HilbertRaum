// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { KnowledgePack } from '../../src/shared/types'
import { renderHome, stubHomeApi } from '../helpers/home-screen'
import { knowledgePack, WIKIPEDIA_EN_PACK } from '../helpers/knowledge-pack-fixtures'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'

// §11.16: Home's fourth readiness row — the knowledge packs (an offline Wikipedia) as a source
// beside the documents. Three states, and the row is absent while the packs are unknown.

const pack = (over: Partial<KnowledgePack> = {}): KnowledgePack => knowledgePack({ ...WIKIPEDIA_EN_PACK, ...over })

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
  }
})

describe('HomeScreen — knowledge packs readiness row (§11.16)', () => {
  it('says how many packs are ready when at least one is present and enabled', async () => {
    stubHomeApi({
      listKnowledgePacks: async () => [
        pack(),
        pack({ id: 'p2', enabled: false }),
        pack({ id: 'p3', available: false }),
        // A confirmed no-full-text-index archive is not askable in the panel, so Home must not count it.
        pack({ id: 'p4', searchable: 'no' })
      ]
    })
    renderHome()
    expect(await screen.findByText('1 knowledge pack ready to ask')).toBeInTheDocument()
    expect(screen.getByText('Knowledge packs')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add packs' })).toBeNull()
  })

  it('offers "Add packs" when none is registered, deep-linking to the packs mode', async () => {
    stubHomeApi()
    const user = userEvent.setup()
    const { onNavigate } = renderHome()
    expect(await screen.findByText(/No packs yet — add an offline Wikipedia/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add packs' }))
    expect(onNavigate).toHaveBeenCalledWith('documents:packs')
  })

  it('says none is ready when packs exist but none is usable, and opens the panel', async () => {
    // Every way a registered pack can be unusable: switched off, file missing (still ENABLED —
    // why the copy says "ready", not "enabled"), and no full-text index.
    stubHomeApi({
      listKnowledgePacks: async () => [
        pack({ enabled: false }),
        pack({ id: 'p2', available: false }),
        pack({ id: 'p3', searchable: 'no' })
      ]
    })
    const user = userEvent.setup()
    const { onNavigate } = renderHome()
    expect(await screen.findByText(/No pack is ready to ask/)).toBeInTheDocument()
    expect(screen.getByText('None ready')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open knowledge packs' }))
    expect(onNavigate).toHaveBeenCalledWith('documents:packs')
  })

  it('renders no row at all when the packs could not be read', async () => {
    const listKnowledgePacks = vi.fn(async (): Promise<KnowledgePack[]> => {
      throw new Error('the pack service is not up')
    })
    stubHomeApi({ listKnowledgePacks })
    renderHome()
    // Settle the other reads first (the Documents row is the last one rendered before it).
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument()
    expect(listKnowledgePacks).toHaveBeenCalledOnce()
    expect(screen.queryByText('Knowledge packs')).toBeNull()
  })
})
