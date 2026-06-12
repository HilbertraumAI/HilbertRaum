// WAV encoding for voice dictation. The renderer records webm/opus via
// MediaRecorder, decodes + resamples to 16 kHz mono PCM through an OfflineAudioContext,
// and hands whisper a plain PCM16 WAV — encoded HERE, in pure JS, so dictation adds no
// dependency. Pure function (no DOM, no Node) ⇒ unit-testable in the node environment.

/** Bytes of the fixed RIFF/fmt/data header `encodeWavPcm16` writes. */
export const WAV_HEADER_BYTES = 44

/**
 * Encode mono float samples (range −1…1, clamped) as a 16-bit little-endian PCM WAV
 * file. Layout: "RIFF" + "WAVE" + a 16-byte "fmt " chunk (PCM, 1 channel) + "data".
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sample rate: ${sampleRate}`)
  }
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // RIFF chunk size = file bytes − 8
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size (PCM)
  view.setUint16(20, 1, true) // audio format 1 = integer PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate = rate × blockAlign
  view.setUint16(32, 2, true) // block align = channels × bytesPerSample
  view.setUint16(34, 16, true) // bits per sample

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    // Asymmetric int16 range: −1 → −32768, +1 → +32767.
    view.setInt16(WAV_HEADER_BYTES + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}
