import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// #166: the screen containers had drifted into three undocumented caps (860 / 1100 / 1180px),
// all left-aligned, so the leftover space piled up as a differently-sized right gutter on
// every screen. Guidelines §14 fixes TWO centred tiers — reading 860px (`.screen`) and
// workspace 1180px — and these pins keep a third width (or a left-aligned container) from
// creeping back in with a future wave. #171 (§14 amendment) re-tiered the two card/row-list
// screens (AI model, Skills) from reading to workspace — the same §11.6 "list needs more
// than a reading column" argument that placed docs / translate / images / review.

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

  it('the scroll container reserves the scrollbar gutter on both edges (#171)', () => {
    // Without this, the centred column sits ~8px further left on scrolling pages than on
    // non-scrolling ones — the same-width columns visibly jump between nav clicks.
    expect(rule('content')).toContain('scrollbar-gutter: stable both-edges')
  })

  it.each([
    'docs-screen',
    'translate-screen',
    'images-screen',
    'review-screen',
    'models-screen',
    'skills-screen'
  ])('workspace tier: .%s caps at 1180px', (selector) => {
    expect(rule(selector)).toContain('max-width: 1180px')
  })

  it('no screen container invents a third width tier', () => {
    const widths = [
      ...stylesCss.matchAll(/^\.[\w-]*screen\s*\{[^}]*?max-width:\s*(\d+)px/gm)
    ].map((m) => Number(m[1]))
    // .screen + the six workspace containers must all be present and on-tier.
    expect(widths.length).toBeGreaterThanOrEqual(7)
    for (const width of widths) expect([860, 1180]).toContain(width)
  })
})
