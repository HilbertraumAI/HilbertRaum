import { appendFileSync, existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

// Test temp-root hygiene (issue #335). Roughly 120 test files mint a `hilbertraum-*` root under
// the OS temp directory per test (often with a sqlite handle open against it) and never remove
// it: a full `npm test` used to leave ~2,500 roots behind, every run. The Performance fixture's
// fix (`performance-fixture.ts`, PR #303 P8, TH2) — register every root at creation, one
// teardown removes them, retry once, never fail the suite over a timing artifact — is applied
// here ONCE for every file by the harness instead of by hand in each suite:
//
//   tests/setup-temp-roots.ts   (vitest `setupFiles`, runs inside every test file's fork) wraps
//                               the `mkdtemp` family, records every root minted directly under
//                               `os.tmpdir()` with a test prefix, and removes them in `afterAll`
//                               (ONE attempt each, under the hook's own long timeout); a root
//                               that cannot be removed — on Windows a sqlite handle the suite
//                               never closed keeps the file locked until the fork exits — goes
//                               onto the run's deferred list instead of failing the suite.
//   tests/global-temp-roots.ts  (vitest `globalSetup`, main process) mints the deferred list and
//                               sweeps it in its teardown, which runs after every fork has exited
//                               and released its handles.
//
// This module holds the pure pieces so they can be unit-tested (`tests/unit/temp-roots.test.ts`)
// and shared by both. Nothing here touches production code.

/** The prefixes test suites use for their temp roots (see the mkdtemp call sites under tests/). */
export const TEMP_ROOT_PREFIXES = ['hilbertraum-', 'hr-'] as const

/** The env var carrying the run's deferred-list path from `globalSetup` to the forks. */
export const DEFERRED_ROOTS_ENV = 'HILBERTRAUM_TEST_DEFERRED_ROOTS'

/**
 * Is `path` a test temp root this harness may remove: a directory DIRECTLY under `os.tmpdir()`
 * whose name starts with one of the test prefixes? Anything else — a root under a suite's own
 * scratch dir, a nested mkdtemp inside a workspace, an unrelated name — is left alone.
 */
export function isTestTempRoot(path: string, tmp: string = tmpdir()): boolean {
  const abs = resolve(path)
  if (resolve(dirname(abs)) !== resolve(tmp)) return false
  const name = basename(abs)
  return TEMP_ROOT_PREFIXES.some((p) => name.startsWith(p))
}

export interface RemoveTempRootOptions {
  /** Attempts in total (default 2: one retry). */
  attempts?: number
  /** Pause between attempts, ms (default 25). */
  delayMs?: number
  /** Injectable remover (default `rmSync(path, { recursive: true, force: true })`). */
  rm?: (path: string) => void
}

const defaultRm = (path: string): void => rmSync(path, { recursive: true, force: true })

/**
 * Remove one temp root. `force` makes a missing root a no-op; a failure (EBUSY / EPERM /
 * ENOTEMPTY from a handle still open on Windows, or a directory being written by a late
 * async task) is retried after a real macrotask, and a final failure is REPORTED as `false`,
 * never thrown — a leaked temp dir must not fail a green suite. Resolves `true` when the root
 * is gone afterwards.
 */
export async function removeTempRoot(path: string, opts: RemoveTempRootOptions = {}): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 2)
  const delayMs = opts.delayMs ?? 25
  const rm = opts.rm ?? defaultRm
  for (let i = 0; i < attempts; i++) {
    try {
      rm(path)
      return true
    } catch {
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return !existsSync(path)
}

/** Append one root to the run's deferred list (a no-op without a list, e.g. a bare vitest run). */
export function appendDeferredRoot(path: string, listFile: string | undefined = process.env[DEFERRED_ROOTS_ENV]): void {
  if (!listFile) return
  try {
    appendFileSync(listFile, `${path}\n`, 'utf8')
  } catch {
    /* the list is best-effort: a root we cannot record is the same leak as before */
  }
}

/** The deferred roots recorded so far (deduplicated, in first-seen order). */
export function readDeferredRoots(listFile: string): string[] {
  if (!existsSync(listFile)) return []
  const seen = new Set<string>()
  for (const line of readFileSync(listFile, 'utf8').split(/\r?\n/)) {
    const path = line.trim()
    if (path) seen.add(path)
  }
  return [...seen]
}

export interface SweepResult {
  removed: number
  remaining: string[]
}

/**
 * The post-run sweep: remove every deferred root (each still gated by `isTestTempRoot`, so a
 * corrupted list can never delete anything else), then delete the list itself.
 */
export async function sweepDeferredRoots(listFile: string, opts: RemoveTempRootOptions = {}): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, remaining: [] }
  for (const root of readDeferredRoots(listFile)) {
    if (!isTestTempRoot(root)) continue
    if (await removeTempRoot(root, opts)) result.removed += 1
    else result.remaining.push(root)
  }
  try {
    unlinkSync(listFile)
  } catch {
    /* already gone */
  }
  return result
}

// ---- The per-file registry the setup file feeds (module-level: one per fork + file) --------

const recorded: string[] = []

/** Record a root the wrapped `mkdtemp` minted; only test roots directly under the temp dir. */
export function recordTempRoot(path: unknown): void {
  if (typeof path === 'string' && isTestTempRoot(path)) recorded.push(path)
}

/** The roots recorded in this file so far and not yet cleaned up. */
export function pendingTempRoots(): readonly string[] {
  return recorded
}

/**
 * The per-file teardown: remove every recorded root; a root that cannot be removed goes onto
 * the deferred list for the post-run sweep. Returns what happened, for the unit test.
 */
export async function cleanupRecordedRoots(opts: RemoveTempRootOptions = {}): Promise<SweepResult> {
  const roots = recorded.splice(0, recorded.length)
  const result: SweepResult = { removed: 0, remaining: [] }
  for (const root of roots) {
    if (await removeTempRoot(root, opts)) {
      result.removed += 1
    } else {
      result.remaining.push(root)
      appendDeferredRoot(root)
    }
  }
  return result
}
