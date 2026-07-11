import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDriveRootFromLauncher } from '../../src/main/services/launcher'
import { runPreflight } from '../../src/main/services/preflight'
import type { DriveSpeed } from '../../src/main/services/benchmark'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('resolveDriveRootFromLauncher', () => {
  it('derives the drive root from a Windows drive-letter launcher (no hardcoded letter)', () => {
    expect(resolveDriveRootFromLauncher('E:\\Start HilbertRaum.cmd', 'win32')).toBe('E:\\')
    // The SAME drive on a second laptop gets a different letter — must follow it (criterion #10).
    expect(resolveDriveRootFromLauncher('F:\\Start HilbertRaum.cmd', 'win32')).toBe('F:\\')
  })

  it('handles a launcher nested in a sub-folder of the drive', () => {
    expect(resolveDriveRootFromLauncher('E:\\PRIVATE_AI\\Start HilbertRaum.cmd', 'win32')).toBe(
      'E:\\PRIVATE_AI'
    )
  })

  it('derives the drive root from a POSIX / macOS launcher', () => {
    expect(
      resolveDriveRootFromLauncher('/Volumes/MYDRIVE/start-hilbertraum.sh', 'posix')
    ).toBe('/Volumes/MYDRIVE')
    expect(
      resolveDriveRootFromLauncher('/Volumes/HILBERTRAUM/Start HilbertRaum.command', 'posix')
    ).toBe('/Volumes/HILBERTRAUM')
  })

  it('auto-detects Windows vs POSIX grammar from the path', () => {
    expect(resolveDriveRootFromLauncher('E:\\Start HilbertRaum.cmd')).toBe('E:\\')
    expect(resolveDriveRootFromLauncher('/media/usb/start-hilbertraum.sh')).toBe('/media/usb')
    // Mixed separators still resolve (auto picks win32 on a backslash).
    expect(resolveDriveRootFromLauncher('E:/PRIVATE_AI\\Start HilbertRaum.cmd')).toBe(
      'E:\\PRIVATE_AI'
    )
  })

  it('resolves a Windows UNC launcher to its share root (absolute)', () => {
    const root = resolveDriveRootFromLauncher(
      '\\\\SERVER\\share\\Start HilbertRaum.cmd',
      'win32'
    )
    expect(root.startsWith('\\\\SERVER\\share')).toBe(true)
  })

  it('rejects an empty path', () => {
    expect(() => resolveDriveRootFromLauncher('')).toThrow(/empty/)
    expect(() => resolveDriveRootFromLauncher('   ')).toThrow(/empty/)
  })

  it('rejects a bare filename / relative path with no absolute parent', () => {
    expect(() => resolveDriveRootFromLauncher('Start HilbertRaum.cmd', 'win32')).toThrow(
      /absolute/
    )
    expect(() => resolveDriveRootFromLauncher('./sub/start.sh', 'posix')).toThrow(/absolute/)
  })
})

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

    expect(res.slowDriveWarning).toMatch(/slower/i)
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
    const root = tempDir('hilbertraum-preflight-space-')
    mkdirSync(join(root, 'workspace'), { recursive: true })

    const res = await runPreflight({
      rootPath: root,
      measureSpeed: async () => fastSpeed,
      // An impossibly high floor forces the low-space branch deterministically.
      minFreeBytes: Number.MAX_SAFE_INTEGER
    })

    expect(res.freeBytes).not.toBeNull()
    expect(res.problems.some((p) => /low on free space/i.test(p))).toBe(true)
  })

  it('does not report low space when free space is unmeasurable (freeBytes == null)', async () => {
    // A non-existent root → statfs throws → freeBytes is null; the low-space branch must
    // be skipped (guarded by `!= null`) even with an impossibly high floor.
    const root = join(tempDir('hilbertraum-preflight-noroot-'), 'does-not-exist')
    const res = await runPreflight({
      rootPath: root,
      measureSpeed: async () => fastSpeed,
      minFreeBytes: Number.MAX_SAFE_INTEGER
    })
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
