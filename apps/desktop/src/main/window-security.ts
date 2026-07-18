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

import type { WebPreferences } from 'electron'

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
  webSecurity: true
}) satisfies Readonly<WebPreferences>

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
  return isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; " +
        "img-src 'self' data:; font-src 'self'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'"
}

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
 * policy. The meta is the second, defence-in-depth layer (the effective policy is the
 * INTERSECTION of both), so it must not advertise localhost in prod: if the session
 * header wiring ever regresses, the meta alone must still deny every remote origin.
 *
 * Prod therefore strips the `ws://localhost:*` / `http://localhost:*` connect-src
 * entries; every other directive is byte-identical to the dev policy of the same page.
 * The `ocr` page keeps `worker-src 'self' blob:` and `img-src … data: blob:` — the
 * bundled pdfjs's allowances (its worker itself loads as a plain 'self' asset; measured:
 * packaged rasterization runs under the stricter header intersection) — so this meta
 * never becomes the directive that breaks rasterization only in packaged builds, the one
 * place CI cannot see. Pinned by tests/unit/window-security.test.ts and by the
 * built-output test tests/integration/csp-build-output.test.ts (no `localhost` in a
 * built meta, ever).
 */
export function buildMetaCsp(isDev: boolean, page: 'index' | 'ocr'): string {
  const connectSrc = isDev ? "'self' ws://localhost:* http://localhost:*" : "'self'"
  return page === 'index'
    ? `default-src 'self'; script-src 'self'; connect-src ${connectSrc}; ` +
        "img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'"
    : `default-src 'self'; script-src 'self'; connect-src ${connectSrc}; ` +
        "img-src 'self' data: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'"
}

/**
 * Main-window window-open policy: open external links in the OS browser, never inside
 * the app window — but only safe web schemes. Handing an arbitrary renderer-supplied
 * URL (e.g. file://, smb://) to the OS handler is a known Electron pitfall, so anything
 * other than http(s) is dropped; the in-app open is ALWAYS denied. `openExternal` is
 * injected (the real caller passes shell.openExternal) so the policy is unit-testable.
 * The OCR rasterizer's worker window does not use this — it denies everything inline.
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
