import type { Db } from './db'
import type { ResolvedPaths } from './workspace'
import type { RuntimeManager } from './runtime'
import type { Embedder } from './embeddings'

// Shared application context assembled at startup and passed to IPC handlers.
// As later phases land, add: models registry, ingestion queue, etc.
export interface AppContext {
  paths: ResolvedPaths
  db: Db
  runtime: RuntimeManager
  /** Embedder used for document ingestion + retrieval (mock now, real in Phase 10). */
  embedder: Embedder
  /** Directory holding model-manifests, or null if it could not be located. */
  manifestsDir: string | null
}
