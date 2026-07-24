import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildMetaCsp } from '../../src/main/window-security'

// BE-2 (ocr-audit 2026-07-18), OCR-R P5: packaged builds load index.html/ocr.html over
// `file://`, where the CSP <meta> tag — not the buildCsp() response header — is the
// effective policy. The checked-in HTML carries the DEV policy (Vite HMR needs
// `ws://localhost:*` / `http://localhost:*` in connect-src); the `hilbertraum:csp-meta`
// transform in electron.vite.config.ts rewrites the tag at build time from
// `buildMetaCsp(isDev, page)`. This test guards the transform forever: the BUILT
// production HTML must carry the prod policy — no `localhost` anywhere in the meta.
//
// Runs against out/renderer (the `electron-vite build` output). CI always builds before
// testing (ci.yml: npm run build → npm test), so the guard is enforced on every PR; a
// local test run without a prior build skips with the reason below rather than
// false-failing (the evidence-pack-pdf-smoke skip idiom).

const OUT_RENDERER = join(__dirname, '..', '..', 'out', 'renderer')
const PAGES = [
  { file: 'index.html', page: 'index' as const },
  { file: 'ocr.html', page: 'ocr' as const }
]
const built = PAGES.every(({ file }) => existsSync(join(OUT_RENDERER, file)))

/** Extract the content of the CSP meta tag from an HTML string (attribute order as emitted). */
function cspMetaContent(html: string, file: string): string {
  const m = html.match(
    /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"|<meta[^>]*content="([^"]*)"[^>]*http-equiv="Content-Security-Policy"/
  )
  if (!m) throw new Error(`${file}: no Content-Security-Policy meta tag in the built HTML`)
  return (m[1] ?? m[2])!
}

describe.skipIf(!built)('built renderer HTML carries the PROD CSP meta (BE-2)', () => {
  // AUD-18, the other half of the coverage question: `built` is an EVERY over a hardcoded page
  // list, so it only notices pages that DISAPPEAR. A newly added renderer entry point leaves
  // `built` true and every existing assertion green while the new page's baked CSP is never
  // looked at — the packaged policy for that window would ship unverified. Pin the page set to
  // what the build actually emitted: adding a page must force it into PAGES above.
  it('PAGES covers every HTML page the renderer build emitted', () => {
    const emitted = readdirSync(OUT_RENDERER)
      .filter((f) => f.endsWith('.html'))
      .sort()
    expect(emitted).toEqual(PAGES.map(({ file }) => file).sort())
  })

  for (const { file, page } of PAGES) {
    const html = (): string => readFileSync(join(OUT_RENDERER, file), 'utf8')

    it(`${file}: the baked CSP meta contains no localhost (the dev-only relaxation)`, () => {
      // RED on the pre-P5 build output: the checked-in dev meta (connect-src 'self'
      // ws://localhost:* http://localhost:*) shipped verbatim into the build.
      expect(cspMetaContent(html(), file)).not.toContain('localhost')
    })

    it(`${file}: the baked CSP meta is exactly buildMetaCsp(false, '${page}')`, () => {
      // Stronger than the no-localhost scan: the built tag IS the single source of
      // truth's prod policy, byte for byte — any transform bypass or drift reddens.
      expect(cspMetaContent(html(), file)).toBe(buildMetaCsp(false, page))
    })
  }
})

describe.skipIf(built)('csp-build-output (skipped: no build output)', () => {
  it('out/renderer is absent — run `npm run build` first (CI always does)', () => {
    expect(built).toBe(false)
  })
})

// AUD-18 — CI positive control (the CODE-46 idiom: make a silent skip observable).
// Both real assertions above sit behind `describe.skipIf(!built)`, and `built` is derived from a
// hardcoded `out/renderer` path plus a hardcoded page list. If the renderer `outDir` ever moves,
// or a page is renamed/added, `built` quietly flips to false — and the ONLY automated check of
// the CSP that packaged builds actually enforce disappears from the run, with a green suite and
// no trace. That is a lost-coverage failure mode that looks exactly like success.
//
// CI builds before it tests (build → test), so on CI the output MUST be present. This reddens
// there on a layout drift instead of skipping, and is a no-op locally, where running the tests
// without a prior `npm run build` is normal and expected. A failure here is NOT a CSP
// regression: it means the guard stopped pointing at the build output — repoint it (or update
// PAGES) so the two assertions above execute again.
describe('csp-build-output guard is not silently skipped (AUD-18)', () => {
  it('the packaged-CSP assertions actually ran on CI', () => {
    if (process.env.CI) expect(built).toBe(true)
  })
})
