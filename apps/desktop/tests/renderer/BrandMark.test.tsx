// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BrandMark, BrandLockup } from '../../src/renderer/components/BrandMark'

// Brand-refresh BR3 (docs/brand-refresh-plan §9): the mark/lockup pick the theme-correct
// asset via a CSS pair toggle (both images render — the [data-theme] rule shows one), so the
// gate works pre-unlock without a JS theme read. Guards: both theme assets present, min-size
// clamp, decorative vs labelled a11y wiring, and that the vendored public/brand assets exist.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'public')

describe('BrandMark', () => {
  it('renders BOTH theme assets (CSS toggles which shows) — gate-safe, no JS theme read', () => {
    const { container } = render(<BrandMark size={24} />)
    const light = container.querySelector('img.brand-img-light') as HTMLImageElement
    const dark = container.querySelector('img.brand-img-dark') as HTMLImageElement
    // Relative (no leading slash) so it resolves under the production file:// load too.
    expect(light?.getAttribute('src')).toBe('brand/mark-on-light.svg')
    expect(dark?.getAttribute('src')).toBe('brand/mark-on-dark.svg')
  })

  it('clamps size to ≥16px and dev-warns below the minimum', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(<BrandMark size={8} />)
    const img = container.querySelector('img.brand-img-light') as HTMLImageElement
    expect(img.getAttribute('width')).toBe('16')
    expect(img.getAttribute('height')).toBe('16')
    expect(warn).toHaveBeenCalled()
  })

  it('honors the requested size at/above the minimum', () => {
    const { container } = render(<BrandMark size={36} />)
    const img = container.querySelector('img.brand-img-light') as HTMLImageElement
    expect(img.getAttribute('width')).toBe('36')
  })

  it('reserves clear space (wrapper padding > 0)', () => {
    const { container } = render(<BrandMark size={24} />)
    const wrapper = container.querySelector('.brand-img') as HTMLElement
    expect(parseFloat(wrapper.style.padding)).toBeGreaterThan(0)
  })

  it('is decorative by default (hidden from the a11y tree)', () => {
    const { container } = render(<BrandMark />)
    const wrapper = container.querySelector('.brand-img') as HTMLElement
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper.getAttribute('role')).toBeNull()
    // The images themselves never carry an accessible name.
    container.querySelectorAll('img').forEach((img) => expect(img.getAttribute('alt')).toBe(''))
  })

  it('exposes a label when not decorative', () => {
    render(<BrandMark decorative={false} title="HilbertRaum" />)
    expect(screen.getByRole('img', { name: 'HilbertRaum' })).toBeTruthy()
  })
})

describe('BrandLockup', () => {
  it('renders both theme lockups and is labelled by default', () => {
    const { container } = render(<BrandLockup />)
    expect(container.querySelector('img.brand-img-light')?.getAttribute('src')).toBe(
      'brand/lockup-on-light.svg'
    )
    expect(container.querySelector('img.brand-img-dark')?.getAttribute('src')).toBe(
      'brand/lockup-on-dark.svg'
    )
    expect(screen.getByRole('img', { name: 'HilbertRaum' })).toBeTruthy()
  })
})

describe('vendored brand assets exist (offline, same-origin)', () => {
  it.each([
    'brand/mark-on-light.svg',
    'brand/mark-on-dark.svg',
    'brand/lockup-on-light.svg',
    'brand/lockup-on-dark.svg',
    'icon.svg'
  ])('%s is present under public/', (rel) => {
    expect(existsSync(join(publicDir, rel))).toBe(true)
  })
})
