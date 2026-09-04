import type { ExtractedSegment } from '../ingestion/parsers'

// ZIM article HTML → ExtractedSegment[] (knowledge packs, query-time retrieval arm).
//
// Input is mwoffliner/Parsoid output served by the kiwix-serve sidecar: machine-generated,
// well-formed HTML with a stable shape — `<section>` blocks, `<h2>`–`<h4>` headings inside
// `.mw-heading` wrappers, `<sup class="mw-ref">` reference markers, MathML `<math alttext>`
// carrying the LaTeX source, and (maxi flavours) figures/images. We extract readable text
// the same way MarkdownParser does for headings: one segment per heading section, heading
// text kept in the segment body AND as `sectionLabel`, intro text before the first heading
// as a leading label-less segment.
//
// A hand-rolled scanner (no HTML-parser dependency) is deliberate: the pure-JS/no-new-deps
// parser rule (parsers/index.ts header) applies, and the input is machine-generated markup,
// not adversarial web HTML — the output feeds retrieval text and a plain-text viewer, never
// innerHTML, so a permissive scanner cannot become an injection surface.
//
// Dropped subtrees: head, script/style/noscript (raw-text aware), tables (infoboxes and
// data tables scramble into `header: value` noise without geometry), figures/images, nav,
// and `<sup class="mw-ref">` citation brackets ([1][2] — noise for retrieval; other <sup>
// like m<sup>2</sup> keeps its text). `<math>` emits its `alttext` LaTeX and skips the
// MathML subtree; the `<img>` fallback that follows is dropped with all images, so each
// formula appears exactly once.

const TOKEN =
  /<!--[\s\S]*?-->|<!\[[^\]]*\]>|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g

/** Elements whose entire subtree is dropped. `<math>` is handled separately (alttext). */
const SKIP_SUBTREE = new Set([
  'head',
  'table',
  'figure',
  'nav',
  'noscript',
  'template',
  'svg'
])

/** Raw-text elements: their content is not markup and is skipped to the matching close tag. */
const RAW_TEXT = new Set(['script', 'style'])

/** Void elements (never pushed on the open stack). Images are dropped; br becomes a newline. */
const VOID = new Set(['br', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

/** Block-level boundaries: a newline on open and close so text does not run together. */
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'blockquote',
  'ul',
  'ol',
  'dl',
  'dd',
  'dt',
  'pre',
  'article',
  'main',
  'header',
  'footer',
  'caption',
  'tr'
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  deg: '°',
  times: '×',
  minus: '−',
  prime: '′',
  Prime: '″',
  thinsp: ' ',
  ensp: ' ',
  emsp: ' '
}

/** Decode numeric and common named entities; unknown named entities are left verbatim. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec, hex, name) => {
    if (dec) return safeFromCodePoint(Number.parseInt(dec, 10), all)
    if (hex) return safeFromCodePoint(Number.parseInt(hex, 16), all)
    return name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : all
  })
}

function safeFromCodePoint(cp: number, fallback: string): string {
  // Guard the RangeError on out-of-range/surrogate code points in crafted input.
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return fallback
  }
  return String.fromCodePoint(cp)
}

/** Pull one attribute value out of a raw attribute string (both quote styles). */
function attrValue(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  if (!m) return null
  return m[2] ?? m[3] ?? null
}

export interface ZimArticle {
  /** Article title from the first <h1>, or null when the page has none. */
  title: string | null
  segments: ExtractedSegment[]
}

/**
 * Extract readable text segments from one ZIM article's HTML. Pure and synchronous;
 * `maxChars` bounds the scan (default 1 MiB of markup) so a pathological page cannot
 * stall the ask path — everything past the cap is simply not retrieved from.
 */
export function zimArticleToSegments(html: string, maxChars = 1_048_576): ZimArticle {
  const input = html.length > maxChars ? html.slice(0, maxChars) : html

  const segments: ExtractedSegment[] = []
  let title: string | null = null
  let currentLabel: string | null = null
  let buffer = ''

  // Heading capture: while > 0 we are inside <hN> and text goes to headingBuf instead.
  let headingLevel = 0
  let headingBuf = ''

  // Subtree skipping: depth counters rather than a full open-tag stack — Parsoid output
  // is balanced, and a counter survives the odd unbalanced tag without corrupting state.
  let skipDepth = 0
  let supSkipDepth = 0
  let mathDepth = 0
  let rawTextUntil: string | null = null

  const flush = (): void => {
    const text = tidy(buffer)
    if (text.length > 0) segments.push({ text, pageNumber: null, sectionLabel: currentLabel })
    buffer = ''
  }

  const emit = (text: string): void => {
    if (headingLevel > 0) headingBuf += text
    else buffer += text
  }

  let last = 0
  for (let m = TOKEN.exec(input); m !== null; m = TOKEN.exec(input)) {
    const tag = m[2]?.toLowerCase()

    // Character data between the previous token and this one.
    if (m.index > last && skipDepth === 0 && supSkipDepth === 0 && mathDepth === 0 && !rawTextUntil) {
      emit(decodeEntities(input.slice(last, m.index)))
    }
    last = TOKEN.lastIndex

    if (!tag) continue // comment / doctype / CDATA

    const isClose = m[1] === '/'
    const attrs = m[3] ?? ''
    const selfClosing = m[4] === '/' || VOID.has(tag)

    // Raw-text mode: ignore every token except the matching close tag.
    if (rawTextUntil) {
      if (isClose && tag === rawTextUntil) rawTextUntil = null
      continue
    }

    if (mathDepth > 0) {
      if (tag === 'math') mathDepth += isClose ? -1 : 1
      continue
    }
    if (skipDepth > 0) {
      if (SKIP_SUBTREE.has(tag) && !selfClosing) skipDepth += isClose ? -1 : 1
      continue
    }
    if (supSkipDepth > 0) {
      if (tag === 'sup' && !selfClosing) supSkipDepth += isClose ? -1 : 1
      continue
    }

    if (!isClose && RAW_TEXT.has(tag)) {
      if (!selfClosing) rawTextUntil = tag
      continue
    }
    if (!isClose && SKIP_SUBTREE.has(tag)) {
      if (!selfClosing) skipDepth = 1
      continue
    }
    if (!isClose && tag === 'math') {
      // The LaTeX source rides in alttext; emit it once, skip the MathML rendering tree.
      const alt = attrValue(attrs, 'alttext')
      if (alt) emit(` ${decodeEntities(alt)} `)
      if (!selfClosing) mathDepth = 1
      continue
    }
    if (!isClose && tag === 'sup') {
      // Reference brackets ([1], [note 2]) are retrieval noise; other superscripts keep text.
      const cls = attrValue(attrs, 'class') ?? ''
      if (/\b(?:mw-ref|reference)\b/.test(cls)) {
        if (!selfClosing) supSkipDepth = 1
        continue
      }
    }

    const h = /^h([1-6])$/.exec(tag)
    if (h) {
      if (!isClose) {
        headingLevel = Number(h[1])
        headingBuf = ''
      } else if (headingLevel > 0) {
        const heading = tidy(headingBuf)
        headingLevel = 0
        if (heading.length > 0) {
          if (title === null) {
            // The first heading is the page <h1> (article title); it labels the intro
            // segment implicitly via `title`, not via sectionLabel.
            title = heading
          } else {
            flush()
            currentLabel = heading
            buffer = `${heading}\n`
          }
        }
      }
      continue
    }

    if (tag === 'br' || BLOCK.has(tag)) emit('\n')
    if (!isClose && tag === 'li') emit('\n- ')
    if (isClose && tag === 'li') emit('\n')
  }

  // Trailing character data (a well-formed page ends in tags, but stay total).
  if (last < input.length && skipDepth === 0 && supSkipDepth === 0 && mathDepth === 0 && !rawTextUntil) {
    emit(decodeEntities(input.slice(last)))
  }
  flush()

  return { title, segments }
}

/** Collapse intra-line whitespace, strip invisible characters, cap blank runs. */
function tidy(text: string): string {
  return text
    .replace(/[­​-‍﻿]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
