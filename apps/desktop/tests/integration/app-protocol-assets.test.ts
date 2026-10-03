import { describe, it, expect } from 'vitest'
import { lstatSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  APP_ORIGIN,
  appPageUrl,
  createAppProtocolHandler,
  listAppAssets,
  resolveAppAsset
} from '../../src/main/app-protocol'

// #560: the app's pages are served from `hilbertraum://app/` out of the BUILT renderer
// (out/renderer, inside app.asar when packaged). The handler serves only files with an entry in its
// explicit MIME table and names it can request, so a build that emits a new asset type — or a name
// outside the resolver's character set — would 404 in the packaged app while every unit test stays
// green. This pins the real build output: every file is servable, and every URL the pages and
// stylesheets reference resolves. Runs after `npm run build` (CI builds first); skips locally
// without a build (the csp-build-output.test.ts idiom).

const OUT_RENDERER = join(__dirname, '..', '..', 'out', 'renderer')
const built = existsSync(join(OUT_RENDERER, 'index.html')) && existsSync(join(OUT_RENDERER, 'ocr.html'))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return lstatSync(full).isDirectory() ? walk(full) : [relative(OUT_RENDERER, full).split(sep).join('/')]
  })
}

const realFs = {
  readdir: (dir: string) => readdirSync(dir),
  kind: (path: string): 'file' | 'dir' | 'other' => {
    const st = lstatSync(path)
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
  }
}

describe.skipIf(!built)('the built renderer is fully servable on hilbertraum://app (#560)', () => {
  const files = built ? listAppAssets(OUT_RENDERER, realFs, join) : new Set<string>()

  it('the allowlist is exactly the build output — no file left out', () => {
    expect([...files].sort()).toEqual(walk(OUT_RENDERER).sort())
    expect(files.has('index.html')).toBe(true)
    expect(files.has('ocr.html')).toBe(true)
  })

  it('every built file resolves through the handler policy with a content type', () => {
    const unservable = [...files].filter((f) => resolveAppAsset(`${APP_ORIGIN}/${f}`, 'GET', files) === null)
    expect(unservable).toEqual([])
  })

  it('every URL the two pages and the stylesheets reference resolves to a built file', () => {
    const refs: string[] = []
    for (const page of ['index', 'ocr'] as const) {
      const pageUrl = appPageUrl(page)
      const html = readFileSync(join(OUT_RENDERER, `${page}.html`), 'utf8')
      for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) refs.push(new URL(m[1]!, pageUrl).href)
    }
    for (const css of [...files].filter((f) => f.endsWith('.css'))) {
      const cssUrl = `${APP_ORIGIN}/${css}`
      const text = readFileSync(join(OUT_RENDERER, css), 'utf8')
      for (const m of text.matchAll(/url\((?!["']?data:)["']?([^"')]+)["']?\)/g)) refs.push(new URL(m[1]!, cssUrl).href)
    }
    // The KaTeX stylesheet's fonts and the page bundles are among them (a sanity floor, so a
    // regex that silently matched nothing cannot pass).
    expect(refs.some((u) => /KaTeX_Main-Regular-[^/]+\.woff2$/.test(u))).toBe(true)
    expect(refs.filter((u) => u.endsWith('.js')).length).toBeGreaterThanOrEqual(2)
    const broken = refs.filter((u) => resolveAppAsset(u, 'GET', files) === null)
    expect(broken).toEqual([])
  })

  it("pdf.js's decoders resolve where the OCR page looks for them (its DECODERS_URL)", () => {
    for (const name of ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js']) {
      expect(resolveAppAsset(`${APP_ORIGIN}/pdfjs-wasm/${name}`, 'GET', files)?.contentType).toBe(
        'text/javascript; charset=utf-8'
      )
    }
  })

  it('the handler serves the built bytes from the real directory', async () => {
    const handler = createAppProtocolHandler({
      files,
      readFile: async (relPath) => new Uint8Array(readFileSync(join(OUT_RENDERER, relPath)))
    })
    const res = await handler(new Request(appPageUrl('ocr')))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(readFileSync(join(OUT_RENDERER, 'ocr.html'), 'utf8'))
    // …and nothing beside the renderer root, though it sits one level up in the same build.
    expect(existsSync(join(OUT_RENDERER, '..', 'main'))).toBe(true)
    const outside = await handler(new Request(`${APP_ORIGIN}/..%2fmain%2findex.mjs`))
    expect(outside.status).toBe(404)
  })
})
