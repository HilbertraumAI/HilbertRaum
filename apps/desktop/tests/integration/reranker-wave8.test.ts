import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { LlamaReranker } from '../../src/main/services/reranker/llama'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'
import {
  cpuRequestCeilingFor,
  resolveRerankerDevicePosture,
  snapshotRerankerOccupancy,
  createPendingModelSwitchCounter
} from '../../src/main/services/rag/device-posture'
import { DEFAULT_SETTINGS, type GpuDevice } from '../../src/shared/types'
import { resolveRerankProfile, rerankScopeFor, type RerankerDevice } from '../../src/main/services/rag/rerank-profile'
import type { RuntimeManager } from '../../src/main/services/runtime'

// Wave 8 (step 4-8, resolving the scoped Opus review of step 4-7's finding C3): option B', the
// use-time re-check (Q), the CPU request ceiling (G), and the lifecycle hardening (single-flight
// teardown + dead-handle recovery + abort classification). Driven at the SAME level as
// reranker.test.ts — a real LlamaReranker over a fake spawn + fake loopback fetch — because the
// mechanism under test lives entirely inside `resolveServer`/`ensureStarted`/`beginOrJoinTeardown`.

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
  /** Simulate a mid-session crash: exits WITHOUT going through kill() (ruling (c)(ii)). */
  crash(code = 1): void {
    this.emit('exit', code, null)
  }
}

/** A child whose exit only fires once `releaseExit()` is called — lets a test hold a teardown
 *  open long enough to observe single-flight sharing or a concurrent rerank's F19 refusal. */
class GatedChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  private wantExit = false
  private released = false
  kill(): boolean {
    this.killed = true
    this.wantExit = true
    if (this.released) this.emit('exit', 0, null)
    return true
  }
  releaseExit(): void {
    this.released = true
    if (this.wantExit) this.emit('exit', 0, null)
  }
}

function fakeSpawnOf<T extends ChildProcessLike>(make: () => T) {
  const calls: Array<{ args: string[] }> = []
  const children: T[] = []
  const spawn = (_c: string, args: string[]): ChildProcessLike => {
    calls.push({ args })
    const c = make()
    children.push(c)
    return c
  }
  return { spawn, calls, children }
}

/** /health ok, /v1/rerank returns one ascending score per document (order-preserving is not the
 *  point here — the lifecycle/race mechanics are). */
function rerankFetch(): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
    if (u.endsWith('/v1/rerank')) {
      const body = JSON.parse(String(init?.body)) as { documents: string[] }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: body.documents.map((_d, index) => ({ index, relevance_score: index })) })
      } as Response
    }
    throw new Error(`unexpected url ${u}`)
  }) as typeof fetch
}

/** A /health that stays pending until `release()` is called — lets a test park a cold start
 *  in flight, exactly like reranker.test.ts's F19 fixture. */
function gatedHealthFetch(): { fetchImpl: typeof fetch; release: () => void } {
  let releaseFn: (() => void) | null = null
  const ready = new Promise<void>((r) => (releaseFn = r))
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/health')) {
      await ready
      return { ok: true, status: 200 } as Response
    }
    if (u.endsWith('/v1/rerank')) {
      const body = JSON.parse(String(init?.body)) as { documents: string[] }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: body.documents.map((_d, index) => ({ index, relevance_score: index })) })
      } as Response
    }
    throw new Error(`unexpected url ${u}`)
  }) as typeof fetch
  return { fetchImpl, release: () => releaseFn!() }
}

const base = {
  id: 'bge-reranker-v2-m3-f16',
  binPath: '/bin/llama-server',
  modelPath: '/models/reranker.gguf',
  findPort: async () => 53000,
  healthIntervalMs: 1
}

function docs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `doc ${i}`)
}

// ---- Ruling (b)(G): the CPU posture's per-call request ceiling -------------------------------

describe('Wave 8 ruling (b)(G): the CPU request ceiling', () => {
  it('refuses a CPU-posture request above the injected ceiling, BEFORE any start, and never latches startFailed', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const reranker = new LlamaReranker({
      ...base,
      spawn,
      fetchImpl: rerankFetch(),
      devicePosture: () => 'cpu',
      cpuRequestCeiling: () => 48
    })
    await expect(reranker.rerank('q', docs(49))).rejects.toThrow(/refused/i)
    expect(calls.length).toBe(0) // thrown before any start
    // Not latched: a request AT the ceiling succeeds right after, on the same instance.
    const hits = await reranker.rerank('q', docs(48))
    expect(hits).toHaveLength(48)
    expect(calls.length).toBe(1)
    await reranker.stop()
  })

  it('admits a CPU-posture request at exactly the default ceiling (read from cpuRequestCeilingFor, not hand-typed)', async () => {
    const ceiling = cpuRequestCeilingFor(DEFAULT_SETTINGS) // the real formula, default settings -> 48
    expect(ceiling).toBe(48)
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const reranker = new LlamaReranker({
      ...base,
      spawn,
      fetchImpl: rerankFetch(),
      devicePosture: () => 'cpu',
      cpuRequestCeiling: () => ceiling
    })
    const hits = await reranker.rerank('q', docs(ceiling))
    expect(hits).toHaveLength(ceiling)
    expect(calls[0]!.args).toContain('--device')
    await reranker.stop()
  })

  // Module-mocked finite CPU_HI_MIN_THREADS (the rerank-profile.test.ts pattern) + a mocked
  // defaultThreadCount (CI's real core count is unpredictable) so cpuRequestCeilingFor's OWN
  // formula, not a hand-typed 72, decides the top48-class ceiling under the wide-scope opt-in.
  it('admits a request at the top48-class ceiling under a module-mocked finite CPU_HI_MIN_THREADS with the opt-in', async () => {
    vi.resetModules()
    vi.doMock('../../src/shared/rerank-rules', () => ({ CPU_HI_MIN_THREADS: 8 }))
    vi.doMock('../../src/main/services/runtime/sidecar', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/main/services/runtime/sidecar')>()
      return { ...actual, defaultThreadCount: () => 8 }
    })
    try {
      const mod = await import('../../src/main/services/rag/device-posture')
      const wideSettings = { ...DEFAULT_SETTINGS, ragRerankWideScope: true }
      const ceiling = mod.cpuRequestCeilingFor(wideSettings)
      expect(ceiling).toBe(72) // 2*12 (ragTopKInitial) + totalCandidateCapFor('top48') (48)
      const defaultCeiling = mod.cpuRequestCeilingFor(DEFAULT_SETTINGS) // opt-in off -> still 'capped'
      expect(defaultCeiling).toBe(48)

      const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
      const reranker = new LlamaReranker({
        ...base,
        spawn,
        fetchImpl: rerankFetch(),
        devicePosture: () => 'cpu',
        cpuRequestCeiling: () => ceiling
      })
      const hits = await reranker.rerank('q', docs(72))
      expect(hits).toHaveLength(72)
      await expect(reranker.rerank('q2', docs(73))).rejects.toThrow(/refused/i)
      expect(calls.length).toBe(1) // the refusal spawned nothing new
      await reranker.stop()
    } finally {
      vi.doUnmock('../../src/shared/rerank-rules')
      vi.doUnmock('../../src/main/services/runtime/sidecar')
      vi.resetModules()
    }
  })

  // Verification 2's hole B-1: a Q/G check separated by an await from the start it guards. Set up
  // a resident 'cpu' sidecar, then let devicePosture answer 'gpu' (triggering Q's restart) on the
  // FIRST call of this rerank() and 'cpu' again on the SECOND (post-restart-await) call -- a
  // posture that flips TWICE inside one rerank(). G must refuse the oversized request on the
  // fresh, post-await read, not admit it on the strength of the momentary 'gpu' reading.
  it('re-applies G after the await inside Q\'s own restart, on a posture that flipped during that await', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const postures: RerankerDevice[] = ['cpu'] // cold start #1: cpu
    let call = 0
    const devicePosture = (): RerankerDevice => {
      const p = postures[Math.min(call, postures.length - 1)]!
      call++
      return p
    }
    const reranker = new LlamaReranker({
      ...base,
      spawn,
      fetchImpl: rerankFetch(),
      devicePosture,
      cpuRequestCeiling: () => 48
    })
    await reranker.rerank('warm', docs(1)) // cold start #1, recorded 'cpu'
    expect(calls.length).toBe(1)

    // Now make the NEXT rerank() see 'gpu' first (mismatch -> Q restarts), then 'cpu' again
    // (G must catch the oversized request on THIS second, post-await read).
    postures.length = 0
    postures.push('gpu', 'cpu')
    call = 0
    await expect(reranker.rerank('wide', docs(100))).rejects.toThrow(/refused/i)
    // The mismatch tore the cpu sidecar down (Q's restart), but G refused before any respawn.
    expect(calls.length).toBe(1)
    expect(reranker.isLoaded()).toBe(false)
    await reranker.stop()
  })
})

// ---- Ruling (b)(Q): the four race rules -------------------------------------------------------

describe('Wave 8 ruling (b)(Q): the four race rules', () => {
  it('no flap: a resolved posture equal to the recorded one restarts nothing', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => 'cpu' })
    await reranker.rerank('q', docs(1))
    await reranker.rerank('q2', docs(1))
    await reranker.rerank('q3', docs(1))
    expect(calls.length).toBe(1) // one cold start, reused every time
    await reranker.stop()
  })

  it('rule (i): refuses rather than joins when a teardown it did not start is already in flight', async () => {
    const { spawn, calls, children } = fakeSpawnOf(() => new GatedChild())
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => 'cpu' })
    await reranker.rerank('q', docs(1)) // resident
    const suspendP = reranker.suspend() // teardown in flight; kill() called, exit gated
    // A concurrent rerank() call while tearingDown is true must refuse promptly (F19), not wait.
    await expect(reranker.rerank('q2', docs(1))).rejects.toThrow(/suspending/i)
    expect(calls.length).toBe(1) // no second spawn attempted
    children[0]!.releaseExit()
    await suspendP
    await reranker.stop()
  })

  // Hole B-2 (verification 2): a lock JOINING a Q-initiated teardown, under a posture that keeps
  // changing, must still leave NOTHING resident afterwards -- Q must not respawn just because its
  // own await settled.
  it('rule (ii): a lock joining a Q-initiated teardown under a changing posture leaves nothing resident', async () => {
    const { spawn, calls, children } = fakeSpawnOf(() => new GatedChild())
    let posture: RerankerDevice = 'gpu'
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => posture })
    await reranker.rerank('q', docs(1)) // resident, recorded 'gpu'
    expect(calls.length).toBe(1)

    posture = 'cpu' // a real occupancy change -- Q must restart on the next call
    const askP = reranker.rerank('q2', docs(1)) // detects the mismatch, initiates the teardown pass
    // Let Q's own beginOrJoinTeardown() run (kill() called on child #1) before the lock joins.
    while (!children[0]!.killed) await new Promise((r) => setTimeout(r, 1))
    const lockP = reranker.suspend() // the LOCK joins the SAME single-flight pass (requesterCount -> 2)
    children[0]!.releaseExit() // let the shared pass settle
    await lockP
    await expect(askP).rejects.toThrow(/suspending/i) // rule (ii): another caller joined -> refuse
    expect(calls.length).toBe(1) // Q never got to respawn
    expect(reranker.isLoaded()).toBe(false) // the lock's intent — nothing resident — holds
    await reranker.stop()
  })

  it('rule (ii): the caller\'s OWN aborted signal ends the ask instead of landing on the fallback', async () => {
    const { spawn, children } = fakeSpawnOf(() => new GatedChild())
    let posture: RerankerDevice = 'gpu'
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => posture })
    await reranker.rerank('q', docs(1))
    posture = 'cpu'
    const controller = new AbortController()
    const askP = reranker.rerank('q2', docs(1), { signal: controller.signal })
    while (!children[0]!.killed) await new Promise((r) => setTimeout(r, 1))
    controller.abort() // the CALLER's own signal — a lock would do this to the ask FIRST
    children[0]!.releaseExit()
    await expect(askP).rejects.toThrow(/abort/i)
    await reranker.stop()
  })

  // Rule (iii)'s guard is that a call which has ALREADY restarted once never loops for a SECOND
  // mismatch-driven restart of its own. The re-check's own answer to "can this be reached?" is
  // "only through a real second event inside the call: a second flip, a joined teardown
  // requester, or another call's restart aborting a start this call joined — each lands on the
  // fallback by design" (the Wave 8 analysis, NF-2 re-check). This proves the observable
  // guarantee for the THIRD of those: after restarting once, this call's OWN fresh cold start is
  // cut short by a second, independent caller — and the ask fails ONCE, cleanly, rather than
  // looping for a further attempt of its own.
  it('rule (iii) (composite with rule (iv)): a call that already restarted once does not loop for a second attempt when its fresh cold start is itself aborted', async () => {
    const { spawn, calls, children } = fakeSpawnOf(() => new GatedChild())
    // Health succeeds immediately for the FIRST spawned child (establishing 'gpu' residency);
    // any LATER spawn (the post-restart cold start under test) never self-reports healthy, so it
    // stays "in flight" until something aborts it — deterministic, no raced release needed.
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) {
        const firstChild = children.length === 1
        return { ok: firstChild, status: firstChild ? 200 : 503 } as Response
      }
      if (u.endsWith('/v1/rerank')) {
        const body = JSON.parse(String(init?.body)) as { documents: string[] }
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: body.documents.map((_d, index) => ({ index, relevance_score: index })) })
        } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    let posture: RerankerDevice = 'gpu'
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl, devicePosture: () => posture })
    await reranker.rerank('q', docs(1)) // cold start #1, recorded 'gpu'
    expect(calls.length).toBe(1)

    posture = 'cpu' // mismatch #1: this call's OWN restart (rule iii's precondition)
    const askP = reranker.rerank('q2', docs(1))
    // Let the restart's teardown of child #1 begin, then settle it so the call proceeds to its
    // OWN fresh 'cpu' cold start (spawn #2), which can never self-report healthy.
    while (!children[0]!.killed) await new Promise((r) => setTimeout(r, 1))
    children[0]!.releaseExit()
    while (calls.length < 2) await new Promise((r) => setTimeout(r, 1))
    // A SECOND, independent caller now tears down THIS call's own fresh cold start (spawn #2) —
    // the "second event" that would otherwise require a second restart of askP's own.
    const suspendP = reranker.suspend()
    while (!children[1]!.killed) await new Promise((r) => setTimeout(r, 1))
    children[1]!.releaseExit()
    await expect(askP).rejects.toThrow(/aborted by another operation/i) // fails once, cleanly
    await suspendP
    expect(calls.length).toBe(2) // exactly one restart's cold start was ever attempted by askP
    await reranker.stop()
  })

  // Hole B-3 (verification 2): a joined ask whose cold start ANOTHER caller's teardown aborts
  // must land on the fallback (a non-abort error), never end as if its OWN Stop had fired.
  it('rule (iv): a joined ask whose cold start another caller aborts lands on the fallback, not ended', async () => {
    const { spawn, children } = fakeSpawnOf(() => new GatedChild())
    // /health never reports healthy on its own -- the ask's cold start is unblocked only by
    // Q's abort-driven `stop()` inside `waitForHealthy`'s per-iteration abort check, never by a
    // successful health probe (deterministic: no reliance on a raced release).
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: false, status: 503 } as Response
      if (u.endsWith('/v1/rerank')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ index: 0, relevance_score: 0 }] }) } as Response
      }
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl, devicePosture: () => 'cpu' })
    const askP = reranker.rerank('q', docs(1)) // cold start begins; can never self-report healthy
    while (children.length === 0) await new Promise((r) => setTimeout(r, 1))
    const suspendP = reranker.suspend() // ANOTHER caller's teardown aborts the in-flight start
    while (!children[0]!.killed) await new Promise((r) => setTimeout(r, 1))
    children[0]!.releaseExit()
    await expect(askP).rejects.toThrow(/aborted by another operation/i)
    await expect(askP).rejects.not.toThrow(/^AbortError$/) // reclassified: not the DOMException name
    await suspendP
    await reranker.stop()
  })
})

// ---- Ruling (c): sidecar lifecycle hardening ---------------------------------------------------

describe('Wave 8 ruling (c): sidecar lifecycle hardening', () => {
  it('(i) overlapping suspend() + suspend() share ONE teardown pass — the child is killed exactly once', async () => {
    const { spawn, children } = fakeSpawnOf(() => new GatedChild())
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => 'cpu' })
    await reranker.rerank('q', docs(1))
    const p1 = reranker.suspend()
    const p2 = reranker.suspend() // overlaps p1 -- must join, not start a second pass
    expect(children[0]!.killed).toBe(true) // kill() called by the shared pass
    children[0]!.releaseExit()
    await Promise.all([p1, p2])
    expect(reranker.isLoaded()).toBe(false)
    await reranker.stop()
  })

  it('(i) stop() joining an in-flight suspend() still settles only after the shared kill (no orphan on quit)', async () => {
    const { spawn, children } = fakeSpawnOf(() => new GatedChild())
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => 'cpu' })
    await reranker.rerank('q', docs(1))
    const suspendP = reranker.suspend()
    let stopSettled = false
    const stopP = reranker.stop().then(() => {
      stopSettled = true
    })
    // The shared pass has NOT settled yet (child still gated) — stop() must not resolve early.
    await new Promise((r) => setTimeout(r, 5))
    expect(stopSettled).toBe(false)
    expect(children.length).toBe(1) // stop() joined the SAME pass, no second teardown started
    children[0]!.releaseExit()
    await Promise.all([suspendP, stopP])
    expect(stopSettled).toBe(true)
    expect(children[0]!.killed).toBe(true)
  })

  it('(ii) one unexpected exit drops the dead handle and the next rerank() cold-starts with a freshly resolved posture', async () => {
    const { spawn, calls, children } = fakeSpawnOf(() => new FakeChild())
    let posture: RerankerDevice = 'cpu'
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => posture })
    await reranker.rerank('q', docs(1))
    expect(reranker.isLoaded()).toBe(true)
    children[0]!.crash() // a healthy child dying on its own -- NOT via stop()/suspend()
    expect(reranker.isLoaded()).toBe(false) // the dead handle is dropped synchronously

    posture = 'gpu' // the freshly resolved posture for the lazy restart
    const hits = await reranker.rerank('q2', docs(1))
    expect(hits).toHaveLength(1)
    expect(calls.length).toBe(2) // re-spawned, not served from the dead handle
    expect(calls[1]!.args).not.toContain('--device') // used the NEW posture
    await reranker.stop()
  })

  it('(ii) a SECOND unexpected exit in the same session latches like a permanent load fault', async () => {
    const { spawn, calls, children } = fakeSpawnOf(() => new FakeChild())
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => 'cpu' })
    await reranker.rerank('q', docs(1))
    children[0]!.crash() // exit #1 -- drops the handle, does not latch
    await reranker.rerank('q2', docs(1)) // lazily restarts fine
    expect(calls.length).toBe(2)
    children[1]!.crash() // exit #2 -- latches
    await expect(reranker.rerank('q3', docs(1))).rejects.toThrow(/twice/i)
    expect(calls.length).toBe(2) // no third spawn attempted — fails fast
    await reranker.stop()
  })

  it('(ii) a teardown-initiated exit (stop()/suspend()) never counts as an unexpected exit', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => 'cpu' })
    await reranker.rerank('q', docs(1))
    await reranker.suspend() // a NORMAL teardown -- FakeChild.kill() fires 'exit' itself
    const hits = await reranker.rerank('q2', docs(1))
    expect(hits).toHaveLength(1)
    expect(calls.length).toBe(2) // ordinary lazy restart, not the crash-latch path
    await reranker.stop()
  })
})

// ---- Ruling (d): the resident sidecar's posture, read back -------------------------------------

describe('Wave 8 ruling (d): Reranker.devicePosture()', () => {
  it('reports the RESIDENT posture when loaded, and the posture a cold start would take now when not', async () => {
    const { spawn } = fakeSpawnOf(() => new FakeChild())
    let posture: RerankerDevice = 'cpu'
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture: () => posture })
    expect(reranker.devicePosture()).toBe('cpu') // not loaded yet -- the posture a cold start would take
    await reranker.rerank('q', docs(1))
    posture = 'gpu' // an occupancy change AFTER this sidecar launched
    expect(reranker.devicePosture()).toBe('cpu') // the RESIDENT sidecar's actual (launch-time) posture
    await reranker.suspend()
    expect(reranker.devicePosture()).toBe('gpu') // nothing resident -- reports what a cold start would take now
    await reranker.stop()
  })
})

// ---- Scenarios S1-S5, S9 (option B', the Wave 8 analysis §4) -----------------------------------

// The project's own measured GTX 1070 Ti fixture (#391 leg 2, cited throughout opus-review-7.md
// and the Wave 8 analysis): {totalMb: 8273, freeMb: 7504}. qwen3.5-9b-ud-q4kxl needs ~7284.1 MiB
// (remainder 219.9 < the 2808.2 MiB floor) => posture 'cpu'. qwen3.5-4b-ud-q4kxl needs ~3837.4 MiB
// (remainder 3666.6 >= the floor) => posture 'gpu'.
const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')
const GTX_1070_TI: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce GTX 1070 Ti', totalMb: 8273, freeMb: 7504 }
const GTX_SETTINGS = {
  ...DEFAULT_SETTINGS,
  gpuMode: 'auto' as const,
  gpuAutoDisabled: false,
  gpuProbe: { devices: [GTX_1070_TI], probedAt: new Date().toISOString() }
}
const NINE_B = 'qwen3.5-9b-ud-q4kxl'
const FOUR_B = 'qwen3.5-4b-ud-q4kxl'

/** A minimal fake RuntimeManager (Pick<RuntimeManager, 'activeModelId'|'status'>): `commit()`
 *  models `doStart`'s synchronous assignment of `current` on a successful load; `setStarting()`
 *  models `start()`'s synchronous `startingModelId` assignment. Neither is masked (F15) here --
 *  the masked-restart case gets its own dedicated test in the registerModelIpc suite. */
function fakeRuntimeManager(initialModelId: string | null): Pick<RuntimeManager, 'activeModelId' | 'status'> & {
  commit(id: string | null): void
  setStarting(id: string | null): void
} {
  let committed = initialModelId
  let startingModelId: string | null = null
  return {
    activeModelId: () => committed,
    status: () => ({ startingModelId }) as ReturnType<RuntimeManager['status']>,
    commit(id) {
      committed = id
    },
    setStarting(id) {
      startingModelId = id
    }
  }
}

describe('Wave 8 scenarios S1-S5, S9 (option B\', the analysis §4)', () => {
  it('S1: 9B committed (cpu) -> Use the 4B, ask DURING the hash -> a capped CPU rerank runs throughout', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const runtime = fakeRuntimeManager(NINE_B) // stays committed to the 9B for the WHOLE hash window
    const pending = createPendingModelSwitchCounter()
    const devicePosture = (): RerankerDevice =>
      resolveRerankerDevicePosture(GTX_SETTINGS, MANIFESTS_DIR, snapshotRerankerOccupancy(runtime, pending, () => null))
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture, cpuRequestCeiling: () => 48 })
    // Two asks "during the hash" -- the setting may already say 4B, but the COMMITTED model
    // (what this fake tracks) has not moved yet, so the posture stays 'cpu' throughout.
    const hits1 = await reranker.rerank('during-hash-1', docs(10))
    const hits2 = await reranker.rerank('during-hash-2', docs(20))
    expect(hits1).toHaveLength(10)
    expect(hits2).toHaveLength(20)
    expect(calls.length).toBe(1) // one CPU cold start, reused for both asks
    expect(calls[0]!.args).toContain('--device')
    await reranker.stop()
  })

  it('S2: 4B committed, GPU sidecar resident -> Use the 9B, warm cache -> the teardown is awaited BEFORE the load', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const runtime = fakeRuntimeManager(FOUR_B)
    const pending = createPendingModelSwitchCounter()
    const devicePosture = (): RerankerDevice =>
      resolveRerankerDevicePosture(GTX_SETTINGS, MANIFESTS_DIR, snapshotRerankerOccupancy(runtime, pending, () => null))
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture })
    await reranker.rerank('warm', docs(1))
    expect(reranker.isLoaded()).toBe(true)
    expect(calls[0]!.args).not.toContain('--device') // gpu

    // registerModelIpc.ts's own sequence: increment, AWAIT suspend, decrement -- all BEFORE
    // ctx.runtime.start() commits the new model.
    pending.increment()
    await reranker.suspend()
    pending.decrement()
    expect(reranker.isLoaded()).toBe(false) // torn down BEFORE the load below
    runtime.commit(NINE_B) // the load — happens only AFTER the awaited suspend resolved
    await reranker.stop()
  })

  it('S3: as S2, cold cache, with an ask DURING the hash -> the GPU sidecar beside the resident 4B is correctly budgeted, then torn down before the 9B loads', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const runtime = fakeRuntimeManager(FOUR_B)
    const pending = createPendingModelSwitchCounter()
    const devicePosture = (): RerankerDevice =>
      resolveRerankerDevicePosture(GTX_SETTINGS, MANIFESTS_DIR, snapshotRerankerOccupancy(runtime, pending, () => null))
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture })
    // An ask lands DURING the hash (committed model still 4B) -- correctly budgeted GPU.
    await reranker.rerank('during-hash', docs(30))
    expect(calls[0]!.args).not.toContain('--device')
    expect(reranker.isLoaded()).toBe(true)

    pending.increment()
    await reranker.suspend() // torn down BEFORE the 9B's load
    pending.decrement()
    expect(reranker.isLoaded()).toBe(false)
    runtime.commit(NINE_B)
    await reranker.stop()
  })

  it('S4: 9B -> 4B; the FIRST ask after the commit restarts Q on the GPU', async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const runtime = fakeRuntimeManager(NINE_B)
    const pending = createPendingModelSwitchCounter()
    const devicePosture = (): RerankerDevice =>
      resolveRerankerDevicePosture(GTX_SETTINGS, MANIFESTS_DIR, snapshotRerankerOccupancy(runtime, pending, () => null))
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture })
    await reranker.rerank('before', docs(1)) // resident, recorded 'cpu' (9B)
    expect(calls[0]!.args).toContain('--device')

    // The commit (startModelRuntime's suspend has already been awaited by this point -- S2/S3).
    runtime.commit(FOUR_B)
    const hits = await reranker.rerank('first-after-commit', docs(1)) // Q detects the mismatch itself
    expect(hits).toHaveLength(1)
    expect(calls.length).toBe(2)
    expect(calls[1]!.args).not.toContain('--device') // restarted on the GPU
    await reranker.stop()
  })

  it("S5: mid-ask -- a wide ('all') set resolved on the resident 4B/gpu sidecar; Use on the 9B lands BEFORE this rerank() call -- G refuses the now-cpu-postured wide set", async () => {
    const { spawn, calls } = fakeSpawnOf(() => new FakeChild())
    const runtime = fakeRuntimeManager(FOUR_B)
    const pending = createPendingModelSwitchCounter()
    const devicePosture = (): RerankerDevice =>
      resolveRerankerDevicePosture(GTX_SETTINGS, MANIFESTS_DIR, snapshotRerankerOccupancy(runtime, pending, () => null))
    const reranker = new LlamaReranker({ ...base, spawn, fetchImpl: rerankFetch(), devicePosture, cpuRequestCeiling: () => 48 })
    // BEFORE the Use click: a GPU rerank is correct for a wide (100-document) set.
    const before = await reranker.rerank('before-use', docs(100))
    expect(before).toHaveLength(100)
    expect(calls[0]!.args).not.toContain('--device')

    // Use on the 9B lands: startModelRuntime's pending counter goes up BEFORE this ask's own
    // rerank() call reaches the sidecar (the ask's retrieval/planning took long enough to overlap
    // it) -- during the pending window the posture is 'cpu' and G refuses the still-wide request.
    pending.increment()
    await expect(reranker.rerank('mid-ask-wide', docs(100))).rejects.toThrow(/refused/i)
    pending.decrement()
    expect(calls.length).toBe(1) // no GPU cold start beside the loading 9B, no CPU cold start either
    await reranker.stop()
  })

  it('S9: the acceptance read\'s snapshot (committed 4B, no occupancy, the recorded probe) resolves gpu / all', () => {
    const posture = resolveRerankerDevicePosture(
      GTX_SETTINGS,
      MANIFESTS_DIR,
      snapshotRerankerOccupancy(fakeRuntimeManager(FOUR_B), createPendingModelSwitchCounter(), () => null)
    )
    expect(posture).toBe('gpu')
    const input = {
      gpuMode: GTX_SETTINGS.gpuMode,
      gpuAutoDisabled: GTX_SETTINGS.gpuAutoDisabled,
      probeDevices: GTX_SETTINGS.gpuProbe!.devices,
      threads: 8,
      rerankerAvailable: true,
      wideScopeOptIn: false
    }
    const scope = rerankScopeFor(resolveRerankProfile(input), input, posture)
    expect(scope).toBe('all')
  })
})
