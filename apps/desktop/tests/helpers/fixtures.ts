// Test fixture builders. We cannot ship binary PDF/DOCX fixtures or generate them with
// the parser libraries (mammoth/pdfjs are read-only), so we synthesise minimal-but-valid
// files in code: a single-page PDF with standard-font text, and a STORED-method .docx zip.
// Both are real enough for pdfjs/mammoth to parse, giving the parsers genuine coverage
// fully offline.

/** Build a minimal valid single-page PDF whose content shows `text` (Helvetica). */
export function makePdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, '\\$1')
  const objs: string[] = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  const stream = `BT /F1 24 Tf 72 700 Td (${escaped}) Tj ET`
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefPos = Buffer.byteLength(pdf, 'latin1')
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

/** One positioned text run on a synthetic columnar page. */
export interface PdfCell {
  text: string
  /** Text-space x of the run's left edge (PDF points; origin bottom-left). */
  x: number
  /** Text-space y of the baseline (PDF points; HIGHER is further up the page). */
  y: number
}

/**
 * Build a minimal valid single-page PDF whose text is POSITIONED cell-by-cell (one `Td`/`Tj` per
 * cell). This is the synthetic COLUMNAR fixture the PDF geometry-extraction tests need: pdf.js returns
 * each cell with its `transform` x/y, so the layout reconstructor can rebuild the visual rows. Latin-1
 * + `/WinAnsiEncoding` so German umlauts (ü/ö/ä/ß) round-trip; never use a real bank statement (D57).
 */
export function makeColumnarPdf(cells: PdfCell[], fontSize = 10): Buffer {
  let content = ''
  for (const c of cells) {
    const esc = c.text.replace(/([()\\])/g, '\\$1')
    content += `BT /F1 ${fontSize} Tf ${c.x} ${c.y} Td (${esc}) Tj ET\n`
  }
  const stream = Buffer.from(content, 'latin1')
  const objs: Buffer[] = []
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1')
  objs[2] = Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1')
  objs[3] = Buffer.from(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    'latin1'
  )
  objs[4] = Buffer.concat([
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream', 'latin1')
  ])
  objs[5] = Buffer.from(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    'latin1'
  )

  const parts: Buffer[] = []
  let pos = 0
  const push = (b: Buffer): void => {
    parts.push(b)
    pos += b.length
  }
  push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'))
  const offsets: number[] = []
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pos
    push(Buffer.from(`${i} 0 obj\n`, 'latin1'))
    push(objs[i])
    push(Buffer.from('\nendobj\n', 'latin1'))
  }
  const xrefPos = pos
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  push(Buffer.from(xref, 'latin1'))
  push(Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`, 'latin1'))
  return Buffer.concat(parts)
}

// ---- Scanned-PDF detection fixtures (Phase 38 step 0) ------------------------------
//
// A REAL (tiny, 1.1 kB) JPEG so the image-only PDFs are honest fixtures: pdfjs parses
// the page tree and finds an image XObject and no text, exactly like a true scan.
// Detection never decodes the image, so its content is irrelevant.
export const TINY_JPEG: Buffer = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCACgAHgDASIAAhEBAxEB/8QAGgABAAIDAQAAAAAAAAAAAAAAAAIGAQQHA//EACIQAQACAgICAgMBAAAAAAAAAAABAgMEBRESIRNBIjFRFf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwDrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACOXJTDivly3ilKRNrWmeoiI/cpNXk4wW4vZrtY75ME4rfJWkT5TXr3EdfYI6fLaW/knHgyX+SK+c0yYr47eP1PVoiep+p+24qOPf2sWHcwaPI05bHh1vLHtY61tnwR3ETS019Wt13MeonuJ7hnd3eJwcdWurzGzsYc2f8AC/8ApTXHW3hP42zTPlEffUTM9/XXoFtHPKctOzqVyZ+ey1tThvk8KbcU6zVnqJnrqZnv+z7+/wCL5pZ67Ojgz0yVy1yY62i9ZiYt6/foHuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//2Q==',
  'base64'
)

type FixturePage = { kind: 'text'; lines: string[] } | { kind: 'image' }

/**
 * Build a PDF mixing real-text pages and image-only pages (binary-safe — the JPEG
 * stream rides untouched). Used for the three Phase-38 detection fixtures:
 * image-only ("true scan"), hybrid (text + image), and all-text (via makePdf above).
 */
export function makeMixedPdf(pages: FixturePage[]): Buffer {
  const objs: Array<string | { head: string; bin: Buffer; tail: string }> = []
  const add = (body: (typeof objs)[number]): number => {
    objs.push(body)
    return objs.length
  }
  const kidRefs: string[] = []
  add('<< /Type /Catalog /Pages 2 0 R >>') // obj 1
  add('PLACEHOLDER') // obj 2 — patched below
  const fontNum = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  for (const p of pages) {
    if (p.kind === 'text') {
      const content =
        'BT /F1 12 Tf 72 720 Td 16 TL\n' +
        p.lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
        '\nET'
      const contentNum = add(
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
      )
      const pageNum = add(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
          `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
      )
      kidRefs.push(`${pageNum} 0 R`)
    } else {
      const imgNum = add({
        head:
          '<< /Type /XObject /Subtype /Image /Width 120 /Height 160 ' +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${TINY_JPEG.length} >>\nstream\n`,
        bin: TINY_JPEG,
        tail: '\nendstream'
      })
      const content = 'q 612 0 0 792 0 0 cm /Im0 Do Q'
      const contentNum = add(
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
      )
      const pageNum = add(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
          `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
      )
      kidRefs.push(`${pageNum} 0 R`)
    }
  }
  objs[1] = `<< /Type /Pages /Kids [${kidRefs.join(' ')}] /Count ${kidRefs.length} >>`

  const chunks: Buffer[] = []
  let offset = 0
  const push = (b: Buffer | string): void => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')
    chunks.push(buf)
    offset += buf.length
  }
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const xref: number[] = [0]
  for (let i = 0; i < objs.length; i++) {
    xref.push(offset)
    push(`${i + 1} 0 obj\n`)
    const o = objs[i]
    if (typeof o === 'string') push(o)
    else {
      push(o.head)
      push(o.bin)
      push(o.tail)
    }
    push('\nendobj\n')
  }
  const xrefStart = offset
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`)
  for (let i = 1; i <= objs.length; i++) push(`${String(xref[i]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

/** A "true scan": every page is an image, zero extractable text. */
export function makeScanOnlyPdf(pages = 2): Buffer {
  return makeMixedPdf(Array.from({ length: pages }, () => ({ kind: 'image' as const })))
}

/** A hybrid PDF: one real text page + one scanned page (must NOT be detected). */
export function makeHybridPdf(): Buffer {
  return makeMixedPdf([
    {
      kind: 'text',
      lines: [
        'Quarterly report, page one.',
        'This page has a real text layer with several sentences of content.',
        'It exists to prove hybrid PDFs are not mistaken for scans.'
      ]
    },
    { kind: 'image' }
  ])
}

/** A tiny but valid 1x1 PNG (photo-import tests; the fake engine never decodes it). */
export const TINY_PNG: Buffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

// ---- Minimal .docx (OOXML zip) ---------------------------------------------------

function crc32(buf: Buffer): number {
  let crc = ~0
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (~crc) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
}

/** Write a ZIP archive using the STORED (no compression) method. */
function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method = stored
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18) // compressed size
    local.writeUInt32LE(e.data.length, 22) // uncompressed size
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    locals.push(local, name, e.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    centrals.push(central, name)

    offset += local.length + name.length + e.data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const centralSize = centralBuf.length
  const centralOffset = offset

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, end])
}

/** Build a minimal valid .docx containing the given paragraphs. */
export function makeDocx(paragraphs: string[]): Buffer {
  const xmlEscape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join('')

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`

  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') }
  ])
}
