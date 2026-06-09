import { readFile } from 'node:fs/promises'
import type { DocumentParser, ExtractedSegment, ParsedDocument } from './index'

// PDF parser (spec R3). Uses pdfjs-dist's *legacy* build, which runs in plain Node
// with no Web Worker and no DOM — validated in Phase 4. Each page becomes one segment
// tagged with its 1-based page number, so every chunk derived from it can cite a page.
// pdfjs is imported lazily so the (large) library only loads when a PDF is ingested.

interface TextItemLike {
  str?: unknown
  hasEOL?: unknown
}

function itemText(item: TextItemLike): { str: string; eol: boolean } | null {
  if (typeof item.str !== 'string') return null // skip marked-content / non-text items
  return { str: item.str, eol: item.hasEOL === true }
}

export const PdfParser: DocumentParser = {
  name: 'PdfParser',
  extensions: ['.pdf'],
  mimeType: 'application/pdf',
  async parse(filePath: string): Promise<ParsedDocument> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(await readFile(filePath))
    const loadingTask = pdfjs.getDocument({ data })
    const doc = await loadingTask.promise

    const segments: ExtractedSegment[] = []
    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()
        let text = ''
        for (const raw of content.items) {
          const item = itemText(raw as TextItemLike)
          if (!item) continue
          text += item.str
          text += item.eol ? '\n' : ' '
        }
        const trimmed = text.trim()
        if (trimmed.length > 0) segments.push({ text: trimmed, pageNumber })
      }
    } finally {
      // Release pdfjs transport/worker resources promptly.
      await loadingTask.destroy()
    }

    return { segments, mimeType: 'application/pdf' }
  }
}
