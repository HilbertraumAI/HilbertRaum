import { gpuUsefulForProfile, primaryUsefulDevice } from '../../../shared/gpu-rules'
import type { GpuDevice } from '../../../shared/types'
import { CPU_HI_MIN_THREADS } from '../../../shared/rerank-rules'

// Phase 4 PR-B (step 4-4, Wave 4 ruling (a) — `programme-state/steps/G1-bundle-selection/
// rulings-wave4.md`; step 4-5, Wave 5 rulings (c)-(f)): the rerank *scope* (how many
// knowledge-pack chunks the reranker sees) follows a hardware profile; its *device posture*
// (CPU/GPU) follows a SEPARATE headroom gate (`rerankerDeviceFor`, step 4-5). This module is
// the ONE place that decides both — pure, no `node:`/`electron` imports, so the per-ask
// candidate-scope wiring (`registerRagIpc.ts` → `zim/arm.ts`) and the sidecar's lazy-start
// device posture (`reranker/llama.ts` via `compose-services.ts`) can never disagree. Mirrors
// `shared/gpu-rules.ts`'s "one definition" style (PR #303 audit M8/N3).
//
// The three SCOPE profiles (Phase 2 ruling (d), restated by Wave 4 ruling (a)):
//   - `gpu`     — a usable GPU is available (the app's own `gpuMode`/`gpuAutoDisabled`/probe
//                 rule, `isUsefulDevice`): the reranker sees every fetched block
//                 (`GPU_RERANK_SCOPE`) and rerank is on by default.
//   - `cpu-hi`  — no usable GPU, but the runtime's configured thread count is at least
//                 `CPU_HI_MIN_THREADS`: `top48` is available as an OPT-IN setting (default
//                 off; step 4-5 ruling (c) hides the control while the constant is `Infinity`).
//   - `default` — neither of the above: unchanged (today's `capped` scope).
// Nothing else enters the SCOPE decision (no RAM tier, no model size, no benchmark). The
// DEVICE POSTURE is no longer read off this classification (step 4-5, ruling (d)): see
// `rerankerDeviceFor`'s own doc comment.

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
   * probe never resolves to `gpu`. This function itself preserves the distinction
   * (`Array.isArray` below); today's two production call sites (`registerRagIpc.ts`,
   * `main/index.ts`) both read `probeDevices` via `performance.ts`'s `eligibleDevicesFor`, which
   * returns `[]` rather than `null` for "no probe" — so `null` currently reaches only the
   * fixtures in `rerank-profile.test.ts`, never a real ask. No behaviour difference today (`[]`
   * and `null` both fail the `gpu` check), but a future rule that DOES distinguish "unknown" from
   * "known, no usable device" would need one or both call sites to pass the real `null` through.
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
 * FROZEN by run L (step 4-4, 2026-09-15) — `artifacts/scope-selection.json`,
 * `artifacts/run-l-latency.json` (the `cpu50.json` 50-id set, one lock hold, GPU planner + GPU
 * reranker legs). Pre-registered selection rule (Frozen parameters): the widest of {`all`,
 * `top96`, `top48`} whose rerank p90 is at or under today's shipped CPU rerank median per
 * question (4-i M1, 10,848 ms). Selected: **`'all'`** (p90 2,671 ms, n=43 calls; `top96`
 * 1,128 ms, `top48` 693 ms — every GPU scope clears the bound with wide margin) — matches the
 * predicted value (4-i's bgeP recipe reranks the bundle's own ALL scope in seconds on the GPU,
 * 1g p90 2.87 s). No miss.
 */
export const GPU_RERANK_SCOPE: Exclude<RerankScope, 'capped'> = 'all'

/**
 * FROZEN by run L (step 4-4, 2026-09-15) — same artifacts; MISS at both {8, 16} threads (see
 * `shared/rerank-rules.ts` for the full derivation and the frozen value). Re-exported under its
 * historical name here (the `shared/performance-rules.ts` precedent) so every existing
 * `rerank-profile.ts` import site is unchanged; step 4-5 (ruling (c)) also lets
 * `SettingsScreen.tsx` (renderer) import it directly from the shared module — this file itself
 * stays free of `node:`/`electron` imports, but a renderer component must not reach into
 * `main/services/*` across the project's own renderer/main build boundary (electron-vite's
 * renderer target has no polyfill for `node:fs` et al — see `main/services/models.ts`'s
 * imports — so a pure MAIN-only module is not automatically renderer-safe by transitive
 * closure; `shared/*` is the only side both may import).
 */
export { CPU_HI_MIN_THREADS }

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
  if (meetsThreadThreshold(input.threads, CPU_HI_MIN_THREADS)) return 'cpu-hi'
  return 'default'
}

/**
 * The `cpu-hi` branch's own comparator, extracted so a test can exercise BOTH directions (a
 * count under vs at/over a threshold) without a finite `CPU_HI_MIN_THREADS` existing in
 * production — today it is `Infinity` (see the constant's own doc comment), so
 * `resolveRerankProfile` alone can never observe the `true` branch at any real thread count.
 * Diagnostics/testability only; identical to the inline comparison it replaces.
 */
export function meetsThreadThreshold(threads: number, minThreads: number): boolean {
  return threads >= minThreads
}

/**
 * The candidate scope for a resolved profile. A scope wider than `capped` is used ONLY when a
 * reranker is provisioned: with no reranker every profile is `capped`. The `gpu` acceptance
 * read's own no-rerank column (the `all` scope through `retrieve()`'s no-rerank interleave — the
 * configuration an ABSENT reranker produces, `rerankerAvailable: false`; a rerank-call FAILURE is
 * restricted to the `capped` companion instead, since step 4-5 ruling (e)(i), `zim/arm.ts`'s
 * `cappedCandidates`) measured WHY the absent-reranker fallback stays `capped`: `allPacked` 26→22
 * and `anyPacked` 42→33 against the `capped`/no-rerank baseline — a wide lexical pool with no
 * cross-encoder does not merely fail to help, it packs FEWER gold blocks than today's narrower
 * pool (see `docs/known-limitations.md`'s fallback-cost bullet and `docs/rag-design.md` §17 for
 * the full table). This is a measured cost, not a hypothetical.
 */
export function rerankScopeFor(profile: RerankProfile, input: RerankProfileInput): RerankScope {
  if (!input.rerankerAvailable) return 'capped'
  if (profile === 'gpu') return GPU_RERANK_SCOPE
  if (profile === 'cpu-hi') return input.wideScopeOptIn ? 'top48' : 'capped'
  return 'capped'
}

/**
 * Step 4-5 (ruling (d), B2): what `rerankerDeviceFor` needs to gate the reranker sidecar's
 * device posture on PROVABLE HEADROOM, never on `gpuUsefulForProfile`'s profile-bump predicate
 * (that predicate is measured only against a 5 GiB usable-card floor and says nothing about
 * room for a SECOND resident model beside the chat model — see the function's own doc comment
 * for why master's "must never contend for VRAM with the chat model" pin demanded this).
 * `budgetMib` and `chatModelNeedMib` are computed by the impure CALLER (`main/index.ts`'s
 * `rerankerDevicePosture`, which already imports `main/services/models.ts`'s
 * `graphicsBudgetMib`/`estimateGraphicsNeedMib`) and handed in as plain numbers so this module
 * stays free of `node:`/`electron` imports (see `CPU_HI_MIN_THREADS`'s doc comment on why that
 * matters for the renderer boundary) — "prefer computing it from the manifest at the seam".
 */
export interface RerankerHeadroomInput {
  /**
   * The eligible probe's device list, gated by `gpuMode`/`gpuAutoDisabled` at the call site
   * exactly as `RerankProfileInput.probeDevices` is (an empty/null list here already means "GPU
   * is off, auto-disabled, or unprobed" — this function applies no separate gpuMode check).
   * `null` = unknown, and per the #380 semantics an unknown probe never earns `gpu`.
   */
  probeDevices: GpuDevice[] | null
  /**
   * `graphicsBudgetMib(primaryUsefulDevice(probeDevices))` — the budget device's free-memory
   * figure (or `totalMb − GRAPHICS_IDLE_ALLOWANCE_MIB` with no free figure), computed by the
   * caller. `null` when the probe carries no total/free figure at all (never provable).
   */
  budgetMib: number | null
  /**
   * `estimateGraphicsNeedMib(manifest)` for `settings.activeModelId`'s manifest — the app's own
   * placement estimate for the active chat model, computed by the caller with the SAME
   * estimator the picker and the fit budget use. `null` with no active chat model or an
   * unresolvable manifest (never provable).
   */
  chatModelNeedMib: number | null
}

/**
 * The reranker's own estimated graphics need (MiB) under `estimateGraphicsNeedMib`, computed
 * over the shipped reranker manifest (`model-manifests/reranker/bge-reranker-v2-m3.yaml`:
 * `size_on_disk_gb: 1.16`, no `host_mapped_weights_mib`, no `estimated_context_cache_gib` → the
 * 0.5 GiB default):
 *
 *     weightsMib(1.16 GB) = 1.16e9 / 1024² ≈ 1,106.262 MiB
 *     onCard               = 1,106.262 − 0 (no host-mapped figure)
 *     estimate             = onCard × 1.15 + 0.5×1,024 + 1,024 (the fit margin)
 *                          ≈ 2,808.2015380859375 MiB   (≈ 2.8 GiB, as ruling (d) states)
 *
 * FROZEN as a constant rather than computed at this seam (see `RerankerHeadroomInput`'s doc
 * comment): `estimateGraphicsNeedMib` lives in `main/services/models.ts`, which this module
 * must not import. Pinned by a test computing the same formula over the manifest's own
 * published fields, so a future edit to the manifest is caught rather than silently drifting
 * this floor. This is the "conservative floor" ruling (d) asks for — the posture is `'gpu'`
 * only when the remainder (budget minus the chat model's placement) is at or above it.
 */
export const RERANKER_HEADROOM_FLOOR_MIB = 2808.2015380859375

/**
 * The reranker sidecar's device posture (step 4-5, ruling (d), B2): `'gpu'` iff (1) the probe
 * names a useful budget device (`primaryUsefulDevice` — the SAME rule `selectBudgetDevice`
 * uses, never `gpuUsefulForProfile`'s coarser bump predicate) AND (2) the budget device's
 * headroom is PROVABLE (`budgetMib`/`chatModelNeedMib` both known) AND (3) the remainder after
 * the active chat model's placement is at or above `RERANKER_HEADROOM_FLOOR_MIB`. `'cpu'`
 * whenever any of the three fails to hold — a machine cannot earn the GPU posture by failing to
 * report (ruling (d)): an unknown/empty probe, no useful device, no budget figure, no active
 * chat model, and an unresolvable manifest all mean `'cpu'`, exactly like an insufficient
 * remainder.
 *
 * `resolveRerankProfile`'s `'gpu' | 'cpu-hi' | 'default'` classification (and therefore
 * `rerankScopeFor`, the candidate-scope half of the decision) is UNCHANGED by this — only the
 * device-posture half is re-sourced, per ruling (d): "`gpuUsefulForProfile` stops deciding this
 * question."
 */
export function rerankerDeviceFor(input: RerankerHeadroomInput): RerankerDevice {
  if (!Array.isArray(input.probeDevices) || primaryUsefulDevice(input.probeDevices) == null) {
    return 'cpu'
  }
  if (input.budgetMib == null || !Number.isFinite(input.budgetMib)) return 'cpu'
  if (input.chatModelNeedMib == null || !Number.isFinite(input.chatModelNeedMib)) return 'cpu'
  const remainderMib = input.budgetMib - input.chatModelNeedMib
  return remainderMib >= RERANKER_HEADROOM_FLOOR_MIB ? 'gpu' : 'cpu'
}
