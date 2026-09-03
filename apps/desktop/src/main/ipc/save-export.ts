import { BrowserWindow, dialog } from 'electron'
import { open as openFileAsync, rename as renameAsync, rm as rmAsync } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// The shared "export to a user-chosen file" step used by the audit-log, transcript,
// document and skills exports. The dialog + fs run in MAIN (the renderer has no fs/dialog
// access). Logging/audit stays at the call sites — what may be recorded differs per
// export (the audit privacy rule: ids only, never titles/paths derived from content).

export interface SaveExportDialogOptions {
  title: string
  defaultPath: string
  filters: Electron.FileFilter[]
  /** Optional extra dialog text — the encryption-boundary warning's macOS save-sheet
   *  voice (`review.export.encryptionWarning` precedent). Other platforms ignore it;
   *  the renderer shows the same copy BEFORE the dialog on every platform. */
  message?: string
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
 * cancelled. The write is the same async atomic tail as `saveBinaryExport` (#256): it used
 * to be `writeFileSync` on the Electron MAIN thread, so a multi-megabyte export to a slow
 * USB drive stalled every window and every pending IPC reply for the whole write.
 */
export async function saveTextExport(
  options: SaveExportDialogOptions,
  content: string
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await writeAtomic(result.filePath, Buffer.from(bomFor(result.filePath) + content, 'utf8'))
  return result.filePath
}

/**
 * The evidence-pack `writePackFileAtomic` tail: tmp sibling in the destination's own
 * directory (same volume ⇒ the rename is atomic) → short-write check → fsync → rename, so a
 * failure up to the rename leaves NO destination file and no half-written export can ever
 * exist. The tmp sibling carries a per-call random token (the AUD-17 posture): two
 * concurrent exports to one destination share no scratch file — the later rename simply
 * replaces the earlier file, as any second save to one path does.
 */
async function writeAtomic(destPath: string, bytes: Buffer): Promise<void> {
  const tmpPath = `${destPath}.${randomUUID().replace(/-/g, '')}.tmp`
  try {
    const fd = await openFileAsync(tmpPath, 'w')
    try {
      const { bytesWritten } = await fd.write(bytes, 0, bytes.length, null)
      // POSIX permits short writes; a truncated export must refuse, not half-succeed.
      if (bytesWritten !== bytes.length) {
        throw new Error(`export: short write (${bytesWritten}/${bytes.length} bytes)`)
      }
      await fd.sync()
    } finally {
      // Never swallow a close failure: an unclosed handle keeps the tmp sibling locked on
      // Windows and would defeat the cleanup below.
      await fd.close()
    }
    await renameAsync(tmpPath, destPath)
  } catch (err) {
    try {
      await rmAsync(tmpPath, { force: true })
    } catch {
      /* best-effort cleanup — the original failure is the error that matters */
    }
    throw err
  }
}

/**
 * Show a save dialog and write BINARY `content` to the chosen file ATOMICALLY — the
 * evidence-pack `writePackFileAtomic` tail: tmp sibling in the destination's own directory
 * (same volume ⇒ the rename is atomic) → short-write check → fsync → rename, so a failure
 * up to the rename leaves NO destination file and no half-written export can ever exist.
 * Bytes are written VERBATIM: no BOM (`bomFor` is a plain-text concern), no encoding.
 * Returns the saved path, or null when the user cancelled.
 *
 * Callers (#90 hoist): the document original export (`docs:exportOriginal`) and the skills
 * same-format DOCX export (previously a module-local closure in `registerSkillsIpc`, which
 * wrote non-atomically). The atomic tail itself is `writeAtomic` (shared with the text
 * writer since #256).
 */
export async function saveBinaryExport(
  options: SaveExportDialogOptions,
  content: Uint8Array
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await writeAtomic(result.filePath, Buffer.isBuffer(content) ? content : Buffer.from(content))
  return result.filePath
}
