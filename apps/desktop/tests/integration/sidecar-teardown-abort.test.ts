import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { E5Embedder } from '../../src/main/services/embeddings/e5'
import { LlamaReranker } from '../../src/main/services/reranker/llama'
import { VisionRuntime } from '../../src/main/services/vision/runtime'
import { TranslationRuntime } from '../../src/main/services/translation/runtime'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// #244 (port of the review's B8 reproduction): a lock or quit that lands
// during a NEVER-HEALTHY cold start of a lazily-started llama-server must settle in about one
// health-poll interval, not the full 180 s health window. Before the fix, only the translation
// runtime (#159 / BE-1) aborted an in-flight start; the E5 embedder, the reranker and the vision
// runtime awaited the whole spawn + health wait of a child they were about to kill anyway —
// measured at 180 250 ms each (production defaults: 180 000 ms health timeout, 250 ms poll cap)
// against 250 ms for translation — and the timed-out start then armed each wrapper's
// `startFailed` latch, so the NEXT start after unlock was refused too (sticky for the reranker,
// permanent for a vision instance).
//
// Production defaults on purpose: `base` carries NO `healthTimeoutMs` / `healthIntervalMs`, so
// the bound this test measures is the one the product ships. Fake timers make the 180 s
// reproducible in milliseconds; the settle time is read off the faked clock.
//
// Does not prove: the field likelihood of a wedged cold start (a slow USB read of a multi-GB
// weight is the realistic trigger) — only that, when it happens, teardown is bounded.

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 4242
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

/** A spawn() stub that records EVERY spawned child (a restart after an aborted start spawns a second). */
function fakeSpawn() {
  const children: FakeChild[] = []
  const spawn = (): ChildProcessLike => {
    const child = new FakeChild()
    children.push(child)
    return child
  }
  return { spawn, children }
}

/** `/health` never turns ready — a wedged cold start. Every other route is unreachable before health. */
const neverHealthy = (async () =>
  ({ ok: false, status: 503, json: async () => ({ status: 'loading' }) }) as Response) as typeof fetch

/** Production defaults: no health timeout / interval override. `findPort` keeps the test off the network. */
const base = {
  binPath: '/bin/llama-server',
  modelPath: '/models/model.gguf',
  findPort: async () => 54321
}

/** Drain the microtask queue between fake-clock steps (promise chains settle without timers). */
async function flush(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/**
 * Pump the fake clock in `step` ms slices until `done()` holds, and return the elapsed FAKE
 * milliseconds — or null if `max` ms passed first. The health poll backs off up to the 250 ms
 * production cap, so one slice is about one poll.
 */
async function advanceUntil(done: () => boolean, max = 200_000, step = 250): Promise<number | null> {
  const t0 = Date.now()
  await flush()
  while (!done()) {
    if (Date.now() - t0 >= max) return null
    await vi.advanceTimersByTimeAsync(step)
    await flush()
  }
  return Date.now() - t0
}

interface WrapperCase {
  name: string
  build: (spawn: () => ChildProcessLike) => {
    /** Trigger the lazy cold start (the first user-facing call). */
    kick: () => Promise<unknown>
    /** The lock/quit teardown under test. */
    teardown: () => Promise<void>
    /** A second user-facing call after the teardown — must spawn a FRESH child (no stale latch). */
    restart?: () => Promise<unknown>
    /** The wrapper's own latch accessor where one exists. */
    latched?: () => boolean
    /** Permanent stop at the end so nothing is left parked. */
    finalStop: () => Promise<void>
  }
}

const cases: WrapperCase[] = [
  {
    name: 'E5Embedder.stop()',
    build: (spawn) => {
      const e5 = new E5Embedder({ ...base, id: 'e5', dimensions: 2, spawn, fetchImpl: neverHealthy })
      return { kick: () => e5.embed(['a']), teardown: () => e5.stop(), finalStop: () => e5.stop() }
    }
  },
  {
    // suspend() clears the embedder's latch by design (L4), so the observable here is the
    // lazy RESTART: a second embed() after the aborted start spawns a fresh child.
    name: 'E5Embedder.suspend() then a lazy restart',
    build: (spawn) => {
      const e5 = new E5Embedder({ ...base, id: 'e5', dimensions: 2, spawn, fetchImpl: neverHealthy })
      return {
        kick: () => e5.embed(['a']),
        teardown: () => e5.suspend(),
        restart: () => e5.embed(['b']),
        finalStop: () => e5.stop()
      }
    }
  },
  {
    // The reranker KEEPS its latch across suspend() (F7 policy: a bad GGUF loads no better after
    // unlock) — so an aborted start that wrongly latched would refuse every rerank for the
    // session. The restart proves the aborted start did not latch.
    name: 'LlamaReranker.suspend() then a lazy restart',
    build: (spawn) => {
      const rr = new LlamaReranker({ ...base, id: 'rr', spawn, fetchImpl: neverHealthy })
      return {
        kick: () => rr.rerank('q', ['d']),
        teardown: () => rr.suspend(),
        restart: () => rr.rerank('q', ['d']),
        finalStop: () => rr.stop()
      }
    }
  },
  {
    name: 'VisionRuntime.stop()',
    build: (spawn) => {
      const vis = new VisionRuntime({
        ...base,
        modelId: 'vis',
        projectorPath: '/models/mmproj.gguf',
        spawn,
        fetchImpl: neverHealthy
      })
      return {
        kick: () =>
          vis.analyze({ imageBytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png', question: 'what?' }),
        teardown: () => vis.stop(),
        latched: () => vis.isStartFailed(),
        finalStop: () => vis.stop()
      }
    }
  },
  {
    // The #159 template — green before this change; kept as the control the three above must match.
    name: 'TranslationRuntime.suspend() (control, #159)',
    build: (spawn) => {
      const tg = new TranslationRuntime({
        ...base,
        modelId: 'tg',
        spawn,
        fetchImpl: neverHealthy,
        gpu: { getGpuMode: () => 'off', getGpuAutoDisabled: () => true }
      })
      return {
        kick: () => tg.translate({ sourceLang: 'de', targetLang: 'en', text: 'Guten Tag.' }),
        teardown: () => tg.suspend(),
        latched: () => tg.isStartFailed(),
        finalStop: () => tg.stop()
      }
    }
  }
]

/** One health poll is ≤ 250 ms; anything near the 180 s health window is the finding. */
const SETTLE_BOUND_MS = 5_000

describe('#244 — lock/quit teardown during a never-healthy cold start (B8)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(cases)('$name settles in < 5 s, kills the child, and leaves no stale latch', async ({ build }) => {
    vi.useFakeTimers()
    const { spawn, children } = fakeSpawn()
    const w = build(spawn)

    const inflight = w.kick()
    inflight.catch(() => {}) // observed below; never unhandled
    expect(await advanceUntil(() => children.length === 1, SETTLE_BOUND_MS)).not.toBeNull()
    expect(children).toHaveLength(1) // the cold start spawned exactly one child

    let settled = false
    const teardown = w.teardown().then(() => {
      settled = true
    })
    const at = await advanceUntil(() => settled)
    expect(at).not.toBeNull() // the teardown settled inside the 200 s pump at all
    expect(children[0].killed).toBe(true) // the mid-start child was killed, never orphaned
    // The finding: 180 250 ms for E5 / reranker / vision before the fix, 250 ms for translation.
    expect(at).toBeLessThan(SETTLE_BOUND_MS)
    await teardown
    await expect(inflight).rejects.toThrow() // the in-flight call rejects (aborted start)

    if (w.latched) expect(w.latched()).toBe(false) // an aborted start is not a load fault
    if (w.restart) {
      const again = w.restart()
      again.catch(() => {})
      expect(await advanceUntil(() => children.length === 2, SETTLE_BOUND_MS)).not.toBeNull()
      expect(children).toHaveLength(2) // a FRESH child — the aborted start left no latch behind
    }

    let stopped = false
    void w.finalStop().then(() => {
      stopped = true
    })
    expect(await advanceUntil(() => stopped, SETTLE_BOUND_MS)).not.toBeNull()
    expect(children.every((c) => c.killed)).toBe(true)
  })
})
