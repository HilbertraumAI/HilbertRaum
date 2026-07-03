import { describe, it, expect } from 'vitest'
import {
  localizedSkillTitle,
  localizedSkillDescription,
  skillTitleResolver,
  type LocalizableSkill
} from '../../src/renderer/lib/skillI18n'
import { de, type MessageKey } from '../../src/shared/i18n'
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

// U5 (audit ux-12): German assistant-voice skill strings address the user with the informal DU, not
// the formal Sie (plan §0). This lint-ish guard flags a Sie/Ihr regression in the assistant-voice
// namespaces — the deterministic analysis answers (`skills.*Analysis.*`) and the routing/redaction
// answers (`skills.analysis.*` / `skills.redactionRouting.*`). It matches formal-address markers
// only (the polite pronoun `Ihnen` / possessive `Ihre…`, and the "verb-en Sie" imperative shape),
// so a sentence-start pronoun "Sie" (e.g. "Sie läuft vollständig auf diesem Gerät" — *it* runs) is
// correctly NOT flagged. Runs against the German catalog directly (the source of truth for `de`).
describe('du/Sie consistency — assistant-voice skill strings use du (ux-12 guard)', () => {
  // Formal-you markers: the polite dative `Ihnen`; the polite possessive in EVERY form — bare `Ihr`
  // (masc/neut nom+acc, e.g. "Ihr Konto/Saldo") plus the declined `Ihre/Ihren/Ihrem/Ihrer/Ihres`; and
  // a polite `Sie` that appears MID-CLAUSE — i.e. immediately after a lowercase letter ("prüfen Sie",
  // "nutzen Sie", "für Sie", "damit Sie"). A PRONOUN "Sie" (she/it/they) is only ever capitalized at a
  // sentence start, where it is preceded by ". " (not a lowercase letter), so "Sie läuft"/"Sie
  // verarbeitet"/"Sie ergänzen" are correctly NOT flagged.
  const FORMAL_YOU = /\bIhnen\b|\bIhr(?:e[nmrs]?)?\b|[a-zäöüß] Sie\b/
  const ASSISTANT_VOICE = /^skills\.(bankAnalysis|invoiceAnalysis|analysis|redactionRouting)\./

  const scoped = (Object.keys(de) as MessageKey[]).filter((k) => ASSISTANT_VOICE.test(k))

  it('covers the analysis + routing/redaction answer namespaces (guard is not vacuously empty)', () => {
    expect(scoped.length).toBeGreaterThan(20)
  })

  it('no assistant-voice skill string addresses the user with the formal Sie/Ihr', () => {
    const offenders = scoped.filter((k) => FORMAL_YOU.test(de[k]))
    expect(offenders, `formal Sie/Ihr in: ${offenders.join(', ')}`).toEqual([])
  })

  it('the guard would catch a formal-Sie regression (proves it is not a no-op)', () => {
    expect(FORMAL_YOU.test('bitte prüfen Sie die Zahlen selbst')).toBe(true) // imperative
    expect(FORMAL_YOU.test('nutzen Sie die Schaltfläche')).toBe(true)
    expect(FORMAL_YOU.test('Damit ich Ihnen keine falsche Summe nenne')).toBe(true) // dative
    expect(FORMAL_YOU.test('versteh sie als Ihr Auszugssaldo')).toBe(true) // bare possessive Ihr <noun>
    expect(FORMAL_YOU.test('Ihre Zahlen sind hier')).toBe(true) // declined possessive
    expect(FORMAL_YOU.test('den Auszug für Sie erstellt')).toBe(true) // prepositional accusative
    // …but tolerates a sentence-start pronoun "Sie" (it/she/they) — the redaction routing copy relies on it.
    expect(FORMAL_YOU.test('Sie läuft vollständig auf diesem Gerät')).toBe(false)
    expect(FORMAL_YOU.test('Sie verarbeitet jeweils ein Dokument')).toBe(false)
    expect(FORMAL_YOU.test('Skills ergänzen Antworten; sie greifen nie zu')).toBe(false) // lowercase pronoun
  })
})
