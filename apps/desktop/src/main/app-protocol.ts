// The app's own pages are served from a custom scheme, `hilbertraum://app/`, not `file://` (#560).
//
// On a `file://` origin the CSP's `'self'` matches EVERY `file://` URL: a script running in a window
// could read any file the OS account can read (`connect-src 'self'`), and a `<script src>` pointing
// at any local `.js` would run (`script-src 'self'`) — measured on the packaged build. On this scheme
// `'self'` is `hilbertraum://app` alone, whose content is the renderer build inside `app.asar`. The
// scheme also lets the packaged build turn Electron's `GrantFileProtocolExtraPrivileges` fuse off
// (electron-builder.yml), which the `file://` load could not survive: its module scripts are
// refused by CORS from origin `null` once the fuse is off.
//
// The handler is a file server, so it is the new attack surface. Two independent layers decide
// what it serves, and no request data ever reaches a `path.join`:
//   1. syntax — the exact scheme and host, no credentials or port, GET only, no `%` anywhere in the
//      path (Chromium hands encoded `/`, `\`, NUL and double encodings through unchanged), every
//      segment from a strict character set (no `\`, `:`, `$` — drive letters, UNC prefixes and NTFS
//      stream names), no empty / `.` / `..` segment;
//   2. allowlist — the path must name a file enumerated under the renderer root when the handler
//      was installed. Directories are never listed; nothing outside the root is in the set.
// Every response, refusals included, carries the production CSP and `nosniff`. The MIME table is
// explicit (the OS registry can map `.js` to `text/plain`, which breaks module scripts under
// nosniff); an extension it does not know is refused, and the built-output test fails CI first.
//
// A second host, `hilbertraum://print/<token>` (#563), serves the evidence-pack print page from
// memory instead of a transient plaintext file beside the export. It is a different origin from
// `hilbertraum://app`, so the app's own pages cannot read it (no CORS, and their CSP refuses other
// origins). The map of pending pages IS its allowlist: a page is held for one print, served at
// most once, and dropped in the print's `finally`. See `PrintPages`.
//
// Deliberately no runtime `electron` import (type-only is fine): the module must be unit-testable
// under plain vitest (the window-security.ts pattern). The Electron glue is install-app-protocol.ts.

import { randomBytes } from 'node:crypto'
import type { Privileges } from 'electron'
import { buildCsp, EVIDENCE_PACK_CSP } from './window-security'

export const APP_SCHEME = 'hilbertraum'
export const APP_HOST = 'app'
/** The origin of the app's own pages, as Chromium reports it (`location.origin`). */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/**
 * The scheme's privileges, every key explicit (`Required` makes a privilege a future Electron adds
 * a type error until someone decides it). Measured on Electron 43.7.7 (docs/architecture.md, the
 * #560 record): `standard` is what makes `'self'` match the scheme and relative URLs resolve
 * (without it every script and stylesheet is refused); `secure` makes the pages a secure context
 * (`getUserMedia` for dictation, `crypto.randomUUID`). Module scripts with `crossorigin`, dynamic
 * `import()` (pdf.js's decoders), stylesheets, fonts and XHR all load with those two alone.
 * `supportFetchAPI` would only enable `fetch()` of the scheme, which nothing uses; `corsEnabled`,
 * `stream`, `codeCache` and `allowExtensions` have no use here. `bypassCSP` and
 * `allowServiceWorkers` must stay false — the CSP is the point.
 */
export const APP_SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  bypassCSP: false,
  allowServiceWorkers: false,
  supportFetchAPI: false,
  corsEnabled: false,
  stream: false,
  codeCache: false,
  allowExtensions: false
}) satisfies Readonly<Required<Privileges>>

export type AppPage = 'index' | 'ocr'

/** The URL a window loads for one of the app's pages. */
export function appPageUrl(page: AppPage): string {
  return `${APP_ORIGIN}/${page}.html`
}

/** Content types by extension — exactly what the renderer build emits. An extension missing here
 *  is refused; tests/integration/app-protocol-assets.test.ts fails when the build emits one. */
export const APP_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
})

/** A path segment the resolver accepts: what Vite's hashed asset names, the brand files and the
 *  pdf.js decoders are made of. Excludes `%`, `\`, `/`, `:`, `$`, spaces and control characters. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/

function mimeTypeOf(relPath: string): string | null {
  const dot = relPath.lastIndexOf('.')
  if (dot <= relPath.lastIndexOf('/')) return null
  return APP_MIME_TYPES[relPath.slice(dot).toLowerCase()] ?? null
}

/**
 * Resolve a request to one enumerated renderer file, or `null` (refuse). Pure: `files` holds the
 * root-relative paths, `/`-separated, as `listAppAssets` returns them.
 */
export function resolveAppAsset(
  rawUrl: string,
  method: string,
  files: ReadonlySet<string>
): { relPath: string; contentType: string } | null {
  if (method !== 'GET') return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null
  const path = url.pathname
  if (!path.startsWith('/') || path.includes('%')) return null
  const segments = path.slice(1).split('/')
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || !SEGMENT.test(s)) return null
  }
  const relPath = segments.join('/')
  if (!files.has(relPath)) return null
  const contentType = mimeTypeOf(relPath)
  return contentType === null ? null : { relPath, contentType }
}

/** The headers on every response the handler returns, refusals included. */
export function appResponseHeaders(contentType?: string): Record<string, string> {
  return {
    ...(contentType ? { 'Content-Type': contentType } : {}),
    'Content-Security-Policy': buildCsp(false),
    'X-Content-Type-Options': 'nosniff'
  }
}

/** The host of the in-memory print pages (#563). */
export const PRINT_HOST = 'print'
/** Their origin — not `APP_ORIGIN`, so the app's pages cannot read a print page. */
export const PRINT_ORIGIN = `${APP_SCHEME}://${PRINT_HOST}`
/** At most this many prints hold a page at once. Each holds one rendered pack in memory and a
 *  hidden window; four concurrent exports already take four save dialogs. */
export const PRINT_MAX_PENDING = 4

/** A print token: 32 random bytes, lowercase hex. */
const PRINT_TOKEN = /^[0-9a-f]{64}$/

/** A page held for one print: the URL its window loads, and the release its `finally` calls. */
export interface PrintPageSlot {
  url: string
  release: () => void
}

/**
 * The pending print pages (#563), keyed by a random token — the print host's allowlist. A slot
 * runs from `open` to `release` (the print's `finally`). Its page is served AT MOST ONCE: the
 * handler's `take` removes it, so a reload or a second request gets a 404. Printing renders the
 * document already loaded and does not fetch it again (measured).
 */
export class PrintPages {
  private readonly pages = new Map<string, string>()
  private readonly slots = new Set<string>()

  constructor(
    private readonly max: number = PRINT_MAX_PENDING,
    private readonly newToken: () => string = () => randomBytes(32).toString('hex')
  ) {}

  /** Hold `html` for one print. Throws, before anything else happens, when `max` prints already
   *  hold a slot. */
  open(html: string): PrintPageSlot {
    if (this.slots.size >= this.max) throw new Error('evidence pdf: too many prints at once')
    const token = this.newToken()
    if (!PRINT_TOKEN.test(token) || this.slots.has(token)) {
      throw new Error('evidence pdf: could not mint a print token')
    }
    this.slots.add(token)
    this.pages.set(token, html)
    let released = false
    return {
      url: `${PRINT_ORIGIN}/${token}`,
      release: () => {
        if (released) return
        released = true
        this.pages.delete(token)
        this.slots.delete(token)
      }
    }
  }

  /** The handler's read: the page for `token`, removed as it is returned (one-shot). */
  take(token: string): string | null {
    const html = this.pages.get(token)
    if (html === undefined) return null
    this.pages.delete(token)
    return html
  }

  /** Prints currently holding a slot. */
  get pending(): number {
    return this.slots.size
  }
}

/** The app's one registry: the handler serves from it, `print-pdf.ts` opens slots in it. */
export const printPages = new PrintPages()

/**
 * The print host's syntax layer: the token a request names, or `null` (refuse). Exactly the
 * scheme and the print host, no credentials or port, GET, and a path of `/` plus one token —
 * nothing else, not even a query. Whether the token is pending is `PrintPages.take`'s call.
 */
export function resolvePrintToken(rawUrl: string, method: string): string | null {
  if (method !== 'GET') return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== PRINT_HOST) return null
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '') return null
  const token = url.pathname.slice(1)
  return url.pathname.startsWith('/') && PRINT_TOKEN.test(token) ? token : null
}

/** The headers of a served print page: the pack's own policy, no sniffing, nothing cached. */
export function printResponseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': EVIDENCE_PACK_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  }
}

export interface AppProtocolHandlerDeps {
  /** Root-relative paths of every servable file (see `listAppAssets`). */
  files: ReadonlySet<string>
  /** Read one of those files; `relPath` is always a member of `files`. */
  readFile: (relPath: string) => Promise<Uint8Array<ArrayBuffer>>
  /** The pending print pages (#563); the print host serves nothing without them. */
  printPages?: Pick<PrintPages, 'take'>
}

/** The `protocol.handle` callback. A refused request — or a read that fails — is a 404 with an
 *  empty body: the reason never leaks to the page. */
export function createAppProtocolHandler(deps: AppProtocolHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const token = resolvePrintToken(request.url, request.method)
    if (token !== null) {
      const html = deps.printPages?.take(token) ?? null
      if (html !== null) return new Response(html, { status: 200, headers: printResponseHeaders() })
      return new Response(null, { status: 404, headers: appResponseHeaders() })
    }
    const hit = resolveAppAsset(request.url, request.method, deps.files)
    if (hit) {
      try {
        const body = await deps.readFile(hit.relPath)
        return new Response(body, { status: 200, headers: appResponseHeaders(hit.contentType) })
      } catch {
        /* fall through to the refusal */
      }
    }
    return new Response(null, { status: 404, headers: appResponseHeaders() })
  }
}

/** The slice of `node:fs` the enumeration needs — injectable for tests. */
export interface AssetDirReader {
  readdir(dir: string): string[]
  kind(path: string): 'file' | 'dir' | 'other'
}

/**
 * Enumerate every regular file under `root` as a root-relative, `/`-separated path. A missing root
 * yields an empty set (the dev server case: nothing is built, so nothing is served). Names the
 * resolver could never request (outside `SEGMENT`) are left out rather than half-served.
 */
export function listAppAssets(root: string, fs: AssetDirReader, join: (a: string, b: string) => string): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string, prefix: string): void => {
    let names: string[]
    try {
      names = fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!SEGMENT.test(name) || name === '.' || name === '..') continue
      const full = join(dir, name)
      const kind = fs.kind(full)
      if (kind === 'dir') walk(full, `${prefix}${name}/`)
      else if (kind === 'file') out.add(`${prefix}${name}`)
    }
  }
  walk(root, '')
  return out
}

/**
 * The main window's navigation predicate (SEC-3 guard): the dev server's exact origin when the
 * window loads one, else exactly the app's index page. Replaces the prefix checks
 * (`startsWith('file://')` let any local file through; `startsWith('http://localhost')` also
 * matched `http://localhost.example`).
 */
export function createMainWindowNavigationPredicate(devServerUrl: string | undefined): (url: string) => boolean {
  if (devServerUrl) {
    let devOrigin: string
    try {
      devOrigin = new URL(devServerUrl).origin
    } catch {
      return () => false
    }
    return (url) => {
      try {
        return new URL(url).origin === devOrigin
      } catch {
        return false
      }
    }
  }
  return (url) => {
    try {
      const u = new URL(url)
      return (
        u.protocol === `${APP_SCHEME}:` &&
        u.host === APP_HOST &&
        u.username === '' &&
        u.password === '' &&
        u.port === '' &&
        u.pathname === '/index.html'
      )
    } catch {
      return false
    }
  }
}
