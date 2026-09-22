import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OcrInstallJob, OcrInstallStatus, PolicyStatus } from '@shared/types'
import { friendlyIpcError } from './errors'
import { computeDownloadGate } from './downloadGate'
import { useT } from '../i18n'

// The in-app OCR language-file install (#410), shared by the Documents rows (a failed scan or
// photo that needs the files) and the AI Model screen's quiet row: both entry points open the
// SAME confirmation dialog (`OcrInstallDialog.tsx`) and drive the SAME job, so this hook carries
// the one lazy-load/poll/cancel/remembered-job pattern (the `useKnowledgePackToolsInstall.ts`
// shape). The dialog facts come from main (`ocr:status` — code-side pins, the yaml's host).

const JOB_LIVE: ReadonlySet<OcrInstallJob['status']> = new Set([
  'queued',
  'downloading',
  'verifying',
  'activating'
])

// Module-scoped (like ModelsScreen's `rememberedEngineJob`): leaving and re-entering a screen
// during a live install keeps showing its progress instead of losing the job.
let rememberedJob: OcrInstallJob | null = null

/** Test/preview-only reset. Production code never calls this. */
export function __resetOcrInstallForTests(): void {
  rememberedJob = null
}

export interface OcrInstall {
  /** The dialog facts, or null while loading / on an older preload. */
  status: OcrInstallStatus | null
  downloadsEnabled: boolean
  /** Why downloads are blocked (the SAME copy as every other download surface), or null. */
  blockedReason: string | null
  job: OcrInstallJob | null
  /** `job` is queued/downloading/verifying/activating. */
  live: boolean
  /** A refused start or cancel, as friendly copy. */
  error: string | null
  start: () => Promise<void>
  cancel: () => Promise<void>
}

/**
 * `active` gates the lazy `getOcrInstallStatus`/`getPolicy` fetch — the caller passes true only
 * while the affordance may be shown, so screens that never need it make no extra calls. The
 * fetch runs once per `active` transition to true, and again after every finished job (the files
 * changed). `onFinished` fires exactly once per job, on its live → terminal transition (done,
 * failed or cancelled) — the caller re-reads its own status then.
 */
export function useOcrInstall(active: boolean, onFinished: (job: OcrInstallJob) => void): OcrInstall {
  const { t } = useT()
  const [status, setStatus] = useState<OcrInstallStatus | null>(null)
  const [policy, setPolicy] = useState<PolicyStatus | null>(null)
  const [job, setJob] = useState<OcrInstallJob | null>(rememberedJob)
  const [error, setError] = useState<string | null>(null)
  const [loadTick, setLoadTick] = useState(0)
  const jobRef = useRef<OcrInstallJob | null>(rememberedJob)
  const mountedRef = useRef(true)
  const onFinishedRef = useRef(onFinished)
  onFinishedRef.current = onFinished

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!active) return
    // `Promise.resolve` + `?.`: an older/partial preload (or a test stub that never supplied
    // these) degrades to "no offer" instead of throwing.
    Promise.all([
      Promise.resolve(window.api.getOcrInstallStatus?.()),
      Promise.resolve(window.api.getPolicy?.())
    ])
      .then(([s, p]) => {
        if (!mountedRef.current) return
        setStatus(s ?? null)
        setPolicy(p ?? null)
      })
      .catch((e) => {
        if (mountedRef.current) setError(friendlyIpcError(e))
      })
  }, [active, loadTick])

  // Poll the live job (the engine/kiwix hooks' async-with-polling shape).
  useEffect(() => {
    jobRef.current = job
    rememberedJob = job
    if (!job || !JOB_LIVE.has(job.status)) return
    const timer = setInterval(() => {
      Promise.resolve(window.api.getOcrInstallJob?.(job.jobId))
        .then((next) => {
          if (!mountedRef.current || !next) return
          // A response for a job that is no longer current must never overwrite the newer one.
          if (jobRef.current?.jobId !== job.jobId || next.jobId !== job.jobId) return
          // The ref moves NOW, not after React commits: a second response handled before that
          // commit (two queued polls, or a cancel reply racing a tick) must see the terminal job,
          // so `onFinished` fires exactly once per job.
          const wasLive = JOB_LIVE.has(jobRef.current?.status ?? 'done')
          jobRef.current = next
          setJob(next)
          if (wasLive && !JOB_LIVE.has(next.status)) {
            setLoadTick((n) => n + 1)
            onFinishedRef.current(next)
          }
        })
        .catch(() => undefined)
    }, 500)
    return () => clearInterval(timer)
  }, [job?.jobId, job?.status])

  const start = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const started = await window.api.installOcr()
      rememberedJob = started
      jobRef.current = started
      if (mountedRef.current) setJob(started)
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    }
  }, [])

  const cancel = useCallback(async (): Promise<void> => {
    const current = jobRef.current
    if (!current) return
    try {
      const next = await window.api.cancelOcrInstall(current.jobId)
      if (jobRef.current?.jobId !== next.jobId) return // a newer job replaced it meanwhile
      rememberedJob = next
      if (!mountedRef.current) return
      const wasLive = JOB_LIVE.has(jobRef.current?.status ?? 'done')
      jobRef.current = next
      setJob(next)
      if (wasLive && !JOB_LIVE.has(next.status)) {
        setLoadTick((n) => n + 1)
        onFinishedRef.current(next)
      }
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    }
  }, [])

  const gate = computeDownloadGate(policy, t)
  // Memoized so a Documents row that receives this object keeps its memo while nothing changed.
  return useMemo(
    () => ({
      status,
      downloadsEnabled: gate.downloadsEnabled,
      blockedReason: gate.blockedReason,
      job,
      live: job != null && JOB_LIVE.has(job.status),
      error,
      start,
      cancel
    }),
    [status, gate.downloadsEnabled, gate.blockedReason, job, error, start, cancel]
  )
}
