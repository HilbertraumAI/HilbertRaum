import { readFile } from 'node:fs/promises'
import type { DocumentParser, ParsedDocument } from './index'

// Plain-text parser: the whole file is a single segment with no page/section structure.
export const TxtParser: DocumentParser = {
  name: 'TxtParser',
  extensions: ['.txt', '.text', '.log'],
  mimeType: 'text/plain',
  readsWholeFileToString: true, // PERF-4: `readFile(..,'utf8')` → one JS string

  async parse(filePath: string): Promise<ParsedDocument> {
    const text = await readFile(filePath, 'utf8')
    return { segments: [{ text }], mimeType: 'text/plain' }
  }
}
