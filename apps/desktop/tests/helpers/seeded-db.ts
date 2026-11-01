import type { Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { openFreshDb } from './db-fixtures'

// Apart from db-fixtures on purpose: loading `services/settings` there would change what the skills suites load.

/** A fresh workspace DB with the default settings seeded. Handle closed by the #460 sweep. */
export function seededFreshDb(label: string): Db {
  const db = openFreshDb(label)
  seedSettings(db)
  return db
}
