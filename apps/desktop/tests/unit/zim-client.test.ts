import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ArticlePathError,
  MAX_ARTICLE_PATH_CHARS,
  assertArticlePath,
  encodeArticlePath,
  fetchArticleHtml,
  kiwixGet,
  parseLibraryXml,
  parseSearchXml,
  searchPack
} from '../../src/main/services/zim/client'

// The loopback client against a real ephemeral node:http server — the transport is the
// point (the undici crash forced node:http; see client.ts header), so the tests exercise
// real sockets, not a fetch stub.

let server: http.Server
let port = 0
/** Mirrors client.ts MAX_BODY_BYTES (8 MiB) — kept literal here so the test pins the shipped ceiling. */
const CEILING_BYTES = 8 * 1024 * 1024
/** Every request the fixture server received — used to prove the L5 contract rejects a
 *  hazardous key BEFORE any HTTP request (#301 P5, finding L5). */
let requestCount = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++
    if (req.url?.startsWith('/slow')) return // never responds — timeout leg
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
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(SEARCH_XML)
      return
    }
    if (req.url?.startsWith('/raw/')) {
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
      path: 'zim\\wikipedia_en_ray-charles_maxi_2026-08.zim'
    })
    expect(books[1]?.title).toBe('Käfer & Co')
    expect(books[1]?.articleCount).toBeNull()
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
