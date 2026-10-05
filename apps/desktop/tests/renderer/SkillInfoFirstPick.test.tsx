// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { clearSkillDetailRequest, consumeSkillDetailRequest } from '../../src/renderer/lib/skillDetailRequest'
import { DEFAULT_SETTINGS, type RuntimeStatus, type SkillInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { makeSkillInfo, makeConversation as conv } from '../helpers/chat-fixtures'

// #46 — the ChatScreen wiring for the first-selection skill info card: the FIRST pick of a skill
// (ever, by declared id) shows the what/needs/limits card and persists the id in
// `AppSettings.skillInfoSeen`; an already-seen skill shows nothing automatically but the picker's
// ⓘ re-opens the card on demand. The pure card component is covered in SkillInfoCard.test.tsx;
// here we prove the real screen behavior (the SkillPerTurn test precedent).

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: true, modelId: 'm1', port: 1234, healthy: true, message: 'ok', ...over }
}

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return makeSkillInfo({ author: 'HilbertRaum', ...over })
}

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
  clearSkillDetailRequest()
  window.localStorage.clear()
})

/** Mounts ChatScreen over the stubbed bridge with a controllable seen-list, selects the conv. */
async function mount(
  seen: string[],
  over: { onNavigate?: (screen: string) => void } = {}
): Promise<{ updateSettings: ReturnType<typeof vi.fn>; getSettings: ReturnType<typeof vi.fn>; user: ReturnType<typeof userEvent.setup> }> {
  const user = userEvent.setup()
  const getSettings = vi.fn(async () => ({ ...DEFAULT_SETTINGS, skillInfoSeen: seen }))
  const updateSettings = vi.fn(async (patch: Record<string, unknown>) => ({
    ...DEFAULT_SETTINGS,
    ...patch
  }))
  stubApi({
    listConversations: vi.fn(async () => [conv()]),
    getRuntimeStatus: vi.fn(async () => status()),
    listMessages: vi.fn(async () => []),
    listDocuments: vi.fn(async () => []),
    listSkills: vi.fn(async () => [skill()]),
    suggestSkills: vi.fn(async () => []),
    listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
    listAttachments: vi.fn(async () => []),
    setConversationDefaultSkill: vi.fn(async () => {}),
    getSettings,
    updateSettings
  })
  render(<ChatScreen onNavigate={over.onNavigate ?? (() => {})} />)
  await user.click(await screen.findByText('My chat'))
  return { updateSettings, getSettings, user }
}

const pickerTrigger = (): HTMLElement => screen.getByRole('button', { name: /^skill:/i })

async function pickSkill(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(pickerTrigger())
  await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
}

describe('ChatScreen — first-selection skill info card (#46)', () => {
  it('the FIRST pick shows the info card and persists the skill id as seen', async () => {
    const { updateSettings, user } = await mount([])
    await pickSkill(user)
    // The card appears with the catalog copy (bank-statement is an app skill)…
    expect(await screen.findByRole('note', { name: /about “bank statement helper”/i })).toBeInTheDocument()
    expect(screen.getByText(/exact, checkable extraction/)).toBeInTheDocument()
    // …and the seen-memory is persisted by declared id (not installId).
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ skillInfoSeen: ['bank-statement'] }))
  })

  it('an already-seen skill shows NO automatic card; the picker ⓘ re-opens and closes it', async () => {
    const { updateSettings, getSettings, user } = await mount(['bank-statement'])
    await pickSkill(user)
    // Gate the negatives on the settings read having RESOLVED: an unresolved read (seen === null) also
    // suppresses the card and the write, which would make them pass for the wrong reason.
    await waitFor(() => expect(getSettings).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('note', { name: /about “bank statement helper”/i })).not.toBeInTheDocument()
    expect(updateSettings).not.toHaveBeenCalled()
    // The ⓘ affordance re-opens the card on demand…
    await user.click(screen.getByRole('button', { name: /about “bank statement helper”/i }))
    expect(await screen.findByRole('note', { name: /about “bank statement helper”/i })).toBeInTheDocument()
    // …its ✕ hides it again.
    await user.click(screen.getByRole('button', { name: 'Hide this explanation' }))
    expect(screen.queryByRole('note', { name: /about “bank statement helper”/i })).not.toBeInTheDocument()
  })

  it('clearing the skill hides the card (it is gated to the ACTIVE pick)', async () => {
    const { user } = await mount([])
    await pickSkill(user)
    expect(await screen.findByRole('note', { name: /about “bank statement helper”/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /clear skill bank statement helper/i }))
    expect(screen.queryByRole('note', { name: /about/i })).not.toBeInTheDocument()
  })

  it('"Learn more" navigates to the Skills screen (the detail deep-link mailbox)', async () => {
    const onNavigate = vi.fn()
    const { user } = await mount([], { onNavigate })
    await pickSkill(user)
    await screen.findByRole('note', { name: /about “bank statement helper”/i })
    await user.click(screen.getByRole('button', { name: 'Learn more' }))
    expect(onNavigate).toHaveBeenCalledWith('skills')
    expect(consumeSkillDetailRequest()).toBe('app:bank-statement')
  })
})
