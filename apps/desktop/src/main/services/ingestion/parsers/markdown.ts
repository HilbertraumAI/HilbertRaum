import { readFile } from 'node:fs/promises'
import type { DocumentParser, ExtractedSegment, ParsedDocument } from './index'

// Markdown parser: split the document at ATX headings (`#`..`######`) so each section
// becomes its own segment carrying the heading text as `sectionLabel`. The heading line
// is kept in the segment text so the chunk still reads naturally. Content before the
// first heading becomes a leading, label-less segment. We do not strip inline markdown —
// for retrieval the raw text is fine, and keeping it avoids lossy transformation.

const HEADING = /^(#{1,6})\s+(.*)$/
// RAG-N4: a fenced code block boundary (``` or ~~~, optionally indented, with an optional info
// string on the opening line). A `#`-prefixed line INSIDE such a block is code — a shell comment,
// a C `#define`, a diff/patch hunk — not a section heading; detecting it as one would fragment the
// code block and stamp a bogus `sectionLabel` on the pieces (→ wrong citations). We toggle an
// in-fence flag on each fence line and suppress heading detection while inside. (A simple toggle —
// it does not model nested fences of differing backtick lengths, which markdown disallows anyway.)
const FENCE = /^\s*(```|~~~)/

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

    let inFence = false
    for (const line of lines) {
      if (FENCE.test(line)) {
        // Enter/leave a fenced code block; the fence line itself stays in the current segment.
        inFence = !inFence
      } else if (!inFence) {
        const m = HEADING.exec(line)
        if (m) {
          // A new heading starts a new section.
          flush()
          currentLabel = m[2].trim() || null
        }
      }
      buffer.push(line)
    }
    flush()

    // A document with no extractable text still yields an empty (but valid) result.
    return { segments, mimeType: 'text/markdown' }
  }
}
