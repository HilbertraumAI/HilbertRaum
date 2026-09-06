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
  /** The per-request budget that elapsed. */
  readonly timeoutMs: number
  /** True when the server had already sent response headers when the budget elapsed. */
  readonly headersReceived: boolean
  /** Body bytes received before the budget elapsed (the truncation point of a T19 stall). */
  readonly bytesReceived: number
  constructor(timeoutMs: number, headersReceived: boolean, bytesReceived: number) {
    super(
      `kiwix-serve did not answer within ${timeoutMs} ms` +
        (headersReceived
          ? ` (headers received, ${bytesReceived} body bytes, incomplete)`
          : ' (no response headers)')
    )
    this.name = 'KiwixTimeoutError'
    this.timeoutMs = timeoutMs
    this.headersReceived = headersReceived
    this.bytesReceived = bytesReceived
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
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<KiwixResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const combined = combineSignals(opts.signal, timeoutMs)
  return new Promise<KiwixResponse>((resolve, reject) => {
    let headersReceived = false
    let size = 0
    /**
     * Classify a transport failure. `combineSignals` aborts the combined signal for exactly two
     * reasons — the caller's signal, or its own timer — so "the combined signal fired while the
     * CALLER's did not" is the timeout, and the caller's abort keeps precedence in the race.
     */
    const fail = (err: unknown): void => {
      if (combined.signal.aborted && opts.signal?.aborted !== true) {
        reject(new KiwixTimeoutError(timeoutMs, headersReceived, size))
        return
      }
      reject(err)
    }
    const req = http.get(
      { host: '127.0.0.1', port, path, agent, signal: combined.signal },
      (res) => {
        headersReceived = true
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            res.destroy()
            reject(new Error(`kiwix-serve response exceeded ${MAX_BODY_BYTES} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const location = res.headers.location
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(typeof location === 'string' ? { location } : {})
          })
        })
        res.on('error', fail)
      }
    )
    req.on('error', fail)
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
 * `searchPack`: throws on a non-200 status; resolves `null` when the response lacks (or does not
 * parse) `<opensearch:totalResults>`.
 */
export async function searchPackTotal(
  port: number,
  bookUuid: string,
  pattern: string,
  signal?: AbortSignal
): Promise<number | null> {
  const path =
    `/search?books.id=${encodeURIComponent(bookUuid)}` +
    `&pattern=${encodeURIComponent(pattern)}&format=xml&pageLength=1`
  const res = await kiwixGet(port, path, { signal })
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
 * 4 s is a STALL DETECTOR, not a throughput bound: a healthy loopback read of a 700 KB entry
 * takes ~10–80 ms on the measurement machine (a stalling one delivers its truncated body in
 * 3–6 ms and then hangs), and a 1 MiB article off a USB drive on the i7-8550U reference is
 * still far under a second. Three attempts × 4 s = 12 s worst case — under the client's old
 * 15 s default and under the 20 s per-ask deadline — while three consecutive stalls have
 * probability ≈ 0.1–0.8 %.
 */
export const ARTICLE_READ_TIMEOUT_MS = 4_000
/** Total `/raw` attempts per request, the first one included (see `ARTICLE_READ_TIMEOUT_MS`). */
export const ARTICLE_READ_ATTEMPTS = 3

/**
 * One `/raw` read with the stall retry (#301 P7 T19). The retryable signature is exactly one
 * thing: THIS ATTEMPT'S OWN TIMER elapsed before the body completed — whether or not headers and
 * part of the body had already arrived. The measured fault arrives WITH both (200, a
 * `Content-Length`, and ~85 % of the bytes in 3–6 ms, then silence), so a partial body is the
 * normal case, not the exception; the partial body is discarded and the whole entry is read
 * again on a fresh connection (the module agent is `keepAlive: false`).
 *
 * NEVER retried when: the caller's signal aborted — checked first, its reason propagates at once
 * (the ask deadline, a cancellation, a lock: the H4 contract); a non-timeout socket error ended
 * the attempt; the body went over `MAX_BODY_BYTES`; or any HTTP status completed
 * (200/404/redirect/other — existing semantics stand).
 *
 * This lives INSIDE one request-guard window (`ZimService.withServer`, index.ts): the server
 * tuple cannot change across a stall that never reached the server's lifecycle, so the guard's
 * single admitted lifecycle retry is untouched and no double-retry semantics arise.
 */
async function readRawArticle(
  port: number,
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<KiwixResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await kiwixGet(port, path, { signal, timeoutMs })
    } catch (err) {
      if (signal?.aborted === true) throw err
      if (!(err instanceof KiwixTimeoutError)) throw err
      if (attempt >= ARTICLE_READ_ATTEMPTS) throw err
      // No path and no serving name (finding L1): the route class plus the truncation shape is
      // all a log line may carry — enough to recognise the T19 fault in a diagnostics tail.
      log.warn('kiwix-serve cut a knowledge-pack article read short — retrying', {
        route: 'raw',
        attempt,
        timeoutMs,
        headersReceived: err.headersReceived,
        bytesReceived: err.bytesReceived
      })
    }
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
  /** Test seam only: the per-ATTEMPT timeout, so the stall legs need not sit out the real 4 s
   *  (mirrors `probeSearchable`'s `opts.timeoutMs`). Production never passes it. */
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? ARTICLE_READ_TIMEOUT_MS
  const res = await readRawArticle(port, rawContentPath(name, articlePath), signal, timeoutMs)
  if (res.status === 404) return null
  if (REDIRECT_STATUSES.has(res.status)) {
    const target = redirectTargetFor(name, res.location)
    if (target === null) return null
    // Exactly ONE more request, under the same signal: a chain is bounded, not followed.
    const hop = await readRawArticle(port, rawContentPath(name, target), signal, timeoutMs)
    if (hop.status === 200) return hop.body
    if (hop.status === 404 || REDIRECT_STATUSES.has(hop.status)) return null
    throw new Error(`kiwix-serve article fetch failed (HTTP ${hop.status})`)
  }
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
