import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { File, Reporter } from 'vitest'

// Full-suite collection guard.
//
// vitest's parallel pool can, under heavy machine load, silently drop a test file from a
// run — a worker fails to collect it and the run reports a *lower* file total with no error
// and a green exit (we saw 164/168 instead of 168/168 during the 2026-06-19 merge). A dropped
// suite that "passes" by not running is a false green. This reporter turns that into a hard
// failure: it walks the test tree on disk and asserts vitest collected every file. If any are
// missing it throws from `onFinished`, which vitest surfaces as a fatal error and a non-zero
// exit (verified: a throw here exits 1; setting `process.exitCode` does NOT stick).
//
// It only enforces when handed an `expected` list (the full unfiltered suite). Filtered runs
// (`vitest run tests/unit`, a name pattern, watch mode) pass `null` and the guard no-ops, so
// running a subset never false-fails. See vitest.config.ts for the gate.

/** Posix-relative paths (from `root`) of every `*.test.{ts,tsx}` file under `testsDir`. */
export function listTestFiles(root: string, testsDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.test\.tsx?$/.test(entry.name)) out.push(relative(root, full).split('\\').join('/'))
    }
  }
  walk(testsDir)
  return out.sort()
}

export class FullSuiteGuard implements Reporter {
  constructor(private readonly expected: readonly string[] | null) {}

  onFinished(files: File[] = []): void {
    if (!this.expected) return // filtered / subset / watch run — nothing to assert against
    const collected = new Set(files.map((f) => f.name.split('\\').join('/')))
    const missing = this.expected.filter((f) => !collected.has(f))
    if (missing.length === 0) return
    const msg =
      `Full-suite collection guard FAILED: vitest collected ${collected.size} of ` +
      `${this.expected.length} test files. ${missing.length} were dropped (silent under-` +
      `collection — likely a pool worker died under load). A dropped suite must NOT pass ` +
      `as green. Re-run the suite. Missing files:\n` +
      missing.map((f) => `  - ${f}`).join('\n')
    // A throw from onFinished is the only mechanism that reliably forces a non-zero exit.
    throw new Error(msg)
  }
}
