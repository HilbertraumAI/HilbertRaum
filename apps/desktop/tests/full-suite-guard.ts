import { createHash } from 'node:crypto'
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

// ---- Sharding (#458 step 2) ---------------------------------------------------------------
//
// The windows legs run at their time budget, so CI splits each of them into `--shard` jobs.
// That breaks the gate above unless the guard knows about it: `--shard=1/2` is a FLAG, so
// `isFullRun` in vitest.config.ts stays true and the guard would demand all 449 files from a
// job that legitimately collected half — a hard failure on EVERY sharded run.
//
// Note the alternative is worse, which is why this code exists rather than a folder split:
// `vitest run tests/unit` passes a POSITIONAL, so `isFullRun` goes false and the guard
// silently NO-OPS. Splitting the suite that way would quietly retire the very false-green
// protection this file exists for, with no signal. Shard; never split by path.
//
// So reproduce vitest's own split and assert the shard's expected SUBSET. The union of the
// shards is still every file, so nothing is given up: a dropped file fails whichever shard
// owned it. Kept deliberately faithful to vitest 3.2.6 `BaseSequencer.shard`:
//
//   const shardSize = Math.ceil(files.length / count)
//   files.map((spec) => ({ spec, hash: hash('sha1', specPath, 'hex') }))
//        .sort(byHashAscending)
//        .slice(shardSize * (index - 1), shardSize * index)
//
// The one detail that matters, and that cost a wrong first implementation here: `specPath` is
//
//   pathe.resolve(slash(config.root), slash(spec.moduleId)).slice(config.root.length)
//
// and vitest's `resolve` is **pathe**, which always returns POSIX paths — while vite has
// already normalised `config.root` to POSIX too. So the hashed string is simply the
// root-relative path with forward slashes and a leading one, `/tests/unit/x.test.ts`, on
// EVERY platform, and the split is therefore platform-independent. Reproducing it with
// node's native `path.resolve` looks equivalent and is not: on windows it hashes
// `\tests\unit\x.test.ts` and assigns a completely different half (verified — it agreed with
// vitest on 109 of 225 files, i.e. chance). `hash()` itself is `crypto.hash ?? createHash`,
// both plain sha1-hex.
//
// Verified against a real `vitest run --shard=1/2` on windows: this helper's shard 1 contains
// all 213 files that run actually executed (`shard-split` cases below pin the properties).
// If a vitest upgrade changes the algorithm the sharded legs fail loudly and together — the
// guard over-reporting missing files, never a false green.

export interface Shard {
  index: number
  count: number
}

/**
 * `--shard=1/2`, `--shard 1/2` or `--shard=2` → `{ index, count }`; `null` when absent or not
 * parseable. A malformed value returns null so the guard falls back to whole-suite enforcement
 * (fail safe: over-strict, never silently off) and vitest reports the bad flag itself.
 */
export function parseShard(argv: readonly string[]): Shard | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg !== '--shard' && !arg.startsWith('--shard=')) continue
    const raw = arg.startsWith('--shard=') ? arg.slice('--shard='.length) : (argv[i + 1] ?? '')
    const m = /^(\d+)(?:\/(\d+))?$/.exec(raw.trim())
    if (!m) return null
    const index = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count < 1 || index < 1 || index > count) return null
    return { index, count }
  }
  return null
}

/**
 * The subset of `files` — posix-relative paths as `listTestFiles` returns them — that vitest's
 * sequencer assigns to `shard`. Order is vitest's (hash-ascending), not the input order.
 */
export function shardTestFiles(files: readonly string[], shard: Shard): string[] {
  const shardSize = Math.ceil(files.length / shard.count)
  return [...files]
    .map((file) => ({ file, hash: createHash('sha1').update(`/${file}`).digest('hex') }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .slice(shardSize * (shard.index - 1), shardSize * shard.index)
    .map(({ file }) => file)
}
