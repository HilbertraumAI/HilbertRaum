import { describe, it, expect } from 'vitest'
import { listTables } from '../helpers/db-fixtures'
import { seedSettings, getSettings, updateSettings } from '../../src/main/services/settings'
import { applyUiLanguageSetting, initMainI18n, mainUiLanguage } from '../../src/main/services/i18n'
import { UI_LANGUAGE_CODES } from '../../src/shared/i18n'
import { openFreshDb, rawSetting } from '../helpers/db-fixtures'

/** A deliberately mistyped renderer patch crossing the IPC boundary: a whole-patch cast, not `as never`. */
type JunkPatch = Record<string, unknown>

const freshDb = (): ReturnType<typeof openFreshDb> => openFreshDb('db')

describe('database migration', () => {
  it('creates all spec §8 tables', () => {
    const db = freshDb()
    const tables = listTables(db)
    for (const t of [
      'settings',
      'conversations',
      'messages',
      'documents',
      'chunks',
      'embeddings',
      'runtime_events'
    ]) {
      expect(tables).toContain(t)
    }
  })
})

describe('settings persistence', () => {
  it('seeds the default settings (network permitted by default so downloads work)', () => {
    const db = freshDb()
    const seeded = seedSettings(db)
    expect(seeded.allowNetwork).toBe(true)
    expect(seeded.workspaceMode).toBe('plaintext_dev')
  })

  it('round-trips partial updates and merges with defaults', () => {
    const db = freshDb()
    seedSettings(db)
    const updated = updateSettings(db, { allowNetwork: false, activeModelId: 'qwen3-4b-instruct-q4' })
    expect(updated.allowNetwork).toBe(false)
    expect(updated.activeModelId).toBe('qwen3-4b-instruct-q4')
    // A key with no row (a workspace written before the key existed) reads its default: the
    // seed wrote a row for every key, so drop one to reach the merge.
    db.prepare("DELETE FROM settings WHERE key = 'contextTokens'").run()
    expect(rawSetting(db, 'contextTokens')).toBeUndefined()
    // Re-read from a fresh getSettings to confirm persistence.
    const reread = getSettings(db)
    expect(reread.allowNetwork).toBe(false)
    expect(reread.activeModelId).toBe('qwen3-4b-instruct-q4')
    expect(reread.contextTokens).toBe(4096) // the shipped default, merged in
  })

  it('theme defaults to system, accepts the enum, and drops junk values (Phase 23)', () => {
    const db = freshDb()
    seedSettings(db)
    expect(getSettings(db).theme).toBe('system')
    expect(updateSettings(db, { theme: 'dark' }).theme).toBe('dark')
    expect(updateSettings(db, { theme: 'light' }).theme).toBe('light')
    // Junk from a buggy/hostile renderer is never persisted (same guard as gpuMode).
    expect(updateSettings(db, { theme: 'banana' } as JunkPatch).theme).toBe('light')
    expect(updateSettings(db, { theme: 'system' }).theme).toBe('system')
  })

  it('clamps contextTokens UP to the 2048 floor so the tree-build budget can never starve (HIGH_BUG vuln-scan-2026-06-21)', () => {
    const db = freshDb()
    seedSettings(db)
    // A buggy/hostile renderer patch below the floor is clamped up, not dropped.
    expect(updateSettings(db, { contextTokens: 512 }).contextTokens).toBe(2048)
    expect(updateSettings(db, { contextTokens: 1024 }).contextTokens).toBe(2048)
    expect(getSettings(db).contextTokens).toBe(2048) // persisted clamped
    // A value at/above the floor passes through unchanged.
    expect(updateSettings(db, { contextTokens: 8192 }).contextTokens).toBe(8192)
    // A non-finite value falls back to the floor rather than persisting NaN.
    expect(updateSettings(db, { contextTokens: Number.NaN as number }).contextTokens).toBe(2048)
  })

  it('skillInfoSeen (#46) defaults empty, round-trips ids, and sanitizes junk element-wise', () => {
    const db = freshDb()
    seedSettings(db)
    expect(getSettings(db).skillInfoSeen).toEqual([])
    expect(updateSettings(db, { skillInfoSeen: ['bank-statement', 'document-edit'] }).skillInfoSeen).toEqual([
      'bank-statement',
      'document-edit'
    ])
    // The generic string[] guard: non-string elements are dropped, a non-array is never persisted.
    expect(updateSettings(db, { skillInfoSeen: ['ok', 42, null] } as JunkPatch).skillInfoSeen).toEqual(['ok'])
    expect(updateSettings(db, { skillInfoSeen: 'junk' } as JunkPatch).skillInfoSeen).toEqual(['ok'])
  })

  it('uiLanguage defaults to system, saves every registered language and system, and drops junk (Phase 39)', () => {
    const db = freshDb()
    seedSettings(db)
    expect(getSettings(db).uiLanguage).toBe('system')
    // The write gate follows the registry: a language registered after German is a valid choice.
    const kept = UI_LANGUAGE_CODES.filter((code) => {
      updateSettings(db, { uiLanguage: 'system' })
      return updateSettings(db, { uiLanguage: code }).uiLanguage === code && getSettings(db).uiLanguage === code
    })
    expect(kept).toEqual([...UI_LANGUAGE_CODES])
    // Junk from a buggy/hostile renderer is never persisted (same guard as theme/gpuMode)…
    const last = UI_LANGUAGE_CODES[UI_LANGUAGE_CODES.length - 1]
    expect(updateSettings(db, { uiLanguage: 'xx' } as JunkPatch).uiLanguage).toBe(last)
    // …and 'system' (follow the OS) is a valid choice too.
    expect(updateSettings(db, { uiLanguage: 'system' }).uiLanguage).toBe('system')
  })

  it('a uiLanguage only a newer build knows resolves like system and its row is kept (downgrade on a shared drive)', () => {
    const db = freshDb()
    seedSettings(db)
    // A newer build on the same drive saved a language this build doesn't register. The write
    // gate refuses that value here, so the row is written the way that build wrote it.
    db.prepare("UPDATE settings SET value_json = ? WHERE key = 'uiLanguage'").run(JSON.stringify('xx'))
    try {
      // Once settings are readable, main re-resolves from the stored value (plaintext start,
      // unlock): on a German OS that is German, not English.
      initMainI18n('de-AT')
      applyUiLanguageSetting(getSettings(db).uiLanguage)
      expect(mainUiLanguage()).toBe('de')
    } finally {
      initMainI18n('en-US') // module-global cache: never leak German into this worker
    }
    // Neither the read nor another setting's write drops the row: the newer build still finds
    // the choice.
    updateSettings(db, { theme: 'dark' })
    expect(rawSetting(db, 'uiLanguage')).toBe('xx')
  })
})
