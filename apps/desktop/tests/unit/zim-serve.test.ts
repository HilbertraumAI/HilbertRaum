import { describe, expect, it, vi } from 'vitest'
import type { SpawnFn } from '../../src/main/services/runtime/sidecar'
import {
  initBinaryVerification,
  _resetBinaryVerificationForTests
} from '../../src/main/services/binary-verifier'
import { log } from '../../src/main/services/logging'
import { KiwixServer } from '../../src/main/services/zim/serve'
import { until } from '../helpers/hang-budget'
import {
  BIND_RACE,
  ServeFakeChild,
  binaryWithMarker,
  expectAbortError,
  failEarly,
  serveGate,
  type EarlyFailure,
  type ServeChildMode
} from '../helpers/zim-fakes'

/** The library build a start serves unless a row needs a second one. */
const LIBRARY = '/ws/.zim-library.xml'

interface Harness {
  server: KiwixServer
  calls: Array<{ command: string; args: string[] }>
  children: ServeFakeChild[]
}

function makeServer(opts: {
  probeResults?: boolean[] | ((port: number) => Promise<boolean>)
  ports?: number[]
  /** The first `failCount` children (default 1) die like this before they are healthy. */
  failFirst?: EarlyFailure
  failCount?: number
  /** Default: a fake path. The real verifier answers `skip-dev` while it is not enforced. */
  binPath?: string
}): Harness {
  const calls: Array<{ command: string; args: string[] }> = []
  const children: ServeFakeChild[] = []
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
    const child = new ServeFakeChild(9000 + children.length, 'exit-on-sigterm')
    if (opts.failFirst && children.length < (opts.failCount ?? 1)) failEarly(child, opts.failFirst)
    children.push(child)
    return child
  }
  const portQueue = [...(opts.ports ?? [8100, 8101])]
  const probes = opts.probeResults
  let probeIdx = 0
  let generation = 0
  const server = new KiwixServer({
    binPath: opts.binPath ?? '/bin/kiwix-serve',
    spawn,
    findPort: async () => portQueue.shift() ?? 8199,
    probe:
      typeof probes === 'function'
        ? probes
        : async () => (Array.isArray(probes) ? (probes[probeIdx++] ?? true) : true),
    allocateGeneration: () => ++generation,
    healthTimeoutMs: 500,
    healthIntervalMs: 1,
    killGraceMs: 10
  })
  return { server, calls, children }
}

describe('KiwixServer', () => {
  it('starts, probes to healthy, and reports its port', async () => {
    const { server, calls } = makeServer({ probeResults: [false, true] })
    await expect(server.ensureStarted({ libraryXmlPath: LIBRARY })).resolves.toMatchObject({ port: 8100 })
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
    const [a, b] = await Promise.all([
      server.ensureStarted({ libraryXmlPath: LIBRARY }),
      server.ensureStarted({ libraryXmlPath: LIBRARY })
    ])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
    // Once it is live, the same library is answered by that child, not a second spawn.
    await expect(server.ensureStarted({ libraryXmlPath: LIBRARY })).resolves.toEqual(a)
    expect(calls).toHaveLength(1)
    await server.stop()
  })

  it('retries ONCE on a fresh port after a bind race', async () => {
    // Only the SECOND port ever becomes healthy — a dead first child must not probe true.
    const { server, calls } = makeServer({ failFirst: BIND_RACE, probeResults: async (p) => p === 8101 })
    await expect(server.ensureStarted({ libraryXmlPath: LIBRARY })).resolves.toMatchObject({ port: 8101 })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.args).toContain('8101')
    await server.stop()

    // Once, not until it works: when the retry races too, the start fails although a third
    // port would have answered.
    const twice = makeServer({
      failFirst: BIND_RACE,
      failCount: 2,
      ports: [8100, 8101, 8102],
      probeResults: async (p) => p === 8102
    })
    await expect(twice.server.ensureStarted({ libraryXmlPath: LIBRARY })).rejects.toThrow(
      /exited before becoming healthy \(code 1\).*address already in use/s
    )
    expect(twice.calls).toHaveLength(2)
  })

  it('surfaces the stderr tail when the child exits before healthy', async () => {
    const { server, calls } = makeServer({
      failFirst: { kind: 'exit', code: 42, stderr: 'The library was NOT loaded' },
      probeResults: async () => false
    })
    await expect(server.ensureStarted({ libraryXmlPath: LIBRARY })).rejects.toThrow(/code 42.*library was NOT loaded/s)
    expect(calls).toHaveLength(1) // not a bind race: no retry
  })

  it('maps a spawn error to a launch failure', async () => {
    const { server } = makeServer({
      failFirst: { kind: 'error', error: new Error('spawn ENOENT') },
      probeResults: async () => false
    })
    await expect(server.ensureStarted({ libraryXmlPath: LIBRARY })).rejects.toThrow(/failed to launch.*ENOENT/s)
  })

  // #554: superseding a live child for a DIFFERENT library.xml awaits stop() between the entry
  // abort check and the 'abort' subscription. 'abort' fires once, so a cancel that lands during
  // that teardown must be caught by a re-check, or the new child spawns and health-checks anyway.
  it('honours a cancel that lands while a superseding start awaits stop(): no spawn, and the next start still runs (#554)', async () => {
    const { server, calls } = makeServer({})
    await server.ensureStarted({ libraryXmlPath: LIBRARY })
    expect(calls).toHaveLength(1)
    const controller = new AbortController()
    const realStop = server.stop.bind(server)
    // By ordering, not a timer: the cancel lands while ensureStarted is parked on this teardown.
    const stopSpy = vi.spyOn(server, 'stop').mockImplementationOnce(() => {
      const teardown = realStop()
      controller.abort()
      return teardown
    })
    const other = '/ws/.zim-library.2.xml'
    try {
      const outcome = await server
        .ensureStarted({ libraryXmlPath: other, signal: controller.signal })
        .catch((err: unknown) => err)
      expect(stopSpy).toHaveBeenCalledTimes(1) // the supersede branch ran
      expect(calls).toHaveLength(1) // nothing new spawned
      expect(outcome).toBeInstanceOf(DOMException)
      expect((outcome as DOMException).name).toBe('AbortError')
      expect(server.alive()).toBe(false)
      // The same path without an abort still starts.
      await expect(server.ensureStarted({ libraryXmlPath: other })).resolves.toMatchObject({ port: 8101 })
      expect(calls).toHaveLength(2)
      expect(calls[1]?.args).toContain(other)
    } finally {
      stopSpy.mockRestore()
      await server.stop()
    }
  })

  // #339 P8-1 (R-1 closure, auditable for BOTH binaries): an in-app install records a hash
  // for kiwix-serve, so `skip-legacy` now means exactly "a bundle placed by hand" — said once
  // per process (the kiwix-manage rule), never per start, never with a path. Once the warning
  // fired, any later "says nothing" holds whatever the verdict, so the silent verdicts come first.
  it('kiwix-serve logs one skip-legacy warning per process on a hashless install marker, and still starts', async () => {
    const warn = vi.spyOn(log, 'warn')
    const r1 = (): string[] =>
      warn.mock.calls
        .map((c) => c[0])
        .filter((m): m is string => typeof m === 'string' && m.includes('kiwix-serve') && m.includes('R-1'))
    const startAndStop = async (binPath?: string): Promise<void> => {
      const { server, calls } = makeServer({ binPath })
      await expect(server.ensureStarted({ libraryXmlPath: LIBRARY })).resolves.toMatchObject({ port: 8100 })
      expect(calls).toHaveLength(1) // spawned — none of these verdicts blocks
      await server.stop()
    }
    try {
      await startAndStop() // the unenforced real verifier: skip-dev
      initBinaryVerification(false)
      await startAndStop(await binaryWithMarker('kiwix-serve.exe', 'ok'))
      expect(r1()).toEqual([])

      const hashless = await binaryWithMarker('kiwix-serve.exe', 'legacy')
      await startAndStop(hashless)
      await startAndStop(hashless)
      expect(r1()).toHaveLength(1)
      expect(r1()[0]).not.toMatch(/[\\/]/)
    } finally {
      warn.mockRestore()
      _resetBinaryVerificationForTests()
    }
  })
})

// --- KiwixServer on its own: the per-child record boundary (H3) -----------------------
// The service's own pre-publication recheck would mask a missing recheck INSIDE the server,
// so these drive `KiwixServer` directly.

/** One macrotask, so a fake child's terminal event has reached every listener before the
 *  recorded state is read. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface ServeOnlyHarness {
  server: KiwixServer
  /** The spawned kiwix-serve children, in order. */
  spawns: ServeFakeChild[]
  hooks: { probe: () => Promise<boolean>; findPort: () => Promise<number> }
  nextChildMode: ServeChildMode
  /** Every child the bounded kill could not confirm stopped, as `onUnconfirmedChild` reported it. */
  unconfirmed: Array<{ libraryXmlPath: string; settled: Promise<void> }>
}

function serveOnlyHarness(): ServeOnlyHarness {
  const spawns: ServeFakeChild[] = []
  let pid = 9500
  let generation = 0
  const hooks = {
    probe: async (): Promise<boolean> => true,
    findPort: async (): Promise<number> => 8500 + spawns.length
  }
  const harness: ServeOnlyHarness = {
    spawns,
    hooks,
    nextChildMode: 'exit-on-sigterm',
    unconfirmed: [],
    server: null as unknown as KiwixServer
  }
  harness.server = new KiwixServer({
    binPath: '/bin/kiwix-serve',
    spawn: () => {
      const child = new ServeFakeChild(pid++, harness.nextChildMode)
      spawns.push(child)
      return child
    },
    findPort: () => hooks.findPort(),
    probe: () => hooks.probe(),
    allocateGeneration: () => ++generation,
    healthTimeoutMs: 1_000,
    healthIntervalMs: 1,
    killGraceMs: 5,
    forceKillWaitMs: 5,
    onUnconfirmedChild: (libraryXmlPath, settled) => harness.unconfirmed.push({ libraryXmlPath, settled })
  })
  return harness
}

describe('KiwixServer — per-child records (H3, P3a)', () => {
  it('a superseded start never publishes its child even when its parked probe finally succeeds', async () => {
    const h = serveOnlyHarness()
    h.nextChildMode = 'ignore-all' // it also never reaches a terminal state on its own
    const gate = serveGate<boolean>()
    h.hooks.probe = () => gate.wait()

    const start = h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    await gate.entered
    const stale = h.spawns[0]!
    const stopping = h.server.stop()
    gate.release(true) // the OLD probe succeeds — after the teardown began
    await expectAbortError(start)
    await stopping

    expect(h.server.alive()).toBe(false)
    expect(h.server.port()).toBeNull()
    expect(h.server.generation()).toBeNull()
    expect(h.server.current()).toBeNull()
    expect(stale.killCalls).toEqual([undefined, 'SIGKILL']) // bounded escalation, then given up
    // Reported with the build it was given, so the caller keeps that file (#713).
    expect(h.unconfirmed.map((u) => u.libraryXmlPath)).toEqual(['/ws/library.1.xml'])

    // The restart is an independent record with its own generation and its own path.
    h.nextChildMode = 'exit-on-sigterm'
    h.hooks.probe = async () => true
    const again = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.2.xml' })
    const live = h.spawns[1]!
    expect(h.server.current()).toEqual({
      port: again.port,
      generation: again.generation,
      libraryXmlPath: '/ws/library.2.xml'
    })

    // The obsolete record's LATE terminal event mutates only itself — and settles the report.
    let settled = false
    void h.unconfirmed[0]!.settled.then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    stale.emit('exit', 1, null)
    await tick()
    expect(settled).toBe(true)
    expect(h.server.alive()).toBe(true)
    expect(h.server.generation()).toBe(again.generation)
    expect(h.server.port()).toBe(again.port)
    expect(live.killCalls).toEqual([])
    await h.server.stop()
  })

  it('overlapping stops share ONE teardown pass (the translation single-flight shape)', async () => {
    const h = serveOnlyHarness()
    h.nextChildMode = 'ignore-sigterm' // a real grace window for a second stop to arrive in
    await h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    const child = h.spawns[0]!

    const firstStop = h.server.stop()
    const secondStop = h.server.stop() // arrives inside the SIGTERM → SIGKILL window
    expect(secondStop).toBe(firstStop) // the same pass, not a second no-op body
    await Promise.all([firstStop, secondStop])
    expect(child.killCalls).toEqual([undefined, 'SIGKILL']) // killed once, escalated once
    expect(h.server.alive()).toBe(false)
    expect(h.unconfirmed).toEqual([]) // SIGKILL took: nothing to keep
  })

  it('every child of the process takes a distinct generation, and a start aborted by a teardown leaves the next start free to spawn', async () => {
    const h = serveOnlyHarness()
    const first = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    await h.server.stop()
    const second = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(second.port).not.toBe(first.port)

    // An aborted start leaves nothing behind: the very next ensureStarted() spawns again
    // instead of rethrowing the abort.
    const gate = serveGate<boolean>()
    h.hooks.probe = () => gate.wait()
    const parked = h.server.ensureStarted({ libraryXmlPath: '/ws/library.2.xml' })
    await gate.entered
    const stopping = h.server.stop()
    gate.release(false)
    await expectAbortError(parked)
    await stopping
    h.hooks.probe = async () => true
    const third = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.2.xml' })
    expect(third.generation).toBeGreaterThan(second.generation)
    expect(h.spawns).toHaveLength(4)
    await h.server.stop()
  })
})

// #715: every suite injects 1–500 ms bounds. This one constructs the server without them and
// drives the shipped values on fake timers (D-Z10: "SIGTERM, 2 s, SIGKILL, 3 s"; the 20 s health
// window), each to just short of it and onto it.
describe('KiwixServer — the shipped bounds (#715)', () => {
  it('a child that never answers is killed 20 s in, escalated to SIGKILL 2 s later, and given up 3 s after that', async () => {
    const child = new ServeFakeChild(9900, 'ignore-all')
    let spawned = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      const server = new KiwixServer({
        binPath: '/bin/kiwix-serve',
        spawn: () => {
          spawned = true
          return child
        },
        findPort: async () => 8600,
        probe: async () => false,
        allocateGeneration: () => 1
      })
      let settled = false
      const outcome = server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' }).then(
        () => null,
        (err: unknown) => err
      )
      void outcome.then(() => (settled = true))
      // The verifier reads real files before the spawn; the health window opens at the spawn.
      await until(() => spawned, 'the kiwix-serve spawn after the verifier')

      await vi.advanceTimersByTimeAsync(20_000 - 1)
      expect(child.killCalls).toEqual([])
      // The deadline is read after each probe, so the kill lands within one health interval.
      for (let ms = 0; ms < 250 && child.killCalls.length === 0; ms++) await vi.advanceTimersByTimeAsync(1)
      expect(child.killCalls).toEqual([undefined])
      await vi.advanceTimersByTimeAsync(2_000 - 1)
      expect(child.killCalls).toEqual([undefined])
      await vi.advanceTimersByTimeAsync(1)
      expect(child.killCalls).toEqual([undefined, 'SIGKILL'])
      await vi.advanceTimersByTimeAsync(3_000 - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(String(await outcome)).toMatch(/did not become healthy within 20000ms/)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
      child.emit('exit', null, 'SIGKILL') // leaves the crash-reap registry
    }
  })
})
