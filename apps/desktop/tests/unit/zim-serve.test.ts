import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import { registeredSidecarPids } from '../../src/main/services/runtime/sidecar'
import type { BinaryVerifyResult } from '../../src/main/services/binary-verifier'
import { log } from '../../src/main/services/logging'
import { KiwixServer, _resetKiwixServeSkipLegacyWarnForTests } from '../../src/main/services/zim/serve'

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
  /** #339 P8-1: the pre-spawn verifier seam (default: the harness's always-`ok`). */
  verifyBinary?: (binPath: string) => Promise<BinaryVerifyResult>
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
    killGraceMs: 10,
    ...(opts.verifyBinary ? { verifyBinary: opts.verifyBinary } : {})
  })
  return { server, calls, children }
}

describe('KiwixServer', () => {
  it('starts, probes to healthy, and reports its port', async () => {
    const { server, calls } = makeServer({ probeResults: [false, true] })
    await expect(server.ensureStarted()).resolves.toMatchObject({ port: 8100 })
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
    await expect(server.ensureStarted()).resolves.toMatchObject({ port: 8101 })
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
    await expect(server.ensureStarted()).resolves.toMatchObject({ port: 8101 })
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
    await expect(server.ensureStarted()).resolves.toMatchObject({ port: 8101 })
    expect(calls).toHaveLength(2)
    await server.stop()
  })

  // #339 P8-1 (R-1 closure, auditable for BOTH binaries): an in-app install records a hash
  // for kiwix-serve, so `skip-legacy` now means exactly "a bundle placed by hand" — said once
  // per process (the kiwix-manage rule), never per start, never with a path.
  it('kiwix-serve logs one skip-legacy warning per process on a hashless install marker, and still starts', async () => {
    _resetKiwixServeSkipLegacyWarnForTests()
    const warn = vi.spyOn(log, 'warn')
    try {
      for (let i = 0; i < 2; i++) {
        const { server, calls } = makeServer({ verifyBinary: async () => 'skip-legacy' })
        await expect(server.ensureStarted()).resolves.toMatchObject({ port: 8100 })
        expect(calls).toHaveLength(1) // spawned — skip-legacy never blocks
        await server.stop()
      }
      const r1 = warn.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('kiwix-serve') && c[0].includes('R-1'))
      expect(r1).toHaveLength(1)
      expect(r1[0]?.[0]).not.toMatch(/[\\/]/)
      // A verified install says nothing.
      warn.mockClear()
      const { server } = makeServer({ verifyBinary: async () => 'ok' })
      await server.ensureStarted()
      await server.stop()
      expect(warn.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('R-1'))).toHaveLength(0)
    } finally {
      warn.mockRestore()
      _resetKiwixServeSkipLegacyWarnForTests()
    }
  })
})
