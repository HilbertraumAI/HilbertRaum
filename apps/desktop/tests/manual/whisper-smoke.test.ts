import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWhisperCliTranscriber,
  resolveWhisperCliPath
} from '../../src/main/services/transcriber'
import { AUDIO_DECODE_ERROR_PREFIX } from '../../src/main/services/transcriber/cli'
import { packTranscriptSegments } from '../../src/main/services/ingestion/parsers/audio'

// MANUAL whisper smoke (Phase 36, wave-3 plan §14 R-W2..R-W4 live verification) — NOT CI.
//
// CI stays zero-network/zero-model/zero-binary/zero-audio, so this file is skipped
// unless HILBERTRAUM_WHISPER_SMOKE points at a provisioned drive root (the gpu/rerank/
// translategemma-smoke shape):
//
//   HILBERTRAUM_WHISPER_SMOKE=<root with runtime/whisper.cpp/<os>/whisper-cli + models/transcriber/ggml-*.bin>
//   HILBERTRAUM_WHISPER_AUDIO=<dir with local German audio fixtures — NEVER committed; the repo ships no audio>
//     expected files (source locally, e.g. TTS + LibriVox):
//       german.wav german.mp3 german.flac german.ogg   (short German speech, any length)
//       german_long.mp3                                 (optional: ~60 min for the R-W4 leg)
//       sample.m4a                                      (optional: the expected-DECODE-FAIL leg)
//   npx vitest run tests/manual/whisper-smoke.test.ts
//
// Against the REAL pinned v1.8.6 binary + real GGML weights this proves what the
// fake-spawn unit tests cannot:
//   R-W2: the binary actually DECODES wav/mp3/flac/ogg (and m4a actually fails →
//         the exit-0 silent-failure mode maps to the decode error),
//   R-W3/R-W4: real transcription quality/time on real German audio, progressive
//         `-pp` progress, and the packed segments' time labels.
// Findings 2026-06-11 (dev box, 4 threads): formats wav/mp3/flac/ogg decode; m4a fails
// with exit 0 + stderr only; small RTF ≈ 0.46 vs base ≈ 0.21; 52-min mp3 → see plan §14.

const ROOT = process.env.HILBERTRAUM_WHISPER_SMOKE?.trim() ?? ''
const AUDIO_DIR = process.env.HILBERTRAUM_WHISPER_AUDIO?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT) && AUDIO_DIR.length > 0 && existsSync(AUDIO_DIR)

function transcriberModel(root: string): string | null {
  const dir = join(root, 'models', 'transcriber')
  if (!existsSync(dir)) return null
  const bin = readdirSync(dir).find((f) => f.endsWith('.bin'))
  return bin ? join(dir, bin) : null
}

describe.skipIf(!enabled)('Whisper smoke (manual, real v1.8.6 + real German audio)', () => {
  const binPath = enabled ? resolveWhisperCliPath(ROOT) : null
  const modelPath = enabled ? transcriberModel(ROOT) : null

  // REL-6: workDir is required (the transient transcript must stay in a swept dir). A throwaway
  // temp dir is fine here — the transcript is shredded after each call regardless. Created in
  // beforeAll (not at module load) and removed in afterAll so a SKIPPED run — i.e. every CI run
  // and any local run without the env gate — leaves no temp dir behind (TEST-N9).
  let WORK = ''
  beforeAll(() => {
    WORK = mkdtempSync(join(tmpdir(), 'whisper-smoke-'))
  })
  afterAll(() => {
    if (WORK) rmSync(WORK, { recursive: true, force: true })
  })

  function makeReal() {
    expect(binPath, 'whisper-cli missing under runtime/whisper.cpp/<os>/').toBeTruthy()
    expect(modelPath, 'no .bin under models/transcriber/').toBeTruthy()
    return createWhisperCliTranscriber({
      id: 'smoke-whisper',
      binPath: binPath!,
      modelPath: modelPath!
    })
  }

  // R-W2: every advertised format must really decode — the UI promise rests on this.
  it.each(['wav', 'mp3', 'flac', 'ogg'])(
    'decodes german.%s into German text with sane timestamps',
    { timeout: 600_000 },
    async (ext) => {
      const file = join(AUDIO_DIR, `german.${ext}`)
      expect(existsSync(file), `fixture missing: ${file}`).toBe(true)
      const t = makeReal()
      const progress: number[] = []
      const segments = await t.transcribe(file, {
        language: 'de',
        workDir: WORK,
        onProgress: (p) => progress.push(p)
      })
      expect(segments.length).toBeGreaterThan(0)
      expect(segments[0].endMs).toBeGreaterThan(segments[0].startMs)
      const text = segments.map((s) => s.text).join(' ')
      expect(text.length).toBeGreaterThan(20)
      console.log(`[${ext}] ${segments.length} segments, progress ticks: ${progress.length}`)
      console.log(`[${ext}] head: ${text.slice(0, 160)}`)
      // The packed ExtractedSegments carry the D29 time-range labels.
      const packed = packTranscriptSegments(segments)
      expect(packed[0].sectionLabel).toMatch(/^(\d+:)?\d{2}:\d{2}–(\d+:)?\d{2}:\d{2}$/)
    }
  )

  // R-W2 descope leg: m4a must FAIL as the decode error (the exit-0 stderr mode),
  // never hang and never return an empty "success".
  it('fails on m4a with the decode error (descoped format)', { timeout: 120_000 }, async () => {
    const file = join(AUDIO_DIR, 'sample.m4a')
    if (!existsSync(file)) return console.log('sample.m4a not provided — leg skipped')
    const t = makeReal()
    await expect(t.transcribe(file, { workDir: WORK })).rejects.toThrow(AUDIO_DECODE_ERROR_PREFIX)
  })

  // R-W4: the long-file leg — wall time + progressive progress on a ~60 min recording.
  it('transcribes a long recording with progressive progress', { timeout: 3_600_000 }, async () => {
    const file = join(AUDIO_DIR, 'german_long.mp3')
    if (!existsSync(file)) return console.log('german_long.mp3 not provided — leg skipped')
    const t = makeReal()
    const started = Date.now()
    const progress: number[] = []
    const segments = await t.transcribe(file, {
      language: 'de',
      workDir: WORK,
      onProgress: (p) => progress.push(p)
    })
    const wallS = Math.round((Date.now() - started) / 1000)
    const audioS = Math.round(segments[segments.length - 1].endMs / 1000)
    console.log(
      `long file: ${audioS}s audio in ${wallS}s wall (RTF ${(wallS / audioS).toFixed(2)}), ` +
        `${segments.length} segments, ${progress.length} progress ticks (last ${progress.at(-1)}%)`
    )
    expect(segments.length).toBeGreaterThan(50)
    // The job UX rests on this: whisper really reports progress as it goes.
    expect(progress.length).toBeGreaterThan(5)
    expect(progress.at(-1)).toBeGreaterThanOrEqual(95)
  })
})
