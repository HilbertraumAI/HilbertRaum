import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeEntities, zimArticleToSegments } from '../../src/main/services/zim/html'

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
    const bounded = zimArticleToSegments(big, 110)
    expect(bounded.segments.map((s) => s.text).join('')).not.toContain('tail marker')
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
