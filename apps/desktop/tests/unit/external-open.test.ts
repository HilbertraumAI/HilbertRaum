import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BaseWindow, BrowserWindow, Dialog, MessageBoxOptions, MessageBoxReturnValue, Shell } from 'electron'
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
// browser windows). The opener is unit-tested with typed fake `dialog` / `shell`; the wiring pin
// at the end keeps `index.ts` on it.

type Shown = { window: BaseWindow | null; options: MessageBoxOptions }

interface HarnessOptions {
  /** The dialog's answer: 0 = Open, 1 = Cancel (the default). */
  response?: number
  /** Hold every dialog until `release()` — models a dialog that is still up. */
  hold?: boolean
  /** The dialog itself rejects. */
  reject?: boolean
  /** `shell.openExternal` rejects (a failed browser launch). */
  openRejects?: boolean
  /** No main window (null) — the app-modal overload must be used. */
  window?: null
  /** The main window exists but `isDestroyed()` — must not be used as the parent. */
  destroyed?: boolean
  /** The FIRST copy lookup throws (a broken `t`) — the guard must not latch. */
  tThrowsOnce?: boolean
}

function harness(opts: HarnessOptions = {}) {
  const shown: Shown[] = []
  const opened: string[] = []
  let release: (() => void) | null = null
  // Typed fakes (no casts): one implementation covering both `showMessageBox` overloads.
  const dialog: Pick<Dialog, 'showMessageBox'> = {
    async showMessageBox(a: BaseWindow | MessageBoxOptions, b?: MessageBoxOptions): Promise<MessageBoxReturnValue> {
      shown.push(b ? { window: a as BaseWindow, options: b } : { window: null, options: a as MessageBoxOptions })
      if (opts.reject) throw new Error('dialog failed')
      if (opts.hold) await new Promise<void>((r) => (release = r))
      return { response: opts.response ?? 1, checkboxChecked: false }
    }
  }
  const shell: Pick<Shell, 'openExternal'> = {
    openExternal: async (url: string) => {
      if (opts.openRejects) throw new Error('no browser')
      opened.push(url)
    }
  }
  // Only `isDestroyed` is read off the window; the dialog fake records the reference.
  const window = { isDestroyed: () => opts.destroyed === true } as BrowserWindow
  let tCalls = 0
  const open = createExternalOpener({
    dialog,
    shell,
    getWindow: () => (opts.window === null ? null : window),
    t: (key: MessageKey, params?: MessageParams) => {
      if (opts.tThrowsOnce && tCalls++ === 0) throw new Error('copy lookup failed')
      return t('en', key, params)
    }
  })
  // One macrotask drains every pending microtask (the dialog promise, the openExternal
  // continuation, the finally that clears the guard) — no counting of promise hops.
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
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
    expect(String(options.detail)).toContain('Site: https://example.com') // the origin, on its own line
    expect(String(options.detail)).toContain('https://example.com/a%20b?q=1#frag') // the URL
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
    expect(detail).toContain(`characters not shown: ${hidden}`)
    // A display truncation that lost the origin would let a look-alike path masquerade as the
    // site: the shown string must still parse to the SAME origin as what opens.
    expect(new URL(shown).origin).toBe(new URL(h.opened[0]).origin)
  })

  it('credentials in the URL are dropped from the display and flagged — the Site line names the real origin', async () => {
    const h = harness({ response: 0 })
    h.open('https://www.bank.example@evil.test/login')
    await h.settle()
    const detail = String(h.shown[0].options.detail)
    expect(detail).toContain('Site: https://evil.test')
    expect(detail).toContain('https://evil.test/login')
    expect(detail).not.toContain('bank.example@') // the look-alike prefix never reaches the dialog
    expect(detail).toContain('carries a username')
    expect(h.opened).toEqual(['https://www.bank.example@evil.test/login'])
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
    // The guard resets once the dialog settles: a later request is shown again (and, being
    // held by the fake like the first, opens once released).
    h.open('https://fourth.example/')
    await h.settle()
    expect(h.shown).toHaveLength(2)
    expect(h.opened).toEqual(['https://first.example/'])
    h.release()
    await h.settle()
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

  it('a failed browser launch (openExternal rejects) resets the guard too', async () => {
    const h = harness({ response: 0, openRejects: true })
    h.open('https://example.com/')
    await h.settle()
    expect(h.shown).toHaveLength(1)
    h.open('https://example.com/again')
    await h.settle()
    expect(h.shown).toHaveLength(2)
  })

  it('without a main window the app-modal overload is used and the open still works', async () => {
    const h = harness({ response: 0, window: null })
    h.open('https://example.com/no-window')
    await h.settle()
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].window).toBeNull()
    expect(h.opened).toEqual(['https://example.com/no-window'])
  })

  it('a destroyed main window is not used as the dialog parent', async () => {
    const h = harness({ response: 0, destroyed: true })
    h.open('https://example.com/torn-down')
    await h.settle()
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].window).toBeNull()
    expect(h.opened).toEqual(['https://example.com/torn-down'])
  })

  it('a throw while preparing the dialog opens nothing and does NOT latch the guard', async () => {
    const h = harness({ response: 0, tThrowsOnce: true })
    h.open('https://example.com/first')
    await h.settle()
    expect(h.shown).toEqual([])
    expect(h.opened).toEqual([])
    h.open('https://example.com/second')
    await h.settle()
    expect(h.shown).toHaveLength(1)
    expect(h.opened).toEqual(['https://example.com/second'])
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

describe('describeUrlForDisplay (#236) — ≤ budget, origin preserved, cut marked, built from the parsed URL', () => {
  it('returns a short URL unchanged', () => {
    const r = describeUrlForDisplay('https://example.com/a')
    expect(r).toEqual({ shown: 'https://example.com/a', hidden: 0, credentials: false })
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

  it('a NON-normalised input (a path that percent-encodes longer than written) still keeps the origin', () => {
    // Built from the raw string this cut the host off entirely ("/%C3%A9%C3%A9…").
    const href = 'https://example.com/' + 'é'.repeat(200)
    const r = describeUrlForDisplay(href)
    expect(r.shown.startsWith('https://example.com/')).toBe(true)
    expect(new URL(r.shown).origin).toBe(new URL(href).origin)
    expect(r.hidden).toBeGreaterThan(0)
  })

  it('drops userinfo from the shown string and reports it', () => {
    const r = describeUrlForDisplay('https://user:secret@example.com/p')
    expect(r).toEqual({ shown: 'https://example.com/p', hidden: 0, credentials: true })
    expect(describeUrlForDisplay('https://example.com/p').credentials).toBe(false)
  })
})

describe('call-site wiring (#236) — index.ts hands the policy the consenting opener', () => {
  // Source-text pin (idiom: window-security.test.ts, shutdown.test.ts) — index.ts cannot be
  // imported under vitest. The policy pins in window-security.test.ts prove the policy still
  // routes http(s) to its callback; this proves the callback is the opener, not shell.openExternal.
  const mainDir = join(__dirname, '../../src/main')
  const indexSrc = readFileSync(join(mainDir, 'index.ts'), 'utf8')

  it('the window-open handler is the policy over the opener created by createExternalOpener', () => {
    expect(indexSrc).toMatch(
      /const (\w+) = createExternalOpener\(\{[\s\S]*?setWindowOpenHandler\(createWindowOpenPolicy\(\1\)\)/
    )
  })

  it('shell.openExternal is reached nowhere under src/main except external-open.ts', () => {
    // Both spellings of the sink: a member call on Electron's `shell`, and `openExternal`
    // pulled out of the 'electron' import. (window-security.ts's `openExternal` is the
    // policy's injected callback parameter, not the sink.) The scan is comment-blind by
    // design — a comment that spells `shell.openExternal` reddens it too; describe the sink
    // in words instead. The exemption is the one module by full path, not by basename.
    const offenders: string[] = []
    const exempt = join(mainDir, 'external-open.ts')
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          if (p === exempt) continue
          const src = readFileSync(p, 'utf8')
          if (/\bshell\s*\.\s*openExternal\b/.test(src) || /import\s*\{[^}]*\bopenExternal\b[^}]*\}\s*from\s*['"]electron['"]/.test(src)) {
            offenders.push(p.slice(mainDir.length + 1))
          }
        }
      }
    }
    walk(mainDir)
    expect(offenders).toEqual([])
  })
})
