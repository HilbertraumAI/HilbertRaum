import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSelectingRuntimeFactory,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { probeGpuDevices, createCachedGpuProbe } from '../../src/main/services/runtime/gpu'
import {
  resolveLlamaServerPath,
  resolveCpuFallbackServerPath
} from '../../src/main/services/runtime/sidecar'
import type { RuntimeStartOptions } from '../../src/main/services/runtime'

// MANUAL GPU smoke (Phase 15 green gate; architecture.md GPU record "Release acceptance") — NOT part of CI.
//
// The CI suite must stay green with zero binaries, zero models, and zero GPUs, so this
// whole file is skipped unless HILBERTRAUM_GPU_SMOKE points at a provisioned drive root:
//
//   HILBERTRAUM_GPU_SMOKE=<root with runtime/llama.cpp/<os>/{,cpu/}llama-server + models/chat/*.gguf>
//   npx vitest run tests/manual/gpu-smoke.test.ts
//
// On the dev box (RTX 3080 Ti) this exercises, against the REAL b9585 Vulkan build:
// rung-1 GPU start + streamed tokens, the forced-CPU rung (`--device none`), and a
// simulated rung-1 failure landing on the rung-3 pure-CPU safety net.

const ROOT = process.env.HILBERTRAUM_GPU_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

// Production keeps the locked 60 s health timeout; the smoke loads a multi-GB model
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

  it('probes the real GPU via --list-devices', { timeout: 30_000 }, async () => {
    expect(binPath).toBeTruthy()
    const devices = await probeGpuDevices(binPath!)
    console.log('probe:', devices)
    expect(devices.length).toBeGreaterThan(0)
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

  it('simulated rung-1 failure lands on the rung-3 pure-CPU safety net', { timeout: 240_000 }, async () => {
    // A "binary" that exits immediately with a non-zero code (the §12 stub): where.exe
    // rejects llama-server's args and dies fast → rungs 1 + 2 fail, rung 3 is real.
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
