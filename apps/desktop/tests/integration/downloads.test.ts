import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DownloadManager, assertDownloadAllowed } from '../../src/main/services/downloads'
import type { FetchFn } from '../../src/main/services/assets'
import { applyUiLanguageSetting, tMain } from '../../src/main/services/i18n'
import { weightPath, mmprojPath, type HashStore } from '../../src/main/services/models'
import {
  latestEffectiveRead,
  recordModelLoadRead,
  resetEffectiveReadForTests
} from '../../src/main/services/read-speed'
import type { ModelManifest, ModelRole } from '../../src/shared/manifest'
import type { DownloadJob } from '../../src/shared/types'
import type { UiLanguage } from '../../src/shared/i18n'
import { tempRoot } from '../helpers/db-fixtures'
import { deferred } from '../helpers/deferred'
import { OPEN_GATES, bodyFetch, hangingFetch, rangeFetch, routedFetch, runToEnd } from '../helpers/download-fixtures'
import { until, within } from '../helpers/hang-budget'
import {
  downloadManifest,
  sha256,
  verifiedManifest,
  visionManifest,
  writeDriveFile
} from '../helpers/manifest-fixtures'

// Two seams over the REAL assets module, so no production injection seam is needed; every row
// without a hook runs the real functions unchanged:
// - F17 (#687): `downloadCaps` records the `maxBytes` the manager hands `downloadToFile`. The role
//   defaults are ≥ 4 GiB, so a real body-size bracket around the cap is out of reach here.
// - `verifyHook` holds or faults a verify, the #687 way (BE-4, F-13), calling through to the real one.
// - `freeBytes` is the free space `statfs` reports for the drive (#768); unset, the real volume's.
type VerifyFn = typeof import('../../src/main/services/assets').verifyDownloadedFile
type VerifyHook = (real: VerifyFn, ...args: Parameters<VerifyFn>) => ReturnType<VerifyFn>

const seams = vi.hoisted(() => ({
  downloadCaps: [] as Array<number | undefined>,
  verifyHook: null as VerifyHook | null,
  /** Runs before each real `rm`: a row holds the delete of a bad `.part`, or faults it. */
  rmHook: null as (() => Promise<void>) | null,
  freeBytes: null as number | 'unreadable' | null
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = {
    ...orig,
    rm: async (...args: Parameters<typeof orig.rm>) => {
      await seams.rmHook?.()
      return orig.rm(...args)
    },
    // The real call runs first, so a path that does not exist still throws as it does on a drive.
    statfs: async (...args: Parameters<typeof orig.statfs>) => {
      const real = await orig.statfs(...args)
      if (seams.freeBytes === 'unreadable') throw new Error('statfs: not supported on this volume')
      return seams.freeBytes === null ? real : { ...real, bavail: seams.freeBytes, bsize: 1 }
    }
  }
  return { ...mocked, default: mocked }
})
vi.mock('../../src/main/services/assets', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/main/services/assets')>()
  return {
    ...orig,
    downloadToFile: (...args: Parameters<typeof orig.downloadToFile>) => {
      seams.downloadCaps.push(args[2]?.maxBytes)
      return orig.downloadToFile(...args)
    },
    verifyDownloadedFile: (...args: Parameters<typeof orig.verifyDownloadedFile>) =>
      seams.verifyHook ? seams.verifyHook(orig.verifyDownloadedFile, ...args) : orig.verifyDownloadedFile(...args)
  }
})

afterEach(() => {
  seams.verifyHook = null
  seams.rmHook = null
  seams.freeBytes = null
  applyUiLanguageSetting('en') // main's language is module-global: a row that sets another must not leak it
})

// Phase 18 — the in-app model downloader (architecture.md "In-app model downloader"). Everything
// runs through the INJECTED fake fetch: the suite makes zero real network calls, and the
// gate tests prove a closed gate never even reaches the fetch seam.

/** The suffix is an on-disk contract (a kept .part resumes across versions), so it is spelled here, not imported. */
const partOf = (dest: string): string => `${dest}.part`

const BODY = 'hello-world-weights'

async function cancelAndUnwind(mgr: DownloadManager, jobId: string): Promise<DownloadJob> {
  mgr.cancel(jobId)
  return runToEnd(mgr, jobId)
}

/** Done and failed only: both are set at the end of the run. A cancelled job reads terminal before the run has unwound. */
async function waitForTerminal(mgr: DownloadManager, jobId: string): Promise<DownloadJob> {
  await until(() => {
    const s = mgr.get(jobId).status
    return s === 'done' || s === 'failed'
  }, 'download job finishing')
  return mgr.get(jobId)
}

/** Holds the NEXT verify (one shot; a later file verifies unhooked). */
function gateNextVerify(): { entered: Promise<void>; release: () => void } {
  const entered = deferred()
  const gate = deferred()
  seams.verifyHook = async (real, ...args) => {
    seams.verifyHook = null
    entered.resolve()
    await gate.promise
    return real(...args)
  }
  return { entered: entered.promise, release: () => gate.resolve() }
}

/** A hash that only ends when its signal aborts: a multi-GB weight on a USB stick, for as long as the row needs. */
function hashUntilStopped(): Promise<void> {
  const entered = deferred()
  seams.verifyHook = (_real, _file, _expected, _label, signal) =>
    new Promise((_resolve, reject) => {
      entered.resolve()
      signal?.addEventListener('abort', () => reject(new Error('hash stopped')))
    })
  return entered.promise
}

// ---- gates (the offline guarantee: a closed gate never reaches the network seam) ----

describe('download gates', () => {
  it('assertDownloadAllowed distinguishes the policy ceiling from the Settings toggle', () => {
    expect(() => assertDownloadAllowed({ policyAllows: false, settingAllows: true })).toThrow(
      /drive.s policy/
    )
    expect(() => assertDownloadAllowed({ policyAllows: false, settingAllows: false })).toThrow(
      /drive.s policy/ // policy is authoritative — it wins the explanation too
    )
    expect(() => assertDownloadAllowed({ policyAllows: true, settingAllows: false })).toThrow(
      /Settings/
    )
    expect(() => assertDownloadAllowed(OPEN_GATES)).not.toThrow()
  })

  it('refuses to start when EITHER gate is closed — and never calls fetch', async () => {
    const fetchSpy = vi.fn()
    const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    const root = tempRoot('downloads')
    await expect(
      mgr.start({ rootPath: root, manifest: downloadManifest(), gates: { policyAllows: false, settingAllows: true } })
    ).rejects.toThrow(/policy/)
    await expect(
      mgr.start({ rootPath: root, manifest: downloadManifest(), gates: { policyAllows: true, settingAllows: false } })
    ).rejects.toThrow(/Settings/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mgr.activeJob()).toBeNull()
  })

  it('license gate: a non-approved license needs the explicit acknowledgement', async () => {
    const body = 'pending-license-weights'
    const pending = verifiedManifest(body, {
      license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
    })
    const fetchSpy = vi.fn(bodyFetch(body))
    const root = tempRoot('downloads')
    const mgr = new DownloadManager({ fetchImpl: fetchSpy })
    await expect(
      mgr.start({ rootPath: root, manifest: pending, gates: OPEN_GATES })
    ).rejects.toThrow(/license/)
    expect(fetchSpy).not.toHaveBeenCalled()
    const job = await mgr.start({ rootPath: root, manifest: pending, gates: OPEN_GATES, licenseAccepted: true })
    expect((await waitForTerminal(mgr, job.jobId)).status).toBe('done')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a manifest without a download block is refused', async () => {
    const mgr = new DownloadManager({ fetchImpl: vi.fn() as unknown as FetchFn })
    await expect(
      mgr.start({ rootPath: tempRoot('downloads'), manifest: downloadManifest({ download: undefined }), gates: OPEN_GATES })
    ).rejects.toThrow(/no download source/)
  })

  // Issue #196: the publisher deleted the exact file. The main process refuses BEFORE any
  // request — the Models screen already hides the button, but a renderer bug must never cost
  // the user a multi-GB request into a known 404.
  it('a withdrawn upstream source is refused by NAME and never reaches fetch', async () => {
    const fetchSpy = vi.fn()
    const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    const gone = downloadManifest({
      download: {
        url: 'https://example.test/qwen3-4b.gguf',
        sha256: 'REPLACE_WITH_REAL_HASH',
        size_bytes: 1000,
        license_url: 'https://example.test/license',
        withdrawn: '2026-08-20: Dynamic 3.0 restructure'
      }
    })
    await expect(mgr.start({ rootPath: tempRoot('downloads'), manifest: gone, gates: OPEN_GATES })).rejects.toThrow(
      /qwen3-4b-instruct-q4[\s\S]*removed this exact file[\s\S]*Dynamic 3\.0 restructure/
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  const W = 'verified-weights'
  const G = 'gguf-bytes'
  const P = 'mmproj-bytes'
  it.each<[string, { manifest: ModelManifest; files: Array<[string, string]>; refusal: RegExp }]>([
    [
      'a present + verified weight',
      {
        manifest: verifiedManifest(W),
        files: [['models/chat/qwen3-4b-instruct-q4.gguf', W]],
        refusal: /already downloaded/
      }
    ],
    [
      'a fully present + verified vision model (both files in place)',
      {
        manifest: visionManifest(G, P),
        files: [
          ['models/vision/vl.gguf', G],
          ['models/vision/vl-mmproj.gguf', P]
        ],
        refusal: /already downloaded/
      }
    ],
    [
      'a present placeholder-hash weight',
      {
        manifest: downloadManifest(),
        files: [['models/chat/qwen3-4b-instruct-q4.gguf', 'whatever-bytes']],
        refusal: /cannot be verified/
      }
    ],
    [
      'a vision model with one verified file and one it cannot verify',
      {
        manifest: visionManifest(G, P, { mmprojSha256: 'REPLACE_WITH_REAL_HASH' }),
        files: [
          ['models/vision/vl.gguf', G],
          ['models/vision/vl-mmproj.gguf', P]
        ],
        refusal: /cannot be verified/
      }
    ]
  ])('%s is refused: nothing to download, nothing fetched', async (_title, row) => {
    const root = tempRoot('downloads')
    for (const [rel, body] of row.files) writeDriveFile(root, rel, body)
    const fetchSpy = vi.fn()
    const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    await expect(mgr.start({ rootPath: root, manifest: row.manifest, gates: OPEN_GATES })).rejects.toThrow(row.refusal)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a concurrent start() — single-flight latch closes the check-then-set window (BUG vuln-scan-2026-06-21)', async () => {
    const body = 'hello-world-weights'
    const m = verifiedManifest(body)
    const root = tempRoot('downloads')
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    // Fire two starts in the same tick: the first sets the `starting` latch synchronously
    // before its `await planModelDownloads`, so the second must reject rather than launch a
    // second concurrent run (which previously orphaned the first AbortController).
    const p1 = mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const p2 = mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    await expect(p2).rejects.toThrow(/already running/i)
    const job1 = await p1
    expect(['queued', 'downloading']).toContain(job1.status)
    expect(mgr.activeJob()).toBe(job1.jobId) // exactly one active job
    await cancelAndUnwind(mgr, job1.jobId) // unwind the hanging fetch
  })

  // `cancel()` flips the status at once, with the run still closing its stream on the `.part`. A
  // start in that window used to be accepted, which put two writers on one file.
  it('a cancelled job holds the manager until its run has settled, and the next start resumes (#752)', async () => {
    const m = verifiedManifest(BODY)
    const root = tempRoot('downloads')
    const hanging = hangingFetch('hello-')
    const range = rangeFetch(BODY, { honourRange: true })
    const calls = { n: 0 }
    const fetchImpl: FetchFn = (url, init) => (calls.n++ === 0 ? hanging(url, init) : range.fetch(url, init))
    const mgr = new DownloadManager({ fetchImpl })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    await until(() => mgr.get(job.jobId).receivedBytes > 0, 'the first chunk')

    expect(mgr.cancel(job.jobId).status).toBe('cancelled')
    expect(mgr.activeJob()).toBe(job.jobId)
    await expect(mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })).rejects.toThrow(
      tMain('main.download.alreadyRunning')
    )
    expect(mgr.list()).toEqual([]) // a cancelled job is never listed, however long it takes to unwind

    await runToEnd(mgr, job.jobId)
    expect(mgr.activeJob()).toBeNull()
    const next = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    expect((await waitForTerminal(mgr, next.jobId)).status).toBe('done')
    expect(range.ranges).toEqual(['bytes=6-'])
    expect(readFileSync(weightPath(root, m), 'utf8')).toBe(BODY)
  })

  // #768: before this check a drive with 13.5 GB free took a 14.4 GB download and stopped on ENOSPC near the end. The
  // refusal comes with the others, before the job exists: nothing is listed, audited or requested.
  describe('free space on the drive (#768)', () => {
    const NBSP = String.fromCharCode(0xa0)
    it.each<[string, UiLanguage, number, number, string, string]>([
      ['clearly short', 'en', 14_439_363_584, 13_500_000_000, '14.4 GB', '13.5 GB'],
      // Rounded half, 14.39 GB free would read 14.4 GB, the size itself: free space rounds down.
      ['free rounds down, never up to the size', 'en', 14_439_363_584, 14_390_000_000, '14.4 GB', '14.3 GB'],
      // Both in the same tenth: the size rounds up instead, so the two figures still differ.
      ['the size and the free space in the same tenth', 'en', 14_439_363_584, 14_420_000_000, '14.5 GB', '14.4 GB'],
      // Under a gigabyte (a projector, the rest of a resume) both read in MB, not "0.1 GB" against "0.0 GB".
      ['a shortfall under a gigabyte', 'en', 40_000_000, 15_000_000, '40.0 MB', '15.0 MB'],
      // #804: in main's language, joined as its catalog joins a figure and its unit (U+00A0 outside English
      // and German), so the refusal reads like the download dialog beside it. toThrow compares by code point.
      ['main speaks French', 'fr', 14_439_363_584, 13_500_000_000, `14,4${NBSP}GB`, `13,5${NBSP}GB`]
    ])('refuses a download larger than the free space (%s), naming both figures, before any job, audit or request', async (_title, lang, sizeBytes, freeBytes, needed, free) => {
      seams.freeBytes = freeBytes
      applyUiLanguageSetting(lang)
      const fetchSpy = vi.fn()
      const audit = vi.fn()
      const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn, audit })
      const big = downloadManifest({
        download: {
          url: 'https://example.test/big.gguf',
          sha256: 'REPLACE_WITH_REAL_HASH',
          size_bytes: sizeBytes,
          license_url: 'https://example.test/license'
        }
      })
      await expect(mgr.start({ rootPath: tempRoot('downloads'), manifest: big, gates: OPEN_GATES })).rejects.toThrow(
        tMain('main.download.notEnoughSpace', { needed, free })
      )
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(audit).not.toHaveBeenCalled()
      expect(mgr.list()).toEqual([])
      expect(mgr.activeJob()).toBeNull()
    })

    it('counts a kept .part as fetched: free space for exactly the rest is enough, and the download resumes', async () => {
      const m = verifiedManifest(BODY)
      const root = tempRoot('downloads')
      writeDriveFile(root, `${m.localPath}.part`, BODY.slice(0, 12))
      seams.freeBytes = BODY.length - 12 // the whole file would not fit; no headroom is asked for on top
      const { fetch, ranges } = rangeFetch(BODY, { honourRange: true })
      const mgr = new DownloadManager({ fetchImpl: fetch })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      expect((await waitForTerminal(mgr, job.jobId)).status).toBe('done')
      expect(ranges).toEqual(['bytes=12-'])
    })

    const unsizedProjector = (): ModelManifest => {
      const v = visionManifest(G, P)
      return { ...v, mmproj: { ...v.mmproj!, download: { ...v.mmproj!.download!, sizeBytes: null } } }
    }
    it.each<[string, { manifest: () => ModelManifest; free: number | 'unreadable' }]>([
      // The GGUF's declared 10 bytes alone are more than the 1 byte free: an unknown size is not a zero.
      ['a file of the model declares no size', { manifest: unsizedProjector, free: 1 }],
      ['the drive cannot report its free space', { manifest: () => verifiedManifest(BODY), free: 'unreadable' }]
    ])('does not check when %s, and the download runs', async (_title, row) => {
      seams.freeBytes = row.free
      const { fetch } = routedFetch({
        'https://example.test/qwen3-4b.gguf': BODY,
        'https://example.test/vl.gguf': G,
        'https://example.test/vl-mmproj.gguf': P
      })
      const mgr = new DownloadManager({ fetchImpl: fetch })
      const job = await mgr.start({ rootPath: tempRoot('downloads'), manifest: row.manifest(), gates: OPEN_GATES })
      expect((await waitForTerminal(mgr, job.jobId)).status).toBe('done')
    })
  })
})

// ---- vision: a model is TWO files (GGUF + mmproj projector, DIST-1) ------------------

describe('DownloadManager vision (two files)', () => {
  it('fetches BOTH files, verifies each, and reports the COMBINED progress', async () => {
    const gguf = 'the-language-gguf-bytes'
    const mmproj = 'the-mmproj-projector-bytes'
    const m = visionManifest(gguf, mmproj)
    const root = tempRoot('downloads')
    const { fetch, urls } = routedFetch({
      'https://example.test/vl.gguf': gguf,
      'https://example.test/vl-mmproj.gguf': mmproj
    })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    expect(job.totalBytes).toBe(gguf.length + mmproj.length)

    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(false)
    expect(finished.receivedBytes).toBe(gguf.length + mmproj.length)
    expect(finished.totalBytes).toBe(gguf.length + mmproj.length)
    // The GGUF is fetched before the projector, and both land verified on disk.
    expect(urls).toEqual([
      'https://example.test/vl.gguf',
      'https://example.test/vl-mmproj.gguf'
    ])
    expect(readFileSync(weightPath(root, m), 'utf8')).toBe(gguf)
    expect(readFileSync(mmprojPath(root, m), 'utf8')).toBe(mmproj)
  })

  it('a tampered mmproj fails the job: the GGUF stays, the projector never lands, no install fires', async () => {
    const gguf = 'the-language-gguf-bytes'
    const m = visionManifest(gguf, 'the-mmproj-we-expected')
    const root = tempRoot('downloads')
    const { fetch, urls } = routedFetch({
      'https://example.test/vl.gguf': gguf,
      'https://example.test/vl-mmproj.gguf': 'tampered-mmproj-bytes'
    })
    const installed: string[] = []
    const mgr = new DownloadManager({ fetchImpl: fetch, onModelInstalled: (id) => installed.push(id) })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/checksum/i)
    expect(urls).toHaveLength(2)
    expect(readFileSync(weightPath(root, m), 'utf8')).toBe(gguf)
    expect(existsSync(mmprojPath(root, m))).toBe(false)
    expect(existsSync(partOf(mmprojPath(root, m)))).toBe(false)
    expect(installed).toEqual([])
  })

  it('finishes a half-downloaded vision model: GGUF already present → fetches JUST the mmproj', async () => {
    const gguf = 'already-here-gguf'
    const mmproj = 'still-missing-mmproj'
    const m = visionManifest(gguf, mmproj)
    const root = tempRoot('downloads')
    // The GGUF arrived + verified in a prior run; the mmproj never did (the reported bug).
    writeDriveFile(root, m.localPath, gguf)
    const { fetch, urls } = routedFetch({ 'https://example.test/vl-mmproj.gguf': mmproj })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(urls).toEqual(['https://example.test/vl-mmproj.gguf']) // the present GGUF is NOT re-fetched
    expect(readFileSync(mmprojPath(root, m), 'utf8')).toBe(mmproj)
  })
})

// #310: the same job machinery over a THREE-file shard set — the manager already runs a model's
// tasks as one job with summed bytes, so the whole capability is the planner's extra tasks.
describe('DownloadManager multi-file weight (#310)', () => {
  const shardPath = (n: number): string => `models/chat/big-${String(n).padStart(5, '0')}-of-00003.gguf`
  const shardUrl = (n: number): string => `https://example.test/big-${n}.gguf`
  /** A three-shard manifest whose every hash is the real hash of its body. */
  function shardedManifest(bodies: [string, string, string]): ModelManifest {
    return downloadManifest({
      id: 'sharded-chat',
      local_path: shardPath(1),
      sha256: sha256(bodies[0]),
      download: {
        url: shardUrl(1),
        sha256: sha256(bodies[0]),
        size_bytes: bodies[0].length,
        license_url: 'https://example.test/license'
      },
      files: [2, 3].map((n) => ({
        local_path: shardPath(n),
        sha256: sha256(bodies[n - 1]),
        download: { url: shardUrl(n), sha256: sha256(bodies[n - 1]), size_bytes: bodies[n - 1].length }
      }))
    })
  }
  const BODIES: [string, string, string] = ['shard-one-bytes', 'shard-two-bytes--', 'shard-three-bytes']
  const abs = (root: string, n: number): string => join(root, ...shardPath(n).split('/'))

  it('fetches every shard in order, sums their bytes, and settles done only after the LAST', async () => {
    const m = shardedManifest(BODIES)
    const root = tempRoot('downloads')
    const { fetch, urls } = routedFetch({
      [shardUrl(1)]: BODIES[0],
      [shardUrl(2)]: BODIES[1],
      [shardUrl(3)]: BODIES[2]
    })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    expect(job.totalBytes).toBe(BODIES.reduce((n, b) => n + b.length, 0))

    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(false)
    expect(finished.receivedBytes).toBe(BODIES.reduce((n, b) => n + b.length, 0))
    expect(urls).toEqual([shardUrl(1), shardUrl(2), shardUrl(3)])
    for (const n of [1, 2, 3]) expect(readFileSync(abs(root, n), 'utf8')).toBe(BODIES[n - 1])
  })

  it('fetches only the shards that are missing (a resumed half-installed set)', async () => {
    const m = shardedManifest(BODIES)
    const root = tempRoot('downloads')
    writeDriveFile(root, shardPath(1), BODIES[0]) // shard 1 arrived + verified in a prior run
    writeDriveFile(root, shardPath(3), BODIES[2])
    const { fetch, urls } = routedFetch({ [shardUrl(2)]: BODIES[1] })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    expect((await waitForTerminal(mgr, job.jobId)).status).toBe('done')
    expect(urls).toEqual([shardUrl(2)])
  })

  it('a cancel between files stops before the NEXT shard is requested', async () => {
    const m = shardedManifest(BODIES)
    const root = tempRoot('downloads')
    const { fetch, urls } = routedFetch({
      [shardUrl(1)]: BODIES[0],
      [shardUrl(2)]: BODIES[1],
      [shardUrl(3)]: BODIES[2]
    })
    const installed: string[] = []
    const mgr = new DownloadManager({ fetchImpl: fetch, onModelInstalled: (id) => installed.push(id) })
    // `set` runs inside finishVerifiedFile: past the first file's verify and abort check, past its rename, before run()'s between-files check.
    const cancelLanded = deferred()
    const hashStore: HashStore = {
      get: () => null,
      set: () => {
        mgr.cancel(mgr.activeJob() ?? 'no-active-job')
        cancelLanded.resolve()
      },
      delete: () => undefined
    }
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES, hashStore })
    await within(cancelLanded.promise, 'the first shard finishing')
    await runToEnd(mgr, job.jobId)
    expect(mgr.get(job.jobId).status).toBe('cancelled')
    expect(urls).toEqual([shardUrl(1)]) // shards 2 and 3 were never requested
    expect(readFileSync(abs(root, 1), 'utf8')).toBe(BODIES[0])
    expect(existsSync(abs(root, 2))).toBe(false)
    expect(installed).toEqual([])
  })
})

// ---- #782: switching internet access off ----------------------------------------------
// The switch says "When off, the app makes no internet calls". A transfer stops at once; a job checking a file it already
// has finishes that file and stops before its next request; a job that needs no more network finishes. `onStopped` is
// the notice, so it fires only for a job that really stopped. The settings handler's side is core-model-ipc's.

describe('switching internet access off (#782)', () => {
  it('stops a transfer in progress at once, keeps the .part for resume, says why, and tells once', async () => {
    const m = verifiedManifest(BODY)
    const root = tempRoot('downloads')
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    const onStopped = vi.fn()
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    await until(() => mgr.get(job.jobId).receivedBytes > 0, 'the first chunk')

    mgr.networkSwitched(false, onStopped)
    const done = await runToEnd(mgr, job.jobId)
    expect(done).toMatchObject({ status: 'cancelled', stoppedBy: 'networkOff' })
    expect(onStopped).toHaveBeenCalledOnce()
    expect(readFileSync(partOf(weightPath(root, m)), 'utf8')).toBe('hello-')
    expect(existsSync(weightPath(root, m))).toBe(false)
  })

  it('a job checking its first file finishes that file and stops before the next request', async () => {
    const gguf = 'the-language-gguf-bytes'
    const m = visionManifest(gguf, 'the-mmproj-projector-bytes')
    const root = tempRoot('downloads')
    const { fetch, urls } = routedFetch({
      'https://example.test/vl.gguf': gguf,
      'https://example.test/vl-mmproj.gguf': 'the-mmproj-projector-bytes'
    })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const onStopped = vi.fn()
    const verify = gateNextVerify()
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    await within(verify.entered, 'the GGUF verify')

    mgr.networkSwitched(false, onStopped)
    expect(onStopped).not.toHaveBeenCalled() // the check needs no network: it runs on
    verify.release()
    const done = await runToEnd(mgr, job.jobId)
    expect(done).toMatchObject({ status: 'cancelled', stoppedBy: 'networkOff' })
    expect(onStopped).toHaveBeenCalledOnce()
    expect(urls).toEqual(['https://example.test/vl.gguf']) // the projector was never requested
    expect(readFileSync(weightPath(root, m), 'utf8')).toBe(gguf) // the checked file is in place
    expect(existsSync(mmprojPath(root, m))).toBe(false)
  })

  it('switched back on before the check ends, the job carries on to its next file, and nothing is told', async () => {
    const gguf = 'the-language-gguf-bytes'
    const mmproj = 'the-mmproj-projector-bytes'
    const m = visionManifest(gguf, mmproj)
    const root = tempRoot('downloads')
    const { fetch, urls } = routedFetch({ 'https://example.test/vl.gguf': gguf, 'https://example.test/vl-mmproj.gguf': mmproj })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const onStopped = vi.fn()
    const verify = gateNextVerify()
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    await within(verify.entered, 'the GGUF verify')

    mgr.networkSwitched(false, onStopped)
    mgr.networkSwitched(true)
    verify.release()
    const done = await waitForTerminal(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(onStopped).not.toHaveBeenCalled()
    expect(urls).toEqual(['https://example.test/vl.gguf', 'https://example.test/vl-mmproj.gguf'])
  })

  it('a job checking its last file installs the model, and nothing is told', async () => {
    const m = verifiedManifest(BODY)
    const root = tempRoot('downloads')
    const mgr = new DownloadManager({ fetchImpl: bodyFetch(BODY) })
    const onStopped = vi.fn()
    const verify = gateNextVerify()
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    await within(verify.entered, 'the verify')

    mgr.networkSwitched(false, onStopped)
    verify.release()
    const done = await waitForTerminal(mgr, job.jobId)
    expect(done.status).toBe('done')
    expect(done.stoppedBy).toBeUndefined()
    expect(onStopped).not.toHaveBeenCalled()
    expect(readFileSync(weightPath(root, m), 'utf8')).toBe(BODY)
  })

  it('a job the user already cancelled is not marked or told', async () => {
    const m = verifiedManifest(BODY)
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    const onStopped = vi.fn()
    const job = await mgr.start({ rootPath: tempRoot('downloads'), manifest: m, gates: OPEN_GATES })
    mgr.cancel(job.jobId)
    mgr.networkSwitched(false, onStopped)
    const done = await runToEnd(mgr, job.jobId)
    expect(done.status).toBe('cancelled')
    expect(done.stoppedBy).toBeUndefined()
    expect(onStopped).not.toHaveBeenCalled()
  })

  // The plan can hash a file already on the drive for minutes, after the gates were read.
  it('a start whose planning straddles the switch is refused, and nothing is requested', async () => {
    const fetchSpy = vi.fn()
    const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    // start() runs synchronously to its first await (the plan), past its gate check; the switch lands there.
    const starting = mgr.start({ rootPath: tempRoot('downloads'), manifest: verifiedManifest(BODY), gates: OPEN_GATES })
    mgr.networkSwitched(false)
    await expect(starting).rejects.toThrow(tMain('main.download.networkOff'))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mgr.activeJob()).toBeNull()
    expect(mgr.list()).toEqual([])
  })

  it('a start whose planning straddles a switch off and back on goes ahead', async () => {
    const mgr = new DownloadManager({ fetchImpl: bodyFetch(BODY) })
    const starting = mgr.start({ rootPath: tempRoot('downloads'), manifest: verifiedManifest(BODY), gates: OPEN_GATES })
    mgr.networkSwitched(false)
    mgr.networkSwitched(true)
    const job = await starting
    expect((await waitForTerminal(mgr, job.jobId)).status).toBe('done')
  })
})

// ---- the job state machine ----------------------------------------------------------

describe('DownloadManager jobs', () => {
  it('downloads, verifies, renames .part into place, and PRIMES the checksum cache with the verified hash', async () => {
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    const primed: Array<{ path: string; actual: string }> = []
    const hashStore: HashStore = {
      get: () => null,
      set: (p, entry) => primed.push({ path: p, actual: entry.actual }),
      delete: () => undefined
    }
    const mgr = new DownloadManager({ fetchImpl: rangeFetch(body).fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES, hashStore })
    expect(job.status === 'queued' || job.status === 'downloading').toBe(true)
    expect(job.totalBytes).toBe(body.length)

    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(false)
    expect(finished.receivedBytes).toBe(body.length)
    expect(readFileSync(dest, 'utf8')).toBe(body)
    expect(existsSync(partOf(dest))).toBe(false)
    // Prime (not invalidate) the checksum cache with the hash just verified, so the Models screen
    // reports `installed` without redundantly re-hashing the multi-GB weight (download→verify UX).
    expect(primed.find((p) => p.path === dest)?.actual).toBe(sha256(body))
  })

  // #392 (review round): the prime above is exactly why this file is never re-hashed — so no
  // `checksum` sample will ever exist for it, and its bytes are page-cache-resident from the
  // WRITE. A model start right after the download would time a RAM read and persist it as the
  // drive's speed. `finishVerifiedFile` marks the final path warm instead; that start records
  // nothing at all (honest absence — the download verify is excluded from sampling by design),
  // and the next cold start measures the medium.
  it('a finished download marks its weight page-cache-warm: the start after it records no read sample (#392)', async () => {
    resetEffectiveReadForTests()
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    const mgr = new DownloadManager({ fetchImpl: rangeFetch(body).fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    expect((await waitForTerminal(mgr, job.jobId)).status).toBe('done')

    recordModelLoadRead(dest, 10_000, m.id, 6_000_000_000)
    expect(latestEffectiveRead()).toBeNull()
  })

  it('a download that FAILS verification marks nothing: a later start of that path still samples (#392)', async () => {
    resetEffectiveReadForTests()
    const m = verifiedManifest('the-bytes-we-expected')
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    const mgr = new DownloadManager({ fetchImpl: rangeFetch('tampered-bytes').fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    expect((await waitForTerminal(mgr, job.jobId)).status).toBe('failed')

    recordModelLoadRead(dest, 10_000, m.id, 6_000_000_000)
    expect(latestEffectiveRead()?.source).toBe('model_load')
  })

  it('placeholder expected hash → job done but flagged unverified (checksum honesty, R5)', async () => {
    const m = downloadManifest() // placeholder hashes
    const root = tempRoot('downloads')
    const audited: string[] = []
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch('whatever-bytes').fetch,
      audit: (type) => audited.push(type)
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(true)
    expect(existsSync(weightPath(root, m))).toBe(true)
    expect(audited).toEqual(['model_download_started'])
  })

  // Issue #40: `onModelInstalled` is the seam that lets the app re-run the startup-frozen
  // availability selectors the moment the weights land (the translation sidecar today) — a
  // downloaded model must activate without an app restart.
  it('fires onModelInstalled exactly once when the job reaches done — AFTER the weight is in place', async () => {
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    const installed: Array<{ modelId: string; weightPresent: boolean }> = []
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch(body).fetch,
      onModelInstalled: (modelId) => installed.push({ modelId, weightPresent: existsSync(dest) })
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(installed).toEqual([{ modelId: m.id, weightPresent: true }]) // once, and PRESENCE holds
  })

  it('fires onModelInstalled for a placeholder-hash (unverified) completion too — presence is what the selectors check', async () => {
    const m = downloadManifest() // placeholder hashes → done + unverified
    const root = tempRoot('downloads')
    const installed: string[] = []
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch('whatever-bytes').fetch,
      onModelInstalled: (modelId) => installed.push(modelId)
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(true)
    expect(installed).toEqual([m.id]) // exactly what a restart would see (modelExists)
  })

  it('does NOT fire onModelInstalled on a failed or cancelled job', async () => {
    const installed: string[] = []
    // Failed: checksum mismatch.
    const bad = verifiedManifest('the-bytes-we-expected')
    const root1 = tempRoot('downloads')
    const mgrFail = new DownloadManager({
      fetchImpl: rangeFetch('tampered-bytes').fetch,
      onModelInstalled: (modelId) => installed.push(modelId)
    })
    const failJob = await mgrFail.start({ rootPath: root1, manifest: bad, gates: OPEN_GATES })
    expect((await waitForTerminal(mgrFail, failJob.jobId)).status).toBe('failed')
    // Cancelled: abort mid-stream.
    const m = verifiedManifest('hello-world-weights')
    const root2 = tempRoot('downloads')
    const mgrCancel = new DownloadManager({
      fetchImpl: hangingFetch('hello-'),
      onModelInstalled: (modelId) => installed.push(modelId)
    })
    const cancelJob = await mgrCancel.start({ rootPath: root2, manifest: m, gates: OPEN_GATES })
    await until(() => mgrCancel.get(cancelJob.jobId).receivedBytes > 0, 'the first chunk')
    const finished = await cancelAndUnwind(mgrCancel, cancelJob.jobId)
    expect(finished.status).toBe('cancelled')
    expect(installed).toEqual([])
  })

  it('a throwing onModelInstalled hook never fails the finished job', async () => {
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot('downloads')
    const audited: string[] = []
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch(body).fetch,
      audit: (type) => audited.push(type),
      onModelInstalled: () => {
        throw new Error('selector refresh blew up')
      }
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done') // the download outcome is untouched
    expect(finished.error).toBeNull()
    expect(audited).toContain('model_download_verified') // the rest of run() survived the hook fault
  })

  it('hash mismatch → the partial is DELETED and the job fails with friendly copy', async () => {
    const m = verifiedManifest('the-bytes-we-expected')
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    const audited: string[] = []
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch('tampered-bytes').fetch,
      audit: (type) => audited.push(type)
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/checksum/i)
    expect(finished.error).not.toMatch(/Error:/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(partOf(dest))).toBe(false)
    expect(audited).toEqual(['model_download_started', 'model_download_failed'])
  })

  it('cancel mid-download keeps the .part for resume and never installs a half-weight', async () => {
    const m = verifiedManifest('hello-world-weights')
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    // `receivedBytes`, not the on-disk size: the chunk may still be buffered here, and the resume prefix
    // survives only because the failed stream flushes it (`end()`). A `destroy()` would drop it.
    await until(() => mgr.get(job.jobId).receivedBytes > 0, 'the first chunk arriving')

    const finished = await cancelAndUnwind(mgr, job.jobId)
    expect(finished.status).toBe('cancelled')
    expect(readFileSync(partOf(dest), 'utf8')).toBe('hello-')
    expect(existsSync(dest)).toBe(false)
  })

  it('resumes a kept .part with a Range request (206 appends; hash verifies the whole)', async () => {
    const body = 'hello-world-weights'
    const m = verifiedManifest(body)
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    writeDriveFile(root, `${m.localPath}.part`, 'hello-') // a previous cancelled attempt
    const { fetch, ranges } = rangeFetch(body, { honourRange: true })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(ranges[0]).toBe('bytes=6-')
    expect(finished.status).toBe('done')
    expect(finished.receivedBytes).toBe(body.length)
    expect(readFileSync(dest, 'utf8')).toBe(body)
  })

  it('restarts cleanly when the server ignores the Range header (200 truncates)', async () => {
    const body = 'fresh-complete-weights'
    const m = verifiedManifest(body)
    const root = tempRoot('downloads')
    const dest = weightPath(root, m)
    writeDriveFile(root, `${m.localPath}.part`, 'stale-garbage-prefix')
    const { fetch, ranges } = rangeFetch(body) // honourRange off → plain 200
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(ranges[0]).toBe('bytes=20-') // we ASKED to resume…
    expect(finished.status).toBe('done') // …the 200 restarted instead of corrupting
    expect(readFileSync(dest, 'utf8')).toBe(body)
    expect(statSync(dest).size).toBe(body.length)
  })

  it('one download at a time: a second start is refused while one runs', async () => {
    const m = verifiedManifest('hello-world-weights')
    const root = tempRoot('downloads')
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    await expect(
      mgr.start({ rootPath: tempRoot('downloads'), manifest: downloadManifest({ id: 'other-model' }), gates: OPEN_GATES })
    ).rejects.toThrow(/one model downloads at a time/i)
    await cancelAndUnwind(mgr, job.jobId)
  })

  it('an HTTP error fails the job with friendly copy (no half-state)', async () => {
    const m = downloadManifest()
    const root = tempRoot('downloads')
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as FetchFn
    const mgr = new DownloadManager({ fetchImpl: notFound })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/could not start/)
    expect(existsSync(weightPath(root, m))).toBe(false)
  })

  it('polling an unknown job id reports a terminal failed state (pollers stop gracefully)', () => {
    const mgr = new DownloadManager({ fetchImpl: vi.fn() as unknown as FetchFn })
    const job = mgr.get('no-such-job')
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/Unknown/)
  })

  // F17 (audit-postmerge-2026-06-29): the model downloader must ALWAYS pass a bounded `maxBytes` to
  // downloadToFile — the manifest's size plus drift headroom when known, else a per-role default — so a
  // redirected / Content-Length-less endpoint can't fall through to the multi-GiB backstop and fill the drive.
  describe('size cap (F17)', () => {
    const GiB = 1024 * 1024 * 1024

    it.each<[string, { role: ModelRole; cap: number }]>([
      ['chat', { role: 'chat', cap: 40 * GiB }],
      ['embeddings', { role: 'embeddings', cap: 4 * GiB }]
    ])('passes a bounded per-role maxBytes even when the manifest omits size_bytes: %s', async (_title, row) => {
      const body = 'weights-with-no-declared-size'
      const m = downloadManifest({
        role: row.role,
        sha256: sha256(body),
        // download block WITHOUT size_bytes → planOneFile sets sizeBytes:null.
        download: { url: 'https://example.test/x.gguf', sha256: sha256(body), license_url: 'https://example.test/l' }
      })
      seams.downloadCaps.length = 0
      const mgr = new DownloadManager({ fetchImpl: rangeFetch(body).fetch })
      const job = await mgr.start({ rootPath: tempRoot('downloads'), manifest: m, gates: OPEN_GATES })
      expect((await waitForTerminal(mgr, job.jobId)).status).toBe('done')
      expect(seams.downloadCaps).toEqual([row.cap])
    })

    it('COMPLETES a fresh download whose real body is larger than the declared size_bytes (regression)', async () => {
      // The reported failure: the true upstream file is a few % bigger than the manifest's size_bytes,
      // so the old exact cap (size_bytes + 1 MiB) aborted the stream near the end (~95%). With the
      // drift-tolerant cap the same download now runs to completion and verifies. Body is 1.5 MiB and
      // the declared size only 256 KiB — a >1 MiB overshoot that the OLD cap would have truncated.
      const body = 'q'.repeat(Math.ceil(1.5 * 1024 * 1024))
      const declared = 256 * 1024
      const m = downloadManifest({
        sha256: sha256(body),
        download: {
          url: 'https://example.test/big.gguf',
          sha256: sha256(body),
          size_bytes: declared, // UNDER-declared vs the real body
          license_url: 'https://example.test/license'
        }
      })
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      const mgr = new DownloadManager({ fetchImpl: rangeFetch(body).fetch })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('done')
      expect(finished.unverified).toBe(false)
      expect(finished.receivedBytes).toBe(body.length)
      expect(readFileSync(dest, 'utf8')).toBe(body)
    })
  })

  // full-audit 2026-07-10 BE-2: the persistent checksum cache is an OPTIMIZATION. Locking the
  // encrypted workspace mid-download closes the settings DB, so the store's set/delete can
  // throw ("database is not open") on completion — that fault must never turn a verified,
  // in-place download into a failed job, suppress onModelInstalled, or skip a later file.
  describe('hash-store faults (BE-2)', () => {
    const placeholders = (m: ModelManifest): ModelManifest => ({
      ...m,
      sha256: 'REPLACE_WITH_REAL_HASH',
      mmproj: m.mmproj && { ...m.mmproj, sha256: 'REPLACE_WITH_REAL_HASH' }
    })

    it.each<[string, { hashes: 'real' | 'placeholder'; sets: number; deletes: number; unverified: boolean }]>([
      ['a real hash primes', { hashes: 'real', sets: 2, deletes: 0, unverified: false }],
      ['a placeholder invalidates, never primes', { hashes: 'placeholder', sets: 0, deletes: 2, unverified: true }]
    ])('a store whose set/delete throws (workspace locked mid-download) never changes the job outcome: %s', async (_title, row) => {
      const gguf = 'the-language-gguf-bytes'
      const mmproj = 'the-mmproj-projector-bytes'
      const base = visionManifest(gguf, mmproj) // TWO tasks — the second must still run
      const m = row.hashes === 'real' ? base : placeholders(base)
      const root = tempRoot('downloads')
      let sets = 0
      let deletes = 0
      const lockedStore: HashStore = {
        get: () => null,
        set: () => {
          sets++
          throw new Error('database is not open')
        },
        delete: () => {
          deletes++
          throw new Error('database is not open')
        }
      }
      const installed: string[] = []
      const { fetch, urls } = routedFetch({
        'https://example.test/vl.gguf': gguf,
        'https://example.test/vl-mmproj.gguf': mmproj
      })
      const mgr = new DownloadManager({
        fetchImpl: fetch,
        onModelInstalled: (modelId) => installed.push(modelId)
      })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES, hashStore: lockedStore })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('done') // the cache fault never reached the job outcome
      expect(finished.unverified).toBe(row.unverified)
      expect(installed).toEqual([m.id]) // fired exactly once — #40 activation preserved
      // The second task ran despite the first file's store fault, and both files are in place.
      expect(urls).toEqual(['https://example.test/vl.gguf', 'https://example.test/vl-mmproj.gguf'])
      expect(readFileSync(weightPath(root, m), 'utf8')).toBe(gguf)
      expect(readFileSync(mmprojPath(root, m), 'utf8')).toBe(mmproj)
      expect(sets).toBe(row.sets)
      expect(deletes).toBe(row.deletes)
    })
  })

  // full-audit 2026-07-10 BE-4: `cancel()` used to act only on queued/downloading — a cancel
  // during `verifying` (a multi-GB SHA-256 on USB takes minutes) was silently dropped and a
  // two-task job then started downloading its next file.
  describe('cancel during verifying (BE-4)', () => {
    const gguf = 'the-language-gguf-bytes'
    const mmproj = 'the-mmproj-projector-bytes'
    function twoFileRun(): { m: ModelManifest; root: string; dest: string; mgr: DownloadManager; urls: string[] } {
      const m = visionManifest(gguf, mmproj)
      const root = tempRoot('downloads')
      const { fetch, urls } = routedFetch({
        'https://example.test/vl.gguf': gguf,
        'https://example.test/vl-mmproj.gguf': mmproj
      })
      return { m, root, dest: weightPath(root, m), mgr: new DownloadManager({ fetchImpl: fetch }), urls }
    }

    it('is honoured: terminal cancelled, nothing renamed, .part kept, the second file never starts', async () => {
      const { m, root, dest, mgr, urls } = twoFileRun()
      const gate = gateNextVerify()
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      await within(gate.entered, 'the first verify starting')
      expect(mgr.get(job.jobId).status).toBe('verifying')
      expect(mgr.cancel(job.jobId).status).toBe('cancelled') // previously a silent no-op in this state
      gate.release()
      await runToEnd(mgr, job.jobId)
      expect(mgr.get(job.jobId).status).toBe('cancelled')
      // The mid-download-cancel contract holds here too: nothing renamed into place, the
      // fully-downloaded .part KEPT for the next attempt…
      expect(existsSync(dest)).toBe(false)
      expect(readFileSync(partOf(dest), 'utf8')).toBe(gguf)
      // …and task 2 (the mmproj) was never requested.
      expect(urls).toEqual(['https://example.test/vl.gguf'])
    })

    // The hash used to run on for minutes with the job already reading cancelled, so a run-settled
    // latch alone would have turned a restart into "already running" for all that time.
    it('stops the hash itself, so the run settles at once (#752)', async () => {
      const { m, root, dest, mgr, urls } = twoFileRun()
      const hashing = hashUntilStopped()
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      await within(hashing, 'the first verify starting')
      mgr.cancel(job.jobId)
      const settled = await runToEnd(mgr, job.jobId)
      expect(settled.status).toBe('cancelled')
      expect(settled.error).toBeNull()
      expect(existsSync(dest)).toBe(false)
      expect(readFileSync(partOf(dest), 'utf8')).toBe(gguf)
      expect(urls).toEqual(['https://example.test/vl.gguf'])
    })

    it('the same held verify with no cancel renames the file and goes on to the second', async () => {
      const { m, root, dest, mgr, urls } = twoFileRun()
      const gate = gateNextVerify()
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      await within(gate.entered, 'the first verify starting')
      gate.release()
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('done')
      expect(readFileSync(dest, 'utf8')).toBe(gguf)
      expect(urls).toEqual(['https://example.test/vl.gguf', 'https://example.test/vl-mmproj.gguf'])
    })
  })

  // BUG dl-size-cap-2026-07-03 — a misaligned 206 resume discards the poisoned .part for a clean restart.
  describe('resume-offset self-heal', () => {
    it('a 206 whose Content-Range starts at the WRONG offset fails the job AND deletes the .part', async () => {
      const body = 'hello-world-weights'
      const m = verifiedManifest(body)
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, 'hello-') // a prior partial (6 bytes); resume asks for bytes=6-
      // Server answers 206 but from byte 0 (wrong slice) — appending would corrupt the file.
      const fetchImpl = (async () =>
        new Response(body, {
          status: 206,
          headers: { 'content-length': String(body.length), 'content-range': `bytes 0-${body.length - 1}/${body.length}` }
        })) as unknown as FetchFn
      const reasons: unknown[] = []
      const mgr = new DownloadManager({ fetchImpl, audit: (_type, _message, meta) => reasons.push(meta.reason) })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('failed')
      // Poisoned prefix discarded → the next attempt restarts clean rather than re-appending.
      expect(existsSync(partOf(dest))).toBe(false)
      expect(existsSync(dest)).toBe(false)
      // …and the copy says so: `main.download.interrupted` promises to keep the part this just deleted (#752).
      expect(finished.error).toBe(tMain('main.download.resumeDiscarded'))
      expect(reasons.at(-1)).toBe('resume-offset')
    })
  })

  // #752: a job's error and its audit record used to carry `err.message`, and an errno's message
  // names the drive path. The audit log's data class is ids and counts (security-model.md).
  describe('what a failure says', () => {
    function auditingManager(fetchImpl: FetchFn): { mgr: DownloadManager; reasons: unknown[] } {
      const reasons: unknown[] = []
      const mgr = new DownloadManager({ fetchImpl, audit: (_type, _message, meta) => reasons.push(meta.reason) })
      return { mgr, reasons }
    }

    it('a rename that fails on the drive leaves the .part, and the retry lands', async () => {
      const m = verifiedManifest(BODY)
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      seams.verifyHook = async (real, ...args) => {
        seams.verifyHook = null
        const result = await real(...args)
        mkdirSync(dest) // a real errno on every OS: EPERM on Windows, EISDIR elsewhere
        return result
      }
      const { mgr, reasons } = auditingManager(bodyFetch(BODY))
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('failed')
      expect(finished.error).toBe(tMain('main.download.writeFailed'))
      expect(reasons.at(-1)).toBe('write')
      expect(readFileSync(partOf(dest), 'utf8')).toBe(BODY)

      rmSync(dest, { recursive: true })
      const retry = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      expect((await waitForTerminal(mgr, retry.jobId)).status).toBe('done')
      expect(readFileSync(dest, 'utf8')).toBe(BODY)
    })

    it.each<[string, Record<string, string>]>([
      ['a full drive, which names no path of its own', { code: 'ENOSPC' }],
      ['a file past the drive format limit', { code: 'EFBIG' }],
      ['any other errno that names a path', { code: 'UNKNOWN', path: 'D:\\models\\w.gguf.part' }]
    ])('%s reads as the drive', async (_title, fields) => {
      const m = verifiedManifest(BODY)
      seams.verifyHook = async () => {
        throw Object.assign(new Error(`${fields.code}: failed, open '${fields.path}'`), fields)
      }
      const { mgr, reasons } = auditingManager(bodyFetch(BODY))
      const job = await mgr.start({ rootPath: tempRoot('downloads'), manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.error).toBe(tMain('main.download.writeFailed'))
      expect(reasons.at(-1)).toBe('write')
    })

    it('a connection that drops keeps the resume promise, which is true there, and audits no URL', async () => {
      const m = verifiedManifest(BODY)
      const root = tempRoot('downloads')
      // The drop waits for the chunk to arrive: an error right behind it discards it, and the `.part` stays empty.
      let drop: (err: Error) => void = () => undefined
      const droppable: FetchFn = async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('hello-'))
              drop = (err) => c.error(err)
            }
          }),
          { status: 200 }
        )
      const { mgr, reasons } = auditingManager(droppable)
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      await until(() => mgr.get(job.jobId).receivedBytes > 0, 'the first chunk')
      drop(new Error('connection reset'))
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.error).toBe(tMain('main.download.interrupted', { reason: 'connection reset' }))
      expect(reasons.at(-1)).toBe('network')
      expect(readFileSync(partOf(weightPath(root, m)), 'utf8')).toBe('hello-')
    })

    it.each<[string, FetchFn, string, string]>([
      [
        'no connection',
        async () => {
          throw new Error('fetch failed')
        },
        'fetch failed',
        'network'
      ],
      [
        'a redirect to nowhere',
        async () => new Response(null, { status: 302 }),
        'redirect with no Location for https://example.test/qwen3-4b.gguf',
        'redirect'
      ]
    ])('a request that ends before its first byte promises nothing, there being no part to keep: %s', async (_title, fetchImpl, reason, label) => {
      const m = verifiedManifest(BODY)
      const root = tempRoot('downloads')
      const { mgr, reasons } = auditingManager(fetchImpl)
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.error).toBe(tMain('main.download.httpFailed', { reason }))
      expect(reasons.at(-1)).toBe(label)
      expect(existsSync(partOf(weightPath(root, m)))).toBe(false)
    })

    // Thrown from the catch that handles the mismatch, this left the job at `downloading` for good.
    it('a misaligned resume whose .part cannot be deleted fails by the drive, and is not stranded', async () => {
      const m = verifiedManifest(BODY)
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, 'hello-')
      const misaligned = (async () =>
        new Response(BODY, {
          status: 206,
          headers: { 'content-length': String(BODY.length), 'content-range': `bytes 0-${BODY.length - 1}/${BODY.length}` }
        })) as unknown as FetchFn
      seams.rmHook = async () => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      const { mgr, reasons } = auditingManager(misaligned)
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.error).toBe(tMain('main.download.writeFailed'))
      expect(reasons.at(-1)).toBe('write')
      expect(readFileSync(partOf(dest), 'utf8')).toBe('hello-')
    })
  })

  // F-13 (full-audit 2026-07-16): a COMPLETE `.part` (a cancel/crash during the minutes-long
  // verify, or a failed rename, leaves the whole file staged) used to be re-requested with an
  // unsatisfiable `Range: bytes=<fullSize>-` → HTTP 416 forever, with no in-app recovery. The
  // fix verifies the staged bytes IN PLACE: a match renames into place; a mismatch discards +
  // restarts clean.
  describe('complete .part recovery (F-13)', () => {
    it('a matching complete .part renames into place WITHOUT re-requesting (no 416 dead-end)', async () => {
      const body = 'hello-world-weights'
      const m = verifiedManifest(body) // size_bytes = body.length
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, body) // the full file, staged by a cancel-during-verify
      const fetchSpy = vi.fn()
      const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('done')
      expect(finished.unverified).toBe(false)
      // The pre-download short-circuit means the unsatisfiable Range is never even sent.
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(readFileSync(dest, 'utf8')).toBe(body)
      expect(existsSync(partOf(dest))).toBe(false)
    })

    it('a caught HTTP 416 on a complete .part (size unknown) verifies in place → done', async () => {
      const body = 'hello-world-weights'
      // No size_bytes → the pre-download short-circuit cannot fire; recovery goes via the 416 catch.
      const m = downloadManifest({
        sha256: sha256(body),
        download: { url: 'https://example.test/x.gguf', sha256: sha256(body), license_url: 'https://example.test/l' }
      })
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, body) // complete file already staged
      const ranges: Array<string | null> = []
      const only416 = (async (_url: unknown, init?: RequestInit) => {
        ranges.push(new Headers(init?.headers).get('range'))
        return new Response(null, { status: 416 }) // Range Not Satisfiable — the .part is complete
      }) as unknown as FetchFn
      const mgr = new DownloadManager({ fetchImpl: only416 })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(ranges[0]).toBe('bytes=19-') // we DID ask to resume the full-length .part…
      expect(finished.status).toBe('done') // …and recovered by verifying it in place, not looping
      expect(readFileSync(dest, 'utf8')).toBe(body)
      expect(existsSync(partOf(dest))).toBe(false)
    })

    it('a throw INSIDE the 416-path settle fails the job (never a stuck job / unhandled rejection)', async () => {
      // Review fix-up (Phase 5): the catch-path settleCompletePart invocation had no exception
      // protection — a rename/finish failure on the AV-interfered destination (the audit F-13
      // entry's own named producer of complete .parts) escaped runOne, became an unhandled
      // rejection, and left the job stuck at non-terminal 'verifying' forever (no error copy,
      // never pruned). Deterministic stand-in for the AV interference: the hooked verifier
      // reports OK and then the `.part` VANISHES (AV quarantine) before the rename, so
      // finishVerifiedFile's renameSync throws inside the settle.
      const body = 'hello-world-weights'
      // No size_bytes → the pre-download short-circuit cannot fire; recovery goes via the 416 catch.
      const m = downloadManifest({
        sha256: sha256(body),
        download: { url: 'https://example.test/x.gguf', sha256: sha256(body), license_url: 'https://example.test/l' }
      })
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, body) // complete file already staged
      const only416 = (async () => new Response(null, { status: 416 })) as unknown as FetchFn
      seams.verifyHook = async (real, ...args) => {
        const result = await real(...args) // ok: the bytes DO verify
        rmSync(args[0]) // then the .part vanishes (AV quarantine), so the rename throws
        return result
      }
      const reasons: unknown[] = []
      const mgr = new DownloadManager({
        fetchImpl: only416,
        audit: (_type, _message, meta) => reasons.push(meta.reason)
      })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId) // pre-fix: stuck at 'verifying' → timeout
      expect(finished.status).toBe('failed')
      // No raw errno text, no drive path, and no promise to resume a `.part` that is gone (#752).
      expect(finished.error).toBe(tMain('main.download.writeFailed'))
      expect(reasons.at(-1)).toBe('write')
      expect(existsSync(dest)).toBe(false) // nothing half-renamed into place
    })

    it('a cancel during the complete .part verify keeps it and renames nothing', async () => {
      const body = 'hello-world-weights'
      const m = verifiedManifest(body)
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, body)
      const fetchSpy = vi.fn()
      const gate = gateNextVerify()
      const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      await within(gate.entered, 'the complete .part verify starting')
      expect(mgr.cancel(job.jobId).status).toBe('cancelled')
      gate.release()
      await runToEnd(mgr, job.jobId)
      expect(mgr.get(job.jobId).status).toBe('cancelled')
      expect(existsSync(dest)).toBe(false)
      expect(readFileSync(partOf(dest), 'utf8')).toBe(body)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    // A cancel in any of these deletes used to be overwritten: by 'downloading' on the clean restart,
    // by 'failed' on the other two. The renderer stopped polling on `cancelled`, so a late `failed`
    // turned up in the reloaded screen and the audit log as a failure the user never had.
    it.each<[string, { staged: string | null; fetchImpl: FetchFn }]>([
      ['the restart past a corrupt complete .part', { staged: 'x'.repeat(BODY.length), fetchImpl: vi.fn() as unknown as FetchFn }],
      [
        'a misaligned resume',
        {
          staged: 'hello-',
          fetchImpl: (async () =>
            new Response(BODY, {
              status: 206,
              headers: { 'content-length': String(BODY.length), 'content-range': `bytes 0-${BODY.length - 1}/${BODY.length}` }
            })) as unknown as FetchFn
        }
      ],
      ['a checksum mismatch', { staged: null, fetchImpl: rangeFetch('tampered-bytes').fetch }]
    ])('a cancel during the delete of a bad .part stands: %s', async (_title, row) => {
      const m = verifiedManifest(BODY)
      const root = tempRoot('downloads')
      if (row.staged != null) writeDriveFile(root, `${m.localPath}.part`, row.staged)
      const reached = deferred()
      const held = deferred()
      seams.rmHook = async () => {
        reached.resolve()
        await held.promise
      }
      const audited: string[] = []
      const mgr = new DownloadManager({ fetchImpl: row.fetchImpl, audit: (type) => audited.push(type) })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      await within(reached.promise, 'the bad .part being deleted')
      mgr.cancel(job.jobId)
      held.resolve()
      const settled = await runToEnd(mgr, job.jobId)
      expect(settled.status).toBe('cancelled')
      expect(settled.error).toBeNull()
      expect(audited).toEqual(['model_download_started'])
    })

    // The two ways in differ in what catches the stopped hash: the 416 route's settle sits in its
    // own catch, which fails the job on anything it does not recognise (#752).
    it.each<[string, { sizeKnown: boolean; fetchImpl: FetchFn }]>([
      ['the size check', { sizeKnown: true, fetchImpl: vi.fn() as unknown as FetchFn }],
      ['a caught 416', { sizeKnown: false, fetchImpl: (async () => new Response(null, { status: 416 })) as unknown as FetchFn }]
    ])('a cancel stops the hash of a complete .part reached through %s', async (_title, row) => {
      const m = downloadManifest({
        sha256: sha256(BODY),
        download: {
          url: 'https://example.test/x.gguf',
          sha256: sha256(BODY),
          license_url: 'https://example.test/l',
          ...(row.sizeKnown ? { size_bytes: BODY.length } : {})
        }
      })
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, BODY)
      const hashing = hashUntilStopped()
      const audited: string[] = []
      const logged: string[] = []
      const mgr = new DownloadManager({
        fetchImpl: row.fetchImpl,
        audit: (type) => audited.push(type),
        log: (message) => logged.push(message)
      })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      await within(hashing, 'the complete .part verify starting')
      mgr.cancel(job.jobId)
      const settled = await runToEnd(mgr, job.jobId)
      expect(settled.status).toBe('cancelled')
      expect(settled.error).toBeNull()
      expect(audited).toEqual(['model_download_started'])
      expect(logged.filter((message) => /failed/.test(message))).toEqual([]) // a cancel is not a failure in app.log either
      expect(existsSync(dest)).toBe(false)
      expect(readFileSync(partOf(dest), 'utf8')).toBe(BODY)
    })

    it.each<[string, { staged: boolean; fetchImpl: FetchFn }]>([
      ['a fresh download', { staged: false, fetchImpl: bodyFetch(BODY) }],
      ['a staged complete .part', { staged: true, fetchImpl: vi.fn() as unknown as FetchFn }]
    ])('a .part that vanishes before the verify of %s fails by name', async (_title, row) => {
      const m = verifiedManifest(BODY)
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      if (row.staged) writeDriveFile(root, `${m.localPath}.part`, BODY)
      seams.verifyHook = async (real, ...args) => {
        rmSync(args[0]) // antivirus or a pulled drive, between the last byte and the hash
        return real(...args)
      }
      const audited: Array<{ type: string; reason: unknown }> = []
      const mgr = new DownloadManager({
        fetchImpl: row.fetchImpl,
        audit: (type, _message, meta) => audited.push({ type, reason: meta.reason })
      })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('failed')
      expect(finished.error).toBe(tMain('main.download.fileMissing'))
      expect(audited.at(-1)).toEqual({ type: 'model_download_failed', reason: 'file missing before verification' })
      expect(existsSync(dest)).toBe(false)
    })

    // The clean restart truncates the `.part` when it gets as far as writing. A restart that fails
    // first is what shows the delete: without it the next attempt hashes the same bad bytes again.
    it('a corrupt complete .part stays gone when the clean restart fails', async () => {
      const body = 'fresh-complete-weights'
      const m = verifiedManifest(body)
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      writeDriveFile(root, `${m.localPath}.part`, 'X'.repeat(body.length))
      const unavailable = (async () => new Response(null, { status: 503 })) as unknown as FetchFn
      const mgr = new DownloadManager({ fetchImpl: unavailable })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      expect((await waitForTerminal(mgr, job.jobId)).status).toBe('failed')
      expect(existsSync(partOf(dest))).toBe(false)
      expect(existsSync(dest)).toBe(false)
    })

    it('a complete-but-CORRUPT .part is discarded and the download restarts clean', async () => {
      const body = 'fresh-complete-weights'
      const m = verifiedManifest(body) // size_bytes = body.length
      const root = tempRoot('downloads')
      const dest = weightPath(root, m)
      // A torn/aborted prior write left a full-length .part whose bytes DON'T match the hash.
      writeDriveFile(root, `${m.localPath}.part`, 'X'.repeat(body.length))
      const { fetch, ranges } = rangeFetch(body) // honourRange off → 200 full body on a fresh request
      const mgr = new DownloadManager({ fetchImpl: fetch })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      // The corrupt .part failed verify → discarded → a single clean re-download (no Range).
      expect(ranges).toEqual([null])
      expect(finished.status).toBe('done')
      expect(finished.unverified).toBe(false)
      expect(readFileSync(dest, 'utf8')).toBe(body)
      expect(existsSync(partOf(dest))).toBe(false)
    })
  })
})
