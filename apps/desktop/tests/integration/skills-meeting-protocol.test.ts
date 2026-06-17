import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'
import { openDatabase, type Db } from '../../src/main/services/db'
import { reconcileSkills, getSkill, skillInstallId } from '../../src/main/services/skills/registry'
import { resolveTurnSkill } from '../../src/main/services/skills/turn'
import {
  buildSkillFence,
  composeSystemPromptWithSkill,
  SKILL_GUARD_LINE
} from '../../src/main/services/skills/prompt'

// Skills — the SECOND bundled app skill: meeting-protocol. Unlike bank-statement (a Tier-2 tool
// skill), this is the Tier-1 INSTRUCTION-only reference + the bilingual-trigger reference. It
// exercises the instruction path end-to-end against the COMMITTED package: parse (SL-1) →
// discover/reconcile (S3) → resolveTurnSkill (S6) → fence into a prompt (S7), and pins that an
// instruction skill reserves NO tools and that German plurals with umlauts are listed separately.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')
const MEETING_SKILL_MD = readFileSync(join(APP_SKILLS_DIR, 'meeting-protocol', 'SKILL.md'), 'utf8')

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-meeting-')), 'test.sqlite'))
}

function deps(): { appSkillsDir: string; userSkillsDir: string } {
  return {
    appSkillsDir: APP_SKILLS_DIR,
    userSkillsDir: join(mkdtempSync(join(tmpdir(), 'hilbertraum-meeting-user-')), 'user-skills')
  }
}

describe('meeting-protocol — committed SKILL.md is a Tier-1 instruction skill', () => {
  it('parses ok with kind:instruction and reserves no tools', () => {
    const parsed = parseSkillMarkdown(MEETING_SKILL_MD)
    expect(parsed.errors).toEqual([])
    expect(parsed.ok).toBe(true)
    const m = parsed.manifest!
    expect(m.id).toBe('meeting-protocol')
    expect(m.kind).toBe('instruction')
    // Instruction skill: never effective tools, never reserves any (no allowedTools declared).
    expect(m.allowedTools).toEqual([])
    expect(m.reservesTools).toBe(false)
    // v1 permission ceiling holds.
    expect(m.permissions.network).toBe('denied')
    expect(m.permissions.documents).toBe('selected_only')
  })

  it('covers English + German triggers, including umlaut singular/plural pairs', () => {
    const kws = parseSkillMarkdown(MEETING_SKILL_MD).manifest!.triggers.keywords
    // English coverage.
    expect(kws).toContain('meeting')
    // German coverage.
    expect(kws).toContain('besprechung')
    expect(kws).toContain('protokoll')
    // The umlaut breaks the substring match, so singular AND plural must both be listed.
    expect(kws).toContain('beschluss')
    expect(kws).toContain('beschlüsse')
    expect(kws).toContain('aufgabe')
    expect(kws).toContain('aufgaben')
  })
})

describe('meeting-protocol — discovery + reconcile (S3)', () => {
  it('discovers and reconciles the committed app skill as enabled', () => {
    const db = freshDb()
    const d = deps()
    const res = reconcileSkills(db, d)
    expect(res.errors).toEqual([])

    const installId = skillInstallId('app', 'meeting-protocol')
    const record = getSkill(db, installId)
    expect(record, 'meeting-protocol must be discovered from app-skills/').not.toBeNull()
    expect(record!.enabled).toBe(true)
    expect(record!.source).toBe('app')
    expect(record!.trustedLevel).toBe('app')
    expect(record!.kind).toBe('instruction')
    expect(record!.manifest.allowedTools).toEqual([])
    expect(record!.manifest.reservesTools).toBe(false)
  })
})

describe('meeting-protocol — reaches the prompt (S6/S7 fence path)', () => {
  it('resolves the turn skill and injects its body, guard line last', () => {
    const db = freshDb()
    const d = deps()
    reconcileSkills(db, d)
    const installId = skillInstallId('app', 'meeting-protocol')

    const turn = resolveTurnSkill(db, d, 'conv-1', installId)
    expect(turn, 'the bundled skill must resolve for a turn').not.toBeNull()
    expect(turn!.installId).toBe(installId)

    const fence = buildSkillFence({ title: turn!.title, body: turn!.body })
    expect(fence.omitted).toBe(false)
    const prompt = composeSystemPromptWithSkill('BASE PREAMBLE.', fence.text)

    expect(prompt).toContain('BASE PREAMBLE.')
    expect(prompt).toContain('Separate what was decided from what was merely discussed')
    expect(prompt).toContain(SKILL_GUARD_LINE)
    // The guard always wins: it is the very last line of the assembled prompt.
    expect(prompt.trimEnd().endsWith(SKILL_GUARD_LINE)).toBe(true)
  })
})
