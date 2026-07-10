import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DownloadManager,
  assertDownloadAllowed,
  partPath,
  type DownloadGates
} from '../../src/main/services/downloads'
import { verifyDownloadedFile, type FetchFn } from '../../src/main/services/assets'
import { weightPath, mmprojPath, type HashStore } from '../../src/main/services/models'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'
import type { DownloadJob } from '../../src/shared/types'

// Phase 18 — the in-app model downloader (architecture.md "In-app model downloader"). Everything
// runs through the INJECTED fake fetch: the suite makes zero real network calls, and the
// gate tests prove a closed gate never even reaches the fetch seam.

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-downloads-'))
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function manifest(overrides: Record<string, unknown> = {}): ModelManifest {
  const raw: Record<string, unknown> = {
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
    sha256: 'REPLACE_WITH_REAL_HASH',
    recommended_profiles: ['LITE'],
    license_review: {
      status: 'approved',
      reviewed_by: 'test',
      reviewed_at: '2026-06-10',
      notes: ''
    },
    download: {
      url: 'https://example.test/qwen3-4b.gguf',
      sha256: 'REPLACE_WITH_REAL_HASH',
      size_bytes: 1000,
      license_url: 'https://example.test/license'
    },
    ...overrides
  }
  const res = validateManifest(raw)
  if (!res.manifest) throw new Error('fixture invalid: ' + res.errors.join(', '))
  return res.manifest
}

/** Manifest whose top-level AND download hashes are the real hash of `body`. */
function verifiedManifest(body: string): ModelManifest {
  return manifest({
    sha256: sha256(body),
    download: {
      url: 'https://example.test/qwen3-4b.gguf',
      sha256: sha256(body),
      size_bytes: body.length,
      license_url: 'https://example.test/license'
    }
  })
}

const OPEN: DownloadGates = { policyAllows: true, settingAllows: true }

/**
 * Range-aware fake fetch: serves `body`, honouring `Range: bytes=N-` with a 206 when
 * `honourRange` (else a full 200). Records every request's Range header.
 */
function rangeFetch(
  body: string,
  opts: { honourRange?: boolean } = {}
): { fetch: FetchFn; ranges: Array<string | null> } {
  const ranges: Array<string | null> = []
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')
    ranges.push(range)
    const m = range && opts.honourRange ? /^bytes=(\d+)-$/.exec(range) : null
    const slice = m ? body.slice(Number(m[1])) : body
    return new Response(slice, {
      status: m ? 206 : 200,
      headers: { 'content-length': String(slice.length) }
    })
  }) as unknown as FetchFn
  return { fetch, ranges }
}

/** Fake fetch that streams one chunk then stays open until the signal aborts. */
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

/** A vision manifest: language GGUF + mmproj projector, each hashed to the real hash of its body. */
function visionManifest(ggufBody: string, mmprojBody: string): ModelManifest {
  return manifest({
    role: 'vision',
    input_modalities: ['text', 'image'],
    local_path: 'models/vision/vl.gguf',
    sha256: sha256(ggufBody),
    download: {
      url: 'https://example.test/vl.gguf',
      sha256: sha256(ggufBody),
      size_bytes: ggufBody.length,
      license_url: 'https://example.test/license'
    },
    mmproj: {
      local_path: 'models/vision/vl-mmproj.gguf',
      sha256: sha256(mmprojBody),
      download: {
        url: 'https://example.test/vl-mmproj.gguf',
        sha256: sha256(mmprojBody),
        size_bytes: mmprojBody.length,
        license_url: 'https://example.test/license'
      }
    }
  })
}

/** Fake fetch that serves a body per URL (404 for any unrouted URL); records every URL asked for. */
function routedFetch(routes: Record<string, string>): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = []
  const fetch = (async (url: unknown) => {
    const u = String(url)
    urls.push(u)
    const body = routes[u]
    if (body == null) return new Response(null, { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
  }) as unknown as FetchFn
  return { fetch, urls }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function waitForTerminal(mgr: DownloadManager, jobId: string): Promise<DownloadJob> {
  await waitFor(() => {
    const s = mgr.get(jobId).status
    return s === 'done' || s === 'failed' || s === 'cancelled'
  })
  // Let the background runner's `finally` clear the active slot too.
  await waitFor(() => mgr.activeJob() === null)
  return mgr.get(jobId)
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
    expect(() => assertDownloadAllowed(OPEN)).not.toThrow()
  })

  it('refuses to start when EITHER gate is closed — and never calls fetch', async () => {
    const fetchSpy = vi.fn()
    const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    const root = tempRoot()
    await expect(
      mgr.start({ rootPath: root, manifest: manifest(), gates: { policyAllows: false, settingAllows: true } })
    ).rejects.toThrow(/policy/)
    await expect(
      mgr.start({ rootPath: root, manifest: manifest(), gates: { policyAllows: true, settingAllows: false } })
    ).rejects.toThrow(/Settings/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mgr.activeJob()).toBeNull()
  })

  it('license gate: a non-approved license needs the explicit acknowledgement', async () => {
    const fetchSpy = vi.fn()
    const mgr = new DownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    const pending = manifest({
      license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
    })
    await expect(
      mgr.start({ rootPath: tempRoot(), manifest: pending, gates: OPEN })
    ).rejects.toThrow(/license/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a manifest without a download block is refused', async () => {
    const mgr = new DownloadManager({ fetchImpl: vi.fn() as unknown as FetchFn })
    await expect(
      mgr.start({ rootPath: tempRoot(), manifest: manifest({ download: undefined }), gates: OPEN })
    ).rejects.toThrow(/no download source/)
  })

  it('a present + verified weight is refused (nothing to download)', async () => {
    const body = 'verified-weights'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const dest = weightPath(root, m)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, body)
    const mgr = new DownloadManager({ fetchImpl: vi.fn() as unknown as FetchFn })
    await expect(mgr.start({ rootPath: root, manifest: m, gates: OPEN })).rejects.toThrow(
      /already downloaded/
    )
  })

  it('rejects a concurrent start() — single-flight latch closes the check-then-set window (BUG vuln-scan-2026-06-21)', async () => {
    const body = 'hello-world-weights'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    // Fire two starts in the same tick: the first sets the `starting` latch synchronously
    // before its `await planModelDownloads`, so the second must reject rather than launch a
    // second concurrent run (which previously orphaned the first AbortController).
    const p1 = mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const p2 = mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    await expect(p2).rejects.toThrow(/already running/i)
    const job1 = await p1
    expect(['queued', 'downloading']).toContain(job1.status)
    expect(mgr.activeJob()).toBe(job1.jobId) // exactly one active job
    mgr.cancel(job1.jobId) // unwind the hanging fetch
  })
})

// ---- vision: a model is TWO files (GGUF + mmproj projector, DIST-1) ------------------

describe('DownloadManager vision (two files)', () => {
  it('fetches BOTH files, verifies each, and reports the COMBINED progress', async () => {
    const gguf = 'the-language-gguf-bytes'
    const mmproj = 'the-mmproj-projector-bytes'
    const m = visionManifest(gguf, mmproj)
    const root = tempRoot()
    const { fetch, urls } = routedFetch({
      'https://example.test/vl.gguf': gguf,
      'https://example.test/vl-mmproj.gguf': mmproj
    })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    expect(job.totalBytes).toBe(gguf.length + mmproj.length)

    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(false)
    expect(finished.receivedBytes).toBe(gguf.length + mmproj.length)
    // The GGUF is fetched before the projector, and both land verified on disk.
    expect(urls).toEqual([
      'https://example.test/vl.gguf',
      'https://example.test/vl-mmproj.gguf'
    ])
    expect(readFileSync(weightPath(root, m), 'utf8')).toBe(gguf)
    expect(readFileSync(mmprojPath(root, m), 'utf8')).toBe(mmproj)
  })

  it('finishes a half-downloaded vision model: GGUF already present → fetches JUST the mmproj', async () => {
    const gguf = 'already-here-gguf'
    const mmproj = 'still-missing-mmproj'
    const m = visionManifest(gguf, mmproj)
    const root = tempRoot()
    // The GGUF arrived + verified in a prior run; the mmproj never did (the reported bug).
    const ggufDest = weightPath(root, m)
    mkdirSync(join(ggufDest, '..'), { recursive: true })
    writeFileSync(ggufDest, gguf)
    const { fetch, urls } = routedFetch({ 'https://example.test/vl-mmproj.gguf': mmproj })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(urls).toEqual(['https://example.test/vl-mmproj.gguf']) // the present GGUF is NOT re-fetched
    expect(readFileSync(mmprojPath(root, m), 'utf8')).toBe(mmproj)
  })

  it('a fully present + verified vision model is refused (both files in place)', async () => {
    const gguf = 'gguf-bytes'
    const mmproj = 'mmproj-bytes'
    const m = visionManifest(gguf, mmproj)
    const root = tempRoot()
    mkdirSync(join(weightPath(root, m), '..'), { recursive: true })
    writeFileSync(weightPath(root, m), gguf)
    writeFileSync(mmprojPath(root, m), mmproj)
    const mgr = new DownloadManager({ fetchImpl: vi.fn() as unknown as FetchFn })
    await expect(mgr.start({ rootPath: root, manifest: m, gates: OPEN })).rejects.toThrow(
      /already downloaded/
    )
  })
})

// ---- the job state machine ----------------------------------------------------------

describe('DownloadManager jobs', () => {
  it('downloads, verifies, renames .part into place, and PRIMES the checksum cache with the verified hash', async () => {
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const dest = weightPath(root, m)
    const primed: Array<{ path: string; actual: string }> = []
    const hashStore: HashStore = {
      get: () => null,
      set: (p, entry) => primed.push({ path: p, actual: entry.actual }),
      delete: () => undefined
    }
    const mgr = new DownloadManager({ fetchImpl: rangeFetch(body).fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN, hashStore })
    expect(job.status === 'queued' || job.status === 'downloading').toBe(true)
    expect(job.totalBytes).toBe(body.length)

    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(false)
    expect(finished.receivedBytes).toBe(body.length)
    expect(readFileSync(dest, 'utf8')).toBe(body)
    expect(existsSync(partPath(dest))).toBe(false)
    // Prime (not invalidate) the checksum cache with the hash just verified, so the Models screen
    // reports `installed` without redundantly re-hashing the multi-GB weight (download→verify UX).
    expect(primed.find((p) => p.path === dest)?.actual).toBe(sha256(body))
  })

  it('placeholder expected hash → job done but flagged unverified (checksum honesty, R5)', async () => {
    const m = manifest() // placeholder hashes
    const root = tempRoot()
    const mgr = new DownloadManager({ fetchImpl: rangeFetch('whatever-bytes').fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(true)
    expect(existsSync(weightPath(root, m))).toBe(true)
  })

  // Issue #40: `onModelInstalled` is the seam that lets the app re-run the startup-frozen
  // availability selectors the moment the weights land (the translation sidecar today) — a
  // downloaded model must activate without an app restart.
  it('fires onModelInstalled exactly once when the job reaches done — AFTER the weight is in place', async () => {
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const dest = weightPath(root, m)
    const installed: Array<{ modelId: string; weightPresent: boolean }> = []
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch(body).fetch,
      onModelInstalled: (modelId) => installed.push({ modelId, weightPresent: existsSync(dest) })
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(installed).toEqual([{ modelId: m.id, weightPresent: true }]) // once, and PRESENCE holds
  })

  it('fires onModelInstalled for a placeholder-hash (unverified) completion too — presence is what the selectors check', async () => {
    const m = manifest() // placeholder hashes → done + unverified
    const root = tempRoot()
    const installed: string[] = []
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch('whatever-bytes').fetch,
      onModelInstalled: (modelId) => installed.push(modelId)
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done')
    expect(finished.unverified).toBe(true)
    expect(installed).toEqual([m.id]) // exactly what a restart would see (modelExists)
  })

  it('does NOT fire onModelInstalled on a failed or cancelled job', async () => {
    const installed: string[] = []
    // Failed: checksum mismatch.
    const bad = verifiedManifest('the-bytes-we-expected')
    const root1 = tempRoot()
    const mgrFail = new DownloadManager({
      fetchImpl: rangeFetch('tampered-bytes').fetch,
      onModelInstalled: (modelId) => installed.push(modelId)
    })
    const failJob = await mgrFail.start({ rootPath: root1, manifest: bad, gates: OPEN })
    expect((await waitForTerminal(mgrFail, failJob.jobId)).status).toBe('failed')
    // Cancelled: abort mid-stream.
    const m = verifiedManifest('hello-world-weights')
    const root2 = tempRoot()
    const mgrCancel = new DownloadManager({
      fetchImpl: hangingFetch('hello-'),
      onModelInstalled: (modelId) => installed.push(modelId)
    })
    const cancelJob = await mgrCancel.start({ rootPath: root2, manifest: m, gates: OPEN })
    await waitFor(() => mgrCancel.get(cancelJob.jobId).receivedBytes > 0)
    mgrCancel.cancel(cancelJob.jobId)
    expect((await waitForTerminal(mgrCancel, cancelJob.jobId)).status).toBe('cancelled')
    expect(installed).toEqual([])
  })

  it('a throwing onModelInstalled hook never fails the finished job', async () => {
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const mgr = new DownloadManager({
      fetchImpl: rangeFetch(body).fetch,
      onModelInstalled: () => {
        throw new Error('selector refresh blew up')
      }
    })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('done') // the download outcome is untouched
    expect(finished.error).toBeNull()
  })

  it('hash mismatch → the partial is DELETED and the job fails with friendly copy', async () => {
    const m = verifiedManifest('the-bytes-we-expected')
    const root = tempRoot()
    const dest = weightPath(root, m)
    const mgr = new DownloadManager({ fetchImpl: rangeFetch('tampered-bytes').fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('failed')
    expect(finished.error).toMatch(/checksum/i)
    expect(finished.error).not.toMatch(/Error:/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(partPath(dest))).toBe(false)
  })

  it('cancel mid-download keeps the .part for resume and never installs a half-weight', async () => {
    const m = verifiedManifest('hello-world-weights')
    const root = tempRoot()
    const dest = weightPath(root, m)
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    await waitFor(() => mgr.get(job.jobId).receivedBytes > 0)

    const cancelled = mgr.cancel(job.jobId)
    expect(cancelled.status).toBe('cancelled')
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(finished.status).toBe('cancelled')
    expect(existsSync(dest)).toBe(false)
    // The streamed prefix lands on disk asynchronously — poll for it.
    await waitFor(
      () => existsSync(partPath(dest)) && readFileSync(partPath(dest), 'utf8') === 'hello-'
    )
  })

  it('resumes a kept .part with a Range request (206 appends; hash verifies the whole)', async () => {
    const body = 'hello-world-weights'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const dest = weightPath(root, m)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(partPath(dest), 'hello-') // a previous cancelled attempt
    const { fetch, ranges } = rangeFetch(body, { honourRange: true })
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(ranges[0]).toBe('bytes=6-')
    expect(finished.status).toBe('done')
    expect(finished.receivedBytes).toBe(body.length)
    expect(readFileSync(dest, 'utf8')).toBe(body)
  })

  it('restarts cleanly when the server ignores the Range header (200 truncates)', async () => {
    const body = 'fresh-complete-weights'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const dest = weightPath(root, m)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(partPath(dest), 'stale-garbage-prefix')
    const { fetch, ranges } = rangeFetch(body) // honourRange off → plain 200
    const mgr = new DownloadManager({ fetchImpl: fetch })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    const finished = await waitForTerminal(mgr, job.jobId)
    expect(ranges[0]).toBe('bytes=20-') // we ASKED to resume…
    expect(finished.status).toBe('done') // …the 200 restarted instead of corrupting
    expect(readFileSync(dest, 'utf8')).toBe(body)
    expect(statSync(dest).size).toBe(body.length)
  })

  it('one download at a time: a second start is refused while one runs', async () => {
    const m = verifiedManifest('hello-world-weights')
    const root = tempRoot()
    const mgr = new DownloadManager({ fetchImpl: hangingFetch('hello-') })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
    await expect(
      mgr.start({ rootPath: tempRoot(), manifest: manifest({ id: 'other-model' }), gates: OPEN })
    ).rejects.toThrow(/one model downloads at a time/i)
    mgr.cancel(job.jobId)
    await waitForTerminal(mgr, job.jobId)
  })

  it('an HTTP error fails the job with friendly copy (no half-state)', async () => {
    const m = manifest()
    const root = tempRoot()
    const notFound = (async () => new Response(null, { status: 404 })) as unknown as FetchFn
    const mgr = new DownloadManager({ fetchImpl: notFound })
    const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
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
  // downloadToFile — the manifest's exact size when known, else a per-role default — so a redirected
  // / Content-Length-less endpoint can't fall through to the multi-GiB backstop and fill the drive.
  describe('size cap (F17)', () => {
    const GiB = 1024 * 1024 * 1024

    it('passes a bounded per-role maxBytes even when the manifest omits size_bytes', async () => {
      const body = 'weights-with-no-declared-size'
      const m = manifest({
        sha256: sha256(body),
        // download block WITHOUT size_bytes → planOneFile sets sizeBytes:null.
        download: { url: 'https://example.test/x.gguf', sha256: sha256(body), license_url: 'https://example.test/l' }
      })
      let captured: unknown = 'unset'
      const mgr = new DownloadManager({
        downloadImpl: async (_url, dest, deps) => {
          captured = deps?.maxBytes
          writeFileSync(dest, body)
          return { status: 200, received: body.length, contentLength: null }
        }
      })
      const job = await mgr.start({ rootPath: tempRoot(), manifest: m, gates: OPEN })
      await waitForTerminal(mgr, job.jobId)
      expect(typeof captured).toBe('number')
      expect(captured as number).toBeGreaterThan(0)
      expect(captured as number).toBeLessThan(64 * GiB)
    })

    it('passes a DRIFT-TOLERANT size-based cap when size_bytes is known (not the razor-thin exact size)', async () => {
      // BUG dl-size-cap-2026-07-03: the cap must be size_bytes + headroom so a file a little larger than
      // the DECLARED size still fits — the old exact cap truncated a legitimate download near ~95%.
      const body = 'exactly-sized-weights'
      const m = verifiedManifest(body) // size_bytes = body.length
      let captured: unknown = 'unset'
      const mgr = new DownloadManager({
        downloadImpl: async (_url, dest, deps) => {
          captured = deps?.maxBytes
          writeFileSync(dest, body)
          return { status: 200, received: body.length, contentLength: body.length }
        }
      })
      const job = await mgr.start({ rootPath: tempRoot(), manifest: m, gates: OPEN })
      await waitForTerminal(mgr, job.jobId)
      expect(typeof captured).toBe('number')
      expect(captured as number).toBeGreaterThan(body.length) // headroom over the declared size
    })

    it('COMPLETES a fresh download whose real body is larger than the declared size_bytes (regression)', async () => {
      // The reported failure: the true upstream file is a few % bigger than the manifest's size_bytes,
      // so the old exact cap (size_bytes + 1 MiB) aborted the stream near the end (~95%). With the
      // drift-tolerant cap the same download now runs to completion and verifies. Body is 1.5 MiB and
      // the declared size only 256 KiB — a >1 MiB overshoot that the OLD cap would have truncated.
      const body = 'q'.repeat(Math.ceil(1.5 * 1024 * 1024))
      const declared = 256 * 1024
      const m = manifest({
        sha256: sha256(body),
        download: {
          url: 'https://example.test/big.gguf',
          sha256: sha256(body),
          size_bytes: declared, // UNDER-declared vs the real body
          license_url: 'https://example.test/license'
        }
      })
      const root = tempRoot()
      const dest = weightPath(root, m)
      const mgr = new DownloadManager({ fetchImpl: rangeFetch(body).fetch })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
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
    it('a store whose set/delete throws (workspace locked mid-download) never changes the job outcome', async () => {
      const gguf = 'the-language-gguf-bytes'
      const mmproj = 'the-mmproj-projector-bytes'
      const m = visionManifest(gguf, mmproj) // TWO tasks — the second must still run
      const root = tempRoot()
      const lockedStore: HashStore = {
        get: () => null,
        set: () => {
          throw new Error('database is not open')
        },
        delete: () => {
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
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN, hashStore: lockedStore })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('done') // the cache fault never reached the job outcome
      expect(finished.unverified).toBe(false)
      expect(installed).toEqual([m.id]) // fired exactly once — #40 activation preserved
      // The second task ran despite the first file's store fault, and both files are in place.
      expect(urls).toEqual(['https://example.test/vl.gguf', 'https://example.test/vl-mmproj.gguf'])
      expect(readFileSync(weightPath(root, m), 'utf8')).toBe(gguf)
      expect(readFileSync(mmprojPath(root, m), 'utf8')).toBe(mmproj)
    })
  })

  // full-audit 2026-07-10 BE-4: `cancel()` used to act only on queued/downloading — a cancel
  // during `verifying` (a multi-GB SHA-256 on USB takes minutes) was silently dropped and a
  // two-task job then started downloading its next file.
  describe('cancel during verifying (BE-4)', () => {
    it('is honoured: terminal cancelled, nothing renamed, .part kept, the second file never starts', async () => {
      const gguf = 'the-language-gguf-bytes'
      const mmproj = 'the-mmproj-projector-bytes'
      const m = visionManifest(gguf, mmproj)
      const root = tempRoot()
      const dest = weightPath(root, m)
      const { fetch, urls } = routedFetch({
        'https://example.test/vl.gguf': gguf,
        'https://example.test/vl-mmproj.gguf': mmproj
      })
      // Deterministic gate (no sleeps): the fake verify signals entry and holds until released.
      let verifyEntered!: () => void
      const verifyStarted = new Promise<void>((resolve) => (verifyEntered = resolve))
      let releaseVerify!: () => void
      const verifyGate = new Promise<void>((resolve) => (releaseVerify = resolve))
      const mgr = new DownloadManager({
        fetchImpl: fetch,
        verifyImpl: async (path, expected) => {
          verifyEntered()
          await verifyGate
          return verifyDownloadedFile(path, expected) // the real result — the bytes DO verify
        }
      })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
      await verifyStarted
      expect(mgr.get(job.jobId).status).toBe('verifying')
      const cancelled = mgr.cancel(job.jobId) // previously a silent no-op in this state
      expect(cancelled.status).toBe('cancelled')
      releaseVerify()
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('cancelled')
      // The mid-download-cancel contract holds here too: nothing renamed into place, the
      // fully-downloaded .part KEPT for the next attempt…
      expect(existsSync(dest)).toBe(false)
      expect(readFileSync(partPath(dest), 'utf8')).toBe(gguf)
      // …and task 2 (the mmproj) was never requested.
      expect(urls).toEqual(['https://example.test/vl.gguf'])
    })
  })

  // BUG dl-size-cap-2026-07-03 — a misaligned 206 resume discards the poisoned .part for a clean restart.
  describe('resume-offset self-heal', () => {
    it('a 206 whose Content-Range starts at the WRONG offset fails the job AND deletes the .part', async () => {
      const body = 'hello-world-weights'
      const m = verifiedManifest(body)
      const root = tempRoot()
      const dest = weightPath(root, m)
      mkdirSync(join(dest, '..'), { recursive: true })
      writeFileSync(partPath(dest), 'hello-') // a prior partial (6 bytes); resume asks for bytes=6-
      // Server answers 206 but from byte 0 (wrong slice) — appending would corrupt the file.
      const fetchImpl = (async () =>
        new Response(body, {
          status: 206,
          headers: { 'content-length': String(body.length), 'content-range': `bytes 0-${body.length - 1}/${body.length}` }
        })) as unknown as FetchFn
      const mgr = new DownloadManager({ fetchImpl })
      const job = await mgr.start({ rootPath: root, manifest: m, gates: OPEN })
      const finished = await waitForTerminal(mgr, job.jobId)
      expect(finished.status).toBe('failed')
      // Poisoned prefix discarded → the next attempt restarts clean rather than re-appending.
      expect(existsSync(partPath(dest))).toBe(false)
      expect(existsSync(dest)).toBe(false)
    })
  })
})
