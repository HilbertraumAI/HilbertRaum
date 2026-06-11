import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// GPU IPC-layer behavior (audit round, architecture.md GPU record §5.4 + §8):
//  - tryGpuAgain clears the flags AND invalidates the session probe cache AND
//    re-persists a fresh probe (a plain settings write kept a stale "no GPU" cache).
//  - maybeRunFirstBenchmark refreshes the persisted gpuProbe each session even when a
//    benchmark already exists (a drive moved between machines kept the old GPU label).

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { maybeRunFirstBenchmark, tryGpuAgain } from '../../src/main/ipc/registerBenchmarkIpc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import {
  llamaServerBinaryName,
  llamaServerDir
} from '../../src/main/services/runtime/sidecar'
import type { AppContext } from '../../src/main/services/context'
import type { CachedGpuProbe } from '../../src/main/services/runtime/gpu'
import type { BenchmarkResult, GpuDevice } from '../../src/shared/types'

const RTX: GpuDevice = {
  id: 'Vulkan0',
  name: 'NVIDIA GeForce RTX 3080 Ti',
  totalMb: 12300,
  freeMb: 11511
}

/** A drive root with a fake llama-server present (so probeAndPersistGpu resolves it). */
function rootWithBinary(): string {
  const root = mkdtempSync(join(tmpdir(), 'paid-gpuipc-'))
  const dir = llamaServerDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), 'fake-binary')
  return root
}

function seededDb(root: string): Db {
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return db
}

function fakeProbe(devices: GpuDevice[]): CachedGpuProbe & { invalidated: () => number } {
  let invalidations = 0
  const probe = (async () => devices) as unknown as CachedGpuProbe
  probe.invalidate = () => {
    invalidations += 1
  }
  return Object.assign(probe, { invalidated: () => invalidations })
}

function ctxWith(root: string, db: Db, probe: CachedGpuProbe): AppContext {
  return {
    paths: { rootPath: root, workspacePath: join(root, 'workspace') },
    db,
    workspace: { isUnlocked: () => true },
    probeGpu: probe
  } as unknown as AppContext
}

describe('tryGpuAgain', () => {
  it('clears the flags, invalidates the probe cache, and persists a fresh probe', async () => {
    const root = rootWithBinary()
    const db = seededDb(root)
    updateSettings(db, {
      gpuAutoDisabled: true,
      gpuLastError: '2026-06-10T00:00:00Z — crashed',
      gpuProbe: { devices: [], probedAt: '2026-06-01T00:00:00Z' } // the stale false-empty probe
    })
    const probe = fakeProbe([RTX])

    const result = await tryGpuAgain(ctxWith(root, db, probe))

    expect(probe.invalidated()).toBe(1)
    expect(result.gpuAutoDisabled).toBe(false)
    expect(result.gpuLastError).toBeNull()
    // The user's explicit toggle is untouched; the fresh probe is persisted.
    expect(result.gpuMode).toBe('auto')
    expect(result.gpuProbe?.devices).toEqual([RTX])
    expect(getSettings(db).gpuProbe?.devices).toEqual([RTX])
  })
})

describe('maybeRunFirstBenchmark — per-session probe refresh', () => {
  it('refreshes the persisted gpuProbe even when a benchmark already exists', async () => {
    const root = rootWithBinary()
    const db = seededDb(root)
    // Already benchmarked (so no first-run benchmark fires) with another machine's GPU.
    updateSettings(db, {
      lastBenchmark: { profile: 'BALANCED' } as unknown as BenchmarkResult,
      gpuProbe: { devices: [RTX], probedAt: '2026-06-01T00:00:00Z' }
    })
    const probe = fakeProbe([]) // THIS machine has no GPU

    maybeRunFirstBenchmark(ctxWith(root, db, probe))

    await vi.waitFor(() => {
      expect(getSettings(db).gpuProbe?.devices).toEqual([])
    })
    // The existing benchmark result was not overwritten by a new run.
    expect((getSettings(db).lastBenchmark as unknown as { profile: string }).profile).toBe(
      'BALANCED'
    )
  })
})
