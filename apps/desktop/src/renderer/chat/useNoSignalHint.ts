import { useEffect, useState } from 'react'
import { DICTATION_SILENCE_PEAK_DBFS } from '../../shared/dictation-level'

// Live "no signal" hint while recording (#497 follow-up, owner request 2026-09-21). The
// waveform's Web Audio tap — the SAME mic stream the recorder reads; never played back, never
// recorded — is sampled a few times a second, and once its peak has stayed under the dictation
// gate's silence floor for `afterMs` the composer says so, BEFORE the user stops and only then
// learns that nothing was captured. Clears the moment signal returns, or when recording ends.
// A null analyser (Web Audio unavailable / a test fake) never shows the hint — the post-stop
// gate (`assertUsableDictation`) still covers that case.

export interface NoSignalTiming {
  /** How long the tap must stay under the floor before the hint shows. */
  afterMs: number
  /** Sampling interval. */
  pollMs: number
}

/** Two seconds: longer than a breath between sentences, shorter than a wasted dictation. */
export const DEFAULT_NO_SIGNAL_TIMING: NoSignalTiming = { afterMs: 2000, pollMs: 250 }

/** The gate's peak floor (−50 dBFS) as a linear amplitude, so the hint and the refusal agree. */
const FLOOR = Math.pow(10, DICTATION_SILENCE_PEAK_DBFS / 20)

export function useNoSignalHint(
  analyser: AnalyserNode | null,
  recording: boolean,
  timing: NoSignalTiming = DEFAULT_NO_SIGNAL_TIMING
): boolean {
  const [noSignal, setNoSignal] = useState(false)
  useEffect(() => {
    if (!recording || !analyser) {
      setNoSignal(false)
      return
    }
    const frame = new Float32Array(analyser.fftSize)
    let quietSince: number | null = null
    const tick = (): void => {
      analyser.getFloatTimeDomainData(frame)
      let peak = 0
      for (let i = 0; i < frame.length; i++) {
        const a = frame[i] < 0 ? -frame[i] : frame[i]
        if (a > peak) peak = a
      }
      const now = Date.now()
      if (peak >= FLOOR) {
        quietSince = null
        setNoSignal(false)
        return
      }
      if (quietSince === null) quietSince = now
      if (now - quietSince >= timing.afterMs) setNoSignal(true)
    }
    const timer = setInterval(tick, timing.pollMs)
    return () => {
      clearInterval(timer)
      setNoSignal(false)
    }
  }, [analyser, recording, timing.afterMs, timing.pollMs])
  return noSignal
}
