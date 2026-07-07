import type { TransformSpan } from '../skills/tools/span-transform'

// Same-format DOCX export (beta-feedback-2026-07 Phase 9, #22/#23, decision D77; architecture.md
// "Skills — design record" §23). DOCX in → DOCX out with formatting intact: styles, numbering, tables,
// headers, and every other zip part survive UNTOUCHED because only the text CONTENT inside `<w:t>` nodes
// of `word/document.xml` changes. This extends the D58 "byte-identity outside the located spans" guarantee
// from the extracted text to the real file: every non-`document.xml` zip part is copied byte-identical,
// and inside `document.xml` every character outside a located span stays byte-identical too.
//
// Pure main-side TS: no node:fs, no network, no native deps (CLAUDE.md §0). `jszip` (a direct dependency
// since Phase 9 — already in the tree under mammoth) is imported LAZILY so it only loads when a `.docx` is
// actually rewritten. The module knows nothing about redaction/edits — it reads the `<w:t>` TEXT LAYER and
// splices a caller-supplied `TransformSpan[]` (in text-layer offsets) across the node map. The caller
// (the run seam) re-runs its locate + verify pass over THIS text layer — which differs from the
// mammoth-extracted chunk text the model located against in Phases 7/8 — so the spans are anchored in the
// text that is actually rewritten (the D77 re-anchoring constraint).
//
// THE TEXT LAYER. `readDocxTextLayer` concatenates, in document order, the UNESCAPED text of every `<w:t>`
// node, inserting a `\n` at each `</w:p>` (paragraph/table-cell boundary) so the layer has a line
// structure the LLM locate windows can anchor to. Each `<w:t>` node keeps a map from its layer offset back
// to its raw byte range in `document.xml`, so a span — even one that crosses a run boundary — splices back
// into the exact nodes it covers.

const DOCUMENT_XML_PATH = 'word/document.xml'

/** One `<w:t>` text node's place in both the concatenated text layer and the raw `document.xml` bytes. */
interface DocxTextNode {
  /** Offset in `document.xml` where the node's INNER text begins (just after the opening tag's `>`). */
  rawStart: number
  /** Offset in `document.xml` where the node's INNER text ends (just before `</w:t>`). */
  rawEnd: number
  /** Offset of this node's text in the concatenated (unescaped) text layer. */
  layerStart: number
  /** The node's UNESCAPED inner text (what the user sees; what the locate/verify pass anchors against). */
  layerText: string
}

export interface DocxTextLayer {
  /** The concatenated, unescaped `<w:t>` text with a `\n` at every paragraph boundary (the locate input). */
  text: string
  /** The `<w:t>` nodes in document order, each mapping a layer range back to its raw `document.xml` bytes. */
  nodes: DocxTextNode[]
}

// ---- XML text-content escape / unescape (text nodes only — not attributes) ----

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'"
}

/** Unescape XML text content to the characters the user sees. Handles the five named entities plus
 *  decimal (`&#8217;`) and hex (`&#x2019;`) numeric character references. `<w:t>` bodies contain only
 *  text (no child elements), so no literal `<`/`>` can appear — every `&` is the start of an entity. */
function xmlUnescape(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (m, dec: string, hex: string) => {
    if (dec !== undefined) return String.fromCodePoint(Number.parseInt(dec, 10))
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
    return NAMED_ENTITIES[m] ?? m
  })
}

/** Escape a string for XML text content (only `&`, `<`, `>` are special outside attribute values). */
function xmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

// A `<w:t ...>inner</w:t>` element (inner is non-greedy: `<w:t>` bodies hold only text, no `</w:t>`),
// OR a paragraph close `</w:p>` (a layer newline). Alternation, scanned in document order via matchAll.
const NODE_OR_PARA_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>/g

/**
 * Parse `word/document.xml` into the text layer + the `<w:t>` node map. Deterministic — `readDocxTextLayer`
 * and `applySpansToDocx` both call it on the same bytes, so the offsets the caller's spans are computed
 * against map back to the same nodes at write time.
 */
function parseTextLayer(xml: string): DocxTextLayer {
  const nodes: DocxTextNode[] = []
  let layer = ''
  for (const m of xml.matchAll(NODE_OR_PARA_RE)) {
    if (m[1] === undefined) {
      // `</w:p>` — a paragraph/cell boundary becomes a single layer newline (not part of any node, so a
      // span never rewrites it; masks/edits never straddle a paragraph in practice).
      layer += '\n'
      continue
    }
    const whole = m[0]
    const rawInner = m[1]
    const openTagLen = whole.indexOf('>') + 1 // length of `<w:t ...>` (its `>` is the first in the match)
    const rawStart = (m.index ?? 0) + openTagLen
    const layerText = xmlUnescape(rawInner)
    nodes.push({ rawStart, rawEnd: rawStart + rawInner.length, layerStart: layer.length, layerText })
    layer += layerText
  }
  return { text: layer, nodes }
}

/**
 * Read a DOCX's `<w:t>` text layer: the concatenated, unescaped node text (paragraph-newline separated)
 * plus the node→offset map. The caller runs its locate + verify pass over `.text` and hands the resulting
 * `TransformSpan[]` (text-layer offsets) to `applySpansToDocx`. Throws if the bytes are not a Word `.docx`
 * (no `word/document.xml`) — the seam falls back to the segment-faithful `.txt` path.
 */
export async function readDocxTextLayer(bytes: Uint8Array): Promise<DocxTextLayer> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(bytes)
  const docFile = zip.file(DOCUMENT_XML_PATH)
  if (!docFile) throw new Error('not a Word document (no word/document.xml)')
  const xml = await docFile.async('string')
  return parseTextLayer(xml)
}

/** Whether a span's shape is applicable at all (positive length, integer bounds). */
function validSpan(span: TransformSpan): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.length) &&
    span.length > 0 &&
    span.start >= 0
  )
}

/**
 * Rewrite ONE node's unescaped text under the spans overlapping it. A span's replacement is emitted only in
 * the node where the span STARTS; a span that crosses into or out of the node has its covered characters
 * removed here (they are replaced once, at the start node). The node's non-span characters are copied
 * through verbatim at the text layer, so every unchanged character survives character-for-character.
 * Byte-identity holds for untouched nodes and every non-`document.xml` part; inside a REWRITTEN node the
 * re-escape emits only `&amp;/&lt;/&gt;`, so an unchanged `&#233;`/`&quot;` re-emerges as its literal
 * character — character- but not byte-stable (D58 as extended by D77).
 */
function rewriteNodeText(node: DocxTextNode, spans: readonly TransformSpan[]): string {
  const base = node.layerText
  const nStart = node.layerStart
  const nEnd = nStart + base.length
  let out = ''
  let cursor = 0 // relative to the node (0 .. base.length)
  for (const span of spans) {
    const spanEnd = span.start + span.length
    const relStart = Math.max(0, span.start - nStart)
    const relEnd = Math.min(base.length, spanEnd - nStart)
    if (relEnd <= relStart) continue // no overlap with this node
    out += base.slice(cursor, relStart)
    if (span.start >= nStart && span.start < nEnd) out += span.replacement // emit only at the start node
    cursor = relEnd
  }
  out += base.slice(cursor)
  return out
}

/**
 * Splice `spans` (text-layer offsets) across a DOCX's `<w:t>` nodes and re-zip, every other part copied
 * through. Re-reads `document.xml`, re-parses the SAME node map `readDocxTextLayer` produced, rewrites only
 * the nodes a span touches (unchanged nodes keep their raw escaped bytes verbatim), and returns the new
 * `.docx` bytes. A span crossing a run boundary splits across nodes; the replacement is emitted once, in
 * the node where the span starts. Every non-`document.xml` part is byte-identical; inside `document.xml`
 * only the touched `<w:t>` text content changes.
 */
export async function applySpansToDocx(bytes: Uint8Array, spans: readonly TransformSpan[]): Promise<Buffer> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(bytes)
  const docFile = zip.file(DOCUMENT_XML_PATH)
  if (!docFile) throw new Error('not a Word document (no word/document.xml)')
  const xml = await docFile.async('string')
  const { nodes } = parseTextLayer(xml)

  const sorted = spans.filter(validSpan).slice().sort((a, b) => a.start - b.start)
  // For each node, gather the spans overlapping its layer range and rewrite only if the text changes.
  const changes: Array<{ rawStart: number; rawEnd: number; newRaw: string }> = []
  for (const node of nodes) {
    const nStart = node.layerStart
    const nEnd = nStart + node.layerText.length
    const overlapping = sorted.filter((s) => s.start < nEnd && s.start + s.length > nStart)
    if (overlapping.length === 0) continue
    const newText = rewriteNodeText(node, overlapping)
    if (newText !== node.layerText) {
      changes.push({ rawStart: node.rawStart, rawEnd: node.rawEnd, newRaw: xmlEscape(newText) })
    }
  }

  // Splice the changed nodes' raw ranges into the XML (nodes are already ascending, non-overlapping).
  let newXml = xml
  if (changes.length > 0) {
    let out = ''
    let cur = 0
    for (const c of changes) {
      out += xml.slice(cur, c.rawStart) + c.newRaw
      cur = c.rawEnd
    }
    out += xml.slice(cur)
    newXml = out
  }
  zip.file(DOCUMENT_XML_PATH, newXml)
  return zip.generateAsync({ type: 'nodebuffer' })
}
