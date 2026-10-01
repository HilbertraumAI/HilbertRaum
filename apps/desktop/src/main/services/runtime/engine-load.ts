import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineProblem, EngineProblemFamily, EngineProblemReason } from '../../../shared/types'

// Engine load failures (#530; design record: architecture.md "Engine load failures"). An engine
// program can be ON the drive, pass the pre-spawn hash check, and still never run: the operating
// system's loader refuses it before the program prints a line of its own — a system library is
// missing (Linux without `libgomp1`), the system is older than the build, a Windows PC lacks the
// Visual C++ runtime, or code integrity blocks it. Before #530 nothing recognised that, so the
// chat ladder blamed the GPU or the model, the GPU probe recorded "no graphics card", and the
// embedder stored the loader's raw line — absolute drive path included — on every document.
//
// This module holds the three pieces every spawn site shares:
//   1. `classifyLoadFailure` — pure: exit code + signal + stderr → a reason, or null for every
//      failure that is not the loader's (those keep their old handling, byte for byte);
//   2. `EngineCannotRunError` — the typed, path-free error a spawn site throws instead;
//   3. the session verdict store — in memory only, NEVER persisted (a restart after the fix starts
//      clean), read by `getAppStatus` and cleared by "Check again".
//
// The shapes below were measured, not guessed (2026-10-01, the pinned b11146 / whisper b5130
// archives in stock Ubuntu containers, and llama-server.exe from Node 24 on Windows 11):
//   - Linux, a library missing: exit 127, ONE stderr line
//     `<abs path>/llama-server: error while loading shared libraries: libgomp.so.1: cannot open
//     shared object file: No such file or directory`. ld.so names only the FIRST missing library
//     (Ubuntu 20.04 reports `libssl.so.3`, never `libgomp.so.1`).
//   - Linux, the system too old: exit **1**, several lines
//     `<abs>: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by <abs>)`
//     — so the exit code alone can never decide; the text does.
//   - Windows: exit 0xC0000135 (a DLL not found) / 0xC0000139 (an entry point not found), no
//     stderr at all, about 20 ms after the spawn; Node reports the NTSTATUS unsigned.
//   - macOS (not measured — no Mac in the project): dyld prints `Library not loaded: …` /
//     `Symbol not found: …` and aborts (SIGABRT).

/** A classified load failure — an {@link EngineProblem} before the caller names the family. */
export type LoadFailure = Omit<EngineProblem, 'family'>

export interface LoadFailureInput {
  exitCode: number | null
  signal: string | null
  /** The program's stderr (any length; ANSI-free or not). Never stored — only matched. */
  stderr: string
  /** The OS the program ran on (default `process.platform`) — sets `EngineProblem.os`. */
  platform?: NodeJS.Platform
  /**
   * Windows only: is this DLL present in `%SystemRoot%\System32`? Consulted ONLY after a
   * DLL-shaped NTSTATUS, to tell a missing Visual C++ runtime from damaged engine files.
   * Injected by tests; the default checks the real System32.
   */
  systemDllExists?: (dll: string) => boolean
}

/** Windows NTSTATUS exit codes the loader produces (as Node reports them: unsigned). */
const STATUS_DLL_NOT_FOUND = 0xc0000135
const STATUS_ENTRYPOINT_NOT_FOUND = 0xc0000139
const STATUS_INVALID_IMAGE_FORMAT = 0xc000007b
/** Code integrity / Smart App Control refused an image (seen on the dev box, 2026-09-04). */
const STATUS_CODE_INTEGRITY_BLOCKED = 0xc0e90002

/**
 * The Microsoft Visual C++ 2015–2022 runtime. Every Windows engine build imports these three
 * (llama.cpp, whisper.cpp and kiwix-tools — measured 2026-10-01) and none of the drive's engine
 * folders carries them; they come with the separately installed Redistributable.
 */
export const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'] as const

/** Libraries the ENGINES ship next to their programs — a missing one means damaged engine files. */
const ENGINE_OWN_LIBRARY = /^(?:lib)?(?:llama|ggml|mtmd|whisper)[\w.+-]*\.(?:so|dylib|dll)\b/i

/**
 * OpenSSL 3 is part of every supported Linux base system (measured present in stock Ubuntu 22.04
 * and 24.04 images), so its absence means a system that predates the engine — not a package to add.
 */
const OPENSSL3_LIBRARY = /^lib(?:ssl|crypto)\.so\.3$/

const LINUX_LOADER_RE = /error while loading shared libraries: ([^:\s]+): ([^\r\n]*)/
const LINUX_VERSION_RE = /version [`'‘]((?:GLIBC|GLIBCXX|CXXABI)_[0-9.]+)[`'’] not found/
const LINUX_SYMBOL_RE = /symbol lookup error: [^\r\n]*undefined symbol: (\S+)/
const DYLD_NOT_LOADED_RE = /Library not loaded:\s*(\S+)/
const DYLD_SYMBOL_RE = /Symbol not found:\s*(\S+)/
const DYLD_EXPECTED_IN_RE = /Expected in:?\s*(\S+)/
const DYLD_OS_TOO_OLD_RE = /which is newer than running OS/i

const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

function osOf(platform: NodeJS.Platform): EngineProblem['os'] {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'mac'
  return 'linux'
}

/** The last path segment of a library path or install name (`@rpath/libggml.dylib` → `libggml.dylib`). */
function fileName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function defaultSystemDllExists(dll: string): boolean {
  return existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', dll))
}

/** How the program ended, for Diagnostics: `exit code 127`, `exit code 0xC0000135`, `signal SIGABRT`. */
export function describeExit(exitCode: number | null, signal: string | null): string {
  if (exitCode != null) {
    const unsigned = exitCode >>> 0
    return unsigned > 0xffff ? `exit code 0x${unsigned.toString(16).toUpperCase()}` : `exit code ${exitCode}`
  }
  return signal ? `signal ${signal}` : 'no exit status'
}

/**
 * Was this a refusal by the operating system's loader, and why? Null for every other failure —
 * a model error, a bind race, a crash, a usage error — so callers keep their existing handling.
 * Pure apart from the injected Windows DLL check; never throws.
 */
export function classifyLoadFailure(input: LoadFailureInput): LoadFailure | null {
  const platform = input.platform ?? process.platform
  const os = osOf(platform)
  const exit = describeExit(input.exitCode, input.signal)
  const text = input.stderr.replace(ANSI_RE, '')
  const failure = (reason: EngineProblemReason, name?: string): LoadFailure =>
    name ? { reason, os, name, exit } : { reason, os, exit }

  // Linux (glibc ld.so). The library ld.so names comes first: it is the one the user can act on.
  const missing = LINUX_LOADER_RE.exec(text)
  if (missing) {
    const library = fileName(missing[1])
    if (ENGINE_OWN_LIBRARY.test(library)) return failure('files-damaged', library)
    if (OPENSSL3_LIBRARY.test(library)) return failure('system-too-old', library)
    // "cannot open shared object file" is the missing case; "file too short" / "wrong ELF class"
    // on a SYSTEM library is a broken system install — still the system's, not the engine's.
    return failure('library-missing', library)
  }
  const version = LINUX_VERSION_RE.exec(text)
  if (version) return failure('system-too-old', version[1])
  // An undefined symbol in a library the ENGINE ships is a mismatched engine install. In a SYSTEM
  // library (a Mesa Vulkan driver that does not match the loader, say) it is no engine fault:
  // null, so the ladder's #312 logic treats it as the device problem it is.
  const symbol = LINUX_SYMBOL_RE.exec(text)
  if (symbol) {
    const referencing = /symbol lookup error: ([^:\r\n]+):/.exec(text)?.[1] ?? ''
    return ENGINE_OWN_LIBRARY.test(fileName(referencing)) ? failure('files-damaged', symbol[1]) : null
  }

  // macOS (dyld) — not measured on hardware; the wording is dyld's documented one.
  const notLoaded = DYLD_NOT_LOADED_RE.exec(text)
  if (notLoaded) {
    const installName = notLoaded[1]
    const library = fileName(installName)
    const engineOwn = installName.startsWith('@') || ENGINE_OWN_LIBRARY.test(library)
    return failure(engineOwn ? 'files-damaged' : 'system-too-old', library)
  }
  const dyldSymbol = DYLD_SYMBOL_RE.exec(text)
  if (dyldSymbol) {
    const expectedIn = DYLD_EXPECTED_IN_RE.exec(text)?.[1] ?? ''
    const engineOwn = expectedIn.startsWith('@') || ENGINE_OWN_LIBRARY.test(fileName(expectedIn))
    return failure(engineOwn ? 'files-damaged' : 'system-too-old', dyldSymbol[1])
  }
  if (DYLD_OS_TOO_OLD_RE.test(text)) return failure('system-too-old')

  // Windows: no text at all — the NTSTATUS exit code is the whole story.
  if (input.exitCode != null) {
    const status = input.exitCode >>> 0
    if (status === STATUS_CODE_INTEGRITY_BLOCKED) return failure('blocked')
    if (
      status === STATUS_DLL_NOT_FOUND ||
      status === STATUS_ENTRYPOINT_NOT_FOUND ||
      status === STATUS_INVALID_IMAGE_FORMAT
    ) {
      const exists = input.systemDllExists ?? defaultSystemDllExists
      let absent: string | undefined
      try {
        absent = VC_RUNTIME_DLLS.find((dll) => !exists(dll))
      } catch {
        absent = undefined
      }
      return absent ? failure('vc-runtime-missing', absent) : failure('files-damaged')
    }
  }
  return null
}

/** Windows spawn errors that mean "Windows would not start this program" (policy, AV, quarantine). */
const WINDOWS_REFUSED_SPAWN_CODES = new Set(['EPERM', 'UNKNOWN', 'EACCES'])

/**
 * Classify a SPAWN error — the program never started at all. On Windows, `CreateProcess` refusals by
 * code integrity, an application-control policy or security software surface from Node as EPERM /
 * `UNKNOWN` / EACCES (synchronously or via the `'error'` event) instead of an exit code: the same
 * "the OS refused the program" class as 0xC0E90002, so `blocked`. Elsewhere (ENOENT, a POSIX EACCES)
 * nothing here can say WHY, so null keeps the old handling.
 */
export function classifySpawnError(err: unknown, platform: NodeJS.Platform = process.platform): LoadFailure | null {
  if (platform !== 'win32') return null
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== 'string' || !WINDOWS_REFUSED_SPAWN_CODES.has(code)) return null
  return { reason: 'blocked', os: 'win', exit: `spawn error ${code}` }
}

/** A spawn error's message without the program's absolute path (Node writes `spawn <path> <CODE>`). */
export function pathFreeSpawnError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.length > 0) return `spawn ${code}`
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^spawn \S+ /, 'spawn ')
}

/**
 * Classify a failure from a stored or thrown MESSAGE — the healing path for state written before
 * #530 (a `gpuLastError`, a failed document's `error_message`). Reads the `exited before becoming
 * healthy (code N | signal S)` status the sidecars put in their messages, and the rest as stderr.
 */
export function classifyLoadFailureMessage(
  message: string,
  opts: Pick<LoadFailureInput, 'platform' | 'systemDllExists'> = {}
): LoadFailure | null {
  const status = /exited before becoming healthy \((?:code (-?\d+)|signal (\S+?))\)/.exec(message)
  const exitCode = status?.[1] != null ? Number(status[1]) : null
  const signal = status?.[2] ?? null
  return classifyLoadFailure({ exitCode, signal, stderr: message, ...opts })
}

const REASON_PHRASE: Record<EngineProblemReason, string> = {
  'library-missing': 'a system library is missing',
  'system-too-old': 'the system is older than the engine needs',
  'files-damaged': "the engine's own files are missing or damaged",
  'vc-runtime-missing': 'the Microsoft Visual C++ runtime is missing',
  blocked: 'Windows refused to start it (code integrity or security software)'
}

/** One path-free English line for logs and error messages: `a system library is missing: libgomp.so.1 (exit code 127)`. */
export function describeLoadFailure(failure: LoadFailure): string {
  return `${REASON_PHRASE[failure.reason]}${failure.name ? `: ${failure.name}` : ''} (${failure.exit})`
}

/**
 * Thrown by a spawn site instead of its usual start error when the loader refused the program.
 * The message is path-free (the raw loader line goes to the log once, at the spawn site), so a
 * caller that persists or shows `err.message` can no longer leak the drive path.
 */
export class EngineCannotRunError extends Error {
  readonly problem: EngineProblem

  constructor(program: string, problem: EngineProblem) {
    super(`${program} cannot run on this computer — ${describeLoadFailure(problem)}`)
    this.name = 'EngineCannotRunError'
    this.problem = problem
  }
}

/** `instanceof` across module copies is not guaranteed in tests; the name check is the fallback. */
export function isEngineCannotRunError(err: unknown): err is EngineCannotRunError {
  return (
    err instanceof EngineCannotRunError ||
    (err instanceof Error && err.name === 'EngineCannotRunError' && 'problem' in err)
  )
}

// ---- The session verdict store ---------------------------------------------------------------
//
// Module-level and session-scoped, the `modelLoadLatched` idiom (factory.ts): fed by every spawn
// site that classifies a load failure (first-hand evidence, wherever it happens first), read by
// `getAppStatus`, cleared by "Check again" once the program starts. Never persisted — nothing
// about a system library belongs to the drive, and a wrong verdict must not outlive the process.

interface StoredProblem {
  problem: EngineProblem
  /** Monotonic report sequence — "Check again" asks whether a report landed after it began. */
  seq: number
  /**
   * The program the OS refused, when the reporter knows it. A healthy start of THAT program clears
   * the verdict (an intermittent block that went away); a different program of the same family
   * starting — a Windows Kit's `cpu/` build beside a damaged main folder — does not.
   */
  binPath?: string
}

const FAMILY_ORDER: EngineProblemFamily[] = ['llama_cpp', 'whisper_cpp']
const problems = new Map<EngineProblemFamily, StoredProblem>()
const listeners = new Set<() => void>()
let reportSeq = 0

function sameProblem(a: EngineProblem, b: EngineProblem): boolean {
  return a.reason === b.reason && a.name === b.name && a.exit === b.exit && a.os === b.os
}

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* a listener must never break a spawn site's error path */
    }
  }
}

/** Record that this engine cannot run (first-hand evidence from a spawn). Never throws. */
export function reportEngineProblem(problem: EngineProblem, binPath?: string): void {
  const previous = problems.get(problem.family)
  problems.set(problem.family, { problem, seq: ++reportSeq, ...(binPath ? { binPath } : {}) })
  if (!previous || !sameProblem(previous.problem, problem)) notifyListeners()
}

/** The engine started (or is gone): drop its verdict. Never throws. */
export function clearEngineProblem(family: EngineProblemFamily): void {
  if (problems.delete(family)) notifyListeners()
}

/**
 * The program at `binPath` just started (healthy, or the probe answered): if the family's verdict was
 * about THAT program, it is stale — drop it. Never throws.
 */
export function clearEngineProblemFor(family: EngineProblemFamily, binPath: string): void {
  const stored = problems.get(family)
  if (stored && stored.binPath === binPath) clearEngineProblem(family)
}

/** Every current verdict, the chat engine first. */
export function engineProblems(): EngineProblem[] {
  return FAMILY_ORDER.flatMap((family) => {
    const stored = problems.get(family)
    return stored ? [stored.problem] : []
  })
}

/** This family's current verdict, or null. */
export function engineProblemFor(family: EngineProblemFamily): EngineProblem | null {
  return problems.get(family)?.problem ?? null
}

/** The current report sequence — capture it before a re-check, compare with {@link engineProblemReportedSince}. */
export function engineProblemSeq(): number {
  return reportSeq
}

/** Did a report for this family land after `seq` was captured? */
export function engineProblemReportedSince(family: EngineProblemFamily, seq: number): boolean {
  const stored = problems.get(family)
  return stored != null && stored.seq > seq
}

/** Subscribe to verdict changes (a new or different problem, or a cleared one). Returns the unsubscribe. */
export function onEngineProblemsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test reset: forget every verdict and listener. */
export function resetEngineProblemsForTest(): void {
  problems.clear()
  listeners.clear()
  reportSeq = 0
}
