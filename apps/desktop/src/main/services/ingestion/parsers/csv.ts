import { readFile } from 'node:fs/promises'
import type { DocumentParser, ExtractedSegment, ParsedDocument } from './index'

// CSV parser using papaparse (pure-JS). Rows are linearised into readable text so they
// embed and retrieve sensibly: the first row is treated as a header and each subsequent
// row is rendered as "header: value" pairs on one line. When there is only one row it is
// emitted verbatim. The whole table is one segment (CSV has no page/section structure).

interface ParseResultLike {
  data: unknown[]
}

function cell(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

export const CsvParser: DocumentParser = {
  name: 'CsvParser',
  extensions: ['.csv', '.tsv'],
  mimeType: 'text/csv',
  async parse(filePath: string): Promise<ParsedDocument> {
    const Papa = (await import('papaparse')).default
    const raw = await readFile(filePath, 'utf8')
    const parsed = Papa.parse(raw, { skipEmptyLines: true }) as unknown as ParseResultLike

    const rows = (parsed.data as unknown[][]).filter((r) => Array.isArray(r) && r.length > 0)
    if (rows.length === 0) return { segments: [], mimeType: 'text/csv' }

    const header = rows[0].map(cell)
    const hasHeader = rows.length > 1 && header.some((h) => h.length > 0)

    const lines: string[] = []
    if (hasHeader) {
      for (const row of rows.slice(1)) {
        const pairs = header
          .map((h, i) => `${h}: ${cell(row[i])}`)
          .filter((_, i) => cell(row[i]).length > 0 || header[i].length > 0)
        lines.push(pairs.join('; '))
      }
    } else {
      for (const row of rows) lines.push(row.map(cell).join(', '))
    }

    const text = lines.join('\n').trim()
    const segments: ExtractedSegment[] = text.length > 0 ? [{ text }] : []
    return { segments, mimeType: 'text/csv' }
  }
}
