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
 * Serialize numbered PDF objects (object `i + 1` is `objs[i]`; object 1 is the catalog) behind the binary
 * header comment, with a byte-exact xref. Binary-safe: a Buffer object (an image stream) rides untouched.
 * `eofNewline` keeps each builder's historical last byte, so every builder's output stays byte-identical.
 */
function serializePdf(objs: Array<string | Buffer>, eofNewline: boolean): Buffer {
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
    push(objs[i])
    push('\nendobj\n')
  }
  const xrefStart = offset
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`)
  for (let i = 1; i <= objs.length; i++) push(`${String(xref[i]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF${eofNewline ? '\n' : ''}`)
  return Buffer.concat(chunks)
}

/** A stream object: `dict` entries (without `/Length`, which is counted here in bytes) and its data. */
function streamObject(data: Buffer | string, dict = ''): Buffer {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1')
  return Buffer.concat([
    Buffer.from(`<< ${dict ? `${dict} ` : ''}/Length ${bytes.length} >>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream', 'latin1')
  ])
}

/**
 * Build a minimal valid single-page PDF whose text is POSITIONED cell-by-cell (one `Td`/`Tj` per
 * cell). This is the synthetic COLUMNAR fixture the PDF geometry-extraction tests need: pdf.js returns
 * each cell with its `transform` x/y, so the layout reconstructor can rebuild the visual rows. Latin-1
 * + `/WinAnsiEncoding` so German umlauts (ü/ö/ä/ß) round-trip; never use a real bank statement (D57).
 */
export function makeColumnarPdf(cells: PdfCell[], fontSize = 10): Buffer {
  return makeColumnarPdfPages([cells], fontSize)
}

/**
 * The MULTI-PAGE columnar fixture: one page per entry, each built as {@link makeColumnarPdf} builds its
 * one page (#687: the layout parser carries the statement year and month from page to page, which one
 * page cannot show). The pages share one Helvetica font, numbered last, so a one-page call produces the
 * single-page builder's historical bytes.
 */
export function makeColumnarPdfPages(pages: PdfCell[][], fontSize = 10): Buffer {
  const fontNum = 3 + 2 * pages.length
  const objs: Array<string | Buffer> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`
  ]
  pages.forEach((cells, i) => {
    let content = ''
    for (const c of cells) {
      const esc = c.text.replace(/([()\\])/g, '\\$1')
      content += `BT /F1 ${fontSize} Tf ${c.x} ${c.y} Td (${esc}) Tj ET\n`
    }
    objs.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${4 + 2 * i} 0 R >>`,
      streamObject(content)
    )
  })
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  return serializePdf(objs, false)
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

/** An image XObject: its dictionary entries (without `/Length`) and its raw stream bytes. */
interface FixtureImage {
  dict: string
  bin: Buffer
}

const JPEG_IMAGE: FixtureImage = {
  dict: '/Width 120 /Height 160 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
  bin: TINY_JPEG
}

type FixturePage =
  | { kind: 'text'; lines: string[] }
  | { kind: 'image'; image?: FixtureImage }
  // #575: a page with no content at all (an empty separator page) — neither text nor an image.
  | { kind: 'blank' }

/**
 * Build a PDF mixing real-text pages and image-only pages (binary-safe — the JPEG
 * stream rides untouched). Used for the three Phase-38 detection fixtures:
 * image-only ("true scan"), hybrid (text + image), and all-text (via makePdf above).
 */
export function makeMixedPdf(pages: FixturePage[]): Buffer {
  const objs: Array<string | Buffer> = []
  const add = (body: string | Buffer): number => {
    objs.push(body)
    return objs.length
  }
  const kidRefs: string[] = []
  add('<< /Type /Catalog /Pages 2 0 R >>') // obj 1
  add('PLACEHOLDER') // obj 2 — patched below
  const fontNum = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  for (const p of pages) {
    if (p.kind === 'blank') {
      const contentNum = add(streamObject(''))
      const pageNum = add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R >>`
      )
      kidRefs.push(`${pageNum} 0 R`)
    } else if (p.kind === 'text') {
      const content =
        'BT /F1 12 Tf 72 720 Td 16 TL\n' +
        p.lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
        '\nET'
      const contentNum = add(streamObject(content))
      const pageNum = add(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
          `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
      )
      kidRefs.push(`${pageNum} 0 R`)
    } else {
      const image = p.image ?? JPEG_IMAGE
      const imgNum = add(streamObject(image.bin, `/Type /XObject /Subtype /Image ${image.dict}`))
      const contentNum = add(streamObject('q 612 0 0 792 0 0 cm /Im0 Do Q'))
      const pageNum = add(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
          `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
      )
      kidRefs.push(`${pageNum} 0 R`)
    }
  }
  objs[1] = `<< /Type /Pages /Kids [${kidRefs.join(' ')}] /Count ${kidRefs.length} >>`
  return serializePdf(objs, true)
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

// ---- CCITT fax scan (#551) ------------------------------------------------------------
//
// Black-and-white office scans usually store each page as a CCITT Group 4 (fax) image, and
// pdf.js 6 decodes those only through a module it loads separately (`wasmUrl`). These 16
// bytes are a 64×16 test pattern encoded by Windows' TIFF encoder (WIC,
// `TiffCompressOption.Ccitt4`, one strip, WhiteIsZero, so PDF needs no `/BlackIs1`).
export const CCITT_SCAN_WIDTH = 64
export const CCITT_SCAN_HEIGHT = 16
const TINY_CCITT_G4: Buffer = Buffer.from('Km//Mwav/////8f/wAQAQA==', 'base64')

/** The pattern's black pixels: a box over rows 4–11 × columns 8–39, a full-height bar over columns 50–53. */
export function ccittScanIsBlack(x: number, y: number): boolean {
  return (y >= 4 && y <= 11 && x >= 8 && x <= 39) || (x >= 50 && x <= 53)
}

/** A one-page scan whose only content is the CCITT G4 image: no text layer. */
export function makeCcittScanPdf(): Buffer {
  const w = CCITT_SCAN_WIDTH
  const h = CCITT_SCAN_HEIGHT
  return makeMixedPdf([
    {
      kind: 'image',
      image: {
        dict:
          `/Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 ` +
          `/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${w} /Rows ${h} >>`,
        bin: TINY_CCITT_G4
      }
    }
  ])
}

// ---- Type3 image-mask glyph (#687) ----------------------------------------------------
//
// pdf.js compiles a Type3 glyph that paints an IMAGE MASK into a path (`compileType3Glyph`, its only
// DOMMatrix use in the main process) when the font loads, which text extraction does. The mask is 8×8
// (a 1×1 mask takes a shortcut that skips the compiler): a square outline, 1 = unpainted.
const TYPE3_GLYPH_MASK: Buffer = Buffer.from([0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff])

/** A one-page PDF: `line` in Helvetica, then `AAAA` in a Type3 font whose one glyph paints an 8×8 image mask. */
export function makeType3MaskGlyphPdf(line: string): Buffer {
  const esc = line.replace(/([()\\])/g, '\\$1')
  return serializePdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R /T3 6 0 R >> >> /Contents 4 0 R >>',
      streamObject(`BT /F1 12 Tf 72 720 Td (${esc}) Tj ET\nBT /T3 12 Tf 72 690 Td (AAAA) Tj ET`),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 8 8] /FontMatrix [0.125 0 0 0.125 0 0] ' +
        '/CharProcs << /A 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> ' +
        '/FirstChar 65 /LastChar 65 /Widths [8] /Resources << /XObject << /M 8 0 R >> >> >>',
      // The glyph procedure: width + bbox (`d1`), then the mask scaled onto the 8×8 glyph box.
      streamObject('8 0 0 0 8 8 d1 q 8 0 0 8 0 0 cm /M Do Q'),
      streamObject(
        TYPE3_GLYPH_MASK,
        '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1'
      )
    ],
    true
  )
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
  return makeDocxFromBody(
    paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join('')
  )
}

/** Build a minimal valid .docx whose `<w:body>` is `body`, raw WordprocessingML (the caller escapes). */
export function makeDocxFromBody(body: string): Buffer {
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
