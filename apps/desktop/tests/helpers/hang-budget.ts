// CI-aware budgets for test-side HANG DETECTORS (#458 step 3).
//
// Roughly thirty poll loops across the suite carry a hand-rolled bound —
// `if (Date.now() - start > 5_000) throw new Error('task never finished')` — and a few
// fixtures carry their own `waitFor(..., ms)` default. Every one of them exists to turn a
// hang into a NAMED failure instead of a bare vitest timeout. None is a timing proof.
//
// The trap they all shared: `vitest.config.ts` widens `testTimeout`/`hookTimeout` to 60 s on
// CI because the windows runners are starved (#458, #101), but **a hand-rolled bound is
// invisible to that config and does not widen with it**. So the suite's own hang detectors
// stayed at their desk-tight values on the one platform that needed slack, and fired on work
// that was merely slow. `doctasks-translation.test.ts` documented this at its 30 s detector
// after it flaked 3 of 4 runs; this module generalises the fix instead of waiting for each
// bound to be bitten in turn.
//
// Deliberately NOT for timing PROOFS. If a test asserts that something completed *within* a
// budget as evidence about the code (the FTS 500 ms bound, #84; the `elapsedMs >=
// DF_PROBE_TIMEOUT_MS` lower bound in `zim-arm`), that assertion is the point and must not be
// silently relaxed here. Use this only where exceeding the bound means "it hung", never "it
// was too slow".

/** Multiplier applied on CI. 4x is exactly the ratio `testTimeout` already uses: 15 s -> 60 s. */
const CI_FACTOR = 4

/**
 * Ceiling for a widened budget. A hang detector is only useful if it fires BEFORE the test
 * budget around it — otherwise the named error is replaced by a bare `Test timed out in
 * 60000ms` and the diagnosis is lost. 45 s keeps every widened bound comfortably inside the
 * 60 s CI `testTimeout`. A file that deliberately raises its own per-test budget (e.g.
 * `vi.setConfig`) and needs a longer detector should pass the value it wants directly.
 */
const CI_CEILING_MS = 45_000

/**
 * The wall-clock budget a test-side hang detector should use, given the value that is right at
 * a developer's desk. Unchanged locally (a real hang still fails fast); widened on CI, where
 * GitHub Actions sets `CI=true` and a starved fork can be descheduled for 10+ seconds.
 */
export function hangBudgetMs(localMs: number): number {
  if (!process.env.CI) return localMs
  return Math.min(localMs * CI_FACTOR, CI_CEILING_MS)
}

/**
 * The same widening for a poll loop bounded by ITERATION COUNT rather than wall clock —
 * `for (let i = 0; i < hangPolls(200); i++)`. Pass the loop's own sleep so the 45 s cap still
 * lands on real time: 200 polls of 5 ms is a 1 s detector, and on CI becomes a 4 s one.
 *
 * This shape is the NASTIER of the two and was missed by the first sweep of #458 step 3 —
 * CI found it (`vision-security.test.ts`, run 34664328086). A counted loop does not merely
 * stay narrow on CI, it **falls through silently**: no named error, just the next assertion
 * failing with something opaque like `expected [] to have a length of 1`. Prefer failing
 * loudly after the loop where the surrounding test makes that practical.
 */
export function hangPolls(iterations: number, stepMs: number): number {
  return Math.max(1, Math.round(hangBudgetMs(iterations * stepMs) / stepMs))
}
