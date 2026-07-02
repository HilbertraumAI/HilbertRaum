import { describe, it, expect } from 'vitest'
import {
  de,
  en,
  resolveUiLanguage,
  t,
  tCount,
  type MessageKey
} from '../../src/shared/i18n'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

// Phase 39 — the shared i18n module (i18n record §3.1, D-L1/D-L2/D-L8): synchronous
// lookup, {name} interpolation, .one/.other plurals, English fallback, and the
// 'system' → locale resolution the setting + the pre-unlock gate both use.

describe('t — lookup and interpolation', () => {
  it('looks up plain keys per language', () => {
    // Rail labels are now plain words — no soft hyphens (Task A: the rail never breaks a label
    // mid-word; the grid column is widened to fit instead). See the rail-labels guard below.
    expect(t('en', 'nav.documents')).toBe('Documents')
    expect(t('de', 'nav.documents')).toBe('Dokumente')
    expect(t('en', 'gate.unlock.title')).toBe('Unlock your workspace')
    expect(t('de', 'gate.unlock.title')).toBe('Arbeitsbereich entsperren')
  })

  it('interpolates {name} params in both languages', () => {
    expect(t('en', 'home.docsReady.other', { count: 3 })).toBe(
      '3 documents ready to ask about'
    )
    expect(t('de', 'home.docsReady.other', { count: 3 })).toBe(
      '3 Dokumente bereit für deine Fragen'
    )
  })

  it('falls back to the raw key for an unknown key (runtime guard; typecheck prevents real ones)', () => {
    expect(t('en', 'no.such.key' as MessageKey)).toBe('no.such.key')
    expect(t('de', 'no.such.key' as MessageKey)).toBe('no.such.key')
  })

  it('falls back to the English string when a param is missing in a non-English render', () => {
    // The unresolved placeholder stays literal — visible in dev, never a crash.
    expect(t('de', 'home.docsReady.other')).toBe('{count} documents ready to ask about')
  })

  it('U1/ux-10: the extract coverage badge is softened from "Every match found" (overclaim) to "Read"', () => {
    // "Every match found" asserted the EXTRACTION was exhaustive — a small model / unusual layout can miss
    // a match. The honest claim is that every section was READ, not that every match was captured.
    for (const key of ['coverage.extract.whole', 'coverage.extract.sections'] as MessageKey[]) {
      expect(t('en', key)).not.toMatch(/every match/i)
      expect(t('en', key, { scanned: 3 })).toMatch(/read/i)
      expect(t('de', key)).not.toMatch(/jeder treffer/i)
      expect(t('de', key, { scanned: 3 })).toMatch(/gelesen/i)
    }
  })
})

describe('tCount — .one/.other plural pairs (n === 1 rule)', () => {
  it('selects the singular variant only for exactly 1', () => {
    expect(tCount('en', 'home.docsReady', 1)).toBe('1 document ready to ask about')
    expect(tCount('en', 'home.docsReady', 0)).toBe('0 documents ready to ask about')
    expect(tCount('en', 'home.docsReady', 2)).toBe('2 documents ready to ask about')
    expect(tCount('de', 'home.docsReady', 1)).toBe('1 Dokument bereit für deine Fragen')
    expect(tCount('de', 'home.docsReady', 5)).toBe('5 Dokumente bereit für deine Fragen')
  })
})

describe('resolveUiLanguage (D-L2)', () => {
  it('an explicit choice always wins over the OS locale', () => {
    expect(resolveUiLanguage('en', 'de-DE')).toBe('en')
    expect(resolveUiLanguage('de', 'en-US')).toBe('de')
  })

  it("'system' resolves de-prefixed locales to German, everything else to English", () => {
    expect(resolveUiLanguage('system', 'de')).toBe('de')
    expect(resolveUiLanguage('system', 'de-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'de-AT')).toBe('de')
    expect(resolveUiLanguage('system', 'de_CH')).toBe('de')
    expect(resolveUiLanguage('system', 'DE-DE')).toBe('de')
    expect(resolveUiLanguage('system', 'en-US')).toBe('en')
    expect(resolveUiLanguage('system', 'fr-FR')).toBe('en')
    // A locale merely STARTING with the letters 'de' is not German.
    expect(resolveUiLanguage('system', 'dv')).toBe('en')
  })

  it('tolerates a missing/empty locale (→ English)', () => {
    expect(resolveUiLanguage('system', '')).toBe('en')
    expect(resolveUiLanguage('system', null)).toBe('en')
    expect(resolveUiLanguage('system', undefined)).toBe('en')
  })

  it("the shipped default ('system') resolves to English on this EN dev/CI machine", () => {
    // The whole existing suite asserts English copy (D-L8); this pins the assumption.
    expect(DEFAULT_SETTINGS.uiLanguage).toBe('system')
    expect(resolveUiLanguage(DEFAULT_SETTINGS.uiLanguage, 'en-US')).toBe('en')
  })
})

describe('catalog hygiene (parity is otherwise enforced by typecheck)', () => {
  it('both catalogs carry the same keys with no empty values', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries({ ...en, ...de })) {
      expect(value.trim().length, `empty value for ${key}`).toBeGreaterThan(0)
    }
  })

  it('placeholder sets match per key (a {name} in English exists in German too)', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(placeholders(de[key]), `placeholder mismatch in ${key}`).toEqual(
        placeholders(en[key])
      )
    }
  })

  it('every .one plural key has its .other partner and vice versa (tCount contract)', () => {
    // Key parity is asserted above, so checking the English key set covers both catalogs.
    // A trailing ".other" alone is not proof of a plural ('models.section.other' is a
    // section name) — a plural variant is one that interpolates {count}.
    const keys = new Set(Object.keys(en) as MessageKey[])
    for (const key of keys) {
      if (key.endsWith('.one')) {
        expect(keys.has(`${key.slice(0, -4)}.other` as MessageKey), `missing .other for ${key}`).toBe(true)
      } else if (key.endsWith('.other') && en[key].includes('{count}')) {
        expect(keys.has(`${key.slice(0, -6)}.one` as MessageKey), `missing .one for ${key}`).toBe(true)
      }
    }
  })
})
