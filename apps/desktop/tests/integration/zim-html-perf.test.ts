import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testBudgetMs } from '../helpers/hang-budget'

// #715 — a load smoke for scripts/zim-html-perf.mjs, the D2 performance report (rag-design §17
// D-Z3). It imports the converter's TypeScript sources straight from apps/desktop with Node's type
// stripping, and it once stopped loading for months without anyone noticing: the converter grew
// its first extension-less sibling import (#627). Nothing ran it. This runs its shortest mode on
// the committed fixtures and checks it got through every section to the verdict; the figures
// themselves are machine-dependent and asserted nowhere.

const repoRoot = join(__dirname, '..', '..', '..', '..')
const fixtures = join(__dirname, '..', 'fixtures', 'zim')

describe.skipIf(!process.features.typescript)('zim-html-perf.mjs (the D2 converter measurement)', () => {
  it(
    'loads the converter and reports every section through to the verdict',
    () => {
      const run = spawnSync(process.execPath, ['--no-warnings', 'scripts/zim-html-perf.mjs', '--quick', '--fixtures', fixtures], {
        cwd: repoRoot,
        encoding: 'utf8'
      })
      expect(run.stderr).toBe('')
      expect(run.status).toBe(0)
      for (const section of ['== Section A', '== Section B', '== Section C', '== Section D', '== Verdict ==']) {
        expect(run.stdout).toContain(section)
      }
    },
    testBudgetMs(60_000)
  )
})
