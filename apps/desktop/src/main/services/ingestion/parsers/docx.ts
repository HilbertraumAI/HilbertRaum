import type { DocumentParser, ExtractedSegment, ParsedDocument } from './index'

// DOCX parser using mammoth's raw-text extraction. mammoth is pure-JS (it reads the
// OOXML zip with JSZip), so there is no native dependency. Word documents have no
// reliable page model in the XML, so we emit paragraphs as segments without page
// numbers; the chunker recombines them into ~500-token chunks. mammoth is imported
// lazily so it only loads when a .docx is ingested.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const DocxParser: DocumentParser = {
  name: 'DocxParser',
  extensions: ['.docx'],
  mimeType: DOCX_MIME,
  async parse(filePath: string): Promise<ParsedDocument> {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })

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
