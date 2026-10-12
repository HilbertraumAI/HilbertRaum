import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// IPC-layer tests for registerDictationIpc (Phase 37, D30): bytes → transient temp
// WAV (documents dir, `.parse` infix — crash-sweep covered) → fake transcriber →
// text; the temp file is shredded on success AND on failure; an absent transcriber
// and oversized/empty payloads are refused with friendly copy; nothing is audited.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { IPC } from '../../src/shared/ipc'
import {
  DEFAULT_DICTATION_TIMEOUT_MS,
  DICTATION_BUSY_MESSAGE,
  DICTATION_FAILED_MESSAGE,
  DICTATION_MAX_BYTES,
  DICTATION_TOO_LONG_MESSAGE,
  DICTATION_UNAVAILABLE_MESSAGE,
  registerDictationIpc
} from '../../src/main/ipc/registerDictationIpc'
import { documentsDir } from '../../src/main/services/ingestion'
import { createPlaintextOps } from '../../src/main/services/ingestion/plaintext-ops'
import { encodeWavPcm16 } from '../../src/renderer/lib/wav'
import { t } from '../../src/shared/i18n'
import { EngineCannotRunError } from '../../src/main/services/runtime/engine-load'
import type { Transcriber, TranscribeOptions } from '../../src/main/services/transcriber'
import type { AppContext } from '../../src/main/services/context'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { until, within } from '../helpers/hang-budget'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** A fake transcriber that records what it saw on disk at transcribe time. */
function fakeTranscriber(behavior?: { fail?: boolean }): {
  transcriber: Transcriber
  seen: { filePath: string; existed: boolean; bytes: Buffer | null; workDir?: string; vad?: boolean }[]
} {
  const seen: { filePath: string; existed: boolean; bytes: Buffer | null; workDir?: string; vad?: boolean }[] = []
  return {
    seen,
    transcriber: {
      id: 'fake-whisper',
      async transcribe(filePath: string, opts?: TranscribeOptions) {
        const existed = existsSync(filePath)
        seen.push({
          filePath,
          existed,
          bytes: existed ? readFileSync(filePath) : null,
          workDir: opts?.workDir,
          vad: opts?.vad
        })
        if (behavior?.fail) throw new Error('boom: ggml backend exploded (exit 3)')
        return [
          { startMs: 0, endMs: 800, text: ' Hello there ' },
          { startMs: 800, endMs: 1500, text: 'dictation  works' }
        ]
      }
    }
  }
}

function ctxWith(workspacePath: string, transcriber: Transcriber | null): {
  ctx: AppContext
  audit: ReturnType<typeof vi.fn>
} {
  const audit = vi.fn()
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { workspacePath },
    transcriber,
    audit,
    workspace: { isUnlocked: () => true }
  } as unknown as AppContext
  return { ctx, audit }
}

function freshWorkspacePath(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-dictation-'))
}

beforeEach(() => ipcState.handlers.clear())

describe('registerDictationIpc', () => {
  it('writes the bytes to a .parse-infixed temp WAV in the documents dir, transcribes, returns joined text, shreds', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    const { ctx, audit } = ctxWith(workspacePath, transcriber)
    registerDictationIpc(ctx)

    const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]) // arbitrary bytes
    const { result } = await invoke(handlers, IPC.transcribeDictation, audio)

    // The transcriber got a real file holding exactly the sent bytes.
    expect(seen).toHaveLength(1)
    expect(seen[0].existed).toBe(true)
    expect(Buffer.from(audio).equals(seen[0].bytes!)).toBe(true)
    // Temp-file contract: documents dir, `.parse` infix (crash-sweep coverage), .wav.
    expect(dirname(seen[0].filePath)).toBe(documentsDir(workspacePath))
    expect(basename(seen[0].filePath)).toMatch(/\.parse-dictation\.wav$/)
    // The transcriber's own transient JSON is steered into the same swept dir.
    expect(seen[0].workDir).toBe(documentsDir(workspacePath))
    // Joined, whitespace-normalized text back to the composer.
    expect(result).toBe('Hello there dictation works')
    // Shredded after success; nothing lingers in the documents dir.
    expect(existsSync(seen[0].filePath)).toBe(false)
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
    // Dictation is deliberately NOT audited (content-adjacent, plan §12).
    expect(audit).not.toHaveBeenCalled()
  })

  it('shreds the temp file and returns friendly copy when the transcriber fails', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber({ fail: true })
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    const err = await invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3])).then(
      () => null,
      (e: unknown) => e
    )
    expect(String(err)).toContain(DICTATION_FAILED_MESSAGE)
    // Never the raw CLI error (§11.4 — the technical reason stays in the local log).
    expect(String(err)).not.toMatch(/ggml|exit 3/)
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(existsSync(s.filePath)).toBe(false)
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })

  // PERF-2: the WAV write is now `await writeFile` (off the main thread). The write-failure path must
  // still behave: friendly copy (never the raw reason), the transcriber never reached, the temp shred
  // runs (no-op here — the file was never created), and inFlight is reset so a later dictation works.
  it('returns friendly copy + recovers when the temp write itself fails (PERF-2)', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)
    const docsDir = join(workspacePath, 'documents') // the storeDir captured at registration

    // Remove the documents dir so `await writeFile(<docsDir>/uuid.wav)` rejects (ENOENT) before transcribe.
    rmSync(docsDir, { recursive: true, force: true })
    const err = await invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3])).then(
      () => null,
      (e: unknown) => e
    )
    expect(String(err)).toContain(DICTATION_FAILED_MESSAGE)
    // Never the raw fs reason (the path/errno stays in the local log only).
    expect(String(err)).not.toMatch(/ENOENT|no such file/i)
    // The write threw BEFORE transcribe — the transcriber was never reached.
    expect(seen.length).toBe(0)

    // inFlight was reset by the `finally` even on the write-failure path: a second dictation works.
    mkdirSync(docsDir, { recursive: true })
    const { result } = await invoke(handlers, IPC.transcribeDictation, new Uint8Array([4, 5, 6]))
    expect(result).toBe('Hello there dictation works')
    expect(seen.length).toBe(1)
  })

  it('refuses with friendly copy when no transcriber is selected', async () => {
    const workspacePath = freshWorkspacePath()
    registerDictationIpc(ctxWith(workspacePath, null).ctx)

    await expect(invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      DICTATION_UNAVAILABLE_MESSAGE
    )
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })

  // S3 (full-audit-2026-06-30): the handler used to dispatch on the transcriber's presence
  // alone, landing a transient PLAINTEXT WAV in the documents dir even while the vault is
  // locked (where it should hold only `.enc` sidecars) — an F16 lock-guard parity gap. With a
  // transcriber PRESENT (so the refusal is the lock gate, not the unavailable backstop) and a
  // LOCKED workspace, it must refuse with the friendly locked copy and write nothing.
  it('refuses on a locked vault and writes NO file under documents/ (S3)', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    const lockedCtx = {
      trustedSenders: ANY_SENDER,
      paths: { workspacePath },
      transcriber,
      audit: vi.fn(),
      workspace: { isUnlocked: () => false }
    } as unknown as AppContext
    registerDictationIpc(lockedCtx)

    await expect(
      invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(/Workspace is locked\./)
    // The refusal precedes any disk write AND the transcriber dispatch.
    expect(seen).toHaveLength(0)
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
    // (The unlocked happy-path test above is the control: the same byte shape succeeds when
    // isUnlocked() is true, so only the lock gate refused here.)
  })

  it('refuses empty and non-byte payloads without touching the disk', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    await expect(invoke(handlers, IPC.transcribeDictation, new Uint8Array(0))).rejects.toThrow(
      DICTATION_FAILED_MESSAGE
    )
    await expect(invoke(handlers, IPC.transcribeDictation, 'not-bytes')).rejects.toThrow(DICTATION_FAILED_MESSAGE)
    await expect(invoke(handlers, IPC.transcribeDictation, undefined)).rejects.toThrow(DICTATION_FAILED_MESSAGE)
    expect(seen).toHaveLength(0)
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })

  it('refuses an implausibly large recording with a next step (import instead)', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    const huge = new Uint8Array(DICTATION_MAX_BYTES + 1)
    await expect(invoke(handlers, IPC.transcribeDictation, huge)).rejects.toThrow(DICTATION_TOO_LONG_MESSAGE)
    expect(seen).toHaveLength(0)
  })

  it('accepts a Buffer payload (what Electron IPC actually delivers)', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber } = fakeTranscriber()
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    const { result } = await invoke(handlers, IPC.transcribeDictation, Buffer.from([9, 9, 9]))
    expect(result).toBe('Hello there dictation works')
  })

  // #497: the silence gate's backstop. The renderer refuses a silent recording first (with the
  // actionable copy); the handler re-checks the WAV bytes so a silent clip can never reach
  // whisper — which hallucinates a word ("you" on the pinned build) rather than return nothing.
  it('refuses a silent WAV before touching the disk or the transcriber (#497)', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    const silent = encodeWavPcm16(new Float32Array(16000 * 2), 16000) // 2 s of digital silence
    await expect(invoke(handlers, IPC.transcribeDictation, silent)).rejects.toThrow(
      t('en', 'main.dictation.silent')
    )
    expect(seen).toHaveLength(0)
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })

  it('refuses a too-short WAV with the no-speech copy, not the microphone copy (#497)', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    const loudButShort = new Float32Array(1600) // 100 ms
    for (let i = 0; i < loudButShort.length; i++) loudButShort[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000)
    await expect(invoke(handlers, IPC.transcribeDictation, encodeWavPcm16(loudButShort, 16000))).rejects.toThrow(
      t('en', 'main.dictation.tooShort')
    )
    expect(seen).toHaveLength(0)
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })

  it('passes a speech-level WAV through to the transcriber unchanged (#497)', async () => {
    const workspacePath = freshWorkspacePath()
    const { transcriber, seen } = fakeTranscriber()
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    const tone = new Float32Array(16000 * 2)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / 16000) // −20 dBFS
    const wav = encodeWavPcm16(tone, 16000)
    const { result } = await invoke(handlers, IPC.transcribeDictation, wav)
    expect(result).toBe('Hello there dictation works')
    expect(seen).toHaveLength(1)
    expect(seen[0].bytes).toEqual(Buffer.from(wav))
    // #504: dictation asks for Silero VAD (the backend honours it only with the model on the drive).
    expect(seen[0].vad).toBe(true)
  })

  // REL-3 (TEST-4): whisper is not internally serialized, so a second mic press while the
  // first dictation is in flight would spawn a concurrent child. The single-flight guard
  // rejects the second invocation BEFORE it touches disk/spawns — no double-spawn.
  it('rejects a concurrent dictation without double-spawning (REL-3)', async () => {
    const workspacePath = freshWorkspacePath()
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const transcriber: Transcriber = {
      id: 'blocking',
      async transcribe(_filePath: string, _opts?: TranscribeOptions) {
        calls += 1
        await gate
        return [{ startMs: 0, endMs: 1, text: 'done' }]
      }
    }
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)

    const first = invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3]))
    // PERF-2: the async `await writeFile` precedes transcribe(), so wait on the observable (TEST-1: an iteration cap
    // flaked under full-suite load). inFlight is set synchronously, so the BUSY refusal below holds regardless.
    await until(() => calls > 0, 'the first dictation reaching transcribe')
    expect(calls).toBe(1)
    // The second press is refused with friendly copy and never reaches the transcriber (were it let through, it
    // would park on the gate: `within` names that instead of a bare test timeout).
    await expect(
      within(invoke(handlers, IPC.transcribeDictation, new Uint8Array([4, 5, 6])), 'the second press settling')
    ).rejects.toThrow(DICTATION_BUSY_MESSAGE)
    expect(calls).toBe(1)
    release()
    const { result } = await first
    expect(result).toBe('done')
    // The guard is released after completion — its temp file is shredded too.
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })

  // REL-3 (TEST-4): a wedged child must not hang the mic spinner forever — the shipped wall-clock
  // ceiling (DEFAULT_DICTATION_TIMEOUT_MS) aborts it (→ kills the whisper child) and the renderer gets the friendly copy.
  // The fake checks `signal.aborted` before it subscribes (#549: a deadline that fired during the WAV write once
  // left it unsettled for a whole 120 s budget).
  it('a wedged child rejects on the wall-clock timeout, not a hang (REL-3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // The shipped ceiling, not a HILBERTRAUM_DICTATION_TIMEOUT_MS left in the shell (an empty value reads as unset).
    vi.stubEnv('HILBERTRAUM_DICTATION_TIMEOUT_MS', '')
    try {
      const workspacePath = freshWorkspacePath()
      let signal: AbortSignal | undefined
      const transcriber: Transcriber = {
        id: 'wedged',
        transcribe: (_filePath: string, opts: TranscribeOptions) =>
          new Promise<never>((_resolve, reject) => {
            signal = opts.signal
            const cancelled = (): void => reject(new Error('Transcription was cancelled.'))
            if (opts.signal?.aborted) cancelled()
            else opts.signal?.addEventListener('abort', cancelled, { once: true })
          })
      }
      registerDictationIpc(ctxWith(workspacePath, transcriber).ctx)
      const call = invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3]))
      await until(() => signal !== undefined, 'the dictation reaching transcribe')
      vi.advanceTimersByTime(DEFAULT_DICTATION_TIMEOUT_MS - 1)
      expect(signal!.aborted).toBe(false) // just short of the shipped ceiling: still transcribing
      vi.advanceTimersByTime(1)
      await expect(within(call, 'the dictation settling at its ceiling')).rejects.toThrow(DICTATION_FAILED_MESSAGE)
      // The temp WAV is shredded even though the child wedged (finally ran).
      expect(readdirSync(documentsDir(workspacePath))).toEqual([])
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    }
  })

  // #237: a dictation registers with `ctx.plaintextOps`, so "Lock now" / quit reach it: the registry's abort is the
  // whisper child's signal, and its sweep shreds the temp WAV of a transcription that outlives the settle bound. Both
  // steps run in one tick here, before the handler's own `finally` can shred — the state such a transcription leaves.
  it('a lock reaches an in-flight dictation: the registry aborts the whisper child and its sweep shreds the temp WAV (#237)', async () => {
    const workspacePath = freshWorkspacePath()
    const ops = createPlaintextOps()
    let wav: string | null = null
    let signal: AbortSignal | undefined
    const transcriber: Transcriber = {
      id: 'parked',
      transcribe: (filePath: string, opts: TranscribeOptions) =>
        new Promise<never>((_resolve, reject) => {
          wav = filePath
          signal = opts.signal
          const cancelled = (): void => reject(new Error('Transcription was cancelled.'))
          if (opts.signal?.aborted) cancelled()
          else opts.signal?.addEventListener('abort', cancelled, { once: true })
        })
    }
    const { ctx } = ctxWith(workspacePath, transcriber)
    ctx.plaintextOps = ops
    registerDictationIpc(ctx)
    const call = invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3]))
    await until(() => wav !== null, 'the dictation reaching transcribe')
    expect(existsSync(wav!)).toBe(true)
    ops.abortAll()
    expect(signal!.aborted).toBe(true) // the lock reached the whisper child's signal
    expect(ops.sweepRegistered()).toBe(1) // the WAV was tracked, so the lock sweep shreds it
    expect(existsSync(wav!)).toBe(false)
    await expect(call).rejects.toThrow(DICTATION_FAILED_MESSAGE)
    expect(ops.size()).toBe(0) // released in the handler's finally
  })
})

// #530: the OS refused to start the voice engine — the handler says so (a retry would not help);
// every other failure keeps the generic copy.
describe('registerDictationIpc — voice engine refused by the OS (#530)', () => {
  const throwing = (err: Error): Transcriber => ({
    id: 'fake-whisper',
    async transcribe() {
      throw err
    }
  })

  it('an EngineCannotRunError (whisper family) rejects with the engine-cannot-run copy and shreds the temp file', async () => {
    const workspacePath = freshWorkspacePath()
    const refusal = new EngineCannotRunError('whisper-cli', {
      family: 'whisper_cpp',
      reason: 'library-missing',
      os: 'linux',
      name: 'libgomp.so.1',
      exit: 'exit code 127'
    })
    registerDictationIpc(ctxWith(workspacePath, throwing(refusal)).ctx)
    const err = await invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3])).then(
      () => null,
      (e: unknown) => e
    )
    expect(String(err)).toContain(t('en', 'main.dictation.engineCannotRun'))
    expect(String(err)).not.toContain(DICTATION_FAILED_MESSAGE)
    expect(String(err)).not.toContain('libgomp') // the technical detail stays out of the toast
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })
})
