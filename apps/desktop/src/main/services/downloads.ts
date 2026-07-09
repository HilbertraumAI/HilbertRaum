import { existsSync, renameSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tMain } from './i18n'
import type { ModelManifest } from '../../shared/manifest'
import type { DownloadJob } from '../../shared/types'
import {
  planModelDownloads,
  downloadToFile,
  modelWeightMaxBytes,
  verifyDownloadedFile,
  ResumeOffsetMismatchError,
  type FetchFn,
  type ModelDownloadTask
} from './assets'
import { invalidateChecksum, primeChecksum, type HashStore } from './models'

// In-app model downloader (architecture.md "In-app model downloader"). A thin job
// state machine over the `assets.ts` seams: `planModelDownloads` (license gate +
// present/verified states), `downloadToFile` (injected fetch + progress + Range
// resume), `verifyDownloadedFile` (placeholder honesty). Async-with-polling like the
// import jobs — the renderer polls `getDownloadJob`; there are no new event channels.
//
// Invariants:
// - GATES FIRST (all must hold): the policy ceiling (`network.allow_model_downloads`),
//   the user's `allowNetwork` setting (default ON, but gated by the policy ceiling above), and a per-download confirmation in
//   the renderer (with an explicit license acknowledgement when the manifest's
//   `license_review.status` is not `approved`). `start()` re-checks the first two in
//   the main process — a renderer bug can never start an unsanctioned download.
// - The network bytes land in `<weightPath>.part`; the file is renamed into place ONLY
//   after the hash verifies, so a crashed/cancelled download never leaves a half-weight
//   where `computeInstallState` can see it. A cancelled/failed `.part` is KEPT and
//   resumed via a `Range` header next time (best-effort; a server without ranges → 200
//   → clean restart).
// - Verify-before-trust: a hash MISMATCH deletes the `.part` and fails the job; a
//   PLACEHOLDER expected hash completes the job but marks it `unverified` — the model
//   stays UNVERIFIED until a real hash lands in the manifest (never a silent pass).
// - One download at a time (multi-GB weights on USB; a queue is pointless contention).

/** Why a download may not start — the renderer maps these to the §6.1 explanations. */
export interface DownloadGates {
  /** `policy.network.allowModelDownloads` — the authoritative ceiling. */
  policyAllows: boolean
  /** The user's `allowNetwork` Settings toggle (spec §3.6, default on; gated by `policyAllows`). */
  settingAllows: boolean
}

/**
 * Throw a friendly, cause-specific error when either network gate is closed. The copy
 * mirrors the Models screen's explanations (policy vs. Settings — the `PolicyStatus`
 * distinction the Privacy screen already makes). Job errors and throws in this service
 * are session-only (never persisted), so they localize at emission via tMain()
 * (i18n record §3.3 rule 2).
 */
export function assertDownloadAllowed(gates: DownloadGates): void {
  if (!gates.policyAllows) {
    throw new Error(tMain('main.download.policyDisabled'))
  }
  if (!gates.settingAllows) {
    throw new Error(tMain('main.download.networkOff'))
  }
}

export interface StartDownloadOptions {
  rootPath: string
  manifest: ModelManifest
  gates: DownloadGates
  /**
   * The user explicitly acknowledged the model's license in the confirmation dialog.
   * Required when `license_review.status !== 'approved'` (mirrors `--accept-license`).
   */
  licenseAccepted?: boolean
  /** Persistent checksum cache — invalidated for the weight path on success. */
  hashStore?: HashStore
}

/** The download-lifecycle audit events this service can emit. */
export type DownloadAuditType =
  | 'model_download_started'
  | 'model_download_verified'
  | 'model_download_failed'

export interface DownloadManagerDeps {
  /** Injected fetch — production passes the global `fetch`; tests pass a fake. */
  fetchImpl?: FetchFn
  /** Injected downloader (default `downloadToFile`) — tests capture the applied size cap (F17). */
  downloadImpl?: typeof downloadToFile
  log?: (msg: string, meta?: unknown) => void
  /**
   * Audit hook: the IPC layer injects the app recorder so the background verify/fail
   * outcomes reach the audit log without this service knowing about the DB. Carries
   * the model id and counts — never file contents. Must never throw.
   */
  audit?: (type: DownloadAuditType, message: string, metadata: Record<string, unknown>) => void
  /**
   * Fired once when a download job reaches `done` — every file of the model is renamed into
   * place (issue #40). The IPC layer wires this to `AppContext.onModelInstalled`, which re-runs
   * the availability selectors that were frozen at startup (the translation sidecar today), so a
   * mid-session download activates without an app restart. Fires for placeholder-hash
   * (`unverified`) completions too — the selectors are PRESENCE-driven (`modelExists`), exactly
   * what a restart would see. Guarded here; a throwing hook must never fail the finished job.
   */
  onModelInstalled?: (modelId: string) => void
}

/** The `.part` staging path for a weight destination. */
export function partPath(dest: string): string {
  return `${dest}.part`
}

/** Finished (done/failed/cancelled) jobs kept around for late polls; older ones are pruned. */
const MAX_TERMINAL_JOBS = 20

/**
 * Owns the in-app download jobs. Jobs live in memory for the session only; the
 * durable truth is the filesystem — a verified weight in place, or a resumable
 * `.part`.
 */
export class DownloadManager {
  private jobs = new Map<string, DownloadJob>()
  private active: { jobId: string; controller: AbortController } | null = null
  /** Synchronous single-flight latch covering the check-then-set window in `start()` that
   *  straddles an `await` (BUG vuln-scan-2026-06-21). True from passing the guard until
   *  `this.active` is set (or the start aborts/throws). */
  private starting = false
  private deps: DownloadManagerDeps

  constructor(deps: DownloadManagerDeps = {}) {
    this.deps = deps
  }

  /**
   * Validate every gate and start downloading one model in the background. Returns the
   * initial job snapshot (poll `get(jobId)` for progress). Throws — with a friendly,
   * cause-specific message — when a gate is closed, another download is running, the
   * manifest has no upstream source, or the weight is already present + verified.
   */
  async start(opts: StartDownloadOptions): Promise<DownloadJob> {
    this.pruneTerminalJobs()
    assertDownloadAllowed(opts.gates)
    // Single-flight: `activeJob()` and the `this.active` assignment below straddle the
    // `await planModelDownloads(...)`, so two near-simultaneous start() invokes both observed
    // `activeJob() === null` and both launched a run (orphaning the first AbortController). The
    // synchronous `starting` latch closes that window (BUG vuln-scan-2026-06-21).
    if (this.activeJob() !== null || this.starting) {
      throw new Error(tMain('main.download.alreadyRunning'))
    }
    this.starting = true
    try {
      if (!opts.manifest.download) {
        throw new Error(tMain('main.download.noSource', { modelId: opts.manifest.id }))
      }

      // Reuse the canonical planner: license gate + present/verified/unverified states. A vision
      // model plans TWO tasks — the language GGUF then its `mmproj` projector (DIST-1); every other
      // role plans one. The downloader fetches ALL of them as one logical job: `computeInstallState`
      // requires both files present + verified, so a GGUF-only download would never reach `installed`.
      const tasks = await planModelDownloads(opts.rootPath, [opts.manifest], {
        acceptLicense: opts.licenseAccepted,
        hashStore: opts.hashStore
      })
      if (tasks.length === 0) {
        throw new Error(tMain('main.download.noSource', { modelId: opts.manifest.id }))
      }
      // The license gate is the MODEL's (a vision projector inherits its GGUF's review), so a single
      // blocked file blocks the whole model.
      const blocked = tasks.find((t) => t.status === 'license-blocked')
      if (blocked) {
        throw new Error(tMain('main.download.licenseFirst', { license: blocked.license ?? '' }))
      }
      // Fetch only the files actually absent/stale — a model whose GGUF is already present + verified
      // but whose mmproj is missing downloads JUST the projector (the common "finish the vision model"
      // case). When nothing is left to fetch, distinguish "fully verified" from "present-but-placeholder".
      const toDownload = tasks.filter((t) => t.status === 'download')
      if (toDownload.length === 0) {
        throw new Error(
          tasks.every((t) => t.status === 'present-verified')
            ? tMain('main.download.alreadyVerified')
            : tMain('main.download.presentUnverified')
        )
      }

      const modelId = tasks[0].id
      const plannedTotal = sumSizes(toDownload)
      const job: DownloadJob = {
        jobId: randomUUID(),
        modelId,
        status: 'queued',
        receivedBytes: 0,
        totalBytes: plannedTotal,
        unverified: false,
        error: null
      }
      this.jobs.set(job.jobId, job)
      const controller = new AbortController()
      this.active = { jobId: job.jobId, controller }
      this.deps.log?.('Model download started', {
        modelId,
        jobId: job.jobId,
        files: toDownload.length
      })
      this.deps.audit?.('model_download_started', `Model download started: ${modelId}`, {
        modelId,
        jobId: job.jobId,
        sizeBytes: plannedTotal,
        files: toDownload.length
      })

      // Background run — the invoke returns immediately; the renderer polls for progress.
      void this.run(job, toDownload, controller, opts.hashStore).finally(() => {
        if (this.active?.jobId === job.jobId) this.active = null
      })
      return { ...job }
    } finally {
      // Clear the latch only once `this.active` is set (success) or the start aborted (throw) —
      // by here `activeJob()` covers any subsequent caller, so there is no gap.
      this.starting = false
    }
  }

  /** Job snapshot for polling. Unknown/expired ids report a terminal state. */
  get(jobId: string): DownloadJob {
    const job = this.jobs.get(jobId)
    if (job) return { ...job }
    return {
      jobId,
      modelId: '',
      status: 'failed',
      receivedBytes: 0,
      totalBytes: null,
      unverified: false,
      error: tMain('main.download.unknownJob')
    }
  }

  /**
   * Cancel an in-flight download. The `.part` file is kept so the next attempt resumes.
   * Cancelling a job that already reached a terminal state is a no-op.
   */
  cancel(jobId: string): DownloadJob {
    const job = this.jobs.get(jobId)
    if (!job) return this.get(jobId)
    if (job.status === 'queued' || job.status === 'downloading') {
      job.status = 'cancelled'
      if (this.active?.jobId === jobId) this.active.controller.abort()
      this.deps.log?.('Model download cancelled', { modelId: job.modelId, jobId })
    }
    return { ...job }
  }

  /**
   * Drop the oldest terminal jobs beyond the keep window. Jobs are session-only and a
   * long session can start many downloads — without this the map grows unbounded. The
   * Map iterates in insertion (= creation) order, so the front entries are the oldest;
   * `get()` already answers pruned ids with a terminal "unknown job" snapshot.
   */
  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()].filter(
      (j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
    )
    for (const job of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_JOBS))) {
      this.jobs.delete(job.jobId)
    }
  }

  /** The currently running job id, or null. */
  activeJob(): string | null {
    if (!this.active) return null
    const job = this.jobs.get(this.active.jobId)
    if (!job) return null
    const live = job.status === 'queued' || job.status === 'downloading' || job.status === 'verifying'
    return live ? job.jobId : null
  }

  /**
   * Download + verify every file of the model in order (a vision model's GGUF then its mmproj
   * projector; one file for every other role). The job's `receivedBytes`/`totalBytes` are the
   * COMBINED progress across the files. The job is `done` only once ALL files are in place +
   * verified; the first file to cancel or fail stops the run and the later files are skipped.
   */
  private async run(
    job: DownloadJob,
    tasks: ModelDownloadTask[],
    controller: AbortController,
    hashStore?: HashStore
  ): Promise<void> {
    let completedBytes = 0
    for (let i = 0; i < tasks.length; i++) {
      // What is still queued after this file — keeps the combined total honest mid-download.
      const remainingPlanned = sumSizes(tasks.slice(i + 1))
      const ok = await this.runOne(job, tasks[i], controller, hashStore, completedBytes, remainingPlanned)
      if (!ok) return // cancelled or failed — job already marked; later files are skipped
      completedBytes = job.receivedBytes
    }

    // Every file of the model is in place + verified (or placeholder-complete).
    job.status = 'done'
    this.deps.log?.('Model download complete', {
      modelId: job.modelId,
      verified: !job.unverified
    })
    // Issue #40: let the app re-run the availability selectors NOW — the weights this session's
    // startup composition didn't see are on disk. Never let a hook fault fail the finished job.
    try {
      this.deps.onModelInstalled?.(job.modelId)
    } catch {
      /* the download itself succeeded; selector refresh is best-effort */
    }
    // Checksum honesty extends to the audit log: only a REAL hash match (no placeholder file in
    // the set) records "verified" — otherwise the model reports UNVERIFIED on the Models screen.
    if (!job.unverified) {
      this.deps.audit?.('model_download_verified', `Model download verified: ${job.modelId}`, {
        modelId: job.modelId,
        jobId: job.jobId,
        bytes: job.receivedBytes
      })
    }
  }

  /**
   * Download + verify ONE file into place. Returns true to continue to the next file, false when
   * the job reached a terminal state (cancelled or failed) and the run must stop. `baseBytes` is
   * the byte total of already-finished files; `remainingPlanned` is the planned size of the files
   * after this one — together they keep the job's combined received/total accurate across a
   * multi-file (GGUF + mmproj) download.
   */
  private async runOne(
    job: DownloadJob,
    task: ModelDownloadTask,
    controller: AbortController,
    hashStore: HashStore | undefined,
    baseBytes: number,
    remainingPlanned: number | null
  ): Promise<boolean> {
    const part = partPath(task.dest)
    try {
      // Best-effort Range resume: a kept `.part` (cancelled/crashed earlier attempt)
      // becomes the prefix. The server decides — 206 appends, 200 restarts cleanly.
      const resumeFrom = existsSync(part) ? statSync(part).size : 0
      let prefix = resumeFrom
      job.status = 'downloading'
      job.receivedBytes = baseBytes + prefix
      const download = this.deps.downloadImpl ?? downloadToFile
      const result = await download(task.url, part, {
        fetchImpl: this.deps.fetchImpl,
        signal: controller.signal,
        // D3 + F17: cap the body so a redirected/hostile endpoint can't stream past it and fill the
        // drive (the SHA verify already rejects wrong bytes). The cap is the manifest's exact
        // `size_bytes` when known, else a bounded per-role default — never unbounded (so a manifest
        // that omits size_bytes no longer collapses the cap to the multi-GiB backstop).
        maxBytes: modelWeightMaxBytes(task.role, task.sizeBytes),
        ...(resumeFrom > 0
          ? { headers: { Range: `bytes=${resumeFrom}-` }, append: true, resumeFrom }
          : {}),
        onResponse: ({ status, contentLength }) => {
          // A 200 means the server ignored the Range request → the file restarts.
          prefix = status === 206 ? resumeFrom : 0
          job.receivedBytes = baseBytes + prefix
          // Combined total = finished files + this file (Content-Length) + the files still queued.
          // Any unknown size collapses the total to null (the bar then shows the byte count only).
          job.totalBytes =
            contentLength != null && remainingPlanned != null
              ? baseBytes + prefix + contentLength + remainingPlanned
              : null
        },
        onProgress: (received) => {
          job.receivedBytes = baseBytes + prefix + received
        }
      })
      this.deps.log?.('Model download finished, verifying', {
        modelId: job.modelId,
        status: result.status,
        bytes: job.receivedBytes
      })

      // A cancel that raced the final bytes: cancel() aborts our controller, so the
      // signal is the explicit cancel flag (no status-narrowing cast needed).
      if (controller.signal.aborted) return false // keep the .part for resume

      job.status = 'verifying'
      const verify = await verifyDownloadedFile(part, task.expectedSha256)
      if (verify.reason === 'mismatch') {
        // Verify-before-trust: the partial is deleted, the job fails loudly.
        await rm(part, { force: true })
        job.status = 'failed'
        job.error = tMain('main.download.checksumMismatch')
        this.deps.log?.('Model download checksum mismatch — partial deleted', {
          modelId: job.modelId,
          expected: task.expectedSha256,
          actual: verify.actual
        })
        this.deps.audit?.('model_download_failed', `Model download failed: ${job.modelId}`, {
          modelId: job.modelId,
          jobId: job.jobId,
          reason: 'checksum mismatch — file discarded'
        })
        return false
      }
      if (verify.reason === 'missing') {
        job.status = 'failed'
        job.error = tMain('main.download.fileMissing')
        this.deps.audit?.('model_download_failed', `Model download failed: ${job.modelId}`, {
          modelId: job.modelId,
          jobId: job.jobId,
          reason: 'file missing before verification'
        })
        return false
      }

      // ok (verified) or placeholder (cannot verify — checksum honesty): the bytes are
      // complete either way, so move the file into place and refresh install state.
      renameSync(part, task.dest)
      // Prime the checksum cache with the hash we JUST computed (identical bytes, same file) so the
      // Models screen's install-state refresh reports `installed` immediately instead of redundantly
      // re-hashing the multi-GB weight — that re-hash is the invisible gap where the card briefly
      // looked un-downloaded (download→verify UX). A placeholder file has no real hash to trust, so
      // it is invalidated (computeInstallState short-circuits placeholder weights without hashing).
      if (verify.reason === 'placeholder' || !verify.actual) {
        invalidateChecksum(task.dest, hashStore)
      } else {
        primeChecksum(task.dest, verify.actual, hashStore)
      }
      // A single placeholder-hash file taints the whole model as UNVERIFIED (never silently pass).
      if (verify.reason === 'placeholder') job.unverified = true
      // Pin the combined received total to this file's true on-disk size before the next file.
      job.receivedBytes = baseBytes + statSync(task.dest).size
      return true
    } catch (err) {
      if (job.status === 'cancelled') {
        // The abort we asked for — the kept `.part` resumes next time.
        this.deps.log?.('Model download stopped after cancel; partial kept for resume', {
          modelId: job.modelId
        })
        return false
      }
      // A misaligned 206 resume (the server served a slice starting at the wrong byte): the on-disk
      // `.part` can't be safely continued, so discard it — the NEXT attempt restarts from scratch
      // rather than re-appending onto a poisoned prefix (BUG dl-size-cap-2026-07-03 hardening).
      if (err instanceof ResumeOffsetMismatchError) {
        await rm(part, { force: true })
        this.deps.log?.('Model download resume offset mismatch — partial discarded for a clean restart', {
          modelId: job.modelId
        })
      }
      job.status = 'failed'
      job.error = friendlyDownloadError(err)
      this.deps.log?.('Model download failed', { modelId: job.modelId, error: String(err) })
      this.deps.audit?.('model_download_failed', `Model download failed: ${job.modelId}`, {
        modelId: job.modelId,
        jobId: job.jobId,
        reason: String(err).slice(0, 300)
      })
      return false
    }
  }
}

/** Null-safe sum of task byte sizes — null if ANY size is unknown (the bar drops the total). */
function sumSizes(tasks: ModelDownloadTask[]): number | null {
  let total = 0
  for (const t of tasks) {
    if (t.sizeBytes == null) return null
    total += t.sizeBytes
  }
  return total
}

/** Map a low-level fetch/stream error to spec §11.4-toned copy (never blame, stay plain). */
function friendlyDownloadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/HTTP \d+/.test(raw)) {
    return tMain('main.download.httpFailed', { reason: raw.replace(/^Download failed: /, '') })
  }
  return tMain('main.download.interrupted', { reason: raw })
}
