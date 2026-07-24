import { rm as rmAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { SECURE_WINDOW_WEB_PREFERENCES } from '../../window-security'
import { log } from '../logging'
import { installNavigationGuard } from '../navigation-guard'
import { escapeHtml } from './render-html'

// Evidence-pack PDF print harness (EP-1 plan §11 item 1, D-1): render the Phase-3 HTML
// pack — UNCHANGED — in a dedicated hidden BrowserWindow and hand back the
// `webContents.printToPDF` bytes. The OCR rasterizer is the hidden-window precedent
// (SECURE_WINDOW_WEB_PREFERENCES posture, per-task window, destroy-in-finally, step
// timeout); this window is even more locked down: NO preload at all — the page is inert
// print content, nothing ever talks to it over IPC.
//
// Print contract (D-1 research record, plan §4 — pinned by the unit suite):
//  - The HTML template's `@page { size: A4; margin: 18mm 16mm }` is AUTHORITATIVE for the
//    page geometry: `preferCSSPageSize: true` + `pageSize: 'A4'` (the fallback when a
//    stylesheet-less document ever reaches this — it never should).
//  - `generateDocumentOutline: true` turns the template's semantic h1→h2→h3 tree into PDF
//    bookmarks (render-html.ts PRINT CONTRACT: exactly 1×h1 + 8×h2 + h3 subsections, no
//    h4+).
//  - `generateTaggedPDF: true` asks for an accessible tagged PDF. EXPERIMENTAL per the
//    Electron docs (still so in Electron 39; "may not adhere fully to PDF/UA and WCAG standards") — the docs
//    state this honestly (known-limitations.md): accessible headings/reading order are
//    best-effort, never a PDF/UA claim.
//  - Footer = pack ID + `pageNumber`/`totalPages` (spec §17.1 repeating footer). Chromium
//    header/footer templates run in a bare print context: SYSTEM font stack + inline
//    styles only — `@font-face` inside a template makes the whole print fail (D-1 pitfall
//    list), and the default template font-size is unusable, so both are explicit.
//  - `displayHeaderFooter: true` would also stamp Chromium's DEFAULT header (print date +
//    document title) on every page — content the pack never promised. An empty-span
//    `headerTemplate` suppresses it; the footer is the only chrome.
//  - Print only after `did-finish-load` AND `document.fonts.ready` (D-1 pitfall: fonts
//    settling after load). `loadFile`'s promise IS the did-finish-load wait (it resolves
//    on finish, rejects on did-fail-load); the fonts wait is an explicit
//    `executeJavaScript` round trip.
//
// Lifecycle: the window is created per print and destroyed in `finally` — on success, on
// every failure, AND on app quit (a `before-quit` hook destroys it so a quit mid-print
// can never leave a hidden window pinning the process; `window-all-closed` counts hidden
// windows too). Each print gets its OWN window and shares no channels, so concurrent
// prints are independent — no busy latch needed (unlike the rasterizer's fixed IPC
// channel pair). Concurrent prints also share no FILE: the caller hands in a print-source
// path made unique per export (AUD-17 — a name derived only from the destination let two
// same-destination exports print each other's bytes; the atomic pipeline owns that naming
// rule and documents the incident). A wedged renderer fails the step timeout rather than
// hanging the export.
//
// The print SOURCE is a transient `.print.tmp.html` SIBLING of the user-chosen
// destination (the atomic pipeline hands the path in): `loadFile` needs a real file with
// an .html extension (Chromium sniffs file:// MIME from the extension — a wrong extension
// renders the markup as plain text and would print garbage), a data: URL has a ~2 MB
// navigation cap a large pack could exceed, and the user-chosen directory is exactly the
// place this content is ALREADY sanctioned to exist in plaintext (§24.3 warning) — never
// an OS temp dir. It is removed in the same `finally`, with one retry and an honest log
// line when the removal fails (AUD-16, see `removePrintSource`); crash residue matches the
// `${dest}.tmp` class the atomic writer already accepts.
//
// No network anywhere: the pack HTML is self-contained (golden-pinned: zero remote refs),
// the window denies every navigation/window-open, and the smoke suite watches the
// session's request log + the offline connect-guard across a real print.

/** Per-step (load / fonts / print) timeout — a wedged hidden renderer must fail the
 *  export, not hang it (the rasterizer's RASTER_STEP_TIMEOUT_MS discipline). */
export const PRINT_STEP_TIMEOUT_MS = 60_000

/** Pause before the single print-source cleanup retry. A scanner's handle is released
 *  within a moment of the file going quiet, so one short wait converts almost every
 *  transient lock into a clean removal; it costs nothing on the normal path (the first
 *  removal succeeds and never reaches the retry). */
const PRINT_SOURCE_RETRY_DELAY_MS = 250

/** System-font stack for the footer template — mirrors the pack body stack
 *  (render-html.ts); no `@font-face`, ever (D-1: custom fonts in header/footer templates
 *  fail the print). */
const FOOTER_FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

/**
 * The full D-1 option set for one pack print (installed Electron 39 supports every option
 * — verified against the local `electron.d.ts`, not assumed; re-smoked on the 39.8.10 packaged
 * build, DEP-1 P4). Exported so the unit suite
 * pins the literals: a dropped `preferCSSPageSize` or a template `@font-face` would
 * otherwise ship green.
 */
export function buildEvidencePackPrintOptions(packId: string): Electron.PrintToPDFOptions {
  const id = escapeHtml(packId)
  return {
    pageSize: 'A4',
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: true,
    // Suppress Chromium's default date/title header — the footer is the only chrome.
    headerTemplate: '<span></span>',
    footerTemplate:
      `<div style="width: 100%; font-family: ${FOOTER_FONT_STACK}; font-size: 8px; ` +
      'color: #444444; padding: 0 16mm; display: flex; justify-content: space-between;">' +
      `<span>${id}</span>` +
      '<span><span class="pageNumber"></span>/<span class="totalPages"></span></span>' +
      '</div>',
    generateDocumentOutline: true,
    generateTaggedPDF: true
  }
}

export interface PrintEvidencePackPdfOptions {
  /** The pack ID minted by the export pipeline — repeated in every page footer. */
  packId: string
  /** Absolute path for the transient print-source HTML. MUST end in `.html` (file:// MIME
   *  is sniffed from the extension), live next to the chosen destination (see the module
   *  header) and be UNIQUE to this export — two prints sharing one path print each other's
   *  documents (AUD-17). Written, loaded, and always removed here. */
  sourceHtmlPath: string
}

/** The OS error code of a failed fs call, or 'unknown'. Deliberately NOT the message: an
 *  fs error message embeds the PATH, and the print source sits next to a user-chosen
 *  destination whose file name is seeded from the review title — content, never logged. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'unknown'
}

/**
 * Remove the transient print source, with ONE retry and an honest log line (AUD-16).
 *
 * The file is a plaintext copy of already-rendered pack content sitting beside the user's
 * destination. On Windows an antivirus scanner or the search indexer routinely opens a
 * freshly written HTML file, and a handle held without FILE_SHARE_DELETE makes the unlink
 * throw (EBUSY/EPERM) — the handle is released a moment later, which is exactly what the
 * single delayed retry is for. This used to be a bare `catch {}` in a module that imported
 * no logger, so a failed cleanup left that copy on disk with no trace at all; now every
 * outcome is recorded. Cleanup never fails the print: an exported pack that is already on
 * disk must not be reported as a failure because a temporary file lingered.
 *
 * The log stays IDS ONLY — the pack id (a freshly minted random UUID) and the OS error
 * code. Never the path, never a byte of the pack.
 */
async function removePrintSource(sourceHtmlPath: string, packId: string): Promise<void> {
  try {
    await rmAsync(sourceHtmlPath, { force: true })
    return
  } catch (err) {
    log.warn('evidence pdf: print source could not be removed — retrying once', {
      packId,
      code: errorCode(err)
    })
  }
  await new Promise((resolve) => setTimeout(resolve, PRINT_SOURCE_RETRY_DELAY_MS))
  try {
    await rmAsync(sourceHtmlPath, { force: true })
  } catch (err) {
    log.warn(
      'evidence pdf: print source still present after the retry — a plaintext copy of this pack remains beside the exported file',
      { packId, code: errorCode(err) }
    )
  }
}

/** Reject `promise` after {@link PRINT_STEP_TIMEOUT_MS}; the caller's `finally` destroys
 *  the window, so a timed-out step can never leave a hidden window behind. */
async function withStepTimeout<T>(promise: Promise<T>, step: string): Promise<T> {
  // A step that LOSES the race still settles later (usually rejecting once the finally
  // destroys the window) — mark it handled so it can never surface as a spurious
  // unhandled rejection. Does not affect the race: that awaits its own registration.
  promise.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`evidence pdf: the ${step} step took too long`)),
          PRINT_STEP_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Print `html` (the UNCHANGED `renderEvidencePackHtml` output) to PDF bytes through a
 * dedicated hidden sandboxed window. Throws on any failure — load error, wedged step,
 * print failure, app quit mid-print — after tearing the window and the transient source
 * file down. The window is never left behind; the source file removal is attempted twice
 * and, in the rare case the OS still refuses (see `removePrintSource`), the leftover is
 * LOGGED rather than hidden. The caller (the atomic export pipeline) owns what happens to
 * the bytes: nothing is written to the destination here.
 */
export async function printEvidencePackHtmlToPdf(
  html: string,
  opts: PrintEvidencePackPdfOptions
): Promise<Buffer> {
  let win: BrowserWindow | null = null
  // App-quit teardown (plan §11): destroying the window rejects the pending load/print
  // step, so the export fails cleanly (no file, no row) instead of stalling the quit.
  const onBeforeQuit = (): void => {
    if (win && !win.isDestroyed()) win.destroy()
  }
  try {
    // Inside the try (FIX-2): a partial write (ENOSPC mid-stream) is decrypted pack
    // content on disk — the finally's force-remove must cover it, not just later steps.
    // AUD-15: ASYNC like the atomic writer's tail — a multi-megabyte pack's print source
    // used to be written synchronously on the Electron MAIN thread, stalling the whole
    // process (every window, every IPC reply) for the duration.
    await writeFileAsync(opts.sourceHtmlPath, html, 'utf8')
    win = new BrowserWindow({
      show: false,
      // A worker, not a UI: never in the taskbar or any window list (rasterizer posture).
      skipTaskbar: true,
      // Deliberately no preload script — the page is inert print content with no IPC
      // surface (the wiring pin test enforces this stays true).
      webPreferences: { ...SECURE_WINDOW_WEB_PREFERENCES }
    })
    // The pack is self-contained local content — deny every window-open and navigation
    // (both will-navigate AND will-redirect; SEC-3). The main-side loadFile below does
    // not fire will-navigate, so deny-all is safe (rasterizer precedent).
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    installNavigationGuard(win.webContents, () => false)
    app.once('before-quit', onBeforeQuit)

    await withStepTimeout(win.loadFile(opts.sourceHtmlPath), 'load')
    // D-1: print only after did-finish-load (the loadFile promise) AND fonts settled.
    // executeJavaScript is main-initiated — it works in the sandboxed, preload-free page.
    await withStepTimeout(
      win.webContents.executeJavaScript('document.fonts.ready.then(() => true)'),
      'fonts'
    )
    const pdf = await withStepTimeout(
      win.webContents.printToPDF(buildEvidencePackPrintOptions(opts.packId)),
      'print'
    )
    return Buffer.from(pdf)
  } finally {
    app.removeListener('before-quit', onBeforeQuit)
    if (win && !win.isDestroyed()) win.destroy()
    await removePrintSource(opts.sourceHtmlPath, opts.packId)
  }
}
