import { describe, it, expect } from 'vitest'
import {
  AudioParser,
  AUDIO_EXTENSIONS,
  AUDIO_NEEDS_TRANSCRIBER_MESSAGE,
  AUDIO_SEGMENT_MAX_WORDS,
  AUDIO_SEGMENT_TARGET_WORDS,
  AUDIO_TRANSCRIPTION_FAILED_MESSAGE,
  AUDIO_UNREADABLE_MESSAGE,
  audioRangeLabel,
  formatAudioTimestamp,
  packTranscriptSegments
} from '../../src/main/services/ingestion/parsers/audio'
import { isAudioPath, selectParser, supportedExtensions } from '../../src/main/services/ingestion/parsers'
import { chunkSegments } from '../../src/main/services/ingestion/chunker'
import { AUDIO_DECODE_ERROR_PREFIX } from '../../src/main/services/transcriber/cli'
import type { Transcriber, TranscriptSegment } from '../../src/main/services/transcriber'

// Phase 36 — the AudioParser with a FAKE transcriber behind the injection seam (the
// wave-3 testing posture: CI is zero-binary/zero-audio; the real path lives in the
// PAID_WHISPER_SMOKE manual harness).

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

  it('keeps every packed segment at or below MAX words (the one-chunk invariant)', () => {
    const input = Array.from({ length: 100 }, (_, i) => seg(i * 5, i * 5 + 5, 37))
    for (const p of packTranscriptSegments(input)) {
      expect(p.text.split(/\s+/).length).toBeLessThanOrEqual(AUDIO_SEGMENT_MAX_WORDS)
    }
  })

  it('splits an oversized single whisper segment instead of overflowing', () => {
    const big = seg(0, 600, AUDIO_SEGMENT_MAX_WORDS * 2 + 50)
    const packed = packTranscriptSegments([big])
    expect(packed.length).toBe(3)
    for (const p of packed) {
      expect(p.text.split(/\s+/).length).toBeLessThanOrEqual(AUDIO_SEGMENT_MAX_WORDS)
      expect(p.sectionLabel).toBe(audioRangeLabel(0, 600_000))
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

  it('target stays below the max (packing sanity)', () => {
    expect(AUDIO_SEGMENT_TARGET_WORDS).toBeLessThan(AUDIO_SEGMENT_MAX_WORDS)
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
