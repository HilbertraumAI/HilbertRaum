import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  TranslationRuntime,
  isTranslationStartError,
  TRANSLATION_START_FAILED_CODE,
  type TranslateOptions
} from '../../src/main/services/translation/runtime'
import { createSelectedTranslator } from '../../src/main/services/translation/factory'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// TG-2 fake-server tests for the real TranslationRuntime (plan §4 TG-2): launch args (NO --jinja,
// --ctx-size 4096, --parallel 1), the raw /completion streaming + stop/temperature, abort
// forwarding, error mapping, single-flight + failed-start latch, the GPU device ladder (issue #42:
// gpuMode/gpuAutoDisabled honoured per cold start, GPU-fail → forced-CPU fallback + session latch),
// and — the hybrid heart — the SOFT idle-teardown interlock (vision RUNTIME-4) alongside
// stop()/suspend() (reranker). No real binary is spawned: spawn/fetchImpl/findPort are injected
// (the e5/reranker/vision seam).

/** A canned /completion SSE stream: two content frames + a terminal stop frame with timings. */
const COMPLETION_SSE =
  'data: {"content":"Good ","stop":false}\n\n' +
  'data: {"content":"day.","stop":false}\n\n' +
  'data: {"content":"","stop":true,"stopping_word":"<end_of_turn>","timings":{"predicted_per_second":9.5,"predicted_n":3}}\n\n'
const COMPLETION_TEXT = 'Good day.'

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

function fakeSpawn() {
  const calls: Array<{ args: string[] }> = []
  const children: FakeChild[] = []
  const spawn = (_c: string, args: string[]): ChildProcessLike => {
    calls.push({ args })
    const child = new FakeChild()
    children.push(child)
    return child
  }
  return { spawn, calls, children }
}

/** A `ReadableStream` over the SSE text (one chunk; readCompletionSSE handles the rest). */
function sseBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.close()
      sent = true
      controller.enqueue(bytes)
    }
  })
}

/** Routes /health (ok) + /completion (the canned SSE). Records request URLs/bodies. */
function translationFetch(sse = COMPLETION_SSE) {
  const urls: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    urls.push(u)
    if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
    if (u.endsWith('/completion')) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return { ok: true, status: 200, body: sseBody(sse) } as unknown as Response
    }
    throw new Error(`unexpected url ${u}`)
  }) as typeof fetch
  return { fetchImpl, urls, bodies }
}

const base = {
  modelId: 'translategemma',
  binPath: '/bin/llama-server',
  modelPath: '/models/translategemma.gguf',
  contextTokens: 4096,
  findPort: async () => 51200,
  healthIntervalMs: 1
}

const translateOpts: TranslateOptions = { sourceLang: 'de', targetLang: 'en', text: 'Guten Tag.' }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('TranslationRuntime — launch + translate', () => {
  it('launches WITHOUT --jinja, with --ctx-size 4096 --parallel 1, GPU auto-offload by default, loopback only', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    await rt.translate(translateOpts)
    const args = calls[0].args.join(' ')
    expect(args).not.toContain('--jinja') // the #20305 regression (plan §1.1 / §2 D2)
    expect(args).not.toContain('--reasoning-format') // not the chat CHAT_SERVER_ARGS
    expect(args).toContain('--ctx-size 4096') // plan §2 D4
    expect(args).toContain('--parallel 1') // sequential windows; contains #25142 (plan §2 D8/D9)
    // Issue #42: default posture = GPU auto-offload, the chat rung-1 shape — NO device args
    // (b9849 defaults ngl=auto + fit=on; on a GPU-less machine this IS CPU mode).
    expect(args).not.toContain('--device')
    expect(args).not.toContain('-ngl') // NEVER pass -ngl (the GPU record's hard rule)
    expect(args).toContain('--chat-template gemma') // avoids the #20305 STARTUP crash (TG-2 smoke finding)
    expect(args).toContain('--host 127.0.0.1') // loopback only
    expect(rt.isStartFailed()).toBe(false) // a healthy instance never reads as latched (BE-7)
    await rt.stop()
  })

  it('defaults --ctx-size to 4096 when the manifest omits contextTokens', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const { contextTokens: _omit, ...noCtx } = base
    const rt = new TranslationRuntime({ ...noCtx, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    await rt.translate(translateOpts)
    expect(calls[0].args.join(' ')).toContain('--ctx-size 4096')
    expect(rt.contextWindow()).toBe(4096)
    await rt.stop()
  })

  it('POSTs the trained prompt to /completion with temperature 0 + stop token, streams the text', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, bodies, urls } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })

    const tokens: string[] = []
    let timings: unknown
    const out = await rt.translate({
      ...translateOpts,
      onToken: (d) => tokens.push(d),
      onFinal: (info) => (timings = info.timings)
    })

    expect(out).toBe(COMPLETION_TEXT)
    expect(tokens.join('')).toBe(COMPLETION_TEXT) // streamed token-by-token
    expect(urls.some((u) => u.endsWith('/completion'))).toBe(true) // NOT /v1/chat/completions
    const body = bodies[0]
    expect(body.temperature).toBe(0) // greedy MT (plan §2 D2)
    expect(body.stop).toEqual(['<end_of_turn>'])
    expect(body.stream).toBe(true)
    expect(String(body.prompt)).toContain('You are a professional German (de) to English (en) translator.')
    expect(String(body.prompt).endsWith('Guten Tag.<end_of_turn>\n<start_of_turn>model\n')).toBe(true)
    expect(body.n_predict).toBeUndefined() // unset unless maxTokens is passed
    expect(timings).toEqual({ predicted_per_second: 9.5, predicted_n: 3 }) // the smoke's tok/s artifact
    await rt.stop()
  })

  it('passes maxTokens through as n_predict', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, bodies } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    await rt.translate({ ...translateOpts, maxTokens: 512 })
    expect(bodies[0].n_predict).toBe(512)
    await rt.stop()
  })

  it('shares ONE start across concurrent translates (single-flight)', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    const [a, b] = await Promise.all([rt.translate(translateOpts), rt.translate(translateOpts)])
    expect(a).toBe(COMPLETION_TEXT)
    expect(b).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(1) // one shared spawn, not two
    await rt.stop()
  })

  it('latches a failed start with the distinct startFailed code (fail fast, ONE spawn) — F-7', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      queueMicrotask(() => child.emit('exit', 1, null)) // dies immediately (corrupt GGUF)
      return child
    }
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      // gpuMode 'off' → the launch is ALREADY forced-CPU, so there is no GPU→CPU rung to walk:
      // a start failure latches after exactly one spawn (the pre-#42 shape, preserved verbatim).
      gpu: { getGpuMode: () => 'off' },
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    // F-7 / FA-4 option c: a non-bind start fault latches AND carries the distinct code, so the UI
    // can say "restart / free memory" instead of a bare "runtime failed".
    const err = await rt.translate(translateOpts).catch((e: unknown) => e)
    expect(isTranslationStartError(err)).toBe(true)
    expect((err as { code?: string }).code).toBe(TRANSLATION_START_FAILED_CODE)
    await expect(rt.translate(translateOpts)).rejects.toThrow() // still latched
    expect(calls.length).toBe(1) // the latch prevented a second spawn + health-timeout stall
    // BE-7 (full-audit 2026-07-10): the latch is now REPORTABLE, so the issue-#40
    // onModelInstalled refresh can replace this dead instance after a re-download repair.
    expect(rt.isStartFailed()).toBe(true)
    await rt.stop()
  })

  it('does NOT latch a transient port-bind race — a later start retries (reranker F7 parity, F-7)', async () => {
    // A bind race is the ONE non-latching start class (`ensureStarted` propagates it RAW, not a
    // TranslationStartError). It stays retryable across the session, so a second translate() still
    // attempts to start — contrast the permanent-fault latch above, which spawns once total.
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      const stderr = new EventEmitter()
      ;(child as unknown as { stderr: EventEmitter }).stderr = stderr
      queueMicrotask(() => {
        stderr.emit('data', 'bind: address already in use') // the isBindRaceError signature
        child.emit('exit', 1, null)
      })
      return child
    }
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    const err1 = await rt.translate(translateOpts).catch((e: unknown) => e)
    expect(isTranslationStartError(err1)).toBe(false) // a bind race is NOT the latched class
    const spawnsAfterFirst = calls.length
    await rt.translate(translateOpts).catch(() => undefined)
    expect(calls.length).toBeGreaterThan(spawnsAfterFirst) // not latched → it tried to start again
    expect(rt.isStartFailed()).toBe(false) // a bind race never reads as latched — no replacement (BE-7)
    await rt.stop()
  })

  it('forwards the caller abort signal to the /completion request (cancels in flight)', async () => {
    const { spawn } = fakeSpawn()
    let seenSignal: AbortSignal | undefined
    const hangingFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      seenSignal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl: hangingFetch })
    const controller = new AbortController()
    const p = rt.translate({ ...translateOpts, signal: controller.signal })
    await sleep(2)
    controller.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(seenSignal?.aborted).toBe(true)
    await rt.stop()
  })

  it('maps a non-200 /completion response to a request error', async () => {
    const { spawn } = fakeSpawn()
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      return { ok: false, status: 500, body: null } as unknown as Response
    }) as typeof fetch
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await expect(rt.translate(translateOpts)).rejects.toThrow(/HTTP 500/)
    await rt.stop()
  })

  it('maps a mid-stream /completion error frame to a CompletionError', async () => {
    const { spawn } = fakeSpawn()
    const errSse = 'data: {"error":{"message":"context size exceeded","type":"exceed_context_size_error"}}\n\n'
    const { fetchImpl } = translationFetch(errSse)
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await expect(rt.translate(translateOpts)).rejects.toThrow(/Translation request failed: context size exceeded/)
    await rt.stop()
  })

  it('rejects retryably when the /completion stream ends without the terminal stop frame (TA-4 M2)', async () => {
    const { spawn } = fakeSpawn()
    // Content frames but NO `stop:true` terminal — a server-side close mid-decode. Pre-TA-4 this
    // resolved the partial as a truncated "success"; now the reader throws so both consumers retry/fail.
    const truncated =
      'data: {"content":"Good ","stop":false}\n\n' + 'data: {"content":"day.","stop":false}\n\n'
    const { fetchImpl } = translationFetch(truncated)
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await expect(rt.translate(translateOpts)).rejects.toThrow(/stream ended before the terminal stop frame/)
    await rt.stop()
  })
})

// The idle-teardown interlock (vision RUNTIME-4 pattern) + the reranker stop()/suspend() split.
// Injected clock → deterministic (fire teardown on demand), no wall-clock idle sleeps.
describe('TranslationRuntime — idle teardown + stop/suspend', () => {
  class GatedChild extends EventEmitter implements ChildProcessLike {
    pid = 9
    killed = false
    hold = false
    kill(): boolean {
      this.killed = true
      if (!this.hold) queueMicrotask(() => this.emit('exit', 0, null))
      return true
    }
    release(): void {
      queueMicrotask(() => this.emit('exit', 0, null))
    }
  }
  function gatedSpawn() {
    const calls: Array<{ args: string[] }> = []
    const children: GatedChild[] = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new GatedChild()
      children.push(child)
      return child
    }
    return { spawn, calls, children }
  }
  function fakeClock() {
    const state = { fire: null as (() => void) | null, setCount: 0, clearCount: 0, unrefCount: 0 }
    const clock = {
      set(cb: () => void) {
        state.setCount++
        state.fire = cb
        return {
          clear: () => {
            state.clearCount++
            if (state.fire === cb) state.fire = null
          },
          unref: () => {
            state.unrefCount++
          }
        }
      }
    }
    return { clock, state }
  }

  it('arms an unref\'d idle timer on settle and tears the idle sidecar down when it fires', async () => {
    const { spawn, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    expect(state.setCount).toBe(1)
    expect(state.unrefCount).toBe(1) // never blocks a clean quit
    state.fire!() // idle window elapses → soft teardown kills the child
    expect(children[0].killed).toBe(true)
    await rt.stop()
  })

  it('re-entry RESETS the idle clock; a reused sidecar is never torn down by the stale timer', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    const staleCb = state.fire!
    await rt.translate(translateOpts) // re-entry cancels T1, re-arms T2, REUSES the sidecar
    expect(calls.length).toBe(1)
    expect(children[0].killed).toBe(false)
    expect(state.clearCount).toBe(1)
    expect(state.setCount).toBe(2)
    expect(state.fire).not.toBe(staleCb)
    state.fire!() // the rearmed timer tears the now-idle sidecar down
    expect(children[0].killed).toBe(true)
    await rt.stop()
  })

  it('a translate racing a soft idle teardown AWAITS it, then cold-starts ONE fresh child (M5: no double-load)', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    children[0].hold = true // hold child0's exit so the soft teardown stays IN FLIGHT
    state.fire!() // nulls this.server synchronously, kills child0 (gated, still alive)
    expect(children[0].killed).toBe(true)
    let resolved = false
    const p = rt.translate(translateOpts).then((out) => {
      resolved = true
      return out
    })
    await tick()
    await tick()
    // Parked on the in-flight soft teardown — NO second spawn yet, so the ~10 GB sidecars never
    // co-exist (the double-load the M5 improvement closes).
    expect(resolved).toBe(false)
    expect(calls.length).toBe(1)
    children[0].release() // child0 finally exits → the parked translate now cold-starts
    const out = await p
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2) // exactly one fresh child, spawned only AFTER the old one died
    await rt.stop()
  })

  it('recovers from a mid-session sidecar CRASH: the next translate cold-starts a fresh child (M1)', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    expect(calls.length).toBe(1)
    // The child dies on its OWN (driver crash / OOM) after having been healthy, outside stop() —
    // a real 'exit'. LlamaServer fires onUnexpectedExit, and the runtime drops the dead handle so
    // the next translate cold-starts instead of failing forever against a stale server.
    children[0].emit('exit', 134, null)
    await tick()
    const out = await rt.translate(translateOpts)
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2) // cold-started a fresh child rather than reusing the dead one
    await rt.stop()
  })

  it('a healthy crash does NOT clobber a newer instance (identity-compared)', async () => {
    // The exit callback captures the child that crashed; if a soft teardown + restart has already
    // installed a NEWER server by the time a late crash notification lands, nulling must be a no-op.
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts) // child0
    state.fire!() // soft teardown of child0 (not held → exits)
    await tick()
    await rt.translate(translateOpts) // cold-starts child1 (the NEWER instance)
    expect(calls.length).toBe(2)
    children[0].emit('exit', 134, null) // a LATE crash notice from the already-dead child0
    await tick()
    // child1 is untouched — the next translate reuses it, no third spawn.
    const out = await rt.translate(translateOpts)
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    await rt.stop()
  })

  it('concurrent stop() + suspend() both resolve only AFTER the child is dead (single-flight teardown, M5)', async () => {
    const { spawn, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    children[0].hold = true // child0 won't exit until released — the SIGTERM→SIGKILL window
    let suspendDone = false
    let stopDone = false
    const suspendP = rt.suspend().then(() => (suspendDone = true))
    const stopP = rt.stop().then(() => (stopDone = true))
    await tick()
    await tick()
    expect(children[0].killed).toBe(true) // the kill signal was sent
    expect(suspendDone).toBe(false) // both await the ONE shared teardown, not a resolved no-op
    expect(stopDone).toBe(false)
    expect(children.length).toBe(1) // single-flight: no second teardown pass, no extra child
    children[0].release() // the child finally exits
    await Promise.all([suspendP, stopP])
    expect(suspendDone).toBe(true)
    expect(stopDone).toBe(true)
    await expect(rt.translate(translateOpts)).rejects.toThrow(/stopped/) // stop() stayed permanent
  })

  it('overlapping suspends stay single-flight: a racing translate is refused until the SHARED teardown settles (M5)', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    children[0].hold = true
    const s1 = rt.suspend()
    const s2 = rt.suspend() // overlapping — must JOIN s1, never start a second pass
    await tick()
    await tick()
    // While the shared teardown is still killing, `tearingDown` is HELD → a racing translate is
    // refused (pre-fix, s2's finally cleared the flag early and this would cold-start instead).
    await expect(rt.translate(translateOpts)).rejects.toThrow(/suspending/)
    expect(children.length).toBe(1)
    children[0].release()
    await Promise.all([s1, s2])
    // Only now that the shared teardown settled is `tearingDown` cleared → translate restarts.
    const out = await rt.translate(translateOpts)
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    await rt.stop()
  })

  it('stop() is PERMANENT: kills the child, cancels the idle timer, and blocks restart', async () => {
    const { spawn, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    await rt.stop()
    expect(children[0].killed).toBe(true)
    expect(state.clearCount).toBeGreaterThanOrEqual(1)
    await expect(rt.translate(translateOpts)).rejects.toThrow(/stopped/)
  })

  it('suspend() is SOFT: kills the child but a later translate lazily restarts', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    await rt.suspend()
    expect(children[0].killed).toBe(true)
    const out = await rt.translate(translateOpts) // NOT stopped — lazily restarts after lock
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    await rt.stop()
  })

  it('stop() during an in-flight soft teardown AWAITS it (no orphan)', async () => {
    const { spawn, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    children[0].hold = true
    state.fire!() // soft teardown now in flight (gated open)
    let stopResolved = false
    const stopP = rt.stop().then(() => (stopResolved = true))
    await tick()
    await tick()
    expect(stopResolved).toBe(false) // stop() awaits idleTeardownPromise
    children[0].release()
    await stopP
    expect(stopResolved).toBe(true)
    expect(children.length).toBe(1) // no orphan, no extra child
  })
})

describe('createSelectedTranslator — availability ladder', () => {
  const modelInfo = { id: 'translategemma', modelPath: '/models/tg.gguf', contextTokens: 4096 }

  it('returns null when no translation model is configured', () => {
    const t = createSelectedTranslator({ rootPath: '/drive', model: null, resolveBin: () => '/bin/ls' })
    expect(t).toBeNull()
  })

  it('returns null when the llama-server binary is absent', () => {
    const t = createSelectedTranslator({
      rootPath: '/drive',
      model: modelInfo,
      resolveBin: () => null,
      modelExists: () => true
    })
    expect(t).toBeNull()
  })

  it('returns null when the weights are not present', () => {
    const t = createSelectedTranslator({
      rootPath: '/drive',
      model: modelInfo,
      resolveBin: () => '/bin/ls',
      modelExists: () => false
    })
    expect(t).toBeNull()
  })

  it('builds a Translator when binary + weights are present', () => {
    const reasons: string[] = []
    const t = createSelectedTranslator({
      rootPath: '/drive',
      model: modelInfo,
      resolveBin: () => '/bin/ls',
      modelExists: () => true,
      onSelect: (_kind, reason) => reasons.push(reason)
    })
    expect(t).not.toBeNull()
    expect(t?.modelId).toBe('translategemma')
    expect(t?.contextWindow()).toBe(4096)
    expect(reasons.some((r) => /binary \+ weights present/.test(r))).toBe(true)
  })
})

// Issue #42 — the translation device ladder: the sidecar honours the SAME Settings signals the
// chat ladder reads (gpuMode + gpuAutoDisabled, re-read per COLD START), attempts GPU auto-offload
// (no device args), and on a non-transient GPU start failure falls back to forced CPU ONCE within
// the same start, latching the session to CPU afterwards. A mid-session crash of a GPU-composed
// sidecar arms the same latch. The latch is session-only and never writes the persisted
// `gpuAutoDisabled` (chat's ladder owns that) — a translation-only GPU fault must not force chat
// into compatibility mode.
describe('TranslationRuntime — GPU device ladder (issue #42)', () => {
  const deviceOf = (args: string[]): string => (args.join(' ').includes('--device none') ? 'cpu' : 'auto')

  it("gpuMode 'off' forces --device none", async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      idleTimeoutMs: 100_000,
      gpu: { getGpuMode: () => 'off' }
    })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe('cpu')
    await rt.stop()
  })

  it('a persisted gpuAutoDisabled forces --device none (a previously detected GPU problem is respected)', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      idleTimeoutMs: 100_000,
      gpu: { getGpuMode: () => 'auto', getGpuAutoDisabled: () => true }
    })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe('cpu')
    await rt.stop()
  })

  it('the signals are re-read per COLD START: a Settings flip takes effect after a suspend, no restart', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    let mode: 'auto' | 'off' = 'off'
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      idleTimeoutMs: 100_000,
      gpu: { getGpuMode: () => mode }
    })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe('cpu') // launched while 'off'
    await rt.suspend()
    mode = 'auto'
    await rt.translate(translateOpts) // lazy cold restart re-resolves the device
    expect(deviceOf(calls[1].args)).toBe('auto')
    await rt.stop()
  })

  it('a failed GPU attempt falls back to forced CPU WITHIN the same translate() and latches the session', async () => {
    // Child 0 (the GPU attempt) dies before health; every later child is healthy. The fake fetch
    // refuses connections while attempt 1 is live (a dead child must not pass its health probe).
    const calls: Array<{ args: string[] }> = []
    const children: FakeChild[] = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      children.push(child)
      if (calls.length === 1) queueMicrotask(() => child.emit('exit', 1, null))
      return child
    }
    const good = translationFetch()
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (calls.length < 2) throw new Error('connection refused') // the dying GPU attempt
      return good.fetchImpl(url, init)
    }) as typeof fetch
    const fallbacks: string[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      idleTimeoutMs: 100_000,
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    const out = await rt.translate(translateOpts) // GPU rung fails → CPU rung serves the window
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    expect(deviceOf(calls[0].args)).toBe('auto') // rung 1: GPU auto-offload
    expect(deviceOf(calls[1].args)).toBe('cpu') // rung 2: forced CPU, same start
    expect(fallbacks.length).toBe(1)
    expect(fallbacks[0]).toMatch(/GPU-attempt start failed/)
    // The session latch: a later cold start (post-suspend, gpu signals unchanged) pins CPU —
    // no repeated GPU health timeout per window.
    await rt.suspend()
    await rt.translate(translateOpts)
    expect(deviceOf(calls[2].args)).toBe('cpu')
    expect(fallbacks.length).toBe(1) // the latch arms (and reports) once
    await rt.stop()
  })

  it('only the FINAL (CPU) rung failing arms the permanent startFailed latch — with the F-7 code', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      queueMicrotask(() => child.emit('exit', 1, null)) // EVERY child dies (a truly broken GGUF)
      return child
    }
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    const err = await rt.translate(translateOpts).catch((e: unknown) => e)
    expect(isTranslationStartError(err)).toBe(true)
    expect((err as { code?: string }).code).toBe(TRANSLATION_START_FAILED_CODE)
    expect(calls.length).toBe(2) // walked BOTH rungs (auto, then cpu) before latching
    expect(deviceOf(calls[0].args)).toBe('auto')
    expect(deviceOf(calls[1].args)).toBe('cpu')
    await expect(rt.translate(translateOpts)).rejects.toThrow() // latched
    expect(calls.length).toBe(2) // no third spawn
    await rt.stop()
  })

  it('a transient bind race on the GPU attempt does NOT fall back or latch — the retry re-attempts GPU', async () => {
    const calls: Array<{ args: string[] }> = []
    const spawn = (_c: string, args: string[]): ChildProcessLike => {
      calls.push({ args })
      const child = new FakeChild()
      const stderr = new EventEmitter()
      ;(child as unknown as { stderr: EventEmitter }).stderr = stderr
      queueMicrotask(() => {
        stderr.emit('data', 'bind: address already in use')
        child.emit('exit', 1, null)
      })
      return child
    }
    const fallbacks: string[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch,
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    await rt.translate(translateOpts).catch(() => undefined)
    await rt.translate(translateOpts).catch(() => undefined)
    expect(fallbacks.length).toBe(0) // a port steal is not a device fault (chat REL-1 parity)
    // LlamaServer itself retries a bind race once on a fresh port → 2 spawns per translate. The
    // point here: EVERY spawn kept the GPU posture — the CPU rung was never walked, nothing latched.
    expect(calls.length).toBe(4)
    expect(calls.every((c) => deviceOf(c.args) === 'auto')).toBe(true)
    await rt.stop()
  })

  it('a GPU-composed sidecar dying MID-SESSION latches the session to CPU (chat §5.3, session-scoped)', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const fallbacks: string[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      idleTimeoutMs: 100_000,
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe('auto')
    // The healthy GPU-composed child dies on its own (driver crash) — outside stop().
    children[0].emit('exit', 134, null)
    await tick()
    expect(fallbacks.length).toBe(1)
    expect(fallbacks[0]).toMatch(/exited unexpectedly mid-session/)
    // The M1 recovery cold start now pins CPU instead of crash-looping the GPU.
    const out = await rt.translate(translateOpts)
    expect(out).toBe(COMPLETION_TEXT)
    expect(deviceOf(calls[1].args)).toBe('cpu')
    await rt.stop()
  })

  it('a CPU-composed sidecar dying mid-session does NOT touch the device posture', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const fallbacks: string[] = []
    let mode: 'auto' | 'off' = 'off'
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      idleTimeoutMs: 100_000,
      gpu: { getGpuMode: () => mode },
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe('cpu')
    children[0].emit('exit', 134, null) // a CPU crash is NOT a GPU signal
    await tick()
    expect(fallbacks.length).toBe(0)
    mode = 'auto' // the user re-enables GPU — nothing latched, so it is honoured
    await rt.translate(translateOpts)
    expect(deviceOf(calls[1].args)).toBe('auto')
    await rt.stop()
  })
})
