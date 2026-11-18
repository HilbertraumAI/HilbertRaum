import { waitForEngineSpawns } from '../runtime/spawn-gate'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { once } from 'node:events'
import { join, resolve as resolvePath } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  defaultThreadCount,
  guardChildStdio,
  llamaOsDir,
  registerSidecarChild,
  unregisterSidecarChild,
  type ResolveBinOptions
} from '../runtime/sidecar'
import { verifyBinaryBeforeSpawn } from '../binary-verifier'
import {
  EngineCannotRunError,
  classifyLoadFailure,
  classifySpawnError,
  clearEngineProblemFor,
  describeLoadFailure,
  reportEngineProblem
} from '../runtime/engine-load'
import { shredFile } from '../workspace-vault'
import { log } from '../logging'
import { WhisperPathError, planWhisperArgv, whisperCommand } from './argv'
import type { TranscribeOptions, Transcriber, TranscriptSegment } from './index'

// whisper.cpp CLI transcriber (see index.ts for the CLI-over-server
// rationale). One child process per file: spawn the pinned `whisper-cli` with the GGML
// weights, let it write the full transcript JSON (`-oj`) to a TRANSIENT file, parse the
// `transcription[].offsets` (milliseconds) + text, shred the transient. The child starts in the
// workspace's documents folder and gets every path in a spelling it reads on a Windows command line
// (#869, `argv.ts`).
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
 * Speech padding (ms) handed to whisper-cli's Silero VAD (`-vp`) for dictation (#504). The
 * pad protects word onsets: with whisper.cpp's 30 ms default the pinned build clipped "Guten"
 * off a German test sentence attenuated by 40 dB; with 200 ms the sentence is kept verbatim,
 * while digital silence and −40 / −30 dBFS white-noise clips still yield ZERO segments
 * (measured 2026-09-21 against the real binary + ggml-small + ggml-silero-v5.1.2). The
 * threshold stays at whisper.cpp's default (0.5): lowering it did not help the onset and
 * would only cost noise margin.
 */
export const VAD_SPEECH_PAD_MS = 200

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

/** Resolves when `signal` aborts (at once when it already has); never rejects. */
const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })))

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
  /**
   * Absolute path of the Silero VAD GGML model (#504), or null/undefined when the drive has
   * none. Used only by calls that ask for it (`TranscribeOptions.vad` — dictation today).
   */
  vadModelPath?: string | null
  /** CLI threads (`-t`); default = half the logical cores (the sidecar default). */
  threads?: number
  /** Injected spawn for tests (no real process). */
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /**
   * Per-spawn inactivity watchdog ceiling in ms (REL-1). Default
   * `DEFAULT_WHISPER_IDLE_TIMEOUT_MS` (env-overridable). Injected small in tests.
   */
  idleTimeoutMs?: number
  /** Grace after SIGTERM before escalating to SIGKILL (REL-2). Default `DEFAULT_KILL_GRACE_MS`. */
  killGraceMs?: number
  /** Cap on the `suspend()`/`stop()` cleanup await (REL-2). Default `DEFAULT_SUSPEND_TIMEOUT_MS`. */
  suspendTimeoutMs?: number
  /** The OS this runs on (default `process.platform`): what the #530 spawn-error and load-failure
   *  classifiers report, and which command-line plan the #869 planner makes. A test seam. */
  platform?: NodeJS.Platform
}

export class WhisperCliTranscriber implements Transcriber {
  readonly id: string
  /** The Silero VAD model this transcriber can run before decoding (#504), or null. */
  readonly vadModelPath: string | null
  private readonly binPath: string
  private readonly modelPath: string
  private readonly threads: number
  private readonly idleTimeoutMs: number
  private readonly killGraceMs: number
  private readonly suspendTimeoutMs: number
  private readonly spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  private readonly platform?: NodeJS.Platform
  /**
   * In-flight CLI children mapped to a promise that resolves when that child has fully
   * exited AND its `transcribe()` cleanup (the transient-transcript shred) has run.
   * suspend()/stop() kill each child and AWAIT these so the parent does not exit before
   * the shred completes (L5): the transient JSON lives in `tmpdir()` by default, which the
   * workspace crash-sweep never reaches, so a missed shred leaves transcript content on disk.
   */
  private readonly active = new Map<ChildProcess, Promise<void>>()
  /**
   * #869: calls still copying their original into the documents folder (no child yet), mapped to
   * the same cleanup promise. suspend()/stop() abort each copy and await its shred like a child's:
   * an engine update suspends without aborting the import's own signal (`registerEngineIpc`).
   */
  private readonly copying = new Map<AbortController, Promise<void>>()
  private stopped = false

  constructor(opts: WhisperCliOptions) {
    this.id = opts.id
    this.binPath = opts.binPath
    this.modelPath = opts.modelPath
    this.vadModelPath = opts.vadModelPath ?? null
    this.threads = opts.threads ?? defaultThreadCount()
    this.idleTimeoutMs = resolveIdleTimeoutMs(opts.idleTimeoutMs)
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.suspendTimeoutMs = opts.suspendTimeoutMs ?? DEFAULT_SUSPEND_TIMEOUT_MS
    this.spawnImpl = opts.spawnImpl ?? nodeSpawn
    this.platform = opts.platform
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
    // #869: the child starts in workDir and gets every path in a spelling the pinned whisper-cli
    // reads on a Windows command line (`argv.ts`): files in workDir by their bare names, the models
    // absolute or relative, an original with no ASCII spelling copied in. Paths are resolved here,
    // against the app's own working directory, before the child gets another one.
    // #504: voice-activity detection BEFORE decoding, for the calls that ask (dictation). Silero
    // VAD finds the speech segments and whisper decodes only those; a recording with none
    // yields an empty transcript (the JSON is still written, with no segments) instead of a
    // hallucinated word. Imports stay VAD-free: the VAD remaps segment timestamps and audio
    // citations cite time ranges — unmeasured, so not switched on there.
    const cwd = resolvePath(opts.workDir)
    const plan = planWhisperArgv({
      cwd,
      modelPath: this.modelPath,
      vadModelPath: opts.vad && this.vadModelPath ? this.vadModelPath : null,
      filePath,
      id: randomUUID(),
      platform: this.platform ?? process.platform
    })
    if ('refused' in plan) {
      // A model file name only a user's own manifest can give; copying gigabytes per call is no
      // option. The argument, never the path, goes to the log.
      log.warn('whisper-cli not started: a model path has no ASCII spelling on this Windows command line', {
        class: 'whisper:non-ascii-path',
        arg: plan.refused
      })
      throw new WhisperPathError(plan.refused)
    }
    const jsonPath = join(opts.workDir, `${plan.outBase}.json`)
    // #869: the transient copy of an original with no ASCII spelling (Windows only). Plaintext
    // audio, the same class as an encrypted re-index's decrypted `.parse` transient; the `.parse`
    // infix keeps it under the startup crash sweep, and the `finally` below shreds it.
    const copyPath = plan.copyName ? join(opts.workDir, plan.copyName) : null

    const args = [
      '-m', plan.model,
      '-f', plan.file,
      '-l', opts.language ?? 'auto',
      '-t', String(this.threads),
      '-pp', // progress lines ("progress = N%" every ~5%)
      '-oj',
      '-of', plan.outBase
    ]
    if (plan.vadModel) {
      args.push('--vad', '-vm', plan.vadModel, '-vp', String(VAD_SPEECH_PAD_MS))
    }

    // `done` resolves only after the shred below runs. suspend()/stop() await it (via the
    // `active` map, or `copying` while the original is still being copied) so a killed child's
    // transient transcript, or a partial copy, is shredded before the parent exits (L5).
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    // #869: the copy is aborted by the call's own signal (cancel, lock, quit) AND by suspend()/stop().
    const copyAbort = copyPath ? new AbortController() : null
    const copy = copyPath && copyAbort
      ? {
          signal: opts.signal ? AbortSignal.any([opts.signal, copyAbort.signal]) : copyAbort.signal,
          run: async (signal: AbortSignal): Promise<void> => {
            this.copying.set(copyAbort, done)
            const out = createWriteStream(copyPath, { flags: 'wx' })
            try {
              await pipeline(createReadStream(filePath), out, { signal })
            } finally {
              // The partial copy is shredded by the `finally` below — after its handle is closed.
              if (!out.closed) await once(out, 'close').catch(() => undefined)
            }
          }
        }
      : undefined
    let registeredChild: ChildProcess | null = null
    try {
      const { stderrTail } = await this.run(cwd, args, opts, (child) => {
        registeredChild = child
        this.active.set(child, done)
        if (copyAbort) this.copying.delete(copyAbort) // a child now: suspend()/stop() kill it instead
      }, copy)
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
      if (copyPath) shredFile(copyPath) // #869: so is the copied audio
      if (copyAbort) this.copying.delete(copyAbort)
      if (registeredChild) this.active.delete(registeredChild)
      resolveDone() // unblock any suspend()/stop() waiting on this child's cleanup
    }
  }

  /** Spawn the CLI in `cwd` and resolve on exit, surfacing progress + a bounded stderr tail.
   *  `copy` (#869: the copy of an original) runs after the waits, right before the spawn; its
   *  signal is the call's own plus suspend()/stop()'s. */
  private async run(
    cwd: string,
    args: string[],
    opts: TranscribeOptions,
    onChild: (child: ChildProcess) => void,
    copy?: { signal: AbortSignal; run: (signal: AbortSignal) => Promise<void> }
  ): Promise<{ code: number | null; stderrTail: string }> {
    // #658: a call cancelled (the dictation deadline, a lock during the WAV write) or a transcriber
    // stopped (quit) starts nothing — no model load it would kill at once. Checked before the waits
    // below and again after them: a `stop()` that lands in between has nothing in `active` to kill,
    // so a child spawned after it would outlive the app.
    const cancelled = (): boolean => opts.signal?.aborted === true || this.stopped || copy?.signal.aborted === true
    if (cancelled()) throw new Error('Transcription was cancelled.')
    // Re-hash whisper-cli against its install marker before spawn (vuln-scan B). A
    // packaged-build tamper is refused; the audio import then fails per-file with the
    // generic failure copy (the raw reason stays in the local log only).
    // #516: an engine install replacing this folder holds spawns until its swap is over.
    await waitForEngineSpawns('whisper_cpp')
    if ((await verifyBinaryBeforeSpawn(this.binPath)) === 'mismatch') {
      throw new Error('whisper-cli failed pre-spawn integrity verification')
    }
    if (cancelled()) throw new Error('Transcription was cancelled.')
    if (copy) {
      // #869: a copy is written only past the engine gate and the hash. A cancel, suspend() or
      // stop() during it aborts it and starts nothing; the caller's `finally` shreds what was
      // written, and suspend()/stop() await that.
      try {
        await copy.run(copy.signal)
      } catch (err) {
        if (cancelled()) throw new Error('Transcription was cancelled.')
        throw err
      }
      // An engine install that began its swap during the copy holds this spawn too (#516). The wait
      // ends early on an abort, so a suspend() never waits on the gate.
      await Promise.race([waitForEngineSpawns('whisper_cpp'), untilAborted(copy.signal)])
      if (cancelled()) throw new Error('Transcription was cancelled.')
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        // windowsHide (#530): every other sidecar spawn already passed it; this one never did.
        // #869: in the documents folder, its bare-name arguments resolve there; the command is
        // absolute, or a relative one would be looked up from there too.
        child = this.spawnImpl(whisperCommand(this.binPath), args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (err) {
        // #658: Node throws SYNCHRONOUSLY for spawn errors outside its short async list — EPERM and
        // `UNKNOWN` among them, how a Windows policy or security software refuses the program
        // (measured: a deny-execute ACL throws `spawn EPERM`). Nothing was registered yet.
        reject(this.spawnFailure(err))
        return
      }
      // #790: both piped streams can error on their own (a spawn that failed before its pipes were
      // open); the child's own 'error' below rejects. The transcript is a file, not stdout.
      guardChildStdio(child, 'whisper-cli')
      onChild(child) // register in `active` so suspend()/stop() can kill + await its cleanup
      // CODE-11 (full-audit 2026-07-11): make the child reachable by the crash-exit reap —
      // a hard uncaughtException skips suspend()/stop(), and on Windows the child survives.
      // F-32: whisper-cli runs the `runtime/whisper.cpp/<os>/` binary — the whisper_cpp family.
      registerSidecarChild(child.pid, 'whisper_cpp')
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
      // Not aborted yet: checked synchronously just before the spawn (#658).
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        unregisterSidecarChild(child.pid) // CODE-11: gone/never started — off the kill list
        clearWatchdog()
        opts.signal?.removeEventListener('abort', onAbort)
        reject(this.spawnFailure(err))
      })
      child.on('close', (code, signal) => {
        unregisterSidecarChild(child.pid) // CODE-11: dead — off the crash-reap kill list
        clearWatchdog()
        opts.signal?.removeEventListener('abort', onAbort)
        if (opts.signal?.aborted || this.stopped) {
          reject(new Error('Transcription was cancelled.'))
          return
        }
        if (timedOut) {
          // Distinct from a generic terminate so the local log shows WHY (no content).
          reject(new Error(`whisper-cli watchdog: no output for ${this.idleTimeoutMs} ms; transcription aborted`))
          return
        }
        // #530: the OS refused to start the program (a missing system library, a system too
        // old, a missing Windows runtime, a code-integrity block) — the voice ENGINE cannot run
        // here, which no retry, re-index or other recording fixes.
        const refused =
          signal || (code !== null && code !== 0) ? this.loadFailureError(code, signal, stderrTail) : null
        if (refused) {
          reject(refused)
        } else if (signal) {
          // The tail now rides the signal branch too (#530): a dyld abort explains itself there.
          reject(new Error(`whisper-cli was terminated (${signal})${stderrTail ? `: ${stderrTail.slice(-500)}` : ''}`))
        } else {
          // Exit code deliberately NOT used as the success signal (see module note);
          // a hard non-zero exit (missing DLL, bad model) still fails loudly here.
          if (code !== null && code !== 0) {
            reject(new Error(`whisper-cli exited with code ${code}: ${stderrTail.slice(-500)}`))
          } else {
            // #530: the program ran — a refusal recorded against THIS binary is stale.
            clearEngineProblemFor('whisper_cpp', this.binPath)
            resolve({ code, stderrTail })
          }
        }
      })
    })
  }

  /**
   * #530: what a spawn error rejects with — thrown synchronously (#658) or emitted as `'error'`. A
   * Windows refusal by policy / security software is the voice engine's verdict and the typed error;
   * anything else is passed on as it came.
   */
  private spawnFailure(err: unknown): unknown {
    const refused = classifySpawnError(err, this.platform)
    if (!refused) return err
    const problem = { family: 'whisper_cpp' as const, ...refused }
    log.warn('whisper-cli cannot run on this computer — the operating system refused to start it', {
      problem: describeLoadFailure(refused),
      binPath: this.binPath,
      error: String(err)
    })
    reportEngineProblem(problem, this.binPath)
    return new EngineCannotRunError('whisper-cli', problem)
  }

  /**
   * #530: the typed error when the OS loader refused whisper-cli, else null. Records the session
   * verdict and logs the raw tail (it holds the drive path) once, locally.
   */
  private loadFailureError(code: number | null, signal: string | null, stderrTail: string): EngineCannotRunError | null {
    const failure = classifyLoadFailure({
      exitCode: code,
      signal,
      stderr: stderrTail,
      platform: this.platform
    })
    if (!failure) return null
    const problem = { family: 'whisper_cpp' as const, ...failure }
    log.warn('whisper-cli cannot run on this computer — the operating system refused to start it', {
      problem: describeLoadFailure(failure),
      binPath: this.binPath,
      stderr: stderrTail.trim().slice(-1000)
    })
    reportEngineProblem(problem, this.binPath)
    return new EngineCannotRunError('whisper-cli', problem)
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
   * Kill in-flight children (workspace lock, engine update) — per-file CLI, so next use just
   * respawns — and abort the copies still being written (#869). Awaits each one's full cleanup
   * (exit + transient-transcript shred, or the partial copy's shred) before returning, so the
   * parent cannot exit on quit with an un-shredded transcript or copy still on disk (L5).
   * The await is BOUNDED (REL-2): a child that ignores even SIGKILL must not hang teardown —
   * past `suspendTimeoutMs` we return regardless (the crash-sweep is the shred backstop).
   */
  async suspend(): Promise<void> {
    const pending = [...this.active.entries()]
    for (const [child] of pending) this.killWithEscalation(child)
    // #869: a call still copying its original has no child yet — abort the copy (it then starts
    // nothing) and await its shred the same way.
    const copies = [...this.copying.entries()]
    for (const [abort] of copies) abort.abort()
    // Wait for each killed child's `close` (or each aborted copy) to drive transcribe()'s finally
    // (shred + resolve), but never longer than the cap so a wedged child can't hang quit/lock.
    await Promise.race([
      Promise.all([...pending.map(([, done]) => done), ...copies.map(([, done]) => done)]),
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
