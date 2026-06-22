import { extname } from 'node:path'
import type { Transcriber } from '../../transcriber'
import type { OcrEngine, OcrPage } from '../../ocr'

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

/**
 * Optional per-parse context (ADDITIVE — the text parsers ignore it). Carries the
 * injected transcriber the AudioParser needs (parsers stay constructor-free
 * singletons; the dependency arrives per call from `IngestionDeps`), a coarse
 * progress callback, and the workspace documents dir for content transients
 * (`.parse` infix → covered by the startup crash sweep).
 */
export interface ParseContext {
  transcriber?: Transcriber | null
  /** Coarse progress (0–100) — surfaces as "Transcribing… N%" during audio ingestion. */
  onProgress?: (percent: number) => void
  /** Directory for transient content files the parse may create (storeDir). */
  workDir?: string
  /**
   * OCR engine for photo imports. Optional AND nullable: absent/null means a photo
   * FILE fails friendly with the needs-the-OCR-files copy — text ingestion is
   * unaffected (graceful-fallback rule).
   */
  ocrEngine?: OcrEngine | null
  /**
   * Stored per-page OCR recognition for a scan-detected PDF: when present,
   * the PdfParser turns an image-only PDF into one segment per recognized page
   * instead of failing with the scan notice. Fed from `documents.ocr_json`.
   */
  ocrPages?: OcrPage[] | null
  /**
   * Max PDF pages the text-extraction loop will walk (security audit M-2). Beyond this,
   * the PdfParser stops and logs — a crafted PDF can declare an enormous page count.
   * Absent → no cap (the parser's historical behaviour).
   */
  maxPages?: number
  /**
   * Max DECLARED uncompressed size (bytes) of a DOCX zip before it is inflated (security
   * audit M-3 — zip-bomb guard). Absent → no cap.
   */
  maxInflatedBytes?: number
  /**
   * Geometry-aware LAYOUT mode for the PDF parser (PDF geometry-extraction plan §3.1, D51). When set,
   * `PdfParser.parse()` reconstructs visual rows/columns from word coordinates and emits clean,
   * year-resolved `<date> <desc> <amount>` lines instead of pdf.js reading-order text — recovering a
   * COLUMNAR bank statement the default mode scrambles. Opt-in and bank-statement-ONLY (D58): ingest,
   * the renderer preview, and the other extractors never set it, so their text is byte-unchanged.
   */
  layout?: boolean
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
  parse(filePath: string, ctx?: ParseContext): Promise<ParsedDocument>
}

import { TxtParser } from './txt'
import { MarkdownParser } from './markdown'
import { PdfParser } from './pdf'
import { DocxParser } from './docx'
import { CsvParser } from './csv'
import { AudioParser, AUDIO_EXTENSIONS } from './audio'
import { ImageParser, IMAGE_EXTENSIONS } from './image'

// Registry of available parsers. Order is irrelevant — selection is by extension.
export const PARSERS: readonly DocumentParser[] = [
  TxtParser,
  MarkdownParser,
  PdfParser,
  DocxParser,
  CsvParser,
  AudioParser,
  ImageParser
]

/** True when this file/title resolves to the audio parser. */
export function isAudioPath(filePath: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extname(filePath).toLowerCase())
}

/** True when this file/title resolves to the photo parser. */
export function isImagePath(filePath: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extname(filePath).toLowerCase())
}

/** True when this file/title is a PDF (the scan-detection / OCR-task target). */
export function isPdfPath(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.pdf'
}

/** Every file extension the ingestion pipeline can handle (lowercase, with dot). */
export function supportedExtensions(): string[] {
  return PARSERS.flatMap((p) => [...p.extensions])
}

/** Pick the parser for a file by extension, or null when the type is unsupported. */
export function selectParser(filePath: string): DocumentParser | null {
  const ext = extname(filePath).toLowerCase()
  return PARSERS.find((p) => p.extensions.includes(ext)) ?? null
}
