// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillPicker, Transcript } from '../../src/renderer/chat'
import { I18nProvider } from '../../src/renderer/i18n'
import type { Message, SkillInfo } from '../../src/shared/types'

// jsdom does not implement Element.scrollTo (Transcript scrolls to newest content).
beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

// Skills plan S6 (UI) — the composer skill picker + the per-message glyph. The picker is a pure
// component; the glyph rides the assistant message in the Transcript. Heavier send/stamp wiring is
// covered by the service tests (skills-turn.test.ts); here we prove the two UI pieces render + fire.

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    installId: 'user:bank',
    id: 'bank',
    title: 'Bank statement helper',
    description: 'Reads printed totals.',
    version: '1.0.0',
    kind: 'instruction',
    author: 'You',
    language: 'en',
    source: 'user',
    trustedLevel: 'user',
    enabled: true,
    warningAck: true,
    unavailable: false,
    permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
    permissionSummary: 'x',
    duplicateId: false,
    installedAt: 't',
    updatedAt: 't',
    ...over
  }
}

function withI18n(ui: React.ReactElement): React.ReactElement {
  return <I18nProvider>{ui}</I18nProvider>
}

afterEach(cleanup)

describe('SkillPicker (composer footer, skills plan §10.2)', () => {
  it('shows the selected skill in the trigger and offers None + each enabled skill', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(withI18n(<SkillPicker skills={[skill()]} value="user:bank" onChange={onChange} />))
    // Trigger reflects the current pick.
    expect(screen.getByRole('button', { name: /Bank statement helper/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Bank statement helper/ }))
    expect(screen.getByRole('menuitemradio', { name: /No skill/ })).toBeInTheDocument()
    // Selecting "No skill" clears it (null).
    await user.click(screen.getByRole('menuitemradio', { name: /No skill/ }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('emits the install_id when a skill is chosen', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(withI18n(<SkillPicker skills={[skill()]} value={null} onChange={onChange} />))
    await user.click(screen.getByRole('button', { name: /No skill/ }))
    await user.click(screen.getByRole('menuitemradio', { name: /Bank statement helper/ }))
    expect(onChange).toHaveBeenCalledWith('user:bank')
  })

  it('pins a one-tap suggestion on top and applies it only when tapped (S8 / DS14)', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillPicker
          skills={[skill()]}
          value={null}
          onChange={onChange}
          suggestion={{ installId: 'user:bank', title: 'Bank statement helper' }}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: /No skill/ }))
    const offer = screen.getByRole('menuitem', { name: /Suggested: Bank statement helper/ })
    expect(offer).toBeInTheDocument()
    // Inert until tapped — onChange not called just by surfacing the offer.
    expect(onChange).not.toHaveBeenCalled()
    await user.click(offer)
    expect(onChange).toHaveBeenCalledWith('user:bank')
  })

  it('hides the suggestion when it is already the active skill', async () => {
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillPicker
          skills={[skill()]}
          value="user:bank"
          onChange={vi.fn()}
          suggestion={{ installId: 'user:bank', title: 'Bank statement helper' }}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: /Bank statement helper/ }))
    expect(screen.queryByRole('menuitem', { name: /Suggested:/ })).not.toBeInTheDocument()
  })
})

describe('per-message skill glyph (Transcript, DS16/§22-A5)', () => {
  function msg(over: Partial<Message>): Message {
    return {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'An answer.',
      createdAt: 't',
      ...over
    }
  }
  function renderTranscript(messages: Message[]): void {
    render(
      withI18n(
        <Transcript
          messages={messages}
          streamingHere={false}
          streamText=""
          streamThinking=""
          thinkingOpen={false}
          onThinkingOpenChange={() => {}}
          emptyState={<div />}
          onCopy={() => {}}
          onSave={() => {}}
          actionsDisabled={false}
        />
      )
    )
  }

  it('renders the skill label (icon + word) on an answer a skill shaped', () => {
    renderTranscript([msg({ skillId: 'user:bank', skillTitle: 'Bank statement helper' })])
    expect(screen.getByText('Skill: Bank statement helper')).toBeInTheDocument()
  })

  it('shows no glyph when the answer carried no skill (or the skill was deleted → null)', () => {
    renderTranscript([msg({ skillId: null, skillTitle: null })])
    expect(screen.queryByText(/^Skill:/)).not.toBeInTheDocument()
  })
})
