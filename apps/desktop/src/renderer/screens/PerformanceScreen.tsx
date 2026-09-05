import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, ErrorBanner, useToast } from '../components'
import { useT, type I18n } from '../i18n'
import { localizeServerCopy } from '../lib/displayMap'
import { friendlyIpcError } from '../lib/errors'
import { fmt1 } from '../lib/format'
import type { UiLanguage } from '@shared/i18n'
import type {
  BenchmarkProgressStep,
  BenchmarkResult,
  EffectiveReadSample,
  ModelInfo,
  PerformanceSnapshot
} from '@shared/types'

// The Performance screen (design-guidelines §2 "8 primary + 1 utility"; benchmark.md
// "Performance screen"). Three cards:
//   1. "This computer": the hardware check's answer as a verdict line + four tiles (speed,
//      memory, graphics memory, drive) and the one action, "Check again". While a check runs, the steps show
//      as they land (EVENTS.benchmarkProgress) instead of an opaque "Running…" button.
//   2. "Observed while you worked": real figures from normal use (the last finished answer,
//      the last model start, the last full file check): session-only, never persisted.
//   3. "Other computers": one row per machine the drive has been checked on.
// The raw table + Copy stays on Settings › Diagnostics (the support surface); this screen
// answers the user's question ("what can this computer run, how fast") in plain words.

/** Below this a measured decode speed reads "Slow" (the picker's own #95 step-down gate). */
const SLOW_TOKENS_PER_SECOND = 5
/** The honest-read threshold the slow-read warning uses (benchmark.ts SLOW_EFFECTIVE_READ_MBPS). */
const SLOW_READ_MBPS = 100
/** Below this much graphics memory the runtime's GPU gate keeps models on the processor
 *  (runtime/gpu.ts GPU_BUMP_MIN_VRAM_MB, 6 GiB). */
const USABLE_VRAM_MB = 6144

/** MiB → GB (1 GiB units, one decimal), the figure the probe reports. */
function vramGb(mb: number, lang: UiLanguage): string {
  return fmt1(mb / 1024, lang)
}

type Tone = 'success' | 'warning' | 'neutral' | 'accent'

function fmtNum(n: number, lang: UiLanguage): string {
  return n.toLocaleString(lang)
}

function fmtDate(iso: string, lang: UiLanguage): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(lang)
}

function fmtDateTime(iso: string, lang: UiLanguage): string {
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

function profileTone(profile: BenchmarkResult['profile']): Tone {
  return profile === 'UNKNOWN' ? 'neutral' : 'accent'
}

/** Plain-text rendering of the "This computer" card for the Copy button (mirrors the
 *  Diagnostics report shape so support sees the same figures either way). */
function buildReport(
  bench: BenchmarkResult,
  models: ModelInfo[],
  contextTokens: number | null,
  t: I18n['t'],
  lang: UiLanguage
): string {
  const lines = [
    t('perf.card.title'),
    `${t('perf.tile.speed')}: ${
      bench.tokensPerSecond != null
        ? `${fmtNum(bench.tokensPerSecond, lang)} ${t('perf.tile.speed.unit')} (${t('perf.tile.speed.sub', {
            model: modelName(bench.measuredModelId, models, t),
            when: fmtDate(bench.ranAt, lang)
          })})`
        : t('perf.tile.speed.none')
    }`,
    `${t('perf.tile.memory')}: ${bench.ramGb > 0 ? `${fmt1(bench.ramGb, lang)} ${t('perf.tile.memory.unit')}` : t('diag.app.unknown')}`,
    `${t('diag.bench.cpu')}: ${(bench.cpuModel || t('perf.unknownCpu')) + (bench.cpuCores > 0 ? t('diag.bench.cores', { count: bench.cpuCores }) : '')}`,
    `${t('perf.tile.graphics')}: ${
      bench.gpuVramMb != null ? `${vramGb(bench.gpuVramMb, lang)} ${t('perf.tile.graphics.unit')} (${bench.gpu ?? ''})` : t('perf.rating.none')
    }`,
    `${t('perf.tile.drive')}: ${
      bench.effectiveRead ? `${fmtNum(bench.effectiveRead.mbps, lang)} ${t('perf.tile.drive.unit')}` : t('perf.tile.drive.none')
    }`,
    `${t('diag.bench.profile')}: ${bench.profile}`,
    `${t('diag.bench.recommended')}: ${bench.recommendedModelId ? modelName(bench.recommendedModelId, models, t) : t('diag.bench.noMatch')}`
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
  const [contextOverride, setContextOverride] = useState<number | null>(null)
  const [runtimeModelId, setRuntimeModelId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [doneSteps, setDoneSteps] = useState<BenchmarkProgressStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.getPerformance()
      if (mountedRef.current) {
        setSnap(next)
        setRunning((r) => r || next.running)
      }
    } catch (err) {
      if (mountedRef.current) setError(friendlyIpcError(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Display names for the model ids the results carry, the active context pick, and which
    // model is up (the "Start … and measure" offer). lazyVerify: no weight hashing for a
    // name lookup.
    window.api
      .listModels(true)
      .then((list) => mountedRef.current && setModels(list))
      .catch(() => {})
    window.api
      .getSettings()
      .then((s) => mountedRef.current && setContextOverride(s.contextTokensOverride ?? null))
      .catch(() => {})
    window.api
      .getRuntimeStatus()
      .then((r) => mountedRef.current && setRuntimeModelId(r.running ? r.modelId : null))
      .catch(() => {})
  }, [refresh])

  // The steps of a check THIS window started (main sends them to the requesting window only).
  useEffect(() => {
    const off = window.api.onBenchmarkProgress?.((step) => {
      if (!mountedRef.current) return
      if (step === 'done') return
      setDoneSteps((prev) => (prev.includes(step) ? prev : [...prev, step]))
    })
    return () => off?.()
  }, [])

  const runCheck = useCallback(async (): Promise<void> => {
    setRunning(true)
    setError(null)
    setDoneSteps([])
    try {
      await window.api.runBenchmark()
    } catch (err) {
      if (mountedRef.current) setError(friendlyIpcError(err))
    } finally {
      if (mountedRef.current) setRunning(false)
      await refresh()
    }
  }, [refresh])

  /** "Start <model> and measure": bring the recommended model up (the AI Model screen's
   *  "Use this model" action), then check, so the check's speed leg has a runtime. */
  const startAndMeasure = useCallback(
    async (modelId: string): Promise<void> => {
      setRunning(true)
      setError(null)
      setDoneSteps([])
      try {
        const status = await window.api.useModel(modelId)
        if (mountedRef.current) setRuntimeModelId(status.running ? status.modelId : null)
        await window.api.runBenchmark()
      } catch (err) {
        if (mountedRef.current) setError(friendlyIpcError(err))
      } finally {
        if (mountedRef.current) setRunning(false)
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
  const recommended = bench?.recommendedModelId
    ? models.find((m) => m.id === bench.recommendedModelId) ?? null
    : null
  const recommendedName = bench?.recommendedModelId ? modelName(bench.recommendedModelId, models, t) : null
  // The context the recommended model would launch with: the user's override, else the
  // model's own recommended window (the AI Model screen's "Automatic" resolution).
  const contextTokens = contextOverride ?? recommended?.recommendedContextTokens ?? null
  const speedModelName = bench ? modelName(bench.measuredModelId, models, t) : ''
  const speedApprox = bench != null && bench.tokensPerSecond != null && bench.speedBasis?.basis !== 'timings'
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
      return t('perf.verdict.speed', { model: speedModelName, tps: fmtNum(bench.tokensPerSecond, lang) }) + drive
    }
    if (recommendedName) {
      return t('perf.verdict.noSpeed', { model: recommendedName, ram: fmt1(bench.ramGb, lang) }) + drive
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
        value={fmtNum(bench.tokensPerSecond, lang)}
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

  function memoryTile(): JSX.Element {
    const cpu = bench
      ? (bench.cpuModel || t('perf.unknownCpu')) + (bench.cpuCores > 0 ? t('diag.bench.cores', { count: bench.cpuCores }) : '')
      : ''
    const fits =
      recommendedName && contextTokens != null
        ? t('perf.tile.memory.fits', { model: recommendedName, context: contextTokens.toLocaleString(lang) })
        : null
    return (
      <Tile
        label={t('perf.tile.memory')}
        value={bench && bench.ramGb > 0 ? fmt1(bench.ramGb, lang) : null}
        unit={t('perf.tile.memory.unit')}
        sub={bench ? [fits, cpu].filter(Boolean).join(' · ') : t('perf.notChecked')}
        pill={t(`perf.profile.${bench?.profile ?? 'UNKNOWN'}`)}
        tone={bench ? profileTone(bench.profile) : 'neutral'}
      />
    )
  }

  /** Graphics memory decides what runs accelerated, so it stands beside RAM as its own
   *  tile. The result's own figure wins; a result persisted before the field existed falls
   *  back to the live probe, but only for the computer the app is on right now. */
  function graphicsTile(): JSX.Element {
    const liveMb = snap?.currentMachine ? (snap.currentGpu?.totalMb ?? null) : null
    const mb = bench?.gpuVramMb ?? liveMb
    const name = bench?.gpu ?? (snap?.currentMachine ? (snap.currentGpu?.name ?? null) : null)
    if (mb == null || mb <= 0) {
      return (
        <Tile
          label={t('perf.tile.graphics')}
          value={null}
          sub={bench ? t('perf.tile.graphics.none') : t('perf.notChecked')}
          pill={bench ? t('perf.rating.none') : t('perf.rating.pending')}
          tone="neutral"
        />
      )
    }
    const usable = mb >= USABLE_VRAM_MB
    return (
      <Tile
        label={t('perf.tile.graphics')}
        value={vramGb(mb, lang)}
        unit={t('perf.tile.graphics.unit')}
        sub={usable ? (name ?? '') : [name, t('perf.tile.graphics.small', { min: Math.round(USABLE_VRAM_MB / 1024) })].filter(Boolean).join(' · ')}
        pill={usable ? t('perf.rating.usable') : t('perf.rating.small')}
        tone={usable ? 'success' : 'warning'}
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
            {running
              ? t('perf.running')
              : bench
                ? t('perf.checkedAt', { when: fmtDateTime(bench.ranAt, lang) })
                : t('perf.notChecked')}
          </span>
        </div>
        {snap && bench && !snap.currentMachine && <p className="hint hint-lede">{t('perf.otherMachine')}</p>}
        {running ? (
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
            <div className="perf-tiles">
              {speedTile()}
              {memoryTile()}
              {graphicsTile()}
              {driveTile()}
            </div>
            <div className="actions perf-actions">
              {canStartRecommended && recommended && bench?.tokensPerSecond == null ? (
                <Button variant="primary" onClick={() => void startAndMeasure(recommended.id)}>
                  {t('perf.startAndMeasure', { model: recommended.displayName })}
                </Button>
              ) : null}
              <Button onClick={() => void runCheck()}>{bench ? t('perf.checkAgain') : t('perf.check')}</Button>
              <Button variant="ghost" onClick={() => onNavigate('models')}>
                {t('perf.contextSize')}
              </Button>
              {bench && (
                <Button
                  variant="ghost"
                  title={t('diag.copyTitle')}
                  onClick={() => copyReport(buildReport(bench, models, contextTokens, t, lang))}
                >
                  {t('perf.copy')}
                </Button>
              )}
              <span className="hint">{t('perf.autoNote')}</span>
            </div>
          </>
        )}
        {/* Always mounted so the FIRST failure is announced (SH-2, #145). */}
        <ErrorBanner message={error ? t('perf.failed', { error }) : null} t={t} />
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
              return (
                <div className="perf-row" key={`${entry.cpuModel}|${entry.ramGb}|${entry.ranAt}`}>
                  <div className="perf-row-main">
                    {entry.tokensPerSecond != null
                      ? t('perf.others.row', { tps: fmtNum(entry.tokensPerSecond, lang), model: name })
                      : t('perf.others.rowNoSpeed', { model: name })}
                  </div>
                  <div className="perf-row-sub">
                    {entry.gpuVramMb != null && entry.gpuVramMb > 0
                      ? t('perf.others.subGpu', {
                          cpu: entry.cpuModel || t('perf.unknownCpu'),
                          ram: fmt1(entry.ramGb, lang),
                          vram: vramGb(entry.gpuVramMb, lang),
                          when: fmtDate(entry.ranAt, lang)
                        })
                      : t('perf.others.sub', {
                          cpu: entry.cpuModel || t('perf.unknownCpu'),
                          ram: fmt1(entry.ramGb, lang),
                          when: fmtDate(entry.ranAt, lang)
                        })}
                  </div>
                  <div className="perf-row-side">
                    {entry.tokensPerSecond != null && (
                      <Badge tone={speedTone(entry.tokensPerSecond)}>
                        {entry.tokensPerSecond < SLOW_TOKENS_PER_SECOND ? t('perf.rating.slow') : t('perf.rating.good')}
                      </Badge>
                    )}
                    {slowDrive && <Badge tone="warning">{t('perf.rating.slowDrive')}</Badge>}
                    <Badge tone={profileTone(entry.profile)}>{t(`perf.profile.${entry.profile}`)}</Badge>
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
