// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { t } from '../../src/shared/i18n'
import type { Conversation, Message, RuntimeStatus, SkillInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// #135 (skills-pipeline audit TEST-2): the #80 offer ACCEPT flow at the ChatScreen level — the
// feature's core promise ("re-run via the EXISTING regenerate path with the skill explicitly set")
// previously had no coverage past the Transcript prop boundary (SkillOffer.test.tsx hands a vi.fn()
// to Transcript directly; SkillPerTurn.test.tsx covers composer picks). This mounts the REAL screen
// and pins the argument tuple the click produces on the wire — a wrong-parameter-position regression
// (`askDocuments(convId, content, SKILL, REGENERATE, …)` vs stream()'s own
// (convId, content, REGENERATE, depth, SKILL) order) would ship unseen otherwise — plus the
// optimistic drop of the answered turn, and the #132 click-time availability gate as wired.

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'My documents chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'documents',
    scopeDocumentIds: null,
    collectionId: null,
    scope: null,
    ...over
  }
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: true, modelId: 'm1', port: 1234, healthy: true, message: 'ok', ...over }
}

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    installId: 'app:bank-statement',
    id: 'bank-statement',
    title: 'Bank Statement Analysis',
    description: 'Analyzes a bank statement.',
    version: '1.0.0',
    kind: 'tool',
    author: 'HilbertRaum',
    language: 'en',
    source: 'app',
    trustedLevel: 'app',
    enabled: true,
    warningAck: true,
    unavailable: false,
    permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
    permissionSummary: 'x',
    duplicateId: false,
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

const MESSAGES: Message[] = [
  {
    id: 'm-user',
    conversationId: 'c1',
    role: 'user',
    content: 'kategorisiere alle transaktionen und erstelle eine summe pro kategorie',
    createdAt: '2026-08-09T10:00:00.000Z'
  },
  {
    id: 'm-assistant',
    conversationId: 'c1',
    role: 'assistant',
    content: 'Found 2 amounts across 1 section scanned.',
    createdAt: '2026-08-09T10:00:05.000Z',
    skillOffer: { installId: 'app:bank-statement', title: 'Bank Statement Analysis', source: 'deterministic' }
  }
]

const RUN_LABEL = t('en', 'chat.skill.offer.run', { title: 'Bank Statement Analysis' })

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

async function mountWithOffer(skills: SkillInfo[]): Promise<{
  askDocuments: ReturnType<typeof vi.fn>
  user: ReturnType<typeof userEvent.setup>
}> {
  const user = userEvent.setup()
  // The accept HANGS (an in-flight stream): the optimistic drop of the answered turn stays
  // observable — a resolved stream would refetch listMessages (this stub) and re-show the old row.
  const askDocuments = vi.fn((): Promise<Message> => new Promise<Message>(() => {}))
  stubApi({
    listConversations: vi.fn(async () => [conv()]),
    getRuntimeStatus: vi.fn(async () => status()),
    listMessages: vi.fn(async () => MESSAGES),
    listDocuments: vi.fn(async () => []),
    listSkills: vi.fn(async () => skills),
    suggestSkills: vi.fn(async () => []),
    listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
    listAttachments: vi.fn(async () => []),
    askDocuments,
    onToken: vi.fn(() => () => {}),
    onReasoning: vi.fn(() => () => {}),
    onScopeNotice: vi.fn(() => () => {})
  })
  render(<ChatScreen onNavigate={() => {}} />)
  await user.click(await screen.findByText('My documents chat'))
  await screen.findByText('Found 2 amounts across 1 section scanned.')
  return { askDocuments, user }
}

describe('ChatScreen — the #80 offer accept flow (#135)', () => {
  it('a click re-runs via the regenerate path with the skill explicitly set, in the wire argument order', async () => {
    const { askDocuments, user } = await mountWithOffer([skill()])
    const run = screen.getByRole('button', { name: RUN_LABEL })
    expect(run).toBeEnabled()
    await user.click(run)
    // The wire tuple: (conversationId, content='', skillInstallId, regenerate=true, pinnedDocumentId).
    // stream()'s OWN parameter order swaps regenerate/skill — this pins the translation.
    await waitFor(() =>
      expect(askDocuments).toHaveBeenCalledExactlyOnceWith('c1', '', 'app:bank-statement', true, undefined)
    )
    // The answered turn was optimistically dropped before the re-run (the regenerate contract).
    expect(screen.queryByText('Found 2 amounts across 1 section scanned.')).not.toBeInTheDocument()
  })

  it('#132: with the offered skill disabled, the row is disabled with the honest tooltip and nothing fires', async () => {
    const { askDocuments, user } = await mountWithOffer([skill({ enabled: false })])
    const run = screen.getByRole('button', { name: RUN_LABEL })
    expect(run).toBeDisabled()
    expect(run).toHaveAttribute('title', t('en', 'chat.skill.offer.unavailable'))
    await user.click(run)
    expect(askDocuments).not.toHaveBeenCalled()
  })

  it('#132: with the offered skill REMOVED entirely, the stored title still renders and the row is disabled', async () => {
    const { askDocuments } = await mountWithOffer([])
    // The offer's stamped title is the honest fallback — the affordance never lies about what it was.
    const run = screen.getByRole('button', { name: RUN_LABEL })
    expect(run).toBeDisabled()
    expect(askDocuments).not.toHaveBeenCalled()
  })
})
