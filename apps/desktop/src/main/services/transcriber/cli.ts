import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { llamaOsDir, defaultThreadCount, type ResolveBinOptions } from '../runtime/sidecar'
import { verifyBinaryBeforeSpawn, type BinaryVerifyResult } from '../binary-verifier'
import { shredFile } from '../workspace-vault'
import { log } from '../logging'
import type { TranscribeOptions, Transcriber, TranscriptSegment } from './index'

// whisper.cpp CLI transcriber (see index.ts for the CLI-over-server
// rationale). One child process per file: spawn the pinned `whisper-cli` with the GGML
// weights, let it write the full transcript JSON (`-oj`) to a TRANSIENT file, parse the
// `transcription[].offsets` (milliseconds) + text, shred the transient.
//
// Caveat: whisper-cli v1.8.6 EXITS 0 even when it cannot
// decode the input ("failed to read audio data" goes to stderr, no output is written).
// The exit code is therefore NOT trusted — success means "the JSON output exists and
// parses"; a missing/empty result with a decode complaint on stderr maps to a
// distinguishable DECODE error the parser turns into friendly copy (spec §11.4).

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
 * `resolveLlamaServerPath`). A `HILBERTRAUM_WHISPER_BIN` env override points at an explicit
 * binary for DEV ONLY (still validated for existence); in a packaged build it is ignored
 * — it would spawn an arbitrary, unverified binary (security audit M-5).
 */
export function resolveWhisperCliPath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveBinOptions = {}
): string | null {
  const override = env.HILBERTRAUM_WHISPER_BIN?.trim()
  if (override) {
    if (opts.isDev) return existsSync(override) ? override : null
    log.warn('Ignoring HILBERTRAUM_WHISPER_BIN in a packaged build (dev-only override)')
  }
  const candidate = join(whisperCliDir(rootPath, platform), whisperCliBinaryName(platform))
  return existsSync(candidate) ? candidate : null
}

/** Marker prefix so the AudioParser can map a decode failure to friendly copy. */
export const AUDIO_DECODE_ERROR_PREFIX = 'AUDIO_DECODE_FAILED:'

/**
 * Per-spawn INACTIVITY watchdog ceiling (REL-1). whisper-cli emits `-pp` progress
 * (`progress = N%`, ~every 5%); a healthy run — even a slow, hours-long one — keeps
 * producing output, so the watchdog is reset on EVERY stdout/stderr chunk and only
 * fires when the child has been completely silent for this long. That distinguishes a
 * legitimately slow transcription (keeps advancing) from a wedged/spinning child (no
 * output at all), which would otherwise hang the ingestion slot until app restart.
 * 15 min is deliberately generous (one `-pp` step on a multi-hour file on a slow CPU
 * stays well under it). Override with `HILBERTRAUM_WHISPER_IDLE_TIMEOUT_MS` or per
 * instance via `WhisperCliOptions.idleTimeoutMs` (tests dial it down).
 */
export const DEFAULT_WHISPER_IDLE_TIMEOUT_MS = 15 * 60 * 1000

function resolveIdleTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit
  const env = Number(process.env.HILBERTRAUM_WHISPER_IDLE_TIMEOUT_MS)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_WHISPER_IDLE_TIMEOUT_MS
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Grace after SIGTERM before escalating to SIGKILL on a kill (REL-2), mirroring
 * `LlamaServer.stop()`'s `DEFAULT_KILL_GRACE_MS`. A whisper-cli wedged in native decode code
 * can ignore SIGTERM and never emit `close`; the escalation guarantees the child actually dies.
 */
const DEFAULT_KILL_GRACE_MS = 2_000
/**
 * Absolute cap on how long `suspend()`/`stop()` wait for the killed children to finish their
 * cleanup (exit + transient shred) before returning (REL-2). Even SIGKILL can leave a child
 * uninterruptible on rare platforms; teardown (quit/lock) must never hang on it. Past this
 * deadline the transient shred is best-effort — for the in-workspace `.parse` transient the
 * startup crash-sweep is the backstop. Comfortably above the grace so the normal wedged case
 * (SIGTERM ignored → SIGKILL → close → shred) completes well within it.
 */
const DEFAULT_SUSPEND_TIMEOUT_MS = 10_000

/** Shape of the `-oj` output we rely on (whisper.cpp v1.8.6). */
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
  /**
   * Re-hash the `whisper-cli` binary against its install marker before each spawn
   * (vuln-scan B). Defaults to the shared `verifyBinaryBeforeSpawn` (inert in dev / before
   * init). On a packaged-build `mismatch` the transcription is refused. The dev-only
   * `HILBERTRAUM_WHISPER_BIN` override is never hash-gated (dev resolves `skip-dev`).
   */
  verifyBinary?: (binPath: string) => Promise<BinaryVerifyResult>
  /**
   * Per-spawn inactivity watchdog ceiling in ms (REL-1). Default
   * `DEFAULT_WHISPER_IDLE_TIMEOUT_MS` (env-overridable). Injected small in tests.
   */
  idleTimeoutMs?: number
  /** Grace after SIGTERM before escalating to SIGKILL (REL-2). Default `DEFAULT_KILL_GRACE_MS`. */
  killGraceMs?: number
  /** Cap on the `suspend()`/`stop()` cleanup await (REL-2). Default `DEFAULT_SUSPEND_TIMEOUT_MS`. */
  suspendTimeoutMs?: number
}

export class WhisperCliTranscriber implements Transcriber {
  readonly id: string
  private readonly binPath: string
  private readonly modelPath: string
  private readonly threads: number
  private readonly idleTimeoutMs: number
  private readonly killGraceMs: number
  private readonly suspendTimeoutMs: number
  private readonly spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  private readonly verifyBinary: (binPath: string) => Promise<BinaryVerifyResult>
  /**
   * In-flight CLI children mapped to a promise that resolves when that child has fully
   * exited AND its `transcribe()` cleanup (the transient-transcript shred) has run.
   * suspend()/stop() kill each child and AWAIT these so the parent does not exit before
   * the shred completes (L5): the transient JSON lives in `tmpdir()` by default, which the
   * workspace crash-sweep never reaches, so a missed shred leaves transcript content on disk.
   */
  private readonly active = new Map<ChildProcess, Promise<void>>()
  private stopped = false

  constructor(opts: WhisperCliOptions) {
    this.id = opts.id
    this.binPath = opts.binPath
    this.modelPath = opts.modelPath
    this.threads = opts.threads ?? defaultThreadCount()
    this.idleTimeoutMs = resolveIdleTimeoutMs(opts.idleTimeoutMs)
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.suspendTimeoutMs = opts.suspendTimeoutMs ?? DEFAULT_SUSPEND_TIMEOUT_MS
    this.spawnImpl = opts.spawnImpl ?? nodeSpawn
    this.verifyBinary = opts.verifyBinary ?? verifyBinaryBeforeSpawn
  }

  async transcribe(filePath: string, opts: TranscribeOptions): Promise<TranscriptSegment[]> {
    if (this.stopped) throw new Error('Transcriber has been stopped.')
    // The CLI writes `<outBase>.json` — content, so it must be a transient we shred.
    // Inside the workspace documents dir the `.parse` infix keeps it covered by the
    // startup crash sweep; it must NEVER land in the OS tmpdir (which the sweep never
    // reaches) or "next to the input" (on a first import the input is the user's
    // ORIGINAL file outside the workspace). REL-6: `workDir` is REQUIRED — fail closed
    // rather than strand recognised speech outside the sweep if a caller ever omits it.
    if (!opts.workDir) {
      throw new Error('Transcriber workDir is required (transient transcript must stay inside the crash sweep).')
    }
    const outBase = join(opts.workDir, `${randomUUID()}.parse-transcript`)
    const jsonPath = `${outBase}.json`

    const args = [
      '-m', this.modelPath,
      '-f', filePath,
      '-l', opts.language ?? 'auto',
      '-t', String(this.threads),
      '-pp', // progress lines ("progress = N%" every ~5%)
      '-oj',
      '-of', outBase
    ]

    // `done` resolves only after the shred below runs. suspend()/stop() await it (via the
    // `active` map) so a killed child's transient transcript is shredded before the parent
    // exits (L5).
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    let registeredChild: ChildProcess | null = null
    try {
      const { stderrTail } = await this.run(args, opts, (child) => {
        registeredChild = child
        this.active.set(child, done)
      })
      let parsed: WhisperJson
      try {
        parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson
      } catch {
        // Missing/unparsable output with exit 0 = the silent-decode-failure mode
        // (see module note).
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
      if (registeredChild) this.active.delete(registeredChild)
      resolveDone() // unblock any suspend()/stop() waiting on this child's cleanup
    }
  }

  /** Spawn the CLI and resolve on exit, surfacing progress + a bounded stderr tail. */
  private async run(
    args: string[],
    opts: TranscribeOptions,
    onChild: (child: ChildProcess) => void
  ): Promise<{ code: number | null; stderrTail: string }> {
    // Re-hash whisper-cli against its install marker before spawn (vuln-scan B). A
    // packaged-build tamper is refused; the audio import then fails per-file with the
    // generic failure copy (the raw reason stays in the local log only).
    if ((await this.verifyBinary(this.binPath)) === 'mismatch') {
      throw new Error('whisper-cli failed pre-spawn integrity verification')
    }
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      onChild(child) // register in `active` so suspend()/stop() can kill + await its cleanup
      let stderrTail = ''
      const scanProgress = (text: string): void => {
        for (const m of text.matchAll(/progress\s*=\s*(\d{1,3})%/g)) {
          const pct = Number(m[1])
          if (pct >= 0 && pct <= 100) opts.onProgress?.(pct)
        }
      }

      // Inactivity watchdog (REL-1): kill a child that has gone completely silent for
      // `idleTimeoutMs` (no `-pp` progress, no stderr) — a wedged/spinning whisper that
      // would otherwise hang this ingestion slot forever. Reset on every chunk so a
      // legitimately slow but advancing transcription is never killed. The timeout error
      // carries ONLY the duration — never any output/content.
      let timedOut = false
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const clearWatchdog = (): void => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = undefined
      }
      const armWatchdog = (): void => {
        clearWatchdog()
        watchdog = setTimeout(() => {
          timedOut = true
          // REL-2: escalate to SIGKILL if the wedged child ignores SIGTERM — otherwise the
          // watchdog "fires" but the child lives on and this ingestion slot stays held.
          this.killWithEscalation(child)
        }, this.idleTimeoutMs)
      }
      armWatchdog()

      // `-pp` progress goes to stderr in v1.8.6; scan both streams to be safe — but the
      // error TAIL keeps STDERR ONLY: stdout carries the TRANSCRIPT (content), which
      // must never ride an error message into logs or the documents table.
      child.stdout?.on('data', (chunk: Buffer | string) => {
        armWatchdog()
        scanProgress(String(chunk))
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        armWatchdog()
        const text = String(chunk)
        scanProgress(text)
        stderrTail = (stderrTail + text).slice(-4000)
      })

      // REL-2: escalate to SIGKILL so a "Stop" / cancel can't be ignored by a wedged child.
      const onAbort = (): void => this.killWithEscalation(child)
      // Already aborted at spawn time (rare): kill at once; otherwise arm the listener.
      if (opts.signal?.aborted) onAbort()
      else opts.signal?.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        clearWatchdog()
        opts.signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
      child.on('close', (code, signal) => {
        clearWatchdog()
        opts.signal?.removeEventListener('abort', onAbort)
        if (opts.signal?.aborted || this.stopped) {
          reject(new Error('Transcription was cancelled.'))
        } else if (timedOut) {
          // Distinct from a generic terminate so the local log shows WHY (no content).
          reject(new Error(`whisper-cli watchdog: no output for ${this.idleTimeoutMs} ms; transcription aborted`))
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

  /**
   * Kill a whisper child and escalate to SIGKILL if it ignores the polite signal (REL-2),
   * mirroring `LlamaServer.stop()`. whisper-cli can wedge in native decode code that ignores
   * SIGTERM and never emits `close`; without escalation the watchdog/abort/suspend "fires" but
   * the child lives on, `transcribe()` never settles (the ingestion slot stays held), and
   * `suspend()`/`stop()` — which await each child's cleanup — hang quit/lock forever.
   * Best-effort throughout (a child already gone makes both kills harmless no-ops). The grace
   * timer is `unref`'d so it never keeps Electron alive by itself, and is cleared the moment
   * the child is confirmed gone so a clean exit leaves no lingering timer.
   */
  private killWithEscalation(child: ChildProcess): void {
    let gone = false
    const escalate = setTimeout(() => {
      if (!gone) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* best-effort */
        }
      }
    }, this.killGraceMs)
    escalate.unref?.()
    const onGone = (): void => {
      gone = true
      clearTimeout(escalate)
    }
    child.once('exit', onGone)
    child.once('close', onGone)
    child.once('error', onGone)
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  /**
   * Kill in-flight children (workspace lock) — per-file CLI, so next use just respawns.
   * Awaits each child's full cleanup (exit + transient-transcript shred) before returning,
   * so the parent cannot exit on quit with an un-shredded transcript still on disk (L5).
   * The await is BOUNDED (REL-2): a child that ignores even SIGKILL must not hang teardown —
   * past `suspendTimeoutMs` we return regardless (the crash-sweep is the shred backstop).
   */
  async suspend(): Promise<void> {
    const pending = [...this.active.entries()]
    for (const [child] of pending) this.killWithEscalation(child)
    // Wait for each killed child's `close` to drive transcribe()'s finally (shred + resolve),
    // but never longer than the cap so a wedged child can't hang quit/lock.
    await Promise.race([
      Promise.all(pending.map(([, done]) => done)),
      delay(this.suspendTimeoutMs)
    ])
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
