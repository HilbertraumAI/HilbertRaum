import type { AppContext } from '../context'
import type { VisionStatus } from '../../../shared/types'
import { pickManifestForRole, type ModelManifest } from '../../../shared/manifest'
import {
  computeInstallState,
  createSettingsHashStore,
  discoverManifests,
  isSupportedRuntimeFormat,
  manifestFilesPresent
} from '../models'
import { getSettings } from '../settings'
import { resolveLlamaServerPath } from '../runtime/sidecar'

// Vision availability detection (image-understanding plan §10). Pure-ish + cheap: no hashing
// on the hot path (lazy `skipHash`, reusing the checksum cache). WORKSPACE-AGNOSTIC (PROD-2):
// status does NOT fail on lock and there is NO `'locked'` reason — vision weights aren't
// encrypted, so status can read `available:true` while the screen shows its locked posture.
//
// Order of checks (plan §10; the pick since #890):
//   1. no `llama-server` binary resolvable      → `no-runtime`
//   2. no pick (`pickVisionManifest`: no vision manifest this engine can load with GGUF AND mmproj
//      on the drive), or the pick is not `installed` by `computeInstallState` with `skipHash`, which
//      hashes nothing (a placeholder hash outside developer mode or a cached checksum mismatch fails
//      it; a present file with a real hash and no cache entry passes unhashed) → `no-model`, or
//      `incompatible` ("needs a newer engine") when a vision manifest needs a runtime/format this
//      engine cannot load
//   3. else `available` + the pick's modelId/modelDisplayName

/**
 * #890 (G-8 (ii-a)): THE images model, the one rule every role uses (`pickManifestForRole`) applied to the vision
 * manifests whose files are all on the drive (`manifestFilesPresent`): the one flagged `default_for_role`, else the
 * first in walk order. Synchronous (presence only, no hashing), so the Performance screen's row names exactly what
 * `getVisionStatus` judges. `manifests` may hold every role; only vision counts.
 */
export function pickVisionManifest(manifests: readonly ModelManifest[], rootPath: string): ModelManifest | undefined {
  const present = manifests.filter((m) => m.role === 'vision' && manifestFilesPresent(rootPath, m))
  return pickManifestForRole(present, 'vision')
}

export async function getVisionStatus(ctx: AppContext): Promise<VisionStatus> {
  // 1. The vision sidecar uses the SAME on-drive llama-server binary as chat/embeddings.
  const binPath = resolveLlamaServerPath(ctx.paths.rootPath, process.platform, process.env, {
    isDev: ctx.isDev
  })
  if (!binPath) return { available: false, reason: 'no-runtime' }

  if (!ctx.manifestsDir) return { available: false, reason: 'no-model' }
  const { manifests } = discoverManifests(ctx.manifestsDir)
  const visionManifests = manifests.map((m) => m.manifest).filter((m) => m.role === 'vision')
  if (visionManifests.length === 0) return { available: false, reason: 'no-model' }

  // The pick is judged once: a pick that fails verification is not replaced by another vision model
  // (as a damaged flagged embedder composes the mock, never a second embeddings model).
  const pick = pickVisionManifest(visionManifests, ctx.paths.rootPath)
  if (pick) {
    // Lock-safe developer-mode + hash store: a locked DB can't be read, so fall back to the
    // build's `isDev`; the hash store is lock-aware itself (getter-based, degrades to a cache
    // miss while locked — BE-2, full-audit 2026-07-10), so status stays workspace-agnostic.
    const unlocked = ctx.workspace.isUnlocked()
    const developerMode = ctx.isDev || (unlocked && getSettings(ctx.db).developerMode)
    const hashStore = createSettingsHashStore(() => ctx.db, ctx.paths.rootPath)
    // `skipHash: true` — display-only on the hot path; a verified cache hit is still honoured.
    const state = await computeInstallState(pick, ctx.paths.rootPath, { developerMode, hashStore, skipHash: true })
    if (state === 'installed' || state === 'running') {
      return { available: true, modelId: pick.id, modelDisplayName: pick.displayName }
    }
  }
  // Unloadable by this engine (newer arch) ⇒ incompatible; otherwise missing/checksum_failed ⇒ no-model.
  const sawUnsupported = visionManifests.some((m) => !isSupportedRuntimeFormat(m.runtime, m.format))
  return { available: false, reason: sawUnsupported ? 'incompatible' : 'no-model' }
}
