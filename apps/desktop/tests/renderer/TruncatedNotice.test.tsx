// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, screen, fireEvent } from '@testing-library/react'
import { t } from '../../src/shared/i18n'
import type { EndedEarly, Message } from '../../src/shared/types'
import { assistantMsg, userMsg } from '../helpers/chat-fixtures'
import { renderTranscript } from '../helpers/transcript'

// #498: the cut-off badge used to read "Reply cut off — reached the model's context limit" and its
// tooltip always advised raising the context size — wrong for a grounded reply the app's OWN fixed
// per-reply cap ended. The label now names no cause and `Message.truncatedCause` picks the tooltip;
// a legacy row (flag set, no cause) keeps the old context-window advice.

const CUT = 'An answer that stops mid-'
const Q = 'Tell me about lighthouses.'
/** The question; `endedEarly` marks one a stopped turn left unanswered. */
const ask = (id: string, endedEarly?: EndedEarly): Message => userMsg(id, Q, { endedEarly })

const notice = (): HTMLElement | null => document.querySelector('.msg-truncated')

beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

describe('Transcript truncation notice (#498)', () => {
  it('names no cause in the visible label, in either language', () => {
    renderTranscript({ messages: [assistantMsg('a1', CUT, { truncated: true, truncatedCause: 'cap' })] }, 'en')
    expect(screen.getByText('Reply cut off')).toBeInTheDocument()
    expect(screen.queryByText(/context limit/i)).not.toBeInTheDocument()
    cleanup()
    renderTranscript({ messages: [assistantMsg('a1', CUT, { truncated: true, truncatedCause: 'cap' })] }, 'de')
    expect(screen.getByText('Antwort abgeschnitten')).toBeInTheDocument()
    expect(screen.queryByText(/Kontextlimit/)).not.toBeInTheDocument()
  })

  it.each([
    ['en', 'context', 'raise the context size', true],
    ['en', 'cap', 'raise the context size', false],
    ['de', 'context', 'Kontextgröße', true],
    ['de', 'cap', 'Kontextgröße', false]
  ] as const)(
    '%s: a %s cut-off picks its tooltip; only the window cause advises a bigger context',
    (lang, cause, remedy, advises) => {
      renderTranscript({ messages: [assistantMsg('a1', CUT, { truncated: true, truncatedCause: cause })] }, lang)
      const el = notice()
      expect(el).toHaveAttribute('role', 'note')
      expect(el).toHaveAttribute('title', t(lang, `chat.truncated.hint.${cause}`))
      expect(el?.getAttribute('title')?.includes(remedy)).toBe(advises)
    }
  )

  it('a legacy truncated row with no cause keeps the old context-window advice', () => {
    renderTranscript({ messages: [assistantMsg('a1', CUT, { truncated: true })] }, 'en')
    expect(notice()).toHaveAttribute('title', t('en', 'chat.truncated.hint.context'))
  })

  it('shows nothing on a complete reply or on a user turn', () => {
    renderTranscript({ messages: [assistantMsg('a1', CUT)] }, 'en')
    expect(notice()).toBeNull()
    cleanup()
    renderTranscript({ messages: [userMsg('u1', 'hi', { truncated: true, truncatedCause: 'cap' })] }, 'en')
    expect(notice()).toBeNull()
  })
})

// #600 / #612: a reply that ended before it was finished — the user stopped or switched the model,
// pressed Stop, or locked the workspace / quit — gets its OWN label ("Reply stopped"), never the cut-off
// badge, whose meaning is "the model ran out of room"; the tooltip names the cause. A question such a
// turn left with no answer gets a "Not answered" note naming the cause, which goes once an answer follows.
describe('the "Reply stopped" and "Not answered" notes (#600, #612)', () => {
  const causes: EndedEarly[] = ['model', 'user', 'lock']

  it.each((['en', 'de'] as const).flatMap((lang) => causes.map((cause) => [lang, cause] as const)))(
    '%s: a reply that ended early (%s) shows "Reply stopped" with the hint for its cause',
    (lang, cause) => {
      renderTranscript({ messages: [ask('u1'), assistantMsg('a1', CUT, { endedEarly: cause })] }, lang)
      expect(notice()).toHaveTextContent(t(lang, 'chat.endedEarly.label'))
      expect(notice()).toHaveAttribute('title', t(lang, `chat.endedEarly.hint.${cause}`))
    }
  )

  it.each(causes)('a question a turn that ended early (%s) left unanswered says why', (cause) => {
    renderTranscript({ messages: [ask('u1', cause)] }, 'en')
    expect(notice()).toHaveTextContent(t('en', `chat.unanswered.${cause}`))
  })

  it('once an answer follows the question, the "Not answered" note goes', () => {
    renderTranscript({ messages: [ask('u1', 'user'), assistantMsg('a1', CUT)] }, 'en')
    expect(screen.queryByText(t('en', 'chat.unanswered.user'))).toBeNull()
  })
})

// #613: "Send again" is the way on for a question that got no answer — after an error or a crash
// (which leave no "Not answered" mark) as much as after a stop before the first word. Only the LAST
// question can be sent again (main answers the conversation's last turn), and never while it is
// being answered: the live bubble under it is that answer.
describe('"Send again" under an unanswered last question (#613)', () => {
  const sendAgain = (): HTMLElement | null => screen.queryByRole('button', { name: /Send again|Noch einmal senden/ })

  it.each([
    ['en', 'after an error, which leaves no mark', undefined, '↺ Send again'],
    ['de', 'after a stop before the first word', 'user', '↺ Noch einmal senden']
  ] as const)('%s: %s, the last question offers it and sends its id', (lang, _l, mark, label) => {
    const onSendAgain = vi.fn()
    renderTranscript({ messages: [ask('u1'), assistantMsg('a1', CUT), ask('u2', mark)], onSendAgain }, lang)
    expect(sendAgain()).toHaveTextContent(label)
    fireEvent.click(sendAgain()!)
    expect(onSendAgain).toHaveBeenCalledWith('u2')
  })

  it('is offered under the last question only — not under an answered one, nor an older unanswered one', () => {
    const onSendAgain = vi.fn()
    renderTranscript({ messages: [ask('u1', 'model'), ask('u2')], onSendAgain }, 'en')
    expect(screen.getAllByRole('button', { name: /Send again/ })).toHaveLength(1)
    fireEvent.click(sendAgain()!)
    expect(onSendAgain).toHaveBeenCalledWith('u2')
    cleanup()
    renderTranscript({ messages: [ask('u1', 'model'), assistantMsg('a1', CUT)], onSendAgain }, 'en')
    expect(sendAgain()).toBeNull()
  })

  it('while the question is being answered again, neither "Send again" nor its old note shows', () => {
    renderTranscript({ messages: [ask('u1', 'model')], onSendAgain: vi.fn(), streamingHere: true }, 'en')
    expect(sendAgain()).toBeNull()
    expect(screen.queryByText(t('en', 'chat.unanswered.model'))).toBeNull()
  })
})
