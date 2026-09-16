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
  CHUNKS_PER_ARTICLE,
  DISCOVERY_MAX_ADMITTED_PER_PACK,
  DISCOVERY_MAX_READS_PER_PACK,
  FTS_TOP_UNSEEN_PASS,
  HEAD_NOUN_MAX_READS,
  HEAD_NOUN_MAX_TOTAL_PROBES,
  LIST_ARTICLE_CHUNKS,
  MAX_EXTERNAL_CANDIDATES,
  PROBE_TIMEOUT_MS,
  allocateCandidates,
  chunksForScope,
  collectPackCandidates,
  overlapScore,
  packQuota,
  perArticleBudget,
  queryTerms,
  totalCandidateCapFor,
  withinReadBudget,
  type ExternalCandidate,
  type PackCandidateList
} from '../../src/main/services/zim/arm'
import type { RerankScope } from '../../src/main/services/rag/rerank-profile'
import type { SearchPlan } from '../../src/main/services/zim/expand'
import { zimArticleToSegmentsAsync } from '../../src/main/services/zim/html'
import { CHUNK_DEFAULTS, chunkSegments } from '../../src/main/services/ingestion/chunker'

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

/** F3 (review 2026-09-14) — a "…(Roman)"-titled article (title alone trips the fiction trap)
 *  with 24 neutral filler sections BEFORE a "Biologie" section carrying `explicitBiology`
 *  evidence: segment index ~25, well past the two-segment LEAD and past the old bounded
 *  20-segment window. `evidence` false omits that section entirely (nothing to rescue it). */
function romanArticleHtml(title: string, evidence: boolean): string {
  const sections: Array<[string, string]> = Array.from({ length: 24 }, (_, i) => [
    `Abschnitt ${i}`,
    `Ein neutraler Abschnitt ohne Bezug zum gesuchten Thema, Nummer ${i}.`
  ])
  if (evidence) {
    sections.push(['Biologie', 'Der Blutkreislauf wird von einem Systemherz und zwei Kiemenherzen angetrieben.'])
  }
  return articleHtml(title, sections)
}
/** N1 (second review, step 4-3) — the first review's CASE A **verbatim**: an intro (no
 *  heading, TWO paragraphs) followed by ONE section, "Kraken in der Kultur" (two more
 *  paragraphs) — exactly two segments, no biological evidence ANYWHERE (unlike
 *  `romanArticleHtml`, which always carries a rescuing "Biologie" section or omits it
 *  entirely past segment ~25). The spellings "Kopffuesser"/"praegte"/"beruehmt" are literal
 *  (not the umlaut forms): `norm()` (NFKD + strip combining marks) turns "ü"/"ß" into
 *  "u"/"ss", which would make "Kopffüßer" collide with `explicitBiology`'s "kopffusser" — the
 *  literal "ue"/"ae" spellings keep the escape hatch from firing by accident. */
function caseAArticleHtml(): string {
  return (
    '<!DOCTYPE html><html lang="de"><head><title>Kraken</title></head><body>' +
    '<h1>Kraken</h1>' +
    '<section data-mw-section-id="0">' +
    '<p>Die Kraken sind eine Ordnung der Kopffuesser.</p>' +
    '<p>Sie besitzen acht Arme und leben in allen Weltmeeren.</p>' +
    '</section>' +
    '<section data-mw-section-id="1">' +
    '<div class="mw-heading mw-heading2"><h2 id="s0">Kraken in der Kultur</h2></div>' +
    '<p>Der Spielfilm um einen Riesenkraken praegte das Bild des Tieres.</p>' +
    '<p>Ein Roman von Jules Verne machte ihn beruehmt.</p>' +
    '</section>' +
    '</body></html>'
  )
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

/** Poll until `cond()` is true or `rounds` are exhausted (real loopback I/O, never a sleep of a
 *  fixed guessed duration) — used by the mid-discovery abort legs below. */
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
/** Every `/suggest` call the fixture received (title/head-noun probes, Phase 4 PR-A). */
const suggestRequests: Array<{ content: string; term: string }> = []
const LIST_ARTICLE = 'Liste der größten Kohlekraftwerke der Erde'
/** Phase 4 PR-A discovery fixtures (`pack-plan`): a plan query, its one hit, and the plain
 *  `searchPattern` rewrite of `PLAN_QUESTION` (below) — the port's "last query" (item 3). */
const PLAN_QUERY = 'Kohlekraftwerk Konzept'
const PLAN_QUERY_HIT = 'Kraftwerk Tuoketuo'
const PLAN_QUESTION = 'Welche sind die größten Kohlekraftwerke der Welt?'
const PLAIN_PATTERN = 'größten Kohlekraftwerke Welt'
/** A list article long enough to chunk into more than `CHUNKS_PER_ARTICLE` pieces (500-token chunks). */
function listArticleHtml(): string {
  const row = (n: number): string =>
    `Kraftwerk Nummer ${n} steht in einem Land mit vielen Kohlevorkommen und liefert ` +
    'elektrische Energie fuer eine grosse Region mit mehreren Millionen Einwohnern, die ' +
    'ueberwiegend in Staedten und Industriegebieten leben und deren Bedarf stetig waechst. '
  const sections: Array<[string, string]> = []
  for (let sIdx = 0; sIdx < 8; sIdx++) {
    let text = ''
    for (let r = 0; r < 12; r++) text += row(sIdx * 12 + r + 1)
    sections.push([`Rang ${sIdx * 12 + 1} bis ${sIdx * 12 + 12}`, text])
  }
  return articleHtml(LIST_ARTICLE, sections)
}

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
      searchPatterns.push(pattern)
      // Phase 4 PR-A — the plan's own FTS queries (route F's `discover()`), keyed by book and
      // exact query string: the plain PATTERN rewrite always runs last (item 3 of the port).
      if (book === 'pack-plan') {
        const titles =
          pattern === PLAN_QUERY
            ? [PLAN_QUERY_HIT]
            : pattern === PLAIN_PATTERN
              ? ['Kohlekraftwerk', 'Kohleausstieg']
              : []
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, titles))
        return
      }
      // F2 (review 2026-09-14) — the #340 L3 zero-hit length retry: the FULL pattern finds
      // nothing, the narrower `retry` pattern (kept terms of 5+ chars only) finds one hit.
      if (book === 'pack-f2-retry') {
        const titles = pattern === 'Kohleausstieg' ? ['Kohleausstieg'] : []
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, titles))
        return
      }
      // F3 integration fixture, PROBE_TIMEOUT_MS fixture — isolate to the plan-title route.
      if (book === 'pack-f3' || book === 'pack-slow-probe') {
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, []))
        return
      }
      // FTS never finds anything for this book — isolates the head-noun route (below).
      if (book === 'pack-headnoun' || book === 'pack-headnoun2' || book === 'pack-headnoun3') {
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(searchXml(`book-${book}`, []))
        return
      }
      // The read-budget legs feed candidates ONLY through plan titles (`/suggest`); FTS stays
      // empty so it never contributes an extra read.
      if (book === 'pack-budget-reads' || book === 'pack-budget-admit') {
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
              : ['Schwefel']
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(searchXml(`book-${book}`, titles))
      return
    }
    // The title index (`/suggest`) — the real kiwix-serve shape (`value`, an HTML-bolded
    // `label`, `kind: "path"`, the entry `path`), plus the synthetic `kind: "pattern"` row the
    // capability probe reads, which every discovery caller here skips by construction (they
    // only ever look at `kind: "path"` rows, `client.ts` `suggestTitles`).
    if (url.pathname === '/suggest') {
      const content = url.searchParams.get('content') ?? ''
      const term = url.searchParams.get('term') ?? ''
      suggestRequests.push({ content, term })
      // Phase 4 PR-A STAGE 2 — a plan title, exact match.
      if (content === 'book-pack-plan' && term === LIST_ARTICLE) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: LIST_ARTICLE, kind: 'path', path: LIST_ARTICLE.replace(/ /g, '_') }]))
        return
      }
      // A plan title whose OWN suggest lookup errors — costs only that title, never the pack.
      if (content === 'book-pack-plan' && term === 'Liste kaputt') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      // A multi-word plan title whose rank-0 /suggest hit is a COMPLETELY unrelated article —
      // route F's own predicate (`multiWord && hidx===0`) admits it anyway, byte-identical.
      if (content === 'book-pack-plan' && term === 'Ganz Anderes Thema') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: 'Voll Unrelated Artikel', kind: 'path', path: 'Voll_Unrelated_Artikel' }]))
        return
      }
      // Phase 4 PR-A STAGE 1 — the head-noun rule's candidates (see the arm test below: the
      // LONGEST matching suffix wins, so "Bikes" -> "Bik", not "Bike").
      if (content === 'book-pack-headnoun' && (term === 'Testo' || term === 'Bik')) {
        const article = term === 'Testo' ? 'Testo' : 'Bik'
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: article, kind: 'path', path: article }]))
        return
      }
      // A head-noun NEAR MISS — a real /suggest hit exists but is not an exact match, so
      // `resolveHeadNoun` does not accept it. Used to prove head-noun hits never enter the
      // aggregate score pool (unlike title/FTS hits): if they did, this hit would surface via
      // a later top-2-unseen pass even though it was never accepted.
      if (content === 'book-pack-headnoun2' && term === 'Obje') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: 'Objekte (Begriff)', kind: 'path', path: 'Objekte_(Begriff)' }]))
        return
      }
      // F4 (review 2026-09-14) — ACCEPTED but never ADMITTED: 'Ersto' and 'Zweito' both confirm
      // EXACTLY via /suggest (so resolveHeadNoun accepts them), but their /raw reads 404 below.
      // 'Dritto' would confirm too, but must never even be probed once the budget is spent.
      if (content === 'book-pack-headnoun3' && (term === 'Ersto' || term === 'Zweito' || term === 'Dritto')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: term, kind: 'path', path: term }]))
        return
      }
      // Phase 4 PR-A read-budget legs — every `T<n>` candidate resolves via `/suggest`.
      if ((content === 'book-pack-budget-reads' || content === 'book-pack-budget-admit') && /^T\d+$/.test(term)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: term, kind: 'path', path: term }]))
        return
      }
      // Phase 4 PR-A read-budget legs — every `T<n>` candidate resolves via `/suggest`.
      if ((content === 'book-pack-budget-reads' || content === 'book-pack-budget-admit') && /^T\d+$/.test(term)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: term, kind: 'path', path: term }]))
        return
      }
      // F3 integration fixture (review 2026-09-14, test gap 2) — two "…(Roman)" plan titles,
      // both exact-match their own /suggest term. N1 (step 4-3) adds a third: "Kraken" itself
      // (the CASE A shape, no "(Roman)" title suffix).
      if (
        content === 'book-pack-f3' &&
        (term === 'Kraken (Roman)' || term === 'Tintenfisch (Roman)' || term === 'Kraken')
      ) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([{ value: term, kind: 'path', path: term.replace(/ /g, '_') }]))
        return
      }
      // PROBE_TIMEOUT_MS behavioural test (review 2026-09-14, test gap 3): a /suggest response
      // held well past any sane probe bound. A real answer eventually arrives (so a caller that
      // does NOT respect the `probeTimeoutMs` seam would still pass, slowly) — the seam is what
      // proves the client gives up at ITS bound rather than the server's.
      if (content === 'book-pack-slow-probe' && term === 'Verzoegert') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify([{ value: 'Verzoegert', kind: 'path', path: 'Verzoegert' }]))
        }, 2_000)
        return
      }
      res.writeHead(404)
      res.end()
      return
    }
    if (url.pathname.startsWith('/raw/')) {
      const servedName = url.pathname.split('/')[2] ?? ''
      const article = decodeURIComponent(url.pathname.split('/content/')[1] ?? '').replace(/_/g, ' ')
      rawReads.push(article)
      // Phase 4 PR-A read-budget legs: 'pack-budget-reads' 404s every `T<n>` (found via
      // `/suggest`, vanished at fetch — nothing is ever admitted, so the READ cap is what stops
      // it); 'pack-budget-admit' serves them all, so the ADMITTED cap stops it instead.
      if (servedName === 'book-pack-budget-reads' && /^T\d+$/.test(article)) {
        res.writeHead(404)
        res.end()
        return
      }
      // #339 D-Z22: every article request now carries `Range: bytes=<n>-`; libkiwix answers it
      // `206` + `Content-Range` + the tail, and so does this fake — so the stall leg below
      // exercises the RESUME path rather than a whole re-read.
      const rangeFrom = ((): number | null => {
        const h = req.headers.range
        if (typeof h !== 'string') return null
        const m = /^bytes=(\d+)-$/.exec(h.trim())
        return m ? Number(m[1]) : null
      })()
      const sendArticle = (html: string): void => {
        const buf = Buffer.from(html, 'utf8')
        if (rangeFrom === null || rangeFrom >= buf.length) {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(buf)
          return
        }
        const tail = buf.subarray(rangeFrom)
        res.writeHead(206, {
          'content-type': 'text/html',
          'content-length': String(tail.length),
          'content-range': `bytes ${rangeFrom}-${buf.length - 1}/${buf.length}`
        })
        res.end(tail)
      }
      if (article === LIST_ARTICLE) {
        sendArticle(listArticleHtml())
        return
      }
      // One article whose fetch fails: the arm must skip THAT HIT and keep the others.
      if (article === 'Kaputt') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      // F4 (review 2026-09-14): 'Ersto' and 'Zweito' both confirm EXACTLY via /suggest (an
      // ACCEPTED head-noun candidate) but vanish at fetch time — never ADMITTED.
      if (article === 'Ersto' || article === 'Zweito') {
        res.writeHead(404)
        res.end()
        return
      }
      // F3 integration fixture (test gap 2): the biological evidence sits in the LAST section,
      // segment index ~25 — well past the two-segment LEAD and the old bounded 20-segment window.
      if (article === 'Kraken (Roman)') {
        sendArticle(romanArticleHtml(article, true))
        return
      }
      if (article === 'Tintenfisch (Roman)') {
        sendArticle(romanArticleHtml(article, false))
        return
      }
      // N1 (second review, step 4-3) — the CASE A shape itself: two segments, no biological
      // evidence anywhere, driven through the arm's REAL leadText/wideText construction.
      if (article === 'Kraken') {
        sendArticle(caseAArticleHtml())
        return
      }
      // One article big enough to need several converter slices (P1b), so an ask that is
      // cancelled while it converts has something to be cancelled during.
      if (article === 'Grossartikel') {
        sendArticle(bigArticleHtml())
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
        const total = Buffer.byteLength(body)
        res.writeHead(rangeFrom === null ? 200 : 206, {
          'content-type': 'text/html',
          'content-length': String(total),
          ...(rangeFrom === null
            ? {}
            : { 'content-range': `bytes ${rangeFrom}-${total - 1}/${total}` })
        })
        res.write(body.slice(0, Math.floor(body.length * 0.85)))
        return
      }
      sendArticle(body)
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
  // word) — the plain pattern rewrite is still what a plan-less ask sends.
  it('sends the plain pattern rewrite to /search when no plan is supplied', async () => {
    searchPatterns.length = 0
    const climate = await collectPackCandidates(
      port,
      [{ id: 'pack-climate', title: 'Klima' }],
      'Welche Rolle spielt das Treibhausgas beim Treibhauspotential?'
    )
    expect(searchPatterns).toEqual(['Treibhausgas Treibhauspotential'])
    expect(climate.candidates.length).toBeGreaterThan(0)
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

// Step 4-4 (Wave 4 ruling (a), Phase 2 ruling (d)) — the candidate SCOPE per hardware profile.
// `perArticleBudget`/`totalCandidateCapFor`/`chunksForScope` are the pure widening
// `rag/rerank-profile.ts`'s `rerankScopeFor` selects between; `capped`'s own numbers are pinned
// above (every pre-existing `collectPackCandidates`/`allocateCandidates`/`packQuota` test in this
// file calls them with NO scope/cap argument and stays green, unmodified — the regression pin
// ruling (a) asks for).
describe('candidate scope (step 4-4)', () => {
  const SCOPES: RerankScope[] = ['capped', 'top48', 'top96', 'all']

  it('perArticleBudget doubles/quadruples the per-article slice; totalCandidateCapFor the pack-quota cap; all is unbounded', () => {
    expect(perArticleBudget('capped', false)).toBe(CHUNKS_PER_ARTICLE)
    expect(perArticleBudget('capped', true)).toBe(LIST_ARTICLE_CHUNKS)
    expect(perArticleBudget('top48', false)).toBe(CHUNKS_PER_ARTICLE * 2)
    expect(perArticleBudget('top48', true)).toBe(LIST_ARTICLE_CHUNKS * 2)
    expect(perArticleBudget('top96', false)).toBe(CHUNKS_PER_ARTICLE * 4)
    expect(perArticleBudget('top96', true)).toBe(LIST_ARTICLE_CHUNKS * 4)
    expect(perArticleBudget('all', false)).toBe(Number.POSITIVE_INFINITY)
    expect(perArticleBudget('all', true)).toBe(Number.POSITIVE_INFINITY)

    expect(totalCandidateCapFor('capped')).toBe(MAX_EXTERNAL_CANDIDATES)
    expect(totalCandidateCapFor('top48')).toBe(MAX_EXTERNAL_CANDIDATES * 2)
    expect(totalCandidateCapFor('top96')).toBe(MAX_EXTERNAL_CANDIDATES * 4)
    expect(totalCandidateCapFor('all')).toBe(Number.POSITIVE_INFINITY)
  })

  it('chunksForScope orders overlap-desc/index-asc and slices to the per-article budget, for a non-list article', () => {
    // 50 synthetic chunks, DEscending index so overlap-desc/index-asc tie-break order is provable.
    const chunks = Array.from({ length: 50 }, (_, i) => ({ index: i, overlap: 50 - i, text: `c${i}` }))
    for (const scope of SCOPES) {
      const picked = chunksForScope(chunks, scope, false)
      expect(picked.length).toBe(Math.min(chunks.length, perArticleBudget(scope, false)))
      // Overlap-desc: chunk 0 (overlap 50, the highest) is always first when anything is picked.
      expect(picked[0]!.index).toBe(0)
      // Every picked chunk's overlap is >= every NOT-picked chunk's overlap (a true top-N slice).
      const pickedIdx = new Set(picked.map((c) => c.index))
      const minPickedOverlap = Math.min(...picked.map((c) => c.overlap))
      for (const c of chunks) {
        if (!pickedIdx.has(c.index)) expect(c.overlap).toBeLessThanOrEqual(minPickedOverlap)
      }
    }
  })

  it('the superset property: capped ⊆ top48 ⊆ top96 ⊆ all, by chunk index, for both a normal and a list article (fixed overlaps, including ties)', () => {
    // B10 (scoped Opus review, step 4-4): FIXED, hand-written overlaps — including genuine ties
    // (the case `index asc` tie-breaking exists for, which `Math.random()` essentially never
    // produces) — so this fixture is reproducible and a failure is re-runnable. Overlap pattern:
    // a strictly-descending run (0..29 tied in pairs: 39,39,38,38,...) then a flat tail of zeros,
    // so every scope's cut point lands inside a tie at least once.
    const chunks = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      overlap: i < 30 ? 39 - Math.floor(i / 2) : 0, // pairs tie: (0,1)->39, (2,3)->38, ...; 30..39 -> 0
      text: `c${i}`
    }))
    for (const isList of [false, true]) {
      const byScope = new Map(SCOPES.map((s) => [s, new Set(chunksForScope(chunks, s, isList).map((c) => c.index))]))
      const capped = byScope.get('capped')!
      const top48 = byScope.get('top48')!
      const top96 = byScope.get('top96')!
      const all = byScope.get('all')!
      for (const i of capped) expect(top48.has(i)).toBe(true)
      for (const i of top48) expect(top96.has(i)).toBe(true)
      for (const i of top96) expect(all.has(i)).toBe(true)
      expect(all.size).toBe(chunks.length) // all = every chunk, nothing dropped
      // A tie is genuinely exercised: index-asc must have been the tie-break, not incidental.
      expect(new Set(chunks.map((c) => c.overlap)).size).toBeLessThan(chunks.length)
    }
  })

  // B10 (scoped Opus review, step 4-4): the property above is pinned only at the `chunksForScope`
  // level, where it is near-tautological (every scope is a prefix of the same total order). The
  // layer where it could actually break is the COMPOSITION `collectPackCandidates` performs: the
  // article loop's `if (item.candidates.length >= item.quota) break` (arm.ts), the per-pack
  // `packQuota(i, N, cap)` (NOT uniformly doubling — e.g. at N=5, pack 3 gets 5 under `capped`
  // and 9, not 10, under `top48`), and `allocateCandidates`'s round-robin reclaim. This test
  // replicates that composition, verbatim, over two FIXED multi-pack/multi-article fixtures (one
  // with a list article) using the branch's own exported `chunksForScope`/`packQuota`/
  // `allocateCandidates` — never a re-implementation of the picker — and asserts the superset
  // property on the ADMITTED output, not just the per-article slice.
  function composeAdmitted(
    packsArticles: ReadonlyArray<ReadonlyArray<{ isList: boolean; chunks: Array<{ index: number; overlap: number }> }>>,
    scope: RerankScope
  ): Set<string> {
    const cap = totalCandidateCapFor(scope)
    const perPack = packsArticles.map((articles, packIdx) => {
      const quota = packQuota(packIdx, packsArticles.length, cap)
      const candidates: ExternalCandidate[] = []
      for (const [articleIdx, article] of articles.entries()) {
        if (candidates.length >= quota) break
        const picked = chunksForScope(article.chunks, scope, article.isList)
        for (const c of picked) {
          candidates.push({ ...archiveCandidate(0, ''), chunkId: `p${packIdx}:a${articleIdx}:c${c.index}` })
        }
      }
      return { packId: `p${packIdx}`, candidates }
    })
    const { admitted } = allocateCandidates(perPack, cap)
    return new Set(admitted.map((c) => c.chunkId))
  }

  it('the superset property holds on the COMPOSED admission output (packQuota + the article loop + allocateCandidates), not only the per-article slice', () => {
    const tiedChunks = (n: number): Array<{ index: number; overlap: number }> =>
      Array.from({ length: n }, (_, i) => ({ index: i, overlap: Math.floor((n - i) / 2) })) // ties every pair
    const fixtures: Array<ReadonlyArray<ReadonlyArray<{ isList: boolean; chunks: Array<{ index: number; overlap: number }> }>>> = [
      // Fixture 1: 3 packs, uneven article counts, one list article, tied overlaps.
      [
        [{ isList: false, chunks: tiedChunks(20) }, { isList: true, chunks: tiedChunks(30) }],
        [{ isList: false, chunks: tiedChunks(10) }],
        [{ isList: false, chunks: tiedChunks(50) }, { isList: false, chunks: tiedChunks(6) }, { isList: false, chunks: tiedChunks(6) }]
      ],
      // Fixture 2: 5 packs (packQuota's "+1 for the first `cap mod N`" term actually fires),
      // each with one small article — the case B10 names explicitly (N=5, cap doubling is not
      // uniform: floor(24/5)=4 r4 under capped, floor(48/5)=9 r3 under top48).
      Array.from({ length: 5 }, () => [{ isList: false, chunks: tiedChunks(12) }])
    ]
    for (const packsArticles of fixtures) {
      const byScope = new Map(SCOPES.map((s) => [s, composeAdmitted(packsArticles, s)]))
      const capped = byScope.get('capped')!
      const top48 = byScope.get('top48')!
      const top96 = byScope.get('top96')!
      const all = byScope.get('all')!
      for (const id of capped) expect(top48.has(id)).toBe(true)
      for (const id of top48) expect(top96.has(id)).toBe(true)
      for (const id of top96) expect(all.has(id)).toBe(true)
    }
  })

  it('packQuota/allocateCandidates with an explicit cap match totalCandidateCapFor for a wider scope, and default to MAX_EXTERNAL_CANDIDATES unchanged', () => {
    const n = 3
    // Byte-identical to the no-cap-argument call (the regression pin): default cap === MAX_EXTERNAL_CANDIDATES.
    const defaultQuotas = Array.from({ length: n }, (_, i) => packQuota(i, n))
    const cappedQuotas = Array.from({ length: n }, (_, i) => packQuota(i, n, totalCandidateCapFor('capped')))
    expect(cappedQuotas).toEqual(defaultQuotas)
    expect(cappedQuotas.reduce((a, b) => a + b, 0)).toBe(MAX_EXTERNAL_CANDIDATES)

    const top48Cap = totalCandidateCapFor('top48')
    const top48Quotas = Array.from({ length: n }, (_, i) => packQuota(i, n, top48Cap))
    expect(top48Quotas.reduce((a, b) => a + b, 0)).toBe(top48Cap)
    expect(top48Cap).toBe(MAX_EXTERNAL_CANDIDATES * 2)

    // allocateCandidates admits up to the cap when every pack has enough candidates, for 'all' too.
    const longPacks = Array.from({ length: n }, (_, i) => ({
      packId: `p${i}`,
      candidates: Array.from({ length: 100 }, (_, j) => archiveCandidate(j, `pack ${i} chunk ${j}`))
    }))
    expect(allocateCandidates(longPacks, totalCandidateCapFor('all')).admitted).toHaveLength(300)
    expect(allocateCandidates(longPacks, totalCandidateCapFor('capped')).admitted).toHaveLength(MAX_EXTERNAL_CANDIDATES)
  })

  // B11 (scoped Opus review, step 4-4): the test this replaces was titled after a
  // reranker-availability contract but its body (`perArticleBudget('capped', false) <
  // perArticleBudget('top48', false)`) checked neither `rerankerAvailable` nor `collectPackCandidates`
  // — it would pass on an implementation that ignored `rerankerAvailable` entirely. That real
  // contract IS pinned, in `rerank-profile.test.ts`'s "rerankerAvailable false -> capped on every
  // profile" case (`rerankScopeFor` refuses a wide scope with no reranker BEFORE reading the
  // profile). What THIS file can meaningfully pin instead is `collectPackCandidates`'s own
  // absent-option default: that omitting `candidateScope` really does mean `'capped'`, not a
  // scope that silently drifted.
  it('collectPackCandidates with no candidateScope option is byte-identical to an explicit candidateScope: "capped" (the absent-option default really is capped)', async () => {
    const packs = [{ id: 'pack-climate', title: 'Klimawandel von Wikipedia' }]
    const question = 'Wie entsteht Treibhausgas in der Landwirtschaft?'
    const { candidates: implicit } = await collectPackCandidates(port, packs, question)
    const { candidates: explicit } = await collectPackCandidates(port, packs, question, undefined, undefined, {
      candidateScope: 'capped'
    })
    expect(implicit.map((c) => c.chunkId)).toEqual(explicit.map((c) => c.chunkId))
  })

  it('end to end: candidateScope "all" yields EVERY chunk of an admitted list article, not just its capped slice', async () => {
    // Reuses the pack-plan fixture (`describe('collectPackCandidates — Phase 4 PR-A discovery
    // port')` above): a plan whose title is the LIST_ARTICLE, chunked to more than
    // LIST_ARTICLE_CHUNKS pieces (asserted there: `outcomes[0].found > LIST_ARTICLE_CHUNKS`).
    const packs = [{ id: 'pack-plan', title: 'Kraftwerke von Wikipedia' }]
    const names = new Map([['pack-plan', 'book-pack-plan']])
    const PLAN: SearchPlan = { titles: [LIST_ARTICLE], queries: [PLAN_QUERY] }
    const expand = async (): Promise<SearchPlan> => PLAN

    // The independently-computed full chunk count of the list article, via the SAME chunker the
    // arm uses — never a re-implementation of `collectPackCandidates`'s own count.
    const article = await zimArticleToSegmentsAsync(listArticleHtml())
    const totalListChunks = chunkSegments(article.segments, CHUNK_DEFAULTS).length
    expect(totalListChunks).toBeGreaterThan(LIST_ARTICLE_CHUNKS) // the fixture's own premise

    const { candidates: capped } = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names, { expand })
    const cappedList = capped.filter((c) => c.sourceTitle === LIST_ARTICLE)
    expect(cappedList.length).toBe(LIST_ARTICLE_CHUNKS) // "with no option yields today's list"

    const { candidates: all } = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names, {
      expand,
      candidateScope: 'all'
    })
    const allList = all.filter((c) => c.sourceTitle === LIST_ARTICLE)
    expect(allList.length).toBe(totalListChunks) // "yields every chunk of the admitted article"
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

// ---- Phase 4 PR-A: route F's discovery semantics (`docs/rag-design.md` §17 "Discovery port") --
describe('collectPackCandidates — Phase 4 PR-A discovery port', () => {
  const reset = (): void => {
    rawReads.length = 0
    suggestRequests.length = 0
    searchPatterns.length = 0
  }
  const emptyPlan = (): SearchPlan => ({ titles: [], queries: [] })

  describe('the planner (search plan)', () => {
    const packs = [{ id: 'pack-plan', title: 'Kraftwerke von Wikipedia' }]
    const names = new Map([['pack-plan', 'book-pack-plan']])
    const PLAN: SearchPlan = { titles: [LIST_ARTICLE], queries: [PLAN_QUERY] }

    it('the plan runs ONCE per ask; its title (via /suggest, exact match) and query hits are read, plus the plain pattern rewrite LAST; a list article keeps more chunks', async () => {
      reset()
      let calls = 0
      const expand = async (q: string): Promise<SearchPlan> => {
        calls++
        expect(q).toBe(PLAN_QUESTION)
        return PLAN
      }
      const { candidates, outcomes } = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names, { expand })
      expect(calls).toBe(1)
      // (The head-noun rule also probes this question's "Kohlekraftwerke" — its OWN describe
      // block below covers that route; here only the plan title's own lookup matters.)
      expect(suggestRequests).toContainEqual({ content: 'book-pack-plan', term: LIST_ARTICLE })
      expect(searchPatterns).toEqual([PLAN_QUERY, PLAIN_PATTERN])
      // Item 2 (title): the plan title is read FIRST. Item 3 (FTS): the plan's own query's
      // rank-1 hit, then the plain pattern's rank-1 hit, then the one remaining unseen
      // candidate by aggregate score ("both top-2 passes kept").
      expect(rawReads).toEqual([LIST_ARTICLE, PLAN_QUERY_HIT, 'Kohlekraftwerk', 'Kohleausstieg'])
      const list = candidates.filter((c) => c.sourceTitle === LIST_ARTICLE)
      expect(list.length).toBe(LIST_ARTICLE_CHUNKS)
      expect(candidates.filter((c) => c.sourceTitle === 'Kohlekraftwerk').length).toBeLessThanOrEqual(CHUNKS_PER_ARTICLE)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({ packId: 'pack-plan', status: 'searched', reason: null })
      expect(outcomes[0]!.found).toBeGreaterThan(LIST_ARTICLE_CHUNKS)
    })

    it('a null plan, a throwing planner and no planner at all produce the SAME discovery — no /suggest, only the plain pattern', async () => {
      reset()
      const none = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names)
      expect(rawReads).toEqual(['Kohlekraftwerk', 'Kohleausstieg'])
      // No PLAN title lookup (there is no plan) — the head-noun rule still probes this
      // question's own capitalised nouns (its own describe block below), so this checks for
      // the ABSENCE of a title-shaped ("Liste …") lookup specifically, not of every /suggest call.
      expect(suggestRequests.some((r) => r.content === 'book-pack-plan' && r.term.startsWith('Liste'))).toBe(false)
      expect(searchPatterns).toEqual([PLAIN_PATTERN])
      reset()
      const nulled = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names, { expand: async () => null })
      expect(rawReads).toEqual(['Kohlekraftwerk', 'Kohleausstieg'])
      expect(nulled.candidates.map((c) => c.chunkId)).toEqual(none.candidates.map((c) => c.chunkId))
      reset()
      const threw = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names, {
        expand: async () => {
          throw new Error('runtime exploded')
        }
      })
      expect(threw.candidates.map((c) => c.chunkId)).toEqual(none.candidates.map((c) => c.chunkId))
    })

    it('the ask cancelled while the planner runs REJECTS with the abort — nothing is searched, never an empty list', async () => {
      reset()
      const ctrl = new AbortController()
      const expand = async (_q: string, signal?: AbortSignal): Promise<null> => {
        ctrl.abort()
        const err = new Error('cancelled')
        err.name = 'AbortError'
        expect(signal?.aborted).toBe(true)
        throw err
      }
      await expect(
        collectPackCandidates(port, packs, PLAN_QUESTION, ctrl.signal, names, { expand })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(searchPatterns).toEqual([])
      expect(rawReads).toEqual([])
    })

    it('a failing title suggest costs only that title — the FTS routes still run', async () => {
      reset()
      const { candidates } = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names, {
        expand: async () => ({ titles: ['Liste kaputt'], queries: [PLAN_QUERY] })
      })
      expect(suggestRequests).toContainEqual({ content: 'book-pack-plan', term: 'Liste kaputt' })
      expect(rawReads).toEqual([PLAN_QUERY_HIT, 'Kohlekraftwerk', 'Kohleausstieg'])
      expect(candidates.some((c) => c.sourceTitle === PLAN_QUERY_HIT)).toBe(true)
    })

    it('without a served name the title index is not asked — FTS alone still runs', async () => {
      reset()
      await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, undefined, { expand: async () => PLAN })
      expect(suggestRequests).toEqual([])
      expect(rawReads).toEqual([PLAN_QUERY_HIT, 'Kohlekraftwerk', 'Kohleausstieg'])
    })

    // Orchestrator verification finding, ruled PLAUSIBLE-NOT-A-DEFECT: for a MULTI-WORD plan
    // title, `discover()`'s own admission predicate treats the rank-0 `/suggest` hit as a match
    // UNCONDITIONALLY (`title.includes(' ') && hidx === 0`), regardless of how similar the hit
    // actually is to the title asked for — byte-identical to `prototype.mjs`'s own condition.
    // Kept as ported (fidelity to the measured harness is the brief's criterion, not a design
    // preference introduced here); this test pins the behaviour explicitly rather than leaving
    // it implicit. See report.md "Open questions for the next step" — PR-B's review should
    // decide whether this is worth tightening, given the downstream `admit.ts` gate only
    // screens for topic-conflict, never for "is this actually the right article".
    it('a multi-word plan title admits its rank-0 /suggest hit even when the hit is a COMPLETELY unrelated article (route F\'s own predicate, ported byte-identical)', async () => {
      reset()
      const { candidates } = await collectPackCandidates(port, packs, PLAN_QUESTION, undefined, names, {
        expand: async () => ({ titles: ['Ganz Anderes Thema'], queries: [] })
      })
      expect(suggestRequests).toContainEqual({ content: 'book-pack-plan', term: 'Ganz Anderes Thema' })
      expect(rawReads).toContain('Voll Unrelated Artikel')
      expect(candidates.some((c) => c.sourceTitle === 'Voll Unrelated Artikel')).toBe(true)
    })

    it('the per-ask DEADLINE elapsing during the planner call is an outcome, never a cancellation — every pack settles deadline, nothing is searched', async () => {
      reset()
      const deadline = new AbortController()
      const ask = new AbortController() // the ask itself is NOT cancelled
      const expand = async (_q: string, signal?: AbortSignal): Promise<null> => {
        deadline.abort() // the arm's combined deadline fires while the model is still thinking
        expect(signal?.aborted).toBe(true)
        const err = new Error('deadline')
        err.name = 'AbortError'
        throw err
      }
      const { candidates, outcomes } = await collectPackCandidates(
        port,
        [...packs, { id: 'pack-climate', title: 'Klimawandel' }],
        PLAN_QUESTION,
        deadline.signal,
        names,
        { expand, askSignal: ask.signal }
      )
      expect(candidates).toEqual([])
      expect(outcomes.map((o) => [o.packId, o.status, o.reason])).toEqual([
        ['pack-plan', 'skipped', 'deadline'],
        ['pack-climate', 'skipped', 'deadline']
      ])
      expect(searchPatterns).toEqual([])
      expect(rawReads).toEqual([])
    })
  })

  // F2 (review 2026-09-14): the #340 L3 zero-hit length retry, restored — master's own trigger
  // (`arm.ts:340` on master), gated to the PATTERN query only and only on a genuine zero-hit
  // search, never run on every ask. `zim-regressions.test.ts` T15's `emptySearches` leg (and the
  // `sends the plain pattern rewrite` test above) both use questions whose `rewrite.retry` is
  // null by construction (every kept term is already >= 5 chars) — this is the leg where it
  // isn't, so the retry actually fires.
  describe('the zero-hit length retry (F2)', () => {
    it('retries once with the narrower `retry` pattern when the full pattern finds nothing, and reads what it finds', async () => {
      reset()
      const packs = [{ id: 'pack-f2-retry', title: 'Energie von Wikipedia' }]
      const { candidates } = await collectPackCandidates(
        port,
        packs,
        'Was ist Kohleausstieg und Erde?', // pattern: "Kohleausstieg Erde"; retry: "Kohleausstieg"
        undefined,
        undefined,
        { expand: async () => ({ titles: [], queries: [] }) }
      )
      expect(searchPatterns).toEqual(['Kohleausstieg Erde', 'Kohleausstieg'])
      expect(rawReads).toEqual(['Kohleausstieg'])
      expect(candidates.some((c) => c.sourceTitle === 'Kohleausstieg')).toBe(true)
    })
  })

  // F3 (review 2026-09-14, test gap 2): "nothing drives the arm's real `bodyText` construction
  // through the gate" — the CASE A/B fixtures in `zim-admit.test.ts` call `admitArticle`
  // directly with hand-built windows; this drives the REAL fetch -> segments -> arm's own
  // lead/wide construction -> `admitArticle` path end to end, through `collectPackCandidates`.
  describe('the admission gate sees the arm\'s REAL two windows (F3, end to end)', () => {
    const packs = [{ id: 'pack-f3', title: 'Meerestiere von Wikipedia' }]
    const names = new Map([['pack-f3', 'book-pack-f3']])
    const QUESTION = 'Wie funktioniert das Herz eines Oktopus?' // biology signal: "Herz" + "Oktopus"

    it('admits a "…(Roman)"-titled article (title alone trips the fiction trap) whose ONLY biological evidence sits ~25 segments deep — the wide window has no cap', async () => {
      reset()
      const { candidates, outcomes } = await collectPackCandidates(port, packs, QUESTION, undefined, names, {
        expand: async () => ({ titles: ['Kraken (Roman)'], queries: [] })
      })
      expect(rawReads).toEqual(['Kraken (Roman)'])
      expect(candidates.some((c) => c.sourceTitle === 'Kraken (Roman)')).toBe(true)
      // "admitted" here is a CHUNK count (`allocateCandidates` operates on chunk-level
      // candidates), so it is > 0 once the one admitted article contributes its chunks.
      expect(outcomes[0]).toMatchObject({ packId: 'pack-f3', status: 'searched', reason: null })
      expect(outcomes[0]!.admitted).toBeGreaterThan(0)
    })

    it('refuses the SAME fiction-flavoured shape when NO biological evidence exists anywhere in the article', async () => {
      reset()
      const { candidates, outcomes } = await collectPackCandidates(port, packs, QUESTION, undefined, names, {
        expand: async () => ({ titles: ['Tintenfisch (Roman)'], queries: [] })
      })
      expect(rawReads).toEqual(['Tintenfisch (Roman)']) // fetched, then refused by the gate
      expect(candidates).toEqual([])
      expect(outcomes[0]).toMatchObject({ packId: 'pack-f3', admitted: 0, found: 0 })
    })

    // N1 (second review): the true "no evidence anywhere" CASE A, driven through the arm's
    // REAL bodyText path (real HTML -> segments -> the arm's own leadText/wideText
    // construction -> admitArticle) rather than hand-fed windows. At `dd85f361` `leadText` is
    // `article.segments.slice(0, 2)`, so the lead swallows the whole "Kraken in der Kultur"
    // section (fiction marker "Roman"/"Spielfilm"), and with no `explicitBiology` evidence
    // anywhere the article is refused (`explicit-literary-topic-without-requested-biological-
    // evidence`) — this test is RED at that commit. After the one-line narrowing to
    // `slice(0, 1)` the lead is the intro only, the fiction marker sits outside it, and the
    // article is admitted — GREEN. See `artifacts/test-red-green.txt` for both runs' output.
    it('N1 (second review, step 4-3) — the CASE A shape end to end: NO biological evidence anywhere; admitted once the lead narrows to the intro segment only', async () => {
      reset()
      // First: the fixture itself has the CASE A shape — exactly two segments, the review's
      // texts verbatim (title "Kraken" comes from the page's own <h1>, asserted below via the
      // admitted candidate's sourceTitle).
      const parsed = await zimArticleToSegmentsAsync(caseAArticleHtml())
      expect(parsed.title).toBe('Kraken')
      expect(parsed.segments).toHaveLength(2)
      expect(parsed.segments[0]?.text).toBe(
        'Die Kraken sind eine Ordnung der Kopffuesser.\n\nSie besitzen acht Arme und leben in allen Weltmeeren.'
      )
      expect(parsed.segments[1]?.text).toBe(
        'Kraken in der Kultur\n\nDer Spielfilm um einen Riesenkraken praegte das Bild des Tieres.\n\n' +
          'Ein Roman von Jules Verne machte ihn beruehmt.'
      )

      // Then: driven through the arm's real discovery + admission path, the article is admitted.
      const { candidates, outcomes } = await collectPackCandidates(port, packs, QUESTION, undefined, names, {
        expand: async () => ({ titles: ['Kraken'], queries: [] })
      })
      expect(rawReads).toEqual(['Kraken'])
      expect(candidates.some((c) => c.sourceTitle === 'Kraken')).toBe(true)
      expect(outcomes[0]).toMatchObject({ packId: 'pack-f3', status: 'searched', reason: null })
      expect(outcomes[0]!.admitted).toBeGreaterThan(0)
    })
  })

  describe('the head-noun rule (route F 1a-i, ported)', () => {
    const packs = [{ id: 'pack-headnoun', title: 'Autos von Wikipedia' }]
    const names = new Map([['pack-headnoun', 'book-pack-headnoun']])
    // "Testos"/"Bikes" -> the inflection rule's single candidate ("Testo"/"Bik" — the LONGEST
    // matching suffix wins, 'es' before 's', so "Bikes" -> "Bik", not "Bike" — both accepted);
    // "Cars" would resolve too (-> "Car"), but HEAD_NOUN_MAX_READS caps successful reads at 2, so
    // its own /suggest is never even asked — the loop breaks before reaching it.
    const QUESTION = 'Was sind Testos und Bikes und Cars?'

    it('resolves capitalised nouns via /suggest, admits at most HEAD_NOUN_MAX_READS, BEFORE any plan title or FTS read', async () => {
      reset()
      expect(HEAD_NOUN_MAX_READS).toBe(2)
      const { candidates, outcomes } = await collectPackCandidates(port, packs, QUESTION, undefined, names, {
        expand: async () => emptyPlan()
      })
      expect(rawReads.slice(0, 2)).toEqual(['Testo', 'Bik'])
      expect(suggestRequests.some((r) => r.content === 'book-pack-headnoun' && r.term === 'Car')).toBe(false)
      expect(candidates.some((c) => c.sourceTitle === 'Testo')).toBe(true)
      expect(candidates.some((c) => c.sourceTitle === 'Bik')).toBe(true)
      expect(outcomes[0]).toMatchObject({ packId: 'pack-headnoun', status: 'searched', reason: null })
    })

    it('a question with no capitalised candidate word probes nothing', async () => {
      reset()
      await collectPackCandidates(port, packs, 'wie viel kostet das?', undefined, names, { expand: async () => emptyPlan() })
      expect(suggestRequests.filter((r) => r.content === 'book-pack-headnoun')).toEqual([])
    })

    it('without a served name the head-noun rule is not asked either', async () => {
      reset()
      await collectPackCandidates(port, packs, QUESTION, undefined, undefined, { expand: async () => emptyPlan() })
      expect(suggestRequests).toEqual([])
    })

    // Orchestrator verification finding: does a head-noun probe's HIT feed the aggregate score
    // pool the title/FTS routes share (so a later top-2-unseen pass could read it even when it
    // was never "accepted")? Checked against the frozen research artifact,
    // `steps/1a-i-title-grounding/artifacts/harness/prototype-a1.diff`: the A1 patch reads its
    // OWN accepted candidate directly (`await read(target,'head-noun')`) and logs the attempt to
    // `headNoun.log` — it never calls `add()`, route F's shared-pool sink, for ANY head-noun
    // result, accepted or not. This port matches that: STAGE 1 never calls `addScore`. This test
    // pins it with a genuine near miss — a real `/suggest` hit exists (so there is something a
    // buggy future edit COULD score) but is not an exact match, so `resolveHeadNoun` refuses it;
    // with FTS returning nothing for this pack, the ONLY way the hit could ever be read is via a
    // top-2-unseen pass finding it in the pool — which must never happen.
    it('a head-noun NEAR MISS (a real /suggest hit that does not confirm exactly) is never fed into the score pool, so it is never read via a later top-2-unseen pass', async () => {
      reset()
      const nearMissPacks = [{ id: 'pack-headnoun2', title: 'Objekte von Wikipedia' }]
      const nearMissNames = new Map([['pack-headnoun2', 'book-pack-headnoun2']])
      const { candidates, outcomes } = await collectPackCandidates(
        port,
        nearMissPacks,
        'Was sind Objekte?', // -> head-noun candidate "Obje" (see zim-head-noun.test.ts)
        undefined,
        nearMissNames,
        { expand: async () => emptyPlan() }
      )
      expect(suggestRequests).toContainEqual({ content: 'book-pack-headnoun2', term: 'Obje' })
      // The near-miss hit was FOUND but never read, from any route.
      expect(rawReads).toEqual([])
      expect(candidates).toEqual([])
      expect(outcomes[0]).toMatchObject({ packId: 'pack-headnoun2', status: 'searched', reason: null, found: 0 })
    })

    // F4 (review 2026-09-14, test gap 1): `issued` must count ACCEPTANCES (a confirmed /suggest
    // match), not ADMISSIONS — a read that 404s still spent one of the two head-noun slots. Two
    // words ("Erstos", "Zweitos") both confirm EXACTLY via /suggest but 404 at fetch, so neither
    // is ever admitted; a THIRD word ("Drittos") would ALSO confirm exactly (proven by the same
    // fixture accepting its stripped form on request), but must never even be PROBED once the
    // two-read budget is spent — with the pre-fix code (`issued++` gated on admission) all three
    // words would be probed and read, since nothing was ever admitted to trip the counter.
    it('a head-noun candidate ACCEPTED via /suggest but never ADMITTED (404 at fetch) still spends its read slot — the cap stops discovery before a third, resolvable word is even probed', async () => {
      reset()
      const packs = [{ id: 'pack-headnoun3', title: 'Zahlwoerter von Wikipedia' }]
      const names = new Map([['pack-headnoun3', 'book-pack-headnoun3']])
      const { candidates, outcomes } = await collectPackCandidates(
        port,
        packs,
        'Was sind Erstos und Zweitos und Drittos?',
        undefined,
        names,
        { expand: async () => emptyPlan() }
      )
      expect(suggestRequests).toContainEqual({ content: 'book-pack-headnoun3', term: 'Ersto' })
      expect(suggestRequests).toContainEqual({ content: 'book-pack-headnoun3', term: 'Zweito' })
      // The budget-exhausting proof: the third, equally resolvable word is never even asked.
      expect(suggestRequests.some((r) => r.content === 'book-pack-headnoun3' && r.term === 'Dritto')).toBe(false)
      expect(rawReads).toEqual(['Ersto', 'Zweito'])
      expect(candidates).toEqual([])
      expect(outcomes[0]).toMatchObject({ packId: 'pack-headnoun3', status: 'failed', reason: 'read-failed' })
    })
  })

  describe('the per-pack read budget', () => {
    it('READS: DISCOVERY_MAX_READS_PER_PACK bounds fetch attempts even when every suggest lookup matches and every fetch 404s', async () => {
      reset()
      expect(DISCOVERY_MAX_READS_PER_PACK).toBe(12)
      const titles = Array.from({ length: 20 }, (_, i) => `T${i}`)
      const packs = [{ id: 'pack-budget-reads', title: 'Budget reads' }]
      const names = new Map([['pack-budget-reads', 'book-pack-budget-reads']])
      const { candidates, outcomes } = await collectPackCandidates(port, packs, 'wie viel kostet das?', undefined, names, {
        expand: async () => ({ titles, queries: [] })
      })
      expect(rawReads).toHaveLength(DISCOVERY_MAX_READS_PER_PACK)
      expect(candidates).toEqual([])
      // Every hit was found and fetched (0 mismatches) but none survived the fetch (404) — an
      // honest read-failed, not a silent empty search.
      expect(outcomes[0]).toMatchObject({ packId: 'pack-budget-reads', status: 'failed', reason: 'read-failed' })
    })

    it('ADMITTED: DISCOVERY_MAX_ADMITTED_PER_PACK stops discovery once enough articles are admitted, before the read cap binds', async () => {
      reset()
      expect(DISCOVERY_MAX_ADMITTED_PER_PACK).toBe(8)
      expect(DISCOVERY_MAX_ADMITTED_PER_PACK).toBeLessThan(DISCOVERY_MAX_READS_PER_PACK)
      const titles = Array.from({ length: 20 }, (_, i) => `T${i}`)
      const packs = [{ id: 'pack-budget-admit', title: 'Budget admits' }]
      const names = new Map([['pack-budget-admit', 'book-pack-budget-admit']])
      const { outcomes } = await collectPackCandidates(port, packs, 'wie viel kostet das?', undefined, names, {
        expand: async () => ({ titles, queries: [] })
      })
      expect(rawReads).toHaveLength(DISCOVERY_MAX_ADMITTED_PER_PACK)
      expect(outcomes[0]).toMatchObject({ packId: 'pack-budget-admit', status: 'searched', reason: null })
    })

    it('withinReadBudget (pure): true only while BOTH counts are under their limits', () => {
      const limits = { maxReads: DISCOVERY_MAX_READS_PER_PACK, maxAdmitted: DISCOVERY_MAX_ADMITTED_PER_PACK }
      expect(withinReadBudget(0, 0, limits)).toBe(true)
      expect(withinReadBudget(DISCOVERY_MAX_READS_PER_PACK - 1, 0, limits)).toBe(true)
      expect(withinReadBudget(DISCOVERY_MAX_READS_PER_PACK, 0, limits)).toBe(false)
      expect(withinReadBudget(0, DISCOVERY_MAX_ADMITTED_PER_PACK - 1, limits)).toBe(true)
      expect(withinReadBudget(0, DISCOVERY_MAX_ADMITTED_PER_PACK, limits)).toBe(false)
      expect(withinReadBudget(DISCOVERY_MAX_READS_PER_PACK, DISCOVERY_MAX_ADMITTED_PER_PACK, limits)).toBe(false)
    })
  })
})

// ---- Phase 4 PR-A — the ported discovery constants (route F's own defaults are 14/8 for its
// one archive; this arm applies the pair PER PACK — see arm.ts's file header) --------------------
describe('the discovery read budget and pass sizes (Phase 4 PR-A)', () => {
  it('DISCOVERY_MAX_READS_PER_PACK / DISCOVERY_MAX_ADMITTED_PER_PACK / FTS_TOP_UNSEEN_PASS / HEAD_NOUN_MAX_TOTAL_PROBES match the ported design', () => {
    expect(DISCOVERY_MAX_READS_PER_PACK).toBe(12)
    expect(DISCOVERY_MAX_ADMITTED_PER_PACK).toBe(8)
    expect(FTS_TOP_UNSEEN_PASS).toBe(2)
    expect(HEAD_NOUN_MAX_TOTAL_PROBES).toBe(12)
    expect(PROBE_TIMEOUT_MS).toBe(3_000)
    // The read cap stays above the admitted cap: an admission-gate-heavy question (many reads,
    // few admits) must still be able to try up to the full read budget.
    expect(DISCOVERY_MAX_READS_PER_PACK).toBeGreaterThan(DISCOVERY_MAX_ADMITTED_PER_PACK)
  })

  // Review 2026-09-14, test gap 3: `PROBE_TIMEOUT_MS` (and its `probeTimeoutMs` test seam) had
  // no BEHAVIOURAL test — only its value was pinned above. A slow `/suggest` sitting out the
  // client's 15 s default under the arm's single 20 s per-ask deadline would starve every pack
  // still waiting its turn at `PACK_SEARCH_CONCURRENCY`; this proves the seam actually cuts a
  // slow probe off at ITS bound, not the server's, and that discovery still completes cleanly —
  // no hang, no throw, just no hit for that title (`docs/packaging.md`'s own `probeTimeoutMs`
  // seam record for this exact shape).
  it('a /suggest lookup held well past PROBE_TIMEOUT_MS is cut off at the probeTimeoutMs seam, not the server — discovery completes without that title\'s hit', async () => {
    rawReads.length = 0
    const packs = [{ id: 'pack-slow-probe', title: 'Langsam' }]
    const names = new Map([['pack-slow-probe', 'book-pack-slow-probe']])
    const t0 = Date.now()
    const { candidates, outcomes } = await collectPackCandidates(
      port,
      packs,
      'Was bedeutet das?',
      undefined,
      names,
      { expand: async () => ({ titles: ['Verzoegert'], queries: [] }), probeTimeoutMs: 50 }
    )
    const elapsedMs = Date.now() - t0
    // The seam's bound (50 ms), never the fixture's 2,000 ms delay, decided this.
    expect(elapsedMs).toBeLessThan(1_500)
    expect(rawReads).not.toContain('Verzoegert')
    expect(candidates.every((c) => c.sourceTitle !== 'Verzoegert')).toBe(true)
    // No hang, no throw: the pack still settles cleanly (a zero-hit search, nothing to admit).
    expect(outcomes[0]).toMatchObject({ packId: 'pack-slow-probe', status: 'searched', reason: null, found: 0 })
  })
})

// #429 — the served library and the search response can disagree about a pack's name (a
// non-native separator in the recorded path used to produce an unroutable whole-path serving
// name). The L4 guard already refused every such hit; what it did NOT do was say so, and the
// pack settled `searched` with nothing found — "this archive had nothing to say", which is both
// wrong and undiagnosable. Same guard, honest verdict.
describe('#429 — a pack whose every hit is refused by the route guard is read-failed, not empty', () => {
  const packs = [{ id: 'pack-climate', title: 'Klimawandel von Wikipedia' }]
  const question = 'Wie entsteht Treibhausgas in der Landwirtschaft?'

  it('settles read-failed and produces nothing when the published name is not the one the hits carry', async () => {
    const wrong = new Map([['pack-climate', 'k:/zim/klimawandel']]) // the #429 shape, verbatim
    const { candidates, outcomes } = await collectPackCandidates(port, packs, question, undefined, wrong)

    expect(candidates).toEqual([])
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      packId: 'pack-climate',
      status: 'failed',
      reason: 'read-failed',
      found: 0,
      admitted: 0
    })
  })

  it('the SAME pack with the name its hits carry produces candidates and settles searched', async () => {
    // The control: without it the assertion above would also pass if the fixture were simply
    // broken, which is the failure mode the tautological serving-name check had.
    const right = new Map([['pack-climate', 'book-pack-climate']])
    const { candidates, outcomes } = await collectPackCandidates(port, packs, question, undefined, right)

    expect(candidates.length).toBeGreaterThan(0)
    expect(outcomes[0]).toMatchObject({ status: 'searched', reason: null })
  })
})
