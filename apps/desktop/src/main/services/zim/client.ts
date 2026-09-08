import http from 'node:http'
import { log } from '../logging'
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
  /**
   * The `Location` response header, verbatim, when the server sent one — additive (#301 P7 T19):
   * only `fetchArticleHtml`'s redirect leg reads it, every other caller is unchanged.
   */
  location?: string
  /**
   * The `Content-Range` response header, verbatim, when the server sent one (#339 D-Z22). Only
   * the `/raw` resume leg reads it — to prove a resumed tail really is the tail it asked for.
   */
  contentRange?: string
}

/** The bytes-level shape of one response, before the UTF-8 decode `kiwixGet` applies. The
 *  `/raw` reader assembles a resumed body from BYTES: a stall can cut a multi-byte character
 *  in half, and decoding the halves separately would corrupt it (D-Z22). */
interface KiwixRawResponse {
  status: number
  body: Buffer
  location?: string
  contentRange?: string
  /** The declared `Content-Length`, when the server sent a parseable one. */
  contentLength: number | null
}

/**
 * The rejection of a `kiwixGet` whose OWN per-request timeout fired (#301 P7 T19) — NEVER a
 * caller abort, which keeps rejecting with the caller's own reason so the #159 `AbortError`
 * convention, the ask deadline and the lock are unchanged.
 *
 * Purely additive: every existing caller still just sees "the request rejected" on a timeout
 * (`probeSearchable` → unknown, the `serve.ts` health probe → not healthy, `searchPack` → the
 * arm's `search-failed`). Only `fetchArticleHtml` reads the class — to separate "this attempt's
 * own timer elapsed before the body completed" (retryable) from a socket error, an over-ceiling
 * body or a completed HTTP status (not retryable). `headersReceived` / `bytesReceived` are
 * DIAGNOSTIC ONLY: the measured kiwix-serve fault arrives with both of them set.
 */
export class KiwixTimeoutError extends Error {
  /** The budget that elapsed — the whole-request one for `'total'`, the inter-chunk one for
   *  `'idle'`. */
  readonly timeoutMs: number
  /**
   * WHICH timer fired (#339 D-Z22). `'total'` — the whole attempt's budget elapsed (the only
   * kind before D-Z22). `'idle'` — headers had arrived and then no byte came for `idleMs`,
   * which is the measured kiwix-serve stall signature and is caught far sooner than the total.
   */
  readonly kind: 'idle' | 'total'
  /** True when the server had already sent response headers when the budget elapsed. */
  readonly headersReceived: boolean
  /** Body bytes received before the budget elapsed (the truncation point of a T19 stall). */
  readonly bytesReceived: number
  /** The status line already received, when there was one. */
  readonly status: number | null
  /** The `Content-Length` the server declared, when it declared a parseable one. */
  readonly contentLength: number | null
  /**
   * The body bytes actually received, verbatim — the RESUME input of `readRawArticle`, never
   * logged and never handed to a caller as an article. Empty when nothing arrived.
   */
  readonly partial: Buffer
  constructor(fields: {
    timeoutMs: number
    kind: 'idle' | 'total'
    headersReceived: boolean
    status: number | null
    contentLength: number | null
    partial: Buffer
  }) {
    const bytesReceived = fields.partial.length
    super(
      (fields.kind === 'idle'
        ? `kiwix-serve sent no further byte for ${fields.timeoutMs} ms`
        : `kiwix-serve did not answer within ${fields.timeoutMs} ms`) +
        (fields.headersReceived
          ? ` (headers received, ${bytesReceived} body bytes, incomplete)`
          : ' (no response headers)')
    )
    this.name = 'KiwixTimeoutError'
    this.timeoutMs = fields.timeoutMs
    this.kind = fields.kind
    this.headersReceived = fields.headersReceived
    this.bytesReceived = bytesReceived
    this.status = fields.status
    this.contentLength = fields.contentLength
    this.partial = fields.partial
  }
}

/**
 * GET one path from the sidecar. Resolves with status + UTF-8 body (non-2xx included —
 * the caller maps statuses); rejects on network error, timeout, caller abort, or an
 * over-ceiling body. A timeout rejects with `KiwixTimeoutError`; a caller abort rejects
 * with whatever the caller's signal aborted with.
 */
export function kiwixGet(
  port: number,
  path: string,
  opts: KiwixGetOptions = {}
): Promise<KiwixResponse> {
  return kiwixGetRaw(port, path, opts).then((res) => ({
    status: res.status,
    body: res.body.toString('utf8'),
    ...(res.location !== undefined ? { location: res.location } : {}),
    ...(res.contentRange !== undefined ? { contentRange: res.contentRange } : {})
  }))
}

/** What `kiwixGet` (and the `/raw` reader beneath it) accepts. `headers` and `idleMs` are
 *  #339 D-Z22 additions; only the `/raw` article route passes either. */
export interface KiwixGetOptions {
  /** The whole-attempt budget. Rejects with `KiwixTimeoutError` `kind: 'total'`. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Extra request headers — the `/raw` route's `Range` and nothing else today. */
  headers?: Record<string, string>
  /**
   * The INTER-CHUNK budget, armed when headers arrive and re-armed on every data chunk;
   * 0 / omitted disables it. Rejects with `KiwixTimeoutError` `kind: 'idle'`, which carries the
   * bytes received so far so a `/raw` read can resume rather than start over (D-Z22).
   */
  idleMs?: number
}

/** The bytes-level `kiwixGet` — see `kiwixGet` for the contract; only the decode differs. */
function kiwixGetRaw(
  port: number,
  path: string,
  opts: KiwixGetOptions = {}
): Promise<KiwixRawResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const idleMs = opts.idleMs ?? 0
  const combined = combineSignals(opts.signal, timeoutMs)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  return new Promise<KiwixRawResponse>((resolve, reject) => {
    let headersReceived = false
    let status: number | null = null
    let contentLength: number | null = null
    let chunks: Buffer[] = []
    let size = 0
    /** Set by the inter-chunk timer just before it tears the request down, so `fail` can tell
     *  its own destroy from a genuine socket error (the request was never aborted). */
    let idleFired = false
    /**
     * Classify a transport failure. `combineSignals` aborts the combined signal for exactly two
     * reasons — the caller's signal, or its own timer — so "the combined signal fired while the
     * CALLER's did not" is the timeout, and the caller's abort keeps precedence in the race.
     * The idle timer is checked first and under the same caller-abort precedence.
     */
    const fail = (err: unknown): void => {
      if (opts.signal?.aborted === true) {
        // The caller's cancellation wins every race (the H4 contract). Normally node's own
        // abort error arrives here and is passed through; but the inter-chunk timer tears the
        // request down with an error of OUR making, so a caller aborting a heartbeat later
        // would otherwise surface THAT instead of the abort. Rebuild it in that one case.
        reject(
          err instanceof Error && err.name === 'AbortError'
            ? err
            : new DOMException('The knowledge-pack request was cancelled', 'AbortError')
        )
        return
      }
      if (idleFired || combined.signal.aborted) {
        reject(
          new KiwixTimeoutError({
            timeoutMs: idleFired ? idleMs : timeoutMs,
            kind: idleFired ? 'idle' : 'total',
            headersReceived,
            status,
            contentLength,
            partial: Buffer.concat(chunks)
          })
        )
        return
      }
      reject(err)
    }
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path,
        agent,
        signal: combined.signal,
        ...(opts.headers ? { headers: opts.headers } : {})
      },
      (res) => {
        headersReceived = true
        status = res.statusCode ?? 0
        contentLength = toCount(res.headers['content-length'] ?? null)
        // Armed on the headers and re-armed on every chunk: a healthy read is never quiet for
        // long (max inter-chunk gap 24.6 ms on NVMe, 17.8 ms off the USB Kit drive — D-Z22),
        // while the measured stall is silence with the connection left open.
        const armIdle = (): void => {
          if (idleMs <= 0) return
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            idleFired = true
            req.destroy(new Error('kiwix-serve stalled mid-body'))
          }, idleMs)
          ;(idleTimer as { unref?: () => void }).unref?.()
        }
        armIdle()
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            clearTimeout(idleTimer)
            chunks = []
            res.destroy()
            reject(new Error(`kiwix-serve response exceeded ${MAX_BODY_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
          armIdle()
        })
        res.on('end', () => {
          const location = res.headers.location
          const contentRange = res.headers['content-range']
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            contentLength,
            ...(typeof location === 'string' ? { location } : {}),
            ...(typeof contentRange === 'string' ? { contentRange } : {})
          })
        })
        res.on('error', fail)
      }
    )
    req.on('error', fail)
  }).finally(() => {
    clearTimeout(idleTimer)
    combined.clear()
  })
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
  /**
   * The archive's own `tags` attribute, verbatim (`;`-separated, e.g.
   * `wikipedia;_ftindex:yes;_pictures:no`). Read for the `_ftindex` HINT only
   * (`ftIndexHint`) — a tag never confirms searchability (#301 P4, finding M7, plan §2.5).
   */
  tags: string | null
}

/**
 * The archive's `_ftindex` tag as a HINT (#301 P4, finding M7; plan §9.21 (d)2). `_ftindex:yes`
 * ⇒ `'yes'`, `_ftindex:no` ⇒ `'no'`, a bare legacy `_ftindex` ⇒ `'yes'`, no such tag ⇒ null.
 *
 * A hint is stored in `knowledge_packs.ftindex_hint` and NOTHING else: it never sets
 * `searchable`, never affects an ask's eligibility, and never contradicts a live probe. The
 * archive says what it believes about itself; only the `/suggest` probe against the running
 * server establishes what the sidecar can actually search (§2.5 items 1 and 4).
 */
export function ftIndexHint(tags: string | null): 'yes' | 'no' | null {
  if (tags === null) return null
  for (const raw of tags.split(';')) {
    const tag = raw.trim().toLowerCase()
    if (tag === '_ftindex' || tag === '_ftindex:yes') return 'yes'
    if (tag === '_ftindex:no') return 'no'
  }
  return null
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
      path: decode(attrValue(attrs, 'path')),
      tags: decode(attrValue(attrs, 'tags'))
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

/**
 * Parse the OpenSearch `<opensearch:totalResults>` count a `format=xml` search response
 * carries — the archive-wide hit count for the pattern, independent of the `pageLength` asked
 * for. Null when the element is absent or its content does not parse as a non-negative integer
 * (#353 document-frequency ladder — the ladder treats "unknown" and "absent" the same way).
 */
export function parseSearchTotal(xml: string): number | null {
  const m = /<opensearch:totalResults>([^<]*)<\/opensearch:totalResults>/.exec(xml)
  return m ? toCount(m[1] ?? null) : null
}

/**
 * The archive-wide hit COUNT for one term, via the same `/search` route as `searchPack` with
 * `pageLength=1` — the smallest page that still makes kiwix-serve compute and report the total.
 * This is the document-frequency PROBE the #353 ladder uses to narrow a pattern that found
 * nothing (`arm.ts` `runPack`, `query-rewrite.ts` `narrowByFrequency`). Same failure contract as
 * `searchPack`: throws on a non-200 status OR a timeout; resolves `null` when the response lacks
 * (or does not parse) `<opensearch:totalResults>`.
 */
export async function searchPackTotal(
  port: number,
  bookUuid: string,
  pattern: string,
  signal?: AbortSignal,
  /** The probe's own per-request timeout (`arm.ts` `DF_PROBE_TIMEOUT_MS`) — deliberately
   *  shorter than `DEFAULT_TIMEOUT_MS`, so one stalled probe cannot sit out the client's whole
   *  15 s default under the arm's single 20 s per-ask deadline. Production always sets it. */
  opts: { timeoutMs?: number } = {}
): Promise<number | null> {
  const path =
    `/search?books.id=${encodeURIComponent(bookUuid)}` +
    `&pattern=${encodeURIComponent(pattern)}&format=xml&pageLength=1`
  const res = await kiwixGet(port, path, { signal, timeoutMs: opts.timeoutMs })
  if (res.status !== 200) {
    throw new Error(`kiwix-serve search failed (HTTP ${res.status})`)
  }
  return parseSearchTotal(res.body)
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

// ---- /suggest capability probe --------------------------------------------------

/**
 * The term the capability probe sends. A NON-EMPTY, short, language-neutral term is used
 * deliberately: an empty term would make the verdict depend on libkiwix's empty-term handling,
 * which is not part of the contract we pinned (§2.2). Its only job is to make the server
 * produce its suggestion envelope — the synthetic `kind:"pattern"` entry, which libkiwix adds
 * ONLY when the book has a full-text index, is what is read, never the suggestions themselves.
 */
export const SUGGEST_PROBE_TERM = 'the'

/**
 * Ask a running kiwix-serve whether ONE served book can be full-text searched (#301 P4,
 * finding M7; plan §2.5 and §9.21 (d)4).
 *
 *   `'yes'`  — HTTP 200 AND the body parses as a JSON ARRAY containing an entry with
 *              `kind === 'pattern'` (libkiwix adds that entry only with a Xapian index).
 *   `'no'`   — HTTP 200 AND a valid JSON array WITHOUT such an entry: the only shape that
 *              may ever be persisted as "this archive has no full-text index".
 *   `null`   — UNKNOWN, for everything else: a 404 (ambiguous — unknown name, absent entry),
 *              any other non-200, a non-array or malformed body, a timeout, a network error.
 *              Unknown is never written as `'no'`; the pack is simply probed again later.
 *
 * Never throws except for the CALLER's own abort (a lock or a cancelled reconcile), which
 * propagates as the #159 `AbortError` so no verdict is written under a closing session.
 */
export async function probeSearchable(
  port: number,
  name: string,
  signal?: AbortSignal,
  /** Test seam only: the per-request timeout, so the "a timeout stays unknown" leg does not
   *  have to sit out the client's real 15 s default. Production never passes it. */
  opts: { timeoutMs?: number } = {}
): Promise<'yes' | 'no' | null> {
  const path =
    `/suggest?content=${encodeURIComponent(name)}` +
    `&term=${encodeURIComponent(SUGGEST_PROBE_TERM)}&count=1`
  let res: KiwixResponse
  try {
    res = await kiwixGet(port, path, { signal, timeoutMs: opts.timeoutMs })
  } catch (err) {
    if (signal?.aborted) throw err // the caller's cancellation, never a capability verdict
    return null // timeout, network error, over-ceiling body: unknown
  }
  if (res.status !== 200) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(res.body)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const hasPattern = parsed.some(
    (entry) =>
      typeof entry === 'object' && entry !== null && (entry as { kind?: unknown }).kind === 'pattern'
  )
  return hasPattern ? 'yes' : 'no'
}

/**
 * Title-index lookup (#340 L3-b, D-Z20): the `/suggest` entries whose title starts with `term`,
 * as search-hit-shaped rows the arm can fetch. On the pinned kiwix-serve the route answers
 * `[{ value, label, kind: "path", path }]` — `value` is the article title, `path` the SAME entry
 * key a search hit's link carries, so `/raw/<name>/content/<path>` serves it directly (verified
 * on the real server 2026-09-07); the synthetic `kind: "pattern"` entry (the capability probe's
 * signal) is skipped. Prefix-only and case-/diacritic-sensitive by nature (residual R-6) — that is
 * why the arm only ever calls it with a title the expansion synthesised, never with the question.
 * Same failure contract as `searchPack`: throws on a non-200 status or a timeout; a body that is
 * not a JSON array yields no rows.
 */
export async function suggestTitles(
  port: number,
  name: string,
  term: string,
  count: number,
  signal?: AbortSignal,
  opts: { timeoutMs?: number } = {}
): Promise<KiwixSearchHit[]> {
  const path =
    `/suggest?content=${encodeURIComponent(name)}` +
    `&term=${encodeURIComponent(term)}&count=${count}`
  const res = await kiwixGet(port, path, { signal, timeoutMs: opts.timeoutMs })
  if (res.status !== 200) {
    throw new Error(`kiwix-serve suggest failed (HTTP ${res.status})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.body)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const hits: KiwixSearchHit[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { kind?: unknown; value?: unknown; path?: unknown }
    if (e.kind !== 'path' || typeof e.value !== 'string' || typeof e.path !== 'string') continue
    const title = decodeEntities(e.value).trim()
    const articlePath = safeDecodeURIComponent(e.path)
    if (title === '' || articlePath === '') continue
    hits.push({ title, urlId: name, articlePath, wordCount: null })
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

/** The redirect statuses a `/raw/…/content/` read can answer with (kiwix-serve 3.8.1 sends 302). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308])

/** The one `/raw` route builder — `encodeArticlePath` (and therefore `assertArticlePath`) owns
 *  the entry key, `encodeURIComponent` the serving name. */
function rawContentPath(name: string, articlePath: string): string {
  return `/raw/${encodeURIComponent(name)}/content/${encodeArticlePath(articlePath)}`
}

/**
 * The entry key a redirect `Location` points at within the SAME book, or null when the
 * location is anything we refuse to follow (#301 P7 T19).
 *
 * Accepted: a PATH-ABSOLUTE `/content/<name>/<target>` (what kiwix-serve answers — the viewer
 * route, not `/raw`) or `/raw/<name>/content/<target>`, where `<name>` URL-decodes to EXACTLY
 * the `name` we asked under. Refused, as null: another book's name (the viewer must never show
 * another book's text — finding L4), an absolute-URL or protocol-relative location, a relative
 * reference, an unparseable one, and a target the entry-key contract refuses (finding L5;
 * `assertArticlePath` never THROWS for a server-supplied target — that throw is for
 * caller-supplied keys, at the first request only).
 */
function redirectTargetFor(name: string, location: string | undefined): string | null {
  if (location === undefined) return null
  if (!location.startsWith('/') || location.startsWith('//')) return null
  const m =
    /^\/content\/([^/]+)\/(.+)$/.exec(location) ?? /^\/raw\/([^/]+)\/content\/(.+)$/.exec(location)
  if (!m) return null
  if (safeDecodeURIComponent(m[1]) !== name) return null
  // Per SEGMENT — the exact inverse of `encodeArticlePath`, so an already-encoded slash inside
  // one segment stays inside it and the re-encode round-trips (`a%252Fb` → `a%2Fb` → `a%252Fb`).
  const target = m[2].split('/').map(safeDecodeURIComponent).join('/')
  try {
    assertArticlePath(target)
  } catch {
    return null
  }
  return target
}

/**
 * The per-ATTEMPT budget of one `/raw` article read, and how many attempts it gets.
 *
 * #301 P7 T19: kiwix-serve 3.8.1 (win-x86_64) cuts ~5–20 % of `/raw` reads above ~80 KB short —
 * the status line and most of the body arrive, the last part never does; the per-attempt timeout
 * detects it and the read is retried on a fresh connection. Client- and thread-count-independent,
 * and the truncation point is the same for a given entry every time (Treibhauseffekt stops at
 * 195,590 of 234,141 bytes). Measurement: `docs/rag-design.md` §17 "Real acceptance (T19, P7)".
 *
 * Since #339 (D-Z22) the app no longer TRIGGERS that defect — every article request carries
 * `Range: bytes=0-` (`RANGE_WHOLE_BODY`), which routes the read through libkiwix's callback
 * reader — and `ARTICLE_READ_IDLE_MS` is the detector that fires first. These two constants stay
 * as the SAFETY NET for a build, a route or a platform the Range mitigation does not cover.
 *
 * 4 s is a STALL DETECTOR, not a throughput bound: a healthy loopback read of a 700 KB entry
 * takes ~10–80 ms on the measurement machine (a stalling one delivers its truncated body in
 * 3–6 ms and then hangs), and a 1 MiB article off a USB drive on the i7-8550U reference is
 * still far under a second. Three attempts × 4 s = 12 s worst case — under the client's old
 * 15 s default and under the 20 s per-ask deadline — while three consecutive stalls have
 * probability ≈ 0.1–0.8 %.
 */
export const ARTICLE_READ_TIMEOUT_MS = 4_000
/** Total `/raw` attempts per request, the first one included (see `ARTICLE_READ_TIMEOUT_MS`).
 *  Every request counts — a fresh read and a resume alike. */
export const ARTICLE_READ_ATTEMPTS = 3

/**
 * The INTER-CHUNK budget of a `/raw` article read (#339, `docs/rag-design.md` §17 D-Z22).
 *
 * A healthy read is fast and never quiet: measured through this very stack (node:http,
 * `keepAlive: false`, loopback) the largest gap between two body chunks was **24.6 ms** on the
 * NVMe measurement machine and **17.8 ms** off the USB Kit drive on K: (p90 ≤ 16.5 / 13.9;
 * time-to-first-byte ≤ 11 ms, whole 974 KB body ≤ 31 ms). A stall is silence after the last
 * chunk with the connection left open. 1,000 ms is therefore ~40× the worst gap either drive
 * produced — far enough above the noise to never cut a live read, and four times sooner than
 * the whole-attempt `ARTICLE_READ_TIMEOUT_MS` ceiling that used to be the only detector.
 */
export const ARTICLE_READ_IDLE_MS = 1_000

/**
 * The `Range` header every `/raw` article request carries (#339 D-Z22), the redirect hop
 * included. libkiwix resolves `bytes=0-` as PARTIAL content even though it spans the whole
 * entry (`byte_range.cpp`), so the article is served through the 16 KiB callback reader instead
 * of the one-buffer path that carries the Windows cut-short defect: **0 bad in 800 curl reads +
 * 160 hop reads + 160 node:http reads** across four server configurations and five entries,
 * while the interleaved plain reads stalled 442/800. A server that ignores the header answers
 * `200` and everything still works.
 */
const RANGE_WHOLE_BODY = 'bytes=0-'

/**
 * One `/raw` read: Range-first, with the stall retry (#301 P7 T19, #339 D-Z22).
 *
 * Every request carries `Range` — `bytes=0-` for a whole entry, `bytes=<received>-` for a
 * resume. The retryable signature is exactly one thing: THIS ATTEMPT'S OWN TIMER elapsed before
 * the body completed, the inter-chunk one (`kind: 'idle'`, the stall's own signature) or the
 * whole-attempt one (`kind: 'total'`) — whether or not headers and part of the body had already
 * arrived. The measured fault arrives WITH both (200, a `Content-Length`, and ~85 % of the bytes
 * in 3–6 ms, then silence).
 *
 * A stall that left a well-defined prefix is RESUMED rather than re-read: measured on the real
 * server, `Range: bytes=<received>-` answers the missing tail byte-exactly in ~6 ms (3/3, and
 * again 3/3 off the USB Kit drive). The tail is accepted only against proof — `206` with
 * `Content-Range` exactly `bytes <received>-<len-1>/<len>` and a tail of exactly the promised
 * length. Anything else discards the prefix and reads the whole entry again. Bytes are joined
 * BEFORE the UTF-8 decode, because a stall can cut a multi-byte character in half. A partial
 * body never reaches a caller either way.
 *
 * NEVER retried when: the caller's signal aborted — checked first, its reason propagates at once
 * (the ask deadline, a cancellation, a lock: the H4 contract); a non-timeout socket error ended
 * the attempt; the body went over `MAX_BODY_BYTES`; or any HTTP status completed
 * (200/206/404/redirect/other — existing semantics stand).
 *
 * This lives INSIDE one request-guard window (`ZimService.withServer`, index.ts): the server
 * tuple cannot change across a stall that never reached the server's lifecycle, so the guard's
 * single admitted lifecycle retry is untouched and no double-retry semantics arise — which is
 * also what makes a resume safe: the pack file cannot be swapped underneath it (a lock or pack
 * change aborts through the caller's signal, which keeps precedence over every retry).
 */
async function readRawArticle(
  port: number,
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  idleMs: number
): Promise<KiwixResponse> {
  /** Set only while the PREVIOUS attempt left a usable prefix; cleared the moment a resume is
   *  refused, so the fallback is always an ordinary whole-entry read. */
  let pending: { prefix: Buffer; total: number } | null = null
  for (let attempt = 1; ; attempt++) {
    // Annotated: the resume decision below reads `from`, which TypeScript would otherwise chase
    // back through `pending` into its own initializer.
    const from: number = pending?.prefix.length ?? 0
    try {
      const res = await kiwixGetRaw(port, path, {
        signal,
        timeoutMs,
        idleMs,
        headers: { Range: from === 0 ? RANGE_WHOLE_BODY : `bytes=${from}-` }
      })
      if (pending === null) return decodeRaw(res)
      // A resume is accepted ONLY on proof that this really is the tail that was asked for.
      const { prefix, total } = pending
      pending = null
      const expected = `bytes ${from}-${total - 1}/${total}`
      if (res.status !== 206 || res.contentRange !== expected || res.body.length !== total - from) {
        // A `200` from a server ignoring Range, a `416`, a mismatching range, a short tail: the
        // prefix is worthless and is dropped. The loop falls through to a fresh whole-entry read.
        log.warn('kiwix-serve refused a knowledge-pack article resume — reading the whole entry', {
          route: 'raw',
          attempt,
          status: res.status,
          hasContentRange: res.contentRange !== undefined
        })
        if (attempt >= ARTICLE_READ_ATTEMPTS) {
          throw new Error(`kiwix-serve article fetch failed (HTTP ${res.status}, resume refused)`)
        }
        continue
      }
      // Concatenated as BYTES, then decoded once: a stall can cut a multi-byte character in half.
      return decodeRaw({ ...res, body: Buffer.concat([prefix, res.body]) })
    } catch (err) {
      if (signal?.aborted === true) throw err
      if (!(err instanceof KiwixTimeoutError)) throw err
      if (attempt >= ARTICLE_READ_ATTEMPTS) throw err
      // Resume only where the tail is well defined: headers arrived, the status is a body
      // status, the server declared a length, and part — but not all — of it is in hand.
      // Resumes are never CHAINED: a stalled resume's bytes only mean what its own
      // `Content-Range` said, so the prefix is dropped and the next attempt reads the whole
      // entry. Two stalls in one read are already a ~0.1 % event, and a Range read has never
      // stalled in 1,120 measured reads (D-Z22) — depth is not worth the ambiguity.
      pending =
        from === 0 &&
        err.headersReceived &&
        (err.status === 200 || err.status === 206) &&
        err.contentLength !== null &&
        // The assembled body is exactly `contentLength` bytes by the acceptance rule below, so
        // this is where `MAX_BODY_BYTES` applies to it: an over-ceiling entry is never
        // assembled, and the fresh read that follows rejects on the ceiling as it always did.
        err.contentLength <= MAX_BODY_BYTES &&
        err.bytesReceived > 0 &&
        err.bytesReceived < err.contentLength
          ? { prefix: err.partial, total: err.contentLength }
          : null
      // No path and no serving name (finding L1): the route class plus the truncation shape is
      // all a log line may carry — enough to recognise the T19 fault in a diagnostics tail.
      log.warn('kiwix-serve cut a knowledge-pack article read short — retrying', {
        route: 'raw',
        attempt,
        kind: err.kind,
        timeoutMs: err.timeoutMs,
        headersReceived: err.headersReceived,
        bytesReceived: err.bytesReceived,
        resume: pending !== null
      })
    }
  }
}

/** The UTF-8 view of a bytes-level response — the shape every `/raw` caller sees. */
function decodeRaw(res: KiwixRawResponse): KiwixResponse {
  return {
    status: res.status,
    body: res.body.toString('utf8'),
    ...(res.location !== undefined ? { location: res.location } : {}),
    ...(res.contentRange !== undefined ? { contentRange: res.contentRange } : {})
  }
}

/**
 * Fetch one article's raw HTML. 404 → null (entry vanished between search and fetch,
 * or the pack file changed underneath us — a skip, not a failure); other non-200 → throws.
 *
 * `name` is the SERVING name (`identity.ts` `servingNameFor`), never the file stem: libkiwix
 * ≥ 14 slugifies case, accents, spaces and `+`, so the stem 404s or — worse — names another
 * book (finding L4).
 *
 * #301 P7 T19: kiwix-serve 3.8.1 answers a ZIM redirect entry under /raw with 302 →
 * /content/<book>/<target>; followed one hop, same book only. Roughly half a Wikipedia ZIM's
 * entries are such alias titles, so without the hop the viewer could not open them at all.
 * A second redirect, another book, or a target the entry-key contract refuses ⇒ the honest
 * "unavailable" null. The locator is unchanged by the hop — a citation stays
 * `packId + articlePath` (`docs/rag-design.md` §17 D-Z11).
 *
 * Both requests — the first AND the redirect hop's — go through `readRawArticle`, so either
 * one may be retried on the T19 stall signature (see `ARTICLE_READ_TIMEOUT_MS`).
 */
export async function fetchArticleHtml(
  port: number,
  name: string,
  articlePath: string,
  signal?: AbortSignal,
  /** Test seams only: the per-ATTEMPT timeout and the inter-chunk one, so the stall legs need
   *  not sit out the real 4 s / 1 s (mirrors `probeSearchable`'s `opts.timeoutMs`). Production
   *  never passes either. */
  opts: { timeoutMs?: number; idleMs?: number } = {}
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? ARTICLE_READ_TIMEOUT_MS
  const idleMs = opts.idleMs ?? ARTICLE_READ_IDLE_MS
  const read = (key: string): Promise<KiwixResponse> =>
    readRawArticle(port, rawContentPath(name, key), signal, timeoutMs, idleMs)
  const res = await read(articlePath)
  if (res.status === 404) return null
  if (REDIRECT_STATUSES.has(res.status)) {
    const target = redirectTargetFor(name, res.location)
    if (target === null) return null
    // Exactly ONE more request, under the same signal: a chain is bounded, not followed.
    const hop = await read(target)
    if (isBodyStatus(hop.status)) return hop.body
    if (hop.status === 404 || REDIRECT_STATUSES.has(hop.status)) return null
    throw new Error(`kiwix-serve article fetch failed (HTTP ${hop.status})`)
  }
  if (!isBodyStatus(res.status)) {
    throw new Error(`kiwix-serve article fetch failed (HTTP ${res.status})`)
  }
  return res.body
}

/** The statuses a `/raw` read may answer an ARTICLE with. `206` joined `200` with the
 *  Range-first read (#339 D-Z22) — it is what libkiwix answers `Range: bytes=0-` with, and a
 *  server that ignores the header still answers `200`. */
function isBodyStatus(status: number): boolean {
  return status === 200 || status === 206
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
