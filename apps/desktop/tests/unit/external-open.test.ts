import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import {
  createExternalOpener,
  describeUrlForDisplay,
  EXTERNAL_URL_DISPLAY_BUDGET
} from '../../src/main/external-open'

// #236 (owner decision #221 — "confirmation"): every http(s) `window.open` the renderer issues
// reaches the OS browser ONLY through a native confirmation that names the site. Before this
// module existed, `index.ts` wired `createWindowOpenPolicy((url) => void shell.openExternal(url))`
// — the URL went straight from the untrusted renderer to `shell.openExternal`, unconfirmed and
// unthrottled (a compromised renderer could page everything it can read out through visible
// browser windows). The opener is unit-tested with a fake `dialog` / `shell`; the wiring pin at
// the end keeps `index.ts` on it.

type Shown = { window: unknown; options: Record<string, unknown> }

function harness(opts: { response?: number; hold?: boolean; reject?: boolean } = {}) {
  const shown: Shown[] = []
  const opened: string[] = []
  let release: (() => void) | null = null
  const dialog = {
    showMessageBox: vi.fn(async (window: unknown, options: Record<string, unknown>) => {
      shown.push({ window, options })
      if (opts.reject) throw new Error('dialog failed')
      if (opts.hold) await new Promise<void>((r) => (release = r))
      return { response: opts.response ?? 1, checkboxChecked: false }
    })
  }
  const shell = {
    openExternal: vi.fn(async (url: string) => {
      opened.push(url)
    })
  }
  const window = { id: 'main', isDestroyed: () => false }
  const open = createExternalOpener({
    dialog: dialog as never,
    shell: shell as never,
    getWindow: () => window as never,
    t: (key: MessageKey, params?: MessageParams) => t('en', key, params)
  })
  const settle = async (): Promise<void> => {
    // Two microtask turns: the dialog promise, then the openExternal continuation.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { open, shown, opened, window, release: () => release?.(), settle }
}

describe('createExternalOpener (#236) — consent before any OS browser open', () => {
  it('confirmed → exactly one openExternal with the normalised URL; the dialog names the origin', async () => {
    const h = harness({ response: 0 })
    h.open('https://Example.COM/a b?q=1#frag')
    await h.settle()
    expect(h.opened).toEqual(['https://example.com/a%20b?q=1#frag'])
    expect(h.shown).toHaveLength(1)
    const { window, options } = h.shown[0]
    expect(window).toBe(h.window) // modal to the main window when one exists
    expect(options.type).toBe('question')
    expect(options.buttons).toEqual(['Open', 'Cancel'])
    expect(options.defaultId).toBe(1) // Enter = Cancel
    expect(options.cancelId).toBe(1) // Esc = Cancel
    expect(options.message).toBe('Open this link in your browser?')
    expect(String(options.detail)).toContain('https://example.com') // the origin, on its own line
    expect(String(options.detail)).toContain('https://example.com/a%20b?q=1#frag') // the full URL
  })

  it('cancelled → nothing is opened', async () => {
    const h = harness({ response: 1 })
    h.open('https://example.com/docs')
    await h.settle()
    expect(h.shown).toHaveLength(1)
    expect(h.opened).toEqual([])
  })

  it('a URL over the display budget: the origin is shown, the cut is marked, the full URL is what opens', async () => {
    const long = 'https://example.com/' + 'p'.repeat(EXTERNAL_URL_DISPLAY_BUDGET * 3) + '?k=v'
    const h = harness({ response: 0 })
    h.open(long)
    await h.settle()
    expect(h.opened).toEqual([long])
    const detail = String(h.shown[0].options.detail)
    const { shown, hidden } = describeUrlForDisplay(long)
    expect(hidden).toBeGreaterThan(0)
    expect(detail).toContain(shown)
    expect(detail).not.toContain(long) // the untruncated string never appears in the dialog
    expect(detail).toContain(`${hidden} more characters`)
    // A display truncation that lost the origin would let a look-alike path masquerade as the
    // site: the shown string must still parse to the SAME origin as what opens.
    expect(new URL(shown).origin).toBe(new URL(h.opened[0]).origin)
  })

  it('a second request while a dialog is open is dropped — not shown, not opened', async () => {
    const h = harness({ response: 0, hold: true })
    h.open('https://first.example/')
    h.open('https://second.example/')
    h.open('https://third.example/')
    await h.settle()
    expect(h.shown).toHaveLength(1)
    expect(h.opened).toEqual([])
    h.release()
    await h.settle()
    expect(h.opened).toEqual(['https://first.example/'])
    // The guard resets once the dialog settles: a later request is shown again.
    h.open('https://fourth.example/')
    await h.settle()
    expect(h.shown).toHaveLength(2)
    expect(h.opened).toEqual(['https://first.example/', 'https://fourth.example/'])
  })

  it('a dialog failure resets the guard and opens nothing', async () => {
    const h = harness({ reject: true })
    h.open('https://example.com/')
    await h.settle()
    expect(h.opened).toEqual([])
    h.open('https://example.com/again')
    await h.settle()
    expect(h.shown).toHaveLength(2)
  })

  it('non-web schemes never reach the dialog (defence in depth behind the window-open policy)', async () => {
    const h = harness({ response: 0 })
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'smb://x/y', 'not a url', '']) {
      h.open(url)
    }
    await h.settle()
    expect(h.shown).toEqual([])
    expect(h.opened).toEqual([])
  })
})

describe('describeUrlForDisplay (#236) — ≤ budget, origin preserved, cut marked', () => {
  it('returns a short URL unchanged', () => {
    const r = describeUrlForDisplay('https://example.com/a')
    expect(r).toEqual({ shown: 'https://example.com/a', hidden: 0 })
  })

  it('cuts the path/query, never the origin, and counts the hidden characters', () => {
    const origin = 'https://example.com'
    const url = origin + '/' + 'x'.repeat(1000)
    const r = describeUrlForDisplay(url)
    expect(r.shown.startsWith(origin + '/')).toBe(true)
    expect(r.shown.endsWith('…')).toBe(true)
    expect(r.shown.length).toBeLessThanOrEqual(EXTERNAL_URL_DISPLAY_BUDGET + 1) // + the ellipsis
    expect(r.hidden).toBe(url.length - (r.shown.length - 1))
    expect(new URL(r.shown).origin).toBe(origin)
  })

  it('an origin longer than the budget is still shown whole', () => {
    const origin = 'https://' + 'h'.repeat(EXTERNAL_URL_DISPLAY_BUDGET + 20) + '.example'
    const r = describeUrlForDisplay(origin + '/path')
    expect(r.shown.startsWith(origin)).toBe(true)
    expect(new URL(r.shown).origin).toBe(origin)
  })
})

describe('call-site wiring (#236) — index.ts hands the policy the consenting opener', () => {
  // Source-text pin (idiom: window-security.test.ts, shutdown.test.ts) — index.ts cannot be
  // imported under vitest. The policy pins in window-security.test.ts prove the policy still
  // routes http(s) to its callback; this proves the callback is the opener, not shell.openExternal.
  const mainDir = join(__dirname, '../../src/main')
  const indexSrc = readFileSync(join(mainDir, 'index.ts'), 'utf8')

  it('the window-open policy receives the opener created by createExternalOpener', () => {
    expect(indexSrc).toMatch(/const (\w+) = createExternalOpener\(\{[\s\S]*?createWindowOpenPolicy\(\1\)/)
  })

  it('shell.openExternal is called nowhere under src/main except external-open.ts', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          if (name === 'external-open.ts') continue
          if (/\bopenExternal\s*\(/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(mainDir.length + 1))
        }
      }
    }
    walk(mainDir)
    expect(offenders).toEqual([])
  })
})
