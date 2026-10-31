import { describe, it, expect, vi } from 'vitest'
import { openSync, fsyncSync, readFileSync, renameSync } from 'node:fs'
import { bodyFetch, OPEN_GATES } from '../helpers/download-fixtures'
import { verifiedManifest } from '../helpers/manifest-fixtures'
import { tempRoot } from '../helpers/db-fixtures'

// F-34 (full-audit 2026-07-16) — a WIRING pin with teeth, in the CODE-10 spirit of
// workspace-vault-durability.test.ts: it drives the REAL model downloader and asserts the
// durability-critical fs call ORDER — the completed `.part` is fsynced to the DEVICE before
// the atomic renameSync lands it under its final weight path. Without it a power cut / unplug
// right after completion (the #51 exFAT hard-unplug habit) can persist the rename + the
// (size,mtime) checksum-cache prime while trailing data blocks are lost, yielding a torn weight
// the cache reports verified. A plain vi.spyOn on the externalized node:fs builtin does NOT
// intercept the modules' internal named-import calls, so this file mocks node:fs with
// pass-through vi.fn wrappers — everything still hits the real filesystem; the mock only RECORDS.
// Kept in its own file so the module mock can never leak into the behavioral downloads suite.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const mocked = {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync)
  }
  return { ...mocked, default: mocked }
})

// Imported AFTER the mock is registered so the service modules bind the wrapped fns.
const { DownloadManager } = await import('../../src/main/services/downloads')
const { weightPath } = await import('../../src/main/services/models')
import type { DownloadJob } from '../../src/shared/types'
import { hangBudgetMs } from '../helpers/hang-budget'

const spies = {
  openSync: vi.mocked(openSync),
  fsyncSync: vi.mocked(fsyncSync),
  renameSync: vi.mocked(renameSync)
}

async function waitForTerminal(mgr: InstanceType<typeof DownloadManager>, jobId: string): Promise<DownloadJob> {
  const start = Date.now()
  for (;;) {
    const job = mgr.get(jobId)
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
    if (Date.now() - start > hangBudgetMs(5000)) throw new Error('download never finished')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('download durability — fsync-before-rename wiring (F-34, CODE-10)', () => {
  it('fsyncs the completed .part to the device BEFORE renaming it into place', async () => {
    const body = 'the-language-gguf-weight-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot('dl-fsync')
    const dest = weightPath(root, m)
    const part = `${dest}.part` // on-disk contract: a kept .part resumes across versions

    spies.openSync.mockClear()
    spies.fsyncSync.mockClear()
    spies.renameSync.mockClear()

    const mgr = new DownloadManager({ fetchImpl: bodyFetch(body) })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')

    // Every write-capable fd opened for the `.part` (the fsync target)…
    const partFds = spies.openSync.mock.calls
      .map((args, i) => ({ path: String(args[0]), flags: args[1], fd: spies.openSync.mock.results[i]?.value as number }))
      .filter((c) => c.path === part && c.flags === 'r+')
      .map((c) => c.fd)
    expect(partFds.length).toBeGreaterThan(0)

    // …must be fsynced BEFORE the atomic rename lands it under the final weight path
    // (TEETH: delete downloadToFile's fsync → no `.part` fsync precedes the rename → red).
    const renameIdx = spies.renameSync.mock.calls.findIndex(([from, to]) => from === part && to === dest)
    expect(renameIdx).toBeGreaterThanOrEqual(0)
    const renameOrder = spies.renameSync.mock.invocationCallOrder[renameIdx]
    const fsyncOrders = spies.fsyncSync.mock.calls
      .map((args, i) => ({ fd: args[0], order: spies.fsyncSync.mock.invocationCallOrder[i] }))
      .filter((c) => partFds.includes(c.fd as number))
    expect(fsyncOrders.length).toBeGreaterThan(0)
    expect(Math.min(...fsyncOrders.map((c) => c.order))).toBeLessThan(renameOrder)
  })

  it('a flush fault is best-effort: the download still lands', async () => {
    const body = 'the-language-gguf-weight-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot('dl-fsync')
    spies.fsyncSync.mockClear()
    spies.fsyncSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
    })
    const mgr = new DownloadManager({ fetchImpl: bodyFetch(body) })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(spies.fsyncSync).toHaveBeenCalled() // the fault really fired
    expect(finished.status).toBe('done')
    expect(readFileSync(weightPath(root, m), 'utf8')).toBe(body)
  })
})
