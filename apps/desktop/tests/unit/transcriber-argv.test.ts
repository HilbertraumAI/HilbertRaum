import { describe, expect, it } from 'vitest'
import { planWhisperArgv } from '../../src/main/services/transcriber/argv'

// #869: whisper-cli v1.8.6 reads its command line through the Windows ANSI code page, so a path
// with a character outside ASCII reaches it mangled (`Олена` → `?????`: "input file not found") or
// as bytes that are not UTF-8 (cp1252 `ü`: a fail-fast crash, 0xC0000409). It reads a RELATIVE
// path exactly: the OS resolves it against the child's wide working directory. So the child starts
// in the workspace's documents folder and every argument gets an ASCII spelling from there, or the
// audio is copied there first (an import's original file), or the call is refused (a model). The
// Windows layouts are measured on the real binary by the #869 matrix in
// tests/manual/whisper-smoke.test.ts. The planner is pure; the platform is injected.

const ID = '0b5f3c1e-7a2d-4c11-9e3f-5d6b7a8c9d0e'
const OUT = `${ID}.parse-transcript`

/** A root's documents folder and its two whisper models, as `resolvePaths` and the manifest lay them out. */
function root(path: string, sep: '\\' | '/'): { cwd: string; model: string; vad: string } {
  return {
    cwd: [path, 'workspace', 'documents'].join(sep),
    model: [path, 'models', 'transcriber', 'ggml-small.bin'].join(sep),
    vad: [path, 'models', 'transcriber', 'ggml-silero-v5.1.2.bin'].join(sep)
  }
}

const JUERGEN = root('C:\\Users\\Jürgen\\AppData\\Roaming\\HilbertRaum', '\\')
const KIT_D = root('D:\\HilbertRaum', '\\')
const KIT_UEBUNGEN = root('D:\\Übungen\\HilbertRaum', '\\')
const LINUX = root('/media/jörg/HilbertRaum', '/')
const UP_TO_MODELS = '..\\..\\models\\transcriber\\'

describe('planWhisperArgv (#869)', () => {
  it.each([
    {
      name: 'a non-ASCII root: the models relative to the documents folder, the dictation WAV bare',
      at: JUERGEN,
      vad: true,
      filePath: `${JUERGEN.cwd}\\${ID}.parse-dictation.wav`,
      want: { model: `${UP_TO_MODELS}ggml-small.bin`, vadModel: `${UP_TO_MODELS}ggml-silero-v5.1.2.bin`, file: `${ID}.parse-dictation.wav`, copyName: null }
    },
    {
      name: 'an ASCII Kit: the models stay absolute, the stored copy goes bare',
      at: KIT_D,
      vad: false,
      filePath: `${KIT_D.cwd}\\doc-1.mp3`,
      want: { model: KIT_D.model, vadModel: null, file: 'doc-1.mp3', copyName: null }
    },
    {
      name: 'an encrypted first import of C:\\Users\\Jörg\\Music\\Sitzung März.mp3 beside a Kit on D: is copied in',
      at: KIT_D,
      vad: false,
      filePath: 'C:\\Users\\Jörg\\Music\\Sitzung März.mp3',
      want: { model: KIT_D.model, vadModel: null, file: `${ID}.parse-audio.mp3`, copyName: `${ID}.parse-audio.mp3` }
    },
    {
      name: 'an original in another folder of the same non-ASCII account goes relative',
      at: JUERGEN,
      vad: false,
      filePath: 'C:\\Users\\Jürgen\\Music\\meeting.mp3',
      want: { model: `${UP_TO_MODELS}ggml-small.bin`, vadModel: null, file: '..\\..\\..\\..\\..\\Music\\meeting.mp3', copyName: null }
    },
    {
      name: 'an ASCII original on another drive than a non-ASCII Kit stays absolute',
      at: KIT_UEBUNGEN,
      vad: false,
      filePath: 'C:\\Users\\Public\\Music\\meeting.mp3',
      want: { model: `${UP_TO_MODELS}ggml-small.bin`, vadModel: null, file: 'C:\\Users\\Public\\Music\\meeting.mp3', copyName: null }
    },
    {
      name: 'a non-ASCII original on another drive is copied in, keeping its extension',
      at: KIT_UEBUNGEN,
      vad: false,
      filePath: 'E:\\Aufnahmen\\Олена.wav',
      want: { model: `${UP_TO_MODELS}ggml-small.bin`, vadModel: null, file: `${ID}.parse-audio.wav`, copyName: `${ID}.parse-audio.wav` }
    }
  ])('win32: $name', ({ at, vad, filePath, want }) => {
    const plan = planWhisperArgv({ cwd: at.cwd, modelPath: at.model, vadModelPath: vad ? at.vad : null, filePath, id: ID, platform: 'win32' })
    expect(plan).toEqual({ ...want, outBase: OUT })
  })

  // A model whose path below `models/` holds a non-ASCII character — the file name or a folder — is
  // only possible in a user's own manifest; copying gigabytes per call is no option, so the call is
  // refused before anything starts.
  it.each([
    { name: 'a non-ASCII file name', arg: '-m', modelPath: 'D:\\HilbertRaum\\models\\transcriber\\ggml-small-für-mich.bin', vadModelPath: null },
    { name: 'an ASCII file name in a non-ASCII folder', arg: '-m', modelPath: 'D:\\HilbertRaum\\models\\Übersetzung\\ggml-small.bin', vadModelPath: null },
    { name: 'a non-ASCII VAD file name', arg: '-vm', modelPath: KIT_D.model, vadModelPath: 'D:\\HilbertRaum\\models\\transcriber\\ggml-silero-größer.bin' }
  ])('win32: refuses a model with no ASCII spelling: $name ($arg)', ({ arg, modelPath, vadModelPath }) => {
    const plan = planWhisperArgv({ cwd: KIT_D.cwd, modelPath, vadModelPath, filePath: `${KIT_D.cwd}\\doc-1.mp3`, id: ID, platform: 'win32' })
    expect(plan).toEqual({ refused: arg })
  })

  // macOS and Linux hand the child its argv as bytes, so every path reads exactly: the documents
  // folder's files still go bare (one code path), everything else absolute, and nothing is copied.
  it.each([
    { name: 'a foreign non-ASCII original stays absolute', filePath: '/home/jörg/Musik/Sitzung März.mp3', file: '/home/jörg/Musik/Sitzung März.mp3' },
    { name: 'the stored copy goes bare', filePath: `${LINUX.cwd}/doc-1.mp3`, file: 'doc-1.mp3' }
  ])('linux: $name, never a copy', ({ filePath, file }) => {
    const plan = planWhisperArgv({ cwd: LINUX.cwd, modelPath: LINUX.model, vadModelPath: LINUX.vad, filePath, id: ID, platform: 'linux' })
    expect(plan).toEqual({ model: LINUX.model, vadModel: LINUX.vad, file, outBase: OUT, copyName: null })
  })
})
