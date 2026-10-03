import { describe, it, expect, vi } from 'vitest'
import { posix } from 'node:path'
import {
  APP_HOST,
  APP_MIME_TYPES,
  APP_ORIGIN,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  appPageUrl,
  appResponseHeaders,
  createAppProtocolHandler,
  createMainWindowNavigationPredicate,
  devRendererUrl,
  listAppAssets,
  resolveAppAsset,
  type AssetDirReader
} from '../../src/main/app-protocol'
import { buildCsp } from '../../src/main/window-security'

// #560: the app's pages are served from `hilbertraum://app/` by a protocol handler — a file server,
// so the new attack surface. These pins hold the policy (privileges, resolver, headers, navigation)
// where CI can see it; the Electron glue (install-app-protocol.ts) is pinned by source scans in
// window-security.test.ts, and the packaged behaviour was measured (docs/architecture.md, #560).

const FILES = new Set([
  'index.html',
  'ocr.html',
  'icon.svg',
  'assets/index-CUW7abL-.js',
  'assets/index-DcCGpUUW.css',
  'assets/KaTeX_Main-Regular-B22Nviop.woff2',
  'assets/KaTeX_Main-Regular-Dr94JaBh.woff',
  'assets/KaTeX_Main-Regular-ypZvNtVU.ttf',
  'brand/mark-on-dark.svg',
  'pdfjs-wasm/jbig2_nowasm_fallback.js',
  // In the set but with no MIME entry: must still be refused.
  'notes.txt',
  'LICENSE'
])
const at = (path: string): string => `${APP_ORIGIN}/${path}`
const resolve = (url: string, method = 'GET') => resolveAppAsset(url, method, FILES)

describe('the scheme and its privileges', () => {
  it('is hilbertraum://app — not the generic app:// other local clients use', () => {
    expect(APP_SCHEME).toBe('hilbertraum')
    expect(APP_HOST).toBe('app')
    expect(APP_ORIGIN).toBe('hilbertraum://app')
    expect(appPageUrl('index')).toBe('hilbertraum://app/index.html')
    expect(appPageUrl('ocr')).toBe('hilbertraum://app/ocr.html')
  })

  it('pins every privilege exactly: standard + secure only; never bypassCSP or service workers', () => {
    expect({ ...APP_SCHEME_PRIVILEGES }).toEqual({
      standard: true,
      secure: true,
      bypassCSP: false,
      allowServiceWorkers: false,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: false,
      codeCache: false,
      allowExtensions: false
    })
    expect(Object.isFrozen(APP_SCHEME_PRIVILEGES)).toBe(true)
  })
})

describe('resolveAppAsset — what the handler serves', () => {
  it('serves enumerated files with their explicit content type, ignoring query and fragment', () => {
    expect(resolve(at('index.html'))).toEqual({ relPath: 'index.html', contentType: 'text/html; charset=utf-8' })
    expect(resolve(at('assets/index-CUW7abL-.js'))?.contentType).toBe('text/javascript; charset=utf-8')
    expect(resolve(at('assets/index-DcCGpUUW.css'))?.contentType).toBe('text/css; charset=utf-8')
    expect(resolve(at('assets/KaTeX_Main-Regular-B22Nviop.woff2'))?.contentType).toBe('font/woff2')
    expect(resolve(at('assets/KaTeX_Main-Regular-Dr94JaBh.woff'))?.contentType).toBe('font/woff')
    expect(resolve(at('assets/KaTeX_Main-Regular-ypZvNtVU.ttf'))?.contentType).toBe('font/ttf')
    expect(resolve(at('brand/mark-on-dark.svg'))?.contentType).toBe('image/svg+xml')
    expect(resolve(at('pdfjs-wasm/jbig2_nowasm_fallback.js'))?.relPath).toBe('pdfjs-wasm/jbig2_nowasm_fallback.js')
    expect(resolve(at('index.html?secret=1#frag'))?.relPath).toBe('index.html')
  })

  it('the MIME table is explicit and exactly what the build emits (never the OS registry)', () => {
    expect({ ...APP_MIME_TYPES }).toEqual({
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf'
    })
  })

  // Each vector as a page or main could write it. Chromium canonicalises some before the handler
  // (`..`, `%2e%2e`, a literal backslash, the host's case) and hands the rest through unchanged
  // (encoded `/` and `\`, NUL, double encoding, drive letters, UNC prefixes, NTFS stream names —
  // measured on Electron 43.7.7); the resolver must refuse both forms on its own.
  const TRAVERSAL: Array<[string, string]> = [
    ['directory: the root', `${APP_ORIGIN}/`],
    ['directory: no path at all', APP_ORIGIN],
    ['directory: a listed folder', at('assets/')],
    ['directory: a folder without the slash', at('assets')],
    ['dot-dot (resolved by the URL parser, then not in the set)', at('../secret.txt')],
    ['dot-dot deep', at('../../../../../../Windows/win.ini')],
    ['%2e%2e', at('%2e%2e/%2e%2e/main/index.mjs')],
    ['.%2e', at('.%2e/main/index.mjs')],
    ['encoded slash', at('..%2f..%2fmain%2findex.mjs')],
    ['encoded backslash', at('..%5c..%5cmain%5cindex.mjs')],
    ['upper-case encoded backslash', at('..%5C..%5Cpackage.json')],
    ['literal backslash', `${APP_ORIGIN}/..\\..\\package.json`],
    ['backslash inside a segment', `${APP_ORIGIN}/assets\\index-CUW7abL-.js`],
    ['double encoding', at('%252e%252e/%252e%252e/package.json')],
    ['an encoded ordinary character', at('ind%65x.html')],
    ['drive letter', at('C:/Windows/win.ini')],
    ['encoded drive path', at('C%3a%5cWindows%5cwin.ini')],
    ['UNC via an empty segment', at('/server/share/x')],
    ['UNC encoded', at('%5c%5cserver%5cshare%5cx')],
    ['NUL encoded', at('index.html%00.txt')],
    ['NUL raw', at('index.html\u0000.txt')],
    ['NTFS alternate data stream', at('index.html::$DATA')],
    ['NTFS short name', at('INDEX~1.HTM')],
    ['case variant of a real file', at('INDEX.HTML')],
    ['trailing dot (Windows strips it)', at('index.html.')],
    ['trailing space', at('index.html%20')],
    ['empty middle segment', at('assets//index-CUW7abL-.js')],
    ['in the set, but no MIME entry', at('notes.txt')],
    ['in the set, no extension', at('LICENSE')],
    ['not in the set', at('main/index.mjs')],
    ['outside the renderer root', at('../main/index.mjs')]
  ]
  it.each(TRAVERSAL)('refuses %s', (_label, url) => {
    expect(resolve(url)).toBeNull()
  })

  // The two layers must each hold on their own. Most vectors above are ALSO refused by the
  // allowlist, which would hide a dropped syntax layer; here the allowlist (hypothetically) names
  // each hostile path with a servable extension, and the syntax layer alone must still refuse it.
  const SYNTAX_ONLY: Array<[string, string]> = [
    ['an encoded ordinary character', at('ind%65x.html')],
    ['encoded backslashes', at('..%5cmain%5cindex.mjs')],
    ['encoded slashes', at('..%2fmain%2findex.mjs')],
    ['an encoded NUL', at('index.html%00.html')],
    ['a literal backslash', `${APP_ORIGIN}/..\\main\\index.mjs`],
    ['a drive letter', at('C:/Windows/evil.js')],
    ['an encoded UNC prefix', at('%5c%5cserver%5cshare%5cevil.js')],
    ['an NTFS stream name', at('index.html:x.html')],
    ['an empty segment', at('assets//index-CUW7abL-.js')],
    ['a dollar sign', at('$evil.js')]
  ]
  it.each(SYNTAX_ONLY)('the syntax layer alone refuses %s', (_label, url) => {
    const pathname = new URL(url).pathname.slice(1)
    expect(resolveAppAsset(url, 'GET', new Set([...FILES, pathname]))).toBeNull()
  })

  const HOSTS: Array<[string, string]> = [
    ['another host', 'hilbertraum://other/index.html'],
    ['a host that starts with app', 'hilbertraum://app.evil/index.html'],
    ['a host in upper case (Chromium lower-cases; Node does not)', 'hilbertraum://APP/index.html'],
    ['credentials', 'hilbertraum://user:pw@app/index.html'],
    ['a username alone', 'hilbertraum://user@app/index.html'],
    ['a port', 'hilbertraum://app:8080/index.html'],
    ['no host', 'hilbertraum:///index.html'],
    ['an opaque path', 'hilbertraum:index.html'],
    ['file://', 'file:///C:/app/out/renderer/index.html'],
    ['http', 'http://app/index.html'],
    ['the generic app://', 'app://app/index.html'],
    ['not a URL', 'not a url']
  ]
  it.each(HOSTS)('refuses %s', (_label, url) => {
    expect(resolve(url)).toBeNull()
  })

  it.each(['POST', 'PUT', 'HEAD', 'OPTIONS', 'get'])('refuses method %s', (method) => {
    expect(resolve(at('index.html'), method)).toBeNull()
  })
})

describe('createAppProtocolHandler — every response carries the CSP and nosniff', () => {
  const PROD_HEADERS = { csp: buildCsp(false), nosniff: 'nosniff' }
  const bytes = new TextEncoder().encode('<!doctype html>')
  const makeHandler = (readFile = vi.fn(async (_relPath: string) => new Uint8Array(bytes))) => ({
    handler: createAppProtocolHandler({ files: FILES, readFile }),
    readFile
  })

  it('a served file: 200, its bytes, its content type, the production CSP, nosniff', async () => {
    const { handler, readFile } = makeHandler()
    const res = await handler(new Request(at('index.html')))
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(PROD_HEADERS.csp)
    expect(res.headers.get('x-content-type-options')).toBe(PROD_HEADERS.nosniff)
    expect(readFile).toHaveBeenCalledExactlyOnceWith('index.html')
  })

  it('a refusal: 404, empty body, the same CSP and nosniff, and the file system is never touched', async () => {
    const { handler, readFile } = makeHandler()
    for (const url of [at('..%5c..%5cpackage.json'), at('assets/'), 'hilbertraum://other/index.html', at('notes.txt')]) {
      const res = await handler(new Request(url))
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
      expect(res.headers.get('content-type')).toBeNull()
      expect(res.headers.get('content-security-policy')).toBe(PROD_HEADERS.csp)
      expect(res.headers.get('x-content-type-options')).toBe(PROD_HEADERS.nosniff)
    }
    const post = await handler(new Request(at('index.html'), { method: 'POST', body: 'x' }))
    expect(post.status).toBe(404)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('a read that fails is a 404 with the same headers, not a leaked error', async () => {
    const { handler } = makeHandler(vi.fn(async () => Promise.reject(new Error('ENOENT: D:\\secret path'))))
    const res = await handler(new Request(at('index.html')))
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    expect(res.headers.get('content-security-policy')).toBe(PROD_HEADERS.csp)
  })

  it('appResponseHeaders carries the production policy whatever the build mode', () => {
    expect(appResponseHeaders('text/css; charset=utf-8')).toEqual({
      'Content-Type': 'text/css; charset=utf-8',
      'Content-Security-Policy': buildCsp(false),
      'X-Content-Type-Options': 'nosniff'
    })
    expect(appResponseHeaders()).toEqual({
      'Content-Security-Policy': buildCsp(false),
      'X-Content-Type-Options': 'nosniff'
    })
  })
})

describe('listAppAssets — the allowlist the handler serves from', () => {
  // A fake tree: nested folders, a symlink (kind 'other' under lstat), a name the resolver could
  // never request, and a folder that throws on read.
  const TREE: Record<string, string[] | 'file' | 'other'> = {
    '/r': ['index.html', 'assets', 'brand', 'link.js', 'bad name.js', 'locked'],
    '/r/index.html': 'file',
    '/r/assets': ['a-1.js', 'deep'],
    '/r/assets/a-1.js': 'file',
    '/r/assets/deep': ['f.woff2'],
    '/r/assets/deep/f.woff2': 'file',
    '/r/brand': ['m.svg'],
    '/r/brand/m.svg': 'file',
    '/r/link.js': 'other',
    '/r/bad name.js': 'file',
    '/r/locked': []
  }
  const fs: AssetDirReader = {
    readdir: (dir) => {
      if (dir === '/r/locked') throw new Error('EACCES')
      const v = TREE[dir]
      if (!Array.isArray(v)) throw new Error('ENOTDIR')
      return v
    },
    kind: (path) => {
      const v = TREE[path]
      return Array.isArray(v) ? 'dir' : v === 'file' ? 'file' : 'other'
    }
  }

  it('lists regular files as root-relative "/" paths; no folders, no symlinks, no unrequestable names', () => {
    expect([...listAppAssets('/r', fs, posix.join)].sort()).toEqual([
      'assets/a-1.js',
      'assets/deep/f.woff2',
      'brand/m.svg',
      'index.html'
    ])
  })

  it('a missing root is an empty set (nothing is served)', () => {
    expect(listAppAssets('/missing', fs, posix.join).size).toBe(0)
  })
})

describe('createMainWindowNavigationPredicate — the main window may navigate only to its own shell', () => {
  it('packaged / built: exactly the index page of the app scheme', () => {
    const allowed = createMainWindowNavigationPredicate(undefined)
    expect(allowed('hilbertraum://app/index.html')).toBe(true)
    expect(allowed('hilbertraum://app/index.html#section')).toBe(true)
    for (const url of [
      'hilbertraum://app/ocr.html',
      'hilbertraum://app/',
      'hilbertraum://app/assets/index-CUW7abL-.js',
      'hilbertraum://other/index.html',
      'hilbertraum://user@app/index.html',
      'hilbertraum://app:1/index.html',
      // The old prefix check let every one of these through:
      'file:///C:/app/out/renderer/index.html',
      'file:///C:/Users/me/Downloads/dropped.html',
      'http://localhost:5173/',
      'https://evil.example/',
      'not a url'
    ]) {
      expect(allowed(url), url).toBe(false)
    }
  })

  it('dev server: its exact origin only (the old prefix also matched localhost.<anything>)', () => {
    const allowed = createMainWindowNavigationPredicate('http://localhost:5173')
    expect(allowed('http://localhost:5173/')).toBe(true)
    expect(allowed('http://localhost:5173/index.html')).toBe(true)
    for (const url of [
      'http://localhost.evil.example:5173/',
      'http://localhost:5174/',
      'https://localhost:5173/',
      'hilbertraum://app/index.html',
      'file:///C:/x.html'
    ]) {
      expect(allowed(url), url).toBe(false)
    }
  })

  it('a malformed dev-server URL denies everything', () => {
    expect(createMainWindowNavigationPredicate('::not a url::')('http://localhost:5173/')).toBe(false)
  })
})

describe('devRendererUrl — only an unpackaged build follows the dev server (#562)', () => {
  const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173' }

  it('unpackaged: the dev server electron-vite names', () => {
    expect(devRendererUrl(false, env)).toBe('http://localhost:5173')
  })

  it('packaged: never, whatever the environment says', () => {
    expect(devRendererUrl(true, env)).toBeUndefined()
    expect(devRendererUrl(true, { ELECTRON_RENDERER_URL: 'http://127.0.0.1:8080' })).toBeUndefined()
  })

  it('unset or empty: no dev server', () => {
    expect(devRendererUrl(false, {})).toBeUndefined()
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: '' })).toBeUndefined()
  })
})
