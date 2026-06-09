import { readFile } from 'node:fs/promises'
import type { DocumentParser, ExtractedSegment, ParsedDocument } from './index'

// Markdown parser: split the document at ATX headings (`#`..`######`) so each section
// becomes its own segment carrying the heading text as `sectionLabel`. The heading line
// is kept in the segment text so the chunk still reads naturally. Content before the
// first heading becomes a leading, label-less segment. We do not strip inline markdown —
// for retrieval the raw text is fine, and keeping it avoids lossy transformation.

const HEADING = /^(#{1,6})\s+(.*)$/

export const MarkdownParser: DocumentParser = {
  name: 'MarkdownParser',
  extensions: ['.md', '.markdown', '.mdown'],
  mimeType: 'text/markdown',
  async parse(filePath: string): Promise<ParsedDocument> {
    const raw = await readFile(filePath, 'utf8')
    const lines = raw.split(/\r?\n/)

    const segments: ExtractedSegment[] = []
    let currentLabel: string | null = null
    let buffer: string[] = []

    const flush = (): void => {
      const text = buffer.join('\n').trim()
      if (text.length > 0) segments.push({ text, sectionLabel: currentLabel })
      buffer = []
    }

    for (const line of lines) {
      const m = HEADING.exec(line)
      if (m) {
        // A new heading starts a new section.
        flush()
        currentLabel = m[2].trim() || null
      }
      buffer.push(line)
    }
    flush()

    // A document with no extractable text still yields an empty (but valid) result.
    return { segments, mimeType: 'text/markdown' }
  }
}
