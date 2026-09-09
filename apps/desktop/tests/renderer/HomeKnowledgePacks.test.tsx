// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import type { AppStatus, KnowledgePack, PreflightResult, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// §11.16: Home's fourth readiness row — the knowledge packs (an offline Wikipedia) as a source
// beside the documents. Three states, and the row is absent while the packs are unknown (an
// older bridge without the channel, or a failed read) so an unstubbed harness never sees it.

const APP_STATUS = {
  workspaceMode: 'plaintext_dev',
  activeModelId: 'qwen3-chat'
} as unknown as AppStatus
const PREFLIGHT = { ok: true, problems: [], slowDriveWarning: null } as unknown as PreflightResult
const RUNTIME: RuntimeStatus = { running: true, modelId: 'qwen3-chat', port: 1, healthy: true, message: '' }

function pack(over: Partial<KnowledgePack> = {}): KnowledgePack {
  return {
    id: 'p1',
    title: 'Wikipedia (English)',
    description: null,
    language: 'eng',
    zimDate: '2026-07-01',
    articleCount: 100,
    sizeBytes: 1024,
    leaf: 'wikipedia_en.zim',
    enabled: true,
    available: true,
    unavailableReason: null,
    addedAt: '2026-09-01T00:00:00Z',
    ...over
  }
}

function stubs(listKnowledgePacks?: () => Promise<KnowledgePack[]>): void {
  stubApi({
    getAppStatus: vi.fn(async () => APP_STATUS),
    listDocuments: vi.fn(async () => []),
    runPreflight: vi.fn(async () => PREFLIGHT),
    getRuntimeStatus: vi.fn(async () => RUNTIME),
    ...(listKnowledgePacks ? { listKnowledgePacks } : {})
  })
}

afterEach(cleanup)

describe('HomeScreen — knowledge packs readiness row (§11.16)', () => {
  it('says how many packs are ready when at least one is present and enabled', async () => {
    stubs(async () => [pack(), pack({ id: 'p2', enabled: false }), pack({ id: 'p3', available: false })])
    render(<HomeScreen onNavigate={() => {}} />)
    expect(await screen.findByText('1 knowledge pack ready to ask')).toBeInTheDocument()
    expect(screen.getByText('Knowledge packs')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add packs' })).toBeNull()
  })

  it('offers "Add packs" when none is registered, deep-linking to the packs mode', async () => {
    const onNavigate = vi.fn()
    stubs(async () => [])
    const user = userEvent.setup()
    render(<HomeScreen onNavigate={onNavigate} />)
    expect(await screen.findByText(/No packs yet — add an offline Wikipedia/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add packs' }))
    expect(onNavigate).toHaveBeenCalledWith('documents:packs')
  })

  it('says none is enabled when packs exist but none is usable, and opens the panel', async () => {
    const onNavigate = vi.fn()
    stubs(async () => [pack({ enabled: false })])
    const user = userEvent.setup()
    render(<HomeScreen onNavigate={onNavigate} />)
    expect(await screen.findByText(/No pack is enabled/)).toBeInTheDocument()
    expect(screen.getByText('None enabled')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open knowledge packs' }))
    expect(onNavigate).toHaveBeenCalledWith('documents:packs')
  })

  it('renders no row at all while the packs are unknown (no channel / failed read)', async () => {
    stubs()
    render(<HomeScreen onNavigate={() => {}} />)
    // Settle the other reads first (the Documents row is the last one rendered before it).
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument()
    expect(screen.queryByText('Knowledge packs')).toBeNull()
  })
})
