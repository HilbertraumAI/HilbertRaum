import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
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
  DICTATION_BUSY_MESSAGE,
  DICTATION_FAILED_MESSAGE,
  DICTATION_MAX_BYTES,
  DICTATION_TOO_LONG_MESSAGE,
  DICTATION_UNAVAILABLE_MESSAGE,
  registerDictationIpc
} from '../../src/main/ipc/registerDictationIpc'
import { documentsDir } from '../../src/main/services/ingestion'
import type { Transcriber, TranscribeOptions } from '../../src/main/services/transcriber'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** A fake transcriber that records what it saw on disk at transcribe time. */
function fakeTranscriber(behavior?: { fail?: boolean }): {
  transcriber: Transcriber
  seen: { filePath: string; existed: boolean; bytes: Buffer | null; workDir?: string }[]
} {
  const seen: { filePath: string; existed: boolean; bytes: Buffer | null; workDir?: string }[] = []
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
          workDir: opts?.workDir
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

  it('refuses with friendly copy when no transcriber is selected', async () => {
    const workspacePath = freshWorkspacePath()
    registerDictationIpc(ctxWith(workspacePath, null).ctx)

    await expect(invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      DICTATION_UNAVAILABLE_MESSAGE
    )
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
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
    await new Promise((r) => setImmediate(r)) // let the first reach transcribe()
    // The second press is refused with friendly copy and never reaches the transcriber.
    await expect(invoke(handlers, IPC.transcribeDictation, new Uint8Array([4, 5, 6]))).rejects.toThrow(
      DICTATION_BUSY_MESSAGE
    )
    expect(calls).toBe(1)
    release()
    const { result } = await first
    expect(result).toBe('done')
    // The guard is released after completion — its temp file is shredded too.
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })

  // REL-3 (TEST-4): a wedged child must not hang the mic spinner forever — the wall-clock
  // ceiling aborts it (→ kills the whisper child) and the renderer gets the friendly copy.
  it('a wedged child rejects on the wall-clock timeout, not a hang (REL-3)', async () => {
    const workspacePath = freshWorkspacePath()
    // Only settles when the dictation timeout aborts the signal (mimics a killed child).
    const transcriber: Transcriber = {
      id: 'wedged',
      transcribe: (_filePath: string, opts: TranscribeOptions) =>
        new Promise<never>((_resolve, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () => reject(new Error('Transcription was cancelled.')),
            { once: true }
          )
        })
    }
    registerDictationIpc(ctxWith(workspacePath, transcriber).ctx, { maxDurationMs: 30 })

    await expect(invoke(handlers, IPC.transcribeDictation, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      DICTATION_FAILED_MESSAGE
    )
    // The temp WAV is shredded even though the child wedged (finally ran).
    expect(readdirSync(documentsDir(workspacePath))).toEqual([])
  })
})
