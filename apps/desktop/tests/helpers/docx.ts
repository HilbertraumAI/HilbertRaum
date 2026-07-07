import JSZip from 'jszip'

// A minimal but VALID Word `.docx` fixture builder for the same-format DOCX export tests (Phase 9, D77).
// Each entry in `paragraphs` becomes one `<w:p>` with one `<w:t>` run; the resulting `<w:t>` text layer is
// the paragraphs joined by `\n` (matching `readDocxTextLayer`). Includes non-`document.xml` parts
// ([Content_Types].xml, _rels/.rels, word/styles.xml) so a rewrite can be checked to leave them byte-equal.

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

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'

function xmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/** Build a valid `.docx` whose `<w:t>` text layer is `paragraphs.join('\n')` (+ a trailing `\n`). */
export async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join('')
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', RELS)
  zip.file('word/document.xml', documentXml)
  zip.file('word/styles.xml', STYLES)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** The base64 of every non-`word/document.xml` part, keyed by path — for byte-identity assertions. */
export async function otherDocxParts(bytes: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, string>()
  for (const path of Object.keys(zip.files)) {
    if (path === 'word/document.xml' || zip.files[path].dir) continue
    out.set(path, await zip.files[path].async('base64'))
  }
  return out
}
