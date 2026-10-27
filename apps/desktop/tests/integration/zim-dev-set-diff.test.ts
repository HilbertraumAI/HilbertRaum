import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const scratchRepo = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-dev-set-diff-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(scratchRepo, { recursive: true, force: true })
})

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

  // Negative control: HEAD against HEAD can only ever say IDENTICAL, so a comparator that always
  // said so would pass the test above. A throwaway repo with a stub converter gives the script a
  // real words-changed pair and a whitespace-only pair, independent of this repo's history.
  it('reports a changed word as WORDS CHANGED (exit 1) and a whitespace-only change as identical words (exit 0)', () => {
    // The developer's global/system git config (hooks, templates, signing) and a hook's GIT_DIR
    // must not reach the scratch repo.
    const emptyConfig = join(scratch, 'empty.gitconfig')
    writeFileSync(emptyConfig, '')
    const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' }
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[k]
    const git = (...args: string[]): string =>
      execFileSync(
        'git',
        ['-c', 'user.name=zim-test', '-c', 'user.email=zim-test@example.invalid', '-c', 'core.autocrlf=false', ...args],
        { cwd: scratchRepo, env: gitEnv, encoding: 'utf8' }
      )
    const zimDir = join(scratchRepo, 'apps', 'desktop', 'src', 'main', 'services', 'zim')
    mkdirSync(zimDir, { recursive: true })
    mkdirSync(join(scratchRepo, 'scripts'), { recursive: true })
    copyFileSync(join(repoRoot, 'scripts', 'zim-dev-set-diff.mjs'), join(scratchRepo, 'scripts', 'zim-dev-set-diff.mjs'))
    const pages = join(scratchRepo, 'pages')
    mkdirSync(pages)
    writeFileSync(join(pages, 'a.html'), '<p>x</p>')
    const commitConverter = (text: string): string => {
      writeFileSync(
        join(zimDir, 'html.ts'),
        `export function zimArticleToSegments(_html) { return { title: 'T', segments: [{ sectionLabel: 'S', text: ${JSON.stringify(text)} }] } }
`
      )
      git('add', '--', 'apps/desktop/src/main/services/zim/html.ts', 'scripts/zim-dev-set-diff.mjs')
      git('commit', '-m', text)
      return git('rev-parse', 'HEAD').trim()
    }
    git('init', '-q')
    const c1 = commitConverter('alpha beta gamma')
    const c2 = commitConverter('alpha beta delta')
    const c3 = commitConverter('alpha  beta  delta')

    const run = (base: string, head: string, jsonName: string) => {
      const json = join(scratch, jsonName)
      const result = spawnSync(
        process.execPath,
        ['--no-warnings', 'scripts/zim-dev-set-diff.mjs', '--pages', pages, '--base', base, '--head', head, '--json', json],
        { cwd: scratchRepo, env: gitEnv, encoding: 'utf8' }
      )
      expect(existsSync(json), result.stderr).toBe(true)
      return { result, report: JSON.parse(readFileSync(json, 'utf8')) }
    }

    const changed = run(c1, c2, 'changed.json')
    expect(changed.result.status).toBe(1)
    expect(changed.result.stdout).toContain('VERDICT: WORDS CHANGED')
    expect(changed.report.identical).toBe(false)
    expect(changed.report.total).toEqual({ articles: 1, identical: 0, whitespaceOnly: 0, wordsChanged: 1 })

    const spaced = run(c2, c3, 'spaced.json')
    expect(spaced.result.status).toBe(0)
    expect(spaced.result.stdout).toContain('VERDICT: WORDS IDENTICAL')
    expect(spaced.report.identical).toBe(true)
    expect(spaced.report.total).toEqual({ articles: 1, identical: 0, whitespaceOnly: 1, wordsChanged: 0 })
  })
})
