import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createSelectingRuntimeFactory,
  createGpuCrashAutoFallback,
  COMPATIBILITY_MODE_NOTICE,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { GpuDevice } from '../../src/shared/types'

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

/** /health → ok; nothing else is reached before the crash. */
const healthOkFetch = (async (url: string | URL) => {
  if (String(url).endsWith('/health')) return { ok: true, status: 200 } as Response
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
