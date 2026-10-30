import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { hangBudgetMs } from '../helpers/hang-budget'
import { tempRoot } from '../helpers/db-fixtures'
import { bodyFetch, hangingFetch } from '../helpers/download-fixtures'
import { sha256 } from '../helpers/manifest-fixtures'

const handlers = ipcState.handlers as unknown as IpcHandlers

const BODY = 'downloaded-model-bytes'

/** A drive root with one downloadable manifest (real hash of BODY) + optional policy. */
function makeDrive(opts: { policyDeniesDownloads?: boolean; placeholderHash?: boolean; pendingLicense?: boolean } = {}): {
  rootPath: string
  configPath: string
  manifestsDir: string
} {
  // #314: a placeholder hash lands the weight but leaves the job `done` + `unverified` — the
  // second kind of unresolved result `downloads:list` has to keep offering.
  const hash = opts.placeholderHash ? 'PLACEHOLDER' : sha256(BODY)
  const rootPath = tempRoot('dlipc')
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
      sha256: hash,
      recommended_profiles: ['LITE'],
      license_review: opts.pendingLicense
        ? { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
        : { status: 'approved', reviewed_by: 't', reviewed_at: '2026-06-10', notes: '' },
      download: {
        url: 'https://example.test/test-model.gguf',
        sha256: hash,
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

const openedDbs: Db[] = []

function makeCtx(opts: {
  policyDeniesDownloads?: boolean
  allowNetwork?: boolean
  unlocked?: boolean
  placeholderHash?: boolean
  pendingLicense?: boolean
}): { ctx: AppContext; db: Db; rootPath: string } {
  const drive = makeDrive({
    policyDeniesDownloads: opts.policyDeniesDownloads,
    placeholderHash: opts.placeholderHash,
    pendingLicense: opts.pendingLicense
  })
  const db = openDatabase(join(drive.rootPath, 'test.sqlite'))
  openedDbs.push(db)
  seedSettings(db)
  // Set explicitly (the seeded default is now allowNetwork:true) so an `allowNetwork:false`
  // case genuinely exercises the setting-off gate rather than inheriting the default.
  updateSettings(db, { allowNetwork: opts.allowNetwork ?? false })
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath: drive.rootPath, configPath: drive.configPath },
    db,
    workspace: { isUnlocked: () => opts.unlocked !== false },
    manifestsDir: drive.manifestsDir
  } as unknown as AppContext
  return { ctx, db, rootPath: drive.rootPath }
}

const okFetch = bodyFetch(BODY)

async function waitForTerminal(jobId: string): Promise<DownloadJob> {
  const start = Date.now()
  for (;;) {
    const { result } = await invoke(handlers, IPC.getDownloadJob, jobId)
    const job = result as DownloadJob
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
    if (Date.now() - start > hangBudgetMs(5000)) throw new Error('download job never finished')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => ipcState.handlers.clear())
afterEach(() => {
  for (const db of openedDbs.splice(0)) db.close()
})

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

  it('a manifest awaiting license review needs licenseAccepted to be exactly true', async () => {
    const fetchSpy = vi.fn(bodyFetch(BODY))
    const { ctx } = makeCtx({ allowNetwork: true, pendingLicense: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: fetchSpy }))
    await expect(invoke(handlers, IPC.downloadModel, 'test-model-q4')).rejects.toThrow(/license/)
    await expect(
      invoke(handlers, IPC.downloadModel, 'test-model-q4', { licenseAccepted: 'yes' })
    ).rejects.toThrow(/license/)
    expect(fetchSpy).not.toHaveBeenCalled()
    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4', { licenseAccepted: true })
    expect((await waitForTerminal((result as DownloadJob).jobId)).status).toBe('done')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
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

  it('cancelDownload routes the id: the job ends cancelled', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: hangingFetch('partial-') }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const job = result as DownloadJob
    const { result: cancelled } = await invoke(handlers, IPC.cancelDownload, job.jobId)
    expect((cancelled as DownloadJob).status).toBe('cancelled')
    const finished = await waitForTerminal(job.jobId)
    expect(finished.status).toBe('cancelled')
  })
})

// #314 — the reload-recovery pair. A renderer reload wipes the screen's module memory but NOT
// the main process's jobs, so `downloads:list` answers "what does the user still have to act on"
// without a caller-supplied job id, and `downloads:dismiss` makes a dismissal outlive the reload.
describe('downloads:list / downloads:dismiss (renderer-reload recovery, #314)', () => {
  const failingFetch = (async () => {
    throw new Error('connection reset')
  }) as unknown as FetchFn

  /** Narrow private read: memory is the only effect of this set's bound, and no public observable shows it. */
  const dismissedIds = (m: DownloadManager): Set<string> =>
    (m as unknown as { dismissed: Set<string> }).dismissed

  async function list(): Promise<DownloadJob[]> {
    const { result } = await invoke(handlers, IPC.listDownloadJobs)
    return result as DownloadJob[]
  }

  /** Poll one manager (not the IPC layer) until the job leaves its live states. */
  async function settle(manager: DownloadManager, jobId: string): Promise<DownloadJob> {
    const start = Date.now()
    for (;;) {
      const job = manager.get(jobId)
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
      if (Date.now() - start > hangBudgetMs(5000)) throw new Error('download job never finished')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it('lists the running job while a download is in flight (progress + Cancel can re-attach)', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: hangingFetch('partial-') }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const started = result as DownloadJob
    const listed = await list()
    expect(listed).toHaveLength(1)
    expect(listed[0].jobId).toBe(started.jobId)
    expect(listed[0].modelId).toBe('test-model-q4')
    expect(['queued', 'downloading', 'verifying']).toContain(listed[0].status)

    await invoke(handlers, IPC.cancelDownload, started.jobId)
    await waitForTerminal(started.jobId)
  })

  it('lists a failed job with its error, so the reloaded screen can name the failure', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: failingFetch }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const started = result as DownloadJob
    expect((await waitForTerminal(started.jobId)).status).toBe('failed')

    const listed = await list()
    expect(listed).toHaveLength(1)
    expect(listed[0].jobId).toBe(started.jobId)
    expect(listed[0].status).toBe('failed')
    expect(listed[0].error).toBeTruthy()
  })

  it('lists a done-but-UNVERIFIED job (the placeholder-hash result still needs the user)', async () => {
    const { ctx } = makeCtx({ allowNetwork: true, placeholderHash: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: okFetch }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const started = result as DownloadJob
    const finished = await waitForTerminal(started.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(true)

    const listed = await list()
    expect(listed.map((j) => j.jobId)).toEqual([started.jobId])
  })

  it('never lists a VERIFIED done job — the model row already carries that state', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: okFetch }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const finished = await waitForTerminal((result as DownloadJob).jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(false)
    expect(await list()).toEqual([])
  })

  it('never lists a CANCELLED job', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: hangingFetch('partial-') }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const started = result as DownloadJob
    await invoke(handlers, IPC.cancelDownload, started.jobId)
    expect((await waitForTerminal(started.jobId)).status).toBe('cancelled')
    expect(await list()).toEqual([])
  })

  it('stops listing a job the renderer dismissed, so the dismissal survives the reload', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, new DownloadManager({ fetchImpl: failingFetch }))

    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const started = result as DownloadJob
    await waitForTerminal(started.jobId)
    expect(await list()).toHaveLength(1)

    await invoke(handlers, IPC.dismissDownloadJob, started.jobId)
    expect(await list()).toEqual([])
    // The job itself is untouched — a late poll still gets its real terminal state.
    const { result: polled } = await invoke(handlers, IPC.getDownloadJob, started.jobId)
    expect((polled as DownloadJob).status).toBe('failed')
  })

  it('dismissing an id this manager never issued changes nothing', async () => {
    const manager = new DownloadManager({ fetchImpl: failingFetch })
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, manager)

    await invoke(handlers, IPC.dismissDownloadJob, 'no-such-job')
    expect(dismissedIds(manager).size).toBe(0)
    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const started = result as DownloadJob
    await waitForTerminal(started.jobId)
    expect((await list()).map((j) => j.jobId)).toEqual([started.jobId])
  })

  it('serves both channels with the workspace LOCKED — neither needs an unlock', async () => {
    const manager = new DownloadManager({ fetchImpl: failingFetch })
    const { ctx } = makeCtx({ allowNetwork: true })
    registerDownloadIpc(ctx, manager)
    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    const started = result as DownloadJob
    await waitForTerminal(started.jobId)

    // The vault locks mid-session; the SAME manager is re-registered against the locked context.
    registerDownloadIpc(makeCtx({ allowNetwork: true, unlocked: false }).ctx, manager)
    expect((await list()).map((j) => j.jobId)).toEqual([started.jobId])
    await invoke(handlers, IPC.dismissDownloadJob, started.jobId)
    expect(await list()).toEqual([])
  })

  it('prunes the oldest terminal jobs past the keep window — and their dismissal records', async () => {
    const { ctx } = makeCtx({ allowNetwork: true })
    const manager = new DownloadManager({ fetchImpl: failingFetch })
    registerDownloadIpc(ctx, manager)

    // 23 failed jobs, the first one dismissed straight away. Pruning runs at the START of a
    // download: the 22nd start finds 21 terminal jobs and drops ids[0] (dismissed), the 23rd finds
    // 21 again and drops ids[1] (undismissed), the one a pruning failure would still leave listed.
    const ids: string[] = []
    for (let i = 0; i < 23; i++) {
      const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
      const started = result as DownloadJob
      ids.push(started.jobId)
      await settle(manager, started.jobId)
      if (i === 0) manager.dismiss(started.jobId)
    }

    // 21 kept: the window (MAX_TERMINAL_JOBS = 20) plus the job whose start ran the prune, in
    // creation order. ids[0] (dismissed) and ids[1] (not) are gone.
    expect(manager.list().map((j) => j.jobId)).toEqual(ids.slice(2))
    expect(manager.get(ids[0]).error).toMatch(/Unknown/)
    expect(manager.get(ids[1]).error).toMatch(/Unknown/)
    // …and the dismissal record left with it, so the set can never outgrow the keep window.
    expect(dismissedIds(manager).has(ids[0])).toBe(false)
    expect(dismissedIds(manager).size).toBe(0)
  })
})

describe('the default manager main/index.ts registers (no injected manager)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('the default manager main/index.ts registers fetches globally and reports to the context', async () => {
    const fetchSpy = vi.fn(bodyFetch(BODY))
    vi.stubGlobal('fetch', fetchSpy) // before registering: the registrar reads `fetch` when it builds the manager
    const { ctx } = makeCtx({ allowNetwork: true })
    const audit = vi.fn()
    const onModelInstalled = vi.fn()
    ctx.audit = audit
    ctx.onModelInstalled = onModelInstalled
    registerDownloadIpc(ctx)
    const { result } = await invoke(handlers, IPC.downloadModel, 'test-model-q4')
    expect((await waitForTerminal((result as DownloadJob).jobId)).status).toBe('done')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(onModelInstalled).toHaveBeenCalledWith('test-model-q4')
    expect(audit.mock.calls.map(([type]) => type)).toEqual(['model_download_started', 'model_download_verified'])
  })
})
