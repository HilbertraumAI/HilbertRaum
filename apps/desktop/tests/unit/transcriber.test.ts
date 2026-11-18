import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  createWhisperCliTranscriber,
  resolveWhisperCliPath,
  vadModelPathOf,
  whisperCliBinaryName,
  whisperCliDir
} from '../../src/main/services/transcriber'
import { AUDIO_DECODE_ERROR_PREFIX, VAD_SPEECH_PAD_MS } from '../../src/main/services/transcriber/cli'
import { WhisperPathError } from '../../src/main/services/transcriber/argv'
import {
  EngineCannotRunError,
  engineProblemFor,
  isEngineCannotRunError,
  reportEngineProblem,
  resetEngineProblemsForTest
} from '../../src/main/services/runtime/engine-load'
import {
  killRegisteredSidecarChildren,
  registeredSidecarPids
} from '../../src/main/services/runtime/sidecar'
import { holdEngineSpawns } from '../../src/main/services/runtime/spawn-gate'
import { until, within } from '../helpers/hang-budget'

// #869 review: a pass-through `node:fs` whose `createReadStream`, once armed, hands the transcriber's
// copy a source that sends one chunk and then stalls — a copy still being written, so a stop(),
// suspend(), cancel or engine swap can land in it deterministically. Fault injection, not a wait;
// every other call (and an unarmed copy) is the real one.
const stalledCopy = vi.hoisted(() => ({
  armed: false,
  source: null as null | { push(chunk: Buffer | null): boolean },
  /** The copy's own write stream, so a row can wait for its handle to close. */
  writer: null as null | NodeJS.EventEmitter
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { Readable } = await import('node:stream')
  const createReadStream = ((...args: Parameters<typeof actual.createReadStream>) => {
    if (!stalledCopy.armed) return actual.createReadStream(...args)
    const source = new Readable({ read() {} })
    source.push(Buffer.from('PARTIAL-AUDIO'))
    stalledCopy.source = source
    return source
  }) as typeof actual.createReadStream
  const createWriteStream = ((...args: Parameters<typeof actual.createWriteStream>) => {
    const writer = actual.createWriteStream(...args)
    if (stalledCopy.armed) stalledCopy.writer = writer
    return writer
  }) as typeof actual.createWriteStream
  const mocked = { ...actual, createReadStream, createWriteStream }
  return { ...mocked, default: mocked }
})

// #869 review: the pre-spawn binary hash, observed (each call logs 'hash' into `events`) and, once
// `hold` is set, held — so a row can see WHEN it runs relative to the copy and an engine swap, and
// land a suspend() inside it. Pass-through otherwise (the verifier is inert in the unit suite).
const hashProbe = vi.hoisted(() => ({ events: [] as string[], hold: null as null | Promise<void> }))
vi.mock('../../src/main/services/binary-verifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/binary-verifier')>()
  return {
    ...actual,
    verifyBinaryBeforeSpawn: async (binPath: string) => {
      hashProbe.events.push('hash')
      if (hashProbe.hold) await hashProbe.hold
      return actual.verifyBinaryBeforeSpawn(binPath)
    }
  }
})

// Phase 36 — the whisper-cli path resolver and the CLI backend driven by a FAKE spawn (CI is zero-binary:
// no real process, no real audio). The selector itself runs over a real temp drive in compose-transcriber.test.ts.

describe('resolveWhisperCliPath', () => {
  it('resolves runtime/whisper.cpp/<os>/whisper-cli[.exe] when present', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-bin-'))
    expect(resolveWhisperCliPath(root, 'win32', {})).toBeNull()
    const binDir = whisperCliDir(root, 'win32')
    expect(binDir).toBe(join(root, 'runtime', 'whisper.cpp', 'win'))
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, whisperCliBinaryName('win32')), 'fake')
    expect(resolveWhisperCliPath(root, 'win32', {})).toBe(join(binDir, 'whisper-cli.exe'))
  })

  it('honours the HILBERTRAUM_WHISPER_BIN override in DEV (existing file only)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-ovr-'))
    const bin = join(root, 'custom-whisper.exe')
    expect(
      resolveWhisperCliPath(root, 'win32', { HILBERTRAUM_WHISPER_BIN: bin }, { isDev: true })
    ).toBeNull()
    writeFileSync(bin, 'fake')
    expect(resolveWhisperCliPath(root, 'win32', { HILBERTRAUM_WHISPER_BIN: bin }, { isDev: true })).toBe(bin)
  })

  it('IGNORES the HILBERTRAUM_WHISPER_BIN override in a packaged build (M-5)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-ovr-'))
    const bin = join(root, 'evil-whisper.exe')
    writeFileSync(bin, 'fake')
    // Default (no opts) and explicit isDev:false both ignore the env override.
    expect(resolveWhisperCliPath(root, 'win32', { HILBERTRAUM_WHISPER_BIN: bin })).toBeNull()
    expect(
      resolveWhisperCliPath(root, 'win32', { HILBERTRAUM_WHISPER_BIN: bin }, { isDev: false })
    ).toBeNull()
    // The legitimate on-drive binary still resolves with the override set.
    const binDir = whisperCliDir(root, 'win32')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, whisperCliBinaryName('win32')), 'fake')
    expect(resolveWhisperCliPath(root, 'win32', { HILBERTRAUM_WHISPER_BIN: bin })).toBe(
      join(binDir, 'whisper-cli.exe')
    )
  })
})

// ---- WhisperCliTranscriber with a fake spawn ----------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  kill: () => boolean
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
    setImmediate(() => child.emit('close', null, 'SIGTERM'))
    return true
  }
  return child
}

/** Records each kill signal; only the signals in `diesOn` actually make it close (REL-2). */
interface StubbornChild extends FakeChild {
  signals: Array<NodeJS.Signals | number | undefined>
  kill: (signal?: NodeJS.Signals | number) => boolean
}
function makeStubbornChild(diesOn: ReadonlyArray<NodeJS.Signals>): StubbornChild {
  const child = new EventEmitter() as StubbornChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.signals = []
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    child.signals.push(signal)
    const sig = (signal ?? 'SIGTERM') as NodeJS.Signals
    if (diesOn.includes(sig)) {
      child.killed = true
      setImmediate(() => child.emit('close', null, String(sig)))
    }
    return true
  }
  return child
}

/**
 * Where whisper-cli writes its transcript: `<-of>.json`, a relative `-of` resolved against the CHILD's
 * working directory (#869), as the OS does for the real program. Null when a relative `-of` came
 * with no `cwd`: the real child would write into the app's own folder, so the fake writes nothing.
 */
function transcriptPathOf(args: string[], o: SpawnOptions | undefined): string | null {
  const outBase = args[args.indexOf('-of') + 1]
  if (isAbsolute(outBase)) return `${outBase}.json`
  return typeof o?.cwd === 'string' ? resolve(o.cwd, `${outBase}.json`) : null
}

/** A transcriber whose spawn records argv + options, then (next macrotask) writes `json` (if given) to the
 *  `-of` path, emits `stderrText` and closes with (exitCode, signal) — or emits `error` instead, or (`thrown`)
 *  throws it from the spawn call itself, as Node does for codes outside its async list (#658). */
function fakeCliTranscriber(opts: {
  json?: unknown
  stderrText?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  error?: Error
  thrown?: Error
  /** #790: after `error`, an ENOTCONN on both piped streams, as a spawn that failed before its pipes
   *  were open emits; whatever such an emit throws (an unhandled stream error) is collected here. */
  pipeErrorsThrown?: unknown[]
  modelPath?: string
  vadModelPath?: string
  platform?: NodeJS.Platform
  /** #869: runs at spawn time, while the child "runs" — what the child would find on disk. */
  onSpawn?: (args: string[], o: SpawnOptions) => void
  /** The child runs until it is killed (no close of its own). */
  hold?: boolean
}): { transcriber: ReturnType<typeof createWhisperCliTranscriber>; spawned: string[][]; spawnOptions: SpawnOptions[] } {
  const spawned: string[][] = []
  const spawnOptions: SpawnOptions[] = []
  const transcriber = createWhisperCliTranscriber({
    id: 'whisper-small-multilingual',
    binPath: 'C:/fake/whisper-cli.exe',
    modelPath: opts.modelPath ?? 'C:/fake/ggml-small.bin',
    vadModelPath: opts.vadModelPath,
    platform: opts.platform,
    threads: 4,
    spawnImpl: (_cmd: string, args: string[], o: SpawnOptions): ChildProcess => {
      spawned.push(args)
      spawnOptions.push(o)
      if (opts.thrown) throw opts.thrown
      opts.onSpawn?.(args, o)
      const child = makeFakeChild()
      if (opts.hold) return child as unknown as ChildProcess
      setImmediate(() => {
        if (opts.error) {
          child.emit('error', opts.error)
          for (const stream of opts.pipeErrorsThrown ? [child.stdout, child.stderr] : []) {
            try {
              stream.emit('error', Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' }))
            } catch (e) {
              opts.pipeErrorsThrown?.push(e)
            }
          }
          return
        }
        const outJson = transcriptPathOf(args, o)
        if (opts.stderrText) child.stderr.emit('data', Buffer.from(opts.stderrText))
        if (opts.json !== undefined && outJson) writeFileSync(outJson, JSON.stringify(opts.json))
        if (!child.killed) child.emit('close', opts.signal ? null : (opts.exitCode ?? 0), opts.signal ?? null)
      })
      return child as unknown as ChildProcess
    }
  })
  return { transcriber, spawned, spawnOptions }
}

const WHISPER_JSON = {
  result: { language: 'de' },
  transcription: [
    { offsets: { from: 0, to: 5920 }, text: ' Abschnitt drei der Erzählungen.' },
    { offsets: { from: 5920, to: 8440 }, text: ' Dies ist eine Aufnahme.' },
    { offsets: { from: 8440, to: 9000 }, text: '   ' } // whitespace-only → dropped
  ]
}

// #504: Silero VAD before decoding, for the calls that ask (dictation). The CLI contract:
// `--vad -vm <model> -vp 200` only when BOTH the caller asked and a VAD model is known; imports
// (no `vad`) and drives without the file stay byte-identical to before.
describe('WhisperCliTranscriber — Silero VAD for dictation (#504)', () => {
  const VAD = 'C:/fake/ggml-silero-v5.1.2.bin'
  const EMPTY_JSON = { result: { language: 'en' }, transcription: [] }

  it('adds --vad, the model path and the measured speech pad when asked and a VAD model is known', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-vad-'))
    const { transcriber, spawned } = fakeCliTranscriber({ json: WHISPER_JSON, vadModelPath: VAD })
    expect(transcriber.vadModelPath).toBe(VAD)
    await transcriber.transcribe('C:/audio/dictation.wav', { workDir, vad: true })
    const args = spawned[0]
    expect(args).toContain('--vad')
    // #869: absolute, resolved before the child starts in the documents folder (an ASCII path here).
    expect(args[args.indexOf('-vm') + 1]).toBe(resolve(VAD))
    expect(args[args.indexOf('-vp') + 1]).toBe(String(VAD_SPEECH_PAD_MS))
    expect(VAD_SPEECH_PAD_MS).toBe(200) // the 2026-09-21 calibration: keeps "Guten" at −40 dB
  })

  it('stays VAD-free for an import (no `vad`) even when a VAD model is known', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-vad-'))
    const { transcriber, spawned } = fakeCliTranscriber({ json: WHISPER_JSON, vadModelPath: VAD })
    await transcriber.transcribe('C:/audio/meeting.mp3', { workDir })
    expect(spawned[0]).not.toContain('--vad')
    expect(spawned[0]).not.toContain('-vm')
  })

  it('stays VAD-free when the drive has no VAD model, even for a dictation', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-vad-'))
    const { transcriber, spawned } = fakeCliTranscriber({ json: WHISPER_JSON })
    expect(transcriber.vadModelPath).toBeNull()
    await transcriber.transcribe('C:/audio/dictation.wav', { workDir, vad: true })
    expect(spawned[0]).not.toContain('--vad')
  })

  it('a transcript with no segments (VAD found no speech) is an EMPTY list, not a failure', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-vad-'))
    const { transcriber } = fakeCliTranscriber({ json: EMPTY_JSON, vadModelPath: VAD })
    await expect(transcriber.transcribe('C:/audio/noise.wav', { workDir, vad: true })).resolves.toEqual([])
    expect(readdirSync(workDir)).toEqual([]) // the transient JSON is still shredded
  })
})

describe('vadModelPathOf (#504)', () => {
  it('finds the Silero file among the required paths by its whisper.cpp name, on either separator', () => {
    expect(vadModelPathOf({ requiredPaths: ['D:/m/ggml-small.bin', 'D:/m/ggml-silero-v5.1.2.bin'] })).toBe(
      'D:/m/ggml-silero-v5.1.2.bin'
    )
    expect(vadModelPathOf({ requiredPaths: ['D:\\m\\ggml-small.bin', 'D:\\m\\ggml-silero-v6.bin'] })).toBe(
      'D:\\m\\ggml-silero-v6.bin'
    )
  })

  it('is null without one (a weight-only manifest, or no required paths at all)', () => {
    expect(vadModelPathOf({ requiredPaths: ['D:/m/ggml-small.bin'] })).toBeNull()
    expect(vadModelPathOf({})).toBeNull()
  })
})

describe('WhisperCliTranscriber (fake spawn)', () => {
  it('parses the -oj JSON into ordered ms segments and shreds the transient', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-work-'))
    const { transcriber, spawned, spawnOptions } = fakeCliTranscriber({ json: WHISPER_JSON })
    const segments = await transcriber.transcribe('C:/audio/meeting.mp3', { workDir })
    expect(segments).toEqual([
      { startMs: 0, endMs: 5920, text: 'Abschnitt drei der Erzählungen.' },
      { startMs: 5920, endMs: 8440, text: 'Dies ist eine Aufnahme.' }
    ])
    // CLI contract: model, file, auto language, threads, progress, JSON out. #869: a path outside
    // the documents folder goes absolute (ASCII here), resolved before the child changes folder.
    const args = spawned[0]
    expect(args[args.indexOf('-m') + 1]).toBe(resolve('C:/fake/ggml-small.bin'))
    expect(args[args.indexOf('-f') + 1]).toBe(resolve('C:/audio/meeting.mp3'))
    expect(args[args.indexOf('-l') + 1]).toBe('auto')
    expect(args).toContain('-pp')
    expect(args).toContain('-oj')
    // The transcript JSON is CONTENT: the transient carries the crash-sweep `.parse` infix inside
    // workDir — the child's working directory, so `-of` is its bare name (#869) — and is gone after.
    const outBase = args[args.indexOf('-of') + 1]
    expect(spawnOptions[0]?.cwd).toBe(resolve(workDir))
    expect(outBase).toMatch(/^[0-9a-f-]{36}\.parse-transcript$/)
    expect(readdirSync(workDir)).toEqual([])
  })

  // CODE-11 (full-audit 2026-07-11): the whisper child rides the same crash-exit PID registry
  // as LlamaServer — registered while it runs (so an uncaughtException reap can kill it),
  // deregistered once it closes.
  it('registers the child PID while running and deregisters it on close (CODE-11 crash reap)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-reap-'))
    killRegisteredSidecarChildren(() => undefined) // isolate: clear leftovers from other tests
    let observedDuringRun: number[] = []
    const transcriber = createWhisperCliTranscriber({
      id: 'whisper-small-multilingual',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/ggml-small.bin',
      spawnImpl: (_cmd, args, o): ChildProcess => {
        const child = makeFakeChild() as FakeChild & { pid: number }
        child.pid = 7777
        setImmediate(() => {
          observedDuringRun = registeredSidecarPids()
          const outJson = transcriptPathOf(args, o)
          if (outJson) writeFileSync(outJson, JSON.stringify(WHISPER_JSON))
          child.emit('close', 0, null)
        })
        return child as unknown as ChildProcess
      }
    })
    await transcriber.transcribe('a.mp3', { workDir })
    expect(observedDuringRun).toContain(7777) // reachable by the crash-exit reap mid-run
    expect(registeredSidecarPids()).not.toContain(7777) // forgotten once the child closed
  })

  it('reports -pp progress percentages', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-prog-'))
    const { transcriber } = fakeCliTranscriber({
      json: WHISPER_JSON,
      stderrText: 'whisper_print_progress_callback: progress =   5%\nprogress =  60%\n'
    })
    const seen: number[] = []
    await transcriber.transcribe('a.mp3', { workDir, onProgress: (p) => seen.push(p) })
    expect(seen).toEqual([5, 60])
  })

  // R-W2: whisper-cli EXITS 0 on an undecodable file (error only on stderr, no output).
  // Success therefore means "the JSON exists and parses" — never the exit code.
  it('maps the exit-0 decode failure to the AUDIO_DECODE_FAILED error', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-decode-'))
    const { transcriber } = fakeCliTranscriber({
      stderrText: 'read_audio_data: failed to read audio data\nerror: failed to read audio file',
      exitCode: 0
    })
    await expect(transcriber.transcribe('bad.m4a', { workDir })).rejects.toThrow(
      AUDIO_DECODE_ERROR_PREFIX
    )
  })

  // L5: suspend()/stop() must AWAIT each killed child's cleanup (the transient-transcript
  // shred in transcribe()'s finally), so the parent never exits leaving an un-shredded
  // transcript in tmpdir() (the workspace crash-sweep never reaches the default workDir).
  it('suspend() awaits the transient-transcript shred before returning (L5)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-shred-'))
    let outJson = ''
    // A child that writes the transcript JSON, then "runs" (never closes on its own) until killed.
    const pending = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      spawnImpl: (_cmd: string, args: string[], o: SpawnOptions): ChildProcess => {
        const child = makeFakeChild()
        outJson = transcriptPathOf(args, o) ?? ''
        if (outJson) writeFileSync(outJson, JSON.stringify(WHISPER_JSON)) // transcript content on disk
        return child as unknown as ChildProcess
      }
    })
    const call = pending.transcribe('a.mp3', { workDir })
    await new Promise((r) => setImmediate(r))
    expect(existsSync(outJson)).toBe(true) // present mid-transcription
    await pending.suspend() // kills the child; must not return until the shred has run
    expect(existsSync(outJson)).toBe(false) // shredded by the time suspend() resolves
    expect(readdirSync(workDir)).toEqual([])
    await expect(call).rejects.toThrow(/terminated|cancelled/i) // the suspended call rejects, never a partial transcript
  })

  it('stop() refuses new work permanently (the will-quit latch)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-stop-'))
    const { transcriber } = fakeCliTranscriber({ json: WHISPER_JSON })
    await transcriber.stop()
    await expect(transcriber.transcribe('a.mp3', { workDir })).rejects.toThrow(/stopped/)
  })

  // #516 (architecture.md "In-app engine updates" §3): while an install replaces runtime/whisper.cpp/<os>/, a
  // transcription waits for the swap; LlamaServer (sidecar.test.ts), the GPU probe (gpu.test.ts) and the engine
  // check (engine-health.test.ts) wait the same way.
  it('waits for an engine install to finish its swap before it spawns (#516 spawn gate)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-gate-'))
    const { transcriber, spawned } = fakeCliTranscriber({ json: WHISPER_JSON })
    const release = holdEngineSpawns('whisper_cpp')
    const call = transcriber.transcribe('a.mp3', { workDir })
    try {
      // One macrotask: every microtask the transcription could chain (the gate, verify, spawn) has run.
      await new Promise((r) => setImmediate(r))
      expect(spawned).toHaveLength(0) // held: nothing spawned mid-swap
    } finally {
      release()
    }
    expect(await call).toHaveLength(2)
    expect(spawned).toHaveLength(1)
  })

  // #658 review: a quit's stop() or a cancel that lands while the call waits on the gate (or the hash) starts
  // nothing. stop() finds nothing in `active` to kill then, so a child spawned after it would outlive the app.
  it.each<[string, (t: { stop(): Promise<void> }, c: AbortController) => unknown]>([
    ['stop() (quit)', (t) => t.stop()],
    ['a cancel', (_t, c) => c.abort()]
  ])('%s while the call waits on the #516 gate spawns nothing', async (_label, end) => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-gate-end-'))
    const { transcriber, spawned } = fakeCliTranscriber({ json: WHISPER_JSON })
    const controller = new AbortController()
    const release = holdEngineSpawns('whisper_cpp')
    const call = transcriber.transcribe('a.mp3', { workDir, signal: controller.signal })
    try {
      await new Promise((r) => setImmediate(r)) // as above: the call is parked on the gate
      await end(transcriber, controller)
    } finally {
      release()
    }
    await expect(within(call, 'the ended call settling')).rejects.toThrow('Transcription was cancelled.')
    expect(spawned).toHaveLength(0)
  })

  // #658: a call already cancelled (the dictation deadline) does not sit out an engine install's swap first.
  it('a call already cancelled does not wait for the #516 gate', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-gate-pre-'))
    const { transcriber, spawned } = fakeCliTranscriber({ json: WHISPER_JSON })
    const release = holdEngineSpawns('whisper_cpp')
    try {
      const call = transcriber.transcribe('a.mp3', { workDir, signal: AbortSignal.abort() })
      // The exact message: `within`'s own timeout error must not pass for it.
      await expect(within(call, 'the call settling while the gate is held')).rejects.toThrow('Transcription was cancelled.')
      expect(spawned).toHaveLength(0)
    } finally {
      release()
    }
  })

  // REL-1 (TEST-4): the threaded AbortSignal (now actually supplied by the ingestion call
  // site) arms the abort listener — aborting mid-transcription kills the in-flight child and
  // the call rejects "cancelled". Previously the listener existed but was never armed.
  // An already-aborted signal (the dictation deadline or a lock that fired during the WAV write, #549 / #237) ends the call too.
  it.each<[string, boolean]>([
    ['mid-run', false],
    ['before the call (#549)', true]
  ])('an aborted signal kills the in-flight child and the call rejects (REL-1 threaded cancel): %s', async (_when, preAborted) => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-sig-'))
    const controller = new AbortController()
    if (preAborted) controller.abort()
    let heldChild = null as FakeChild | null // widened: the spawn callback assigns it
    const t = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      spawnImpl: (): ChildProcess => {
        const child = makeFakeChild() // "runs" until killed
        heldChild = child
        return child as unknown as ChildProcess
      }
    })
    const call = t.transcribe('a.mp3', { workDir, signal: controller.signal })
    if (!preAborted) {
      await new Promise((r) => setImmediate(r))
      expect(heldChild).not.toBeNull()
      controller.abort()
    }
    await expect(within(call, 'the aborted transcription settling')).rejects.toThrow(/cancelled/i)
    // No child left running. #658: a call cancelled before it began starts no whisper-cli at all.
    if (preAborted) expect(heldChild).toBeNull()
    else expect(heldChild?.killed).toBe(true)
  })

  // REL-2: a whisper-cli wedged in native code can ignore SIGTERM and never emit 'close'.
  // stop()/suspend() must escalate to SIGKILL (mirroring LlamaServer.stop) so the slot is
  // freed and the transient transcript is still shredded — not hang quit/lock forever.
  it('stop() escalates to SIGKILL when the child ignores SIGTERM, then shreds (REL-2)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-sigkill-'))
    let held: StubbornChild | null = null
    let outJson = ''
    const t = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      killGraceMs: 20, // SIGTERM grace dialled down (prod default 2 s)
      spawnImpl: (_cmd: string, args: string[], o: SpawnOptions): ChildProcess => {
        const child = makeStubbornChild(['SIGKILL']) // ignores SIGTERM, dies only on SIGKILL
        held = child
        outJson = transcriptPathOf(args, o) ?? ''
        if (outJson) writeFileSync(outJson, JSON.stringify(WHISPER_JSON)) // transcript content on disk
        return child as unknown as ChildProcess
      }
    })
    const call = t.transcribe('a.mp3', { workDir })
    await new Promise((r) => setImmediate(r))
    expect(existsSync(outJson)).toBe(true)
    await t.stop() // must resolve via the SIGKILL escalation, not hang on the wedged child
    expect(held!.signals).toContain('SIGKILL') // escalated past the ignored SIGTERM
    expect(existsSync(outJson)).toBe(false) // transient shredded before stop() returned
    expect(readdirSync(workDir)).toEqual([])
    await call.catch(() => undefined)
  })

  // REL-2: even SIGKILL can leave a child uninterruptible on rare platforms. The await in
  // suspend()/stop() is bounded so teardown can never hang on a child that won't die.
  it('suspend() resolves within the bounded window when the child ignores even SIGKILL (REL-2)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-nodie-'))
    let held: StubbornChild | null = null
    const t = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      killGraceMs: 10,
      suspendTimeoutMs: 40, // the absolute cap; the child never closes
      spawnImpl: (): ChildProcess => {
        const child = makeStubbornChild([]) // ignores every signal; never closes
        held = child
        return child as unknown as ChildProcess
      }
    })
    const call = t.transcribe('a.mp3', { workDir })
    await new Promise((r) => setImmediate(r))
    expect(held).not.toBeNull()
    await within(t.suspend(), 'suspend() returning at its 40 ms cap', 1500) // not the child's (absent) exit, not the 10 s default
    expect(held!.signals).toContain('SIGKILL') // it still tried the forceful escalation
    void call.catch(() => undefined) // never settles (the child never closes) — that's the point
  })

  // REL-1 (TEST-4): a wedged/spinning child that emits nothing and never closes is killed by the inactivity watchdog and
  // the call rejects, instead of hanging the ingestion slot until app restart. REL-2: the watchdog is itself a kill site, so a
  // SIGTERM-deaf child is escalated to SIGKILL — after the polite signal, never instead of it.
  it('the inactivity watchdog escalates to SIGKILL on a SIGTERM-ignoring child (REL-2)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-wd-kill-'))
    let held: StubbornChild | null = null
    const t = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      idleTimeoutMs: 20,
      killGraceMs: 20,
      spawnImpl: (): ChildProcess => {
        const child = makeStubbornChild(['SIGKILL']) // ignores SIGTERM
        held = child
        return child as unknown as ChildProcess
      }
    })
    await expect(t.transcribe('a.mp3', { workDir })).rejects.toThrow(/watchdog|no output/i)
    expect(held!.signals[0]).not.toBe('SIGKILL') // the polite kill came first
    expect(held!.signals).toContain('SIGKILL')
    expect(readdirSync(workDir)).toEqual([])
  })

  // REL-6: workDir is required — the transient transcript (recognised speech = content)
  // must land in a swept directory, never the OS tmpdir. A missing/empty workDir fails
  // closed BEFORE any spawn rather than stranding content outside the crash sweep.
  it('refuses an empty workDir before spawning (REL-6 fail-closed)', async () => {
    let spawned = false
    const t = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      spawnImpl: (): ChildProcess => {
        spawned = true
        return makeFakeChild() as unknown as ChildProcess
      }
    })
    await expect(t.transcribe('a.mp3', { workDir: '' })).rejects.toThrow(/workDir is required/i)
    expect(spawned).toBe(false)
  })
})

// #530: a whisper-cli the OS loader refuses is classified (typed, path-free error + session verdict);
// every other failure keeps its old message.
describe('WhisperCliTranscriber — OS loader refusal (#530)', () => {
  afterEach(() => resetEngineProblemsForTest())

  const LOADER_LINE =
    '/media/someone/HR/runtime/whisper.cpp/linux/whisper-cli: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

  const workDir = (): string => mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-530-'))

  it('exit 127 with the loader line rejects with EngineCannotRunError and records the verdict', async () => {
    const { transcriber } = fakeCliTranscriber({ stderrText: LOADER_LINE, exitCode: 127 })
    const err = await transcriber.transcribe('a.mp3', { workDir: workDir() }).catch((e: unknown) => e)
    expect(isEngineCannotRunError(err)).toBe(true)
    const expected = { family: 'whisper_cpp', reason: 'library-missing', name: 'libgomp.so.1', exit: 'exit code 127' }
    expect((err as EngineCannotRunError).problem).toMatchObject(expected)
    expect(engineProblemFor('whisper_cpp')).toMatchObject(expected)
    // path-free: the drive path never rides the error message
    expect((err as Error).message).not.toContain('/media/someone')
  })

  it.each<[string, string, RegExp]>([
    ['now with the stderr tail', 'some diagnostic line from whisper\n', /^whisper-cli was terminated \(SIGSEGV\): some diagnostic line from whisper/],
    ['and no dangling colon without stderr', '', /^whisper-cli was terminated \(SIGSEGV\)$/]
  ])('a child killed by a signal keeps the signal message, %s', async (_label, stderrText, message) => {
    const { transcriber } = fakeCliTranscriber({ stderrText, signal: 'SIGSEGV' })
    const err = await transcriber.transcribe('a.mp3', { workDir: workDir() }).catch((e: unknown) => e)
    expect(isEngineCannotRunError(err)).toBe(false)
    expect((err as Error).message).toMatch(message)
    expect(engineProblemFor('whisper_cpp')).toBeNull()
  })

  it('a normal non-zero exit with non-loader stderr keeps the old "exited with code N:" message', async () => {
    const { transcriber } = fakeCliTranscriber({ stderrText: 'model load failed', exitCode: 3 })
    const err = await transcriber.transcribe('a.mp3', { workDir: workDir() }).catch((e: unknown) => e)
    expect(isEngineCannotRunError(err)).toBe(false)
    expect((err as Error).message).toBe('whisper-cli exited with code 3: model load failed')
    expect(engineProblemFor('whisper_cpp')).toBeNull()
  })

  // Node defers only EACCES / EAGAIN / EMFILE / ENFILE / ENOENT to the 'error' event; EPERM and UNKNOWN are
  // THROWN by spawn (#658 — measured: a deny-execute ACL on Windows throws `spawn EPERM`).
  it.each<[string, 'error' | 'thrown', string]>([
    ['the error event', 'error', 'EACCES'],
    ['a synchronous throw (#658)', 'thrown', 'EPERM']
  ])('a Windows spawn refusal (%s, %s) is the typed "blocked" verdict', async (_how, how, code) => {
    const refusal = Object.assign(new Error(`spawn C:\\Kit\\runtime\\whisper.cpp\\win\\whisper-cli.exe ${code}`), { code })
    const { transcriber } = fakeCliTranscriber({ [how]: refusal, platform: 'win32' })
    const err = await transcriber.transcribe('a.wav', { workDir: workDir() }).catch((e: unknown) => e)
    expect(isEngineCannotRunError(err)).toBe(true)
    expect((err as EngineCannotRunError).problem).toEqual({ family: 'whisper_cpp', reason: 'blocked', os: 'win', exit: `spawn error ${code}` })
    expect(engineProblemFor('whisper_cpp')?.reason).toBe('blocked')
  })

  // #790, the order measured on Windows (Node 24.13, Electron 43.8.3): a spawn that fails before its
  // pipes are open emits the child's ENOENT, then ENOTCONN on stdout and on stderr. Unhandled, each
  // stream error is an uncaught exception: a main-process crash in an audio import or a dictation.
  it('absorbs the errors on both piped streams of a failed spawn and rejects with the spawn error (#790)', async () => {
    const thrown: unknown[] = []
    const missing = Object.assign(new Error('spawn C:\\Kit\\runtime\\whisper.cpp\\win\\whisper-cli.exe ENOENT'), { code: 'ENOENT' })
    const { transcriber } = fakeCliTranscriber({ error: missing, pipeErrorsThrown: thrown, platform: 'win32' })
    const err = await transcriber.transcribe('a.wav', { workDir: workDir() }).catch((e: unknown) => e)
    expect(err).toBe(missing) // not a refusal: passed on as it came
    expect(thrown).toEqual([])
  })

  // The #530 heal at this spawn site: whisper-cli ran, so a refusal recorded against it is stale.
  it('a clean run clears a verdict recorded against the same program', async () => {
    reportEngineProblem({ family: 'whisper_cpp', reason: 'blocked', os: 'win', exit: 'spawn error EPERM' }, 'C:/fake/whisper-cli.exe')
    const { transcriber } = fakeCliTranscriber({ json: WHISPER_JSON })
    expect(await transcriber.transcribe('a.wav', { workDir: workDir() })).toHaveLength(2)
    expect(engineProblemFor('whisper_cpp')).toBeNull()
  })

  // #869: and in the documents folder, every platform — the folder its bare-name arguments resolve in.
  it('spawns with windowsHide: true, in the documents folder', async () => {
    const dir = workDir()
    const { transcriber, spawnOptions } = fakeCliTranscriber({ stderrText: LOADER_LINE, exitCode: 127 })
    await transcriber.transcribe('a.mp3', { workDir: dir }).catch(() => undefined)
    expect(spawnOptions[0]?.windowsHide).toBe(true)
    expect(spawnOptions[0]?.cwd).toBe(resolve(dir))
  })
})

// #869: the pinned whisper-cli reads its command line through the Windows ANSI code page, so the
// child starts in the documents folder and gets ASCII spellings from there (the pure planner's rows
// are in transcriber-argv.test.ts). These rows cover what the transcriber does around the spawn: the
// working directory, the transcript read back under a non-ASCII root, the transient copy of an
// original that has no ASCII spelling, and the refusal of a model that has none.
describe('WhisperCliTranscriber — non-ASCII paths on Windows (#869)', () => {
  /** An ASCII temp root (Node 24.13's rmSync skips a non-ASCII one), with non-ASCII folders inside it. */
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-869-'))

  it('reads the transcript back from the documents folder of a non-ASCII root, the stored file by its bare name', async () => {
    const docs = join(scratch(), 'Jörg äöü', 'workspace', 'documents')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, 'doc-1.mp3'), 'AUDIO')
    const { transcriber, spawned, spawnOptions } = fakeCliTranscriber({ json: WHISPER_JSON })
    const segments = await transcriber.transcribe(join(docs, 'doc-1.mp3'), { workDir: docs })
    expect(segments.map((s) => s.text)).toEqual(['Abschnitt drei der Erzählungen.', 'Dies ist eine Aufnahme.'])
    expect(spawnOptions[0]?.cwd).toBe(resolve(docs))
    expect(spawned[0][spawned[0].indexOf('-f') + 1]).toBe('doc-1.mp3')
    // Not asserted here: that the transcript is gone. Node 24.13's `rmSync` silently skips a path
    // with a non-ASCII character (measured 2026-11-18; Electron 43.8.6's Node 24.22.1 removes it),
    // so the shred would fail on such a test runtime for a reason that is not the app's. The rows
    // below and above prove the shred in an ASCII folder.
  })

  // A dev run's relative drive root (or `HILBERTRAUM_WHISPER_BIN`): the child starts elsewhere, so a
  // relative command or model would be looked up from the documents folder — the #787 trap.
  it('hands the child the command and the models resolved from the app folder, not from its own', async () => {
    const docs = scratch()
    const spawnedAs: string[] = []
    const transcriber = createWhisperCliTranscriber({
      id: 't',
      binPath: join('drive', 'runtime', 'whisper-cli'),
      modelPath: join('drive', 'models', 'ggml-small.bin'),
      vadModelPath: join('drive', 'models', 'ggml-silero-v5.1.2.bin'),
      spawnImpl: (cmd: string, args: string[], o: SpawnOptions): ChildProcess => {
        spawnedAs.push(cmd, args[args.indexOf('-m') + 1], args[args.indexOf('-vm') + 1])
        const child = makeFakeChild()
        setImmediate(() => {
          const outJson = transcriptPathOf(args, o)
          if (outJson) writeFileSync(outJson, JSON.stringify(WHISPER_JSON))
          child.emit('close', 0, null)
        })
        return child as unknown as ChildProcess
      }
    })
    await transcriber.transcribe(join(docs, 'a.wav'), { workDir: docs, vad: true })
    expect(spawnedAs).toEqual([
      resolve('drive', 'runtime', 'whisper-cli'),
      resolve('drive', 'models', 'ggml-small.bin'),
      resolve('drive', 'models', 'ggml-silero-v5.1.2.bin')
    ])
  })

  // An encrypted first import parses the user's ORIGINAL file wherever it is (`ingestion/index.ts`).
  // With no ASCII spelling from the documents folder it is copied there under an ASCII `.parse` name
  // (the startup crash sweep covers it) for exactly as long as the child runs. `platform: 'win32'`
  // picks the Windows plan on every host; the copy itself is the same code everywhere.
  it.each<[string, { exitCode?: number; stderrText?: string; json?: unknown; hold?: boolean }, 'resolves' | 'rejects', 'abort' | 'suspend' | null]>([
    ['a transcription that succeeds', { json: WHISPER_JSON }, 'resolves', null],
    ['a transcription that fails', { exitCode: 3, stderrText: 'error: failed to initialize whisper context' }, 'rejects', null],
    ['a cancelled transcription', { hold: true }, 'rejects', 'abort'],
    ['a transcription stopped by suspend() (lock)', { hold: true }, 'rejects', 'suspend']
  ])('copies an original with no ASCII spelling in for the run and shreds it after %s', async (_label, child, outcome, end) => {
    const root = scratch()
    const docs = join(root, 'workspace', 'documents')
    const origin = join(root, 'Jörg', 'Music', 'Sitzung März.mp3')
    mkdirSync(docs, { recursive: true })
    mkdirSync(join(root, 'Jörg', 'Music'), { recursive: true })
    writeFileSync(origin, 'ORIGINAL-AUDIO-BYTES')
    const seenByChild: Array<{ file: string; bytes: string | null }> = []
    const { transcriber } = fakeCliTranscriber({
      ...child,
      platform: 'win32',
      onSpawn: (args, o) => {
        const file = args[args.indexOf('-f') + 1]
        const copy = resolve(String(o.cwd), file)
        seenByChild.push({ file, bytes: existsSync(copy) ? readFileSync(copy, 'utf8') : null })
      }
    })
    const controller = new AbortController()
    const call = transcriber.transcribe(origin, { workDir: docs, signal: controller.signal })
    if (end) {
      await until(() => seenByChild.length > 0, 'the child starting') // it "runs" until killed
      if (end === 'abort') controller.abort()
      else await transcriber.suspend() // must not return before the copy is shredded (L5)
      if (end === 'suspend') expect(readdirSync(docs)).toEqual([])
    }
    if (outcome === 'resolves') await expect(call).resolves.toHaveLength(2)
    else await expect(within(call, 'the transcription settling')).rejects.toThrow()
    expect(seenByChild).toEqual([{ file: expect.stringMatching(/^[0-9a-f-]{36}\.parse-audio\.mp3$/), bytes: 'ORIGINAL-AUDIO-BYTES' }])
    expect(readdirSync(docs)).toEqual([]) // the copy and the transcript are shredded
    expect(readFileSync(origin, 'utf8')).toBe('ORIGINAL-AUDIO-BYTES') // the original is never touched
  })

  // The copy is the call's work before a child exists, so a quit's stop(), a lock's or an engine
  // update's suspend() and a cancel each reach it as they reach a running child: the copy is aborted,
  // nothing is spawned, and the partial copy is shredded before stop()/suspend() return. An engine
  // update suspends WITHOUT aborting the import's signal (`registerEngineIpc` pauseEngineUsers).
  describe('a copy still being written', () => {
    afterEach(() => {
      stalledCopy.armed = false
      stalledCopy.source = null
      stalledCopy.writer = null
      hashProbe.events.length = 0
      hashProbe.hold = null
    })

    /** Start a transcription of an original that is copied in (its child "runs" until killed). With
     *  `stall` (the default) the copy stops after its first chunk and this resolves once that chunk is
     *  on disk; without it the copy completes on its own and this resolves at once. */
    async function copyInFlight(stall = true): Promise<{
      docs: string
      call: Promise<unknown>
      controller: AbortController
      spawned: string[][]
      transcriber: ReturnType<typeof createWhisperCliTranscriber>
    }> {
      const root = scratch()
      const docs = join(root, 'workspace', 'documents')
      mkdirSync(docs, { recursive: true })
      mkdirSync(join(root, 'Олена'), { recursive: true })
      const origin = join(root, 'Олена', 'Sitzung März.wav')
      writeFileSync(origin, 'ORIGINAL-AUDIO-BYTES')
      const { transcriber, spawned } = fakeCliTranscriber({
        json: WHISPER_JSON,
        platform: 'win32',
        hold: true,
        onSpawn: () => hashProbe.events.push('spawn')
      })
      const controller = new AbortController()
      stalledCopy.armed = stall
      const call = transcriber.transcribe(origin, { workDir: docs, signal: controller.signal })
      call.catch(() => undefined) // settled by each row
      if (stall) {
        await until(
          () => readdirSync(docs).some((f) => f.includes('.parse-audio') && readFileSync(join(docs, f), 'utf8') === 'PARTIAL-AUDIO'),
          'the copy writing its first chunk'
        )
      }
      return { docs, call, controller, spawned, transcriber }
    }

    it.each<[string, (t: ReturnType<typeof createWhisperCliTranscriber>, c: AbortController) => Promise<void> | void]>([
      ['stop() (quit)', (t) => t.stop()],
      ['suspend() (lock, engine update)', (t) => t.suspend()]
    ])('%s aborts it, spawns nothing, and returns only once the partial copy is shredded', async (_label, end) => {
      const { docs, call, spawned, transcriber, controller } = await copyInFlight()
      await within(Promise.resolve(end(transcriber, controller)), 'stop()/suspend() returning')
      expect(readdirSync(docs)).toEqual([]) // shredded BEFORE it returned
      await expect(within(call, 'the transcription settling')).rejects.toThrow('Transcription was cancelled.')
      expect(spawned).toHaveLength(0)
    })

    it('a cancel aborts it and spawns nothing', async () => {
      const { docs, call, spawned, controller } = await copyInFlight()
      controller.abort()
      await expect(within(call, 'the transcription settling')).rejects.toThrow('Transcription was cancelled.')
      expect(spawned).toHaveLength(0)
      expect(readdirSync(docs)).toEqual([])
    })

    // #516 + vuln-scan B, the order that matters: the copy comes FIRST, then the spawn gate, the binary
    // hash and the spawn, in that order and with nothing between the hash and the spawn. An engine
    // install that starts its swap during a long copy therefore holds the spawn, and the binary is
    // hashed only after the swap — the one that will run, never the one replaced under the copy.
    it('an engine swap that begins during it holds the spawn, and the binary is hashed after the swap', async () => {
      const { spawned, transcriber } = await copyInFlight()
      const release = holdEngineSpawns('whisper_cpp')
      try {
        const closed = once(stalledCopy.writer!, 'close')
        stalledCopy.source!.push(null) // the copy completes while the swap runs
        await within(closed, 'the copy closing')
        await new Promise((r) => setImmediate(r)) // every continuation of the finished copy has run
        expect(spawned).toHaveLength(0)
      } finally {
        hashProbe.events.push('swap over')
        release()
      }
      await until(() => spawned.length === 1, 'the spawn after the swap')
      expect(hashProbe.events).toEqual(['swap over', 'hash', 'spawn'])
      await transcriber.stop() // the held child
    })

    // A suspend() (or stop()) landing during the binary hash — after the copy, before the spawn — is
    // seen too: the finished copy is shredded before it returns, and no child starts afterwards.
    it('a suspend() during the binary hash returns at once, the copy shredded, and starts nothing', async () => {
      let hashDone: () => void = () => undefined
      hashProbe.hold = new Promise<void>((r) => (hashDone = r))
      const { docs, call, spawned, transcriber } = await copyInFlight(false)
      try {
        await until(() => hashProbe.events.includes('hash'), 'the hash starting')
        await within(transcriber.suspend(), 'suspend() returning during the hash')
        expect(readdirSync(docs)).toEqual([])
      } finally {
        hashDone()
      }
      await expect(within(call, 'the transcription settling')).rejects.toThrow('Transcription was cancelled.')
      expect(spawned).toHaveLength(0)
    })

    // The engine update's own suspend() then lands while the finished copy waits at that gate: it must
    // not wait for the gate (the swap waits for it), and nothing may start after the swap.
    it('a suspend() while the finished copy waits at the gate returns at once and starts nothing', async () => {
      const { docs, call, spawned, transcriber } = await copyInFlight()
      const release = holdEngineSpawns('whisper_cpp')
      try {
        const closed = once(stalledCopy.writer!, 'close')
        stalledCopy.source!.push(null)
        await within(closed, 'the copy closing')
        await new Promise((r) => setImmediate(r)) // parked at the gate
        await within(transcriber.suspend(), 'suspend() returning while the gate is held')
        expect(readdirSync(docs)).toEqual([])
      } finally {
        release()
      }
      await expect(within(call, 'the transcription settling')).rejects.toThrow('Transcription was cancelled.')
      expect(spawned).toHaveLength(0)
    })
  })

  // Only a user's own manifest can give a model a path with a non-ASCII character; copying gigabytes
  // per call is no option, so the call is refused, typed, before anything is spawned or written.
  it('refuses a model with no ASCII spelling before it spawns or writes anything', async () => {
    const docs = scratch()
    const { transcriber, spawned } = fakeCliTranscriber({
      json: WHISPER_JSON,
      platform: 'win32',
      modelPath: join(tmpdir(), 'models', 'ggml-small-für-mich.bin')
    })
    const err = await transcriber.transcribe(join(docs, 'a.wav'), { workDir: docs }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WhisperPathError)
    expect(err).toMatchObject({ arg: '-m' })
    expect((err as Error).message).not.toContain('für-mich') // path-free
    expect(spawned).toHaveLength(0)
    expect(readdirSync(docs)).toEqual([])
  })
})
