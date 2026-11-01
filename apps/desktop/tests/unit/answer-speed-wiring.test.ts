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

  // #747: the rest of `initBackend`'s Performance wiring, the same kind of pin. Each emitter's flips
  // are proved at its owner (performance-notify, translation-runtime, vision-runtime); these say the
  // composition listens. The regex takes any `?.` and spacing, and each row deletes its line from a
  // COPY of the slice to prove the pin can fail.
  const initBackendCode = stripComments(initBackendSrc)
  const pushedBy = (source: string): RegExp =>
    new RegExp(`(?<![.\\w])${source}\\??\\.?(?:onChange|onResidencyChange)\\??\\.?\\(\\s*notifyPerformanceChanged\\s*\\)`)

  it.each(['runtime', 'embedder', 'reranker', 'translator', 'ctx\\.vision'])('%s pushes performance:changed on every transition', (source) => {
    const pin = pushedBy(source)
    expect(initBackendCode).toMatch(pin)
    expect(initBackendCode.replace(pin, '')).not.toMatch(pin)
  })

  it('a translator composed after a download gets the same subscription: it is a fresh instance', () => {
    const start = initBackendCode.indexOf('ctx.refreshTranslatorSlot =')
    const slot = initBackendCode.slice(start, initBackendCode.indexOf('rearmWhenChatEngineHeals(', start))
    const pin = pushedBy('ctx\\.translator')
    expect(slot).toMatch(pin)
    expect(slot.replace(pin, '')).not.toMatch(pin)
  })

  it('the ladder and the crash fallback reach one GPU failure recorder', () => {
    expect(initBackendCode).toMatch(/const persistGpuFailure = createGpuFailureRecorder\(/)
    expect(initBackendCode).toMatch(/onGpuFailure: persistGpuFailure\b/)
    expect(initBackendCode).toMatch(/persistFailure: \(reason\) => \{[\s\S]*?persistGpuFailure\(reason\)/)
  })
})
