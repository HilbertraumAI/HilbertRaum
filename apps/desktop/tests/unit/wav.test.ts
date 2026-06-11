import { describe, it, expect } from 'vitest'
import { encodeWavPcm16, WAV_HEADER_BYTES } from '../../src/renderer/lib/wav'

// Phase 37 (D30): the dictation WAV encoder is a pure function — round-trip it here.
// The header is parsed by hand (no audio libs in CI) and the samples are decoded back
// from the PCM16 payload; whatever whisper-cli accepts as "wav" rests on this layout.

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe('encodeWavPcm16', () => {
  it('writes a canonical RIFF/fmt/data header for 16 kHz mono PCM16', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1])
    const wav = encodeWavPcm16(samples, 16000)
    const v = view(wav)

    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(wav.byteLength - 8)
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(v.getUint32(16, true)).toBe(16) // PCM fmt chunk size
    expect(v.getUint16(20, true)).toBe(1) // integer PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000) // byte rate
    expect(v.getUint16(32, true)).toBe(2) // block align
    expect(v.getUint16(34, true)).toBe(16) // bits per sample
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('round-trips samples within int16 quantization error', () => {
    const n = 1600
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.8
    const wav = encodeWavPcm16(samples, 16000)
    const v = view(wav)

    for (let i = 0; i < n; i++) {
      const int = v.getInt16(WAV_HEADER_BYTES + i * 2, true)
      const decoded = int < 0 ? int / 0x8000 : int / 0x7fff
      expect(Math.abs(decoded - samples[i])).toBeLessThan(1 / 0x7fff + 1e-7)
    }
  })

  it('clamps out-of-range samples to the int16 extremes instead of wrapping', () => {
    const wav = encodeWavPcm16(new Float32Array([2.5, -2.5, 1, -1]), 16000)
    const v = view(wav)
    expect(v.getInt16(WAV_HEADER_BYTES, true)).toBe(0x7fff)
    expect(v.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-0x8000)
    expect(v.getInt16(WAV_HEADER_BYTES + 4, true)).toBe(0x7fff)
    expect(v.getInt16(WAV_HEADER_BYTES + 6, true)).toBe(-0x8000)
  })

  it('encodes an empty recording as a valid 44-byte file', () => {
    const wav = encodeWavPcm16(new Float32Array(0), 16000)
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES)
    expect(view(wav).getUint32(40, true)).toBe(0)
  })

  it('rejects a nonsensical sample rate', () => {
    expect(() => encodeWavPcm16(new Float32Array(1), 0)).toThrow(/sample rate/i)
    expect(() => encodeWavPcm16(new Float32Array(1), 15999.5)).toThrow(/sample rate/i)
  })
})
