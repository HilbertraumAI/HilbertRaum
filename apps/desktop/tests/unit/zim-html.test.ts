import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLICE_WORK,
  IncrementalTidy,
  TEXT_PIECE_CHARS,
  attrValue,
  decodeEntities,
  tidyWhole,
  zimArticleSlices,
  zimArticleToSegments,
  zimArticleToSegmentsAsync,
  type ZimArticle
} from '../../src/main/services/zim/html'

// ZIM article HTML → segments (knowledge packs). The fixture is a hand-trimmed
// Parsoid/mwoffliner page carrying every structure the converter must handle:
// head noise, mw-ref sups, plain sups, MathML with alttext + fallback <img>,
// nested tables, figures with captions, lists, numeric + named entities.
const FIXTURE = readFileSync(join(__dirname, '../fixtures/zim/article.html'), 'utf8')

describe('zimArticleToSegments', () => {
  const article = zimArticleToSegments(FIXTURE)
  const all = article.segments.map((s) => s.text).join('\n\n')

  it('takes the article title from the first heading', () => {
    expect(article.title).toBe('Kontaktverfahren')
  })

  it('emits the intro as a leading label-less segment', () => {
    expect(article.segments[0]?.sectionLabel).toBeNull()
    expect(article.segments[0]?.text).toContain('technisches Verfahren zur Herstellung')
  })

  it('labels each section with its heading and keeps the heading in the text', () => {
    const labels = article.segments.map((s) => s.sectionLabel)
    expect(labels).toEqual([
      null,
      'Verfahrensbeschreibung',
      'Doppelkontaktverfahren',
      'Einzelnachweise'
    ])
    const verfahren = article.segments[1]
    expect(verfahren?.text.startsWith('Verfahrensbeschreibung')).toBe(true)
  })

  it('drops head noise, scripts and inline styles entirely', () => {
    expect(all).not.toContain('must never appear')
    expect(all).not.toContain('head-style')
    expect(all).not.toContain('inline-noise')
    expect(all).not.toContain('stylesheet')
  })

  it('drops mw-ref citation brackets but keeps ordinary superscripts', () => {
    expect(all).not.toContain('[1]')
    expect(all).toContain('25 m2 gemessen')
  })

  it('emits each formula once, as its alttext LaTeX', () => {
    const hits = all.match(/S\+O_\{2\}/g) ?? []
    expect(hits).toHaveLength(1)
    expect(all).not.toContain('MJX-TeXAtom') // MathML internals never leak
  })

  it('drops tables (nested included) and figures with their captions', () => {
    expect(all).not.toContain('Tabelleninhalt')
    expect(all).not.toContain('verschachtelte Zelle')
    expect(all).not.toContain('Bildunterschrift')
    expect(all).not.toContain('Anlagenfoto')
  })

  it('renders list items on their own lines', () => {
    expect(all).toContain('- Erster Punkt')
    expect(all).toContain('- Zweiter Punkt')
  })

  it('decodes numeric and named entities', () => {
    expect(all).toContain('Schwefelsäure')
    expect(all).toContain('Umsätze')
    expect(all).toContain('99,8 %') // &#8201; thin space → space via tidy
  })

  it('keeps reference-section text reachable for retrieval', () => {
    expect(all).toContain('Referenztext bleibt erhalten.')
  })

  it('is total on junk input', () => {
    expect(zimArticleToSegments('').segments).toEqual([])
    expect(zimArticleToSegments('<p>unterminated').segments[0]?.text).toBe('unterminated')
    expect(zimArticleToSegments('plain text, no markup').segments[0]?.text).toBe(
      'plain text, no markup'
    )
    // A never-closed skip subtree swallows the rest but must not throw.
    expect(() => zimArticleToSegments('<table><tr><td>x')).not.toThrow()
  })

  it('bounds the scan at maxChars', () => {
    const big = `<p>${'a'.repeat(100)}</p><p>tail marker</p>`
    const bounded = zimArticleToSegments(big, { maxChars: 110 })
    expect(bounded.segments.map((s) => s.text).join('')).not.toContain('tail marker')
  })
})

// ---------------------------------------------------------------------------------------
// H1 — the linear forward scanner (PR #294 review H1, required checks T02-a / T02-b).
//
// The oracle is the instrumented `work` counter, never wall-clock time: CI machines vary by
// an order of magnitude, but "input positions the scanner examined" is deterministic. The
// defect was O(n²) (the old TOKEN regex rescanned the suffix once per unclosed `<`), so the
// assertions are (1) work > 0 — a counter stuck at zero must not pass, (2) an ABSOLUTE
// linear bound work ≤ K·n + c with the K proved in html.ts's complexity record, (3) the
// scaling rule work(60k) ≤ 2.5 × work(30k), and (4) USEFUL OUTPUT: fast output of nothing is
// not a fix, so every case must still extract the lead text (and the tail wherever the
// recovery can reach it).
// ---------------------------------------------------------------------------------------

/** The proved per-index examination bound from html.ts's complexity record (K = 5). */
const K = 5
/** Per-tag bookkeeping slack in the bound (the `c` of work ≤ K·n + c). */
const C = 64
const bound = (n: number): number => K * n + C

const LEAD = '<p>lead</p>'
const TAIL = '<p>tail</p>'
/** `unit` repeated to roughly `size` chars, never cut mid-unit (a half `<!--` is a different
 *  pathology). Sizes therefore differ by a few chars per family; the 30k/60k unit COUNT is
 *  exactly doubled, which is what the scaling rule is about. */
const runs = (unit: string, size: number): string => unit.repeat(Math.round(size / unit.length))
const pathology = (unit: string, size: number): string => `${LEAD}${runs(unit, size)}${TAIL}`

interface Family {
  /** What the run models. */
  readonly what: string
  readonly unit: string
  /** Whether the recovery can still reach the trailing `<p>tail</p>`. */
  readonly keepsTail: boolean
  /** `null` = the whole input is converted; otherwise the reported truncation. */
  readonly truncation: { reason: string; what?: string } | null
}

// One row per pathology family. Families whose recovery legitimately loses the tail are
// exactly the ones whose remainder cannot be interpreted at all (HTML5 discards it), and
// every one of those MUST report `truncated.reason === 'unterminated'`.
const FAMILIES: readonly Family[] = [
  // The H1 defect itself: unclosed `<` runs made the old tokeniser rescan the suffix.
  { what: 'unclosed `<x ` tags', unit: '<x ', keepsTail: true, truncation: null },
  { what: 'repeated bare `<`', unit: '<', keepsTail: true, truncation: null },
  { what: 'tags with unmatched `"`', unit: '<p t="a ', keepsTail: true, truncation: null },
  { what: "tags with unmatched `'`", unit: "<p t='a ", keepsTail: true, truncation: null },
  { what: 'deep `<div>` nesting', unit: '<div>', keepsTail: true, truncation: null },
  { what: 'entity-heavy text', unit: '&amp;&#65;&aaaa &#xFFFFFF; ', keepsTail: true, truncation: null },
  { what: 'closed comments', unit: '<!--c-->', keepsTail: true, truncation: null },
  { what: 'closed CDATA', unit: '<![CDATA[x]]>', keepsTail: true, truncation: null },
  {
    what: 'script bodies full of `</div>` sentinels',
    unit: '<script>a</div>b</script>',
    keepsTail: true,
    truncation: null
  },
  {
    what: 'unterminated comments',
    unit: '<!--c ',
    keepsTail: false,
    truncation: { reason: 'unterminated', what: 'comment' }
  },
  {
    what: 'unterminated CDATA',
    unit: '<![CDATA[x ',
    keepsTail: false,
    truncation: { reason: 'unterminated', what: 'cdata' }
  },
  {
    what: 'unterminated `<script>`',
    unit: '<script>x ',
    keepsTail: false,
    truncation: { reason: 'unterminated', what: 'script' }
  },
  {
    what: 'unterminated `<style>`',
    unit: '<style>x ',
    keepsTail: false,
    truncation: { reason: 'unterminated', what: 'style' }
  }
]

/** The four non-Wikipedia ZIM producers (plan §5.1): Parsoid/mwoffliner, zimit/warc2zim,
 *  DevDocs and Stack Exchange (sotoki). Committed fixtures, so normal CI runs them without
 *  an external archive environment. */
const NON_WIKIPEDIA: ReadonlyArray<{
  file: string
  title: string
  contains: readonly string[]
  omits: readonly string[]
  /** Segments the page must yield. One segment per heading section plus the intro, so this
   *  is 2 only where the fixture carries a sub-heading under its h1; the zimit, DevDocs and
   *  Stack Exchange pages model producers whose entry pages are a single h1 followed by flat
   *  prose, so they yield one (substantial) intro segment. `minChars` carries the real
   *  "useful output" weight for those. */
  minSegments: number
  minChars: number
}> = [
  {
    file: 'parsoid-datamw.html',
    title: 'Ammonia synthesis',
    contains: ['iron catalyst at high pressure and moderate temperature', 'N_2 + 3H_2'],
    minSegments: 4,
    minChars: 1200,
    omits: [
      'datamw-style-never-shown',
      'datamw-comment-never-shown',
      'mw-ref-never-shown',
      'infobox-never-shown'
    ]
  },
  {
    file: 'zimit-page.html',
    title: 'Field notes on offline archives',
    contains: ['the crawler stores every response body exactly as served'],
    minSegments: 1,
    minChars: 1200,
    omits: [
      'wombat-never-shown',
      'noscript-never-shown',
      'zimit-banner-never-shown',
      'svg-never-shown',
      'cdata-never-shown',
      'ie-never-shown'
    ]
  },
  {
    file: 'devdocs-page.html',
    title: 'Array.prototype.flatMap()',
    contains: ['maps each element and flattens the result by one level', 'x => [x, x * 2]'],
    minSegments: 1,
    minChars: 1200,
    omits: ['devdocs-nav-never-shown', 'devdocs-style-never-shown', 'compat-table-never-shown']
  },
  {
    file: 'stackexchange-question.html',
    title: 'How do I bound lookahead in a hand-rolled HTML scanner?',
    contains: [
      'the scanner must never search the same suffix twice',
      'remember the position of the last failed search'
    ],
    minSegments: 1,
    minChars: 1200,
    omits: ['se-script-never-shown', 'se-vote-table-never-shown', 'se-comment-never-shown']
  }
]

describe('zimArticleToSegments — H1 linear scanner', () => {
  const textOf = (a: ReturnType<typeof zimArticleToSegments>): string =>
    a.segments.map((s) => s.text).join('\n')

  it("T02 the scanner's work counter is nonzero and scales linearly: work(60k) ≤ 2.5 × work(30k) on the unclosed-< pathology (no wall-clock)", () => {
    const small = pathology('<x ', 30_000)
    const large = pathology('<x ', 60_000)
    const a = zimArticleToSegments(small)
    const b = zimArticleToSegments(large)

    // A zero or constant counter must not pass.
    expect(a.work).toBeGreaterThan(0)
    expect(b.work).toBeGreaterThan(a.work)

    // Absolute linear bound with the K proved in html.ts (the old regex needed ~n²/2 here).
    expect(a.work).toBeLessThanOrEqual(bound(small.length))
    expect(b.work).toBeLessThanOrEqual(bound(large.length))

    // The scaling rule: doubling the input may not more than 2.5× the work.
    expect(b.work).toBeLessThanOrEqual(2.5 * a.work)

    // …and the output is still useful: an unclosed-`<` run is recovered at each `<`, so
    // both the lead and the tail survive and nothing is reported as lost.
    for (const r of [a, b]) {
      expect(textOf(r)).toContain('lead')
      expect(textOf(r)).toContain('tail')
      expect(r.truncated).toBeNull()
    }
  })

  it('T02 unterminated quotes / comments / script / style, repeated <, entity-heavy and non-Wikipedia fixtures (Parsoid, zimit, DevDocs, Stack Exchange) extract useful text within the work budget and report truncation explicitly', () => {
    for (const f of FAMILIES) {
      const small = pathology(f.unit, 30_000)
      const large = pathology(f.unit, 60_000)
      const a = zimArticleToSegments(small)
      const b = zimArticleToSegments(large)

      expect(a.work, f.what).toBeGreaterThan(0)
      expect(a.work, f.what).toBeLessThanOrEqual(bound(small.length))
      expect(b.work, f.what).toBeLessThanOrEqual(bound(large.length))
      expect(b.work, `${f.what}: work(60k) ≤ 2.5 × work(30k)`).toBeLessThanOrEqual(2.5 * a.work)

      // Useful output: the lead is ALWAYS extracted, however malformed the rest is.
      expect(textOf(a), f.what).toContain('lead')
      expect(textOf(b), f.what).toContain('lead')

      // The tail is extracted whenever the recovery can reach it; the families that
      // legitimately lose it are exactly the ones that report `unterminated`.
      expect(textOf(a).includes('tail'), `${f.what}: tail reachable`).toBe(f.keepsTail)
      if (f.truncation === null) {
        expect(a.truncated, f.what).toBeNull()
      } else {
        expect(a.truncated, f.what).toMatchObject(f.truncation)
        expect(a.truncated?.reason, f.what).toBe('unterminated')
      }
    }

    // The four non-Wikipedia producers. Their contract: the h1 is the title, the wanted
    // prose (and decoded code/math) survives, no dropped subtree leaks, no markup survives,
    // the conversion is complete and the counter is live.
    for (const f of NON_WIKIPEDIA) {
      const html = readFileSync(join(__dirname, '../fixtures/zim', f.file), 'utf8')
      const r = zimArticleToSegments(html)
      const text = textOf(r)
      expect(r.title, f.file).toBe(f.title)
      for (const wanted of f.contains) expect(text, `${f.file}: ${wanted}`).toContain(wanted)
      for (const banned of f.omits) expect(text, `${f.file}: ${banned}`).not.toContain(banned)
      expect(text, f.file).not.toMatch(/<[a-z][a-z0-9-]*[\s>]/i)
      expect(r.truncated, f.file).toBeNull()
      expect(r.work, f.file).toBeGreaterThan(0)
      expect(r.work, f.file).toBeLessThanOrEqual(bound(html.length))
      expect(r.segments.length, f.file).toBeGreaterThanOrEqual(f.minSegments)
      expect(text.length, f.file).toBeGreaterThanOrEqual(f.minChars)
    }
  })

  it('emits a live, monotone counter: zero only for empty input, and never wall-clock', () => {
    expect(zimArticleToSegments('').work).toBe(0)
    expect(zimArticleToSegments('a').work).toBeGreaterThan(0)
    expect(zimArticleToSegments('<').work).toBeGreaterThan(0)
    const short = zimArticleToSegments('<p>abc</p>')
    const long = zimArticleToSegments(`<p>${'abc '.repeat(500)}</p>`)
    expect(long.work).toBeGreaterThan(short.work)
    // Deterministic: the same input always costs the same.
    expect(zimArticleToSegments('<p>abc</p>').work).toBe(short.work)
  })

  it('recovers at the `<` inside a malformed tag instead of swallowing the document', () => {
    const r = zimArticleToSegments('<p>lead</p><x <y <z <p>tail</p>')
    expect(textOf(r)).toContain('lead')
    expect(textOf(r)).toContain('tail')
    expect(r.truncated).toBeNull()
  })

  it('keeps scanning after an attribute quote that never closes inside the tag', () => {
    // The `>` still ends the tag, so nothing is lost and nothing is reported.
    const r = zimArticleToSegments('<p>lead</p><p t="x> middle </p><p>tail</p>')
    expect(textOf(r)).toContain('lead')
    expect(textOf(r)).toContain('middle')
    expect(textOf(r)).toContain('tail')
    expect(r.truncated).toBeNull()
  })

  it('treats a `<` that starts nothing as text and advances one char', () => {
    const r = zimArticleToSegments('<p>a <<<< b < c <1 d</p>')
    const text = textOf(r)
    expect(text).toContain('a <<<< b < c <1 d')
    expect(r.truncated).toBeNull()
  })

  it('drops a `</` with no tag name and a `<?…>` processing instruction as bogus comments', () => {
    const r = zimArticleToSegments('<p>lead</> </ x> <?php echo 1; ?> tail</p>')
    expect(textOf(r)).toContain('lead')
    expect(textOf(r)).toContain('tail')
    expect(textOf(r)).not.toContain('php')
    expect(r.truncated).toBeNull()
  })

  it('reports every truncation reason with the index that cut the output', () => {
    const cases: Array<[string, { reason: string; what?: string }]> = [
      ['<p>lead</p><!-- never closed', { reason: 'unterminated', what: 'comment' }],
      ['<p>lead</p><![CDATA[ never closed', { reason: 'unterminated', what: 'cdata' }],
      ['<p>lead</p><script> never closed', { reason: 'unterminated', what: 'script' }],
      ['<p>lead</p><style> never closed', { reason: 'unterminated', what: 'style' }],
      ['<p>lead</p><p class=abc never closed', { reason: 'unterminated', what: 'tag' }],
      ['<p>lead</p><p class="abc never closed', { reason: 'unterminated', what: 'quote' }]
    ]
    for (const [html, expected] of cases) {
      const r = zimArticleToSegments(html)
      expect(r.truncated, html).toMatchObject(expected)
      // The `at` index points into the input, at or after the lead we already emitted.
      expect(r.truncated?.at, html).toBeGreaterThanOrEqual(LEAD.length)
      expect(r.truncated?.at, html).toBeLessThan(html.length)
      // Never throws, and the segments emitted before the cut are still returned.
      expect(textOf(r), html).toContain('lead')
    }
  })

  it('stops at the work budget and returns the segments emitted so far', () => {
    const html = `${LEAD}${'<div>chunk</div>'.repeat(4000)}`
    const r = zimArticleToSegments(html, { maxWork: 500 })
    expect(r.truncated).toMatchObject({ reason: 'workBudget' })
    expect(r.truncated?.at).toBeGreaterThan(0)
    expect(r.truncated?.at).toBeLessThan(html.length)
    expect(r.work).toBeGreaterThan(0)
    expect(r.work).toBeLessThanOrEqual(bound(html.length))
    // Partial, but not empty: the ask path still gets chunks out of the article.
    expect(r.segments.length).toBeGreaterThan(0)
    expect(textOf(r)).toContain('lead')
    // The same input without the tiny budget converts completely.
    expect(zimArticleToSegments(html).truncated).toBeNull()
  })

  it('reports the maxChars cut with how far conversion got; a slice artifact is never blamed on the markup', () => {
    const big = `<p>${'a'.repeat(100)}</p><p>tail marker</p>`
    expect(zimArticleToSegments(big, { maxChars: 110 }).truncated).toEqual({
      reason: 'maxChars',
      at: 110
    })
    expect(zimArticleToSegments(big).truncated).toBeNull()
    // Sliced inside a comment: the cap is the reason (the comment may well close past the
    // cap), and `at` records where output actually stopped — the comment's start.
    const cutEarlier = zimArticleToSegments(`<p>lead</p><!-- ${'x'.repeat(200)}`, {
      maxChars: 100
    })
    expect(cutEarlier.truncated).toEqual({ reason: 'maxChars', at: LEAD.length })
    expect(cutEarlier.segments.map((s) => s.text)).toEqual(['lead'])
    // A sliced tag is the same story: the cap, not a phantom unterminated tag / quote; `at`
    // keeps the scan's position (here the quote that never closed inside the cap).
    const slicedTag = zimArticleToSegments(`<p>lead</p><p class="${'y'.repeat(200)}`, { maxChars: 100 })
    expect(slicedTag.truncated).toMatchObject({ reason: 'maxChars' })
    expect(slicedTag.truncated?.at).toBeGreaterThanOrEqual(LEAD.length)
    expect(slicedTag.truncated?.at).toBeLessThan(100)
    // The work budget keeps precedence over the cap: it is the more alarming signal.
    const budget = zimArticleToSegments(`${LEAD}${'<div>c</div>'.repeat(4000)}`, { maxChars: 20_000, maxWork: 300 })
    expect(budget.truncated).toMatchObject({ reason: 'workBudget' })
  })

  it('never lowercases the input to find a raw-text end tag (indices would shift)', () => {
    // U+0130 lowercases to two code units in JS; a whole-input toLowerCase() would shift
    // every index after it. Uppercase end tags must still close their raw-text element.
    const r = zimArticleToSegments('<p>İ lead</p><SCRIPT>hidden</SCRIPT><p>tail</p>')
    const text = textOf(r)
    expect(text).toContain('İ lead')
    expect(text).toContain('tail')
    expect(text).not.toContain('hidden')
    expect(r.truncated).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------
// P1b — cooperative slicing (PR #294 review H1). Linear was not enough: a worst-case 1 MiB
// article is 55–63 ms of uninterruptible main-thread work on laptop-class hardware, so the
// scanner is now a generator that yields every `sliceWork` work units. These tests pin the
// three things that make slicing real rather than cosmetic — the slice boundaries exist, the
// event loop actually turns between them, and an abort stops the conversion — plus the
// equivalence that lets the sync API and the perf script keep using the same code.
// ---------------------------------------------------------------------------------------

/** A ~1 MiB body of `unit`, wrapped in the usual lead/tail so output is checkable. */
const megabyte = (unit: string): string => pathology(unit, 1_040_000)

/**
 * Run `fn` with `globalThis.setImmediate` counted (and optionally hooked). The converter
 * reaches the global at call time, so this observes exactly the macrotask hops it takes
 * between slices — the public, deterministic way to see slice boundaries from outside.
 */
async function withHopCounter<T>(
  fn: () => Promise<T>,
  onHop?: (hop: number) => void
): Promise<{ result?: T; error?: unknown; hops: number }> {
  const real = globalThis.setImmediate
  let hops = 0
  const patched = ((cb: (...a: never[]) => void, ...args: never[]) => {
    hops += 1
    onHop?.(hops)
    return real(cb, ...args)
  }) as unknown as typeof globalThis.setImmediate
  globalThis.setImmediate = patched
  try {
    const result = await fn()
    return { result, hops }
  } catch (error) {
    return { error, hops }
  } finally {
    globalThis.setImmediate = real
  }
}

describe('zimArticleToSegments — P1b cooperative slicing', () => {
  const textOf = (a: ZimArticle): string => a.segments.map((s) => s.text).join('\n')

  it('P1b slices the scan: a small article is one slice, and slices never exceed work / DEFAULT_SLICE_WORK + 1', () => {
    // A ~30 KB real article — the common case — must not be sliced at all.
    for (const f of NON_WIKIPEDIA) {
      const html = readFileSync(join(__dirname, '../fixtures/zim', f.file), 'utf8')
      expect(zimArticleToSegments(html).slices, f.file).toBe(1)
    }
    expect(zimArticleToSegments('<h1>T</h1><p>a short article body</p>').slices).toBe(1)
    expect(zimArticleToSegments('').slices).toBe(1)

    // The invariant that always holds. There are two slice triggers: `sliceWork` units of
    // scan work, and one emitted text piece of TEXT_PIECE_CHARS. Every char emitted was
    // charged to `work` first (by the `find` hop that skipped the run), and the two
    // constants are equal, so each trigger can fire at most work/sliceWork times:
    // slices ≤ floor(2 × work / sliceWork) + 1 on ANY input.
    for (const f of FAMILIES) {
      const r = zimArticleToSegments(megabyte(f.unit))
      expect(r.slices, f.what).toBeGreaterThanOrEqual(1)
      expect(r.slices, f.what).toBeLessThanOrEqual(
        Math.floor((2 * r.work) / DEFAULT_SLICE_WORK) + 1
      )
    }

    // Pure markup, no text to emit: work accrues by stepping and only the scan trigger
    // fires, so slices track work / sliceWork exactly.
    const markupOnly = zimArticleToSegments(megabyte('<x '))
    expect(markupOnly.slices).toBe(Math.ceil(markupOnly.work / DEFAULT_SLICE_WORK))
    expect(markupOnly.slices).toBeGreaterThan(10)

    // Text-bearing families are sliced by BOTH triggers, so they land between the scan-only
    // count and the two-trigger bound — never at 1, which is the regression that matters.
    for (const unit of ['<', '<div>', '<p>some words of body text</p>', '&amp;&#65;&aaaa ']) {
      const r = zimArticleToSegments(megabyte(unit))
      expect(r.slices, unit).toBeGreaterThanOrEqual(Math.ceil(r.work / DEFAULT_SLICE_WORK))
      expect(r.slices, unit).toBeLessThanOrEqual(
        Math.floor((2 * r.work) / DEFAULT_SLICE_WORK) + 1
      )
      expect(r.slices, unit).toBeGreaterThan(10)
    }

    // A family that charges most of its work in ONE failed lookahead legitimately yields
    // fewer slices than work / sliceWork: the hop is indivisible (the documented overshoot),
    // and its content is discarded rather than emitted, so no text piece follows either.
    const oneHop = zimArticleToSegments(megabyte('<!--c '))
    expect(oneHop.work).toBeGreaterThan(10 * DEFAULT_SLICE_WORK)
    expect(oneHop.slices).toBeLessThan(3)
  })

  it('P1b a tiny sliceWork slices a 30k input many times without changing the result', () => {
    const html = pathology('<x ', 30_000)
    let yields = 0
    const run = zimArticleSlices(html, { sliceWork: 1_000 })
    let step = run.next()
    while (!step.done) {
      yields += 1
      step = run.next()
    }
    expect(yields).toBeGreaterThan(25)
    expect(step.value.slices).toBe(yields + 1)
    // Same work, same output, same truncation — only the slicing changed.
    const whole = zimArticleToSegments(html)
    expect({ ...step.value, slices: 0 }).toEqual({ ...whole, slices: 0 })
  })

  it('P1b the event loop runs between slices, and a single-slice article never yields a macrotask', async () => {
    const multi = await withHopCounter(() => zimArticleToSegmentsAsync(megabyte('<x ')))
    expect(multi.error).toBeUndefined()
    expect(multi.result?.slices).toBeGreaterThan(10)
    // One macrotask hop per slice boundary: the main thread really was handed back.
    expect(multi.hops).toBe((multi.result?.slices ?? 0) - 1)

    const single = await withHopCounter(() =>
      zimArticleToSegmentsAsync('<h1>T</h1><p>a short article body</p>')
    )
    expect(single.result?.slices).toBe(1)
    expect(single.hops).toBe(0)
  })

  it('P1b an abort mid-conversion rejects with the signal reason and runs no further slice', async () => {
    const html = megabyte('<x ')
    const full = zimArticleToSegments(html)
    expect(full.slices).toBeGreaterThan(10)

    const ac = new AbortController()
    const reason = new Error('the ask was cancelled')
    // Abort from inside the FIRST inter-slice hop: the next slice boundary must refuse.
    const aborted = await withHopCounter(
      () => zimArticleToSegmentsAsync(html, { signal: ac.signal }),
      (hop) => {
        if (hop === 1) ac.abort(reason)
      }
    )
    expect(aborted.result).toBeUndefined()
    expect(aborted.error).toBe(reason)
    // One slice ran, one hop happened, and then nothing: far short of the full conversion.
    expect(aborted.hops).toBe(1)
    expect(aborted.hops).toBeLessThan(full.slices - 1)
  })

  it('P1b an already-aborted signal rejects before the first slice', async () => {
    const ac = new AbortController()
    ac.abort()
    const run = await withHopCounter(() =>
      zimArticleToSegmentsAsync(megabyte('<x '), { signal: ac.signal })
    )
    expect(run.result).toBeUndefined()
    expect(run.hops).toBe(0)
    // No reason given ⇒ the platform's own AbortError; with a reason ⇒ that reason verbatim.
    expect((run.error as { name?: string })?.name).toBe('AbortError')

    const withReason = new AbortController()
    const reason = { code: 'cancelled' }
    withReason.abort(reason)
    await expect(
      zimArticleToSegmentsAsync('<p>x</p>', { signal: withReason.signal })
    ).rejects.toBe(reason)
  })

  it('P1b the async result is identical to the sync result on the fixtures and pathology families', async () => {
    for (const f of NON_WIKIPEDIA) {
      const html = readFileSync(join(__dirname, '../fixtures/zim', f.file), 'utf8')
      expect(await zimArticleToSegmentsAsync(html), f.file).toEqual(zimArticleToSegments(html))
    }
    for (const unit of ['<x ', '<!--c ']) {
      const html = megabyte(unit)
      const async_ = await zimArticleToSegmentsAsync(html)
      const sync = zimArticleToSegments(html)
      expect(async_, unit).toEqual(sync)
      // Spelled out: the fields the ask path and the viewer depend on.
      expect(async_.work, unit).toBe(sync.work)
      expect(async_.slices, unit).toBe(sync.slices)
      expect(async_.truncated, unit).toEqual(sync.truncated)
      expect(textOf(async_), unit).toBe(textOf(sync))
    }
  })
})

describe('IncrementalTidy — the whole-string tidy, applied piece by piece', () => {
  // A deterministic PRNG: a failure here must be reproducible from the seed alone.
  const rng = (seed: number): (() => number) => {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 0x1_0000_0000
    }
  }
  // Letters, every flavour of horizontal and vertical whitespace, the invisibles the first
  // tidy pass strips, and entity text — the alphabet the rules actually distinguish.
  const TOKENS = [
    'a',
    'bc',
    'Wort',
    '9',
    '.',
    ',',
    ' ',
    '  ',
    '\t',
    '\r',
    '\r\n',
    '\n',
    '\n\n',
    '\n\n\n',
    '\v',
    '\f',
    ' ',
    ' ',
    '　',
    '­',
    '​',
    '‌',
    '‍',
    '﻿',
    '&amp;',
    '&#65;',
    '&nbsp;',
    '&aaaa',
    ' \n ',
    '\t\n\t'
  ]
  const build = (next: () => number): string => {
    const parts: string[] = []
    const count = 1 + Math.floor(next() * 40)
    for (let i = 0; i < count; i += 1) parts.push(TOKENS[Math.floor(next() * TOKENS.length)]!)
    return parts.join('')
  }
  const drive = (whole: string, pieceSizes: number[]): string => {
    const inc = new IncrementalTidy()
    let at = 0
    let k = 0
    while (at < whole.length) {
      const size = Math.max(1, pieceSizes[k % pieceSizes.length]!)
      inc.push(whole.slice(at, at + size))
      at += size
      k += 1
    }
    return inc.result()
  }

  it('P1b the incremental tidy equals tidyWhole over the concatenation, for any split', () => {
    const next = rng(0x9e3779b9)
    let checked = 0
    for (let t = 0; t < 400; t += 1) {
      const whole = build(next)
      const expected = tidyWhole(whole)
      // Split size 1 — the worst case for a carry — plus a handful of random sizes and the
      // degenerate "one piece" case.
      const splits: number[][] = [
        [1],
        [2],
        [3],
        [whole.length || 1],
        [1 + Math.floor(next() * 7)],
        [1 + Math.floor(next() * 5), 1 + Math.floor(next() * 11), 1]
      ]
      for (const sizes of splits) {
        expect(drive(whole, sizes), `${JSON.stringify(whole)} split ${sizes.join(',')}`).toBe(
          expected
        )
        checked += 1
      }
    }
    expect(checked).toBe(400 * 6)
  })

  it('P1b the incremental tidy handles the seeded section start and repeated resets', () => {
    const inc = new IncrementalTidy()
    // How a heading seeds the next segment: canonical text plus one pending newline.
    inc.reset('Verfahren', 1)
    inc.push('   \n  Erster Absatz.  ')
    inc.push('\n\n\n Zweiter.   \n\t')
    expect(inc.result()).toBe(tidyWhole('Verfahren\n   \n  Erster Absatz.  \n\n\n Zweiter.   \n\t'))
    inc.reset()
    expect(inc.result()).toBe('')
    inc.push('  \n only \t text \n  ')
    expect(inc.result()).toBe(tidyWhole('  \n only \t text \n  '))
  })

  it('P1b a text run longer than TEXT_PIECE_CHARS decodes and tidies exactly as one piece would', () => {
    // Entities every few chars, so piece boundaries land on and around them constantly.
    const run = '&amp;a &#65; b&nbsp;&aaaa \n c '.repeat(Math.ceil(1_100_000 / 30))
    const article = zimArticleToSegments(`<p>${run}</p>`)
    expect(article.segments).toHaveLength(1)
    // maxChars cuts the input at 1 MiB; the converted run is everything after the 3-char
    // <p> prefix up to that cut, decoded and tidied as one string by the oracle.
    expect(article.segments[0]?.text).toBe(tidyWhole(decodeEntities(run.slice(0, 1_048_576 - 3))))
    expect(article.truncated).toMatchObject({ reason: 'maxChars' })

    // And an entity placed so that it straddles the piece boundary exactly.
    for (const offset of [-3, -1, 0, 1, 3]) {
      const at = TEXT_PIECE_CHARS + offset - '&amp;'.length
      const raw = `${'x'.repeat(at)}&amp;${'y'.repeat(1000)}`
      expect(zimArticleToSegments(`<p>${raw}</p>`).segments[0]?.text, `offset ${offset}`).toBe(
        tidyWhole(decodeEntities(raw))
      )
    }
  })

  it('P1b every segment the converter produces is already in canonical (tidyWhole) form', () => {
    const inputs: Array<[string, string]> = [
      ...NON_WIKIPEDIA.map(
        (f): [string, string] => [
          f.file,
          readFileSync(join(__dirname, '../fixtures/zim', f.file), 'utf8')
        ]
      ),
      ['article.html', FIXTURE],
      ...FAMILIES.map((f): [string, string] => [f.what, megabyte(f.unit)])
    ]
    for (const [label, html] of inputs) {
      const a = zimArticleToSegments(html)
      for (const s of a.segments) {
        expect(s.text, `${label}: segment is canonical`).toBe(tidyWhole(s.text))
        expect(s.text, `${label}: no leading/trailing whitespace`).toBe(s.text.trim())
        expect(s.text, `${label}: no run of three newlines`).not.toMatch(/\n{3}/)
        expect(s.text, `${label}: no space beside a newline`).not.toMatch(/ \n| \n|\n /)
      }
      if (a.title !== null) expect(a.title, `${label}: title`).toBe(tidyWhole(a.title))
    }
  })
})

describe('attrValue', () => {
  it('reads both quote styles, skips look-alike names, and is linear on a hostile tag', () => {
    expect(attrValue(' class="a b" id="x"', 'class')).toBe('a b')
    expect(attrValue(" data-mw='{\"a\":\"> b\"}' id='y'", 'data-mw')).toBe('{"a":"> b"}')
    expect(attrValue(' data-class="no" class="yes"', 'class')).toBe('yes')
    expect(attrValue(' CLASS="upper"', 'class')).toBe('upper')
    expect(attrValue(' hidden class="v"', 'class')).toBe('v')
    expect(attrValue(' class=unquoted', 'class')).toBeNull()
    expect(attrValue(' id="x"', 'class')).toBeNull()
    // The old regex form rescanned the tail per ` class=` candidate: quadratic. This is one
    // pass, so a pathological single tag stays cheap (the assertion is the result, the
    // point is that it returns at all).
    expect(attrValue(` ${'class="'.repeat(20_000)}`, 'class')).toBe('class=')
  })
})

describe('decodeEntities', () => {
  it('decodes numeric, hex and known named entities; leaves unknown ones', () => {
    expect(decodeEntities('&#196;&#xE4;&amp;&nbsp;&ndash;')).toBe('Ää& –')
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;')
  })

  it('rejects out-of-range and surrogate code points without throwing', () => {
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;')
  })
})

// Full real-article sanity checks against uncommitted mwoffliner output. Run with
// HILBERTRAUM_ZIM_FIXTURES=<dir containing *.html raw kiwix-serve articles> — the
// committed fixture pins the contract; this leg pins realism (manual-smoke convention).
const realDir = process.env.HILBERTRAUM_ZIM_FIXTURES
describe.runIf(!!realDir && existsSync(realDir!))('real mwoffliner articles', () => {
  for (const name of ['kontaktverfahren.html', 'treibhausgas.html', 'georgia.html']) {
    it(`extracts clean sectioned text from ${name}`, () => {
      const file = join(realDir!, name)
      if (!existsSync(file)) return
      const html = readFileSync(file, 'utf8')
      const { title, segments } = zimArticleToSegments(html)
      expect(title).toBeTruthy()
      expect(segments.length).toBeGreaterThan(3)
      const text = segments.map((s) => s.text).join('\n\n')
      expect(text.length).toBeGreaterThan(2000)
      // No markup, style or MathML internals may survive.
      expect(text).not.toMatch(/<[a-z][a-z0-9-]*[\s>]/i)
      expect(text).not.toContain('MJX-TeXAtom')
      expect(text).not.toMatch(/\{[\s;]*display:/)
      // Labelled sections exist and are non-trivial.
      expect(segments.some((s) => s.sectionLabel)).toBe(true)
    })
  }
})
