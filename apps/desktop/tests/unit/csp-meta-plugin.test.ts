import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import config from '../../electron.vite.config'
import { buildMetaCsp } from '../../src/main/window-security'

// Guards the `hilbertraum:csp-meta` transform's DEV-serve path (electron.vite.config.ts).
// The build path is already pinned by tests/integration/csp-build-output.test.ts; this is
// its dev counterpart. Regression captured in DEP-1 P3 (2026-07-19), latent since OCR-R P5
// (14259f68): in dev serve the transform rewrites the checked-in meta with
// buildMetaCsp(true, page) — which BY DESIGN equals the checked-in dev policy byte for byte
// (window-security.ts: "every other directive is byte-identical to the dev policy"). The old
// guard used `replaced === html` as a proxy for "no tag found", so the identical (correct)
// no-op replacement tripped it and the transform threw, 500-ing the renderer in `npm run dev`.
// The fix guards on tag ABSENCE instead. This test only ever passed once electron actually
// launched a dev window (agent shells inherit ELECTRON_RUN_AS_NODE, which had masked it).

const REPO_INDEX_HTML = join(__dirname, '..', '..', 'src', 'renderer', 'index.html')
const REPO_OCR_HTML = join(__dirname, '..', '..', 'src', 'renderer', 'ocr.html')

/** Dig the csp-meta plugin object out of the renderer config's (possibly nested) plugin list. */
function cspMetaPlugin(): Plugin {
  const plugins = ((config as { renderer?: { plugins?: unknown[] } }).renderer?.plugins ??
    []) as unknown[]
  const flat = plugins.flat(Infinity) as Plugin[]
  const plugin = flat.find((p) => p && (p as Plugin).name === 'hilbertraum:csp-meta')
  if (!plugin) throw new Error('hilbertraum:csp-meta plugin not found in renderer config')
  return plugin
}

/** Put the plugin into dev-serve mode and run its transformIndexHtml handler. */
function transformInDevServe(html: string, filename: string): string {
  const plugin = cspMetaPlugin()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(plugin as any).configResolved({ command: 'serve' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = (plugin as any).transformIndexHtml
  const handler = typeof t === 'function' ? t : t.handler
  return handler(html, { filename, path: '/index.html', server: {} })
}

/** Content of the CSP meta tag in an HTML string (attribute order as emitted). */
function cspMetaContent(html: string): string {
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)
  if (!m) throw new Error('no CSP meta tag in transformed HTML')
  return m[1]!
}

describe('hilbertraum:csp-meta transform — dev-serve path', () => {
  it('rewrites the checked-in index.html meta to buildMetaCsp(true, index) without throwing', () => {
    // RED before the fix: the dev policy the transform writes is byte-identical to the
    // checked-in meta, so the old `replaced === html` guard threw here.
    const out = transformInDevServe(readFileSync(REPO_INDEX_HTML, 'utf8'), REPO_INDEX_HTML)
    expect(cspMetaContent(out)).toBe(buildMetaCsp(true, 'index'))
  })

  it('rewrites the checked-in ocr.html meta to buildMetaCsp(true, ocr) without throwing', () => {
    const out = transformInDevServe(readFileSync(REPO_OCR_HTML, 'utf8'), REPO_OCR_HTML)
    expect(cspMetaContent(out)).toBe(buildMetaCsp(true, 'ocr'))
  })

  it('still throws loudly when the HTML has no CSP meta tag (the drift tooth stays)', () => {
    const noMeta = '<!doctype html><html><head><title>x</title></head><body></body></html>'
    expect(() => transformInDevServe(noMeta, REPO_INDEX_HTML)).toThrow(/no CSP meta tag found/)
  })
})
