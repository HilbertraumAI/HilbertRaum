import { existsSync, renameSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mainUiLanguage, tMain } from './i18n'
import type { ModelManifest } from '../../shared/manifest'
import type { DownloadJob } from '../../shared/types'
import { isUnresolvedDownloadResult } from '../../shared/downloads'
import { fmt1 } from '../../shared/format'
import { freeBytes } from './disk-space'
import {
  planModelDownloads,
  downloadToFile,
  failureReason,
  flushToDevice,
  isDiskError,
  modelWeightMaxBytes,
  verifyDownloadedFile,
  ResumeOffsetMismatchError,
  RangeNotSatisfiableError,
  type FetchFn,
  type ModelDownloadTask,
  type VerifyResult
} from './assets'
import { invalidateChecksum, primeChecksum, type HashStore } from './models'
import { noteWeightWarmed } from './read-speed'

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
//   the main process — a renderer bug can never start an unsanctioned download. The gates are
//   read at the start only; switching internet access off later stops the job through
//   `networkSwitched` (#782). A workspace lock does not (BE-2).
// - The network bytes land in `<weightPath>.part`; the file is renamed into place ONLY
//   after the hash verifies, so a crashed/cancelled download never leaves a half-weight
//   where `computeInstallState` can see it. A cancelled/failed `.part` is KEPT and
//   resumed via a `Range` header next time (best-effort; a server without ranges → 200
//   → clean restart).
// - A COMPLETE `.part` (a cancel/crash during the minutes-long verify, or a failed rename,
//   leaves the full file staged) is NOT re-requested with an unsatisfiable `Range:
//   bytes=<fullSize>-` (→ HTTP 416, which used to loop forever with no in-app recovery,
//   F-13). It is VERIFIED in place: a matching hash renames it into place; a mismatch
//   discards the `.part` and restarts clean (the ResumeOffsetMismatch treatment).
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

/**
 * #782: "Allow internet access" as one downloader sees it, between its gate checks. Each manager (models, the
 * engine, OCR) holds one; the settings handler reports every real flip of the switch to it.
 *
 * - A switch-off is remembered for the run that was going, so a job in a local phase (a check, an extraction)
 *   stops at its next network request (`stopsAt`); the manager stops a transfer at once itself.
 * - A start captures `mark()` with its gates and asks `stillAllowed(mark)` after its awaits, so a start that
 *   planned across a switch-off is refused while the switch is still off.
 * - A switch back on withdraws a stop still waiting for its request.
 */
export class NetworkSwitch {
  private offs = 0
  private isOff = false
  private due: { run: AbortController; onStopped: () => void } | null = null

  /** Internet access went off. `run` is the controller of the manager's running job, if there is one. */
  switchedOff(run: AbortController | null, onStopped: () => void): void {
    this.offs++
    this.isOff = true
    this.due = run ? { run, onStopped } : null
  }

  /** Internet access went back on: a job that has not stopped yet carries on. */
  switchedOn(): void {
    this.isOff = false
    this.due = null
  }

  /** Captured with the gates at the top of a start. */
  mark(): number {
    return this.offs
  }

  /** False when the switch went off after `mark` and is still off. */
  stillAllowed(mark: number): boolean {
    return this.offs === mark || !this.isOff
  }

  /** True when `run` must stop before its next network request. */
  stopsAt(run: AbortController): boolean {
    return this.due?.run === run
  }

  /** `run` stopped for the switch: its `onStopped` (the notice) runs once, and never throws out of here. */
  stopped(run: AbortController): void {
    if (this.due?.run !== run) return
    const { onStopped } = this.due
    this.due = null
    try {
      onStopped()
    } catch {
      /* the notice is best-effort; it must never fail the run that called it */
    }
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
  /** Persistent checksum cache: primed with the verified hash on success; invalidated for a placeholder. */
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
function partPath(dest: string): string {
  return `${dest}.part`
}

/** Finished (done/failed/cancelled) jobs kept around for late polls; older ones are pruned. */
const MAX_TERMINAL_JOBS = 20

/**
 * Owns the in-app download jobs. Jobs live in memory for the session only (never persisted —
 * a renderer reload keeps them, an app restart loses them, #314); the durable truth is the
 * filesystem — a verified weight in place, or a resumable `.part`.
 */
export class DownloadManager {
  private jobs = new Map<string, DownloadJob>()
  /**
   * Held until `run()` has settled, not until the job reads terminal (#752, F-33 in the sibling
   * managers). `cancel()` flips the status at once, but the run can still be closing its stream
   * on the `.part`; a second start in that window would write to the same file.
   */
  private active: { jobId: string; controller: AbortController } | null = null
  /** #782: the internet-access switch between this manager's gate checks. */
  private readonly network = new NetworkSwitch()
  /** #314: terminal results the renderer dismissed. Session-only like `jobs`, and pruned
   *  alongside it so the set stays bounded by MAX_TERMINAL_JOBS. */
  private dismissed = new Set<string>()
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
   * manifest has no upstream source, the weight is already present + verified, or the
   * drive has no room for the bytes still to fetch (#768).
   */
  async start(opts: StartDownloadOptions): Promise<DownloadJob> {
    this.pruneTerminalJobs()
    assertDownloadAllowed(opts.gates)
    const networkMark = this.network.mark()
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
      // #196: the upstream publisher deleted the exact file this manifest pins. Checked BEFORE
      // the license gate (the planner orders them the same way) because no acknowledgement can
      // make a deleted file fetchable — and refused HERE, not only in the renderer, so the
      // known-dead URL is never requested even if a card offers the button.
      const withdrawn = tasks.find((t) => t.status === 'source-withdrawn')
      if (withdrawn) {
        throw new Error(
          tMain('main.download.sourceWithdrawn', {
            modelId: opts.manifest.id,
            reason: withdrawn.withdrawn ?? ''
          })
        )
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
      // #768: refused before the job exists, so a download that cannot fit is never audited as
      // started and never requested, instead of failing on ENOSPC partway through.
      await assertRoomFor(toDownload)
      // #782: internet access was switched off while this start planned (the plan can hash a file
      // already on the drive, for minutes), and is still off: the gates it began with no longer hold.
      if (!this.network.stillAllowed(networkMark)) throw new Error(tMain('main.download.networkOff'))

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
   * #314 — every job a renderer that lost its memory still has to show: the live job (if any)
   * plus every retained terminal job that is still UNRESOLVED (failed, or done-but-unverified)
   * and not dismissed, in creation order. A verified `done` and a `cancelled` job are never
   * listed — the model row carries their state. Snapshots, like `get()`.
   */
  list(): DownloadJob[] {
    const live = this.activeJob()
    const out: DownloadJob[] = []
    for (const job of this.jobs.values()) {
      // A cancelled job can still hold the run while it unwinds; it is not the user's problem.
      if (job.jobId === live && job.status !== 'cancelled') {
        out.push({ ...job })
        continue
      }
      if (this.dismissed.has(job.jobId)) continue
      if (isUnresolvedDownloadResult(job)) out.push({ ...job })
    }
    return out
  }

  /**
   * #314 — the user dismissed a terminal result: `list()` stops offering it, so the dismissal
   * survives a renderer reload (main-process memory does; the renderer's module state does not).
   * An id this manager never issued (or already pruned) is a no-op: recording it would grow
   * the set without ever bounding it.
   */
  dismiss(jobId: string): void {
    if (this.jobs.has(jobId)) this.dismissed.add(jobId)
  }

  /**
   * Cancel an in-flight download. The `.part` file is kept so the next attempt resumes.
   * Cancelling a job that already reached a terminal state is a no-op. `verifying` is a
   * cancellable state too (BE-4, full-audit 2026-07-10): the SHA-256 over a multi-GB weight
   * on USB takes minutes, and a dropped cancel there let a two-file job start its next file.
   * The abort stops the hash itself (#752), so the run settles at once instead of minutes later;
   * `runOne` re-checks the signal after the verify returns, before any rename.
   */
  cancel(jobId: string): DownloadJob {
    const job = this.jobs.get(jobId)
    if (!job) return this.get(jobId)
    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'verifying') {
      job.status = 'cancelled'
      if (this.active?.jobId === jobId) this.active.controller.abort()
      this.deps.log?.('Model download cancelled', { modelId: job.modelId, jobId })
    }
    return { ...job }
  }

  /**
   * #782: internet access was switched off (`on` false) or back on. Off: a transfer in progress stops
   * at once; a job checking a file it already has finishes that file and stops before its next
   * request, so a model whose bytes are all on the drive still installs; a start still planning is
   * refused when its plan is done. The `.part` is kept, as for a cancel. `onStopped` runs once, when
   * (and if) the job stops. On before that: the job carries on.
   */
  networkSwitched(on: boolean, onStopped: () => void = () => undefined): void {
    if (on) return this.network.switchedOn()
    const active = this.active
    this.network.switchedOff(active?.controller ?? null, onStopped)
    const job = active ? this.jobs.get(active.jobId) : undefined
    if (active && job && (job.status === 'queued' || job.status === 'downloading')) {
      this.stopNetworkJob(job, active.controller)
    }
  }

  /** Stop `job` for #782: it reads `cancelled` and says why, and its run settles as a cancel's does. */
  private stopNetworkJob(job: DownloadJob, controller: AbortController): void {
    job.status = 'cancelled'
    job.stoppedBy = 'networkOff'
    controller.abort()
    this.deps.log?.('Model download stopped: internet access was switched off', {
      modelId: job.modelId,
      jobId: job.jobId
    })
    this.network.stopped(controller)
  }

  /**
   * Drop the oldest terminal jobs beyond the keep window. Jobs are session-only and a
   * long session can start many downloads — without this the map grows unbounded. The
   * Map iterates in insertion (= creation) order, so the front entries are the oldest;
   * `get()` already answers pruned ids with a terminal "unknown job" snapshot. A pruned job's
   * dismissal record goes with it (#314), so `dismissed` can never outgrow the keep window.
   */
  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()].filter(
      (j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
    )
    for (const job of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_JOBS))) {
      this.jobs.delete(job.jobId)
      this.dismissed.delete(job.jobId)
    }
  }

  /** The job whose run has not settled yet, or null. A cancelled job stays here until it has. */
  activeJob(): string | null {
    return this.active?.jobId ?? null
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
      // BE-4 (full-audit 2026-07-10): a cancel that landed in the window after this file's
      // abort checks (e.g. during the rename) must stop the run here — the next runOne would
      // otherwise overwrite the `cancelled` status and start downloading the next file.
      if (controller.signal.aborted) {
        job.status = 'cancelled'
        return
      }
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
    // A COMPLETE `.part` cannot be resumed (Range would be unsatisfiable → 416). When the
    // staged bytes turn out corrupt we discard them and restart ONE clean download; the loop
    // caps that at a single retry (`allowResume` false → no Range → 200 restart / fresh fetch).
    let allowResume = true
    for (;;) {
      // A clean restart comes back here past the awaited delete of the bad `.part`. A cancel in
      // that await must stand: 'downloading' below would overwrite it (#752).
      if (controller.signal.aborted) {
        job.status = 'cancelled'
        return false
      }
      try {
        // Best-effort Range resume: a kept `.part` (cancelled/crashed earlier attempt)
        // becomes the prefix. The server decides — 206 appends, 200 restarts cleanly.
        const resumeFrom = allowResume && existsSync(part) ? statSync(part).size : 0
        // F-13: the `.part` already holds the WHOLE file (size known + covered) — a cancel/
        // crash during the minutes-long verify, or a failed rename, staged it. Resuming would
        // send `Range: bytes=<fullSize>-` and every origin answers 416, with no in-app
        // recovery. Verify the staged bytes in place instead; a mismatch discards + restarts.
        if (resumeFrom > 0 && task.sizeBytes != null && resumeFrom >= task.sizeBytes) {
          const settled = await this.settleCompletePart(job, task, controller, hashStore, baseBytes)
          if (settled === 'restart') {
            allowResume = false
            continue
          }
          return settled === 'done'
        }
        // #782: internet access went off while this job checked a file it already had. That file
        // finished; nothing new is requested.
        if (this.network.stopsAt(controller)) {
          this.stopNetworkJob(job, controller)
          return false
        }
        let prefix = resumeFrom
        job.status = 'downloading'
        job.receivedBytes = baseBytes + prefix
        const result = await downloadToFile(task.url, part, {
          fetchImpl: this.deps.fetchImpl,
          signal: controller.signal,
          // D3 + F17: cap the body so a redirected/hostile endpoint can't stream past it and fill the
          // drive (the SHA verify already rejects wrong bytes). The cap is the manifest's size_bytes
          // plus drift headroom when known, else a bounded per-role default — never unbounded (so a
          // manifest that omits size_bytes no longer collapses the cap to the multi-GiB backstop).
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
        const verify = await this.verifyPart(part, task, job, controller.signal)
        // BE-4 (full-audit 2026-07-10): honour a cancel that landed DURING the hash — before
        // acting on the verify result. Same contract as a mid-download cancel: the `.part` is
        // kept for resume, nothing is renamed into place, and a two-file job stops here. The
        // status is set explicitly because a cancel racing the `verifying` transition above
        // could have been overwritten.
        if (controller.signal.aborted) {
          job.status = 'cancelled'
          this.deps.log?.('Model download cancelled during verify; partial kept for resume', {
            modelId: job.modelId
          })
          return false
        }
        if (verify.reason === 'mismatch') {
          // Verify-before-trust: the partial is deleted, the job fails loudly.
          await rm(part, { force: true })
          this.deps.log?.('Model download checksum mismatch — partial deleted', {
            modelId: job.modelId,
            expected: task.expectedSha256,
            actual: verify.actual
          })
          this.failJob(job, tMain('main.download.checksumMismatch'), 'checksum mismatch — file discarded')
          return false
        }
        if (verify.reason === 'missing') {
          this.failJob(job, tMain('main.download.fileMissing'), 'file missing before verification')
          return false
        }

        // ok (verified) or placeholder (cannot verify — checksum honesty): the bytes are
        // complete either way, so move the file into place and refresh install state.
        this.finishVerifiedFile(job, task, hashStore, baseBytes, verify)
        return true
      } catch (err) {
        if (job.status === 'cancelled') {
          // The abort we asked for — the kept `.part` resumes next time.
          this.deps.log?.('Model download stopped after cancel; partial kept for resume', {
            modelId: job.modelId
          })
          return false
        }
        // F-13: a `Range` resume answered 416 — the `.part` is already complete (size unknown,
        // so the pre-download short-circuit above could not fire). Verify it in place: a match
        // renames into place, a mismatch discards + restarts clean. Same recovery, reached via
        // the network this time. GUARDED (Phase-5 review fix-up): unlike the try-path settle —
        // whose throws fall into THIS catch — a throw escaping here (renameSync on an
        // AV-interfered destination, an I/O fault out of the verify) would leave runOne, become
        // an unhandled rejection (run()/start() never catch), and strand the job at non-terminal
        // 'verifying' forever with no error copy. Route it to the shared failure handling below.
        if (err instanceof RangeNotSatisfiableError && existsSync(part)) {
          try {
            const settled = await this.settleCompletePart(job, task, controller, hashStore, baseBytes)
            if (settled === 'restart') {
              allowResume = false
              continue
            }
            return settled === 'done'
          } catch (settleErr) {
            if (controller.signal.aborted) return false // a stopped hash, not a failure (#752)
            this.deps.log?.('Model download failed settling a complete partial', {
              modelId: job.modelId,
              error: String(settleErr)
            })
            this.failJob(job, friendlyDownloadError(settleErr, hasPartBytes(part)), failureReason(settleErr))
            return false
          }
        }
        // A misaligned 206 resume (the server served a slice starting at the wrong byte): the on-disk
        // `.part` can't be safely continued, so discard it — the NEXT attempt restarts from scratch
        // rather than re-appending onto a poisoned prefix (BUG dl-size-cap-2026-07-03 hardening).
        // A delete that fails (an AV lock) is the failure to report: thrown from this catch it
        // would strand the job at 'downloading', the class the 416 branch above guards (#752).
        let failure: unknown = err
        if (err instanceof ResumeOffsetMismatchError) {
          try {
            await rm(part, { force: true })
            this.deps.log?.('Model download resume offset mismatch — partial discarded for a clean restart', {
              modelId: job.modelId
            })
          } catch (rmErr) {
            failure = rmErr
          }
        }
        this.deps.log?.('Model download failed', { modelId: job.modelId, error: String(failure) })
        this.failJob(job, friendlyDownloadError(failure, hasPartBytes(part)), failureReason(failure))
        return false
      }
    }
  }

  /**
   * The one way a job fails, by the OCR manager's rule: a cancel that landed during an awaited
   * delete stands (#752). The renderer stopped polling on that `cancelled`, so a late `failed`
   * would turn up later as a failure the user never saw. `reason` is the audit record's, a label.
   */
  private failJob(job: DownloadJob, error: string, reason: string): void {
    if (job.status === 'cancelled') return
    job.status = 'failed'
    job.error = error
    this.deps.audit?.('model_download_failed', `Model download failed: ${job.modelId}`, {
      modelId: job.modelId,
      jobId: job.jobId,
      reason
    })
  }

  /**
   * The verify-after-download hash (#106): a real multi-GB model-weight hash that
   * bypasses `sha256FileCached` (it hashes the staged `.part`, then `finishVerifiedFile`
   * primes the cache). `verifyDownloadedFile` carries the instrumentation itself; this
   * wrapper only supplies the model label. A cancel stops the hash, which rejects (#752): both
   * of `runOne`'s catches read that as the cancel it is.
   */
  private async verifyPart(
    part: string,
    task: ModelDownloadTask,
    job: DownloadJob,
    signal: AbortSignal
  ): Promise<VerifyResult> {
    return verifyDownloadedFile(part, task.expectedSha256, { modelId: job.modelId, file: 'download' }, signal)
  }

  /**
   * Settle a `.part` that already holds the COMPLETE file (F-13): reached from the pre-download
   * size short-circuit or from a caught 416. Verify the staged bytes in place rather than
   * re-requesting an unsatisfiable `Range`. A matching (or placeholder) hash renames into
   * place exactly like a fresh download; a real mismatch discards the `.part` so the caller
   * restarts one clean download. A cancel landing during the hash keeps the `.part` (resume
   * contract). Returns 'done' | 'cancelled' | 'failed' | 'restart'.
   */
  private async settleCompletePart(
    job: DownloadJob,
    task: ModelDownloadTask,
    controller: AbortController,
    hashStore: HashStore | undefined,
    baseBytes: number
  ): Promise<'done' | 'cancelled' | 'failed' | 'restart'> {
    const part = partPath(task.dest)
    job.status = 'verifying'
    job.receivedBytes = baseBytes + statSync(part).size
    this.deps.log?.('Completed .part found — verifying in place instead of resuming (F-13)', {
      modelId: job.modelId
    })
    const verify = await this.verifyPart(part, task, job, controller.signal)
    // Honour a cancel that landed DURING the hash — keep the `.part` (BE-4 resume contract).
    if (controller.signal.aborted) {
      job.status = 'cancelled'
      this.deps.log?.('Model download cancelled during complete-part verify; partial kept', {
        modelId: job.modelId
      })
      return 'cancelled'
    }
    if (verify.reason === 'missing') {
      this.failJob(job, tMain('main.download.fileMissing'), 'file missing before verification')
      return 'failed'
    }
    if (verify.reason === 'mismatch') {
      // The staged bytes are wrong (a torn/aborted prior write) — discard and restart clean
      // rather than serving a corrupt weight the checksum cache would later report verified.
      await rm(part, { force: true })
      this.deps.log?.('Completed .part failed verification — discarded for a clean restart (F-13)', {
        modelId: job.modelId,
        expected: task.expectedSha256,
        actual: verify.actual
      })
      return 'restart'
    }
    // ok (verified) or placeholder (cannot verify): the bytes are complete either way. The hash
    // read them through the page cache, so it says nothing about the device, and a stream that
    // ended on failure never reached `downloadToFile`'s flush (#752, F-34).
    flushToDevice(part)
    this.finishVerifiedFile(job, task, hashStore, baseBytes, verify)
    return 'done'
  }

  /**
   * Rename a verified/placeholder `.part` into place and refresh the checksum cache. Shared by
   * the fresh-download finish and the F-13 complete-part settle so the prime/invalidate + total
   * accounting has ONE definition.
   */
  private finishVerifiedFile(
    job: DownloadJob,
    task: ModelDownloadTask,
    hashStore: HashStore | undefined,
    baseBytes: number,
    verify: VerifyResult
  ): void {
    renameSync(partPath(task.dest), task.dest)
    // #392: the bytes at `task.dest` are page-cache-resident — the app wrote them moments ago —
    // and the prime below means nothing will ever re-hash them, so no `checksum` sample exists
    // for this file either. A model start right after the download would time a RAM read and
    // persist it as the drive's speed. Mark the FINAL path warm (never the `.part`, which is
    // gone): this start records no read sample at all, and the next cold one measures the medium.
    noteWeightWarmed(task.dest)
    // Prime the checksum cache with the hash we JUST computed (identical bytes, same file) so the
    // Models screen's install-state refresh reports `installed` immediately instead of redundantly
    // re-hashing the multi-GB weight — that re-hash is the invisible gap where the card briefly
    // looked un-downloaded (download→verify UX). A placeholder file has no real hash to trust, so
    // it is invalidated (computeInstallState short-circuits placeholder weights without hashing).
    // BE-2 (full-audit 2026-07-10): the checksum cache is an OPTIMIZATION — a store fault
    // (e.g. the workspace was locked mid-download, closing the settings DB) must never
    // change the outcome of a download whose bytes are already verified + in place.
    try {
      if (verify.reason === 'placeholder' || !verify.actual) {
        invalidateChecksum(task.dest, hashStore)
      } else {
        primeChecksum(task.dest, verify.actual, hashStore)
      }
    } catch {
      // Ids only (S1 policy) — the next install-state read simply re-hashes.
      this.deps.log?.('Checksum cache update failed after verify; download outcome unchanged', {
        modelId: job.modelId,
        jobId: job.jobId
      })
    }
    // A single placeholder-hash file taints the whole model as UNVERIFIED (never silently pass).
    if (verify.reason === 'placeholder') job.unverified = true
    // Pin the combined received total to this file's true on-disk size before the next file.
    job.receivedBytes = baseBytes + statSync(task.dest).size
  }
}

/**
 * Refuse a download whose bytes still to fetch exceed the free space where the weights land
 * (#768). Still to fetch: each file's declared size less its kept `.part`, which the run resumes
 * (a complete one is verified in place and needs nothing). No check when any file's size is
 * undeclared or the free space cannot be read, and no headroom on top: the owner's call, the
 * same gentle posture as preflight's low-space note. The drive's files live under one root, so
 * the first file's folder (or its nearest existing parent) answers for all of them.
 */
async function assertRoomFor(tasks: ModelDownloadTask[]): Promise<void> {
  let needed = 0
  for (const task of tasks) {
    if (task.sizeBytes == null) return
    const kept = statSync(partPath(task.dest), { throwIfNoEntry: false })?.size ?? 0
    needed += Math.max(0, task.sizeBytes - kept)
  }
  const free = await freeBytes(dirname(tasks[0].dest))
  if (free == null || needed <= free) return
  const lang = mainUiLanguage()
  // Both figures in the unit the size needs, so a projector or the rest of a resume reads "40.0 MB"
  // rather than "0.1 GB" — decimal, one decimal, like every disk size (`fmtDiskSize`). And they must
  // never read alike: free space rounds down to the tenth; the size rounds as shown elsewhere,
  // unless that prints the same tenth as the free space, and then up — which always differs, since
  // needed > free.
  const [unit, label]: [number, string] =
    needed >= 1e9 ? [1e9, 'GB'] : needed >= 1e6 ? [1e6, 'MB'] : [1e3, 'KB']
  const shown = (bytes: number): string => `${fmt1(bytes / unit, lang)} ${label}`
  const tenth = unit / 10
  const freeShown = shown(Math.floor(free / tenth) * tenth)
  let neededShown = shown(needed)
  if (neededShown === freeShown) neededShown = shown(Math.ceil(needed / tenth) * tenth)
  throw new Error(tMain('main.download.notEnoughSpace', { needed: neededShown, free: freeShown }))
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

/** Is anything on the drive for the next start to resume from? */
function hasPartBytes(part: string): boolean {
  try {
    return statSync(part).size > 0
  } catch {
    return false
  }
}

/**
 * Map a low-level fetch/stream error to spec §11.4-toned copy (never blame, stay plain). Only a
 * failure with bytes on the drive may say `main.download.interrupted`, which promises to keep them
 * (#752): an errno's message names the drive path and its `.part` may be gone, a misaligned resume
 * has just deleted the `.part`, and a request that failed before its first byte kept nothing.
 */
function friendlyDownloadError(err: unknown, partKept: boolean): string {
  if (err instanceof ResumeOffsetMismatchError) return tMain('main.download.resumeDiscarded')
  if (isDiskError(err)) return tMain('main.download.writeFailed')
  const raw = err instanceof Error ? err.message : String(err)
  if (/HTTP \d+/.test(raw) || !partKept) {
    return tMain('main.download.httpFailed', { reason: raw.replace(/^Download failed: /, '') })
  }
  return tMain('main.download.interrupted', { reason: raw })
}
