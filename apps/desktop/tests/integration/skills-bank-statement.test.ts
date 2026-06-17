import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  reconcileSkills,
  getSkill,
  listSkills,
  skillInstallId
} from '../../src/main/services/skills/registry'
import { resolveTurnSkill } from '../../src/main/services/skills/turn'
import { recordToInfo } from '../../src/main/services/skills/installer'
import {
  buildSkillFence,
  composeSystemPromptWithSkill,
  SKILL_GUARD_LINE
} from '../../src/main/services/skills/prompt'

// Skills plan Phase S9 — the built-in bank-statement instruction stub. This is the FIRST real
// app skill, so it exercises the whole S2→S7 path end-to-end against the COMMITTED package:
// discover (S2/S3) → reconcile-enabled (S3) → resolveTurnSkill (S6) → fence into a prompt (S7).
// It also pins the §22-D1 "stub honesty" contract on the committed SKILL.md and asserts the
// commercial-drive gate (S9 / §14) is mirrored in BOTH provisioning scripts.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')
const BANK_SKILL_MD = readFileSync(join(APP_SKILLS_DIR, 'bank-statement', 'SKILL.md'), 'utf8')

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-s9-')), 'test.sqlite'))
}

function deps(): { appSkillsDir: string; userSkillsDir: string } {
  return {
    appSkillsDir: APP_SKILLS_DIR,
    userSkillsDir: join(mkdtempSync(join(tmpdir(), 'hilbertraum-s9-user-')), 'user-skills')
  }
}

describe('S9 — bundled bank-statement skill: discovery + reconcile', () => {
  it('discovers and reconciles the committed app skill as enabled', () => {
    const db = freshDb()
    const d = deps()
    const res = reconcileSkills(db, d)
    expect(res.errors).toEqual([])

    const installId = skillInstallId('app', 'bank-statement')
    const record = getSkill(db, installId)
    expect(record, 'bank-statement must be discovered from app-skills/').not.toBeNull()
    // App skills install enabled + pre-acknowledged (DS19 source default).
    expect(record!.enabled).toBe(true)
    expect(record!.source).toBe('app')
    expect(record!.trustedLevel).toBe('app')
    // S11c: the skill is FLIPPED to kind:'tool', which makes its declared allowedTools effective
    // (the SL-1 parser keeps the list only for a tool skill — an instruction skill's stays []).
    expect(record!.kind).toBe('tool')
    expect(record!.manifest.allowedTools).toEqual([
      'extract_transactions',
      'validate_statement_balances',
      'categorize_transactions',
      'summarize_cashflow',
      'export_transactions_csv'
    ])
    expect(record!.manifest.reservesTools).toBe(true)
    expect(recordToInfo(record!, false).reservesTools).toBe(true)
    // v1 permission ceiling: network always denied; documents at most selected_only.
    expect(record!.manifest.permissions.network).toBe('denied')
    expect(record!.manifest.permissions.documents).toBe('selected_only')
    // Triggers make it the first real selector candidate.
    expect(record!.manifest.triggers?.keywords).toContain('bank statement')
    // §16: the committed manifest carries a German DISPLAY override, projected into SkillInfo so the
    // renderer can localize the title/description (the body language is unchanged).
    expect(record!.manifest.localized?.de?.title).toBe('Kontoauszug-Analyse')
    const info = recordToInfo(record!, false)
    expect(info.localized?.de?.title).toBe('Kontoauszug-Analyse')
    expect(info.localized?.de?.description).toMatch(/Kontoauszug/)

    // It is the only app skill committed for now (sanity: discovery isn't picking up junk).
    const appSkills = listSkills(db).filter((s) => s.source === 'app')
    expect(appSkills.map((s) => s.id)).toContain('bank-statement')
  })
})

describe('S9 — bundled bank-statement skill: reaches the prompt (S6/S7 fence path)', () => {
  it('resolves the turn skill and injects its body into a system prompt', () => {
    const db = freshDb()
    const d = deps()
    reconcileSkills(db, d)
    const installId = skillInstallId('app', 'bank-statement')

    // The real S6 resolver, asked for this skill explicitly (requestedInstallId).
    const turn = resolveTurnSkill(db, d, 'conv-1', installId)
    expect(turn, 'the bundled skill must resolve for a turn').not.toBeNull()
    expect(turn!.installId).toBe(installId)

    // The real S7 fence + plain-chat composition.
    const fence = buildSkillFence({ title: turn!.title, body: turn!.body })
    expect(fence.omitted).toBe(false)
    const prompt = composeSystemPromptWithSkill('BASE PREAMBLE.', fence.text)

    // The skill's instructions actually reach the assembled prompt, bracketed by the guard.
    expect(prompt).toContain('BASE PREAMBLE.')
    expect(prompt).toContain("Quote the statement's own printed figures")
    expect(prompt).toContain(SKILL_GUARD_LINE)
  })
})

describe('S11c — the committed body is the reconcile body and stays §22-D1 honest', () => {
  // The body after the frontmatter (what the fence injects).
  const body = BANK_SKILL_MD.split(/\n---\n/).slice(1).join('\n---\n')

  it('carries the Tier-2 reconcile rules (the §6.6 body returns with the tools)', () => {
    expect(body).toMatch(/reconcile/i)
    expect(body).toMatch(/extracted transaction table/i)
    expect(body).toMatch(/uncertain or unreconciled rows/i)
  })

  it('stays honest: app-orchestrated only + never invents a figure (§22-D1)', () => {
    // The tools run only on a user action (DS4) — the body must not imply the model acts alone.
    expect(body).toMatch(/only when the user starts them/i)
    expect(body).toMatch(/do not invent a figure/i)
    expect(body).toMatch(/quote the statement's own printed figures/i)
  })

  it('declares kind: tool in the committed frontmatter (the S11c flip)', () => {
    const frontmatter = BANK_SKILL_MD.split(/\n---\n/)[0]
    expect(frontmatter).toMatch(/^kind:\s*tool\b/m)
  })
})

describe('S9 — commercial-drive gate is mirrored in both provisioning scripts (§22-E4)', () => {
  // The TS gate (assertCommercialDrive) is canonical; the self-contained scripts re-implement
  // it. Both must carry the SAME app-skills-present + user-skills-empty problem strings.
  const ps1 = readFileSync(join(REPO_ROOT, 'scripts', 'build-commercial-drive.ps1'), 'utf8')
  const sh = readFileSync(join(REPO_ROOT, 'scripts', 'build-commercial-drive.sh'), 'utf8')

  it.each([
    ['ps1', () => ps1],
    ['sh', () => sh]
  ])('build-commercial-drive.%s gates app-skills present + user-skills empty', (_label, src) => {
    expect(src()).toContain('no app skills provisioned')
    expect(src()).toContain('user skill present on a drive meant to ship empty')
  })

  it('both prepare-drive scripts copy app-skills onto the drive', () => {
    const prepPs1 = readFileSync(join(REPO_ROOT, 'scripts', 'prepare-drive.ps1'), 'utf8')
    const prepSh = readFileSync(join(REPO_ROOT, 'scripts', 'prepare-drive.sh'), 'utf8')
    expect(prepPs1).toMatch(/app-skills/)
    expect(prepPs1).toMatch(/copied app skills/)
    expect(prepSh).toMatch(/app-skills/)
    expect(prepSh).toMatch(/copied app skills/)
  })
})
