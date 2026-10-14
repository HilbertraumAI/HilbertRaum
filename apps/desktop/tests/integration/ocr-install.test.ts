import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'

// Issue #410 — the in-app OCR language-file installer (services/ocr-install.ts) + its
// IPC surface (registerEngineIpc.ts). Manager-level tests drive `OcrInstallManager`
// directly with an injected fetch and FAKE_PINS (the real OCR_PINS hash real CDN files
// this suite cannot produce); the last section drives the same manager through the real
// IPC handlers. Zero network (every fetch is injected), zero shell-out.

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
  OCR_SIZE_CAP_HEADROOM,
  OcrInstallManager,
  ocrPinRelPath,
  type OcrPin,
  type StartOcrInstallOptions
} from '../../src/main/services/ocr-install'
import { effectiveDownloadCap, verifyDownloadedFile, type FetchFn } from '../../src/main/services/assets'
import { tMain } from '../../src/main/services/i18n'
import { updateSettings } from '../../src/main/services/settings'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { closePerformanceFixture, ctxWith, freshRoot, seededDb } from '../helpers/performance-fixture'
import { hangBudgetMs, until } from '../helpers/hang-budget'
import { tempRoot } from '../helpers/db-fixtures'
import type { OcrInstallJob, OcrInstallStatus, OcrRefreshOutcome } from '../../src/shared/types'

const handlers = ipcState.handlers as IpcHandlers

// ---- Fixtures shared by every section ------------------------------------------------

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** deu/eng bodies the fake fetches serve; the pins below are hashed to THESE bytes, never
 *  the real CDN files OCR_PINS hashes. */
const DEU_BYTES = 'deu-bytes'
const ENG_BYTES = 'eng-bytes'

const FAKE_PINS: readonly OcrPin[] = [
  { lang: 'deu', sha256: sha256(DEU_BYTES), sizeBytes: DEU_BYTES.length },
  { lang: 'eng', sha256: sha256(ENG_BYTES), sizeBytes: ENG_BYTES.length }
]

const ALLOW = { policyAllows: true, settingAllows: true }

interface OcrYamlOverrides {
  host?: string
  deuUrl?: string
  engUrl?: string
  deuSha?: string
  engSha?: string
  deuDest?: string
  engDest?: string
  extraLangs?: Array<{ lang: string; url: string; sha256: string; dest: string }>
  /** Leave these languages out of the `ocr:` block. */
  omitLangs?: string[]
  /** A llama_cpp-only yaml: no `ocr:` block at all. */
  noOcrBlock?: boolean
}

/** A `runtime-sources.yaml` carrying a valid `llama_cpp:` block (required by the
 *  validator) plus an `ocr:` block matching FAKE_PINS by default. */
function ocrYaml(o: OcrYamlOverrides = {}): string {
  const host = o.host ?? 'https://example.test'
  const files = [
    {
      lang: 'deu',
      url: o.deuUrl ?? `${host}/deu.traineddata.gz`,
      sha256: o.deuSha ?? FAKE_PINS[0].sha256,
      dest: o.deuDest ?? 'ocr/deu.traineddata.gz'
    },
    {
      lang: 'eng',
      url: o.engUrl ?? `${host}/eng.traineddata.gz`,
      sha256: o.engSha ?? FAKE_PINS[1].sha256,
      dest: o.engDest ?? 'ocr/eng.traineddata.gz'
    },
    ...(o.extraLangs ?? [])
  ].filter((f) => !o.omitLangs?.includes(f.lang))
  return stringify({
    llama_cpp: {
      version: 'btest',
      builds: [
        {
          os: 'win',
          arch: 'x64',
          backend: 'cpu',
          url: `${host}/llama.zip`,
          sha256: sha256('llama-body'),
          extract_to: 'runtime/llama.cpp/win'
        }
      ]
    },
    ...(o.noOcrBlock ? {} : { ocr: { version: '4.0.0_best_int', files } })
  })
}

function manifestsDirWith(root: string, yaml: string): string {
  const dir = join(root, 'model-manifests')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runtime-sources.yaml'), yaml)
  return dir
}

function sourceOpts(
  root: string,
  manifests: string | null,
  bundled: string | null = null
): { rootPath: string; manifestsDir: string | null; bundledManifestsDir: string | null } {
  return { rootPath: root, manifestsDir: manifests, bundledManifestsDir: bundled }
}

function startOpts(
  root: string,
  manifests: string | null,
  bundled: string | null = null,
  activate: () => Promise<OcrRefreshOutcome> = async () => 'activated'
): StartOcrInstallOptions {
  return { ...sourceOpts(root, manifests, bundled), gates: ALLOW, activate }
}

/** Serves the pinned deu/eng bytes keyed by a `deu`/`eng` substring in the URL. */
const correctBytesFetch: FetchFn = (async (url: unknown) => {
  const u = String(url)
  const body = u.includes('deu') ? DEU_BYTES : u.includes('eng') ? ENG_BYTES : null
  if (body === null) throw new Error(`unexpected fetch: ${u}`)
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
}) as unknown as FetchFn

/** A fetch whose body stream sends one chunk then hangs until its request signal aborts
 *  (the downloads.test.ts `hangingFetch` idiom) — pins a cancel deterministically mid-download. */
function hangingFetch(firstChunk: string): FetchFn {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstChunk))
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError'))
        )
      }
    })
    return new Response(stream, { status: 200 })
  }) as unknown as FetchFn
}

/** One chunk, then a body error carrying a drive error code. `isDiskError` reads only `.code`, and a real ENOSPC
 *  arrives from the write stream through the same `fail(err)` in `downloadToFile`. The chunk means the `.part`
 *  exists, so the cleanup the test asserts is real. */
function diskFullFetch(): FetchFn {
  return (async () => {
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))
          return
        }
        sent = true
        controller.enqueue(new TextEncoder().encode('d'))
      }
    })
    return new Response(stream, { status: 200 })
  }) as unknown as FetchFn
}

/**
 * Poll a job to a terminal status AND wait for its `run()` to fully SETTLE (the F-33 busy-latch
 * precedent, engine-download.test.ts): `cancel()` flips `status` to 'cancelled' SYNCHRONOUSLY,
 * before the in-flight `run()` has actually reached its `aborted()` cleanup (the `.part` removal)
 * — `activeJob()` stays non-null until that background work finishes. Without this, a test that
 * cancels and immediately asserts the `.part` is gone races the manager's own cleanup.
 */
const TERMINAL: ReadonlySet<OcrInstallJob['status']> = new Set(['done', 'failed', 'cancelled'])

async function runToEnd(mgr: OcrInstallManager, jobId: string): Promise<OcrInstallJob> {
  await until(() => TERMINAL.has(mgr.get(jobId).status) && mgr.activeJob() !== jobId, 'the OCR install job settling')
  return mgr.get(jobId)
}

async function waitForStatus(
  mgr: OcrInstallManager,
  jobId: string,
  status: OcrInstallJob['status']
): Promise<void> {
  await until(() => mgr.get(jobId).status === status, `the OCR install job reaching ${status}`)
}

// ---- Gates — a closed gate never fetches ----------------------------------------------

describe('gates (offline guarantee — a closed gate never fetches, #410)', () => {
  it.each([
    ['the policy ceiling denies downloads', { policyAllows: false, settingAllows: true }, 'main.download.policyDisabled'],
    ['the allowNetwork setting is off', { policyAllows: true, settingAllows: false }, 'main.download.networkOff']
  ] as const)('refuses when %s — no fetch, no ocr/ folder', async (_label, gates, key) => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    await expect(mgr.start({ ...startOpts(root, manifests), gates })).rejects.toThrow(tMain(key))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'ocr'))).toBe(false)
  })
})

// ---- Sources / destinations ------------------------------------------------------------

describe('sources / destinations (#410)', () => {
  it('the yaml dest is ignored: files always land at the fixed ocr/<lang>.traineddata.gz path', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(
      root,
      ocrYaml({
        deuDest: 'Start HilbertRaum.cmd',
        engDest: 'runtime/llama.cpp/win/llama-server.exe'
      })
    )
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(existsSync(join(root, ocrPinRelPath('deu')))).toBe(true)
    expect(existsSync(join(root, ocrPinRelPath('eng')))).toBe(true)
    expect(existsSync(join(root, 'Start HilbertRaum.cmd'))).toBe(false)
    expect(existsSync(join(root, 'runtime', 'llama.cpp', 'win', 'llama-server.exe'))).toBe(false)
  })

  it('a yaml sha256 that does not match the pin is a mismatch — refused, no fetch, unavailable', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml({ deuSha: sha256('not-the-pinned-bytes') }))
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    await expect(mgr.start(startOpts(root, manifests))).rejects.toThrow(tMain('main.ocr.sourcesMismatch'))
    expect(fetchSpy).not.toHaveBeenCalled()
    const status = await mgr.status(sourceOpts(root, manifests))
    expect(status.available).toBe(false)
  })

  it('a yaml missing one pinned language is a mismatch too', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml({ omitLangs: ['eng'] }))
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    await expect(mgr.start(startOpts(root, manifests))).rejects.toThrow(tMain('main.ocr.sourcesMismatch'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to the app-bundled source list when the drive yaml carries no ocr: block', async () => {
    const root = tempRoot('ocr')
    const driveManifests = manifestsDirWith(root, ocrYaml({ noOcrBlock: true }))
    const bundled = tempRoot('ocr-bundled')
    writeFileSync(join(bundled, 'runtime-sources.yaml'), ocrYaml({ host: 'https://bundled.example.test' }))
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, driveManifests, bundled))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toContain('bundled.example.test')
    }
  })

  it('neither the drive nor the bundled dir carries an ocr source: unavailable, no host, refused', async () => {
    const root = tempRoot('ocr')
    const driveManifests = manifestsDirWith(root, ocrYaml({ noOcrBlock: true }))
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
    const status = await mgr.status(sourceOpts(root, driveManifests))
    expect(status.available).toBe(false)
    expect(status.sourceHost).toBeNull()
    await expect(mgr.start(startOpts(root, driveManifests))).rejects.toThrow(tMain('main.ocr.noSources'))
  })

  it('extra languages in the yaml are ignored — never fetched, never written', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(
      root,
      ocrYaml({
        extraLangs: [
          { lang: 'fra', url: 'https://example.test/fra.traineddata.gz', sha256: sha256('fra-bytes'), dest: 'ocr/fra.traineddata.gz' }
        ]
      })
    )
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('done')
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toContain('fra')
    expect(existsSync(join(root, 'ocr', 'fra.traineddata.gz'))).toBe(false)
  })
})

// ---- Hash-is-state ----------------------------------------------------------------------

describe('hash-is-state (#410)', () => {
  it('a present + verified file is skipped without a fetch — only the missing one is fetched', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), DEU_BYTES)
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('eng')
    expect(readFileSync(join(root, 'ocr', 'eng.traineddata.gz'), 'utf8')).toBe(ENG_BYTES)
  })

  it('both already present + verified: start() refuses alreadyInstalled, no fetch; status reflects it', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), DEU_BYTES)
    writeFileSync(join(root, 'ocr', 'eng.traineddata.gz'), ENG_BYTES)
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    await expect(mgr.start(startOpts(root, manifests))).rejects.toThrow(tMain('main.ocr.alreadyInstalled'))
    expect(fetchSpy).not.toHaveBeenCalled()
    const status = await mgr.status(sourceOpts(root, manifests))
    expect(status.languages).toEqual([
      { lang: 'deu', role: 'language', sizeBytes: FAKE_PINS[0].sizeBytes, installed: true },
      { lang: 'eng', role: 'language', sizeBytes: FAKE_PINS[1].sizeBytes, installed: true }
    ])
    expect(status.totalBytes).toBe(0)
  })

  it('#538: a drive with deu + eng reports the orientation file as the one missing piece, by role', async () => {
    const root = tempRoot('ocr')
    const OSD_BYTES = 'osd-bytes'
    const osdPin: OcrPin = { lang: 'osd', sha256: sha256(OSD_BYTES), sizeBytes: OSD_BYTES.length }
    const manifests = manifestsDirWith(
      root,
      ocrYaml({
        extraLangs: [
          { lang: 'osd', url: 'https://example.test/osd.traineddata.gz', sha256: osdPin.sha256, dest: 'ocr/osd.traineddata.gz' }
        ]
      })
    )
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), DEU_BYTES)
    writeFileSync(join(root, 'ocr', 'eng.traineddata.gz'), ENG_BYTES)
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: [...FAKE_PINS, osdPin] })
    const status = await mgr.status(sourceOpts(root, manifests))
    expect(status.languages.map((l) => [l.lang, l.role, l.installed])).toEqual([
      ['deu', 'language', true],
      ['eng', 'language', true],
      ['osd', 'orientation', false]
    ])
    expect(status.totalBytes).toBe(OSD_BYTES.length)
  })

  it('a present but CORRUPT file, served corrupt again: checksum mismatch, no .part, the existing file and the skipped one untouched', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), 'corrupt-deu-on-disk')
    writeFileSync(join(root, 'ocr', 'eng.traineddata.gz'), ENG_BYTES) // present + correct: skipped
    const badFetch: FetchFn = (async () =>
      new Response('still-wrong-bytes', { status: 200 })) as unknown as FetchFn
    const mgr = new OcrInstallManager({ fetchImpl: badFetch, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('failed')
    expect(done.error).toBe(tMain('main.ocr.checksumMismatch'))
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz.part'))).toBe(false)
    expect(readFileSync(join(root, 'ocr', 'deu.traineddata.gz'), 'utf8')).toBe('corrupt-deu-on-disk')
    expect(readFileSync(join(root, 'ocr', 'eng.traineddata.gz'), 'utf8')).toBe(ENG_BYTES)
  })

  // No content-length, so the body cap is the PINNED size + OCR_SIZE_CAP_HEADROOM plus the downloader's own margin
  // (`effectiveDownloadCap`, owned by assets.test.ts). A body of exactly that size downloads and is then refused by the
  // hash; one byte more is cut off as a failed download. Either way: no .part and no file. The cap is per file: the
  // eng row lets a correct deu download first, so the SECOND planned file is the one served over its own cap.
  const DEU_BODY_CAP = effectiveDownloadCap(null, FAKE_PINS[0].sizeBytes + OCR_SIZE_CAP_HEADROOM)
  const ENG_BODY_CAP = effectiveDownloadCap(null, FAKE_PINS[1].sizeBytes + OCR_SIZE_CAP_HEADROOM)
  it.each([
    ['deu', 'exactly the effective cap', 'main.ocr.checksumMismatch', DEU_BODY_CAP],
    ['deu', 'one byte over the effective cap', 'main.ocr.downloadFailed', DEU_BODY_CAP + 1],
    ['eng', 'one byte over the effective cap', 'main.ocr.downloadFailed', ENG_BODY_CAP + 1]
  ] as const)(
    'the body cap is the pinned size + OCR_SIZE_CAP_HEADROOM: a %s body of %s (no content-length) is refused as %s, no .part left',
    async (lang, _label, key, bytes) => {
      const root = tempRoot('ocr')
      const manifests = manifestsDirWith(root, ocrYaml())
      mkdirSync(join(root, 'ocr'), { recursive: true })
      // deu rows: eng present + correct, so only deu is fetched. eng row: nothing present; deu downloads correctly.
      if (lang === 'deu') writeFileSync(join(root, 'ocr', 'eng.traineddata.gz'), ENG_BYTES)
      const sizedFetch: FetchFn = (async (url: unknown) =>
        lang === 'eng' && String(url).includes('deu')
          ? correctBytesFetch(url as string)
          : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(bytes))
              controller.close()
            }
          }),
          { status: 200 } // deliberately no content-length header
        )) as unknown as FetchFn
      const mgr = new OcrInstallManager({ fetchImpl: sizedFetch, pins: FAKE_PINS })
      const done = await runToEnd(mgr, (await mgr.start(startOpts(root, manifests))).jobId)
      expect(done.status).toBe('failed')
      expect(done.error).toBe(tMain(key))
      expect(existsSync(join(root, 'ocr', `${lang}.traineddata.gz.part`))).toBe(false)
      expect(existsSync(join(root, 'ocr', `${lang}.traineddata.gz`))).toBe(false)
    }
  )

  it('a user-added third language file and an unrelated file survive a full install byte-identical', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'fra.traineddata.gz'), 'fra-bytes-not-pinned')
    writeFileSync(join(root, 'ocr', 'notes.txt'), 'user notes')
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(readFileSync(join(root, 'ocr', 'fra.traineddata.gz'), 'utf8')).toBe('fra-bytes-not-pinned')
    expect(readFileSync(join(root, 'ocr', 'notes.txt'), 'utf8')).toBe('user notes')
  })
})

// ---- Folder safety ------------------------------------------------------------------------

describe('ocr/ folder safety (#410)', () => {
  it('refuses a symlink/junction ocr/ — nothing written into the target, folder unsafe', async (ctx) => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const target = tempRoot('ocr-target')
    const ocrPath = join(root, 'ocr')
    try {
      symlinkSync(target, ocrPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Neither link kind is creatable here: report SKIPPED, never passed (a junction needs no
      // privilege on Windows, so this runs there and on Linux CI).
      ctx.skip()
      return
    }
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    await expect(mgr.start(startOpts(root, manifests))).rejects.toThrow(tMain('main.ocr.unsafeFolder'))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(existsSync(join(target, 'deu.traineddata.gz'))).toBe(false)
    expect(existsSync(join(target, 'eng.traineddata.gz'))).toBe(false)
  })

  it('refuses ocr/ as a regular file', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    writeFileSync(join(root, 'ocr'), 'not a directory')
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    await expect(mgr.start(startOpts(root, manifests))).rejects.toThrow(tMain('main.ocr.unsafeFolder'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ---- Job lifecycle ------------------------------------------------------------------------

describe('job lifecycle (#410)', () => {
  for (const outcome of ['activated', 'restartRequired'] as const) {
    it(`reaches 'done' only after activate resolves, outcome ${outcome}, only after BOTH files are renamed`, async () => {
      const root = tempRoot('ocr')
      const manifests = manifestsDirWith(root, ocrYaml())
      const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
      let activateCalls = 0
      let sawBothFiles = false
      let sawNoParts = false
      let releaseActivate: () => void = () => undefined
      const gate = new Promise<void>((r) => {
        releaseActivate = r
      })
      const activate = async (): Promise<OcrRefreshOutcome> => {
        activateCalls += 1
        sawBothFiles =
          existsSync(join(root, 'ocr', 'deu.traineddata.gz')) && existsSync(join(root, 'ocr', 'eng.traineddata.gz'))
        sawNoParts =
          !existsSync(join(root, 'ocr', 'deu.traineddata.gz.part')) &&
          !existsSync(join(root, 'ocr', 'eng.traineddata.gz.part'))
        await gate
        return outcome
      }
      const job = await mgr.start(startOpts(root, manifests, null, activate))
      await waitForStatus(mgr, job.jobId, 'activating')
      // Not done while activate is still pending.
      expect(mgr.get(job.jobId).status).toBe('activating')
      releaseActivate()
      const done = await runToEnd(mgr, job.jobId)
      expect(done.status).toBe('done')
      expect(done.outcome).toBe(outcome)
      expect(activateCalls).toBe(1)
      expect(sawBothFiles).toBe(true)
      expect(sawNoParts).toBe(true)
      expect(done.totalBytes).toBe(FAKE_PINS[0].sizeBytes + FAKE_PINS[1].sizeBytes)
      expect(done.receivedBytes).toBe(done.totalBytes)
    })
  }

  it('a rejecting activate still reaches done, with outcome startFailed', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
    const job = await mgr.start(
      startOpts(root, manifests, null, async () => {
        throw new Error('activation exploded')
      })
    )
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(done.outcome).toBe('startFailed')
  })

  it('cancel right after start() resolves (still queued) ends cancelled before any fetch', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    // run() is still awaiting its first folder check (real fs I/O), so this cancel lands on a queued job.
    expect(mgr.get(job.jobId).status).toBe('queued')
    mgr.cancel(job.jobId)
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('cancelled')
    expect(done.receivedBytes).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("cancel during 'downloading' removes the .part and ends cancelled", async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const mgr = new OcrInstallManager({ fetchImpl: hangingFetch('partial-bytes'), pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    await waitForStatus(mgr, job.jobId, 'downloading')
    mgr.cancel(job.jobId)
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('cancelled')
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz.part'))).toBe(false)
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz'))).toBe(false)
  })

  it("cancel during 'verifying' removes the .part and ends cancelled", async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    let releaseVerify: () => void = () => undefined
    const verifyGate = new Promise<void>((r) => {
      releaseVerify = r
    })
    const mgr = new OcrInstallManager({
      fetchImpl: correctBytesFetch,
      pins: FAKE_PINS,
      verifyImpl: async (path, sha) => {
        await verifyGate
        return verifyDownloadedFile(path, sha)
      }
    })
    const job = await mgr.start(startOpts(root, manifests))
    await waitForStatus(mgr, job.jobId, 'verifying')
    mgr.cancel(job.jobId)
    releaseVerify()
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('cancelled')
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz.part'))).toBe(false)
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz'))).toBe(false)
  })

  it("cancel during 'activating' reads cancelled at once, and STAYS cancelled with outcome null once activate settles", async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
    let releaseActivate: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      releaseActivate = r
    })
    const activate = async (): Promise<OcrRefreshOutcome> => {
      await gate
      return 'activated'
    }
    const job = await mgr.start(startOpts(root, manifests, null, activate))
    await waitForStatus(mgr, job.jobId, 'activating')
    const cancelled = mgr.cancel(job.jobId)
    expect(cancelled.status).toBe('cancelled')
    releaseActivate()
    await vi.waitFor(() => expect(mgr.activeJob()).toBeNull(), { timeout: hangBudgetMs(5000) })
    const finalJob = mgr.get(job.jobId)
    expect(finalJob.status).toBe('cancelled')
    expect(finalJob.outcome).toBeNull()
  })

  it('get(unknown id) reports a failed snapshot carrying the unknown-job copy', () => {
    const mgr = new OcrInstallManager({ pins: FAKE_PINS })
    const job = mgr.get('nope')
    expect(job.jobId).toBe('nope')
    expect(job.status).toBe('failed')
    expect(job.error).toBe(tMain('main.ocr.unknownJob'))
  })
})

// ---- Single-flight ------------------------------------------------------------------------

describe('single-flight (#410)', () => {
  it('two start() calls fired back-to-back: exactly one succeeds, the other is refused', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const mgr = new OcrInstallManager({ fetchImpl: hangingFetch('x'), pins: FAKE_PINS })
    const p1 = mgr.start(startOpts(root, manifests))
    const p2 = mgr.start(startOpts(root, manifests))
    const results = await Promise.allSettled([p1, p2])
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<OcrInstallJob> => r.status === 'fulfilled'
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String((rejected[0].reason as Error).message)).toBe(tMain('main.ocr.alreadyRunning'))
    mgr.cancel(fulfilled[0].value.jobId) // unwind the hanging fetch
    await runToEnd(mgr, fulfilled[0].value.jobId)
  })

  it('a start while a cancelled-but-unsettled activate is still running is refused; a new start is allowed once it settles', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
    let releaseActivate: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      releaseActivate = r
    })
    const activate = async (): Promise<OcrRefreshOutcome> => {
      await gate
      return 'activated'
    }
    const job = await mgr.start(startOpts(root, manifests, null, activate))
    await waitForStatus(mgr, job.jobId, 'activating')
    mgr.cancel(job.jobId)
    await expect(mgr.start(startOpts(root, manifests))).rejects.toThrow(tMain('main.ocr.alreadyRunning'))
    releaseActivate()
    await vi.waitFor(() => expect(mgr.activeJob()).toBeNull(), { timeout: hangBudgetMs(5000) })
    // Every file landed before 'activating' is ever reached, so a fresh start finds nothing to fetch.
    await expect(mgr.start(startOpts(root, manifests))).rejects.toThrow(tMain('main.ocr.alreadyInstalled'))
  })
})

// ---- Drive-side failures -------------------------------------------------------------------

describe('drive-side failures read as drive problems, never raw paths (#410)', () => {
  it('a download that fails on the DRIVE (ENOSPC) says "could not be saved", not "check the internet"', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    const mgr = new OcrInstallManager({ fetchImpl: diskFullFetch(), pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('failed')
    expect(done.error).toBe(tMain('main.ocr.writeFailed'))
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz.part'))).toBe(false)
  })

  it('a network failure still says "check the internet connection"', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    // What undici throws when there is no network.
    const offlineFetch: FetchFn = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as FetchFn
    const mgr = new OcrInstallManager({ fetchImpl: offlineFetch, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.error).toBe(tMain('main.ocr.downloadFailed'))
  })

  it('a present file that cannot be read at start is refused with friendly copy — no raw error, no drive path', async () => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    // A DIRECTORY where the language file belongs: hashing it fails (EISDIR) the way an AV lock
    // or an ACL would, deterministically on every OS.
    mkdirSync(join(root, 'ocr', 'deu.traineddata.gz'), { recursive: true })
    const fetchSpy = vi.fn(correctBytesFetch)
    const mgr = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    const refusal = await mgr.start(startOpts(root, manifests)).catch((e: unknown) => e as Error)
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toBe(tMain('main.ocr.readFailed'))
    expect((refusal as Error).message).not.toContain(root)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a planted .part link is unlinked, never followed — its target is untouched', async (ctx) => {
    const root = tempRoot('ocr')
    const manifests = manifestsDirWith(root, ocrYaml())
    mkdirSync(join(root, 'ocr'), { recursive: true })
    const target = tempRoot('ocr-part-target')
    writeFileSync(join(target, 'keep.txt'), 'precious')
    try {
      symlinkSync(target, join(root, 'ocr', 'deu.traineddata.gz.part'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Neither link kind is creatable here: report SKIPPED, never passed (a junction needs no
      // privilege on Windows, so this runs there and on Linux CI).
      ctx.skip()
      return
    }
    const mgr = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS })
    const job = await mgr.start(startOpts(root, manifests))
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('precious')
    expect(existsSync(join(target, 'deu.traineddata.gz'))).toBe(false)
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz'))).toBe(true)
    expect(existsSync(join(root, 'ocr', 'deu.traineddata.gz.part'))).toBe(false)
  })
})

// ---- Logs are content-free -----------------------------------------------------------------

describe('logs are content-free (#410)', () => {
  it('never carry a URL, a drive root path, or a .traineddata path fragment — but do carry the language codes', async () => {
    const logs: Array<[string, Record<string, unknown> | undefined]> = []
    const log = (msg: string, meta?: Record<string, unknown>): void => {
      logs.push([msg, meta])
    }

    // A full, successful install.
    const root1 = tempRoot('ocr')
    const manifests1 = manifestsDirWith(root1, ocrYaml())
    const mgr1 = new OcrInstallManager({ fetchImpl: correctBytesFetch, pins: FAKE_PINS, log })
    const done1 = await runToEnd(mgr1, (await mgr1.start(startOpts(root1, manifests1))).jobId)
    expect(done1.status).toBe('done')

    // A failed install (checksum mismatch).
    const root2 = tempRoot('ocr')
    const manifests2 = manifestsDirWith(root2, ocrYaml())
    const badFetch: FetchFn = (async () => new Response('wrong-bytes', { status: 200 })) as unknown as FetchFn
    const mgr2 = new OcrInstallManager({ fetchImpl: badFetch, pins: FAKE_PINS, log })
    const done2 = await runToEnd(mgr2, (await mgr2.start(startOpts(root2, manifests2))).jobId)
    expect(done2.status).toBe('failed')

    expect(logs.length).toBeGreaterThan(0)
    const dump = JSON.stringify(logs)
    expect(dump).not.toContain('https')
    expect(dump).not.toContain('example.test')
    // JSON.stringify escapes every backslash, so a Windows drive root appears in `dump` only in its escaped form.
    const asInDump = (s: string): string => JSON.stringify(s).slice(1, -1)
    expect(dump).not.toContain(asInDump(root1))
    expect(dump).not.toContain(asInDump(root2))
    expect(dump).not.toContain('.traineddata')
    expect(dump).toContain('deu')
    expect(dump).toContain('eng')
  })
})

// ---- IPC end to end ------------------------------------------------------------------------

describe('OCR install via IPC (#410)', () => {
  afterEach(async () => {
    await closePerformanceFixture()
  })

  function makeIpcDrive(opts: { locked?: boolean } = {}): {
    root: string
    ctx: ReturnType<typeof ctxWith>
    ocrInstaller: OcrInstallManager
    fetchSpy: ReturnType<typeof vi.fn>
  } {
    const root = freshRoot()
    const manifests = join(root, 'model-manifests')
    mkdirSync(manifests, { recursive: true })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'policy.json'), JSON.stringify({ network: { allow_model_downloads: true } }))
    writeFileSync(join(manifests, 'runtime-sources.yaml'), ocrYaml())
    const db = seededDb(root)
    updateSettings(db, { allowNetwork: true })
    const fetchSpy = vi.fn(correctBytesFetch)
    const ocrInstaller = new OcrInstallManager({ fetchImpl: fetchSpy as unknown as FetchFn, pins: FAKE_PINS })
    const ctx = ctxWith(root, db, {
      paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'config') },
      manifestsDir: manifests,
      isDev: true,
      ocrEngine: null,
      workspace: { isUnlocked: () => opts.locked !== true }
    })
    handlers.clear()
    registerEngineIpc(ctx, undefined, { ocrInstaller })
    return { root, ctx, ocrInstaller, fetchSpy }
  }

  it('refuses while the workspace is locked, before any fetch', async () => {
    const d = makeIpcDrive({ locked: true })
    await expect(invoke(handlers, IPC.installOcr)).rejects.toThrow(tMain('main.download.networkOff'))
    expect(d.fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a payload — the install takes none, and the argument is never echoed', async () => {
    const d = makeIpcDrive()
    await expect(invoke(handlers, IPC.installOcr, { lang: 'fra' })).rejects.toThrow(tMain('main.ocr.badRequest'))
    await expect(invoke(handlers, IPC.installOcr, 'x')).rejects.toThrow(tMain('main.ocr.badRequest'))
    try {
      await invoke(handlers, IPC.installOcr, { lang: 'fra' })
      throw new Error('expected installOcr to reject')
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('fra')
    }
    expect(d.fetchSpy).not.toHaveBeenCalled()
  })

  it('getOcrInstallStatus reports the pinned languages, sizes, source host and licence', async () => {
    makeIpcDrive()
    const { result } = await invoke(handlers, IPC.getOcrInstallStatus)
    const status = result as OcrInstallStatus
    expect(status.available).toBe(true)
    expect(status.languages).toEqual([
      { lang: 'deu', role: 'language', sizeBytes: FAKE_PINS[0].sizeBytes, installed: false },
      { lang: 'eng', role: 'language', sizeBytes: FAKE_PINS[1].sizeBytes, installed: false }
    ])
    expect(status.totalBytes).toBe(FAKE_PINS[0].sizeBytes + FAKE_PINS[1].sizeBytes)
    expect(status.sourceHost).toBe('example.test')
    expect(status.license).toBe('Apache-2.0')
  })

  it('installOcr (no arguments) fills the null OCR slot without a restart once the job completes', async () => {
    const d = makeIpcDrive()
    expect(d.ctx.ocrEngine).toBeNull()
    const { result } = await invoke(handlers, IPC.installOcr)
    const started = result as OcrInstallJob
    const finalJob = await vi.waitFor(
      async () => {
        const { result: polled } = await invoke(handlers, IPC.getOcrInstallJob, started.jobId)
        const j = polled as OcrInstallJob
        if (j.status !== 'done') throw new Error(`not done yet: ${j.status}`)
        return j
      },
      { timeout: hangBudgetMs(5000) }
    )
    expect(finalJob.outcome).toBe('activated')
    expect(d.ctx.ocrEngine).not.toBeNull()
    expect(d.ctx.ocrEngine?.languages).toEqual(['deu', 'eng'])
  })

  it('cancelOcrInstall with a non-string id returns a failed unknown-job snapshot without throwing', async () => {
    makeIpcDrive()
    const { result } = await invoke(handlers, IPC.cancelOcrInstall, 42)
    const job = result as OcrInstallJob
    expect(job.status).toBe('failed')
    expect(job.error).toBe(tMain('main.ocr.unknownJob'))
  })
})
