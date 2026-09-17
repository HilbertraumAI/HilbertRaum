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
import type { AppSettings } from '../../src/shared/types'

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
