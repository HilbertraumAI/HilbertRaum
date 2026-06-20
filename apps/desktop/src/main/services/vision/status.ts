import type { AppContext } from '../context'
import type { VisionStatus } from '../../../shared/types'
import { computeInstallState, createSettingsHashStore, discoverManifests } from '../models'
import { getSettings } from '../settings'
import { resolveLlamaServerPath } from '../runtime/sidecar'

// Vision availability detection (image-understanding plan §10). Pure-ish + cheap: no hashing
// on the hot path (lazy `skipHash`, reusing the checksum cache). WORKSPACE-AGNOSTIC (PROD-2):
// status does NOT fail on lock and there is NO `'locked'` reason — vision weights aren't
// encrypted, so status can read `available:true` while the screen shows its locked posture.
//
// Order of checks (plan §10):
//   1. no `llama-server` binary resolvable      → `no-runtime`
//   2. no `role:vision` manifest installed+verified (GGUF AND mmproj present) → `no-model`
//   3. a vision manifest the current runtime can't load (unsupported runtime/format)
//      → `incompatible` ("needs a newer engine")
//   4. else `available` + modelId/modelDisplayName

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

  // Lock-safe developer-mode + hash store: a locked DB can't be read, so fall back to the
  // build's `isDev` and skip the persistent cache (status stays workspace-agnostic).
  const unlocked = ctx.workspace.isUnlocked()
  const developerMode = ctx.isDev || (unlocked && getSettings(ctx.db).developerMode)
  const hashStore = unlocked ? createSettingsHashStore(ctx.db) : undefined

  let sawUnsupported = false
  for (const manifest of visionManifests) {
    // `skipHash: true` — display-only on the hot path; a verified cache hit is still honoured.
    const state = await computeInstallState(manifest, ctx.paths.rootPath, {
      developerMode,
      hashStore,
      skipHash: true
    })
    if (state === 'installed' || state === 'running') {
      return { available: true, modelId: manifest.id, modelDisplayName: manifest.displayName }
    }
    if (state === 'unsupported') sawUnsupported = true
  }
  // Present-but-unloadable (newer arch) ⇒ incompatible; otherwise missing/checksum_failed ⇒ no-model.
  return { available: false, reason: sawUnsupported ? 'incompatible' : 'no-model' }
}
