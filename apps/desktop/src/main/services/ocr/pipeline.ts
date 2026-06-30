// OCR page pipelining (ING-5). Pure orchestration — no Electron — so it is unit-testable
// with fake render/recognize functions and reusable by the hidden-window rasterizer.

/**
 * Drive `pageCount` pages with a bounded 1-deep look-ahead (ING-5): render page N+1 while
 * page N's `onPage` (recognition) is still running, but keep recognitions serial and in
 * order. Render (pdfjs) and recognize (e.g. WASM tesseract) are different engines, so they
 * pipeline instead of running strictly serially.
 *
 * Ordering: `onPage` is invoked 1,2,3,… and the previous one is awaited before the next
 * starts. Memory: at most two PNGs are live at once (the one being recognized + the one just
 * rendered ahead) — "one extra" over a strictly-serial loop. Cancellation: `signal` is
 * checked before each render and before each `onPage`; on any throw the in-flight recognition
 * is awaited (errors swallowed) so it never leaks as an unhandled rejection.
 */
export async function pipelinePages(
  pageCount: number,
  renderPage: (pageNumber: number) => Promise<Buffer>,
  onPage: (pageNumber: number, png: Buffer) => void | Promise<void>,
  opts?: { signal?: AbortSignal; abortError?: () => Error }
): Promise<void> {
  const makeAbort = opts?.abortError ?? (() => new DOMException('aborted', 'AbortError'))
  let prevOnPage: Promise<void> | null = null
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (opts?.signal?.aborted) throw makeAbort()
      // Render N. On every iteration after the first this runs WHILE recognize(N-1) is in
      // flight — the look-ahead overlap.
      const png = await renderPage(pageNumber)
      // Hold here until the previous recognition finishes: serializes recognitions, keeps
      // them in order, and bounds memory to one extra rendered PNG.
      if (prevOnPage) await prevOnPage
      if (opts?.signal?.aborted) throw makeAbort()
      // Start recognize(N) but do NOT await it — the next render overlaps it.
      prevOnPage = Promise.resolve(onPage(pageNumber, png))
    }
    // Drain the LAST recognition. R4 (full-audit-2026-06-30, Phase C): null `prevOnPage` BEFORE
    // awaiting it so that if this final recognition rejects, the catch below does NOT re-await the
    // SAME already-settled promise — there is no still-pending look-ahead for the last page. The
    // catch's drain is then reserved for a genuine in-flight recognition (a render/abort throw mid
    // loop while recognize(N-1) is still running).
    const last = prevOnPage
    prevOnPage = null
    if (last) await last
  } catch (err) {
    if (prevOnPage) await prevOnPage.catch(() => undefined)
    throw err
  }
}
