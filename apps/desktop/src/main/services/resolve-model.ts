import { discoverManifests, weightPath, type DiscoveredManifest } from './models'
import type { ModelRole } from '../../shared/manifest'

// M-A3 (audit-2026-06-13): the embeddings / reranker / transcriber resolvers in index.ts
// were three copy-paste bodies differing only by the role string (and whether they carried
// `contextTokens`). One manifest-driven, pre-unlock-safe resolver replaces all three.
//
// Settings live inside the (possibly encrypted) DB and are unreadable before unlock, so
// these resolve the manifest's DEFAULT model for the role rather than the active-model id.

/** A model located on the drive: id + GGUF/GGML weight path (+ optional context window). */
export interface ResolvedModel {
  id: string
  modelPath: string
  /** The manifest's recommended context window; omitted for roles that don't use it. */
  contextTokens?: number
}

/**
 * Resolve the default model for `role` from the manifests: id + weight path (+
 * `contextTokens` for the roles that need it). Returns null when no manifest dir is known
 * or no manifest for the role exists (→ the role's selector falls back to mock/null).
 * Never throws — a malformed manifest dir reads as "no model".
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
    const found = manifests.find((m) => m.manifest.role === role)
    if (!found) return null
    const resolved: ResolvedModel = {
      id: found.manifest.id,
      modelPath: weightPath(rootPath, found.manifest)
    }
    // The transcriber's WhisperCliTranscriber takes no context window; embeddings + the
    // reranker do, so only attach it when the caller asks.
    if (opts.includeContextTokens !== false) {
      resolved.contextTokens = found.manifest.recommendedContextTokens
    }
    return resolved
  } catch {
    return null
  }
}
