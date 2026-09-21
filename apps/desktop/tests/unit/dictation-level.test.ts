import { describe, it, expect } from 'vitest'
import {
  DICTATION_MIN_DURATION_MS,
  DICTATION_SILENCE_PEAK_DBFS,
  DICTATION_SILENCE_RMS_DBFS,
  describeDictationLevel,
  judgeDictationLevel,
  measureDictationLevel,
  measureWavPcm16Level
} from '../../src/shared/dictation-level'
import { encodeWavPcm16 } from '../../src/renderer/lib/wav'
import {
  assertUsableDictation,
  DICTATION_SILENT_MESSAGE,
  DICTATION_TOO_SHORT_MESSAGE
} from '../../src/renderer/lib/dictation'

// #497 — the silence gate's pure rule, shared by the renderer (primary) and the main handler
// (backstop). The synthetic clips mirror the 2026-09-21 measurement against the pinned
// whisper-cli: digital silence and −60 dBFS noise (both hallucinated a word) must be refused;
// speech-level audio — and the same speech attenuated by 40 dB, which whisper still transcribes —
// must pass.

const RATE = 16000

function sine(seconds: number, amplitude: number, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)
  return out
}

/** Seeded uniform white noise in ±amplitude (deterministic across runs). */
function noise(seconds: number, amplitude: number): Float32Array {
  let seed = 12345
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = amplitude * ((seed / 0x7fffffff) * 2 - 1)
  }
  return out
}

describe('measureDictationLevel', () => {
  it('reads digital silence as -Infinity peak and RMS with the right duration', () => {
    const level = measureDictationLevel(new Float32Array(RATE * 3), RATE)
    expect(level.durationMs).toBe(3000)
    expect(level.peakDbfs).toBe(-Infinity)
    expect(level.rmsDbfs).toBe(-Infinity)
  })

  it('measures a −20 dBFS sine at −20 dBFS peak and ≈ −23 dBFS RMS', () => {
    const level = measureDictationLevel(sine(2, 0.1), RATE)
    expect(level.durationMs).toBe(2000)
    expect(level.peakDbfs).toBeCloseTo(-20, 1)
    expect(level.rmsDbfs).toBeCloseTo(-23.0, 0) // sine RMS = peak − 3.01 dB
  })

  it('measures the −60 dBFS-peak noise clip like the calibration run (≈ −60 peak, ≈ −64.8 RMS)', () => {
    const level = measureDictationLevel(noise(3, 0.001), RATE)
    expect(level.peakDbfs).toBeGreaterThan(-60.5)
    expect(level.peakDbfs).toBeLessThan(-59.5)
    expect(level.rmsDbfs).toBeCloseTo(-64.8, 0) // uniform noise RMS = peak − 4.77 dB
  })
})

describe('judgeDictationLevel — the #497 floors', () => {
  it('pins the calibrated constants', () => {
    expect(DICTATION_SILENCE_PEAK_DBFS).toBe(-50)
    expect(DICTATION_SILENCE_RMS_DBFS).toBe(-70)
    expect(DICTATION_MIN_DURATION_MS).toBe(300)
  })

  it('refuses digital silence (the reported "you" case)', () => {
    expect(judgeDictationLevel(measureDictationLevel(new Float32Array(RATE * 3), RATE))).toBe('silent')
  })

  it('refuses the −60 dBFS noise clip (hallucinated random-script text on the pinned build)', () => {
    expect(judgeDictationLevel(measureDictationLevel(noise(3, 0.001), RATE))).toBe('silent')
  })

  it('passes speech-level audio, and the same audio attenuated by 40 dB (whisper still transcribes it)', () => {
    expect(judgeDictationLevel(measureDictationLevel(sine(2, 0.7), RATE))).toBe('ok') // ≈ −3 dBFS peak
    expect(judgeDictationLevel(measureDictationLevel(sine(2, 0.007), RATE))).toBe('ok') // ≈ −43 dBFS peak
  })

  it('reports a clip under the minimum duration as too short — BEFORE the level arms', () => {
    // 100 ms of digital silence: the one-frame-WAV shape must read "too short", never "silent".
    expect(judgeDictationLevel(measureDictationLevel(new Float32Array(RATE / 10), RATE))).toBe('too-short')
    expect(judgeDictationLevel(measureDictationLevel(sine(0.1, 0.5), RATE))).toBe('too-short')
  })
})

describe('measureWavPcm16Level — the main-process backstop reads the renderer WAV', () => {
  it('round-trips the renderer encoder within 0.1 dB', () => {
    const samples = sine(2, 0.1)
    const fromFloat = measureDictationLevel(samples, RATE)
    const fromWav = measureWavPcm16Level(encodeWavPcm16(samples, RATE))
    expect(fromWav).not.toBeNull()
    expect(fromWav?.durationMs).toBe(2000)
    expect(fromWav?.peakDbfs).toBeCloseTo(fromFloat.peakDbfs, 1)
    expect(fromWav?.rmsDbfs).toBeCloseTo(fromFloat.rmsDbfs, 1)
  })

  it('reads an UNALIGNED Buffer slice (what Electron IPC delivers) identically', () => {
    const wav = encodeWavPcm16(sine(1, 0.1), RATE)
    const shifted = Buffer.concat([Buffer.alloc(1), Buffer.from(wav)]).subarray(1)
    expect(shifted.byteOffset % 2).toBe(1)
    expect(measureWavPcm16Level(shifted)).toEqual(measureWavPcm16Level(wav))
  })

  it('returns null for bytes that are not our PCM16 mono WAV', () => {
    expect(measureWavPcm16Level(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(measureWavPcm16Level(new Uint8Array(64))).toBeNull() // zeros: no RIFF tag
    const stereo = encodeWavPcm16(sine(1, 0.1), RATE).slice()
    stereo[22] = 2 // channels = 2 — not the shape the renderer produces
    expect(measureWavPcm16Level(stereo)).toBeNull()
  })

  it('a digitally silent WAV reads as silent and a one-frame WAV as too short', () => {
    expect(judgeDictationLevel(measureWavPcm16Level(encodeWavPcm16(new Float32Array(RATE * 2), RATE))!)).toBe('silent')
    expect(judgeDictationLevel(measureWavPcm16Level(encodeWavPcm16(new Float32Array(1), RATE))!)).toBe('too-short')
  })
})

describe('describeDictationLevel — numbers only for the local log', () => {
  it('renders -Infinity as the word "silence" (JSON cannot carry it) and rounds to a tenth', () => {
    expect(describeDictationLevel(measureDictationLevel(new Float32Array(RATE), RATE))).toEqual({
      durationMs: 1000,
      peakDbfs: 'silence',
      rmsDbfs: 'silence'
    })
    const d = describeDictationLevel(measureDictationLevel(sine(1.5, 0.1), RATE))
    expect(d.durationMs).toBe(1500)
    expect(d.peakDbfs).toBe(-20)
    expect(typeof d.rmsDbfs).toBe('number')
  })
})

describe('assertUsableDictation — the renderer gate throws canonical English, localized at display', () => {
  it('throws the silent copy on digital silence and on −60 dBFS noise', () => {
    expect(() => assertUsableDictation(new Float32Array(RATE * 3), RATE)).toThrow(DICTATION_SILENT_MESSAGE)
    expect(() => assertUsableDictation(noise(3, 0.001), RATE)).toThrow(DICTATION_SILENT_MESSAGE)
  })

  it('throws the too-short copy on a sub-300 ms clip', () => {
    expect(() => assertUsableDictation(sine(0.1, 0.5), RATE)).toThrow(DICTATION_TOO_SHORT_MESSAGE)
  })

  it('returns silently on speech-level audio', () => {
    expect(() => assertUsableDictation(sine(2, 0.1), RATE)).not.toThrow()
  })
})
