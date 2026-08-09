import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// #166: the screen containers had drifted into three undocumented caps (860 / 1100 / 1180px),
// all left-aligned, so the leftover space piled up as a differently-sized right gutter on
// every screen. Guidelines §14 fixes TWO centred tiers — reading 860px (`.screen`) and
// workspace 1180px (docs / translate / images / review) — and these pins keep a third width
// (or a left-aligned container) from creeping back in with a future wave.

const stylesCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'styles.css'),
  'utf8'
)

/** The declaration block of a top-level container rule (`.selector {`, not descendants). */
const rule = (selector: string) =>
  stylesCss.match(new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''

describe('styles.css — screen width tiers (guidelines §14, #166)', () => {
  it('reading tier: .screen caps at 860px and centres (symmetric gutters)', () => {
    const screen = rule('screen')
    expect(screen).toContain('max-width: 860px')
    expect(screen).toContain('margin: 0 auto')
  })

  it.each(['docs-screen', 'translate-screen', 'images-screen', 'review-screen'])(
    'workspace tier: .%s caps at 1180px',
    (selector) => {
      expect(rule(selector)).toContain('max-width: 1180px')
    }
  )

  it('no screen container invents a third width tier', () => {
    const widths = [
      ...stylesCss.matchAll(/^\.[\w-]*screen\s*\{[^}]*?max-width:\s*(\d+)px/gm)
    ].map((m) => Number(m[1]))
    // .screen + the four workspace containers must all be present and on-tier.
    expect(widths.length).toBeGreaterThanOrEqual(5)
    for (const width of widths) expect([860, 1180]).toContain(width)
  })
})
