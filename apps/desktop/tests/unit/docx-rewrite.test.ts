import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readDocxTextLayer, applySpansToDocx } from '../../src/main/services/export/docx-rewrite'
import type { TransformSpan } from '../../src/main/services/skills/tools/span-transform'

// Same-format DOCX export unit tests (beta-feedback-2026-07 Phase 9, #22/#23, D77; architecture.md
// "Skills — design record" §23). The writer reads the `<w:t>` TEXT LAYER, splices caller-supplied spans
// (text-layer offsets) across the node map, and re-zips with every other part byte-identical. These pin:
//   - the text layer concatenates `<w:t>` text with a `\n` at each paragraph boundary (unescaped);
//   - only the targeted `<w:t>` text changes; every OTHER zip part is byte-identical (decompressed);
//   - a span that crosses a RUN boundary splits across two `<w:t>` nodes correctly;
//   - umlauts / UTF-8 and `&amp;`-escaped text survive the round-trip.

const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:r><w:t xml:space="preserve">Hello Jane </w:t></w:r><w:r><w:t>Doe today.</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t xml:space="preserve">Grüße aus Wien &amp; Zürich.</w:t></w:r></w:p>' +
  '</w:body></w:document>'

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

// A non-document.xml part (styles) that must survive every rewrite byte-identical — the "formatting
// survives because runs are untouched" guarantee, at the zip-part granularity.
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'

async function makeFixtureDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', RELS)
  zip.file('word/document.xml', DOCUMENT_XML)
  zip.file('word/styles.xml', STYLES)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** Every non-`word/document.xml` part's decompressed bytes, keyed by path — for byte-identity checks. */
async function otherParts(bytes: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, string>()
  for (const path of Object.keys(zip.files)) {
    if (path === 'word/document.xml' || zip.files[path].dir) continue
    out.set(path, await zip.files[path].async('base64'))
  }
  return out
}

describe('docx-rewrite — the <w:t> text layer', () => {
  it('concatenates node text with a paragraph newline, unescaping entities', async () => {
    const bytes = await makeFixtureDocx()
    const { text, nodes } = await readDocxTextLayer(bytes)
    // Two runs in paragraph 1 concatenate ("Hello Jane " + "Doe today."), then a \n, then paragraph 2
    // with the `&amp;` unescaped to `&` and the umlauts intact.
    expect(text).toBe('Hello Jane Doe today.\nGrüße aus Wien & Zürich.\n')
    // Three `<w:t>` nodes mapped (paragraph breaks are not nodes).
    expect(nodes).toHaveLength(3)
    expect(nodes[0].layerText).toBe('Hello Jane ')
    expect(nodes[2].layerText).toBe('Grüße aus Wien & Zürich.')
  })

  it('throws for bytes that are not a Word document (no word/document.xml)', async () => {
    const zip = new JSZip()
    zip.file('hello.txt', 'not a docx')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(readDocxTextLayer(bytes)).rejects.toThrow()
  })
})

describe('docx-rewrite — applySpansToDocx', () => {
  it('changes only the targeted <w:t> text; every other part stays byte-identical', async () => {
    const bytes = await makeFixtureDocx()
    const { text } = await readDocxTextLayer(bytes)
    // Mask "Wien" (a single-node span) with 4 full-block glyphs.
    const at = text.indexOf('Wien')
    const span: TransformSpan = { start: at, length: 4, replacement: '████' }
    const out = await applySpansToDocx(bytes, [span])

    const layer = await readDocxTextLayer(out)
    expect(layer.text).toBe('Hello Jane Doe today.\nGrüße aus ████ & Zürich.\n')
    expect(layer.text).not.toContain('Wien')
    // Umlauts and the `&` survive the round-trip.
    expect(layer.text).toContain('Grüße')
    expect(layer.text).toContain('Zürich')
    expect(layer.text).toContain(' & ')

    // Every non-document.xml part is byte-identical (decompressed) — formatting/styles untouched (D77).
    const before = await otherParts(bytes)
    const after = await otherParts(out)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, b64] of before) expect(after.get(path), `${path} must be byte-identical`).toBe(b64)
    // The output opens as a valid zip and still carries the styles part.
    const outZip = await JSZip.loadAsync(out)
    expect(outZip.file('word/styles.xml')).not.toBeNull()
  })

  it('splits a span that crosses a run boundary across both <w:t> nodes', async () => {
    const bytes = await makeFixtureDocx()
    const { text } = await readDocxTextLayer(bytes)
    // "Jane Doe" straddles the run boundary ("Hello Jane " | "Doe today.") — the mask must cover it whole.
    const at = text.indexOf('Jane Doe')
    const span: TransformSpan = { start: at, length: 'Jane Doe'.length, replacement: '█'.repeat('Jane Doe'.length) }
    const out = await applySpansToDocx(bytes, [span])
    const layer = await readDocxTextLayer(out)
    expect(layer.text).toBe('Hello ████████ today.\nGrüße aus Wien & Zürich.\n')
    expect(layer.text).not.toContain('Jane')
    expect(layer.text).not.toContain('Doe')
  })

  it('supports a length-changing replacement (an edit) crossing a run boundary', async () => {
    const bytes = await makeFixtureDocx()
    const { text } = await readDocxTextLayer(bytes)
    const at = text.indexOf('Jane Doe')
    // Replace the whole cross-run "Jane Doe" with a shorter string — the edit path (replace ≠ find length).
    const span: TransformSpan = { start: at, length: 'Jane Doe'.length, replacement: 'A. Roe' }
    const out = await applySpansToDocx(bytes, [span])
    const layer = await readDocxTextLayer(out)
    expect(layer.text).toBe('Hello A. Roe today.\nGrüße aus Wien & Zürich.\n')
  })

  it('a no-op span set re-zips to a byte-identical set of parts (clean run keeps every part)', async () => {
    const bytes = await makeFixtureDocx()
    const out = await applySpansToDocx(bytes, [])
    const before = await otherParts(bytes)
    const after = await otherParts(out)
    for (const [path, b64] of before) expect(after.get(path)).toBe(b64)
    // document.xml is unchanged too (no span touched a node).
    const beforeDoc = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
    const afterDoc = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    expect(afterDoc).toBe(beforeDoc)
  })
})

// F-11 (audit 2026-07-16): a SELF-CLOSING `<w:t …/>` (attribute-bearing empty node — Apache POI /
// lxml-style OOXML producers emit these for empty runs; Word itself rarely does) used to be read as an
// OPENING tag: `(?:\s[^>]*)?` consumed the trailing `/`, and the lazy body then swallowed every
// character up to the NEXT `</w:t>` — raw run/formatting markup entered the text layer, and a span
// overlapping the pseudo-node re-emitted that markup xmlEscape'd as VISIBLE text in the saved copy
// (destroying the intervening runs' formatting — a D77 guarantee violation). The regex now matches the
// self-closing form explicitly (an empty node, before the paired-tag alternative).
describe('docx-rewrite — self-closing <w:t …/> nodes (F-11)', () => {
  const SELF_CLOSING_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t xml:space="preserve"/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Hello Jane</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>' +
    '</w:body></w:document>'

  async function makeSelfClosingDocx(): Promise<Buffer> {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', CONTENT_TYPES)
    zip.file('_rels/.rels', RELS)
    zip.file('word/document.xml', SELF_CLOSING_XML)
    zip.file('word/styles.xml', STYLES)
    return zip.generateAsync({ type: 'nodebuffer' })
  }

  it('the text layer contains NO markup when a run holds a self-closing <w:t xml:space="preserve"/>', async () => {
    const bytes = await makeSelfClosingDocx()
    const { text, nodes } = await readDocxTextLayer(bytes)
    // The empty node contributes nothing; the following runs' markup must NOT leak into the layer.
    expect(text).toBe('Hello Jane\nSecond paragraph.\n')
    expect(text).not.toContain('<')
    // Only the two REAL text nodes are mapped (the empty self-closing node has no inner text).
    expect(nodes).toHaveLength(2)
    expect(nodes[0].layerText).toBe('Hello Jane')
  })

  it('a span in the run FOLLOWING the self-closing node splices only that run\'s text', async () => {
    const bytes = await makeSelfClosingDocx()
    const { text } = await readDocxTextLayer(bytes)
    const at = text.indexOf('Jane')
    const out = await applySpansToDocx(bytes, [{ start: at, length: 4, replacement: '████' } satisfies TransformSpan])
    const layer = await readDocxTextLayer(out)
    expect(layer.text).toBe('Hello ████\nSecond paragraph.\n')
    expect(layer.text).not.toContain('Jane')
    // The intervening run/formatting markup survives AS MARKUP — never re-emitted as escaped text.
    const doc = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string')
    expect(doc).toContain('<w:t xml:space="preserve"/>')
    expect(doc).toContain('<w:rPr><w:b/></w:rPr>')
    expect(doc).not.toContain('&lt;w:')
  })

  it('a bare self-closing <w:t/> (no attributes) still contributes nothing (regression)', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', CONTENT_TYPES)
    zip.file('_rels/.rels', RELS)
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t/></w:r><w:r><w:t>Tail</w:t></w:r></w:p></w:body></w:document>'
    )
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const { text, nodes } = await readDocxTextLayer(bytes)
    expect(text).toBe('Tail\n')
    expect(nodes).toHaveLength(1)
  })
})
