import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  cardIsShared,
  createPendingModelSwitchCounter,
  createTranslationHeadroom,
  resolveRerankerDevicePosture,
  resolveTranslationDevicePosture,
  type RerankerOccupancySnapshot
} from '../../src/main/services/rag/device-posture'
import { CHAT_MEASURED_MARGIN_MIB, chatGraphicsShareMib, findManifestById } from '../../src/main/services/models'
import { recordModelPlacement, resetModelPlacementForTests } from '../../src/main/services/runtime/placement'
import type { ModelRuntime } from '../../src/main/services/runtime'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type GpuDevice,
  type ModelPlacement,
  type RuntimeStatus
} from '../../src/shared/types'

// #473 Phase 1 (owner rulings of 2026-10-12): the two sidecar headroom gates — translation's new
// one and the reranker's — read the running chat model's share of the card (ruling 3), and the
// translation gate decides card or processor by whether the model FULLY fits beside it (ruling 1).
// Real manifests: the 9B chat model's estimate is 7,284 MiB at its 8,192-token window; the
// translation model's is 8,892 MiB; the reranker's floor is 2,808 MiB.

const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')
const CHAT = 'qwen3.5-9b-ud-q4kxl'
const TRANSLATION = 'translategemma-12b-it-q4'

/** The b11146 `--list-devices` capture of the hybrid desktop (list-devices-b11146-vulkan-rtx3080ti.txt). */
const RTX_3080_TI: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12084, freeMb: 11316 }
const UHD_770: GpuDevice = { id: 'Vulkan1', name: 'Intel(R) UHD Graphics 770', totalMb: 32606, freeMb: 48060 }
const RTX_3090: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24822, freeMb: 23575 }
/** The #318 GTX 1070 Ti: 7,504 MiB free, under the translation model's 8,892 alone. */
const GTX_1070_TI: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce GTX 1070 Ti', totalMb: 8273, freeMb: 7504 }

function withProbe(...devices: GpuDevice[]): AppSettings {
  return { ...DEFAULT_SETTINGS, gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices, probedAt: new Date().toISOString() } }
}

function chat(overrides: Partial<RerankerOccupancySnapshot> = {}): RerankerOccupancySnapshot {
  return {
    committedModelId: CHAT,
    chatStartBusy: false,
    translationOccupied: false,
    committedContextTokens: 8192,
    committedBackend: 'gpu',
    ...overrides
  }
}

/** A measured 9B start: 6,010 MiB on the card (the #318 measurement read 6,007). */
function measured9b(overrides: Partial<ModelPlacement> = {}): ModelPlacement {
  return {
    modelId: CHAT,
    contextTokens: 8192,
    backend: 'gpu',
    gpuLayers: 33,
    totalLayers: 33,
    gpuModelMb: 5210,
    cpuModelMb: 545.62,
    gpuKvMb: 300,
    cpuKvMb: 0,
    gpuRsMb: 50,
    gpuComputeMb: 450,
    metalMaxWorkingSetMb: null,
    machineKey: null,
    at: new Date().toISOString(),
    ...overrides
  }
}

afterEach(() => resetModelPlacementForTests())

describe('chatGraphicsShareMib — the running chat model on the card (#473 ruling 3)', () => {
  const manifest = findManifestById(MANIFESTS_DIR, CHAT)!

  it('uses this session\'s measurement for the same model and window, plus the margin', () => {
    expect(chatGraphicsShareMib(manifest, 8192, measured9b())).toBe(5210 + 300 + 50 + 450 + CHAT_MEASURED_MARGIN_MIB)
  })

  it('falls back to the estimate when the measurement is for another window, and scales the cache term UP to the launched one', () => {
    const atDefault = chatGraphicsShareMib(manifest, 8192, null)
    const atFourTimes = chatGraphicsShareMib(manifest, 32768, measured9b())
    // The manifest's cache term at 8,192 tokens grows by three more of the same at 32,768.
    expect(atFourTimes - atDefault).toBeCloseTo(manifest.estimatedContextCacheGib! * 1024 * 3, 6)
    // Never scaled DOWN: a sliding-window cache does not shrink with the window.
    expect(chatGraphicsShareMib(manifest, 2048, null)).toBe(atDefault)
  })
})

describe('resolveTranslationDevicePosture — card only if translation fully fits, else the reason (#473 ruling 1)', () => {
  it.each([
    ['a 12 GB card with nothing else on it', 'auto', withProbe(RTX_3080_TI), chat({ committedModelId: null })],
    ['a 12 GB card beside the 9B chat model', 'beside-chat', withProbe(RTX_3080_TI), chat()],
    ['a 24 GB card beside the 9B chat model', 'auto', withProbe(RTX_3090), chat()],
    ['a chat start in flight (ruling 2: chat takes the card first)', 'chat-starting', withProbe(RTX_3090), chat({ chatStartBusy: true })],
    ['an 8 GB card, too small even alone', 'too-large', withProbe(GTX_1070_TI), chat({ committedModelId: null })],
    ['a chat start requested, still in its weight check (#599)', 'chat-starting', withProbe(RTX_3090), chat({ chatStartRequested: true })],
    ['the chat model running on the processor', 'auto', withProbe(RTX_3080_TI), chat({ committedBackend: 'cpu' })],
    ['the hybrid box: the iGPU\'s 48 GB never counts', 'beside-chat', withProbe(UHD_770, RTX_3080_TI), chat()],
    ['no stored probe for this machine (nothing to judge)', 'auto', { ...DEFAULT_SETTINGS }, chat()],
    ['an integrated-only machine (out of scope)', 'auto', withProbe(UHD_770), chat()],
    ['a locked workspace', 'auto', null, chat()]
  ] as const)('%s → %s', (_label, expected, settings, occupancy) => {
    expect(resolveTranslationDevicePosture(settings, MANIFESTS_DIR, occupancy, TRANSLATION)).toBe(expected)
  })

  it('a measured chat footprint admits translation where the estimate would not', () => {
    // 15,200 − (6,010 + 256) = 8,934 ≥ 8,892, while 15,200 − 7,284 = 7,916 is not.
    const card = withProbe({ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4080', totalMb: 16376, freeMb: 15200 })
    expect(resolveTranslationDevicePosture(card, MANIFESTS_DIR, chat(), TRANSLATION)).toBe('beside-chat')
    recordModelPlacement(measured9b())
    expect(resolveTranslationDevicePosture(card, MANIFESTS_DIR, chat(), TRANSLATION)).toBe('auto')
  })
})

describe('the reranker gate reads the same chat share (#473 ruling 3)', () => {
  it('a raised context window is counted', () => {
    // 10,192 − 7,284 = 2,908 clears the 2,808 floor at the default window; at 32,768 tokens the
    // cache term adds 922 MiB and it no longer does.
    const card = withProbe({ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080', totalMb: 10240, freeMb: 10192 })
    expect(resolveRerankerDevicePosture(card, MANIFESTS_DIR, chat())).toBe('gpu')
    expect(resolveRerankerDevicePosture(card, MANIFESTS_DIR, chat({ committedContextTokens: 32768 }))).toBe('cpu')
  })

  it('a chat model on the processor holds nothing on the card', () => {
    const laptop = withProbe({ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994, freeMb: 5226 })
    expect(resolveRerankerDevicePosture(laptop, MANIFESTS_DIR, chat())).toBe('cpu')
    expect(resolveRerankerDevicePosture(laptop, MANIFESTS_DIR, chat({ committedBackend: 'cpu' }))).toBe('gpu')
  })
})

describe('Apple Silicon (#473 ruling 4: no new rule)', () => {
  // On Metal the probe's free figure IS the working-set cap: build 11146's
  // `ggml_metal_device_get_memory` reports total = recommendedMaxWorkingSetSize and free = total
  // minus what the ASKING process allocated — nothing, for the probe. The gates therefore compute
  // "cap − chat", the number a dedicated unified-memory rule would. Pinned so a change that classed
  // Apple GPUs as integrated (they are) cannot silently send every Mac's sidecars to the processor.
  const mac = withProbe({ id: 'MTL0', name: 'Apple M2 Pro', totalMb: 21845, freeMb: 21845 })

  it('the Metal device is the budget device for both gates', () => {
    expect(resolveRerankerDevicePosture(mac, MANIFESTS_DIR, chat())).toBe('gpu')
    expect(resolveTranslationDevicePosture(mac, MANIFESTS_DIR, chat(), TRANSLATION)).toBe('auto')
  })
})

describe('createTranslationHeadroom — the composed callback', () => {
  it('reads the runtime\'s committed model, window and backend, and a pending switch, live', () => {
    const pending = createPendingModelSwitchCounter()
    let backend: 'gpu' | 'cpu' = 'gpu'
    let launched = 8192
    let startRequested = false
    const runtimeManager = {
      activeModelId: () => CHAT,
      status: () => ({ startingModelId: null, startRequested }) as unknown as RuntimeStatus,
      active: () => ({ modelId: CHAT, contextWindow: () => launched, backend }) as unknown as ModelRuntime
    }
    const deps = { runtimeManager, pendingModelSwitches: pending, manifestsDir: MANIFESTS_DIR }
    const gate = createTranslationHeadroom({ ...deps, getSettings: () => withProbe(RTX_3080_TI) })
    expect(gate(TRANSLATION)).toBe('beside-chat') // the 9B is on the 12 GB card
    backend = 'cpu'
    expect(gate(TRANSLATION)).toBe('auto') // the 9B moved to the processor
    backend = 'gpu'
    pending.increment()
    expect(gate(TRANSLATION)).toBe('chat-starting') // a switch is pending
    pending.decrement()
    startRequested = true
    expect(gate(TRANSLATION)).toBe('chat-starting') // still in its weight check (#599)
    startRequested = false
    // 16,300 − 7,284 = 9,016 holds the 8,892 at the default window; the raised window adds 922 and it no longer does.
    const roomy = createTranslationHeadroom({
      ...deps,
      getSettings: () => withProbe({ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4080', totalMb: 16376, freeMb: 16300 })
    })
    expect(roomy(TRANSLATION)).toBe('auto')
    launched = 32768
    expect(roomy(TRANSLATION)).toBe('beside-chat')
  })
})

describe('cardIsShared — where the chat-first hook yields (#473 ruling 2)', () => {
  it.each<[string, boolean, AppSettings | null]>([
    ['a discrete card on record', true, withProbe(RTX_3080_TI)],
    ['Apple\x27s Metal pool', true, withProbe({ id: 'MTL0', name: 'Apple M2 Pro', totalMb: 21845, freeMb: 21845 })],
    ['an integrated GPU only (nothing on a card to give back)', false, withProbe(UHD_770)],
    ['no stored probe', false, { ...DEFAULT_SETTINGS, gpuMode: 'auto' }],
    ['the GPU switched off', false, { ...withProbe(RTX_3080_TI), gpuMode: 'off' }],
    ['a locked workspace', false, null]
  ])('%s → %s', (_label, expected, settings) => {
    expect(cardIsShared(settings)).toBe(expected)
  })
})
