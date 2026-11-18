import { isAbsolute, posix, resolve, win32 } from 'node:path'
import { isAsciiPath } from '../zim/argv'

// How a whisper-cli child is handed its files (#869; architecture.md "Audio transcription
// (Phase 36)", "#869 amendment").
//
// The pinned whisper-cli (whisper.cpp v1.8.6, Windows x64) has a narrow `main` and no UTF-8
// `activeCodePage` manifest (llama-server has one since b12110, #729), so Windows fills its argv in
// the ANSI code page. A character outside that code page arrives as `?` ("input file not found");
// one inside it (cp1252 `ü` = 0xFC) arrives as a byte that is not UTF-8, and whisper-cli dies with
// a fail-fast exception (0xC0000409) while it loads the model. Measured 2026-11-17 and on the real
// model by tests/manual/whisper-smoke.test.ts "#869 layout matrix".
//
// What it reads exactly: a RELATIVE path, which the OS resolves against the child's working
// directory — wide, and therefore exact. So every child starts in the workspace's documents folder
// (`opts.workDir`) on every platform, and gets the shortest ASCII spelling of each path:
//
//   - the transcript (`-of`) and any file in that folder (a stored copy, a decrypted transient, the
//     dictation WAV) by its bare name, on every platform — names the app chooses, so ASCII;
//   - on Windows, a model (`-m`, `-vm`) absolute when that is ASCII, else relative to that folder
//     (`..\..\models\…` under a root such as `C:\Users\Jürgen\AppData\Roaming\HilbertRaum`); with no
//     ASCII spelling (a non-ASCII model FILE name, which only a user's own manifest can give) the
//     call is refused, typed (`WhisperPathError`), before anything starts;
//   - on Windows, the audio absolute when ASCII, else relative when ASCII, else COPIED into that
//     folder first under an ASCII name (`<id>.parse-audio<ext>`): an encrypted workspace's first
//     import parses the user's ORIGINAL file wherever it is (`ingestion/index.ts`), and a German
//     file name (`Sitzung März.mp3`) has no ASCII spelling from anywhere. The `.parse` infix keeps
//     the copy under the startup crash sweep; the transcriber shreds it with the transcript.
//
// The working directory is the documents folder, never the audio's own folder: Windows searches a
// process's working directory for a DLL it finds neither beside the exe nor in the system folders
// (the #787 review, rag-design.md §17 D-Z1). The documents folder is the app's own and holds only
// names the app chooses (`<uuid>…`), so no downloaded `vcruntime140.dll` or `ggml-*.dll` can sit
// there; and it is not the engine folder, which an engine install replaces while no child runs.
//
// Every path is resolved against the APP's working directory before it is spelled: the child starts
// elsewhere, so a relative path (a dev run's relative drive root, `HILBERTRAUM_WHISPER_BIN`) would
// otherwise be looked up from the documents folder (the #787 trap).

/** The program whisper-cli is spawned as, absolute: the child starts in another folder (#869). */
export function whisperCommand(binPath: string): string {
  return isAbsolute(binPath) ? binPath : resolve(binPath)
}

export interface WhisperArgvInput {
  /** The child's working directory: the workspace's documents folder, absolute. */
  cwd: string
  /** The whisper weights (`-m`). */
  modelPath: string
  /** The Silero VAD model (`-vm`), or null when this call runs without VAD. */
  vadModelPath: string | null
  /** The audio (`-f`). */
  filePath: string
  /** This call's id (ASCII): names the transcript `<id>.parse-transcript` and a copy `<id>.parse-audio<ext>`. */
  id: string
  platform: NodeJS.Platform
}

/** The arguments as the child gets them, each readable from `cwd`. */
export interface WhisperArgv {
  model: string
  vadModel: string | null
  file: string
  /** `-of`: a bare name in `cwd`; whisper-cli writes `<outBase>.json`. */
  outBase: string
  /** Windows only: the audio had no ASCII spelling, so the caller copies it into `cwd` under this
   *  name before the spawn (`file` is that name) and shreds it after. Always null elsewhere. */
  copyName: string | null
}

/** The model the call cannot hand whisper-cli on this Windows command line. */
export interface WhisperArgvRefusal {
  refused: '-m' | '-vm'
}

/**
 * The call was refused before anything started (#869): a model path has no ASCII spelling on this
 * Windows command line. Path-free — the caller logs the argument, never the path.
 */
export class WhisperPathError extends Error {
  readonly kind = 'non-ascii-path' as const
  constructor(readonly arg: WhisperArgvRefusal['refused']) {
    super(
      `whisper-cli was not started: the ${arg === '-m' ? 'speech' : 'voice-activity'} model's path has no ` +
        'spelling it can read on this Windows command line (#869)'
    )
    this.name = 'WhisperPathError'
  }
}

export function isWhisperPathError(err: unknown): err is WhisperPathError {
  return err instanceof WhisperPathError
}

/** An extension the copy may keep: what whisper-cli's decoder sees of the name. */
const COPY_EXT = /^\.[A-Za-z0-9]{1,8}$/

/** Plan one whisper-cli command line (#869). Pure; the platform is injected. */
export function planWhisperArgv(input: WhisperArgvInput): WhisperArgv | WhisperArgvRefusal {
  const windows = input.platform === 'win32'
  const p = windows ? win32 : posix
  const cwd = input.cwd
  const outBase = `${input.id}.parse-transcript`

  /** Windows: the absolute path when ASCII, else its path from `cwd` when that is ASCII, else null.
   *  Across drives `win32.relative` returns the absolute target, which is non-ASCII by then (the
   *  ASCII case returned first), so the ASCII test alone refuses it. */
  const asciiSpelling = (target: string): string | null => {
    if (isAsciiPath(target)) return target
    const rel = win32.relative(cwd, target)
    return rel !== '' && isAsciiPath(rel) ? rel : null
  }
  const weight = (path: string): string | null => {
    const target = p.resolve(path)
    return windows ? asciiSpelling(target) : target
  }

  const model = weight(input.modelPath)
  if (model === null) return { refused: '-m' }
  const vadModel = input.vadModelPath === null ? null : weight(input.vadModelPath)
  if (input.vadModelPath !== null && vadModel === null) return { refused: '-vm' }

  const audio = p.resolve(input.filePath)
  const fromCwd = p.relative(cwd, audio)
  const bare = fromCwd !== '' && fromCwd !== '..' && p.basename(fromCwd) === fromCwd ? fromCwd : null
  if (!windows) return { model, vadModel, file: bare ?? audio, outBase, copyName: null }
  const file = bare !== null && isAsciiPath(bare) ? bare : asciiSpelling(audio)
  if (file !== null) return { model, vadModel, file, outBase, copyName: null }
  const ext = p.extname(audio)
  const copyName = `${input.id}.parse-audio${COPY_EXT.test(ext) ? ext : ''}`
  return { model, vadModel, file: copyName, outBase, copyName }
}
