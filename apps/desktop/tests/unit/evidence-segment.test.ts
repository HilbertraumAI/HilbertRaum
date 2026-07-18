import { describe, it, expect } from 'vitest'
import { segmentAnswerBlocks, type AnswerBlock } from '../../src/main/services/evidence-pack/segment'
import { extractCitationMarkers } from '../../src/shared/citation-markers'
import { localizeServerCopy } from '../../src/renderer/lib/displayMap'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'

// EP-1 Phase 1 (plan §6.1/§6.2) — the deterministic answer-block segmenter and the shared
// `[S{n}]` marker extraction. The segmenter is PURE (string → blocks); keys must be stable
// against the snapshot (spec Risk 7). Marker extraction must agree BYTE-FOR-BYTE with the
// renderer's `localizeCitationMarkers` exclusion behavior — both import the same regex
// source (shared/citation-markers.ts), and the parity suite below proves it against the
// REAL display function using the display-map test fixtures.

const kinds = (blocks: AnswerBlock[]): string[] => blocks.map((b) => b.blockKind)
const texts = (blocks: AnswerBlock[]): string[] => blocks.map((b) => b.text)

describe('segmentAnswerBlocks — the markdown zoo (plan §6 tests)', () => {
  it('splits paragraphs on blank lines and keeps multi-line paragraphs together', () => {
    const blocks = segmentAnswerBlocks('First line\nstill first paragraph.\n\nSecond paragraph.')
    expect(kinds(blocks)).toEqual(['paragraph', 'paragraph'])
    expect(texts(blocks)).toEqual(['First line\nstill first paragraph.', 'Second paragraph.'])
  })

  it('classifies ATX headings as single-line heading blocks', () => {
    const blocks = segmentAnswerBlocks('# Title\n\nBody text.\n\n### Sub\nMore body.')
    expect(kinds(blocks)).toEqual(['heading', 'paragraph', 'heading', 'paragraph'])
    expect(blocks[0]!.text).toBe('# Title')
    expect(blocks[2]!.text).toBe('### Sub')
  })

  it('keeps a top-level list item with its nested children as ONE coherent block (§12.2)', () => {
    const md = [
      '- Parent point [S1]',
      '  - nested child a',
      '  - nested child b',
      '- Second point [S2]',
      '',
      '1. Ordered one',
      '2) Ordered two'
    ].join('\n')
    const blocks = segmentAnswerBlocks(md)
    expect(kinds(blocks)).toEqual(['list_item', 'list_item', 'list_item', 'list_item'])
    expect(blocks[0]!.text).toBe('- Parent point [S1]\n  - nested child a\n  - nested child b')
    expect(blocks[0]!.markers).toEqual(['S1'])
    expect(blocks[1]!.markers).toEqual(['S2'])
  })

  it('keeps a fenced block as one unit and never extracts markers from it', () => {
    const md = 'Before [S1].\n\n```sql\nSELECT 1; -- [S2] is a literal here\n```\n\nAfter [S3].'
    const blocks = segmentAnswerBlocks(md)
    expect(kinds(blocks)).toEqual(['paragraph', 'fence', 'paragraph'])
    expect(blocks[1]!.text).toBe('```sql\nSELECT 1; -- [S2] is a literal here\n```')
    expect(blocks[1]!.markers).toEqual([])
    expect(blocks[0]!.markers).toEqual(['S1'])
    expect(blocks[2]!.markers).toEqual(['S3'])
  })

  it('an unclosed fence swallows to end-of-text (the CITE_CODE_SPLIT_RE idiom)', () => {
    const md = 'Prose [S1].\n\n```\ncode [S2]\nstill code'
    const blocks = segmentAnswerBlocks(md)
    expect(kinds(blocks)).toEqual(['paragraph', 'fence'])
    expect(blocks[1]!.text).toBe('```\ncode [S2]\nstill code')
    expect(blocks[1]!.markers).toEqual([])
  })

  it('a ~~~ fence closes only on a matching-or-longer ~~~ fence', () => {
    const md = '~~~\ninner ``` does not close\n~~~~\n\ntail'
    const blocks = segmentAnswerBlocks(md)
    expect(kinds(blocks)).toEqual(['fence', 'paragraph'])
    expect(blocks[0]!.text).toBe('~~~\ninner ``` does not close\n~~~~')
  })

  it('a run of ≥2 pipe lines is ONE table block; a lone pipe line reads as a paragraph', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 [S1] |\n\n| lonely pipe line'
    const blocks = segmentAnswerBlocks(md)
    expect(kinds(blocks)).toEqual(['table', 'paragraph'])
    expect(blocks[0]!.text).toBe('| a | b |\n|---|---|\n| 1 | 2 [S1] |')
    // Table cells are prose for the marker contract (the display rewrite localizes them too).
    expect(blocks[0]!.markers).toEqual(['S1'])
  })

  it('consecutive > lines form one blockquote block', () => {
    const blocks = segmentAnswerBlocks('> quoted [S1]\n> more quote\n\nplain')
    expect(kinds(blocks)).toEqual(['blockquote', 'paragraph'])
    expect(blocks[0]!.text).toBe('> quoted [S1]\n> more quote')
    expect(blocks[0]!.markers).toEqual(['S1'])
  })

  it('an empty or whitespace-only answer yields ZERO blocks', () => {
    expect(segmentAnswerBlocks('')).toEqual([])
    expect(segmentAnswerBlocks('   \n\n\t\n')).toEqual([])
  })

  it('normalizes CRLF so Windows-persisted answers segment identically', () => {
    const lf = segmentAnswerBlocks('# H\n\nPara one.\n\n- item')
    const crlf = segmentAnswerBlocks('# H\r\n\r\nPara one.\r\n\r\n- item')
    expect(crlf).toEqual(lf)
  })

  it('inline code spans keep their [S{n}] literal (marker in code vs prose)', () => {
    const blocks = segmentAnswerBlocks('Prose cites [S1], but the token `[S1]` in code stays literal.')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.markers).toEqual(['S1']) // once, from prose — the code-span copy is excluded
  })

  it('deduplicates repeated markers per block, first-appearance order (spec §13.1)', () => {
    const blocks = segmentAnswerBlocks('See [S2] then [S1] then [S2] again.')
    expect(blocks[0]!.markers).toEqual(['S2', 'S1'])
  })
})

describe('segmentAnswerBlocks — stable keys (spec Risk 7)', () => {
  it('keys are ordinal + kind + content-hash, and identical text at different ordinals stays distinct', () => {
    const blocks = segmentAnswerBlocks('Same text.\n\nOther.\n\nSame text.')
    blocks.forEach((b, i) => {
      expect(b.blockKey).toMatch(new RegExp(`^b${i}-${b.blockKind}-[0-9a-f]{12}$`))
    })
    expect(blocks[0]!.blockKey).not.toBe(blocks[2]!.blockKey) // ordinal differs
    expect(blocks[0]!.blockKey.split('-')[2]).toBe(blocks[2]!.blockKey.split('-')[2]) // same content hash
  })

  it('is deterministic: the same snapshot always segments to the same blocks and keys', () => {
    const md = '# T\n\nA [S1] paragraph.\n\n- one\n- two\n\n```\ncode\n```\n\n> quote\n\n| a |\n| b |'
    const first = segmentAnswerBlocks(md)
    const second = segmentAnswerBlocks(md)
    expect(second).toEqual(first)
    expect(new Set(first.map((b) => b.blockKey)).size).toBe(first.length) // unique within the answer
  })

  it('ordinals are contiguous render order', () => {
    const blocks = segmentAnswerBlocks('# A\n\nB.\n\nC.')
    expect(blocks.map((b) => b.ordinal)).toEqual([0, 1, 2])
  })
})

// ---- Marker-extraction parity with the renderer display rewrite (plan §6.2) -------------
// Both sides import the SAME regex source; this suite drives the REAL `localizeServerCopy`
// (DE rewrites prose markers to [Q{n}], leaves code verbatim) over the display-map test
// fixtures and asserts extraction picks exactly the markers the display would rewrite.

const tDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)

/** The distinct marker numbers the DE display rewrite actually localized. */
function rewrittenMarkers(raw: string): string[] {
  const out = new Set<string>()
  for (const m of localizeServerCopy(tDe, raw).matchAll(/\[Q(\d+)\]/g)) out.add(`S${m[1]}`)
  return [...out].sort()
}

describe('extractCitationMarkers ≡ localizeCitationMarkers exclusion behavior', () => {
  const FIXTURES = [
    'See [S1] and [S2] for the clause.',
    'Prose cites [S1], but the token `[S1]` in code stays literal.',
    'Real cite [S2].\n```\nlog[S1] = value\n```\nAfter [S3].',
    'The [START] tag and [Section] head.', // no digits → no markers on either side
    'Unclosed fence stays code:\n```\n[S4]', // trailing fence swallows to end on both sides
    '~~~\n[S5] in a tilde fence\n~~~\nProse [S6].',
    '| cell [S7] | x |\n|---|---|'
  ]

  for (const raw of FIXTURES) {
    it(`agrees with the display rewrite for: ${JSON.stringify(raw.slice(0, 40))}…`, () => {
      expect([...extractCitationMarkers(raw)].sort()).toEqual(rewrittenMarkers(raw))
    })
  }

  it('the segmenter surfaces exactly the union of its blocks’ prose markers', () => {
    const md = 'Cite [S1].\n\n```\n[S2] literal\n```\n\n> quoted [S3]\n\nAgain [S1].'
    const blocks = segmentAnswerBlocks(md)
    const union = [...new Set(blocks.flatMap((b) => b.markers))].sort()
    expect(union).toEqual(rewrittenMarkers(md))
  })

  it('code-span exclusion inside ONE block matches the display exactly', () => {
    const raw = 'Prose cites [S1], but the token `[S1]` in code stays literal.'
    // Display: prose copy rewritten, code copy verbatim.
    expect(localizeServerCopy(tDe, raw)).toBe(
      'Prose cites [Q1], but the token `[S1]` in code stays literal.'
    )
    // Extraction: the prose copy counts once; the code copy never does.
    expect(extractCitationMarkers(raw)).toEqual(['S1'])
  })

  // ---- Code regions SPANNING block boundaries (Phase-1 review FIX-3) -------------------
  // The display's prose/code split runs over the WHOLE message; the segmenter therefore
  // extracts markers over the whole snapshot once and assigns them to blocks by offset.
  // Both repros are two-sided: what the display renders as literal code gets NO marker
  // (no over-claimed answer_marker link), what it renders as a citation KEEPS its marker.

  it('repro (a): a mid-line ``` swallows to end-of-text — the [S1] the UI shows as code yields NO marker', () => {
    const raw = 'To fence, type ``` in markdown.\n\nThe clause requires notice. [S1]'
    // Display side: the marker sits inside the code region → rendered literal, no [Q1].
    expect(localizeServerCopy(tDe, raw)).toBe(raw)
    expect(localizeServerCopy(tDe, raw)).not.toContain('[Q1]')
    // Extraction side: no block carries S1 — display literal ⇒ no auto-link, ever.
    const blocks = segmentAnswerBlocks(raw)
    expect(kinds(blocks)).toEqual(['paragraph', 'paragraph'])
    expect(blocks.flatMap((b) => b.markers)).toEqual([])
  })

  it('repro (b): a code region closing mid-line — the display rewrites [S2]; the block keeps S2 (and drops [S1])', () => {
    const raw = 'start ``` code [S1]\n\nstill code ``` end [S2]'
    // Display side: [S1] is inside the ```…``` region (literal); [S2] is prose (citation).
    const localized = localizeServerCopy(tDe, raw)
    expect(localized).toContain('[Q2]')
    expect(localized).toContain('[S1]')
    expect(localized).not.toContain('[Q1]')
    // Extraction side: block markers mirror exactly that — S2 assigned, S1 excluded.
    const blocks = segmentAnswerBlocks(raw)
    expect(kinds(blocks)).toEqual(['paragraph', 'paragraph'])
    expect(blocks[0]!.markers).toEqual([])
    expect(blocks[1]!.markers).toEqual(['S2'])
  })
})
