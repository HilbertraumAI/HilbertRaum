// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #147 coverage add: the CSS-token APPLICATION seam. Theme.test.tsx checks only that the
// data-theme attribute lands on <html>; token-contrast.test.ts checks only static values in
// tokens.css. Neither would catch a broken dark-theme SELECTOR (e.g. a typo'd attribute
// name) — the attribute would flip, the static values would pass, and the app would render
// light tokens in dark mode. jsdom cannot cascade custom properties into getComputedStyle,
// so this pins the wiring: the real stylesheet's dark rule must MATCH the documentElement
// exactly when (and only when) the attribute the theme module writes is set, and that rule
// must actually redefine the load-bearing surface tokens.

const tokensCss = readFileSync(
  join(__dirname, '..', '..', 'src', 'renderer', 'tokens.css'),
  'utf8'
)

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.head.querySelectorAll('style[data-test]').forEach((s) => s.remove())
})

function loadTokens(): CSSStyleSheet {
  const style = document.createElement('style')
  style.setAttribute('data-test', 'tokens')
  style.textContent = tokensCss
  document.head.appendChild(style)
  return style.sheet as CSSStyleSheet
}

describe('tokens.css — dark-theme selector wiring (#147)', () => {
  it("the dark rule's selector matches <html> exactly when data-theme='dark' is set", () => {
    const sheet = loadTokens()
    const darkRules = [...sheet.cssRules].filter(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes('data-theme')
    )
    expect(darkRules.length).toBeGreaterThan(0)

    const root = document.documentElement
    // Light (no attribute): the dark rule must NOT apply.
    for (const rule of darkRules) expect(root.matches(rule.selectorText)).toBe(false)
    // Dark: the module-owned attribute value must satisfy the real selector.
    root.setAttribute('data-theme', 'dark')
    expect(darkRules.some((rule) => root.matches(rule.selectorText))).toBe(true)
  })

  it('the dark rule redefines the load-bearing surface tokens (the flip has substance)', () => {
    const sheet = loadTokens()
    const dark = [...sheet.cssRules].find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes('data-theme')
    )
    expect(dark).toBeDefined()
    for (const token of ['--bg', '--surface', '--text', '--accent', '--focus']) {
      expect(dark!.style.getPropertyValue(token), `${token} missing from the dark rule`).not.toBe('')
    }
    // …and with DIFFERENT values than the light :root, so the attribute flip changes pixels.
    const light = [...sheet.cssRules].find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.trim() === ':root'
    )
    expect(light).toBeDefined()
    expect(dark!.style.getPropertyValue('--bg')).not.toBe(light!.style.getPropertyValue('--bg'))
  })
})
