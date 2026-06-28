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
