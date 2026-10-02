import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #530 "Check again" (`recheckEngines` / `rearmLlamaConsumers`) over a minimal fake AppContext.
// Electron is mocked only because the re-check's import graph reaches the model IPC registrar.
vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }
}))

import type { AppContext } from '../../src/main/services/context'
import type { EngineProblem } from '../../src/shared/types'
import { openDatabase, type Db } from '../../src/main/services/db'
import { rearmLlamaConsumers, recheckEngines } from '../../src/main/ipc/engine-recheck'
import {
  engineProblemFor,
  reportEngineProblem,
  resetEngineProblemsForTest
} from '../../src/main/services/runtime/engine-load'
import { clearModelLoadLatches, latchModelLoad, modelLoadLatchReason } from '../../src/main/services/runtime/factory'
import {
  llamaOsDir,
  llamaServerBinaryName,
  type ChildProcessLike,
  type SpawnFn
} from '../../src/main/services/runtime/sidecar'
import { whisperCliBinaryName } from '../../src/main/services/transcriber/cli'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'

const LLAMA_PROBLEM: EngineProblem = {
  family: 'llama_cpp',
  reason: 'library-missing',
  os: 'linux',
  name: 'libgomp.so.1',
  exit: 'exit code 127'
}
const WHISPER_PROBLEM: EngineProblem = { ...LLAMA_PROBLEM, family: 'whisper_cpp' }

const dirs: string[] = []
const dbs: Db[] = []

function driveRoot(opts: { llama?: boolean; whisper?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-recheck-'))
  dirs.push(root)
  const put = (family: string, bin: string): void => {
    const dir = join(root, 'runtime', family, llamaOsDir())
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, bin), '')
  }
  if (opts.llama !== false) put('llama.cpp', llamaServerBinaryName())
  if (opts.whisper) put('whisper.cpp', whisperCliBinaryName())
  return root
}

interface Fakes {
  ctx: AppContext
  probe: Mock & { invalidate: Mock }
  embedderReset: Mock
  rerankerReset: Mock
  visionReset: Mock
  refreshTranslatorSlot: Mock
  restartChat: Mock
}

/** `probeBehavior` runs inside the fake device probe (e.g. re-report the problem). `db` null = locked workspace. */
function makeCtx(root: string, probeBehavior: () => void, db: Db | null = null): Fakes {
  const probe = Object.assign(
    vi.fn(async () => {
      probeBehavior()
      return []
    }),
    { invalidate: vi.fn() }
  )
  const embedderReset = vi.fn()
  const rerankerReset = vi.fn()
  const visionReset = vi.fn()
  const refreshTranslatorSlot = vi.fn()
  const ctx = {
    paths: { rootPath: root },
    isDev: false,
    probeGpu: probe,
    embedder: { resetStartFailure: embedderReset },
    reranker: { resetStartFailure: rerankerReset },
    vision: { resetStartFailure: visionReset },
    refreshTranslatorSlot,
    runtime: { status: () => ({ backend: 'mock', modelId: 'm', running: true, healthy: true, port: null, message: '' }) },
    // Locked: probeAndPersistGpu and healEngineLoadState are admission-gated and skip entirely.
    workspace: { isUnlocked: () => db != null },
    db
  } as unknown as AppContext
  return { ctx, probe, embedderReset, rerankerReset, visionReset, refreshTranslatorSlot, restartChat: vi.fn(async () => undefined) }
}

/** A fake child that emits `stderr` (when given) then closes with `code` on the next microtask. */
function closingSpawn(code: number, stderr = ''): SpawnFn {
  return () => {
    const child = new EventEmitter() as EventEmitter & ChildProcessLike
    const err = new EventEmitter()
    Object.assign(child, { pid: 5, killed: false, stderr: err, kill: () => true, unref: () => undefined })
    queueMicrotask(() => {
      if (stderr) err.emit('data', Buffer.from(stderr))
      child.emit('close', code, null)
    })
    return child
  }
}
const verified = async (): Promise<'verified'> => 'verified'
const LOADER_STDERR =
  '/media/x/runtime/whisper.cpp/linux/whisper-cli: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

beforeEach(() => {
  // A developer's dev-only override would redirect the resolvers away from the temp drive.
  vi.stubEnv('HILBERTRAUM_LLAMA_BIN', '')
  vi.stubEnv('HILBERTRAUM_WHISPER_BIN', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetEngineProblemsForTest()
  clearModelLoadLatches()
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('recheckEngines — the chat engine (#530)', () => {
  // The chat engine is re-checked with an explicit `--version` spawn (review fix): the GPU probe
  // answers [] for a binary it could not even run, which would have read as "loads".
  const LLAMA_LOADER_STDERR =
    '/media/x/runtime/llama.cpp/linux/llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

  it('a program the OS still refuses keeps the verdict and re-arms nothing', async () => {
    reportEngineProblem(LLAMA_PROBLEM)
    latchModelLoad('m', 'unknown model architecture')
    const f = makeCtx(driveRoot(), () => undefined)
    const result = await recheckEngines(f.ctx, {
      restartChat: f.restartChat,
      spawn: closingSpawn(127, LLAMA_LOADER_STDERR),
      verify: verified,
      platform: 'linux'
    })
    expect(result.problems).toEqual([LLAMA_PROBLEM])
    expect(f.embedderReset).not.toHaveBeenCalled()
    expect(f.rerankerReset).not.toHaveBeenCalled()
    expect(f.visionReset).not.toHaveBeenCalled()
    expect(f.refreshTranslatorSlot).not.toHaveBeenCalled()
    expect(f.restartChat).not.toHaveBeenCalled()
    expect(modelLoadLatchReason('m')).not.toBeNull()
  })

  it('a program the OS now starts loses the verdict and every consumer is re-armed', async () => {
    reportEngineProblem(LLAMA_PROBLEM)
    latchModelLoad('m', 'unknown model architecture')
    const f = makeCtx(driveRoot(), () => undefined)
    const result = await recheckEngines(f.ctx, { restartChat: f.restartChat, spawn: closingSpawn(0), verify: verified })
    expect(result.problems).toEqual([])
    expect(engineProblemFor('llama_cpp')).toBeNull()
    expect(f.embedderReset).toHaveBeenCalledTimes(1)
    expect(f.rerankerReset).toHaveBeenCalledTimes(1)
    expect(f.visionReset).toHaveBeenCalledTimes(1)
    expect(f.refreshTranslatorSlot).toHaveBeenCalledTimes(1)
    expect(f.restartChat).toHaveBeenCalledTimes(1)
    expect(modelLoadLatchReason('m')).toBeNull()
  })

  it('a binary that could not even be checked (integrity mismatch) keeps the verdict — never "runs again"', async () => {
    reportEngineProblem(LLAMA_PROBLEM)
    const f = makeCtx(driveRoot(), () => undefined)
    const spawn = vi.fn(closingSpawn(0))
    const result = await recheckEngines(f.ctx, { restartChat: f.restartChat, spawn, verify: async () => 'mismatch' })
    expect(spawn).not.toHaveBeenCalled()
    expect(result.problems).toEqual([LLAMA_PROBLEM])
    expect(f.restartChat).not.toHaveBeenCalled()
  })

  it('a Windows spawn refusal (EPERM — policy / security software) is still a refusal', async () => {
    reportEngineProblem(LLAMA_PROBLEM)
    const f = makeCtx(driveRoot(), () => undefined)
    const spawn: SpawnFn = () => {
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
    }
    const result = await recheckEngines(f.ctx, { restartChat: f.restartChat, spawn, verify: verified, platform: 'win32' })
    expect(result.problems).toEqual([{ family: 'llama_cpp', reason: 'blocked', os: 'win', exit: 'spawn error EPERM' }])
    expect(f.restartChat).not.toHaveBeenCalled()
  })

  it('two clicks share one pass (single flight): one spawn, one restart', async () => {
    reportEngineProblem(LLAMA_PROBLEM)
    const f = makeCtx(driveRoot(), () => undefined)
    const spawn = vi.fn(closingSpawn(0))
    const deps = { restartChat: f.restartChat, spawn, verify: verified }
    const [a, b] = await Promise.all([recheckEngines(f.ctx, deps), recheckEngines(f.ctx, deps)])
    expect(a).toBe(b)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(f.restartChat).toHaveBeenCalledTimes(1)
  })

  it('with an unlocked workspace the heal runs too: the loader-caused flag clears, the probe is refreshed (#530)', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-recheck-db-')), 'test.sqlite'))
    seedSettings(db)
    dbs.push(db)
    updateSettings(db, {
      gpuAutoDisabled: true,
      gpuLastError:
        '2026-09-30T10:00:00.000Z — llama-server exited before becoming healthy (code 127) — last output: /m/llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory'
    })
    reportEngineProblem(LLAMA_PROBLEM)
    const f = makeCtx(driveRoot(), () => undefined, db)
    await recheckEngines(f.ctx, { restartChat: f.restartChat, spawn: closingSpawn(0), verify: verified, platform: 'linux' })
    const s = getSettings(db)
    expect(s.gpuAutoDisabled).toBe(false)
    expect(s.gpuLastError).toBeNull()
    expect(f.probe.invalidate).toHaveBeenCalledTimes(1)
    expect(f.probe).toHaveBeenCalledTimes(1)
    expect(f.restartChat).toHaveBeenCalledTimes(1)
  })

  it('an absent chat-engine binary clears the verdict (the missing-engine banner takes over)', async () => {
    reportEngineProblem(LLAMA_PROBLEM)
    const f = makeCtx(driveRoot({ llama: false }), () => undefined)
    const result = await recheckEngines(f.ctx, { restartChat: f.restartChat })
    expect(result.problems).toEqual([])
    expect(f.probe).not.toHaveBeenCalled()
    // Gone is not healed: nothing is re-armed and no restart is attempted on a missing engine.
    expect(f.embedderReset).not.toHaveBeenCalled()
    expect(f.restartChat).not.toHaveBeenCalled()
  })

  it('does nothing when no engine has a verdict', async () => {
    const f = makeCtx(driveRoot(), () => undefined)
    const result = await recheckEngines(f.ctx, { restartChat: f.restartChat })
    expect(result).toEqual({ problems: [] })
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.restartChat).not.toHaveBeenCalled()
  })
})

describe('recheckEngines — the voice engine (#530)', () => {
  it('a voice engine the OS now starts loses its verdict; the chat consumers are not re-armed', async () => {
    reportEngineProblem(WHISPER_PROBLEM)
    const f = makeCtx(driveRoot({ whisper: true }), () => undefined)
    const result = await recheckEngines(f.ctx, {
      restartChat: f.restartChat,
      spawn: closingSpawn(0),
      verify: verified,
      platform: 'linux'
    })
    expect(result.problems).toEqual([])
    expect(f.embedderReset).not.toHaveBeenCalled()
    expect(f.restartChat).not.toHaveBeenCalled()
  })

  it('a voice engine the OS still refuses keeps its verdict', async () => {
    reportEngineProblem(WHISPER_PROBLEM)
    const f = makeCtx(driveRoot({ whisper: true }), () => undefined)
    const result = await recheckEngines(f.ctx, {
      restartChat: f.restartChat,
      spawn: closingSpawn(127, LOADER_STDERR),
      verify: verified,
      platform: 'linux'
    })
    expect(result.problems).toEqual([WHISPER_PROBLEM])
    expect(engineProblemFor('whisper_cpp')).toEqual(WHISPER_PROBLEM)
  })

  it('an absent voice binary clears the verdict', async () => {
    reportEngineProblem(WHISPER_PROBLEM)
    const f = makeCtx(driveRoot(), () => undefined)
    const result = await recheckEngines(f.ctx, { restartChat: f.restartChat, verify: verified })
    expect(result.problems).toEqual([])
  })
})

describe('rearmLlamaConsumers (#530)', () => {
  it('re-arms the model latches and every consumer, tolerating missing optional ones', () => {
    latchModelLoad('m', 'unknown model architecture')
    const f = makeCtx(driveRoot(), () => undefined)
    rearmLlamaConsumers(f.ctx)
    expect(modelLoadLatchReason('m')).toBeNull()
    expect(f.embedderReset).toHaveBeenCalledTimes(1)
    expect(f.rerankerReset).toHaveBeenCalledTimes(1)
    expect(f.visionReset).toHaveBeenCalledTimes(1)
    expect(f.refreshTranslatorSlot).toHaveBeenCalledTimes(1)

    const bare = { embedder: {}, reranker: undefined, vision: undefined } as unknown as AppContext
    expect(() => rearmLlamaConsumers(bare)).not.toThrow()
  })
})
