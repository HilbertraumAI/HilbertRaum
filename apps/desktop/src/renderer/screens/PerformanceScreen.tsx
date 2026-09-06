import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, ErrorBanner, useToast } from '../components'
import { useT, type I18n } from '../i18n'
import { localizeServerCopy } from '../lib/displayMap'
import { friendlyIpcError } from '../lib/errors'
import { fmt1 } from '../lib/format'
import type { UiLanguage } from '@shared/i18n'
import { isHardwareProfile } from '@shared/benchmark-schema'
import { isUsefulDevice, looksIntegrated, USABLE_VRAM_MB } from '@shared/gpu-rules'
import {
  CARD_FREE_SLACK_MB,
  FIT_TARGET_MARGIN_MB,
  SLOW_READ_MBPS,
  SLOW_TOKENS_PER_SECOND
} from '@shared/performance-rules'
import type {
  BenchmarkProgressStep,
  BenchmarkResult,
  EffectiveReadSample,
  HardwareProfile,
  ModelInfo,
  PerformanceSnapshot,
  PlacementKind,
  ResidentModelRow
} from '@shared/types'

// The Performance screen (design-guidelines §2, the machine group; benchmark.md
// "Performance screen"). Four cards — "This computer", "Observed while you worked", "Models on
// this computer", "Other computers":
//   1. "This computer": the hardware check's answer as a verdict line + four tiles (speed,
//      memory, graphics memory, drive) and the one action, "Check again". While a check runs, the steps show
//      as they land (EVENTS.benchmarkProgress) instead of an opaque "Running…" button. The model
//      the verdict and the "Start … and measure" offer name is `snapshot.recommendation` — the
//      LIVE pick the AI Model screen stars; the result's saved pick is history, labelled
//      "Recommended at the time of the check" where it differs.
//   2. "Observed while you worked": real figures from normal use (the last finished answer,
//      the last model start, the last full file check). The ROWS are session latches; of the
//      figures behind them only the answer speed is never persisted — the read samples do
//      persist into the benchmark records, where the Drive tile shows them (PR #303 audit L8).
//      Above the models card on purpose: what the machine actually did outranks what it could hold.
//   3. "Models on this computer": every model the app can hold, where it runs, loaded or not,
//      and the two shared budgets (card, RAM).
//   4. "Other computers": one row per machine the drive has been checked on.
// The raw table + Copy stays on Settings › Diagnostics (the support surface); this screen
// answers the user's question ("what can this computer run, how fast") in plain words.
//
// The whole screen is PUSHED, never polled (benchmark.md "Push, not poll"): main broadcasts the
// payload-free `performance:changed` after anything the snapshot reads has changed, and the
// screen re-reads `performance:get`. So the observed rows, the loaded/not-loaded pills and the
// running state stay current while the screen is open, including for a benchmark another window
// (or the first-run path) started.
//
// The rating thresholds (`SLOW_TOKENS_PER_SECOND`, `SLOW_READ_MBPS`), the "usable card" rule
// (`isUsefulDevice`, `USABLE_VRAM_MB`) and the two placement figures the copy names
// (`CARD_FREE_SLACK_MB`, `FIT_TARGET_MARGIN_MB`) are IMPORTED from the shared modules the main
// services rate by — never re-declared here (PR #303 audit N3 / M8 / DR4).

/** MiB → GB (1 GiB units, one decimal), the figure the probe reports. */
function vramGb(mb: number, lang: UiLanguage): string {
  return fmt1(mb / 1024, lang)
}

/** The `--fit-target` margin as the copy states it: a whole number of GB when it divides
 *  evenly (today's 1 GiB), else one decimal — locale-formatted either way. */
function marginGb(lang: UiLanguage): string {
  const gb = FIT_TARGET_MARGIN_MB / 1024
  return Number.isInteger(gb) ? gb.toLocaleString(lang) : fmt1(gb, lang)
}

const PLACE_PILL: Record<PlacementKind, { key: 'perf.place.gpu' | 'perf.place.partial' | 'perf.place.cpu' | 'perf.place.tooLarge' | 'perf.place.unknown'; tone: 'success' | 'warning' | 'neutral' | 'error' }> = {
  gpu: { key: 'perf.place.gpu', tone: 'success' },
  partial: { key: 'perf.place.partial', tone: 'warning' },
  cpu: { key: 'perf.place.cpu', tone: 'neutral' },
  too_large: { key: 'perf.place.tooLarge', tone: 'error' },
  unknown: { key: 'perf.place.unknown', tone: 'neutral' }
}

type Tone = 'success' | 'warning' | 'neutral' | 'accent'

function fmtNum(n: number, lang: UiLanguage): string {
  return n.toLocaleString(lang)
}

/** The dash the tiles already use for a figure the app does not have. */
const UNKNOWN = '–'

// Defence in depth against a malformed persisted record (PR #303 audit H1). `getSettings`
// validates every benchmark record now, so the snapshot should never carry one — but the
// formatters below are the LAST thing between a stored blob and the screen, and
// `toLocaleString` on `undefined` throws, which took the whole screen down (there is no error
// boundary above it). A missing/NaN figure reads as the tiles' unknown dash instead, so one
// bad row can only ever cost its own value.

function fmt1Safe(n: number | null | undefined, lang: UiLanguage): string {
  return typeof n === 'number' && Number.isFinite(n) ? fmt1(n, lang) : UNKNOWN
}

function fmtNumSafe(n: number | null | undefined, lang: UiLanguage): string {
  return typeof n === 'number' && Number.isFinite(n) ? fmtNum(n, lang) : UNKNOWN
}

/** A record whose date is unknown carries `ranAt: ''` (`UNKNOWN_RAN_AT`) — never a fake "now". */
function fmtDate(iso: string | null | undefined, lang: UiLanguage): string {
  if (!iso) return UNKNOWN
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(lang)
}

function fmtDateTime(iso: string | null | undefined, lang: UiLanguage): string {
  if (!iso) return UNKNOWN
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang)
}

/** Seconds (one decimal) from a byte count over MB/s: the model-load window's duration. */
function secondsOf(sample: EffectiveReadSample, lang: UiLanguage): string {
  return fmt1(sample.ms / 1000, lang)
}

/** The model's display name when the catalog knows it, else its id (an old result may name
 *  a model no longer in the catalog), else the "loaded model" placeholder. */
function modelName(id: string | null | undefined, models: ModelInfo[], t: I18n['t']): string {
  if (!id) return t('perf.unknownModel')
  return models.find((m) => m.id === id)?.displayName ?? id
}

function speedTone(tps: number): Tone {
  return tps < SLOW_TOKENS_PER_SECOND ? 'warning' : 'success'
}

function driveTone(mbps: number): Tone {
  return mbps < SLOW_READ_MBPS ? 'warning' : 'success'
}

/** The profile of a record, tolerant of a malformed one (H1): anything unrecognised is UNKNOWN. */
function profileOf(profile: BenchmarkResult['profile'] | undefined): HardwareProfile {
  return isHardwareProfile(profile) ? profile : 'UNKNOWN'
}

function profileTone(profile: BenchmarkResult['profile'] | undefined): Tone {
  return profileOf(profile) === 'UNKNOWN' ? 'neutral' : 'accent'
}

/**
 * What the graphics tile (and the Copy report) has to say — resolved ONCE from the snapshot
 * (PR #303 audit M8 / N1). For the computer the app is on, the ELIGIBLE probe's device
 * (`snap.currentGpu`, selected and rated main-side by the shared rules) is the freshest truth
 * and wins; a result from another computer has only what its own check recorded. `name` and
 * `mb` always describe one device. The rating never comes from the memory figure alone: the
 * `useful` flag main computed for the live device, else the shared `isUsefulDevice` rule over
 * the recorded name + memory — so an integrated device reporting 16 GB of shared memory is
 * "Integrated", never "Usable".
 */
type GraphicsFigure =
  | { kind: 'pending' }
  | { kind: 'notRecorded' }
  | { kind: 'none' }
  | { kind: 'device'; mb: number; name: string | null; useful: boolean; integrated: boolean }

function graphicsFigure(bench: BenchmarkResult | null, snap: PerformanceSnapshot | null): GraphicsFigure {
  if (!bench) return { kind: 'pending' }
  const live = snap?.currentMachine ? snap.currentGpu : null
  const mb = live?.totalMb ?? bench.gpuVramMb ?? null
  const name = live?.name ?? bench.gpu ?? null
  if (mb == null || mb <= 0) {
    // A foreign result that merely predates the field: the app never probed that machine for
    // it, so it claims nothing either way (N1). An explicit null IS a recorded "nothing".
    return snap && !snap.currentMachine && !('gpuVramMb' in bench) ? { kind: 'notRecorded' } : { kind: 'none' }
  }
  const useful = typeof live?.useful === 'boolean' ? live.useful : isUsefulDevice({ name: name ?? '', totalMb: mb })
  return { kind: 'device', mb, name, useful, integrated: !useful && name != null && looksIntegrated(name) }
}

/**
 * A decode figure that did NOT come from the runtime's own timings: the chunk-count fallback,
 * or a result persisted before `speedBasis` existed (all of which were chunk-based). Rated with
 * the neutral "Approximate" pill instead of Good/Slow — an approximate figure is not evidence
 * of a fast or a slow machine (PR #303 audit L6).
 */
function speedIsApprox(bench: Pick<BenchmarkResult, 'speedBasis'>): boolean {
  return bench.speedBasis?.basis !== 'timings'
}

/**
 * How a decode figure was measured, in words — the SAME qualifier the Speed tile carries, so
 * the Copy report and the other-computer rows can never present a chunk-counted or a legacy
 * reading as an ordinary tokens/s figure (PR #303 audit L6). `basis: 'timings'` names the
 * window it covers (`diag.bench.tokensOver`, the wording Diagnostics uses for the same fact);
 * the chunk fallback is marked approximate and names its chunk count; an ABSENT basis is
 * approximate with NO window — the app never invents one.
 */
function speedBasisNote(bench: Pick<BenchmarkResult, 'speedBasis'>, t: I18n['t'], lang: UiLanguage): string {
  const basis = bench.speedBasis
  if (basis?.basis === 'timings') return t('diag.bench.tokensOver', { tokens: fmtNumSafe(basis.tokens, lang) })
  const approx = t('perf.tile.speed.approx')
  return basis ? `${approx}; ${t('perf.tile.speed.chunks', { chunks: fmtNumSafe(basis.tokens, lang) })}` : approx
}

/** Plain-text rendering of the "This computer" card for the Copy button (mirrors the
 *  Diagnostics report shape so support sees the same figures either way). `currentMachine`
 *  decides the heading: the report is pasted into a support message, where "This computer"
 *  over another machine's figures misattributes every line under it (L6). */
function buildReport(
  bench: BenchmarkResult,
  graphics: GraphicsFigure,
  models: ModelInfo[],
  contextTokens: number | null,
  currentMachine: boolean,
  t: I18n['t'],
  lang: UiLanguage
): string {
  const graphicsLine =
    graphics.kind === 'device'
      ? `${vramGb(graphics.mb, lang)} ${t(graphics.integrated ? 'perf.tile.graphics.unitShared' : 'perf.tile.graphics.unit')} (${graphics.name ?? ''})`
      : graphics.kind === 'notRecorded'
        ? t('perf.rating.notRecorded')
        : t('perf.rating.none')
  // Timings: "Measured with X on DATE, over N tokens". Chunks / no basis: the tile's own
  // qualifier after a full stop, with the chunk window only when the record carries one.
  const speedSub = t('perf.tile.speed.sub', {
    model: modelName(bench.measuredModelId, models, t),
    when: fmtDate(bench.ranAt, lang)
  })
  const speedProvenance = speedIsApprox(bench)
    ? `${speedSub}. ${speedBasisNote(bench, t, lang)}`
    : `${speedSub}, ${speedBasisNote(bench, t, lang)}`
  const lines = [
    currentMachine
      ? t('perf.card.title')
      : t('perf.report.otherComputer', {
          cpu: bench.cpuModel || t('perf.unknownCpu'),
          ram: fmt1Safe(bench.ramGb, lang)
        }),
    `${t('perf.tile.speed')}: ${
      bench.tokensPerSecond != null
        ? `${fmtNumSafe(bench.tokensPerSecond, lang)} ${t('perf.tile.speed.unit')} (${speedProvenance})`
        : t('perf.tile.speed.none')
    }`,
    `${t('perf.tile.memory')}: ${bench.ramGb > 0 ? `${fmt1Safe(bench.ramGb, lang)} ${t('perf.tile.memory.unit')}` : t('diag.app.unknown')}`,
    `${t('diag.bench.cpu')}: ${(bench.cpuModel || t('perf.unknownCpu')) + (bench.cpuCores > 0 ? t('diag.bench.cores', { count: bench.cpuCores }) : '')}`,
    `${t('perf.tile.graphics')}: ${graphicsLine}`,
    `${t('perf.tile.drive')}: ${
      bench.effectiveRead ? `${fmtNumSafe(bench.effectiveRead.mbps, lang)} ${t('perf.tile.drive.unit')}` : t('perf.tile.drive.none')
    }`,
    `${t('diag.bench.profile')}: ${bench.profile}`,
    // The result's own pick is what the check said then; the live one is on the screen.
    `${t('perf.recommendation.atCheckTime')}: ${bench.recommendedModelId ? modelName(bench.recommendedModelId, models, t) : t('diag.bench.noMatch')}`
  ]
  if (contextTokens != null) lines.push(`${t('models.context.title')}: ${t('models.tech.contextValue', { count: contextTokens.toLocaleString(lang) })}`)
  lines.push(`${t('diag.bench.lastRun')}: ${fmtDateTime(bench.ranAt, lang)}`)
  for (const w of bench.warnings) lines.push(`- ${localizeServerCopy(t, w)}`)
  return lines.join('\n')
}

interface TileProps {
  label: string
  value: string | null
  unit?: string
  sub: string
  pill: string
  tone: Tone
}

function Tile({ label, value, unit, sub, pill, tone }: TileProps): JSX.Element {
  return (
    <div className="perf-tile">
      <div className="perf-tile-head">
        <span className="perf-tile-label">{label}</span>
        <Badge tone={tone}>{pill}</Badge>
      </div>
      <div className="perf-tile-value">
        {value ?? '–'}
        {value != null && unit ? <small>{unit}</small> : null}
      </div>
      <div className="perf-tile-sub">{sub}</div>
    </div>
  )
}

const STEP_ORDER: BenchmarkProgressStep[] = ['system', 'drive', 'speed']

function StepIcon({ state }: { state: 'done' | 'active' | 'todo' }): JSX.Element {
  return (
    <svg className="perf-step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      {state === 'done' && <path d="m8.5 12.3 2.4 2.4 4.8-5" />}
      {state === 'active' && <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />}
    </svg>
  )
}

export interface PerformanceScreenProps {
  onNavigate: (target: string) => void
}

export function PerformanceScreen({ onNavigate }: PerformanceScreenProps): JSX.Element {
  const { t, lang } = useT()
  const toast = useToast()
  const [snap, setSnap] = useState<PerformanceSnapshot | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  // The GPU is switched off in Settings or auto-disabled after a crash: the next start runs from
  // RAM whatever card the probe lists, and the graphics tile says so instead of "no card".
  const [gpuOff, setGpuOff] = useState(false)
  const [runtimeModelId, setRuntimeModelId] = useState<string | null>(null)
  /** A check THIS window started ("Check again" / "Start … and measure"). Kept apart from the
   *  snapshot's `running`, which is the backend's benchmark occupancy span and is true for runs
   *  this window never started (PR #303 audit M1: merging the two locked the screen into
   *  "Running…" for a foreign run and never let it out). */
  const [ownActionInFlight, setOwnActionInFlight] = useState(false)
  const [doneSteps, setDoneSteps] = useState<BenchmarkProgressStep[]>([])
  /** The last failed `performance:get`; cleared by the next successful read. */
  const [fetchError, setFetchError] = useState<string | null>(null)
  /** The last failed action; cleared when the user starts another one — never by a read, so a
   *  background refresh cannot swallow the failure the user is still looking at. */
  const [actionError, setActionError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  // ---- The snapshot read: pushed, serialised (benchmark.md "Push, not poll") ----------------
  // `performance:changed` carries nothing; every push means "re-read `performance:get`". One
  // read at a time: a push that lands while a read is in flight raises `wantedRef` and buys
  // ANOTHER pass once that read settles, so no push is ever dropped and two reads never race.
  // `genRef` stamps each issued read — only the newest stamp may apply a reply, and unmount
  // bumps it, so a late reply is discarded instead of touching a dead screen. A discarded reply
  // CONTINUES the drain rather than leaving it: a read wanted meanwhile (React.StrictMode's
  // dev double mount asks for one on the same instance) must still be issued. No timers.
  const genRef = useRef(0)
  const readingRef = useRef(false)
  const wantedRef = useRef(false)
  const pendingRef = useRef<Promise<void> | null>(null)
  /** Mirrors `ownActionInFlight` for the apply path (state is a render behind). */
  const ownActionRef = useRef(false)
  /** `running` of the last applied snapshot: its false → true edge is a run starting. */
  const backendRunningRef = useRef(false)
  /** Set when THIS window starts a check from the action button; consumed by the focus effect
   *  once the idle actions row is back. Never set for a run another window started (HW3). */
  const restoreFocusRef = useRef(false)
  /** The idle branch's "Check again" / "Check this computer" button — the node the busy branch
   *  unmounts under a keyboard user. */
  const checkButtonRef = useRef<HTMLButtonElement | null>(null)

  const applySnapshot = useCallback((next: PerformanceSnapshot): void => {
    // Verbatim, never merged with the previous value: the screen follows the backend out of a
    // run as readily as into one.
    setSnap(next)
    // A run this window did not start has no steps here (main sends `benchmark:progress` to the
    // requesting window only), so it shows the running state with none ticked rather than
    // inventing them. Our own run cleared them at the click and its first step can land before
    // this snapshot does — re-clearing under our own run would un-tick it.
    if (next.running && !backendRunningRef.current && !ownActionRef.current) setDoneSteps([])
    backendRunningRef.current = next.running
  }, [])

  /** The cheap metadata the actions read, re-read with every snapshot: which model is up (the
   *  "Start … and measure" offer, the speed step's label). NOT `listModels` — that is a name
   *  lookup, mount-only. Fire-and-forget under the read's stamp, so a slow reply neither stalls
   *  the snapshot nor overwrites a newer one. The graphics figure is NOT read here: the raw
   *  `settings.gpuProbe` could belong to another computer, so the snapshot's eligible
   *  `currentGpu` is the only probe source this screen has (PR #303 audit M8.3); the settings
   *  read below takes ONLY the two GPU flags, for the tile's "acceleration is off" sub-line. */
  const refreshMeta = useCallback((gen: number): void => {
    const fresh = (): boolean => mountedRef.current && gen === genRef.current
    void window.api
      .getRuntimeStatus()
      .then((r) => {
        if (fresh()) setRuntimeModelId(r.running ? r.modelId : null)
      })
      .catch(() => {})
    void window.api
      .getSettings()
      .then((s) => {
        if (!fresh()) return
        setGpuOff(s.gpuMode === 'off' || s.gpuAutoDisabled)
      })
      .catch(() => {})
  }, [])

  const refresh = useCallback((): Promise<void> => {
    wantedRef.current = true
    // Already reading: the flag above guarantees one more pass when it settles.
    if (readingRef.current) return pendingRef.current ?? Promise.resolve()
    readingRef.current = true
    const drain = async (): Promise<void> => {
      try {
        while (wantedRef.current && mountedRef.current) {
          wantedRef.current = false
          const gen = (genRef.current += 1)
          try {
            const next = await window.api.getPerformance()
            if (!mountedRef.current || gen !== genRef.current) continue
            applySnapshot(next)
            setFetchError(null)
          } catch (err) {
            if (!mountedRef.current || gen !== genRef.current) continue
            // The last snapshot stays on screen and the actions stay live; the banner explains
            // the stale figures and offers the retry.
            setFetchError(friendlyIpcError(err))
          }
          refreshMeta(gen)
        }
      } finally {
        readingRef.current = false
        pendingRef.current = null
      }
    }
    const p = drain()
    // Park it only if the drain actually suspended — a synchronous throw finishes it before
    // this line, and its `finally` has already cleared the flags.
    if (readingRef.current) pendingRef.current = p
    return p
  }, [applySnapshot, refreshMeta])

  // Subscribe BEFORE the first read (a push that lands during it must not be missed) and tear
  // both subscriptions down on unmount: one registration per mount, no accumulation.
  useEffect(() => {
    mountedRef.current = true
    const offChanged = window.api.onPerformanceChanged(() => {
      void refresh()
    })
    // The steps of a check THIS window started (main sends them to the requesting window only).
    const offProgress = window.api.onBenchmarkProgress((step) => {
      if (!mountedRef.current) return
      // 'done' means the PROBES are complete — the persist and the occupancy release still
      // follow (benchmark.md "Progress"), so it is not the idle signal: re-read rather than
      // guess, and let the terminal push be the one that turns `running` off.
      if (step === 'done') {
        void refresh()
        return
      }
      setDoneSteps((prev) => (prev.includes(step) ? prev : [...prev, step]))
    })
    void refresh()
    // Display names for the model ids the results carry. Mount-only: it is a name lookup, no
    // push changes it, and a model installed elsewhere arrives with this screen's next mount.
    // lazyVerify: no weight hashing for a name lookup.
    window.api
      .listModels(true)
      .then((list) => mountedRef.current && setModels(list))
      .catch(() => {})
    return () => {
      mountedRef.current = false
      // Invalidate everything in flight: a reply that lands after this applies nothing.
      genRef.current += 1
      offChanged?.()
      offProgress?.()
    }
  }, [refresh])

  const runCheck = useCallback(async (): Promise<void> => {
    ownActionRef.current = true
    restoreFocusRef.current = true
    setOwnActionInFlight(true)
    setActionError(null)
    setDoneSteps([])
    try {
      await window.api.runBenchmark()
    } catch (err) {
      if (mountedRef.current) setActionError(friendlyIpcError(err))
    } finally {
      // ONLY the local flag: whether a run still holds the lane is the snapshot's answer (the
      // persist and the release follow the last step), and the push after them delivers it.
      ownActionRef.current = false
      if (mountedRef.current) setOwnActionInFlight(false)
      await refresh()
    }
  }, [refresh])

  /** "Start <model> and measure": bring the recommended model up (the AI Model screen's
   *  "Use this model" action), then check, so the check's speed leg has a runtime. */
  const startAndMeasure = useCallback(
    async (modelId: string): Promise<void> => {
      ownActionRef.current = true
      restoreFocusRef.current = true
      setOwnActionInFlight(true)
      setActionError(null)
      setDoneSteps([])
      try {
        const status = await window.api.useModel(modelId)
        if (mountedRef.current) setRuntimeModelId(status.running ? status.modelId : null)
        await window.api.runBenchmark()
      } catch (err) {
        if (mountedRef.current) setActionError(friendlyIpcError(err))
      } finally {
        ownActionRef.current = false
        if (mountedRef.current) setOwnActionInFlight(false)
        await refresh()
      }
    },
    [refresh]
  )

  const copyReport = useCallback(
    (text: string): void => {
      void window.api
        ?.copyToClipboard(text)
        .then((ok) => toast(ok ? t('diag.copied') : t('diag.copyFailed')))
        .catch(() => toast(t('diag.copyFailed')))
    },
    [toast, t]
  )

  const bench = snap?.current ?? null
  /** The backend's own answer, taken from each snapshot as it comes. */
  const backendRunning = snap?.running ?? false
  /** What the card shows as busy: a run anywhere on this machine, or this window's own action. */
  const busy = backendRunning || ownActionInFlight

  // Keyboard focus across the busy swap (HW3; design-guidelines §6). The busy branch renders a
  // DIFFERENT subtree — the steps list plus a disabled "Running…" button — so the action button
  // a keyboard user just activated is UNMOUNTED and the active element falls back to <body>:
  // the user is dropped out of the screen mid-task and has to tab in from the top again. When
  // the run THIS window started ends and the idle actions row mounts again, put focus back on
  // the primary action. The flag is set only by `runCheck` / `startAndMeasure` and cleared as
  // it is consumed, so a run this window did not start (another window, the first-run path)
  // ends without ever moving the caret out from under whatever the user is doing here.
  useEffect(() => {
    if (busy || !restoreFocusRef.current) return
    restoreFocusRef.current = false
    checkButtonRef.current?.focus()
  }, [busy])

  // Both failures can stand at once; the read failure is the one with a retry.
  const bannerMessage =
    [
      actionError ? t('perf.failed', { error: actionError }) : null,
      fetchError ? t('perf.loadFailed', { error: fetchError }) : null
    ]
      .filter(Boolean)
      .join(' ') || null
  // The LIVE pick (the same one the AI Model screen stars), never the id saved with the check:
  // a fresh probe, a flipped GPU toggle or a new speed sample moves it without a re-run. The
  // saved `recommendedModelId` is history and is labelled as such where it still shows.
  const live = snap?.recommendation ?? null
  const recommended = live?.modelId ? models.find((m) => m.id === live.modelId) ?? null : null
  const recommendedName = live?.modelId ? modelName(live.modelId, models, t) : null
  const atCheckTimeName =
    bench?.recommendedModelId && live && bench.recommendedModelId !== live.modelId
      ? modelName(bench.recommendedModelId, models, t)
      : null
  // The context the LIVE recommended model would launch with, resolved MAIN-SIDE by the launch
  // path's own helper (PR #303 audit M5 residual): recomputing it here with `??` over the
  // catalog entry showed a "0-token context" for a model whose manifest states no recommended
  // window, while the runtime starts such a model on the settings default.
  const contextTokens = snap?.placement.recommendedContextTokens ?? null
  const speedModelName = bench ? modelName(bench.measuredModelId, models, t) : ''
  const speedApprox = bench != null && bench.tokensPerSecond != null && speedIsApprox(bench)
  const canStartRecommended =
    recommended != null &&
    runtimeModelId == null &&
    (recommended.state === 'installed' || recommended.state === 'ready')

  function verdict(): string {
    if (!bench) return t('perf.verdict.notChecked')
    const drive = bench.effectiveRead
      ? ' ' + (bench.effectiveRead.mbps < SLOW_READ_MBPS ? t('perf.verdict.driveSlow') : t('perf.verdict.driveFast'))
      : ''
    if (bench.tokensPerSecond != null) {
      return t('perf.verdict.speed', { model: speedModelName, tps: fmtNumSafe(bench.tokensPerSecond, lang) }) + drive
    }
    if (recommendedName && live) {
      return t('perf.verdict.noSpeed', { model: recommendedName, basis: t(`perf.basis.${live.basis}`) }) + drive
    }
    return t('perf.verdict.noRecommendation') + drive
  }

  function speedTile(): JSX.Element {
    if (!bench || bench.tokensPerSecond == null) {
      return (
        <Tile
          label={t('perf.tile.speed')}
          value={null}
          sub={t('perf.tile.speed.noneHint')}
          pill={t('perf.rating.pending')}
          tone="neutral"
        />
      )
    }
    return (
      <Tile
        label={t('perf.tile.speed')}
        value={fmtNumSafe(bench.tokensPerSecond, lang)}
        unit={t('perf.tile.speed.unit')}
        sub={
          t('perf.tile.speed.sub', { model: speedModelName, when: fmtDate(bench.ranAt, lang) }) +
          (speedApprox ? `. ${t('perf.tile.speed.approx')}` : '')
        }
        pill={
          speedApprox
            ? t('perf.rating.approx')
            : bench.tokensPerSecond < SLOW_TOKENS_PER_SECOND
              ? t('perf.rating.slow')
              : t('perf.rating.good')
        }
        tone={speedApprox ? 'neutral' : speedTone(bench.tokensPerSecond)}
      />
    )
  }

  const unified = snap?.placement.memoryClass === 'unified'

  function memoryTile(): JSX.Element {
    const cpu = bench
      ? (bench.cpuModel || t('perf.unknownCpu')) + (bench.cpuCores > 0 ? t('diag.bench.cores', { count: bench.cpuCores }) : '')
      : ''
    return (
      <Tile
        label={unified ? t('perf.tile.memory.unified') : t('perf.tile.memory')}
        value={bench && bench.ramGb > 0 ? fmt1Safe(bench.ramGb, lang) : null}
        unit={t('perf.tile.memory.unit')}
        sub={bench ? [unified ? t('perf.tile.memory.unifiedSub') : null, cpu].filter(Boolean).join(' · ') : t('perf.notChecked')}
        pill={t(`perf.profile.${profileOf(bench?.profile)}`)}
        tone={bench ? profileTone(bench.profile) : 'neutral'}
      />
    )
  }

  const graphics = graphicsFigure(bench, snap)

  /** Graphics memory decides what runs accelerated, so it stands beside RAM as its own
   *  tile. One figure (`graphicsFigure`): `snapshot.currentGpu` — the BUDGET device for the
   *  next start, the same card the Models ★ goes by, for the computer the app is on right now
   *  — else what the result recorded; rated by the shared "usable" rule. Never the stored
   *  probe's first device: on a hybrid laptop that is as often the iGPU's shared-RAM figure
   *  (PR #308 audit decision 9). A device rated not usable is named honestly — an integrated
   *  one (a recorded name) by its shared memory, a small discrete one by its size — and never
   *  called "Usable"; a foreign result that never recorded the field says so; with the GPU
   *  switched off or auto-disabled and no card for the next start, the copy names the cause
   *  instead of a missing card. */
  function graphicsTile(): JSX.Element {
    if (graphics.kind !== 'device') {
      const [sub, pill] =
        graphics.kind === 'pending'
          ? [t('perf.notChecked'), t('perf.rating.pending')]
          : graphics.kind === 'notRecorded'
            ? [t('perf.tile.graphics.notRecorded'), t('perf.rating.notRecorded')]
            : [gpuOff ? t('perf.tile.graphics.off') : t('perf.tile.graphics.none'), t('perf.rating.none')]
      return <Tile label={t('perf.tile.graphics')} value={null} sub={sub} pill={pill} tone="neutral" />
    }
    const { mb, name, useful, integrated } = graphics
    if (integrated) {
      return (
        <Tile
          label={t('perf.tile.graphics')}
          value={vramGb(mb, lang)}
          unit={t('perf.tile.graphics.unitShared')}
          sub={[name, t('perf.tile.graphics.integrated')].filter(Boolean).join(' · ')}
          pill={t('perf.rating.integrated')}
          tone="neutral"
        />
      )
    }
    return (
      <Tile
        label={t('perf.tile.graphics')}
        value={vramGb(mb, lang)}
        unit={t('perf.tile.graphics.unit')}
        sub={useful ? (name ?? '') : [name, t('perf.tile.graphics.small', { min: Math.round(USABLE_VRAM_MB / 1024) })].filter(Boolean).join(' · ')}
        pill={useful ? t('perf.rating.usable') : t('perf.rating.small')}
        tone={useful ? 'success' : 'warning'}
      />
    )
  }

  function driveTile(): JSX.Element {
    const sample = bench?.effectiveRead ?? null
    if (!sample) {
      return (
        <Tile
          label={t('perf.tile.drive')}
          value={null}
          sub={t('perf.tile.drive.noneHint')}
          pill={t('perf.rating.pending')}
          tone="neutral"
        />
      )
    }
    const params = { when: fmtDate(sample.at, lang), gb: fmt1(sample.bytes / 1e9, lang) }
    return (
      <Tile
        label={t('perf.tile.drive')}
        value={fmtNum(sample.mbps, lang)}
        unit={t('perf.tile.drive.unit')}
        sub={sample.source === 'model_load' ? t('perf.tile.drive.load', params) : t('perf.tile.drive.hash', params)}
        pill={sample.mbps < SLOW_READ_MBPS ? t('perf.rating.slow') : t('perf.rating.fast')}
        tone={driveTone(sample.mbps)}
      />
    )
  }

  /** "Your model": the active model against this computer's memory (benchmark.md). The
   *  verdict is main-side; this only puts words and numbers to it. */
  function modelRow(): JSX.Element {
    const p = snap?.placement
    if (!p) return <></>
    const gb = (mb: number | null | undefined): string => (mb == null ? '' : fmt1(mb / 1024, lang))
    const pill = PLACE_PILL[p.model ? p.verdict.kind : 'unknown']
    const v = p.verdict
    let need = ''
    let text = ''
    if (!p.model) {
      text = t('perf.model.none')
    } else {
      need = v.needMb == null ? '' : v.estimated ? t('perf.model.needEstimate', { need: gb(v.needMb) }) : t('perf.model.need', { need: gb(v.needMb) })
      const budget = gb(v.budgetMb)
      switch (v.kind) {
        case 'gpu':
          text =
            p.memoryClass === 'unified'
              ? t(v.estimated ? 'perf.model.unifiedEstimate' : 'perf.model.unified', { ram: gb(p.ramMb), budget })
              : // No layer count to state (an estimate, or — defence in depth against a
                // malformed record — an observed 'gpu' with no total): the wording that needs
                // none, never "all  layers on the GPU" with an empty interpolation (L7 / gate (c)).
                v.estimated || v.totalLayers == null
                ? t('perf.model.gpuEstimate', { budget })
                : t('perf.model.gpu', { budget, layers: String(v.totalLayers) })
          break
        case 'partial': {
          const split = { budget, gpuLayers: String(v.gpuLayers ?? ''), layers: String(v.totalLayers ?? ''), spill: gb(v.spillMb), margin: marginGb(lang) }
          if (v.estimated) {
            text = t('perf.model.partialEstimate', { budget, spill: gb(v.spillMb) })
          } else if (v.freeAtStartMb == null) {
            text = t('perf.model.partial', split)
          } else if (v.budgetMb != null && v.freeAtStartMb >= v.budgetMb - CARD_FREE_SLACK_MB) {
            // The card was essentially empty: the fit's own reservations are the reason.
            const free = gb(v.freeAtStartMb)
            text =
              v.workingMb != null
                ? t('perf.model.partialMargin', { ...split, free, working: gb(v.workingMb) })
                : t('perf.model.partialMarginNoWorking', { ...split, free })
          } else {
            text = t('perf.model.partialFree', { ...split, free: gb(v.freeAtStartMb) })
          }
          break
        }
        case 'cpu':
          text = t(v.estimated ? 'perf.model.cpuEstimate' : 'perf.model.cpu', { budget })
          break
        case 'too_large':
          text = t('perf.model.tooLarge', { budget })
          break
        default:
          // Owner gate (c): an OBSERVED unknown is the runtime's silence, not a missing first
          // start — "measured on its first start" would invite a restart that changes nothing.
          text = t(v.estimated ? 'perf.model.unknown' : 'perf.model.unknownObserved')
      }
    }
    // Nothing measured for the current configuration: the placement record lives on the DRIVE,
    // one per model, and is read back only on the machine that wrote it — so a start elsewhere
    // sends this row back to the estimate (PR #303 audit L8). The mismatch note below says
    // something more specific about the same fact, so the two never both appear.
    const showPerDrive = p.model != null && v.estimated && !p.observedMismatch
    return (
      <div className="perf-model">
        <div className="perf-model-title">{t('perf.model.title')}</div>
        <div className="perf-model-line">
          {p.model
            ? t('perf.model.line', {
                model: modelName(p.model.id, models, t),
                size: fmt1(p.model.sizeOnDiskGb, lang),
                context: p.model.contextTokens.toLocaleString(lang)
              })
            : t('perf.model.none')}
        </div>
        {p.model && <div className="perf-model-verdict">{[need, text].filter(Boolean).join(' ')}</div>}
        {/* An earlier measurement that does not describe the current configuration (a different
            context size, or a GPU start now forced onto the processor): the verdict above is the
            estimate for the settings as they stand, and this says what was measured and when, so
            the two never read as one contradicting claim. */}
        {p.model && p.observedMismatch && (
          <div className="perf-model-note hint">
            {t('perf.model.measuredOther', {
              context: p.observedMismatch.contextTokens.toLocaleString(lang),
              when: fmtDate(p.observedMismatch.at, lang)
            })}
          </div>
        )}
        {showPerDrive && <div className="perf-model-note hint">{t('perf.model.perDrive')}</div>}
        <div className="perf-model-side">
          <Badge tone={pill.tone}>{t(pill.key)}</Badge>
          {p.model && v.kind === 'too_large' && (
            <Button size="sm" onClick={() => onNavigate('models')}>
              {t('perf.model.choose')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  /** "Models on this computer": every model the app can hold, where it runs under the current
   *  configuration, and whether it is resident now, then the two shared budgets (the card, the
   *  processor's memory). The card line appears only while a row actually goes to the card;
   *  the processor line compares the class-aware total (main-side, DR5) against RAM — on
   *  Apple Silicon against the unified budget, and the copy says "memory", not "RAM". */
  function modelsCard(): JSX.Element {
    const p = snap?.placement
    if (!p) return <></>
    const gbOf = (v: number | null): string => (v == null ? '' : fmt1(v, lang))
    const chatRow = p.models.find((r) => r.role === 'chat')
    const trRow = p.models.find((r) => r.role === 'translation')
    const anyOnCard = chatRow?.device === 'gpu' || trRow?.device === 'gpu'
    const vram = p.vramMb != null ? fmt1(p.vramMb / 1024, lang) : null
    const unifiedPool = p.memoryClass === 'unified'
    const againstMb = unifiedPool ? (p.verdict.budgetMb ?? p.ramMb) : p.ramMb
    const againstGb = againstMb != null ? fmt1(againstMb / 1024, lang) : null
    const sumGb = p.totals.ramAllMb != null ? fmt1(p.totals.ramAllMb / 1024, lang) : null
    const tooMuch = p.totals.ramAllMb != null && againstMb != null && p.totals.ramAllMb > againstMb
    /** Where a row runs, in words: the pinned roles say "by design"; chat and translation on
     *  the processor are there because of the machine or the configuration, and say just that. */
    const deviceCopy = (r: ResidentModelRow): string =>
      r.device === 'cpu' && (r.role === 'chat' || r.role === 'translation')
        ? t('perf.models.device.processor')
        : t(`perf.models.device.${r.device}`)
    return (
      <div className="card">
        <h2 style={{ marginBottom: 2 }}>{t('perf.models.title')}</h2>
        <p className="hint hint-lede">{t('perf.models.hint')}</p>
        <div className="perf-rows perf-models">
          {p.models.map((r) => (
            <div className="perf-row" key={r.role}>
              <div className="perf-row-main">
                <strong>{t(`perf.role.${r.role}`)}</strong>
                {': '}
                {r.modelId
                  ? r.sizeOnDiskGb != null
                    ? t('perf.models.row', { model: modelName(r.modelId, models, t), size: gbOf(r.sizeOnDiskGb) })
                    : t('perf.models.rowNoSize', { model: modelName(r.modelId, models, t) })
                  : t('perf.models.none')}
              </div>
              <div className="perf-row-sub">
                {[
                  deviceCopy(r),
                  t(`perf.models.lifetime.${r.lifetime}`),
                  r.gpuLayers != null && r.totalLayers != null
                    ? t('perf.models.split', { gpuLayers: String(r.gpuLayers), layers: String(r.totalLayers) })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <div className="perf-row-side">
                {r.modelId && (
                  <Badge tone={r.loaded ? 'success' : 'neutral'}>
                    {r.loaded ? t('perf.models.loaded') : t('perf.models.notLoaded')}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="perf-models-summary">
          {p.memoryClass !== 'cpu' && vram && chatRow && trRow && anyOnCard && (
            <div className="perf-models-summary-line">
              <span>
                {t('perf.models.card', { chat: gbOf(chatRow.sizeOnDiskGb), translation: gbOf(trRow.sizeOnDiskGb), vram })}
                {p.totals.bothOnCard ? ` ${t('perf.models.cardBoth')}` : ''}
              </span>
              {p.totals.bothOnCard && <Badge tone="warning">{t('perf.place.partial')}</Badge>}
            </div>
          )}
          {sumGb && againstGb && (
            <div className="perf-models-summary-line">
              <span>
                {unifiedPool
                  ? t('perf.models.memory', { sum: sumGb, budget: againstGb })
                  : t('perf.models.ram', { sum: sumGb, ram: againstGb })}
              </span>
              <Badge tone={tooMuch ? 'warning' : 'success'}>{tooMuch ? t('perf.models.ramTooMuch') : t('perf.models.ramOk')}</Badge>
            </div>
          )}
        </div>
      </div>
    )
  }

  function steps(): JSX.Element {
    // The speed step only exists when a runtime is up; a run with no model shows it skipped.
    const speedLabel = runtimeModelId
      ? t('perf.step.speed', { model: modelName(runtimeModelId, models, t) })
      : t('perf.step.speedSkipped')
    const labels: Record<BenchmarkProgressStep, string> = {
      system: t('perf.step.system'),
      drive: t('perf.step.drive'),
      speed: speedLabel,
      done: ''
    }
    const firstOpen = STEP_ORDER.find((s) => !doneSteps.includes(s))
    return (
      <ul className="perf-steps" aria-live="polite">
        {STEP_ORDER.map((step) => {
          const state = doneSteps.includes(step) ? 'done' : step === firstOpen ? 'active' : 'todo'
          return (
            <li key={step} className={`perf-step perf-step-${state}`}>
              <StepIcon state={state} />
              <span>{labels[step]}</span>
            </li>
          )
        })}
      </ul>
    )
  }

  const observed = snap?.observed
  const hasObserved = Boolean(observed?.lastAnswer || observed?.lastModelLoad || observed?.lastChecksum)

  return (
    <div className="screen performance-screen">
      <h1>{t('perf.title')}</h1>
      <p className="lead">{t('perf.lead')}</p>

      <div className="card">
        <div className="perf-card-head">
          <h2>{t('perf.card.title')}</h2>
          <span className="hint">
            {busy
              ? t('perf.running')
              : bench
                ? t('perf.checkedAt', { when: fmtDateTime(bench.ranAt, lang) })
                : t('perf.notChecked')}
          </span>
        </div>
        {snap && bench && !snap.currentMachine && <p className="hint hint-lede">{t('perf.otherMachine')}</p>}
        {busy ? (
          <>
            {steps()}
            <div className="actions perf-actions">
              <Button disabled>{t('perf.running')}</Button>
              <span className="hint">{t('perf.step.hint')}</span>
            </div>
          </>
        ) : (
          <>
            <p className="perf-verdict">{verdict()}</p>
            {atCheckTimeName && (
              <p className="hint">
                {t('perf.recommendation.atCheckTime')}: {atCheckTimeName}
              </p>
            )}
            <div className="perf-tiles" style={unified ? { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } : undefined}>
              {speedTile()}
              {memoryTile()}
              {!unified && graphicsTile()}
              {driveTile()}
            </div>
            {modelRow()}
            <div className="actions perf-actions">
              {canStartRecommended && recommended && bench?.tokensPerSecond == null ? (
                <Button variant="primary" onClick={() => void startAndMeasure(recommended.id)}>
                  {t('perf.startAndMeasure', { model: recommended.displayName })}
                </Button>
              ) : null}
              <Button ref={checkButtonRef} onClick={() => void runCheck()}>
                {bench ? t('perf.checkAgain') : t('perf.check')}
              </Button>
              <Button variant="ghost" onClick={() => onNavigate('models')}>
                {t('perf.contextSize')}
              </Button>
              {bench && (
                <Button
                  variant="ghost"
                  title={t('diag.copyTitle')}
                  onClick={() => copyReport(buildReport(bench, graphics, models, contextTokens, snap?.currentMachine ?? true, t, lang))}
                >
                  {t('perf.copy')}
                </Button>
              )}
              <span className="hint">{t('perf.autoNote')}</span>
            </div>
          </>
        )}
        {/* Always mounted so the FIRST failure is announced (SH-2, #145). A failed check and a
            failed read are separate: a later successful read clears the read failure without
            hiding the check the user is still waiting on. */}
        <ErrorBanner message={bannerMessage} t={t}>
          {fetchError ? (
            <div className="actions">
              <Button size="sm" onClick={() => void refresh()}>
                {t('perf.retry')}
              </Button>
            </div>
          ) : null}
        </ErrorBanner>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 2 }}>{t('perf.observed.title')}</h2>
        <p className="hint hint-lede">{t('perf.observed.hint')}</p>
        {!hasObserved ? (
          <p className="hint">{t('perf.observed.none')}</p>
        ) : (
          <div className="perf-rows">
            {observed?.lastAnswer && (
              <div className="perf-row">
                <div className="perf-row-main">
                  {t('perf.observed.answer', {
                    tps: fmt1(observed.lastAnswer.tokensPerSecond, lang),
                    ttft: fmt1(observed.lastAnswer.ttftMs / 1000, lang)
                  })}
                </div>
                <div className="perf-row-sub">
                  {t('perf.observed.answerSub', {
                    model: modelName(observed.lastAnswer.modelId, models, t),
                    when: fmtDateTime(observed.lastAnswer.at, lang),
                    tokens: fmtNum(observed.lastAnswer.tokens, lang)
                  })}
                </div>
                <div className="perf-row-side">
                  <Badge tone={speedTone(observed.lastAnswer.tokensPerSecond)}>
                    {observed.lastAnswer.tokensPerSecond < SLOW_TOKENS_PER_SECOND ? t('perf.rating.slow') : t('perf.rating.good')}
                  </Badge>
                </div>
              </div>
            )}
            {observed?.lastModelLoad && (
              <div className="perf-row">
                <div className="perf-row-main">
                  {t('perf.observed.load', { seconds: secondsOf(observed.lastModelLoad, lang) })}
                </div>
                <div className="perf-row-sub">
                  {t('perf.observed.loadSub', {
                    model: modelName(observed.lastModelLoad.modelId, models, t),
                    gb: fmt1(observed.lastModelLoad.bytes / 1e9, lang),
                    mbps: fmtNum(observed.lastModelLoad.mbps, lang)
                  })}
                </div>
                <div className="perf-row-side">
                  <Badge tone={driveTone(observed.lastModelLoad.mbps)}>
                    {observed.lastModelLoad.mbps < SLOW_READ_MBPS ? t('perf.rating.slow') : t('perf.rating.fast')}
                  </Badge>
                </div>
              </div>
            )}
            {observed?.lastChecksum && (
              <div className="perf-row">
                <div className="perf-row-main">
                  {t('perf.observed.check', { seconds: secondsOf(observed.lastChecksum, lang) })}
                </div>
                <div className="perf-row-sub">
                  {t('perf.observed.checkSub', {
                    model: modelName(observed.lastChecksum.modelId, models, t),
                    when: fmtDate(observed.lastChecksum.at, lang),
                    gb: fmt1(observed.lastChecksum.bytes / 1e9, lang)
                  })}
                </div>
                <div className="perf-row-side">
                  <Badge>{t('perf.observed.oncePerModel')}</Badge>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {modelsCard()}

      <div className="card">
        <h2 style={{ marginBottom: 2 }}>{t('perf.others.title')}</h2>
        <p className="hint hint-lede">{t('perf.others.hint')}</p>
        {!snap || snap.otherMachines.length === 0 ? (
          <p className="hint">{t('perf.others.none')}</p>
        ) : (
          <div className="perf-rows">
            {snap.otherMachines.map((entry) => {
              const model = entry.tokensPerSecond != null ? entry.measuredModelId : entry.recommendedModelId
              const name = modelName(model, models, t)
              const slowDrive = entry.effectiveRead != null && entry.effectiveRead.mbps < SLOW_READ_MBPS
              // Provenance travels with the figure (L6): a chunk-counted or a legacy
              // (absent-basis) reading is rated with the neutral "Approximate" pill and carries
              // the tile's own qualifier in the sub line, so it is never read as an ordinary
              // tokens/s figure this machine could be compared against. A timings reading names
              // the window it covers instead.
              const approx = speedIsApprox(entry)
              const basisNote = entry.tokensPerSecond != null ? speedBasisNote(entry, t, lang) : null
              return (
                <div className="perf-row" key={`${entry.cpuModel}|${entry.ramGb}|${entry.ranAt}`}>
                  <div className="perf-row-main">
                    {entry.tokensPerSecond != null
                      ? t('perf.others.row', { tps: fmtNumSafe(entry.tokensPerSecond, lang), model: name })
                      : t('perf.others.rowNoSpeed', { model: name })}
                  </div>
                  <div className="perf-row-sub">
                    {/* A recorded card is listed as VRAM only when the shared rule rates it usable:
                        an integrated device's shared figure is not graphics memory (M8.1). */}
                    {[
                      entry.gpuVramMb != null &&
                      entry.gpuVramMb > 0 &&
                      isUsefulDevice({ name: entry.gpu ?? '', totalMb: entry.gpuVramMb })
                        ? t('perf.others.subGpu', {
                            cpu: entry.cpuModel || t('perf.unknownCpu'),
                            ram: fmt1Safe(entry.ramGb, lang),
                            vram: vramGb(entry.gpuVramMb, lang),
                            when: fmtDate(entry.ranAt, lang)
                          })
                        : t('perf.others.sub', {
                            cpu: entry.cpuModel || t('perf.unknownCpu'),
                            ram: fmt1Safe(entry.ramGb, lang),
                            when: fmtDate(entry.ranAt, lang)
                          }),
                      basisNote
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="perf-row-side">
                    {entry.tokensPerSecond != null && (
                      <Badge tone={approx ? 'neutral' : speedTone(entry.tokensPerSecond)}>
                        {approx
                          ? t('perf.rating.approx')
                          : entry.tokensPerSecond < SLOW_TOKENS_PER_SECOND
                            ? t('perf.rating.slow')
                            : t('perf.rating.good')}
                      </Badge>
                    )}
                    {slowDrive && <Badge tone="warning">{t('perf.rating.slowDrive')}</Badge>}
                    <Badge tone={profileTone(entry.profile)}>{t(`perf.profile.${profileOf(entry.profile)}`)}</Badge>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="perf-footer">
        <span className="hint">{t('perf.footer')}</span>
        <Button size="sm" variant="ghost" onClick={() => onNavigate('settings:diagnostics')}>
          {t('perf.footerLink')}
        </Button>
      </div>
    </div>
  )
}
