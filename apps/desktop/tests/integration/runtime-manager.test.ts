import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { LlamaServer, type ChildProcessLike } from '../../src/main/services/runtime/sidecar'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'

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
