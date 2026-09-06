import { useEffect, useRef, useState } from 'react'
import type { EngineDownloadJob, EngineOptionalFamily, EngineStatus, PolicyStatus } from '@shared/types'
import { friendlyIpcError } from './errors'
import { computeDownloadGate } from './downloadGate'
import { useT } from '../i18n'

// Shared by the Knowledge-packs panel notice AND the Models screen's quiet row (#339 P8-2, the
// owner's ruling): both entry points install the SAME optional family (`kiwix_tools`) through
// the SAME confirm dialog (`KnowledgePackToolsDialog.tsx`), so this hook carries the one
// poll/cancel/remembered-job pattern instead of two copies that could drift — it mirrors
// ModelsScreen's own engine-job handling (`ModelsScreen.tsx` ~340-372 poll, ~905-985 banner).

const JOB_LIVE: ReadonlySet<EngineDownloadJob['status']> = new Set([
  'queued',
  'downloading',
  'verifying',
  'extracting'
])

// Module-scoped (like ModelsScreen's `rememberedEngineJob`): a remount during a LIVE install —
// leaving and re-entering the Documents screen, or the Models screen — keeps showing progress
// instead of losing the job.
let rememberedJob: EngineDownloadJob | null = null

/** Test/preview-only reset. Production code never calls this (mirrors ModelsScreen's own). */
export function __resetKnowledgePackToolsInstallForTests(): void {
  rememberedJob = null
}

export interface KnowledgePackToolsInstall {
  /** The `kiwix_tools` entry of `optionalFamilies` — null while loading, absent, or installed. */
  family: EngineOptionalFamily | null
  downloadsEnabled: boolean
  blockedReason: string | null
  job: EngineDownloadJob | null
  /** `job` is in a live (queued/downloading/verifying/extracting) state. */
  live: boolean
  error: string | null
  start: () => Promise<void>
  cancel: () => Promise<void>
}

/**
 * `active` gates the lazy `getEngineStatus`/`getPolicy` fetch: the caller passes `false` while
 * the affordance need not exist yet — PacksPanel: `toolsInstalled` is true; ModelsScreen: the
 * family isn't in `missingOptionalFamilies` — so the existing PacksPanel tests (which stub only
 * `getKnowledgePackStatus`/`listKnowledgePacks`) keep passing untouched, and `assertNoUnexpected
 * ApiCalls()` stays meaningful. The fetch runs once per `active` transition to true, not on
 * every render. `onDone` fires exactly once, on the `done` transition only (never `failed` /
 * `cancelled`) — the caller re-derives its own install state from its own refresh instead of
 * this hook guessing at it.
 */
export function useKnowledgePackToolsInstall(
  active: boolean,
  onDone: () => void
): KnowledgePackToolsInstall {
  const { t } = useT()
  const [family, setFamily] = useState<EngineOptionalFamily | null>(null)
  const [policy, setPolicy] = useState<PolicyStatus | null>(null)
  const [job, setJob] = useState<EngineDownloadJob | null>(rememberedJob)
  const [error, setError] = useState<string | null>(null)
  const jobRef = useRef<EngineDownloadJob | null>(rememberedJob)
  const mountedRef = useRef(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const fetchedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Lazy load: only once `active` and only once per mount (a re-render while active stays true
  // must not re-fetch).
  useEffect(() => {
    if (!active || fetchedRef.current) return
    fetchedRef.current = true
    Promise.all([window.api.getEngineStatus(), window.api.getPolicy()])
      .then(([engine, p]: [EngineStatus | undefined, PolicyStatus | undefined]) => {
        if (!mountedRef.current) return
        // `?.` tolerates an older/partial preload (or a test stub that never supplied these) —
        // same defensive shape as ModelsScreen's own `getEngineStatus?.()` degrade.
        setFamily(
          engine?.optionalFamilies?.find((f) => f.family === 'kiwix_tools' && !f.installed) ?? null
        )
        setPolicy(p ?? null)
      })
      .catch((e) => {
        if (!mountedRef.current) return
        setError(friendlyIpcError(e))
      })
  }, [active])

  // Poll the live install job (same async-with-polling shape as ModelsScreen's engine poll).
  useEffect(() => {
    jobRef.current = job
    rememberedJob = job
    if (!job || !JOB_LIVE.has(job.status)) return
    const timer = setInterval(() => {
      window.api
        .getEngineJob(job.jobId)
        .then((next) => {
          if (!mountedRef.current) return
          // A response for a job that is no longer current (a new install accepted meanwhile)
          // must never overwrite the newer job (mirrors ModelsScreen's F2/B1 guard).
          if (jobRef.current?.jobId !== job.jobId || next.jobId !== job.jobId) return
          setJob(next)
          // Fire exactly once, on the live → 'done' transition (never 'failed' / 'cancelled',
          // and never again once polling has already stopped — 'done' drops out of JOB_LIVE so
          // the interval above is not rescheduled on the next effect run).
          if (next.status === 'done' && JOB_LIVE.has(jobRef.current?.status ?? 'done')) {
            onDoneRef.current()
          }
        })
        .catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [job?.jobId, job?.status])

  async function start(): Promise<void> {
    setError(null)
    try {
      const started = await window.api.downloadEngine({ families: ['kiwix_tools'] })
      rememberedJob = started
      if (mountedRef.current) setJob(started)
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    }
  }

  async function cancel(): Promise<void> {
    if (!job) return
    try {
      const next = await window.api.cancelEngineDownload(job.jobId)
      rememberedJob = next
      if (mountedRef.current) setJob(next)
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    }
  }

  const gate = computeDownloadGate(policy, t)
  return {
    family,
    downloadsEnabled: gate.downloadsEnabled,
    blockedReason: gate.blockedReason,
    job,
    live: job != null && JOB_LIVE.has(job.status),
    error,
    start,
    cancel
  }
}
