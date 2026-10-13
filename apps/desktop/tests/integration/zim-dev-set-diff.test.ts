import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// scripts/zim-dev-set-diff.mjs — stage A of the knowledge-pack acceptance read
// (docs/rag-design.md §17, "Shipping rule for knowledge-pack changes"). It loads the converter
// straight from git with Node's type stripping, the way scripts/zim-html-perf.mjs did until the
// converter gained extension-less imports and that script stopped loading without anyone noticing
// (#627). This runs it end to end on the committed fixtures, base and head both HEAD, so a
// developer's uncommitted converter edits cannot turn it red.

const repoRoot = join(__dirname, '..', '..', '..', '..')
const fixtures = join(__dirname, '..', 'fixtures', 'zim')
const scratch = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-diff-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe.skipIf(!process.features.typescript)('zim-dev-set-diff.mjs (stage A of the acceptance read)', () => {
  it('loads a git ref’s converter, converts every cached article twice and reports them word-identical', () => {
    const json = join(scratch, 'report.json')
    const run = spawnSync(
      process.execPath,
      ['--no-warnings', 'scripts/zim-dev-set-diff.mjs', '--pages', fixtures, '--base', 'HEAD', '--head', 'HEAD', '--json', json],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('VERDICT: WORDS IDENTICAL')
    const report = JSON.parse(readFileSync(json, 'utf8'))
    const articles = readdirSync(fixtures).filter((f) => f.endsWith('.html')).length
    expect(report.identical).toBe(true)
    expect(report.total).toEqual({ articles, identical: articles, whitespaceOnly: 0, wordsChanged: 0 })
  })
})
