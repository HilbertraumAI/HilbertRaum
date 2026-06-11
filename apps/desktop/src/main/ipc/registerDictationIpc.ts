import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { documentsDir } from '../services/ingestion'
import { shredFile } from '../services/workspace-vault'
import { log } from '../services/logging'

// Phase 37 — voice dictation (wave-3 plan §10, locked design D30). The renderer
// records and resamples in-page and sends WAV BYTES (never a path); this handler
// writes them to a transient temp file — the whisper CLI takes file paths only
// (D34) — runs the Phase-36 transcriber, shreds the temp, and returns plain text
// for the composer to insert. Privacy posture:
//   • The temp WAV lives in the workspace documents dir under the `.parse` infix,
//     so the startup `shredStalePlaintext` crash sweep covers a crash mid-dictation
//     (the documented ingestion-temp pattern), and it is shredded in `finally`.
//   • No audit event — dictation is content-adjacent, like search (plan §12).
//   • Errors back to the renderer are friendly §11.4 copy; the technical reason
//     goes to the local log only (transcriber error tails are stderr-only — never
//     transcript content, the Phase-36 guarantee).

/** Friendly refusal when no transcriber is selected (binary or weights absent). The
 *  renderer hides the mic in this state, so this is a defensive backstop. */
export const DICTATION_UNAVAILABLE_MESSAGE =
  'Voice dictation is not available — the speech model is not installed on this drive.'

/** Friendly catch-all for a failed transcription (§11.4 — never the raw CLI error). */
export const DICTATION_FAILED_MESSAGE = 'Could not transcribe that — try again.'

/** Refusal for an implausibly large recording. 64 MB ≈ 35 min of 16 kHz mono PCM16 —
 *  far past any composer dictation; anything bigger belongs in a document import. */
export const DICTATION_MAX_BYTES = 64 * 1024 * 1024
export const DICTATION_TOO_LONG_MESSAGE =
  'That recording is too long for dictation. For long recordings, import the audio file as a document instead.'

export function registerDictationIpc(ctx: AppContext): void {
  const storeDir = documentsDir(ctx.paths.workspacePath)

  ipcMain.handle(IPC.transcribeDictation, async (_e, audio: unknown): Promise<string> => {
    const transcriber = ctx.transcriber
    if (!transcriber) throw new Error(DICTATION_UNAVAILABLE_MESSAGE)
    // IPC delivers the renderer's Uint8Array as a Buffer (a Uint8Array subclass).
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
      throw new Error(DICTATION_FAILED_MESSAGE)
    }
    if (audio.byteLength > DICTATION_MAX_BYTES) throw new Error(DICTATION_TOO_LONG_MESSAGE)

    const tempPath = join(storeDir, `${randomUUID()}.parse-dictation.wav`)
    try {
      writeFileSync(tempPath, audio)
      const segments = await transcriber.transcribe(tempPath, { workDir: storeDir })
      return segments
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    } catch (err) {
      // The reason is for the local log only (stderr tails, never content); the
      // renderer gets the friendly copy.
      log.warn('Dictation transcription failed', { error: String(err) })
      throw new Error(DICTATION_FAILED_MESSAGE)
    } finally {
      shredFile(tempPath)
    }
  })
}
