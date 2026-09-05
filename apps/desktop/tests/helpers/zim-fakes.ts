import { EventEmitter } from 'node:events'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// Shared knowledge-pack test doubles (#301). Extracted from the P3a lifecycle suite
// (`tests/unit/zim-service-lifecycle.test.ts`) when P3b needed the same fake children and the
// same controlled-promise gate at the IPC/session level: the ordering facts of both suites are
// established by an `entered`/`release` pair, never by a fixed sleep, and both drive the SAME
// three kill behaviours. One definition, so the two suites cannot drift apart on what "the
// child ignored SIGTERM" means.

/**
 * A controlled promise. `entered` resolves when the code under test reaches the gate;
 * `release(value)` lets it continue. The pair is what makes "the lock landed WHILE this was in
 * flight" a fact rather than a hope.
 */
export interface ServeGate<T> {
  readonly entered: Promise<void>
  wait(): Promise<T>
  release(value: T): void
}

export function serveGate<T>(): ServeGate<T> {
  let markEntered: () => void = () => {}
  const entered = new Promise<void>((resolve) => {
    markEntered = () => resolve()
  })
  let release: (value: T) => void = () => {}
  const released = new Promise<T>((resolve) => {
    release = resolve
  })
  return {
    entered,
    wait: (): Promise<T> => {
      markEntered()
      return released
    },
    release: (value: T): void => release(value)
  }
}

/**
 * How a fake child reacts to `kill()`:
 * - `exit-on-sigterm` — the polite signal is enough (the ordinary case),
 * - `ignore-sigterm`  — only `SIGKILL` kills it (proves the escalation),
 * - `ignore-all`      — nothing kills it (proves the bounded wait and the `uncertain` failure
 *   policy: the PID stays registered and the build file is kept).
 * `kill()` NEVER implies a terminal state on its own — the test decides when `exit` arrives.
 */
export type ServeChildMode = 'exit-on-sigterm' | 'ignore-sigterm' | 'ignore-all'

export class ServeFakeChild extends EventEmitter implements ChildProcessLike {
  pid: number
  killed = false
  /** Set by its own listener when it emits `exit` — the ordering oracle for "the next child
   *  spawns only after the previous one is terminal". */
  exited = false
  stderr = new EventEmitter()
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = []
  mode: ServeChildMode
  constructor(pid: number, mode: ServeChildMode) {
    super()
    this.pid = pid
    this.mode = mode
    this.on('exit', () => {
      this.exited = true
    })
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal)
    this.killed = true
    if (this.mode === 'exit-on-sigterm') queueMicrotask(() => this.emit('exit', 0, null))
    else if (this.mode === 'ignore-sigterm' && signal === 'SIGKILL')
      queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    return true
  }
}
