import { existsSync, renameSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tMain } from './i18n'
import type { ModelManifest } from '../../shared/manifest'
import type { DownloadJob } from '../../shared/types'
import {
  planModelDownloads,
  downloadToFile,
  verifyDownloadedFile,
  type FetchFn,
  type ModelDownloadTask
} from './assets'
import { invalidateChecksum, type HashStore } from './models'

// In-app model downloader (architecture.md "In-app model downloader"). A thin job
// state machine over the `assets.ts` seams: `planModelDownloads` (license gate +
// present/verified states), `downloadToFile` (injected fetch + progress + Range
// resume), `verifyDownloadedFile` (placeholder honesty). Async-with-polling like the
// import jobs — the renderer polls `getDownloadJob`; there are no new event channels.
//
// Invariants:
// - GATES FIRST (all must hold): the policy ceiling (`network.allow_model_downloads`),
//   the user's `allowNetwork` setting (default OFF), and a per-download confirmation in
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
  /** The user's `allowNetwork` Settings toggle (spec §3.6, default off). */
  settingAllows: boolean
}

/**
 * Throw a friendly, cause-specific error when either network gate is closed. The copy
 * mirrors the Models screen's explanations (policy vs. Settings — the `PolicyStatus`
 * distinction the Privacy screen already makes). Job errors and throws in this service
 * are session-only (never persisted), so they localize at emission via tMain()
 * (i18n-plan §3.3 rule 2).
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
  log?: (msg: string, meta?: unknown) => void
  /**
   * Audit hook: the IPC layer injects the app recorder so the background verify/fail
   * outcomes reach the audit log without this service knowing about the DB. Carries
   * the model id and counts — never file contents. Must never throw.
   */
  audit?: (type: DownloadAuditType, message: string, metadata: Record<string, unknown>) => void
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
    if (this.activeJob() !== null) {
      throw new Error(tMain('main.download.alreadyRunning'))
    }
    if (!opts.manifest.download) {
      throw new Error(tMain('main.download.noSource', { modelId: opts.manifest.id }))
    }

    // Reuse the canonical planner: license gate + present/verified/unverified states.
    const tasks = await planModelDownloads(opts.rootPath, [opts.manifest], {
      acceptLicense: opts.licenseAccepted,
      hashStore: opts.hashStore
    })
    const task = tasks[0]
    if (!task) {
      throw new Error(tMain('main.download.noSource', { modelId: opts.manifest.id }))
    }
    if (task.status === 'present-verified') {
      throw new Error(tMain('main.download.alreadyVerified'))
    }
    if (task.status === 'present-unverified') {
      throw new Error(tMain('main.download.presentUnverified'))
    }
    if (task.status === 'license-blocked') {
      throw new Error(tMain('main.download.licenseFirst', { license: task.license ?? '' }))
    }

    const job: DownloadJob = {
      jobId: randomUUID(),
      modelId: task.id,
      status: 'queued',
      receivedBytes: 0,
      totalBytes: task.sizeBytes,
      unverified: false,
      error: null
    }
    this.jobs.set(job.jobId, job)
    const controller = new AbortController()
    this.active = { jobId: job.jobId, controller }
    this.deps.log?.('Model download started', { modelId: task.id, jobId: job.jobId })
    this.deps.audit?.('model_download_started', `Model download started: ${task.id}`, {
      modelId: task.id,
      jobId: job.jobId,
      sizeBytes: task.sizeBytes
    })

    // Background run — the invoke returns immediately; the renderer polls for progress.
    void this.run(job, task, controller, opts.hashStore).finally(() => {
      if (this.active?.jobId === job.jobId) this.active = null
    })
    return { ...job }
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

  private async run(
    job: DownloadJob,
    task: ModelDownloadTask,
    controller: AbortController,
    hashStore?: HashStore
  ): Promise<void> {
    const part = partPath(task.dest)
    try {
      // Best-effort Range resume: a kept `.part` (cancelled/crashed earlier attempt)
      // becomes the prefix. The server decides — 206 appends, 200 restarts cleanly.
      const resumeFrom = existsSync(part) ? statSync(part).size : 0
      let prefix = resumeFrom
      job.status = 'downloading'
      job.receivedBytes = prefix
      const result = await downloadToFile(task.url, part, {
        fetchImpl: this.deps.fetchImpl,
        signal: controller.signal,
        ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` }, append: true } : {}),
        onResponse: ({ status, contentLength }) => {
          // A 200 means the server ignored the Range request → the file restarts.
          prefix = status === 206 ? resumeFrom : 0
          job.receivedBytes = prefix
          if (contentLength != null) job.totalBytes = prefix + contentLength
        },
        onProgress: (received) => {
          job.receivedBytes = prefix + received
        }
      })
      this.deps.log?.('Model download finished, verifying', {
        modelId: job.modelId,
        status: result.status,
        bytes: job.receivedBytes
      })

      // A cancel that raced the final bytes: cancel() aborts our controller, so the
      // signal is the explicit cancel flag (no status-narrowing cast needed).
      if (controller.signal.aborted) return // keep the .part for resume

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
        return
      }
      if (verify.reason === 'missing') {
        job.status = 'failed'
        job.error = tMain('main.download.fileMissing')
        this.deps.audit?.('model_download_failed', `Model download failed: ${job.modelId}`, {
          modelId: job.modelId,
          jobId: job.jobId,
          reason: 'file missing before verification'
        })
        return
      }

      // ok (verified) or placeholder (cannot verify — checksum honesty): the bytes are
      // complete either way, so move the file into place and refresh install state.
      renameSync(part, task.dest)
      invalidateChecksum(task.dest, hashStore)
      job.unverified = verify.reason === 'placeholder'
      job.status = 'done'
      this.deps.log?.('Model download complete', {
        modelId: job.modelId,
        verified: !job.unverified
      })
      // Checksum honesty extends to the audit log: only a REAL hash match records
      // "verified" (a placeholder-hash completion stays unrecorded — the model itself
      // reports UNVERIFIED on the Models screen).
      if (!job.unverified) {
        this.deps.audit?.('model_download_verified', `Model download verified: ${job.modelId}`, {
          modelId: job.modelId,
          jobId: job.jobId,
          bytes: job.receivedBytes
        })
      }
    } catch (err) {
      if (job.status === 'cancelled') {
        // The abort we asked for — the kept `.part` resumes next time.
        this.deps.log?.('Model download stopped after cancel; partial kept for resume', {
          modelId: job.modelId
        })
        return
      }
      job.status = 'failed'
      job.error = friendlyDownloadError(err)
      this.deps.log?.('Model download failed', { modelId: job.modelId, error: String(err) })
      this.deps.audit?.('model_download_failed', `Model download failed: ${job.modelId}`, {
        modelId: job.modelId,
        jobId: job.jobId,
        reason: String(err).slice(0, 300)
      })
    }
  }
}

/** Map a low-level fetch/stream error to spec §11.4-toned copy (never blame, stay plain). */
function friendlyDownloadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/HTTP \d+/.test(raw)) {
    return tMain('main.download.httpFailed', { reason: raw.replace(/^Download failed: /, '') })
  }
  return tMain('main.download.interrupted', { reason: raw })
}
