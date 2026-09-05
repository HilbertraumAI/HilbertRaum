import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
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
