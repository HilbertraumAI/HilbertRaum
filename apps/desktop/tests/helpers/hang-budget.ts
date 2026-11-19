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
// that was merely slow. `doctasks-translation.test.ts` once documented this at a 30 s detector
// after it flaked 3 of 4 runs (that suite now uses the shared 10 s `waitTerminal`); this module
// generalises the fix instead of waiting for each bound to be bitten in turn.
//
// Deliberately NOT for timing PROOFS. If a test asserts that something completed *within* a
// budget as evidence about the code (the FTS 500 ms bound, #84), that assertion is the point and
// must not be silently relaxed here. A test about a product timer drives the shipped constant with
// fake timers instead (CONTRIBUTING "Pin the bound that ships"). Use this only where exceeding the bound means "it hung", never "it
// was too slow".
//
// The two LIBRARY defaults are the same trap, and they are handled here too (#915). `vi.waitFor` and
// testing-library's `waitFor` / `find*` default to 1 s, and neither follows `testTimeout`. testing-library's is
// raised once for every jsdom file, in `tests/setup.ts`: `configure({ asyncUtilTimeout: hangBudgetMs(5_000) })`.
// Vitest has no such config key, so every `vi.waitFor` passes `{ timeout: hangBudgetMs(n) }` itself (5000 is the usual n); a testing-library wait
// passes one only to go above its 5000 default, never below it. A literal
// `timeout:` on any wait never widens on CI, so it is not allowed. The repo-hygiene row "every wait takes its
// ceiling from hang-budget" enforces those source rules; `tests/unit/hang-budget.dom.test.ts` asserts the setup
// default itself. A HEAVY row (real hashing, process spawns) takes
// `testBudgetMs` as its per-test timeout instead.

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

/** The CI `testTimeout` in `vitest.config.ts` — the floor no per-test budget may sit under. */
const CI_TEST_TIMEOUT_MS = 60_000

/**
 * The same widening for an explicit PER-TEST timeout — `it('…', async () => {…}, testBudgetMs(60_000))`.
 *
 * The third shape of the trap, and the one that outlived #458 step 3 (run 35099769260): a
 * literal per-test timeout REPLACES the config's `testTimeout`, so it never widens on CI either.
 * Every one in the suite was written to give a heavy test MORE room than the default — and once
 * the CI default rose to 60 s, each silently became the opposite. `docs-ipc` BE-1's `60_000`
 * (4x the desk default, by design) was exactly the CI default, i.e. no extra room on the one
 * platform it was added for; it timed out in setup on a runner that froze for 24 s + 18 s. The
 * renderer suites' `8000`/`10000` were wider than vitest's old 5 s default and are now 6-7x
 * TIGHTER than what an unannotated test gets on CI.
 *
 * So: unchanged locally; on CI the same 4x as `testTimeout`, and never under the CI default —
 * an explicit budget must not leave a test with less room than having none. No ceiling: nothing
 * wraps a test budget the way a test budget wraps a hang detector.
 */
export function testBudgetMs(localMs: number): number {
  if (!process.env.CI) return localMs
  return Math.max(localMs * CI_FACTOR, CI_TEST_TIMEOUT_MS)
}

// Captured at import, before any test installs fake timers, so the detector below keeps real time
// under `vi.useFakeTimers()`.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/**
 * Await `p`, or fail by name once `hangBudgetMs(localMs)` of REAL time has passed — the
 * promise-shaped hang detector. It works under fake timers too. `what` names the event awaited:
 * the failure reads "`what` never happened".
 */
export function within<T>(p: Promise<T>, what: string, localMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = realSetTimeout(() => reject(new Error(`${what} never happened`)), hangBudgetMs(localMs))
    p.then(
      (v) => {
        realClearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        realClearTimeout(t)
        reject(e)
      }
    )
  })
}

const realNow = Date.now.bind(Date)

/**
 * Poll `cond` until it holds, or fail by name once `hangBudgetMs(localMs)` of REAL time has
 * passed — the poll-shaped twin of `within`, for state that has no promise to await.
 *
 * Bound a poll by TIME, never by a count of loop turns. A counted loop
 * (`for (let i = 0; i < 200; i++) { if (cond) break; await sleep(5) }`) is a detector hard-coded
 * in disguise: it does not widen on CI, it **falls through silently** to an opaque next assertion
 * (`vision-security.test.ts`, run 34664328086, #458), and its length depends on the platform: a
 * 0-1 ms `setTimeout` step lasts about 1.1 ms on Linux but about 15.6 ms on Windows (timer
 * resolution), and a 5 ms one 5 ms vs 15.6 ms, so a count of turns is several times narrower on the
 * ubuntu runner than at a Windows desk (#895). The suite's counted polls were retired with #895.
 */
export async function until(cond: () => boolean, what: string, localMs = 5_000): Promise<void> {
  await untilValue(() => cond() || undefined, what, localMs)
}

/**
 * Poll a (sync or async) `probe` until it yields a value (anything but `undefined`, `null` or `false`), or fail by
 * name once `hangBudgetMs(localMs)` of REAL time has passed: the twin of `until` for state read through an awaited
 * call (an IPC channel, a job status) whose answer the caller wants back. Real time like `until`, so a poll bounded
 * this way cannot narrow into a count of timer turns (#895), and it works under fake timers and a mocked `Date.now`.
 * Each probe call is raced against the time left, so a probe that never settles (a handler parked on a gate) still
 * fails by name at the deadline instead of running into the test timeout.
 */
export async function untilValue<T>(
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  what: string,
  localMs = 5_000
): Promise<T> {
  const deadline = realNow() + hangBudgetMs(localMs)
  const timedOut = (): Error => new Error(`${what} never happened`)
  for (;;) {
    const v = await new Promise<T | null | undefined | false>((resolve, reject) => {
      const t = realSetTimeout(() => reject(timedOut()), Math.max(0, deadline - realNow()))
      Promise.resolve()
        .then(probe)
        .then(
          (value) => {
            realClearTimeout(t)
            resolve(value)
          },
          (e: unknown) => {
            realClearTimeout(t)
            reject(e)
          }
        )
    })
    if (v !== undefined && v !== null && v !== false) return v
    if (realNow() > deadline) throw timedOut()
    await new Promise<void>((r) => realSetTimeout(r, 1))
  }
}
