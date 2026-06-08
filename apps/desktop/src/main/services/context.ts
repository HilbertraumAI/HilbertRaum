import type { Db } from './db'
import type { ResolvedPaths } from './workspace'

// Shared application context assembled at startup and passed to IPC handlers.
// As later phases land, add: runtime, models registry, ingestion queue, etc.
export interface AppContext {
  paths: ResolvedPaths
  db: Db
}
