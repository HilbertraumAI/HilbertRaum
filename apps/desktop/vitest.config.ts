import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { FullSuiteGuard, listTestFiles } from './tests/full-suite-guard'

// Default environment is node (the bulk of the suite tests main-process services). Renderer
// component tests opt into jsdom per-file with a `// @vitest-environment jsdom` docblock and
// pull in React Testing Library; the setup file registers @testing-library/jest-dom matchers.

// Full-suite collection guard (see tests/full-suite-guard.ts). Only enforce on an unfiltered
// run: vitest's argv after the `run` subcommand is flags-only for a full run, so any positional
// (a path/name filter via `npm test -- tests/unit`) means "subset" and disables the guard. The
// gate fails safe — an unrecognised invocation disables the guard rather than false-failing.
const runArgs = process.argv.slice(process.argv.indexOf('run') + 1)
const isFullRun = process.argv.includes('run') && !runArgs.some((a) => !a.startsWith('-'))
const expectedFiles = isFullRun ? listTestFiles(__dirname, resolve(__dirname, 'tests')) : null

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
    testTimeout: process.env.CI ? 60_000 : 15_000
  }
})
