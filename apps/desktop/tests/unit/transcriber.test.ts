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
    const root = mkdtempSync(join(tmpdir(), 'paid-whisper-bin-'))
    expect(resolveWhisperCliPath(root, 'win32', {})).toBeNull()
    const binDir = whisperCliDir(root, 'win32')
    expect(binDir).toBe(join(root, 'runtime', 'whisper.cpp', 'win'))
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, whisperCliBinaryName('win32')), 'fake')
    expect(resolveWhisperCliPath(root, 'win32', {})).toBe(join(binDir, 'whisper-cli.exe'))
  })

  it('honours the PAID_WHISPER_BIN override (existing file only)', () => {
    const root = mkdtempSync(join(tmpdir(), 'paid-whisper-ovr-'))
    const bin = join(root, 'custom-whisper.exe')
    expect(resolveWhisperCliPath(root, 'win32', { PAID_WHISPER_BIN: bin })).toBeNull()
    writeFileSync(bin, 'fake')
    expect(resolveWhisperCliPath(root, 'win32', { PAID_WHISPER_BIN: bin })).toBe(bin)
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
  it('parses the -oj JSON into ordered ms segments and shreds the transient', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'paid-whisper-work-'))
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
    const workDir = mkdtempSync(join(tmpdir(), 'paid-whisper-prog-'))
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
    const workDir = mkdtempSync(join(tmpdir(), 'paid-whisper-decode-'))
    const { transcriber } = fakeCliTranscriber({
      stderrText: 'read_audio_data: failed to read audio data\nerror: failed to read audio file',
      exitCode: 0
    })
    await expect(transcriber.transcribe('bad.m4a', { workDir })).rejects.toThrow(
      AUDIO_DECODE_ERROR_PREFIX
    )
  })

  it('fails loudly on a hard non-zero exit (missing DLL, bad model)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'paid-whisper-exit-'))
    const { transcriber } = fakeCliTranscriber({ stderrText: 'model load failed', exitCode: 3 })
    await expect(transcriber.transcribe('a.mp3', { workDir })).rejects.toThrow(/exited with code 3/)
  })

  it('suspend() kills the in-flight child and the call rejects (workspace lock)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'paid-whisper-susp-'))
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
    const workDir = mkdtempSync(join(tmpdir(), 'paid-whisper-shred-'))
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
    const { transcriber } = fakeCliTranscriber({ json: WHISPER_JSON })
    await transcriber.stop()
    await expect(transcriber.transcribe('a.mp3')).rejects.toThrow(/stopped/)
  })
})
