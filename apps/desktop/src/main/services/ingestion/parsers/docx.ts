import { readFile } from 'node:fs/promises'
import { t } from '../../../../shared/i18n'
import type { DocumentParser, ExtractedSegment, ParseContext, ParsedDocument } from './index'
import { declaredZipInflatedSize } from '../limits'

// DOCX parser using mammoth's raw-text extraction. mammoth is pure-JS (it reads the
// OOXML zip with JSZip), so there is no native dependency. Word documents have no
// reliable page model in the XML, so we emit paragraphs as segments without page
// numbers; the chunker recombines them into ~500-token chunks. mammoth is imported
// lazily so it only loads when a .docx is ingested.
//
// Zip-bomb guard (security audit M-3): JSZip 3.x enforces no uncompressed-size ceiling,
// so a few-KB `.docx` whose `document.xml` inflates to gigabytes would OOM the main
// process. Before handing the bytes to mammoth we sum the DECLARED uncompressed sizes
// in the zip central directory and refuse anything over `ctx.maxInflatedBytes`. We read
// the file ourselves (already byte-capped upstream) and pass the buffer to mammoth so
// it does not re-read from disk.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const DocxParser: DocumentParser = {
  name: 'DocxParser',
  extensions: ['.docx'],
  mimeType: DOCX_MIME,
  async parse(filePath: string, ctx?: ParseContext): Promise<ParsedDocument> {
    const buffer = await readFile(filePath)
    const cap = ctx?.maxInflatedBytes
    if (cap && cap > 0) {
      const inflated = declaredZipInflatedSize(buffer)
      if (inflated !== null && inflated > cap) {
        // Persist-canonical English (i18n record §3.3 rule 1) — display-mapped at render.
        throw new Error(t('en', 'main.ingest.fileTooLarge'))
      }
    }
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })

    // mammoth separates paragraphs with blank lines; keep them as ordered segments so
    // the chunker can pack them, dropping empties.
    const segments: ExtractedSegment[] = result.value
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter((para) => para.length > 0)
      .map((para) => ({ text: para }))

    return { segments, mimeType: DOCX_MIME }
  }
}
