import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #530 — the session side of "an engine the OS loader refuses to start": the startup check,
// healing what the app wrote before the fix (gpuAutoDisabled + failed document rows), the
// `checkProgramLoads` probe, and how an ingestion failure persists the canonical path-free row
// text. #634 — the same for a search-model failure: the row text by kind, and the heal of rows
// written before it.

import { t, type MessageKey } from '../../src/shared/i18n'
import type { AppContext } from '../../src/main/services/context'
import { openDatabase, type Db } from '../../src/main/services/db'
import { checkProgramLoads, healEngineLoadState, startEngineCheck } from '../../src/main/services/engine-health'
import {
  EngineCannotRunError,
  engineProblemFor,
  engineProblems,
  resetEngineProblemsForTest
} from '../../src/main/services/runtime/engine-load'
import { failureRowMessage, rewriteEngineFailureRows } from '../../src/main/services/ingestion/engine-failure'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import type { Embedder } from '../../src/main/services/embeddings'
import { E5Embedder } from '../../src/main/services/embeddings/e5'
import { EmbedderError } from '../../src/main/services/embeddings/errors'
import {
  llamaServerBinaryName,
  llamaServerDir,
  type ChildProcessLike,
  type SpawnFn
} from '../../src/main/services/runtime/sidecar'
import { holdEngineSpawns } from '../../src/main/services/runtime/spawn-gate'
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

describe('startEngineCheck (#530, #656)', () => {
  it('starts the session device probe on the drive’s chat engine with no workspace open; nothing to probe, nothing started; a failing probe never escapes', async () => {
    // A plain function, not `vi.fn`: a spy attaches its own handler to the promise it returns, which
    // would hide the unhandled rejection this row exists to catch.
    const probed: string[] = []
    const probeGpu = Object.assign(
      async (bin: string): Promise<null> => {
        probed.push(bin)
        throw new Error('driver wedged')
      },
      { invalidate: () => undefined }
    )
    const check = (rootPath: string): void =>
      startEngineCheck({ paths: { rootPath }, isDev: false, probeGpu } as unknown as AppContext)

    // No chat engine for this OS on the drive: no probe (it would spawn nothing useful).
    check(tmp())
    expect(probed).toEqual([])

    const root = tmp()
    mkdirSync(llamaServerDir(root), { recursive: true })
    const bin = join(llamaServerDir(root), llamaServerBinaryName())
    writeFileSync(bin, '')
    expect(() => check(root)).not.toThrow()
    expect(probed).toEqual([bin])
    // Fire-and-forget: the rejection is swallowed inside the check (vitest fails a run on an unhandled one).
    await new Promise((r) => setImmediate(r))
  })
})

describe('healEngineLoadState (#530)', () => {
  it.each<{ shape: string; gpuLastError: string | null; opts: typeof LINUX | typeof WIN; cleared: boolean }>([
    // ISO-prefixed, as index.ts stores it.
    { shape: 'the Linux loader line', gpuLastError: LEGACY_GPU_ERROR, opts: LINUX, cleared: true },
    {
      // An NTSTATUS exit code only.
      shape: 'the Windows no-text shape',
      gpuLastError: '2026-09-30T10:00:00.000Z — llama-server exited before becoming healthy (code 3221225781)',
      opts: WIN,
      cleared: true
    },
    { shape: 'a genuine GPU fault', gpuLastError: GENUINE_GPU_ERROR, opts: LINUX, cleared: false },
    // A renderer patch can set the flag alone; no text is no evidence — and must not break the row heal.
    { shape: 'missing (no stored error)', gpuLastError: null, opts: LINUX, cleared: false }
  ])('a compatibility-mode flag whose stored error is $shape: cleared $cleared, and the row heal still runs', ({ gpuLastError, opts, cleared }) => {
    const db = freshDb()
    updateSettings(db, { gpuAutoDisabled: true, gpuLastError })
    addDoc(db, 'failed', LEGACY_ROW)
    const result = healEngineLoadState(unlockedCtx(db), opts)
    expect(result.gpuFlagCleared).toBe(cleared)
    const s = getSettings(db)
    expect(s.gpuAutoDisabled).toBe(!cleared)
    expect(s.gpuLastError).toBe(cleared ? null : gpuLastError)
    expect(result.rowsRewritten).toBe(1)
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
      expect(healEngineLoadState(ctx, LINUX)).toEqual({ gpuFlagCleared: false, rowsRewritten: 0, searchModelRowsRewritten: 0 })
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
    // Not a load refusal, so #530 leaves it — and #634's pass rewrites it: on a document row the
    // only llama-server is the search model's, so this is its start failure.
    expect(first.searchModelRowsRewritten).toBe(1)
    expect(rowMessage(db, gpuFault)).toBe(t('en', 'main.ingest.searchModelCannotStart'))
    expect(rowMessage(db, notFailed)).toBe(LEGACY_ROW)

    const second = healEngineLoadState(unlockedCtx(db), LINUX)
    expect(second.rowsRewritten).toBe(0)
    expect(second.searchModelRowsRewritten).toBe(0)
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
function fakeSpawn(behavior?: (child: FakeChild) => void): {
  spawn: SpawnFn
  children: FakeChild[]
  options: SpawnOptions[]
} {
  const children: FakeChild[] = []
  const options: SpawnOptions[] = []
  const spawn: SpawnFn = (_command, _args, spawnOptions) => {
    const child = new FakeChild()
    children.push(child)
    options.push(spawnOptions)
    if (behavior) queueMicrotask(() => behavior(child))
    return child
  }
  return { spawn, children, options }
}
const emitStderr = (child: FakeChild, text: string): void => {
  ;(child.stderr as unknown as EventEmitter).emit('data', Buffer.from(text))
}
const LOADER_STDERR =
  '/media/someone/HR/runtime/whisper.cpp/linux/whisper-cli: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

describe('checkProgramLoads (#530)', () => {
  const verified = async (): Promise<'verified'> => 'verified'

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

  // #730: llama-server applies the host's llama.cpp variables and config files even for `--version`.
  it('starts llama-server without the host’s llama.cpp variables and config files (#730)', async () => {
    const configVar = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME'
    vi.stubEnv('LLAMA_ARG_RPC', 'host:50052')
    vi.stubEnv(configVar, '/host/config')
    try {
      const { spawn, options } = fakeSpawn((c) => c.emit('close', 0, null))
      await checkProgramLoads('llama_cpp', '/x/llama-server', ['--version'], { spawn, verify: verified, ...LINUX })
      const childEnv = options[0].env ?? process.env // what Node hands the child
      expect(childEnv.LLAMA_ARG_RPC).toBeUndefined()
      expect(childEnv[configVar]).not.toBe('/host/config')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // #516 (architecture.md "In-app engine updates" §3): "Check again" never launches a program an
  // install of ITS family is replacing; LlamaServer (sidecar.test.ts) and the GPU probe (gpu.test.ts)
  // wait the same way.
  it('waits for an install of its family to finish the swap before it launches (#516 spawn gate)', async () => {
    const { spawn, children } = fakeSpawn((c) => c.emit('close', 0, null))
    const release = holdEngineSpawns('whisper_cpp')
    const checking = checkProgramLoads('whisper_cpp', '/x/whisper-cli', ['--help'], { spawn, verify: verified, ...LINUX })
    try {
      // One macrotask: every microtask the check could chain (verify, spawn) has run.
      await new Promise((r) => setImmediate(r))
      expect(children).toHaveLength(0) // held: nothing launched mid-swap
    } finally {
      release()
    }
    expect(await checking).toBe('loads')
    expect(children).toHaveLength(1)
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

const failingEmbedder = (err: unknown): Embedder => ({
  id: 'fail-embedder',
  dimensions: 4,
  embed: async () => {
    throw err
  }
})

/** Import one small text file through the real pipeline with `embedder`; the row as stored. */
async function ingestThrough(
  embedder: Embedder,
  db: Db = freshDb()
): Promise<{ status: string; errorMessage: string | null }> {
  const root = tmp()
  const src = join(root, 'notes.txt')
  writeFileSync(src, 'some words to chunk and embed '.repeat(40))
  const queued = createQueuedDocument(db, src)
  const info = await processDocument(db, documentsDir(root), queued.id, { embedder })
  return { status: info.status, errorMessage: rowMessage(db, queued.id) }
}

const ingestWith = (err: unknown): Promise<{ status: string; errorMessage: string | null }> =>
  ingestThrough(failingEmbedder(err))

describe('ingestion row text for an engine the OS refused (#530)', () => {
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
    // Dormant in production today (parsers/audio.ts wraps a whisper refusal first); guarded at the boundary that persists it.
    const err = new EngineCannotRunError('whisper-cli', {
      family: 'whisper_cpp',
      reason: 'library-missing',
      os: 'linux',
      name: 'libgomp.so.1',
      exit: 'exit code 127'
    })
    expect(await ingestWith(err)).toEqual({ status: 'failed', errorMessage: t('en', 'main.ingest.voiceEngineCannotRun') })
  })

  it('any other error keeps its own message', async () => {
    const out = await ingestWith(new Error('embedding backend exploded'))
    expect(out.status).toBe('failed')
    expect(out.errorMessage).toBe('embedding backend exploded')
    expect(failureRowMessage('plain string')).toBe('plain string')
  })
})

// ---- #634: the search model's failures -----------------------------------------------------

describe('ingestion row text for a search-model failure (#634)', () => {
  // The real embedder, its sidecar failing to load a damaged weight file (the real b9849 lines).
  // Before #634 the row stored llama-server's stderr tail, which names that file by absolute path —
  // on every document of the session, because the embedder latches its failed start.
  it('a search model that cannot start stores the canonical text on every row, never the weight path', async () => {
    const weightPath = join(tmp(), 'models', 'embeddings', 'multilingual-e5-small-q8.gguf')
    const { spawn, children } = fakeSpawn((child) => {
      ;(child.stderr as unknown as EventEmitter).emit(
        'data',
        `0.00.333.627 E cmn  common_init_: failed to load model '${weightPath}'\n` +
          '0.00.334.509 E srv  llama_server: exiting due to model loading error\n'
      )
      child.emit('exit', 1, null)
      child.emit('close', 1, null)
    })
    const embedder = new E5Embedder({
      id: 'multilingual-e5-small-q8',
      binPath: '/bin/llama-server',
      modelPath: weightPath,
      findPort: async () => 52000,
      healthIntervalMs: 1,
      spawn,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    })
    const db = freshDb()
    for (let i = 0; i < 2; i++) {
      expect(await ingestThrough(embedder, db)).toEqual({
        status: 'failed',
        errorMessage: t('en', 'main.ingest.searchModelCannotStart')
      })
    }
    expect(children.length).toBe(1) // the second document met the latched failure
    await embedder.stop()
  })

  it.each([
    { kind: 'timeout', key: 'main.ingest.searchModelTimeout' },
    { kind: 'start', key: 'main.ingest.searchModelCannotStart' },
    { kind: 'failed', key: 'main.ingest.searchModelFailed' },
    // A lock or quit cut the embed off: the existing "interrupted" text, which offers a re-index.
    { kind: 'interrupted', key: 'main.ingest.interrupted' }
  ] as const)('a $kind failure stores $key', async ({ kind, key }) => {
    const out = await ingestWith(new EmbedderError(kind, 'Embedding request failed: raw detail'))
    expect(out).toEqual({ status: 'failed', errorMessage: t('en', key) })
  })
})

describe('the session-start heal rewrites rows a search-model failure wrote before #634', () => {
  it('rewrites the raw search-model failures, leaves every other row alone, and is idempotent', () => {
    const db = freshDb()
    const legacy: Array<[string, MessageKey]> = [
      ['The operation timed out.', 'main.ingest.searchModelTimeout'],
      // undici's word for a body cut off (before #607 also its own 305 s limit).
      ['terminated', 'main.ingest.searchModelFailed'],
      [
        "llama-server exited before becoming healthy (code 1) — last output: 0.00.333.627 E cmn  common_init_: failed to load model '/media/someone/HR/models/embeddings/multilingual-e5-small-q8.gguf'",
        'main.ingest.searchModelCannotStart'
      ],
      ['Embedding request failed: HTTP 500 — slot unavailable', 'main.ingest.searchModelFailed'],
      // A bind race was transient: a retry fixes it, so not the "check the model files" text.
      [
        'llama-server exited before becoming healthy (code 1) — last output: error: bind: address already in use',
        'main.ingest.searchModelFailed'
      ],
      ['Embedder is suspending (workspace is locking)', 'main.ingest.interrupted']
    ]
    const ids = legacy.map(([message]) => addDoc(db, 'failed', message))
    const loaderRefusal = addDoc(db, 'failed', LEGACY_ROW) // #530's text, not the search model's
    const other = addDoc(db, 'failed', 'This file could not be read.')
    const notFailed = addDoc(db, 'indexed', 'The operation timed out.')

    const first = healEngineLoadState(unlockedCtx(db), LINUX)
    expect(first.searchModelRowsRewritten).toBe(legacy.length)
    legacy.forEach(([, key], i) => expect(rowMessage(db, ids[i]!)).toBe(t('en', key)))
    expect(rowMessage(db, loaderRefusal)).toBe(t('en', 'main.ingest.engineLibraryMissing', { library: 'libgomp.so.1' }))
    expect(rowMessage(db, other)).toBe('This file could not be read.')
    expect(rowMessage(db, notFailed)).toBe('The operation timed out.')

    expect(healEngineLoadState(unlockedCtx(db), LINUX).searchModelRowsRewritten).toBe(0)
  })
})
