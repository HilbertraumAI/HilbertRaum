import type { Db } from './db'
import type { ResolvedPaths } from './workspace'
import type { WorkspaceController } from './workspace-vault'
import type { RuntimeManager } from './runtime'
import type { Embedder } from './embeddings'

// Shared application context assembled at startup and passed to IPC handlers.
// As later phases land, add: models registry, ingestion queue, etc.
export interface AppContext {
  paths: ResolvedPaths
  /**
   * The live workspace database. Backed by a getter over `workspace` (Phase 9): in
   * `plaintext_dev` mode it is open from startup; in `encrypted` mode it throws until
   * the vault is unlocked. Handlers read it at call time, so it tracks unlock/lock.
   */
  db: Db
  /** Owns the workspace lock/unlock lifecycle (Phase 9). */
  workspace: WorkspaceController
  runtime: RuntimeManager
  /** Embedder used for document ingestion + retrieval (mock now, real in Phase 10). */
  embedder: Embedder
  /** Directory holding model-manifests, or null if it could not be located. */
  manifestsDir: string | null
}
