import { BrowserWindow } from 'electron'
import { EVENTS } from '../../shared/ipc'
import type { AppSettings } from '../../shared/types'

// The Performance screen's push (PR #303 audit remediation P3, owner decision G6): a
// payload-free `performance:changed` to every live window, meaning "re-read `performance:get`".
// The screen has no other way to learn about a run it did not start (the first-run benchmark,
// the moved-drive restore, a run pressed in another window), a sample a model start just
// produced, or a sidecar unloading after its idle window — and interval polling was ruled out.
//
// Rules the emit sites keep:
//   - notify AFTER the mutation (the persist, the release, the latch write), never before, so
//     the re-read the renderer issues on receipt sees the new state;
//   - never from `buildPerformanceSnapshot` or any other getter (a read must not fan out into
//     more reads);
//   - this module reads no DB and no settings — it only sends.
//
// Every send is isolated: a destroyed window, a recipient whose `webContents` throws, or a
// sink a test installed that throws can never block the other windows, the persistence that
// triggered the push, or startup. No coalescing here — the renderer serialises its refetches.

/**
 * The settings keys `buildPerformanceSnapshot` reads that the generic `settings:update`
 * channel can change: a patch touching one of them pushes the screen's re-read; every other
 * settings write stays silent. (`activeModelId` also moves through `models:select` /
 * `models:use`, which push on their own; `gpuProbe`, `modelPlacements`, `lastBenchmark` and
 * `benchmarkHistory` are written only by the seams that already push.)
 */
export const PERFORMANCE_SETTINGS_KEYS: ReadonlyArray<keyof AppSettings> = [
  'activeModelId',
  'activeEmbeddingModelId',
  'contextTokens',
  'contextTokensOverride',
  'gpuMode'
]

type PerformanceChangedSink = () => void

let sink: PerformanceChangedSink | null = null

function broadcastToWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(EVENTS.performanceChanged)
    } catch {
      /* one dead recipient never blocks the next */
    }
  }
}

/**
 * Tell every live window that the Performance snapshot changed. Call it after the mutation.
 * Never throws — `BrowserWindow` being unavailable (a headless test harness) and a throwing
 * sink are both swallowed.
 */
export function notifyPerformanceChanged(): void {
  try {
    ;(sink ?? broadcastToWindows)()
  } catch {
    /* a notification is a courtesy to the screen, never the mutation's problem */
  }
}

/**
 * Test seam: replace the window broadcast with `fn` (null restores the default). Production
 * never calls this — the default is the only sink the app uses.
 */
export function setPerformanceChangedSink(fn: PerformanceChangedSink | null): void {
  sink = fn
}
