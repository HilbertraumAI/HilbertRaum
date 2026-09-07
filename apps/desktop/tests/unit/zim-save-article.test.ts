import { describe, expect, it } from 'vitest'
import {
  ARTICLE_TITLE_MAX_CHARS,
  articleDocumentTitle,
  renderArticleMarkdown
} from '../../src/main/services/zim/save-article'

// #340 Tier-2 (D-Z21): the pure halves of "Save article to my documents" — the document title
// rule and the Markdown the import path parses. The materialise flow itself is exercised end to
// end in zim-ipc-session.test.ts (a real DB, the real handler, the real import pipeline).

describe('articleDocumentTitle', () => {
  it('files the copy as "<article> (<archive>).md" — the .md picks the Markdown parser', () => {
    expect(articleDocumentTitle('Treibhausgas', 'Klimawandel von Wikipedia')).toBe('Treibhausgas (Klimawandel von Wikipedia).md')
  })

  it('collapses whitespace, tolerates a missing archive title and an empty article title', () => {
    expect(articleDocumentTitle('  Liste der   Länder  ', null)).toBe('Liste der Länder.md')
    expect(articleDocumentTitle('', 'Pack')).toBe('Article (Pack).md')
    expect(articleDocumentTitle('   ', null)).toBe('Article.md')
  })

  it('caps an absurd title without ever dropping the extension, splitting a surrogate pair or unbalancing the parenthetical', () => {
    const long = articleDocumentTitle('x'.repeat(400), 'y'.repeat(100))
    expect(long.endsWith('.md')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(ARTICLE_TITLE_MAX_CHARS + 3)
    // The archive parenthetical stays whole (itself capped at half the budget); the article
    // title is what gets shortened.
    expect(long).toMatch(/^x+ \(y{90}\)\.md$/)
    const smiley = String.fromCodePoint(0x1f600)
    const astral = articleDocumentTitle(`a${smiley}`.repeat(200), null)
    expect(astral.endsWith('.md')).toBe(true)
    const lone = Array.from(astral).some((ch) => {
      const cp = ch.codePointAt(0)!
      return cp >= 0xd800 && cp <= 0xdfff
    })
    expect(lone).toBe(false)
  })
})

describe('renderArticleMarkdown', () => {
  const article = {
    title: 'Treibhausgas',
    sections: [
      { label: null, text: 'Treibhausgase sind Spurengase.\n\nSie wirken auf die Strahlung.' },
      { label: 'Landwirtschaft', text: 'Methan entsteht in der Landwirtschaft.' },
      { label: 'Leer', text: '   ' }
    ],
    partial: false
  }

  it('writes an H1, an attribution quote naming the archive and the date, then one H2 per labelled section', () => {
    const md = renderArticleMarkdown(article, { archiveTitle: 'Klimawandel von Wikipedia', savedAt: '2026-09-07T10:00:00.000Z' })
    const lines = md.split('\n')
    expect(lines[0]).toBe('# Treibhausgas')
    expect(lines[2]).toBe('> Offline copy of the article "Treibhausgas" from the knowledge pack "Klimawandel von Wikipedia", saved with HilbertRaum on 2026-09-07.')
    expect(md).toContain('\nTreibhausgase sind Spurengase.\n\nSie wirken auf die Strahlung.\n')
    expect(md).toContain('\n## Landwirtschaft\n\nMethan entsteht in der Landwirtschaft.\n')
    // An empty section still gets its heading (the viewer showed it) but no blank body line.
    expect(md).toContain('## Leer\n')
    expect(md).not.toContain('Only the first part')
    // The lead (label-less) section never gets a heading of its own.
    expect(md).not.toContain('## intro')
  })

  it('states honestly when the converter stopped short, and copes with no archive title', () => {
    const md = renderArticleMarkdown({ ...article, partial: true }, { archiveTitle: null, savedAt: '2026-09-07T10:00:00.000Z' })
    expect(md).toContain('> Offline copy of the article "Treibhausgas", saved with HilbertRaum on 2026-09-07.')
    expect(md).toContain('> Only the first part of the article could be copied')
  })

  it('collapses whitespace inside titles and labels so headings stay single-line', () => {
    const md = renderArticleMarkdown(
      { title: ' Zwei\n Zeilen ', sections: [{ label: 'Ab\nschnitt', text: 'x' }], partial: false },
      { archiveTitle: 'P\nack', savedAt: '2026-09-07' }
    )
    expect(md.split('\n')[0]).toBe('# Zwei Zeilen')
    expect(md).toContain('## Ab schnitt\n')
    expect(md).toContain('"Zwei Zeilen" from the knowledge pack "P ack"')
  })
})
