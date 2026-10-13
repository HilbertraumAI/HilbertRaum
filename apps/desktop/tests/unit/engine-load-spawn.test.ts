import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  EngineCannotRunError,
  engineProblemFor,
  reportEngineProblem,
  resetEngineProblemsForTest
} from '../../src/main/services/runtime/engine-load'
import { failureSignature, LlamaServer, type ChildProcessLike, type SpawnFn } from '../../src/main/services/runtime/sidecar'
import { probeGpuDevices } from '../../src/main/services/runtime/gpu'

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
    // FakeChild.kill() never emits 'exit': stop() would sit out the default grace.
    killGraceMs: 1,
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

  // #655: on a Kit the probe and rungs 1–2 (main build) and rung 3 (cpu/) all report, cpu/ last. Once the
  // fix is in, the main build runs on the graphics card — that clears it. The cpu/ net starts only after the
  // main build's rungs failed, so it clears only as the latest reporter: a main build that refused it again
  // right before (still damaged) keeps the verdict and its #532 reinstall offer (review of #655).
  const KIT_MAIN = 'C:\\Kit\\runtime\\llama.cpp\\win\\llama-server.exe'
  const KIT_CPU = 'C:\\Kit\\runtime\\llama.cpp\\win\\cpu\\llama-server.exe'
  it.each<[string, string[], string, boolean]>([
    ['the main build clears a verdict the cpu/ build reported last (#655)', [KIT_MAIN, KIT_CPU], KIT_MAIN, true],
    ['the cpu/ build keeps a verdict the main build reported after it', [KIT_MAIN, KIT_CPU, KIT_MAIN], KIT_CPU, false],
    ['the cpu/ build clears a verdict it reported last (an intermittent block)', [KIT_MAIN, KIT_CPU], KIT_CPU, true],
    // Rungs 1–2 failed for a reason that is not the loader's; only cpu/ was refused (and still is).
    ['the main build leaves a verdict only the cpu/ build reported', [KIT_CPU], KIT_MAIN, false]
  ])('a healthy start: %s', async (_label, reporters, started, cleared) => {
    const problem = { family: 'llama_cpp', reason: 'files-damaged', os: 'win', exit: 'exit code 0xC0000135' } as const
    for (const binPath of reporters) reportEngineProblem(problem, binPath)
    const spawn: SpawnFn = () => new FakeChild()
    const healthy = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch
    const s = server(spawn, { fetchImpl: healthy, binPath: started })
    await s.start()
    try {
      expect(engineProblemFor('llama_cpp') === null).toBe(cleared)
    } finally {
      await s.stop()
    }
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
  it('resolves null and records the verdict', async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stderr!.emit('data', Buffer.from(LOADER_LINE))
        child.emit('close', 127, null)
      })
      return child
    }
    const devices = await probeGpuDevices('/bin/llama-server', { spawn, platform: 'linux', verify: async () => 'skip-dev' })
    expect(devices).toBeNull()
    expect(engineProblemFor('llama_cpp')).toMatchObject({ reason: 'library-missing', name: 'libgomp.so.1' })
  })

  // #653: a non-zero exit that is not the loader's is no answer either (`null`, gpu.test.ts) — but it
  // is no refusal: the engine ran, so no verdict is recorded and nothing tells the user it cannot run.
  it('a non-zero exit that is not the loader’s is unknown too, and records no verdict (#653)', async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild()
      queueMicrotask(() => {
        child.stderr!.emit('data', Buffer.from('error: unknown argument: --list-devices\n'))
        child.emit('close', 1, null)
      })
      return child
    }
    expect(await probeGpuDevices('/bin/llama-server', { spawn, platform: 'linux', verify: async () => 'skip-dev' })).toBeNull()
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

  // #653 review: the guard that keeps a timed-out probe's own kill from logging a second non-answer
  // must not swallow an exit 0 that lands just after the kill-timeout. The program ran, so a refusal
  // recorded against it is stale either way; the probe's own answer stays the timeout's `null`.
  it('a probe that exits 0 just after its kill-timeout still clears a stale verdict (#653)', async () => {
    vi.useFakeTimers()
    try {
      reportEngineProblem({ family: 'llama_cpp', reason: 'blocked', os: 'win', exit: 'exit code 0xC0E90002' }, '/bin/llama-server')
      let child!: FakeChild
      const spawn: SpawnFn = () => (child = new FakeChild()) // exits only when the test says so
      const probing = probeGpuDevices('/bin/llama-server', { spawn, timeoutMs: 20, verify: async () => 'skip-dev' })
      await vi.advanceTimersByTimeAsync(20)
      expect(await probing).toBeNull()
      child.emit('close', 0, null)
      expect(engineProblemFor('llama_cpp')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
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
