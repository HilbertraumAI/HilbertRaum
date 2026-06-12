import type { Db } from './db'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types'

// Settings persistence on top of the key/value `settings` table (spec §8).
// Each AppSettings field is stored as its own row so partial updates are clean.
// The table lives inside the workspace database, so on an encrypted workspace the
// settings are encrypted at rest and unreadable before unlock.

export function getSettings(db: Db): AppSettings {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as Array<{
    key: string
    value_json: string
  }>
  const stored: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value_json)
    } catch {
      /* ignore malformed rows */
    }
  }
  // Merge stored values over defaults so new fields always have a value.
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings>) }
}

export function updateSettings(db: Db, patch: Partial<AppSettings>): AppSettings {
  const now = new Date().toISOString()
  const upsert = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    // The patch crosses the IPC boundary from the renderer: persist only KNOWN settings
    // keys, and only when the value's primitive type matches the default's (nullable
    // fields accept null). Unknown/mistyped entries are dropped.
    if (!(key in DEFAULT_SETTINGS)) continue
    const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]
    if (def !== null && value !== null && typeof value !== typeof def) continue
    // Enum-valued keys get an exact-value check (a renderer bug must not persist junk
    // like `gpuMode: 'banana'` — readers treat anything !== 'auto' as off, which fails
    // safe, but junk must not be stored either).
    if (key === 'gpuMode' && value !== 'auto' && value !== 'off') continue
    if (key === 'theme' && value !== 'system' && value !== 'light' && value !== 'dark') continue
    if (key === 'uiLanguage' && value !== 'system' && value !== 'en' && value !== 'de') continue
    upsert.run(key, JSON.stringify(value), now)
  }
  return getSettings(db)
}

/** Seed defaults on first run (writes only when the table is empty; keys added in
 *  later versions are filled at read time by `getSettings`'s defaults merge). */
export function seedSettings(db: Db): AppSettings {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }
  if (existing.n === 0) {
    return updateSettings(db, DEFAULT_SETTINGS)
  }
  return getSettings(db)
}
