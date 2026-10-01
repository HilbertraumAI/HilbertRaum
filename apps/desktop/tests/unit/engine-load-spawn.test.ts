import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  EngineCannotRunError,
  engineProblemFor,
  reportEngineProblem,
  resetEngineProblemsForTest
} from '../../src/main/services/runtime/engine-load'
import { failureSignature, LlamaServer, type ChildProcessLike, type SpawnFn } from '../../src/main/services/runtime/sidecar'
import { createCachedGpuProbe, probeGpuDevices } from '../../src/main/services/runtime/gpu'

// #530 at the spawn sites: the shared LlamaServer (chat, embedder, reranker, vision, translation)
// and the GPU device probe recognise a program the OS loader refused, record the session verdict,
// and stop telling the rest of the app "it exited" (LlamaServer) or "no graphics card" (probe).

const LOADER_LINE =
  '/media/someone/HR/runtime/llama.cpp/linux/llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 5150
  killed = false
  stderr: EventEmitter | null = new EventEmitter()
  stdout: EventEmitter | null = new EventEmitter()
  kill(): boolean {
    this.killed = true
    return true
  }
}

const notHealthy = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch

function server(spawn: SpawnFn, extra: Partial<ConstructorParameters<typeof LlamaServer>[0]> = {}): LlamaServer {
  return new LlamaServer({
    binPath: '/media/someone/HR/runtime/llama.cpp/linux/llama-server',
    modelPath: '/m.gguf',
    contextTokens: 2048,
    spawn,
    fetchImpl: notHealthy,
    findPort: async () => 50900,
    healthIntervalMs: 1,
    verifyBinary: async () => 'skip-dev',
    ...extra
  })
}

afterEach(() => resetEngineProblemsForTest())

describe('LlamaServer — a program the OS loader refused (#530)', () => {
  it('throws the typed, path-free error and records the verdict — no bind retry', async () => {
    let spawns = 0
    const spawn: SpawnFn = () => {
      spawns++
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stderr!.emit('data', Buffer.from(LOADER_LINE))
        child.emit('exit', 127, null)
        child.emit('close', 127, null)
      })
      return child
    }
    const err = await server(spawn, { platform: 'linux' }).start().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineCannotRunError)
    expect((err as Error).message).toBe(
      'llama-server cannot run on this computer — a system library is missing: libgomp.so.1 (exit code 127)'
    )
    expect((err as Error).message).not.toContain('/media/')
    expect(spawns).toBe(1)
    expect(engineProblemFor('llama_cpp')).toEqual({
      family: 'llama_cpp',
      reason: 'library-missing',
      os: 'linux',
      name: 'libgomp.so.1',
      exit: 'exit code 127'
    })
    // The #312 comparison never sees it: the typed message carries no exit-status shape.
    expect(failureSignature((err as Error).message)).toBeNull()
  })

  it('waits for the stderr that arrives AFTER exit (Node may emit exit before the pipe drains)', async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      queueMicrotask(() => child.emit('exit', 127, null)) // process gone, pipe not drained yet
      setTimeout(() => {
        child.stderr!.emit('data', Buffer.from(LOADER_LINE)) // late-delivered loader line
        child.emit('close', 127, null)
      }, 5)
      return child
    }
    await expect(server(spawn, { platform: 'linux' }).start()).rejects.toBeInstanceOf(EngineCannotRunError)
    expect(engineProblemFor('llama_cpp')?.name).toBe('libgomp.so.1')
  })

  it('classifies a Windows DLL-not-found exit (no stderr at all) from the code', async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      child.stderr = null // Windows: the loader writes nothing
      queueMicrotask(() => child.emit('exit', 3221225781, null))
      return child
    }
    const err = await server(spawn, { platform: 'win32', systemDllExists: (dll) => dll !== 'msvcp140.dll' })
      .start()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineCannotRunError)
    expect((err as EngineCannotRunError).problem).toEqual({
      family: 'llama_cpp',
      reason: 'vc-runtime-missing',
      os: 'win',
      name: 'msvcp140.dll',
      exit: 'exit code 0xC0000135'
    })
  })

  it('keeps the old exit message for a failure that is not the loader’s', async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stderr!.emit('data', Buffer.from('0.00.100.000 E llama_model_load: error loading model\n'))
        child.emit('exit', 1, null)
        child.emit('close', 1, null)
      })
      return child
    }
    const err = await server(spawn, { platform: 'linux' }).start().catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(EngineCannotRunError)
    expect((err as Error).message).toMatch(/^llama-server exited before becoming healthy \(code 1\)/)
    expect(engineProblemFor('llama_cpp')).toBeNull()
  })

  it('turns a SYNCHRONOUS spawn throw into the path-free launch-failure shape (not Windows)', async () => {
    const spawn: SpawnFn = () => {
      throw Object.assign(new Error('spawn /media/someone/HR/runtime/llama.cpp/linux/llama-server EACCES'), { code: 'EACCES' })
    }
    const err = await server(spawn, { platform: 'linux' }).start().catch((e: unknown) => e)
    expect((err as Error).message).toBe('llama-server failed to launch: spawn EACCES')
    expect(failureSignature((err as Error).message)).toBe('launch')
  })

  it('a Windows spawn refusal (sync EPERM — policy / security software) is the typed "blocked" verdict', async () => {
    // Review fix: the bare launch signature matched on every rung, so the ladder blamed the MODEL.
    const spawn: SpawnFn = () => {
      throw Object.assign(new Error('spawn C:\\Kit\\llama-server.exe EPERM'), { code: 'EPERM' })
    }
    const err = await server(spawn, { platform: 'win32' }).start().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineCannotRunError)
    expect((err as EngineCannotRunError).problem).toEqual({
      family: 'llama_cpp',
      reason: 'blocked',
      os: 'win',
      exit: 'spawn error EPERM'
    })
  })

  it('the async spawn error takes the same paths (Windows EACCES → blocked; elsewhere path-free)', async () => {
    const erroring = (code: string): SpawnFn => () => {
      const child = new FakeChild()
      queueMicrotask(() => child.emit('error', Object.assign(new Error(`spawn /x/llama-server ${code}`), { code })))
      return child
    }
    await expect(server(erroring('EACCES'), { platform: 'win32' }).start()).rejects.toBeInstanceOf(EngineCannotRunError)
    resetEngineProblemsForTest()
    const err = await server(erroring('ENOENT'), { platform: 'linux' }).start().catch((e: unknown) => e)
    expect((err as Error).message).toBe('llama-server failed to launch: spawn ENOENT')
  })

  it('a healthy start of the refused program clears its verdict (an intermittent block that went away)', async () => {
    const binPath = '/media/someone/HR/runtime/llama.cpp/linux/llama-server'
    reportEngineProblem(
      { family: 'llama_cpp', reason: 'blocked', os: 'win', exit: 'exit code 0xC0E90002' },
      binPath
    )
    const spawn: SpawnFn = () => new FakeChild()
    const healthy = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch
    const s = server(spawn, { fetchImpl: healthy })
    await s.start()
    expect(engineProblemFor('llama_cpp')).toBeNull()
    await s.stop()
  })

  it('a healthy start of ANOTHER program of the family (a cpu/ build) leaves the verdict', async () => {
    reportEngineProblem(
      { family: 'llama_cpp', reason: 'files-damaged', os: 'win', exit: 'exit code 0xC0000135' },
      'C:\\Kit\\runtime\\llama.cpp\\win\\llama-server.exe'
    )
    const spawn: SpawnFn = () => new FakeChild()
    const healthy = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch
    const s = server(spawn, { fetchImpl: healthy, binPath: 'C:\\Kit\\runtime\\llama.cpp\\win\\cpu\\llama-server.exe' })
    await s.start()
    expect(engineProblemFor('llama_cpp')?.reason).toBe('files-damaged')
    await s.stop()
  })
})

describe('GPU probe — a refused program is UNKNOWN, not "no graphics card" (#530)', () => {
  const refusingSpawn = (): { spawn: SpawnFn; spawns: () => number } => {
    let n = 0
    const spawn: SpawnFn = () => {
      n++
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stderr!.emit('data', Buffer.from(LOADER_LINE))
        child.emit('close', 127, null)
      })
      return child
    }
    return { spawn, spawns: () => n }
  }

  it('resolves null and records the verdict', async () => {
    const { spawn } = refusingSpawn()
    const devices = await probeGpuDevices('/bin/llama-server', { spawn, platform: 'linux', verify: async () => 'skip-dev' })
    expect(devices).toBeNull()
    expect(engineProblemFor('llama_cpp')).toMatchObject({ reason: 'library-missing', name: 'libgomp.so.1' })
  })

  it('is never cached — the next caller probes again (so an installed library is seen)', async () => {
    const { spawn, spawns } = refusingSpawn()
    const probe = createCachedGpuProbe({ spawn, platform: 'linux', verify: async () => 'skip-dev' })
    expect(await probe('/bin/llama-server')).toBeNull()
    expect(await probe('/bin/llama-server')).toBeNull()
    expect(spawns()).toBe(2)
  })

  it('still answers [] for a non-zero exit that is not the loader’s (the old contract)', async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stderr!.emit('data', Buffer.from('error: unknown argument: --list-devices\n'))
        child.emit('close', 1, null)
      })
      return child
    }
    expect(await probeGpuDevices('/bin/llama-server', { spawn, platform: 'linux', verify: async () => 'skip-dev' })).toEqual([])
    expect(engineProblemFor('llama_cpp')).toBeNull()
  })

  it('a probe that answers clears a verdict recorded against the same binary', async () => {
    reportEngineProblem({ family: 'llama_cpp', reason: 'blocked', os: 'win', exit: 'exit code 0xC0E90002' }, '/bin/llama-server')
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    }
    expect(await probeGpuDevices('/bin/llama-server', { spawn, verify: async () => 'skip-dev' })).toEqual([])
    expect(engineProblemFor('llama_cpp')).toBeNull()
  })

  it('a Windows spawn refusal (the error event) is UNKNOWN plus the verdict, not "no graphics card"', async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' })))
      return child
    }
    expect(await probeGpuDevices('/bin/llama-server', { spawn, platform: 'win32', verify: async () => 'skip-dev' })).toBeNull()
    expect(engineProblemFor('llama_cpp')?.reason).toBe('blocked')
  })

  it('pipes stderr (it was ignored, which threw the loader line away)', async () => {
    const options: unknown[] = []
    const spawn: SpawnFn = (_c, _a, o) => {
      options.push(o)
      const child = new FakeChild()
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    }
    await probeGpuDevices('/bin/llama-server', { spawn, verify: async () => 'skip-dev' })
    expect(options[0]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  })
})
