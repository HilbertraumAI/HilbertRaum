import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  LlamaServer,
  type ChildProcessLike,
  type SpawnFn,
  type UnexpectedExitInfo
} from '../../src/main/services/runtime/sidecar'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import {
  createSelectingRuntimeFactory,
  createGpuCrashAutoFallback,
  COMPATIBILITY_MODE_NOTICE,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { performShutdown } from '../../src/main/shutdown'
import type { AppContext } from '../../src/main/services/context'
import type { GpuDevice } from '../../src/shared/types'

// Regression tests for the two runtime-lifecycle fixes:
//  B1 — LlamaServer.stop() must escalate to SIGKILL when the child ignores SIGTERM
//       (the escalation gated on `this.exited`, not the always-true `child.killed`).
//  B2 — RuntimeManager.start() must NOT leave a half-started runtime as "active" when
//       start()/health() throws (callers gate chat/RAG on active() != null).

/** A child that records the signals it receives; only exits when told which signal does. */
class RecordingChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  signals: Array<string | undefined> = []
  constructor(private readonly exitOn: 'SIGTERM' | 'SIGKILL') {
    super()
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal === undefined ? undefined : String(signal))
    this.killed = true
    // SIGTERM is delivered as kill() with no signal arg; SIGKILL is explicit.
    const isTerm = signal === undefined || signal === 'SIGTERM'
    if ((this.exitOn === 'SIGTERM' && isTerm) || (this.exitOn === 'SIGKILL' && signal === 'SIGKILL')) {
      queueMicrotask(() => this.emit('exit', 0, signal ?? null))
    }
    return true
  }
}

function healthOnlyFetch(): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith('/health')) return { ok: true, status: 200 } as Response
    throw new Error('unexpected url')
  }) as typeof fetch
}

function makeServer(child: ChildProcessLike): LlamaServer {
  return new LlamaServer({
    binPath: '/bin/llama-server',
    modelPath: '/m.gguf',
    contextTokens: 2048,
    spawn: () => child,
    fetchImpl: healthOnlyFetch(),
    findPort: async () => 51010,
    healthIntervalMs: 1,
    killGraceMs: 10 // tiny grace so the escalation path is fast to test
  })
}

describe('LlamaServer.stop() — B1 force-kill escalation', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const child = new RecordingChild('SIGKILL') // ignores SIGTERM
    const server = makeServer(child)
    await server.start()
    await server.stop()
    // First a polite SIGTERM (no arg), then the SIGKILL escalation after the grace window.
    expect(child.signals).toContain('SIGKILL')
    expect(child.signals[0]).toBeUndefined()
  })

  it('does NOT escalate when the child exits on the polite SIGTERM', async () => {
    const child = new RecordingChild('SIGTERM')
    const server = makeServer(child)
    await server.start()
    await server.stop()
    // Only the polite signal was sent; no SIGKILL needed.
    expect(child.signals).toEqual([undefined])
  })
})

describe('RuntimeManager.start() — B2 reset on failed start', () => {
  const opts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }

  function runtime(over: Partial<ModelRuntime> & { onStop?: () => void }): ModelRuntime {
    return {
      modelId: 'm',
      start: async () => {},
      stop: async () => over.onStop?.(),
      health: async () => ({ healthy: true, message: '', port: 1 }),
      chatStream: async function* () {},
      ...over
    }
  }

  it('leaves no active runtime when start() throws, and cleans up the failed runtime', async () => {
    let stopped = false
    const failing = runtime({
      start: async () => {
        throw new Error('llama-server health timeout')
      },
      onStop: () => {
        stopped = true
      }
    })
    const mgr = new RuntimeManager(() => failing)

    await expect(mgr.start(opts)).rejects.toThrow(/health timeout/)
    // No stale "active" runtime — chat/RAG gate on active() != null.
    expect(mgr.active()).toBeNull()
    expect(mgr.activeModelId()).toBeNull()
    expect(mgr.status().running).toBe(false)
    // The half-started runtime was stopped (best-effort cleanup).
    expect(stopped).toBe(true)
  })

  it('also resets when health() throws after a successful start', async () => {
    const failing = runtime({
      health: async () => {
        throw new Error('health probe blew up')
      }
    })
    const mgr = new RuntimeManager(() => failing)
    await expect(mgr.start(opts)).rejects.toThrow(/health probe/)
    expect(mgr.active()).toBeNull()
  })

  // H2 (audit round 4): start/stop must be SERIALIZED. A real GGUF start can take up
  // to the health timeout; in that window a second start() used to skip the stop
  // (current was still null) and spawn a second, never-stopped llama-server (orphan),
  // and a stop() used to be a silent no-op the in-flight start then overrode. A model
  // SWITCH (start A, then start B) must stop A before starting B.
  it('serializes a model switch — the first runtime is stopped, never orphaned', async () => {
    const events: string[] = []
    const gate: { release: (() => void) | null } = { release: null }
    const mgr = new RuntimeManager((o) =>
      runtime({
        modelId: o.modelId,
        start: async () => {
          events.push(`start:${o.modelId}`)
          if (o.modelId === 'a') await new Promise<void>((resolve) => (gate.release = resolve))
        },
        onStop: () => events.push(`stop:${o.modelId}`)
      })
    )

    const p1 = mgr.start({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 2048 })
    const p2 = mgr.start({ modelId: 'b', modelPath: '/b.gguf', contextTokens: 2048 })
    // Let A finish loading; B must then stop A before starting B.
    await new Promise((r) => setTimeout(r, 0))
    gate.release?.()
    await Promise.all([p1, p2])

    expect(events).toEqual(['start:a', 'stop:a', 'start:b'])
    expect(mgr.activeModelId()).toBe('b')
  })

  // The reported double-start bug: clicking Start twice for the SAME model (or revisiting
  // the AI Model screen before the GGUF finished loading) used to stop-and-restart the
  // runtime — two "Start runtime" log lines, two backend selections. start() is now
  // idempotent for the in-flight/running model, and exposes `startingModelId` so the UI
  // can disable the button.
  it('is idempotent for the same model — a double-start does not restart it', async () => {
    const events: string[] = []
    const gate: { release: (() => void) | null } = { release: null }
    const mgr = new RuntimeManager((o) =>
      runtime({
        modelId: o.modelId,
        start: async () => {
          events.push(`start:${o.modelId}`)
          await new Promise<void>((resolve) => (gate.release = resolve))
        },
        onStop: () => events.push(`stop:${o.modelId}`)
      })
    )

    const p1 = mgr.start(opts) // opts.modelId === 'm'
    // The in-flight model is visible immediately (server truth for the disabled button).
    expect(mgr.status().startingModelId).toBe('m')
    const p2 = mgr.start(opts) // a double-click while m is still loading
    await new Promise((r) => setTimeout(r, 0)) // let m's start() run and arm the gate
    gate.release?.()
    const [s1, s2] = await Promise.all([p1, p2])

    expect(events).toEqual(['start:m']) // ONE start, no stop/restart
    expect(mgr.activeModelId()).toBe('m')
    expect(s1.running).toBe(true)
    expect(s2.running).toBe(true)
    expect(mgr.status().startingModelId).toBeNull() // cleared once settled
  })

  // Starting the model that is ALREADY running is a no-op too (the AI Model screen shows
  // Stop, but a stale tab or race could still call start).
  it('is idempotent for the already-running model', async () => {
    const events: string[] = []
    const mgr = new RuntimeManager((o) =>
      runtime({
        modelId: o.modelId,
        start: async () => {
          events.push(`start:${o.modelId}`)
        },
        onStop: () => events.push(`stop:${o.modelId}`)
      })
    )
    await mgr.start(opts)
    await mgr.start(opts) // already running
    expect(events).toEqual(['start:m'])
    expect(mgr.activeModelId()).toBe('m')
  })

  it('stop() during an in-flight start stops the runtime that start committed', async () => {
    const events: string[] = []
    const gate: { release: (() => void) | null } = { release: null }
    const mgr = new RuntimeManager(() =>
      runtime({
        modelId: 'r1',
        start: async () => {
          events.push('start:r1')
          await new Promise<void>((resolve) => (gate.release = resolve))
        },
        onStop: () => events.push('stop:r1')
      })
    )

    const p1 = mgr.start(opts)
    const pStop = mgr.stop() // user clicks Stop (or the app quits) mid-load
    await new Promise((r) => setTimeout(r, 0))
    gate.release?.()
    await Promise.all([p1, pStop])

    expect(events).toEqual(['start:r1', 'stop:r1'])
    expect(mgr.active()).toBeNull()
    expect(mgr.status().running).toBe(false)
  })

  it('a later successful start works after an earlier failed one', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    const mgr = new RuntimeManager(() =>
      runtime({
        modelId: mode === 'ok' ? 'good' : 'bad',
        start: async () => {
          if (mode === 'fail') throw new Error('boom')
        }
      })
    )
    await expect(mgr.start(opts)).rejects.toThrow(/boom/)
    expect(mgr.active()).toBeNull()
    mode = 'ok'
    const status = await mgr.start(opts)
    expect(status.running).toBe(true)
    expect(mgr.activeModelId()).toBe('good')
  })
})

// REL-1 (audit 2026-06-28) — the GPU mid-session crash auto-fallback, wired THROUGH the real
// RuntimeManager + the real createSelectingRuntimeFactory + the real createGpuCrashAutoFallback,
// with the fake placed at the SPAWN/child level (no fake `restart` is injected — the production
// `restart → manager.forceRestart` wiring is exercised verbatim). This is the path the existing
// runtime-ladder/runtime-manager unit tests never connected: ladder tests inject a fake `restart`
// (so the manager interaction is skipped) and manager tests prove the idempotency guard in
// isolation. Before the fix, the crash restart hit that guard (the crashed runtime is still
// `current` with the same modelId) and was silently swallowed.

const CRASH_OPTS: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }
const RTX: GpuDevice = {
  id: 'Vulkan0',
  name: 'NVIDIA GeForce RTX 3080 Ti',
  totalMb: 12300,
  freeMb: 11511
}

/** A fake llama-server child: it never exits on its own until `crash()` is called. */
class FakeServerChild extends EventEmitter implements ChildProcessLike {
  readonly pid: number
  killed = false
  exited = false
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    if (!this.exited) {
      this.exited = true
      queueMicrotask(() => this.emit('exit', 0, signal ?? null))
    }
    return true
  }
  /** Simulate a mid-session crash: a healthy server dies on its own (driver crash / VRAM theft). */
  crash(code: number): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, null)
  }
}

/**
 * Wire the REAL stack exactly as `main/index.ts` does — `createGpuCrashAutoFallback` →
 * `manager.forceRestart`, `createSelectingRuntimeFactory` with the ladder hooks, `RuntimeManager`
 * — but inject a fake child at the spawn seam and a loopback `fetch` that only answers for a LIVE
 * child's port (so a request routed to a dead server actually fails, the way it would in prod).
 */
function crashHarness() {
  let pidSeq = 100
  let portSeq = 52000
  let pendingPort = 0
  const children: Array<{ child: FakeServerChild; args: string[]; port: number }> = []
  const liveByPort = new Map<number, FakeServerChild>()

  const findPort = async (): Promise<number> => {
    pendingPort = ++portSeq
    return pendingPort
  }
  const spawn: SpawnFn = (_command, args) => {
    const child = new FakeServerChild(++pidSeq)
    liveByPort.set(pendingPort, child)
    children.push({ child, args, port: pendingPort })
    return child
  }
  const fetchImpl = (async (url: string | URL) => {
    const u = new URL(String(url))
    const child = liveByPort.get(Number(u.port))
    // A crashed server's socket is gone — refuse the connection, so a chat/health routed to the
    // dead runtime genuinely fails (this is what gives the post-crash chat assertion its teeth).
    if (!child || child.exited) throw new Error('connect ECONNREFUSED (llama-server is gone)')
    if (u.pathname === '/health') return { ok: true, status: 200 } as Response
    if (u.pathname === '/v1/chat/completions') {
      const sse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse))
          c.close()
        }
      })
      return { ok: true, status: 200, body } as unknown as Response
    }
    throw new Error(`unexpected url ${u.pathname}`)
  }) as typeof fetch

  // The makeLlama seam builds the REAL LlamaRuntime over the fake child (so the real LlamaServer
  // unexpected-exit hook → LadderRuntime → onGpuCrash chain runs); we spy each runtime's stop()
  // to count the stops the crash path drives.
  const made: Array<{ stops: number; extraArgs: string[] }> = []
  const makeLlama = (o: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions): ModelRuntime => {
    const rt = createLlamaRuntime(o, {
      binPath,
      extraArgs: rung?.extraArgs,
      onUnexpectedExit: rung?.onUnexpectedExit,
      spawn,
      fetchImpl,
      findPort,
      healthIntervalMs: 1
    })
    const rec = { stops: 0, extraArgs: rung?.extraArgs ?? [] }
    const origStop = rt.stop.bind(rt)
    ;(rt as { stop: () => Promise<void> }).stop = async () => {
      rec.stops++
      return origStop()
    }
    made.push(rec)
    return rt
  }

  let gpuAutoDisabled = false
  const persisted: string[] = []
  const notices: string[] = []

  // Late-bind the manager into the crash fallback, exactly as main/index.ts does.
  let mgrRef: RuntimeManager | null = null
  const restartPromises: Array<Promise<unknown>> = []
  const fallback = createGpuCrashAutoFallback({
    restart: (o) => {
      const p = mgrRef!.forceRestart(o)
      restartPromises.push(p)
      return p
    },
    persistFailure: (reason) => {
      gpuAutoDisabled = true // before the restart → the rebuilt ladder skips rung 1 → CPU
      persisted.push(reason)
    },
    notify: (m) => notices.push(m)
  })

  const factory = createSelectingRuntimeFactory({
    rootPath: '/root',
    resolveBin: () => '/bin/llama-server',
    modelExists: () => true,
    makeLlama,
    gpu: {
      getGpuMode: () => 'auto',
      getGpuAutoDisabled: () => gpuAutoDisabled,
      onGpuFailure: (reason) => persisted.push(reason),
      probeDevices: async () => (gpuAutoDisabled ? [] : [RTX]),
      resolveCpuBin: () => null,
      onGpuCrash: (o, info) => fallback(o, info)
    }
  })
  const mgr = new RuntimeManager(factory)
  mgrRef = mgr

  return {
    mgr,
    children,
    made,
    persisted,
    notices,
    restartPromises,
    gpuDisabled: () => gpuAutoDisabled
  }
}

describe('GPU mid-session crash auto-fallback through the real manager (REL-1)', () => {
  it('forces a real CPU restart on an unexpected exit — exactly one stop + one start, status reflects the NEW server', async () => {
    const h = crashHarness()

    // 1. A GPU-backed runtime is current + healthy.
    const start = await h.mgr.start(CRASH_OPTS)
    expect(start.backend).toBe('gpu')
    expect(h.mgr.status().healthy).toBe(true)
    expect(h.children).toHaveLength(1)
    const deadPort = h.children[0].port

    // 2. The GPU server dies mid-session (driver crash / VRAM stolen).
    h.children[0].child.crash(134)
    // The fallback fires `restart` fire-and-forget (`void restart(opts)`); await its completion.
    await Promise.all(h.restartPromises)
    expect(h.restartPromises).toHaveLength(1)

    // 3. The real path actually restarted: one new spawn (not zero = swallowed, not a loop),
    //    the dead runtime stopped exactly once, the new backend is CPU, and status() reflects
    //    the NEW server — not the dead one whose cached health used to be reported as live.
    expect(h.children).toHaveLength(2)
    expect(h.made[0].stops).toBe(1) // the crashed runtime was stopped
    expect(h.made[1].stops).toBe(0) // the restarted runtime is still live
    expect(h.children[0].args).not.toContain('none') // rung 1 — GPU auto-offload
    expect(h.children[1].args).toContain('none') // rung 2 — `--device none` (forced CPU)
    expect(h.gpuDisabled()).toBe(true) // persisted before the restart (retry lands on CPU)
    expect(h.notices).toEqual([COMPATIBILITY_MODE_NOTICE])

    const status = h.mgr.status()
    expect(status.backend).toBe('cpu')
    expect(status.healthy).toBe(true)
    expect(status.modelId).toBe('m')
    expect(status.port).toBe(h.children[1].port)
    expect(status.port).not.toBe(deadPort)

    // 4. A chat turn AFTER the crash succeeds against the restarted (CPU) server. On the pre-fix
    //    code this routed to the dead server's refused socket and threw.
    const tokens: string[] = []
    for await (const tok of h.mgr.active()!.chatStream([{ role: 'user', content: 'hi' }])) {
      tokens.push(tok)
    }
    expect(tokens.join('')).toBe('hello')

    // 5. T8 (post-merge audit Phase 5): `made[0].stops===1` above only counts the stop() WRAPPER —
    //    it would still hold if stop() stopped reaching the child kill (an orphan). Pin the REAL
    //    reap on observable child state. The crashed child already exited, so the manager correctly
    //    does NOT re-kill it (no orphan to reap) — its `killed` stays false; what must hold is that
    //    the LIVE restarted CPU child is genuinely killed by the manager's stop(). (DIVERGES from the
    //    audit's literal "crashed child killed===true", which is false on correct code — the crashed
    //    child is already dead, so stop() early-returns on `this.exited` before any kill.)
    expect(h.children[0].child.exited).toBe(true) // the crashed GPU child is genuinely dead
    await h.mgr.stop()
    expect(h.children[1].child.killed).toBe(true) // stop() reached the LIVE child's kill — real reap
  })

  it('does NOT loop: a CPU restart that itself crashes does not auto-fall-back again', async () => {
    const h = crashHarness()
    await h.mgr.start(CRASH_OPTS)

    // First (GPU) crash → one CPU restart.
    h.children[0].child.crash(134)
    await Promise.all(h.restartPromises)
    expect(h.children).toHaveLength(2)
    expect(h.mgr.status().backend).toBe('cpu')

    // Crash the restarted CPU server too. A CPU crash is NOT a GPU-fallback case (LadderRuntime
    // gates onGpuCrash on backend === 'gpu'), so no further restart is triggered.
    h.children[1].child.crash(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.restartPromises).toHaveLength(1) // still exactly one — no loop
    expect(h.children).toHaveLength(2) // no third spawn
  })
})

// ---- Phase C (full-audit 2026-07-11): CODE-2 cancellable start + CODE-3 shutdown latch ----
//
// CODE-2: `stop()` used to QUEUE behind an uncancellable in-flight start — a 20 GB GGUF load
// (or a failing ladder walking up to 3 rungs × 180 s health timeouts) held the queue for
// minutes while quit and "Lock now" both awaited it; users hard-kill, which orphans the
// loading child — the exact outcome the queue exists to prevent. `LlamaServer.stop()`
// DURING `waitForHealthy` already worked one layer down (the exit-check throw); these tests
// pin that the manager's stop now actually REACHES it.
// CODE-3: `performShutdown` had no latch, so an auto-start whose multi-GB weight hash
// completed during the ~7 s of awaited teardown windows could enqueue a fresh start AFTER
// the stop; `app.exit(0)` then killed the parent mid-start and orphaned the child.

const QUIT_OPTS: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }

/**
 * The REAL ladder + REAL LlamaRuntime/LlamaServer over a fake child that never turns
 * healthy (a slow multi-GB load, /health stays 503). `healthTimeoutMs` is 60 s so the
 * PRE-fix behavior (stop waits out the whole timeout) reds as a test timeout, while the
 * fixed prompt-cancel path settles in milliseconds.
 */
function loadingStartHarness() {
  const child = new RecordingChild('SIGTERM')
  let spawned = 0
  const failures: string[] = []
  let mockMade = false
  const makeLlama = (o: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions): ModelRuntime =>
    createLlamaRuntime(o, {
      binPath,
      extraArgs: rung?.extraArgs,
      onUnexpectedExit: rung?.onUnexpectedExit,
      spawn: () => {
        spawned++
        return child
      },
      fetchImpl: (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch,
      findPort: async () => 52100,
      healthTimeoutMs: 60_000,
      healthIntervalMs: 5
      // (no killGraceMs seam through LlamaRuntimeDeps — irrelevant: the fake child dies on SIGTERM)
    })
  const factory = createSelectingRuntimeFactory({
    rootPath: '/root',
    resolveBin: () => '/bin/llama-server',
    modelExists: () => true,
    makeLlama,
    makeMock: (o) => {
      mockMade = true
      return {
        modelId: o.modelId,
        backend: 'mock',
        start: async () => {},
        stop: async () => {},
        health: async () => ({ healthy: true, message: 'mock', port: null }),
        chatStream: async function* () {}
      }
    },
    gpu: {
      probeDevices: async () => [],
      onGpuFailure: (r) => failures.push(r),
      resolveCpuBin: () => null
    }
  })
  return {
    mgr: new RuntimeManager(factory),
    child,
    failures,
    spawnCount: () => spawned,
    wasMock: () => mockMade
  }
}

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('quit-path lifecycle (full-audit 2026-07-11 CODE-2/CODE-3)', () => {
  it(
    'stop() mid-start kills the loading child and settles promptly (CODE-2, mid-waitForHealthy)',
    { timeout: 15_000 },
    async () => {
      const h = loadingStartHarness()
      const startP = h.mgr.start(QUIT_OPTS)
      startP.catch(() => undefined) // asserted below; pre-arm so no unhandled rejection
      while (h.spawnCount() === 0) await tick()
      const t0 = Date.now()
      await h.mgr.stop() // pre-fix: queued behind the full 60 s health timeout → test timeout
      expect(Date.now() - t0).toBeLessThan(5_000)
      expect(h.child.killed).toBe(true)
      await expect(startP).rejects.toThrow(/cancelled/i)
      // A start killed by the cancel is NOT a GPU fault — nothing persists gpuAutoDisabled…
      expect(h.failures).toEqual([])
      // …and the ladder walk aborted: no rung-2 respawn, no mock fallback for a cancelled start.
      expect(h.spawnCount()).toBe(1)
      expect(h.wasMock()).toBe(false)
      expect(h.mgr.active()).toBeNull()
      expect(h.mgr.status().running).toBe(false)
    }
  )

  it(
    'performShutdown during a model start settles promptly and latches the manager (CODE-2/CODE-3 quit path)',
    { timeout: 15_000 },
    async () => {
      const h = loadingStartHarness()
      const startP = h.mgr.start(QUIT_OPTS)
      startP.catch(() => undefined)
      while (h.spawnCount() === 0) await tick()

      const ctx = {
        runtime: h.mgr,
        embedder: {},
        workspace: { shutdown: () => undefined }
      } as unknown as AppContext
      await performShutdown(ctx, {
        inFlightStreams: new Map(),
        streamSettled: new Map(),
        detachVaultKey: () => undefined,
        log: { error: () => undefined }
      })

      expect(h.child.killed).toBe(true) // the loading child died with the teardown — no orphan
      await expect(startP).rejects.toThrow()
      // The latch is armed: a late auto-start (its weight hash just completed) can't spawn.
      await expect(h.mgr.start(QUIT_OPTS)).rejects.toThrow(/shut down/i)
      expect(h.spawnCount()).toBe(1)
    }
  )

  it('start() after shutdown() rejects WITHOUT invoking the factory (CODE-3)', async () => {
    let made = 0
    const mgr = new RuntimeManager(() => {
      made++
      return {
        modelId: 'm',
        start: async () => {},
        stop: async () => {},
        health: async () => ({ healthy: true, message: '', port: 1 }),
        chatStream: async function* () {}
      }
    })
    mgr.shutdown()
    expect(mgr.isShutdown()).toBe(true)
    await expect(mgr.start(QUIT_OPTS)).rejects.toThrow(/shut down/i)
    await expect(mgr.forceRestart(QUIT_OPTS)).rejects.toThrow(/shut down/i) // crash restart too
    expect(made).toBe(0)
    // stop() still works after the latch (it IS the teardown) — a no-op here.
    await expect(mgr.stop()).resolves.toBeUndefined()
  })

  it('a start already ENQUEUED when shutdown() arms never spawns (CODE-3)', async () => {
    const events: string[] = []
    const gate: { release: (() => void) | null } = { release: null }
    let made = 0
    const mgr = new RuntimeManager((o) => {
      made++
      return {
        modelId: o.modelId,
        start: async () => {
          events.push(`start:${o.modelId}`)
          if (o.modelId === 'a') await new Promise<void>((r) => (gate.release = r))
        },
        stop: async () => {
          events.push(`stop:${o.modelId}`)
        },
        health: async () => ({ healthy: true, message: '', port: 1 }),
        chatStream: async function* () {}
      }
    })
    const p1 = mgr.start({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 2048 })
    // b is enqueued BEHIND a's in-flight start (a switch) — it passed start()'s entry check
    // before the latch armed, so only doStart's re-check can stop it from spawning.
    const p2 = mgr.start({ modelId: 'b', modelPath: '/b.gguf', contextTokens: 2048 })
    await tick(0)
    mgr.shutdown() // quit begins while b still sits in the queue
    gate.release?.()
    await p1 // a committed (it started before the latch)
    await expect(p2).rejects.toThrow(/shut down/i)
    expect(made).toBe(1) // b's factory was NEVER invoked
    expect(events).toEqual(['start:a'])
  })
})

describe('LlamaServer.start() — REL-2 single-flight', () => {
  it('two concurrent start() calls spawn exactly one child', async () => {
    let spawns = 0
    const child = new RecordingChild('SIGTERM')
    const server = new LlamaServer({
      binPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn: () => {
        spawns++
        return child
      },
      fetchImpl: healthOnlyFetch(),
      findPort: async () => 51011,
      verifyBinary: async () => 'ok',
      healthIntervalMs: 1
    })

    // Both calls race past the (pre-assignment) `if (this.child)` guard; the single-flight latch
    // must collapse them to ONE spawn and resolve both only once the server is healthy.
    await Promise.all([server.start(), server.start()])
    expect(spawns).toBe(1)
    expect((await server.health()).healthy).toBe(true)
  })
})
