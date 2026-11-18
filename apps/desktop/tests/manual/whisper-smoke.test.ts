import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWhisperCliTranscriber,
  resolveWhisperCliPath,
  whisperCliDir
} from '../../src/main/services/transcriber'
import { AUDIO_DECODE_ERROR_PREFIX } from '../../src/main/services/transcriber/cli'
import { WhisperPathError } from '../../src/main/services/transcriber/argv'
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
// #869 layout matrix (Windows; its own gate, same drive root): HILBERTRAUM_WHISPER_869=1 with
// HILBERTRAUM_WHISPER_SMOKE set, plus HILBERTRAUM_WHISPER_869_WAV=<a short 16 kHz mono speech WAV>
// (default: <HILBERTRAUM_WHISPER_AUDIO>/german.wav) and optionally
// HILBERTRAUM_WHISPER_869_OTHER_DRIVE=<a second drive's scratch folder, e.g. a `subst Q:` of an empty
// folder> for the cross-drive leg. Run it alone with `-t "#869"`. See the describe block below.
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
  // The WHISPER weight — not the Silero VAD file that sits beside it since #504 (it sorts first).
  const bin = readdirSync(dir).find((f) => f.endsWith('.bin') && !/silero/i.test(f))
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
  const M4A = join(AUDIO_DIR, 'sample.m4a')
  it.skipIf(!existsSync(M4A))('fails on m4a with the decode error (descoped format)', { timeout: 120_000 }, async () => {
    const t = makeReal()
    await expect(t.transcribe(M4A, { workDir: WORK })).rejects.toThrow(AUDIO_DECODE_ERROR_PREFIX)
  })

  // R-W4: the long-file leg — wall time + progressive progress on a ~60 min recording.
  const LONG = join(AUDIO_DIR, 'german_long.mp3')
  it.skipIf(!existsSync(LONG))('transcribes a long recording with progressive progress', { timeout: 3_600_000 }, async () => {
    const t = makeReal()
    const started = Date.now()
    const progress: number[] = []
    const segments = await t.transcribe(LONG, {
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

// #869 layout matrix. The pinned whisper-cli reads its command line through the Windows ANSI code
// page: with master's absolute paths a root under `Jörg äöü` crashed it (0xC0000409 while loading the
// model) and one under `Олена 日本` failed ("input file not found", exit 2), measured on the real
// model. Each root below is a Kit-shaped copy (the engine folder copied, the models hard-linked) and
// every leg goes through the app's own service: a stored file, an encrypted first import's foreign
// original whose name has no ASCII spelling (copied into the documents folder for the run, on
// Windows), and a dictation with VAD. A model with a non-ASCII path (here its file name) is refused
// before anything starts, and a documents folder past MAX_PATH fails as an error, never a crash or a hang.
// rag-design.md §17 D-Z1 "#787 amendment" is the kiwix twin; architecture.md "Audio transcription
// (Phase 36)" "#869 amendment" is this one's record.
const M869 = process.env.HILBERTRAUM_WHISPER_869 === '1' && ROOT.length > 0 && existsSync(ROOT)
const M869_WAV = process.env.HILBERTRAUM_WHISPER_869_WAV?.trim() || (AUDIO_DIR ? join(AUDIO_DIR, 'german.wav') : '')
const M869_OTHER_DRIVE = process.env.HILBERTRAUM_WHISPER_869_OTHER_DRIVE?.trim() ?? ''

describe.runIf(M869)('#869 layout matrix (manual, real whisper-cli under non-ASCII roots)', () => {
  let scratch = ''
  /** Node 24.13's rmSync silently skips a non-ASCII path (Electron 43's Node 24.22 does not), so the
   *  "nothing left behind" check runs only where the test runtime can remove such a file at all. */
  let runtimeRemovesNonAscii = true
  beforeAll(() => {
    expect(existsSync(M869_WAV), `speech WAV missing: ${M869_WAV}`).toBe(true)
    // An ASCII temp root, so its recursive removal works on every Node.
    scratch = mkdtempSync(join(tmpdir(), 'hilbertraum-whisper-869-'))
    const probe = join(scratch, 'prüfung.tmp')
    writeFileSync(probe, 'x')
    rmSync(probe, { force: true })
    runtimeRemovesNonAscii = !existsSync(probe)
  })
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  const weightName = (): string => {
    const weight = transcriberModel(ROOT)
    expect(weight, 'no whisper weight under models/transcriber/').toBeTruthy()
    return weight!.split(/[\\/]/).pop()!
  }
  const vadName = (): string => {
    const vad = readdirSync(join(ROOT, 'models', 'transcriber')).find((f) => /^ggml-silero-.*\.bin$/i.test(f))
    expect(vad, 'no Silero VAD model under models/transcriber/').toBeTruthy()
    return vad!
  }
  const linkOrCopy = (from: string, to: string): void => {
    try {
      linkSync(from, to)
    } catch {
      copyFileSync(from, to) // another volume (a `subst` drive counts as one)
    }
  }
  const text = (segments: Array<{ text: string }>): string => segments.map((s) => s.text).join(' ').trim()

  /** A Kit-shaped root: the engine folder copied, the models linked, an empty documents folder. */
  function provision(root: string, weightAs = weightName()): { docs: string; make: () => ReturnType<typeof createWhisperCliTranscriber> } {
    const binDir = whisperCliDir(root)
    mkdirSync(binDir, { recursive: true })
    for (const e of readdirSync(whisperCliDir(ROOT), { withFileTypes: true })) {
      if (e.isFile()) copyFileSync(join(whisperCliDir(ROOT), e.name), join(binDir, e.name))
    }
    const models = join(root, 'models', 'transcriber')
    mkdirSync(models, { recursive: true })
    linkOrCopy(join(ROOT, 'models', 'transcriber', weightName()), join(models, weightAs))
    linkOrCopy(join(ROOT, 'models', 'transcriber', vadName()), join(models, vadName()))
    const docs = join(root, 'workspace', 'documents')
    mkdirSync(docs, { recursive: true })
    const binPath = resolveWhisperCliPath(root)
    expect(binPath, `whisper-cli not provisioned under ${root}`).toBeTruthy()
    return {
      docs,
      make: () =>
        createWhisperCliTranscriber({
          id: 'whisper-869',
          binPath: binPath!,
          modelPath: join(models, weightAs),
          vadModelPath: join(models, vadName())
        })
    }
  }

  /** Transcribe while sampling the documents folder, so a transient copy is seen while the child runs. */
  async function sampled(
    run: () => Promise<Array<{ text: string }>>,
    docs: string
  ): Promise<{ text: string; seen: Set<string>; ms: number }> {
    const seen = new Set<string>()
    const timer = setInterval(() => {
      for (const f of readdirSync(docs)) seen.add(f)
    }, 10)
    const t0 = Date.now()
    try {
      return { text: text(await run()), seen, ms: Date.now() - t0 }
    } finally {
      clearInterval(timer)
    }
  }

  it.each(['ascii', 'Jörg äöü', 'Олена 日本'])(
    'under %s: a stored file, a foreign non-ASCII original, a dictation with VAD',
    { timeout: 900_000 },
    async (name) => {
      const root = join(scratch, name, 'HilbertRaum')
      const { docs, make } = provision(root)
      const transcriber = make()

      const stored = join(docs, 'doc-1.wav')
      copyFileSync(M869_WAV, stored)
      const a = await sampled(() => transcriber.transcribe(stored, { workDir: docs, language: 'de' }), docs)
      expect(a.text.length, `${name}: stored file`).toBeGreaterThan(10)

      // An encrypted first import parses the user's original where it is (ingestion/index.ts).
      const origin = join(scratch, name, 'Jörg', 'Musik', 'Sitzung März.wav')
      mkdirSync(join(scratch, name, 'Jörg', 'Musik'), { recursive: true })
      copyFileSync(M869_WAV, origin)
      const b = await sampled(() => transcriber.transcribe(origin, { workDir: docs, language: 'de' }), docs)
      expect(b.text.length, `${name}: foreign original`).toBeGreaterThan(10)
      const copies = [...b.seen].filter((f) => /\.parse-audio\.wav$/.test(f))
      expect(copies.length, `${name}: the transient copy (Windows only)`).toBe(process.platform === 'win32' ? 1 : 0)

      const dictation = join(docs, '00000000-dict-869.parse-dictation.wav')
      copyFileSync(M869_WAV, dictation)
      const c = await sampled(() => transcriber.transcribe(dictation, { workDir: docs, vad: true }), docs)
      expect(c.text.length, `${name}: dictation with VAD`).toBeGreaterThan(10)

      if (runtimeRemovesNonAscii) {
        // The transcripts and the copy are shredded; only what this test put there is left.
        expect(readdirSync(docs).sort(), `${name}: left in documents`).toEqual(['00000000-dict-869.parse-dictation.wav', 'doc-1.wav'])
      }
      // eslint-disable-next-line no-console
      console.info(
        `[whisper-869] ${name}: stored ${a.ms} ms "${a.text.slice(0, 40)}" | original ${b.ms} ms, copies seen ${copies.length} ` +
          `"${b.text.slice(0, 40)}" | dictation+VAD ${c.ms} ms "${c.text.slice(0, 40)}" | clean-check ${runtimeRemovesNonAscii}`
      )
    }
  )

  // A Kit on another drive than the original: no relative spelling exists across drives, so a
  // non-ASCII original is copied in and an ASCII one goes absolute.
  it.runIf(M869_OTHER_DRIVE.length > 0 && process.platform === 'win32')(
    'a Kit on another drive: a non-ASCII original is copied in, an ASCII one read where it is',
    { timeout: 900_000 },
    async () => {
      const root = join(M869_OTHER_DRIVE, 'Übungen', 'HilbertRaum')
      try {
        const { docs, make } = provision(root)
        const transcriber = make()
        const nonAscii = join(scratch, 'cross', 'Jörg', 'Musik', 'Sitzung März.wav')
        const ascii = join(scratch, 'cross', 'Public', 'meeting.wav')
        for (const f of [nonAscii, ascii]) {
          mkdirSync(join(f, '..'), { recursive: true })
          copyFileSync(M869_WAV, f)
        }
        const n = await sampled(() => transcriber.transcribe(nonAscii, { workDir: docs, language: 'de' }), docs)
        const s = await sampled(() => transcriber.transcribe(ascii, { workDir: docs, language: 'de' }), docs)
        expect(n.text.length).toBeGreaterThan(10)
        expect(s.text.length).toBeGreaterThan(10)
        expect([...n.seen].filter((f) => f.includes('.parse-audio')).length).toBe(1)
        expect([...s.seen].filter((f) => f.includes('.parse-audio')).length).toBe(0)
        // eslint-disable-next-line no-console
        console.info(`[whisper-869] other drive: copied original ${n.ms} ms "${n.text.slice(0, 40)}" | ASCII original ${s.ms} ms`)
      } finally {
        rmSync(join(M869_OTHER_DRIVE, 'Übungen'), { recursive: true, force: true })
      }
    }
  )

  // Only a user's own manifest can give a model a path outside ASCII; on Windows the call is refused,
  // typed, before anything starts. POSIX reads any name.
  it('a model with a non-ASCII path (its file name) is refused on Windows, read elsewhere', { timeout: 600_000 }, async () => {
    const { docs, make } = provision(join(scratch, 'refusal', 'HilbertRaum'), 'ggml-small-für-mich.bin')
    const stored = join(docs, 'doc-1.wav')
    copyFileSync(M869_WAV, stored)
    const run = make().transcribe(stored, { workDir: docs, language: 'de' })
    if (process.platform === 'win32') await expect(run).rejects.toBeInstanceOf(WhisperPathError)
    else expect(text(await run).length).toBeGreaterThan(10)
  })

  // A documents folder past MAX_PATH: Windows refuses a child working directory of 258+ characters
  // and Node's spawn fails (ENOENT, absorbed by `guardChildStdio`, #790). It must reject, not crash or
  // hang. Such a folder could not work before either: whisper-cli opens its files without a long-path
  // prefix.
  it.runIf(process.platform === 'win32')('a documents folder past MAX_PATH fails as an error', { timeout: 600_000 }, async () => {
    const { make } = provision(join(scratch, 'deep', 'HilbertRaum'))
    const docs = join(scratch, 'deep', 'd'.repeat(120), 'e'.repeat(120), 'workspace', 'documents')
    expect(docs.length).toBeGreaterThan(260)
    mkdirSync(docs, { recursive: true })
    const stored = join(docs, 'doc-1.wav')
    copyFileSync(M869_WAV, stored)
    const err = await make()
      .transcribe(stored, { workDir: docs, language: 'de' })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    // eslint-disable-next-line no-console
    console.info(`[whisper-869] MAX_PATH documents folder (${docs.length} chars): ${String(err).slice(0, 160)}`)
  })
})
