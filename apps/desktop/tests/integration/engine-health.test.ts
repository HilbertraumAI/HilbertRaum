import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #530 — the session side of "an engine the OS loader refuses to start": healing what the app
// wrote before the fix (gpuAutoDisabled + failed document rows), the `checkProgramLoads` probe,
// and how an ingestion failure persists the canonical path-free row text.

import { t } from '../../src/shared/i18n'
import type { AppContext } from '../../src/main/services/context'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  checkProgramLoads,
  healEngineLoadState,
  isLoaderCausedGpuError
} from '../../src/main/services/engine-health'
import {
  EngineCannotRunError,
  engineProblemFor,
  engineProblems,
  resetEngineProblemsForTest
} from '../../src/main/services/runtime/engine-load'
import {
  engineProblemRowMessage,
  failureRowMessage,
  rewriteEngineFailureRows
} from '../../src/main/services/ingestion/engine-failure'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import type { Embedder } from '../../src/main/services/embeddings'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'

const LINUX = { platform: 'linux' as const }
const WIN = { platform: 'win32' as const, systemDllExists: () => true }

const LEGACY_ROW =
  'llama-server exited before becoming healthy (code 127) — last output: /media/someone/HR/runtime/llama.cpp/linux/llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory'
const LEGACY_GPU_ERROR = `2026-09-30T10:00:00.000Z — ${LEGACY_ROW}`
const GENUINE_GPU_ERROR =
  '2026-09-30T10:00:00.000Z — llama-server exited before becoming healthy (code 1) — last output: ggml_vulkan: Device memory allocation of size 123 failed.'

const dirs: string[] = []
const dbs: Db[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'hilbertraum-engine-health-'))
  dirs.push(d)
  return d
}
function freshDb(): Db {
  const db = openDatabase(join(tmp(), 'test.sqlite'))
  seedSettings(db)
  dbs.push(db)
  return db
}

afterEach(() => {
  resetEngineProblemsForTest()
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const unlockedCtx = (db: Db): Pick<AppContext, 'db' | 'workspace'> =>
  ({ db, workspace: { isUnlocked: () => true } }) as unknown as Pick<AppContext, 'db' | 'workspace'>

/** A document row in a given state (the file need not exist; only the row matters here). */
function addDoc(db: Db, status: string, errorMessage: string | null): string {
  const doc = createQueuedDocument(db, join(tmp(), 'x.txt'))
  db.prepare('UPDATE documents SET status = ?, error_message = ? WHERE id = ?').run(status, errorMessage, doc.id)
  return doc.id
}
const rowMessage = (db: Db, id: string): string | null =>
  (db.prepare('SELECT error_message AS m FROM documents WHERE id = ?').get(id) as { m: string | null }).m

describe('isLoaderCausedGpuError (#530)', () => {
  it('recognises a loader refusal, not a GPU fault, and treats empty input as false', () => {
    expect(isLoaderCausedGpuError(LEGACY_GPU_ERROR, LINUX)).toBe(true)
    expect(isLoaderCausedGpuError(GENUINE_GPU_ERROR, LINUX)).toBe(false)
    expect(isLoaderCausedGpuError('', LINUX)).toBe(false)
    expect(isLoaderCausedGpuError(null, LINUX)).toBe(false)
    expect(isLoaderCausedGpuError(undefined, LINUX)).toBe(false)
  })

  it('recognises the Windows no-text shape (NTSTATUS exit code only)', () => {
    expect(isLoaderCausedGpuError('llama-server exited before becoming healthy (code 3221225781)', WIN)).toBe(true)
  })
})

describe('healEngineLoadState (#530)', () => {
  it('clears a loader-caused compatibility-mode flag together with its error text', () => {
    const db = freshDb()
    updateSettings(db, { gpuAutoDisabled: true, gpuLastError: LEGACY_GPU_ERROR })
    const result = healEngineLoadState(unlockedCtx(db), LINUX)
    expect(result.gpuFlagCleared).toBe(true)
    const s = getSettings(db)
    expect(s.gpuAutoDisabled).toBe(false)
    expect(s.gpuLastError).toBeNull()
  })

  it('leaves a genuine GPU fault alone', () => {
    const db = freshDb()
    updateSettings(db, { gpuAutoDisabled: true, gpuLastError: GENUINE_GPU_ERROR })
    const result = healEngineLoadState(unlockedCtx(db), LINUX)
    expect(result.gpuFlagCleared).toBe(false)
    const s = getSettings(db)
    expect(s.gpuAutoDisabled).toBe(true)
    expect(s.gpuLastError).toBe(GENUINE_GPU_ERROR)
  })

  it('skips a locked or locking workspace without throwing (and without touching the DB)', () => {
    const db = freshDb()
    updateSettings(db, { gpuAutoDisabled: true, gpuLastError: LEGACY_GPU_ERROR })
    const id = addDoc(db, 'failed', LEGACY_ROW)
    const locked = { db, workspace: { isUnlocked: () => false } } as unknown as Pick<AppContext, 'db' | 'workspace'>
    const locking = {
      db,
      workspace: { isUnlocked: () => true, isLocking: () => true }
    } as unknown as Pick<AppContext, 'db' | 'workspace'>
    for (const ctx of [locked, locking]) {
      expect(healEngineLoadState(ctx, LINUX)).toEqual({ gpuFlagCleared: false, rowsRewritten: 0 })
    }
    expect(getSettings(db).gpuAutoDisabled).toBe(true)
    expect(rowMessage(db, id)).toBe(LEGACY_ROW)
  })

  it('never throws when the database itself is unusable', () => {
    const db = freshDb()
    db.close()
    expect(() => healEngineLoadState(unlockedCtx(db), LINUX)).not.toThrow()
  })

  it('rewrites failed rows holding the raw loader line, leaves others alone, and is idempotent', () => {
    const db = freshDb()
    const legacy = addDoc(db, 'failed', LEGACY_ROW)
    const otherFailed = addDoc(db, 'failed', 'This file could not be read.')
    const gpuFault = addDoc(db, 'failed', GENUINE_GPU_ERROR.split(' — ').slice(1).join(' — '))
    // Same raw text but NOT failed: only failed rows are ever rewritten.
    const notFailed = addDoc(db, 'indexed', LEGACY_ROW)

    const first = healEngineLoadState(unlockedCtx(db), LINUX)
    expect(first.rowsRewritten).toBe(1)
    const canonical = t('en', 'main.ingest.engineLibraryMissing', { library: 'libgomp.so.1' })
    expect(rowMessage(db, legacy)).toBe(canonical)
    expect(rowMessage(db, legacy)).not.toContain('/')
    expect(rowMessage(db, otherFailed)).toBe('This file could not be read.')
    expect(rowMessage(db, gpuFault)).toContain('ggml_vulkan')
    expect(rowMessage(db, notFailed)).toBe(LEGACY_ROW)

    const second = healEngineLoadState(unlockedCtx(db), LINUX)
    expect(second.rowsRewritten).toBe(0)
    expect(rowMessage(db, legacy)).toBe(canonical)
  })
})

describe('rewriteEngineFailureRows (#530)', () => {
  it('maps the Windows no-text shape (an NTSTATUS exit code only) to the generic canonical text', () => {
    const db = freshDb()
    const id = addDoc(db, 'failed', 'llama-server exited before becoming healthy (code 3221225781)')
    expect(rewriteEngineFailureRows(db, WIN)).toBe(1)
    expect(rowMessage(db, id)).toBe(t('en', 'main.ingest.engineCannotRun'))
  })
})

// ---- checkProgramLoads (fake spawn) ------------------------------------------------------

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 11
  killed = false
  stderr = new EventEmitter() as unknown as ChildProcessLike['stderr']
  kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true
    return true
  })
  unref(): void {
    /* a real child detaches; nothing to do */
  }
}

/** A spawn whose child runs `behavior` on the next microtask (never, when `behavior` is omitted). */
function fakeSpawn(behavior?: (child: FakeChild) => void): { spawn: SpawnFn; children: FakeChild[]; calls: string[][] } {
  const children: FakeChild[] = []
  const calls: string[][] = []
  const spawn: SpawnFn = (_cmd, args) => {
    calls.push(args)
    const child = new FakeChild()
    children.push(child)
    if (behavior) queueMicrotask(() => behavior(child))
    return child
  }
  return { spawn, children, calls }
}
const emitStderr = (child: FakeChild, text: string): void => {
  ;(child.stderr as unknown as EventEmitter).emit('data', Buffer.from(text))
}
const LOADER_STDERR =
  '/media/someone/HR/runtime/whisper.cpp/linux/whisper-cli: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

describe('checkProgramLoads (#530)', () => {
  const verified = async (): Promise<'verified'> => 'verified'

  it('exit 0 means the program loads', async () => {
    const { spawn, calls } = fakeSpawn((c) => c.emit('close', 0, null))
    const out = await checkProgramLoads('whisper_cpp', '/x/whisper-cli', ['--help'], { spawn, verify: verified, ...LINUX })
    expect(out).toBe('loads')
    expect(calls).toEqual([['--help']])
    expect(engineProblems()).toEqual([])
  })

  it('exit 127 with the loader line is refused and recorded as the family verdict', async () => {
    const { spawn } = fakeSpawn((c) => {
      emitStderr(c, LOADER_STDERR)
      c.emit('close', 127, null)
    })
    const out = await checkProgramLoads('whisper_cpp', '/x/whisper-cli', ['--help'], { spawn, verify: verified, ...LINUX })
    expect(out).toBe('refused')
    expect(engineProblemFor('whisper_cpp')).toEqual({
      family: 'whisper_cpp',
      reason: 'library-missing',
      os: 'linux',
      name: 'libgomp.so.1',
      exit: 'exit code 127'
    })
    expect(engineProblemFor('llama_cpp')).toBeNull()
  })

  it('a usage error (exit 1, no loader text) still counts as a program that ran', async () => {
    const { spawn } = fakeSpawn((c) => {
      emitStderr(c, 'error: invalid argument: --help\n')
      c.emit('close', 1, null)
    })
    const out = await checkProgramLoads('llama_cpp', '/x/llama-server', ['--version'], { spawn, verify: verified, ...LINUX })
    expect(out).toBe('loads')
    expect(engineProblems()).toEqual([])
  })

  it('a failed integrity check is unchecked and spawns nothing', async () => {
    const { spawn, calls } = fakeSpawn((c) => c.emit('close', 0, null))
    const out = await checkProgramLoads('llama_cpp', '/x/llama-server', ['--version'], {
      spawn,
      verify: async () => 'mismatch',
      ...LINUX
    })
    expect(out).toBe('unchecked')
    expect(calls).toEqual([])
  })

  it('a spawn that throws is unchecked', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn EACCES')
    }
    const out = await checkProgramLoads('llama_cpp', '/x/llama-server', ['--version'], { spawn, verify: verified, ...LINUX })
    expect(out).toBe('unchecked')
  })

  it('a child that never exits is killed at the bound and counts as loading', async () => {
    const { spawn, children } = fakeSpawn()
    const out = await checkProgramLoads('llama_cpp', '/x/llama-server', ['--version'], {
      spawn,
      verify: verified,
      timeoutMs: 20,
      ...LINUX
    })
    expect(out).toBe('loads')
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
  })
})

// ---- Ingestion: the row text a failed embed persists -------------------------------------

describe('ingestion row text for an engine the OS refused (#530)', () => {
  const failingEmbedder = (err: unknown): Embedder => ({
    id: 'fail-embedder',
    dimensions: 4,
    embed: async () => {
      throw err
    }
  })

  async function ingestWith(err: unknown): Promise<{ status: string; errorMessage: string | null }> {
    const db = freshDb()
    const root = tmp()
    const src = join(root, 'notes.txt')
    writeFileSync(src, 'some words to chunk and embed '.repeat(40))
    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, documentsDir(root), queued.id, { embedder: failingEmbedder(err) })
    const stored = rowMessage(db, queued.id)
    return { status: info.status, errorMessage: stored }
  }

  it('a chat-engine library problem persists the canonical text naming only the library file', async () => {
    const err = new EngineCannotRunError('llama-server', {
      family: 'llama_cpp',
      reason: 'library-missing',
      os: 'linux',
      name: 'libgomp.so.1',
      exit: 'exit code 127'
    })
    const out = await ingestWith(err)
    expect(out.status).toBe('failed')
    expect(out.errorMessage).toBe(t('en', 'main.ingest.engineLibraryMissing', { library: 'libgomp.so.1' }))
    expect(out.errorMessage).not.toContain('/')
  })

  it('any other engine reason persists the generic canonical text', async () => {
    const err = new EngineCannotRunError('llama-server', {
      family: 'llama_cpp',
      reason: 'files-damaged',
      os: 'win',
      exit: 'exit code 0xC0000135'
    })
    expect((await ingestWith(err)).errorMessage).toBe(t('en', 'main.ingest.engineCannotRun'))
  })

  it('a whisper-family problem maps to the voice engine text', async () => {
    const problem = {
      family: 'whisper_cpp' as const,
      reason: 'library-missing' as const,
      os: 'linux' as const,
      name: 'libgomp.so.1',
      exit: 'exit code 127'
    }
    expect(engineProblemRowMessage(problem)).toBe(t('en', 'main.ingest.voiceEngineCannotRun'))
    expect(failureRowMessage(new EngineCannotRunError('whisper-cli', problem))).toBe(
      t('en', 'main.ingest.voiceEngineCannotRun')
    )
  })

  it('any other error keeps its own message', async () => {
    const out = await ingestWith(new Error('embedding backend exploded'))
    expect(out.status).toBe('failed')
    expect(out.errorMessage).toBe('embedding backend exploded')
    expect(failureRowMessage('plain string')).toBe('plain string')
  })
})
