import { afterEach, describe, expect, it, vi } from 'vitest'
import { hangBudgetMs, testBudgetMs, until, untilValue, within } from '../helpers/hang-budget'

// #895: the contract of the harness hang detectors that the call sites never exercise (they only take the success path):
// real time under fake timers and a pinned Date.now, and the documented CI widening.

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('untilValue (#895)', () => {
  it('returns the first ready value of an async probe; undefined, null and false all mean "not yet"', async () => {
    const answers: unknown[] = [undefined, null, false, { state: 'done' }]
    let calls = 0
    const v = await untilValue(async () => answers[calls++] as { state: string } | null | undefined | false, 'the job finishing')
    expect(v).toEqual({ state: 'done' })
    expect(calls).toBe(4)
  })

  it.each([
    ['until', (what: string, localMs: number): Promise<unknown> => until(() => false, what, localMs)],
    ['untilValue', (what: string, localMs: number): Promise<unknown> => untilValue(async () => undefined, what, localMs)]
  ])('%s fails by name on REAL time while the clock is faked and Date.now is pinned', async (_name, poll) => {
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    // `within` runs on the real clock too, so a poll that waited on the faked one fails here by name, not by the test timeout.
    await expect(within(poll('the run terminating', 20), 'the poll failing by name', 2_000)).rejects.toThrow(
      'the run terminating never happened'
    )
  })

  it.each([
    ['until', (what: string, localMs: number): Promise<unknown> => until(() => false, what, localMs)],
    ['untilValue', (what: string, localMs: number): Promise<unknown> => untilValue(async () => undefined, what, localMs)]
  ])('%s widens its bound on CI (4x: a 20 ms bound cannot give up before 80 ms of real time)', async (_name, poll) => {
    vi.stubEnv('CI', 'true')
    const started = Date.now()
    await expect(within(poll('the CI-widened poll', 20), 'the poll failing by name', 2_000)).rejects.toThrow(
      'the CI-widened poll never happened'
    )
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
  })
})

describe('untilValue — a probe that never settles (#895)', () => {
  it('still fails by name at its deadline', async () => {
    await expect(
      within(untilValue(() => new Promise<never>(() => {}), 'the parked probe answering', 20), 'the poll failing by name', 2_000)
    ).rejects.toThrow('the parked probe answering never happened')
  })
})

describe('hang-budget CI widening', () => {
  it('is the identity at a desk and 4x (capped at 45 s, floored at 60 s per test) on CI', () => {
    vi.stubEnv('CI', '')
    expect([hangBudgetMs(5_000), testBudgetMs(10_000)]).toEqual([5_000, 10_000])
    vi.stubEnv('CI', 'true')
    expect([hangBudgetMs(5_000), hangBudgetMs(20_000), testBudgetMs(10_000)]).toEqual([20_000, 45_000, 60_000])
  })
})
