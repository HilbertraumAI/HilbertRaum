import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SKILL_LIMITS, resolveSkillLimits } from '../../src/main/services/skills/limits'
import {
  parseSkillManifestFromDir,
  parseSkillManifestSource
} from '../../src/main/services/skills/manifest'

const VALID_SKILL_MD = [
  '---',
  'id: contract-review',
  'title: Contract Review',
  'description: Lists the clauses I always check before signing.',
  'version: 1.2.0',
  '---',
  '',
  'Check every clause carefully.',
  ''
].join('\n')

describe('resolveSkillLimits', () => {
  it('returns the documented defaults with no env overrides', () => {
    const limits = resolveSkillLimits({})
    expect(limits).toEqual(DEFAULT_SKILL_LIMITS)
    expect(limits.maxFileBytes).toBe(1024 * 1024)
    expect(limits.maxTotalBytes).toBe(8 * 1024 * 1024)
    expect(limits.maxFiles).toBe(200)
    expect(limits.maxPathLen).toBe(255)
    expect(limits.maxDepth).toBe(4)
    expect(limits.maxBodyChars).toBe(64 * 1024)
  })

  it('applies env overrides for each cap', () => {
    const limits = resolveSkillLimits({
      HILBERTRAUM_SKILL_MAX_FILE_BYTES: '2048',
      HILBERTRAUM_SKILL_MAX_TOTAL_BYTES: '4096',
      HILBERTRAUM_SKILL_MAX_FILES: '10',
      HILBERTRAUM_SKILL_MAX_PATH_LEN: '120',
      HILBERTRAUM_SKILL_MAX_DEPTH: '2',
      HILBERTRAUM_SKILL_MAX_BODY: '500'
    } as NodeJS.ProcessEnv)
    expect(limits).toEqual({
      maxFileBytes: 2048,
      maxTotalBytes: 4096,
      maxFiles: 10,
      maxPathLen: 120,
      maxDepth: 2,
      maxBodyChars: 500
    })
  })

  it('ignores junk / non-positive overrides and keeps the default', () => {
    const limits = resolveSkillLimits({
      HILBERTRAUM_SKILL_MAX_FILES: 'lots',
      HILBERTRAUM_SKILL_MAX_DEPTH: '0',
      HILBERTRAUM_SKILL_MAX_BODY: '-5'
    } as NodeJS.ProcessEnv)
    expect(limits.maxFiles).toBe(DEFAULT_SKILL_LIMITS.maxFiles)
    expect(limits.maxDepth).toBe(DEFAULT_SKILL_LIMITS.maxDepth)
    expect(limits.maxBodyChars).toBe(DEFAULT_SKILL_LIMITS.maxBodyChars)
  })
})

describe('parseSkillManifestSource', () => {
  it('applies the env-resolved body cap from limits', () => {
    const big = ['---', 'id: xx', 'title: X', 'description: d', 'version: 1.0.0', '---', '', 'y'.repeat(100)].join('\n')
    expect(parseSkillManifestSource(big, { limits: { ...DEFAULT_SKILL_LIMITS, maxBodyChars: 50 } }).ok).toBe(false)
    expect(parseSkillManifestSource(big, { limits: { ...DEFAULT_SKILL_LIMITS, maxBodyChars: 500 } }).ok).toBe(true)
  })
})

describe('parseSkillManifestFromDir', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hr-skill-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads + validates a SKILL.md from a package dir', () => {
    writeFileSync(join(dir, 'SKILL.md'), VALID_SKILL_MD, 'utf8')
    const res = parseSkillManifestFromDir(dir)
    expect(res.ok).toBe(true)
    expect(res.manifest?.id).toBe('contract-review')
    expect(res.manifest?.version).toBe('1.2.0')
  })

  it('fails friendly when SKILL.md is missing', () => {
    const res = parseSkillManifestFromDir(dir)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('SKILL.md'))).toBe(true)
  })

  it('reads an optional manifest.json and notes a conflict (SKILL.md wins, DS2)', () => {
    writeFileSync(join(dir, 'SKILL.md'), VALID_SKILL_MD, 'utf8')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '9.9.9' }), 'utf8')
    const res = parseSkillManifestFromDir(dir)
    expect(res.ok).toBe(true)
    expect(res.manifest?.version).toBe('1.2.0')
    expect(res.notes.some((n) => n.includes('manifest.json'))).toBe(true)
  })

  it('ignores a malformed manifest.json without erroring', () => {
    writeFileSync(join(dir, 'SKILL.md'), VALID_SKILL_MD, 'utf8')
    writeFileSync(join(dir, 'manifest.json'), '{ not valid json', 'utf8')
    const res = parseSkillManifestFromDir(dir)
    expect(res.ok).toBe(true)
  })

  it('does not confuse a nested resources dir for the package root', () => {
    mkdirSync(join(dir, 'resources'))
    writeFileSync(join(dir, 'resources', 'note.md'), 'reference', 'utf8')
    writeFileSync(join(dir, 'SKILL.md'), VALID_SKILL_MD, 'utf8')
    expect(parseSkillManifestFromDir(dir).ok).toBe(true)
  })
})
