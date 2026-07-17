import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, openSync, fsyncSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const { DownloadManager, partPath } = await import('../../src/main/services/downloads')
const { weightPath } = await import('../../src/main/services/models')
const { validateManifest } = await import('../../src/shared/manifest')
import type { FetchFn } from '../../src/main/services/assets'
import type { ModelManifest } from '../../src/shared/manifest'
import type { DownloadJob } from '../../src/shared/types'

const spies = {
  openSync: vi.mocked(openSync),
  fsyncSync: vi.mocked(fsyncSync),
  renameSync: vi.mocked(renameSync)
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** A verified single-file chat manifest whose top-level + download hashes match `body`. */
function verifiedManifest(body: string): ModelManifest {
  const raw = {
    id: 'qwen3-4b-instruct-q4',
    display_name: 'Qwen3 4B Instruct Q4',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    size_on_disk_gb: 2.7,
    recommended_min_ram_gb: 8,
    recommended_ram_gb: 16,
    recommended_context_tokens: 4096,
    local_path: 'models/chat/qwen3-4b-instruct-q4.gguf',
    sha256: sha256(body),
    recommended_profiles: ['LITE'],
    license_review: { status: 'approved', reviewed_by: 't', reviewed_at: '2026-06-10', notes: '' },
    download: {
      url: 'https://example.test/qwen3-4b.gguf',
      sha256: sha256(body),
      size_bytes: body.length,
      license_url: 'https://example.test/license'
    }
  }
  const res = validateManifest(raw)
  if (!res.manifest) throw new Error('fixture invalid: ' + res.errors.join(', '))
  return res.manifest
}

const OPEN = { policyAllows: true, settingAllows: true }

const bodyFetch = (body: string): FetchFn =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.length) }
    })) as unknown as FetchFn

async function waitForTerminal(mgr: InstanceType<typeof DownloadManager>, jobId: string): Promise<DownloadJob> {
  const start = Date.now()
  for (;;) {
    const job = mgr.get(jobId)
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
    if (Date.now() - start > 5000) throw new Error('download never finished')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('download durability — fsync-before-rename wiring (F-34, CODE-10)', () => {
  it('fsyncs the completed .part to the device BEFORE renaming it into place', async () => {
    const body = 'the-language-gguf-weight-bytes'
    const m = verifiedManifest(body)
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-dl-fsync-'))
    const dest = weightPath(root, m)
    const part = partPath(dest)

    spies.openSync.mockClear()
    spies.fsyncSync.mockClear()
    spies.renameSync.mockClear()

    const mgr = new DownloadManager({ fetchImpl: bodyFetch(body) })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
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
})
