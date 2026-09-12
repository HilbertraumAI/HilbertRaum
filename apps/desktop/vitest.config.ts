import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { FullSuiteGuard, listTestFiles, parseShard, shardTestFiles } from './tests/full-suite-guard'

// Default environment is node (the bulk of the suite tests main-process services). Renderer
// component tests opt into jsdom per-file with a `// @vitest-environment jsdom` docblock and
// pull in React Testing Library; the setup file registers @testing-library/jest-dom matchers.

// Full-suite collection guard (see tests/full-suite-guard.ts). Only enforce on an unfiltered
// run: vitest's argv after the `run` subcommand is flags-only for a full run, so any positional
// (a path/name filter via `npm test -- tests/unit`) means "subset" and disables the guard. The
// gate fails safe — an unrecognised invocation disables the guard rather than false-failing.
//
// A SHARDED run (#458 step 2: the windows legs are split) is still a full run, just divided,
// so the guard stays on and narrows to the shard's expected subset — `shardTestFiles`
// reproduces vitest's own split. Without that it would demand all 449 files from a job that
// correctly collected half, failing every sharded run.
//
// `--shard 1/2` (space form) puts its VALUE in argv looking exactly like a path filter, which
// would switch the guard off instead of narrowing it — silently, the one failure mode this
// file cannot tolerate. So the positional check skips a `--shard` value. CI uses the `=` form.
const runArgs = process.argv.slice(process.argv.indexOf('run') + 1)
const shard = parseShard(runArgs)
const positionals = runArgs.filter((a, i) => !a.startsWith('-') && runArgs[i - 1] !== '--shard')
const isFullRun = process.argv.includes('run') && positionals.length === 0
const allTestFiles = isFullRun ? listTestFiles(__dirname, resolve(__dirname, 'tests')) : null
const expectedFiles = allTestFiles && shard ? shardTestFiles(allTestFiles, shard) : allTestFiles

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      // AssistantMarkdown ships lazy in prod (renderer code-split: streamdown/katex load as a
      // separate chunk via ./AssistantMarkdownLazy's React.lazy). In tests, resolve that wrapper
      // to the real synchronous component so render assertions don't have to await Suspense/chunk
      // load. Both the chat barrel and Transcript import the exact specifier './AssistantMarkdownLazy'.
      './AssistantMarkdownLazy': resolve(__dirname, 'src/renderer/chat/AssistantMarkdown.tsx')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Issue #335: `setup-temp-roots.ts` records every `hilbertraum-*` / `hr-*` root a file mints
    // under the OS temp dir and removes them in that file's `afterAll`; `global-temp-roots.ts`
    // sweeps, after the forks exit, the roots an open sqlite handle kept locked on Windows.
    // See tests/helpers/temp-roots.ts. Before this, a full run leaked ~2,500 roots.
    setupFiles: ['./tests/setup.ts', './tests/setup-temp-roots.ts'],
    globalSetup: ['./tests/global-temp-roots.ts'],
    globals: true,
    reporters: ['default', new FullSuiteGuard(expectedFiles)],
    // Pin the pool explicitly (don't ride vitest's default) so collection behaviour is
    // deterministic across vitest upgrades. `forks` keeps each suite in its own process —
    // required here because parts of the suite touch native bindings (node:sqlite, llama)
    // that don't share cleanly across worker threads. The FullSuiteGuard above is the hard
    // backstop for any load-induced fork drop.
    pool: 'forks',
    // The full parallel suite on a loaded machine starves the heavy integration/
    // renderer tests of CPU and trips vitest's 5 s default timeout (historically
    // 1–2 flakes per run, a different test each time; all pass in isolation). 3×
    // headroom absorbs the scheduling, costs nothing when tests are fast, and —
    // unlike capping maxWorkers — leaves the wall time of a clean run unchanged.
    // TS-1 (full-audit 2026-07-10): the raw fixed-sleep sync points behind those
    // flakes were swept — every wait is now a poll-until gate on observable state,
    // and each surviving fixed sleep carries a comment justifying it (timestamp
    // ordering, timeout simulation, single-macrotask hops). The timeout stays as
    // cheap headroom for genuinely CPU-starved forks, not as a flake mitigation.
    //
    // Issue #101: the same starvation is ENDEMIC on the CI *windows* runners (~2×
    // ubuntu wall-clock; 11 min observed on a re-run leg). Three distinct
    // integration tests hit the 15 s budget in ten days — vault-lock-cipher
    // (2026-07-24 push run), docs-ipc BE-1 (PR #96 / #97), dictation REL-3
    // (PR #100) — each green on the same tree's other legs and its own re-run.
    // On CI the budget therefore rises to 60 s (GitHub Actions sets CI=true).
    // This loosens no evidence: timing PROOFS in this suite live in explicit
    // assertions (e.g. the FTS 500 ms bound, #84), never in the vitest budget.
    // Locally the tight 15 s stays, catching real hangs fast at the desk.
    testTimeout: process.env.CI ? 60_000 : 15_000,
    // Hooks get the SAME budget as tests, for the same reason and on the same evidence.
    // Until #458 this line did not exist, so `beforeEach`/`afterEach`/`beforeAll` ran on
    // vitest's 10 s default — SIX TIMES LESS headroom than the tests above, on the one
    // platform the comment above says is starved. Two of the five windows flakes in #458 were
    // hook timeouts, not test timeouts: `performance-gpu` (run 34655007954) and
    // `doctasks-translation` (run 34543501694), both `Hook timed out in 10000ms`.
    //
    // Those hooks are not slow. `performance-gpu`'s is five synchronous resets; 10 s on that is
    // a fork that got no CPU, which no amount of hook optimisation fixes: vitest runs
    // `availableParallelism() - 1` forks, so on a 4-core runner three forks plus the main
    // process fill the machine before Defender and the runner agent take their share.
    //
    // The 10 s default was already known to be too tight here and patched ONE hook at a time —
    // `tests/setup-temp-roots.ts` carries its own `TEARDOWN_TIMEOUT_MS` (120 s) citing run
    // 34033122353. This generalises that fix instead of waiting for each hook to be bitten;
    // 129 suites open a sqlite DB (99 of them never close it, #460) and many do that plus
    // `mkdtempSync` inside a hook, as do the fixture teardowns that close DBs and remove roots.
    //
    // This loosens no evidence, exactly as for `testTimeout`: a hook is SETUP, never a timing
    // proof — the suite's timing proofs live in explicit assertions (the FTS 500 ms bound, #84),
    // and nothing asserts a hook timeout. Locally the tight 15 s stays, so a real hang at the
    // desk still fails fast.
    hookTimeout: process.env.CI ? 60_000 : 15_000
  }
})
