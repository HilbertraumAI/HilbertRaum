import { join } from 'node:path'
import type { EngineBuildStamp } from '../../../shared/types'
import { readRuntimeMarker } from '../assets'
import type { AuditRecorder } from '../audit'
import type { Db } from '../db'
import { log } from '../logging'
import { engineBuildStampOf, updateSettings } from '../settings'
import { llamaServerBinaryName, llamaServerDir, resolveLlamaServerPath } from './sidecar'

/**
 * W-70 (app-update plan, T3.11): which build of the chat engine this app runs from the drive, as a stamp, or null when
 * that is unknown. "Own build" is what `runtime/llama.cpp/<os>/` holds (its install marker's `version` and `backend`,
 * the read of Diagnostics' "runtime build" line), not what the app pins: an older engine nobody updated is still the
 * build that runs. Null when there is no engine (no program in the folder), no marker this app can read (none, one
 * that cannot be read just now, a damaged one), a tag a stamp cannot hold, or (dev only) `HILBERTRAUM_LLAMA_BIN`
 * runs a program outside the folder, whose build the folder's marker does not describe. Never throws.
 */
export function ownEngineBuild(rootPath: string, isDev: boolean): EngineBuildStamp | null {
  try {
    const dir = llamaServerDir(rootPath)
    const bin = resolveLlamaServerPath(rootPath, process.platform, process.env, { isDev })
    if (bin !== join(dir, llamaServerBinaryName(process.platform))) return null
    const marker = readRuntimeMarker(dir)
    return marker ? engineBuildStampOf({ version: marker.version, backend: marker.backend }) : null
  } catch {
    return null
  }
}

/**
 * What a GPU failure leaves behind (architecture.md GPU record §5.2, §5.3): `gpuAutoDisabled` and a
 * timestamped `gpuLastError`, so the next ladder skips every GPU rung. That write is what ends a
 * crash at one restart: the §5.3 fallback rebuilds the ladder, and without the flag it lands on the
 * GPU again. Built once at the composition seam, which holds the workspace, the audit recorder and the drive.
 *
 * W-70: the same write records the engine build the failure happened under (`gpuAutoDisabledEngine`, from
 * `ownEngineBuild`), FIRST: the store writes key by key, so a write cut short leaves a stamp beside a false flag,
 * which nothing reads, and never a new flag beside an older stamp. Every set rewrites it, null when the build is
 * unknown, so no older stamp survives a new set. Release 1 freezes both (the later-writer duty in F-27).
 *
 * Never throws: it runs inside the ladder and the crash handler, and a locked workspace (the write
 * is refused) must not stop the fallback it reports. The audit event lands either way.
 */
export function createGpuFailureRecorder(deps: {
  requireDb: () => Db
  audit: AuditRecorder
  paths: { rootPath: string }
  isDev: boolean
}): (reason: string) => void {
  return (reason) => {
    try {
      updateSettings(deps.requireDb(), {
        gpuAutoDisabledEngine: ownEngineBuild(deps.paths.rootPath, deps.isDev),
        gpuAutoDisabled: true,
        gpuLastError: `${new Date().toISOString()} — ${reason}`.slice(0, 2000)
      })
    } catch (err) {
      log.warn('Could not persist GPU fallback state', { error: String(err) })
    }
    log.warn('GPU start/run failed — continuing in compatibility (CPU) mode', { reason })
    // Audit: the reason is sidecar stderr/health output, never user content.
    deps.audit('runtime_fallback', 'Switched to compatibility (CPU) mode', {
      reason: reason.slice(0, 500)
    })
  }
}
