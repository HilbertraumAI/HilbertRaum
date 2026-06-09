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
