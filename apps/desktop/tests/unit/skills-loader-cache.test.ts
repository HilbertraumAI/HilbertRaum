import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSkillPackage,
  clearSkillParseCache
} from '../../src/main/services/skills/loader'
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
  beforeEach(() => clearSkillParseCache())

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

  it('a missing SKILL.md is not cached (defers to the friendly parser error)', () => {
    const { record, opts } = makeEnv('bank', 'Body.')
    const ok = loadSkillPackage(record, opts)
    expect(ok.ok).toBe(true)
    // Point the record at a sibling folder with no SKILL.md.
    const missing = { source: 'user', path: 'does-not-exist' } as SkillRecord
    const res = loadSkillPackage(missing, opts)
    expect(res.ok).toBe(false)
  })
})
