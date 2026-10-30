import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #290 / PR #303 audit T8 — the Performance screen's "last answer" figure is wired in
// index.ts's `initBackend`: every finished chat answer's speed payload must reach
// `recordAnswerSpeed` (services/performance.ts) ONLY through `observeAnswerSpeed`
// (registerBenchmarkIpc.ts), which pairs the latch write with the `performance:changed`
// push (see that function's docstring) — a callback that called `recordAnswerSpeed`
// directly would latch the figure but never tell the screen to re-read it.
//
// This is a source-text wiring pin — index.ts pulls in the whole Electron main process and
// cannot be imported under vitest, so this mirrors the idiom already used for other main.ts
// call sites (external-open.test.ts, window-security.test.ts, shutdown.test.ts).
// `observeAnswerSpeed` itself is proven in performance-notify "a finished answer latches
// with the running model and pushes".

// B-T8 (PR #303 audit remediation, P10 cross-review): the pin used to require the exact literal
// shape `const X = ctx as AppContext … setAnswerSpeedObserver((speed) => observeAnswerSpeed(X,
// speed))`, so an unrelated refactor (a renamed local, an added guard clause, a block-bodied
// callback) could break a pin that never caught a real regression. The regex below only
// requires: `setAnswerSpeedObserver(` given a one-parameter callback (parens optional, any
// name) whose body — expression or block — calls `observeAnswerSpeed(` somewhere inside it. The
// control inside the pin proves the regex still tells correctly-wired code from
// mis-wired code, without pinning to a literal string; index.ts itself is never edited to prove
// it — a mutated COPY of the read slice stands in.
const WIRING_PIN_RE = /setAnswerSpeedObserver\(\s*\(?\s*\w+\s*\)?\s*=>\s*(?:\{[\s\S]*?)?observeAnswerSpeed\(/

/** Strips line and block comments before a "never calls X directly" check, so an explanatory
 *  comment that merely names the forbidden call cannot trip a pin that only cares about real code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('wiring pin: initBackend routes chat-stream speed through observeAnswerSpeed', () => {
  const mainDir = join(__dirname, '../../src/main')
  const indexSrc = readFileSync(join(mainDir, 'index.ts'), 'utf8')
  const initBackendStart = indexSrc.indexOf('function initBackend(')
  const nextTopLevelFn = indexSrc.indexOf('function createWindow(', initBackendStart)
  const initBackendSrc = indexSrc.slice(initBackendStart, nextTopLevelFn)

  it('setAnswerSpeedObserver, inside initBackend, is given a callback that calls observeAnswerSpeed', () => {
    expect(initBackendSrc).toMatch(WIRING_PIN_RE)
    // The control: the same slice wired straight to the latch must fail the pin.
    const mutated = initBackendSrc.replace(/observeAnswerSpeed\(/, 'recordAnswerSpeed(')
    expect(mutated).not.toBe(initBackendSrc) // guard: the swap actually changed something
    expect(mutated).not.toMatch(WIRING_PIN_RE)
  })

  it('recordAnswerSpeed is never called directly from index.ts (only reachable via observeAnswerSpeed)', () => {
    expect(stripComments(indexSrc)).not.toMatch(/\brecordAnswerSpeed\(/)
  })
})
