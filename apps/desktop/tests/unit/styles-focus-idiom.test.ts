import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// SH-3 (frontend audit 2026-08-09, #146): the Translate input's focus ring referenced an
// UNDEFINED --focus-ring token, so a hardcoded translucent-blue fallback always won — the
// single escape from the token system in styles.css, and (via `outline: none` + box-shadow)
// an invisible focus indicator under forced-colors. These pins keep both from coming back;
// token-contrast.test.ts can't (it reads tokens.css, not styles.css).

const stylesCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'styles.css'),
  'utf8'
)

describe('styles.css — focus idiom (SH-3)', () => {
  it('never references the undefined --focus-ring token', () => {
    expect(stylesCss).not.toMatch(/--focus-ring/)
  })

  it('carries no hardcoded blue focus fallback', () => {
    expect(stylesCss).not.toMatch(/rgba\(\s*80\s*,\s*130\s*,\s*255/)
  })

  it('the translate input uses the outline idiom (forced-colors keeps outlines, drops shadows)', () => {
    const rule = stylesCss.match(/\.translate-input:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('outline: 2px solid var(--focus)')
    expect(rule).not.toContain('outline: none')
  })
})
