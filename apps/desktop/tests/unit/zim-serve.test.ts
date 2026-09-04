import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import { registeredSidecarPids } from '../../src/main/services/runtime/sidecar'
import { KiwixServer } from '../../src/main/services/zim/serve'

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid: number
  killed = false
  stderr = new EventEmitter()
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

interface Harness {
  server: KiwixServer
  calls: Array<{ command: string; args: string[] }>
  children: FakeChild[]
}

function makeServer(opts: {
  probeResults?: boolean[] | ((port: number) => Promise<boolean>)
  ports?: number[]
  failFirstChild?: 'bind-race' | 'enoent' | 'exit-42'
}): Harness {
  const calls: Array<{ command: string; args: string[] }> = []
  const children: FakeChild[] = []
  let spawnCount = 0
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
    const child = new FakeChild(9000 + spawnCount)
    children.push(child)
    const failMode = spawnCount === 0 ? opts.failFirstChild : undefined
    spawnCount++
    if (failMode === 'bind-race') {
      queueMicrotask(() => {
        child.stderr.emit('data', 'bind: address already in use')
        child.emit('exit', 1, null)
      })
    } else if (failMode === 'enoent') {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
    } else if (failMode === 'exit-42') {
      queueMicrotask(() => {
        child.stderr.emit('data', 'The library was NOT loaded')
        child.emit('exit', 42, null)
      })
    }
    return child
  }
  const portQueue = [...(opts.ports ?? [8100, 8101])]
  const probes = opts.probeResults
  let probeIdx = 0
  const server = new KiwixServer({
    binPath: '/bin/kiwix-serve',
    libraryXmlPath: '/ws/.zim-library.xml',
    spawn,
    findPort: async () => portQueue.shift() ?? 8199,
    probe:
      typeof probes === 'function'
        ? probes
        : async () => (Array.isArray(probes) ? (probes[probeIdx++] ?? true) : true),
    healthTimeoutMs: 500,
    healthIntervalMs: 1,
    killGraceMs: 10
  })
  return { server, calls, children }
}

describe('KiwixServer', () => {
  it('starts, probes to healthy, and reports its port', async () => {
    const { server, calls } = makeServer({ probeResults: [false, true] })
    await expect(server.ensureStarted()).resolves.toBe(8100)
    expect(server.port()).toBe(8100)
    expect(calls[0]?.args).toEqual([
      '--address',
      '127.0.0.1',
      '--port',
      '8100',
      '--nosearchbar',
      '--blockexternal',
      '--library',
      '/ws/.zim-library.xml'
    ])
    await server.stop()
    expect(server.port()).toBeNull()
  })

  it('is single-flight: concurrent ensureStarted() shares one spawn', async () => {
    const { server, calls } = makeServer({})
    const [a, b] = await Promise.all([server.ensureStarted(), server.ensureStarted()])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
    await server.stop()
  })

  it('retries ONCE on a fresh port after a bind race', async () => {
    // Only the SECOND port ever becomes healthy — a dead first child must not probe true.
    const { server, calls } = makeServer({ failFirstChild: 'bind-race', probeResults: async (p) => p === 8101 })
    await expect(server.ensureStarted()).resolves.toBe(8101)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.args).toContain('8101')
    await server.stop()
  })

  it('surfaces the stderr tail when the child exits before healthy, and latches', async () => {
    const { server, calls } = makeServer({ failFirstChild: 'exit-42', probeResults: async (p) => p === 8101 })
    await expect(server.ensureStarted()).rejects.toThrow(/code 42.*library was NOT loaded/s)
    // The failure latches: no new spawn until the latch is reset.
    await expect(server.ensureStarted()).rejects.toThrow(/code 42/)
    expect(calls).toHaveLength(1)
    server.resetFailureLatch()
    await expect(server.ensureStarted()).resolves.toBe(8101)
    await server.stop()
  })

  it('maps a spawn error to a launch failure', async () => {
    const { server } = makeServer({ failFirstChild: 'enoent', probeResults: async () => false })
    await expect(server.ensureStarted()).rejects.toThrow(/failed to launch.*ENOENT/s)
  })

  it('registers the child for the crash reap and unregisters it on stop', async () => {
    const { server, children } = makeServer({})
    await server.ensureStarted()
    const pid = children[0]!.pid
    expect(registeredSidecarPids('kiwix_tools')).toContain(pid)
    await server.stop()
    expect(registeredSidecarPids('kiwix_tools')).not.toContain(pid)
  })

  it('cold-starts again after the server died on its own', async () => {
    const { server, calls, children } = makeServer({})
    await server.ensureStarted()
    children[0]!.emit('exit', 1, null) // crash after healthy
    await expect(server.ensureStarted()).resolves.toBe(8101)
    expect(calls).toHaveLength(2)
    await server.stop()
  })
})
