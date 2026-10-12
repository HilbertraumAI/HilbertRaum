import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter, getEventListeners } from 'node:events'
import {
  TranslationRuntime,
  isRequestTimeoutError,
  isTranslationStartError,
  TRANSLATION_START_FAILED_CODE,
  type TranslateOptions,
  type TranslationGpuDeps
} from '../../src/main/services/translation/runtime'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'
import { isRuntimeUnresponsiveError } from '../../src/main/services/runtime/llama'
import { EngineCannotRunError, engineProblemFor, resetEngineProblemsForTest } from '../../src/main/services/runtime/engine-load'
import { holdEngineSpawns } from '../../src/main/services/runtime/spawn-gate'
import { until, within } from '../helpers/hang-budget'
import {
  FakeChild,
  GatedChild,
  exitingChild,
  fakeSpawn,
  fakeIdleClock,
  loadingSidecar,
  sseBody
} from '../helpers/fake-sidecar'

// TG-2 fake-server tests for the real TranslationRuntime (plan §4 TG-2): launch args (NO --jinja,
// --ctx-size 4096, --parallel 1), the raw /completion streaming + stop/temperature, abort
// forwarding, error mapping, the failed-start latch, the GPU device ladder (issue #42:
// gpuMode/gpuAutoDisabled honoured per cold start, GPU-fail → forced-CPU fallback + session latch),
// and — the hybrid heart — the SOFT idle-teardown interlock (vision RUNTIME-4) alongside
// stop()/suspend() (reranker). No real binary is spawned: spawn/fetchImpl/findPort are injected
// (the e5/reranker/vision seam; fakes: `tests/helpers/fake-sidecar.ts`).

/** A canned /completion SSE stream: two content frames + a terminal stop frame with timings. */
const COMPLETION_SSE =
  'data: {"content":"Good ","stop":false}\n\n' +
  'data: {"content":"day.","stop":false}\n\n' +
  'data: {"content":"","stop":true,"stopping_word":"<end_of_turn>","timings":{"predicted_per_second":9.5,"predicted_n":3}}\n\n'
const COMPLETION_TEXT = 'Good day.'

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

/** A fetch whose every request is refused — a child that died before it could listen. */
const refusingFetch = (async () => {
  throw new Error('connection refused')
}) as unknown as typeof fetch

/** A FakeChild that prints its load log right after spawn, chunk by chunk as a real pipe splits it, and
 *  stays alive (a child that dies before healthy is fake-sidecar's `exitingChild`). */
function spawnedChild(stderr: string[]): FakeChild {
  const child = new FakeChild()
  const err = new EventEmitter()
  ;(child as unknown as { stderr: EventEmitter }).stderr = err
  queueMicrotask(() => {
    for (const chunk of stderr) err.emit('data', chunk)
  })
  return child
}

/** A spawn whose FIRST child holds its exit after a kill until `held.releaseExit()` (a teardown in flight);
 *  later children exit at once. */
function spawnHoldingFirst() {
  const held = new GatedChild()
  let spawned = 0
  return { held, ...fakeSpawn<ChildProcessLike>(() => (spawned++ === 0 ? held : new FakeChild())) }
}

const base = {
  modelId: 'translategemma',
  binPath: '/bin/llama-server',
  modelPath: '/models/translategemma.gguf',
  contextTokens: 4096,
  findPort: async () => 51200,
  healthIntervalMs: 1,
  /** An idle clock nobody fires: no row is torn down by the wall clock (nor by a HILBERTRAUM_TRANSLATION_IDLE_MS
   *  left in the shell); the idle rows inject `fakeIdleClock()`. */
  idleClock: { set: () => ({ clear: () => undefined }) }
}

const translateOpts: TranslateOptions = { sourceLang: 'de', targetLang: 'en', text: 'Guten Tag.' }

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Two macrotask hops, for a NEGATIVE with nothing to wait on: everything on the way to a spawn or a settle is
 *  microtasks here (findPort, the dev-mode binary check, the fake fetch), so whatever would happen without a
 *  timer has happened by now. */
async function hops(): Promise<void> {
  await tick()
  await tick()
}

describe('TranslationRuntime — launch + translate', () => {
  it('launches WITHOUT --jinja, with --ctx-size 4096 --parallel 1, GPU auto-offload by default, loopback only', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate(translateOpts)
    const args = calls[0].args.join(' ')
    expect(args).not.toContain('--jinja') // the #20305 regression (plan §1.1 / §2 D2)
    expect(args).not.toContain('--reasoning-format') // not the chat CHAT_SERVER_ARGS
    expect(args).toContain('--ctx-size 4096') // plan §2 D4
    expect(args).toContain('--parallel 1') // sequential windows; contains #25142 (plan §2 D8/D9)
    // One slot here is TRANSLATION_SLOT_ARGS' own decision, in the long form: the chat server's
    // `-np 1` (#319) never reaches this sidecar, exactly as `--jinja` never does.
    expect(args).not.toContain('-np ')
    // #399 D5 likewise: --cache-ram is gated on the CHAT model's family in LlamaRuntime and never
    // reaches this sidecar (TranslateGemma is a gemma family — the one that would have matched).
    expect(args).not.toContain('--cache-ram')
    // Issue #42: default posture = GPU auto-offload, the chat rung-1 shape — NO device args
    // (b9849 defaults ngl=auto + fit=on; on a GPU-less machine this IS CPU mode).
    expect(args).not.toContain('--device')
    expect(args).not.toContain('-ngl') // NEVER pass -ngl (the GPU record's hard rule)
    expect(args).toContain('--chat-template gemma') // avoids the #20305 STARTUP crash (TG-2 smoke finding)
    // #605: a progress frame per 512 prompt tokens — at the default 2048 a window is one batch, silent until 100 %.
    expect(args).toContain('--batch-size 512 --ubatch-size 512')
    expect(args).toContain('--host 127.0.0.1') // loopback only
    expect(rt.isStartFailed()).toBe(false) // a healthy instance never reads as latched (BE-7)
    await rt.stop()
  })

  it.each<[string, number | undefined, number]>([
    ['omitted: the 4096 default', undefined, 4096],
    ["8192: the manifest's own value", 8192, 8192]
  ])('launches --ctx-size from the manifest contextTokens and reports the same contextWindow() (%s)', async (_label, contextTokens, ctx) => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, contextTokens, spawn, fetchImpl })
    await rt.translate(translateOpts)
    expect(calls[0].args.join(' ')).toContain(`--ctx-size ${ctx}`)
    expect(rt.contextWindow()).toBe(ctx) // the window planner clamps against this — it must match the server
    await rt.stop()
  })

  it('POSTs the trained prompt to /completion with temperature 0 + stop token, streams the text', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, bodies, urls } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })

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
    expect(body.return_progress).toBe(true) // #605: the prompt-progress frames the compute clock watches
    expect(timings).toEqual({ predicted_per_second: 9.5, predicted_n: 3 }) // the smoke's tok/s artifact
    await rt.stop()
  })

  it('passes maxTokens through as n_predict', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, bodies } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate({ ...translateOpts, maxTokens: 512 })
    expect(bodies[0].n_predict).toBe(512)
    await rt.stop()
  })

  it('latches a failed start with the distinct startFailed code (fail fast, ONE spawn) — F-7', async () => {
    const { spawn, calls } = fakeSpawn(() => exitingChild(1)) // dies immediately (corrupt GGUF)
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      // gpuMode 'off' → the launch is ALREADY forced-CPU, so there is no GPU→CPU rung to walk:
      // a start failure latches after exactly one spawn (the pre-#42 shape, preserved verbatim).
      gpu: { getGpuMode: () => 'off' },
      fetchImpl: refusingFetch
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
    // Deterministically wait until the request has REACHED fetch (the signal was handed over)
    // before aborting — a fixed `sleep(2)` could fire before fetch under CPU starvation and
    // exercise a different (pre-flight) path. State-poll on the captured signal (TS-1).
    await until(() => seenSignal !== undefined, 'the request reaching fetch')
    controller.abort()
    await expect(within(p, 'the Stop ending the request')).rejects.toThrow(/abort/i)
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
})

// The idle-teardown interlock (vision RUNTIME-4 pattern) + the reranker stop()/suspend() split.
// Injected clock → deterministic (fire teardown on demand), no wall-clock idle sleeps.
describe('TranslationRuntime — idle teardown + stop/suspend', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('arms an unref\'d idle timer on settle and tears the idle sidecar down when it fires', async () => {
    vi.stubEnv('HILBERTRAUM_TRANSLATION_IDLE_MS', '') // the shipped default, whatever the shell sets
    const { spawn, children } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeIdleClock()
    const armedFor: number[] = []
    const idleClock = { set: (cb: () => void, ms: number) => (armedFor.push(ms), clock.set(cb)) }
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock })
    await rt.translate(translateOpts)
    expect(armedFor).toEqual([120_000]) // DEFAULT_TRANSLATION_IDLE_MS, the bound that ships
    expect(state.setCount).toBe(1)
    expect(state.unrefCount).toBe(1) // never blocks a clean quit
    state.fire!() // idle window elapses → soft teardown kills the child
    expect(children[0].killed).toBe(true)
    await rt.stop()
  })

  it('re-entry RESETS the idle clock; a reused sidecar is never torn down by the stale timer', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeIdleClock()
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
    // child0 holds its exit so the soft teardown stays IN FLIGHT
    const { held, spawn, calls } = spawnHoldingFirst()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    state.fire!() // nulls this.server synchronously, kills child0 (gated, still alive)
    expect(held.killed).toBe(true)
    let resolved = false
    const p = rt.translate(translateOpts).then((out) => {
      resolved = true
      return out
    })
    await hops()
    // Parked on the in-flight soft teardown — NO second spawn yet, so the ~10 GB sidecars never
    // co-exist (the double-load the M5 improvement closes).
    expect(resolved).toBe(false)
    expect(calls.length).toBe(1)
    held.releaseExit() // child0 finally exits → the parked translate now cold-starts
    const out = await p
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2) // exactly one fresh child, spawned only AFTER the old one died
    await rt.stop()
  })

  // #637: the M5 wait above is up to the 2 s kill grace; a cancelled window stops waiting at once and
  // starts nothing.
  it('a cancel ends a translate\'s wait for a soft idle teardown at once, and starts no child (#637)', async () => {
    // child0 holds its exit so the soft teardown stays IN FLIGHT
    const { held, spawn, calls } = spawnHoldingFirst()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    state.fire!()
    const cancel = new AbortController()
    const waiting = rt.translate({ ...translateOpts, signal: cancel.signal }).catch((e: unknown) => e)
    const reason = new DOMException('Cancelled by the user', 'AbortError')
    cancel.abort(reason)
    expect(await within(waiting, 'the cancel ending the wait for the idle teardown')).toBe(reason)
    expect(calls.length).toBe(1) // no fresh ~10 GB child for a window nobody waits for
    held.releaseExit()
    await rt.stop()
  })

  // #637: a cancelled translate no longer waits for its cold start, so its `finally` runs while the
  // start is still in flight — and armIdleTimer returns early on `starting`. The start's own settle
  // must arm the clock, or ~10 GB that lands with nobody waiting stays resident until lock or quit.
  it('a start that lands after every translate was cancelled arms the idle clock, and its fire tears it down (#637)', async () => {
    const { spawn, children } = fakeSpawn()
    const { fetchImpl, state: start } = loadingSidecar(translationFetch().fetchImpl)
    const { clock, state } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })

    const cancel = new AbortController()
    const cancelled = rt.translate({ ...translateOpts, signal: cancel.signal }).catch(() => undefined)
    await until(() => start.probes > 0, 'the cold start polling /health')
    cancel.abort()
    await within(cancelled, 'the cancel ending the wait for the start')
    expect(state.fire).toBeNull() // the translate settled while the start was still loading

    start.loaded = true
    await until(() => rt.deviceStatus()?.live === true, 'the abandoned start landing')
    expect(state.fire).not.toBeNull() // armed by the start's settle, with no translate in flight
    expect(state.unrefCount).toBe(state.setCount)
    state.fire!()
    expect(children[0].killed).toBe(true)
    expect(rt.deviceStatus()?.live).toBe(false)
    await rt.stop()
  })

  // #656: Node can report one death twice — an 'error' (the process is gone) and later its 'exit' — and
  // LlamaServer passes both on as onUnexpectedExit. By the second report a translate has cold-started a NEWER
  // child; dropping the handle again would strand it and spawn a third. This row drives exactly that 'error'
  // then 'exit' pair because it is the one way a stale report reaches the runtime today: a child already
  // stopped by a teardown reports nothing (LlamaServer's own guard, sidecar.test.ts). If #656 is fixed so a
  // death is reported once, the row still pins the outcome — the late notice changes nothing.
  it("a dead child's second death report does NOT clobber the newer instance (identity-compared, #656)", async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate(translateOpts) // child0
    children[0].emit('error', new Error('read ECHILD')) // first report: M1 drops the dead handle
    await rt.translate(translateOpts) // cold-starts child1, the NEWER instance
    expect(calls.length).toBe(2)
    children[0].crash(134) // the late 'exit' of the same death
    expect(await rt.translate(translateOpts)).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2) // child1 reused, no third spawn
    expect(rt.deviceStatus()?.live).toBe(true)
    await rt.stop()
  })

  it('concurrent stop() + suspend() both resolve only AFTER the child is dead (single-flight teardown, M5)', async () => {
    // child0 won't exit until released — the SIGTERM→SIGKILL window
    const { held, spawn, calls } = spawnHoldingFirst()
    const { fetchImpl } = translationFetch()
    const { clock } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    let suspendDone = false
    let stopDone = false
    const suspendP = rt.suspend().then(() => (suspendDone = true))
    const stopP = rt.stop().then(() => (stopDone = true))
    await hops()
    expect(held.killed).toBe(true) // the kill signal was sent
    expect(suspendDone).toBe(false) // both await the ONE shared teardown, not a resolved no-op
    expect(stopDone).toBe(false)
    expect(calls.length).toBe(1) // single-flight: no second teardown pass, no extra child
    held.releaseExit() // the child finally exits
    await Promise.all([suspendP, stopP])
    expect(suspendDone).toBe(true)
    expect(stopDone).toBe(true)
    await expect(rt.translate(translateOpts)).rejects.toThrow(/stopped/) // stop() stayed permanent
  })

  it('overlapping suspends stay single-flight: a racing translate is refused until the SHARED teardown settles (M5)', async () => {
    const { held, spawn, calls } = spawnHoldingFirst()
    const { fetchImpl } = translationFetch()
    const { clock } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    const s1 = rt.suspend()
    const s2 = rt.suspend() // overlapping — must JOIN s1, never start a second pass
    await hops()
    // While the shared teardown is still killing, `tearingDown` is HELD → a racing translate is
    // refused (pre-fix, s2's finally cleared the flag early and this would cold-start instead).
    await expect(rt.translate(translateOpts)).rejects.toThrow(/suspending/)
    expect(calls.length).toBe(1)
    held.releaseExit()
    await Promise.all([s1, s2])
    // Only now that the shared teardown settled is `tearingDown` cleared → translate restarts.
    const out = await rt.translate(translateOpts)
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    await rt.stop()
  })

  it('stop() is PERMANENT: kills the child, cancels the idle timer, and blocks restart', async () => {
    const { spawn, children } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    await rt.stop()
    expect(children[0].killed).toBe(true)
    expect(state.clearCount).toBeGreaterThanOrEqual(1)
    await expect(rt.translate(translateOpts)).rejects.toThrow(/stopped/)
    expect(children.length).toBe(1) // no fresh child behind the refusal
  })

  it('suspend() is SOFT: kills the child but a later translate lazily restarts', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const { clock } = fakeIdleClock()
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
    const { held, spawn, calls } = spawnHoldingFirst()
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    state.fire!() // soft teardown now in flight (gated open)
    let stopResolved = false
    const stopP = rt.stop().then(() => (stopResolved = true))
    await hops()
    expect(stopResolved).toBe(false) // stop() awaits idleTeardownPromise
    held.releaseExit()
    await stopP
    expect(stopResolved).toBe(true)
    expect(calls.length).toBe(1) // no orphan, no extra child
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

  // Tuple rows with `%s`: a `$label` title is quoted and cut at 40 characters.
  it.each<[string, TranslationGpuDeps, 'cpu' | 'auto']>([
    ["gpuMode 'off' forces --device none", { getGpuMode: () => 'off' }, 'cpu'],
    [
      'a persisted gpuAutoDisabled forces --device none (a previously detected GPU problem is respected)',
      { getGpuMode: () => 'auto', getGpuAutoDisabled: () => true },
      'cpu'
    ],
    // #312, acceptance 2 (translation side): chat no longer persists gpuAutoDisabled for a model IT could not load,
    // so the flag stays false and the next translation cold start still resolves 'auto'.
    [
      '#312: gpuAutoDisabled false keeps the cold start on GPU auto-offload — no --device none',
      { getGpuMode: () => 'auto', getGpuAutoDisabled: () => false },
      'auto'
    ]
  ])('%s', async (_label, gpu, device) => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, gpu })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe(device)
    expect(calls[0].args.join(' ').includes('--device')).toBe(device === 'cpu') // 'auto' carries no device args at all
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
    let n = 0
    const { spawn, calls } = fakeSpawn(() => (++n === 1 ? exitingChild(1) : new FakeChild()))
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
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    const out = await rt.translate(translateOpts) // GPU rung fails → CPU rung serves the window
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    expect(deviceOf(calls[0].args)).toBe('auto') // rung 1: GPU auto-offload
    expect(deviceOf(calls[1].args)).toBe('cpu') // rung 2: forced CPU, same start
    expect(fallbacks.length).toBe(1)
    expect(fallbacks[0]).toMatch(/GPU-attempt start failed/)
    expect(rt.deviceStatus()).toEqual({ device: 'cpu', gpuLayers: null, totalLayers: null, live: true }) // the hint reports the CPU attempt that serves
    // The session latch: a later cold start (post-suspend, gpu signals unchanged) pins CPU —
    // no repeated GPU health timeout per window.
    await rt.suspend()
    await rt.translate(translateOpts)
    expect(deviceOf(calls[2].args)).toBe('cpu')
    expect(fallbacks.length).toBe(1) // the latch arms (and reports) once
    await rt.stop()
  })

  it('only the FINAL (CPU) rung failing arms the permanent startFailed latch — with the F-7 code', async () => {
    const { spawn, calls } = fakeSpawn(() => exitingChild(1)) // EVERY child dies (a truly broken GGUF)
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl: refusingFetch
    })
    const err = await rt.translate(translateOpts).catch((e: unknown) => e)
    expect(isTranslationStartError(err)).toBe(true)
    expect((err as { code?: string }).code).toBe(TRANSLATION_START_FAILED_CODE)
    expect((err as { engineCannotRun?: boolean }).engineCannotRun).toBe(false) // #530: not the OS loader
    expect(err).not.toBeInstanceOf(EngineCannotRunError)
    expect(calls.length).toBe(2) // walked BOTH rungs (auto, then cpu) before latching
    expect(deviceOf(calls[0].args)).toBe('auto')
    expect(deviceOf(calls[1].args)).toBe('cpu')
    await expect(rt.translate(translateOpts)).rejects.toThrow() // latched
    expect(calls.length).toBe(2) // no third spawn
    await rt.stop()
  })

  it('a transient bind race on the GPU attempt does NOT fall back or latch — the retry re-attempts GPU', async () => {
    const { spawn, calls } = fakeSpawn(() => exitingChild(1, 'bind: address already in use'))
    const fallbacks: string[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl: refusingFetch,
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    const err = await rt.translate(translateOpts).catch((e: unknown) => e)
    expect(isTranslationStartError(err)).toBe(false) // the ONE non-latching class: rethrown raw, still retryable (F-7)
    const spawnsAfterFirst = calls.length
    await rt.translate(translateOpts).catch(() => undefined)
    expect(calls.length).toBeGreaterThan(spawnsAfterFirst) // not latched → it tried to start again
    expect(rt.isStartFailed()).toBe(false) // never reads as latched — no replacement (BE-7)
    expect(fallbacks.length).toBe(0) // a port steal is not a device fault (chat REL-1 parity)
    // #163 (T-9): the spawn COUNT is LlamaServer's own bind-retry policy; pin only the posture.
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
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe('auto')
    // The healthy GPU-composed child dies on its own (driver crash) — outside stop().
    children[0].crash(134)
    await tick()
    expect(fallbacks.length).toBe(1)
    expect(fallbacks[0]).toMatch(/exited unexpectedly mid-session/)
    // The M1 recovery cold start now pins CPU instead of crash-looping the GPU.
    const out = await rt.translate(translateOpts)
    expect(out).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2) // M1: exactly one fresh child
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
      gpu: { getGpuMode: () => mode },
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    await rt.translate(translateOpts)
    expect(deviceOf(calls[0].args)).toBe('cpu')
    children[0].crash(134) // a CPU crash is NOT a GPU signal
    await tick()
    expect(fallbacks.length).toBe(0)
    mode = 'auto' // the user re-enables GPU — nothing latched, so it is honoured
    await rt.translate(translateOpts)
    expect(deviceOf(calls[1].args)).toBe('auto')
    await rt.stop()
  })
})

// Issue #42 reopen — cold-start observability: the runtime parses llama.cpp's own load log
// (`load_tensors: offloaded X/Y layers to GPU`, streamed on stderr) for the REAL offload outcome,
// reports it once per successful cold start (`onStarted` — compose-services logs it symmetrically
// with the chat ladder's start line), and exposes it with liveness via `deviceStatus()` (→
// getAppStatus → the Translate screen's #36-style hint). The point: under `--fit` a resident chat
// model can force a silent PARTIAL offload at ~CPU speed — posture alone would hide it.
describe('TranslationRuntime — cold-start device observability (issue #42 reopen)', () => {
  it('parses the offload split from the server load log — across chunk boundaries — and reports it once', async () => {
    // The offload line split mid-number across two stderr chunks (real pipes chunk arbitrarily).
    const { spawn } = fakeSpawn(() =>
      spawnedChild([
        'ggml_vulkan: Found 1 Vulkan devices\nload_tensors: offloaded 12',
        '/49 layers to GPU\nload_all: model loaded\n'
      ])
    )
    const { fetchImpl } = translationFetch()
    const started: unknown[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      onStarted: (info) => started.push(info)
    })
    expect(rt.deviceStatus()).toBeNull() // unknown before the first start
    await rt.translate(translateOpts)
    expect(started).toEqual([{ device: 'auto', gpuLayers: 12, totalLayers: 49 }])
    expect(rt.deviceStatus()).toEqual({ device: 'auto', gpuLayers: 12, totalLayers: 49, live: true })
    // LAST-KNOWN values survive a teardown (the hint stays explainable after a run)…
    await rt.suspend()
    expect(rt.deviceStatus()).toEqual({ device: 'auto', gpuLayers: 12, totalLayers: 49, live: false })
    // …and the next cold start re-reports (one onStarted per successful start).
    await rt.translate(translateOpts)
    expect(started.length).toBe(2)
    expect(rt.deviceStatus()?.live).toBe(true)
    await rt.stop()
  })

  it('parses an offload line buried in ONE large chunk with >window trailing log (CODE-22)', async () => {
    // CODE-22 (full-audit 2026-07-11): the parse used to slice the rolling window to
    // OFFLOAD_PARSE_WINDOW (512) bytes BEFORE matching — a single stderr chunk carrying the line
    // plus >512 bytes of trailing log lost it permanently and the hint degraded to "unknown".
    const { spawn } = fakeSpawn(() =>
      spawnedChild(['load_tensors: offloaded 7/49 layers to GPU\n' + 'x'.repeat(600) + '\nload_all: model loaded\n'])
    )
    const { fetchImpl } = translationFetch()
    const started: unknown[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      onStarted: (info) => started.push(info)
    })
    await rt.translate(translateOpts)
    expect(started).toEqual([{ device: 'auto', gpuLayers: 7, totalLayers: 49 }])
    expect(rt.deviceStatus()).toEqual({ device: 'auto', gpuLayers: 7, totalLayers: 49, live: true })
    await rt.stop()
  })

  it("a forced-CPU start reports device 'cpu' with an honest null split (no offload line printed)", async () => {
    const { spawn } = fakeSpawn(() => spawnedChild(['load_all: model loaded\n']))
    const { fetchImpl } = translationFetch()
    const started: unknown[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      gpu: { getGpuMode: () => 'off' },
      onStarted: (info) => started.push(info)
    })
    await rt.translate(translateOpts)
    expect(started).toEqual([{ device: 'cpu', gpuLayers: null, totalLayers: null }])
    expect(rt.deviceStatus()).toEqual({ device: 'cpu', gpuLayers: null, totalLayers: null, live: true })
    await rt.stop()
  })

  it('a throwing onStarted hook never breaks the start path (observability only)', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      onStarted: () => {
        throw new Error('boom')
      }
    })
    await expect(rt.translate(translateOpts)).resolves.toBe(COMPLETION_TEXT)
    expect(rt.deviceStatus()?.live).toBe(true)
    await rt.stop()
  })
})

// ---- #159 (BE-1): abortable cold start — lock/quit must not await the health window ----
//
// `doTeardown` used to await an in-flight lazy start to completion: for a hung/slow ~10 GB
// cold start that is up to the FULL health timeout (180 s default — the factory passes no
// override) during which lock/quit appear hung and the plaintext DB stays open. The teardown
// now fires a per-ladder AbortController: the health wait stops at its next poll, the child
// is killed via the normal stop path (no orphan), the start rejects AbortError — and an
// aborted start NEVER arms the `startFailed` latch (translation lazily restarts after the
// next unlock) and never falls to the CPU rung. The lock/quit rows themselves — a prompt settle,
// the killed child, no latch, the lazy restart after `suspend()`, a permanent `stop()` — run at the
// production health budget in `sidecar-teardown-abort.test.ts`; this row keeps the GPU posture's own
// rule. Also closes #163 T-4.
describe('#159 (BE-1) — teardown aborts an in-flight cold start', () => {
  it('an aborted GPU-attempt start never falls to the CPU rung mid-teardown, nor latches the session to CPU', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(translationFetch().fetchImpl)
    const fallbacks: string[] = []
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, onDeviceFallback: (r) => fallbacks.push(r) })
    const inflight = rt.translate(translateOpts)
    inflight.catch(() => {})
    await until(() => state.probes > 0, 'the GPU attempt polling /health')
    await within(rt.suspend(), 'the lock ending the start')
    await expect(inflight).rejects.toThrow()
    // Exactly ONE spawn, the aborted 'auto' attempt: no ~10 GB CPU cold load to tear straight down.
    expect(calls.length).toBe(1)
    expect(calls[0].args.join(' ')).not.toContain('--device')
    // An aborted start is not a device fault: the next unlock still tries the GPU.
    expect(fallbacks).toEqual([])
    await rt.stop()
  })
})

// #637: the other half of #159. A lock or quit cancels the start; the job's own cancel used to reach
// only the request after it, so a cancel during a start that hung held the window — and, for a
// document translation, the doc-task lane and with it chat — up to the 180 s health budget (two of
// them on the GPU→CPU ladder). The cancel now ends only that window's wait; the start goes on.
describe('#637 — a cancel during the translation cold start', () => {
  it('ends that translate at once with its own reason; a translate sharing the start gets its text', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(translationFetch().fetchImpl)
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })

    const cancel = new AbortController()
    const cancelled = rt.translate({ ...translateOpts, signal: cancel.signal }).catch((e: unknown) => e)
    await until(() => state.probes > 0, 'the cold start polling /health')
    const other = rt.translate(translateOpts) // the next window joins the same start
    const reason = new DOMException('Cancelled by the user', 'AbortError')
    cancel.abort(reason)
    // The window's own reason: both consumers read a cancel from their aborted signal.
    expect(await within(cancelled, 'the cancel ending the wait for the start')).toBe(reason)

    state.loaded = true
    expect(await within(other, 'the shared start serving the other translate')).toBe(COMPLETION_TEXT)
    expect(children[0].killed).toBe(false) // the cancel never cancelled the start
    expect(calls.length).toBe(1)
    await rt.stop()
  })

  it('a translate cancelled before it begins starts no sidecar', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    const reason = new DOMException('Cancelled by the user', 'AbortError')
    await expect(rt.translate({ ...translateOpts, signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(calls.length).toBe(0)
    await rt.stop()
  })

  // The ladder's CPU rung is a second ~10 GB cold load. When the GPU attempt fails after every
  // translate waiting for it was cancelled, nobody would use that load; the next translate starts
  // on the CPU directly instead (the session latch the failure arms).
  it('a GPU attempt that fails after every translate left loads no CPU rung for nobody; the next translate starts on the CPU', async () => {
    const { spawn, calls, children } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(translationFetch().fetchImpl)
    let fellBack = false
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl,
      onDeviceFallback: () => {
        fellBack = true
      }
    })
    const cancel = new AbortController()
    const cancelled = rt.translate({ ...translateOpts, signal: cancel.signal }).catch(() => undefined)
    await until(() => state.probes > 0, 'the GPU attempt polling /health')
    cancel.abort()
    await within(cancelled, 'the cancel ending the wait for the start')

    // Hold every engine spawn (the engine update's gate), so a CPU rung walked for nobody would stay
    // in flight at the gate, and the suspend below — a lock — would have to wait for it.
    const release = holdEngineSpawns('llama_cpp')
    try {
      children[0].crash(1) // the GPU attempt dies while loading
      await until(() => fellBack, 'the GPU attempt failing')
      await within(rt.suspend(), 'a lock finding no start in flight')
    } finally {
      release()
    }
    expect(calls.length).toBe(1)
    expect(rt.isStartFailed()).toBe(false) // nothing latched against the next translate

    state.loaded = true
    expect(await within(rt.translate(translateOpts), 'the next translate')).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    expect(calls[1].args.join(' ')).toContain('--device none')
    await rt.stop()
  })
})

// ---- #163 (T-3): the per-request timeout WIRING — generation, not just classification ----
//
// The 45-min request cap → `combineSignals(opts.signal, DEFAULT_REQUEST_TIMEOUT_MS)` → the /completion fetch.
// Since #605 a hung sidecar ends at the header wait or the reader's clocks, so the cap bounds only a decode that
// is alive but slower than ~0.74 tok/s (BE-2's "timed out mid-decode" class). Driven at the shipped value under
// fake timers (CONTRIBUTING "Pin the bound that ships").
describe('#163 (T-3) — per-request timeout wiring', () => {
  afterEach(() => vi.useRealTimers())

  it('a live decode slower than the cap ends at the shipped 2,700,000 ms with the TimeoutError BE-2 reads as too slow, and the sidecar stays up', async () => {
    const { spawn, children } = fakeSpawn()
    let completions = 0
    let send: (frame: string) => void = () => {}
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (!u.endsWith('/completion')) throw new Error(`unexpected url ${u}`)
      completions += 1
      if (completions === 1) return { ok: true, status: 200, body: sseBody(COMPLETION_SSE) } as unknown as Response
      const signal = init!.signal!
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          send = (frame) => c.enqueue(new TextEncoder().encode(frame))
          signal.addEventListener('abort', () => c.error(signal.reason), { once: true }) // as a real fetch does
        }
      })
      return { ok: true, status: 200, body } as unknown as Response
    }) as typeof fetch
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate(translateOpts) // the sidecar starts on real timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const tokens: string[] = []
    let outcome: unknown = 'pending'
    const slow = rt.translate({ ...translateOpts, onToken: (d) => tokens.push(d) }).catch((e: unknown) => (outcome = e))
    await until(() => completions === 2, 'the request reaching the sidecar')
    const token = 'data: {"content":"x","stop":false}\n\n'
    send(token)
    // A token every 60 s: the 120 s decode clock never runs out, so only the cap can end the window.
    for (let t = 60_000; t < 2_700_000; t += 60_000) {
      await vi.advanceTimersByTimeAsync(60_000)
      send(token)
    }
    await vi.advanceTimersByTimeAsync(59_999) // 2,699,999 ms after the request
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await within(slow, 'the request cap ending the window')
    expect(isRequestTimeoutError(outcome)).toBe(true) // with tokens flowed, neither consumer retries it (BE-2)
    expect(isRuntimeUnresponsiveError(outcome)).toBe(false)
    expect(tokens.length).toBe(45)
    expect(children[0].killed).toBe(false) // a slow decode is not a hang: the sidecar is not stopped
    vi.useRealTimers()
    await rt.stop()
  })

  it("a settled window lets go of the caller's signal: no abort listener piles up on a job's shared signal (REL-4)", async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    const job = new AbortController() // one signal for every window, as both consumers pass it
    for (let window = 1; window <= 2; window++) {
      await expect(rt.translate({ ...translateOpts, signal: job.signal })).resolves.toBe(COMPLETION_TEXT)
      // A window that kept its cap would keep this listener (and its 45-min timer) until the cap fired.
      expect(getEventListeners(job.signal, 'abort')).toHaveLength(0)
    }
    await rt.stop()
  })
})

// #605: a hung sidecar used to hold its window until the 45-min request cap (or Electron's own 300 s fetch limit), and
// the retry then queued behind the stuck slot, as every later window of a document did. Now the reader's clocks or the
// header wait end it, and the runtime stops the hung child so the retry starts a fresh one. Production budgets under
// fake timers, as the chat header-wait suite does; the sidecar starts on real timers first.
describe('#605 — a hung translation sidecar', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** /health ok; the `hangAt`-th /completion hangs — before its headers, or after two tokens — and ends only when the
   *  request is aborted, as a real fetch does. Every other request answers. */
  function hangingFetch(hangAt: number, shape: 'headers' | 'mid-stream') {
    let completions = 0
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (!u.endsWith('/completion')) throw new Error(`unexpected url ${u}`)
      completions += 1
      if (completions !== hangAt) return { ok: true, status: 200, body: sseBody(COMPLETION_SSE) } as unknown as Response
      const signal = init!.signal!
      if (shape === 'headers') {
        return await new Promise<Response>((_res, rej) =>
          signal.addEventListener('abort', () => rej(signal.reason), { once: true })
        )
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"content":"Good ","stop":false}\n\ndata: {"content":"da","stop":false}\n\n'))
          signal.addEventListener('abort', () => c.error(signal.reason), { once: true })
        }
      })
      return { ok: true, status: 200, body } as unknown as Response
    }) as typeof fetch
    return { fetchImpl, completions: () => completions }
  }

  it('a decode that stops is ended at 120 s and its sidecar stopped; the retry waits for the exit, then starts a fresh one in the same posture', async () => {
    // The hung child outlives its kill for a while.
    const { held, spawn, calls } = spawnHoldingFirst()
    const { fetchImpl } = hangingFetch(2, 'mid-stream')
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate(translateOpts)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const tokens: string[] = []
    let outcome: unknown = 'pending'
    const hung = rt.translate({ ...translateOpts, onToken: (d) => tokens.push(d) }).then(
      (v) => (outcome = v),
      (e: unknown) => (outcome = e)
    )
    await until(() => tokens.length === 2, 'the two tokens before the hang')
    await vi.advanceTimersByTimeAsync(119_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await within(hung, 'the decode clock ending the window')
    expect(isRuntimeUnresponsiveError(outcome)).toBe(true)
    expect((outcome as Error).message).toContain('no output for 120000ms')
    expect(isRequestTimeoutError(outcome)).toBe(false) // so both consumers retry it, tokens or not
    expect(held.killed).toBe(true)
    vi.useRealTimers()

    let retried = false
    const retry = rt.translate(translateOpts).then((out) => {
      retried = true
      return out
    })
    await hops()
    expect(retried).toBe(false) // never two ~10 GB children at once
    expect(calls.length).toBe(1)
    held.releaseExit()
    expect(await retry).toBe(COMPLETION_TEXT)
    expect(calls.length).toBe(2)
    expect(calls[1].args).toEqual(calls[0].args) // a hang keeps the posture: no switch to the CPU (owner call)
    await rt.stop()
  })

  /** /completion answers the canned stream; the first request's body is held until `releaseFirst()`. Counts requests and
   *  how many are open at the server at once. */
  function slotFetch() {
    const state = { completions: 0, open: 0, maxOpen: 0, releaseFirst: () => {} }
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/health')) return { ok: true, status: 200 } as Response
      state.completions += 1
      state.open += 1
      state.maxOpen = Math.max(state.maxOpen, state.open)
      const held = state.completions === 1
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          if (held) await new Promise<void>((r) => (state.releaseFirst = r))
          c.enqueue(new TextEncoder().encode(COMPLETION_SSE))
          state.open -= 1
          c.close()
        }
      })
      return { ok: true, status: 200, body } as unknown as Response
    }) as typeof fetch
    return { fetchImpl, state }
  }

  // jobs.ts D9: a document translation can start while a Translate job runs. At the one-slot server the second request
  // waited for its headers behind the first window's whole decode — minutes on a CPU, which the 180 s header wait cannot
  // tell from a hang: it would stop a healthy sidecar under both.
  it('overlapping translates queue in the app, never at the one-slot server', async () => {
    const { spawn, calls } = fakeSpawn()
    const { fetchImpl, state } = slotFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    const first = rt.translate(translateOpts)
    await until(() => state.completions === 1, 'the first request reaching the sidecar')
    const second = rt.translate(translateOpts)
    await hops()
    expect(state.completions).toBe(1) // the second waits for the slot
    state.releaseFirst()
    expect(await first).toBe(COMPLETION_TEXT)
    expect(await second).toBe(COMPLETION_TEXT)
    expect(state.completions).toBe(2)
    expect(state.maxOpen).toBe(1)
    expect(calls.length).toBe(1) // one sidecar served both
    await rt.stop()
  })

  it('a cancel ends a translate\'s wait for the slot at once, and sends nothing', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, state } = slotFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    const first = rt.translate(translateOpts)
    await until(() => state.completions === 1, 'the first request reaching the sidecar')
    const cancel = new AbortController()
    const queued = rt.translate({ ...translateOpts, signal: cancel.signal }).catch((e: unknown) => e)
    const reason = new DOMException('Cancelled by the user', 'AbortError')
    cancel.abort(reason)
    expect(await within(queued, 'the cancel ending the wait for the slot')).toBe(reason)
    state.releaseFirst()
    expect(await first).toBe(COMPLETION_TEXT)
    expect(state.completions).toBe(1) // the cancelled window never reached the sidecar
    await rt.stop()
  })

  it('no response headers within 180 s ends the window as hung and stops the sidecar', async () => {
    const { spawn, children } = fakeSpawn()
    const { fetchImpl, completions } = hangingFetch(2, 'headers')
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate(translateOpts)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let outcome: unknown = 'pending'
    const hung = rt.translate(translateOpts).catch((e: unknown) => (outcome = e))
    await until(() => completions() === 2, 'the request reaching the sidecar')
    await vi.advanceTimersByTimeAsync(179_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await within(hung, 'the header deadline ending the window')
    expect(isRuntimeUnresponsiveError(outcome)).toBe(true)
    expect((outcome as Error).message).toContain('no response headers for 180000ms')
    expect(children[0].killed).toBe(true)
    vi.useRealTimers()
    await rt.stop()
  })
})

// Wave 8 ruling (b)(T) (step 4-8): `gpuOccupied()` — true while a GPU-posture ('auto') sidecar is
// loading, resident, or still being torn down (hard or idle); a forced-CPU sidecar never occupies
// the card. The reranker's headroom gate consults this so a GPU rerank never cold-starts beside a
// translation occupant `deviceStatus().live` cannot see (F5 / B-5, the Wave 8 analysis).
describe('Wave 8 ruling (b)(T): TranslationRuntime.gpuOccupied()', () => {
  it('false before any start (nothing to occupy the card with)', () => {
    const { spawn } = fakeSpawn()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl: translationFetch().fetchImpl })
    expect(rt.gpuOccupied()).toBe(false)
  })

  it('(load) true while a GPU-posture cold start is in flight — before deviceStatus().live can see it', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(translationFetch().fetchImpl)
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    const p = rt.translate(translateOpts)
    await until(() => state.probes > 0, 'the GPU-posture cold start polling /health')
    expect(rt.gpuOccupied()).toBe(true) // loading — deviceStatus() would still be null here
    expect(rt.deviceStatus()).toBeNull()
    state.loaded = true
    await within(p, 'the start landing')
    await rt.stop()
  })

  it('(residency) true once the GPU-posture sidecar is resident', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate(translateOpts)
    expect(rt.gpuOccupied()).toBe(true)
    expect(rt.deviceStatus()?.live).toBe(true)
    await rt.stop()
  })

  it('(hard teardown) true while suspend()/stop() is tearing the GPU-posture sidecar down', async () => {
    const { spawn, children } = fakeSpawn(() => new GatedChild())
    const { fetchImpl } = translationFetch()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl })
    await rt.translate(translateOpts)
    const suspendP = rt.suspend()
    expect(rt.gpuOccupied()).toBe(true) // still occupied — the child has not exited yet
    children[0]!.releaseExit()
    await suspendP
    expect(rt.gpuOccupied()).toBe(false)
    await rt.stop()
  })

  it('(idle teardown) true while the soft idle teardown is killing the GPU-posture sidecar', async () => {
    const { spawn, children } = fakeSpawn(() => new GatedChild())
    const { fetchImpl } = translationFetch()
    const { clock, state } = fakeIdleClock()
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, idleClock: clock })
    await rt.translate(translateOpts)
    state.fire!() // idle window elapses -- soft teardown kills the child (B-5's exact window)
    expect(children[0]!.killed).toBe(true)
    expect(rt.gpuOccupied()).toBe(true) // occupied -- deviceStatus().live is already false here
    expect(rt.deviceStatus()?.live).toBe(false)
    children[0]!.releaseExit()
    await tick()
    expect(rt.gpuOccupied()).toBe(false)
    await rt.stop()
  })

  it('(forced-CPU) a CPU-posture translation never occupies the card, loading or resident', async () => {
    const { spawn } = fakeSpawn()
    const { fetchImpl, state } = loadingSidecar(translationFetch().fetchImpl)
    const rt = new TranslationRuntime({ ...base, spawn, fetchImpl, gpu: { getGpuMode: () => 'off' } })
    const p = rt.translate(translateOpts)
    await until(() => state.probes > 0, 'the CPU-posture cold start polling /health')
    expect(rt.gpuOccupied()).toBe(false) // loading
    state.loaded = true
    await within(p, 'the start landing')
    expect(rt.deviceStatus()?.device).toBe('cpu')
    expect(rt.gpuOccupied()).toBe(false) // resident
    await rt.stop()
  })
})

// #530: a program the OS loader refuses is not a device fault — no CPU retry, no fallback note, a
// latched TranslationStartError flagged `engineCannotRun` that the consumers map to the engine copy.
describe('TranslationRuntime — OS loader refusal (#530)', () => {
  afterEach(() => resetEngineProblemsForTest())

  const LOADER_LINE =
    '/media/someone/HR/runtime/llama.cpp/linux/llama-server: error while loading shared libraries: libgomp.so.1: cannot open shared object file: No such file or directory\n'

  it('on the GPU posture: ONE spawn, no CPU retry, no device-fallback note, latched engineCannotRun', async () => {
    const { spawn, calls } = fakeSpawn(() => exitingChild(127, LOADER_LINE))
    const fallbacks: string[] = []
    const rt = new TranslationRuntime({
      ...base,
      spawn,
      fetchImpl: refusingFetch,
      onDeviceFallback: (reason) => fallbacks.push(reason)
    })
    const err = await rt.translate(translateOpts).catch((e: unknown) => e)
    expect(isTranslationStartError(err)).toBe(true)
    expect((err as { engineCannotRun?: boolean }).engineCannotRun).toBe(true)
    expect((err as { code?: string }).code).toBe(TRANSLATION_START_FAILED_CODE)
    expect(calls.length).toBe(1) // the same program would be refused again on the CPU rung
    expect(fallbacks).toEqual([]) // not a device fault
    expect(rt.isStartFailed()).toBe(true)
    expect(engineProblemFor('llama_cpp')?.name).toBe('libgomp.so.1')

    // A later call rethrows the latched error without spawning.
    const again = await rt.translate(translateOpts).catch((e: unknown) => e)
    expect(isTranslationStartError(again)).toBe(true)
    expect((again as { engineCannotRun?: boolean }).engineCannotRun).toBe(true)
    expect(calls.length).toBe(1)
    await rt.stop()
  })
})
