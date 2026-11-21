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
import { developerLeniency } from '../policy'
import { resolveLlamaServerPath } from '../runtime/sidecar'

// Vision availability detection (image-understanding plan §10). Pure-ish + cheap: no hashing
// on the hot path (lazy `skipHash`, reusing the checksum cache). WORKSPACE-AGNOSTIC (PROD-2):
// status does NOT fail on lock and there is NO `'locked'` reason — vision weights aren't
// encrypted, so status can read `available:true` while the screen shows its locked posture.
//
// Order of checks (plan §10; the pick since #890):
//   1. no `llama-server` binary resolvable      → `no-runtime`
//   2. the candidates (`visionCandidates`: the vision manifests this engine can load with GGUF AND
//      mmproj on the drive, the pick first) in that order; the first that `computeInstallState` (with
//      `skipHash`, which hashes nothing: a placeholder hash outside developer mode or a cached
//      checksum mismatch on either file fails it, a present file with a real hash and no cache entry
//      passes unhashed) calls `installed` → `available` + its modelId/modelDisplayName
//   3. none → `damaged` (#913) when a candidate failed that check (the copy points back to the AI
//      Model screen), else `incompatible` ("needs a newer engine") when a vision manifest needs a
//      runtime/format this engine cannot load, else `no-model`
// The developer leniency is the policy-aware one every role uses (`developerLeniency`, #913 S-913-4).

/**
 * #890: the vision models the images service may run, in the order it tries them: the ones whose files are all on
 * the drive (`manifestFilesPresent`), the one rule every role uses (`pickManifestForRole`: flagged
 * `default_for_role`, else the first in walk order) first, then the rest in walk order. Synchronous (presence only,
 * no hashing). `manifests` may hold every role; only vision counts.
 */
export function visionCandidates(manifests: readonly ModelManifest[], rootPath: string): ModelManifest[] {
  const present = manifests.filter((m) => m.role === 'vision' && manifestFilesPresent(rootPath, m))
  const pick = pickManifestForRole(present, 'vision')
  return pick ? [pick, ...present.filter((m) => m !== pick)] : []
}

/**
 * #890: the first candidate: the images model `getVisionStatus` runs whenever it verifies. A preferred model whose
 * files are present but fail their check is passed over there for the next candidate (the AI Model screen shows the
 * damaged file). #933: the Performance row passes over it too, from the checksum cache (`knownFileVerdict` over
 * `visionCandidates`), and falls back to this pick only when no candidate passes.
 */
export function pickVisionManifest(manifests: readonly ModelManifest[], rootPath: string): ModelManifest | undefined {
  return visionCandidates(manifests, rootPath)[0]
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

  // The candidates in order: the pick first, then the next one when the pick fails verification, so
  // Images never goes dark while another vision model on the drive would run (master's walk did that too).
  const candidates = visionCandidates(visionManifests, ctx.paths.rootPath)
  let sawDamaged = false
  if (candidates.length > 0) {
    // Lock-safe developer-mode + hash store: a locked DB can't be read, so fall back to the
    // build's `isDev`; the hash store is lock-aware itself (getter-based, degrades to a cache
    // miss while locked — BE-2, full-audit 2026-07-10), so status stays workspace-agnostic.
    // The drive policy can still say no (#913, S-913-4: before, a commercial drive's policy did
    // not count here, while the chat start gate refused the same file).
    const unlocked = ctx.workspace.isUnlocked()
    const developerMode = developerLeniency(ctx, ctx.isDev || (unlocked && getSettings(ctx.db).developerMode))
    const hashStore = createSettingsHashStore(() => ctx.db, ctx.paths.rootPath)
    for (const m of candidates) {
      // `skipHash: true` — display-only on the hot path; a verified cache hit is still honoured.
      const state = await computeInstallState(m, ctx.paths.rootPath, { developerMode, hashStore, skipHash: true })
      if (state === 'installed' || state === 'running') {
        return { available: true, modelId: m.id, modelDisplayName: m.displayName }
      }
      if (state === 'checksum_failed') sawDamaged = true
    }
  }
  // #913: a model on the drive that failed its check ⇒ damaged (download it again); else unloadable by
  // this engine (newer arch) ⇒ incompatible; otherwise ⇒ no-model.
  if (sawDamaged) return { available: false, reason: 'damaged' }
  const sawUnsupported = visionManifests.some((m) => !isSupportedRuntimeFormat(m.runtime, m.format))
  return { available: false, reason: sawUnsupported ? 'incompatible' : 'no-model' }
}
