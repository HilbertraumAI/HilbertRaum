import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'

// Skills — the SECOND bundled app skill: meeting-protocol. Pins the bilingual trigger keywords: German
// plurals with umlauts are listed separately from the singular. (Parse, discovery, tool-reservation and the
// fence path are covered for every bundled skill by skills-professional-documents / skills-skillmd-parity.)

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')
const MEETING_SKILL_MD = readFileSync(join(APP_SKILLS_DIR, 'meeting-protocol', 'SKILL.md'), 'utf8')

describe('meeting-protocol — committed SKILL.md trigger keywords', () => {
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
