import { rm as rmAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { SECURE_WINDOW_WEB_PREFERENCES } from '../../window-security'
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
// channel pair). The one shared thing two concurrent exports COULD collide on is the
// `.print.tmp.html` sibling when both target the SAME destination path: the loser's
// load/remove races the winner's, and it fails cleanly like any other print failure —
// no destination file, no row (the same posture as the atomic writer's shared
// `${dest}.tmp`). A wedged renderer fails the step timeout rather than hanging the export.
//
// The print SOURCE is a transient `.print.tmp.html` SIBLING of the user-chosen
// destination (the atomic pipeline hands the path in): `loadFile` needs a real file with
// an .html extension (Chromium sniffs file:// MIME from the extension — a wrong extension
// renders the markup as plain text and would print garbage), a data: URL has a ~2 MB
// navigation cap a large pack could exceed, and the user-chosen directory is exactly the
// place this content is ALREADY sanctioned to exist in plaintext (§24.3 warning) — never
// an OS temp dir. It is removed in the same `finally`; crash residue matches the
// `${dest}.tmp` class the atomic writer already accepts.
//
// No network anywhere: the pack HTML is self-contained (golden-pinned: zero remote refs),
// the window denies every navigation/window-open, and the smoke suite watches the
// session's request log + the offline connect-guard across a real print.

/** Per-step (load / fonts / print) timeout — a wedged hidden renderer must fail the
 *  export, not hang it (the rasterizer's RASTER_STEP_TIMEOUT_MS discipline). */
export const PRINT_STEP_TIMEOUT_MS = 60_000

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
   *  is sniffed from the extension) and live next to the chosen destination (see the
   *  module header). Written, loaded, and ALWAYS removed here. */
  sourceHtmlPath: string
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
 * file down; it never leaves either behind. The caller (the atomic export pipeline) owns
 * what happens to the bytes: nothing is written to the destination here.
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
    try {
      await rmAsync(opts.sourceHtmlPath, { force: true })
    } catch {
      /* best-effort cleanup — the print outcome is what matters */
    }
  }
}
