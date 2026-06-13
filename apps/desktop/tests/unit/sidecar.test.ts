import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {
  resolveLlamaServerPath,
  resolveCpuFallbackServerPath,
  llamaServerBinaryName,
  llamaServerDir,
  llamaOsDir,
  defaultThreadCount,
  findFreePort,
  LlamaServer,
  LOOPBACK_HOST,
  type ChildProcessLike,
  type UnexpectedExitInfo
} from '../../src/main/services/runtime/sidecar'

afterEach(() => vi.restoreAllMocks())

// ---- A fake child process: kill() resolves the LlamaServer exit wait. -----------

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 4242
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

/** A spawn() stub that records its calls and returns a FakeChild. */
function fakeSpawn() {
  const calls: Array<{ command: string; args: string[] }> = []
  const child = new FakeChild()
  const spawn = (command: string, args: string[]): ChildProcessLike => {
    calls.push({ command, args })
    return child
  }
  return { spawn, calls, child }
}

/** A health endpoint that becomes ready after `readyAfter` polls. */
function healthFetch(readyAfter = 0) {
  let polls = 0
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url))
    polls++
    const ok = polls > readyAfter
    return { ok, status: ok ? 200 : 503, json: async () => ({ status: ok ? 'ok' : 'loading' }) } as Response
  }) as typeof fetch
  return { fetchImpl, urls }
}

// ---- Binary discovery -----------------------------------------------------------

describe('resolveLlamaServerPath', () => {
  it('finds the platform binary under runtime/llama.cpp/<os>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-bin-'))
    const dir = llamaServerDir(root, 'win32')
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, llamaServerBinaryName('win32'))
    writeFileSync(bin, 'x')
    expect(resolveLlamaServerPath(root, 'win32', {})).toBe(bin)
  })

  it('returns null when the binary is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-bin-'))
    expect(resolveLlamaServerPath(root, 'win32', {})).toBeNull()
  })

  it('honours the HILBERTRAUM_LLAMA_BIN override when it exists, else null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-bin-'))
    const explicit = join(dir, 'my-llama-server')
    writeFileSync(explicit, 'x')
    expect(resolveLlamaServerPath('/nope', 'linux', { HILBERTRAUM_LLAMA_BIN: explicit })).toBe(explicit)
    expect(resolveLlamaServerPath('/nope', 'linux', { HILBERTRAUM_LLAMA_BIN: join(dir, 'absent') })).toBeNull()
  })

  it('maps platforms to os dirs and exe names', () => {
    expect(llamaOsDir('win32')).toBe('win')
    expect(llamaOsDir('darwin')).toBe('mac')
    expect(llamaOsDir('linux')).toBe('linux')
    expect(llamaServerBinaryName('win32')).toBe('llama-server.exe')
    expect(llamaServerBinaryName('linux')).toBe('llama-server')
  })
})

describe('resolveCpuFallbackServerPath (Phase 15, ladder rung 3)', () => {
  it('finds the safety-net binary under runtime/llama.cpp/<os>/cpu/', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-cpubin-'))
    const dir = join(llamaServerDir(root, 'win32'), 'cpu')
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, llamaServerBinaryName('win32'))
    writeFileSync(bin, 'x')
    expect(resolveCpuFallbackServerPath(root, 'win32')).toBe(bin)
  })

  it('returns null when the drive ships no safety net (e.g. mac)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-cpubin-'))
    expect(resolveCpuFallbackServerPath(root, 'darwin')).toBeNull()
  })
})

describe('defaultThreadCount', () => {
  it('is always at least 1', () => {
    expect(defaultThreadCount()).toBeGreaterThanOrEqual(1)
  })
})

describe('findFreePort', () => {
  it('returns a usable loopback port', async () => {
    const port = await findFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })
})

// ---- LlamaServer lifecycle ------------------------------------------------------

describe('LlamaServer', () => {
  it('spawns bound to 127.0.0.1 ONLY (never 0.0.0.0 / a routable host)', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = healthFetch(0)
    const server = new LlamaServer({
      binPath: '/bin/llama-server',
      modelPath: '/models/x.gguf',
      contextTokens: 4096,
      spawn,
      fetchImpl,
      findPort: async () => 51234,
      healthIntervalMs: 1
    })
    await server.start()

    const args = calls[0].args
    const hostIdx = args.indexOf('--host')
    expect(hostIdx).toBeGreaterThanOrEqual(0)
    expect(args[hostIdx + 1]).toBe(LOOPBACK_HOST)
    expect(args).toContain('127.0.0.1')
    expect(args.join(' ')).not.toContain('0.0.0.0')
    // ctx-size + model + port are forwarded.
    expect(args).toContain('--model')
    expect(args).toContain('/models/x.gguf')
    expect(args).toContain('--ctx-size')
    expect(args).toContain('4096')
    expect(args).toContain('51234')
    await server.stop()
  })

  it('reports healthy once /health returns ok, with the bound port', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, urls } = healthFetch(1) // not ready on the first poll
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50000,
      healthIntervalMs: 1
    })
    await server.start()
    const h = await server.health()
    expect(h.healthy).toBe(true)
    expect(h.port).toBe(50000)
    // Every health probe goes to loopback only.
    expect(urls.every((u) => u.startsWith('http://127.0.0.1:50000/'))).toBe(true)
    await server.stop()
  })

  it('throws (does not hang) when the server never becomes healthy', async () => {
    const { spawn, child } = fakeSpawn()
    const fetchImpl = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50001,
      healthTimeoutMs: 40,
      healthIntervalMs: 5
    })
    await expect(server.start()).rejects.toThrow(/did not become healthy/)
    // The wedged child is killed during the failed start (no orphan).
    expect(child.killed).toBe(true)
  })

  it('throws cleanly if the child exits before becoming healthy', async () => {
    const calls: Array<{ args: string[] }> = []
    const child = new FakeChild()
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      // Simulate an immediate crash (bad model, port in use, …).
      queueMicrotask(() => child.emit('exit', 1, null))
      return child
    }
    const fetchImpl = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50002,
      healthIntervalMs: 1
    })
    await expect(server.start()).rejects.toThrow(/exited before becoming healthy/)
  })

  it('surfaces the stderr tail + exit code when the child fails to bind (port conflict)', async () => {
    const child = new FakeChild() as FakeChild & { stderr: EventEmitter }
    child.stderr = new EventEmitter()
    const spawn = (_c: string, _args: string[]): ChildProcessLike => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('error: bind: address already in use\n'))
        child.emit('exit', 1, null)
      })
      return child
    }
    const fetchImpl = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50010,
      healthIntervalMs: 1
    })
    // The thrown error explains WHY (the captured stderr) and that it exited (code 1).
    await expect(server.start()).rejects.toThrow(/address already in use/)
  })

  it('kills the child on stop() so no orphan survives', async () => {
    const { spawn, child } = fakeSpawn()
    const { fetchImpl } = healthFetch(0)
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50003,
      healthIntervalMs: 1
    })
    await server.start()
    expect(child.killed).toBe(false)
    await server.stop()
    expect(child.killed).toBe(true)
    expect(server.port).toBeNull()
  })

  // Phase 15 (§5.3): the mid-session crash hook — fires only for a healthy server
  // dying on its own, never for start-time failures or a stop()-initiated exit.
  it('fires onUnexpectedExit when a healthy server dies on its own', async () => {
    const { spawn, child } = fakeSpawn()
    const { fetchImpl } = healthFetch(0)
    const exits: UnexpectedExitInfo[] = []
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      onUnexpectedExit: (info) => exits.push(info),
      spawn,
      fetchImpl,
      findPort: async () => 50005,
      healthIntervalMs: 1
    })
    await server.start()
    child.emit('exit', 134, null) // driver crash mid-generation
    expect(exits).toHaveLength(1)
    expect(exits[0].exitCode).toBe(134)
  })

  // M-C1: a post-ready 'error' WITHOUT an 'exit' (process gone via ECHILD/EPIPE) is
  // still a mid-session death — it must fire onUnexpectedExit so the GPU auto-fallback
  // runs and stop() doesn't hang waiting on an 'exit' that never comes.
  it('fires onUnexpectedExit when a healthy server emits "error" without "exit"', async () => {
    const { spawn, child } = fakeSpawn()
    const { fetchImpl } = healthFetch(0)
    const exits: UnexpectedExitInfo[] = []
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      onUnexpectedExit: (info) => exits.push(info),
      spawn,
      fetchImpl,
      findPort: async () => 50008,
      healthIntervalMs: 1
    })
    await server.start()
    child.emit('error', new Error('read ECHILD')) // dies without ever emitting 'exit'
    expect(exits).toHaveLength(1)
  })

  it('stop() resolves (does not hang) when the child only ever emits "error"', async () => {
    // A child whose kill() emits 'error' rather than 'exit'.
    class ErrorOnlyChild extends EventEmitter implements ChildProcessLike {
      pid = 9
      killed = false
      kill(): boolean {
        this.killed = true
        queueMicrotask(() => this.emit('error', new Error('gone')))
        return true
      }
    }
    const child = new ErrorOnlyChild()
    const spawn = (): ChildProcessLike => child
    const { fetchImpl } = healthFetch(0)
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50009,
      healthIntervalMs: 1,
      killGraceMs: 10_000 // long: the test would time out if stop() waited on the grace timer
    })
    await server.start()
    await server.stop() // resolves via the 'error' branch of the race, not the grace timeout
    expect(child.killed).toBe(true)
  })

  // M-C2: when child.kill() THROWS, stop() must not bail early (which would leave an
  // orphan holding VRAM + the port) — it still races exit/grace and escalates to SIGKILL.
  it('stop() still escalates to SIGKILL when the polite kill() throws', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = []
    class ThrowOnFirstKillChild extends EventEmitter implements ChildProcessLike {
      pid = 11
      killed = false
      kill(signal?: NodeJS.Signals | number): boolean {
        signals.push(signal)
        if (signals.length === 1) throw new Error('kill failed (EPERM)') // the polite SIGTERM throws
        this.killed = true
        return true
      }
    }
    const child = new ThrowOnFirstKillChild()
    const spawn = (): ChildProcessLike => child
    const { fetchImpl } = healthFetch(0)
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50011,
      healthIntervalMs: 1,
      killGraceMs: 1 // child never exits → grace window elapses → SIGKILL escalation
    })
    await server.start()
    await server.stop()
    // First call (the throwing SIGTERM) did NOT short-circuit stop(): SIGKILL was still sent.
    expect(signals[0]).toBeUndefined() // child.kill() with no arg = SIGTERM
    expect(signals).toContain('SIGKILL')
  })

  it('does NOT fire onUnexpectedExit for an exit during stop()', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl } = healthFetch(0)
    const exits: UnexpectedExitInfo[] = []
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      onUnexpectedExit: (info) => exits.push(info),
      spawn,
      fetchImpl,
      findPort: async () => 50006,
      healthIntervalMs: 1
    })
    await server.start()
    await server.stop() // FakeChild.kill emits 'exit'
    expect(exits).toHaveLength(0)
  })

  it('does NOT fire onUnexpectedExit for an exit BEFORE becoming healthy (start throws instead)', async () => {
    const child = new FakeChild()
    const spawn = (): ChildProcessLike => {
      queueMicrotask(() => child.emit('exit', 1, null))
      return child
    }
    const fetchImpl = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch
    const exits: UnexpectedExitInfo[] = []
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      onUnexpectedExit: (info) => exits.push(info),
      spawn,
      fetchImpl,
      findPort: async () => 50007,
      healthIntervalMs: 1
    })
    await expect(server.start()).rejects.toThrow(/exited before becoming healthy/)
    expect(exits).toHaveLength(0)
  })

  it('makes ZERO non-loopback network calls during start/health/stop', async () => {
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const connectSpy = vi.spyOn(net, 'connect')
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect')

    const { spawn } = fakeSpawn()
    const { fetchImpl } = healthFetch(0)
    const server = new LlamaServer({
      binPath: '/bin/s',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl,
      findPort: async () => 50004,
      healthIntervalMs: 1
    })
    await server.start()
    await server.health()
    await server.stop()

    // The injected fetch handles the (loopback) HTTP; no real sockets are opened.
    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(socketConnectSpy).not.toHaveBeenCalled()
  })
})
