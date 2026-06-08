import type { Db } from './db'
import type { ResolvedPaths } from './workspace'
import type { RuntimeManager } from './runtime'

// Shared application context assembled at startup and passed to IPC handlers.
// As later phases land, add: models registry, ingestion queue, etc.
export interface AppContext {
  paths: ResolvedPaths
  db: Db
  runtime: RuntimeManager
  /** Directory holding model-manifests, or null if it could not be located. */
  manifestsDir: string | null
}
