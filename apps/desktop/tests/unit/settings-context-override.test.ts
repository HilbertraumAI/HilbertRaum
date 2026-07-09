import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  getSettings,
  MAX_CONTEXT_TOKENS_OVERRIDE,
  updateSettings
} from '../../src/main/services/settings'

// The user context-size override (AI Model screen picker, 2026-07-04 user report): null =
// automatic (the model's recommended window), a number = the next start's --ctx-size. The
// validation must clamp into [tree-builder floor, RAM-safety ceiling] and reject junk — the
// default is null, so the generic type check alone would persist ANY renderer value.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-settings-')), 'test.sqlite'))
}

describe('settings.contextTokensOverride validation', () => {
  it('defaults to null (automatic) and round-trips a preset value', () => {
    const db = freshDb()
    expect(getSettings(db).contextTokensOverride).toBeNull()
    expect(updateSettings(db, { contextTokensOverride: 16384 }).contextTokensOverride).toBe(16384)
    // Back to automatic.
    expect(updateSettings(db, { contextTokensOverride: null }).contextTokensOverride).toBeNull()
  })

  it('clamps below the tree-builder floor UP and above the RAM ceiling DOWN', () => {
    const db = freshDb()
    expect(updateSettings(db, { contextTokensOverride: 512 }).contextTokensOverride).toBe(2048)
    expect(updateSettings(db, { contextTokensOverride: 10_000_000 }).contextTokensOverride).toBe(
      MAX_CONTEXT_TOKENS_OVERRIDE
    )
  })

  it('accepts the large long-document rungs up to 128k unclamped (issue #43: the old 32k cap was a dead end)', () => {
    const db = freshDb()
    // Deep-index / whole-document workflows need >32k on models with big native windows;
    // the ceiling must not silently shrink the UI's own presets.
    expect(MAX_CONTEXT_TOKENS_OVERRIDE).toBe(131_072)
    expect(updateSettings(db, { contextTokensOverride: 65_536 }).contextTokensOverride).toBe(65_536)
    expect(updateSettings(db, { contextTokensOverride: 131_072 }).contextTokensOverride).toBe(131_072)
  })

  it('rejects non-numeric junk instead of persisting it (null default defeats the type check)', () => {
    const db = freshDb()
    updateSettings(db, { contextTokensOverride: 8192 })
    // A hostile/buggy renderer value must neither store nor clobber the existing pick.
    updateSettings(db, { contextTokensOverride: 'banana' as unknown as number })
    expect(getSettings(db).contextTokensOverride).toBe(8192)
    updateSettings(db, { contextTokensOverride: Number.NaN })
    expect(getSettings(db).contextTokensOverride).toBe(8192)
  })
})
