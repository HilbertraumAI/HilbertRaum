import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

// #843: the engine's confirmation dialog states what the job will fetch. Its preview (`engine:plan`)
// and `EngineDownloadManager.start()` select the archives with ONE function (`planEngineSteps`); this
// table proves it by behaviour: for each request the preview's URLs are exactly the URLs the started job
// downloads, in order, and a request the job refuses is refused by the preview with the same words.
// Then the committed pins: every required build carries the `size_bytes` the dialog shows and every
// required family a code-side licence. Then the IPC: the preview's payload is the job's payload,
// validated the same way. Zero network (fake fetch), zero shell-out (fake extractor).

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
import {
  EngineDownloadManager,
  hostRuntimeArch,
  hostRuntimeOs,
  previewEngineDownload,
  type EngineStepRequest,
  type ExtractFn
} from '../../src/main/services/runtime-download'
import { SIDECAR_FAMILY_SPECS, writeRuntimeMarker, type FetchFn } from '../../src/main/services/assets'
import { llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'
import { reportEngineProblem, resetEngineProblemsForTest } from '../../src/main/services/runtime/engine-load'
import { updateSettings } from '../../src/main/services/settings'
import { tMain } from '../../src/main/services/i18n'
import type { EngineDownloadJob, EngineDownloadPreview } from '../../src/shared/types'
import { committedRuntimeSources } from '../helpers/catalog'
import { runToEnd } from '../helpers/download-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { ctxWith, freshRoot, seededDb } from '../helpers/performance-fixture'
import { REPO_ROOT } from '../helpers/repo-files'

const handlers = ipcState.handlers as IpcHandlers
const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN = llamaServerBinaryName()
const WHISPER_BIN = HOST_OS === 'win' ? 'whisper-cli.exe' : 'whisper-cli'
const BODY = 'engine-archive-bytes'
const SHA = createHash('sha256').update(BODY).digest('hex')
const ALLOW = { policyAllows: true, settingAllows: true }

const URLS = {
  vulkan: 'https://example.test/llama-vulkan.zip',
  cpu: 'https://example.test/llama-cpu.zip',
  whisper: 'https://example.test/whisper.zip',
  kiwix: 'https://example.test/kiwix.zip'
}
const llamaDir = (root: string): string => join(root, 'runtime', 'llama.cpp', HOST_OS)
const cpuDir = (root: string): string => join(llamaDir(root), 'cpu')
const whisperDir = (root: string): string => join(root, 'runtime', 'whisper.cpp', HOST_OS)
const kiwixDir = (root: string): string => join(root, 'runtime', 'kiwix-tools', HOST_OS)

/**
 * The pin: llama b200 (vulkan + a cpu/ net), whisper v1.8.6, the optional kiwix tools 3.8.1; sizes on two builds.
 * `chatRuntimeFiles`: files the chat engine's main build must hold beside its program.
 */
function makeDrive(opts: { chatRuntimeFiles?: string[] } = {}): { rootPath: string; manifestsDir: string } {
  const rootPath = mkdtempSync(join(tmpdir(), 'hr-engine-plan-root-'))
  const manifestsDir = mkdtempSync(join(tmpdir(), 'hr-engine-plan-manifests-'))
  const build = (backend: string, url: string, extractTo: string, sizeBytes?: number) => ({
    os: HOST_OS,
    arch: HOST_ARCH,
    backend,
    url,
    sha256: SHA,
    ...(sizeBytes ? { size_bytes: sizeBytes } : {}),
    extract_to: extractTo
  })
  writeFileSync(
    join(manifestsDir, 'runtime-sources.yaml'),
    stringify({
      llama_cpp: {
        version: 'b200',
        builds: [
          {
            ...build('vulkan', URLS.vulkan, `runtime/llama.cpp/${HOST_OS}`, 3_000),
            ...(opts.chatRuntimeFiles ? { runtime_files: opts.chatRuntimeFiles } : {})
          },
          build('cpu', URLS.cpu, `runtime/llama.cpp/${HOST_OS}/cpu`, 2_000)
        ]
      },
      whisper_cpp: { version: 'v1.8.6', builds: [build('cpu', URLS.whisper, `runtime/whisper.cpp/${HOST_OS}`)] },
      kiwix_tools: {
        version: '3.8.1',
        optional: true,
        executables: ['kiwix-serve', 'kiwix-manage'],
        builds: [build('cpu', URLS.kiwix, `runtime/kiwix-tools/${HOST_OS}`)]
      }
    })
  )
  return { rootPath, manifestsDir }
}

/** An engine on the drive: its binary and a marker recording `version`. */
async function installed(dir: string, bin: string, version: string, backend: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, bin), `old ${version}`)
  writeRuntimeMarker(dir, { version, backend, os: HOST_OS, arch: HOST_ARCH })
}

const exe = (base: string): string => (HOST_OS === 'win' ? `${base}.exe` : base)
/** Each family's release: its programs (the chat engine's with the library a `chatRuntimeFiles` pin names). */
const extractFamily: ExtractFn = async (_archive, destDir) => {
  const names = destDir.includes('whisper.cpp')
    ? [WHISPER_BIN]
    : destDir.includes('kiwix-tools')
      ? [exe('kiwix-serve'), exe('kiwix-manage')]
      : [BIN, 'ggml.dll']
  for (const name of names) await writeFile(join(destDir, name), 'new binary')
}

function recordingFetch(): { fetchImpl: FetchFn; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length) } })
  }) as unknown as FetchFn
  return { fetchImpl, urls }
}

type Setup = (root: string) => Promise<void>
type Request = Omit<EngineStepRequest, 'rootPath' | 'manifestsDir'>

const nothing: Setup = async () => undefined
const chatOld: Setup = async (root) => installed(llamaDir(root), BIN, 'b150', 'vulkan')
const chatOldNetOld: Setup = async (root) => {
  await chatOld(root)
  await installed(cpuDir(root), BIN, 'b150', 'cpu')
}
const chatOldNetCurrent: Setup = async (root) => {
  await chatOld(root)
  await installed(cpuDir(root), BIN, 'b200', 'cpu')
}
const chatCurrentNetCurrent: Setup = async (root) => {
  await installed(llamaDir(root), BIN, 'b200', 'vulkan')
  await installed(cpuDir(root), BIN, 'b200', 'cpu')
}
const voiceCurrent: Setup = async (root) => installed(whisperDir(root), WHISPER_BIN, 'v1.8.6', 'cpu')
// T8.5c: engines newer than the pin (a later app or fetch-runtime wrote them); the chat engine's program alone.
const chatNewer: Setup = async (root) => installed(llamaDir(root), BIN, 'b250', 'vulkan')
const both = (...setups: Setup[]): Setup => async (root) => {
  for (const s of setups) await s(root)
}

describe('the preview equals what start() fetches (#843: one step selection)', () => {
  const rows: Array<[string, Setup, Request, EngineDownloadPreview['kind'], string[], { chatRuntimeFiles?: string[] }?]> = [
    ['install: only the chat engine is missing', voiceCurrent, {}, 'install', [URLS.vulkan]],
    ['install: both required engines are missing (never the optional tools)', nothing, {}, 'install', [URLS.vulkan, URLS.whisper]],
    ['install: an explicit family list', nothing, { families: ['whisper_cpp'] }, 'install', [URLS.whisper]],
    ['install: the optional tools, named on their own', nothing, { families: ['kiwix_tools'] }, 'install', [URLS.kiwix]],
    ['update: the main build and its older cpu/ net', chatOldNetOld, { families: ['llama_cpp'], update: true }, 'update', [URLS.vulkan, URLS.cpu]],
    ['update: the main build alone when the cpu/ net is current', chatOldNetCurrent, { families: ['llama_cpp'], update: true }, 'update', [URLS.vulkan]],
    ['update: a current main build with an older cpu/ net', both(async (root) => installed(llamaDir(root), BIN, 'b200', 'vulkan'), async (root) => installed(cpuDir(root), BIN, 'b150', 'cpu')), { families: ['llama_cpp'], update: true }, 'update', [URLS.cpu]],
    ['update: both families, the voice engine older too', both(chatOld, async (root) => installed(whisperDir(root), WHISPER_BIN, 'v1.7.0', 'cpu')), { families: ['llama_cpp', 'whisper_cpp'], update: true }, 'update', [URLS.vulkan, URLS.whisper]],
    ['reinstall: the main build (no refused builds named)', chatCurrentNetCurrent, { families: ['llama_cpp'], reinstall: true }, 'reinstall', [URLS.vulkan]],
    ['reinstall: the refused cpu/ net alone', chatCurrentNetCurrent, { families: ['llama_cpp'], reinstall: true, reinstallBuilds: { llama_cpp: { main: false, cpuNet: true } } }, 'reinstall', [URLS.cpu]],
    ['reinstall: both refused builds', chatCurrentNetCurrent, { families: ['llama_cpp'], reinstall: true, reinstallBuilds: { llama_cpp: { main: true, cpuNet: true } } }, 'reinstall', [URLS.vulkan, URLS.cpu]],
    ['reinstall: two families', both(chatCurrentNetCurrent, voiceCurrent), { families: ['llama_cpp', 'whisper_cpp'], reinstall: true }, 'reinstall', [URLS.vulkan, URLS.whisper]],
    // T8.5c (R1 F-4 = R2 M-3; F-24: `newer` is never replaced): only a reinstall replaces an engine newer than the pin.
    // A named list skips the newer family and installs the rest; it used to replace it as "not current".
    ['install: a named list skips the family newer than the pin and installs the missing one', chatNewer, { families: ['llama_cpp', 'whisper_cpp'] }, 'install', [URLS.whisper]],
    // …and so does the argument-less install, for a newer chat engine that lacks a file this pin lists (a later
    // release's layout): it counted as missing, so "Install voice engine" replaced it too.
    ['install: the argument-less install skips a newer chat engine that lacks a file this pin lists', chatNewer, {}, 'install', [URLS.whisper], { chatRuntimeFiles: ['ggml.dll'] }]
  ]

  it.each(rows)('%s', async (_title, setup, request, kind, expected, drive) => {
    const { rootPath, manifestsDir } = makeDrive(drive)
    await setup(rootPath)
    const preview = previewEngineDownload({ rootPath, manifestsDir, ...request })
    const { fetchImpl, urls } = recordingFetch()
    const mgr = new EngineDownloadManager({ fetchImpl, extractImpl: extractFamily })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...request })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status, job.error ?? '').toBe('done')
    expect(preview.kind).toBe(kind)
    expect(preview.items.map((i) => i.url)).toEqual(expected)
    // The dialog's list IS the job's downloads, archive by archive.
    expect(urls).toEqual(preview.items.map((i) => i.url))
    expect(started.families).toEqual([...new Set(preview.items.map((i) => i.family))])
    // What the job set out to fetch is kept for its audit record: the same preview.
    expect(mgr.jobPreview(started.jobId)).toEqual(preview)
  })

  const refused: Array<[string, Setup, Request, string]> = [
    ['update: nothing older than the pin', chatCurrentNetCurrent, { families: ['llama_cpp'], update: true }, tMain('main.engine.nothingToUpdate')],
    ['update: a newer engine is never downgraded', async (root) => installed(llamaDir(root), BIN, 'b250', 'vulkan'), { families: ['llama_cpp'], update: true }, tMain('main.engine.nothingToUpdate')],
    ['update: the optional tools are reported, never updated in-app', async (root) => installed(join(root, 'runtime', 'kiwix-tools', HOST_OS), exe('kiwix-serve'), '3.7.0', 'cpu'), { families: ['kiwix_tools'], update: true }, tMain('main.engine.nothingToUpdate')],
    ['install: every required engine is on the drive', both(chatCurrentNetCurrent, voiceCurrent), {}, tMain('main.engine.alreadyInstalled')],
    // T8.5c (R1 F-4 = R2 M-3): a named install answers a newer engine as the update does. It replaced it as "not current".
    ['install: a named engine newer than the pin is never replaced', chatNewer, { families: ['llama_cpp'] }, tMain('main.engine.nothingToUpdate')],
    // The knowledge-pack tools' consent sends `{ families: ['kiwix_tools'] }` when a file the pin lists is missing: a
    // later release's newer copy may lack one (here kiwix-manage).
    ['install: the named optional tools, newer than the pin and lacking a file it lists, are never replaced', async (root) => installed(kiwixDir(root), exe('kiwix-serve'), '3.9.0', 'cpu'), { families: ['kiwix_tools'] }, tMain('main.engine.nothingToUpdate')],
    ['update: no family named', nothing, { update: true }, tMain('main.engine.badRequest')]
  ]

  it.each(refused)('%s: the preview refuses with the words start() uses, and nothing is fetched', async (_title, setup, request, message) => {
    const { rootPath, manifestsDir } = makeDrive()
    await setup(rootPath)
    expect(() => previewEngineDownload({ rootPath, manifestsDir, ...request })).toThrow(message)
    const { fetchImpl, urls } = recordingFetch()
    const mgr = new EngineDownloadManager({ fetchImpl, extractImpl: extractFamily })
    await expect(mgr.start({ rootPath, manifestsDir, gates: ALLOW, ...request })).rejects.toThrow(message)
    expect(urls).toEqual([])
  })

  it('no sources, no host build: the same refusals as start()', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'hr-engine-plan-root-'))
    expect(() => previewEngineDownload({ rootPath, manifestsDir: null })).toThrow(tMain('main.engine.noSources'))
    const { manifestsDir } = makeDrive()
    const otherOs = HOST_OS === 'win' ? 'linux' : 'win32'
    expect(() => previewEngineDownload({ rootPath, manifestsDir, platform: otherOs, arch: 'riscv' })).toThrow(tMain('main.engine.noHostBuild'))
  })

  it('states the sizes, the installed version, the code-side licence and the safety net per archive', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    await chatOldNetOld(rootPath)
    const preview = previewEngineDownload({ rootPath, manifestsDir, families: ['llama_cpp'], update: true })
    expect(preview.items.map(({ version, installed, backend, safetyNet, sizeBytes, license }) => ({ version, installed, backend, safetyNet, sizeBytes, license }))).toEqual([
      { version: 'b200', installed: 'b150', backend: 'vulkan', safetyNet: false, sizeBytes: 3_000, license: 'MIT' },
      { version: 'b200', installed: 'b150', backend: 'cpu', safetyNet: true, sizeBytes: 2_000, license: 'MIT' }
    ])
    expect(preview.totalBytes).toBe(5_000)
    expect(preview.items[0].licenseUrl).toBe('https://github.com/ggml-org/llama.cpp/blob/b200/LICENSE')
    // A pin without size_bytes reads as unknown, and so does the total.
    const withVoice = previewEngineDownload({ rootPath: mkdtempSync(join(tmpdir(), 'hr-engine-plan-root-')), manifestsDir })
    expect(withVoice.items.map((i) => i.sizeBytes)).toEqual([3_000, null])
    expect(withVoice.totalBytes).toBeNull()
  })
})

describe('the committed pins carry what the dialog states (#843)', () => {
  const manifestsDir = join(REPO_ROOT, 'model-manifests')

  it('every build of a required family declares a positive size_bytes', () => {
    const families = committedRuntimeSources().families ?? {}
    const required = SIDECAR_FAMILY_SPECS.filter((s) => s.optional !== true)
    const missing = required.flatMap((spec) =>
      (families[spec.family]?.builds ?? []).filter((b) => !(Number.isInteger(b.sizeBytes) && (b.sizeBytes ?? 0) > 0)).map((b) => `${spec.family} ${b.url}`)
    )
    expect(required.map((s) => s.family)).toEqual(['llama_cpp', 'whisper_cpp'])
    expect(missing).toEqual([])
  })

  it('every family has a code-side licence, and every required one a licence link', () => {
    expect(SIDECAR_FAMILY_SPECS.filter((s) => !s.license).map((s) => s.family)).toEqual([])
    expect(SIDECAR_FAMILY_SPECS.filter((s) => s.optional !== true && !s.licenseRepo).map((s) => s.family)).toEqual([])
  })

  it.each([
    [
      'Windows: both engines, each with the library licence its archive carries',
      'win32' as const,
      'x64',
      [
        ['llama-b12110-bin-win-vulkan-x64.zip', 37_661_146, 'Apache-2.0 WITH LLVM-exception (libomp.dll)', 'https://github.com/ggml-org/llama.cpp/blob/b12110/LICENSE'],
        ['whisper-bin-x64.zip', 4_093_849, 'zlib (SDL2.dll)', 'https://github.com/ggml-org/whisper.cpp/blob/v1.8.6/LICENSE']
      ]
    ],
    ['macOS: the Metal build, MIT alone', 'darwin' as const, 'arm64', [['llama-b12110-bin-macos-arm64.tar.gz', 16_650_691, null, 'https://github.com/ggml-org/llama.cpp/blob/b12110/LICENSE']]],
    ['Linux: the Vulkan build, MIT alone', 'linux' as const, 'x64', [['llama-b12110-bin-ubuntu-vulkan-x64.tar.gz', 35_858_360, null, 'https://github.com/ggml-org/llama.cpp/blob/b12110/LICENSE']]]
  ])('%s', (_title, platform, arch, expected) => {
    const rootPath = mkdtempSync(join(tmpdir(), 'hr-engine-plan-root-'))
    const preview = previewEngineDownload({ rootPath, manifestsDir, platform, arch })
    expect(preview.items.map((i) => [i.url.split('/').pop(), i.sizeBytes, i.bundledLicense, i.licenseUrl])).toEqual(expected)
    expect(preview.items.every((i) => i.license === 'MIT' && i.url.startsWith('https://github.com/ggml-org/'))).toBe(true)
    expect(preview.totalBytes).toBe(expected.reduce((n, e) => n + (e[1] as number), 0))
  })
})

describe('engine:plan over IPC (#843)', () => {
  function makeIpc(): { root: string; fetchSpy: ReturnType<typeof vi.fn>; manager: EngineDownloadManager } {
    const root = freshRoot()
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'policy.json'), JSON.stringify({ network: { allow_model_downloads: true } }))
    const { manifestsDir } = makeDrive()
    const db = seededDb(root)
    updateSettings(db, { allowNetwork: true })
    const fetchSpy = vi.fn(recordingFetch().fetchImpl)
    const ctx = ctxWith(root, db, {
      paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'config') },
      manifestsDir: null,
      bundledManifestsDir: manifestsDir,
      runtime: { activeModelId: () => null, status: () => ({ running: false, modelId: null, startingModelId: null, port: null, healthy: false, message: '' }) }
    })
    handlers.clear()
    resetEngineProblemsForTest()
    const manager = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn, extractImpl: extractFamily })
    registerEngineIpc(ctx, manager)
    return { root, fetchSpy, manager }
  }

  it('a malformed payload is refused before anything is read or fetched — the words engine:download uses', async () => {
    const d = makeIpc()
    const bad: unknown[] = [{ families: ['../llama_cpp'] }, { families: [] }, { families: ['llama_cpp', 'kiwix_tools'] }, { reinstall: true }, { families: ['kiwix_tools'], reinstall: true }, { families: ['kiwix_tools'], update: true }, { families: ['llama_cpp'], update: true, reinstall: true }, 'llama_cpp', 42]
    for (const payload of bad) {
      await expect(invoke(handlers, IPC.getEnginePlan, payload), JSON.stringify(payload)).rejects.toThrow(tMain('main.engine.badRequest'))
      await expect(invoke(handlers, IPC.downloadEngine, payload), JSON.stringify(payload)).rejects.toThrow(tMain('main.engine.badRequest'))
    }
    expect(d.fetchSpy).not.toHaveBeenCalled()
  })

  it('a reinstall is previewed only for a family holding a "files damaged" verdict, with the builds the OS refused', async () => {
    const d = makeIpc()
    await chatCurrentNetCurrent(d.root)
    const request = { families: ['llama_cpp'], reinstall: true }
    await expect(invoke(handlers, IPC.getEnginePlan, request)).rejects.toThrow(tMain('main.engine.nothingToRepair'))
    // The OS refused the cpu/ net only (#678): the preview — and then the job — replaces that one.
    reportEngineProblem({ family: 'llama_cpp', reason: 'files-damaged', os: HOST_OS, exit: 'exit code 0xC0000135' }, join(cpuDir(d.root), BIN))
    const preview = (await invoke(handlers, IPC.getEnginePlan, request)).result as EngineDownloadPreview
    expect(preview.items.map((i) => i.url)).toEqual([URLS.cpu])
    expect(d.fetchSpy).not.toHaveBeenCalled()
    const job = (await invoke(handlers, IPC.downloadEngine, request)).result as EngineDownloadJob
    await runToEnd(d.manager, job.jobId)
    expect(d.fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([URLS.cpu])
  })

  it('the argument-less preview is what the argument-less install fetches', async () => {
    const d = makeIpc()
    const preview = (await invoke(handlers, IPC.getEnginePlan)).result as EngineDownloadPreview
    expect(preview.kind).toBe('install')
    expect(d.fetchSpy).not.toHaveBeenCalled()
    const job = (await invoke(handlers, IPC.downloadEngine)).result as EngineDownloadJob
    await runToEnd(d.manager, job.jobId)
    expect(d.fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(preview.items.map((i) => i.url))
  })
})
