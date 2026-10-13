import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  createWhisperCliTranscriber,
  resolveWhisperCliPath,
  vadModelPathOf,
  whisperCliBinaryName,
  whisperCliDir
} from '../../src/main/services/transcriber'
import { AUDIO_DECODE_ERROR_PREFIX, VAD_SPEECH_PAD_MS } from '../../src/main/services/transcriber/cli'
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
import { within } from '../helpers/hang-budget'

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
  vadModelPath?: string
  platform?: NodeJS.Platform
}): { transcriber: ReturnType<typeof createWhisperCliTranscriber>; spawned: string[][]; spawnOptions: SpawnOptions[] } {
  const spawned: string[][] = []
  const spawnOptions: SpawnOptions[] = []
  const transcriber = createWhisperCliTranscriber({
    id: 'whisper-small-multilingual',
    binPath: 'C:/fake/whisper-cli.exe',
    modelPath: 'C:/fake/ggml-small.bin',
    vadModelPath: opts.vadModelPath,
    platform: opts.platform,
    threads: 4,
    spawnImpl: (_cmd: string, args: string[], o: SpawnOptions): ChildProcess => {
      spawned.push(args)
      spawnOptions.push(o)
      if (opts.thrown) throw opts.thrown
      const child = makeFakeChild()
      setImmediate(() => {
        if (opts.error) return void child.emit('error', opts.error)
        const outBase = args[args.indexOf('-of') + 1]
        if (opts.stderrText) child.stderr.emit('data', Buffer.from(opts.stderrText))
        if (opts.json !== undefined) writeFileSync(`${outBase}.json`, JSON.stringify(opts.json))
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
    expect(args[args.indexOf('-vm') + 1]).toBe(VAD)
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
    const { transcriber, spawned } = fakeCliTranscriber({ json: WHISPER_JSON })
    const segments = await transcriber.transcribe('C:/audio/meeting.mp3', { workDir })
    expect(segments).toEqual([
      { startMs: 0, endMs: 5920, text: 'Abschnitt drei der Erzählungen.' },
      { startMs: 5920, endMs: 8440, text: 'Dies ist eine Aufnahme.' }
    ])
    // CLI contract: model, file, auto language, threads, progress, JSON out.
    const args = spawned[0]
    expect(args[args.indexOf('-m') + 1]).toBe('C:/fake/ggml-small.bin')
    expect(args[args.indexOf('-f') + 1]).toBe('C:/audio/meeting.mp3')
    expect(args[args.indexOf('-l') + 1]).toBe('auto')
    expect(args).toContain('-pp')
    expect(args).toContain('-oj')
    // The transcript JSON is CONTENT: the transient carries the crash-sweep `.parse`
    // infix inside workDir and is gone after the call.
    const outBase = args[args.indexOf('-of') + 1]
    expect(outBase.startsWith(workDir)).toBe(true)
    expect(outBase).toContain('.parse')
    expect(existsSync(`${outBase}.json`)).toBe(false)
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
      spawnImpl: (_cmd, args, _o): ChildProcess => {
        const child = makeFakeChild() as FakeChild & { pid: number }
        child.pid = 7777
        setImmediate(() => {
          observedDuringRun = registeredSidecarPids()
          const outBase = args[args.indexOf('-of') + 1]
          writeFileSync(`${outBase}.json`, JSON.stringify(WHISPER_JSON))
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
      spawnImpl: (_cmd: string, args: string[]): ChildProcess => {
        const child = makeFakeChild()
        const outBase = args[args.indexOf('-of') + 1]
        outJson = `${outBase}.json`
        writeFileSync(outJson, JSON.stringify(WHISPER_JSON)) // transcript content on disk
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
      spawnImpl: (_cmd: string, args: string[]): ChildProcess => {
        const child = makeStubbornChild(['SIGKILL']) // ignores SIGTERM, dies only on SIGKILL
        held = child
        outJson = `${args[args.indexOf('-of') + 1]}.json`
        writeFileSync(outJson, JSON.stringify(WHISPER_JSON)) // transcript content on disk
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

  // The #530 heal at this spawn site: whisper-cli ran, so a refusal recorded against it is stale.
  it('a clean run clears a verdict recorded against the same program', async () => {
    reportEngineProblem({ family: 'whisper_cpp', reason: 'blocked', os: 'win', exit: 'spawn error EPERM' }, 'C:/fake/whisper-cli.exe')
    const { transcriber } = fakeCliTranscriber({ json: WHISPER_JSON })
    expect(await transcriber.transcribe('a.wav', { workDir: workDir() })).toHaveLength(2)
    expect(engineProblemFor('whisper_cpp')).toBeNull()
  })

  it('spawns with windowsHide: true', async () => {
    const { transcriber, spawnOptions } = fakeCliTranscriber({ stderrText: LOADER_LINE, exitCode: 127 })
    await transcriber.transcribe('a.mp3', { workDir: workDir() }).catch(() => undefined)
    expect(spawnOptions[0]?.windowsHide).toBe(true)
  })
})
