import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, listTables } from '../../src/main/services/db'
import { seedSettings, getSettings, updateSettings } from '../../src/main/services/settings'

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'paid-db-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

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

  it('is idempotent (re-opening does not throw)', () => {
    const db = freshDb()
    expect(() => listTables(db)).not.toThrow()
  })
})

describe('settings persistence', () => {
  it('seeds offline-first defaults', () => {
    const db = freshDb()
    const seeded = seedSettings(db)
    expect(seeded.allowNetwork).toBe(false)
    expect(seeded.workspaceMode).toBe('plaintext_dev')
  })

  it('round-trips partial updates and merges with defaults', () => {
    const db = freshDb()
    seedSettings(db)
    const updated = updateSettings(db, { allowNetwork: true, activeModelId: 'qwen3-4b-instruct-q4' })
    expect(updated.allowNetwork).toBe(true)
    expect(updated.activeModelId).toBe('qwen3-4b-instruct-q4')
    // Re-read from a fresh getSettings to confirm persistence.
    const reread = getSettings(db)
    expect(reread.activeModelId).toBe('qwen3-4b-instruct-q4')
    expect(reread.contextTokens).toBe(4096) // default preserved
  })

  it('theme defaults to system, accepts the enum, and drops junk values (Phase 23)', () => {
    const db = freshDb()
    seedSettings(db)
    expect(getSettings(db).theme).toBe('system')
    expect(updateSettings(db, { theme: 'dark' }).theme).toBe('dark')
    expect(updateSettings(db, { theme: 'light' }).theme).toBe('light')
    // Junk from a buggy/hostile renderer is never persisted (same guard as gpuMode).
    expect(updateSettings(db, { theme: 'banana' as never }).theme).toBe('light')
    expect(updateSettings(db, { theme: 'system' }).theme).toBe('system')
  })

  it('uiLanguage defaults to system, accepts the enum, and drops junk values (Phase 39)', () => {
    const db = freshDb()
    seedSettings(db)
    expect(getSettings(db).uiLanguage).toBe('system')
    expect(updateSettings(db, { uiLanguage: 'de' }).uiLanguage).toBe('de')
    expect(updateSettings(db, { uiLanguage: 'en' }).uiLanguage).toBe('en')
    // Junk from a buggy/hostile renderer is never persisted (same guard as theme/gpuMode).
    expect(updateSettings(db, { uiLanguage: 'fr' as never }).uiLanguage).toBe('en')
    expect(updateSettings(db, { uiLanguage: 'system' }).uiLanguage).toBe('system')
  })
})
