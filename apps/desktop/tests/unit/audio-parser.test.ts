import { describe, it, expect } from 'vitest'
import {
  AudioParser,
  AUDIO_EXTENSIONS,
  AUDIO_NEEDS_TRANSCRIBER_MESSAGE,
  AUDIO_SEGMENT_MAX_TOKENS,
  AUDIO_SEGMENT_TARGET_TOKENS,
  AUDIO_TRANSCRIPTION_FAILED_MESSAGE,
  AUDIO_UNREADABLE_MESSAGE,
  audioRangeLabel,
  formatAudioTimestamp,
  packTranscriptSegments
} from '../../src/main/services/ingestion/parsers/audio'
import { isAudioPath, selectParser, supportedExtensions } from '../../src/main/services/ingestion/parsers'
import { chunkSegments, approxTokenCount, CHUNK_DEFAULTS } from '../../src/main/services/ingestion/chunker'
import { AUDIO_DECODE_ERROR_PREFIX } from '../../src/main/services/transcriber/cli'
import type { Transcriber, TranscriptSegment } from '../../src/main/services/transcriber'

// Phase 36 — the AudioParser with a FAKE transcriber behind the injection seam (the
// wave-3 testing posture: CI is zero-binary/zero-audio; the real path lives in the
// HILBERTRAUM_WHISPER_SMOKE manual harness).

function fakeTranscriber(segments: TranscriptSegment[]): Transcriber {
  return {
    id: 'fake-whisper',
    transcribe: async () => segments
  }
}

describe('formatAudioTimestamp / audioRangeLabel (D29)', () => {
  it('formats mm:ss under an hour and h:mm:ss above', () => {
    expect(formatAudioTimestamp(0)).toBe('00:00')
    expect(formatAudioTimestamp(65_000)).toBe('01:05')
    expect(formatAudioTimestamp(3_599_000)).toBe('59:59')
    expect(formatAudioTimestamp(3_600_000)).toBe('1:00:00')
    expect(formatAudioTimestamp(5_025_000)).toBe('1:23:45')
  })

  it('builds the en-dash time-range label that rides Citation.section', () => {
    expect(audioRangeLabel(65_000, 130_000)).toBe('01:05–02:10')
  })
})

describe('packTranscriptSegments', () => {
  const seg = (startS: number, endS: number, words: number): TranscriptSegment => ({
    startMs: startS * 1000,
    endMs: endS * 1000,
    text: Array.from({ length: words }, (_, i) => `w${startS}_${i}`).join(' ')
  })

  it('packs short whisper segments up to the target and labels the full range', () => {
    // 30 segments × 20 words; target 180 → packs of 9 segments each.
    const input = Array.from({ length: 30 }, (_, i) => seg(i * 10, i * 10 + 10, 20))
    const packed = packTranscriptSegments(input)
    expect(packed.length).toBeGreaterThan(1)
    expect(packed.length).toBeLessThan(input.length)
    // First packed range starts at the first segment's start.
    expect(packed[0].sectionLabel!.startsWith('00:00–')).toBe(true)
    // Every packed segment is page-less (the txt/md dedup rule applies).
    for (const p of packed) expect(p.pageNumber).toBeNull()
    // No text is lost or duplicated.
    const allWords = input.flatMap((s) => s.text.split(' '))
    const packedWords = packed.flatMap((p) => p.text.split(' '))
    expect(packedWords).toEqual(allWords)
  })

  it('keeps every packed segment at or below MAX approx-tokens (the one-chunk invariant)', () => {
    const input = Array.from({ length: 100 }, (_, i) => seg(i * 5, i * 5 + 5, 37))
    for (const p of packTranscriptSegments(input)) {
      expect(approxTokenCount(p.text)).toBeLessThanOrEqual(AUDIO_SEGMENT_MAX_TOKENS)
    }
  })

  it('splits an oversized single whisper segment instead of overflowing', () => {
    // ~2.1× the cap in short (1-token) words → 3 word-boundary pieces, each ≤ MAX tokens.
    const big = seg(0, 600, AUDIO_SEGMENT_MAX_TOKENS * 2 + 50)
    const packed = packTranscriptSegments([big])
    expect(packed.length).toBe(3)
    for (const p of packed) {
      expect(approxTokenCount(p.text)).toBeLessThanOrEqual(AUDIO_SEGMENT_MAX_TOKENS)
      expect(p.sectionLabel).toBe(audioRangeLabel(0, 600_000))
    }
  })

  // RAG-N1: the SAME oversize path on a space-less script. A whitespace split (the old code)
  // would leave a CJK/Thai run as ONE "word" far over the chunk window; it must char-split.
  it('char-splits an oversized space-less (Japanese / Thai) whisper segment to ≤ MAX tokens', () => {
    for (const run of ['情報'.repeat(600), 'ส'.repeat(1300)]) {
      const packed = packTranscriptSegments([{ startMs: 0, endMs: 60_000, text: run }])
      expect(packed.length).toBeGreaterThan(1)
      for (const p of packed) {
        expect(approxTokenCount(p.text)).toBeLessThanOrEqual(AUDIO_SEGMENT_MAX_TOKENS)
        // Pieces are a LOSSLESS partition (overlap 0) — no characters inserted or dropped.
        expect(p.sectionLabel).toBe(audioRangeLabel(0, 60_000))
      }
      expect(packed.map((p) => p.text).join('')).toBe(run)
    }
  })

  // The load-bearing RAG-N1 guarantee: every packed CJK/Thai segment fits in ONE chunk window,
  // so the chunker never windows audio (which is what keeps reconstruction lossless). A pure
  // space-less transcript packed by the OLD word cap (400 words) would be ~thousands of tokens.
  it('packs space-less (Japanese / Thai) transcripts to segments that each fit one chunk window', () => {
    for (const unit of ['この文は日本語のテストです', 'นี่คือประโยคภาษาไทยสำหรับการทดสอบ']) {
      // 60 short space-less whisper segments → far over the window in tokens, a few "words".
      const input = Array.from({ length: 60 }, (_, i) => ({
        startMs: i * 5000,
        endMs: i * 5000 + 5000,
        text: unit
      }))
      const packed = packTranscriptSegments(input)
      expect(packed.length).toBeGreaterThan(1)
      for (const p of packed) {
        expect(approxTokenCount(p.text)).toBeLessThanOrEqual(AUDIO_SEGMENT_MAX_TOKENS)
        expect(approxTokenCount(p.text)).toBeLessThan(CHUNK_DEFAULTS.chunkSizeTokens)
      }
      // …and the chunker maps each packed segment onto exactly ONE chunk, verbatim, no overlap.
      const chunks = chunkSegments(packed)
      expect(chunks.length).toBe(packed.length)
      chunks.forEach((c, i) => expect(c.text).toBe(packed[i].text))
    }
  })

  it('drops empty/whitespace segments', () => {
    expect(packTranscriptSegments([{ startMs: 0, endMs: 1000, text: '   ' }])).toEqual([])
  })

  // THE invariant the chunk-based re-extraction (preview/translate/compare) rests on:
  // every audio chunk is exactly one packed segment, verbatim — no windowing, no overlap.
  it('chunker maps packed segments 1:1 onto chunks with no overlap', () => {
    const input = Array.from({ length: 40 }, (_, i) => seg(i * 8, i * 8 + 8, 31))
    const packed = packTranscriptSegments(input)
    const chunks = chunkSegments(packed)
    expect(chunks.length).toBe(packed.length)
    chunks.forEach((c, i) => {
      expect(c.text).toBe(packed[i].text)
      expect(c.sectionLabel).toBe(packed[i].sectionLabel)
    })
  })

  // The subtle interaction: an oversize single whisper segment is split into pieces that SHARE one
  // time-range label, so `coalesceSegments` re-merges them (joined by '\n\n') and re-windows before
  // chunking. The guarantee that matters (RAG-N1) is that the round-trip never DUPLICATES or DROPS
  // content — it stays byte-identical up to whitespace. (A small trailing remainder that merges into
  // the prior 500-token window normalizes its '\n\n' boundary to a single space in a space-less
  // script — n=800 is an exact 2×400 split with no remainder, n=900/1250 leave a merging remainder.)
  it('round-trips an oversize single CJK whisper segment with no duplicated or dropped content', () => {
    for (const n of [800, 900, 1250]) {
      const big = Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + i)).join('') // n DISTINCT CJK chars
      const packed = packTranscriptSegments([{ startMs: 0, endMs: 120_000, text: big }])
      expect(packed.length).toBeGreaterThan(1)
      for (const p of packed) expect(approxTokenCount(p.text)).toBeLessThanOrEqual(AUDIO_SEGMENT_MAX_TOKENS)
      const recon = chunkSegments(packed)
        .map((c) => c.text)
        .join('')
      const reconNoWs = recon.replace(/\s/g, '')
      // No loss + no duplication: stripped of whitespace the round-trip is byte-identical to the source…
      expect(reconNoWs).toBe(big)
      // …and no span is repeated (distinct chars ⇒ any duplicated overlap would repeat a char).
      expect(new Set(reconNoWs).size).toBe(reconNoWs.length)
    }
  })

  it('target stays below the max, and the max stays a margin below the chunk window', () => {
    expect(AUDIO_SEGMENT_TARGET_TOKENS).toBeLessThan(AUDIO_SEGMENT_MAX_TOKENS)
    // The interaction guarantee: a packed segment (≤ MAX) is strictly under the chunk window,
    // so the chunker emits one window per segment (no split, no overlap) — lossless round-trip.
    expect(AUDIO_SEGMENT_MAX_TOKENS).toBeLessThan(CHUNK_DEFAULTS.chunkSizeTokens)
  })
})

describe('AudioParser', () => {
  it('registers exactly the R-W2-verified extensions in the parser registry', () => {
    expect([...AUDIO_EXTENSIONS]).toEqual(['.wav', '.mp3', '.flac', '.ogg'])
    for (const ext of AUDIO_EXTENSIONS) {
      expect(supportedExtensions()).toContain(ext)
      expect(selectParser(`meeting${ext}`)).toBe(AudioParser)
      expect(isAudioPath(`x/y/meeting${ext}`)).toBe(true)
    }
    // m4a is DESCOPED (whisper-cli cannot decode it without ffmpeg) — never registered.
    expect(supportedExtensions()).not.toContain('.m4a')
    expect(selectParser('memo.m4a')).toBeNull()
    expect(isAudioPath('doc.pdf')).toBe(false)
  })

  it('maps transcriber segments onto time-labeled ExtractedSegments', async () => {
    const parsed = await AudioParser.parse('meeting.mp3', {
      transcriber: fakeTranscriber([
        { startMs: 0, endMs: 4000, text: 'Die Quartalszahlen zeigen ein Wachstum.' },
        { startMs: 4000, endMs: 9000, text: 'Der Vorstand beschließt das Budget.' }
      ])
    })
    expect(parsed.segments).toHaveLength(1) // packed (short)
    expect(parsed.segments[0].text).toBe(
      'Die Quartalszahlen zeigen ein Wachstum. Der Vorstand beschließt das Budget.'
    )
    expect(parsed.segments[0].sectionLabel).toBe('00:00–00:09')
    expect(parsed.segments[0].pageNumber).toBeNull()
  })

  it('fails with the friendly download-the-model copy when no transcriber is injected', async () => {
    await expect(AudioParser.parse('meeting.mp3', {})).rejects.toThrow(
      AUDIO_NEEDS_TRANSCRIBER_MESSAGE
    )
    await expect(AudioParser.parse('meeting.mp3')).rejects.toThrow(AUDIO_NEEDS_TRANSCRIBER_MESSAGE)
  })

  it('maps a decode failure to the convert-to-WAV/MP3 copy (R-W2 silent-failure mode)', async () => {
    const failing: Transcriber = {
      id: 'fake',
      transcribe: async () => {
        throw new Error(`${AUDIO_DECODE_ERROR_PREFIX} meeting.mp3`)
      }
    }
    await expect(AudioParser.parse('meeting.mp3', { transcriber: failing })).rejects.toThrow(
      AUDIO_UNREADABLE_MESSAGE
    )
  })

  it('maps any other transcriber failure to friendly §11.4 copy (never the raw error)', async () => {
    const failing: Transcriber = {
      id: 'fake',
      transcribe: async () => {
        throw new Error('whisper-cli exited with code 3221225501: 0xc000001d STATUS_ILLEGAL_INSTRUCTION')
      }
    }
    const err = await AudioParser.parse('meeting.mp3', { transcriber: failing }).catch((e) => e)
    expect((err as Error).message).toBe(AUDIO_TRANSCRIPTION_FAILED_MESSAGE)
    expect((err as Error).message).not.toContain('0xc000001d')
  })

  it('forwards progress + workDir to the transcriber', async () => {
    let sawWorkDir: string | undefined
    const t: Transcriber = {
      id: 'fake',
      transcribe: async (_file, opts) => {
        sawWorkDir = opts?.workDir
        opts?.onProgress?.(40)
        return [{ startMs: 0, endMs: 1000, text: 'hi' }]
      }
    }
    const seen: number[] = []
    await AudioParser.parse('a.wav', {
      transcriber: t,
      workDir: 'C:/store',
      onProgress: (p) => seen.push(p)
    })
    expect(sawWorkDir).toBe('C:/store')
    expect(seen).toEqual([40])
  })
})
