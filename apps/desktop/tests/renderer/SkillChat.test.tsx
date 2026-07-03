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

describe('SkillPicker — closed-trigger suggestion hint (U-3)', () => {
  const offer = { installId: 'user:bank', title: 'Bank statement helper' }

  it('surfaces the suggestion on the CLOSED trigger and selects it on one tap', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(withI18n(<SkillPicker skills={[skill()]} value={null} onChange={onChange} suggestion={offer} />))
    // Visible WITHOUT opening the picker — the dropdown is still closed (no menu items rendered).
    const hint = screen.getByRole('button', { name: /^Suggested: Bank statement helper$/ })
    expect(hint).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
    // Inert until tapped — surfacing it applies nothing.
    expect(onChange).not.toHaveBeenCalled()
    await user.click(hint)
    expect(onChange).toHaveBeenCalledWith('user:bank')
  })

  it('shows no closed-trigger hint when a skill is already selected (even for a different offer)', () => {
    render(
      withI18n(
        <SkillPicker
          skills={[skill(), skill({ installId: 'user:invoice', id: 'invoice', title: 'Invoice helper' })]}
          value="user:bank"
          onChange={vi.fn()}
          suggestion={{ installId: 'user:invoice', title: 'Invoice helper' }}
        />
      )
    )
    expect(screen.queryByRole('button', { name: /^Suggested:/ })).not.toBeInTheDocument()
  })

  it('hides the closed-trigger hint once the user declines it (suggestionDismissed)', () => {
    render(
      withI18n(
        <SkillPicker skills={[skill()]} value={null} onChange={vi.fn()} suggestion={offer} suggestionDismissed />
      )
    )
    expect(screen.queryByRole('button', { name: /^Suggested:/ })).not.toBeInTheDocument()
  })

  it('clears the closed-trigger hint once a skill is picked', () => {
    const { rerender } = render(
      withI18n(<SkillPicker skills={[skill()]} value={null} onChange={vi.fn()} suggestion={offer} />)
    )
    expect(screen.getByRole('button', { name: /^Suggested:/ })).toBeInTheDocument()
    rerender(
      withI18n(<SkillPicker skills={[skill()]} value="user:bank" onChange={vi.fn()} suggestion={offer} />)
    )
    expect(screen.queryByRole('button', { name: /^Suggested:/ })).not.toBeInTheDocument()
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

// U3 (audit §4.3): per-turn apply — the persistent composer chip's × (clears override + saved
// default) and the explicit "keep for this conversation" opt-in checkbox. Pure component; the screen
// wiring (per-turn resolution, keep persistence) is covered by the turn/IPC service tests.
describe('SkillPicker — per-turn chip × + keep toggle (U3, audit §4.3)', () => {
  it('renders the persistent × only when a skill is active and fires onClear', async () => {
    const onClear = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      withI18n(<SkillPicker skills={[skill()]} value={null} onChange={vi.fn()} onClear={onClear} />)
    )
    // No skill → no × chip.
    expect(screen.queryByRole('button', { name: /Clear skill/ })).not.toBeInTheDocument()
    rerender(withI18n(<SkillPicker skills={[skill()]} value="user:bank" onChange={vi.fn()} onClear={onClear} />))
    await user.click(screen.getByRole('button', { name: /Clear skill Bank statement helper/ }))
    expect(onClear).toHaveBeenCalled()
  })

  it('offers "keep for this conversation" reflecting keptForConversation and toggling it', async () => {
    const onKeepChange = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillPicker
          skills={[skill()]}
          value="user:bank"
          onChange={vi.fn()}
          keptForConversation={false}
          onKeepChange={onKeepChange}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: /Bank statement helper/ }))
    const keep = screen.getByRole('menuitemcheckbox', { name: /Keep for this conversation/ })
    expect(keep).toHaveAttribute('aria-checked', 'false')
    await user.click(keep)
    expect(onKeepChange).toHaveBeenCalledWith(true)
  })

  it('shows the keep checkbox CHECKED when the pick is the saved default', async () => {
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillPicker skills={[skill()]} value="user:bank" onChange={vi.fn()} keptForConversation onKeepChange={vi.fn()} />
      )
    )
    await user.click(screen.getByRole('button', { name: /Bank statement helper/ }))
    expect(screen.getByRole('menuitemcheckbox', { name: /Keep for this conversation/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('hides the keep checkbox (and ×) when no skill is active', async () => {
    const user = userEvent.setup()
    render(withI18n(<SkillPicker skills={[skill()]} value={null} onChange={vi.fn()} onClear={vi.fn()} onKeepChange={vi.fn()} />))
    expect(screen.queryByRole('button', { name: /Clear skill/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /No skill/ }))
    expect(screen.queryByRole('menuitemcheckbox', { name: /Keep for this conversation/ })).not.toBeInTheDocument()
  })
})

// U3 (audit §4.3): the "answer without it" undo now rides EVERY skill-stamped last turn — a per-turn
// pick must be as reversible as an auto-fire, so no skill-shaped answer is a dead end.
describe('per-message "answer without it" undo — extended to picked turns (U3)', () => {
  function msg(over: Partial<Message>): Message {
    return { id: 'm1', conversationId: 'c1', role: 'assistant', content: 'An answer.', createdAt: 't', ...over }
  }
  function renderT(messages: Message[], onAnswerWithoutSkill?: () => void): void {
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
          onAnswerWithoutSkill={onAnswerWithoutSkill}
          onCopy={() => {}}
          onSave={() => {}}
          actionsDisabled={false}
        />
      )
    )
  }

  it('offers the undo on the last EXPLICITLY-PICKED skill turn (keeps the plain "Skill: …" glyph)', async () => {
    const onAnswerWithoutSkill = vi.fn()
    const user = userEvent.setup()
    renderT([msg({ skillId: 'user:bank', skillTitle: 'Bank statement helper', autoFired: false })], onAnswerWithoutSkill)
    // A picked turn reads "Skill: …" (not the auto-fire "Answered with …"), and still carries the undo.
    expect(screen.getByText('Skill: Bank statement helper')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Answer without it' }))
    expect(onAnswerWithoutSkill).toHaveBeenCalled()
  })

  it('still offers the undo on an auto-fired last turn (unchanged)', () => {
    renderT([msg({ skillId: 'user:bank', skillTitle: 'Bank statement helper', autoFired: true })], vi.fn())
    expect(screen.getByText('Answered with Bank statement helper')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Answer without it' })).toBeInTheDocument()
  })

  it('renders no undo when no handler is provided, even on a skill-stamped last turn', () => {
    renderT([msg({ skillId: 'user:bank', skillTitle: 'Bank statement helper', autoFired: false })], undefined)
    expect(screen.queryByRole('button', { name: 'Answer without it' })).not.toBeInTheDocument()
  })

  it('does not offer the undo on a NON-last skill turn', () => {
    renderT(
      [
        msg({ id: 'm1', skillId: 'user:bank', skillTitle: 'Bank statement helper', autoFired: false }),
        msg({ id: 'm2', role: 'user', content: 'a follow-up' }),
        msg({ id: 'm3', content: 'A later, skill-free answer.', skillId: null, skillTitle: null })
      ],
      vi.fn()
    )
    // The skill glyph sits on m1, but the undo only rides the LAST assistant turn (m3, skill-free).
    expect(screen.getByText('Skill: Bank statement helper')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Answer without it' })).not.toBeInTheDocument()
  })
})
