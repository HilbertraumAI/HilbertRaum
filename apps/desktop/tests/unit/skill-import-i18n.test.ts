import { describe, it, expect } from 'vitest'
import {
  IMPORT_ERROR_KEY,
  IMPORT_NOTE_KEY,
  importErrorKeyForMessage,
  localizeSkillNote
} from '../../src/renderer/lib/skillImportI18n'
import { SKILL_IMPORT_ERRORS } from '../../src/main/services/skills/installer'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { SkillNoteRef } from '../../src/shared/types'

// SKA-33 + SKA-35 (skills audit 2026-07-03, U7) — the renderer-side localization plumbing for
// skill import errors and preview notes (lib/skillImportI18n.ts).

describe('IMPORT_ERROR_KEY ⇔ SKILL_IMPORT_ERRORS parity (the matcher contract)', () => {
  it('every installer error code has a copy key, and the EN copy is byte-identical', () => {
    // The SKA-33 matcher finds the structural English string INSIDE the wrapped IPC message by
    // matching the EN catalog. That only works while catalog EN ≡ the installer constant — pin it.
    for (const [code, message] of Object.entries(SKILL_IMPORT_ERRORS)) {
      const key = IMPORT_ERROR_KEY[code]
      expect(key, `missing copy key for installer error code '${code}'`).toBeDefined()
      expect(t('en', key)).toBe(message)
      // And the German copy exists (differs from the key itself — i.e. it is actually translated).
      expect(t('de', key)).not.toBe(key)
    }
  })

  it('has no stale copy keys for codes the installer no longer throws', () => {
    for (const code of Object.keys(IMPORT_ERROR_KEY)) {
      expect(
        (SKILL_IMPORT_ERRORS as Record<string, string>)[code],
        `IMPORT_ERROR_KEY has '${code}' but the installer does not`
      ).toBeDefined()
    }
  })
})

describe('importErrorKeyForMessage (SKA-33 — the wrapped-IPC-message mapper)', () => {
  it('maps the raw structural message AND the Electron-wrapped form to the same key', () => {
    const raw = SKILL_IMPORT_ERRORS.downgradeBlocked
    const wrapped = `Error invoking remote method 'skills:import': Error: ${raw}`
    expect(importErrorKeyForMessage(raw)).toBe('skills.import.error.downgradeBlocked')
    expect(importErrorKeyForMessage(wrapped)).toBe('skills.import.error.downgradeBlocked')
  })

  it('resolves the substring-shaped pair (tooLarge ⊂ fileTooLarge) to the right key each way', () => {
    expect(importErrorKeyForMessage(`x: ${SKILL_IMPORT_ERRORS.tooLarge}`)).toBe('skills.import.error.tooLarge')
    expect(importErrorKeyForMessage(`x: ${SKILL_IMPORT_ERRORS.fileTooLarge}`)).toBe(
      'skills.import.error.fileTooLarge'
    )
  })

  it('returns null for an unknown message (→ the generic failed toast)', () => {
    expect(importErrorKeyForMessage('Something else entirely')).toBeNull()
    expect(importErrorKeyForMessage('')).toBeNull()
  })
})

describe('localizeSkillNote (SKA-35 — note code → localized copy)', () => {
  const tEn = (key: MessageKey, params?: MessageParams): string => t('en', key, params)
  const tDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)

  it('localizes a coded note in both languages, interpolating app-fixed params', () => {
    const ref: SkillNoteRef = { code: 'permissionClamped', params: { field: 'documents', value: 'selected_only' } }
    expect(localizeSkillNote(tEn, 'structural fallback', ref)).toContain('"documents"')
    expect(localizeSkillNote(tDe, 'structural fallback', ref)).toContain('Zugriff')
    expect(localizeSkillNote(tDe, 'structural fallback', ref)).toContain('selected_only')
  })

  it('falls back to the structural string for a missing or unknown code', () => {
    expect(localizeSkillNote(tDe, 'the structural english note')).toBe('the structural english note')
    // A future main may emit codes this renderer doesn't know — they must fall back, not crash.
    expect(localizeSkillNote(tDe, 'fallback', { code: 'someFutureCode' } as unknown as SkillNoteRef)).toBe('fallback')
  })

  it('every mapped note code resolves to real EN + DE copy (no dead keys)', () => {
    const params = { field: 'triggers.keywords', max: 16, value: 'denied' }
    for (const key of Object.values(IMPORT_NOTE_KEY)) {
      expect(t('en', key, params)).not.toBe(key)
      expect(t('de', key, params)).not.toBe(key)
      // No unresolved placeholders left with the superset params supplied.
      expect(t('en', key, params)).not.toMatch(/\{\w+\}/)
      expect(t('de', key, params)).not.toMatch(/\{\w+\}/)
    }
  })
})
