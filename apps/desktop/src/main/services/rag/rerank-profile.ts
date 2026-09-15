import { gpuUsefulForProfile } from '../../../shared/gpu-rules'
import type { GpuDevice } from '../../../shared/types'

// Phase 4 PR-B (step 4-4, Wave 4 ruling (a) — `programme-state/steps/G1-bundle-selection/
// rulings-wave4.md`): the rerank *scope* (how many knowledge-pack chunks the reranker sees)
// and its *device posture* (CPU/GPU) follow a hardware profile. This module is the ONE place
// that decides the profile and what it implies — pure, no `node:`/`electron` imports, so the
// per-ask candidate-scope wiring (`registerRagIpc.ts` → `zim/arm.ts`) and the sidecar's
// lazy-start device posture (`reranker/llama.ts` via `compose-services.ts`) can never disagree
// about which profile a given settings snapshot resolves to. Mirrors `shared/gpu-rules.ts`'s
// "one definition" style (PR #303 audit M8/N3).
//
// The three profiles (Phase 2 ruling (d), restated by Wave 4 ruling (a)):
//   - `gpu`     — a usable GPU is available (the app's own `gpuMode`/`gpuAutoDisabled`/probe
//                 rule, `isUsefulDevice`): the reranker sees every fetched block
//                 (`GPU_RERANK_SCOPE`) and rerank is on by default, the sidecar on the GPU.
//   - `cpu-hi`  — no usable GPU, but the runtime's configured thread count is at least
//                 `CPU_HI_MIN_THREADS`: `top48` is available as an OPT-IN setting (default
//                 off), the sidecar stays on the CPU.
//   - `default` — neither of the above: unchanged (today's `capped` scope, CPU sidecar).
// Nothing else enters the decision (no RAM tier, no model size, no benchmark).

export type RerankProfile = 'gpu' | 'cpu-hi' | 'default'
export type RerankScope = 'all' | 'top96' | 'top48' | 'capped'
export type RerankerDevice = 'gpu' | 'cpu'

export interface RerankProfileInput {
  gpuMode: 'auto' | 'off'
  gpuAutoDisabled: boolean
  /**
   * The eligible probe's device list (`eligibleGpuProbe(settings.gpuProbe, machineKey)?.devices`,
   * or the session-cached probe's answer when one is in hand). `null` = unknown / no probe —
   * the #380 semantics: never "no usable device", but never "usable" either, so an unknown
   * probe never resolves to `gpu`.
   */
  probeDevices: GpuDevice[] | null
  /**
   * The runtime's configured thread count = the `threads` option the sidecar was given, else
   * `defaultThreadCount()` (`runtime/sidecar.ts`: half the logical CPUs, at least 1). The
   * reranker is created without a `threads` option in `compose-services.ts` today, so in
   * production this is `defaultThreadCount()`.
   */
  threads: number
  /** Whether a reranker is provisioned at all (`createSelectedReranker` returned non-null). */
  rerankerAvailable: boolean
  /** The `ragRerankWideScope` setting — the `cpu-hi` profile's opt-in, default off. */
  wideScopeOptIn: boolean
}

/**
 * Set by run L (step 4-4) before any run A3 phase — a development latency read on the 50-id
 * `cpu50.json` set (never `core200`), pre-registered selection rule (Frozen parameters):
 * `GPU_RERANK_SCOPE` = the widest of {`all`, `top96`, `top48`} whose rerank p90 is at or under
 * today's shipped CPU rerank median per question (4-i M1, 10,848 ms), else `top48` with the miss
 * reported. Until run L has run, this constant carries the PREDICTED value (`'all'` — 4-i's
 * bgeP recipe reranks the bundle's own ALL scope in seconds on the GPU, 1g p90 2.87 s). The
 * run-L commit replaces this with the selection and cites `artifacts/scope-selection.json`.
 */
export const GPU_RERANK_SCOPE: Exclude<RerankScope, 'capped'> = 'all'

/**
 * Set by run L: the smallest of {8, 16} whose `top48` rerank p90 is at or under the same
 * 10,848 ms bound, else `Infinity` (the opt-in ships disabled, the miss reported). Until run L
 * has run, this constant carries the PREDICTED value (4-i M2 predicts 8 threads at p90 9.06 s).
 * The run-L commit replaces this with the selection and cites `artifacts/scope-selection.json`.
 */
export const CPU_HI_MIN_THREADS: number = 8

/**
 * The hardware profile for one settings snapshot (Frozen parameters). `gpu` iff GPU auto-mode
 * is on, not auto-disabled, a probe was actually taken (an array, not `null`/unknown), and
 * `gpuUsefulForProfile` finds a usable card (the ONE usable-card rule this app has —
 * `shared/gpu-rules.ts`: `totalMb >= USABLE_VRAM_MB` and not integrated-looking). Else `cpu-hi`
 * iff the configured thread count is at least `CPU_HI_MIN_THREADS`. Else `default`.
 */
export function resolveRerankProfile(input: RerankProfileInput): RerankProfile {
  if (
    input.gpuMode === 'auto' &&
    !input.gpuAutoDisabled &&
    Array.isArray(input.probeDevices) &&
    gpuUsefulForProfile(input.probeDevices)
  ) {
    return 'gpu'
  }
  if (input.threads >= CPU_HI_MIN_THREADS) return 'cpu-hi'
  return 'default'
}

/**
 * The candidate scope for a resolved profile. A scope wider than `capped` is used ONLY when a
 * reranker is provisioned: with no reranker every profile is `capped`, because a wide lexical
 * pool with no cross-encoder would flood the interleave and the `topKFinal` trim.
 */
export function rerankScopeFor(profile: RerankProfile, input: RerankProfileInput): RerankScope {
  if (!input.rerankerAvailable) return 'capped'
  if (profile === 'gpu') return GPU_RERANK_SCOPE
  if (profile === 'cpu-hi') return input.wideScopeOptIn ? 'top48' : 'capped'
  return 'capped'
}

/** The reranker sidecar's device posture for a resolved profile — `gpu` only on the `gpu`
 *  profile, `cpu` (today's byte-identical launch) on every other one. */
export function rerankerDeviceFor(profile: RerankProfile): RerankerDevice {
  return profile === 'gpu' ? 'gpu' : 'cpu'
}
