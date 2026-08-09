import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Opt-in performance mark log for measurement runs (docs/benchmark.md "Perf marks").
//
// Enabled ONLY when the environment variable HILBERTRAUM_PERF_LOG=1 is set (a launcher
// or terminal decision, never a setting): every exported function is a no-op otherwise,
// and no perf.log is ever created for a normal user.
//
// This is deliberately separate from logging.ts. That log buffers in memory before
// unlock and rests encrypted on an encrypted workspace, which makes it unusable for
// timing a packaged Windows launch (no console, info lines only flushed on error,
// rotation, lock, or quit). Timing marks need to land on disk immediately, in
// plaintext, so an interrupted run still yields data.
//
// Plaintext on an encrypted workspace is acceptable here because the content rule is
// STRICTER than logging.ts: a mark carries only a phase name, a model or backend id,
// byte counts, and millisecond durations. Never file names, paths of user files,
// document titles, chat text, or anything password-derived. Document marks identify a
// document only by its random UUID.
//
// Line format: `<ISO-8601 wall clock> <monotonic ms> <event> <json fields>`.
// The wall-clock column correlates with timestamps written outside the process (for
// example a launcher stamp file); the monotonic column (performance.now(), origin at
// process start) gives clean intra-process deltas immune to clock adjustments.
//
// Marks fired before initPerf() (the pre-workspace-resolution window) buffer in
// memory and flush on init, so app_ready is never lost.

const PENDING_MAX = 200

let perfFile: string | null = null
const pending: string[] = []

function enabled(): boolean {
  return process.env.HILBERTRAUM_PERF_LOG === '1'
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Round a millisecond duration for the log: whole ms is plenty at these scales. */
export function perfMs(sinceMonotonicMs: number): number {
  return Math.round(performance.now() - sinceMonotonicMs)
}

/**
 * Adopt the log directory (the same directory logging.ts uses) and flush any marks
 * buffered before init. Call once, right after initLogging(). No-op when disabled.
 */
export function initPerf(directory: string): void {
  if (!enabled()) return
  try {
    mkdirSync(directory, { recursive: true })
    perfFile = join(directory, 'perf.log')
    if (pending.length > 0) {
      appendFileSync(perfFile, pending.join(''))
      pending.length = 0
    }
  } catch {
    /* never crash the app because perf logging failed */
    perfFile = null
  }
}

/**
 * Append one timing mark. Synchronous and tiny (a line is under ~200 bytes), so the
 * measurement I/O itself is negligible next to the multi-MB events being measured.
 * No-op when disabled; buffered when fired before initPerf().
 */
export function perfMark(
  event: string,
  fields?: Record<string, string | number | boolean | null>
): void {
  if (!enabled()) return
  const line = `${new Date().toISOString()} ${performance.now().toFixed(1)} ${event}${
    fields !== undefined ? ' ' + safeJson(fields) : ''
  }\n`
  if (perfFile === null) {
    pending.push(line)
    if (pending.length > PENDING_MAX) pending.shift()
    return
  }
  try {
    appendFileSync(perfFile, line)
  } catch {
    /* never crash the app because perf logging failed */
  }
}
