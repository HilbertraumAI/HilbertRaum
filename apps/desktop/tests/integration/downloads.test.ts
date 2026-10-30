import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DownloadManager, assertDownloadAllowed } from '../../src/main/services/downloads'
import type { FetchFn } from '../../src/main/services/assets'
import { weightPath, mmprojPath, type HashStore } from '../../src/main/services/models'
import {
  latestEffectiveRead,
  recordModelLoadRead,
  resetEffectiveReadForTests
} from '../../src/main/services/read-speed'
import type { ModelManifest, ModelRole } from '../../src/shared/manifest'
import type { DownloadJob } from '../../src/shared/types'
import { tempRoot } from '../helpers/db-fixtures'
import { deferred } from '../helpers/deferred'
import { OPEN_GATES, bodyFetch, hangingFetch, rangeFetch, routedFetch } from '../helpers/download-fixtures'
import { until, within } from '../helpers/hang-budget'
import {
  downloadManifest,
  sha256,
  verifiedManifest,
  visionManifest,
  writeDriveFile
} from '../helpers/manifest-fixtures'

// Three seams over the REAL assets module, so no production injection seam is needed; every row
// without a hook runs the real functions unchanged:
// - F17 (#687): `downloadCaps` records the `maxBytes` the manager hands `downloadToFile`. The role
//   defaults are ≥ 4 GiB, so a real body-size bracket around the cap is out of reach here.
// - `inFlight` counts the running `downloadToFile` calls. A cancelled job reads terminal at once, so
//   `runUnwound` waits on this instead (the manager has no run-settled latch, defect A1).
// - `verifyHook` holds or faults a verify, the #687 way (BE-4, F-13), calling through to the real one.
type VerifyFn = typeof import('../../src/main/services/assets').verifyDownloadedFile
type VerifyHook = (real: VerifyFn, ...args: Parameters<VerifyFn>) => ReturnType<VerifyFn>

const seams = vi.hoisted(() => ({
  downloadCaps: [] as Array<number | undefined>,
  inFlight: 0,
  verifyHook: null as VerifyHook | null
}))
vi.mock('../../src/main/services/assets', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/main/services/assets')>()
  return {
    ...orig,
    downloadToFile: (...args: Parameters<typeof orig.downloadToFile>) => {
      seams.downloadCaps.push(args[2]?.maxBytes)
      seams.inFlight++
      return orig.downloadToFile(...args).finally(() => {
        seams.inFlight--
      })
    },
    verifyDownloadedFile: (...args: Parameters<typeof orig.verifyDownloadedFile>) =>
      seams.verifyHook ? seams.verifyHook(orig.verifyDownloadedFile, ...args) : orig.verifyDownloadedFile(...args)
  }
})

afterEach(() => {
  seams.verifyHook = null
})

// Phase 18 — the in-app model downloader (architecture.md "In-app model downloader"). Everything
// runs through the INJECTED fake fetch: the suite makes zero real network calls, and the
// gate tests prove a closed gate never even reaches the fetch seam.

/** The suffix is an on-disk contract (a kept .part resumes across versions), so it is spelled here, not imported. */
const partOf = (dest: string): string => `${dest}.part`

/** One macrotask: run()'s continuation after an awaited step runs in microtasks. Justified hop, no observable. */
const hop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** For a job the row cancelled: its status flips at once, so wait for the stream instead. Hop first: a run going on to its next file starts it in microtasks. */
async function runUnwound(): Promise<void> {
  await hop()
  await until(() => seams.inFlight === 0, 'download stream unwound')
  await hop()
}

async function cancelAndUnwind(mgr: DownloadManager, jobId: string): Promise<DownloadJob> {
  mgr.cancel(jobId)
  await runUnwound()
  return mgr.get(jobId)
}

/** Done and failed only: both are set at the end of the run. A cancelled job reads terminal before the run has unwound. */
async function waitForTerminal(mgr: DownloadManager, jobId: string): Promise<DownloadJob> {
  await until(() => {
    const s = mgr.get(jobId).status
    return s === 'done' || s === 'failed' || s === 'cancelled'
  }, 'download job reaching a terminal state')
  return mgr.get(jobId)
}

/** Holds the NEXT verify (one shot; a later file verifies unhooked). */
function gateNextVerify(): { entered: Promise<void>; returned: Promise<void>; release: () => void } {
  const entered = deferred()
  const gate = deferred()
  const returned = deferred()
  seams.verifyHook = async (real, ...args) => {
    seams.verifyHook = null
    entered.resolve()
    await gate.promise
    const result = await real(...args)
    returned.resolve()
    return result
  }
  return { entered: entered.promise, returned: returned.promise, release: () => gate.resolve() }
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
    await runUnwound()
    expect(mgr.get(job.jobId).status).toBe('cancelled')
    expect(urls).toEqual([shardUrl(1)]) // shards 2 and 3 were never requested
    expect(readFileSync(abs(root, 1), 'utf8')).toBe(BODIES[0])
    expect(existsSync(abs(root, 2))).toBe(false)
    expect(installed).toEqual([])
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
    // The on-disk size, not `receivedBytes`: that counts the chunk before the buffered write lands.
    await until(() => existsSync(partOf(dest)) && statSync(partOf(dest)).size > 0, 'the first chunk reaching the .part')

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
      await within(gate.returned, 'the held verify returning')
      await hop() // runOne's continuation after the verify
      expect(mgr.get(job.jobId).status).toBe('cancelled')
      // The mid-download-cancel contract holds here too: nothing renamed into place, the
      // fully-downloaded .part KEPT for the next attempt…
      expect(existsSync(dest)).toBe(false)
      expect(readFileSync(partOf(dest), 'utf8')).toBe(gguf)
      // …and task 2 (the mmproj) was never requested.
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
      const mgr = new DownloadManager({ fetchImpl })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('failed')
      // Poisoned prefix discarded → the next attempt restarts clean rather than re-appending.
      expect(existsSync(partOf(dest))).toBe(false)
      expect(existsSync(dest)).toBe(false)
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
      const mgr = new DownloadManager({ fetchImpl: only416 })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN_GATES })
      const finished = await waitForTerminal(mgr, job.jobId) // pre-fix: stuck at 'verifying' → timeout
      expect(finished.status).toBe('failed')
      // The copy carries the raw rename error today (defect A2), so this row does not claim it is friendly.
      expect(finished.error).toMatch(/was interrupted/)
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
      await within(gate.returned, 'the held verify returning')
      await hop()
      expect(mgr.get(job.jobId).status).toBe('cancelled')
      expect(existsSync(dest)).toBe(false)
      expect(readFileSync(partOf(dest), 'utf8')).toBe(body)
      expect(fetchSpy).not.toHaveBeenCalled()
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
