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
  llamaOsDir,
  llamaServerBinaryName,
  llamaServerDir,
  type ChildProcessLike,
  type SpawnFn
} from '../../src/main/services/runtime/sidecar'
import { holdEngineSpawns } from '../../src/main/services/runtime/spawn-gate'
import { runtimeMarkerPath, writeRuntimeMarker } from '../../src/main/services/assets'
import { log } from '../../src/main/services/logging'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import type { RuntimeOs } from '../../src/shared/runtime-sources'
import { rawSetting } from '../helpers/db-fixtures'
import { workspaceStandIn } from '../helpers/workspace-stand-in'

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

/** What the session-start heal reads: the workspace, and (W-70) the drive whose engine build it compares. */
type HealCtx = Pick<AppContext, 'db' | 'workspace' | 'paths' | 'isDev'>
const unlockedCtx = (db: Db, rootPath: string = tmp(), isDev = false): HealCtx =>
  ({ db, workspace: workspaceStandIn(), paths: { rootPath }, isDev }) as unknown as HealCtx

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
    const locked = { db, workspace: workspaceStandIn({ unlocked: false }) } as unknown as HealCtx
    const locking = {
      db,
      workspace: workspaceStandIn({ locking: true })
    } as unknown as HealCtx
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

// W-70 (app-update plan, T3.11): `gpuAutoDisabled` carries the engine build it was set under (`gpuAutoDisabledEngine`),
// and the session-start heal tries the card again once the drive's own engine is another build. Release 1 is the only
// version that runs after a "Go back", so this table is its rule for life: another version OR backend (exact text, no
// order) re-arms; the same build, an unknown or missing engine, and a flag with no stamp it can read stay on the processor.
describe('healEngineLoadState: a GPU flag set under another engine build is tried again (W-70)', () => {
  const STAMPED = { version: 'b9849', backend: 'vulkan' }
  // A genuine GPU fault: #530's clear leaves it, so only the W-70 rule can move the flag.
  const GPU_FAULT = '2026-11-25T10:00:00.000Z — vk::Queue::submit: ErrorDeviceLost'

  /** The chat engine in the drive's `runtime/llama.cpp/<os>/`: the program (unless `program: false`) and its marker. */
  function engine(
    root: string,
    opts: { program?: boolean; marker: { version: string; backend: string } | 'cut-short' | null }
  ): void {
    const dir = llamaServerDir(root)
    mkdirSync(dir, { recursive: true })
    if (opts.program !== false) writeFileSync(join(dir, llamaServerBinaryName()), 'fake-binary')
    const whole = (build: { version: string; backend: string }): string =>
      JSON.stringify({ ...build, os: llamaOsDir() as RuntimeOs, arch: 'x64' })
    // An interrupted copy's marker of ANOTHER build: a reader that took it for a build would re-arm.
    if (opts.marker === 'cut-short') writeFileSync(runtimeMarkerPath(dir), whole({ version: 'b12110', backend: 'vulkan' }).slice(0, 24))
    else if (opts.marker) writeRuntimeMarker(dir, { ...opts.marker, os: llamaOsDir() as RuntimeOs, arch: 'x64' })
  }

  /** A workspace a GPU failure flagged, its stamp row planted as stored text (`undefined`: no row, as before release 1). */
  function flagged(stampText: string | undefined): Db {
    const db = freshDb()
    updateSettings(db, { gpuAutoDisabled: true, gpuLastError: GPU_FAULT })
    db.prepare("DELETE FROM settings WHERE key = 'gpuAutoDisabledEngine'").run()
    if (stampText !== undefined) {
      db.prepare(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('gpuAutoDisabledEngine', ?, '2026-11-25T10:00:00.000Z')"
      ).run(stampText)
    }
    return db
  }
  const stampRow = (db: Db): string | undefined =>
    (db.prepare("SELECT value_json AS v FROM settings WHERE key = 'gpuAutoDisabledEngine'").get() as { v: string } | undefined)?.v

  it.each<{ own: string; arrange: (root: string) => void; rearmed: boolean }>([
    { own: 'the same build', arrange: (r) => engine(r, { marker: STAMPED }), rearmed: false },
    { own: 'another version', arrange: (r) => engine(r, { marker: { ...STAMPED, version: 'b12110' } }), rearmed: true },
    // "Go back": the flag was set under the newer version's engine, release 1 runs its own older one.
    { own: 'an older version', arrange: (r) => engine(r, { marker: { ...STAMPED, version: 'b8000' } }), rearmed: true },
    { own: 'another backend', arrange: (r) => engine(r, { marker: { ...STAMPED, backend: 'cuda' } }), rearmed: true },
    // Owner, 2026-11-25 (review R1-1): "the Mac gets its GPU back". The same version built for the Mac (Metal) is another
    // build, so a Kit flagged on a Windows or Linux computer (Vulkan) gets a new try on a Mac. A known limit, kept: back on
    // that computer the flag is gone, and its card fails one GPU start again (a per-computer flag is the real fix).
    { own: 'the same version built for the Mac (Metal)', arrange: (r) => engine(r, { marker: { ...STAMPED, backend: 'metal' } }), rearmed: true },
    // Inequality, not F-24's order: a tag shape release 1 cannot order is simply another build.
    { own: 'a tag shape release 1 cannot order', arrange: (r) => engine(r, { marker: { ...STAMPED, version: 'b9849-rc1' } }), rearmed: true },
    { own: 'unknown (a program without an install marker)', arrange: (r) => engine(r, { marker: null }), rearmed: false },
    { own: 'unknown (a marker cut short)', arrange: (r) => engine(r, { marker: 'cut-short' }), rearmed: false },
    { own: 'missing (no engine folder)', arrange: () => undefined, rearmed: false },
    {
      own: 'missing (a marker of another build, but no program)',
      arrange: (r) => engine(r, { program: false, marker: { ...STAMPED, version: 'b12110' } }),
      rearmed: false
    }
  ])('a flag stamped b9849/vulkan, the drive’s own engine $own: re-armed $rearmed, and the row heal still runs', ({ arrange, rearmed }) => {
    const db = flagged(JSON.stringify(STAMPED))
    addDoc(db, 'failed', LEGACY_ROW)
    const root = tmp()
    arrange(root)

    const result = healEngineLoadState(unlockedCtx(db, root), LINUX)

    const s = getSettings(db)
    expect(s.gpuAutoDisabled).toBe(!rearmed)
    expect(s.gpuLastError).toBe(rearmed ? null : GPU_FAULT)
    expect(rawSetting(db, 'gpuAutoDisabledEngine')).toEqual(rearmed ? null : STAMPED)
    expect(result.rowsRewritten).toBe(1)
  })

  it('a dev build running HILBERTRAUM_LLAMA_BIN runs a program outside the folder: build unknown, the flag stays (a packaged build ignores the override)', () => {
    const outside = join(tmp(), llamaServerBinaryName())
    writeFileSync(outside, 'fake-binary')
    const root = tmp()
    engine(root, { marker: { ...STAMPED, version: 'b12110' } })
    vi.stubEnv('HILBERTRAUM_LLAMA_BIN', outside)
    try {
      const dev = flagged(JSON.stringify(STAMPED))
      healEngineLoadState(unlockedCtx(dev, root, true), LINUX)
      expect(getSettings(dev).gpuAutoDisabled).toBe(true)
      expect(stampRow(dev)).toBe(JSON.stringify(STAMPED))

      // The control: the same drive in a packaged build runs the folder's program, which is another build.
      const packaged = flagged(JSON.stringify(STAMPED))
      healEngineLoadState(unlockedCtx(packaged, root, false), LINUX)
      expect(getSettings(packaged).gpuAutoDisabled).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each<[string, string | undefined]>([
    ['no stamp row (every workspace flagged before release 1)', undefined],
    ['a null stamp (set while the build was unknown)', 'null'],
    ['a string', '"b9849"'],
    ['an array', '["b9849","vulkan"]'],
    ['an object without a backend', '{"version":"b9849"}'],
    ['a version that is no string', '{"version":9849,"backend":"vulkan"}'],
    ['an empty version', '{"version":"","backend":"vulkan"}'],
    ['a tag past 128 characters', JSON.stringify({ version: 'b'.repeat(129), backend: 'vulkan' })],
    ['text that is no JSON', '{"version":"b98']
  ])('a flag with %s stays on the processor and its row is kept, whatever build the drive runs', (_label, stampText) => {
    // Owner, 2026-11-25: "keep them on the processor". Release 1 never guesses a build it did not record.
    const db = flagged(stampText)
    const root = tmp()
    engine(root, { marker: { version: 'b12110', backend: 'cuda' } })

    healEngineLoadState(unlockedCtx(db, root), LINUX)

    expect(getSettings(db).gpuAutoDisabled).toBe(true)
    expect(getSettings(db).gpuLastError).toBe(GPU_FAULT)
    expect(stampRow(db)).toBe(stampText)
  })

  it('a flag that is off leaves its stamp alone, whatever build the drive runs', () => {
    const db = freshDb()
    db.prepare("DELETE FROM settings WHERE key = 'gpuAutoDisabledEngine'").run()
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('gpuAutoDisabledEngine', ?, '2026-11-25T10:00:00.000Z')"
    ).run(JSON.stringify(STAMPED))
    const root = tmp()
    engine(root, { marker: { ...STAMPED, version: 'b12110' } })

    healEngineLoadState(unlockedCtx(db, root), LINUX)

    expect(getSettings(db).gpuAutoDisabled).toBe(false)
    expect(stampRow(db)).toBe(JSON.stringify(STAMPED))
  })

  it('the #530 clear of a flag a load refusal set clears its stamp too', () => {
    const db = freshDb()
    updateSettings(db, { gpuAutoDisabledEngine: STAMPED, gpuAutoDisabled: true, gpuLastError: LEGACY_GPU_ERROR })
    const root = tmp()
    engine(root, { marker: STAMPED }) // the same build: the W-70 rule alone would keep the flag

    expect(healEngineLoadState(unlockedCtx(db, root), LINUX).gpuFlagCleared).toBe(true)

    expect(getSettings(db).gpuAutoDisabled).toBe(false)
    expect(rawSetting(db, 'gpuAutoDisabledEngine')).toBeNull()
  })

  // Review R1-2: the store writes a patch key by key with no transaction, so the order is what a write cut short leaves
  // (the drive pulled, the app killed). A clear writes the flag first and its stamp last: cut short anywhere, it leaves at
  // worst a stamp beside a false flag, which nothing reads. Stamp first left a set flag with no stamp, which never re-arms.
  it.each<{ clear: string; arrange: () => { db: Db; root: string }; error: string }>([
    {
      clear: 'the re-arm under another build',
      arrange: () => {
        const db = flagged(JSON.stringify(STAMPED))
        const root = tmp()
        engine(root, { marker: { ...STAMPED, version: 'b12110' } })
        return { db, root }
      },
      error: GPU_FAULT
    },
    {
      clear: 'the #530 clear of a load refusal',
      arrange: () => {
        const db = freshDb()
        updateSettings(db, { gpuAutoDisabledEngine: STAMPED, gpuAutoDisabled: true, gpuLastError: LEGACY_GPU_ERROR })
        const root = tmp()
        engine(root, { marker: STAMPED })
        return { db, root }
      },
      error: LEGACY_GPU_ERROR
    }
  ])('$clear, cut short after any of its writes, never leaves the flag set without its stamp', ({ arrange, error }) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      for (const [writes, left] of [
        [1, { gpuAutoDisabled: false, gpuLastError: error, gpuAutoDisabledEngine: STAMPED }],
        [2, { gpuAutoDisabled: false, gpuLastError: null, gpuAutoDisabledEngine: STAMPED }]
      ] as const) {
        const { db, root } = arrange()
        cutGpuRowsShortAfter(db, writes)

        expect(() => healEngineLoadState(unlockedCtx(db, root), LINUX)).not.toThrow()

        expect(gpuRows(db), `cut short after ${writes} write(s)`).toEqual(left)
      }
    } finally {
      warn.mockRestore()
    }
  })
})

/** The three settings rows a GPU flag's set and clears write, as stored. */
function gpuRows(db: Db): Record<string, unknown> {
  return Object.fromEntries(
    ['gpuAutoDisabled', 'gpuLastError', 'gpuAutoDisabledEngine'].map((key) => [key, rawSetting(db, key)])
  )
}

/**
 * A write cut short (R1-2): the next `writes` updates of the three GPU rows land, every later one fails as a pulled drive
 * would. All three rows exist (seeded), so each write of a patch is one UPDATE (the store's upsert of an existing key).
 */
function cutGpuRowsShortAfter(db: Db, writes: number): void {
  for (const row of Object.values(gpuRows(db))) expect(row).not.toBeUndefined()
  db.exec(`
    CREATE TABLE cut_budget (n INTEGER NOT NULL);
    INSERT INTO cut_budget (n) VALUES (${writes});
    CREATE TRIGGER cut_gpu_rows_short BEFORE UPDATE ON settings
    WHEN OLD.key IN ('gpuAutoDisabled', 'gpuLastError', 'gpuAutoDisabledEngine')
    BEGIN
      SELECT RAISE(ABORT, 'drive pulled') WHERE (SELECT n FROM cut_budget) <= 0;
      UPDATE cut_budget SET n = n - 1;
    END;
  `)
}

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
  pid: number | undefined = 11
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
  const verified = async (): Promise<'ok'> => 'ok' // the real verifier's pass verdict

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

  // #790 (review): stderr is what a non-zero exit is read from. Cut short, the loader's line may never
  // have arrived (here: none did), so the same exit cannot say "loads", which would clear a verdict.
  it('an unrecognised exit after the stderr stream failed is unchecked, not loads (#790)', async () => {
    const { spawn } = fakeSpawn((c) => {
      ;(c.stderr as unknown as EventEmitter).emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      c.emit('close', 127, null)
    })
    const out = await checkProgramLoads('llama_cpp', '/x/llama-server', ['--version'], { spawn, verify: verified, ...LINUX })
    expect(out).toBe('unchecked')
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

  // #790, the order measured on Windows: a spawn that fails before its pipes are open emits the
  // child's ENOENT, then ENOTCONN on the piped stderr stream, then 'close'; the child had no PID.
  // Unhandled, the stream's error is an uncaught exception: a main-process crash.
  it('absorbs an error on the stderr stream of a failed spawn; the check is unchecked (#790)', async () => {
    const thrown: unknown[] = []
    const { spawn } = fakeSpawn((child) => {
      child.pid = undefined
      child.emit('error', Object.assign(new Error('spawn C:\\Kit\\llama-server.exe ENOENT'), { code: 'ENOENT' }))
      try {
        ;(child.stderr as unknown as EventEmitter).emit('error', Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN' }))
      } catch (e) {
        thrown.push(e)
      }
      child.emit('close', -4058, null)
    })
    const out = await checkProgramLoads('llama_cpp', 'C:\\Kit\\llama-server.exe', ['--version'], { spawn, verify: verified, ...WIN })
    expect(out).toBe('unchecked')
    expect(thrown).toEqual([])
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

  // T2.12 (F-26): a newer version may store a failure as the code `hr:<key>`. This version's session-start heal only
  // ever rewrites text it wrote itself, so a coded row (one it knows, one with a parameter, one it does not) stays
  // byte for byte as the newer version left it.
  it('leaves a failed row stored as a code exactly as it is', () => {
    const db = freshDb()
    const codes = [
      'hr:main.ingest.searchModelFailed',
      'hr:main.ingest.engineLibraryMissing?library=libgomp.so.1',
      'hr:main.ingest.someFutureFailure'
    ]
    const ids = codes.map((code) => addDoc(db, 'failed', code))
    expect(healEngineLoadState(unlockedCtx(db), LINUX)).toMatchObject({ rowsRewritten: 0, searchModelRowsRewritten: 0 })
    expect(ids.map((id) => rowMessage(db, id))).toEqual(codes)
  })
})
