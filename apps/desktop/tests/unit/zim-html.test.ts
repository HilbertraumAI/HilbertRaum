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
import {
  TABLE_MAX_COLSPAN,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_GRID_CELLS,
  TABLE_MAX_RAW_CHARS,
  TABLE_MAX_ROWSPAN,
  TABLE_MAX_SEGMENTS,
  TABLE_MAX_SOURCE_ROWS,
  TABLE_SEGMENT_MAX_CHARS
} from '../../src/main/services/zim/tables'

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
    // 'Verfahrensbeschreibung' now repeats: the section's infobox table (kept, delivered as
    // its own segment — table delivery) splits the prose before it from the prose after it,
    // and both still carry the section's own heading as their sectionLabel.
    // 'Doppelkontaktverfahren' now repeats too, for the same reason: the section's figure
    // caption is delivered as its own segment (issue: figure captions reach a segment),
    // which flushes the surrounding prose first, exactly as the table case above does.
    expect(labels).toEqual([
      null,
      'Verfahrensbeschreibung',
      'Verfahrensbeschreibung',
      'Verfahrensbeschreibung',
      'Doppelkontaktverfahren',
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

  it('drops mw-ref citation brackets but keeps ordinary superscripts, marked (issue #488)', () => {
    expect(all).not.toContain('[1]')
    expect(all).toContain('25 m^2 gemessen')
    expect(all).not.toContain('25 m2 gemessen')
  })

  it('a prose <sub> gets the same readable marker as a table cell’s ' +
    '(issue #488: prose used to flatten H<sub>2</sub>O to H2O)', () => {
    const text = zimArticleToSegments('<p>H<sub>2</sub>O ist Wasser.</p>')
      .segments.map((s) => s.text)
      .join('\n')
    expect(text).toContain('H_2O ist Wasser')
    expect(text).not.toContain('H2O ist')
  })

  it('a prose <sup> exponent no longer fuses into its base (issue #488: 10<sup>6</sup> read as 106)', () => {
    const text = zimArticleToSegments('<p>Rund 10<sup>6</sup> Einheiten.</p>')
      .segments.map((s) => s.text)
      .join('\n')
    expect(text).toContain('10^6 Einheiten')
    expect(text).not.toMatch(/\b106\b/)
  })

  it('marks an ordinary prose <sup> that sits right beside a dropped mw-ref one (issue #488)', () => {
    const text = zimArticleToSegments(
      '<p>Wert<sup class="mw-ref">[7]</sup> von 3 m<sup>3</sup> pro Tag.</p>'
    )
      .segments.map((s) => s.text)
      .join('\n')
    expect(text).toContain('3 m^3 pro Tag')
    expect(text).not.toContain('[7]')
    expect(text).not.toContain('Wert^')
  })

  it('marks a <sup> inside a heading, and the marked text reaches both the body and the sectionLabel (issue #488)', () => {
    const article = zimArticleToSegments(
      '<h1>Titel</h1><h2>Fläche in m<sup>2</sup></h2><p>Rumpf.</p>'
    )
    const labelled = article.segments.find((s) => s.sectionLabel !== null)
    expect(labelled?.sectionLabel).toBe('Fläche in m^2')
    expect(labelled?.text.startsWith('Fläche in m^2')).toBe(true)
  })

  it('an empty prose <sup> leaves a lone marker — the forward scanner cannot know the element ' +
    'is empty, and a lone marker folds to nothing for the matchers (issue #488)', () => {
    const text = zimArticleToSegments('<p>Rest<sup></sup> danach.</p>')
      .segments.map((s) => s.text)
      .join('\n')
    expect(text).toBe('Rest^ danach.')
  })

  it('a self-closing prose <sup/> or <sub/> marks nothing (issue #488)', () => {
    const text = zimArticleToSegments('<p>a<sup/>b<sub/>c</p>')
      .segments.map((s) => s.text)
      .join('\n')
    expect(text).toBe('abc')
  })

  it('a plain prose <sup> nested inside a dropped mw-ref <sup> does not leak the rest of the citation (issue #488)', () => {
    const text = zimArticleToSegments('<p>1<sup class="mw-ref">[x<sup>2</sup>]leak</sup>tail</p>')
      .segments.map((s) => s.text)
      .join('\n')
    expect(text).toBe('1tail')
    expect(text).not.toContain('leak')
    expect(text).not.toContain('^')
  })

  it('emits each formula once, normalised to plain text', () => {
    const hits = all.match(/S\+O2→SO2/g) ?? []
    expect(hits).toHaveLength(1)
    expect(all).not.toContain('\\displaystyle')
    expect(all).not.toContain('MJX-TeXAtom') // MathML internals never leak
  })

  it('delivers a kept table (its header and data reach the text), inlining its nested table, and delivers a figure caption while still dropping its image', () => {
    // The infobox table (a header cell, so it clears the structural drop test) is now
    // delivered instead of dropped — table delivery, issue: deliver tables to the model.
    expect(all).toContain('Infobox-Zelle')
    expect(all).toContain('Tabelleninhalt darf nicht erscheinen')
    // Its NESTED table is INLINED into the parent cell (not dropped): real Wikipedia infoboxes
    // commonly nest the actual data table one level inside a layout wrapper (the chemical-
    // element infobox is exactly this shape), so dropping every nested table would drop the
    // very content this feature exists to deliver. Emitted exactly once, never duplicated.
    expect(all).toContain('verschachtelte Zelle')
    expect(all.match(/verschachtelte Zelle/g) ?? []).toHaveLength(1)
    // A figure's caption text now reaches its own segment, labelled the same way a table's
    // own <caption> is; the image itself (and its alt text) stays dropped with the rest of
    // the figure subtree.
    expect(all).toContain('Caption: Ansicht der Anlage von außen')
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
// Figure captions: a <figure>'s whole subtree is dropped (image and caption alike), except
// that its <figcaption> text is captured into its own "Caption: " segment -- the same
// labelling and flush-first order the kept-table path already uses for a table's own
// <caption>. The image, its alt text, and everything else in the figure subtree stay dropped.
// ---------------------------------------------------------------------------------------
describe('zimArticleToSegments — figure captions', () => {
  const textOf = (html: string): string =>
    zimArticleToSegments(html)
      .segments.map((s) => s.text)
      .join('\n')

  it('captures a figcaption as its own "Caption: " segment while the image and its alt stay dropped', () => {
    const html =
      '<p>lead prose.</p>' +
      '<figure><img src="x.jpg" alt="alt-text-must-not-appear"><figcaption>Simple caption</figcaption></figure>' +
      '<p>tail prose.</p>'
    const article = zimArticleToSegments(html)
    const captionSegment = article.segments.find((s) => s.text.startsWith('Caption:'))
    expect(captionSegment?.text).toBe('Caption: Simple caption')
    const all = article.segments.map((s) => s.text).join('\n')
    expect(all).not.toContain('alt-text-must-not-appear')
    expect(all).toContain('lead prose')
    expect(all).toContain('tail prose')
  })

  it('a figcaption containing an inline tag and an entity is decoded and tidied like ordinary text', () => {
    const html = '<figure><img src="x.jpg"><figcaption>A caption with <b>bold</b> text &amp; more</figcaption></figure>'
    expect(textOf(html)).toContain('Caption: A caption with bold text & more')
  })

  it('a dropped subtree (svg) nested inside an open figcaption does not leak its text into the caption', () => {
    const html =
      '<figure><figcaption>before <svg><text>svg-leak-must-not-appear</text></svg> after</figcaption></figure>'
    const text = textOf(html)
    expect(text).toContain('Caption: before after')
    expect(text).not.toContain('svg-leak-must-not-appear')
  })

  it('a figcaption inside a dropped subtree (svg) that opened BEFORE any caption never starts ' +
    'a capture: only the figure\'s own caption is delivered', () => {
    const html =
      '<figure><svg><figcaption>svg-inner-caption</figcaption></svg>' +
      '<figcaption>real caption</figcaption></figure>'
    const article = zimArticleToSegments(html)
    expect(article.segments.map((s) => s.text)).toEqual(['Caption: real caption'])
  })

  it('a figure nested inside a figure keeps its own figcaption -- the guard only arms for ' +
    'non-figure skipped subtrees, so a nested <figure> neither arms nor disarms it', () => {
    const html =
      '<figure><img src="a.jpg"><figcaption>outer caption</figcaption>' +
      '<figure><img src="b.jpg"><figcaption>inner caption</figcaption></figure></figure>'
    const article = zimArticleToSegments(html)
    const captions = article.segments.map((s) => s.text).filter((t) => t.startsWith('Caption:'))
    expect(captions).toEqual(['Caption: outer caption', 'Caption: inner caption'])
    const all = article.segments.map((s) => s.text).join('\n')
    expect(all).not.toMatch(/alt|\.jpg/)
  })

  it('the guard still works INSIDE a nested figure: an svg opened inside the inner figure ' +
    'suppresses only that svg\'s own figcaption, not the inner figure\'s real one', () => {
    const html =
      '<figure><figcaption>outer</figcaption>' +
      '<figure><svg><figcaption>svg-inner-must-not-appear</figcaption></svg>' +
      '<figcaption>inner</figcaption></figure></figure>'
    const article = zimArticleToSegments(html)
    const captions = article.segments.map((s) => s.text).filter((t) => t.startsWith('Caption:'))
    expect(captions).toEqual(['Caption: outer', 'Caption: inner'])
    const all = article.segments.map((s) => s.text).join('\n')
    expect(all).not.toContain('svg-inner-must-not-appear')
  })

  it('a self-closing <figcaption/> inside an open caption neither ends the caption early nor ' +
    'drops the rest of it', () => {
    const html = '<figure><figcaption>part one <figcaption/> part two</figcaption></figure>'
    const article = zimArticleToSegments(html)
    expect(article.segments.map((s) => s.text)).toEqual(['Caption: part one part two'])
  })

  it('multiple figcaptions in the same figure are each captured as their own segment', () => {
    const html =
      '<figure><figcaption>first caption</figcaption><img src="x.jpg"><figcaption>second caption</figcaption></figure>'
    const article = zimArticleToSegments(html)
    const captions = article.segments.map((s) => s.text).filter((t) => t.startsWith('Caption:'))
    expect(captions).toEqual(['Caption: first caption', 'Caption: second caption'])
  })

  it('a figcaption outside any figure is ordinary prose, untouched by this change', () => {
    const html = '<p>lead</p><figcaption>a naked figcaption</figcaption><p>tail</p>'
    const text = textOf(html)
    expect(text).toContain('a naked figcaption')
    expect(text).not.toContain('Caption:')
  })

  it('an empty or whitespace-only figcaption emits no caption segment at all', () => {
    const html = '<figure><img src="x.jpg"><figcaption>   </figcaption></figure>'
    const article = zimArticleToSegments(html)
    expect(article.segments.some((s) => s.text.startsWith('Caption:'))).toBe(false)
  })

  it('a caption longer than the table segment cap (1,500 characters) is truncated, never thrown', () => {
    const html = `<figure><figcaption>${'x'.repeat(2000)}</figcaption></figure>`
    expect(() => zimArticleToSegments(html)).not.toThrow()
    const article = zimArticleToSegments(html)
    const captionSegment = article.segments.find((s) => s.text.startsWith('Caption:'))
    expect(captionSegment?.text.length).toBeLessThanOrEqual('Caption: '.length + 1500)
  })

  it('an unterminated figcaption/figure at EOF is total -- never throws, no caption segment', () => {
    const html = '<p>lead</p><figure><figcaption>never closes'
    expect(() => zimArticleToSegments(html)).not.toThrow()
    const text = textOf(html)
    expect(text).toContain('lead')
  })

  it("MediaWiki's div.thumbcaption sitting OUTSIDE a <figure> is ordinary prose already, " +
    'unaffected by this change (no double delivery)', () => {
    const html = '<div class="thumb"><div class="thumbcaption">already delivered as prose</div></div>'
    const article = zimArticleToSegments(html)
    const all = article.segments.map((s) => s.text).join('\n')
    expect(all).toContain('already delivered as prose')
    // Exactly once: this class-based path is untouched, so there is no second, duplicate
    // delivery mechanism for the same text.
    expect(all.match(/already delivered as prose/g) ?? []).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------
// Table delivery (issue: deliver tables to the model instead of dropping them). A kept table
// is parsed into a bounded grid and rendered as one line per data row, `key: value; key:
// value`, keyed by the nearest header row above (2g's research-prototype convention, ported
// fresh — see tables.ts). Layout/navbox tables are unaffected; a figure's caption text now
// reaches its own segment (see the "figure captions" describe above) while everything else in
// the figure subtree stays dropped, exactly as before.
// ---------------------------------------------------------------------------------------
describe('zimArticleToSegments — table delivery', () => {
  const textOf = (html: string): string =>
    zimArticleToSegments(html)
      .segments.map((s) => s.text)
      .join('\n')

  it('delivers a simple table as key: value lines', () => {
    const html = '<table><tr><th>Name</th><th>Value</th></tr><tr><td>Density</td><td>19.3</td></tr></table>'
    expect(textOf(html)).toContain('Name: Density; Value: 19.3')
  })

  it('expands rowspan across the rows it covers', () => {
    const html =
      '<table><tr><th>Group</th><th>Item</th></tr>' +
      '<tr><td rowspan="2">Metals</td><td>Gold</td></tr>' +
      '<tr><td>Silver</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('Group: Metals; Item: Gold')
    expect(text).toContain('Group: Metals; Item: Silver')
  })

  it('expands colspan within a row', () => {
    const html =
      '<table><tr><th>A</th><th>B</th><th>C</th></tr>' +
      '<tr><td colspan="2">wide</td><td>solo</td></tr></table>'
    expect(textOf(html)).toContain('A: wide; B: wide; C: solo')
  })

  it('combined rowspan and colspan expand into every grid position they cover', () => {
    const html =
      '<table><tr><th>A</th><th>B</th><th>C</th></tr>' +
      '<tr><td rowspan="2" colspan="2">big</td><td>x1</td></tr>' +
      '<tr><td>x2</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('A: big; B: big; C: x1')
    expect(text).toContain('A: big; B: big; C: x2')
  })

  it('a multi-row header: a narrower header row below a group header wins the column key, ' +
    'the group header is never glued onto the value (the defect this fixes)', () => {
    const html =
      '<table>' +
      '<tr><th colspan="2">Eigenschaften</th></tr>' +
      '<tr><th>Dichte</th><th>Schmelzpunkt</th></tr>' +
      '<tr><td>19,32 g/cm<sup>3</sup></td><td>1064,18 &#176;C</td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toContain('Dichte: 19,32 g/cm^3; Schmelzpunkt: 1064,18 °C')
    // The specific defect this replaces: the group header repeated onto every covered cell
    // ("Eigenschaften: Dichte | Eigenschaften: 19,32 g/cm3 | ...").
    expect(text).not.toContain('Eigenschaften')
  })

  it('a mid-table header row rebinds the column keys for the rows below it', () => {
    const html =
      '<table>' +
      '<tr><th>City</th><th>Population</th></tr>' +
      '<tr><td>Berlin</td><td>3.7M</td></tr>' +
      '<tr><th>City</th><th>Area</th></tr>' +
      '<tr><td>Munich</td><td>310 km2</td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toContain('City: Berlin; Population: 3.7M')
    expect(text).toContain('City: Munich; Area: 310 km2')
    expect(text).not.toContain('City: Munich; Population: 310 km2')
  })

  it('a nested table is inlined into the parent cell, emitted exactly once (never dropped, never duplicated)', () => {
    const html =
      '<table><tr><th>Outer</th></tr>' +
      '<tr><td><table><tr><th>Inner</th><td>nested-value</td></tr></table></td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('nested-value')
    expect(text.match(/nested-value/g) ?? []).toHaveLength(1)
  })

  it('a table nested deeper than the safety cap is dropped, not inlined (pathological input)', () => {
    let html = '<table><tr><td>'
    for (let i = 0; i < 12; i += 1) html += `<table><tr><td>depth${i}`
    html += '</td></tr></table>'.repeat(12) + '</td></tr></table>'
    expect(() => zimArticleToSegments(html)).not.toThrow()
    // At least the deepest levels (beyond the cap) must not survive as inlined text; the exact
    // cutoff is an implementation constant, not part of the contract.
    const text = textOf(html)
    expect(text).not.toContain('depth11')
  })

  it('a caption is emitted once, identifiably', () => {
    const html = '<table><caption>Physical properties</caption><tr><th>Name</th><td>Gold</td></tr></table>'
    const text = textOf(html)
    const hits = text.match(/Caption: Physical properties/g) ?? []
    expect(hits).toHaveLength(1)
  })

  it.each(['navbox', 'vertical-navbox', 'metadata', 'ambox', 'toc', 'sistersitebox'])(
    'still drops a layout table classed "%s", header cell notwithstanding',
    (cls) => {
      const html = `<table class="${cls}"><tr><th>Nav</th><td>navdata-must-not-appear</td></tr></table>`
      expect(textOf(html)).not.toContain('navdata-must-not-appear')
    }
  )

  it('drops a table with no header cell and no real tabular content (single column, no header)', () => {
    const html = '<table><tr><td>layout-wrapper-must-not-appear</td></tr></table>'
    expect(textOf(html)).not.toContain('layout-wrapper-must-not-appear')
  })

  it('keeps a single-column table that DOES carry a header cell', () => {
    const html = '<table><tr><th>Name</th></tr><tr><td>single-col-should-appear</td></tr></table>'
    expect(textOf(html)).toContain('single-col-should-appear')
  })

  it('keeps a headerless table once it has real (>=2 column) tabular content', () => {
    const html = '<table><tr><td>two-col-a</td><td>two-col-b</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('two-col-a')
    expect(text).toContain('two-col-b')
  })

  it('a CDATA section inside a kept table cell does not leak past a bare ">" inside it ' +
    '(issue #493)', () => {
    const html = '<table><tr><th>A</th><td><![CDATA[cdata-leak > must-not-appear]]></td></tr></table>'
    const text = textOf(html)
    expect(text).not.toContain('cdata-leak')
    expect(text).not.toContain('must-not-appear')
    expect(text).not.toContain('CDATA[')
    expect(text).not.toContain(']]>')
  })

  it('an unterminated CDATA section inside a table is total -- never throws', () => {
    const html = '<table><tr><th>A</th><td>lead<![CDATA[never closes'
    expect(() => zimArticleToSegments(html)).not.toThrow()
    expect(textOf(html)).toContain('lead')
  })

  // The two tests below pin a measured trade-off rather than a fix. A structural rule that
  // dropped a headerless table as page layout whenever one of its cells held only an image was
  // written, measured on the offline corpus, and withdrawn: across 1,437 articles it removed
  // three tables, and one of them was a travel-notice box whose warning text and advisory list
  // are content, not layout. Both shapes are therefore DELIVERED today, deliberately, and these
  // tests exist so the next attempt at such a rule has to break them on purpose.

  it('delivers a headerless notice box laid out as a table -- an icon cell beside the notice ' +
    'and a row of advisory text -- with every one of its lines (the shape a withdrawn ' +
    'image-only-cell drop rule was measured to remove)', () => {
    const html =
      '<table>' +
      '<tr><td rowspan="3"><img src="notice-icon.png"></td>' +
      '<td><b>NOTICE:</b> a standing advisory applies to this whole region.</td></tr>' +
      '<tr><td>Official advisory sources' +
      '<ul><li>Source one</li><li>Source two</li><li>Source three</li></ul></td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toContain('NOTICE: a standing advisory applies to this whole region.')
    expect(text).toContain('Official advisory sources')
    expect(text).toContain('Source one')
    expect(text).toContain('Source two')
    expect(text).toContain('Source three')
  })

  it("delivers issue #487's own image-and-caption wrapper shape too -- a known limitation kept " +
    'open on purpose, because the structural rule that would drop it also removes notice ' +
    'boxes (see the test above)', () => {
    const html = '<table style="float:right"><tr><td><img src="x.jpg"></td><td>caption text</td></tr></table>'
    expect(textOf(html)).toContain('caption text')
  })

  it('still delivers a genuine two-column data table that also has an image cell in one row ' +
    '(the per-row structural fallback judges the table, never the single image cell)', () => {
    const html =
      '<table>' +
      '<tr><td><img src="diagram.png"></td><td>a diagram</td></tr>' +
      '<tr><td>Length</td><td>12 m</td></tr>' +
      '<tr><td>Width</td><td>4 m</td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toContain('Length: 12 m')
    expect(text).toContain('Width: 4 m')
  })

  it('preserves superscripts/subscripts readably inside table-derived text only', () => {
    const html =
      '<table><tr><th>Metric</th><th>Value</th></tr>' +
      '<tr><td>Density</td><td>19,32 g/cm<sup>3</sup></td></tr>' +
      '<tr><td>Formula</td><td>10<sup>6</sup></td></tr>' +
      '<tr><td>Compound</td><td>H<sub>2</sub>O</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('g/cm^3')
    expect(text).toContain('10^6')
    expect(text).toContain('H_2O')
    expect(text).not.toContain('g/cm3')
    expect(text).not.toMatch(/\b106\b/)
  })

  it('still drops an <sup class="mw-ref"> citation bracket inside a table cell', () => {
    const html =
      '<table><tr><th>Metric</th><th>Value</th></tr>' +
      '<tr><td>Density</td><td>19,32<sup class="mw-ref">[1]</sup></td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('Metric: Density; Value: 19,32')
    expect(text).not.toContain('[1]')
    expect(text).not.toContain('19,32^')
  })

  it('a table beyond the source-row cap is cut and says so in its own text', () => {
    // Terse rows so the row-count cap is what cuts the table, not the char/segment caps
    // below (a longer per-row text would hit those first — both caps are real and can
    // interact, but this case isolates the row cap).
    const rowCount = TABLE_MAX_SOURCE_ROWS + 50
    const rows = Array.from({ length: rowCount }, (_, i) => `<tr><td>${i}</td><td>x</td></tr>`)
    const html = `<table><tr><th>A</th><th>B</th></tr>${rows.join('')}</table>`
    const text = textOf(html)
    // The header row also counts against the cap, so exactly TABLE_MAX_SOURCE_ROWS - 1 data
    // rows are parsed and shown.
    const shown = TABLE_MAX_SOURCE_ROWS - 1
    expect(text).toContain(`A: ${shown - 1};`)
    expect(text).not.toContain(`A: ${shown};`)
    expect(text).toMatch(new RegExp(`\\[Rows 1-${shown} of ${rowCount + 1} source rows shown\\]`))
  })

  it('a table whose serialisation exceeds the segment/char caps is split, then cut, with the cut marked', () => {
    const rowCount = 200
    const rows = Array.from(
      { length: rowCount },
      (_, i) => `<tr><td>Item${i}</td><td>${'x'.repeat(60)}</td></tr>`
    )
    const html = `<table><tr><th>Label</th><th>Value</th></tr>${rows.join('')}</table>`
    const article = zimArticleToSegments(html)
    const tableSegments = article.segments.filter((s) => s.text.includes('Label:'))
    expect(tableSegments.length).toBe(TABLE_MAX_SEGMENTS)
    for (const s of tableSegments) expect(s.text.length).toBeLessThanOrEqual(TABLE_SEGMENT_MAX_CHARS + 80)
    const all = article.segments.map((s) => s.text).join('\n')
    // Not every row can have survived TABLE_MAX_SEGMENTS segments of TABLE_SEGMENT_MAX_CHARS.
    expect(all).not.toContain(`Item${rowCount - 1}`)
    expect(all).toMatch(/source rows shown\]/)
  })

  it('caps rowspan and colspan (named constants, pinned by value)', () => {
    expect(TABLE_MAX_ROWSPAN).toBe(40)
    expect(TABLE_MAX_COLSPAN).toBe(24)
    expect(TABLE_MAX_SOURCE_ROWS).toBe(400)
    expect(TABLE_SEGMENT_MAX_CHARS).toBe(1500)
    expect(TABLE_MAX_SEGMENTS).toBe(4)
    const html =
      '<table><tr><th>A</th></tr><tr><td rowspan="9999">huge</td></tr>' +
      Array.from({ length: 60 }, () => '<tr><td>filler</td></tr>').join('') +
      '</table>'
    // A rowspan far beyond the cap must not throw or hang; the cap silently bounds it.
    expect(() => zimArticleToSegments(html)).not.toThrow()
  })

  it('is total on junk table input: an unterminated tag inside a cell must not throw', () => {
    expect(() => zimArticleToSegments('<table><tr><td>x<b')).not.toThrow()
    expect(() => zimArticleToSegments('<table><tr><th>h<td>x')).not.toThrow()
  })

  it('the table segment renders sensibly through the same section-mapping readArticle (zim/index.ts) uses', () => {
    // Mirrors readArticle's own transform: the heading is rendered as the section label, so
    // its duplicate first line is dropped from the segment text. The table now appears in the
    // viewer/saved article, same as the packer sees it: readable text, no leftover markup.
    const html =
      '<h1>T</h1><section><div class="mw-heading mw-heading2"><h2>Facts</h2></div>' +
      '<p>Intro.</p><table><tr><th>Name</th><th>Value</th></tr>' +
      '<tr><td>Density</td><td>19,32 g/cm<sup>3</sup></td></tr></table></section>'
    const article = zimArticleToSegments(html)
    const sections = article.segments.map((s) => {
      let text = s.text
      if (s.sectionLabel && text.startsWith(s.sectionLabel)) {
        text = text.slice(s.sectionLabel.length).replace(/^\n+/, '')
      }
      return { label: s.sectionLabel ?? null, text }
    })
    const tableSection = sections.find((s) => s.text.includes('Density'))
    expect(tableSection).toBeTruthy()
    expect(tableSection?.text).not.toMatch(/<[a-z]/i)
    expect(tableSection?.text).toContain('g/cm^3')
  })

  // -------------------------------------------------------------------------------------
  // Row-header keying (issue #478). An infobox's commonest shape --
  // `<tr><th>Dichte</th><td>19,32</td></tr>` -- is a MIXED row (its `<th>` is not a header
  // ROW), so it used to fall back to `Column 1: Dichte; Column 2: 19,32` instead of using its
  // own leading header cell as the key.
  // -------------------------------------------------------------------------------------
  it('a row-header row (a mixed <th>/<td> row, the commonest infobox shape) is keyed by its ' +
    'own leading header cell, never "Column N"', () => {
    const html = '<table><tr><th>Dichte</th><td>19,32 g/cm<sup>3</sup></td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('Dichte: 19,32 g/cm^3')
    expect(text).not.toContain('Column 1')
    expect(text).not.toContain('Column 2')
  })

  it('the reviewer’s exact reproducing shape: a nested row-header table inside a ' +
    'header-only wrapper renders "Gold: Dichte: 19,32", not "Gold: Column 1: ... Column 2: ..."', () => {
    const html =
      '<table><tr><th>Gold</th></tr>' +
      '<tr><td><table><tr><th>Dichte</th><td>19,32</td></tr></table></td></tr></table>'
    expect(textOf(html)).toContain('Gold: Dichte: 19,32')
  })

  it('a row’s own leading header cell wins over a wider section-grouping header row ' +
    'above it (the real Wikipedia infobox shape: a spanning "Physikalisch" row followed by ' +
    'per-row <th>label</th><td>value</td> rows, none of which should be re-keyed "Physikalisch")', () => {
    const html =
      '<table>' +
      '<tr><th colspan="2">Physikalisch</th></tr>' +
      '<tr><th>Dichte</th><td>19,32 g/cm<sup>3</sup></td></tr>' +
      '<tr><th>Schmelzpunkt</th><td>1064,18 &#176;C</td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toContain('Dichte: 19,32 g/cm^3')
    expect(text).toContain('Schmelzpunkt: 1064,18 °C')
    expect(text).not.toContain('Physikalisch: Dichte')
    expect(text).not.toContain('Physikalisch: 19,32')
  })

  it('a row’s own leading header cell does NOT win over real column headers above it -- ' +
    'the commonest sortable Wikipedia table (row-label column under real column headers) ' +
    'keys every cell by its own column, never by repeating the row label (issue #478)', () => {
    const html =
      '<table><tr><th>Country</th><th>Capital</th><th>Population</th></tr>' +
      '<tr><th scope="row">France</th><td>Paris</td><td>68</td></tr>' +
      '<tr><th scope="row">Spain</th><td>Madrid</td><td>47</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('Country: France; Capital: Paris; Population: 68')
    expect(text).toContain('Country: Spain; Capital: Madrid; Population: 47')
    // The regression this fixes: the row's own header used to win unconditionally, discarding
    // every real column header and repeating the row label as every cell's key.
    expect(text).not.toContain('France: Paris')
    expect(text).not.toContain('France: 68')
  })

  it('the shapes the row-header/group-label rule exists for stay unaffected by the fix above: ' +
    'a group label (spanning 2 or 3 columns, or a single un-spanned header cell) still yields ' +
    'to the row’s own leading header when NO column above genuinely keys the row', () => {
    // <th colspan=2> group header, no genuine column header below it.
    expect(textOf('<table><tr><th colspan="2">Physikalisch</th></tr>' +
      '<tr><th>Dichte</th><td>19,32</td></tr></table>')).toBe('Dichte: 19,32')
    // A single, un-spanned header cell above a row-header row.
    expect(textOf('<table><tr><th>Physikalisch</th></tr>' +
      '<tr><th>Dichte</th><td>19,32</td></tr></table>')).toBe('Dichte: 19,32')
    // <th colspan=3> group header over a 3-cell row-header row.
    expect(textOf('<table><tr><th colspan="3">Physikalisch</th></tr>' +
      '<tr><th>Dichte</th><td>19,32</td><td>g/cm3</td></tr></table>'))
      .toBe('Dichte: 19,32; Dichte: g/cm3')
    // No header row at all above the row-header row.
    expect(textOf('<table><tr><th>Dichte</th><td>19,32</td></tr></table>')).toBe('Dichte: 19,32')
  })

  // -------------------------------------------------------------------------------------
  // A spanning group header over PLAIN `<td>` label/value rows (no `<th>` of the row's own at
  // all) -- the real German-Wikipedia "Gold" infobox shape, and the defect a pre-read review
  // found on this feature's own flagship demonstration: the group header was glued onto BOTH
  // covered columns as their literal per-cell key on every row ("Physikalisch: Dichte;
  // Physikalisch: 19,32 g/cm3 …", issue #478). Two groups, to pin that the group label rebinds
  // per group and is never carried over into the next one.
  // -------------------------------------------------------------------------------------
  it('a spanning <th colspan=2> group header over plain <td>/<td> rows keys each row once, ' +
    'as "Group — Label: Value", never repeated onto both cells', () => {
    const html =
      '<table>' +
      '<tr><th colspan="2">Physikalisch</th></tr>' +
      '<tr><td>Dichte</td><td>gemessen: 19,32 g/cm<sup>3</sup> (20 &#176;C); berechnet: 19,302 g/cm<sup>3</sup></td></tr>' +
      '<tr><td>Schmelzpunkt</td><td>1337,33 K (1064,18 &#176;C)</td></tr>' +
      '<tr><th colspan="2">Chemisch</th></tr>' +
      '<tr><td>Symbol</td><td>Au</td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toContain('Physikalisch — Dichte: gemessen: 19,32 g/cm^3 (20 °C); berechnet: 19,302 g/cm^3')
    expect(text).toContain('Physikalisch — Schmelzpunkt: 1337,33 K (1064,18 °C)')
    expect(text).toContain('Chemisch — Symbol: Au')
    // The defect this replaces, on the exact reproducing values: the group name must never be
    // glued onto BOTH covered cells of the same row.
    expect(text).not.toContain('Physikalisch: Dichte')
    expect(text).not.toContain('Physikalisch: gemessen')
    expect(text).not.toContain('Physikalisch: Schmelzpunkt')
    expect(text).not.toContain('Physikalisch: 1337,33')
    // No output line contains its own group label twice.
    for (const line of text.split('\n')) {
      const hits = line.split('Physikalisch').length - 1
      expect(hits).toBeLessThanOrEqual(1)
    }
    // The label rebinds per group: "Chemisch" never leaks onto the "Physikalisch" rows and
    // vice versa.
    expect(text).not.toContain('Chemisch — Dichte')
    expect(text).not.toContain('Physikalisch — Symbol')
  })

  it('a spanning group header over a row with MORE than two cells and no narrower headers ' +
    'joins the cells un-keyed under the one group label, instead of inventing "Column N"', () => {
    const html =
      '<table>' +
      '<tr><th colspan="3">Measurements</th></tr>' +
      '<tr><td>A</td><td>B</td><td>C</td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toBe('Measurements: A; B; C')
    expect(text).not.toContain('Column 1')
    expect(text).not.toContain('Column 2')
    expect(text).not.toContain('Column 3')
    // The group label appears exactly once, not once per covered column.
    expect(text.split('Measurements').length - 1).toBe(1)
  })

  it('regression: a real per-column header row (narrow, one column each) still keys each ' +
    'column individually -- the group-record rule only applies when no covered column has a ' +
    'genuine (non-group) header of its own', () => {
    const html =
      '<table><tr><th>Name</th><th>Value</th></tr><tr><td>Density</td><td>19.3</td></tr></table>'
    expect(textOf(html)).toBe('Name: Density; Value: 19.3')
  })

  // -------------------------------------------------------------------------------------
  // A single source cell whose `colspan` covers every one of a row's columns (a full-width
  // note or sub-heading row) is a plain sentence, not parallel key/value pairs -- it must be
  // emitted exactly once, never once per covered column, and never as the meaningless "X: X"
  // (issue #478).
  // -------------------------------------------------------------------------------------
  it('a full-width colspan note row under a 2-column row-header table is emitted once, ' +
    'un-keyed, never as "Hinweis zur Messung: Hinweis zur Messung"', () => {
    const html =
      '<table><tr><th>A</th><td>1</td></tr>' +
      '<tr><td colspan="2">Hinweis zur Messung</td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('A: 1\nHinweis zur Messung')
    expect(text).not.toContain('Hinweis zur Messung: Hinweis zur Messung')
  })

  it('a full-width colspan note row under real column headers is emitted once, un-keyed, ' +
    'never as "K: Note; V: Note"', () => {
    const html =
      '<table><tr><th>K</th><th>V</th></tr>' +
      '<tr><td>a</td><td>1</td></tr>' +
      '<tr><td colspan="2">Note</td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('K: a; V: 1\nNote')
    expect(text).not.toContain('K: Note')
    expect(text).not.toContain('V: Note')
  })

  it('a full-width colspan note row under a group-labelled infobox is emitted once, ' +
    'optionally under the group label, never doubled onto every covered column', () => {
    const html =
      '<table><tr><th colspan="2">Physikalisch</th></tr>' +
      '<tr><td>Dichte</td><td>19,32</td></tr>' +
      '<tr><td colspan="2">Anmerkung zur Messung</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('Physikalisch — Dichte: 19,32')
    expect(text).toContain('Physikalisch — Anmerkung zur Messung')
    expect(text).not.toContain('Anmerkung zur Messung: Anmerkung zur Messung')
  })

  it('a 2-column numeric series under a group label is unaffected (two genuinely distinct ' +
    'source cells, not one spanning cell, so the group-record label/value form still applies)', () => {
    const html =
      '<table><tr><th colspan="2">Messwerte</th></tr>' +
      '<tr><td>1990</td><td>12,4</td></tr></table>'
    expect(textOf(html)).toBe('Messwerte — 1990: 12,4')
  })

  it('the article.html infobox row (a real fixture, not a synthetic one) is keyed exactly, ' +
    'not "Column 1: ... Column 2: ..." (pins the exact rendering shape, not just presence)', () => {
    const fixtureText = zimArticleToSegments(FIXTURE).segments.map((s) => s.text).join('\n\n')
    expect(fixtureText).toContain('Infobox-Zelle: Tabelleninhalt darf nicht erscheinen')
  })

  // -------------------------------------------------------------------------------------
  // Nested data table inside a headerless single-column wrapper (issue #478).
  // -------------------------------------------------------------------------------------
  it('a nested REAL table inside a headerless, single-column wrapper is still delivered -- ' +
    'the wrapper is layout, the data one level inside it is not', () => {
    const html =
      '<table><tr><td>' +
      '<table><tr><th>Dichte</th><td>19,32 g/cm<sup>3</sup></td></tr>' +
      '<tr><th>Schmelzpunkt</th><td>1064,18 &#176;C</td></tr></table>' +
      '</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('Dichte: 19,32 g/cm^3')
    expect(text).toContain('Schmelzpunkt: 1064,18 °C')
  })

  it('a headerless single-column wrapper around a nested table that is ITSELF not real ' +
    'tabular content (no header, one column) is still dropped', () => {
    const html = '<table><tr><td><table><tr><td>still-layout-must-not-appear</td></tr></table></td></tr></table>'
    expect(textOf(html)).not.toContain('still-layout-must-not-appear')
  })

  // -------------------------------------------------------------------------------------
  // A layout/navbox table NESTED inside an otherwise-kept table is dropped by the same
  // classifier that already drops one at top level, not inlined (issue #478).
  // -------------------------------------------------------------------------------------
  it('a navbox nested inside a kept table is dropped, not inlined -- the classifier applies ' +
    'at every nesting depth, not only to the outermost table', () => {
    const html =
      '<table><tr><th>Data</th><td>x</td></tr>' +
      '<tr><td>see <table class="navbox"><tr><th>Nav</th><td>junk1</td></tr>' +
      '<tr><th>N2</th><td>junk2</td></tr></table></td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('Data: x')
    expect(text).not.toContain('junk1')
    expect(text).not.toContain('junk2')
    expect(text).not.toContain('Nav')
  })

  it('an ambox maintenance box nested inside a lead-table cell is dropped, not inlined, ' +
    'and does not corrupt the row it was nested in', () => {
    const html =
      '<table><tr><th>D</th><td>1</td></tr>' +
      '<tr><td colspan="2"><table class="ambox"><tr><th>Warn</th>' +
      '<td>Dieser Artikel ist unvollständig</td></tr></table></td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('D: 1')
    expect(text).not.toContain('unvollständig')
    expect(text).not.toContain('Warn')
  })

  // -------------------------------------------------------------------------------------
  // Adjacent nested-table inline text, and a nested table sitting inside running prose, must
  // not be concatenated with no separator (issue #478).
  // -------------------------------------------------------------------------------------
  it('two sibling nested tables in the same cell join with "; ", never run together', () => {
    const html =
      '<table><tr><td>' +
      '<table><tr><th>Dichte</th><td>19,32</td></tr></table>' +
      '<table><tr><th>Schmelz</th><td>1064</td></tr></table>' +
      '</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('Dichte: 19,32; Schmelz: 1064')
    expect(text).not.toContain('19,32Schmelz')
  })

  it('a nested table sitting inside running prose is separated from the surrounding text by ' +
    'a space on both sides, never glued onto it', () => {
    const html =
      '<table><tr><th>A</th><td>vor<table><tr><th>N</th><td>1</td></tr></table>nach</td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('A: vor N: 1 nach')
    expect(text).not.toContain('vorN')
    expect(text).not.toContain('1nach')
  })

  // -------------------------------------------------------------------------------------
  // A rowspan overhanging the table's last real row (issue #478).
  // -------------------------------------------------------------------------------------
  it('a rowspan overhanging the last source row is clamped, not padded with phantom rows', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>x</td><td rowspan="6">y</td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('A: x; B: y')
    expect(text.match(/B: y/g) ?? []).toHaveLength(1)
  })

  // -------------------------------------------------------------------------------------
  // A single record line longer than the segment cap is hard-split (issue #478).
  // -------------------------------------------------------------------------------------
  it('a single record line longer than TABLE_SEGMENT_MAX_CHARS is hard-split, not emitted whole', () => {
    const html = `<table><tr><th>A</th><th>B</th></tr><tr><td>k</td><td>${'v'.repeat(5000)}</td></tr></table>`
    // No other content in this document, so every segment produced is a piece of the one
    // (hard-split) table record line — the first piece carries "A: k", the rest are pure
    // continuations of the long value and would not match a filter on the row's own key.
    const tableSegments = zimArticleToSegments(html).segments
    expect(tableSegments.length).toBeGreaterThan(1)
    for (const s of tableSegments) expect(s.text.length).toBeLessThanOrEqual(TABLE_SEGMENT_MAX_CHARS + 80)
    expect(tableSegments[0]?.text).toContain('A: k')
    expect(tableSegments.some((s) => s.text.includes('[cut]'))).toBe(true)
    // Nothing is silently dropped: every piece of the original 5,000-char value still appears,
    // in order, across the split segments (minus the cut markers between pieces).
    const rebuilt = tableSegments.map((s) => s.text.replace(/ \[cut\]$/, '')).join('')
    expect(rebuilt).toContain('v'.repeat(500))
  })

  it('a hard-split never cuts inside a UTF-16 surrogate pair -- every emitted segment stays ' +
    'well-formed UTF-16, even when the over-long value is entirely astral characters', () => {
    // U+1F600 (an emoji) is a surrogate pair; 800 of them is 1,600 UTF-16 code units, well
    // past TABLE_SEGMENT_MAX_CHARS, with no '; ' pair boundary anywhere in the value at all.
    const html = `<table><tr><th>A</th><td>${'\u{1F600}'.repeat(800)}</td></tr></table>`
    const segments = zimArticleToSegments(html).segments
    expect(segments.length).toBeGreaterThan(1)
    for (const s of segments) expect(s.text.isWellFormed()).toBe(true)
    // Nothing is lost: reassembling the pieces (minus the cut markers) recovers every emoji.
    const rebuilt = segments.map((s) => s.text.replace(/ \[cut\]$/, '')).join('')
    expect([...rebuilt.matchAll(/\u{1F600}/gu)]).toHaveLength(800)
  })

  it('caps the columns and total grid cells a table may expand into (named constants, ' +
    'pinned by value) -- issue #478', () => {
    expect(TABLE_MAX_COLUMNS).toBe(60)
    expect(TABLE_MAX_GRID_CELLS).toBe(6_000)
    expect(TABLE_MAX_RAW_CHARS).toBe(50_000)
  })

  it('a row with more source cells than TABLE_MAX_COLUMNS is cut at the column cap, cut marked', () => {
    const cells = Array.from({ length: TABLE_MAX_COLUMNS + 20 }, (_, i) => `<td>c${i}</td>`).join('')
    const html = `<table><tr>${cells}</tr></table>`
    const text = textOf(html)
    expect(text).toContain(`c${TABLE_MAX_COLUMNS - 1}`)
    expect(text).not.toContain(`c${TABLE_MAX_COLUMNS + 10}`)
    expect(text).toMatch(/Some cells beyond the table's size caps were omitted/)
  })

  // -------------------------------------------------------------------------------------
  // A plain <br>, <p>, <div> or <li> inside a table cell (issue #478): one line
  // per data row is the contract, so an intra-cell break must not split it.
  // -------------------------------------------------------------------------------------
  it('an intra-cell <br> becomes a space, not a newline (one line per data row holds)', () => {
    const html = '<table><tr><th>A</th></tr><tr><td>line1<br>line2</td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('A: line1 line2')
  })

  // -------------------------------------------------------------------------------------
  // A ragged row's empty trailing pair carries no information (issue #478).
  // -------------------------------------------------------------------------------------
  it('a ragged row omits an empty trailing pair instead of emitting "C: "', () => {
    const html = '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('A: 1')
  })

  // -------------------------------------------------------------------------------------
  // A plain <sup> nested inside a dropped <sup class="mw-ref"> must not desynchronise the
  // skip depth and leak the rest of the citation (issue #478).
  // -------------------------------------------------------------------------------------
  it('a plain <sup> nested inside a dropped mw-ref <sup> does not leak the rest of the citation', () => {
    const html =
      '<table><tr><th>A</th></tr>' +
      '<tr><td>1<sup class="mw-ref">[x<sup>2</sup>]leak</sup>tail</td></tr></table>'
    const text = textOf(html)
    expect(text).toBe('A: 1tail')
    expect(text).not.toContain('leak')
    expect(text).not.toContain('[x')
  })

  // -------------------------------------------------------------------------------------
  // Determinism (brief §1's first bound), pinned directly rather than only relied upon
  // (issue #478).
  // -------------------------------------------------------------------------------------
  it('a table-heavy conversion is byte-identical across repeated runs on the same input', () => {
    const html =
      '<table><caption>Cap</caption><tr><th colspan="2">Group</th></tr>' +
      '<tr><th>K</th><th>V</th></tr>' +
      '<tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr>' +
      '<tr><th>Row</th><td>19,32 g/cm<sup>3</sup></td></tr></table>'
    const a = zimArticleToSegments(html)
    const b = zimArticleToSegments(html)
    expect(JSON.stringify(a.segments)).toBe(JSON.stringify(b.segments))
    expect(a.work).toBe(b.work)
  })

  // -------------------------------------------------------------------------------------
  // Two text leaks shipping with table delivery, fixed together (issues #485, #490):
  // a `<style>`/`<script>` body nested inside a kept table used to flow into the open cell
  // as ordinary text (nothing in `parseTableBody`'s tag vocabulary recognised them as
  // raw-text), and a `<math>` nested inside a kept table used to leak BOTH the MathML
  // presentation-character run and the raw TeX `<annotation>` source (no `<math>` branch
  // existed at all, so both halves fell through as plain transparent content) instead of
  // being routed through the same normalised-alttext-once path the prose scanner already
  // uses. A formula cell is often the value the table exists to deliver, so the fix routes
  // it, never drops it -- the doubling-fixed case below asserts the value survives exactly
  // once, not zero times.
  // -------------------------------------------------------------------------------------
  it('drops a <style> block nested inside a kept table (real German-Wikipedia shape, ' +
    'issue #485) -- the declaration text is in no emitted segment, the table\'s real ' +
    'records survive', () => {
    const html = readFileSync(join(__dirname, '../fixtures/zim/dewiki-table-style-leak.html'), 'utf8')
    const article = zimArticleToSegments(html)
    const text = article.segments.map((s) => s.text).join('\n')
    expect(text).not.toContain('fussnoten-marke')
    expect(text).not.toContain('font-style')
    expect(text).not.toContain('unicode-bidi')
    expect(text).not.toContain('TemplateStyles')
    expect(text).not.toMatch(/<[a-z][a-z0-9-]*[\s>]/i)
    expect(text).toContain('Eigenschaft: Kristallsystem; Wert: kubisch')
    expect(text).toContain('Eigenschaft: Dichte; Wert: 19,32 g/cm^3')
  })

  it('a <math> in a data cell (real shape, issue #490) is routed through the normalised ' +
    'alttext-once path -- reproducing and fixing the read\'s own "Formelzeichen: T ' +
    '{…displaystyle T}" doubling: the normalised description emitted once, no TeX ' +
    'source, no doubled presentation characters, and the formula\'s value surviving ' +
    '(the case that proves this is not a plain drop)', () => {
    const html = readFileSync(join(__dirname, '../fixtures/zim/dewiki-table-math-leak.html'), 'utf8')
    const article = zimArticleToSegments(html)
    const text = article.segments.map((s) => s.text).join('\n')
    expect(text).not.toContain('\\displaystyle')
    expect(text).not.toContain('annotation')
    expect(text).not.toMatch(/<[a-z][a-z0-9-]*[\s>]/i)
    // Exactly one standalone "T" survives from the formula (none of the surrounding German
    // prose contains a bare, word-bounded "T" of its own) -- two would mean the doubling
    // survived, zero would mean the fix regressed to a plain drop.
    expect(text.match(/\bT\b/g) ?? []).toHaveLength(1)
    expect(text).toContain('(für Angaben in Kelvin)')
  })

  it('a <math> with no alttext emits nothing but still suppresses its whole MathML subtree', () => {
    const html = '<table><tr><th>A</th><td>before<math><mi>T</mi></math>after</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('beforeafter')
    expect(text).not.toContain('T')
  })

  it('nested <math> is suppressed symmetrically -- the outer alttext survives once, ' +
    'nothing from the inner (or outer) presentation tree leaks', () => {
    const html =
      '<table><tr><th>A</th><td>' +
      '<math alttext="X"><mi>outer-leak<math><mi>inner-leak</mi></math>tail-leak</mi></math>' +
      '</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('X')
    expect(text).not.toContain('outer-leak')
    expect(text).not.toContain('inner-leak')
    expect(text).not.toContain('tail-leak')
  })

  it('a <math> inside a <caption> is routed through the same alttext-once path, never dropped', () => {
    const html = '<table><caption>Value: <math alttext="Y"><mi>Y</mi></math></caption>' +
      '<tr><th>A</th><td>b</td></tr></table>'
    const text = textOf(html)
    const captionLine = text.split('\n').find((l) => l.startsWith('Caption:'))
    expect(captionLine).toBeTruthy()
    expect(captionLine).toContain('Value:')
    expect(captionLine).toMatch(/\bY\b/)
  })

  it('drops <script>, <svg>, <noscript>, <template> and <figure> nested in a kept table, ' +
    'without leaking their content or breaking the table', () => {
    const html =
      '<table><tr><th>A</th><td>' +
      'lead<script>if (a < b) { document.write("script-leak") }</script>' +
      '<svg><text>svg-leak</text></svg>' +
      '<noscript>noscript-leak</noscript>' +
      '<template><b>template-leak</b></template>' +
      '<figure><figcaption>figure-leak</figcaption></figure>' +
      'tail</td></tr></table>'
    const text = textOf(html)
    expect(text).toContain('lead')
    expect(text).toContain('tail')
    for (const leaked of ['script-leak', 'svg-leak', 'noscript-leak', 'template-leak', 'figure-leak']) {
      expect(text).not.toContain(leaked)
    }
  })

  it('a comment containing a tag inside a table is not leaked; a plain comment is unchanged', () => {
    const html =
      '<table>' +
      '<tr><th>A</th><td>lead<!-- comment with a <b>tag</b> inside -->tail</td></tr>' +
      '<tr><th>A</th><td>lead2<!-- plain comment -->tail2</td></tr>' +
      '</table>'
    const text = textOf(html)
    expect(text).toContain('leadtail')
    expect(text).not.toContain('tag')
    expect(text).not.toContain('comment with a')
    expect(text).toContain('lead2tail2')
    expect(text).not.toContain('plain comment')
  })

  it('an unterminated <style> inside a table at EOF is total -- never throws -- ' +
    'beside the existing junk-input totality cases', () => {
    const html = '<table><tr><th>A</th><td>lead<style>.never{closed'
    expect(() => zimArticleToSegments(html)).not.toThrow()
    const text = textOf(html)
    expect(text).toContain('lead')
    expect(text).not.toContain('never')
  })

  it('an unterminated <script> inside a table at EOF is total -- never throws', () => {
    const html = '<table><tr><th>A</th><td>lead<script>var x = 1;'
    expect(() => zimArticleToSegments(html)).not.toThrow()
    const text = textOf(html)
    expect(text).toContain('lead')
    expect(text).not.toContain('var x')
  })
})

// ---------------------------------------------------------------------------------------
// Table cost pathology (issue #478): grid expansion and serialisation were
// previously unbounded and uncharged, so a small, plausible-looking input could cost seconds,
// tens of MB of text and gigabytes of heap in one uninterruptible slice. These are the
// reviewer's own crafted reproducing inputs (scaled to the caps now in force), asserted the
// H1 way -- the `work` counter and useful output, never wall-clock -- plus one explicit timing
// sanity check (generous, not a CI-flake risk) to confirm the fix is not merely "bounded in
// theory".
// ---------------------------------------------------------------------------------------
describe('zimArticleToSegments — table cost pathology (issue #478)', () => {
  it('a single cell at the max rowspan/colspan cap, repeated across many real rows, ' +
    'completes fast and produces a small, bounded amount of text', () => {
    // 50 real rows (so rowspan has somewhere real to expand into after B5's fix) each holding
    // one maximally-spanning cell -- the reviewer's "1 MiB of colspan=24 rowspan=40" shape,
    // reproduced with real rows instead of relying on an unclamped rowspan to fake them.
    const row = '<tr><td colspan="24" rowspan="40">w</td></tr>'
    const html = `<table>${row.repeat(50)}</table>`
    const t0 = performance.now()
    const article = zimArticleToSegments(html)
    const ms = performance.now() - t0
    const text = article.segments.map((s) => s.text).join('\n')
    expect(text.length).toBeLessThan(20_000)
    expect(ms).toBeLessThan(500) // generous; before the fix this shape ran into seconds
    expect(article.work).toBeGreaterThan(0)
    // html.ts's header record derives a combined ceiling for one outermost table's own share
    // plus the last nested table it may still admit (the nested test below pins the same bound
    // against a real nested pathology); a single non-nested table must sit inside it too.
    expect(article.work).toBeLessThanOrEqual(html.length + 2 * (TABLE_MAX_GRID_CELLS + TABLE_MAX_RAW_CHARS) + TABLE_MAX_RAW_CHARS)
  })

  it('a plain, evenly-filled 400×100 grid (no crafted spans at all) completes fast and ' +
    'is cut at the documented caps, not silently truncated', () => {
    const rows = Array.from(
      { length: 400 },
      (_, r) => `<tr>${Array.from({ length: 100 }, (_, c) => `<td>${r}-${c}</td>`).join('')}</tr>`
    )
    const html = `<table>${rows.join('')}</table>`
    const t0 = performance.now()
    const article = zimArticleToSegments(html)
    const ms = performance.now() - t0
    const text = article.segments.map((s) => s.text).join('\n')
    expect(ms).toBeLessThan(500)
    expect(text).toMatch(/Some cells beyond the table's size caps were omitted/)
    expect(article.work).toBeGreaterThan(0)
    // Same header-record ceiling as the max-span single-cell case above.
    expect(article.work).toBeLessThanOrEqual(html.length + 2 * (TABLE_MAX_GRID_CELLS + TABLE_MAX_RAW_CHARS) + TABLE_MAX_RAW_CHARS)
  })

  it('the reviewer’s adversarial input (thousands of source cells in one row) is bounded ' +
    'by the column cap alone, independent of how many source cells the row actually contains', () => {
    const cells = '<td colspan="24">w</td>'.repeat(2000)
    const html = `<table><tr>${cells}</tr></table>`
    const t0 = performance.now()
    expect(() => zimArticleToSegments(html)).not.toThrow()
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(200)
  })

  it('the documented additive table-work bound holds: work ≤ 5·n + 64 + ' +
    'TABLE_MAX_GRID_CELLS + TABLE_MAX_RAW_CHARS per table (html.ts’s header note)', () => {
    const cells = '<td colspan="24">w</td>'.repeat(2000)
    const html = `<table><tr>${cells}</tr></table>`
    const article = zimArticleToSegments(html)
    const proseBound = 5 * html.length + 64
    expect(article.work).toBeLessThanOrEqual(proseBound + TABLE_MAX_GRID_CELLS + TABLE_MAX_RAW_CHARS)
  })

  // -------------------------------------------------------------------------------------
  // A NESTED table's own grid expansion and line-building used to be charged to nothing and
  // sliced never: thousands of small nested max-span tables inside one wrapper cell could
  // cost real seconds and gigabytes in one uninterruptible slice, invisible to `work` and to
  // `maxWork` alike (issue #478). The global nested-work budget bounds this the same way the
  // per-table caps already bound a single huge table.
  // -------------------------------------------------------------------------------------
  it('thousands of small nested max-span tables in one wrapper cell complete fast and with ' +
    'small, bounded output -- nested work is charged and budgeted, not free and unbounded', () => {
    const nestedUnit = '<table><tr><td colspan="24" rowspan="40">w</td></tr></table>'
    const count = Math.ceil((1024 * 1024) / nestedUnit.length)
    const html = `<table><tr><td>${nestedUnit.repeat(count)}</td></tr></table>`
    const t0 = performance.now()
    const article = zimArticleToSegments(html)
    const ms = performance.now() - t0
    const text = article.segments.map((s) => s.text).join('\n')
    // Only the first ~TABLE_MAX_RAW_CHARS worth of nested content is ever inlined -- output
    // stays small and bounded regardless of how many thousand nested tables the input has.
    expect(text.length).toBeLessThan(4 * TABLE_MAX_RAW_CHARS)
    // Deterministic regression guard (never wall-clock alone as the oracle, per this suite's
    // own convention): nested work IS now charged (work exceeds the outer table's raw byte
    // count, where the pre-fix code charged nested tables nothing at all) but stays within the
    // fixed, input-independent ceiling html.ts's header note derives -- never proportional to
    // how many thousand nested tables the input actually has.
    expect(article.work).toBeGreaterThan(html.length)
    expect(article.work).toBeLessThan(html.length + 2 * (TABLE_MAX_GRID_CELLS + TABLE_MAX_RAW_CHARS) + TABLE_MAX_RAW_CHARS)
    // Generous wall-clock smoke check only (CI machines vary by an order of magnitude): before
    // this fix the reviewer measured 173.7 ms for this exact shape on their own desktop
    // (already down from seconds/gigabytes pre-cap); this is not the pass/fail oracle above.
    expect(ms).toBeLessThan(2_000)
    // The budget cutoff is disclosed like any other cap hit, not silently invisible.
    expect(text).toMatch(/Some cells beyond the table's size caps were omitted/)
  })

  it('a cap hit inside a NESTED table (its own row cap) is disclosed with the same marker a ' +
    'top-level table\'s row cap produces', () => {
    const nestedRows = Array.from(
      { length: TABLE_MAX_SOURCE_ROWS + 100 },
      (_, i) => `<tr><th>k${i}</th><td>v${i}</td></tr>`
    ).join('')
    const html = `<table><tr><th>Wrap</th><td><table>${nestedRows}</table></td></tr></table>`
    const text = zimArticleToSegments(html).segments.map((s) => s.text).join('\n')
    expect(text).toMatch(/\[Rows 1-\d+ of \d+ source rows shown\]/)
  })

  it('a cap hit inside a NESTED table (its own column cap) is disclosed with the same marker ' +
    'a top-level table\'s column cap produces', () => {
    const cells = Array.from({ length: TABLE_MAX_COLUMNS + 20 }, (_, i) => `<td>c${i}</td>`).join('')
    const html = `<table><tr><th>Wrap</th><td><table><tr>${cells}</tr></table></td></tr></table>`
    const text = zimArticleToSegments(html).segments.map((s) => s.text).join('\n')
    expect(text).toMatch(/Some cells beyond the table's size caps were omitted/)
  })

  // A single-column WRAPPER whose one cell is a nested table large enough to saturate its own
  // TABLE_MAX_RAW_CHARS budget (issue #478): the nested table's own record lines total 375 x
  // 133 = 49,875 chars, under its own budget, but joining them with '; ' for the inline string
  // pushes the assembled text to ~50,623 chars -- over the budget the OUTER table's single
  // key/value pair is then charged against. Before the fix, the outer pair as a whole exceeded
  // the remaining budget and was dropped entirely, so the wrapper delivered nothing but cap
  // markers even though the identical table un-nested delivers real data.
  it('a wrapper whose nested table saturates TABLE_MAX_RAW_CHARS still delivers data up to ' +
    'the cap, never markers over zero rows', () => {
    const nestedRows = Array.from({ length: 400 }, () => `<tr><td>P</td><td>${'x'.repeat(130)}</td></tr>`).join('')
    const html = `<table><tr><td><table>${nestedRows}</table></td></tr></table>`
    const text = zimArticleToSegments(html).segments.map((s) => s.text).join('\n')
    expect(text).toMatch(/P: x{100,}/)
    expect(text).toMatch(/Some cells beyond the table's size caps were omitted/)
    expect(text).not.toMatch(/^\[Rows 1-0 of /m)
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
    contains: [
      'iron catalyst at high pressure and moderate temperature',
      'N2 + 3H2 → 2NH3',
      // The infobox table has a header cell, so table delivery now keeps it (renamed from
      // 'infobox-never-shown': it used to be dropped whole, it is delivered now). Pinned as
      // the exact keyed line (issue #478), not just a substring of the value:
      // a row-header row ("Catalyst" is a <th> in the row, not a header ROW above it) must
      // key on "Catalyst", never "Column 1".
      'Catalyst: infobox-now-delivered'
    ],
    minSegments: 4,
    minChars: 1200,
    omits: ['datamw-style-never-shown', 'datamw-comment-never-shown', 'mw-ref-never-shown']
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
    contains: [
      'maps each element and flattens the result by one level',
      'x => [x, x * 2]',
      // The compat table has header cells, so table delivery now keeps it (renamed from
      // 'compat-table-never-shown': it used to be dropped whole, it is delivered now). Pinned
      // as the exact keyed lines (issue #478): each row is its own row-header
      // shape (`<th>Browser</th><td>...</td>`), keyed by that row's own label.
      'Browser: compat-table-now-delivered',
      'Node.js: Supported'
    ],
    minSegments: 1,
    minChars: 1200,
    omits: ['devdocs-nav-never-shown', 'devdocs-style-never-shown']
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

  it('normalises a math alttext after decoding its entities (decode-then-normalise order)', () => {
    const html = '<p><math alttext="\\text{CO}_2 &lt; 400"></math></p>'
    const text = textOf(zimArticleToSegments(html))
    expect(text).toContain('CO2 < 400')
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
        expect(s.text.isWellFormed(), `${label}: well-formed UTF-16`).toBe(true)
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
// HILBERTRAUM_ZIM_FIXTURES_DIR=<dir containing *.html raw kiwix-serve articles> — the
// committed fixture pins the contract; this leg pins realism (manual-smoke convention).
// (#301 P5, finding L8, plan §9.19 (d)1: renamed from HILBERTRAUM_ZIM_FIXTURES for the
// HILBERTRAUM_<FEATURE>_<KIND> naming convention the rest of the ZIM env vars follow.)
const realDir = process.env.HILBERTRAUM_ZIM_FIXTURES_DIR
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
