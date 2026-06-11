// Voice-dictation capture (Phase 37, locked design D30): getUserMedia audio →
// MediaRecorder (webm/opus) → decode + resample to 16 kHz mono PCM via an
// OfflineAudioContext render → pure-JS WAV encode. The bytes go to the main process
// over `dictation:transcribe`; no audio ever leaves the renderer as a file path, and
// nothing here touches the network. Streaming ASR is explicitly out of scope (D30).

import { encodeWavPcm16 } from './wav'

/** Whisper's expected input rate; the OfflineAudioContext renders straight to it. */
export const DICTATION_SAMPLE_RATE = 16000

/** Friendly copy (§11.4) when the OS/hardware denies the microphone. Our own session
 *  handler grants audio-only requests, so a failure here is the system's denial. */
export const MIC_BLOCKED_MESSAGE =
  'The microphone could not be used. Check the system microphone settings, then try again.'

/** A live recording: stop to get WAV bytes, or cancel to discard and release the mic. */
export interface DictationCapture {
  /** Stop recording; resolves with the audio as 16 kHz mono PCM16 WAV bytes. */
  stop(): Promise<Uint8Array>
  /** Abandon the recording — releases the microphone, discards everything. */
  cancel(): void
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
  const release = (): void => stream.getTracks().forEach((track) => track.stop())

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
  recorder.start()

  return {
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
  return encodeWavPcm16(rendered.getChannelData(0), DICTATION_SAMPLE_RATE)
}
