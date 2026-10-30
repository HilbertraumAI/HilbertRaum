// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { ContextMeter } from '../../src/renderer/chat/ContextMeter'
import { t, type UiLanguage } from '../../src/shared/i18n'
import type { ContextUsage } from '../../src/shared/types'
import { renderInLanguage } from '../helpers/render-language'

// Beta-feedback plan Phase 2 (#25, D69) — the composer-footer indicator is a conversation-MEMORY
// gauge, not a progress bar. It must (a) expose role="meter" (a current level), never
// "progressbar" (task progress, the #25 misreading), (b) render a visible short label naming the
// gauge, and (c) teach the fill/auto-summarize mental model in the tooltip. EN + DE.
// Copy assertions reference the catalogs (D-L8), never re-typed literals.

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function usage(usedTokens: number, window = 100): ContextUsage {
  return { usedTokens, window }
}

const renderMeter = (lang: UiLanguage, u: ContextUsage): HTMLElement =>
  renderInLanguage(<ContextMeter usage={u} />, lang).container

describe('ContextMeter — memory gauge, not a progress bar (#25, D69)', () => {
  it('exposes role="meter", never role="progressbar"', () => {
    const container = renderMeter('en', usage(40))
    const meter = container.querySelector('.context-meter')
    expect(meter?.getAttribute('role')).toBe('meter')
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    // A meter still carries the value range so an AT announces the level.
    expect(meter?.getAttribute('aria-valuemin')).toBe('0')
    expect(meter?.getAttribute('aria-valuemax')).toBe('100')
    expect(meter?.getAttribute('aria-valuenow')).toBe('40')
  })

  it('renders the visible short label + % (English) and names the meter with it', () => {
    const container = renderMeter('en', usage(40))
    const meter = container.querySelector('.context-meter')
    expect(container.querySelector('.context-meter-label')?.textContent).toBe(
      t('en', 'chat.context.label')
    )
    expect(container.querySelector('.context-meter-pct')?.textContent).toBe('40%')
    // aria-label is the label; the token reading rides aria-valuetext/title.
    expect(meter?.getAttribute('aria-label')).toBe(t('en', 'chat.context.label'))
  })

  it('renders the German label (forced via the localStorage mirror, GermanSmoke pattern)', () => {
    const container = renderMeter('de', usage(40))
    expect(container.querySelector('.context-meter-label')?.textContent).toBe(
      t('de', 'chat.context.label')
    )
    // Sanity: the German copy actually flowed through t() (not the English literal).
    expect(t('de', 'chat.context.label')).not.toBe(t('en', 'chat.context.label'))
  })

  it('CODE-41: the German tooltip uses the locale decimal separator ("6,4k") in title AND aria-valuetext', () => {
    // 6400 of 12800 tokens = 50% (calm, no will-summarize suffix): fmtTokens must render
    // "6,4k von 12,8k" in German — the bare toFixed shipped "6.4k" (full-audit 2026-07-11
    // CODE-41; M-U5 convention, the DiagnosticsTab.fmt1 / formatSize treatment).
    const container = renderMeter('de', usage(6400, 12800))
    const meter = container.querySelector('.context-meter')
    const expected = t('de', 'chat.context.usageTooltip', {
      pct: '50',
      used: '6,4k',
      window: '12,8k'
    })
    expect(expected).toContain('6,4k') // guard: the assertion below really checks the comma form
    expect(meter?.getAttribute('title')).toBe(expected)
    expect(meter?.getAttribute('aria-valuetext')).toBe(expected)
    // English output stays byte-identical to the previous toFixed form.
    cleanup()
    const enContainer = renderMeter('en', usage(6400, 12800))
    expect(enContainer.querySelector('.context-meter')?.getAttribute('title')).toBe(
      t('en', 'chat.context.usageTooltip', { pct: '50', used: '6.4k', window: '12.8k' })
    )
  })

  it('below the amber band the tooltip omits the will-summarize heads-up', () => {
    const container = renderMeter('en', usage(74)) // 74% — the last calm percent
    const meter = container.querySelector('.context-meter')
    expect(meter?.className).toContain('context-meter-calm')
    expect(meter?.getAttribute('title')).not.toContain(t('en', 'chat.context.willSummarize'))
    // The mental-model tooltip still teaches the fill (via the {pct} rewrite, approximate tokens).
    expect(meter?.getAttribute('title')).toBe(
      t('en', 'chat.context.usageTooltip', { pct: '74', used: '74', window: '100' })
    )
  })

  it('at/above 75% (amber) the tooltip adds the will-summarize copy', () => {
    const container = renderMeter('en', usage(6000, 8000)) // exactly 75% — the amber boundary
    const meter = container.querySelector('.context-meter')
    expect(meter?.className).toContain('context-meter-amber')
    // The exact tooltip: whole thousands read '6k' / '8k' (no '.0'), then the heads-up line.
    const expected = `${t('en', 'chat.context.usageTooltip', { pct: '75', used: '6k', window: '8k' })} ${t('en', 'chat.context.willSummarize')}`
    expect(meter?.getAttribute('title')).toBe(expected)
    expect(meter?.getAttribute('aria-valuetext')).toBe(expected)
  })

  it('at/above 90% carries the near-full tone class', () => {
    const container = renderMeter('en', usage(90)) // exactly 90% — the near-full boundary
    const meter = container.querySelector('.context-meter')
    expect(meter?.className).toContain('context-meter-near-full')
    expect(meter?.getAttribute('aria-valuenow')).toBe('90')
    // One percent below stays amber.
    cleanup()
    const below = renderMeter('en', usage(89)).querySelector('.context-meter')
    expect(below?.className).toContain('context-meter-amber')
    expect(below?.className).not.toContain('context-meter-near-full')
  })

  it('renders nothing when the window is unknown (<= 0)', () => {
    const container = renderMeter('en', usage(10, 0))
    expect(container.querySelector('.context-meter')).toBeNull()
  })
})
