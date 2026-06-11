import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OcrEngine } from './index'
import { createTesseractOcrEngine } from './tesseract'

// Availability-aware OCR selector (Phase 38), the transcriber/reranker D9 pattern:
// NO mock fallback. A real `TesseractOcrEngine` is selected only when the drive's
// `ocr/` dir holds at least one vendored `<lang>.traineddata.gz`; otherwise the
// selector returns NULL — photo imports fail per-file with friendly copy and a
// detected scan shows its notice without the "Make searchable (OCR)" offer (D14:
// availability-driven, no settings key).

/** The drive dir holding the vendored OCR language files (drive-layout.md). */
export function ocrAssetsDir(rootPath: string): string {
  return join(rootPath, 'ocr')
}

/**
 * Languages available in an assets dir: every `<lang>.traineddata.gz` (the shipped
 * layout; plain `.traineddata` is NOT accepted — one layout, one code path). Sorted
 * for determinism; 'deu' and 'eng' are what the build pipeline vendors.
 */
export function listOcrLanguages(assetsDir: string): string[] {
  if (!existsSync(assetsDir)) return []
  let names: string[]
  try {
    names = readdirSync(assetsDir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.traineddata.gz'))
    .map((n) => n.slice(0, -'.traineddata.gz'.length))
    .filter((lang) => /^[a-z_]{3,}$/i.test(lang))
    .sort()
}

export interface OcrSelectionDeps {
  /** Drive root — the assets live at `<root>/ocr/`. */
  rootPath: string
  listLanguages?: (assetsDir: string) => string[]
  makeEngine?: (langDir: string, languages: string[]) => OcrEngine
  onSelect?: (kind: 'tesseract' | 'none', reason: string) => void
}

/**
 * Build the active `OcrEngine`, or null when the language files are absent.
 * Construction is cheap (the tesseract worker starts lazily on first recognition),
 * so this returns synchronously like the transcriber selector.
 */
export function createSelectedOcrEngine(deps: OcrSelectionDeps): OcrEngine | null {
  const dir = ocrAssetsDir(deps.rootPath)
  const listLanguages = deps.listLanguages ?? listOcrLanguages
  const makeEngine =
    deps.makeEngine ??
    ((langDir: string, languages: string[]) =>
      createTesseractOcrEngine({ langDir, languages }))

  const languages = listLanguages(dir)
  if (languages.length === 0) {
    deps.onSelect?.('none', 'no OCR language files on the drive')
    return null
  }
  deps.onSelect?.('tesseract', `language files present: ${languages.join(', ')}`)
  return makeEngine(dir, languages)
}
