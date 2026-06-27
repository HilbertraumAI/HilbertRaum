import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { documentsDir } from '../services/ingestion'
import { shredFile } from '../services/workspace-vault'
import { log } from '../services/logging'

// Voice dictation IPC (wave-3 plan §10). The renderer records and resamples
// in-page and sends WAV BYTES (never a path); this handler writes them to a
// transient temp file — the whisper CLI takes file paths only — runs the
// transcriber, shreds the temp, and returns plain text for the composer to
// insert. Privacy posture:
//   • The temp WAV lives in the workspace documents dir under the `.parse` infix,
//     so the startup `shredStalePlaintext` crash sweep covers a crash mid-dictation
//     (the ingestion-temp pattern), and it is shredded in `finally`.
//   • No audit event — dictation is content-adjacent, like search.
//   • Errors back to the renderer are friendly copy; the technical reason goes to
//     the local log only (transcriber error tails are stderr-only — never
//     transcript content).

/** Friendly refusal when no transcriber is selected (binary or weights absent). The
 *  renderer hides the mic in this state, so this is a defensive backstop. */
export const DICTATION_UNAVAILABLE_MESSAGE =
  'Voice dictation is not available — the speech model is not installed on this drive.'

/** Friendly catch-all for a failed transcription (never the raw CLI error). */
export const DICTATION_FAILED_MESSAGE = 'Could not transcribe that — try again.'

/** Refusal for an implausibly large recording. 64 MB ≈ 35 min of 16 kHz mono PCM16 —
 *  far past any composer dictation; anything bigger belongs in a document import. */
export const DICTATION_MAX_BYTES = 64 * 1024 * 1024
export const DICTATION_TOO_LONG_MESSAGE =
  'That recording is too long for dictation. For long recordings, import the audio file as a document instead.'

/** Refusal when a dictation is already transcribing (REL-3 concurrency guard). The
 *  renderer disables the mic while one is in flight; this is the defensive backstop that
 *  keeps rapid mic presses from spawning N concurrent whisper children. */
export const DICTATION_BUSY_MESSAGE = 'Still transcribing the last dictation — one moment.'

/**
 * Wall-clock ceiling for a single dictation (REL-3). The recording is already capped at
 * `DICTATION_MAX_BYTES` (~35 min of audio); transcription should never run much past that,
 * so a child still going at this point is wedged. On expiry the whisper child is killed via
 * the abort signal and the renderer gets the friendly failure copy instead of a hung mic
 * spinner. Override with `HILBERTRAUM_DICTATION_TIMEOUT_MS`.
 */
export const DEFAULT_DICTATION_TIMEOUT_MS = 10 * 60 * 1000

function resolveDictationTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit
  const env = Number(process.env.HILBERTRAUM_DICTATION_TIMEOUT_MS)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_DICTATION_TIMEOUT_MS
}

/** Test seam: dial the wall-clock ceiling down. Prod calls `registerDictationIpc(ctx)`. */
export interface DictationIpcOptions {
  maxDurationMs?: number
}

export function registerDictationIpc(ctx: AppContext, options: DictationIpcOptions = {}): void {
  const storeDir = documentsDir(ctx.paths.workspacePath)
  const maxDurationMs = resolveDictationTimeoutMs(options.maxDurationMs)
  // Single-flight guard: whisper is NOT internally serialized, so without this a second
  // mic press would spawn a concurrent child (REL-3). Reject the second invocation rather
  // than queue it — dictation is interactive, a stale queued result would surprise the user.
  let inFlight = false

  ipcMain.handle(IPC.transcribeDictation, async (_e, audio: unknown): Promise<string> => {
    const transcriber = ctx.transcriber
    if (!transcriber) throw new Error(DICTATION_UNAVAILABLE_MESSAGE)
    // IPC delivers the renderer's Uint8Array as a Buffer (a Uint8Array subclass).
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
      throw new Error(DICTATION_FAILED_MESSAGE)
    }
    if (audio.byteLength > DICTATION_MAX_BYTES) throw new Error(DICTATION_TOO_LONG_MESSAGE)
    // Refuse a concurrent dictation BEFORE touching disk or spawning (no double-spawn).
    if (inFlight) throw new Error(DICTATION_BUSY_MESSAGE)
    inFlight = true

    // Wall-clock bound: abort (→ kills the whisper child → transcribe rejects) so a wedged
    // child can never hang the mic spinner forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), maxDurationMs)

    const tempPath = join(storeDir, `${randomUUID()}.parse-dictation.wav`)
    try {
      writeFileSync(tempPath, audio)
      const segments = await transcriber.transcribe(tempPath, {
        workDir: storeDir,
        signal: controller.signal
      })
      return segments
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    } catch (err) {
      // The reason is for the local log only (stderr tails, never content); the
      // renderer gets the friendly copy (timeout included — a wedged child is a failure).
      log.warn('Dictation transcription failed', { error: String(err) })
      throw new Error(DICTATION_FAILED_MESSAGE)
    } finally {
      clearTimeout(timer)
      shredFile(tempPath)
      inFlight = false
    }
  })
}
