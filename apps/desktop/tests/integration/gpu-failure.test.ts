import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeMarkerPath, writeRuntimeMarker } from '../../src/main/services/assets'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import type { Db } from '../../src/main/services/db'
import { log } from '../../src/main/services/logging'
import { createGpuFailureRecorder } from '../../src/main/services/runtime/gpu-failure'
import { llamaOsDir, llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import type { RuntimeOs } from '../../src/shared/runtime-sources'
import { freshWorkspaceDb, rawSetting, tempRoot } from '../helpers/db-fixtures'
import { seededFreshDb } from '../helpers/seeded-db'

// What `persistGpuFailure` leaves behind (#747). The ladder suites stand a flag in for this write
// (`ladder-harness`'s `latchGpuFailures`), so these rows are the only ones that reach the store. The
// flag is what keeps the §5.3 crash fallback to one restart: the rebuilt ladder reads it.

/** The recorder over a real store and a real audit log, as `initBackend` composes them; `rootPath` is the drive. */
function recorder(getDb: () => Db, rootPath: string = tempRoot('gpu-failure-drive')): (reason: string) => void {
  return createGpuFailureRecorder({ requireDb: getDb, audit: createAuditRecorder(getDb), paths: { rootPath }, isDev: false })
}

/** A seeded workspace DB and the drive root beside it. */
function drive(label: string): { db: Db; root: string } {
  const { db, root } = freshWorkspaceDb(label)
  seedSettings(db)
  return { db, root }
}

/** The chat engine in `runtime/llama.cpp/<os>/` as an install leaves it: the program and, unless null, its install marker. */
function engineOnDrive(root: string, build: { version: string; backend: string } | null): void {
  const dir = llamaServerDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), 'fake-binary')
  if (build) writeRuntimeMarker(dir, { ...build, os: llamaOsDir() as RuntimeOs, arch: 'x64' })
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
    const record = createGpuFailureRecorder({ requireDb: getDb, audit, paths: { rootPath: tempRoot('gpu-failure-drive') }, isDev: false })

    expect(() => record('health check failed')).not.toThrow()
    expect(warn).toHaveBeenCalledWith('Could not persist GPU fallback state', expect.anything())
    warn.mockRestore()

    locked = false
    audit('workspace_unlocked', 'Workspace unlocked')
    expect(getSettings(db).gpuAutoDisabled).toBe(false)
    expect(listAuditEvents(db).map((e) => e.type)).toContain('runtime_fallback')
  })
})

// W-70 (app-update plan, T3.11): the flag carries the engine build it was set under, so release 1 can try the card again
// once its own engine is another build (`healEngineLoadState`). Release 1 freezes the stamp's shape and that every set
// rewrites it: a later version and "Go back" both rely on no older stamp surviving beside a flag set now.
describe('createGpuFailureRecorder: the engine build the flag was set under (W-70)', () => {
  it('stores the build of the drive’s own engine folder with the flag', () => {
    const { db, root } = drive('gpu-failure-stamp')
    engineOnDrive(root, { version: 'b9849', backend: 'vulkan' })
    recorder(() => db, root)('vk::Queue::submit: ErrorDeviceLost')

    const s = getSettings(db)
    expect(s.gpuAutoDisabled).toBe(true)
    expect(rawSetting(db, 'gpuAutoDisabledEngine')).toEqual({ version: 'b9849', backend: 'vulkan' })
  })

  it.each<[string, (root: string) => void]>([
    ['no engine folder on the drive', () => undefined],
    ['a program without an install marker', (root) => engineOnDrive(root, null)],
    [
      'a damaged marker (a folder at its name)',
      (root) => {
        engineOnDrive(root, null)
        mkdirSync(runtimeMarkerPath(llamaServerDir(root)))
      }
    ],
    // The store would drop such a stamp whole and keep the older one: the recorder writes null instead.
    ['a marker whose tag is longer than a stamp holds', (root) => engineOnDrive(root, { version: 'b'.repeat(129), backend: 'vulkan' })]
  ])('an unknown build (%s) stores null over an older stamp, and the flag is still set', (_label, arrange) => {
    const { db, root } = drive('gpu-failure-unknown')
    updateSettings(db, { gpuAutoDisabledEngine: { version: 'b8000', backend: 'vulkan' } })
    arrange(root)
    recorder(() => db, root)('health check failed')

    expect(getSettings(db).gpuAutoDisabled).toBe(true)
    expect(rawSetting(db, 'gpuAutoDisabledEngine')).toBeNull()
  })

  it('writes the stamp before the flag: a store that fails at the flag leaves the stamp and no flag', () => {
    // The store upserts key by key with no transaction, so the order is what a crash between the two writes leaves.
    // A stamp beside a false flag is read by nothing; a flag beside an older stamp would re-arm under the wrong build.
    const { db, root } = drive('gpu-failure-order')
    engineOnDrive(root, { version: 'b9849', backend: 'vulkan' })
    for (const event of ['INSERT', 'UPDATE']) {
      db.exec(
        `CREATE TRIGGER cut_at_flag_${event} BEFORE ${event} ON settings WHEN NEW.key = 'gpuAutoDisabled' BEGIN SELECT RAISE(ABORT, 'disk full'); END`
      )
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      expect(() => recorder(() => db, root)('health check failed')).not.toThrow()
    } finally {
      warn.mockRestore()
    }

    expect(rawSetting(db, 'gpuAutoDisabledEngine')).toEqual({ version: 'b9849', backend: 'vulkan' })
    expect(getSettings(db).gpuAutoDisabled).toBe(false)
  })
})
