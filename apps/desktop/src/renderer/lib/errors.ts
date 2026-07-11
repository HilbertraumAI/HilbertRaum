// Electron wraps an error thrown by an ipcMain.handle handler as
// "Error invoking remote method 'channel': Error: <the real message>" before it
// reaches the renderer. Our main-process messages are already friendly (spec §11.4) —
// strip the transport prefix so users see only the message itself. The leading error name
// can be a custom Error subclass (e.g. "ChatRequestError:"), not just "Error:", so strip
// any `WordError:` prefix — otherwise the class name leaks into the user-visible message.
export function friendlyIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^\w*Error:\s*/, '')
}

/**
 * Await a click-handler's async work and SURFACE a failure instead of dropping it
 * (full-audit 2026-07-11 CODE-26..29 class fix). The bare `void handler()` idiom
 * discarded the promise: a rejection became an unhandled rejection with zero user
 * feedback, leaving the UI stuck in its pre-click state (an unlocked shell after a
 * failed "Lock now", a spinning row after a failed cancel). This awaits, catches,
 * strips the IPC transport prefix via `friendlyIpcError`, and hands the friendly
 * message to the call site's own surface (banner or toast — per-site choice). Never
 * rejects, so `void runAndSurface(…)` at a JSX call site is genuinely fire-safe.
 */
export async function runAndSurface(
  fn: () => unknown,
  onError: (message: string) => void
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    onError(friendlyIpcError(err))
  }
}
