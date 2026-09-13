import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARTICLE_READ_ATTEMPTS,
  ARTICLE_READ_IDLE_MS,
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
/** One entry per finished body-ceiling response: had the SERVER already begun closing the
 *  connection when its response finished? Must be false — see the fixture (#467). */
const ceilingServerClosedFirst: Array<Promise<boolean>> = []
/** Every request the fixture server received — used to prove the L5 contract rejects a
 *  hazardous key BEFORE any HTTP request (#301 P5, finding L5). */
let requestCount = 0
/** Every request URL the fixture server received, in order — the redirect legs assert not just
 *  the answer but exactly WHICH routes were asked for, and in what order (#301 P7 T19). */
const requestLog: string[] = []
/** The `Range` header of every request, positionally aligned with `requestLog` (#339 D-Z22):
 *  the Range-first legs assert not just which routes were asked for but under which header. */
const rangeLog: Array<string | undefined> = []
/** Clears both logs together — they are read by index against each other. */
function resetRequestLog(): void {
  requestLog.length = 0
  rangeLog.length = 0
}
/** The `/raw` requests of the leg so far, each with the `Range` header it carried. */
function rawRequests(): Array<{ url: string; range: string | undefined }> {
  return requestLog
    .map((url, i) => ({ url, range: rangeLog[i] }))
    .filter((e) => e.url.startsWith('/raw/'))
}
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
  | { stall: 'truncated'; partial: string | Buffer; total: number }
  | { stall: 'reset'; partial: string }
  /** Headers and a `Content-Length`, then silence with NOT ONE body byte — the shape that must
   *  never be resumed, because there is no prefix to resume from (#339 D-Z22 leg 6). */
  | { stall: 'headers-only'; total: number }
  /** Slow but ALIVE: `chunks` pieces of `body`, one every `everyMs`. Not a stall — the idle
   *  detector must not cut it (#339 D-Z22 leg 3). */
  | { drip: { body: string; chunks: number; everyMs: number } }
/**
 * A plain answer. Status 200 answers are RANGE-AWARE by default (#339 D-Z22): a
 * `Range: bytes=<n>-` request is answered `206` + `Content-Range` + the tail, exactly as
 * libkiwix does. The optional fields express the misbehaviours a resume must refuse.
 */
type RawAnswerBody = {
  status: number
  headers?: Record<string, string>
  body: string
  /** Answer `200` with the WHOLE body even under `Range` — a server that ignores the header. */
  ignoreRange?: boolean
  /** Send this `Content-Range` instead of the true one (the mismatching-range leg). */
  contentRange?: string
  /** Send only this many bytes of the tail, honestly framed (the short-tail leg). */
  tailBytes?: number
  /** Answer `416 Range Not Satisfiable` to any `Range` request. */
  unsatisfiable?: boolean
}
type RawFixtureAnswer = RawAnswerBody | RawStall
let rawHook: ((url: string) => RawFixtureAnswer | null) | null = null
/**
 * Every hanging `/raw` URL whose connection the CLIENT tore down (it gave up). A leg asserts
 * `toContain`, never an exact list: the server sees a socket close on its own schedule, so a
 * previous leg's teardown can still land here.
 */
const parkedClosedByClient: string[] = []

/** The offset of an open `bytes=<n>-` range, or null when the request carried no such header.
 *  The client only ever sends that one form (#339 D-Z22). */
function rangeStart(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d+)-$/.exec(header.trim())
  return m ? Number(m[1]) : null
}

/**
 * Answer a `/raw` request the way libkiwix does (#339 D-Z22): a `Range: bytes=<n>-` on a 200
 * answer becomes `206` + `Content-Range: bytes <n>-<len-1>/<len>` + the tail; no Range, a
 * non-200 status, or `ignoreRange` keeps the plain answer. The remaining fields inject the
 * misbehaviours a resume has to refuse.
 */
function sendRawAnswer(res: http.ServerResponse, answer: RawAnswerBody, from: number | null): void {
  const buf = Buffer.from(answer.body, 'utf8')
  const headers = { 'content-type': 'text/html', ...answer.headers }
  if (from === null || answer.ignoreRange === true || answer.status !== 200) {
    res.writeHead(answer.status, headers)
    res.end(buf)
    return
  }
  if (answer.unsatisfiable === true || from >= buf.length) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${buf.length}` })
    res.end('range not satisfiable')
    return
  }
  const tail = buf.subarray(from)
  const sent = answer.tailBytes === undefined ? tail : tail.subarray(0, answer.tailBytes)
  res.writeHead(206, {
    ...headers,
    // Honestly framed even when short: the client must catch the short tail on the LENGTH it
    // was promised in `Content-Range`, not on a framing error.
    'content-length': String(sent.length),
    'content-range': answer.contentRange ?? `bytes ${from}-${buf.length - 1}/${buf.length}`
  })
  res.end(sent)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++
    requestLog.push(req.url ?? '')
    rangeLog.push(typeof req.headers.range === 'string' ? req.headers.range : undefined)
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
    //
    // #467: the CLIENT closes these connections, never the server. The client asks for
    // `Connection: close`, so a default answer closes the server's socket the moment its last
    // write is handed to the kernel. Under CPU starvation on Windows the tail of a body queued
    // behind a lagging reader is then never delivered — the read stops ~0.4 % short and Windows
    // resets the connection ~19 s later (`read ECONNRESET`). Measured from 256 KB up; 64 KB and
    // below never did. Answering keep-alive (with no keep-alive timer) leaves the close to the
    // client, which only closes once it has read what it wanted — 0 of 30 under the same load.
    if (req.url?.startsWith('/big') || req.url?.startsWith('/atceiling')) {
      const total = CEILING_BYTES + (req.url.startsWith('/big') ? 1 : 0)
      res.shouldKeepAlive = true
      ceilingServerClosedFirst.push(
        new Promise((resolve) => res.once('finish', () => resolve(req.socket.writableEnded)))
      )
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
      const url = req.url
      const from = rangeStart(req.headers.range)
      const parkOnClientClose = (): void => {
        // `writableFinished` is false exactly when the client tore the connection down first —
        // the proof that the retry opened a FRESH socket rather than reusing a stuck one.
        res.on('close', () => {
          if (!res.writableFinished) parkedClosedByClient.push(url)
        })
      }
      const answer = rawHook?.(url) ?? null
      if (answer && 'drip' in answer) {
        // Slow but alive: the client's idle timer must be re-armed by every one of these.
        const { body, chunks, everyMs } = answer.drip
        const buf = Buffer.from(body, 'utf8')
        res.writeHead(from === null ? 200 : 206, {
          'content-type': 'text/html',
          'content-length': String(buf.length),
          ...(from === null ? {} : { 'content-range': `bytes 0-${buf.length - 1}/${buf.length}` })
        })
        const step = Math.ceil(buf.length / chunks)
        let sent = 0
        const pump = (): void => {
          if (sent >= buf.length) {
            res.end()
            return
          }
          res.write(buf.subarray(sent, sent + step))
          sent += step
          setTimeout(pump, everyMs).unref?.()
        }
        setTimeout(pump, everyMs).unref?.()
        return
      }
      if (answer && 'stall' in answer) {
        if (answer.stall === 'silent') {
          parkOnClientClose()
          return // nothing is ever sent
        }
        if (answer.stall === 'reset') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.write(answer.partial, () => res.destroy()) // a real socket error mid-body
          return
        }
        parkOnClientClose()
        if (answer.stall === 'headers-only') {
          // Framed exactly like a real answer — and then not one body byte ever arrives.
          res.writeHead(from === null ? 200 : 206, {
            'content-type': 'text/html',
            'content-length': String(answer.total),
            ...(from === null
              ? {}
              : { 'content-range': `bytes ${from}-${answer.total - 1}/${answer.total}` })
          })
          // Node holds headers back until the first write — flush them explicitly, or this
          // would be indistinguishable from `'silent'` and would never arm the client's
          // inter-chunk timer at all.
          res.flushHeaders()
          return
        }
        // The measured shape: a complete, HONEST `Content-Length`, then only part of the body.
        res.writeHead(from === null ? 200 : 206, {
          'content-type': 'text/html',
          'content-length': String(answer.total),
          ...(from === null
            ? {}
            : { 'content-range': `bytes ${from}-${answer.total - 1}/${answer.total}` })
        })
        res.write(answer.partial) // …and the rest never comes
        return
      }
      if (answer) {
        sendRawAnswer(res, answer, from)
        return
      }
      if (url.includes('/raw/missing/')) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      sendRawAnswer(res, { status: 200, body: '<html><body><p>Artikel</p></body></html>' }, from)
      return
    }
    res.writeHead(200)
    res.end('ok')
  })
  // Only the body-ceiling answers are keep-alive (#467); 0 disables the idle timer that would
  // otherwise close their socket server-side after 5 s — the very close the fixture avoids.
  server.keepAliveTimeout = 0
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

  // The two 8 MiB legs move real bytes over loopback: well under a second even under load, so
  // the budget is headroom for a starved fork, not a rescue. They used to carry `retry: 2` too,
  // for a `read ECONNRESET` blamed on the transfer being slow; it was the fixture's server-side
  // close instead (#467, see the fixture), so there is nothing left for a retry to absorb.
  const BIG_BODY_BUDGET_MS = 60_000
  it('rejects a body over the 8 MiB ceiling mid-stream (T01, review INFO)', async () => {
    await expect(kiwixGet(port, '/big', { timeoutMs: BIG_BODY_BUDGET_MS })).rejects.toThrow(
      /exceeded 8388608 bytes/
    )
  }, BIG_BODY_BUDGET_MS)

  it('accepts a body of exactly 8 MiB (the ceiling is strict-greater)', async () => {
    ceilingServerClosedFirst.length = 0
    const res = await kiwixGet(port, '/atceiling', { timeoutMs: BIG_BODY_BUDGET_MS })
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(CEILING_BYTES)
    // The fixture's precondition (#467), checked on every run rather than only under load: had
    // the server closed first, this leg would pass on an idle box and reset on a busy one.
    expect(await Promise.all(ceilingServerClosedFirst)).toEqual([false])
  }, BIG_BODY_BUDGET_MS)
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
    resetRequestLog()
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
    resetRequestLog()
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
      resetRequestLog()
      install({
        [ALIAS_URL]: redirectTo(`/content/${NAME}/Treibhauspotential`, status),
        [TARGET_URL]: { status: 200, body: TARGET_HTML }
      })
      await expect(fetchArticleHtml(port, NAME, ALIAS)).resolves.toBe(TARGET_HTML)
      expect(rawLog(), `status ${status}`).toEqual([ALIAS_URL, TARGET_URL])
    }
    // Some builds could answer with the /raw route instead; the same book is the whole test.
    resetRequestLog()
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
      resetRequestLog()
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
      resetRequestLog()
      install({ [ALIAS_URL]: redirectTo(location), [TARGET_URL]: { status: 200, body: TARGET_HTML } })
      await expect(fetchArticleHtml(port, NAME, ALIAS), location).resolves.toBeNull()
      expect(rawLog(), location).toEqual([ALIAS_URL])
    }
    // A redirect status with no `Location` header at all is the same honest null.
    resetRequestLog()
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
    resetRequestLog()
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

    resetRequestLog()
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
    resetRequestLog()
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
      resetRequestLog()
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
    resetRequestLog()
    await expect(
      probeSearchable(port, 'parked', undefined, { timeoutMs: STALL_TIMEOUT_MS })
    ).resolves.toBeNull()
    expect(requestLog.filter((u) => u.startsWith('/suggest'))).toHaveLength(1)
    suggestHook = null

    // …and a search still makes exactly one request per call (it answers here; the point is
    // that nothing in the search path grew a retry).
    resetRequestLog()
    await expect(searchPack(port, 'uuid-1', 'Treibhausgas', 5)).resolves.toHaveLength(2)
    expect(requestLog.filter((u) => u.startsWith('/search'))).toHaveLength(1)
  })
})

describe('fetchArticleHtml reads /raw Range-first and resumes a stall (#339, rag-design §17 D-Z22)', () => {
  const NAME = 'wikipedia_de_climate-change_nopic_2026-07'
  const ENTRY = 'Klimawandel' // the measured 508,338-byte staller
  const ALIAS = 'CO2-Äquivalent'
  /** Long enough for a resume to be a real join, and full of multi-byte characters so the cut
   *  can be placed INSIDE one. */
  const HTML =
    '<html><body><h1>Klimawandel</h1>' +
    '<p>Änderung der Erdatmosphäre — Größenordnung 1,5 °C.</p>'.repeat(60) +
    '</body></html>'
  const BYTES = Buffer.from(HTML, 'utf8')
  /**
   * A cut ONE BYTE into a two-byte UTF-8 sequence. The measured stall cuts at an arbitrary byte
   * offset (a multiple of 65,280), so this is the real hazard: decoding the prefix and the tail
   * separately would turn the split character into two replacement characters. The client joins
   * BYTES and decodes once.
   */
  const CUT = (() => {
    for (let i = Math.floor(BYTES.length / 2); i < BYTES.length - 2; i++) {
      if ((BYTES[i]! & 0xe0) === 0xc0) return i + 1
    }
    throw new Error('fixture has no multi-byte character to cut')
  })()
  const TRUNCATED: RawStall = {
    stall: 'truncated',
    partial: BYTES.subarray(0, CUT),
    total: BYTES.length
  }
  const ANSWER: RawAnswerBody = { status: 200, body: HTML }
  const raw = (encodedKey: string): string => `/raw/${NAME}/content/${encodedKey}`
  const ENTRY_URL = raw('Klimawandel')
  const ALIAS_URL = raw('CO2-%C3%84quivalent')
  const TARGET_URL = raw('Treibhauspotential')
  /** Shrunk for these legs; the shipped budgets are 4 s total and 1 s idle. */
  const TOTAL_MS = 3_000
  const IDLE_MS = 150

  const installQueues = (queues: Record<string, RawFixtureAnswer[]>): void => {
    rawHook = (url) => queues[url]?.shift() ?? { status: 404, body: 'not found' }
  }
  const read = (signal?: AbortSignal, key = ENTRY): Promise<string | null> =>
    fetchArticleHtml(port, NAME, key, signal, { timeoutMs: TOTAL_MS, idleMs: IDLE_MS })

  beforeEach(() => {
    resetRequestLog()
    parkedClosedByClient.length = 0
  })
  afterEach(() => {
    rawHook = null
  })

  // ---- (1) + (2) the Range header itself ----------------------------------------

  it('(1) the first request AND the redirect hop carry Range: bytes=0-; /search and /suggest carry none', async () => {
    installQueues({
      [ALIAS_URL]: [
        { status: 302, headers: { location: `/content/${NAME}/Treibhauspotential` }, body: '' }
      ],
      [TARGET_URL]: [ANSWER]
    })
    await expect(read(undefined, ALIAS)).resolves.toBe(HTML)
    expect(rawRequests()).toEqual([
      { url: ALIAS_URL, range: 'bytes=0-' },
      { url: TARGET_URL, range: 'bytes=0-' }
    ])

    // The mitigation is scoped to the article route: nothing else may start sending a header
    // whose whole purpose is to dodge one route's server-side defect (T19 leg (g)).
    resetRequestLog()
    suggestHook = () => SUGGEST_FIXTURES.indexed!
    await expect(probeSearchable(port, 'indexed')).resolves.toBe('yes')
    await expect(searchPack(port, 'uuid-1', 'Treibhausgas', 5)).resolves.toHaveLength(2)
    suggestHook = null
    expect(rangeLog.every((r) => r === undefined)).toBe(true)
    expect(requestLog.some((u) => u.startsWith('/suggest'))).toBe(true)
    expect(requestLog.some((u) => u.startsWith('/search'))).toBe(true)
  })

  it('(2) a 206 is the article on the first request and on the hop, and a 200 still is too', async () => {
    // The real server answers 206 + Content-Range to `bytes=0-`; the fixture does the same.
    installQueues({ [ENTRY_URL]: [ANSWER] })
    await expect(read()).resolves.toBe(HTML)

    resetRequestLog()
    installQueues({
      [ALIAS_URL]: [
        { status: 302, headers: { location: `/content/${NAME}/Treibhauspotential` }, body: '' }
      ],
      [TARGET_URL]: [ANSWER]
    })
    await expect(read(undefined, ALIAS)).resolves.toBe(HTML)

    // A server that ignores the header answers 200 with the whole body — still the article.
    resetRequestLog()
    installQueues({ [ENTRY_URL]: [{ ...ANSWER, ignoreRange: true }] })
    await expect(read()).resolves.toBe(HTML)
    expect(rawRequests()).toEqual([{ url: ENTRY_URL, range: 'bytes=0-' }])

    // …and a 404 is still the honest skip, under the header like without it.
    resetRequestLog()
    installQueues({ [ENTRY_URL]: [{ status: 404, body: 'not found' }] })
    await expect(read()).resolves.toBeNull()
    expect(rawRequests()).toEqual([{ url: ENTRY_URL, range: 'bytes=0-' }])
  })

  // ---- (3) the inter-chunk idle detector ----------------------------------------

  it('(3) silence after a partial body is caught by the IDLE timer, long before the total one', async () => {
    installQueues({ [ENTRY_URL]: [TRUNCATED, TRUNCATED, TRUNCATED] })
    const started = Date.now()
    let caught: unknown
    await read().catch((err: unknown) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(KiwixTimeoutError)
    expect((caught as KiwixTimeoutError).kind).toBe('idle')
    expect((caught as KiwixTimeoutError).timeoutMs).toBe(IDLE_MS)
    expect((caught as KiwixTimeoutError).headersReceived).toBe(true)
    expect((caught as KiwixTimeoutError).bytesReceived).toBe(CUT)
    expect((caught as KiwixTimeoutError).status).toBe(206)
    expect((caught as KiwixTimeoutError).contentLength).toBe(BYTES.length)
    // Three attempts on the idle timer, not on the total one: the whole ladder is well inside
    // ONE total budget. This is the point of the detector.
    expect(rawRequests()).toHaveLength(ARTICLE_READ_ATTEMPTS)
    expect(Date.now() - started).toBeLessThan(TOTAL_MS)
  })

  it('(3b) a slow but LIVE body is never cut: every chunk re-arms the idle timer', async () => {
    installQueues({
      [ENTRY_URL]: [{ drip: { body: HTML, chunks: 8, everyMs: Math.floor(IDLE_MS / 2) } }]
    })
    await expect(read()).resolves.toBe(HTML)
    expect(rawRequests()).toHaveLength(1) // one request; nothing was retried
  })

  it('(3c) a server that never sends headers at all still rejects on the TOTAL timer', async () => {
    // The idle timer is armed by the headers, so a request that is merely accepted and never
    // answered is the total budget's business — exactly as before D-Z22.
    installQueues({ [ENTRY_URL]: [{ stall: 'silent' }, { stall: 'silent' }, { stall: 'silent' }] })
    let caught: unknown
    await fetchArticleHtml(port, NAME, ENTRY, undefined, { timeoutMs: 200, idleMs: IDLE_MS }).catch(
      (err: unknown) => {
        caught = err
      }
    )
    expect(caught).toBeInstanceOf(KiwixTimeoutError)
    expect((caught as KiwixTimeoutError).kind).toBe('total')
    expect((caught as KiwixTimeoutError).headersReceived).toBe(false)
    expect((caught as KiwixTimeoutError).bytesReceived).toBe(0)
  })

  // ---- (4) + (5) + (6) the resume -----------------------------------------------

  it('(4) a stall is RESUMED from the byte it stopped at, in exactly two requests, byte-exactly', async () => {
    installQueues({ [ENTRY_URL]: [TRUNCATED, ANSWER] })
    const html = await read()
    // Byte-identical to the entry — including the multi-byte character the cut split in half,
    // which only survives because the prefix and the tail are joined BEFORE the UTF-8 decode.
    expect(html).toBe(HTML)
    expect(html).not.toContain(String.fromCharCode(0xfffd)) // no replacement character
    expect(rawRequests()).toEqual([
      { url: ENTRY_URL, range: 'bytes=0-' },
      { url: ENTRY_URL, range: `bytes=${CUT}-` }
    ])
    expect(parkedClosedByClient).toContain(ENTRY_URL)
  })

  it('(5) a resume the server does not prove is DISCARDED, and the whole entry is read again', async () => {
    const refusals: Array<[string, RawAnswerBody]> = [
      // A server that ignores Range answers 200 with the whole body — the prefix would double it.
      ['a 200 ignoring Range', { ...ANSWER, ignoreRange: true }],
      ['a 416', { ...ANSWER, unsatisfiable: true }],
      ['a mismatching Content-Range', { ...ANSWER, contentRange: `bytes 0-${BYTES.length - 1}/${BYTES.length}` }],
      ['a tail shorter than promised', { ...ANSWER, tailBytes: 16 }]
    ]
    for (const [label, refusal] of refusals) {
      resetRequestLog()
      installQueues({ [ENTRY_URL]: [TRUNCATED, refusal, ANSWER] })
      await expect(read(), label).resolves.toBe(HTML)
      // Three requests: the stall, the refused resume, and a FRESH whole-entry read.
      expect(rawRequests(), label).toEqual([
        { url: ENTRY_URL, range: 'bytes=0-' },
        { url: ENTRY_URL, range: `bytes=${CUT}-` },
        { url: ENTRY_URL, range: 'bytes=0-' }
      ])
    }
  })

  it('(5b) the attempt ceiling still bounds a read whose resume keeps being refused', async () => {
    // A fourth answering entry sits in the queue: the bound is the code's, not the fixture's.
    installQueues({
      [ENTRY_URL]: [TRUNCATED, { ...ANSWER, unsatisfiable: true }, TRUNCATED, ANSWER]
    })
    await expect(read()).rejects.toThrow()
    expect(rawRequests()).toHaveLength(ARTICLE_READ_ATTEMPTS)
  })

  it('(6) a stall BEFORE the first body byte is not resumed: the next request is a fresh read', async () => {
    installQueues({ [ENTRY_URL]: [{ stall: 'headers-only', total: BYTES.length }, ANSWER] })
    const started = Date.now()
    await expect(read()).resolves.toBe(HTML)
    // There is no prefix, so there is nothing to resume from: attempt 2 asks for the whole entry.
    expect(rawRequests()).toEqual([
      { url: ENTRY_URL, range: 'bytes=0-' },
      { url: ENTRY_URL, range: 'bytes=0-' }
    ])
    // Headers DID arrive, so the idle timer — not the total one — is what ended attempt 1.
    expect(Date.now() - started).toBeLessThan(TOTAL_MS)
  })

  it('(6b) a stalled resume is not chained: the third attempt reads the whole entry', async () => {
    installQueues({ [ENTRY_URL]: [TRUNCATED, TRUNCATED, ANSWER] })
    await expect(read()).resolves.toBe(HTML)
    expect(rawRequests()).toEqual([
      { url: ENTRY_URL, range: 'bytes=0-' },
      { url: ENTRY_URL, range: `bytes=${CUT}-` },
      { url: ENTRY_URL, range: 'bytes=0-' }
    ])
  })

  // ---- (7) the boundaries the resume must not cross ------------------------------

  it('(7) a caller abort during the resume rejects at once, with no further attempt', async () => {
    const ac = new AbortController()
    const reason = new Error('the ask was cancelled')
    let seen = 0
    rawHook = (url) => {
      if (url !== ENTRY_URL) return { status: 404, body: 'not found' }
      if (++seen === 2) ac.abort(reason) // as the resume request arrives
      return TRUNCATED
    }
    let caught: unknown
    await read(ac.signal).catch((err: unknown) => {
      caught = err
    })
    expect(caught).not.toBeInstanceOf(KiwixTimeoutError)
    expect((caught as Error).name).toBe('AbortError')
    expect((caught as Error).cause).toBe(reason)
    expect(rawRequests()).toHaveLength(2)
  })

  it('(7b) a mid-body socket error during a Range read is still not retried', async () => {
    installQueues({ [ENTRY_URL]: [{ stall: 'reset', partial: HTML.slice(0, 40) }, ANSWER] })
    let caught: unknown
    await read().catch((err: unknown) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(KiwixTimeoutError)
    expect(rawRequests()).toHaveLength(1)
  })

  it('(7c) a stall whose declared length is over the 8 MiB ceiling is never assembled', async () => {
    // `MAX_BODY_BYTES` bounds the ASSEMBLED body, and the assembled body is exactly the declared
    // `Content-Length` — so an over-ceiling entry is refused before a single tail byte is asked
    // for, and the fresh read that follows rejects on the ceiling the way it always did.
    installQueues({
      [ENTRY_URL]: [
        { stall: 'truncated', partial: BYTES.subarray(0, CUT), total: CEILING_BYTES + 1 },
        ANSWER
      ]
    })
    await expect(read()).resolves.toBe(HTML)
    expect(rawRequests()).toEqual([
      { url: ENTRY_URL, range: 'bytes=0-' },
      { url: ENTRY_URL, range: 'bytes=0-' }
    ])
  })

  // ---- (10) the shipped constants ------------------------------------------------

  it('(10) the shipped idle budget clears the measured inter-chunk gaps by 40x', async () => {
    // Largest gap between two body chunks through this very stack: 24.6 ms on the NVMe
    // measurement machine, 17.8 ms off the USB Kit drive on K: (2026-09-08). D-Z22.
    const MEASURED_MAX_GAP_MS = 24.6
    expect(ARTICLE_READ_IDLE_MS).toBe(1_000)
    expect(ARTICLE_READ_IDLE_MS).toBeGreaterThanOrEqual(40 * MEASURED_MAX_GAP_MS)
    // The idle timer must fire well before the whole-attempt one, or it detects nothing.
    expect(ARTICLE_READ_IDLE_MS).toBeLessThan(ARTICLE_READ_TIMEOUT_MS)
    // And the whole ladder still fits inside the arm's 20 s per-ask deadline.
    expect(ARTICLE_READ_TIMEOUT_MS * ARTICLE_READ_ATTEMPTS).toBeLessThan(20_000)
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
