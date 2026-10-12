import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCpuCrashAutoRestart,
  createGpuCrashAutoFallback,
  createSpeculativeCrashAutoFallback,
  clearModelLoadLatch,
  clearModelLoadLatches,
  clearSpeculativeSuppression,
  isSpeculativeSuppressed,
  modelLoadLatchReason,
  COMPATIBILITY_MODE_NOTICE,
  SPEED_UP_DISABLED_NOTICE,
  MTP_SERVER_ARGS,
  WARMUP_MAX_TOKENS,
  WARMUP_PROMPT
} from '../../src/main/services/runtime/factory'
import {
  isNextModelLoadSuppressed,
  latestEffectiveRead,
  latestEffectiveReadBySource,
  MIN_READ_SAMPLE_MS,
  recordChecksumRead,
  resetEffectiveReadForTests,
  suppressNextModelLoadSample
} from '../../src/main/services/read-speed'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { UnexpectedExitInfo } from '../../src/main/services/runtime/sidecar'
import type { EngineProblem, GpuDevice } from '../../src/shared/types'
import { EngineCannotRunError } from '../../src/main/services/runtime/engine-load'
import { deferred, ladderHarness, until } from '../helpers/ladder-harness'

// Phase 15 start ladder (architecture.md GPU record §5.2). Zero binaries, zero GPUs:
// everything runs through the injected makeLlama/makeMock/probe seams (tests/helpers/ladder-harness.ts).

const opts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }

// #372 / #182: the unloadable-model latch and the speculative latch are module state keyed by
// model id, and this file reuses model ids across cases — a case that blames the model (or latches
// MTP off) must never leak its verdict into the next one, so every case starts un-latched.
beforeEach(() => {
  clearModelLoadLatches()
  clearSpeculativeSuppression()
})

const RTX: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }
/** A hybrid laptop's FIRST enumerated device: integrated, reporting shared system memory. */
const IRIS: GpuDevice = { id: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16384, freeMb: 12000 }
/** A discrete card UNDER the usable gate — a 4 GB card since #321 lowered it to 5,120 MiB
 *  (the 6 GB laptop class that used to sit here now clears it). */
const GTX: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce GTX 1650', totalMb: 4096, freeMb: 3600 }

/** What llama-server prints and exits with when it cannot load the weight at all. */
const MODEL_LOAD_REASON =
  'llama-server exited before becoming healthy (code 1) — last output: ' +
  'llama_model_load: error loading model: unknown model architecture: audit fixture'
/** A genuine device fault, same throw shape, different class. */
const DEVICE_LOST_REASON =
  'llama-server exited before becoming healthy (code 134) — last output: ' +
  'ggml_vulkan: vk error: device lost'
/** REL-1: a port-bind race — a transient collision, never a device or a model verdict. */
const BIND_RACE_REASON =
  'llama-server exited before becoming healthy (code 1) — last output: error: bind: address already in use'

/** #182: a manifest that opts in to MTP. 1 GiB of weights ⇒ 1024 + MTP_VRAM_HEADROOM_MB = 4608 MiB
 *  of free VRAM needed on ONE device. */
const MTP_OPTS: RuntimeStartOptions = {
  modelId: 'qwen3.8-27b-q4',
  modelPath: '/w.gguf',
  contextTokens: 8192,
  weightBytes: 1024 * 1024 * 1024,
  speculativeDecoding: 'mtp'
}
/** Roomy enough for the MTP weight + the draft head. */
const BIG: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24576, freeMb: 23000 }

describe('the GPU start ladder', () => {
  it('rung 1 passes NO -ngl and NO --device args; backend = gpu per a non-empty probe', async () => {
    const h = ladderHarness({ probe: [RTX] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].binPath).toBe('/bin/llama-server')
    expect(h.calls[0].extraArgs).toEqual([]) // upstream ngl=auto + fit=on do the work
    expect(h.calls[0].extraArgs.join(' ')).not.toContain('-ngl')
    expect(runtime.backend).toBe('gpu')
    expect(runtime.gpuName).toBe('NVIDIA GeForce RTX 3080 Ti')
    expect(h.failures).toEqual([])
  })

  it('rung 1 success with an EMPTY probe reads as cpu (GPU-less machine)', async () => {
    const h = ladderHarness({ probe: [] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('cpu')
    expect(runtime.gpuName).toBeNull()
  })

  // #380 — an UNKNOWN probe (its 10 s kill-timeout, which the #330 round trip hit because the
  // `--list-devices` child was competing with this very weight upload for the driver) is not
  // "no device". The server's own load log already says where the weights went, and that is
  // what the label must follow: a card decoding at 98–100 tok/s reported as "cpu" poisons the
  // chat header, Diagnostics, the persisted placement, the #322 speed identity and the §5.3
  // crash auto-fallback gate.
  it('an UNKNOWN probe labels the rung from the load log: offloaded layers ⇒ gpu, named from device_info (#380)', async () => {
    const h = ladderHarness({
      probe: null,
      stderr: [
        [
          '  - Vulkan0 : NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)',
          'load_tensors: offloaded 33/33 layers to GPU',
          ''
        ].join('\n')
      ]
    })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('gpu')
    expect(runtime.gpuName).toBe('NVIDIA GeForce RTX 3080 Ti')
  })

  it('an UNKNOWN probe on a HYBRID box names the device the compute buffer landed on, not the first row (#380)', async () => {
    // The `device_info` rows arrive in LOG order, which is not the order the fit used. On this
    // project's own hybrid evidence (`eval/results/hardware/ryzen-7-5800h-rtx-3060-laptop-6gb-
    // 14gb/leg5-device-landing.comment.md`) the AMD iGPU is `Vulkan0`, listed FIRST and given no
    // buffers at all, while every buffer went to `Vulkan1`, the RTX. Naming `devices[0]` would
    // credit the iGPU for a start that ran on the card — the DR2 / M8.2 defect again.
    const h = ladderHarness({
      probe: null,
      stderr: [
        [
          '  - Vulkan0 : AMD Radeon(TM) Graphics (14000 MiB, 12000 MiB free)',
          '  - Vulkan1 : NVIDIA GeForce RTX 3060 Laptop GPU (5994 MiB, 5600 MiB free)',
          'load_tensors: offloaded 29/29 layers to GPU',
          'sched_reserve:      Vulkan1 compute buffer size =  1024.00 MiB',
          ''
        ].join('\n')
      ]
    })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('gpu')
    expect(runtime.gpuName).toBe('NVIDIA GeForce RTX 3060 Laptop GPU')
  })

  it('an UNKNOWN probe with NO offload line in the log still reads as cpu (#380)', async () => {
    const h = ladderHarness({ probe: null, stderr: ['main: server is listening on http://127.0.0.1:1234\n'] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('cpu')
    expect(runtime.gpuName).toBeNull()
  })

  // CHARACTERIZATION of today's behaviour, NOT the design goal — follow-up #TBD-empty-probe. An EMPTY
  // answer (`[]`) is taken as "this machine enumerates no device" and outranks this start's own load
  // log, so a start whose log says it offloaded layers is still labelled cpu (and its placement record
  // says backend 'cpu' beside N>0 GPU layers). #380 moved only the UNKNOWN answer (`null`) to the log
  // (the #380 tests above). If #TBD-empty-probe decides a positive offload line wins, FLIP this
  // expectation — it is the only test that pins the `[]` branch with a log.
  it('an EMPTY probe answer still labels the rung cpu when the load log reports offloaded layers (characterization, #TBD-empty-probe)', async () => {
    const h = ladderHarness({
      probe: [],
      stderr: [
        [
          '  - Vulkan0 : NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)',
          'load_tensors: offloaded 33/33 layers to GPU',
          ''
        ].join('\n')
      ]
    })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('cpu')
    expect(runtime.gpuName).toBeNull()
  })

  it('a probe that answers only AFTER the server start resolved still labels the rung gpu (the concurrent kick-off is intact)', async () => {
    // The #380 fallback must not have cost the ordinary slow-probe path its label: the ladder
    // still awaits the probe after health, so an answer that lands late is used, not skipped.
    const late = deferred<GpuDevice[] | null>()
    const h = ladderHarness({ probe: late.promise })
    const runtime = h.factory(opts)
    let settled = false
    const start = runtime.start().then(() => {
      settled = true
    })
    await until(() => h.calls.length === 1)
    await new Promise((r) => setImmediate(r))
    expect(settled).toBe(false) // parked on the probe, with the fake server already started
    late.resolve([RTX])
    await start
    expect(runtime.backend).toBe('gpu')
    expect(runtime.gpuName).toBe('NVIDIA GeForce RTX 3080 Ti')
  })

  // PR #303 audit M8.2 (P5 residual): `devices[0]` named the iGPU while the model actually ran on the
  // dGPU, so the Chat hint and the Diagnostics line credited the wrong device; the label now comes
  // from the shared `displayDevice` rule. A hybrid laptop's SMALL card (#321: under the usable gate,
  // so nothing is "useful") is still the card, not the iGPU (owner decision 2026-09-07), and an
  // integrated-only box is still named (`useful: false`), so the line never goes blank. SELECTION is
  // untouched — same rung, same (empty) args, still no -ngl: `--fit` decides.
  it.each([
    { name: 'a hybrid [iGPU, dGPU] box: the discrete card (M8.2)', probe: [IRIS, RTX], label: RTX.name },
    {
      name: 'a hybrid [iGPU, SMALL dGPU] box: the card, not the iGPU (owner decision 2026-09-07)',
      probe: [IRIS, GTX],
      label: GTX.name
    },
    { name: 'an integrated-only box: still named, from the integrated device', probe: [IRIS], label: IRIS.name }
  ])(
    'rung 1 is labelled with the shared displayDevice pick, never devices[0], and is gpu for any listed device — $name',
    async ({ probe, label }) => {
      const h = ladderHarness({ probe })
      const runtime = h.factory(opts)
      await runtime.start()
      expect(runtime.gpuName).toBe(label)
      expect(runtime.backend).toBe('gpu') // even below the usable gate: llama.cpp offloads to such a device unasked
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0].extraArgs).toEqual([]) // selection untouched: same rung, no -ngl, no --device
    }
  )

  it('rung 1 failure → rung 2 respawns the SAME binary with exactly --device none and persists the failure', async () => {
    const h = ladderHarness({ failFirst: 1, probe: [RTX] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].binPath).toBe('/bin/llama-server')
    expect(h.calls[1].extraArgs).toEqual(['--device', 'none'])
    expect(runtime.backend).toBe('cpu')
    // The failure was recorded so the NEXT start skips the GPU health timeout.
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0]).toContain('rung 1 failed')
  })

  it('does NOT persist gpuAutoDisabled when rung 1 fails on a port-bind race (REL-1)', async () => {
    // A rung-1 start that died because its port was already taken is a transient TOCTOU
    // race (LlamaServer already retried once), NOT a device/driver fault. Persisting
    // gpuAutoDisabled here would disable GPU for the whole session over one port collision.
    const h = ladderHarness({
      failFirst: 1,
      probe: [RTX],
      failMessage: BIND_RACE_REASON
    })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2) // fell through to rung 2 (forced CPU)
    expect(runtime.backend).toBe('cpu')
    expect(h.failures).toEqual([]) // a port race is not a GPU signal → nothing auto-disables
  })

  it('rungs 1–2 failing land on the rung-3 pure-CPU safety-net build', async () => {
    const h = ladderHarness({ failFirst: 2, probe: [RTX] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2].binPath).toBe('/bin/cpu/llama-server')
    expect(h.calls[2].extraArgs).toEqual([])
    expect(runtime.backend).toBe('cpu')
    // Only the rung-1 (GPU) failure is persisted; rung-2's is not a GPU signal.
    expect(h.failures).toHaveLength(1)
  })

  it('all rungs failing falls back to the mock (rung 4 — never stuck)', async () => {
    const h = ladderHarness({ failFirst: 3 })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.wasMock()).toBe(true)
    expect(runtime.backend).toBe('mock')
    expect(h.selected.at(-1)?.kind).toBe('mock')
    expect(h.selected.at(-1)?.reason).toContain('all llama-server start attempts failed')
  })

  it.each([
    ['gpuMode "off"', { gpuMode: 'off' as const }],
    ['gpuAutoDisabled', { gpuAutoDisabled: true }]
  ])('%s starts at rung 2 (--device none) and its failure is NOT a GPU failure', async (_name, config) => {
    const h = ladderHarness({ ...config, failFirst: 1 })
    const runtime = h.factory(opts)
    await runtime.start()
    // First attempt is already the forced-CPU rung; the safety net catches its failure.
    expect(h.calls[0].extraArgs).toEqual(['--device', 'none'])
    expect(h.calls[1].binPath).toBe('/bin/cpu/llama-server')
    expect(h.failures).toEqual([]) // no GPU attempt → nothing auto-disables
    expect(runtime.backend).toBe('cpu')
  })

  it('omits rung 3 when the drive ships no cpu safety net', async () => {
    const h = ladderHarness({ failFirst: 2, cpuBin: null })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2) // rungs 1 + 2 only, then mock
    expect(runtime.backend).toBe('mock')
  })

  it.each([
    {
      name: 'no llama-server binary is on the drive',
      config: { resolveBin: null },
      reason: 'no llama-server binary on the drive'
    },
    {
      name: 'the weights are absent (checked at opts.modelPath)',
      config: { modelExists: (p: string) => p !== opts.modelPath },
      reason: 'model weights not present'
    }
  ])('still falls back to the mock at CREATION when $name (Phase-10 rule unchanged)', ({ config, reason }) => {
    const h = ladderHarness(config)
    const runtime = h.factory(opts)
    expect(runtime.backend).toBe('mock')
    expect(h.wasMock()).toBe(true)
    expect(h.calls).toHaveLength(0)
    expect(h.selected).toEqual([{ kind: 'mock', reason }])
  })

  it('reports backend through RuntimeManager.status()', async () => {
    const h = ladderHarness({ probe: [RTX] })
    const mgr = new RuntimeManager(h.factory)
    const status = await mgr.start(opts)
    expect(status.backend).toBe('gpu')
    expect(status.gpuName).toBe('NVIDIA GeForce RTX 3080 Ti')
    await mgr.stop()
    expect(mgr.status().backend).toBeUndefined()
  })
})

// CODE-2 (full-audit 2026-07-11): stop() during the ladder walk CANCELS the start — the walk
// aborts between rungs instead of paying the remaining rungs' health timeouts, the in-flight
// rung's runtime is stopped directly (which unblocks a real `waitForHealthy` via its exit
// check), a killed attempt is never persisted as a GPU fault, and the rung-4 mock is NOT
// started for a cancelled start (it would commit a runtime the queued stop must then undo).
describe('ladder start cancellation (full-audit 2026-07-11 CODE-2)', () => {
  it('a stop() BEFORE start() aborts the walk without ever invoking a rung', async () => {
    const h = ladderHarness({})
    const runtime = h.factory(opts)
    await runtime.stop() // e.g. quit lands between factory() and the queued start
    await expect(runtime.start()).rejects.toThrow(/cancelled/i)
    expect(h.calls).toHaveLength(0)
    expect(h.wasMock()).toBe(false)
  })
})

describe('createGpuCrashAutoFallback (§5.3)', () => {
  const info: UnexpectedExitInfo = { exitCode: 134, exitSignal: null, stderrTail: 'vk error' }

  it('persists the failure, notifies with the friendly copy, and restarts ONCE', async () => {
    const restarts: RuntimeStartOptions[] = []
    const persisted: string[] = []
    const notices: string[] = []
    let release: () => void = () => {}
    const restartGate = new Promise<void>((r) => (release = r))
    const handler = createGpuCrashAutoFallback({
      restart: async (o) => {
        restarts.push(o)
        await restartGate
      },
      persistFailure: (reason) => persisted.push(reason),
      notify: (m) => notices.push(m)
    })

    handler(opts, info)
    handler(opts, info) // a second crash report while the restart is in flight → ignored
    release()
    await new Promise((r) => setTimeout(r, 0))

    expect(restarts).toHaveLength(1)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toContain('code 134')
    expect(persisted[0]).toContain('vk error')
    // §11.4 copy: compatibility mode, never "GPU failed" / "your hardware is bad".
    expect(notices).toEqual([COMPATIBILITY_MODE_NOTICE])
    expect(COMPATIBILITY_MODE_NOTICE).not.toMatch(/fail|crash|bad|broken/i)
  })

  it('a failed restart is swallowed and re-arms the handler (the failure surfaces on the next manual start)', async () => {
    let calls = 0
    const handler = createGpuCrashAutoFallback({
      restart: async () => {
        calls++
        throw new Error('restart failed')
      },
      persistFailure: () => {}
    })
    handler(opts, info)
    // A single macrotask hop, no observable to gate on: the rejected restart's .catch (swallows)
    // and .finally (re-arms) are microtasks, all drained before this timer fires.
    await new Promise((r) => setTimeout(r, 0))
    handler(opts, info) // a later crash still falls back
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2)
  })

  // M-C3: a SYNCHRONOUS throw from restart() (before it returns a promise) must not wedge the
  // re-entrancy guard forever — a later crash must still be able to trigger a fresh restart. The
  // GPU and speculative handlers share one implementation; the #599 CPU handler has its own.
  it.each([
    [
      'createGpuCrashAutoFallback',
      (restart: () => Promise<unknown>) => createGpuCrashAutoFallback({ restart, persistFailure: () => {} })
    ],
    [
      'createSpeculativeCrashAutoFallback (#182)',
      (restart: () => Promise<unknown>) => createSpeculativeCrashAutoFallback({ restart })
    ],
    [
      'createCpuCrashAutoRestart (#599, its own implementation)',
      (restart: () => Promise<unknown>) => createCpuCrashAutoRestart({ restart, stop: restart })
    ]
  ])('%s re-arms after a SYNCHRONOUS throw from restart() so future crashes still react (M-C3)', (_name, make) => {
    let calls = 0
    const handler = make(() => {
      calls++
      throw new Error('sync boom') // throws before returning a promise
    })
    expect(() => handler(opts, info)).not.toThrow()
    expect(() => handler(opts, info)).not.toThrow() // not suppressed: the guard reset
    expect(calls).toBe(2) // the CPU handler: restart on the first crash, stop on the second — both reached
  })
})

// #39: warm-up tracking. The ladder runtime reports `warmedUp() === false` until the FIRST
// real generation streams a chunk after start() — the Chat screen shows its calm "the first
// answer takes a little longer" hint only in that state. A model switch builds a fresh
// LadderRuntime, so the flag resets naturally. Deterministic no-model answers (routing/
// refusal/listing) never call chatStream and therefore never mark the runtime warm.
describe('warm-up tracking (#39)', () => {
  const chat = [{ role: 'user' as const, content: 'hi' }]

  it('is cold after start, flips on the first streamed token, and RuntimeManager.status() carries it', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['Hello', ' world'] })
    const manager = new RuntimeManager(h.factory)
    await manager.start(opts)
    const runtime = manager.active()!
    expect(runtime.warmedUp?.()).toBe(false)
    expect(manager.status().warmedUp).toBe(false)

    // Consume only the FIRST token (then early-exit): one chunk is proof the prefill is done.
    for await (const _tok of runtime.chatStream(chat)) break
    expect(runtime.warmedUp?.()).toBe(true)
    expect(manager.status().warmedUp).toBe(true)
  })

  it('a Deep-mode reasoning delta (before any answer token) also marks the runtime warm', async () => {
    // tokens: [] — the generation "streams" only reasoning, which equally proves the prefill ran.
    const h = ladderHarness({ probe: [RTX], tokens: [], reasoningDelta: 'thinking…' })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.warmedUp?.()).toBe(false)

    const seen: string[] = []
    for await (const _tok of runtime.chatStream(chat, { onReasoning: (d) => seen.push(d) })) {
      /* no answer tokens */
    }
    expect(seen).toEqual(['thinking…'])
    expect(runtime.warmedUp?.()).toBe(true)
  })

  it('the wrapped stream still forwards reasoning deltas to the caller unchanged', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['a', 'b'], reasoningDelta: 'r1' })
    const runtime = h.factory(opts)
    await runtime.start()
    const reasoning: string[] = []
    const tokens: string[] = []
    for await (const tok of runtime.chatStream(chat, { onReasoning: (d) => reasoning.push(d) })) {
      tokens.push(tok)
    }
    expect(tokens).toEqual(['a', 'b'])
    expect(reasoning).toEqual(['r1'])
  })

  it('a model switch resets warm-up: the fresh runtime instance is cold again', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['x'] })
    const manager = new RuntimeManager(h.factory)
    await manager.start(opts)
    for await (const _tok of manager.active()!.chatStream(chat)) break
    expect(manager.status().warmedUp).toBe(true)

    await manager.start({ ...opts, modelId: 'm2' })
    expect(manager.status().warmedUp).toBe(false)
  })

  it('a generation that streams NOTHING leaves the runtime cold (an aborted prefill pays again)', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: [] })
    const runtime = h.factory(opts)
    await runtime.start()
    for await (const _tok of runtime.chatStream(chat)) {
      /* zero chunks */
    }
    expect(runtime.warmedUp?.()).toBe(false)
  })
})

// #109: the hidden warm-up generation. After a real rung turns healthy (and its backend
// label is set), start() runs one tiny content-free generation against the INNER runtime
// and discards the output, so "ready" only reports once the one-time prefill/graph
// warm-up cost is paid. The #39 `served` flag deliberately does NOT flip — the real first
// prompt still pays the full system-prompt prefill (no shared cache_prompt prefix), so
// the warm-up hint stays armed as a safety net.
describe('hidden warm-up generation (#109)', () => {
  it('runs AFTER backend labeling on the winning rung and completes BEFORE start() resolves', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const backendsAtWarmup: string[] = []
    let ladder: ModelRuntime
    const h = ladderHarness({
      probe: [RTX],
      chatGate: gate,
      onChat: () => backendsAtWarmup.push(ladder.backend ?? 'unset')
    })
    ladder = h.factory(opts)
    let started = false
    const startP = ladder.start().then(() => {
      started = true
    })

    await until(() => h.chatCalls.length === 1)
    // The label was already set when the warm-up fired — a GPU crash inside this window
    // routes through the §5.3 onGpuCrash auto-fallback (gated on backend === 'gpu').
    expect(backendsAtWarmup).toEqual(['gpu'])
    // …and the "started via rung" selection was logged before the warm-up window.
    expect(h.selected.at(-1)?.reason).toContain('rung 1')
    expect(started).toBe(false) // ready is NOT reported while the warm-up is still running

    release()
    await startP
    expect(started).toBe(true)
    expect(h.warmups).toEqual([{ event: 'done', detail: undefined }])
  })

  it('the request is content-free, thinking-off (no mode), tiny-capped, abortable — and leaves #39 cold', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['warm', 'up'] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.chatCalls).toHaveLength(1)
    expect(h.chatCalls[0]).toEqual({
      content: WARMUP_PROMPT,
      maxTokens: WARMUP_MAX_TOKENS,
      mode: undefined, // omitted = 'balanced' → enable_thinking: false (requestParamsForMode)
      hasSignal: true // the cap can abort it
    })
    expect(WARMUP_MAX_TOKENS).toBeLessThanOrEqual(8)
    // The warm-up called inner.chatStream directly: the #39 served flag did NOT flip, so
    // the warm-up hint stays armed for the real first prompt (its full-prefill safety net).
    expect(runtime.warmedUp?.()).toBe(false)
  })

  it('the rung-4 mock never warms up (zero-assets starts stay instant)', async () => {
    // All real rungs fail → mock commit: no chatStream call is ever made.
    const allFail = ladderHarness({ failFirst: 3 })
    const mockRuntime = allFail.factory(opts)
    await mockRuntime.start()
    expect(mockRuntime.backend).toBe('mock')
    expect(allFail.warmups).toEqual([])
  })

  it('a warm-up failure that is NOT a cancel never fails the start (the server IS healthy)', async () => {
    const h = ladderHarness({ probe: [RTX], chatError: new Error('slot busy') })
    const runtime = h.factory(opts)
    await runtime.start() // resolves despite the failed warm-up
    expect(runtime.backend).toBe('gpu')
    expect(h.warmups).toEqual([{ event: 'failed', detail: 'slot busy' }])
    // Not a rung failure: nothing persisted gpuAutoDisabled, no fallback walk, no mock.
    expect(h.failures).toEqual([])
    expect(h.calls).toHaveLength(1)
    expect(h.wasMock()).toBe(false)
  })

  it('cap expiry aborts the warm-up request and proceeds to ready (never doubles the start)', async () => {
    const h = ladderHarness({ probe: [RTX], chatHangsUntilAbort: true, warmupTimeoutMs: 25 })
    const runtime = h.factory(opts)
    await runtime.start() // a pathological warm-up cannot hold the start hostage
    expect(runtime.backend).toBe('gpu')
    expect(h.warmups).toHaveLength(1)
    expect(h.warmups[0].event).toBe('timeout')
    expect(h.chatCalls[0].hasSignal).toBe(true)
  })

  it('stop() during the warm-up window settles as CANCELLED: no rung walk, no mock, no GPU fault', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    // The killed server makes the warm-up stream error — model the same shape here.
    const h = ladderHarness({ probe: [RTX], chatGate: gate, chatError: new Error('socket closed') })
    const runtime = h.factory(opts)
    const startP = runtime.start()
    startP.catch(() => undefined)
    await until(() => h.chatCalls.length === 1)

    await runtime.stop() // quit / "Lock now" / manual stop lands mid-warm-up
    release()
    await expect(startP).rejects.toThrow(/cancelled/i)

    expect(h.calls).toHaveLength(1) // the walk aborted — rung 2/3 never attempted
    expect(h.wasMock()).toBe(false) // no mock commit for a cancelled start
    expect(h.failures).toEqual([]) // a cancel is not a GPU fault
    expect(h.warmups).toEqual([]) // …and is not logged as a warm-up fault either
  })

  it('a warm-up that completes cleanly despite a racing stop() still settles as CANCELLED', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const h = ladderHarness({ probe: [RTX], chatGate: gate, tokens: ['x'] })
    const runtime = h.factory(opts)
    const startP = runtime.start()
    startP.catch(() => undefined)
    await until(() => h.chatCalls.length === 1)

    await runtime.stop()
    release() // the stream finishes normally — the cancel must STILL win over ready
    await expect(startP).rejects.toThrow(/cancelled/i)
    expect(h.wasMock()).toBe(false)
  })
})

// #108: the ladder records an honest effective-read sample (window bytes / elapsed) from
// the FIRST rung of a walk only — a later rung re-reads a file the failed attempt
// already pulled through the page cache, so its number would be inflated. `weightBytes`
// (from the caller's manifest — covers a vision model's mmproj too) stands in for a
// floor-sized on-disk fixture.
describe('effective-read sample capture (#108)', () => {
  const WEIGHT_BYTES = 6_000_000_000

  beforeEach(() => resetEffectiveReadForTests())

  it('a successful first-rung start records a model_load sample', async () => {
    const h = ladderHarness({ probe: [RTX], startDelayMs: MIN_READ_SAMPLE_MS + 60 })
    const runtime = h.factory({
      modelId: 'm',
      modelPath: '/w.gguf',
      contextTokens: 2048,
      weightBytes: WEIGHT_BYTES
    })
    await runtime.start()

    const sample = latestEffectiveRead()
    expect(sample).not.toBeNull()
    expect(sample?.source).toBe('model_load')
    expect(sample?.modelId).toBe('m')
    expect(sample?.bytes).toBe(WEIGHT_BYTES)
    expect(sample?.ms).toBeGreaterThanOrEqual(MIN_READ_SAMPLE_MS)
  })

  it('a start that succeeds on a LATER rung records nothing (page-cache-warm re-read)', async () => {
    const h = ladderHarness({
      probe: [RTX],
      failFirst: 1,
      startDelayMs: MIN_READ_SAMPLE_MS + 60
    })
    const runtime = h.factory({
      modelId: 'm',
      modelPath: '/w.gguf',
      contextTokens: 2048,
      weightBytes: WEIGHT_BYTES
    })
    await runtime.start()

    expect(h.calls).toHaveLength(2) // rung 1 failed, rung 2 carried the start
    expect(latestEffectiveRead()).toBeNull()
  })
})

// #114: the concurrent sequential weight prefetch that rides the first rung's load
// window. Evidence for the design (measured cold-start wins, the skip rules, the
// rejection of --no-mmap) lives in prefetch.ts's header + issue #114; these tests pin
// the CONTRACT: first rung only, skip-when-just-hashed, abort at window end + on a
// CODE-2 stop, and total isolation of the start from any prefetch outcome.
describe('concurrent weight prefetch (#114)', () => {
  beforeEach(() => resetEffectiveReadForTests())

  it('rides the first rung: started with the load, aborted when the window ends', async () => {
    const h = ladderHarness({})
    await h.factory(opts).start()
    expect(h.prefetches).toHaveLength(1)
    // No weightPaths supplied → the bare modelPath is the file set.
    expect(h.prefetches[0].paths).toEqual([opts.modelPath])
    // The load finished → the window closed and the reader was told to stop.
    expect(h.prefetches[0].aborted).toBe(true)
    await until(() => h.prefetchEvents.length >= 2)
    expect(h.prefetchEvents.map((e) => e.event)).toEqual(['started', 'aborted'])
  })

  it('prefetches the full weightPaths file set (vision: GGUF + mmproj)', async () => {
    const h = ladderHarness({})
    await h.factory({ ...opts, weightPaths: ['/w.gguf', '/mm.proj'] }).start()
    expect(h.prefetches).toHaveLength(1)
    expect(h.prefetches[0].paths).toEqual(['/w.gguf', '/mm.proj'])
  })

  it('skipped when the install-state pass just hashed the weights (page-cache-warm)', async () => {
    suppressNextModelLoadSample()
    const h = ladderHarness({})
    await h.factory(opts).start()
    expect(h.prefetches).toHaveLength(0)
    expect(h.prefetchEvents.map((e) => e.event)).toEqual(['skipped'])
    // The peek did NOT consume the #108 suppression — recordModelLoadRead did, as before.
    expect(isNextModelLoadSuppressed()).toBe(false)
    expect(latestEffectiveRead()).toBeNull()
  })

  // #392 decision (d): the SAMPLE rule is deliberately broader than the PREFETCH skip. "Hashed
  // some time this session" is a weaker warmth signal than "hashed microseconds ago" — on a
  // RAM-constrained machine those pages may already be evicted (#107) — and the asymmetry
  // decides: dropping one possibly-honest load sample costs nothing (the session's checksum
  // sample IS the honest figure), while skipping the prefetch on a genuinely cold cache costs
  // the measured −49 % cold-start win on a 23.5 MB/s stick (prefetch.ts header). Pinned here so
  // a later simplification cannot re-merge the two mechanisms.
  it('a weight hashed EARLIER in the session still prefetches, but records no load sample (#392)', async () => {
    recordChecksumRead(6_000_000_000, 60_000, 'm', opts.modelPath)
    const h = ladderHarness({ startDelayMs: MIN_READ_SAMPLE_MS + 60 })
    await h.factory({ ...opts, weightBytes: 6_000_000_000 }).start()

    expect(h.prefetches).toHaveLength(1)
    expect(h.prefetchEvents[0]?.event).toBe('started')
    // …and the window that prefetch rode read page-cache-warm pages: the checksum stands.
    expect(latestEffectiveReadBySource('model_load')).toBeNull()
  })

  it.each([
    { name: 'a failed rung 1 does not re-prefetch on rung 2', start: opts, probe: undefined },
    {
      name: 'a rung 1a that spawned and failed does not re-prefetch for the plain rung (#182)',
      start: MTP_OPTS,
      probe: [BIG]
    }
  ])('first rung only: $name', async ({ start, probe }) => {
    const h = ladderHarness({ failFirst: 1, probe })
    await h.factory(start).start()
    expect(h.calls).toHaveLength(2)
    expect(h.prefetches).toHaveLength(1) // the failed attempt already pulled the file through the page cache
    expect(h.prefetches[0].aborted).toBe(true) // ended on the failure path
  })

  it('a prefetch read failure never affects the start', async () => {
    const h = ladderHarness({ prefetchFails: true })
    await h.factory(opts).start() // resolves ready — nothing to catch
    await until(() => h.prefetchEvents.some((e) => e.event === 'failed'))
    expect(h.prefetchEvents[0]?.event).toBe('started')
    expect(h.wasMock()).toBe(false)
  })

  it('a CODE-2 stop mid-load aborts the prefetch at once: the reader never outlives a stop or a lock', async () => {
    const gate = deferred<void>()
    const h = ladderHarness({ onStart: () => gate.promise }) // rung 1 parks mid-load
    const runtime = h.factory(opts)
    const startP = runtime.start()
    startP.catch(() => undefined)
    await until(() => h.calls.length === 1)
    await runtime.stop()
    expect(h.prefetches).toHaveLength(1)
    expect(h.prefetches[0].aborted).toBe(true) // stop() ended it — the load window has NOT closed yet
    gate.resolve()
    await expect(startP).rejects.toThrow(/cancelled/i)
  })
})

// Issue #182 — MTP speculative decoding (rung 1a). Design record: architecture.md
// "MTP speculative decoding"; measured evidence: model-benchmarks.md §9.4 addendum.
//
// The shape under test: the manifest OPTS IN, the ladder DECIDES. Every "don't know" answers
// no, because a skipped rung costs nothing while a wrong yes costs a silent partial offload.
describe('MTP speculative decoding (#182)', () => {
  /** Holds the weight, but not the ~2 GiB draft head on top of it. */
  const TIGHT: GpuDevice = { id: 'Vulkan0', name: 'Small card', totalMb: 8192, freeMb: 4000 }

  it('starts rung 1a with EXACTLY the code-owned flag pair when the machine can hold it', async () => {
    const h = ladderHarness({ probe: [BIG] })
    const runtime = h.factory(MTP_OPTS)
    await runtime.start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual(['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2'])
    expect(h.calls[0].extraArgs).toEqual([...MTP_SERVER_ARGS])
    expect(runtime.backend).toBe('gpu')
    expect(h.speculative).toEqual([{ event: 'enabled', detail: undefined }])
    expect(h.selected[0].reason).toContain('rung 1a')
  })

  it('adds NO rung for a model that did not opt in', async () => {
    const h = ladderHarness({ probe: [BIG] })
    await h.factory({ ...MTP_OPTS, speculativeDecoding: null }).start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual([])
    expect(h.speculative).toEqual([])
  })

  // The four "don't know / can't" refusals. All four SKIP the rung — no spawn, no failure,
  // no wasted multi-GB load — and land on exactly today's plain GPU start.
  it.each([
    { name: 'the probe finds no GPU', probe: [] as GpuDevice[], weightBytes: MTP_OPTS.weightBytes, reason: 'no GPU device' },
    {
      name: 'the probe gave no answer (#380 timeout / #530 refusal)',
      probe: null,
      weightBytes: MTP_OPTS.weightBytes,
      reason: 'device probe gave no answer'
    },
    {
      name: 'no single device has the weight + 3.5 GiB of free VRAM',
      probe: [TIGHT],
      weightBytes: MTP_OPTS.weightBytes,
      reason: 'not enough free VRAM'
    },
    {
      // Two cards, 4000 MiB free each: 8000 total would clear the 4608 MiB bar, one card cannot.
      name: 'only the SUM of two cards would hold it (free VRAM is never summed)',
      probe: [TIGHT, { ...TIGHT, id: 'Vulkan1' }],
      weightBytes: MTP_OPTS.weightBytes,
      reason: 'not enough free VRAM'
    },
    {
      name: 'the weight size is unknown (the VRAM check cannot be made)',
      probe: [BIG],
      weightBytes: null,
      reason: 'weight size unknown'
    }
  ])('skips rung 1a without spawning it when $name', async ({ probe, weightBytes, reason }) => {
    const h = ladderHarness({ probe })
    await h.factory({ ...MTP_OPTS, weightBytes }).start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual([]) // straight to today's plain rung 1
    expect(h.speculative).toEqual([{ event: 'skipped', detail: expect.stringContaining(reason) }])
    expect(h.failures).toEqual([]) // a skip is never a GPU fault
  })

  it('is never offered at all when GPU is off or auto-disabled', async () => {
    for (const config of [{ gpuMode: 'off' as const }, { gpuAutoDisabled: true }]) {
      const h = ladderHarness({ ...config, probe: [BIG] })
      await h.factory(MTP_OPTS).start()
      expect(h.calls[0].extraArgs).toEqual(['--device', 'none'])
      expect(h.speculative).toEqual([])
    }
  })

  // The safety net that makes enabling this survivable: an older runtime that rejects the flag,
  // a weight without the draft head, a driver that refuses — rung 1 is next in the walk.
  it('falls through to the plain GPU rung on failure, and never blames the GPU', async () => {
    const h = ladderHarness({
      failFirst: 1,
      probe: [BIG],
      failMessage: 'error: unknown argument: --spec-type'
    })
    const runtime = h.factory(MTP_OPTS)
    await runtime.start()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0].extraArgs).toEqual([...MTP_SERVER_ARGS])
    expect(h.calls[1].extraArgs).toEqual([]) // plain rung 1 — GPU, not CPU
    expect(runtime.backend).toBe('gpu')
    // The whole point: `gpuAutoDisabled` is NOT persisted, so one bad flag cannot exile a
    // working GPU to CPU for every later start.
    expect(h.failures).toEqual([])
    expect(h.speculative.map((e) => e.event)).toEqual(['enabled', 'failed'])
    expect(h.speculative[1].detail).toContain('--spec-type')
  })

  it('latches the model off for the session after one failure — no repeat doomed load', async () => {
    const h = ladderHarness({ failFirst: 1, probe: [BIG] })
    await h.factory(MTP_OPTS).start()
    expect(h.calls).toHaveLength(2)
    await h.factory(MTP_OPTS).start()
    expect(h.calls).toHaveLength(3) // one attempt, not two
    expect(h.calls[2].extraArgs).toEqual([])
    expect(h.speculative.at(-1)).toEqual({
      event: 'skipped',
      detail: 'latched off for this session by an earlier attempt'
    })
    // …and "Try GPU again" re-arms it (the user asking for the accelerated path back).
    clearSpeculativeSuppression()
    await h.factory(MTP_OPTS).start()
    expect(h.calls.at(-1)!.extraArgs).toEqual([...MTP_SERVER_ARGS])
  })

  // A mid-session crash of rung 1a routes to the speculative handler, NOT the §5.3 GPU one:
  // the device is not the suspect, and persisting `gpuAutoDisabled` would need a Diagnostics
  // visit to undo. The model restarts on the GPU with MTP latched off.
  it('routes a mid-session crash to the speculative handler, never to the GPU auto-disable', async () => {
    const h = ladderHarness({ probe: [BIG] })
    const runtime = h.factory(MTP_OPTS)
    await runtime.start()
    h.calls[0].onUnexpectedExit({ exitCode: 1, exitSignal: null, stderrTail: 'vk out of memory' })
    expect(h.specCrashes).toHaveLength(1)
    expect(h.crashes).toEqual([])
    expect(isSpeculativeSuppressed(MTP_OPTS.modelId)).toBe(true)
    expect(h.speculative.at(-1)!.event).toBe('crashed')
    expect(h.speculative.at(-1)!.detail).toContain('vk out of memory')
  })

  it('leaves a PLAIN GPU rung crash on the §5.3 path untouched', async () => {
    const h = ladderHarness({ failFirst: 1, probe: [BIG] })
    await h.factory(MTP_OPTS).start()
    h.calls[1].onUnexpectedExit({ exitCode: 1, exitSignal: null, stderrTail: 'device lost' })
    expect(h.crashes).toHaveLength(1)
    expect(h.specCrashes).toEqual([])
  })

  // Regression guard for the trap this wave walked into: the #108 read sample and the #114
  // prefetch used to be gated on `rungs[0]`, and a SKIPPED rung 1a consumes index 0 without
  // opening a load window — which would have switched both off on every machine that skips it.
  it('still prefetches when rung 1a is skipped (a skipped rung opens no load window and never takes the first-attempt slot the #108 sample shares)', async () => {
    const h = ladderHarness({ probe: [] })
    await h.factory({ ...MTP_OPTS, weightPaths: ['/w.gguf', '/mmproj.gguf'] }).start()
    expect(h.prefetches).toHaveLength(1)
    expect(h.prefetches[0].paths).toEqual(['/w.gguf', '/mmproj.gguf'])
    expect(h.prefetchEvents[0].event).toBe('started')
  })
})

describe('createSpeculativeCrashAutoFallback (#182)', () => {
  const info: UnexpectedExitInfo = { exitCode: 1, exitSignal: null, stderrTail: 'ggml assert' }
  const startOpts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }

  it('restarts once and notifies WITHOUT the compatibility-mode (slower answers) copy', async () => {
    const restarts: RuntimeStartOptions[] = []
    const notices: string[] = []
    const reasons: string[] = []
    const handler = createSpeculativeCrashAutoFallback({
      restart: async (o) => void restarts.push(o),
      onCrash: (r) => reasons.push(r),
      notify: (m) => notices.push(m)
    })
    handler(startOpts, info)
    handler(startOpts, info) // re-entrancy guard: one restart, never a loop
    await until(() => restarts.length > 0)
    expect(restarts).toHaveLength(1)
    expect(notices).toEqual([SPEED_UP_DISABLED_NOTICE])
    expect(notices[0]).not.toBe(COMPATIBILITY_MODE_NOTICE)
    expect(reasons[0]).toContain('ggml assert')
  })
})

// Issue #312 — the CPU control probe. A rung-1 failure used to be persisted as a DEVICE fault
// on the spot, so a model the pinned llama.cpp simply cannot load (unsupported architecture,
// corrupt GGUF, a quantization the pin rejects) latched `gpuAutoDisabled` for the whole
// workspace — downgrading unrelated models AND the translation sidecar to CPU on a machine
// whose GPU is fine. Now the forced-CPU rungs are the control: one of them coming up proves
// the model loads, so the GPU rung was the differentiator (persist, as before); all of them
// dying the SAME way proves the model is the common cause (persist nothing, name the model).
// Anything else — differing classes, or a message shape `failureSignature` cannot classify —
// stays a device verdict, which is today's behaviour and the conservative default.
describe('#312 — a model-load failure is not a device verdict', () => {
  it('every rung dying the same way blames the MODEL: nothing persisted, the mock discloses itself', async () => {
    const h = ladderHarness({
      failFirst: 3,
      probe: [RTX],
      failMessage: MODEL_LOAD_REASON,
      realMock: true
    })
    const runtime = h.factory(opts)
    await runtime.start()

    expect(h.calls).toHaveLength(3) // rung 1 (GPU), rung 2 (--device none), rung 3 (cpu build)
    // Acceptance 1: `gpuAutoDisabled` / `gpuLastError` were never written — the CPU rungs
    // died of the same thing, so the device is not the suspect.
    expect(h.failures).toEqual([])
    // Acceptance 6: the model is named instead, exactly once, with the failure reason.
    expect(h.modelLoadFailures).toHaveLength(1)
    expect(h.modelLoadFailures[0].modelId).toBe('m')
    expect(h.modelLoadFailures[0].reason).toContain('unknown model architecture')
    // The rung-4 graceful fallback is unchanged, and its replies say so.
    expect(runtime.backend).toBe('mock')
    let reply = ''
    for await (const tok of runtime.chatStream([{ role: 'user', content: 'hi' }])) reply += tok
    expect(reply).toContain('this reply is simulated')
  })

  it('the NEXT model is still GPU-eligible: rung 1 first, no --device none, backend gpu', async () => {
    // Acceptance 2 (chat side). `onGpuFailure` here also flips the auto-disable signal, the
    // way `persistGpuFailure` writes it to settings — so if the unloadable model had blamed
    // the device, the healthy model below would start at rung 2.
    const h = ladderHarness({
      failFirst: 3,
      probe: [RTX],
      failMessage: MODEL_LOAD_REASON,
      latchGpuFailures: true
    })
    await h.factory(opts).start()
    expect(h.failures).toEqual([])
    expect(modelLoadLatchReason('m')).not.toBeNull() // #372: the blamed model is latched…

    const healthy = h.factory({ ...opts, modelId: 'healthy' })
    await healthy.start()
    expect(h.calls).toHaveLength(4)
    expect(h.calls[3].extraArgs).toEqual([]) // rung 1 — no --device none anywhere on it
    expect(healthy.backend).toBe('gpu')
    expect(modelLoadLatchReason('healthy')).toBeNull() // …and the latch is per model
  })

  it('a device fault still latches: rung 1 fails, the CPU control comes up, the failure persists', async () => {
    // Acceptance 3. The GPU rung's reason is the model-shaped one on purpose: the classifier
    // never reads llama.cpp's vocabulary — the CPU rung STARTING is what makes it a device
    // verdict. (The plain-message equivalent is 'rung 1 failure → rung 2 respawns the SAME binary…'.)
    const h = ladderHarness({ failFirst: 1, probe: [RTX], failMessage: MODEL_LOAD_REASON })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].extraArgs).toEqual(['--device', 'none'])
    expect(runtime.backend).toBe('cpu')
    expect(h.failures).toHaveLength(1)
    expect(h.modelLoadFailures).toEqual([])
    expect(modelLoadLatchReason('m')).toBeNull() // #372: a device verdict never latches the model
  })

  it('an UNRECOGNISED reason shape on every rung stays a device verdict too', async () => {
    // Acceptance 4: `failureSignature` returns null for anything that is not one of the four
    // sidecar throw shapes, and "no signature" must never un-blame a real GPU fault.
    const h = ladderHarness({ failFirst: 3, probe: [RTX], failMessage: 'something went sideways' })
    await h.factory(opts).start()
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0]).toBe('something went sideways')
    expect(h.modelLoadFailures).toEqual([])
  })

  it('a CODE-2 stop between the rung-1 failure and the CPU rung blames nothing', async () => {
    // The held failure must be dropped when the cancel lands while the CPU rung is coming up: the
    // post-start cancel check sits BEFORE the flush.
    let cancelToo: (() => Promise<void>) | null = null
    const racing = ladderHarness({
      failFirst: 1,
      probe: [RTX],
      failMessage: MODEL_LOAD_REASON,
      onStart: async (index) => {
        if (index === 1) await cancelToo?.()
      }
    })
    const racingRuntime = racing.factory(opts)
    cancelToo = () => racingRuntime.stop()
    await expect(racingRuntime.start()).rejects.toThrow(/cancelled/i)
    expect(racing.failures).toEqual([])
    expect(racing.modelLoadFailures).toEqual([])
    expect(racing.wasMock()).toBe(false)
  })

  it('rung 1a + rung 1 failing with the CPU rung up: one GPU failure, MTP latched off (#182 intact)', async () => {
    // The speculative rung `continue`s before the gpuAttempt branch, so it never sets the held
    // failure; the plain GPU rung does, and rung 2 coming up flushes it. (The MTP describe pins
    // the rest of the #182 contract.)
    const h = ladderHarness({
      failFirst: 2,
      probe: [RTX],
      failMessages: ['error: unknown argument: --spec-type', MODEL_LOAD_REASON]
    })
    const runtime = h.factory(MTP_OPTS)
    await runtime.start()
    expect(h.calls).toHaveLength(3)
    expect(h.calls[0].extraArgs).toEqual([...MTP_SERVER_ARGS]) // rung 1a
    expect(h.calls[1].extraArgs).toEqual([]) // rung 1
    expect(h.calls[2].extraArgs).toEqual(['--device', 'none']) // rung 2 — the control, up
    expect(runtime.backend).toBe('cpu')
    expect(h.failures).toHaveLength(1) // the PLAIN GPU rung's failure only
    expect(h.failures[0]).toBe(MODEL_LOAD_REASON)
    expect(h.modelLoadFailures).toEqual([])
    expect(isSpeculativeSuppressed('qwen3.8-27b-q4')).toBe(true)
  })
})

// #515: the same verdicts on REAL llama-server tails (b11146, captured with the app's argv and
// stdio; tests/fixtures/start-failure-b11146-*.txt). The two rungs' last lines carry different
// per-process timestamps — the #312 comparison has to see past them to the root cause.
describe('#515 — the #312 verdicts on real llama-server tails', () => {
  const reason = (name: string): string =>
    'llama-server exited before becoming healthy (code 1) — last output: ' +
    readFileSync(join(__dirname, '..', 'fixtures', `start-failure-b11146-${name}.txt`), 'utf8').trim()

  it.each([
    {
      name: 'a corrupt GGUF failing on the GPU rung and both CPU rungs',
      tails: ['broken-gguf-gpu', 'broken-gguf-cpu', 'broken-gguf-cpu'],
      device: 0,
      model: 1,
      persisted: null
    },
    {
      name: '…the same with the colour-coded GPU tail the app captured before --log-colors off',
      tails: ['broken-gguf-gpu-coloured', 'broken-gguf-cpu', 'broken-gguf-cpu'],
      device: 0,
      model: 1,
      persisted: null
    },
    {
      name: 'a GPU-side failure with a different cause (an invalid device)',
      tails: ['bad-device', 'broken-gguf-cpu', 'broken-gguf-cpu'],
      device: 1,
      model: 0,
      persisted: 'invalid device: Vulkan7'
    }
  ])('$name: $model model verdict(s), $device device verdict(s)', async ({ tails, device, model, persisted }) => {
    const h = ladderHarness({ failFirst: 3, probe: [RTX], failMessages: tails.map(reason), realMock: true })
    await h.factory(opts).start()
    expect(h.failures).toHaveLength(device)
    expect(h.modelLoadFailures).toHaveLength(model)
    expect(h.failures[0] ?? null).toEqual(persisted === null ? null : expect.stringContaining(persisted))
  })
})

// #372 (the #312 follow-up): (1) a model the ladder blamed is LATCHED for the session — a later
// start of it spawns no rung and pays no health timeout, it re-fires the notice and lands on the
// mock at once; (2) with acceleration off (or the auto-disable flag already persisted) there is no
// GPU rung to compare against, and the model is still NAMED when every rung fails. The latch has
// its own clearing rule (verify / re-download / engine install / restart) — "Try GPU again" is
// about the graphics card and leaves it alone (pinned in performance-gpu.test.ts).
describe('#372 — an unloadable model is latched for the session and named when acceleration is off', () => {
  it('a second start of a blamed model spawns NO rung, names the model again, and lands on the mock at once', async () => {
    const h = ladderHarness({ failFirst: 3, probe: [RTX], failMessage: MODEL_LOAD_REASON, realMock: true })
    await h.factory(opts).start()
    expect(h.calls).toHaveLength(3)
    expect(h.modelLoadFailures).toHaveLength(1)
    expect(modelLoadLatchReason('m')).toContain('unknown model architecture')

    const again = h.factory(opts)
    await again.start()
    expect(h.calls).toHaveLength(3) // nothing spawned: no rung, no health timeout
    expect(again.backend).toBe('mock')
    expect(h.modelLoadFailures).toHaveLength(2) // the notice names the model once more…
    expect(h.modelLoadFailures[1]).toEqual(h.modelLoadFailures[0]) // …with the ORIGINAL reason
    expect(h.failures).toEqual([]) // and the device is still never blamed
    expect(h.selected.at(-1)?.kind).toBe('mock')
    expect(h.selected.at(-1)?.reason).toContain('latched as unloadable this session')
    // The mock's replies still disclose themselves — the outcome of the first walk, minus the wait.
    let reply = ''
    for await (const tok of again.chatStream([{ role: 'user', content: 'hi' }])) reply += tok
    expect(reply).toContain('this reply is simulated')
  })

  it('the latched start never prefetches and never warms up (nothing is loaded)', async () => {
    const h = ladderHarness({ failFirst: 3, probe: [RTX], failMessage: MODEL_LOAD_REASON })
    await h.factory(opts).start()
    const prefetchesBefore = h.prefetches.length
    await h.factory(opts).start()
    expect(h.prefetches).toHaveLength(prefetchesBefore)
    expect(h.warmups).toEqual([])
  })

  it('a stop() before a latched start settles as CANCELLED, not as the mock (CODE-2 holds)', async () => {
    const h = ladderHarness({ failFirst: 3, probe: [RTX], failMessage: MODEL_LOAD_REASON })
    await h.factory(opts).start()
    const notices = h.modelLoadFailures.length
    const again = h.factory(opts)
    await again.stop()
    await expect(again.start()).rejects.toThrow(/cancelled/i)
    expect(h.modelLoadFailures).toHaveLength(notices) // a cancelled start tells the user nothing
    expect(h.selected.filter((s) => s.kind === 'mock')).toHaveLength(1) // only the FIRST walk's mock
  })

  it('clearing the latch for that model re-arms the full walk (verify / re-download seam)', async () => {
    // `failFirst` counts spawns across the whole harness: 6 = both walks fail on every rung.
    const h = ladderHarness({ failFirst: 6, probe: [RTX], failMessage: MODEL_LOAD_REASON })
    await h.factory(opts).start()
    clearModelLoadLatch('m')
    expect(modelLoadLatchReason('m')).toBeNull()
    // The walk runs again — rung 1 first (the GPU was never blamed), then the rest.
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(6)
    expect(h.calls[3].extraArgs).toEqual([])
    expect(h.calls[4].extraArgs).toEqual(['--device', 'none'])
    expect(h.modelLoadFailures).toHaveLength(2)
    expect(h.failures).toEqual([])
    expect(modelLoadLatchReason('m')).toBe(MODEL_LOAD_REASON) // blamed again → latched again
  })

  // Acceptance 2. With no GPU rung the #312 comparison cannot run; the notice must still name the
  // model (where rung 3 comes up instead, 'gpuMode "off" starts at rung 2…' covers it).
  it.each([
    { name: 'acceleration OFF', config: { gpuMode: 'off' as const, failFirst: 2 }, rungs: 2 },
    { name: 'gpuAutoDisabled already persisted', config: { gpuAutoDisabled: true, failFirst: 2 }, rungs: 2 },
    {
      name: 'acceleration OFF with no cpu safety net',
      config: { gpuMode: 'off' as const, cpuBin: null, failFirst: 1 },
      rungs: 1
    }
  ])(
    '$name, every rung failing: the model is named once and latched, the device never blamed, nothing persisted',
    async ({ config, rungs }) => {
      const h = ladderHarness({ ...config, failMessage: MODEL_LOAD_REASON, latchGpuFailures: true })
      const runtime = h.factory(opts)
      await runtime.start()
      expect(h.calls).toHaveLength(rungs) // no GPU rung: the #312 comparison cannot run
      expect(h.calls[0].extraArgs).toEqual(['--device', 'none'])
      expect(runtime.backend).toBe('mock')
      expect(h.modelLoadFailures).toEqual([{ modelId: 'm', reason: MODEL_LOAD_REASON }])
      expect(h.failures).toEqual([]) // `gpuAutoDisabled` is never written on this path
      expect(modelLoadLatchReason('m')).toBe(MODEL_LOAD_REASON)
    }
  )

  it('an UNRECOGNISED failure shape with acceleration off names the model but does NOT latch it', async () => {
    // Unknown evidence is enough to tell the user, not enough to skip every later attempt —
    // the next start walks the rungs again (today's behaviour).
    const h = ladderHarness({ gpuMode: 'off', failFirst: 4, failMessage: 'something went sideways' })
    await h.factory(opts).start()
    expect(h.modelLoadFailures).toHaveLength(1)
    expect(h.failures).toEqual([])
    expect(modelLoadLatchReason('m')).toBeNull()
    await h.factory(opts).start()
    expect(h.calls).toHaveLength(4) // walked again: rung 2 + rung 3 a second time
    expect(h.modelLoadFailures).toHaveLength(2)
  })

  it('a bind race on the last rung names the model but never latches it (a port collision is transient)', async () => {
    const h = ladderHarness({ gpuMode: 'off', failFirst: 2, failMessage: BIND_RACE_REASON })
    await h.factory(opts).start()
    expect(h.modelLoadFailures).toHaveLength(1)
    expect(modelLoadLatchReason('m')).toBeNull()
  })

  it('a rung-1 bind race (never held) followed by the CPU rungs dying of the model: named, latched, no device verdict', async () => {
    // REL-1 drops the GPU rung's bind race before #312 can hold it, so there is no comparison
    // to make — the same "no GPU verdict" branch as acceleration off, and the model is what
    // the CPU rungs could not load.
    const h = ladderHarness({
      failFirst: 3,
      probe: [RTX],
      failMessages: [BIND_RACE_REASON, MODEL_LOAD_REASON, MODEL_LOAD_REASON]
    })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('mock')
    expect(h.failures).toEqual([])
    expect(h.modelLoadFailures).toEqual([{ modelId: 'm', reason: MODEL_LOAD_REASON }])
    expect(modelLoadLatchReason('m')).toBe(MODEL_LOAD_REASON)
  })

  it('the conservative device verdict (differing classes, all rungs down) never latches the model either', async () => {
    const h = ladderHarness({
      failFirst: 3,
      probe: [RTX],
      latchGpuFailures: true, // the device verdict persists, the way `persistGpuFailure` does
      // The Intel-Mac shape (known-limitations): the GPU rung dies of the device, the CPU rungs
      // die of something else entirely. Ambiguous ⇒ blame the device, i.e. today's behaviour.
      failMessages: [DEVICE_LOST_REASON, MODEL_LOAD_REASON, MODEL_LOAD_REASON]
    })
    const first = h.factory(opts)
    await first.start()
    expect(first.backend).toBe('mock')
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0]).toContain('vk error: device lost')
    expect(h.modelLoadFailures).toEqual([])
    expect(modelLoadLatchReason('m')).toBeNull()
    // The next start of the same model still WALKS — from rung 2, as the persisted flag says —
    // and is not short-circuited by any latch.
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(4)
    expect(h.calls[3].extraArgs).toEqual(['--device', 'none'])
    expect(runtime.backend).toBe('cpu')
  })

  it('a CODE-2 stop mid-walk latches nothing (a killed walk is not evidence)', async () => {
    let cancelMe: (() => Promise<void>) | null = null
    const h = ladderHarness({
      gpuMode: 'off',
      failFirst: 2,
      failMessage: MODEL_LOAD_REASON,
      onStart: async (index) => {
        if (index === 1) await cancelMe?.()
      }
    })
    const runtime = h.factory(opts)
    cancelMe = () => runtime.stop()
    await expect(runtime.start()).rejects.toThrow(/cancelled/i)
    expect(h.modelLoadFailures).toEqual([])
    expect(modelLoadLatchReason('m')).toBeNull()
  })
})

// #372 wiring pin: the download-complete seam clears the latch for the model that just landed.
// `main/index.ts` is composition (no unit harness), so the wiring is pinned by source text: the
// handler must call `clearModelLoadLatch(<its model id>)` as its FIRST statement — before
// `if (!ctx) return`, the embedder reset and the transcriber/translator refreshes, any of which can
// return early or throw inside the download manager's swallowing hook.
describe('#372 wiring pin: ctx.onModelInstalled re-arms the model before anything in the handler can return or throw', () => {
  const indexSrc = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
  const handlerStart = indexSrc.indexOf('ctx.onModelInstalled = (')
  const handlerSrc = indexSrc.slice(handlerStart, indexSrc.indexOf('\n  }\n', handlerStart))

  it("clearModelLoadLatch(modelId) is the handler's first statement — before anything that can return or throw", () => {
    expect(handlerSrc).toMatch(/ctx\.onModelInstalled = \(modelId\)/) // also proves the handler was found
    const clearAt = handlerSrc.indexOf('clearModelLoadLatch(modelId)')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    for (const later of ['if (!ctx) return', 'resetStartFailure', 'refreshTranscriberSlot(', 'refreshTranslatorSlot?.(']) {
      expect(handlerSrc.indexOf(later), later).toBeGreaterThan(clearAt)
    }
  })
})

describe('#530 — a program the OS loader refused is neither a GPU nor a model fault', () => {
  const GOMP: EngineProblem = {
    family: 'llama_cpp',
    reason: 'library-missing',
    os: 'linux',
    name: 'libgomp.so.1',
    exit: 'exit code 127'
  }
  const refused = (): EngineCannotRunError => new EngineCannotRunError('llama-server', GOMP)

  // Before #530 the cpu/ build's different path made rung 3's signature differ, so the ladder
  // persisted gpuAutoDisabled — and the next start then latched the MODEL. The next start must walk
  // the full ladder again and still blame nothing, so installing the library and choosing Check
  // again (or restarting) finds a clean slate.
  it.each([
    { name: 'a prepared Kit (rungs 1, 2, 3 all refused)', config: { probe: null }, rungs: 3, nextFirstArgs: [] as string[] },
    {
      name: 'an in-app install or a DIY drive (no cpu/ build)',
      config: { probe: null, cpuBin: null },
      rungs: 2,
      nextFirstArgs: [] as string[]
    },
    { name: 'acceleration off', config: { gpuMode: 'off' as const }, rungs: 2, nextFirstArgs: ['--device', 'none'] }
  ])(
    '$name: the ENGINE is named — no GPU flag, no model latch, and the next start walks the full ladder again',
    async ({ config, rungs, nextFirstArgs }) => {
      const h = ladderHarness({
        ...config,
        failFirst: 2 * rungs,
        failErrors: Array.from({ length: 2 * rungs }, refused),
        latchGpuFailures: true
      })
      const runtime = h.factory(opts)
      await runtime.start()
      expect(h.calls).toHaveLength(rungs)
      expect(h.failures).toEqual([])
      expect(h.modelLoadFailures).toEqual([])
      expect(h.engineFailures).toEqual([{ modelId: 'm', problem: GOMP }])
      expect(runtime.backend).toBe('mock')
      expect(modelLoadLatchReason('m')).toBeNull()
      // SAME harness: `latchGpuFailures` would carry a wrong GPU verdict into this walk, a latch would skip it.
      await h.factory(opts).start()
      expect(h.calls).toHaveLength(2 * rungs)
      expect(h.calls[rungs].extraArgs).toEqual(nextFirstArgs)
      expect(h.engineFailures).toHaveLength(2)
      expect(h.failures).toEqual([])
    }
  )

  it('never latches the MTP rung off for it — the flags were not the problem', async () => {
    const h = ladderHarness({ failFirst: 4, probe: [RTX], failErrors: [refused(), refused(), refused(), refused()] })
    await h.factory({ ...opts, speculativeDecoding: 'mtp', weightBytes: 1024 * 1024 * 1024 }).start()
    expect(isSpeculativeSuppressed('m')).toBe(false)
    expect(h.engineFailures).toHaveLength(1)
    expect(h.failures).toEqual([])
  })

  it('a Windows Kit whose main folder lost a DLL: the cpu/ build runs — CPU, and no gpuAutoDisabled', async () => {
    const h = ladderHarness({ failFirst: 2, probe: null, failErrors: [refused(), refused()] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2].binPath).toBe('/bin/cpu/llama-server')
    expect(runtime.backend).toBe('cpu')
    expect(h.failures).toEqual([]) // the GPU was never the suspect
    expect(h.engineFailures).toEqual([]) // the chat runs; the verdict store (not the ladder) keeps the refusal
  })

  it('a refused GPU rung beside a model fault on the CPU rungs: the #312 model verdict stands', async () => {
    const h = ladderHarness({
      failFirst: 3,
      probe: null,
      failErrors: [refused()],
      failMessage: MODEL_LOAD_REASON
    })
    await h.factory(opts).start()
    expect(h.failures).toEqual([])
    expect(h.engineFailures).toEqual([])
    expect(h.modelLoadFailures).toHaveLength(1)
  })
})
