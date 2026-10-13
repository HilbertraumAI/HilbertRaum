import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSelectingRuntimeFactory,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { probeGpuDevices, createCachedGpuProbe } from '../../src/main/services/runtime/gpu'
import { latestModelPlacement, resetModelPlacementForTests } from '../../src/main/services/runtime/placement'
import {
  resolveLlamaServerPath,
  resolveCpuFallbackServerPath
} from '../../src/main/services/runtime/sidecar'
import type { RuntimeStartOptions } from '../../src/main/services/runtime'
import { displayDevice } from '../../src/shared/gpu-rules'

// MANUAL GPU smoke (Phase 15 green gate; architecture.md GPU record "Release acceptance") — NOT part of CI.
//
// The CI suite must stay green with zero binaries, zero models, and zero GPUs, so this
// whole file is skipped unless HILBERTRAUM_GPU_SMOKE points at a provisioned drive root:
//
//   HILBERTRAUM_GPU_SMOKE=<root with runtime/llama.cpp/<os>/{,cpu/}llama-server + models/chat/*.gguf>
//   npx vitest run tests/manual/gpu-smoke.test.ts
//
// On the dev box (RTX 3080 Ti) this exercises, against the REAL pinned Vulkan build (b11146 at the
// 2026-10 campaign):
// rung-1 GPU start + streamed tokens and the placement record the real load log yields, the
// #380 label (a probe with no answer: the start's own load log says where the weights went),
// the forced-CPU rung (`--device none`), and a simulated rung-1 failure landing on the rung-3
// pure-CPU safety net. The rows below are the only real-driver proof of the placement parser
// (#656: the smoke's runtime used to drop the stderr hook that feeds it).

const ROOT = process.env.HILBERTRAUM_GPU_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

// Production keeps the locked 180 s health timeout (DEFAULT_HEALTH_TIMEOUT_MS); the smoke loads a multi-GB model
// from a possibly-cold disk several times in a row, so it gets more patience — the
// point here is exercising the ladder/GPU mechanics, not the timeout budget.
const PATIENT_MS = 240_000
const patientMakeLlama = (
  o: RuntimeStartOptions,
  binPath: string,
  rung?: LlamaRungOptions
) =>
  createLlamaRuntime(o, {
    binPath,
    extraArgs: rung?.extraArgs,
    onUnexpectedExit: rung?.onUnexpectedExit,
    // The placement parser's feed: without it the ladder records an empty placement (#656).
    onStderrData: rung?.onStderrData,
    healthTimeoutMs: PATIENT_MS
  })

function firstChatModel(root: string): string | null {
  const dir = join(root, 'models', 'chat')
  if (!existsSync(dir)) return null
  // HILBERTRAUM_SMOKE_MODEL pins an explicit filename; otherwise prefer the SMALLEST chat model
  // so the smoke runs on modest laptops (e.g. a 16 GB Iris Xe box), not just the dev
  // workstation — the ladder/GPU mechanics don't depend on model size.
  const override = process.env.HILBERTRAUM_SMOKE_MODEL?.trim()
  if (override) {
    const p = join(dir, override)
    return existsSync(p) ? p : null
  }
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs.length ? ggufs[0].path : null
}

describe.skipIf(!enabled)('GPU smoke (manual, real binaries + real model + real GPU)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const modelPath = enabled ? firstChatModel(ROOT) : null
  const opts: RuntimeStartOptions = {
    modelId: 'smoke-chat-model',
    modelPath: modelPath ?? '/missing.gguf',
    contextTokens: 2048
  }

  beforeEach(() => resetModelPlacementForTests())

  it('probes the real GPU via --list-devices', { timeout: 30_000 }, async () => {
    expect(binPath).toBeTruthy()
    const devices = await probeGpuDevices(binPath!)
    console.log('probe:', devices)
    // #380: `null` means the probe hit its 10 s kill-timeout — a wedged driver on the smoke box,
    // which is a real failure of this smoke, not "this machine has no GPU".
    expect(devices).not.toBeNull()
    expect(devices!.length).toBeGreaterThan(0)
  })

  it('rung 1: starts on the GPU with default args and streams tokens', { timeout: 300_000 }, async () => {
    expect(modelPath).toBeTruthy()
    const factory = createSelectingRuntimeFactory({
      rootPath: ROOT,
      makeLlama: patientMakeLlama,
      gpu: { probeDevices: createCachedGpuProbe() }
    })
    const runtime = factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('gpu')
    console.log('rung-1 backend:', runtime.backend, '| gpu:', runtime.gpuName)
    // What the real load log said (benchmark.md "Your model"): layers on the card, the card's
    // `device_info` row, and its compute buffer.
    const placement = latestModelPlacement()
    console.log('rung-1 placement:', JSON.stringify(placement))
    expect(placement).toMatchObject({ modelId: opts.modelId, backend: 'gpu' })
    expect(placement!.gpuLayers).toBeGreaterThan(0)
    expect(placement!.totalLayers).toBeGreaterThanOrEqual(placement!.gpuLayers!)
    expect(placement!.gpuModelMb).toBeGreaterThan(0)
    expect(placement!.devices?.map((d) => d.name)).toContain(runtime.gpuName)
    expect(placement!.devices?.find((d) => d.name === runtime.gpuName)?.computeMb).toBeGreaterThan(0)
    const out: string[] = []
    // Qwen3 is a thinking model. Since Phase 20 the omitted-mode default (balanced)
    // already sends enable_thinking:false; the /no_think soft switch stays as belt and
    // braces so this smoke also passes against older/unpinned server builds.
    for await (const t of runtime.chatStream(
      [{ role: 'user', content: 'Say "hello" and nothing else. /no_think' }],
      { maxTokens: 64 }
    )) {
      out.push(t)
    }
    console.log('rung-1 streamed:', JSON.stringify(out.join('')))
    expect(out.length).toBeGreaterThan(0)
    await runtime.stop()
  })

  // #380: a probe that hit its kill-timeout answers null (unknown), and the label comes from this
  // start's own load log: `gpu` when it offloaded layers, named for the device that took the compute
  // buffers. On a hybrid machine that is the card, never an iGPU listed first.
  it('a probe with no answer: the load log labels the start gpu and names the card (#380)', { timeout: 300_000 }, async () => {
    const real = await probeGpuDevices(binPath!)
    expect(real).not.toBeNull()
    const factory = createSelectingRuntimeFactory({
      rootPath: ROOT,
      makeLlama: patientMakeLlama,
      gpu: { probeDevices: async () => null }
    })
    const runtime = factory(opts)
    await runtime.start()
    console.log('unknown-probe backend:', runtime.backend, '| gpu:', runtime.gpuName)
    expect(runtime.backend).toBe('gpu')
    expect(runtime.gpuName).toBe(displayDevice(real!)?.device.name)
    expect(latestModelPlacement()).toMatchObject({ backend: 'gpu' })
    await runtime.stop()
  })

  it('gpuMode "off": starts with --device none and reads as cpu', { timeout: 300_000 }, async () => {
    const factory = createSelectingRuntimeFactory({
      rootPath: ROOT,
      makeLlama: patientMakeLlama,
      gpu: { getGpuMode: () => 'off', probeDevices: createCachedGpuProbe() }
    })
    const runtime = factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('cpu')
    const h = await runtime.health()
    expect(h.healthy).toBe(true)
    await runtime.stop()
  })

  it.skipIf(process.platform !== 'win32')('simulated rung-1 failure lands on the rung-3 pure-CPU safety net', { timeout: 240_000 }, async () => {
    // A "binary" that exits immediately with a non-zero code (the §12 stub): where.exe
    // rejects llama-server's args and dies fast → rungs 1 + 2 fail, rung 3 is real.
    // (Windows only: the stub is where.exe.)
    const stub = 'C:\\Windows\\System32\\where.exe'
    expect(existsSync(stub)).toBe(true)
    expect(resolveCpuFallbackServerPath(ROOT)).toBeTruthy()
    const failures: string[] = []
    const factory = createSelectingRuntimeFactory({
      rootPath: ROOT,
      resolveBin: () => stub,
      makeLlama: patientMakeLlama,
      gpu: {
        onGpuFailure: (reason) => failures.push(reason),
        probeDevices: createCachedGpuProbe()
      }
    })
    const runtime = factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('cpu')
    expect(failures).toHaveLength(1) // the rung-1 failure was reported for persistence
    console.log('rung-3 landed; recorded failure:', failures[0]?.slice(0, 120))
    const h = await runtime.health()
    expect(h.healthy).toBe(true)
    await runtime.stop()
  })
})
