import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  NO_PROXY_SWITCH,
  SECURE_WINDOW_WEB_PREFERENCES,
  buildCsp,
  buildMetaCsp,
  createWindowOpenPolicy,
  disableSpellCheckerDownloads
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
    // #239: `spellcheck: false` is the fifth flag — Chromium's spellchecker
    // downloads Hunspell dictionaries from a Google CDN on Windows/Linux (a browser-process
    // fetch that neither the CSP nor the Node-socket tripwire can see), and the offline hard
    // rule forbids it. Closed by construction: this pin + the wiring pins below are the evidence.
    expect(SECURE_WINDOW_WEB_PREFERENCES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
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
        "connect-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'none'; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    )
  })

  it('dev CSP matches the contract string exactly', () => {
    expect(buildCsp(true)).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; " +
        "img-src 'self' data:; font-src 'self'; form-action 'none'"
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

describe('buildMetaCsp (BE-2, ocr-audit 2026-07-18 — the meta tags baked into index.html/ocr.html)', () => {
  // On packaged `file://` loads the META is the effective policy (the buildCsp response
  // header only reaches http(s) — see security-model.md), so these strings ARE the
  // production renderer posture. electron.vite.config.ts rewrites both pages' meta tags
  // from this function at build time; tests/integration/csp-build-output.test.ts proves
  // the built HTML matches these strings byte for byte.
  // #266: both metas carry the header's hardening tail (`object-src`/`base-uri`/
  // `frame-ancestors`) plus `form-action`, so the fallback layer denies the same things.
  // fix/ocr-pdfjs-in-page: `worker-src 'none'` joins the tail — no window starts a worker now
  // (the OCR rasterizer runs pdf.js in-page), and a `file://` worker would be CSP-free.
  const TAIL =
    "worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

  it('index page: prod is the dev policy with the localhost connect-src entries stripped', () => {
    expect(buildMetaCsp(false, 'index')).toBe(
      "default-src 'self'; script-src 'self'; connect-src 'self'; " +
        `img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; ${TAIL}`
    )
    expect(buildMetaCsp(true, 'index')).toBe(
      "default-src 'self'; script-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; " +
        `img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; ${TAIL}`
    )
  })

  it('ocr page: same split, plus the pdfjs img-src blob: allowance; worker-src is none (in TAIL)', () => {
    expect(buildMetaCsp(false, 'ocr')).toBe(
      "default-src 'self'; script-src 'self'; connect-src 'self'; " +
        `img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; ${TAIL}`
    )
    expect(buildMetaCsp(true, 'ocr')).toBe(
      "default-src 'self'; script-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; " +
        `img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; ${TAIL}`
    )
  })

  it('no prod meta ever carries a remote origin, localhost, or an unsafe-eval', () => {
    for (const page of ['index', 'ocr'] as const) {
      const prod = buildMetaCsp(false, page)
      expect(prod).not.toContain('localhost')
      expect(prod).not.toContain('unsafe-eval')
      // Every scheme://host source in the DEV meta must be a localhost dev-server origin.
      const origins = buildMetaCsp(true, page).match(/[a-z]+:\/\/[^\s;]+/g) ?? []
      for (const origin of origins) {
        expect(origin).toMatch(/^(ws|http):\/\/localhost:\*$/)
      }
      // And prod allows NO scheme://host origin at all (blob:/data: carry no host).
      expect(prod).not.toMatch(/[a-z]+:\/\//)
    }
  })
})

// #266: the header is the enforced layer and the meta is the fallback if the header wiring
// ever regresses, so the hardening tail must exist in BOTH with the same values — and
// neither carried `form-action` before. Behavioural: the directives are parsed, not the
// exact strings compared (those pins live above).
describe('CSP hardening tail — header/meta parity (#266)', () => {
  const directives = (csp: string): Map<string, string> =>
    new Map(
      csp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...rest] = d.split(/\s+/)
          return [name, rest.join(' ')] as [string, string]
        })
    )
  const TAIL = ['worker-src', 'object-src', 'base-uri', 'frame-ancestors', 'form-action']

  it("the production header refuses workers, plugins, base changes, framing and form submits ('none' each)", () => {
    const header = directives(buildCsp(false))
    for (const name of TAIL) expect(header.get(name), name).toBe("'none'")
  })

  it('the dev header carries form-action too (HMR needs none of the four)', () => {
    expect(directives(buildCsp(true)).get('form-action')).toBe("'none'")
  })

  it('every baked meta carries the same tail with the same values, dev and prod', () => {
    for (const page of ['index', 'ocr'] as const) {
      for (const isDev of [false, true]) {
        const meta = directives(buildMetaCsp(isDev, page))
        for (const name of TAIL) {
          expect(meta.get(name), `${page} ${isDev ? 'dev' : 'prod'} ${name}`).toBe("'none'")
        }
      }
    }
  })

  it('the KaTeX style allowance survives; both pages refuse workers (fix/ocr-pdfjs-in-page)', () => {
    expect(directives(buildCsp(false)).get('style-src')).toBe("'self' 'unsafe-inline'")
    // The OCR rasterizer runs pdf.js in-page now, so no window needs a worker — and a
    // `file://` worker would run outside the CSP. Both metas (and the prod header) deny it.
    expect(directives(buildMetaCsp(false, 'ocr')).get('worker-src')).toBe("'none'")
    expect(directives(buildMetaCsp(false, 'index')).get('worker-src')).toBe("'none'")
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
  // watch-item (#266): these are source-text pins, brittle by design — index.ts cannot be
  // imported without Electron, so a behavioural form is not small. Re-check them whenever
  // the CSP builders or the window call sites move.
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
      expect(src).not.toMatch(/spellcheck\s*:/i) // #239: the flag lives ONLY in the shared constant
      expect(src).not.toContain('default-src') // the CSP is not re-inlined either
    }
  })

  it('the print window is preload-FREE (plan §11: sandbox, no preload, no node)', () => {
    // Unlike the other two windows, the print page has no IPC surface at all — a
    // `preload:` appearing in print-pdf.ts would silently widen it.
    expect(printPdfSrc).not.toMatch(/preload\s*:/)
  })
})

describe('#560 wiring: the app pages load from hilbertraum://app, never file://', () => {
  // The policy (privileges, resolver, headers, predicate) is pinned behaviourally in
  // tests/unit/app-protocol.test.ts; these source pins hold the Electron glue to it. Brittle by
  // design, like the block above — re-check them whenever the call sites move.
  const read = (rel: string): string => readFileSync(join(__dirname, '../../src/main', rel), 'utf8')
  const indexSrc = read('index.ts')
  const rasterizerSrc = read('services/ocr/rasterizer.ts')
  const glueSrc = read('install-app-protocol.ts')

  it('registers the scheme from the pinned privileges, before ready, and serves it before the first window', () => {
    expect(glueSrc).toContain(
      'protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } }])'
    )
    expect(glueSrc).toMatch(/protocol\.handle\(\s*APP_SCHEME,\s*createAppProtocolHandler\(/)
    const register = indexSrc.indexOf('registerAppSchemePrivileges()')
    const whenReady = indexSrc.indexOf('app.whenReady()')
    expect(register).toBeGreaterThan(-1)
    expect(register).toBeLessThan(whenReady)
    const install = indexSrc.indexOf("installAppProtocol(join(__dirname, '../renderer'))")
    expect(install).toBeGreaterThan(whenReady)
    expect(install).toBeLessThan(indexSrc.indexOf('createWindow()', install))
  })

  it('the main and OCR windows load the scheme; the main window navigates only to its own page', () => {
    expect(indexSrc).toContain("void mainWindow.loadURL(devServerUrl ?? appPageUrl('index'))")
    expect(indexSrc).toContain('createMainWindowNavigationPredicate(devServerUrl)')
    expect(rasterizerSrc).toContain("appPageUrl('ocr')")
    for (const src of [indexSrc, rasterizerSrc]) {
      expect(src).not.toMatch(/\.loadFile\(/)
      expect(src).not.toMatch(/startsWith\(\s*['"]file:/)
    }
  })

  it('no other main-process file registers a scheme, a protocol handler or a privilege literal', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.ts$/.test(name) && !/[\\/](app-protocol|install-app-protocol)\.ts$/.test(full)) {
          const src = readFileSync(full, 'utf8')
          if (/registerSchemesAsPrivileged|protocol\.(handle|register\w*Protocol|intercept\w*)\(|bypassCSP|allowServiceWorkers/.test(src))
            offenders.push(full)
        }
      }
    }
    walk(join(__dirname, '../../src/main'))
    expect(offenders).toEqual([])
  })
})

describe('#567: the browser engine makes no request of its own (WPAD, spell-check dictionary)', () => {
  const mainDir = join(__dirname, '../../src/main')
  // LF-normalised: a Windows checkout has CRLF, and the patterns below are line-anchored.
  const indexSrc = readFileSync(join(mainDir, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const mainSources = (): Array<{ file: string; src: string }> => {
    const out: Array<{ file: string; src: string }> = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.ts$/.test(name)) out.push({ file: full, src: readFileSync(full, 'utf8') })
      }
    }
    walk(mainDir)
    return out
  }

  it('empties the language list BEFORE disabling: the list stops the download, the flag covers macOS', () => {
    const calls: Array<[string, unknown]> = []
    disableSpellCheckerDownloads({
      setSpellCheckerLanguages: (languages) => calls.push(['setSpellCheckerLanguages', languages]),
      setSpellCheckerEnabled: (enable) => calls.push(['setSpellCheckerEnabled', enable])
    })
    expect(calls).toEqual([
      ['setSpellCheckerLanguages', []],
      ['setSpellCheckerEnabled', false]
    ])
  })

  it('the switch is Chromium\'s "never use a proxy"', () => {
    expect(NO_PROXY_SWITCH).toBe('no-proxy-server')
  })

  it('index.ts appends the switch and hooks session-created at module level, before ready', () => {
    const ready = indexSrc.indexOf('app.whenReady().then(')
    expect(ready).toBeGreaterThan(0)
    for (const line of [
      'app.commandLine.appendSwitch(NO_PROXY_SWITCH)',
      "app.on('session-created', disableSpellCheckerDownloads)"
    ]) {
      // A whole unindented line = module level: inside a function it could run after `ready`.
      expect(indexSrc.split('\n')).toContain(line)
      expect(indexSrc.indexOf(line)).toBeLessThan(ready)
    }
  })

  it('the ready handler repeats the call on the default session as its FIRST statement', () => {
    // The download starts a few milliseconds after `ready`; anything awaited first could lose the race.
    expect(indexSrc).toMatch(
      /app\.whenReady\(\)\.then\(\(\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*disableSpellCheckerDownloads\(session\.defaultSession\)\n/
    )
  })

  it('nothing in src/main re-enables a spell checker or sets a proxy (setProxy overrides the switch per session)', () => {
    const offenders = mainSources()
      .filter(({ file }) => !/[\\/]window-security\.ts$/.test(file))
      .flatMap(({ file, src }) =>
        [/\.setSpellChecker\w*\(/, /\.setProxy\(/, /appendSwitch\(\s*['"]proxy-/].filter((re) => re.test(src)).map((re) => `${file}: ${re}`)
      )
    expect(offenders).toEqual([])
  })
})
