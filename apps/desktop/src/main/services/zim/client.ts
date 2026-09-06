import http from 'node:http'
import { combineSignals } from '../runtime/sidecar'
import { attrValue, decodeEntities } from './html'

// Loopback HTTP client for the kiwix-serve sidecar (knowledge packs).
//
// Deliberately node:http, NOT the global fetch the llama sidecars use: Node 24's
// undici crashes with `assert(!this.paused)` on kiwix-serve (libmicrohttpd) response
// framing — reproduced in the 2026-08-22 spike (zim-spike/SPIKE-FINDINGS.md) on both
// keep-alive and `connection: close` requests. A non-keepalive node:http agent is
// stable. All requests are loopback-only by construction (host is hardcoded).

const agent = new http.Agent({ keepAlive: false })

const DEFAULT_TIMEOUT_MS = 15_000
/** Body ceiling — largest observed maxi article is ~0.5 MB of HTML; 8 MiB is generous
 *  headroom while still bounding a pathological entry (the parser caps at 1 MiB anyway). */
const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface KiwixResponse {
  status: number
  body: string
}

/**
 * GET one path from the sidecar. Resolves with status + UTF-8 body (non-2xx included —
 * the caller maps statuses); rejects on network error, timeout, caller abort, or an
 * over-ceiling body.
 */
export function kiwixGet(
  port: number,
  path: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<KiwixResponse> {
  const combined = combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return new Promise<KiwixResponse>((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, agent, signal: combined.signal },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            res.destroy()
            reject(new Error(`kiwix-serve response exceeded ${MAX_BODY_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
  }).finally(() => combined.clear())
}

// ---- library.xml ---------------------------------------------------------------

/** One `<book>` element of a kiwix library.xml, as written by `kiwix-manage add`. */
export interface KiwixBook {
  /** The archive's stable UUID — the `books.id` search filter and our pack id. */
  id: string
  title: string | null
  description: string | null
  language: string | null
  /** ZIM creation date, `YYYY-MM-DD`. */
  date: string | null
  articleCount: number | null
  mediaCount: number | null
  /** The ZIM path exactly as recorded in the XML (as passed to kiwix-manage). */
  path: string | null
}

/** Parse the `<book …/>` elements out of a kiwix library.xml. Unknown books without
 *  an id are skipped; numeric attributes degrade to null, never NaN. */
export function parseLibraryXml(xml: string): KiwixBook[] {
  const books: KiwixBook[] = []
  for (const m of xml.matchAll(/<book\s+([^>]*?)\/?>/g)) {
    const attrs = m[1]
    const id = attrValue(attrs, 'id')
    if (!id) continue
    books.push({
      id,
      title: decode(attrValue(attrs, 'title')),
      description: decode(attrValue(attrs, 'description')),
      language: attrValue(attrs, 'language'),
      date: attrValue(attrs, 'date'),
      articleCount: toCount(attrValue(attrs, 'articleCount')),
      mediaCount: toCount(attrValue(attrs, 'mediaCount')),
      path: decode(attrValue(attrs, 'path'))
    })
  }
  return books
}

// ---- /search -------------------------------------------------------------------

export interface KiwixSearchHit {
  /** Article display title. */
  title: string
  /** URL id of the serving book — the `<urlId>` in `/content/<urlId>/<path>` links.
   *  Parsed from the hit itself, so it tracks whatever naming rule the server applied. */
  urlId: string
  /** Article path within the book (percent-DECODED, ready to re-encode for /raw). */
  articlePath: string
  /** Declared article length in words, when the index carries it. */
  wordCount: number | null
}

/**
 * Full-text search in ONE book via the sidecar's Xapian index.
 * Zero hits → empty array; an error status → throws with the status.
 */
export async function searchPack(
  port: number,
  bookUuid: string,
  pattern: string,
  pageLength: number,
  signal?: AbortSignal
): Promise<KiwixSearchHit[]> {
  const path =
    `/search?books.id=${encodeURIComponent(bookUuid)}` +
    `&pattern=${encodeURIComponent(pattern)}&format=xml&pageLength=${pageLength}`
  const res = await kiwixGet(port, path, { signal })
  if (res.status !== 200) {
    throw new Error(`kiwix-serve search failed (HTTP ${res.status})`)
  }
  return parseSearchXml(res.body)
}

/** Parse the OpenSearch RSS a `format=xml` search returns into hits. */
export function parseSearchXml(xml: string): KiwixSearchHit[] {
  const hits: KiwixSearchHit[] = []
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = item[1]
    const title = /<title>([^<]*)<\/title>/.exec(block)?.[1]
    const link = /<link>([^<]*)<\/link>/.exec(block)?.[1]
    if (!title || !link) continue
    const target = decodeEntities(link)
    const m = /^\/content\/([^/]+)\/(.+)$/.exec(target)
    if (!m) continue
    hits.push({
      title: decodeEntities(title).trim(),
      urlId: m[1],
      articlePath: safeDecodeURIComponent(m[2]),
      wordCount: toCount(/<wordCount>([^<]*)<\/wordCount>/.exec(block)?.[1] ?? null)
    })
  }
  return hits
}

// ---- /raw article fetch --------------------------------------------------------

/** The documented length bound for an archive entry key (#301 P5, finding L5, plan §9.19 (b)):
 *  Wikipedia titles are ≤ 255 bytes and zimit/warc2zim URL-shaped keys reach a few hundred; 2048
 *  is the conventional URL bound with headroom, in UTF-16 code units (`string.length`). */
export const MAX_ARTICLE_PATH_CHARS = 2048

/** Why `assertArticlePath` refused a key. The message carries only this code, NEVER the path
 *  (#301 P5, finding L5). */
export type ArticlePathErrorReason = 'empty' | 'too-long' | 'control' | 'dot-segment' | 'unencodable'

/** Thrown by `assertArticlePath` (and therefore by `encodeArticlePath`) for a hazardous or
 *  unencodable entry key. `message` is the reason CODE, never the path. */
export class ArticlePathError extends Error {
  readonly reason: ArticlePathErrorReason
  constructor(reason: ArticlePathErrorReason) {
    super(reason)
    this.name = 'ArticlePathError'
    this.reason = reason
  }
}

/** Matches any C0 control character or DEL. Built from character codes rather than a regex
 *  escape literal — this toolchain has been observed mangling literal `\u00NN`-style escapes
 *  typed directly into a source edit, so the char-code form is the safe way to express it. */
const CONTROL_OR_DEL_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']'
)

/**
 * The archive-entry-key contract (#301 P5, finding L5, plan §9.19 (b)) — runs FIRST inside
 * `encodeArticlePath`, so there is one place that enforces it. Rejects: an empty key; a key
 * longer than `MAX_ARTICLE_PATH_CHARS`; any C0 control character or DEL; a `.` or `..` SEGMENT
 * anywhere (the `/raw/<book>/content/A/../../x` enumeration vector — a segment that merely
 * STARTS with dots, `..foo` / `.hidden`, is a legal entry name and stays allowed); a lone
 * surrogate (an unencodable key — `encodeURIComponent` itself would throw `URIError`).
 *
 * Compatibility, deliberately kept ALLOWED (tested in `zim-client.test.ts`): empty segments
 * (`A/https://example.com/a//b` — zimit-era URL-shaped keys carry `//`), URL-shaped keys with
 * `: ? # % + & = space` and Unicode, an already-encoded slash inside one segment, namespace-less
 * keys (`Treibhausgas`), namespaced keys (`-/style.css`, `I/img.png`), a trailing dot
 * (`A/Foo.`), and segments that merely start with dots.
 */
export function assertArticlePath(path: string): void {
  if (path.length === 0) throw new ArticlePathError('empty')
  if (path.length > MAX_ARTICLE_PATH_CHARS) throw new ArticlePathError('too-long')
  if (CONTROL_OR_DEL_RE.test(path)) throw new ArticlePathError('control')
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') throw new ArticlePathError('dot-segment')
  }
  try {
    path.split('/').forEach(encodeURIComponent)
  } catch (err) {
    if (err instanceof URIError) throw new ArticlePathError('unencodable')
    throw err
  }
}

/**
 * THE encoder for an archive entry key (#301 P3b, finding L4; plan §9.17 (d)8). Per SEGMENT
 * `encodeURIComponent`, joined by literal `/`: the entry key's own slashes are structure and
 * stay slashes, while every other character — spaces, `+`, `%`, `#`, Unicode, an ENCODED slash
 * inside one segment — is escaped exactly once. Its inverse is `safeDecodeURIComponent`, which
 * `parseSearchXml` applies to a hit's link, so a path round-trips search → citation → viewer
 * unchanged (`my%20wiki` never becomes `my%2520wiki`).
 *
 * ONE owner: nothing else in `src/` may encode an article path. `assertArticlePath` (#301 P5,
 * finding L5, plan §9.19 (b)) runs FIRST, so there is a single place that enforces the contract.
 */
export function encodeArticlePath(articlePath: string): string {
  assertArticlePath(articlePath)
  return articlePath.split('/').map(encodeURIComponent).join('/')
}

/**
 * Fetch one article's raw HTML. 404 → null (entry vanished between search and fetch,
 * or the pack file changed underneath us — a skip, not a failure); other non-200 → throws.
 *
 * `name` is the SERVING name (`identity.ts` `servingNameFor`), never the file stem: libkiwix
 * ≥ 14 slugifies case, accents, spaces and `+`, so the stem 404s or — worse — names another
 * book (finding L4).
 */
export async function fetchArticleHtml(
  port: number,
  name: string,
  articlePath: string,
  signal?: AbortSignal
): Promise<string | null> {
  const encodedPath = encodeArticlePath(articlePath)
  const res = await kiwixGet(port, `/raw/${encodeURIComponent(name)}/content/${encodedPath}`, {
    signal
  })
  if (res.status === 404) return null
  if (res.status !== 200) throw new Error(`kiwix-serve article fetch failed (HTTP ${res.status})`)
  return res.body
}

// ---- helpers -------------------------------------------------------------------

function decode(value: string | null): string | null {
  return value === null ? null : decodeEntities(value)
}

/** "8,245" → 8245; junk → null. */
function toCount(value: string | null): number | null {
  if (value === null) return null
  const n = Number.parseInt(value.replace(/[,.\s]/g, ''), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value // malformed escape — keep verbatim; the re-encode round-trips it
  }
}
