import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'

// #339 P8-2 — the consent step's IPC contract, through the REAL `downloadEngine` handler:
//
//   1. `{ families: ['kiwix_tools'] }` installs the optional family and nothing else, and ONE
//      knowledge-pack reconcile follows the completed install (the searchability cache key
//      carries the tools fingerprint — D-Z11/D-Z15 — so the packs re-probe with the new bundle);
//   2. the argument-less call (the "Install the AI engine" button) still NEVER fetches kiwix;
//   3. the payload is renderer input: an unknown family, an empty list, a duplicate, a
//      non-object or a non-list `families` is refused before any gate or network is touched;
//   4. `kiwixToolsActive` is wired from the per-family sidecar PID registry (P8-1 R-e): a live
//      kiwix child refuses the install with the friendly copy, an unregistered one admits it;
//   5. `getEngineStatus` carries `optionalFamilies` — size from the pin's `size_bytes`, the
//      code-side licence, the pinned URL — and `installed` flips after the install.
//
// Electron is mocked so `ipcMain.handle` records handlers; the network and the extraction are
// fakes (zero-network, no shell-out), the DB and policy are real files under a temp root.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { IPC } from '../../src/shared/ipc'
import { registerEngineIpc } from '../../src/main/ipc/registerEngineIpc'
import { EngineDownloadManager, hostRuntimeArch, hostRuntimeOs, type ExtractFn } from '../../src/main/services/runtime-download'
import type { FetchFn } from '../../src/main/services/assets'
import { llamaServerBinaryName, registerSidecarChild, unregisterSidecarChild } from '../../src/main/services/runtime/sidecar'
import { updateSettings } from '../../src/main/services/settings'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { closePerformanceFixture, ctxWith, freshRoot, seededDb } from '../helpers/performance-fixture'
import type { EngineDownloadJob, EngineStatus } from '../../src/shared/types'

const handlers = ipcState.handlers as IpcHandlers
const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN_NAME = llamaServerBinaryName()
const exe = (base: string): string => (HOST_OS === 'win' ? `${base}.exe` : base)
const KIWIX_FILES = [exe('kiwix-serve'), exe('kiwix-manage'), exe('kiwix-search'), 'icudt74.dll']
const BODY = 'archive-bytes'
const SHA = createHash('sha256').update(BODY).digest('hex')
const KIWIX_SIZE = 18_301_924

const okFetch: FetchFn = async () => new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length) } })
/** Drops the family's declared files at the extract root (the flat-zip shape). */
const extractAll: ExtractFn = async (_archive, destDir) => {
  await mkdir(destDir, { recursive: true })
  for (const f of [BIN_NAME, ...KIWIX_FILES]) await writeFile(join(destDir, f), `bytes of ${f}`)
}

interface Drive {
  root: string
  handlers: IpcHandlers
  manager: EngineDownloadManager
  fetchSpy: ReturnType<typeof vi.fn>
  reconcile: ReturnType<typeof vi.fn>
}

/** A drive whose yaml pins the chat engine + the optional kiwix_tools family for this host,
 *  with a policy that allows downloads and the network setting on; the engine IPC registered
 *  over a real DB. `ctx.zim` is a stub whose `reconcile` the completed-install hook must call. */
function makeDrive(): Drive {
  const root = freshRoot()
  const manifests = join(root, 'model-manifests')
  mkdirSync(manifests, { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'policy.json'), JSON.stringify({ network: { allow_model_downloads: true } }))
  writeFileSync(
    join(manifests, 'runtime-sources.yaml'),
    stringify({
      llama_cpp: {
        version: 'btest',
        builds: [{ os: HOST_OS, arch: HOST_ARCH, backend: 'cpu', url: 'https://example.test/llama.zip', sha256: SHA, extract_to: `runtime/llama.cpp/${HOST_OS}` }]
      },
      kiwix_tools: {
        version: '3.8.1',
        optional: true,
        executables: ['kiwix-serve', 'kiwix-manage', 'kiwix-search'],
        builds: [
          {
            os: HOST_OS,
            arch: HOST_ARCH,
            backend: 'cpu',
            url: 'https://download.kiwix.org/release/kiwix-tools/kiwix-tools_test-3.8.1.zip',
            sha256: SHA,
            size_bytes: KIWIX_SIZE,
            extract_to: `runtime/kiwix-tools/${HOST_OS}`,
            runtime_files: ['icudt74.dll']
          }
        ]
      }
    })
  )
  const db = seededDb(root)
  updateSettings(db, { allowNetwork: true })
  const reconcile = vi.fn(async () => undefined)
  const fetchSpy = vi.fn(okFetch)
  const ctx = ctxWith(root, db, {
    paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'config') },
    manifestsDir: manifests,
    runtime: { activeModelId: () => null, status: () => ({ running: false, modelId: null, startingModelId: null, port: null, healthy: false, message: '' }) },
    zim: { reconcile }
  })
  handlers.clear()
  const manager = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn, extractImpl: extractAll })
  registerEngineIpc(ctx, manager)
  return { root, handlers, manager, fetchSpy, reconcile }
}

async function settle(d: Drive, job: EngineDownloadJob): Promise<EngineDownloadJob> {
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(d.manager.get(job.jobId).status), { timeout: 5000 })
  return d.manager.get(job.jobId)
}

const kiwixDir = (root: string): string => join(root, 'runtime', 'kiwix-tools', HOST_OS)
const llamaBin = (root: string): string => join(root, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME)

afterEach(async () => {
  await closePerformanceFixture()
})

describe('downloadEngine({ families }) — the consent step (#339 P8-2)', () => {
  it('installs the optional kiwix_tools family on an explicit request and reconciles the packs once afterwards', async () => {
    const d = makeDrive()
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['kiwix_tools'] })
    const job = await settle(d, result as EngineDownloadJob)
    expect(job.status).toBe('done')
    for (const f of KIWIX_FILES) expect(existsSync(join(kiwixDir(d.root), f)), f).toBe(true)
    // Only the requested family: the chat engine was NOT fetched by a kiwix request.
    expect(existsSync(llamaBin(d.root))).toBe(false)
    expect(d.fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(d.fetchSpy.mock.calls[0]?.[0])).toContain('download.kiwix.org')
    // The completed install re-probes the packs with the new bundle — exactly once.
    await vi.waitFor(() => expect(d.reconcile).toHaveBeenCalledTimes(1))
  })

  it('the argument-less call still never fetches kiwix_tools, and installing the chat engine reconciles nothing', async () => {
    const d = makeDrive()
    const { result } = await invoke(d.handlers, IPC.downloadEngine)
    const job = await settle(d, result as EngineDownloadJob)
    expect(job.status).toBe('done')
    expect(existsSync(llamaBin(d.root))).toBe(true)
    expect(existsSync(kiwixDir(d.root))).toBe(false)
    expect(d.fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(d.fetchSpy.mock.calls[0]?.[0])).not.toContain('kiwix')
    await new Promise((r) => setTimeout(r, 20))
    expect(d.reconcile).not.toHaveBeenCalled()
  })

  it('refuses a malformed payload before any gate or network is touched', async () => {
    const d = makeDrive()
    const bad: unknown[] = [
      { families: ['../kiwix_tools'] },
      { families: ['kiwix-tools'] },
      { families: [] },
      { families: ['kiwix_tools', 'kiwix_tools'] },
      { families: 'kiwix_tools' },
      'kiwix_tools',
      ['kiwix_tools'],
      42
    ]
    for (const payload of bad) {
      await expect(invoke(d.handlers, IPC.downloadEngine, payload), JSON.stringify(payload)).rejects.toThrow(/was not understood/i)
    }
    expect(d.fetchSpy).not.toHaveBeenCalled()
    expect(d.manager.activeJob()).toBeNull()
  })

  it('is refused while a kiwix child is registered in the sidecar PID registry, and admitted once it is gone', async () => {
    const d = makeDrive()
    registerSidecarChild(7339, 'kiwix_tools')
    try {
      await expect(invoke(d.handlers, IPC.downloadEngine, { families: ['kiwix_tools'] })).rejects.toThrow(/knowledge-pack tools/i)
      expect(d.fetchSpy).not.toHaveBeenCalled()
      // A live kiwix child does not block the CHAT engine.
      const { result } = await invoke(d.handlers, IPC.downloadEngine)
      expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
    } finally {
      unregisterSidecarChild(7339)
    }
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['kiwix_tools'] })
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
  })

  it('getEngineStatus states what the dialog shows: the pinned size, the code-side licence, the pinned URL, and installed flips', async () => {
    const d = makeDrive()
    const before = (await invoke(d.handlers, IPC.getEngineStatus)).result as EngineStatus
    expect(before.missingOptionalFamilies).toEqual(['kiwix_tools'])
    expect(before.optionalFamilies).toEqual([
      {
        family: 'kiwix_tools',
        version: '3.8.1',
        sizeBytes: KIWIX_SIZE,
        url: 'https://download.kiwix.org/release/kiwix-tools/kiwix-tools_test-3.8.1.zip',
        license: 'GPL-3.0-or-later',
        installed: false
      }
    ])
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['kiwix_tools'] })
    await settle(d, result as EngineDownloadJob)
    const after = (await invoke(d.handlers, IPC.getEngineStatus)).result as EngineStatus
    expect(after.missingOptionalFamilies).toEqual([])
    expect(after.optionalFamilies?.[0]?.installed).toBe(true)
    // Readiness is still the chat family's fact alone (P8-1 ruling 3): kiwix changed nothing.
    expect(after.installed).toBe(false)
    expect(after.missingFamilies).toEqual(['llama_cpp'])
  })
})
