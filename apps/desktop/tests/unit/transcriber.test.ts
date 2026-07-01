import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  createSelectedTranscriber,
  createWhisperCliTranscriber,
  resolveWhisperCliPath,
  whisperCliBinaryName,
  whisperCliDir,
  type Transcriber,
  type TranscriberModelInfo
} from '../../src/main/services/transcriber'
import { AUDIO_DECODE_ERROR_PREFIX } from '../../src/main/services/transcriber/cli'

// Phase 36 — transcriber selector (the reranker D9 availability matrix) + the CLI
// backend driven by a FAKE spawn (CI is zero-binary: no real process, no real audio).

const MODEL: TranscriberModelInfo = { id: 'whisper-small-multilingual', modelPath: 'D:/models/transcriber/ggml-small.bin' }

describe('createSelectedTranscriber — availability matrix (D9 pattern)', () => {
  const cases: Array<{ name: string; model: TranscriberModelInfo | null; bin: string | null; weights: boolean; expectNull: boolean; reason: RegExp }> = [
    { name: 'no manifest', model: null, bin: 'C:/bin', weights: true, expectNull: true, reason: /no transcriber model/ },
    { name: 'no binary', model: MODEL, bin: null, weights: true, expectNull: true, reason: /no whisper-cli binary/ },
    { name: 'no weights', model: MODEL, bin: 'C:/bin', weights: false, expectNull: true, reason: /weights not present/ },
    { name: 'binary + weights', model: MODEL, bin: 'C:/bin', weights: true, expectNull: false, reason: /binary \+ weights present/ }
  ]

  it.each(cases)('$name → null=$expectNull', ({ model, bin, weights, expectNull, reason }) => {
    let selected = ''
    const result = createSelectedTranscriber({
      rootPath: 'D:/',
      model,
      resolveBin: () => bin,
      modelExists: () => weights,
      makeTranscriber: (m, b): Transcriber => ({ id: `${m.id}@${b}`, transcribe: async () => [] }),
      onSelect: (_kind, r) => {
        selected = r
      }
    })
    expect(result === null).toBe(expectNull)
    expect(selected).toMatch(reason)
    if (!expectNull) expect(result!.id).toBe(`${MODEL.id}@C:/bin`)
  })

  // There is deliberately NO mock fallback: a missing transcriber must surface as a
  // friendly per-file failure, never an invented transcript.
  it('never falls back to a mock', () => {
    const result = createSelectedTranscriber({
      rootPath: 'D:/',
      model: null,
      resolveBin: () => null,
      modelExists: () => false
    })
    expect(result).toBeNull()
  })
})

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

  it('prefers the component runtime (HILBERTRAUM_RUNTIME_ROOT) over the drive, drive is the fallback', () => {
    const drive = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-drive-'))
    const component = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-comp-'))
    // Only the drive has the binary → component-absent → drive wins (fallback).
    const driveDir = whisperCliDir(drive, 'linux')
    mkdirSync(driveDir, { recursive: true })
    const driveBin = join(driveDir, whisperCliBinaryName('linux'))
    writeFileSync(driveBin, 'fake')
    expect(resolveWhisperCliPath(drive, 'linux', { HILBERTRAUM_RUNTIME_ROOT: component })).toBe(driveBin)

    // Now the component also ships it → component wins.
    const compDir = whisperCliDir(component, 'linux')
    mkdirSync(compDir, { recursive: true })
    const compBin = join(compDir, whisperCliBinaryName('linux'))
    writeFileSync(compBin, 'fake')
    expect(resolveWhisperCliPath(drive, 'linux', { HILBERTRAUM_RUNTIME_ROOT: component })).toBe(compBin)
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

/** Build a transcriber whose spawn writes `json` (if given) to the `-of` path. */
function fakeCliTranscriber(opts: {
  json?: unknown
  stderrText?: string
  exitCode?: number
}): { transcriber: ReturnType<typeof createWhisperCliTranscriber>; spawned: string[][] } {
  const spawned: string[][] = []
  const transcriber = createWhisperCliTranscriber({
    id: 'whisper-small-multilingual',
    binPath: 'C:/fake/whisper-cli.exe',
    modelPath: 'C:/fake/ggml-small.bin',
    threads: 4,
    spawnImpl: (_cmd: string, args: string[], _o: SpawnOptions): ChildProcess => {
      spawned.push(args)
      const child = makeFakeChild()
      setImmediate(() => {
        const ofIndex = args.indexOf('-of')
        const outBase = args[ofIndex + 1]
        if (opts.stderrText) child.stderr.emit('data', Buffer.from(opts.stderrText))
        if (opts.json !== undefined) writeFileSync(`${outBase}.json`, JSON.stringify(opts.json))
        if (!child.killed) child.emit('close', opts.exitCode ?? 0, null)
      })
      return child as unknown as ChildProcess
    }
  })
  return { transcriber, spawned }
}

const WHISPER_JSON = {
  result: { language: 'de' },
  transcription: [
    { offsets: { from: 0, to: 5920 }, text: ' Abschnitt drei der Erzählungen.' },
    { offsets: { from: 5920, to: 8440 }, text: ' Dies ist eine Aufnahme.' },
    { offsets: { from: 8440, to: 9000 }, text: '   ' } // whitespace-only → dropped
  ]
}

describe('WhisperCliTranscriber (fake spawn)', () => {
  it('REFUSES to spawn a tampered whisper-cli (pre-spawn re-hash, vuln-scan B)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-tamper-'))
    let spawned = false
    const transcriber = createWhisperCliTranscriber({
      id: 'whisper-small-multilingual',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/ggml-small.bin',
      spawnImpl: (_cmd, _args, _o): ChildProcess => {
        spawned = true
        return makeFakeChild() as unknown as ChildProcess
      },
      verifyBinary: async () => 'mismatch'
    })
    await expect(transcriber.transcribe('C:/audio/meeting.mp3', { workDir })).rejects.toThrow(
      /pre-spawn integrity verification/
    )
    expect(spawned).toBe(false)
    expect(readdirSync(workDir)).toEqual([]) // no transient left behind
  })

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

  it('fails loudly on a hard non-zero exit (missing DLL, bad model)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-exit-'))
    const { transcriber } = fakeCliTranscriber({ stderrText: 'model load failed', exitCode: 3 })
    await expect(transcriber.transcribe('a.mp3', { workDir })).rejects.toThrow(/exited with code 3/)
  })

  it('suspend() kills the in-flight child and the call rejects (workspace lock)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-susp-'))
    let heldChild: FakeChild | null = null
    // A spawn that never closes on its own — the child "runs" until killed.
    const pending = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      spawnImpl: (): ChildProcess => {
        const child = makeFakeChild()
        heldChild = child
        return child as unknown as ChildProcess
      }
    })
    const call = pending.transcribe('a.mp3', { workDir })
    await new Promise((r) => setImmediate(r))
    expect(heldChild).not.toBeNull()
    await pending.suspend()
    await expect(call).rejects.toThrow(/terminated|cancelled/i)
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
    await call.catch(() => undefined) // the cancelled call rejects; the shred is the point
  })

  it('stop() refuses new work permanently (the will-quit latch)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-stop-'))
    const { transcriber } = fakeCliTranscriber({ json: WHISPER_JSON })
    await transcriber.stop()
    await expect(transcriber.transcribe('a.mp3', { workDir })).rejects.toThrow(/stopped/)
  })

  // REL-1 (TEST-4): a wedged/spinning child that emits nothing and never closes on its own
  // is killed by the inactivity watchdog and the call rejects — instead of hanging the
  // ingestion slot until app restart. Teeth: with a generous idleTimeoutMs this never fires
  // (the call would hang), so a small one proving the kill is the load-bearing assertion.
  it('the inactivity watchdog kills a silent/wedged child and rejects (REL-1)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-idle-'))
    let heldChild: FakeChild | null = null
    const t = createWhisperCliTranscriber({
      id: 't',
      binPath: 'C:/fake/whisper-cli.exe',
      modelPath: 'C:/fake/m.bin',
      idleTimeoutMs: 20, // dialled down; prod default is 15 min
      spawnImpl: (): ChildProcess => {
        const child = makeFakeChild() // emits no data, never closes on its own
        heldChild = child
        return child as unknown as ChildProcess
      }
    })
    await expect(t.transcribe('a.mp3', { workDir })).rejects.toThrow(/watchdog|no output/i)
    expect(heldChild).not.toBeNull()
    expect(heldChild!.killed).toBe(true)
    expect(readdirSync(workDir)).toEqual([]) // no transient stranded by the kill
  })

  // REL-1 (TEST-4): the threaded AbortSignal (now actually supplied by the ingestion call
  // site) arms the abort listener — aborting mid-transcription kills the in-flight child and
  // the call rejects "cancelled". Previously the listener existed but was never armed.
  it('an aborted signal kills the in-flight child and the call rejects (REL-1 threaded cancel)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-sig-'))
    const controller = new AbortController()
    let heldChild: FakeChild | null = null
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
    await new Promise((r) => setImmediate(r))
    expect(heldChild).not.toBeNull()
    controller.abort()
    await expect(call).rejects.toThrow(/cancelled/i)
    expect(heldChild!.killed).toBe(true)
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
    const start = Date.now()
    await t.suspend() // resolves via the bounded timeout, not by the child's (absent) exit
    expect(Date.now() - start).toBeLessThan(1500) // did NOT hang
    expect(held!.signals).toContain('SIGKILL') // it still tried the forceful escalation
    void call.catch(() => undefined) // never settles (the child never closes) — that's the point
  })

  // REL-2: the inactivity watchdog is itself a kill site — a wedged child it fires on must
  // also be escalated to SIGKILL, or the watchdog "fires" yet the child lives on.
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
