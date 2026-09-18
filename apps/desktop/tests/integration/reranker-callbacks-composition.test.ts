import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeServices } from '../../src/main/services/compose-services'
import { createSelectedReranker } from '../../src/main/services/reranker/factory'
import {
  createRerankerCallbacks,
  createPendingModelSwitchCounter,
  type RerankerCallbackDeps
} from '../../src/main/services/rag/device-posture'
import { resolveAskCandidateScope } from '../../src/main/ipc/registerRagIpc'
import type { Translator } from '../../src/main/services/translation'
import { DEFAULT_SETTINGS, type AppSettings, type GpuDevice } from '../../src/shared/types'

// Wave 8 ruling (b)(G)/NF-1 (step 4-8, the Wave 8 analysis's finding that a composition test
// through `compose-services.ts` -> `reranker/factory.ts` alone cannot see an omission at
// `main/index.ts` or at the ask site, `registerRagIpc.ts:262`): this file targets the exported
// closure FACTORY and `composeServices`'s own signature directly, with type-level proof
// (`@ts-expect-error`, which fails `npm run typecheck` if a wire becomes optional again)
// alongside a functional check that the wired callbacks actually reach the sidecar.

describe('Wave 8 NF-1: the required-wiring type-level proof', () => {
  it('composeServices refuses a call that omits either reranker callback (type-level; runtime confirms the shape too)', () => {
    const rootPath = mktemp()
    // @ts-expect-error — rerankerDevicePosture/rerankerRequestCeiling are REQUIRED on composeServices's
    // own signature (ComposeServicesArgs), even though the shared ComposeServicesDeps base (also used
    // by composeTranslator) keeps them optional. An omission here must be a compile error.
    composeServices({ rootPath, manifestsDir: null })
  })

  it('composeServices refuses a call missing ONLY rerankerRequestCeiling', () => {
    const rootPath = mktemp()
    // @ts-expect-error — rerankerRequestCeiling alone omitted.
    composeServices({ rootPath, manifestsDir: null, rerankerDevicePosture: () => 'cpu' as const })
  })

  it('createRerankerCallbacks refuses a call missing any of its four required dependencies', () => {
    const base: RerankerCallbackDeps = {
      runtimeManager: { activeModelId: () => null, status: () => ({ startingModelId: null }) as any },
      pendingModelSwitches: createPendingModelSwitchCounter(),
      getTranslator: () => null,
      getSettings: () => null,
      manifestsDir: null
    }
    // Sanity: the fully-specified shape compiles and runs.
    const cb = createRerankerCallbacks(base)
    expect(cb.devicePosture()).toBe('cpu')
    expect(typeof cb.requestCeiling()).toBe('number')

    // @ts-expect-error — runtimeManager omitted.
    createRerankerCallbacks({ ...base, runtimeManager: undefined })
    // @ts-expect-error — pendingModelSwitches omitted.
    createRerankerCallbacks({ ...base, pendingModelSwitches: undefined })
    // @ts-expect-error — getTranslator omitted.
    createRerankerCallbacks({ ...base, getTranslator: undefined })
    // @ts-expect-error — getSettings omitted.
    createRerankerCallbacks({ ...base, getSettings: undefined })
  })

  it('resolveAskCandidateScope (the ask site, registerRagIpc.ts:262-area) refuses a call omitting occupancy', () => {
    // The type-level proof: `@ts-expect-error` fails `npm run typecheck` if `occupancy` becomes
    // optional again. Wrapped in `expect(...).toThrow()` because TS only strips types -- the
    // call itself still runs (and crashes on the missing 4th argument), which the runtime
    // assertion below turns into a clean, honest test outcome rather than an uncaught error.
    expect(() => {
      // @ts-expect-error — the 4th `occupancy` parameter is required (Wave 8 ruling (a)/NF-1):
      // an optional parameter here would silently readmit "trust the setting" behaviour.
      resolveAskCandidateScope({} as unknown as AppSettings, true, null)
    }).toThrow()
  })
})

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-reranker-callbacks-composition-'))
}

describe('Wave 8: the wired callbacks actually reach the sidecar (functional, not just type-level)', () => {
  it('composeServices threads BOTH callbacks all the way to the reranker it selects (when one is provisioned)', () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-reranker-wiring-'))
    let postureCalls = 0
    let ceilingCalls = 0
    const services = composeServices({
      rootPath,
      manifestsDir: null, // no reranker manifest resolvable here -- the wiring itself is what's under test
      rerankerDevicePosture: () => {
        postureCalls++
        return 'cpu'
      },
      rerankerRequestCeiling: () => {
        ceilingCalls++
        return 48
      }
    })
    // No binary/model provisioned in this fixture, so `reranker` is null (graceful-fallback
    // rule) -- but the CALL to composeServices above already had to accept both callbacks as
    // required parameters (proven above); a real binary+model pairing (reranker.test.ts's
    // `createSelectedReranker` tests) proves the factory threads them into `LlamaReranker`
    // itself via `devicePosture`/`cpuRequestCeiling` — see reranker/factory.ts.
    expect(services.reranker).toBeNull()
    expect(postureCalls).toBe(0) // never called before a rerank() -- lazy, as designed
    expect(ceilingCalls).toBe(0)
  })

  it('reranker/factory.ts threads BOTH callbacks into the constructed LlamaReranker itself', async () => {
    const model = { id: 'bge-reranker-v2-m3-f16', modelPath: '/models/reranker.gguf' }
    const gpuReranker = createSelectedReranker({
      rootPath: '/r',
      model,
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true,
      devicePosture: () => 'gpu',
      requestCeiling: () => 1
    })
    expect(gpuReranker).not.toBeNull()
    // devicePosture(): not loaded yet -- reports the injected callback's answer directly, with
    // no process ever spawned (safe against the real, unmocked spawn/fetch this factory path
    // uses outside a test harness).
    expect(gpuReranker?.devicePosture?.()).toBe('gpu')

    // requestCeiling binds only on the 'cpu' posture (ruling (b)(G)); G throws BEFORE any start,
    // so calling rerank() over the ceiling here is safe too -- no real spawn is ever attempted.
    const cpuReranker = createSelectedReranker({
      rootPath: '/r',
      model,
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true,
      devicePosture: () => 'cpu',
      requestCeiling: () => 1
    })
    expect(cpuReranker?.devicePosture?.()).toBe('cpu')
    await expect(cpuReranker!.rerank('q', ['a', 'b'])).rejects.toThrow(/refused/i) // 2 > the ceiling of 1
  })
})

// Wave 8 review-fix round (opus-review-8.md, finding C4): every OTHER call site of
// `snapshotRerankerOccupancy`/`createRerankerCallbacks` in the suite passes `getTranslator: () =>
// null`, so `translationOccupied: getTranslator()?.gpuOccupied?.() ?? false`
// (`rag/device-posture.ts:232`) was indistinguishable from the literal `false` under the whole
// suite — the wire itself was untested, only its two ENDPOINTS (`TranslationRuntime.gpuOccupied()`
// in `translation-runtime.test.ts`, and `resolveRerankerDevicePosture`'s own occupancy branch with
// a hand-built snapshot in `reranker-wave8.test.ts`/`posture-writers-wave8.test.ts`). These two
// tests drive the JOIN itself through the real, exported `createRerankerCallbacks` factory, with a
// NON-null `Translator`. Confirmed both tests are load-bearing by temporarily replacing
// `device-posture.ts:232`'s expression with the literal `false` in the worktree (`node -e` editing
// the file directly, never through a commit) and re-running this file: BOTH went red (2 failed / 6
// passed — every `gpuOccupied: () => true` assertion stayed 'gpu' instead of 'cpu'), then all 8
// passed again once `git checkout -- device-posture.ts` restored the join — confirmed clean via
// `git diff`/`git status` before moving on.

// The project's own measured GTX 1070 Ti fixture (same as `reranker-wave8.test.ts`'s S1-S9 block):
// {totalMb: 8273, freeMb: 7504}. qwen3.5-4b-ud-q4kxl needs ~3837.4 MiB (remainder 3666.6 MiB >=
// the 2808.2 MiB floor) => posture 'gpu' with NO occupancy — the "otherwise resolves gpu" baseline
// C4 asks for.
const GTX_1070_TI: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce GTX 1070 Ti', totalMb: 8273, freeMb: 7504 }
const GTX_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  gpuMode: 'auto',
  gpuAutoDisabled: false,
  gpuProbe: { devices: [GTX_1070_TI], probedAt: new Date().toISOString() }
}
const FOUR_B = 'qwen3.5-4b-ud-q4kxl'
const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')

const BARE_TRANSLATOR: Translator = {
  modelId: 'translategemma-x',
  contextWindow: () => 4096,
  translate: async () => '',
  stop: async () => undefined
}

function callbacksWith(getTranslator: () => Translator | null): ReturnType<typeof createRerankerCallbacks> {
  const deps: RerankerCallbackDeps = {
    runtimeManager: { activeModelId: () => FOUR_B, status: () => ({ startingModelId: null }) as any },
    pendingModelSwitches: createPendingModelSwitchCounter(),
    getTranslator,
    getSettings: () => GTX_SETTINGS,
    manifestsDir: MANIFESTS_DIR
  }
  return createRerankerCallbacks(deps)
}

describe('Wave 8 review-fix round (C4): Translator.gpuOccupied() -> posture, through the real join', () => {
  it('createRerankerCallbacks: a NON-null Translator.gpuOccupied() reaches the resolved posture (true -> cpu, false -> gpu, absent member -> gpu)', () => {
    // No translator at all: the committed 4B has provable headroom on the fixture -- 'gpu'.
    expect(callbacksWith(() => null).devicePosture()).toBe('gpu')

    // A Translator WITHOUT the optional member reads as NOT occupied -- same answer as null.
    expect(callbacksWith(() => BARE_TRANSLATOR).devicePosture()).toBe('gpu')

    // gpuOccupied() -> false: still 'gpu' (the snapshot that otherwise resolves 'gpu').
    const free: Translator = { ...BARE_TRANSLATOR, gpuOccupied: () => false }
    expect(callbacksWith(() => free).devicePosture()).toBe('gpu')

    // gpuOccupied() -> true: forces 'cpu' on that SAME otherwise-'gpu' snapshot.
    const busy: Translator = { ...BARE_TRANSLATOR, gpuOccupied: () => true }
    expect(callbacksWith(() => busy).devicePosture()).toBe('cpu')
  })

  it('createRerankerCallbacks follows a RE-COMPOSED translator instance through the SAME live getter, not a captured reference (the ruled re-composed-translator case)', () => {
    // Models `main/index.ts`'s `onModelInstalled` re-composition: `ctx.translator` is REASSIGNED
    // to a brand-new instance mid-session, never mutated in place. `getTranslator` below reads
    // `current` fresh on every call -- exactly the live-getter contract `RerankerCallbackDeps.
    // getTranslator`'s own doc comment requires, never a value captured at construction time.
    let current: Translator = { ...BARE_TRANSLATOR, gpuOccupied: () => false } // instance A -- not occupying
    const callbacks = callbacksWith(() => current)
    expect(callbacks.devicePosture()).toBe('gpu') // instance A: not occupying

    current = { ...BARE_TRANSLATOR, gpuOccupied: () => true } // instance B -- a re-composed, occupying instance
    expect(callbacks.devicePosture()).toBe('cpu') // the SAME callbacks object follows B, not a stale A
  })
})
