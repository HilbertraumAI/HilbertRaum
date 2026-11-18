import { discoverManifests, manifestFiles, weightPath, type DiscoveredManifest } from './models'
import { pickManifestForRole, type ModelRole } from '../../shared/manifest'

// M-A3 (audit-2026-06-13): the embeddings / reranker / transcriber resolvers in index.ts
// were three copy-paste bodies differing only by the role string (and whether they carried
// `contextTokens`). One manifest-driven, pre-unlock-safe resolver replaces all three.
//
// Settings live inside the (possibly encrypted) DB and are unreadable before unlock, so
// these resolve the manifest's DEFAULT model for the role rather than the active-model id.

/** A model located on the drive: id + GGUF/GGML weight path (+ optional context window). */
export interface ResolvedModel {
  id: string
  /** The PRIMARY weight file — what the sidecar's `--model` receives (a shard set's shard 1). */
  modelPath: string
  /**
   * Every file this model's weight requires, absolute (#310): `modelPath` plus whatever the
   * manifest's `files:` list declares. The availability ladder checks that they ALL exist, so
   * a sidecar-backed role can never report available on a fraction of its weight.
   */
  requiredPaths: string[]
  /** The manifest's recommended context window; omitted for roles that don't use it. */
  contextTokens?: number
}

/**
 * Resolve the default model for `role` from the manifests: id + weight path (+
 * `contextTokens` for the roles that need it). Returns null when no manifest dir is known
 * or no manifest for the role exists (→ the role's selector falls back to mock/null).
 * Never throws — a malformed manifest dir reads as "no model".
 *
 * #848 — WHICH manifest: `pickManifestForRole` (shared/manifest.ts; the Performance rows and the Models-screen ★
 * use the same function). Among the USABLE manifests, the first one flagged `default_for_role: true`, else the
 * first of the role in walk order (`discoverManifests` takes each folder's entry names in code-unit order). The
 * flag keeps the embedder put when a release or a user adds a second embeddings manifest, on every app that
 * shares the drive. A flagged manifest wins whether or not its file is present: a missing default embedder
 * composes the mock, never another installed one, whose vectors would not match the index. But when NO usable
 * manifest of the role is flagged (none ever was, or the flagged one is invalid or for a newer HilbertRaum), the
 * first usable one in walk order IS composed, another embedder included. Hence the frozen constraint: a release
 * never makes the flagged manifest unusable for an older build (no `min_app_version` on it) without flagging a
 * replacement in the same release (model-policy.md). The workspace's `activeEmbeddingModelId` setting does not
 * decide it (settings are unreadable here, and the embedder never swaps mid-session; known-limitations.md).
 */
export function resolveModelByRole(
  manifestsDir: string | null,
  rootPath: string,
  role: ModelRole,
  opts: {
    includeContextTokens?: boolean
    /**
     * Manifests already discovered by the caller's OWN pass (PF-4, full-audit 2026-07-10):
     * `composeServices` walks the dir once and threads the result into all of its role
     * resolutions instead of re-walking + re-parsing YAML per role. Callers that act on a
     * later user action (IPC handlers, `onModelInstalled`) omit it and stay fresh.
     */
    discovered?: DiscoveredManifest[]
  } = {}
): ResolvedModel | null {
  if (!manifestsDir) return null
  try {
    const manifests = opts.discovered ?? discoverManifests(manifestsDir).manifests
    const found = pickManifestForRole(
      manifests.map((m) => m.manifest),
      role
    )
    if (!found) return null
    const resolved: ResolvedModel = {
      id: found.id,
      modelPath: weightPath(rootPath, found),
      requiredPaths: manifestFiles(rootPath, found).map((f) => f.path)
    }
    // The transcriber's WhisperCliTranscriber takes no context window; embeddings + the
    // reranker do, so only attach it when the caller asks.
    if (opts.includeContextTokens !== false) {
      resolved.contextTokens = found.recommendedContextTokens
    }
    return resolved
  } catch {
    return null
  }
}
