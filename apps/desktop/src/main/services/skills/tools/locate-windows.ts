// The line-numbered, overlapping windows both LLM locate passes walk — the redaction locate
// (architecture.md "Skills — design record" §21) and the document-edit locate (§22). One builder so
// the two passes cannot drift apart (#583). Pure: no runtime, no fs.

/** Window sizing: line-numbered windows with overlap so a span straddling a window edge is seen whole
 *  in at least one window. Lines-based (not char-based) so line numbers stay stable + reportable. */
const WINDOW_LINES = 40
const WINDOW_OVERLAP_LINES = 8

/** Number the given lines with their GLOBAL 1-based line number, tab-separated (`12\ttext`). The
 *  global numbering lets the model's reported line map to the whole document across windows. */
function numberWindow(lines: readonly string[], startLine: number): string {
  return lines.map((text, i) => `${startLine + i}\t${text}`).join('\n')
}

/** One overlapping window over the document's lines: the global start/end line (1-based, inclusive)
 *  and the line-numbered text to feed the model. */
export interface LocateWindow {
  startLine: number
  endLine: number
  numbered: string
}

/**
 * Split `text` into overlapping, line-numbered windows (WINDOW_LINES per window, stepping by
 * WINDOW_LINES - WINDOW_OVERLAP_LINES). The overlap means a span that would straddle a plain window
 * boundary appears WHOLE in at least one window. Empty text ⇒ no windows.
 */
export function buildLocateWindows(text: string): LocateWindow[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  const step = Math.max(1, WINDOW_LINES - WINDOW_OVERLAP_LINES)
  const windows: LocateWindow[] = []
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + WINDOW_LINES)
    windows.push({
      startLine: start + 1,
      endLine: start + slice.length,
      numbered: numberWindow(slice, start + 1)
    })
    if (start + WINDOW_LINES >= lines.length) break // the last window reached the end
  }
  return windows
}
