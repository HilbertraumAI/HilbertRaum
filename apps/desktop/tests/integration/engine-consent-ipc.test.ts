import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { SIDECAR_FAMILY_SPECS, writeRuntimeMarker, type FetchFn } from '../../src/main/services/assets'
import { llamaServerBinaryName, registerSidecarChild, unregisterSidecarChild } from '../../src/main/services/runtime/sidecar'
import { whisperCliBinaryName } from '../../src/main/services/transcriber'
import type { AppContext } from '../../src/main/services/context'
import { clearModelLoadLatches, latchModelLoad, modelLoadLatchReason } from '../../src/main/services/runtime/factory'
import { engineProblemFor, reportEngineProblem, resetEngineProblemsForTest } from '../../src/main/services/runtime/engine-load'
import { updateSettings } from '../../src/main/services/settings'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { closePerformanceFixture, ctxWith, freshRoot, seededDb } from '../helpers/performance-fixture'
import type { EngineDownloadJob, EngineProblem, EngineStatus, RuntimeStatus } from '../../src/shared/types'

const handlers = ipcState.handlers as IpcHandlers
const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN_NAME = llamaServerBinaryName()
const WHISPER_BIN = whisperCliBinaryName()
const exe = (base: string): string => (HOST_OS === 'win' ? `${base}.exe` : base)
const KIWIX_FILES = [exe('kiwix-serve'), exe('kiwix-manage'), exe('kiwix-search'), 'icudt74.dll']
const BODY = 'archive-bytes'
const SHA = createHash('sha256').update(BODY).digest('hex')
const KIWIX_SIZE = 18_301_924

const okFetch: FetchFn = async () => new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length) } })
/** Drops the family's declared files at the extract root (the flat-zip shape). */
const extractAll: ExtractFn = async (_archive, destDir) => {
  await mkdir(destDir, { recursive: true })
  for (const f of [BIN_NAME, WHISPER_BIN, ...KIWIX_FILES]) await writeFile(join(destDir, f), `bytes of ${f}`)
}

/** A minimal VALID transcriber manifest for the #497 case (JSON is YAML). */
const WHISPER_MANIFEST = {
  id: 'whisper-test',
  display_name: 'Whisper (test)',
  family: 'whisper',
  role: 'transcriber',
  format: 'ggml',
  runtime: 'whisper_cpp',
  license: 'mit',
  size_on_disk_gb: 0.1,
  recommended_min_ram_gb: 1,
  recommended_ram_gb: 2,
  recommended_context_tokens: 0,
  local_path: 'models/transcriber/whisper-test.bin',
  sha256: 'REPLACE_WITH_REAL_HASH',
  recommended_profiles: [],
  license_review: { status: 'approved', reviewed_by: 'test', reviewed_at: '2026-09-21', notes: '' }
}

/** A chat model whose weight is NOT on the drive: a developer start falls back to the demo runtime. */
const CHAT_MANIFEST = {
  ...WHISPER_MANIFEST,
  id: 'chat-test',
  display_name: 'Chat (test)',
  family: 'qwen',
  role: 'chat',
  format: 'gguf',
  runtime: 'llama_cpp',
  recommended_context_tokens: 4096,
  local_path: 'models/chat/chat-test.gguf'
}

interface Drive {
  root: string
  handlers: IpcHandlers
  manager: EngineDownloadManager
  fetchSpy: ReturnType<typeof vi.fn>
  reconcile: ReturnType<typeof vi.fn>
  ctx: AppContext
}

/**
 * #532: the selected chat model answering on the demo runtime — what runs while the engine is
 * missing or refused. `stop`/`start` record the restart the completed install must make.
 */
function demoRuntime(): { status: () => RuntimeStatus; activeModelId: () => string; stop: Mock; start: Mock } {
  return {
    activeModelId: () => 'chat-test',
    status: () => ({ running: true, modelId: 'chat-test', backend: 'mock', startingModelId: null, port: null, healthy: true, message: 'Running' }),
    stop: vi.fn(async () => undefined),
    start: vi.fn(async () => ({ running: true, modelId: 'chat-test', port: null, healthy: true, message: 'Running' }))
  }
}

/** A drive whose yaml pins the chat engine + the optional kiwix_tools family for this host,
 *  with a policy that allows downloads and the network setting on; the engine IPC registered
 *  over a real DB. `ctx.zim` is a stub whose `reconcile` the completed-install hook must call.
 *  `withWhisper` (#497) also pins the whisper_cpp family and provisions the speech model's
 *  manifest + weight, so only the voice ENGINE is missing — the "Install voice engine" case. */
function makeDrive(
  opts: { withWhisper?: boolean; runtime?: unknown; llamaVersion?: string; extract?: ExtractFn } = {}
): Drive {
  const root = freshRoot()
  const manifests = join(root, 'model-manifests')
  mkdirSync(manifests, { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  // `models`: a developer may start a model whose weight is missing (the demo-runtime journey, #532).
  writeFileSync(
    join(root, 'config', 'policy.json'),
    JSON.stringify({
      network: { allow_model_downloads: true },
      models: { allow_unverified_models: true, require_manifest: true, require_sha256_match: false }
    })
  )
  writeFileSync(join(manifests, 'chat-test.yaml'), JSON.stringify(CHAT_MANIFEST))
  if (opts.withWhisper) {
    writeFileSync(join(manifests, 'whisper-test.yaml'), JSON.stringify(WHISPER_MANIFEST))
    mkdirSync(join(root, 'models', 'transcriber'), { recursive: true })
    writeFileSync(join(root, 'models', 'transcriber', 'whisper-test.bin'), 'ggml-bytes')
  }
  writeFileSync(
    join(manifests, 'runtime-sources.yaml'),
    stringify({
      llama_cpp: {
        version: opts.llamaVersion ?? 'btest',
        builds: [{ os: HOST_OS, arch: HOST_ARCH, backend: 'cpu', url: 'https://example.test/llama.zip', sha256: SHA, extract_to: `runtime/llama.cpp/${HOST_OS}` }]
      },
      ...(opts.withWhisper
        ? {
            whisper_cpp: {
              version: 'wtest',
              builds: [{ os: HOST_OS, arch: HOST_ARCH, backend: 'cpu', url: 'https://example.test/whisper.zip', sha256: SHA, extract_to: `runtime/whisper.cpp/${HOST_OS}` }]
            }
          }
        : {}),
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
    runtime: opts.runtime ?? { activeModelId: () => null, status: () => ({ running: false, modelId: null, startingModelId: null, port: null, healthy: false, message: '' }) },
    zim: { reconcile },
    // #497: the startup composition found no whisper-cli, so the slot is null until an install.
    transcriber: null
  })
  handlers.clear()
  const manager = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn, extractImpl: opts.extract ?? extractAll })
  registerEngineIpc(ctx, manager)
  return { root, handlers, manager, fetchSpy, reconcile, ctx }
}

describe('a completed whisper_cpp install activates dictation without a restart (#497)', () => {
  it('fills the null transcriber slot the moment the voice engine is on the drive', async () => {
    const d = makeDrive({ withWhisper: true })
    expect(d.ctx.transcriber).toBeNull()
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['whisper_cpp'] })
    const job = await settle(d, result as EngineDownloadJob)
    expect(job.status).toBe('done')
    expect(existsSync(join(d.root, 'runtime', 'whisper.cpp', HOST_OS, WHISPER_BIN))).toBe(true)
    // The completed install re-ran the transcriber selector — binary + weights are both present now.
    await vi.waitFor(() => expect(d.ctx.transcriber).not.toBeNull())
    expect(d.ctx.transcriber?.id).toBe('whisper-test')
    // Only the requested family was fetched; the packs reconcile is the kiwix hook's, not this one's.
    expect(d.fetchSpy).toHaveBeenCalledTimes(1)
    expect(d.reconcile).not.toHaveBeenCalled()
  })

  it('a chat-engine install leaves the slot alone (the speech model is still unusable without whisper-cli)', async () => {
    const d = makeDrive({ withWhisper: true })
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'] })
    const job = await settle(d, result as EngineDownloadJob)
    expect(job.status).toBe('done')
    await new Promise((r) => setTimeout(r, 20))
    expect(d.ctx.transcriber).toBeNull()
  })
})

async function settle(d: Drive, job: EngineDownloadJob): Promise<EngineDownloadJob> {
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(d.manager.get(job.jobId).status), { timeout: 5000 })
  return d.manager.get(job.jobId)
}

const kiwixDir = (root: string): string => join(root, 'runtime', 'kiwix-tools', HOST_OS)
const llamaBin = (root: string): string => join(root, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME)

afterEach(async () => {
  resetEngineProblemsForTest()
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
    // #372: a new runtime binary may load what the old one could not — the completed
    // chat-engine install re-arms EVERY model the ladder latched as unloadable this session.
    latchModelLoad('a', 'unknown model architecture')
    latchModelLoad('b', 'unknown model architecture')
    const { result } = await invoke(d.handlers, IPC.downloadEngine)
    const job = await settle(d, result as EngineDownloadJob)
    expect(job.status).toBe('done')
    expect(existsSync(llamaBin(d.root))).toBe(true)
    expect(existsSync(kiwixDir(d.root))).toBe(false)
    expect(d.fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(d.fetchSpy.mock.calls[0]?.[0])).not.toContain('kiwix')
    await new Promise((r) => setTimeout(r, 20))
    expect(d.reconcile).not.toHaveBeenCalled()
    expect(modelLoadLatchReason('a')).toBeNull()
    expect(modelLoadLatchReason('b')).toBeNull()
  })

  it('installing only the optional kiwix_tools family leaves the #372 latch alone (no new chat runtime)', async () => {
    const d = makeDrive()
    latchModelLoad('a', 'unknown model architecture')
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['kiwix_tools'] })
    const job = await settle(d, result as EngineDownloadJob)
    expect(job.status).toBe('done')
    await vi.waitFor(() => expect(d.reconcile).toHaveBeenCalledTimes(1))
    expect(modelLoadLatchReason('a')).toBe('unknown model architecture')
    clearModelLoadLatches()
  })

  it('refuses a malformed payload before any gate or network is touched', async () => {
    const d = makeDrive()
    const bad: unknown[] = [
      { families: ['../kiwix_tools'] },
      { families: ['kiwix-tools'] },
      { families: [] },
      { families: ['kiwix_tools', 'kiwix_tools'] },
      // An optional family never rides with a required one: the dialog sends kiwix alone,
      // the engine button sends nothing — a mixed payload blurs which request was consented.
      { families: ['llama_cpp', 'kiwix_tools'] },
      { families: 'kiwix_tools' },
      { families: { length: 1, 0: 'kiwix_tools' } },
      'kiwix_tools',
      ['kiwix_tools'],
      42,
      // #532: a reinstall names its families explicitly, never reaches an optional family, and
      // is a real boolean.
      { reinstall: true },
      { families: ['kiwix_tools'], reinstall: true },
      { families: ['llama_cpp'], reinstall: 'yes' }
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
    // `installed` means EVERY declared file — the panel's own `toolsInstalled` needs serve AND
    // manage, and the consent row must never say "installed" while the panel says "missing".
    rmSync(join(kiwixDir(d.root), exe('kiwix-manage')))
    const half = (await invoke(d.handlers, IPC.getEngineStatus)).result as EngineStatus
    expect(half.optionalFamilies?.[0]?.installed).toBe(false)
  })

  it('every optional family the code declares carries the licence its consent dialog names, and it is the one the drive notices state', () => {
    const optional = SIDECAR_FAMILY_SPECS.filter((s) => s.optional === true)
    expect(optional.map((s) => s.family)).toEqual(['kiwix_tools'])
    for (const spec of optional) expect(spec.license, spec.family).toMatch(/^[A-Za-z0-9.+-]+$/)
    const notices = readFileSync(join(__dirname, '..', '..', '..', '..', 'DRIVE-NOTICES.md'), 'utf8')
    expect(notices).toContain(`### kiwix-tools 3.8.1 — ${SIDECAR_FAMILY_SPECS.find((s) => s.family === 'kiwix_tools')?.license}`)
  })
})

// #530: the  handler and the install hook's verdict/latch handling.
describe('engine load verdicts over IPC (#530)', () => {
  const LLAMA_PROBLEM = { family: 'llama_cpp', reason: 'library-missing', os: 'linux', name: 'libgomp.so.1', exit: 'exit code 127' } as const

  it('engine:recheck is registered and refuses while the workspace does not admit work', async () => {
    const d = makeDrive()
    expect(d.handlers.has(IPC.recheckEngine)).toBe(true)
    ;(d.ctx as unknown as { workspace: unknown }).workspace = { isUnlocked: () => false }
    await expect(invoke(d.handlers, IPC.recheckEngine)).rejects.toThrow(/locked/i)
    ;(d.ctx as unknown as { workspace: unknown }).workspace = { isUnlocked: () => true, isLocking: () => true }
    await expect(invoke(d.handlers, IPC.recheckEngine)).rejects.toThrow(/locked/i)
  })

  it('engine:recheck with no verdicts answers an empty problem list', async () => {
    const d = makeDrive()
    const { result } = await invoke(d.handlers, IPC.recheckEngine)
    expect(result).toEqual({ problems: [] })
  })

  it('a completed chat-engine install drops the old binary verdict and re-arms the consumers', async () => {
    const d = makeDrive()
    const resetStartFailure = vi.fn()
    Object.assign(d.ctx, { embedder: { resetStartFailure }, reranker: { resetStartFailure }, vision: { resetStartFailure } })
    reportEngineProblem(LLAMA_PROBLEM)
    reportEngineProblem({ ...LLAMA_PROBLEM, family: 'whisper_cpp' })
    const { result } = await invoke(d.handlers, IPC.downloadEngine)
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
    await vi.waitFor(() => expect(resetStartFailure).toHaveBeenCalledTimes(3))
    expect(engineProblemFor('llama_cpp')).toBeNull()
    // Only the family that was installed loses its verdict.
    expect(engineProblemFor('whisper_cpp')).not.toBeNull()
  })

  it('a completed voice-engine install drops only the voice verdict', async () => {
    const d = makeDrive({ withWhisper: true })
    reportEngineProblem(LLAMA_PROBLEM)
    reportEngineProblem({ ...LLAMA_PROBLEM, family: 'whisper_cpp' })
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['whisper_cpp'] })
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
    expect(engineProblemFor('whisper_cpp')).toBeNull()
    expect(engineProblemFor('llama_cpp')).not.toBeNull()
  })
})

// #532: "Install the AI engine again" — the repair for an engine on the drive whose own files the
// OS loader found missing or damaged. Before it, a present engine with a current marker could never
// be installed again, and the demo runtime standing in for it counted as "a model is running".
describe('downloadEngine({ families, reinstall }) — the damaged-files repair (#532)', () => {
  const DAMAGED: EngineProblem = { family: 'llama_cpp', reason: 'files-damaged', os: HOST_OS, exit: 'exit code 0xC0000135' }

  /** Install the chat engine once, so it is on the drive and current by its marker. */
  async function installChatEngine(d: Drive): Promise<void> {
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'] })
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
    d.fetchSpy.mockClear()
  }

  it('re-fetches a present, current engine whose files are damaged: the old copy goes, cpu/ stays, the fresh copy is remembered', async () => {
    const d = makeDrive()
    await installChatEngine(d)
    const dir = join(d.root, 'runtime', 'llama.cpp', HOST_OS)
    writeFileSync(join(dir, 'leftover-of-the-old-copy.dll'), 'old')
    mkdirSync(join(dir, 'cpu'), { recursive: true })
    writeFileSync(join(dir, 'cpu', BIN_NAME), 'the safety net')
    // Without the flag a current engine is never installed again — the dead end #532 removes.
    await expect(invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'] })).rejects.toThrow(/already installed/i)
    reportEngineProblem(DAMAGED, llamaBin(d.root))

    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'], reinstall: true })
    // The job says what it is, so the screen shows its progress in the banner that started it.
    expect(result).toMatchObject({ families: ['llama_cpp'], reinstall: true })
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
    expect(d.fetchSpy).toHaveBeenCalledTimes(1)
    expect(existsSync(join(dir, 'leftover-of-the-old-copy.dll'))).toBe(false)
    expect(readFileSync(join(dir, 'cpu', BIN_NAME), 'utf8')).toBe('the safety net') // owner: main build only
    expect(engineProblemFor('llama_cpp')).toBeNull()
    // The fresh copy is the program every spawn site resolves: should IT be refused as damaged
    // too, the verdict says so — and the screen offers no second reinstall.
    reportEngineProblem(DAMAGED, llamaBin(d.root))
    expect(engineProblemFor('llama_cpp')?.afterInstall).toBe(true)
  })

  it.each<[string, EngineProblem | null]>([
    ['no verdict at all', null],
    ['a verdict a reinstall cannot fix (a missing system library)', { ...DAMAGED, reason: 'library-missing', name: 'libgomp.so.1' }],
    ['a damaged-files verdict for the OTHER engine only', { ...DAMAGED, family: 'whisper_cpp' }]
  ])('is refused with %s — nothing is fetched', async (_label, problem) => {
    const d = makeDrive()
    await installChatEngine(d)
    if (problem) reportEngineProblem(problem)
    await expect(
      invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'], reinstall: true })
    ).rejects.toThrow(/nothing to repair/i)
    expect(d.fetchSpy).not.toHaveBeenCalled()
  })

  it('is admitted while the demo runtime stands in for the model, and the model restarts on the engine afterwards', async () => {
    const runtime = demoRuntime()
    const d = makeDrive({ runtime })
    // The engine is missing, so the selected model answers in demo mode — before #532 the install
    // was refused here with "stop the model first" (CODE-13's registered polish candidate).
    const { result } = await invoke(d.handlers, IPC.downloadEngine)
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
    // As after a healed "Check again": the demo runtime is stopped and the same model started again.
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'chat-test' })))
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(runtime.stop.mock.invocationCallOrder[0]).toBeLessThan(runtime.start.mock.invocationCallOrder[0] ?? 0)
  })
})

// #516: "Update the AI engine" through the real handler. The model keeps answering through the
// download; only then is everything that runs from the engine folder paused, the files swapped,
// and the model started again — and work in progress refuses the update rather than being cut off.
describe('downloadEngine({ families, update }) — pause, update, resume (#516)', () => {
  /** A model answering on the REAL engine; `stop`/`start` flip it the way the manager does. */
  function liveRuntime(): { status: () => RuntimeStatus; activeModelId: () => string | null; stop: Mock; start: Mock } {
    let running = true
    const status = (): RuntimeStatus =>
      running
        ? { running: true, modelId: 'chat-test', backend: 'gpu', startingModelId: null, port: 1, healthy: true, message: 'Running' }
        : { running: false, modelId: null, startingModelId: null, port: null, healthy: false, message: 'Stopped' }
    return {
      status,
      activeModelId: () => (running ? 'chat-test' : null),
      stop: vi.fn(async () => {
        running = false
      }),
      start: vi.fn(async () => {
        running = true
        return status()
      })
    }
  }
  /** The engine's other users, as the pause sees them. */
  function helpers(): Record<string, Record<string, Mock>> {
    return {
      embedder: { suspend: vi.fn(async () => undefined), resetStartFailure: vi.fn() },
      reranker: { suspend: vi.fn(async () => undefined), resetStartFailure: vi.fn() },
      vision: { stop: vi.fn(async () => undefined), releaseRuntime: vi.fn(async () => undefined), resetStartFailure: vi.fn() },
      translator: { suspend: vi.fn(async () => undefined) }
    }
  }
  /** An older chat engine on the drive (the pin is b200). */
  function withOlderEngine(d: Drive): void {
    const dir = join(d.root, 'runtime', 'llama.cpp', HOST_OS)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, BIN_NAME), 'old engine')
    writeRuntimeMarker(dir, { version: 'b150', backend: 'cpu', os: HOST_OS, arch: HOST_ARCH })
  }
  const versionOnDrive = (d: Drive): string =>
    (JSON.parse(readFileSync(join(d.root, 'runtime', 'llama.cpp', HOST_OS, '.hilbertraum-runtime.json'), 'utf8')) as { version: string }).version

  it('downloads first, then pauses the model and every engine helper, swaps the files and starts the model again', async () => {
    const runtime = liveRuntime()
    const d = makeDrive({ runtime, llamaVersion: 'b200' })
    const h = helpers()
    Object.assign(d.ctx, h)
    withOlderEngine(d)
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'], update: true })
    expect(result).toMatchObject({ families: ['llama_cpp'], update: true })
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('done')
    expect(versionOnDrive(d)).toBe('b200')
    // The model kept answering through the download: it was stopped only after the archive arrived.
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(d.fetchSpy.mock.invocationCallOrder[0]).toBeLessThan(runtime.stop.mock.invocationCallOrder[0] ?? 0)
    // …and the same model comes back on the new engine…
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'chat-test' })))
    // …after every helper running from that folder was paused for the swap. (A model start
    // suspends the reranker again as any switch does, so only the first call is the pause.)
    for (const pause of [h.embedder.suspend, h.reranker.suspend, h.vision.releaseRuntime, h.translator.suspend]) {
      expect(pause.mock.invocationCallOrder[0]).toBeLessThan(runtime.start.mock.invocationCallOrder[0] ?? 0)
    }
    // Vision lets its idle sidecar go; it is never the lock-time stop() that purges finished answers.
    expect(h.vision.stop).not.toHaveBeenCalled()
  })

  it('a failed swap still brings the model back (on the engine left on the drive)', async () => {
    const runtime = liveRuntime()
    const d = makeDrive({
      runtime,
      llamaVersion: 'b200',
      extract: async () => {
        throw new Error('tar exited with code 1')
      }
    })
    Object.assign(d.ctx, helpers())
    withOlderEngine(d)
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'], update: true })
    expect((await settle(d, result as EngineDownloadJob)).status).toBe('failed')
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'chat-test' })))
  })

  it.each<[string, (ctx: AppContext) => void]>([
    ['a document task is queued or running', (ctx) => Object.assign(ctx, { docTasks: { hasActiveTask: () => true } })],
    ['an import is running', (ctx) => Object.assign(ctx, { ingestionActive: () => true })],
    ['a document translation is running', (ctx) => Object.assign(ctx, { translateJobs: { getActiveJob: () => ({ jobId: 't1' }) } })],
    ['an image analysis is running', (ctx) => Object.assign(ctx, { vision: { hasActiveJob: () => true } })],
    // The local API's external lane holds no in-app stream and no span: only the runtime's own gate knows.
    ['a local-API completion is streaming', (ctx) => Object.assign(ctx.runtime, { isGenerating: () => true })],
    [
      'a model is still starting',
      (ctx) => {
        const status = ctx.runtime.status.bind(ctx.runtime)
        Object.assign(ctx.runtime, { status: () => ({ ...status(), startingModelId: 'chat-test' }) })
      }
    ]
  ])('is refused while %s — nothing is fetched, nothing is paused', async (_label, busy) => {
    const runtime = liveRuntime()
    const d = makeDrive({ runtime, llamaVersion: 'b200' })
    Object.assign(d.ctx, helpers())
    withOlderEngine(d)
    busy(d.ctx)
    await expect(
      invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'], update: true })
    ).rejects.toThrow(/in use right now/i)
    expect(d.fetchSpy).not.toHaveBeenCalled()
    expect(runtime.stop).not.toHaveBeenCalled()
  })

  it('work that starts during the download refuses the swap at the pause — the old engine stays and keeps answering', async () => {
    const runtime = liveRuntime()
    const d = makeDrive({ runtime, llamaVersion: 'b200' })
    Object.assign(d.ctx, helpers())
    withOlderEngine(d)
    let importing = false
    Object.assign(d.ctx, { ingestionActive: () => importing })
    d.fetchSpy.mockImplementation(async () => {
      importing = true // an import began while the archive downloaded
      return new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length) } })
    })
    const { result } = await invoke(d.handlers, IPC.downloadEngine, { families: ['llama_cpp'], update: true })
    const job = await settle(d, result as EngineDownloadJob)
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/in use right now/i)
    expect(versionOnDrive(d)).toBe('b150')
    expect(runtime.stop).not.toHaveBeenCalled()
  })
})
