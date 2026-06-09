import { extname } from 'node:path'

// Document parsers (spec §7.7 / §9.2 DocumentParser interface). Each parser turns a
// file into ordered text segments, attaching whatever structural metadata the format
// exposes (PDF page numbers, Markdown section headings). The chunker (chunker.ts) then
// splits each segment into ~500-token chunks, so per-segment page/section labels flow
// straight onto every chunk that comes from it.
//
// All parsers are pure-JS (no native deps) to stay consistent with the node:sqlite
// choice and keep the app buildable without a compiler toolchain. Heavy libraries
// (pdfjs-dist, mammoth, papaparse) are imported lazily inside `parse()` so they are
// only loaded when a file of that type is actually ingested.

/** One contiguous run of extracted text plus the structure it came from. */
export interface ExtractedSegment {
  text: string
  /** 1-based page number when the format has pages (PDF); null otherwise. */
  pageNumber?: number | null
  /** Section/heading label when the format exposes one (Markdown); null otherwise. */
  sectionLabel?: string | null
}

export interface ParsedDocument {
  segments: ExtractedSegment[]
  /** MIME type the parser is responsible for (recorded on the document row). */
  mimeType: string
}

/** The contract every format adapter implements (spec §9.2). */
export interface DocumentParser {
  /** Human-readable name for logs/diagnostics. */
  readonly name: string
  /** Lowercase file extensions this parser handles, each including the dot. */
  readonly extensions: readonly string[]
  /** MIME type recorded for documents handled by this parser. */
  readonly mimeType: string
  /** Extract ordered text segments from the file at `filePath`. */
  parse(filePath: string): Promise<ParsedDocument>
}

import { TxtParser } from './txt'
import { MarkdownParser } from './markdown'
import { PdfParser } from './pdf'
import { DocxParser } from './docx'
import { CsvParser } from './csv'

// Registry of available parsers. Order is irrelevant — selection is by extension.
export const PARSERS: readonly DocumentParser[] = [
  TxtParser,
  MarkdownParser,
  PdfParser,
  DocxParser,
  CsvParser
]

/** Every file extension the ingestion pipeline can handle (lowercase, with dot). */
export function supportedExtensions(): string[] {
  return PARSERS.flatMap((p) => [...p.extensions])
}

/** Pick the parser for a file by extension, or null when the type is unsupported. */
export function selectParser(filePath: string): DocumentParser | null {
  const ext = extname(filePath).toLowerCase()
  return PARSERS.find((p) => p.extensions.includes(ext)) ?? null
}
