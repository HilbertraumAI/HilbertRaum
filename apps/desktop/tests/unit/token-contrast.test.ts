import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Brand-refresh guard (docs/design-guidelines brand-refresh record + brand-refresh-plan §9):
// every role-token pairing must clear WCAG 2.2 AA in BOTH themes — text ≥4.5:1, UI/large
// ≥3:1. This both verifies AND PINS the derived teal values, so a later careless edit to
// tokens.css can't silently regress contrast. Pure file parse — no DOM, no renderer.
//
// The central brand constraint: bright teal #57D0A4 fails on light (~1.9:1), so it is never
// text/link/focus/a thin boundary on a light surface; light roles use --brand-teal-dark and
// the primary button pairs the bright teal fill with dark-ink text. Those facts are asserted
// below (incl. the forbidden bright-teal-on-white pairing, to pin the value as the bright one).

const tokensCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'tokens.css'),
  'utf8'
)

/** Strip /* … *​/ comments, then pull every `--name: value;` from a `{ … }` block body. */
function parseDecls(block: string): Record<string, string> {
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Record<string, string> = {}
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim()
  }
  return out
}

/** Body of the first `selector { … }` rule (non-greedy, balanced enough for this flat file). */
function ruleBody(selectorRe: RegExp): string {
  const m = tokensCss.match(selectorRe)
  if (!m) throw new Error(`rule not found: ${selectorRe}`)
  return m[1]
}

const lightVars = parseDecls(ruleBody(/:root\s*\{([\s\S]*?)\n\}/))
const darkVars = { ...lightVars, ...parseDecls(ruleBody(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)) }

/** Resolve a token (e.g. `--link`) to a #rrggbb hex within a theme, following var() chains. */
function resolve(name: string, vars: Record<string, string>, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`var cycle at ${name}`)
  seen.add(name)
  const raw = vars[name]
  if (raw == null) throw new Error(`unknown token ${name}`)
  const varMatch = raw.match(/^var\((--[\w-]+)\)$/)
  if (varMatch) return resolve(varMatch[1], vars, seen)
  const hex = raw.match(/^#([0-9a-fA-F]{6})$/)
  if (!hex) throw new Error(`token ${name} is not a 6-digit hex or var(): "${raw}"`)
  return `#${hex[1].toLowerCase()}`
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.2152 * lin[2]
}

function contrast(aHex: string, bHex: string): number {
  const a = luminance(aHex)
  const b = luminance(bHex)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const THEMES: Array<[string, Record<string, string>]> = [
  ['light', lightVars],
  ['dark', darkVars]
]

describe.each(THEMES)('token contrast — %s theme', (_name, vars) => {
  const c = (fg: string, bg: string) => contrast(resolve(fg, vars), resolve(bg, vars))

  it('body + muted text ≥ 4.5:1 on bg and surface', () => {
    expect(c('--text', '--bg')).toBeGreaterThanOrEqual(4.5)
    expect(c('--text', '--surface')).toBeGreaterThanOrEqual(4.5)
    expect(c('--text-muted', '--bg')).toBeGreaterThanOrEqual(4.5)
    expect(c('--text-muted', '--surface')).toBeGreaterThanOrEqual(4.5)
  })

  it('links ≥ 4.5:1 (text) on bg and surface', () => {
    expect(c('--link', '--bg')).toBeGreaterThanOrEqual(4.5)
    expect(c('--link', '--surface')).toBeGreaterThanOrEqual(4.5)
  })

  it('focus ring + selected-row bar ≥ 3:1 (UI boundary)', () => {
    expect(c('--focus', '--bg')).toBeGreaterThanOrEqual(3)
    expect(c('--focus', '--surface')).toBeGreaterThanOrEqual(3)
    expect(c('--row-selected-bar', '--row-selected-bg')).toBeGreaterThanOrEqual(3)
  })

  it('semantic accents (success/error/warning) ≥ 4.5:1 on bg', () => {
    expect(c('--success', '--bg')).toBeGreaterThanOrEqual(4.5)
    expect(c('--error', '--bg')).toBeGreaterThanOrEqual(4.5)
    expect(c('--warning', '--bg')).toBeGreaterThanOrEqual(4.5)
  })
})

describe('brand teal — theme-constant pairings', () => {
  const c = (fg: string, bg: string) => contrast(resolve(fg, lightVars), resolve(bg, lightVars))

  it('primary button: teal fill + dark-ink text ≥ 4.5:1 (incl. hover/active)', () => {
    expect(c('--brand-teal', '--brand-ink-dark')).toBeGreaterThanOrEqual(4.5)
    expect(c('--brand-teal-hover', '--brand-ink-dark')).toBeGreaterThanOrEqual(4.5)
    expect(c('--brand-teal-active', '--brand-ink-dark')).toBeGreaterThanOrEqual(4.5)
  })

  it('switch-on track (dark teal) carries the white thumb at ≥ 3:1', () => {
    expect(c('--brand-teal-dark', '--n-0')).toBeGreaterThanOrEqual(3)
  })

  it('bright teal on white is FORBIDDEN (< 3:1) — pins it as the bright value', () => {
    expect(c('--brand-teal', '--n-0')).toBeLessThan(3)
  })

  it('the dark-bg nudge keeps body text legible (--text on dark --bg ≥ 4.5:1)', () => {
    expect(contrast(resolve('--text', darkVars), resolve('--bg', darkVars))).toBeGreaterThanOrEqual(4.5)
  })
})
