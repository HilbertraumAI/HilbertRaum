import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #290 / PR #303 audit T8 — the Performance screen's "last answer" figure is wired in
// index.ts's `initBackend`: every finished chat answer's speed payload must reach
// `recordAnswerSpeed` (services/performance.ts) ONLY through `observeAnswerSpeed`
// (registerBenchmarkIpc.ts), which pairs the latch write with the `performance:changed`
// push (see that function's docstring) — a callback that called `recordAnswerSpeed`
// directly would latch the figure but never tell the screen to re-read it.
//
// (a) is a source-text wiring pin — index.ts pulls in the whole Electron main process and
// cannot be imported under vitest, so this mirrors the idiom already used for other main.ts
// call sites (external-open.test.ts, window-security.test.ts, shutdown.test.ts).
// (b) is the behavioural half: `observeAnswerSpeed` itself, exercised directly.

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { observeAnswerSpeed } from '../../src/main/ipc/registerBenchmarkIpc'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { latestAnswerSpeed, recordAnswerSpeed, resetPerformanceForTests } from '../../src/main/services/performance'
import type { AppContext } from '../../src/main/services/context'
import type { AnswerSpeed } from '../../src/shared/ipc'

describe('wiring pin: initBackend routes chat-stream speed through observeAnswerSpeed', () => {
  const mainDir = join(__dirname, '../../src/main')
  const indexSrc = readFileSync(join(mainDir, 'index.ts'), 'utf8')
  const initBackendStart = indexSrc.indexOf('function initBackend(')
  const nextTopLevelFn = indexSrc.indexOf('function createWindow(', initBackendStart)
  const initBackendSrc = indexSrc.slice(initBackendStart, nextTopLevelFn)

  it('the pin actually found initBackend (and a non-empty slice of it)', () => {
    expect(initBackendStart).toBeGreaterThanOrEqual(0)
    expect(nextTopLevelFn).toBeGreaterThan(initBackendStart)
  })

  it('setAnswerSpeedObserver, inside initBackend, is given a callback that calls observeAnswerSpeed', () => {
    expect(initBackendSrc).toMatch(
      /const (\w+) = ctx as AppContext[\s\S]*?setAnswerSpeedObserver\(\s*\(speed\)\s*=>\s*observeAnswerSpeed\(\1,\s*speed\)\)/
    )
  })

  it('recordAnswerSpeed is never called directly from index.ts (only reachable via observeAnswerSpeed)', () => {
    expect(indexSrc).not.toMatch(/\brecordAnswerSpeed\(/)
  })
})

describe('observeAnswerSpeed: latches the payload under the active model and pushes performance:changed', () => {
  const speed: AnswerSpeed = { messageId: 'msg-1', tokensPerSecond: 24.5, ttftMs: 640, tokens: 88 }
  const ctxWithActive = (modelId: string | null): AppContext =>
    ({ runtime: { active: () => (modelId == null ? null : { modelId }) } }) as unknown as AppContext

  beforeEach(() => {
    resetPerformanceForTests()
  })

  afterEach(() => {
    setPerformanceChangedSink(null)
  })

  it('records latestAnswerSpeed with the active model id and the payload figures, and pushes exactly once', () => {
    const spy = vi.fn()
    setPerformanceChangedSink(spy)

    observeAnswerSpeed(ctxWithActive('m'), speed)

    expect(latestAnswerSpeed()).toMatchObject({
      modelId: 'm',
      tokensPerSecond: speed.tokensPerSecond,
      ttftMs: speed.ttftMs,
      tokens: speed.tokens
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('recordAnswerSpeed alone (the latch, called without going through observeAnswerSpeed) stays pure: no sink call', () => {
    const spy = vi.fn()
    setPerformanceChangedSink(spy)

    recordAnswerSpeed(speed, 'm')

    expect(latestAnswerSpeed()).toMatchObject({ modelId: 'm', tokensPerSecond: speed.tokensPerSecond })
    expect(spy).not.toHaveBeenCalled()
  })
})
