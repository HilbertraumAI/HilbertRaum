import { BrowserWindow, dialog } from 'electron'
import { writeFileSync } from 'node:fs'

// The shared "export to a user-chosen file" step used by the audit-log, transcript
// and document exports. The dialog + fs run in MAIN (the renderer has no fs/dialog
// access). Logging/audit stays at the call sites — what may be recorded differs per
// export (the audit privacy rule: ids only, never titles/paths derived from content).

export interface SaveExportDialogOptions {
  title: string
  defaultPath: string
  filters: Electron.FileFilter[]
}

/**
 * invoice-hardening-2026-07-04 P4: prefix a UTF-8 BOM on PLAIN-TEXT exports (.md/.txt) so legacy
 * Windows editors detect the encoding. Without it, an exported German transcript opened in a
 * CP1252-defaulting viewer rendered mojibake ("ausschlieÃlich" for "ausschließlich" — a real user's
 * bug report arrived pre-garbled this way). Windows is first-class (CLAUDE.md §0), and every modern
 * reader tolerates the BOM in md/txt.
 *
 * Audit 2026-07-16 F-10 (owner decision D-A, 2026-07-17): `.csv` gets the BOM too. Excel \u2014 the
 * PRIMARY consumer of a transactions/invoice CSV \u2014 opens a BOM-less UTF-8 .csv in the ANSI code page
 * on double-click, garbling every umlaut/\u00df in payee/description text (the same P4 mojibake class).
 * Re-import is safe: the app's own CSV parser (papaparse) strips a leading BOM itself. NEVER on
 * other extensions: a BOM breaks strict JSON parsers (the audit-log export) and is wrong for .log
 * tooling.
 */
export function bomFor(filePath: string): string {
  return /\.(?:md|txt|csv)$/i.test(filePath) ? '\ufeff' : ''
}

/**
 * Show a save dialog (parented to the focused window when there is one) and write
 * `content` to the chosen file. Returns the saved path, or null when the user
 * cancelled.
 */
export async function saveTextExport(
  options: SaveExportDialogOptions,
  content: string
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  writeFileSync(result.filePath, bomFor(result.filePath) + content, 'utf8')
  return result.filePath
}
