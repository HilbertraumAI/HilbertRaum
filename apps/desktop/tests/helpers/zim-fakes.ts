import { EventEmitter } from 'node:events'
import { expect } from 'vitest'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import type { ZimServiceDeps } from '../../src/main/services/zim'
import { appendLibraryBook, type LibraryBookOptions } from './zim-library'

// Shared knowledge-pack test doubles (#301): the controlled-promise gate, the fake kiwix-serve /
// kiwix-manage child and its scripted early deaths, the fake kiwix-manage spawn, the ZimService
// deps every service suite passes.
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

/** What a child that dies before it is healthy does: exits (after writing `stderr`, then closes its
 *  stdio, as Node reports a real child), or emits a spawn `error` (ENOENT and friends) and never
 *  exits. `exitFirst`: Node delivers `'exit'` BEFORE the last stderr chunk, which then arrives on
 *  a later turn, followed by `'close'` (#712, #530's ordering). */
export type EarlyFailure =
  | { kind: 'exit'; code: number; stderr?: string; exitFirst?: boolean }
  | { kind: 'error'; error: Error }

// What the REAL kiwix-serve 3.8.1 (win-x86_64) writes to stderr, captured from the pinned binary
// on 2026-11-08 (#712): spawned as `KiwixServer` spawns it, against a held port and against a
// library file it cannot load. Both are followed by exit 1. The library path is the one it was
// given, so a fake prints the path ITS spawn received — the leak #712 is about.

/** kiwix-serve losing its port between `findFreePort()` and bind (libkiwix `InternalServer::start`).
 *  Until #712 the fake printed llama-server's "address already in use", which kiwix-serve never
 *  prints — so the retry passed here and never fired against the real binary. */
export const BIND_RACE: EarlyFailure = {
  kind: 'exit',
  code: 1,
  stderr:
    'Unable to instantiate the HTTP daemon. The port 56283 is maybe already occupied or need more ' +
    'permissions to be open. Please try as root or with a port number higher or equal to 1024.\r\n'
}

/** kiwix-serve unable to load its library file (libkiwix `Manager::reload` + `reloadLibrary`) —
 *  the shape a non-ASCII workspace path produces on Windows. */
export function libraryLoadFailure(libraryXmlPath: string): EarlyFailure {
  return {
    kind: 'exit',
    code: 1,
    stderr:
      `ERROR: Failed to load the XML library file '${libraryXmlPath}'.\r\n` +
      'Errors encountered while loading the library.\r\n'
  }
}

/** A spawn failure shaped like Node's own (`ENOENT` for a missing binary): the path rides in
 *  `message`, `syscall` and `path`, the whole argv in `spawnargs`. */
export function spawnErrorLike(binPath: string, args: readonly string[], code = 'ENOENT'): Error {
  return Object.assign(new Error(`spawn ${binPath} ${code}`), {
    code,
    errno: -4058,
    syscall: `spawn ${binPath}`,
    path: binPath,
    spawnargs: [...args]
  })
}

/** Make `child` die right after spawn, before any health probe can see it alive. */
export function failEarly(child: ServeFakeChild, failure: EarlyFailure): void {
  queueMicrotask(() => {
    if (failure.kind === 'error') {
      child.emit('error', failure.error)
      return
    }
    if (failure.exitFirst) {
      child.emit('exit', failure.code, null)
      setTimeout(() => {
        if (failure.stderr) child.stderr.emit('data', failure.stderr)
        child.emit('close', failure.code, null)
      }, 5)
      return
    }
    if (failure.stderr) child.stderr.emit('data', failure.stderr)
    child.emit('exit', failure.code, null)
    child.emit('close', failure.code, null)
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
