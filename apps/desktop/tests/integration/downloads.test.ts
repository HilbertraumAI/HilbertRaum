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
import type { FetchFn } from '../../src/main/services/assets'
import { weightPath, type HashStore } from '../../src/main/services/models'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'
import type { DownloadJob } from '../../src/shared/types'

// Phase 18 — the in-app model downloader (post-mvp-functionality-plan §6). Everything
// runs through the INJECTED fake fetch: the suite makes zero real network calls, and the
// gate tests prove a closed gate never even reaches the fetch seam.

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'paid-downloads-'))
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
})

// ---- the job state machine ----------------------------------------------------------

describe('DownloadManager jobs', () => {
  it('downloads, verifies, renames .part into place, and invalidates the checksum cache', async () => {
    const body = 'real-model-weights-bytes'
    const m = verifiedManifest(body)
    const root = tempRoot()
    const dest = weightPath(root, m)
    const deleted: string[] = []
    const hashStore: HashStore = {
      get: () => null,
      set: () => undefined,
      delete: (p) => deleted.push(p)
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
    expect(deleted).toContain(dest)
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
})
