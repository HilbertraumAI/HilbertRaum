import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../helpers/repo-files'
import { hangBudgetMs } from '../helpers/hang-budget'

// The combined `eval/results/<stem>.csv` files are derived: `eval/combine.mjs` joins each
// `<stem>-quality-rescored.csv` with its `<stem>-speed.csv`. Scorer v3 once re-ran rescore.mjs and
// left the committed combined CSV a cell behind (#833). This row runs the real script over the
// committed inputs in a scratch tree laid out like the repo (it resolves `results/` next to
// itself) and compares every output with the committed file byte for byte. The committed set is
// derived: every `<stem>.csv` that has a `<stem>-speed.csv` sibling. No inventory to keep in step.
// Regenerate with `node eval/combine.mjs`, then commit the changed CSVs.
describe('eval/combine.mjs matches the committed combined CSVs', () => {
  const RESULTS = join(REPO_ROOT, 'eval', 'results')
  const files = readdirSync(RESULTS)
  const committed = files
    .filter((f) => f.endsWith('.csv') && !f.endsWith('-speed.csv') && files.includes(f.replace(/\.csv$/, '-speed.csv')))
    .sort()
  const isInput = (f: string): boolean => f.endsWith('-speed.csv') || f.endsWith('-quality-rescored.csv')

  let root: string
  let out: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hilbertraum-combine-'))
    out = join(root, 'eval', 'results')
    mkdirSync(out, { recursive: true })
    copyFileSync(join(REPO_ROOT, 'eval', 'combine.mjs'), join(root, 'eval', 'combine.mjs'))
    for (const f of files.filter(isInput)) copyFileSync(join(RESULTS, f), join(out, f))
    const run = spawnSync(process.execPath, [join(root, 'eval', 'combine.mjs')], {
      encoding: 'utf8',
      timeout: hangBudgetMs(10_000)
    })
    expect(run.status, String(run.stderr)).toBe(0)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('finds committed combined CSVs to check', () => {
    expect(committed.length).toBeGreaterThan(0)
  })

  it('writes exactly the committed set: no combined CSV is missing from the repo, none is left over', () => {
    const written = readdirSync(out).filter((f) => !isInput(f))
    expect(written.sort()).toEqual(committed)
  })

  it.each(committed)('%s is what combine.mjs writes from the committed inputs', (f) => {
    expect(readFileSync(join(RESULTS, f), 'utf8')).toBe(readFileSync(join(out, f), 'utf8'))
  })
})
