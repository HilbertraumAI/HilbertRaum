// Window security wiring (TS-2, full-audit 2026-07-10). The BrowserWindow hardening
// flags, the Content-Security-Policy strings, and the window-open policy used to live
// inline in index.ts/rasterizer.ts, where a one-character weakening (`sandbox: false`)
// would ship green through the whole suite. They live here — behind the same
// extract-a-seam pattern as shutdown.ts and navigation-guard.ts — so
// tests/unit/window-security.test.ts can pin every literal. Do NOT edit CSP or
// webPreferences inline at the call sites; change them here, next to their tests.
//
// Deliberately no runtime `electron` import (type-only is fine): the module must be
// unit-testable under plain vitest, like navigation-guard.ts.

import type { Session, WebPreferences } from 'electron'

/**
 * The hardening flags shared by ALL THREE windows (main + OCR rasterizer + the P6
 * evidence-pack PDF print window). The main and rasterizer call sites supply their own
 * `preload` path and spread these AFTER it; the print window deliberately supplies NO
 * preload at all — it renders inert print content with zero IPC surface, and the wiring
 * pin test (tests/unit/window-security.test.ts) enforces that it STAYS preload-free, so
 * do not "restore" one there. A drive-by inline override would have to be written after
 * the spread — which the same pin test (no inline security literals at any call site)
 * catches.
 */
export const SECURE_WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  // #239 (owner decision #218 unanswered → this default): no red-underline spell-check in any
  // window (docs/known-limitations.md). This flag only stops the underlining; the SESSION's
  // dictionary download is stopped by `disableSpellCheckerDownloads` below (#567).
  spellcheck: false
}) satisfies Readonly<WebPreferences>

/**
 * #567: Chromium's command-line switch for "never use a proxy". Without it the browser engine
 * follows the OS proxy settings, and with "Automatically detect settings" on (the Windows
 * default) it requests `http://wpad/wpad.dat` at start (4 requests and 16 name lookups in 15 s),
 * a LAN lookup a hostile network can answer with a proxy. Nothing in the app needs Chromium's proxy
 * settings: the in-app downloads use Node's `fetch`, which never reads them. Appended before
 * `ready` (index.ts). A `setProxy` on any session overrides it for that session (measured), so
 * src/main has none (pinned by tests/unit/window-security.test.ts).
 */
export const NO_PROXY_SWITCH = 'no-proxy-server'

/**
 * #567: stop a session's spell checker from downloading a Hunspell dictionary. The session does
 * it on its own a few milliseconds after `ready`, with no window and whatever the windows'
 * `spellcheck` flag says: on Linux for every language, on Windows for a language Windows cannot
 * spell-check itself (measured: `pl-pl-3-0.bdic` from a Google-operated CDN). It is a
 * browser-process fetch that neither the page CSP nor the offline tripwire (`offlineGuard.ts`)
 * can see. The empty language list is what stops it (`setSpellCheckerEnabled(false)` alone does
 * not, measured); the second call covers macOS, where the language list is a no-op. Electron
 * refills an empty list with the locale at every start and every session has its own, so
 * index.ts runs this from `session-created` on every start. If spell-check is wanted later (#218):
 * a `.bdic` already in the profile's `Dictionaries/` folder is used without a request.
 */
export function disableSpellCheckerDownloads(
  ses: Pick<Session, 'setSpellCheckerLanguages' | 'setSpellCheckerEnabled'>
): void {
  ses.setSpellCheckerLanguages([])
  ses.setSpellCheckerEnabled(false)
}

/**
 * Content-Security-Policy for the renderer session (spec §3.5, defence in depth on top
 * of the index.html meta tag). Production is strict: same-origin only, no remote
 * connect/img/script — the renderer cannot reach any cloud service. Dev relaxes
 * script-src (Vite/React refresh need inline+eval) and connect-src for Vite HMR over
 * ws://localhost (otherwise `npm run dev` breaks) — localhost is the ONLY added origin.
 *
 * Why PROD keeps `style-src 'unsafe-inline'` (audit 2026-07-16 F-39 — investigated, kept):
 * it is load-bearing for KaTeX math. `katex.renderToString` (via `@streamdown/math` →
 * rehype-katex in AssistantMarkdown) emits many per-expression inline
 * `style="height:…;vertical-align:…"` attributes computed from the formula (e.g. `x^2 + y^2`
 * → 11 of them). Inline STYLE ATTRIBUTES have no nonce/hash alternative (CSP nonces cover
 * only `<style>`/`<link>` elements; `'unsafe-hashes'` can't hash dynamic values), so dropping
 * it would render all math with its sizing/alignment styles blocked. The residual risk is
 * bounded: `script-src 'self'` blocks script injection and `connect-src 'self'` + `img-src
 * 'self' data:` close network exfiltration, so injected CSS can only cause same-origin cosmetic
 * effects — no script execution, no data disclosure. See docs/security-model.md. If this string
 * changes, tests/unit/window-security.test.ts + security-model.md + the index.html/ocr.html
 * meta tags must move in lockstep (the effective policy is the intersection of all of them).
 */
export function buildCsp(isDev: boolean): string {
  // `form-action 'none'` (#266): a form submit is a navigation the guard below already
  // refuses; the directive is the second, independent layer. Both header variants carry it.
  return isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; " +
        "img-src 'self' data:; font-src 'self'; form-action 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'none'; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
}

/** The hardening tail every baked meta carries, dev and prod (#266): the meta is the
 *  fallback layer if the header wiring ever regresses, so it denies the same things.
 *  `worker-src 'none'` (fix/ocr-pdfjs-in-page): since the OCR rasterizer runs pdf.js
 *  in-page (no worker), NO window starts a worker — and a `file://` dedicated worker
 *  escapes the CSP entirely (Chromium takes a worker's policy from its own script
 *  response, which a `file://` response has none of; measured, security-model.md). So
 *  refusing workers outright removes a CSP-free context any already-running script could
 *  otherwise reach with one `new Worker`. */
const META_CSP_TAIL =
  "worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

/**
 * The CSP that ships INSIDE the HTML (`<meta http-equiv="Content-Security-Policy">`) of
 * `index.html` (main window) and `ocr.html` (hidden OCR rasterizer window) — the SINGLE
 * source of truth for both pages' meta tags (BE-2, ocr-audit 2026-07-18). The tags are
 * REWRITTEN AT BUILD TIME from this function by the `hilbertraum:csp-meta` transform in
 * electron.vite.config.ts: the dev server serves the dev policy (Vite HMR needs the
 * localhost websocket), the production build bakes the prod policy. Before BE-2 the
 * checked-in meta carried the dev localhost relaxation verbatim into packaged builds.
 *
 * Measured on a packaged Windows build (2026-07-18, OCR-R P5 Step A): the
 * `onHeadersReceived` buildCsp() header DOES attach to `file://` loads in BOTH windows
 * and is ENFORCED (a fetch the meta allowed was blocked with the header string as the
 * violation's originalPolicy) — the header, not the meta, is the load-bearing prod
 * policy. Since #560 both windows load `hilbertraum://app/` (app-protocol.ts), whose
 * handler sets buildCsp(false) on every response; the session hook still attaches its own
 * copy there (measured: two header policies plus the meta, each enforced). The meta is the
 * defence-in-depth layer (the effective policy is the INTERSECTION of all of them), so it
 * must not advertise localhost in prod: if the header wiring ever regresses, the meta alone
 * must still deny every remote origin.
 *
 * Prod therefore strips the `ws://localhost:*` / `http://localhost:*` connect-src
 * entries; every other directive is byte-identical to the dev policy of the same page.
 * The `ocr` page keeps `img-src … data: blob:` (a bundled-pdfjs allowance). `worker-src`
 * is `'none'` on BOTH pages, in the shared tail (fix/ocr-pdfjs-in-page): the rasterizer
 * runs pdf.js in-page with no worker, so refusing workers closes the one CSP-free context
 * a `file://` dedicated worker would be — see `buildCsp`/`META_CSP_TAIL` and
 * security-model.md. Pinned by tests/unit/window-security.test.ts and by the
 * built-output test tests/integration/csp-build-output.test.ts (no `localhost` in a
 * built meta, ever).
 */
export function buildMetaCsp(isDev: boolean, page: 'index' | 'ocr'): string {
  const connectSrc = isDev ? "'self' ws://localhost:* http://localhost:*" : "'self'"
  return page === 'index'
    ? `default-src 'self'; script-src 'self'; connect-src ${connectSrc}; ` +
        `img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; ${META_CSP_TAIL}`
    : `default-src 'self'; script-src 'self'; connect-src ${connectSrc}; ` +
        `img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; ${META_CSP_TAIL}`
}

/**
 * Main-window window-open policy: open external links in the OS browser, never inside
 * the app window — but only safe web schemes. Handing an arbitrary renderer-supplied
 * URL (e.g. file://, smb://) to the OS handler is a known Electron pitfall, so anything
 * other than http(s) is dropped; the in-app open is ALWAYS denied. `openExternal` is
 * injected so the policy is unit-testable — the real caller passes the consenting opener
 * from external-open.ts (#236: a native dialog naming the site stands between this callback
 * and the OS browser; tests/unit/external-open.test.ts pins that nothing under src/main
 * reaches the Electron sink directly). The OCR rasterizer's worker window does not use
 * this — it denies everything inline.
 */
export function createWindowOpenPolicy(
  openExternal: (url: string) => void
): (details: { url: string }) => { action: 'deny' } {
  return ({ url }) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') openExternal(url)
    } catch {
      /* malformed URL → ignore */
    }
    return { action: 'deny' }
  }
}
