import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARTICLE_READ_ATTEMPTS,
  ARTICLE_READ_TIMEOUT_MS,
  ArticlePathError,
  KiwixTimeoutError,
  MAX_ARTICLE_PATH_CHARS,
  SUGGEST_PROBE_TERM,
  assertArticlePath,
  encodeArticlePath,
  fetchArticleHtml,
  ftIndexHint,
  kiwixGet,
  parseLibraryXml,
  parseSearchTotal,
  parseSearchXml,
  probeSearchable,
  searchPack,
  searchPackTotal
} from '../../src/main/services/zim/client'

// The loopback client against a real ephemeral node:http server — the transport is the
// point (the undici crash forced node:http; see client.ts header), so the tests exercise
// real sockets, not a fetch stub.

let server: http.Server
let port = 0
/** A port nothing listens on (bound, read, then closed) — the "the sidecar is gone" leg. */
let closedPort = 0
/**
 * What the fixture answers on `/suggest` (#301 P4, finding M7): a `KiwixResponse`-shaped pair,
 * `'park'` for "accept the request and never answer", or null for 404. Installed per test so
 * the probe matrix is explicit at its call site.
 */
let suggestHook: ((url: string) => { status: number; body: string } | 'park' | null) | null = null

/** The `/suggest` bodies of the probe matrix, keyed by the `content` (serving name). */
const SUGGEST_FIXTURES: Record<string, { status: number; body: string } | 'park' | null> = {
  // libkiwix appends the synthetic `kind:"pattern"` entry ONLY for a book with a full-text
  // index — that entry, not the suggestions around it, is the whole verdict.
  indexed: {
    status: 200,
    body: JSON.stringify([
      { value: 'Treibhausgas', label: 'Treibhausgas', kind: 'path', path: 'A/Treibhausgas' },
      { value: 'the', label: 'containing "the"...', kind: 'pattern' }
    ])
  },
  'index-less': {
    status: 200,
    body: JSON.stringify([
      { value: 'Treibhausgas', label: 'Treibhausgas', kind: 'path', path: 'A/Treibhausgas' }
    ])
  },
  'empty-array': { status: 200, body: '[]' },
  'four-oh-four': { status: 404, body: 'not found' },
  'server-error': { status: 500, body: 'boom' },
  'bad-json': { status: 200, body: '{ this is not json' },
  'json-object': { status: 200, body: JSON.stringify({ kind: 'pattern' }) },
  // A body that merely CONTAINS the word must not be read as the entry.
  'pattern-in-a-string': { status: 200, body: '"kind: pattern"' }
}
/** Mirrors client.ts MAX_BODY_BYTES (8 MiB) — kept literal here so the test pins the shipped ceiling. */
const CEILING_BYTES = 8 * 1024 * 1024
/** Every request the fixture server received — used to prove the L5 contract rejects a
 *  hazardous key BEFORE any HTTP request (#301 P5, finding L5). */
let requestCount = 0
/** Every request URL the fixture server received, in order — the redirect legs assert not just
 *  the answer but exactly WHICH routes were asked for, and in what order (#301 P7 T19). */
const requestLog: string[] = []
/**
 * What the fixture answers on a `/raw/` request (#301 P7 T19): a status, optional response
 * headers (a redirect's `Location`) and a body; null falls through to the default article
 * fixtures below, so every pre-existing `/raw` test is untouched.
 *
 * The `stall` variants reproduce the T19 fault and the failure it must NOT be confused with:
 *   `'truncated'` — 200 + `Content-Length` + MOST of the body within a few ms, then the
 *                   connection hangs and the last part never arrives. This is the MEASURED
 *                   kiwix-serve 3.8.1 (win-x86_64) shape: every stall of the 120-read capture
 *                   looked like this, cutting a given entry at the same byte every time.
 *   `'silent'`    — accepted, and nothing sent at all — not even headers. The same class of
 *                   failure (the attempt's own timer elapses before the body completes), kept
 *                   as its own leg so the retry cannot come to depend on headers arriving.
 *   `'reset'`     — 200 + part of the body, then the SOCKET IS DESTROYED. A real network
 *                   error, not a stall: it must NOT be retried.
 * The two hanging variants end only when the client gives up (its per-attempt timeout).
 */
type RawStall =
  | { stall: 'silent' }
  | { stall: 'truncated'; partial: string; total: number }
  | { stall: 'reset'; partial: string }
type RawFixtureAnswer = { status: number; headers?: Record<string, string>; body: string } | RawStall
let rawHook: ((url: string) => RawFixtureAnswer | null) | null = null
/**
 * Every hanging `/raw` URL whose connection the CLIENT tore down (it gave up). A leg asserts
 * `toContain`, never an exact list: the server sees a socket close on its own schedule, so a
 * previous leg's teardown can still land here.
 */
const parkedClosedByClient: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++
    requestLog.push(req.url ?? '')
    if (req.url?.startsWith('/slow')) return // never responds — timeout leg
    if (req.url?.startsWith('/suggest')) {
      const answer = suggestHook?.(req.url) ?? null
      if (answer === 'park') return // accepted, never answered
      if (answer === null) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body)
      return
    }
    // Body-ceiling fixtures (PR #294 review INFO / plan T01): kiwixGet rejects a body of
    // MORE than 8 MiB and accepts one of exactly 8 MiB. Streamed in 1 MiB writes so the
    // ceiling is hit mid-stream, the way a pathological entry would arrive.
    if (req.url?.startsWith('/big') || req.url?.startsWith('/atceiling')) {
      const total = CEILING_BYTES + (req.url.startsWith('/big') ? 1 : 0)
      res.writeHead(200, { 'content-type': 'text/html' })
      const piece = Buffer.alloc(1024 * 1024, 0x78)
      let sent = 0
      const pump = (): void => {
        while (sent < total) {
          const n = Math.min(piece.length, total - sent)
          sent += n
          if (!res.write(n === piece.length ? piece : piece.subarray(0, n))) {
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      pump()
      return
    }
    if (req.url?.startsWith('/missing')) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    if (req.url?.startsWith('/search')) {
      // #353: a fixed pattern that forces a non-200, the same way `/raw` failures are pinned
      // elsewhere in this file — `searchPackTotal` must throw exactly like `searchPack`.
      if (new URL(req.url, 'http://127.0.0.1').searchParams.get('pattern') === 'force-500') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(SEARCH_XML)
      return
    }
    if (req.url?.startsWith('/raw/')) {
      const answer = rawHook?.(req.url) ?? null
      if (answer && 'stall' in answer) {
        const url = req.url
        if (answer.stall === 'silent') {
          // `writableFinished` is false exactly when the client tore the connection down first —
          // the proof that the retry opened a FRESH socket rather than reusing a stuck one.
          res.on('close', () => {
            if (!res.writableFinished) parkedClosedByClient.push(url)
          })
          return // nothing is ever sent
        }
        if (answer.stall === 'reset') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.write(answer.partial, () => res.destroy()) // a real socket error mid-body
          return
        }
        res.on('close', () => {
          if (!res.writableFinished) parkedClosedByClient.push(url)
        })
        // The measured shape: a complete, HONEST `Content-Length`, then only part of the body.
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(answer.total) })
        res.write(answer.partial) // …and the rest never comes
        return
      }
      if (answer) {
        res.writeHead(answer.status, { 'content-type': 'text/html', ...answer.headers })
        res.end(answer.body)
        return
      }
      if (req.url.includes('/raw/missing/')) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><p>Artikel</p></body></html>')
      return
    }
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  // A real ephemeral port that is then CLOSED: a connection to it is refused by the OS, which
  // is what "the sidecar died before the probe went out" looks like from the client side.
  const dead = http.createServer()
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
  closedPort = (dead.address() as AddressInfo).port
  await new Promise<void>((resolve) => dead.close(() => resolve()))
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const SEARCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Search: Treibhausgas</title>
  <opensearch:totalResults>301</opensearch:totalResults>
  <item>
    <title>Treibhausgas</title>
    <link>/content/wikipedia_de_climate-change_nopic_2026-07/Treibhausgas</link>
    <description>...</description>
    <wordCount>8,245</wordCount>
  </item>
  <item>
    <title>Liste der L&#228;nder nach Treibhausgas-Emissionen</title>
    <link>/content/wikipedia_de_climate-change_nopic_2026-07/Liste_der_L%C3%A4nder_nach_Treibhausgas-Emissionen</link>
    <wordCount>3,428</wordCount>
  </item>
  <item><title>no link — skipped</title></item>
</channel></rss>`

describe('kiwixGet', () => {
  it('returns status and body over a real socket', async () => {
    const res = await kiwixGet(port, '/anything')
    expect(res).toEqual({ status: 200, body: 'ok' })
  })

  it('times out on a server that never responds', async () => {
    await expect(kiwixGet(port, '/slow', { timeoutMs: 100 })).rejects.toThrow()
  })

  // #301 P7 T19: the timeout rejection now CARRIES its classification, so `fetchArticleHtml`
  // can tell the kiwix-serve stall (nothing received at all) from a timeout mid-body. Every
  // other caller still just sees a rejection — kiwixGet itself never retries anything.
  it('rejects a timeout as a KiwixTimeoutError that records no headers were received', async () => {
    const before = requestCount
    let caught: unknown
    await kiwixGet(port, '/slow', { timeoutMs: 100 }).catch((err: unknown) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(KiwixTimeoutError)
    expect((caught as KiwixTimeoutError).name).toBe('KiwixTimeoutError')
    expect((caught as KiwixTimeoutError).headersReceived).toBe(false)
    expect((caught as KiwixTimeoutError).timeoutMs).toBe(100)
    // The retry is the /raw route's alone: a non-article request is tried exactly once.
    expect(requestCount - before).toBe(1)
  })

  it('a caller abort still rejects with the abort, never with the timeout error', async () => {
    const ac = new AbortController()
    const pending = kiwixGet(port, '/slow', { signal: ac.signal, timeoutMs: 60_000 })
    ac.abort()
    let caught: unknown
    await pending.catch((err: unknown) => {
      caught = err
    })
    expect(caught).not.toBeInstanceOf(KiwixTimeoutError)
    expect((caught as Error).name).toBe('AbortError')
  })

  it('aborts on the caller signal', async () => {
    const ac = new AbortController()
    const pending = kiwixGet(port, '/slow', { signal: ac.signal })
    ac.abort()
    await expect(pending).rejects.toThrow()
  })

  // The two 8 MiB legs move real bytes over loopback: ~0.2 s alone, but under a full-suite fork
  // load on Windows they have failed on their own in otherwise green runs (2026-09-05: one
  // 15 s timeout, then one `read ECONNRESET` at ~19 s on the at-ceiling leg while the build
  // and typecheck ran alongside; both pass 10/10 alone every time). The loopback transfer
  // itself is what the environment starves, so they carry a generous budget AND one retry —
  // the assertions are unchanged and a genuine ceiling regression fails every attempt.
  const BIG_BODY_BUDGET_MS = 60_000
  const BIG_BODY_TEST = { timeout: BIG_BODY_BUDGET_MS, retry: 2 }
  it('rejects a body over the 8 MiB ceiling mid-stream (T01, review INFO)', async () => {
    await expect(kiwixGet(port, '/big', { timeoutMs: BIG_BODY_BUDGET_MS })).rejects.toThrow(
      /exceeded 8388608 bytes/
    )
  }, BIG_BODY_TEST)

  it('accepts a body of exactly 8 MiB (the ceiling is strict-greater)', async () => {
    const res = await kiwixGet(port, '/atceiling', { timeoutMs: BIG_BODY_BUDGET_MS })
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(CEILING_BYTES)
  }, BIG_BODY_TEST)
})

describe('parseSearchXml / searchPack', () => {
  it('parses hits with decoded titles and percent-decoded paths', async () => {
    const hits = await searchPack(port, 'uuid-1', 'Treibhausgas', 5)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toEqual({
      title: 'Treibhausgas',
      urlId: 'wikipedia_de_climate-change_nopic_2026-07',
      articlePath: 'Treibhausgas',
      wordCount: 8245
    })
    expect(hits[1]?.title).toBe('Liste der Länder nach Treibhausgas-Emissionen')
    expect(hits[1]?.articlePath).toBe('Liste_der_Länder_nach_Treibhausgas-Emissionen')
  })

  it('returns an empty list for a resultless response', () => {
    expect(parseSearchXml('<rss><channel><title>Search: x</title></channel></rss>')).toEqual([])
  })
})

describe('parseSearchTotal / searchPackTotal (#353 document-frequency ladder)', () => {
  it('parses the opensearch:totalResults element', () => {
    expect(parseSearchTotal(SEARCH_XML)).toBe(301)
  })

  it('returns null when the element is absent', () => {
    expect(parseSearchTotal('<rss><channel><title>Search: x</title></channel></rss>')).toBeNull()
  })

  it('returns null for garbage content instead of NaN', () => {
    expect(
      parseSearchTotal(
        '<rss><channel><opensearch:totalResults>not-a-number</opensearch:totalResults></channel></rss>'
      )
    ).toBeNull()
  })

  it('parses an explicit 0 as the number 0, never as absent', () => {
    expect(
      parseSearchTotal('<rss><channel><opensearch:totalResults>0</opensearch:totalResults></channel></rss>')
    ).toBe(0)
  })

  it('parses the total across whitespace/newline padding inside the element', () => {
    expect(
      parseSearchTotal(
        '<rss><channel><opensearch:totalResults>\n   42  \n</opensearch:totalResults></channel></rss>'
      )
    ).toBe(42)
  })

  it('requests pageLength=1 on the same /search route and returns the parsed total', async () => {
    requestLog.length = 0
    await expect(searchPackTotal(port, 'uuid-1', 'Treibhausgas')).resolves.toBe(301)
    const url = requestLog.find((u) => u.startsWith('/search'))
    expect(url).toContain('pageLength=1')
    expect(url).toContain('pattern=Treibhausgas')
    expect(url).toContain('books.id=uuid-1')
  })

  it('throws on a non-200 status exactly like searchPack', async () => {
    await expect(searchPackTotal(port, 'uuid-1', 'force-500')).rejects.toThrow(/search failed \(HTTP 500\)/)
  })
})

describe('fetchArticleHtml', () => {
  it('fetches raw article HTML, re-encoding the decoded path per segment', async () => {
    const html = await fetchArticleHtml(port, 'book_2026-07', 'Liste_der_Länder')
    expect(html).toContain('<p>Artikel</p>')
  })

  it('maps 404 to null (entry vanished is a skip, not a failure)', async () => {
    await expect(fetchArticleHtml(port, 'missing', 'missing')).resolves.toBeNull()
  })

  it('throws ArticlePathError for a dot-segment key BEFORE any HTTP request (#301 P5, finding L5)', async () => {
    const before = requestCount
    await expect(fetchArticleHtml(port, 'book', 'A/../x')).rejects.toThrow(ArticlePathError)
    expect(requestCount).toBe(before)
  })
})

// ------------------------------------------------------------------------------------------
// #301 P7 T19: kiwix-serve 3.8.1 answers a ZIM REDIRECT ENTRY (an alias title — roughly half a
// Wikipedia ZIM's entries) under `/raw/<book>/content/<key>` with a 302 whose `Location` is the
// VIEWER route `/content/<book>/<target>`. It redirects; it does not follow. One hop, same book
// only; everything else is the honest "unavailable" null (`docs/rag-design.md` §17 D-Z11).
// ------------------------------------------------------------------------------------------
describe('fetchArticleHtml follows one same-book redirect (#301 P7 T19)', () => {
  /** The real archive of the T19 acceptance run, served under its own name. */
  const NAME = 'wikipedia_de_climate-change_nopic_2026-07'
  const ALIAS = 'CO2-Äquivalent' // a redirect entry
  const TARGET_HTML = '<html><body><h1>Treibhauspotential</h1><p>Zielartikel</p></body></html>'
  type RawAnswer = { status: number; headers?: Record<string, string>; body: string }
  const raw = (encodedKey: string): string => `/raw/${NAME}/content/${encodedKey}`
  const ALIAS_URL = raw('CO2-%C3%84quivalent')
  const TARGET_URL = raw('Treibhauspotential')
  const NOT_FOUND: RawAnswer = { status: 404, body: 'not found' }
  const redirectTo = (location: string, status = 302): RawAnswer => ({
    status,
    headers: { location },
    body: ''
  })
  /** The fixture answers exactly the routes the leg spells out; anything else is a 404. */
  const install = (answers: Record<string, RawAnswer>): void => {
    rawHook = (url) => answers[url] ?? NOT_FOUND
  }
  /** Every `/raw` request of THIS leg, in order. */
  const rawLog = (): string[] => requestLog.filter((u) => u.startsWith('/raw/'))

  beforeEach(() => {
    requestLog.length = 0
  })
  afterEach(() => {
    rawHook = null
  })

  it('(a) 302 to /content/<same book>/<target> returns the target body after exactly two requests', async () => {
    install({
      [ALIAS_URL]: redirectTo(`/content/${NAME}/Treibhauspotential`),
      [TARGET_URL]: { status: 200, body: TARGET_HTML }
    })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBe(TARGET_HTML)
    // The order matters as much as the count: the alias first, then the target — and nothing else.
    expect(rawLog()).toEqual([ALIAS_URL, TARGET_URL])
  })

  it('(a2) the same one hop for 301, 307 and 308, and a /raw-shaped Location is accepted too', async () => {
    for (const status of [301, 302, 307, 308]) {
      requestLog.length = 0
      install({
        [ALIAS_URL]: redirectTo(`/content/${NAME}/Treibhauspotential`, status),
        [TARGET_URL]: { status: 200, body: TARGET_HTML }
      })
      await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBe(TARGET_HTML)
      expect(rawLog(), `status ${status}`).toEqual([ALIAS_URL, TARGET_URL])
    }
    // Some builds could answer with the /raw route instead; the same book is the whole test.
    requestLog.length = 0
    install({
      [ALIAS_URL]: redirectTo(`/raw/${NAME}/content/Treibhauspotential`),
      [TARGET_URL]: { status: 200, body: TARGET_HTML }
    })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBe(TARGET_HTML)
    expect(rawLog()).toEqual([ALIAS_URL, TARGET_URL])
  })

  it('(b) a 302 to ANOTHER book returns null and fetches nothing from it (finding L4)', async () => {
    install({ [ALIAS_URL]: redirectTo('/content/other_book/Treibhauspotential') })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBeNull()
    expect(rawLog()).toEqual([ALIAS_URL])
  })

  it('(c) a redirect CHAIN is not followed: null after exactly two requests', async () => {
    install({
      [ALIAS_URL]: redirectTo(`/content/${NAME}/Treibhauspotential`),
      [TARGET_URL]: redirectTo(`/content/${NAME}/Klimawandel`)
    })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBeNull()
    expect(rawLog()).toEqual([ALIAS_URL, TARGET_URL])
  })

  it('(d) a target the L5 entry-key contract refuses returns null WITHOUT throwing, after one request', async () => {
    // A server-supplied target is never a caller's key: it is refused as unavailable, quietly.
    // `..%2Fx` decodes per segment to `../x`, whose `..` segment is the enumeration vector L5
    // exists to stop; `x%00y` decodes to a C0 control character.
    for (const hostile of ['..%2Fx', 'x%00y', '%2E%2E/x']) {
      requestLog.length = 0
      install({ [ALIAS_URL]: redirectTo(`/content/${NAME}/${hostile}`) })
      await expect(fetchArticleHtml(port, NAME, ALIAS), hostile).resolves.toBeNull()
      expect(rawLog(), hostile).toEqual([ALIAS_URL])
    }
  })

  it('(e) an absolute-URL, protocol-relative, relative or missing Location returns null after one request', async () => {
    const locations = [
      `http://127.0.0.1:1/content/${NAME}/Treibhauspotential`, // an absolute URL — never followed
      `//evil.example/content/${NAME}/Treibhauspotential`, // protocol-relative
      'Treibhauspotential', // a relative reference
      `/content/${NAME}`, // no target segment at all
      '/something/else'
    ]
    for (const location of locations) {
      requestLog.length = 0
      install({ [ALIAS_URL]: redirectTo(location), [TARGET_URL]: { status: 200, body: TARGET_HTML } })
      await expect(fetchArticleHtml(port, NAME, ALIAS), location).resolves.toBeNull()
      expect(rawLog(), location).toEqual([ALIAS_URL])
    }
    // A redirect status with no `Location` header at all is the same honest null.
    requestLog.length = 0
    install({ [ALIAS_URL]: { status: 302, body: '' } })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBeNull()
    expect(rawLog()).toEqual([ALIAS_URL])
  })

  it('(f) a percent-encoded non-ASCII target is decoded then re-encoded exactly once', async () => {
    const targetUrl = raw('CO2-%C3%84quivalente')
    install({
      [ALIAS_URL]: redirectTo(`/content/${NAME}/CO2-%C3%84quivalente`),
      [targetUrl]: { status: 200, body: TARGET_HTML }
    })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBe(TARGET_HTML)
    // Exactly once: `%C3%84` must not come back as `%25C3%2584` (the L4 double-encode).
    expect(rawLog()).toEqual([ALIAS_URL, targetUrl])
    expect(rawLog()[1]).not.toContain('%25')
    // …and an already-encoded slash inside one segment stays inside it, both ways.
    requestLog.length = 0
    const encodedSlash = raw('A/a%252Fb')
    install({
      [ALIAS_URL]: redirectTo(`/content/${NAME}/A/a%252Fb`),
      [encodedSlash]: { status: 200, body: TARGET_HTML }
    })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBe(TARGET_HTML)
    expect(rawLog()).toEqual([ALIAS_URL, encodedSlash])
  })

  it('(g) the book-name comparison is EXACT — a case-shifted name is another book', async () => {
    install({ [ALIAS_URL]: redirectTo(`/content/${NAME.toUpperCase()}/Treibhauspotential`) })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBeNull()
    expect(rawLog()).toEqual([ALIAS_URL])
  })

  it('the second hop maps 404 to null and any other error status to the existing throw', async () => {
    install({ [ALIAS_URL]: redirectTo(`/content/${NAME}/Treibhauspotential`) }) // target 404s
    await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBeNull()
    expect(rawLog()).toEqual([ALIAS_URL, TARGET_URL])

    requestLog.length = 0
    install({
      [ALIAS_URL]: redirectTo(`/content/${NAME}/Treibhauspotential`),
      [TARGET_URL]: { status: 500, body: 'boom' }
    })
    await expect(fetchArticleHtml(port, NAME, ALIAS)).rejects.toThrow(
      /article fetch failed \(HTTP 500\)/
    )
    expect(rawLog()).toEqual([ALIAS_URL, TARGET_URL])
  })
})

// ------------------------------------------------------------------------------------------
// #301 P7 T19: kiwix-serve 3.8.1 (win-x86_64) CUTS ~5–20 % of `/raw` reads of entries above
// ~80 KB SHORT — the status line, a `Content-Length` and most of the body arrive within 3–6 ms,
// then the connection hangs and the last part never comes (Treibhauseffekt always stops at
// 195,590 of 234,141 bytes) — while the server stays alive and answers the next request
// normally. Client-, thread-count- and pause-independent, so it is the sidecar's behaviour, not
// ours. The per-attempt timeout detects it and the read is retried on a fresh connection;
// nothing else is retried (`docs/rag-design.md` §17 "Real acceptance").
// ------------------------------------------------------------------------------------------
describe('fetchArticleHtml retries a stalled /raw read (#301 P7 T19)', () => {
  const NAME = 'wikipedia_de_climate-change_nopic_2026-07'
  const ENTRY = 'Treibhauseffekt' // one of the measured stallers (234 KB)
  const ALIAS = 'CO2-Äquivalent'
  const HTML = '<html><body><p>Treibhauseffekt</p></body></html>'
  /** The measured fault, to scale: the last ~15 % of the entry never arrives. */
  const TRUNCATED_PARTIAL = HTML.slice(0, Math.floor(HTML.length * 0.85))
  const TRUNCATED: RawStall = {
    stall: 'truncated',
    partial: TRUNCATED_PARTIAL,
    total: Buffer.byteLength(HTML)
  }
  const raw = (encodedKey: string): string => `/raw/${NAME}/content/${encodedKey}`
  const ENTRY_URL = raw('Treibhauseffekt')
  const ALIAS_URL = raw('CO2-%C3%84quivalent')
  /** The shrunk per-attempt budget (the production one is `ARTICLE_READ_TIMEOUT_MS` = 4 s).
   *  Long enough that a healthy loopback answer lands inside it even under fork load. */
  const STALL_TIMEOUT_MS = 300
  /** A generous ceiling that still proves the read did NOT sit out a 15 s default. */
  const ALL_ATTEMPTS_BUDGET_MS = 5_000

  /** Answers `url` with `queue.shift()` on each request, so "stalls once, then answers" is
   *  expressed as a list rather than as a counter each leg has to re-invent. */
  const installQueues = (queues: Record<string, RawFixtureAnswer[]>): void => {
    rawHook = (url) => queues[url]?.shift() ?? { status: 404, body: 'not found' }
  }
  const rawLog = (): string[] => requestLog.filter((u) => u.startsWith('/raw/'))
  const read = (signal?: AbortSignal): Promise<string | null> =>
    fetchArticleHtml(port, NAME, ENTRY, signal, { timeoutMs: STALL_TIMEOUT_MS })

  beforeEach(() => {
    requestLog.length = 0
    parkedClosedByClient.length = 0
  })
  afterEach(() => {
    rawHook = null
  })

  it('the shipped constants are a stall detector, not a throughput bound', () => {
    expect(ARTICLE_READ_TIMEOUT_MS).toBe(4_000)
    expect(ARTICLE_READ_ATTEMPTS).toBe(3)
    // The whole ladder must fit inside the 20 s per-ask deadline with room to spare.
    expect(ARTICLE_READ_TIMEOUT_MS * ARTICLE_READ_ATTEMPTS).toBeLessThan(15_000)
  })

  it('(a) a first attempt that is never answered at all is retried on a fresh connection', async () => {
    installQueues({ [ENTRY_URL]: [{ stall: 'silent' }, { status: 200, body: HTML }] })
    await expect(read()).resolves.toBe(HTML)
    expect(rawLog()).toEqual([ENTRY_URL, ENTRY_URL])
    // The stalled socket was torn down by the CLIENT, so attempt 2 really is a new connection.
    expect(parkedClosedByClient).toContain(ENTRY_URL)
  })

  it('(b) three cut-short attempts reject as the timeout, and stop at three', async () => {
    installQueues({ [ENTRY_URL]: [TRUNCATED, TRUNCATED, TRUNCATED, { status: 200, body: HTML }] })
    const started = Date.now()
    let caught: unknown
    await read().catch((err: unknown) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(KiwixTimeoutError)
    expect((caught as KiwixTimeoutError).name).toBe('KiwixTimeoutError')
    // The partial body is on the error as diagnosis, never as a result.
    expect((caught as KiwixTimeoutError).headersReceived).toBe(true)
    expect((caught as KiwixTimeoutError).bytesReceived).toBe(Buffer.byteLength(TRUNCATED_PARTIAL))
    // A fourth answering entry sits in the queue: the bound is the code's, not the fixture's.
    expect(rawLog()).toEqual([ENTRY_URL, ENTRY_URL, ENTRY_URL])
    expect(rawLog()).toHaveLength(ARTICLE_READ_ATTEMPTS)
    expect(Date.now() - started).toBeLessThan(ALL_ATTEMPTS_BUDGET_MS)
  })

  it('(c) the caller aborting during attempt 2 rejects at once, with no attempt 3', async () => {
    const ac = new AbortController()
    const reason = new Error('the ask was cancelled')
    let seen = 0
    rawHook = (url) => {
      if (url !== ENTRY_URL) return { status: 404, body: 'not found' }
      // Abort as the SECOND attempt arrives: the request is in flight and stalled, which is
      // exactly the window the retry would otherwise cover.
      if (++seen === 2) ac.abort(reason)
      return TRUNCATED
    }
    let caught: unknown
    await read(ac.signal).catch((err: unknown) => {
      caught = err
    })
    expect(caught).not.toBeInstanceOf(KiwixTimeoutError)
    expect((caught as Error).name).toBe('AbortError')
    expect((caught as Error).cause).toBe(reason)
    expect(rawLog()).toEqual([ENTRY_URL, ENTRY_URL])
  })

  it('(d) headers plus a partial body then a hang IS retried, and the partial body is discarded', async () => {
    // THE measured signature (`tmp/zim-wave/p7/t19-raw-stall4-headers.log`, 120 reads): every
    // stall carried the 200 and most of the entry, then the last part never arrived. The whole
    // read starts over on a fresh connection — a truncated article is never handed to the app.
    installQueues({ [ENTRY_URL]: [TRUNCATED, { status: 200, body: HTML }] })
    const html = await read()
    expect(html).toBe(HTML)
    expect(html).not.toBe(TRUNCATED_PARTIAL)
    expect(rawLog()).toEqual([ENTRY_URL, ENTRY_URL])
    expect(parkedClosedByClient).toContain(ENTRY_URL)
  })

  it('(d2) a mid-body SOCKET ERROR is not a stall: it is not retried', async () => {
    // The retryable signature is "this attempt's own timer elapsed", nothing wider. A connection
    // the server tears down mid-body is a real network failure and keeps its existing semantics.
    installQueues({
      [ENTRY_URL]: [{ stall: 'reset', partial: TRUNCATED_PARTIAL }, { status: 200, body: HTML }]
    })
    let caught: unknown
    await read().catch((err: unknown) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(KiwixTimeoutError)
    expect(rawLog()).toEqual([ENTRY_URL])
  })

  it('(e) an answered attempt keeps its existing semantics and is never retried', async () => {
    for (const answer of [
      { status: 404, body: 'not found' },
      { status: 500, body: 'boom' },
      { status: 302, headers: { location: '/content/other_book/x' }, body: '' }
    ] as const) {
      requestLog.length = 0
      installQueues({ [ENTRY_URL]: [answer, { status: 200, body: HTML }] })
      const pending = read()
      if (answer.status === 500) {
        await expect(pending).rejects.toThrow(/article fetch failed \(HTTP 500\)/)
      } else {
        await expect(pending, String(answer.status)).resolves.toBeNull()
      }
      expect(rawLog(), String(answer.status)).toEqual([ENTRY_URL])
    }
  })

  it('(f) the redirect hop is retried the same way', async () => {
    installQueues({
      [ALIAS_URL]: [{ status: 302, headers: { location: `/content/${NAME}/Treibhauseffekt` }, body: '' }],
      [ENTRY_URL]: [TRUNCATED, { status: 200, body: HTML }]
    })
    await expect(
      fetchArticleHtml(port, NAME, ALIAS, undefined, { timeoutMs: STALL_TIMEOUT_MS })
    ).resolves.toBe(HTML)
    expect(rawLog()).toEqual([ALIAS_URL, ENTRY_URL, ENTRY_URL])
    expect(parkedClosedByClient).toContain(ENTRY_URL)
  })

  it('(g) the other routes are untouched: /suggest and /search are tried exactly once', async () => {
    // The stall retry is scoped to `/raw`; a probe timeout is still one request and an unknown.
    suggestHook = () => 'park'
    requestLog.length = 0
    await expect(
      probeSearchable(port, 'parked', undefined, { timeoutMs: STALL_TIMEOUT_MS })
    ).resolves.toBeNull()
    expect(requestLog.filter((u) => u.startsWith('/suggest'))).toHaveLength(1)
    suggestHook = null

    // …and a search still makes exactly one request per call (it answers here; the point is
    // that nothing in the search path grew a retry).
    requestLog.length = 0
    await expect(searchPack(port, 'uuid-1', 'Treibhausgas', 5)).resolves.toHaveLength(2)
    expect(requestLog.filter((u) => u.startsWith('/search'))).toHaveLength(1)
  })
})

describe('assertArticlePath / encodeArticlePath — the L5 entry-key contract (#301 P5, plan §9.19 (b))', () => {
  it('rejects an empty key', () => {
    expect(() => assertArticlePath('')).toThrow(ArticlePathError)
    try {
      assertArticlePath('')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ArticlePathError)
      expect((err as InstanceType<typeof ArticlePathError>).reason).toBe('empty')
      expect((err as Error).message).toBe('empty')
    }
  })

  it('rejects a key longer than MAX_ARTICLE_PATH_CHARS UTF-16 code units', () => {
    const tooLong = 'A/' + 'x'.repeat(MAX_ARTICLE_PATH_CHARS)
    expect(tooLong.length).toBeGreaterThan(MAX_ARTICLE_PATH_CHARS)
    try {
      assertArticlePath(tooLong)
      expect.unreachable()
    } catch (err) {
      expect((err as InstanceType<typeof ArticlePathError>).reason).toBe('too-long')
    }
    // Exactly at the bound is fine.
    const atBound = 'A/' + 'x'.repeat(MAX_ARTICLE_PATH_CHARS - 2)
    expect(atBound.length).toBe(MAX_ARTICLE_PATH_CHARS)
    expect(() => assertArticlePath(atBound)).not.toThrow()
  })

  it('rejects any C0 control character or DEL, never echoing the path in the message', () => {
    for (const bad of [String.fromCharCode(0), String.fromCharCode(9), String.fromCharCode(31), String.fromCharCode(127)]) {
      const path = `A/x${bad}y`
      try {
        assertArticlePath(path)
        expect.unreachable()
      } catch (err) {
        expect((err as InstanceType<typeof ArticlePathError>).reason).toBe('control')
        expect((err as Error).message).toBe('control')
        expect((err as Error).message).not.toContain(path)
      }
    }
  })

  it('rejects a `.` or `..` SEGMENT anywhere, but allows a segment that merely starts with dots', () => {
    for (const path of ['A/../x', '../A', 'A/.', '.', 'A/b/../c']) {
      try {
        assertArticlePath(path)
        expect.unreachable(`expected ${path} to be rejected`)
      } catch (err) {
        expect((err as InstanceType<typeof ArticlePathError>).reason).toBe('dot-segment')
      }
    }
    // Compatibility: a segment that merely STARTS with dots is a legal entry name.
    expect(() => assertArticlePath('A/..foo')).not.toThrow()
    expect(() => assertArticlePath('A/.hidden')).not.toThrow()
  })

  it('rejects a lone surrogate as unencodable', () => {
    const loneSurrogate = `A/${String.fromCharCode(0xd800)}`
    try {
      assertArticlePath(loneSurrogate)
      expect.unreachable()
    } catch (err) {
      expect((err as InstanceType<typeof ArticlePathError>).reason).toBe('unencodable')
    }
  })

  it('keeps the whole compatibility list allowed, each encoding without throwing and round-tripping per segment', () => {
    const compatible = [
      'A/https://example.com/a//b', // empty segments — zimit-era URL-shaped keys
      'A/one:two?three#four%25plus+amp&eq=space five', // URL-shaped punctuation + space
      'A/Über_ß_' + String.fromCharCode(0x00e9), // Unicode
      'A/a%2Fb', // an already-encoded slash inside one segment
      'Treibhausgas', // namespace-less key
      '-/style.css',
      'I/img.png',
      'A/Foo.', // trailing dot
      'A/..foo', // starts with dots, not exactly ".."
      'A/.hidden' // starts with a dot, not exactly "."
    ]
    for (const key of compatible) {
      expect(() => assertArticlePath(key)).not.toThrow()
      const decoded = encodeArticlePath(key)
        .split('/')
        .map(decodeURIComponent)
        .join('/')
      expect(decoded).toBe(key)
    }
  })
})

describe('parseLibraryXml', () => {
  it('parses kiwix-manage book elements including entity-encoded attributes', () => {
    const books = parseLibraryXml(
      `<library version="20110515">
        <book id="c334200f-6662-3e7b-9d53-dbf334702fa8" path="zim\\wikipedia_en_ray-charles_maxi_2026-08.zim" title="Ray Charles" description="Wikipedia articles about Ray Charles" language="eng" name="wikipedia_en_ray-charles" flavour="maxi" date="2026-08-02" articleCount="340" mediaCount="178" size="2939" />
        <book id="abc" title="K&#228;fer &amp; Co" language="deu" articleCount="junk" />
        <book title="no id — skipped" />
      </library>`
    )
    expect(books).toHaveLength(2)
    expect(books[0]).toEqual({
      id: 'c334200f-6662-3e7b-9d53-dbf334702fa8',
      title: 'Ray Charles',
      description: 'Wikipedia articles about Ray Charles',
      language: 'eng',
      date: '2026-08-02',
      articleCount: 340,
      mediaCount: 178,
      path: 'zim\\wikipedia_en_ray-charles_maxi_2026-08.zim',
      tags: null
    })
    expect(books[1]?.title).toBe('Käfer & Co')
    expect(books[1]?.articleCount).toBeNull()
  })

  it('reads the tags attribute and maps _ftindex to a hint — never to a verdict (#301 P4, finding M7)', () => {
    const book = (tags: string): string => `<book id="x" title="T" tags="${tags}" />`
    const tagsOf = (xml: string): string | null => parseLibraryXml(xml)[0]?.tags ?? null
    expect(tagsOf(book('wikipedia;_ftindex:yes;_pictures:no'))).toBe(
      'wikipedia;_ftindex:yes;_pictures:no'
    )
    // Entity-encoded tag values survive the same decode as every other attribute.
    expect(tagsOf('<book id="x" tags="wikipedia_f&#228;r;_ftindex:no" />')).toBe(
      'wikipedia_fär;_ftindex:no'
    )
    expect(parseLibraryXml('<book id="x" title="T" />')[0]?.tags).toBeNull()

    // The hint mapping itself (plan §9.21 (d)2).
    expect(ftIndexHint('wikipedia;_ftindex:yes;_pictures:no')).toBe('yes')
    expect(ftIndexHint('_ftindex:no')).toBe('no')
    expect(ftIndexHint('wikipedia;_ftindex')).toBe('yes') // the bare legacy tag
    expect(ftIndexHint(' _FTINDEX:YES ; other')).toBe('yes') // trimmed, case-insensitive
    expect(ftIndexHint('wikipedia;_pictures:no')).toBeNull()
    expect(ftIndexHint('')).toBeNull()
    expect(ftIndexHint(null)).toBeNull()
    // A tag that merely CONTAINS the word is not the tag.
    expect(ftIndexHint('has_ftindex;ftindex:yes')).toBeNull()
  })
})

describe('probeSearchable — the /suggest capability probe (#301 P4, finding M7, plan §2.5)', () => {
  it('confirms yes only on a 200 JSON array carrying a kind:"pattern" entry, and no only on a 200 array without one', async () => {
    const requested: string[] = []
    suggestHook = (url) => {
      requested.push(url)
      const name = new URL(url, 'http://127.0.0.1').searchParams.get('content') ?? ''
      return SUGGEST_FIXTURES[name] ?? null
    }
    try {
      // 200 + an array WITH the synthetic pattern entry (libkiwix adds it only with an index).
      await expect(probeSearchable(port, 'indexed')).resolves.toBe('yes')
      // 200 + a valid array WITHOUT one: the ONLY shape that may be persisted as "no".
      await expect(probeSearchable(port, 'index-less')).resolves.toBe('no')
      // …an empty array is that same shape.
      await expect(probeSearchable(port, 'empty-array')).resolves.toBe('no')
      // Everything else stays UNKNOWN — a 404 is ambiguous (§2.2), and so is a body that is
      // not a JSON array, whatever it contains.
      await expect(probeSearchable(port, 'four-oh-four')).resolves.toBeNull()
      await expect(probeSearchable(port, 'server-error')).resolves.toBeNull()
      await expect(probeSearchable(port, 'bad-json')).resolves.toBeNull()
      await expect(probeSearchable(port, 'json-object')).resolves.toBeNull()
      await expect(probeSearchable(port, 'pattern-in-a-string')).resolves.toBeNull()

      // The URL contract: the serving NAME encoded once, a non-empty fixed term, count=1.
      expect(requested[0]).toBe(`/suggest?content=indexed&term=${SUGGEST_PROBE_TERM}&count=1`)
      const unicode = 'gro%C3%9F wiki+1'
      await probeSearchable(port, unicode)
      expect(requested[requested.length - 1]).toBe(
        `/suggest?content=${encodeURIComponent(unicode)}&term=${SUGGEST_PROBE_TERM}&count=1`
      )
    } finally {
      suggestHook = null
    }
  })

  it('a timeout and a network error are unknown, and only the caller’s own abort throws', async () => {
    suggestHook = () => 'park' // the server accepts the request and never answers
    try {
      // A timeout is UNKNOWN, never "no": the archive said nothing at all.
      await expect(probeSearchable(port, 'parked', undefined, { timeoutMs: 100 })).resolves.toBeNull()
      const ac = new AbortController()
      const pending = probeSearchable(port, 'parked', ac.signal)
      ac.abort()
      // The caller's cancellation (a lock, a cancelled reconcile) propagates instead — a probe
      // that straddled it must never write anything.
      await expect(pending).rejects.toThrow()
    } finally {
      suggestHook = null
    }
    // Nothing listening at all (the sidecar died between publication and probe): also unknown.
    await expect(probeSearchable(closedPort, 'anything')).resolves.toBeNull()
  })
})

describe('encodeArticlePath — the ONE encoding owner (#301 P3b, finding L4)', () => {
  it('escapes every segment exactly once and keeps the entry key’s own slashes as structure', () => {
    expect(encodeArticlePath('A/Alpha')).toBe('A/Alpha')
    expect(encodeArticlePath('A/with space')).toBe('A/with%20space')
    expect(encodeArticlePath('A/Über_ß')).toBe('A/%C3%9Cber_%C3%9F')
    expect(encodeArticlePath('A/one#two')).toBe('A/one%23two')
    expect(encodeArticlePath('A/50%_rule')).toBe('A/50%25_rule')
    expect(encodeArticlePath('A/plus+sign')).toBe('A/plus%2Bsign')
    // A percent-escape that is part of the KEY is escaped once more, so one decode gives the
    // key back — the `my%20wiki` → `my%2520wiki` regression is the case where it is not.
    expect(encodeArticlePath('A/a%2Fb')).toBe('A/a%252Fb')
    for (const key of ['A/Alpha', 'A/with space', 'A/a%2Fb', 'A/50%_rule', 'A/Über_ß']) {
      expect(
        encodeArticlePath(key)
          .split('/')
          .map(decodeURIComponent)
          .join('/')
      ).toBe(key)
    }
  })

  it('is the only place in src/ that encodes an article path', () => {
    // The route contract has ONE owner (plan §9.17 (d)8): P5's entry-key validation lands
    // inside it, so a second encoder anywhere would be a second, unvalidated route.
    const root = join(process.cwd(), 'src')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []
      )
    const offenders: string[] = []
    for (const file of walk(root)) {
      if (file.endsWith(join('services', 'zim', 'client.ts'))) continue
      const text = readFileSync(file, 'utf8')
      // The per-segment `split('/').map(encodeURIComponent)` shape, in any spelling.
      if (/split\(\s*['"]\/['"]\s*\)[\s\S]{0,40}encodeURIComponent/.test(text)) {
        offenders.push(file.slice(root.length + 1))
      }
      if (/encodeURIComponent\([^)]*articlePath/.test(text)) offenders.push(file.slice(root.length + 1))
    }
    expect(offenders).toEqual([])
  })
})
