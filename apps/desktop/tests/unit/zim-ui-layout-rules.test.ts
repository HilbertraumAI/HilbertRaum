import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Knowledge-pack layout rules (#301 P6, plan §9.23 (d)) that jsdom cannot hold behaviourally —
// it lays nothing out, so "a 200-character title wraps inside the 360 px popover" and "the
// composer chip ellipsises instead of pushing the send button off a 900 px window" can only be
// pinned at the stylesheet. This is a SOURCE pin (the same idiom as screen-width-tiers.test.ts):
// it proves the rule is present, not that it looks right — the visual half is T18-b, the owner's
// real-Electron review. Colour is deliberately NOT asserted here: token-contrast.test.ts owns it.
// Comments are stripped once: they cite the issue number (`#301`), which would otherwise read
// as a hex colour to the literal-colour net below.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'styles.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the FIRST rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
  const m = re.exec(css)
  if (!m) throw new Error(`no rule for ${selector}`)
  return m[2].replace(/\s+/g, ' ').trim()
}

describe('knowledge-pack layout rules (#301 P6) — the stylesheet carries what jsdom cannot measure', () => {
  it('a long / non-ASCII pack title wraps inside the sources popover row', () => {
    expect(rule('.scope-source-name')).toContain('overflow-wrap: anywhere')
    expect(rule('.scope-source-name')).toContain('min-width: 0')
  })

  it('the "Answering from" chip ellipsises a long pack title instead of overflowing the footer', () => {
    const label = rule('.scope-chip-label')
    expect(label).toContain('overflow: hidden')
    expect(label).toContain('text-overflow: ellipsis')
    expect(label).toContain('white-space: nowrap')
    expect(rule('.scope-footer-wrap .footer-menu-btn')).toContain('min-width: 0')
  })

  it('the pack card head wraps a long title with its badges; the list is a reset <ul>', () => {
    expect(rule('.packs-card-head')).toContain('flex-wrap: wrap')
    expect(rule('.packs-card-title')).toContain('overflow-wrap: anywhere')
    expect(rule('.packs-list')).toContain('list-style: none')
  })

  it('the link-styled pack actions meet the 24 px minimum target (WCAG 2.5.8)', () => {
    expect(rule('.source-card-open')).toContain('min-height: 24px')
    expect(rule('.pack-outcomes-toggle')).toContain('min-height: 24px')
  })

  it('the knowledge-pack blocks use role tokens only — no literal colour', () => {
    // The knowledge-pack block is the stylesheet's tail, from `.scope-packs` onwards.
    const start = css.indexOf('\n.scope-packs ')
    expect(start).toBeGreaterThan(0)
    const block = css.slice(start)
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(block).not.toMatch(/\brgba?\(/)
    for (const sel of ['.pack-outcomes', '.pack-outcomes-toggle', '.pack-outcome-title']) {
      expect(rule(sel)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/)
    }
  })
})
