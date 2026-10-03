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
// Deliberately no runtime `electron` import (type-only is fine): the module must be unit-testable
// under plain vitest (the window-security.ts pattern). The Electron glue is install-app-protocol.ts.

import type { Privileges } from 'electron'
import { buildCsp } from './window-security'

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

export interface AppProtocolHandlerDeps {
  /** Root-relative paths of every servable file (see `listAppAssets`). */
  files: ReadonlySet<string>
  /** Read one of those files; `relPath` is always a member of `files`. */
  readFile: (relPath: string) => Promise<Uint8Array<ArrayBuffer>>
}

/** The `protocol.handle` callback. A refused request — or a read that fails — is a 404 with an
 *  empty body: the reason never leaks to the page. */
export function createAppProtocolHandler(deps: AppProtocolHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
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
