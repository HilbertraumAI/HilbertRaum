// Signal-level rules for voice dictation (#497): refuse a recording that carries no usable
// signal BEFORE it reaches whisper. Shared by the renderer (the primary gate, run on the
// rendered 16 kHz PCM before any byte crosses the IPC — `renderer/lib/dictation.ts`) and the
// main handler (the backstop on the PCM16 WAV bytes it receives — `registerDictationIpc.ts`),
// the `image-headers.ts` pattern: one rule, two enforcement points that can never disagree.
// Pure (no DOM, no Node) ⇒ unit-testable in either environment.
//
// Why a gate and not a whisper flag: the pinned whisper-cli (v1.8.6, ggml-small) turns digital
// silence under `-l auto` into the single word "you" (the #497 report), `-l de` into "[Musik]",
// and low white noise into random-script garbage or broadcaster credits — measured 2026-09-21
// against the real binary + weights. Of whisper's own decoder thresholds only a raised
// `--logprob-thold` silences PURE silence, and none touches the noise cases. A level gate is
// deterministic and catches the reported class with certainty; the −50…−30 dBFS noise band
// that passes it is the Silero-VAD follow-up's job (a new pinned asset, not a flag).
//
// Calibration (same run): the OS voice's German test sentence measures −3.1 dBFS peak /
// −22.3 dBFS RMS; attenuated by 40 dB it is still −43.1 / −62.3 and whisper still transcribes
// it verbatim. The floors below therefore leave a 47 dB margin to ordinary speech and a 7 dB
// margin to a 40 dB-attenuated one, while the −60 dBFS noise clip (−59.9 dBFS peak) and digital
// silence (peak −∞) are refused. A lone click in otherwise silent audio still passes (peak
// arm) — accepted; that is the VAD follow-up's territory too.

/** Peak floor: below this the recording is treated as carrying no signal. */
export const DICTATION_SILENCE_PEAK_DBFS = -50
/** RMS floor, far under any speech — a belt for near-silence with sparse pops. */
export const DICTATION_SILENCE_RMS_DBFS = -70
/**
 * Shortest recording worth transcribing. A near-zero decode in the renderer floors its render
 * at ONE frame, producing a 46-byte WAV that would pass a "not empty" check, spawn whisper and
 * come back as "you" — this arm refuses it (and a double-click on the mic) with the no-speech
 * copy rather than the "check your microphone" one.
 */
export const DICTATION_MIN_DURATION_MS = 300

export interface DictationLevel {
  durationMs: number
  /** Peak |sample| in dBFS (0 = full scale); `-Infinity` for digital silence. */
  peakDbfs: number
  /** RMS in dBFS; `-Infinity` for digital silence. */
  rmsDbfs: number
}

export type DictationLevelVerdict = 'ok' | 'too-short' | 'silent'

const toDbfs = (linear: number): number => (linear > 0 ? 20 * Math.log10(linear) : -Infinity)

function finish(peak: number, sumSquares: number, count: number, sampleRate: number): DictationLevel {
  return {
    durationMs: sampleRate > 0 ? (count / sampleRate) * 1000 : 0,
    peakDbfs: toDbfs(peak),
    rmsDbfs: toDbfs(count > 0 ? Math.sqrt(sumSquares / count) : 0)
  }
}

/** Measure float samples in −1…1 (the renderer's rendered PCM). */
export function measureDictationLevel(samples: ArrayLike<number>, sampleRate: number): DictationLevel {
  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const a = s < 0 ? -s : s
    if (a > peak) peak = a
    sumSquares += s * s
  }
  return finish(peak, sumSquares, samples.length, sampleRate)
}

/**
 * Measure the PCM16 mono WAV the renderer encodes (`renderer/lib/wav.ts`): RIFF/WAVE, a PCM
 * `fmt ` chunk (format 1, one channel, 16 bits) and a `data` chunk. Returns `null` for anything
 * else — not our shape means no verdict here; the transcriber's own decode failure covers it.
 * Reads through a DataView so an unaligned Buffer slice (what Electron IPC delivers) is fine.
 */
export function measureWavPcm16Level(bytes: Uint8Array): DictationLevel | null {
  if (bytes.byteLength < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number): string =>
    String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let offset = 12
  let sampleRate = 0
  let fmtSeen = false
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.byteLength) return null
      const format = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      const bitsPerSample = view.getUint16(body + 14, true)
      if (format !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate <= 0) return null
      fmtSeen = true
    } else if (id === 'data') {
      if (!fmtSeen) return null
      const available = Math.min(size, bytes.byteLength - body)
      const count = Math.floor(available / 2)
      let peak = 0
      let sumSquares = 0
      for (let i = 0; i < count; i++) {
        const s = view.getInt16(body + i * 2, true) / 32768
        const a = s < 0 ? -s : s
        if (a > peak) peak = a
        sumSquares += s * s
      }
      return finish(peak, sumSquares, count, sampleRate)
    }
    offset = body + size + (size & 1) // chunks are word-aligned
  }
  return null
}

/** The verdict both enforcement points apply — duration first, so a one-frame WAV is "too short", not "silent". */
export function judgeDictationLevel(level: DictationLevel): DictationLevelVerdict {
  if (level.durationMs < DICTATION_MIN_DURATION_MS) return 'too-short'
  if (level.peakDbfs < DICTATION_SILENCE_PEAK_DBFS || level.rmsDbfs < DICTATION_SILENCE_RMS_DBFS) {
    return 'silent'
  }
  return 'ok'
}

/**
 * Numbers only, for the local log on a refusal (never content — a dictation is never logged;
 * these are the figures the next "it inserted a stray word" report needs). `-Infinity` is not
 * JSON, so digital silence reads as the word "silence".
 */
export function describeDictationLevel(level: DictationLevel): {
  durationMs: number
  peakDbfs: number | 'silence'
  rmsDbfs: number | 'silence'
} {
  const tenth = (x: number): number | 'silence' => (Number.isFinite(x) ? Math.round(x * 10) / 10 : 'silence')
  return {
    durationMs: Math.round(level.durationMs),
    peakDbfs: tenth(level.peakDbfs),
    rmsDbfs: tenth(level.rmsDbfs)
  }
}
