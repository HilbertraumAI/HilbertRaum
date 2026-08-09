import JSZip from 'jszip'

// A minimal but VALID Word `.docx` fixture builder for the same-format DOCX export tests (Phase 9, D77).
// Each entry in `paragraphs` becomes one `<w:p>` with one `<w:t>` run; the resulting `<w:t>` text layer is
// the paragraphs joined by `\n` (matching `readDocxTextLayer`). Includes non-`document.xml` parts
// ([Content_Types].xml, _rels/.rels, word/styles.xml) so a rewrite can be checked to leave them byte-equal.
//
// #129 additions: optional headers/footers/footnotes/comments, docProps author fields, an external
// hyperlink relationship, and tracked-changes deleted text — the parts PII survives in when only the
// body `<w:t>` nodes are rewritten. All optional and absent by default, so the pre-#129 fixtures (and
// their byte-identity assertions) are byte-unchanged.

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function xmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
}

export interface MakeDocxOptions {
  /** `word/header1.xml` paragraphs (letterhead) — the part a body-only rewrite never touches. */
  headers?: string[]
  /** `word/footer1.xml` paragraphs. */
  footers?: string[]
  /** `word/footnotes.xml` footnote paragraphs. */
  footnotes?: string[]
  /** `word/comments.xml` comment texts, each stamped with `commentAuthor` (default 'Jane Doe'). */
  comments?: string[]
  commentAuthor?: string
  /** Tracked-changes DELETED text appended to the body inside `<w:del>`/`<w:delText>` (with `author`). */
  trackedDeletion?: { text: string; author?: string }
  /** A field instruction (`<w:instrText>`) appended to the body (e.g. a MERGEFIELD with a name). */
  fieldInstruction?: string
  /** An external hyperlink: display text as a body paragraph + `word/_rels/document.xml.rels` target. */
  hyperlink?: { display: string; target: string }
  /** `docProps/core.xml` with dc:creator / cp:lastModifiedBy. */
  creator?: string
  lastModifiedBy?: string
}

/** Build a valid `.docx` whose body `<w:t>` text layer is `paragraphs.join('\n')` (+ a trailing `\n`). */
export async function makeDocx(paragraphs: string[], opts: MakeDocxOptions = {}): Promise<Buffer> {
  let body = paragraphs.map(para).join('')
  if (opts.hyperlink) {
    body +=
      `<w:p><w:hyperlink r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<w:r><w:t xml:space="preserve">${xmlEscape(opts.hyperlink.display)}</w:t></w:r></w:hyperlink></w:p>`
  }
  if (opts.trackedDeletion) {
    const author = xmlEscape(opts.trackedDeletion.author ?? 'Jane Doe')
    body +=
      `<w:p><w:del w:id="90" w:author="${author}" w:date="2026-01-01T00:00:00Z">` +
      `<w:r><w:delText xml:space="preserve">${xmlEscape(opts.trackedDeletion.text)}</w:delText></w:r></w:del></w:p>`
  }
  if (opts.fieldInstruction) {
    body +=
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve">${xmlEscape(opts.fieldInstruction)}</w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
  }
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<w:document ${W_NS}>` +
    `<w:body>${body}</w:body></w:document>`

  const zip = new JSZip()
  const overrides: string[] = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  ]
  zip.file('_rels/.rels', RELS)
  zip.file('word/document.xml', documentXml)
  zip.file('word/styles.xml', STYLES)

  if (opts.headers && opts.headers.length > 0) {
    zip.file(
      'word/header1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W_NS}>${opts.headers.map(para).join('')}</w:hdr>`
    )
    overrides.push(
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
    )
  }
  if (opts.footers && opts.footers.length > 0) {
    zip.file(
      'word/footer1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W_NS}>${opts.footers.map(para).join('')}</w:ftr>`
    )
    overrides.push(
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    )
  }
  if (opts.footnotes && opts.footnotes.length > 0) {
    const notes = opts.footnotes
      .map((t, i) => `<w:footnote w:id="${i + 1}">${para(t)}</w:footnote>`)
      .join('')
    zip.file(
      'word/footnotes.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}>${notes}</w:footnotes>`
    )
    overrides.push(
      '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
    )
  }
  if (opts.comments && opts.comments.length > 0) {
    const author = xmlEscape(opts.commentAuthor ?? 'Jane Doe')
    const comments = opts.comments
      .map((t, i) => `<w:comment w:id="${i}" w:author="${author}" w:initials="JD">${para(t)}</w:comment>`)
      .join('')
    zip.file(
      'word/comments.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W_NS}>${comments}</w:comments>`
    )
    overrides.push(
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
    )
  }
  if (opts.hyperlink) {
    zip.file(
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(opts.hyperlink.target)}" TargetMode="External"/>` +
        '</Relationships>'
    )
  }
  if (opts.creator !== undefined || opts.lastModifiedBy !== undefined) {
    zip.file(
      'docProps/core.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        `<dc:creator>${xmlEscape(opts.creator ?? '')}</dc:creator>` +
        `<cp:lastModifiedBy>${xmlEscape(opts.lastModifiedBy ?? opts.creator ?? '')}</cp:lastModifiedBy>` +
        '</cp:coreProperties>'
    )
    overrides.push(
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    )
  }

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      overrides.join('') +
      '</Types>'
  )
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

/** One part's decompressed XML as a string (null when absent) — for #129 part-content assertions. */
export async function docxPartText(bytes: Uint8Array, path: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes)
  const f = zip.file(path)
  return f ? f.async('string') : null
}
