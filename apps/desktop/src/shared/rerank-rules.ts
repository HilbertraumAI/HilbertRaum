// The rerank-profile constants BOTH the main-process decision (`main/services/rag/
// rerank-profile.ts`) and the renderer (the Settings "General" performance card) need to read
// (step 4-5, ruling (c) — scoped Opus review finding B1). `rerank-profile.ts` re-exports
// `CPU_HI_MIN_THREADS` under its historical name so every existing main-side import site is
// unchanged (the `shared/performance-rules.ts` precedent) — this file is the ONE definition, a
// renderer component may import it directly, and nothing ever duplicates the number.

/**
 * FROZEN by run L (step 4-4, 2026-09-15) — `programme-state/steps/4-4-product-pr-rerank-
 * profiles/artifacts/scope-selection.json`, `run-l-latency.json` (the `cpu50.json` 50-id set,
 * one lock hold, GPU planner + GPU reranker legs). Pre-registered selection rule: the smallest
 * of {8, 16} whose `top48` rerank p90 is at or under the 10,848 ms bound (4-i M1's shipped CPU
 * rerank median), else `Infinity` (the opt-in ships disabled). Selected: **`Infinity` — a MISS
 * at both thread counts** (8 threads: p90 25,317 ms; 16 threads: p90 29,101 ms, n=43 calls
 * each). The `cpu-hi` profile is therefore UNREACHABLE by any finite thread count
 * (`threads >= Infinity` is false for every real machine) — every CPU-only machine resolves
 * `default` regardless of its thread count, and the `ragRerankWideScope` opt-in has no effect
 * for anyone until a future re-measurement lowers this back to a finite value.
 *
 * Step 4-5 (ruling (c), B1): while this stays `Infinity` the app must not show a control that
 * can never do anything — `SettingsScreen.tsx` renders the `ragRerankWideScope` switch only
 * when `Number.isFinite(CPU_HI_MIN_THREADS)`. The setting key, its write gate, the
 * `resolveAskCandidateScope` plumbing and the `top48` scope all stay exactly as 4-4 shipped
 * them, so a later re-measurement re-enables the control by changing this ONE constant.
 */
export const CPU_HI_MIN_THREADS: number = Infinity
