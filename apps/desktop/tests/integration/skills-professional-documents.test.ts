import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'
import type { Db } from '../../src/main/services/db'
import { reconcileSkills, getSkill, skillInstallId } from '../../src/main/services/skills/registry'
import { openFreshDb } from '../helpers/db-fixtures'
import { realAppSkillsDeps, type SkillDirs } from '../helpers/skill-fixtures'

// The "Professional Documents" wave — the upgraded Meeting Minutes skill plus four NEW Tier-1
// instruction skills (contract-brief, deadline-obligation-finder, what-changed, share-safe-review).
// Proves, against the COMMITTED app-skills/ packages: all five are kind:instruction reserving NO tools;
// every directory id is discovered and enabled (so the meeting-protocol id is unchanged — old
// conversations still resolve it). The English + German trigger rows live in the production-path eval
// (`tests/eval/skill-triggers.test.ts` + its corpus), not here.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')

const NEW_SKILL_IDS = ['contract-brief', 'deadline-obligation-finder', 'what-changed', 'share-safe-review'] as const
const ALL_PRO_SKILL_IDS = ['meeting-protocol', ...NEW_SKILL_IDS] as const

function readSkillMd(id: string): string {
  return readFileSync(join(APP_SKILLS_DIR, id, 'SKILL.md'), 'utf8')
}

const freshDb = (): Db => openFreshDb('prodocs')

/** Reconcile against the REAL committed app-skills/ so the live selector sees the shipped triggers. */
const realDeps = (): SkillDirs => realAppSkillsDeps('prodocs-user')

describe('Professional Documents — every package is a valid bundled skill', () => {
  it('all five skills are Tier-1 instruction skills with NO tools and a German display name', () => {
    for (const id of ALL_PRO_SKILL_IDS) {
      const m = parseSkillMarkdown(readSkillMd(id)).manifest!
      expect(m.kind, `${id} must be instruction`).toBe('instruction')
      expect(m.allowedTools, `${id} must reserve no tools`).toEqual([])
      expect(m.reservesTools, `${id} must not reserve tools`).toBe(false)
      // v1 ceiling holds — no network, documents at most selected_only.
      expect(m.permissions.network).toBe('denied')
      expect(m.permissions.documents).toBe('selected_only')
      expect(m.permissions.filesystem).toBe('skill_resources_only')
      // German localized display metadata is present (parser supports localized.de).
      expect(m.localized?.de?.title, `${id} needs a German title`).toBeTruthy()
      expect(m.localized?.de?.description, `${id} needs a German description`).toBeTruthy()
    }
  })

})

describe('Professional Documents — discovery + reconcile (S3)', () => {
  it('discovers and enables all five committed app skills', () => {
    const db = freshDb()
    reconcileSkills(db, realDeps())
    for (const id of ALL_PRO_SKILL_IDS) {
      const rec = getSkill(db, skillInstallId('app', id))
      expect(rec, `${id} must be discovered from app-skills/`).not.toBeNull()
      expect(rec!.enabled).toBe(true)
      expect(rec!.source).toBe('app')
      expect(rec!.trustedLevel).toBe('app')
      expect(rec!.kind).toBe('instruction')
    }
  })
})
