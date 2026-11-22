import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'

// #843: the activity log records every engine and OCR install — when it started and how it ended — and
// nothing about the user. Driven through the real IPC handlers (`registerEngineIpc`) over a real
// workspace DB and the app's real recorder (`createAuditRecorder`), so every row below reads what the
// Activity panel and the plaintext `activity-log.json` export would read. Fake fetch, fake extractor.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' }
}))
// Round 2: one row makes the spawn gate throw, a failure outside every step that records its own reason.
const spawnGate = vi.hoisted(() => ({ throwOnHold: false }))
vi.mock('../../src/main/services/runtime/spawn-gate', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/main/services/runtime/spawn-gate')>()
  return {
    ...orig,
    holdEngineSpawns: (family: string) => {
      if (spawnGate.throwOnHold) throw new Error('the spawn gate failed')
      return orig.holdEngineSpawns(family)
    }
  }
})

import { IPC } from '../../src/shared/ipc'
import { registerEngineIpc } from '../../src/main/ipc/registerEngineIpc'
import {
  EngineDownloadManager,
  engineFolderDeletesSettled,
  hostRuntimeArch,
  hostRuntimeOs,
  type ExtractFn
} from '../../src/main/services/runtime-download'
import { OcrInstallManager, type OcrPin } from '../../src/main/services/ocr-install'
import { writeRuntimeMarker, type FetchFn } from '../../src/main/services/assets'
import { createAuditRecorder } from '../../src/main/services/audit'
import { llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'
import { reportEngineProblem, resetEngineProblemsForTest } from '../../src/main/services/runtime/engine-load'
import { updateSettings } from '../../src/main/services/settings'
import type { Db } from '../../src/main/services/db'
import type { AppContext } from '../../src/main/services/context'
import type { EngineDownloadJob, OcrInstallJob } from '../../src/shared/types'
import { makeSizeOnlyZip } from '../helpers/archives'
import { bodyFetch, hangingFetch, runToEnd } from '../helpers/download-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { ctxWith, freshRoot, seededDb } from '../helpers/performance-fixture'
import { until } from '../helpers/hang-budget'

const handlers = ipcState.handlers as IpcHandlers
const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN = llamaServerBinaryName()
const BODY = 'engine-archive-bytes'
const SHA = createHash('sha256').update(BODY).digest('hex')
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const DEU = 'deu-bytes'
const ENG = 'eng-bytes'
const OCR_PINS: readonly OcrPin[] = [
  { lang: 'deu', sha256: sha256(DEU), sizeBytes: DEU.length },
  { lang: 'eng', sha256: sha256(ENG), sizeBytes: ENG.length }
]
/** Pushed through a failure's error text: it must never reach the log. */
const SENTINEL = 'XSENTINEL_843_ERROR_TEXT'

const ENGINE_KEYS = ['families', 'jobId', 'kind', 'sizeBytes', 'trigger', 'versions']
// `trigger: 'user'` on OCR rows too: the rows are permanent, and an app update will record the same types with its own.
const OCR_KEYS = ['bytes', 'jobId', 'languages', 'trigger']
const exe = (base: string): string => (HOST_OS === 'win' ? `${base}.exe` : base)

interface Row {
  type: string
  message: string
  metadata: Record<string, unknown>
}

interface Harness {
  root: string
  db: Db
  ctx: AppContext
  manager: EngineDownloadManager
  ocr: OcrInstallManager
  rows: () => Row[]
  allText: () => string
}

/**
 * A drive whose app pins pin the chat engine (with its size), the optional knowledge-pack tools and the two OCR
 * files; the engine IPC over a real DB.
 */
function harness(
  opts: { fetchImpl?: FetchFn; extract?: ExtractFn; ocrFetch?: FetchFn; locked?: () => boolean; auditThrows?: boolean; archive?: Buffer } = {}
): Harness {
  const root = freshRoot()
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'policy.json'), JSON.stringify({ network: { allow_model_downloads: true } }))
  const manifests = join(root, 'app-bundle', 'model-manifests')
  mkdirSync(manifests, { recursive: true })
  writeFileSync(
    join(manifests, 'runtime-sources.yaml'),
    stringify({
      llama_cpp: {
        version: 'b200',
        builds: [{ os: HOST_OS, arch: HOST_ARCH, backend: 'cpu', url: 'https://example.test/llama.zip', sha256: opts.archive ? createHash('sha256').update(opts.archive).digest('hex') : SHA, size_bytes: 3_000, extract_to: `runtime/llama.cpp/${HOST_OS}` }]
      },
      kiwix_tools: {
        version: '3.8.1',
        optional: true,
        executables: ['kiwix-serve', 'kiwix-manage'],
        builds: [{ os: HOST_OS, arch: HOST_ARCH, backend: 'cpu', url: 'https://example.test/kiwix.zip', sha256: SHA, size_bytes: 2_000, extract_to: `runtime/kiwix-tools/${HOST_OS}` }]
      },
      ocr: {
        version: '4.0.0_best_int',
        files: [
          { lang: 'deu', url: 'https://example.test/deu.traineddata.gz', sha256: OCR_PINS[0].sha256, dest: 'ocr/deu.traineddata.gz' },
          { lang: 'eng', url: 'https://example.test/eng.traineddata.gz', sha256: OCR_PINS[1].sha256, dest: 'ocr/eng.traineddata.gz' }
        ]
      }
    })
  )
  const db = seededDb(root)
  updateSettings(db, { allowNetwork: true })
  const locked = opts.locked ?? (() => false)
  const recorder = createAuditRecorder(() => {
    if (locked()) throw new Error('The workspace is locked.')
    return db
  })
  // `auditThrows`: a recorder that fails outright (the real one never throws; the callers must not depend on it).
  const audit: typeof recorder = opts.auditThrows
    ? () => {
        throw new Error('the audit sink failed')
      }
    : recorder
  const ctx = ctxWith(root, db, {
    paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'config') },
    manifestsDir: null,
    bundledManifestsDir: manifests,
    audit,
    embedder: {},
    runtime: {
      activeModelId: () => null,
      status: () => ({ running: false, modelId: null, startingModelId: null, port: null, healthy: false, message: '' }),
      stop: vi.fn(async () => undefined)
    }
  })
  handlers.clear()
  resetEngineProblemsForTest()
  const manager = new EngineDownloadManager({
    fetchImpl: opts.fetchImpl ?? (opts.archive ? archiveFetch(opts.archive) : bodyFetch(BODY)),
    extractImpl:
      opts.extract ??
      (async (_archive, destDir) => {
        const names = destDir.includes('kiwix-tools') ? [exe('kiwix-serve'), exe('kiwix-manage')] : [BIN]
        for (const name of names) await writeFile(join(destDir, name), 'binary')
      })
  })
  const ocr = new OcrInstallManager({
    pins: OCR_PINS,
    fetchImpl:
      opts.ocrFetch ??
      ((async (url: unknown) => new Response(String(url).includes('deu') ? DEU : ENG, { status: 200 })) as unknown as FetchFn)
  })
  registerEngineIpc(ctx, manager, { ocrInstaller: ocr })
  const rows = (): Row[] =>
    (db.prepare('SELECT event_type, message, metadata_json FROM runtime_events ORDER BY rowid').all() as Array<{ event_type: string; message: string; metadata_json: string | null }>).map((r) => ({
      type: r.event_type,
      message: r.message,
      metadata: JSON.parse(r.metadata_json ?? '{}') as Record<string, unknown>
    }))
  const allText = (): string =>
    (db.prepare("SELECT event_type || ' ' || message || ' ' || COALESCE(metadata_json, '') AS t FROM runtime_events").all() as Array<{ t: string }>)
      .map((r) => r.t)
      .join('\n')
  return { root, db, ctx, manager, ocr, rows, allText }
}

/** A download that serves `archive` byte for byte. */
function archiveFetch(archive: Buffer): FetchFn {
  return (async () =>
    new Response(new Uint8Array(archive), { status: 200, headers: { 'content-length': String(archive.length) } })) as unknown as FetchFn
}

const installRows = (h: Harness, prefix: 'engine_install' | 'ocr_install'): Row[] => h.rows().filter((r) => r.type.startsWith(prefix))

async function startEngine(h: Harness, payload?: unknown): Promise<EngineDownloadJob> {
  const { result } = payload === undefined ? await invoke(handlers, IPC.downloadEngine) : await invoke(handlers, IPC.downloadEngine, payload)
  return result as EngineDownloadJob
}

describe('engine installs in the activity log (#843)', () => {
  it('a finished install: started, then finished — code names, versions and counts, nothing else', async () => {
    const h = harness()
    const job = await startEngine(h)
    await runToEnd(h.manager, job.jobId)
    await until(() => installRows(h, 'engine_install').length === 2, 'the engine install events')
    const [started, finished] = installRows(h, 'engine_install')
    expect([started.type, finished.type]).toEqual(['engine_install_started', 'engine_install_finished'])
    for (const row of [started, finished]) {
      expect(Object.keys(row.metadata).sort()).toEqual(ENGINE_KEYS)
      expect(row.metadata).toEqual({ jobId: job.jobId, kind: 'install', families: ['llama_cpp'], versions: { llama_cpp: 'b200' }, sizeBytes: 3_000, trigger: 'user' })
      expect(row.message).toMatch(/^Engine install (started|finished): llama_cpp$/)
    }
  })

  it('an update and a reinstall say which they were', async () => {
    const h = harness()
    const dir = join(h.root, 'runtime', 'llama.cpp', HOST_OS)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, BIN), 'old engine')
    writeRuntimeMarker(dir, { version: 'b150', backend: 'cpu', os: HOST_OS, arch: HOST_ARCH })
    const job = await startEngine(h, { families: ['llama_cpp'], update: true })
    await runToEnd(h.manager, job.jobId)
    await until(() => installRows(h, 'engine_install').length === 2, 'the update events')
    expect(installRows(h, 'engine_install').map((r) => [r.type, r.metadata.kind])).toEqual([
      ['engine_install_started', 'update'],
      ['engine_install_finished', 'update']
    ])

    // #532: "Install … again" for an engine whose files the OS loader found damaged (a fresh drive: a copy
    // this session installed would read as "a fresh copy failed too", which offers no reinstall).
    const r = harness()
    const rDir = join(r.root, 'runtime', 'llama.cpp', HOST_OS)
    mkdirSync(rDir, { recursive: true })
    writeFileSync(join(rDir, BIN), 'damaged engine')
    writeRuntimeMarker(rDir, { version: 'b200', backend: 'cpu', os: HOST_OS, arch: HOST_ARCH })
    reportEngineProblem({ family: 'llama_cpp', reason: 'files-damaged', os: HOST_OS, exit: 'exit code 0xC0000135' }, join(rDir, BIN))
    const repair = await startEngine(r, { families: ['llama_cpp'], reinstall: true })
    await runToEnd(r.manager, repair.jobId)
    await until(() => installRows(r, 'engine_install').length === 2, 'the reinstall events')
    expect(installRows(r, 'engine_install').map((row) => [row.type, row.metadata.kind])).toEqual([
      ['engine_install_started', 'reinstall'],
      ['engine_install_finished', 'reinstall']
    ])
  })

  // The knowledge-pack tools install behind their own GPL consent dialog runs through the same engine job.
  it('a knowledge-pack tools install is recorded too, naming the tools family', async () => {
    const h = harness()
    const job = await startEngine(h, { families: ['kiwix_tools'] })
    await runToEnd(h.manager, job.jobId)
    await until(() => installRows(h, 'engine_install').length === 2, 'the tools install events')
    const rows = installRows(h, 'engine_install')
    expect(rows.map((r) => r.type)).toEqual(['engine_install_started', 'engine_install_finished'])
    for (const row of rows) {
      expect(row.metadata).toEqual({ jobId: job.jobId, kind: 'install', families: ['kiwix_tools'], versions: { kiwix_tools: '3.8.1' }, sizeBytes: 2_000, trigger: 'user' })
    }
  })

  it('a failure records a reason code — never the error text, the drive path or the URL failure', async () => {
    let driveRoot = ''
    const failing = (async () => {
      throw new Error(`connect ECONNRESET ${SENTINEL} near ${driveRoot}`)
    }) as unknown as FetchFn
    const h = harness({ fetchImpl: failing })
    driveRoot = h.root
    const job = await startEngine(h)
    const ended = await runToEnd(h.manager, job.jobId)
    // The flow really carried both: they are in the job's own (renderer-facing) error.
    expect(ended.status).toBe('failed')
    expect(ended.error).toContain(SENTINEL)
    expect(ended.error).toContain(h.root)
    await until(() => installRows(h, 'engine_install').length === 2, 'the failure event')
    const failed = installRows(h, 'engine_install')[1]
    expect(failed.type).toBe('engine_install_failed')
    expect(Object.keys(failed.metadata).sort()).toEqual([...ENGINE_KEYS, 'cause', 'reason'].sort())
    expect(failed.metadata).toMatchObject({ reason: 'download', cause: 'network', kind: 'install' })
    const text = h.allText()
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain(h.root)
    expect(text).not.toContain(ended.error ?? '')
  })

  it('a checksum mismatch, a cancel and internet access switched off each fail with their own reason', async () => {
    const mismatch = harness({ fetchImpl: bodyFetch('other bytes') })
    const m = await startEngine(mismatch)
    await runToEnd(mismatch.manager, m.jobId)
    await until(() => installRows(mismatch, 'engine_install').length === 2, 'the mismatch event')
    expect(installRows(mismatch, 'engine_install')[1].metadata.reason).toBe('checksumMismatch')

    for (const [label, stop, reason] of [
      ['cancel', (_h: Harness, id: string) => void invoke(handlers, IPC.cancelEngineDownload, id), 'cancelled'],
      ['network off', (h: Harness, _id: string) => h.ctx.installsNetworkSwitched?.(false, () => undefined), 'networkOff']
    ] as const) {
      const h = harness({ fetchImpl: hangingFetch('part') })
      const job = await startEngine(h)
      await until(() => h.manager.get(job.jobId).status === 'downloading', `${label}: the download running`)
      // The start is on record while the job still runs, not only once it ends.
      expect(installRows(h, 'engine_install').map((r) => r.type)).toEqual(['engine_install_started'])
      stop(h, job.jobId)
      await runToEnd(h.manager, job.jobId)
      await until(() => installRows(h, 'engine_install').length === 2, `${label}: the stop event`)
      const [started, failed] = installRows(h, 'engine_install')
      expect(started.type).toBe('engine_install_started')
      expect(failed.type, label).toBe('engine_install_failed')
      expect(failed.metadata.reason, label).toBe(reason)
    }
  })

  // #986: a drive without room to unpack refuses before anything is touched; the record keeps the two byte
  // counts the message named (counts, never the message).
  it('a drive without room to unpack records noSpace with the bytes needed and free', async () => {
    const h = harness({ archive: makeSizeOnlyZip(10_000, 0xfffffffe) })
    const job = await startEngine(h)
    expect((await runToEnd(h.manager, job.jobId)).status).toBe('failed')
    await until(() => installRows(h, 'engine_install').length === 2, 'the no-room event')
    const failed = installRows(h, 'engine_install')[1]
    expect(failed.type).toBe('engine_install_failed')
    expect(Object.keys(failed.metadata).sort()).toEqual([...ENGINE_KEYS, 'freeBytes', 'neededBytes', 'reason'].sort())
    expect(failed.metadata.reason).toBe('noSpace')
    expect(failed.metadata.neededBytes as number).toBeGreaterThan(failed.metadata.freeBytes as number)
    expect(h.allText()).not.toContain(h.manager.get(job.jobId).error ?? '')
  })

  // Round 2: an unexpected failure outside every step that records a reason (here the spawn gate, between the
  // downloads and the swap) used to leave the job reading 'extracting' and be logged as an install failure.
  it('a failure outside a recorded step ends the job failed, recorded as internal, not as an install failure', async () => {
    const h = harness()
    spawnGate.throwOnHold = true
    try {
      const job = await startEngine(h)
      const ended = await runToEnd(h.manager, job.jobId)
      expect(ended.status).toBe('failed')
      await until(() => installRows(h, 'engine_install').length === 2, 'the failure event')
      expect(installRows(h, 'engine_install')[1]).toMatchObject({ type: 'engine_install_failed', metadata: { reason: 'internal' } })
      expect(h.allText()).not.toContain('the spawn gate failed')
      // #1000: the gate is taken after every copy is staged, so an unexpected throw there still leaves no
      // staged copy behind (the job's cleanup runs in a `finally`).
      await until(() => h.manager.activeJob() === null, 'the job settled')
      await engineFolderDeletesSettled()
      expect(existsSync(`${join(h.root, 'runtime', 'llama.cpp', HOST_OS)}.new`)).toBe(false)
    } finally {
      spawnGate.throwOnHold = false
    }
    // The manager is free again: the next install runs.
    const next = await startEngine(h)
    expect((await runToEnd(h.manager, next.jobId)).status).toBe('done')
  })

  it('a failing audit sink never fails the install: the job starts, runs and settles, and the next one is accepted', async () => {
    const h = harness({ auditThrows: true })
    const job = await startEngine(h)
    expect((await runToEnd(h.manager, job.jobId)).status).toBe('done')
    rmSync(join(h.root, 'runtime'), { recursive: true, force: true })
    const next = await startEngine(h)
    expect((await runToEnd(h.manager, next.jobId)).status).toBe('done')
  })

  it('a request refused before a job exists records nothing (a closed gate, nothing to install)', async () => {
    const h = harness()
    updateSettings(h.db, { allowNetwork: false })
    await expect(startEngine(h)).rejects.toThrow()
    updateSettings(h.db, { allowNetwork: true })
    await expect(startEngine(h, { families: ['llama_cpp'], update: true })).rejects.toThrow()
    expect(installRows(h, 'engine_install')).toEqual([])
  })
})

describe('OCR installs in the activity log (#843)', () => {
  async function startOcr(): Promise<OcrInstallJob> {
    return (await invoke(handlers, IPC.installOcr)).result as OcrInstallJob
  }

  it('a finished install: started, then finished — language codes and byte counts', async () => {
    const h = harness()
    const job = await startOcr()
    await runToEnd(h.ocr, job.jobId)
    await until(() => installRows(h, 'ocr_install').length === 2, 'the OCR events')
    const [started, finished] = installRows(h, 'ocr_install')
    expect(started).toMatchObject({ type: 'ocr_install_started', metadata: { jobId: job.jobId, languages: ['deu', 'eng'], bytes: DEU.length + ENG.length, trigger: 'user' } })
    expect(Object.keys(started.metadata).sort()).toEqual(OCR_KEYS)
    expect(finished.type).toBe('ocr_install_finished')
    expect(Object.keys(finished.metadata).sort()).toEqual([...OCR_KEYS, 'outcome'].sort())
    expect(finished.metadata.trigger).toBe('user')
  })

  it('a failure, a cancel and internet access switched off each record their reason, never the error text', async () => {
    const bad = harness({ ocrFetch: bodyFetch('not the pinned bytes') })
    const job = await startOcr()
    const ended = await runToEnd(bad.ocr, job.jobId)
    expect(ended.status).toBe('failed')
    await until(() => installRows(bad, 'ocr_install').length === 2, 'the OCR failure event')
    const failed = installRows(bad, 'ocr_install')[1]
    expect(failed).toMatchObject({ type: 'ocr_install_failed', metadata: { reason: 'checksumMismatch', cause: 'mismatch', trigger: 'user' } })
    expect(Object.keys(failed.metadata).sort()).toEqual([...OCR_KEYS, 'cause', 'reason'].sort())

    // A download failure whose error names the drive and carries the sentinel: only the codes reach the log.
    let driveRoot = ''
    const broken = harness({
      ocrFetch: (async () => {
        throw new Error(`connect ECONNRESET ${SENTINEL} near ${driveRoot}`)
      }) as unknown as FetchFn
    })
    driveRoot = broken.root
    const down = await startOcr()
    await runToEnd(broken.ocr, down.jobId)
    await until(() => installRows(broken, 'ocr_install').length === 2, 'the OCR download failure event')
    expect(installRows(broken, 'ocr_install')[1].metadata).toMatchObject({ reason: 'downloadFailed', cause: 'network' })
    expect(broken.allText()).not.toContain(SENTINEL)
    expect(broken.allText()).not.toContain(broken.root)

    for (const [label, stop, reason] of [
      ['cancel', (id: string, _h: Harness) => void invoke(handlers, IPC.cancelOcrInstall, id), 'cancelled'],
      ['network off', (_id: string, h: Harness) => h.ctx.installsNetworkSwitched?.(false, () => undefined), 'networkOff']
    ] as const) {
      const h = harness({ ocrFetch: hangingFetch('part') })
      const live = await startOcr()
      await until(() => h.ocr.get(live.jobId).status === 'downloading', `${label}: the download running`)
      stop(live.jobId, h)
      await runToEnd(h.ocr, live.jobId)
      await until(() => installRows(h, 'ocr_install').length === 2, `${label}: the stop event`)
      expect(installRows(h, 'ocr_install').map((r) => r.type)).toEqual(['ocr_install_started', 'ocr_install_failed'])
      expect(installRows(h, 'ocr_install')[1].metadata.reason, label).toBe(reason)
    }
  })

  it('a failing audit sink never fails the install: the job starts, runs and settles, and the next one is accepted', async () => {
    const h = harness({ auditThrows: true })
    const job = await startOcr()
    expect((await runToEnd(h.ocr, job.jobId)).status).toBe('done')
    rmSync(join(h.root, 'ocr'), { recursive: true, force: true })
    const next = await startOcr()
    expect((await runToEnd(h.ocr, next.jobId)).status).toBe('done')
  })

  it('a lock in the middle of an install loses nothing: the events are kept and written after the unlock', async () => {
    let isLocked = false
    const h = harness({ locked: () => isLocked })
    const job = await startOcr()
    isLocked = true
    await runToEnd(h.ocr, job.jobId)
    expect(installRows(h, 'ocr_install').map((r) => r.type)).toEqual(['ocr_install_started'])
    // The next event after the unlock flushes what waited, in order and with its own time.
    isLocked = false
    h.ctx.audit?.('workspace_unlocked', 'Workspace unlocked')
    expect(h.rows().map((r) => r.type)).toEqual(['ocr_install_started', 'ocr_install_finished', 'workspace_unlocked'])
  })
})
