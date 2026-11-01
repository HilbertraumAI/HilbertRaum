import { describe, expect, it, vi } from 'vitest'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import type { Db } from '../../src/main/services/db'
import { log } from '../../src/main/services/logging'
import { createGpuFailureRecorder } from '../../src/main/services/runtime/gpu-failure'
import { getSettings } from '../../src/main/services/settings'
import { seededFreshDb } from '../helpers/seeded-db'

// What `persistGpuFailure` leaves behind (#747). The ladder suites stand a flag in for this write
// (`ladder-harness`'s `latchGpuFailures`), so these rows are the only ones that reach the store. The
// flag is what keeps the §5.3 crash fallback to one restart: the rebuilt ladder reads it.

/** The recorder over a real store and a real audit log, as `initBackend` composes them. */
function recorder(getDb: () => Db): (reason: string) => void {
  return createGpuFailureRecorder({ requireDb: getDb, audit: createAuditRecorder(getDb) })
}

describe('createGpuFailureRecorder', () => {
  it('turns the GPU off for the next ladder, keeps the reason with its time, and audits the fallback', () => {
    const db = seededFreshDb('gpu-failure')
    recorder(() => db)('vk::Queue::submit: ErrorDeviceLost')

    const settings = getSettings(db)
    expect(settings.gpuAutoDisabled).toBe(true)
    expect(settings.gpuLastError).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z — vk::Queue::submit: ErrorDeviceLost$/)
    const [event] = listAuditEvents(db)
    expect(event.type).toBe('runtime_fallback')
    expect(event.metadata).toEqual({ reason: 'vk::Queue::submit: ErrorDeviceLost' })
  })

  it('a reason past the store’s cap still lands, cut to 2,000 characters; the audit keeps 500', () => {
    // The store drops an over-long `gpuLastError` whole (BE-1), which would hide why the GPU went off.
    const db = seededFreshDb('gpu-failure-long')
    recorder(() => db)('e'.repeat(5000))

    expect(getSettings(db).gpuLastError).toHaveLength(2000)
    expect(listAuditEvents(db)[0].metadata).toEqual({ reason: 'e'.repeat(500) })
  })

  it('a locked workspace refuses the write without throwing, and the audit event lands after the unlock', () => {
    const db = seededFreshDb('gpu-failure-locked')
    let locked = true
    const getDb = (): Db => {
      if (locked) throw new Error('Workspace is locked')
      return db
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    const audit = createAuditRecorder(getDb)
    const record = createGpuFailureRecorder({ requireDb: getDb, audit })

    expect(() => record('health check failed')).not.toThrow()
    expect(warn).toHaveBeenCalledWith('Could not persist GPU fallback state', expect.anything())
    warn.mockRestore()

    locked = false
    audit('workspace_unlocked', 'Workspace unlocked')
    expect(getSettings(db).gpuAutoDisabled).toBe(false)
    expect(listAuditEvents(db).map((e) => e.type)).toContain('runtime_fallback')
  })
})
