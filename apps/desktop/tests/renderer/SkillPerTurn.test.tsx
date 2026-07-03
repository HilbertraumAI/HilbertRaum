// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { Conversation, RuntimeStatus, SkillInfo } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// U3 (audit §4.3): the ChatScreen wiring for per-turn skill application. A composer pick applies for
// the turn only — it is NEVER silently written to the conversation's saved default (`active_skill_id`);
// the ONLY writer of that default is the explicit "keep for this conversation" checkbox; and both the
// checkbox (un-keep) and picking "None" / the chip × CLEAR a saved default so it can't resurface on
// reload against the user's visible session choice (the confirmed keep-checkbox-shadow finding). The
// pure picker component is covered in SkillChat.test.tsx; here we prove the real screen behavior.

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'My chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
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
    title: 'Bank statement helper',
    description: 'Explains a bank statement.',
    version: '1.0.0',
    kind: 'instruction',
    author: 'You',
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

/** Common stub set + the setConversationDefaultSkill spy; mounts ChatScreen and selects the conv. */
async function mountWithConversation(
  c: Conversation,
  setConversationDefaultSkill = vi.fn(async () => {})
): Promise<{ setConversationDefaultSkill: ReturnType<typeof vi.fn>; user: ReturnType<typeof userEvent.setup> }> {
  const user = userEvent.setup()
  stubApi({
    listConversations: vi.fn(async () => [c]),
    getRuntimeStatus: vi.fn(async () => status()),
    listMessages: vi.fn(async () => []),
    listDocuments: vi.fn(async () => []),
    listSkills: vi.fn(async () => [skill()]),
    suggestSkills: vi.fn(async () => []),
    listRunnableTools: vi.fn(async () => ({ tools: [], documentIds: [] })),
    listAttachments: vi.fn(async () => []),
    setConversationDefaultSkill
  })
  render(<ChatScreen onNavigate={() => {}} />)
  // Select the conversation so its saved default (if any) becomes the active skill.
  await user.click(await screen.findByText('My chat'))
  return { setConversationDefaultSkill, user }
}

const pickerTrigger = (): HTMLElement => screen.getByRole('button', { name: /^skill:/i })

describe('ChatScreen — per-turn skill apply + keep (U3, audit §4.3)', () => {
  it('a pick is PER-TURN: it is never written to the saved default', async () => {
    const { setConversationDefaultSkill, user } = await mountWithConversation(conv())
    await user.click(pickerTrigger())
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    // The pick shows in the composer chip…
    expect(pickerTrigger()).toHaveTextContent('Bank statement helper')
    // …but it was NOT persisted as the conversation default (per-turn). Any DB write here is only the
    // CLEAR (…, null); the skill id is never persisted without an explicit "keep".
    expect(setConversationDefaultSkill).not.toHaveBeenCalledWith('c1', 'app:bank-statement')
  })

  it('"keep for this conversation" is the ONLY thing that persists the pick as the default', async () => {
    const { setConversationDefaultSkill, user } = await mountWithConversation(conv())
    await user.click(pickerTrigger())
    await user.click(await screen.findByRole('menuitemradio', { name: /bank statement helper/i }))
    await user.click(pickerTrigger())
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /keep for this conversation/i }))
    await waitFor(() => expect(setConversationDefaultSkill).toHaveBeenCalledWith('c1', 'app:bank-statement'))
  })

  it('a saved default shows the keep checkbox CHECKED; picking None CLEARS it (no resurface on reload)', async () => {
    // The confirmed review finding: before the fix, a saved default was left in the DB when the user
    // picked None (the chip × is hidden with no skill), so it silently came back on reload.
    const { setConversationDefaultSkill, user } = await mountWithConversation(
      conv({ activeSkillId: 'app:bank-statement' })
    )
    expect(pickerTrigger()).toHaveTextContent('Bank statement helper')
    await user.click(pickerTrigger())
    expect(screen.getByRole('menuitemcheckbox', { name: /keep for this conversation/i })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await user.click(screen.getByRole('menuitemradio', { name: /no skill/i }))
    await waitFor(() => expect(setConversationDefaultSkill).toHaveBeenCalledWith('c1', null))
    expect(pickerTrigger()).toHaveTextContent('No skill')
  })

  it('the composer chip × clears both the session pick and the saved default', async () => {
    const { setConversationDefaultSkill, user } = await mountWithConversation(
      conv({ activeSkillId: 'app:bank-statement' })
    )
    expect(pickerTrigger()).toHaveTextContent('Bank statement helper')
    await user.click(screen.getByRole('button', { name: /clear skill bank statement helper/i }))
    await waitFor(() => expect(setConversationDefaultSkill).toHaveBeenCalledWith('c1', null))
    expect(pickerTrigger()).toHaveTextContent('No skill')
    // The × is gone once no skill is active.
    expect(screen.queryByRole('button', { name: /clear skill/i })).not.toBeInTheDocument()
  })
})
