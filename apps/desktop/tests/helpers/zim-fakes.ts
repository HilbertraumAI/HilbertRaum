import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import { markerBinaryKey, writeRuntimeMarker } from '../../src/main/services/assets'
import { sha256File } from '../../src/main/services/models'
import type { ZimServiceDeps } from '../../src/main/services/zim'
import { appendLibraryBook, type LibraryBookOptions } from './zim-library'

// Shared knowledge-pack test doubles (#301): the controlled-promise gate, the fake kiwix-serve /
// kiwix-manage child and its scripted early deaths, the fake kiwix-manage spawn, the ZimService
// deps every service suite passes, and a real install marker for the real pre-spawn verifier.
// Ordering facts are established by an `entered`/`release` pair, never by a fixed sleep, and
// every suite drives the SAME three kill behaviours, so no two suites can drift apart on what
// "the child ignored SIGTERM" means. The `<book>` line a fake manager writes is `zim-library.ts`.

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

/** What a child that dies before it is healthy does: exits (after writing `stderr`), or emits a
 *  spawn `error` (ENOENT and friends) and never exits. */
export type EarlyFailure = { kind: 'exit'; code: number; stderr?: string } | { kind: 'error'; error: Error }

/** kiwix-serve losing its port between `findFreePort()` and bind: the stderr the bind-race
 *  retry recognises, then exit 1. */
export const BIND_RACE: EarlyFailure = { kind: 'exit', code: 1, stderr: 'bind: address already in use' }

/** Make `child` die right after spawn, before any health probe can see it alive. */
export function failEarly(child: ServeFakeChild, failure: EarlyFailure): void {
  queueMicrotask(() => {
    if (failure.kind === 'error') {
      child.emit('error', failure.error)
      return
    }
    if (failure.stderr) child.stderr.emit('data', failure.stderr)
    child.emit('exit', failure.code, null)
  })
}

export interface FakeManageOptions {
  /** PID of the first child; each spawn takes the next. */
  firstPid: number
  /** How each child reacts to `kill()` (default `exit-on-sigterm`); a function is read per spawn. */
  mode?: ServeChildMode | (() => ServeChildMode)
  /** The `<book>` attributes per archive (default: its header UUID, `Title of <leaf>`, …). */
  book?: (zimPath: string) => LibraryBookOptions
  /** Runs inside the child before it appends; a throw makes it write the error to stderr and
   *  exit 1, as a failing kiwix-manage does. */
  before?: (libraryXmlPath: string, zimPath: string) => Promise<void> | void
  /** Called at every spawn, before the child runs (which library file it was pointed at). */
  onSpawn?: (r: { libraryXmlPath: string; zimPath: string; child: ServeFakeChild }) => void
}

/**
 * A fake `kiwix-manage LIBRARY add ZIM`: each spawn appends one `<book>` (the archive's own
 * header UUID) and exits 0 — unless it was killed first, so an aborted or timed-out manager
 * writes nothing (the settle-before-cleanup contract). A library file that cannot be written
 * (a temp root removed under a late build) makes it exit 1, never throw.
 */
export function fakeManageSpawn(o: FakeManageOptions): { spawn: SpawnFn; children: ServeFakeChild[] } {
  const children: ServeFakeChild[] = []
  let pid = o.firstPid
  const spawn: SpawnFn = (_command, args) => {
    const libraryXmlPath = args[0] as string
    const zimPath = args[2] as string
    const mode = typeof o.mode === 'function' ? o.mode() : (o.mode ?? 'exit-on-sigterm')
    const child = new ServeFakeChild(pid++, mode)
    children.push(child)
    o.onSpawn?.({ libraryXmlPath, zimPath, child })
    void (async () => {
      let failure: unknown = null
      try {
        await o.before?.(libraryXmlPath, zimPath)
      } catch (err) {
        failure = err
      }
      // One macrotask, so the manager's own exit listeners are attached before the child ends.
      await new Promise<void>((r) => setTimeout(r, 0))
      if (child.killed) return
      if (failure) {
        child.stderr.emit('data', String(failure))
        child.emit('exit', 1, null)
        return
      }
      try {
        appendLibraryBook(libraryXmlPath, zimPath, o.book?.(zimPath))
      } catch (err) {
        child.stderr.emit('data', `Cannot add ZIM to the library: ${err instanceof Error ? err.name : 'error'}`)
        child.emit('exit', 1, null)
        return
      }
      child.emit('exit', 0, null)
    })()
    return child
  }
  return { spawn, children }
}

/** What a ZimService suite must supply itself: its spawns and its port allocator. */
export type ZimServiceDepsOverrides = Partial<ZimServiceDeps> &
  Required<Pick<ZimServiceDeps, 'spawn' | 'manageSpawn' | 'findPort'>>

/**
 * The ZimService deps of the fake-children suites: fake tool paths, a probe that answers, and
 * millisecond health / teardown bounds. A value in `over` wins; an `undefined` one keeps the
 * default. Copied by property descriptor, so a getter in `over` (read at call time) survives.
 */
export function zimServiceDeps(over: ZimServiceDepsOverrides): ZimServiceDeps {
  const deps: ZimServiceDeps = {
    resolveTools: () => ({ serve: '/bin/kiwix-serve', manage: '/bin/kiwix-manage' }),
    probe: async () => true,
    healthTimeoutMs: 1_000,
    healthIntervalMs: 1,
    killGraceMs: 5,
    forceKillWaitMs: 5
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(over))) {
    if ('value' in descriptor && descriptor.value === undefined) continue
    Object.defineProperty(deps, key, descriptor)
  }
  return deps
}

/** What an install marker records for a binary: its true hash, a wrong hash, or no hashes (a
 *  bundle placed by hand). The real verifier answers `ok`, `mismatch` and `skip-legacy`. */
export type MarkerVerdict = 'ok' | 'mismatch' | 'legacy'

/**
 * A real on-disk binary `name` under a real install marker, for a suite that drives the REAL
 * pre-spawn verifier: `initBinaryVerification(false)` turns enforcement on, and
 * `_resetBinaryVerificationForTests()` must undo it. Returns the binary's path.
 */
export async function binaryWithMarker(name: string, verdict: MarkerVerdict): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-marker-'))
  const bin = join(dir, name)
  writeFileSync(bin, 'real-binary-bytes')
  const marker = { version: '3.8.1', backend: 'cpu', os: 'win' as const, arch: 'x64' }
  if (verdict === 'legacy') {
    writeRuntimeMarker(dir, marker)
  } else {
    const hash = verdict === 'ok' ? await sha256File(bin) : 'c'.repeat(64)
    writeRuntimeMarker(dir, { ...marker, binaries: { [markerBinaryKey(dir, bin)]: hash } })
  }
  return bin
}

/** Assert a promise rejects with the #159 AbortError convention (a `DOMException` named
 *  `AbortError`, the shape `isStartAbortError` in runtime/sidecar.ts recognises). */
export async function expectAbortError(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('expected an AbortError rejection, but the call resolved')
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(DOMException)
  expect((err as DOMException).name).toBe('AbortError')
}
