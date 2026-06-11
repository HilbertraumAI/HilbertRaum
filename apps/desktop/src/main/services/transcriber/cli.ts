import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { llamaOsDir, defaultThreadCount } from '../runtime/sidecar'
import { shredFile } from '../workspace-vault'
import type { TranscribeOptions, Transcriber, TranscriptSegment } from './index'

// whisper.cpp CLI transcriber (Phase 36, D34 — see index.ts for the CLI-over-server
// rationale). One child process per file: spawn the pinned `whisper-cli` with the GGML
// weights, let it write the full transcript JSON (`-oj`) to a TRANSIENT file, parse the
// `transcription[].offsets` (milliseconds) + text, shred the transient.
//
// R-W2 caveat (probed 2026-06-11): whisper-cli v1.8.6 EXITS 0 even when it cannot
// decode the input ("failed to read audio data" goes to stderr, no output is written).
// The exit code is therefore NOT trusted — success means "the JSON output exists and
// parses"; a missing/empty result with a decode complaint on stderr maps to a
// distinguishable DECODE error the parser turns into friendly §11.4 copy.

/** Platform-specific `whisper-cli` executable name. */
export function whisperCliBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
}

/** Directory that holds the whisper sidecar family: `runtime/whisper.cpp/<os>/`. */
export function whisperCliDir(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  return join(rootPath, 'runtime', 'whisper.cpp', llamaOsDir(platform))
}

/**
 * Resolve the `whisper-cli` binary, or `null` when it is absent (mirrors
 * `resolveLlamaServerPath`). A `PAID_WHISPER_BIN` env override points at an explicit
 * binary for dev (still validated for existence).
 */
export function resolveWhisperCliPath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const override = env.PAID_WHISPER_BIN?.trim()
  if (override) return existsSync(override) ? override : null
  const candidate = join(whisperCliDir(rootPath, platform), whisperCliBinaryName(platform))
  return existsSync(candidate) ? candidate : null
}

/** Marker prefix so the AudioParser can map a decode failure to friendly copy. */
export const AUDIO_DECODE_ERROR_PREFIX = 'AUDIO_DECODE_FAILED:'

/** Shape of the `-oj` output we rely on (whisper.cpp v1.8.6, verified R-W1). */
interface WhisperJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number }
    text?: string
  }>
}

export interface WhisperCliOptions {
  /** Transcriber id (the manifest id) — diagnostics only. */
  id: string
  /** Absolute path of the `whisper-cli` binary. */
  binPath: string
  /** Absolute path of the GGML weights. */
  modelPath: string
  /** CLI threads (`-t`); default = half the logical cores (the sidecar default). */
  threads?: number
  /** Injected spawn for tests (no real process). */
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

export class WhisperCliTranscriber implements Transcriber {
  readonly id: string
  private readonly binPath: string
  private readonly modelPath: string
  private readonly threads: number
  private readonly spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /** In-flight CLI children — killed on suspend/stop (lock/quit must not orphan them). */
  private readonly active = new Set<ChildProcess>()
  private stopped = false

  constructor(opts: WhisperCliOptions) {
    this.id = opts.id
    this.binPath = opts.binPath
    this.modelPath = opts.modelPath
    this.threads = opts.threads ?? defaultThreadCount()
    this.spawnImpl = opts.spawnImpl ?? nodeSpawn
  }

  async transcribe(filePath: string, opts: TranscribeOptions = {}): Promise<TranscriptSegment[]> {
    if (this.stopped) throw new Error('Transcriber has been stopped.')
    // The CLI writes `<outBase>.json` — content, so it must be a transient we shred.
    // Inside the workspace documents dir the `.parse` infix keeps it covered by the
    // startup crash sweep; it must NEVER default to "next to the input" (on a first
    // import the input is the user's ORIGINAL file outside the workspace).
    const outBase = join(opts.workDir ?? tmpdir(), `${randomUUID()}.parse-transcript`)
    const jsonPath = `${outBase}.json`

    const args = [
      '-m', this.modelPath,
      '-f', filePath,
      '-l', opts.language ?? 'auto',
      '-t', String(this.threads),
      '-pp', // progress lines (R-W4: "progress = N%" every ~5%)
      '-oj',
      '-of', outBase
    ]

    try {
      const { stderrTail } = await this.run(args, opts)
      let parsed: WhisperJson
      try {
        parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson
      } catch {
        // Missing/unparsable output with exit 0 = the R-W2 silent-decode-failure mode.
        if (/failed to read audio/i.test(stderrTail)) {
          throw new Error(`${AUDIO_DECODE_ERROR_PREFIX} ${filePath}`)
        }
        throw new Error(`whisper-cli produced no transcript for ${filePath}`)
      }
      const segments: TranscriptSegment[] = []
      for (const seg of parsed.transcription ?? []) {
        const text = (seg.text ?? '').trim()
        if (text.length === 0) continue
        segments.push({
          startMs: Math.max(0, Math.round(seg.offsets?.from ?? 0)),
          endMs: Math.max(0, Math.round(seg.offsets?.to ?? 0)),
          text
        })
      }
      return segments
    } finally {
      shredFile(jsonPath) // the transcript is content — never leave it on disk
    }
  }

  /** Spawn the CLI and resolve on exit, surfacing progress + a bounded stderr tail. */
  private run(
    args: string[],
    opts: TranscribeOptions
  ): Promise<{ code: number | null; stderrTail: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.active.add(child)
      let stderrTail = ''
      const scanProgress = (text: string): void => {
        for (const m of text.matchAll(/progress\s*=\s*(\d{1,3})%/g)) {
          const pct = Number(m[1])
          if (pct >= 0 && pct <= 100) opts.onProgress?.(pct)
        }
      }
      // `-pp` progress goes to stderr in v1.8.6; scan both streams to be safe — but the
      // error TAIL keeps STDERR ONLY: stdout carries the TRANSCRIPT (content), which
      // must never ride an error message into logs or the documents table.
      child.stdout?.on('data', (chunk: Buffer | string) => scanProgress(String(chunk)))
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = String(chunk)
        scanProgress(text)
        stderrTail = (stderrTail + text).slice(-4000)
      })

      const onAbort = (): void => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        this.active.delete(child)
        opts.signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
      child.on('close', (code, signal) => {
        this.active.delete(child)
        opts.signal?.removeEventListener('abort', onAbort)
        if (opts.signal?.aborted || this.stopped) {
          reject(new Error('Transcription was cancelled.'))
        } else if (signal) {
          reject(new Error(`whisper-cli was terminated (${signal})`))
        } else {
          // Exit code deliberately NOT used as the success signal (see module note);
          // a hard non-zero exit (missing DLL, bad model) still fails loudly here.
          if (code !== null && code !== 0) {
            reject(new Error(`whisper-cli exited with code ${code}: ${stderrTail.slice(-500)}`))
          } else {
            resolve({ code, stderrTail })
          }
        }
      })
    })
  }

  /** Kill in-flight children (workspace lock) — per-file CLI, so next use just respawns. */
  async suspend(): Promise<void> {
    for (const child of [...this.active]) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }

  /** Permanent stop (`will-quit`): kill children and refuse new work. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.suspend()
  }
}

export function createWhisperCliTranscriber(opts: WhisperCliOptions): WhisperCliTranscriber {
  return new WhisperCliTranscriber(opts)
}
