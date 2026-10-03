import { app, BrowserWindow } from 'electron'
import { printPages } from '../../app-protocol'
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
//    Electron docs (still so in Electron 43; "may not adhere fully to PDF/UA and WCAG standards") — the docs
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
//    settling after load). `loadURL`'s promise IS the did-finish-load wait (it resolves
//    on finish, rejects on did-fail-load); the fonts wait is an explicit
//    `executeJavaScript` round trip.
//
// Lifecycle: the window is created per print and destroyed in `finally` — on success, on
// every failure, AND on app quit (a `before-quit` hook destroys it so a quit mid-print
// can never leave a hidden window pinning the process; `window-all-closed` counts hidden
// windows too). Each print gets its OWN window and shares no channels, so concurrent
// prints are independent — no busy latch needed (unlike the rasterizer's fixed IPC
// channel pair). A wedged renderer fails the step timeout rather than hanging the export.
//
// The page is served FROM MEMORY (#563): `printPages.open` holds the HTML under a random
// token and the window loads `hilbertraum://print/<token>`, served by the app's own scheme
// handler (app-protocol.ts) at most once and dropped in the `finally`. Nothing is written to
// disk. Until #563 the page was a transient `.print.tmp.html` file beside the user's
// destination — a plaintext copy of the decrypted pack for the length of the print, left
// behind by a crash or a scanner's handle — removed with one retry and a log line (AUD-16).
// Each print has its own token, so concurrent prints share nothing (AUD-17's print-source
// half: a name derived from the destination once let two exports print each other's bytes).
// A protocol response has no navigation-size cap (a `data:` URL is capped at ~2 MB). The
// print origin is not the app pages' origin, so they cannot read a print page; it runs no
// script and loads no subresource (its CSP, header and meta alike, allows inline styles
// only). `printPages` caps concurrent prints; a print over the cap fails before any window.
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
 * The full D-1 option set for one pack print (installed Electron 43 supports every option
 * — verified against the local `electron.d.ts`, not assumed; re-smoked on the 39.8.10 packaged
 * build in DEP-1 P4, and again on the 43.4.0 / Chromium 150 packaged build in DEP-4 P4
 * 2026-08-18: every option accepted, valid `%PDF-1.4 … %%EOF`, and `generateTaggedPDF`
 * emitted real `StructTreeRoot`/`MarkInfo` structures; the real-Electron smoke passed the same
 * on 43.7.7 in DEP-5, 2026-10-01 — still Experimental upstream, so this
 * remains a best-effort accessibility claim and NOT a PDF/UA conformance claim).
 * Exported so the unit suite
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
 * dedicated hidden sandboxed window that loads it from memory (`printPages`, #563). Throws
 * on any failure — too many prints at once, load error, wedged step, print failure, app quit
 * mid-print — after tearing the window down and dropping the page. Nothing is written to disk
 * here: the caller (the atomic export pipeline) owns what happens to the bytes.
 */
export async function printEvidencePackHtmlToPdf(
  html: string,
  opts: PrintEvidencePackPdfOptions
): Promise<Buffer> {
  // Before anything else: over the cap, the print fails without a window or a held page.
  const page = printPages.open(html)
  let win: BrowserWindow | null = null
  // App-quit teardown (plan §11): destroying the window rejects the pending load/print
  // step, so the export fails cleanly (no file, no row) instead of stalling the quit.
  const onBeforeQuit = (): void => {
    if (win && !win.isDestroyed()) win.destroy()
  }
  try {
    win = new BrowserWindow({
      show: false,
      // A worker, not a UI: never in the taskbar or any window list (rasterizer posture).
      skipTaskbar: true,
      // Deliberately no preload script — the page is inert print content with no IPC
      // surface (the wiring pin test enforces this stays true).
      webPreferences: { ...SECURE_WINDOW_WEB_PREFERENCES }
    })
    // The pack is self-contained content — deny every window-open and navigation (both
    // will-navigate AND will-redirect; SEC-3). The main-side loadURL below does not fire
    // will-navigate, so deny-all is safe (rasterizer precedent).
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    installNavigationGuard(win.webContents, () => false)
    app.once('before-quit', onBeforeQuit)

    await withStepTimeout(win.loadURL(page.url), 'load')
    // D-1: print only after did-finish-load (the loadURL promise) AND fonts settled.
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
    page.release()
  }
}
