import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import {
  ragSettingsFrom,
  retrieve,
  type ExternalRetrievalOutput,
  type RagRetrievalSettings
} from '../../src/main/services/rag'
import type { Reranker } from '../../src/main/services/reranker'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import {
  ARTICLES_PER_PACK,
  DF_PROBE_TIMEOUT_MS,
  MAX_EXTERNAL_CANDIDATES,
  allocateCandidates,
  collectPackCandidates,
  overlapScore,
  packQuota,
  queryTerms,
  type ExternalCandidate,
  type PackCandidateList
} from '../../src/main/services/zim/arm'

// The ZIM retrieval arm end-to-end against a fake kiwix-serve (real sockets — the
// node:http transport is load-bearing, see client.ts), and the retrieve() seam:
// external candidates ride rerank/interleave/dedup/budget/citations exactly like
// document chunks, and an arm failure never breaks the document ask.

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

let server: http.Server
let port = 0

function articleHtml(title: string, sections: Array<[string, string]>): string {
  const body = sections
    .map(
      ([h, text], i) =>
        `<section data-mw-section-id="${i + 1}"><div class="mw-heading mw-heading2"><h2 id="s${i}">${h}</h2></div><p>${text}</p></section>`
    )
    .join('')
  return `<!DOCTYPE html><html lang="de"><head><title>${title}</title></head><body><h1>${title}</h1><section data-mw-section-id="0"><p>Einleitung zu ${title}.</p></section>${body}</body></html>`
}

/** A multi-slice article (P1b): ~600 KB of well-formed sections, comfortably past
 *  DEFAULT_SLICE_WORK so the converter yields to the event loop several times. */
function bigArticleHtml(): string {
  const sections: Array<[string, string]> = Array.from({ length: 400 }, (_, i) => [
    `Abschnitt ${i}`,
    `Treibhausgas aus der Landwirtschaft, Absatz ${i}. `.repeat(20)
  ])
  return articleHtml('Grossartikel', sections)
}
/** Set by the fake sidecar once the big article's body has been written. */
let bigArticleServed = false
/** Every `/search` pattern the fixture server received, in order (#340 L3). Scoped to
 *  NON-PROBE searches (`pageLength !== '1'`) — see `allSearchRequests` for the #353 ladder's
 *  probes, so this array's pre-existing exact-equality assertions stay unaffected by them. */
const searchPatterns: string[] = []
/** Every `/search` request the fixture server received, of EVERY book and EVERY pageLength, in
 *  order (#353 document-frequency ladder) — pins the exact pattern/retry/probe/narrowed
 *  sequence and that a probe carried `pageLength=1`. */
const allSearchRequests: Array<{ book: string; pattern: string; pageLength: string }> = []

// #353: the question below rewrites to three long content words (`searchPattern` keeps them
// verbatim; all >= RETRY_MIN_TERM_CHARS so the length-based retry offers nothing), the pattern
// search finds nothing, and the ladder probes each term's own hit count before narrowing.
const DF_QUESTION = 'Nenne die wichtigsten eigenschaftn von ammoniak'
const DF_NARROWED_PATTERN = 'wichtigsten ammoniak'
const DF_TOTALS: Record<string, number> = { wichtigsten: 12, eigenschaftn: 0, ammoniak: 40 }
function totalsXml(total: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Search</title>' +
    `<opensearch:totalResults>${total}</opensearch:totalResults></channel></rss>`
  )
}

// #353 review fix 1: 8 kept content words (none a stop/frame word, all >= RETRY_MIN_TERM_CHARS
// so there is no length-based retry) — one MORE than DF_PROBE_MAX_TERMS, so the last two never
// get probed at all. They must still survive the narrowed re-search: narrowing the FULL term
// list (not just the probed prefix) is exactly the bug this fixes.
const DF8_QUESTION =
  'Alphaterm Betaterm Gammaterm Deltaterm Epsilonterm Zetaterm Etaterm Thetaterm'
const DF8_TOTALS: Record<string, number> = {
  Alphaterm: 10,
  Betaterm: 0, // the only zero — the term the ladder must drop
  Gammaterm: 20,
  Deltaterm: 5,
  Epsilonterm: 15,
  Zetaterm: 30
  // Etaterm, Thetaterm: past DF_PROBE_MAX_TERMS — never probed, must still survive.
}
const DF8_NARROWED_PATTERN = 'Alphaterm Gammaterm Deltaterm Epsilonterm Zetaterm Etaterm Thetaterm'

/** #353 review fix 4: set true the instant the fixture receives an in-flight probe for
 *  `pack-df-abort`, which never answers it — the test aborts the ask once this flips. */
let dfAbortProbeSeen = false

/** Poll until `cond()` is true or `rounds` are exhausted (real loopback I/O, never a sleep of a
 *  fixed guessed duration) — used only for the #353 abort-during-probe leg below. */
async function waitUntilTrue(cond: () => boolean, rounds = 400): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return cond()
}
/**
 * Article titles whose NEXT `/raw` read the fake sidecar CUTS SHORT — the measured kiwix-serve
 * 3.8.1 stall (#301 P7 T19): the 200, an honest `Content-Length` and most of the body arrive,
 * then the connection hangs and the last part never does. The title is removed as it fires, so
 * the retry finds the article served whole, exactly as the real server behaves.
 */
const stallOnce = new Set<string>()
/** Every article title the fake sidecar was asked for over `/raw`, in order. */
const rawReads: string[] = []

function searchXml(bookUrlId: string, titles: string[]): string {
  const items = titles
    .map(
      (t) =>
        `<item><title>${t}</title><link>/content/${bookUrlId}/${encodeURIComponent(t.replace(/ /g, '_'))}</link><wordCount>1,000</wordCount></item>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Search</title>${items}</channel></rss>`
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/search') {
      const book = url.searchParams.get('books.id') ?? ''
      if (book === 'pack-broken') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      const pattern = url.searchParams.get('pattern') ?? ''
      const pageLength = url.searchParams.get('pageLength') ?? ''
      allSearchRequests.push({ book, pattern, pageLength })
      if (pageLength !== '1') searchPatterns.push(pattern)
      // #353: a book whose pattern search finds nothing, and whose per-term probes (pageLength=1)
      // report a df of 0 for exactly one term — the ladder should narrow around it and re-search.
      if (book === 'pack-df') {
        if (pageLength === '1') {
          res.writeHead(200, { 'content-type': 'application/xml' })
          res.end(totalsXml(DF_TOTALS[pattern] ?? 0))
          return
        }
        const titles = pattern === DF_NARROWED_PATTERN ? ['Ammoniak'] : []
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, titles))
        return
      }
      // #353: a book whose FIRST probe answers HTTP 500 — the ladder must end right there,
      // fail-soft, with no further probe and no narrowed re-search.
      if (book === 'pack-df-fail') {
        if (pageLength === '1') {
          res.writeHead(500)
          res.end('boom')
          return
        }
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, []))
        return
      }
      // #353 review fix 1: 8 kept terms, only the first 6 probed, one of THOSE is df 0 — the
      // narrowed re-search must carry all 7 survivors, including the two never probed.
      if (book === 'pack-df8') {
        if (pageLength === '1') {
          res.writeHead(200, { 'content-type': 'application/xml' })
          res.end(totalsXml(DF8_TOTALS[pattern] ?? 0))
          return
        }
        const titles = pattern === DF8_NARROWED_PATTERN ? ['Alphaterm'] : []
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, titles))
        return
      }
      // #353 review fix 3: every probe stalls forever — `DF_PROBE_TIMEOUT_MS` (not the client's
      // 15 s default) must be what ends it, fail-soft, within a few seconds.
      if (book === 'pack-df-timeout') {
        if (pageLength === '1') return // never answered — the client's own probe timeout fires
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, []))
        return
      }
      // #353 review fix 4: the first probe is seen but never answered — the test aborts the ask
      // once it lands, so the abort must win over the probe, never surface as an empty list.
      if (book === 'pack-df-abort') {
        if (pageLength === '1') {
          dfAbortProbeSeen = true
          return // never answered — the ask's own abort is what ends this
        }
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, []))
        return
      }
      const titles =
        book === 'pack-climate'
          ? ['Treibhausgas', 'Treibhauspotential']
          : book === 'pack-big'
            ? ['Grossartikel']
            : book === 'pack-mixed'
              ? ['Kaputt', 'Schwefel']
              : book === 'pack-retry'
                ? // #340 L3: a book that answers ONLY the narrower retry pattern — the first
                  // (broader) pattern finds nothing, the way an ANDed short generic word does.
                  pattern === 'wirkt'
                  ? ['Schwefel']
                  : []
                : ['Schwefel']
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(searchXml(`book-${book}`, titles))
      return
    }
    if (url.pathname.startsWith('/raw/')) {
      const article = decodeURIComponent(url.pathname.split('/content/')[1] ?? '').replace(/_/g, ' ')
      rawReads.push(article)
      // One article whose fetch fails: the arm must skip THAT HIT and keep the others.
      if (article === 'Kaputt') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      // One article big enough to need several converter slices (P1b), so an ask that is
      // cancelled while it converts has something to be cancelled during.
      if (article === 'Grossartikel') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(bigArticleHtml())
        bigArticleServed = true
        return
      }
      const body = articleHtml(article, [
        ['Landwirtschaft', `${article} entsteht durch Methan aus der Landwirtschaft.`],
        ['Industrie', `${article} in der Industrie stammt aus Verbrennung.`],
        ['Trivia', 'Ein Abschnitt ohne die gesuchten Begriffe.']
      ])
      // #301 P7 T19: the 200 and an honest `Content-Length`, then only ~85 % of the body —
      // the connection hangs and the last part never arrives. The client's per-attempt timeout
      // ends it, and the retry (the title is already consumed) reads the article whole.
      if (stallOnce.delete(article)) {
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-length': String(Buffer.byteLength(body))
        })
        res.write(body.slice(0, Math.floor(body.length * 0.85)))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('collectPackCandidates', () => {
  it('produces archive candidates: search → fetch → segments → chunker → overlap pick', async () => {
    const packs = [{ id: 'pack-climate', title: 'Klimawandel von Wikipedia' }]
    const { candidates: out, outcomes } = await collectPackCandidates(
      port,
      packs,
      'Wie entsteht Treibhausgas in der Landwirtschaft?'
    )
    expect(out.length).toBeGreaterThan(0)
    // #301 P4: the arm reports per-pack outcomes beside the candidates (plan §9.21 (c)6).
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      packId: 'pack-climate',
      title: 'Klimawandel von Wikipedia',
      status: 'searched',
      reason: null,
      found: out.length,
      admitted: out.length
    })
    const first = out[0]!
    expect(first).toMatchObject({
      documentId: 'zim:pack-climate',
      sourceKind: 'archive',
      packId: 'pack-climate',
      archiveTitle: 'Klimawandel von Wikipedia',
      pageNumber: null
    })
    expect(first.chunkId).toMatch(/^zim:pack-climate:/)
    expect(first.sourceTitle).toBe('Treibhausgas')
    expect(first.articlePath).toBe('Treibhausgas')
    // The overlap picker prefers the section naming the query terms.
    expect(first.text).toContain('Landwirtschaft')
  })

  it('#301 P7 T19 an article whose first read is cut short keeps its chunks', async () => {
    // Before the stall retry, kiwix-serve 3.8.1 (win-x86_64) cutting a `/raw` read short cost
    // the ask that article ENTIRELY and silently: `fetchArticleHtml` rejected on the timeout and
    // the arm's per-hit `continue` swallowed it (a measured ask returned 16 of 20 passages after
    // 40 s). The retry makes the stall invisible to the ask — and the truncated body is
    // discarded, so no half-article's chunks reach the answer either.
    const packs = [{ id: 'pack-climate', title: 'Klimawandel von Wikipedia' }]
    const question = 'Wie entsteht Treibhausgas in der Landwirtschaft?'
    const { candidates: unstalled } = await collectPackCandidates(port, packs, question)

    rawReads.length = 0
    stallOnce.add('Treibhausgas') // the top hit — the one that used to disappear
    const { candidates, outcomes } = await collectPackCandidates(
      port,
      packs,
      question,
      undefined,
      undefined,
      // Shrunk for this leg only; the shipped per-attempt budget is 4 s.
      { articleTimeoutMs: 300 }
    )

    expect(stallOnce.size).toBe(0) // the stall really fired
    // Same candidates, in the same order, as the run where nothing stalled.
    expect(candidates.map((c) => c.chunkId)).toEqual(unstalled.map((c) => c.chunkId))
    expect(candidates.some((c) => c.sourceTitle === 'Treibhausgas')).toBe(true)
    expect(outcomes[0]).toMatchObject({
      packId: 'pack-climate',
      status: 'searched',
      reason: null,
      found: candidates.length
    })
    // Exactly ONE extra read, of the stalled article alone — the other hit is fetched once.
    expect(rawReads).toEqual(['Treibhausgas', 'Treibhausgas', 'Treibhauspotential'])
  })

  it('P1b an aborted ask signal propagates out of collectPackCandidates instead of an empty list', async () => {
    // The ask signal drives BOTH the HTTP fetch and (since P1b) the conversion, and the two
    // have opposite contracts: a fetch failure skips that hit, a conversion abort must
    // propagate. To pin the second without racing the first, the signal here is inert to
    // HTTP — kiwixGet captures `aborted` once at request setup (combineSignals) and then
    // relies on an 'abort' listener, which this object never fires — while the converter
    // reads `aborted` afresh at every slice boundary. So the fetch always succeeds and the
    // conversion always sees the cancellation, with no timing window either way.
    bigArticleServed = false
    const reason = new Error('the ask was cancelled')
    let cancelled = false
    const signal = {
      get aborted(): boolean {
        return cancelled
      },
      get reason(): unknown {
        return reason
      },
      onabort: null,
      throwIfAborted(): void {},
      addEventListener(): void {},
      removeEventListener(): void {},
      dispatchEvent(): boolean {
        return true
      }
    } as unknown as AbortSignal
    // Cancel as soon as the sidecar has written the big article: the conversion is then the
    // only work left, and it is the multi-slice one.
    const cancelWhenServed = (): void => {
      if (bigArticleServed) cancelled = true
      else setImmediate(cancelWhenServed)
    }
    setImmediate(cancelWhenServed)

    // The PROPERTY this leg pins: an aborted ask REJECTS — it never resolves to an empty list.
    // Which abort it rejects with is a scheduling fact, not the contract: the converter rejects
    // with `signal.reason` at its next slice boundary, but since the P7 stall retry the client
    // re-reads `signal.aborted` after an attempt and `combineSignals` reads it when the next
    // request is created, so under load the transport can observe the cancellation first and
    // reject with Node's own `AbortError` (seen three times on 2026-09-06 after heavy runs,
    // never in isolation). Both are the ask's abort; neither is an empty list.
    const err = await collectPackCandidates(
      port,
      [{ id: 'pack-big', title: 'Gross' }],
      'Treibhausgas Landwirtschaft',
      signal
    ).then(
      () => {
        throw new Error('expected the aborted ask to reject, but it resolved')
      },
      (e: unknown) => e
    )
    expect(err === reason || (err instanceof Error && err.name === 'AbortError'), String(err)).toBe(true)
  })

  it('P1b a per-hit fetch failure is still skipped — only the conversion abort propagates', async () => {
    const { candidates: out } = await collectPackCandidates(
      port,
      [{ id: 'pack-mixed', title: 'Gemischt' }],
      'Schwefel Verbrennung'
    )
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((c) => c.articlePath === 'Schwefel')).toBe(true)
  })

  // #340 L3 (D-Z18): the question's function and frame words never reach Xapian (it ANDs every
  // word), and a first search that finds nothing is retried ONCE with the narrower pattern.
  it('sends the rewritten pattern to /search and retries once, narrower, when the first search finds nothing', async () => {
    searchPatterns.length = 0
    const { candidates, outcomes } = await collectPackCandidates(
      port,
      [{ id: 'pack-retry', title: 'Retry' }],
      'Wie wirkt CO2 auf das Eis?' // → 'wirkt CO2 Eis', retry 'wirkt'
    )
    expect(searchPatterns).toEqual(['wirkt CO2 Eis', 'wirkt'])
    expect(candidates.length).toBeGreaterThan(0)
    expect(outcomes[0]).toMatchObject({ packId: 'pack-retry', status: 'searched', found: candidates.length })

    // An ordinary question: the frame words are gone, ONE search, no retry when it hits.
    searchPatterns.length = 0
    const climate = await collectPackCandidates(
      port,
      [{ id: 'pack-climate', title: 'Klima' }],
      'Welche Rolle spielt das Treibhausgas beim Treibhauspotential?'
    )
    expect(searchPatterns).toEqual(['Treibhausgas Treibhauspotential'])
    expect(climate.candidates.length).toBeGreaterThan(0)

    // Zero hits and NO narrower pattern to try (every kept term is long): no length-based
    // retry — but the #353 ladder still has two terms to work with, so this leg now issues
    // ONE search plus TWO document-frequency probes (this fixture never answers
    // `opensearch:totalResults`, so both probes resolve unknown and nothing is narrowed — an
    // honest empty result, not a second search).
    searchPatterns.length = 0
    allSearchRequests.length = 0
    const none = await collectPackCandidates(port, [{ id: 'pack-retry', title: 'Retry' }], 'Warum steigt der Meeresspiegel?')
    expect(searchPatterns).toEqual(['steigt Meeresspiegel'])
    const noneRequests = allSearchRequests.filter((r) => r.book === 'pack-retry')
    expect(noneRequests.map((r) => r.pattern)).toEqual(['steigt Meeresspiegel', 'steigt', 'Meeresspiegel'])
    expect(noneRequests.map((r) => r.pageLength)).toEqual([String(ARTICLES_PER_PACK), '1', '1'])
    expect(none.candidates).toEqual([])
    expect(none.outcomes[0]).toMatchObject({ packId: 'pack-retry', status: 'searched', found: 0 })
  })

  // #353: the length-based retry (#340 L3) cannot narrow a pattern whose terms are ALL already
  // RETRY_MIN_TERM_CHARS or longer. The document-frequency ladder is the last resort: probe
  // each term's own archive-wide hit count and search once more without the one the probes say
  // is most likely responsible.
  it('#353 narrows by document frequency when the length-based retry offers nothing: probes then re-searches without the df-0 term', async () => {
    allSearchRequests.length = 0
    const { candidates, outcomes } = await collectPackCandidates(
      port,
      [{ id: 'pack-df', title: 'Chemie' }],
      DF_QUESTION
    )
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.some((c) => c.sourceTitle === 'Ammoniak')).toBe(true)
    expect(outcomes[0]).toMatchObject({
      packId: 'pack-df',
      status: 'searched',
      reason: null,
      found: candidates.length
    })

    const dfRequests = allSearchRequests.filter((r) => r.book === 'pack-df')
    // Stage 1 (zero hits) → three sequential probes, in pattern order → stage 3's one narrowed
    // re-search. No retry stage: every kept term is already >= RETRY_MIN_TERM_CHARS.
    expect(dfRequests.map((r) => r.pattern)).toEqual([
      'wichtigsten eigenschaftn ammoniak',
      'wichtigsten',
      'eigenschaftn',
      'ammoniak',
      DF_NARROWED_PATTERN
    ])
    expect(dfRequests.map((r) => r.pageLength)).toEqual([
      String(ARTICLES_PER_PACK),
      '1',
      '1',
      '1',
      String(ARTICLES_PER_PACK)
    ])
  })

  it('#353 a failed probe ends the ladder fail-soft: the pack stays searched with zero, never search-failed', async () => {
    allSearchRequests.length = 0
    const { candidates, outcomes } = await collectPackCandidates(
      port,
      [{ id: 'pack-df-fail', title: 'Broken probe' }],
      'Erkläre Xenongehalt Betonwerte' // → pattern 'Xenongehalt Betonwerte', no retry (both long)
    )
    expect(candidates).toEqual([])
    expect(outcomes[0]).toMatchObject({
      packId: 'pack-df-fail',
      status: 'searched',
      reason: null,
      found: 0
    })
    const failRequests = allSearchRequests.filter((r) => r.book === 'pack-df-fail')
    // The pattern search, then exactly ONE probe — which fails — and nothing after it: no
    // second probe, no narrowed re-search.
    expect(failRequests.map((r) => r.pattern)).toEqual(['Xenongehalt Betonwerte', 'Xenongehalt'])
    expect(failRequests.map((r) => r.pageLength)).toEqual([String(ARTICLES_PER_PACK), '1'])
  })

  // #353 review fix 1 (CORRECTNESS): `narrowByFrequency` must narrow the FULL kept-term list,
  // not just the probed prefix — otherwise a pattern longer than `DF_PROBE_MAX_TERMS` silently
  // drops its un-probed tail (which could be the question's subject) instead of keeping it.
  it('#353 a pattern longer than DF_PROBE_MAX_TERMS keeps its un-probed terms in the narrowed re-search', async () => {
    allSearchRequests.length = 0
    const { candidates, outcomes } = await collectPackCandidates(
      port,
      [{ id: 'pack-df8', title: 'Eight terms' }],
      DF8_QUESTION
    )
    expect(candidates.length).toBeGreaterThan(0)
    expect(outcomes[0]).toMatchObject({ packId: 'pack-df8', status: 'searched', reason: null })

    const requests = allSearchRequests.filter((r) => r.book === 'pack-df8')
    expect(requests.map((r) => r.pattern)).toEqual([
      'Alphaterm Betaterm Gammaterm Deltaterm Epsilonterm Zetaterm Etaterm Thetaterm', // stage 1
      'Alphaterm', // 6 probes — Etaterm/Thetaterm are past the cap and never probed
      'Betaterm',
      'Gammaterm',
      'Deltaterm',
      'Epsilonterm',
      'Zetaterm',
      DF8_NARROWED_PATTERN // Betaterm (df 0) dropped; Etaterm AND Thetaterm both survive
    ])
    expect(requests.map((r) => r.pageLength)).toEqual([
      String(ARTICLES_PER_PACK),
      '1',
      '1',
      '1',
      '1',
      '1',
      '1',
      String(ARTICLES_PER_PACK)
    ])
  })

  // #353 review fix 3 (DEADLINE): a probe must not sit out the client's 15 s default under the
  // arm's 20 s per-ask deadline — `DF_PROBE_TIMEOUT_MS` bounds it to a few seconds instead.
  it('#353 a probe that never answers ends the ladder fail-soft within DF_PROBE_TIMEOUT_MS, not the 15 s default', async () => {
    const startedAt = Date.now()
    const { candidates, outcomes } = await collectPackCandidates(
      port,
      [{ id: 'pack-df-timeout', title: 'Stalled probe' }],
      'Erkläre Xenongehalt Betonwerte'
    )
    const elapsedMs = Date.now() - startedAt
    expect(candidates).toEqual([])
    expect(outcomes[0]).toMatchObject({
      packId: 'pack-df-timeout',
      status: 'searched',
      reason: null,
      found: 0
    })
    // Comfortably above DF_PROBE_TIMEOUT_MS (scheduling slack) and comfortably below the
    // client's old 15 s default — proves the SHORT budget fired, not the long one.
    expect(elapsedMs).toBeGreaterThanOrEqual(DF_PROBE_TIMEOUT_MS)
    expect(elapsedMs).toBeLessThan(10_000)
  }, 15_000)

  // #353 review fix 4 (TESTS): an ask aborted while a document-frequency probe is in flight must
  // reject with the abort — mirroring the existing P1b "an aborted ask signal propagates" leg —
  // never resolve to an empty candidate list.
  it('#353 an ask aborted while a probe is in flight rejects, never resolves to an empty list', async () => {
    dfAbortProbeSeen = false
    const ac = new AbortController()
    const pending = collectPackCandidates(
      port,
      [{ id: 'pack-df-abort', title: 'Abort probe' }],
      'Erkläre Xenongehalt Betonwerte',
      ac.signal
    )
    expect(await waitUntilTrue(() => dfAbortProbeSeen)).toBe(true)
    ac.abort()
    const err = await pending.then(
      () => {
        throw new Error('expected the aborted ask to reject, but it resolved')
      },
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('AbortError')
  })

  it('isolates a failing pack — the healthy pack still contributes', async () => {
    const packs = [
      { id: 'pack-broken', title: 'Broken' },
      { id: 'pack-chem', title: 'Chemie von Wikipedia' }
    ]
    const { candidates: out, outcomes } = await collectPackCandidates(port, packs, 'Schwefel Verbrennung')
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((c) => c.packId === 'pack-chem')).toBe(true)
    // …and the failing pack is REPORTED rather than silently dropped (#301 P4, finding M6):
    // its `/search` answered HTTP 500, which is `search-failed` for this ask only — never a
    // persisted capability (a 404 is just as ambiguous, plan §2.2).
    expect(outcomes.find((o) => o.packId === 'pack-broken')).toMatchObject({
      title: 'Broken',
      status: 'failed',
      reason: 'search-failed',
      found: 0,
      admitted: 0
    })
    expect(outcomes.find((o) => o.packId === 'pack-chem')).toMatchObject({
      status: 'searched',
      reason: null
    })
  })

  it('allocateCandidates admits round-robin in pack order, reclaims short packs and is completion-order independent', () => {
    const candidate = (packId: string, i: number): ExternalCandidate => ({
      chunkId: `zim:${packId}:A#${i}`,
      documentId: `zim:${packId}`,
      text: `${packId} chunk ${i}`,
      sourceTitle: 'A',
      pageNumber: null,
      sectionLabel: null,
      score: 1,
      sourceKind: 'archive',
      packId,
      archiveTitle: packId,
      articlePath: 'A'
    })
    const list = (packId: string, n: number): PackCandidateList => ({
      packId,
      candidates: Array.from({ length: n }, (_, i) => candidate(packId, i))
    })
    const shares = (input: PackCandidateList[]): number[] => {
      const { admitted, admittedPerPack } = allocateCandidates(input)
      expect(admitted.length).toBeLessThanOrEqual(MAX_EXTERNAL_CANDIDATES)
      // Every admitted candidate is counted exactly once, and the counts sum to the whole set.
      expect([...admittedPerPack.values()].reduce((a, b) => a + b, 0)).toBe(admitted.length)
      return input.map((p) => admittedPerPack.get(p.packId) ?? 0)
    }

    // N = 1: one pack takes the whole budget, and never more than it.
    expect(shares([list('p0', 40)])).toEqual([MAX_EXTERNAL_CANDIDATES])
    expect(shares([list('p0', 5)])).toEqual([5])

    // N = 3 / 7 / 12, every pack long: exactly the quota arithmetic
    // `floor(24/N) + (i < 24 mod N)`, in PACK ORDER.
    for (const n of [3, 7, 12]) {
      const long = Array.from({ length: n }, (_, i) => list(`p${i}`, 30))
      expect(shares(long), `N = ${n}`).toEqual(
        Array.from({ length: n }, (_, i) => packQuota(i, n))
      )
      expect(allocateCandidates(long).admitted).toHaveLength(MAX_EXTERNAL_CANDIDATES)
    }

    // Short / empty / long mixed: the short and empty packs' slots are RECLAIMED by the long
    // ones — the pre-P4 arm instead let the first pack eat the budget before the third was
    // even searched (finding M8).
    const mixed = [list('short', 2), list('empty', 0), list('long-a', 30), list('long-b', 30)]
    const mixedShares = shares(mixed)
    expect(mixedShares[0]).toBe(2)
    expect(mixedShares[1]).toBe(0)
    expect(mixedShares[2]! + mixedShares[3]!).toBe(MAX_EXTERNAL_CANDIDATES - 2)
    expect(Math.abs(mixedShares[2]! - mixedShares[3]!)).toBeLessThanOrEqual(1)

    // Within one pack, its own rank order is preserved…
    const admittedOfLongA = allocateCandidates(mixed).admitted.filter((c) => c.packId === 'long-a')
    expect(admittedOfLongA.map((c) => c.chunkId)).toEqual(
      admittedOfLongA.map((_, i) => `zim:long-a:A#${i}`)
    )
    // …and a pack's FIRST candidate is admitted before any pack's second — the "a late pack's
    // best hit still reaches the reranker" property, which holds because admission happens
    // only after every pack settled.
    const firstRound = allocateCandidates(mixed).admitted.slice(0, 3)
    expect(firstRound.map((c) => c.packId)).toEqual(['short', 'long-a', 'long-b'])

    // COMPLETION-ORDER INDEPENDENCE: the same packs handed in the same PACK order always
    // produce the same admitted list, whatever order they finished in — the function reads a
    // list keyed by pack order and nothing else.
    const settleOrderA = allocateCandidates(mixed).admitted.map((c) => c.chunkId)
    const shuffled = [mixed[2]!, mixed[0]!, mixed[3]!, mixed[1]!]
    const byPackOrderAgain = [shuffled[1]!, shuffled[3]!, shuffled[0]!, shuffled[2]!]
    expect(allocateCandidates(byPackOrderAgain).admitted.map((c) => c.chunkId)).toEqual(settleOrderA)
    // A different PACK order is a different (still fair) result — order is the caller's
    // contract (`retrievablePacks`' `title COLLATE NOCASE, id`), not an accident of timing.
    expect(allocateCandidates(shuffled).admitted.map((c) => c.chunkId)).not.toEqual(settleOrderA)

    expect(allocateCandidates([])).toEqual({ admitted: [], admittedPerPack: new Map() })
  })
})

describe('queryTerms / overlapScore', () => {
  it('extracts distinct unicode terms and counts containment', () => {
    const terms = queryTerms('Zu was wird Treibhausgas, Treibhausgas und CO2?')
    expect(terms).toContain('treibhausgas')
    expect(terms).toContain('co2')
    expect(terms).not.toContain('zu') // <3 chars dropped
    expect(terms.filter((t) => t === 'treibhausgas')).toHaveLength(1) // distinct
    expect(overlapScore('Treibhausgas aus CO2-Quellen', terms)).toBe(2)
    expect(overlapScore('nichts davon', terms)).toBe(0)
  })
})

// ---- the retrieve() seam ----------------------------------------------------------

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-zim-arm-')), 'test.sqlite'))
}

async function seedDocument(db: Db, embedder: MockEmbedder, title: string, texts: string[]): Promise<void> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const vectors = await embedder.embed(texts)
  for (let i = 0; i < texts.length; i++) {
    const chunkId = randomUUID()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(chunkId, docId, i, texts[i], title, texts[i].split(/\s+/).length, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
  }
}

function archiveCandidate(n: number, text: string) {
  return {
    chunkId: `zim:pack-1:Artikel#${n}`,
    documentId: 'zim:pack-1',
    text,
    sourceTitle: 'Artikel',
    pageNumber: null,
    sectionLabel: 'Abschnitt',
    score: 1,
    sourceKind: 'archive' as const,
    packId: 'pack-1',
    archiveTitle: 'Wikipedia (Test)',
    articlePath: 'Artikel'
  }
}

/** The arm's result shape (#301 P4, plan §9.21 (e)3): `{ candidates, outcomes }`. These cases are
 *  about the CANDIDATE pipeline (interleave, rerank, scope, citations), so they report no outcomes
 *  — the outcome contract itself is pinned by the arm/service suites and by T16-a. */
function testArm(...candidates: Array<ReturnType<typeof archiveCandidate>>): ExternalRetrievalOutput {
  return { candidates, outcomes: [] }
}

describe('retrieve() with an external arm', () => {
  it('interleaves document and archive candidates without a reranker and builds archive citations', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'notes.txt', [
      'Treibhausgase entstehen in der Landwirtschaft.',
      'Ganz anderes Thema ohne Bezug.'
    ])
    const r = await retrieve(db, embedder, 'Treibhausgas Landwirtschaft', SETTINGS, null, null, undefined, async () =>
      testArm(
        archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'),
        archiveCandidate(1, 'Weitere Treibhausgase sind Lachgas und CO2.')
      )
    )
    const kinds = new Set(r.chunks.map((c) => c.sourceKind ?? 'document'))
    expect(kinds).toEqual(new Set(['document', 'archive']))
    // Interleave: the first archive chunk sits at position 2, not appended at the end.
    expect(r.chunks[1]?.sourceKind).toBe('archive')
    const archiveCitation = r.citations.find((c) => c.sourceKind === 'archive')
    expect(archiveCitation).toMatchObject({
      sourceTitle: 'Artikel',
      section: 'Abschnitt',
      packId: 'pack-1',
      archiveTitle: 'Wikipedia (Test)',
      articlePath: 'Artikel'
    })
    expect(archiveCitation?.documentId).toBeUndefined()
    expect(archiveCitation?.chunkId).toBeUndefined()
    const docCitation = r.citations.find((c) => c.sourceKind !== 'archive')
    expect(docCitation?.documentId).toBeTruthy()
  })

  it('lets a reranker rank archive chunks above documents on one scale', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'notes.txt', ['Ein Dokument über etwas anderes.'])
    const fakeReranker: Reranker = {
      async rerank(_q, docs) {
        // Highest score to the archive text (it contains "Methan").
        return docs.map((text, index) => ({ index, score: text.includes('Methan') ? 10 : 0 }))
      }
    } as Reranker
    const r = await retrieve(db, embedder, 'Methan', SETTINGS, null, fakeReranker, undefined, async () => testArm(archiveCandidate(0, 'Methan aus der Landwirtschaft.')))
    expect(r.chunks[0]?.sourceKind).toBe('archive')
    expect(r.chunks[0]?.label).toBe('S1')
  })

  // Re-based by P4 (#301, plan §9.21 (a)3, ruling D4) onto the EXPLICIT flag. The live-demo fix
  // (88be37ec) derived "packs only" from an empty document selection, which redefined the legacy
  // empty scope and made "all documents AND a pack" inexpressible; the ruled design is the
  // additive `documentsOff` → `RetrievalScope.noDocuments` flag that `resolveScope` sets. The
  // counter-assertion below is the rejection, pinned.
  it('a packs-only scope skips the document arms entirely (live-demo finding 2026-09-05)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // A document that WOULD match the question — it must not surface when the user turned
    // documents off (an unrelated invoice used to claim the packs-only answer's slots).
    await seedDocument(db, embedder, 'invoice.pdf', ['Treibhausgase entstehen in der Landwirtschaft.'])
    const scope = { packIds: ['pack-1'], collectionIds: null, documentIds: null, noDocuments: true as const }
    const r = await retrieve(db, embedder, 'Treibhausgas', SETTINGS, scope, null, undefined, async () =>
      testArm(archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'))
    )
    expect(r.chunks.length).toBeGreaterThan(0)
    expect(r.chunks.every((c) => c.sourceKind === 'archive')).toBe(true)
    // Counter-assertion (D4): the SAME pack selection WITHOUT the flag keeps the document arms —
    // an empty composed document scope still means the whole corpus, packs are additive.
    const additive = await retrieve(
      db,
      embedder,
      'Treibhausgas',
      SETTINGS,
      { packIds: ['pack-1'], collectionIds: null, documentIds: null },
      null,
      undefined,
      async () => testArm(archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'))
    )
    expect(additive.chunks.some((c) => c.sourceKind === 'archive')).toBe(true)
    expect(additive.chunks.some((c) => c.sourceKind !== 'archive')).toBe(true)
    // And a ticked collection alongside the flag cannot resurrect the documents either: the
    // resolved deny-all is fail-closed everywhere (a contradictory spread stays denied).
    const contradictory = await retrieve(
      db,
      embedder,
      'Treibhausgas',
      SETTINGS,
      { ...scope, collectionIds: ['some-collection'] },
      null,
      undefined,
      async () => testArm(archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'))
    )
    expect(contradictory.chunks.every((c) => c.sourceKind === 'archive')).toBe(true)
  })

  it('a throwing arm never breaks the document ask', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'notes.txt', ['Treibhausgase entstehen in der Landwirtschaft.'])
    const r = await retrieve(db, embedder, 'Treibhausgas', SETTINGS, null, null, undefined, async () => {
      throw new Error('drive unplugged')
    })
    expect(r.chunks.length).toBeGreaterThan(0)
    expect(r.chunks.every((c) => c.sourceKind !== 'archive')).toBe(true)
  })

  // L6 (PR #294 review): the original test compared two calls of the NEW code with each other, which
  // proves nothing about master. This one replays a fixed seed against a result captured from master
  // bfdb514a's retrieve() BEFORE the arm existed (tests/fixtures/zim/no-arm-retrieval-master-bfdb514a.json,
  // generated by a scratch capture run on a detached bfdb514a checkout, 2026-09-05), so the no-arm path
  // is pinned against pre-change behaviour — chunks, scores, labels, citations, deep-equal.
  it('without an arm the pipeline reproduces the pre-change master bfdb514a fixture (L6, T01/T09 no-arm baseline)', async () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), 'tests', 'fixtures', 'zim', 'no-arm-retrieval-master-bfdb514a.json'), 'utf8')
    ) as {
      now: string
      query: string
      documents: Array<{
        id: string
        title: string
        chunks: Array<{ id: string; text: string; pageNumber: number | null; sectionLabel: string | null }>
      }>
      result: unknown
    }
    const db = freshDb()
    const embedder = new MockEmbedder()
    for (const d of fixture.documents) {
      db.prepare(
        `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
      ).run(d.id, d.title, fixture.now, fixture.now)
      const vectors = await embedder.embed(d.chunks.map((c) => c.text))
      d.chunks.forEach((c, i) => {
        db.prepare(
          `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(c.id, d.id, i, c.text, d.title, c.pageNumber, c.sectionLabel, c.text.split(/s+/).length, fixture.now)
        db.prepare(
          `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(c.id, embedder.id, encodeVector(vectors[i]), vectors[i].length, fixture.now)
      })
    }
    const noArm = await retrieve(db, embedder, fixture.query, SETTINGS, null, null, undefined)
    expect(noArm.chunks.length).toBeGreaterThan(0)
    expect(noArm).toEqual(fixture.result)
    // The seam is optional in both spellings: an explicitly-absent arm is the same as none.
    const explicitlyAbsent = await retrieve(db, embedder, fixture.query, SETTINGS, null, null, undefined, null)
    expect(explicitlyAbsent).toEqual(fixture.result)
  })
})
