import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkillPackage } from '../../src/main/services/skills/loader'
import type { SkillRecord } from '../../src/main/services/skills/registry'

// Per-turn parse cache (perf): resolveTurnSkill loads the skill on every turn, so loadSkillPackage
// caches the parsed SKILL.md keyed by its (mtime,size). An unchanged skill is a stat+map hit (same
// result object); an on-disk edit (DS1/DS2 — disk is the source of truth) re-parses on the next call.

function skillMd(id: string, body: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: Skill ${id}`,
    `description: Test ${id}`,
    'version: 1.0.0',
    '---',
    body
  ].join('\n')
}

function makeEnv(id: string, body: string): {
  record: SkillRecord
  opts: { appSkillsDir: string; userSkillsDir: string }
  mdPath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-loadercache-'))
  const userSkillsDir = join(root, 'user-skills')
  const dir = join(userSkillsDir, id)
  mkdirSync(dir, { recursive: true })
  const mdPath = join(dir, 'SKILL.md')
  writeFileSync(mdPath, skillMd(id, body), 'utf8')
  const record = { source: 'user', path: id } as SkillRecord
  return { record, opts: { appSkillsDir: join(root, 'app-skills'), userSkillsDir }, mdPath }
}

describe('loadSkillPackage parse cache', () => {
  it('returns the SAME parsed result object on an unchanged skill (cache hit, no re-parse)', () => {
    const { record, opts } = makeEnv('bank', 'Quote the printed totals.')
    const first = loadSkillPackage(record, opts)
    const second = loadSkillPackage(record, opts)
    expect(first.ok).toBe(true)
    expect(second).toBe(first) // identity ⇒ served from cache, not re-parsed
  })

  it('re-parses when the SKILL.md size changes on disk', () => {
    const { record, opts, mdPath } = makeEnv('bank', 'Short body.')
    const first = loadSkillPackage(record, opts)
    writeFileSync(mdPath, skillMd('bank', 'A noticeably longer body than before, different size.'), 'utf8')
    const second = loadSkillPackage(record, opts)
    expect(second).not.toBe(first)
    expect(second.ok && second.body).toContain('noticeably longer')
  })

  it('re-parses when only the mtime changes (same size, edited in place)', () => {
    const { record, opts, mdPath } = makeEnv('bank', 'AAAA')
    const first = loadSkillPackage(record, opts)
    // Same byte length, different content + bumped mtime → must invalidate.
    writeFileSync(mdPath, skillMd('bank', 'BBBB'), 'utf8')
    const later = statSync(mdPath).mtimeMs / 1000 + 5
    utimesSync(mdPath, later, later)
    const second = loadSkillPackage(record, opts)
    expect(second).not.toBe(first)
    expect(second.ok && second.body).toContain('BBBB')
  })

  it('a vanished SKILL.md is not served from the cache, and a re-created one loads again', () => {
    const { record, opts, mdPath } = makeEnv('bank', 'Body.')
    expect(loadSkillPackage(record, opts).ok).toBe(true) // primes the cache for this dir
    rmSync(mdPath)
    expect(loadSkillPackage(record, opts).ok).toBe(false) // stat fails: friendly error, not the stale parse
    // Re-created with different text: the new body is served, never the pre-delete parse.
    writeFileSync(mdPath, skillMd('bank', 'Rewritten body.'), 'utf8')
    const again = loadSkillPackage(record, opts)
    expect(again.ok).toBe(true)
    expect(again.ok && again.body).toContain('Rewritten body.')
  })
})
