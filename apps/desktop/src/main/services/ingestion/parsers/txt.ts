import { readFile } from 'node:fs/promises'
import type { DocumentParser, ParsedDocument } from './index'

// Plain-text parser: the whole file is a single segment with no page/section structure.
export const TxtParser: DocumentParser = {
  name: 'TxtParser',
  extensions: ['.txt', '.text', '.log'],
  mimeType: 'text/plain',
  readsWholeFileToString: true, // PERF-4: `readFile(..,'utf8')` → one JS string

  async parse(filePath: string): Promise<ParsedDocument> {
    // F-22 (audit 2026-07-16): strip one leading UTF-8 BOM (kept by `readFile(..,'utf8')`) so the
    // invisible U+FEFF never lands in the first chunk's text — the app's own .txt exports carry it (P4).
    const text = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')
    return { segments: [{ text }], mimeType: 'text/plain' }
  }
}
