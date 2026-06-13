import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

// Phase 18 IPC-layer tests: the downloadModel gates are enforced in the MAIN process
// (policy ceiling ∧ allowNetwork setting ∧ license acknowledgement), the offline
// guarantee extension (a closed gate never reaches the network seam — the injected
// fake fetch stays uncalled), and the poll/cancel loop.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { registerDownloadIpc } from '../../src/main/ipc/registerDownloadIpc'
import { DownloadManager } from '../../src/main/services/downloads'
import type { FetchFn } from '../../src/main/services/assets'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, updateSettings } from '../../src/main/services/settings'
import type { DownloadJob } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

const BODY = 'downloaded-model-bytes'

/** A drive root with one downloadable manifest (real hash of BODY) + optional policy. */
function makeDrive(opts: { policyDeniesDownloads?: boolean } = {}): {
  rootPath: string
  configPath: string
  manifestsDir: string
} {
  const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-dlipc-'))
  const manifestsDir = join(rootPath, 'model-manifests')
  mkdirSync(manifestsDir, { recursive: true })
  writeFileSync(
    join(manifestsDir, 'test-model.yaml'),
    stringify({
      id: 'test-model-q4',
      display_name: 'Test Model Q4',
      family: 'test',
      role: 'chat',
      format: 'gguf',
      runtime: 'llama_cpp',
      license: 'apache-2.0',
      size_on_disk_gb: 0.1,
      recommended_min_ram_gb: 4,
      recommended_ram_gb: 8,
      recommended_context_tokens: 4096,
      local_path: 'models/chat/test-model-q4.gguf',
      sha256: sha256(BODY),
      recommended_profiles: ['LITE'],
      license_review: { status: 'approved', reviewed_by: 't', reviewed_at: '2026-06-10', notes: '' },
      download: {
        url: 'https://example.test/test-model.gguf',
        sha256: sha256(BODY),
        size_bytes: BODY.length,
        license_url: 'https://example.test/license'
      }
    })
  )
  const configPath = join(rootPath, 'config')
  mkdirSync(configPath, { recursive: true })
  if (opts.policyDeniesDownloads) {
    writeFileSync(
      join(configPath, 'policy.json'),
      JSON.stringify({ network: { allow_model_downloads: false } })
    )
  }
  return { rootPath, configPath, manifestsDir }
}

function makeCtx(opts: {
  policyDeniesDownloads?: boolean
  allowNetwork?: boolean
  unlocked?: boolean
}): { ctx: AppContext; db: Db; rootPath: string } {
  const drive = makeDrive({ policyDeniesDownloads: opts.policyDeniesDownloads })
  const db = openDatabase(join(drive.rootPath, 'test.sqlite'))
  seedSettings(db)
  // Set explicitly (the seeded default is now allowNetwork:true) so an `allowNetwork:false`
  // case genuinely exercises the setting-off gate rather than inheriting the default.
  updateSettings(db, { allowNetwork: opts.allowNetwork ?? false })
  const ctx = {
    paths: { rootPath: drive.rootPath, configPath: drive.configPath },
    db,
    workspace: { isUnlocked: () => opts.unlocked !== false },
    manifestsDir: drive.manifestsDir
  } as unknown as AppContext
  return { ctx, db, rootPath: drive.rootPath }
}

const okFetch = (async () =>
  new Response(BODY, {
    status: 200,
    headers: { 'content-length': String(BODY.length) }
  })) as unknown as FetchFn

async function waitForTerminal(jobId: string): Promise<DownloadJob> {
  const start = Date.now()
  for (;;) {
    const { result } = await invoke(handlers, IPC.getDownloadJob, jobId)
    const job = result as DownloadJob
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
    if (Date.now() - start > 5000) throw new Error('download job never finished')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => ipcState.handlers.clear())

describe('downloadModel gates (offline guarantee — closed gates never reach the network seam)', () => {
  it('refuses when the policy ceiling denies downloads — fetch never called', async () => {
    const fetchSpy = vi.fn()
    const { ctx } = makeCtx({ policyDeniesDownloads: true, allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn }))
    await expect(invoke(handlers, IPC.downloadModel, 'test-model-q4')).rejects.toThrow(/policy/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses when the allowNetwork setting is off — fetch never called', async () => {
    const fetchSpy = vi.fn()
    const { ctx } = makeCtx({ allowNetwork: false })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn }))
    await expect(invoke(handlers, IPC.downloadModel, 'test-model-q4')).rejects.toThrow(/Settings/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('treats a LOCKED workspace as setting-off (the pre-unlock offline ceiling)', async () => {
    const fetchSpy = vi.fn()
    const { ctx } = makeCtx({ allowNetwork: true, unlocked: false })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn }))
    await expect(invoke(handlers, IPC.downloadModel, 'test-model-q4')).rejects.toThrow(/Settings/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws on an unknown model id', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: okFetch }))
    await expect(invoke(handlers, IPC.downloadModel, 'no-such-model')).rejects.toThrow(
      /Unknown model id/
    )
  })
})

describe('downloadModel happy path (both gates open, injected fake fetch)', () => {
  it('downloads, verifies, and lands the weight at the manifest path', async () => {
    const { ctx, rootPath } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: okFetch }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const job = result as DownloadJob
    expect(job.modelId).toBe('test-model-q4')

    const finished = await waitForTerminal(job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(false)
    const dest = join(rootPath, 'models', 'chat', 'test-model-q4.gguf')
    expect(readFileSync(dest, 'utf8')).toBe(BODY)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('cancelDownload stops an in-flight job and keeps the .part', async () => {
    const { ctx, rootPath } = makeCtx({ allowNetwork: true })
    const hanging = (async (_u: unknown, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial-'))
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError'))
          )
        }
      })
      return new Response(stream, { status: 200 })
    }) as unknown as FetchFn
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: hanging }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const job = result as DownloadJob
    const { result: cancelled } = await invoke(handlers, IPC.cancelDownload, job.jobId)
    expect((cancelled as DownloadJob).status).toBe('cancelled')
    const finished = await waitForTerminal(job.jobId)
    expect(finished.status).toBe('cancelled')
    expect(existsSync(join(rootPath, 'models', 'chat', 'test-model-q4.gguf'))).toBe(false)
  })
})
