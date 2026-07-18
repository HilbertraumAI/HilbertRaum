import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SECURE_WINDOW_WEB_PREFERENCES,
  buildCsp,
  createWindowOpenPolicy
} from '../../src/main/window-security'

// TS-2 (full-audit 2026-07-10): the BrowserWindow hardening flags, the CSP strings, and
// the window-open policy are the app's renderer security posture — before this pin, a
// one-character weakening (`sandbox: false`) shipped green through the whole suite. The
// literals live in src/main/window-security.ts; these tests ARE the contract, so a
// deliberate change here must be a deliberate security decision. The expected strings
// below were copied verbatim from the pre-extraction index.ts (behavior-neutral move).

describe('SECURE_WINDOW_WEB_PREFERENCES (both windows: main + OCR rasterizer)', () => {
  it('pins every hardening flag by name and value — and nothing else', () => {
    // toEqual is exact: a dropped flag, a flipped value, or a smuggled extra key fails.
    expect(SECURE_WINDOW_WEB_PREFERENCES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
  })

  it('is frozen — call sites cannot mutate the shared object', () => {
    expect(Object.isFrozen(SECURE_WINDOW_WEB_PREFERENCES)).toBe(true)
  })
})

describe('buildCsp', () => {
  it('production CSP matches the contract string exactly', () => {
    expect(buildCsp(false)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'"
    )
  })

  it('dev CSP matches the contract string exactly', () => {
    expect(buildCsp(true)).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; " +
        "img-src 'self' data:; font-src 'self'"
    )
  })

  it('the dev relaxation is localhost-only — no other origin appears in either CSP', () => {
    // Every scheme://host source in either policy must be a localhost dev-server origin
    // (Vite HMR). 'self'/'none'/'unsafe-*' keywords and data: carry no host and don't match.
    for (const isDev of [true, false]) {
      const origins = buildCsp(isDev).match(/[a-z]+:\/\/[^\s;]+/g) ?? []
      for (const origin of origins) {
        expect(origin).toMatch(/^(ws|http):\/\/localhost:\*$/)
      }
    }
    // And prod allows NO remote origin at all.
    expect(buildCsp(false)).not.toMatch(/[a-z]+:\/\//)
  })

  it('production never carries the dev relaxations', () => {
    const prod = buildCsp(false)
    expect(prod).not.toContain('unsafe-eval')
    expect(prod).not.toContain('localhost')
  })
})

describe('createWindowOpenPolicy (main window)', () => {
  function open(url: string): { opened: string[]; action: string } {
    const opened: string[] = []
    const policy = createWindowOpenPolicy((u) => opened.push(u))
    const { action } = policy({ url })
    return { opened, action }
  }

  it('http(s) URLs go to the OS browser — and the in-app open is still denied', () => {
    expect(open('https://example.com/docs')).toEqual({
      opened: ['https://example.com/docs'],
      action: 'deny'
    })
    expect(open('http://example.com/')).toEqual({
      opened: ['http://example.com/'],
      action: 'deny'
    })
  })

  it('non-web schemes are dropped entirely (file://, smb://, javascript: never reach the OS handler)', () => {
    for (const url of [
      'file:///etc/passwd',
      'smb://attacker/share',
      'javascript:alert(1)',
      'chrome://settings'
    ]) {
      expect(open(url)).toEqual({ opened: [], action: 'deny' })
    }
  })

  it('a malformed URL is denied without throwing', () => {
    expect(open('not a url')).toEqual({ opened: [], action: 'deny' })
    expect(open('')).toEqual({ opened: [], action: 'deny' })
  })

  it('openExternal is fire-and-forget — the policy still denies synchronously', () => {
    const openExternal = vi.fn()
    const policy = createWindowOpenPolicy(openExternal)
    expect(policy({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})

describe('call-site wiring (the flags cannot be re-inlined)', () => {
  // The unit pins above are worthless if index.ts stops using the module — so pin the
  // wiring at source level too (idiom: ocr.test.ts preload-channel contract). A
  // re-inlined `sandbox: false` after the spread would fail the no-inline-literal scan.
  const indexSrc = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
  const rasterizerSrc = readFileSync(
    join(__dirname, '../../src/main/services/ocr/rasterizer.ts'),
    'utf8'
  )
  // P6: the evidence-pack PDF print harness is the THIRD hidden-window call site.
  const printPdfSrc = readFileSync(
    join(__dirname, '../../src/main/services/evidence-pack/print-pdf.ts'),
    'utf8'
  )

  it('all three windows spread SECURE_WINDOW_WEB_PREFERENCES', () => {
    expect(indexSrc).toContain('...SECURE_WINDOW_WEB_PREFERENCES')
    expect(rasterizerSrc).toContain('...SECURE_WINDOW_WEB_PREFERENCES')
    expect(printPdfSrc).toContain('...SECURE_WINDOW_WEB_PREFERENCES')
  })

  it('index.ts takes the CSP from buildCsp and the window-open handler from createWindowOpenPolicy', () => {
    expect(indexSrc).toContain('buildCsp(isDev)')
    expect(indexSrc).toContain('createWindowOpenPolicy(')
  })

  it('no security literal survives inline at any call site', () => {
    for (const src of [indexSrc, rasterizerSrc, printPdfSrc]) {
      expect(src).not.toMatch(/contextIsolation\s*:/)
      expect(src).not.toMatch(/nodeIntegration\s*:/)
      expect(src).not.toMatch(/\bsandbox\s*:/)
      expect(src).not.toMatch(/webSecurity\s*:/)
      expect(src).not.toContain('default-src') // the CSP is not re-inlined either
    }
  })

  it('the print window is preload-FREE (plan §11: sandbox, no preload, no node)', () => {
    // Unlike the other two windows, the print page has no IPC surface at all — a
    // `preload:` appearing in print-pdf.ts would silently widen it.
    expect(printPdfSrc).not.toMatch(/preload\s*:/)
  })
})
