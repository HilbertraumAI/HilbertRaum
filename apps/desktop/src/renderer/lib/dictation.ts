// Voice-dictation capture: getUserMedia audio →
// MediaRecorder (webm/opus) → decode + resample to 16 kHz mono PCM via an
// OfflineAudioContext render → the #497 level gate (a clip with no usable signal is refused
// HERE, before any byte leaves the page) → pure-JS WAV encode (whisper requires 16 kHz mono
// WAV). The bytes go to the main process over `dictation:transcribe`; no audio ever leaves
// the renderer as a file path, and nothing here touches the network. Streaming ASR is
// explicitly out of scope.

import { encodeWavPcm16 } from './wav'
import { judgeDictationLevel, measureDictationLevel } from '../../shared/dictation-level'

/** Whisper's expected input rate; the OfflineAudioContext renders straight to it. */
export const DICTATION_SAMPLE_RATE = 16000

/** Friendly copy (spec §11.4) when the OS/hardware denies the microphone. Our own session
 *  handler grants audio-only requests, so a failure here is the system's denial. */
export const MIC_BLOCKED_MESSAGE =
  'The microphone could not be used. Check the system microphone settings, then try again.'

/** Friendly copy (canonical English, localized at display like `MIC_BLOCKED_MESSAGE`) when the
 *  recording carried no usable signal (#497): a muted or wrong input device, or the OS handing a
 *  desktop app silence instead of the microphone it is not allowed to use. Whisper would turn
 *  that silence into a stray word ("you" on the pinned build), so it never gets to see it. */
export const DICTATION_SILENT_MESSAGE =
  'No sound reached the microphone. Check that it is not muted and that HilbertRaum may use it in the system settings, then try again.'

/** Friendly copy when the recording is too short to hold speech (a double-click on the mic, or a
 *  near-zero decode). Displayed as the no-speech notice — the microphone is not the problem. */
export const DICTATION_TOO_SHORT_MESSAGE = 'The recording was too short to contain speech — try again.'

/**
 * The #497 gate: throw the friendly copy when the rendered PCM carries no usable signal, so a
 * silent recording never reaches whisper. Runs on the 16 kHz render, before any byte crosses the
 * IPC; `registerDictationIpc` re-checks the WAV as the backstop (one rule for both —
 * `shared/dictation-level.ts`). Exported for the node-side unit test.
 */
export function assertUsableDictation(samples: Float32Array, sampleRate: number): void {
  const verdict = judgeDictationLevel(measureDictationLevel(samples, sampleRate))
  if (verdict === 'silent') throw new Error(DICTATION_SILENT_MESSAGE)
  if (verdict === 'too-short') throw new Error(DICTATION_TOO_SHORT_MESSAGE)
}

/** A live recording: stop to get WAV bytes, or cancel to discard and release the mic. */
export interface DictationCapture {
  /** Stop recording; resolves with the audio as 16 kHz mono PCM16 WAV bytes. */
  stop(): Promise<Uint8Array>
  /** Abandon the recording — releases the microphone, discards everything. */
  cancel(): void
  /** A read-only tap on the live mic for the in-input waveform. `null` when Web Audio
   *  is unavailable (older webview / a test fake) — the UI then simply draws no wave. */
  analyser: AnalyserNode | null
}

/** Starts the recording (the seam `DictationButton` injects in renderer tests). */
export type DictationCaptureStart = () => Promise<DictationCapture>

export const captureDictation: DictationCaptureStart = async () => {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    throw new Error(MIC_BLOCKED_MESSAGE)
  }
  // A read-only Web Audio tap on the SAME stream, feeding the in-input waveform. It is
  // never connected to a destination (nothing is played back) and never touches the
  // recorded bytes, so the WAV pipeline below is byte-identical with or without it.
  // Web Audio failing must not break recording — degrade to no waveform.
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  try {
    audioCtx = new AudioContext()
    void audioCtx.resume() // the mic click is the user gesture; resume if suspended
    const source = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.8
    source.connect(analyser) // NOT to destination — read tap only
  } catch {
    audioCtx = null
    analyser = null
  }
  const release = (): void => {
    stream.getTracks().forEach((track) => track.stop())
    void audioCtx?.close().catch(() => {})
  }

  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream)
  } catch {
    release()
    throw new Error(MIC_BLOCKED_MESSAGE)
  }
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  // A start() that throws (a source that went away between construction and start) must not
  // leak the live stream — the OS indicator would stay lit until GC (#497 review).
  try {
    recorder.start()
  } catch {
    release()
    throw new Error(MIC_BLOCKED_MESSAGE)
  }

  return {
    analyser,
    async stop() {
      try {
        recorder.stop()
        await stopped
      } finally {
        release()
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      return wavBytesFromRecording(blob)
    },
    cancel() {
      try {
        recorder.stop()
      } catch {
        /* never started / already stopped */
      }
      release()
    }
  }
}

/** Decode the compressed recording and render it to 16 kHz mono, then WAV-encode. */
async function wavBytesFromRecording(blob: Blob): Promise<Uint8Array> {
  const encoded = await blob.arrayBuffer()
  // decodeAudioData needs a BaseAudioContext; a 1-frame offline context serves (and
  // unlike AudioContext it neither claims an output device nor needs a user gesture).
  const decodeCtx = new OfflineAudioContext(1, 1, DICTATION_SAMPLE_RATE)
  const decoded = await decodeCtx.decodeAudioData(encoded)
  const frames = Math.max(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE))
  // Rendering through a 1-channel context resamples AND downmixes in one pass.
  const renderCtx = new OfflineAudioContext(1, frames, DICTATION_SAMPLE_RATE)
  const source = renderCtx.createBufferSource()
  source.buffer = decoded
  source.connect(renderCtx.destination)
  source.start()
  const rendered = await renderCtx.startRendering()
  const pcm = rendered.getChannelData(0)
  // #497: refuse a clip with no usable signal BEFORE it is encoded or sent — whisper hallucinates
  // a word on silence rather than returning nothing, and the user needs the microphone hint.
  assertUsableDictation(pcm, DICTATION_SAMPLE_RATE)
  return encodeWavPcm16(pcm, DICTATION_SAMPLE_RATE)
}
