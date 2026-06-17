import { describe, it, expect } from 'vitest'
import {
  localizedSkillTitle,
  localizedSkillDescription,
  skillTitleResolver,
  type LocalizableSkill
} from '../../src/renderer/lib/skillI18n'
import type { SkillInfo } from '../../src/shared/types'

// Display-only per-locale picking for a skill's title/description (architecture.md "Skills" §16).
// The renderer shows a locale's override when present, falling back to the canonical text — and the
// per-message glyph resolver maps installId → localized title with a stamped-title fallback.

const bank: LocalizableSkill = {
  title: 'Bank Statement Analysis',
  description: 'Use when the user wants to reconcile a bank statement.',
  localized: {
    de: { title: 'Kontoauszug-Analyse', description: 'Verwenden zum Abgleich eines Kontoauszugs.' }
  }
}

describe('localizedSkillTitle / localizedSkillDescription', () => {
  it('returns the locale override when present', () => {
    expect(localizedSkillTitle(bank, 'de')).toBe('Kontoauszug-Analyse')
    expect(localizedSkillDescription(bank, 'de')).toBe('Verwenden zum Abgleich eines Kontoauszugs.')
  })

  it('falls back to the canonical text for a locale with no override', () => {
    expect(localizedSkillTitle(bank, 'en')).toBe('Bank Statement Analysis')
    expect(localizedSkillDescription(bank, 'en')).toBe('Use when the user wants to reconcile a bank statement.')
  })

  it('falls back when there is no localized block at all', () => {
    const plain: LocalizableSkill = { title: 'Plain', description: 'No overrides here.' }
    expect(localizedSkillTitle(plain, 'de')).toBe('Plain')
    expect(localizedSkillDescription(plain, 'de')).toBe('No overrides here.')
  })

  it('falls back when an override exists but the requested field is blank/absent', () => {
    const titleOnly: LocalizableSkill = {
      title: 'Title EN',
      description: 'Desc EN',
      localized: { de: { title: 'Titel DE' } } // no German description
    }
    expect(localizedSkillTitle(titleOnly, 'de')).toBe('Titel DE')
    expect(localizedSkillDescription(titleOnly, 'de')).toBe('Desc EN') // falls back
  })

  it('tolerates a missing description (returns empty string)', () => {
    const noDesc: LocalizableSkill = { title: 'T' }
    expect(localizedSkillDescription(noDesc, 'de')).toBe('')
  })
})

describe('skillTitleResolver (per-message glyph)', () => {
  const skills = [
    { installId: 'app:bank-statement', title: 'Bank Statement Analysis', localized: { de: { title: 'Kontoauszug-Analyse' } } },
    { installId: 'app:invoice', title: 'Invoice Analysis' }
  ] as unknown as SkillInfo[]

  it('resolves a loaded skill to its localized title', () => {
    const resolve = skillTitleResolver(skills, 'de')
    expect(resolve('app:bank-statement', 'Bank Statement Analysis')).toBe('Kontoauszug-Analyse')
  })

  it('falls back to the canonical title for a loaded skill with no override', () => {
    const resolve = skillTitleResolver(skills, 'de')
    expect(resolve('app:invoice', 'Invoice Analysis')).toBe('Invoice Analysis')
  })

  it('falls back to the stamped title when the skill is not loaded (e.g. later disabled)', () => {
    const resolve = skillTitleResolver(skills, 'de')
    expect(resolve('app:gone', 'Stamped Title')).toBe('Stamped Title')
    expect(resolve(null, 'Stamped Title')).toBe('Stamped Title')
  })
})
