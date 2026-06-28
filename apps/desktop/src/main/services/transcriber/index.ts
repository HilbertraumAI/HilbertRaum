// Transcriber contract (wave-3 plan §9). Turns an audio FILE into ordered,
// timestamped text segments — the AudioParser maps them onto `ExtractedSegment`s so a
// recording becomes a normal corpus document (chunked, embedded, searchable, citable
// with time ranges via `Citation.section`).
//
// Graceful-fallback rule (same pattern as the reranker): there is NO mock transcriber.
// When the whisper-cli binary or the weights are absent the factory returns null and an
// audio import fails per-file with friendly copy — a mock would invent a transcript
// and silently corrupt the corpus.
//
// The transcriber invokes the pinned whisper.cpp CLI PER FILE rather than composing
// a whisper-server sidecar. Rationale: (1) upstream ships prebuilt binaries for
// Windows only, so there is no per-OS server-ship advantage; (2) ingestion is batch
// per-file — model-load cost is small next to transcription time; (3) the CLI emits
// segments + `-pp` progress while it works, with no HTTP protocol; (4) no
// multi-hundred-MB upload over loopback, no port/health lifecycle — cancel/suspend is
// just killing the child process. The localhost-only sidecar rule is moot (no socket
// at all).

/** One transcribed span: `[startMs, endMs]` + the recognized text. */
export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
}

export interface TranscribeOptions {
  /** ISO 639-1 hint; default `auto` (whisper detects the spoken language). */
  language?: string
  /** Coarse progress callback (0–100), parsed from the CLI's `-pp` output. */
  onProgress?: (percent: number) => void
  /**
   * Directory for the transient transcript JSON the CLI writes (content!). REQUIRED
   * (REL-6): the transient must land in a swept directory — callers pass the workspace
   * documents dir, where the `.parse` infix keeps it covered by the startup crash sweep.
   * There is deliberately NO OS-tmpdir default: tmpdir is outside the sweep, so a forgotten
   * `workDir` would strand recognised speech (content) on disk. Make it explicit, always.
   */
  workDir: string
  /** Abort: kills the CLI child; the returned promise rejects. */
  signal?: AbortSignal
}

/** The contract a transcription backend implements (mirrors `Embedder`/`Reranker`). */
export interface Transcriber {
  /** The transcriber model id (manifest id) — diagnostics/logging only, never stored. */
  readonly id: string
  /** Transcribe one audio file into ordered, timestamped segments. `opts.workDir` is
   *  REQUIRED (REL-6) so the transient transcript never lands outside the crash sweep. */
  transcribe(filePath: string, opts: TranscribeOptions): Promise<TranscriptSegment[]>
  /** Release the backend PERMANENTLY (kills any in-flight CLI child). On `will-quit`. */
  stop?(): Promise<void>
  /** Interrupt for a workspace lock; the next use starts fresh (per-file CLI). */
  suspend?(): Promise<void>
}

export {
  WhisperCliTranscriber,
  createWhisperCliTranscriber,
  resolveWhisperCliPath,
  whisperCliBinaryName,
  whisperCliDir
} from './cli'
export type { WhisperCliOptions } from './cli'
export { createSelectedTranscriber } from './factory'
export type { TranscriberModelInfo, TranscriberSelectionDeps } from './factory'
