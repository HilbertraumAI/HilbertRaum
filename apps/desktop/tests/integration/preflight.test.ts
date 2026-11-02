import { beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPreflight } from '../../src/main/services/preflight'
import { t } from '../../src/shared/i18n'
import type { DriveSpeed } from '../../src/main/services/benchmark'

// A row reads the mocked volume, never this machine's free space.
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = { ...orig, statfs: vi.fn() }
  return { ...mocked, default: mocked }
})

const setFreeBytes = (bytes: number): void => {
  vi.mocked(statfs).mockResolvedValue({ bavail: bytes, bsize: 1 } as unknown as Awaited<ReturnType<typeof statfs>>)
}
beforeEach(() => setFreeBytes(8 * 1024 ** 3))

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('runPreflight', () => {
  const fastSpeed: DriveSpeed = { readMbps: 520, writeMbps: 410 }

  it('passes on a writable, fast drive with no problems', async () => {
    const root = tempDir('hilbertraum-preflight-ok-')
    mkdirSync(join(root, 'workspace'), { recursive: true })
    const measureSpeed = vi.fn(async () => fastSpeed)

    const res = await runPreflight({ rootPath: root, measureSpeed })

    expect(res.writable).toBe(true)
    expect(res.slowDriveWarning).toBeNull()
    expect(res.problems).toEqual([])
    // The injected probe is the only I/O — no real disk benchmark, no network.
    expect(measureSpeed).toHaveBeenCalledWith(join(root, 'workspace'))
  })

  it('surfaces a friendly, non-blocking slow-drive note (never "bad hardware")', async () => {
    const root = tempDir('hilbertraum-preflight-slow-')
    mkdirSync(join(root, 'workspace'), { recursive: true })
    const slow: DriveSpeed = { readMbps: 9, writeMbps: 7 }

    const res = await runPreflight({ rootPath: root, measureSpeed: async () => slow })

    // #110 hardened the binding from a /drive/i word-regex to an EXACT canonical-English
    // match — pin byte equality so a copy or selection drift fails loudly here.
    expect(res.slowDriveWarning).toBe(t('en', 'main.benchmark.warnSlowDrive'))
    expect(res.slowDriveWarning).not.toMatch(/bad/i)
    // Slow is not a blocker.
    expect(res.problems).toEqual([])
  })

  it('flags a read-only drive as a problem (workspace cannot be created)', async () => {
    const root = tempDir('hilbertraum-preflight-ro-')
    // Deliberately do NOT create the workspace dir → isWritable() probe fails → not writable.
    const res = await runPreflight({ rootPath: root, measureSpeed: async () => fastSpeed })

    expect(res.writable).toBe(false)
    expect(res.problems.some((p) => /read-only/i.test(p))).toBe(true)
  })

  it('flags low free space (non-blocking) when below the floor', async () => {
    setFreeBytes(2_147_483_647)
    const root = tempDir('hilbertraum-preflight-space-')
    mkdirSync(join(root, 'workspace'), { recursive: true })

    const res = await runPreflight({ rootPath: root, measureSpeed: async () => fastSpeed })

    expect(res.freeBytes).toBe(2_147_483_647)
    expect(res.writable).toBe(true)
    expect(res.problems.some((p) => /low on free space/i.test(p))).toBe(true)
  })

  it('free space exactly at the shipped 2 GB floor is not low', async () => {
    const root = tempDir('hilbertraum-preflight-floor-')
    mkdirSync(join(root, 'workspace'), { recursive: true })
    setFreeBytes(2_147_483_648)

    const res = await runPreflight({ rootPath: root, measureSpeed: async () => fastSpeed })

    expect(res.freeBytes).toBe(2_147_483_648)
    expect(res.problems).toEqual([])
  })

  it('does not report low space when free space is unmeasurable (freeBytes == null)', async () => {
    // statfs throws → freeBytes is null; the low-space branch must be skipped (guarded by `!= null`).
    vi.mocked(statfs).mockRejectedValue(new Error('no such volume'))
    const root = join(tempDir('hilbertraum-preflight-noroot-'), 'does-not-exist')
    const res = await runPreflight({ rootPath: root, measureSpeed: async () => fastSpeed })
    expect(res.freeBytes).toBeNull()
    expect(res.problems.some((p) => /low on free space/i.test(p))).toBe(false)
  })

  it('degrades to "could not measure" when the drive probe errors (no throw)', async () => {
    const root = tempDir('hilbertraum-preflight-err-')
    mkdirSync(join(root, 'workspace'), { recursive: true })
    const errored: DriveSpeed = { readMbps: null, writeMbps: null, error: 'probe failed' }

    const res = await runPreflight({ rootPath: root, measureSpeed: async () => errored })

    expect(res.slowDriveWarning).toMatch(/could not be measured/i)
    expect(res.problems).toEqual([])
  })
})
