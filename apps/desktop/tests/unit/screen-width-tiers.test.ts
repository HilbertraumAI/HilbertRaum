import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// #166 found the screen containers drifted into three undocumented left-aligned caps; #171
// first re-tiered the card/list screens, then the owner's live review settled the end state
// (guidelines §14 as amended): ONE centred 1180px width for every screen — the same frame
// and orientation on every page — with the READING measure protected one level down by 72ch
// caps on the prose roles. These pins keep per-screen widths (the drift §14 closed) from
// coming back, and keep the prose caps that make the single wide frame readable.

const stylesCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'styles.css'),
  'utf8'
)

/** The declaration block of a top-level container rule (`.selector {`, not descendants). */
const rule = (selector: string) =>
  stylesCss.match(new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''

describe('styles.css — the single screen width (guidelines §14, #166/#171)', () => {
  it('.screen is the one width: 1180px, centred (symmetric gutters)', () => {
    const screen = rule('screen')
    expect(screen).toContain('max-width: 1180px')
    expect(screen).toContain('margin: 0 auto')
  })

  it('no per-screen container re-introduces its own max-width', () => {
    // Every `.<something>-screen { … }` container rule must inherit the shared frame.
    const offenders = [...stylesCss.matchAll(/^(\.[\w-]+-screen)\s*\{([^}]*)\}/gm)]
      .filter(([, , body]) => /max-width/.test(body))
      .map(([, selector]) => selector)
    expect(offenders).toEqual([])
  })

  it('the scroll container reserves the scrollbar gutter on both edges (#171)', () => {
    // Without this, the centred column sits ~8px further left on scrolling pages than on
    // non-scrolling ones — the same-width columns visibly jump between nav clicks.
    expect(rule('content')).toContain('scrollbar-gutter: stable both-edges')
  })

  it.each(['lead', 'hint', 'offline-statement'])(
    'prose role .%s keeps the 72ch reading measure inside the wide frame',
    (selector) => {
      expect(rule(selector)).toContain('max-width: 72ch')
    }
  )
})
