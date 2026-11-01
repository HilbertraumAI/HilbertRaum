import type { AuditRecorder } from '../audit'
import type { Db } from '../db'
import { log } from '../logging'
import { updateSettings } from '../settings'

/**
 * What a GPU failure leaves behind (architecture.md GPU record §5.2, §5.3): `gpuAutoDisabled` and a
 * timestamped `gpuLastError`, so the next ladder skips every GPU rung. That write is what ends a
 * crash at one restart: the §5.3 fallback rebuilds the ladder, and without the flag it lands on the
 * GPU again. Built once at the composition seam, which holds the workspace and the audit recorder.
 *
 * Never throws: it runs inside the ladder and the crash handler, and a locked workspace (the write
 * is refused) must not stop the fallback it reports. The audit event lands either way.
 */
export function createGpuFailureRecorder(deps: { requireDb: () => Db; audit: AuditRecorder }): (reason: string) => void {
  return (reason) => {
    try {
      updateSettings(deps.requireDb(), {
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
