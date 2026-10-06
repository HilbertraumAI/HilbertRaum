import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createSelectingRuntimeFactory,
  createGpuCrashAutoFallback,
  createCpuCrashAutoRestart,
  COMPATIBILITY_MODE_NOTICE,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { GpuDevice } from '../../src/shared/types'
import { t } from '../../src/shared/i18n'
import { hangBudgetMs } from '../helpers/hang-budget'

// DX-5 (full-audit-2026-06-29 follow-up, Phase 7): pin the SPAWN-'exit' → onUnexpectedExit → GPU
// crash auto-fallback WIRING end-to-end.
//
// runtime-ladder.test.ts (unit) proves the ladder ROUTES a crash to onGpuCrash — but it does so by
// hand-invoking `calls[0].onUnexpectedExit(info)` on a STUB makeLlama. That proves the handler
// logic, NOT that the real sidecar actually wires its child's 'exit' event to that callback. A
// regression that dropped `child.once('exit', … onUnexpectedExit())` in sidecar.ts (or its
// `ready && !stopping` gate) would leave the unit test green while a real mid-session GPU crash
// silently failed to auto-fall back to CPU — the user's next message would just error.
//
// This drives the REAL `createLlamaRuntime` → `LlamaServer` (only the spawn / fetch / port seams
// injected, the e5/reranker/vision gated-child style), starts it to healthy on a probe that reports
// a GPU (so backend === 'gpu'), then emits a REAL 'exit' on the spawned child and asserts the GPU
// crash auto-fallback fired (persisted failure + compatibility notice + the single CPU restart).
//
// TEETH-CHECK (recorded in architecture.md "Test-enforcement seams", Phase-7 subsection): neuter
// the wiring in sidecar.ts — drop the `this.opts.onUnexpectedExit?.({…})` call inside the
// `child.once('exit', …)` handler (or its `ready && !stopping` gate) → no crash reaches the ladder
// → `restarts`/`persisted` stay empty → this test reds.

const opts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }
const RTX: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }

/** A controllable sidecar child: becomes healthy via the injected fetch, then we emit 'exit'/stderr
 *  by hand. Real `ChildProcess` 'exit'/'error'/stderr semantics — nothing about the wiring is faked. */
class FakeServerChild extends EventEmitter implements ChildProcessLike {
  pid = 4242
  killed = false
  /** Piped stderr the LlamaServer drains into its tail (emit 'data' to populate the crash tail). */
  readonly stderr = new EventEmitter()
  kill(): boolean {
    this.killed = true
    return true
  }
  unref(): void {}
}

function fakeSpawn() {
  const children: FakeServerChild[] = []
  const spawn = (): ChildProcessLike => {
    const child = new FakeServerChild()
    children.push(child)
    return child
  }
  return { spawn, children }
}

/** /health → ok; /v1/chat/completions serves the #109 warm-up generation the ladder now runs
 *  inside start() (one tiny SSE reply, instantly done); nothing else is reached before the crash. */
const healthOkFetch = (async (url: string | URL) => {
  if (String(url).endsWith('/health')) return { ok: true, status: 200 } as Response
  if (String(url).endsWith('/v1/chat/completions')) {
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse))
        c.close()
      }
    })
    return { ok: true, status: 200, body } as unknown as Response
  }
  throw new Error(`unexpected url ${String(url)}`)
}) as typeof fetch

describe('GPU crash auto-fallback is wired to the real sidecar exit event (DX-5)', () => {
  it('a healthy GPU child that emits a real "exit" triggers persist + notify + one CPU restart', async () => {
    const { spawn, children } = fakeSpawn()
    const restarts: RuntimeStartOptions[] = []
    const persisted: string[] = []
    const notices: string[] = []

    // The §5.3 mid-session crash handler — the genuine recovery, not a stub.
    const onGpuCrash = createGpuCrashAutoFallback({
      restart: async (o) => {
        restarts.push(o)
      },
      persistFailure: (reason) => persisted.push(reason),
      notify: (m) => notices.push(m)
    })

    // The REAL ladder, but makeLlama builds the REAL LlamaRuntime with the spawn/fetch/port seams
    // injected (so the real `LlamaServer.doStart` 'exit' wiring runs without a binary).
    const factory = createSelectingRuntimeFactory({
      rootPath: '/root',
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true,
      makeLlama: (o: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions): ModelRuntime =>
        createLlamaRuntime(o, {
          binPath,
          extraArgs: rung?.extraArgs,
          onUnexpectedExit: rung?.onUnexpectedExit,
          spawn,
          fetchImpl: healthOkFetch,
          findPort: async () => 50_000,
          healthIntervalMs: 1
        }),
      gpu: {
        getGpuMode: () => 'auto',
        probeDevices: async () => [RTX], // rung-1 lands on backend 'gpu'
        onGpuCrash
      }
    })

    const runtime = factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('gpu') // the crash route is armed only for a GPU landing
    expect(children).toHaveLength(1)

    // A mid-session crash: stderr tail, then a REAL 'exit' (SIGABRT-like code 134). This is the
    // event the wiring must carry to onUnexpectedExit → the ladder → onGpuCrash.
    children[0].stderr.emit('data', 'vk error: device lost')
    children[0].emit('exit', 134, null)
    await Promise.resolve() // flush the auto-fallback's microtask

    expect(restarts).toHaveLength(1) // recovery fired ONCE
    expect(restarts[0].modelId).toBe('m') // …restarting the SAME model (now at the CPU rung)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toContain('code 134') // the real exit code flowed through the wiring
    expect(persisted[0]).toContain('vk error: device lost') // …and the captured stderr tail
    expect(notices).toEqual([COMPATIBILITY_MODE_NOTICE]) // friendly §11.4 copy

    await runtime.stop()
  })
})

// #599: a CPU-mode crash (or an OS kill) used to be dropped by the ladder — every surface kept saying
// "running" and each later turn failed on the dead port. Same real exit wiring; the owner's policy:
// one restart per model per session, then the model is left stopped, each with a notice.
describe('a CPU-mode crash restarts the model once per session, then stops it (#599)', () => {
  it('the first crash of a model restarts it; its second stops it; another model gets its own restart', async () => {
    const { spawn, children } = fakeSpawn()
    const restarts: string[] = []
    const stops: string[] = []
    const notices: string[] = []
    const onCpuCrash = createCpuCrashAutoRestart({
      restart: async (o) => {
        restarts.push(o.modelId)
      },
      stop: async (o) => {
        stops.push(o.modelId)
      },
      notify: (m) => notices.push(m)
    })
    const onGpuCrash = (): void => {
      throw new Error('a CPU-mode crash must never reach the GPU fallback')
    }
    const factory = createSelectingRuntimeFactory({
      rootPath: '/root',
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true,
      makeLlama: (o: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions): ModelRuntime =>
        createLlamaRuntime(o, {
          binPath,
          extraArgs: rung?.extraArgs,
          onUnexpectedExit: rung?.onUnexpectedExit,
          spawn,
          fetchImpl: healthOkFetch,
          findPort: async () => 50_000,
          healthIntervalMs: 1
        }),
      gpu: { getGpuMode: () => 'auto', probeDevices: async () => [], onGpuCrash, onCpuCrash }
    })
    const crash = async (modelId: string): Promise<void> => {
      const runtime = factory({ ...opts, modelId })
      await runtime.start()
      expect(runtime.backend).toBe('cpu')
      children[children.length - 1].emit('exit', null, 'SIGKILL')
      await Promise.resolve()
      await runtime.stop()
    }

    await crash('m')
    expect({ restarts, stops }).toEqual({ restarts: ['m'], stops: [] })
    expect(notices).toEqual([t('en', 'main.runtime.crashRestarting')])

    await crash('m') // the restarted model crashes again
    expect({ restarts, stops }).toEqual({ restarts: ['m'], stops: ['m'] })
    expect(notices[1]).toBe(t('en', 'main.runtime.crashStopped'))

    await crash('other')
    expect(restarts).toEqual(['m', 'other'])
  })
})

describe('the CPU crash handler counts one crash once, and never during a lock (#599)', () => {
  function wired(opts2: { admits?: () => boolean; probe?: () => Promise<GpuDevice[] | null> } = {}) {
    const { spawn, children } = fakeSpawn()
    const calls: string[] = []
    const health = { answered: false }
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const res = await healthOkFetch(url, init)
      if (String(url).endsWith('/health')) health.answered = true
      return res
    }) as typeof fetch
    const onCpuCrash = createCpuCrashAutoRestart({
      restart: async (o) => {
        calls.push(`restart ${o.modelId}`)
      },
      stop: async (o) => {
        calls.push(`stop ${o.modelId}`)
      },
      admitsWork: opts2.admits,
      notify: (m) => calls.push(m === t('en', 'main.runtime.crashRestarting') ? 'notice restarting' : 'notice stopped')
    })
    const factory = createSelectingRuntimeFactory({
      rootPath: '/root',
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true,
      makeLlama: (o: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions): ModelRuntime =>
        createLlamaRuntime(o, {
          binPath,
          extraArgs: rung?.extraArgs,
          onUnexpectedExit: rung?.onUnexpectedExit,
          spawn,
          fetchImpl,
          findPort: async () => 50_000,
          healthIntervalMs: 1
        }),
      gpu: { getGpuMode: () => 'auto', probeDevices: opts2.probe ?? (async () => []), onCpuCrash }
    })
    return { factory, children, calls, health }
  }

  it("a sidecar that reports one exit twice ('error', then 'exit') restarts once", async () => {
    const { factory, children, calls } = wired()
    const runtime = factory(opts)
    await runtime.start()
    children[0].emit('error', new Error('read EPIPE'))
    children[0].emit('exit', null, 'SIGKILL')
    await Promise.resolve()
    expect(calls).toEqual(['notice restarting', 'restart m'])
    await runtime.stop()
  })

  it('a crash during a lock neither restarts nor spends the restart', async () => {
    let admits = false
    const { factory, children, calls } = wired({ admits: () => admits })
    for (const _ of [0, 1]) {
      const runtime = factory(opts)
      await runtime.start()
      children[children.length - 1].emit('exit', 1, null)
      await Promise.resolve()
      await runtime.stop()
      admits = true // unlocked again before the next crash
    }
    expect(calls).toEqual(['notice restarting', 'restart m']) // the first crash the user sees restarts
  })

  it('an exit before the GPU probe labels the backend is not a CPU-mode crash', async () => {
    let resolveProbe!: (d: GpuDevice[]) => void
    const probeGate = new Promise<GpuDevice[]>((r) => (resolveProbe = r))
    const { factory, children, calls, health } = wired({ probe: () => probeGate })
    const runtime = factory(opts)
    const starting = runtime.start().catch(() => undefined)
    // Healthy (its /health answered), so its exit is reported; the ladder now waits on the probe.
    const end = Date.now() + hangBudgetMs(5_000)
    while (!health.answered && Date.now() < end) await new Promise((r) => setImmediate(r))
    expect(health.answered).toBe(true)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    children[0].emit('exit', 134, null) // a rung-1 (GPU) server dying before its label settled
    await Promise.resolve()
    expect(calls).toEqual([])
    resolveProbe([RTX])
    await starting
    await runtime.stop()
  })
})
