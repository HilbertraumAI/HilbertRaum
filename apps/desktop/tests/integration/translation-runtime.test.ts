import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { TranslationRuntime, type TranslateOptions } from '../../src/main/services/translation/runtime'
import { createSelectedTranslator } from '../../src/main/services/translation/factory'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// TG-2 fake-server tests for the real TranslationRuntime (plan §4 TG-2): launch args (NO --jinja,
// --ctx-size 4096, --parallel 1, --device none), the raw /completion streaming + stop/temperature,
// abort forwarding, error mapping, single-flight + failed-start latch, and — the hybrid heart —
// the SOFT idle-teardown interlock (vision RUNTIME-4) alongside stop()/suspend() (reranker). No
// real binary is spawned: spawn/fetchImpl/findPort are injected (the e5/reranker/vision seam).

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
  it('launches WITHOUT --jinja, with --ctx-size 4096 --parallel 1 --device none, loopback only', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleTimeoutMs: 100_000 })
    await rt.translate(translateOpts)
    const args = calls[0].args.join(' ')
    expect(args).not.toContain('--jinja') // the #20305 regression (plan §1.1 / §2 D2)
    expect(args).not.toContain('--reasoning-format') // not the chat CHAT_SERVER_ARGS
    expect(args).toContain('--ctx-size 4096') // plan §2 D4
    expect(args).toContain('--parallel 1') // sequential windows; contains #25142 (plan §2 D8/D9)
    expect(args).toContain('--device none') // CPU-pinned for TG-2 (plan §2 D8)
    expect(args).toContain('--chat-template gemma') // avoids the #20305 STARTUP crash (TG-2 smoke finding)
    expect(args).toContain('--host 127.0.0.1') // loopback only
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

  it('latches a failed start (fail fast, ONE spawn) instead of re-awaiting the health timeout', async () => {
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
      fetchImpl: (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    })
    await expect(rt.translate(translateOpts)).rejects.toThrow()
    await expect(rt.translate(translateOpts)).rejects.toThrow()
    expect(calls.length).toBe(1) // the latch prevented a second spawn + health-timeout stall
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

  it('a soft idle teardown lets the next translate cold-start a fresh child', async () => {
    const { spawn, calls, children } = gatedSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    children[0].hold = true // hold child0's exit so the soft teardown stays IN FLIGHT
    state.fire!() // nulls this.server synchronously, kills child0 (gated)
    expect(children[0].killed).toBe(true)
    const out = await rt.translate(translateOpts) // server===null → cold-start a NEW child
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    children[0].release()
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
