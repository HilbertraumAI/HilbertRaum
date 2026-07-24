import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// DV-1 — native <select> controls must not fall back to the user agent's own skin.
//
// A <select> with no class renders in Chromium's defaults: Arial (not --font-sans), square
// corners (not --radius-sm), and a UA border/fill instead of --border-strong/--surface — so it
// reads as foreign on both themes and breaks design-guidelines §6 ("Inputs") + §4.4
// (typography). The shared `.select` rule in styles.css is the one place that maps a dropdown
// onto the role tokens; this guard pins BOTH halves: the rule keeps carrying the tokens, and
// the screens that own a picker <select> keep opting into it.
//
// Pure file parse — jsdom loads no stylesheet, so a rendered computed style would prove
// nothing here; the live computed-style probe lives in the design walk, not in the suite.

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer')
const stylesCss = readFileSync(join(renderer, 'styles.css'), 'utf8')

/** Body of the `.select { … }` rule with comments stripped. */
function selectRule(): string {
  const m = stylesCss.match(/\n\.select\s*\{([\s\S]*?)\n\}/)
  if (!m) throw new Error('the shared `.select` rule is missing from styles.css')
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('DV-1 — the shared `.select` token treatment', () => {
  it('maps every property the UA default overrides onto a role token', () => {
    const body = selectRule()
    expect(body).toMatch(/font-family:\s*var\(--font-sans\)/)
    expect(body).toMatch(/border-radius:\s*var\(--radius-sm\)/)
    expect(body).toMatch(/border:\s*1px solid var\(--border-strong\)/)
    expect(body).toMatch(/background:\s*var\(--surface\)/)
    expect(body).toMatch(/color:\s*var\(--text\)/)
  })

  it('never hardcodes a colour — both themes come from the same rule', () => {
    // Role tokens flip with [data-theme]; a literal hex or rgb() would pin one theme's palette
    // onto the other, which is exactly the failure this rule exists to prevent.
    expect(selectRule()).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/)
  })

  it('clears the 24px minimum target size (§9 / WCAG 2.5.8)', () => {
    const m = selectRule().match(/min-height:\s*(\d+)px/)
    expect(m).not.toBeNull()
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(24)
  })
})

describe('DV-1 — every screen that owns a <select> opts into the treatment', () => {
  // The design review named the context-size picker (AI Model) and the Translate language bar.
  // The Documents translate modal renders the IDENTICAL from/to language pair as the Translate
  // screen, and the Diagnostics activity filter is the same kind of control, so all four files
  // are covered — styling only two of them would leave the same control looking different on
  // two routes to the same task. A new <select> added to any of them without the class would
  // silently reintroduce the UA skin, so the guard is over the FILE, not over a fixed count.
  //
  // `.review-relation select` (review/EvidencePane.tsx) is deliberately NOT here: it already
  // carries its own older, lighter treatment, and moving it onto `.select` is a real restyle of
  // a review-screen control that needs its own visual pass.
  for (const file of [
    'screens/ModelsScreen.tsx',
    'screens/TranslateScreen.tsx',
    'screens/DocumentsScreen.tsx',
    'screens/settings/DiagnosticsTab.tsx'
  ]) {
    it(`every <select> in ${file} carries className="select"`, () => {
      // Strip comments first: the prose in these files talks ABOUT `<select>` elements.
      const src = readFileSync(join(renderer, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
      const opened = [...src.matchAll(/<select\b([\s\S]*?)>/g)].map((m) => m[1])
      expect(opened.length).toBeGreaterThan(0)
      for (const attrs of opened) expect(attrs).toContain('className="select"')
    })
  }
})
