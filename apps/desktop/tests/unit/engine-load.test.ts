import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EngineCannotRunError,
  classifyLoadFailure,
  classifyLoadFailureMessage,
  classifySpawnError,
  clearEngineProblem,
  clearEngineProblemFor,
  pathFreeSpawnError,
  engineProblemFor,
  engineInstalled,
  isEngineCannotRunError,
  onEngineProblemDropped,
  onEngineProblemsChanged,
  reportEngineProblem,
  resetEngineProblemsForTest
} from '../../src/main/services/runtime/engine-load'

// #530 — the loader-failure classifier and the session verdict store. The stderr strings below
// are VERBATIM from the 2026-10-01 measurement (the pinned llama.cpp b11146 / whisper.cpp b5130
// Linux archives in stock ubuntu:20.04/22.04/24.04 containers), with the drive path anonymised;
// the Windows exit codes are what Node 24 reported for llama-server.exe on Windows 11.

const DRIVE = '/media/someone/HILBERTRAUM'
const LLAMA = `${DRIVE}/runtime/llama.cpp/linux/llama-server`
const LLAMA_CPU = `${DRIVE}/runtime/llama.cpp/linux/cpu/llama-server`
const WHISPER = `${DRIVE}/runtime/whisper.cpp/linux/whisper-cli`

const missing = (bin: string, lib: string): string =>
  `${bin}: error while loading shared libraries: ${lib}: cannot open shared object file: No such file or directory\n`

/** Ubuntu 20.04 + libgomp1: whisper-cli exits 1 with one line per missing symbol version. */
const WHISPER_TOO_OLD = [
  `${WHISPER}: /lib/x86_64-linux-gnu/libstdc++.so.6: version \`GLIBCXX_3.4.29' not found (required by ${WHISPER})`,
  `${WHISPER}: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.33' not found (required by ${WHISPER})`,
  `${WHISPER}: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.32' not found (required by ${WHISPER})`,
  `${WHISPER}: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.34' not found (required by ${WHISPER})`
].join('\n')

const linux = { platform: 'linux' as const }
const noDll = (): boolean => {
  throw new Error('the System32 check must not run for a Linux/macOS failure')
}

afterEach(() => resetEngineProblemsForTest())

describe('classifyLoadFailure — Linux (measured)', () => {
  it('names libgomp.so.1 for the vulkan build, the cpu safety net and whisper-cli alike (exit 127)', () => {
    for (const bin of [LLAMA, LLAMA_CPU, WHISPER]) {
      expect(
        classifyLoadFailure({ exitCode: 127, signal: null, stderr: missing(bin, 'libgomp.so.1'), ...linux, systemDllExists: noDll })
      ).toEqual({ reason: 'library-missing', os: 'linux', name: 'libgomp.so.1', exit: 'exit code 127' })
    }
  })

  it('reads a missing OpenSSL 3 (Ubuntu 20.04 reports it before libgomp) as a system too old, not a package', () => {
    for (const lib of ['libssl.so.3', 'libcrypto.so.3']) {
      expect(classifyLoadFailure({ exitCode: 127, signal: null, stderr: missing(LLAMA, lib), ...linux })).toMatchObject({
        reason: 'system-too-old',
        name: lib
      })
    }
  })

  it('classifies the "version not found" lines from the TEXT — they exit 1, not 127', () => {
    const failure = classifyLoadFailure({ exitCode: 1, signal: null, stderr: WHISPER_TOO_OLD, ...linux })
    expect(failure).toEqual({ reason: 'system-too-old', os: 'linux', name: 'GLIBCXX_3.4.29', exit: 'exit code 1' })
  })

  it('blames the engine files when the missing library is one the engine ships itself', () => {
    expect(
      classifyLoadFailure({ exitCode: 127, signal: null, stderr: missing(LLAMA, 'libllama-common.so.0'), ...linux })
    ).toMatchObject({ reason: 'files-damaged', name: 'libllama-common.so.0' })
    expect(
      classifyLoadFailure({ exitCode: 127, signal: null, stderr: missing(WHISPER, 'libggml-base.so.0'), ...linux })
    ).toMatchObject({ reason: 'files-damaged', name: 'libggml-base.so.0' })
    expect(
      classifyLoadFailure({
        exitCode: 127,
        signal: null,
        stderr: `${LLAMA}: symbol lookup error: ${DRIVE}/runtime/llama.cpp/linux/libllama.so.0: undefined symbol: ggml_backend_dev_get\n`,
        ...linux
      })
    ).toMatchObject({ reason: 'files-damaged', name: 'ggml_backend_dev_get' })
  })

  it('an undefined symbol in a SYSTEM library (a mismatched Mesa driver) is no engine fault — null', () => {
    // Review fix: before, every symbol lookup error read as "damaged engine files"; a GPU driver
    // mismatch must reach the ladder's #312 device logic instead.
    const stderr = `${LLAMA}: symbol lookup error: /usr/lib/x86_64-linux-gnu/libvulkan_radeon.so: undefined symbol: vkFoo\n`
    expect(classifyLoadFailure({ exitCode: 127, signal: null, stderr, ...linux })).toBeNull()
  })

  it('carries no path anywhere in its answer', () => {
    const failure = classifyLoadFailure({ exitCode: 127, signal: null, stderr: missing(LLAMA, 'libgomp.so.1'), ...linux })
    expect(JSON.stringify(failure)).not.toContain(DRIVE)
    expect(JSON.stringify(failure)).not.toContain('/')
  })
})

describe('classifyLoadFailure — what it must NOT claim', () => {
  it('returns null for llama.cpp failing on its own (a model error, a bind race, a usage error)', () => {
    const own = [
      '0.00.123.456 E llama_model_load: error loading model: unknown model architecture: \'foo\'\n0.00.200.000 E main: exiting due to model loading error\n',
      'error: bind: address already in use\n',
      'error: invalid argument: --bogus\nusage: llama-server [options]\n'
    ]
    for (const stderr of own) {
      expect(classifyLoadFailure({ exitCode: 1, signal: null, stderr, ...linux })).toBeNull()
    }
  })

  it('returns null for crashes and kills that carry no loader text', () => {
    expect(classifyLoadFailure({ exitCode: null, signal: 'SIGKILL', stderr: '', platform: 'linux' })).toBeNull()
    expect(classifyLoadFailure({ exitCode: null, signal: 'SIGSEGV', stderr: 'load_tensors: …\n', platform: 'linux' })).toBeNull()
    // 0xC0000005 (access violation) and 0xC0000409 (stack buffer overrun) are crashes, not the loader.
    expect(classifyLoadFailure({ exitCode: 0xc0000005, signal: null, stderr: '', platform: 'win32', systemDllExists: () => true })).toBeNull()
    expect(classifyLoadFailure({ exitCode: 0xc0000409, signal: null, stderr: '', platform: 'win32', systemDllExists: () => true })).toBeNull()
  })

  // #656: the strings above are hand-written. These are REAL b11146 start-failure tails (Windows, the
  // app's argv and stdio; paths → <drive>): a corrupt GGUF on the GPU and the CPU rung, a colour-coded
  // one, and a bad `--device`. Each names engine DLLs and drive paths, and none is a loader refusal —
  // neither where a spawn site classifies the tail nor where the session heal reads a stored error.
  it.each(['broken-gguf-gpu', 'broken-gguf-cpu', 'broken-gguf-gpu-coloured', 'bad-device'])(
    'returns null for the real b11146 start-failure tail "%s"',
    (name) => {
      const stderr = readFileSync(join(__dirname, '..', 'fixtures', `start-failure-b11146-${name}.txt`), 'utf8')
      const win = { platform: 'win32' as const, systemDllExists: () => true }
      expect(classifyLoadFailure({ exitCode: 1, signal: null, stderr, ...win })).toBeNull()
      const stored = `2026-10-03T16:26:00.000Z — llama-server exited before becoming healthy (code 1) — last output: ${stderr}`
      expect(classifyLoadFailureMessage(stored, win)).toBeNull()
    }
  )
})

describe('classifyLoadFailure — Windows (exit codes as Node reports them)', () => {
  const all = (): boolean => true

  it('a DLL not found with the Visual C++ runtime present = damaged engine files', () => {
    expect(classifyLoadFailure({ exitCode: 3221225781, signal: null, stderr: '', platform: 'win32', systemDllExists: all })).toEqual({
      reason: 'files-damaged',
      os: 'win',
      exit: 'exit code 0xC0000135'
    })
  })

  it.each([
    { absent: ['msvcp140.dll'], named: 'msvcp140.dll' },
    { absent: ['vcruntime140.dll'], named: 'vcruntime140.dll' },
    { absent: ['vcruntime140_1.dll'], named: 'vcruntime140_1.dll' },
    // No Redistributable at all: the first DLL in import order is named.
    { absent: ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'], named: 'msvcp140.dll' }
  ])('names $named as the missing Visual C++ runtime DLL when System32 lacks $absent', ({ absent, named }) => {
    const exists = (dll: string): boolean => !absent.includes(dll)
    expect(
      classifyLoadFailure({ exitCode: 3221225781, signal: null, stderr: '', platform: 'win32', systemDllExists: exists })
    ).toEqual({ reason: 'vc-runtime-missing', os: 'win', name: named, exit: 'exit code 0xC0000135' })
  })

  it('treats an entry point not found (measured) and a bad image format like a DLL not found', () => {
    for (const code of [3221225785, 0xc000007b]) {
      expect(classifyLoadFailure({ exitCode: code, signal: null, stderr: '', platform: 'win32', systemDllExists: all })?.reason).toBe('files-damaged')
      expect(classifyLoadFailure({ exitCode: code, signal: null, stderr: '', platform: 'win32', systemDllExists: () => false })?.reason).toBe('vc-runtime-missing')
    }
  })

  it('reads 0xC0E90002 as a code-integrity (Smart App Control) block — also from a signed exit code', () => {
    expect(classifyLoadFailure({ exitCode: 3236495362, signal: null, stderr: '', platform: 'win32' })).toEqual({
      reason: 'blocked',
      os: 'win',
      exit: 'exit code 0xC0E90002'
    })
    // PowerShell's $LASTEXITCODE form of the same status.
    expect(classifyLoadFailure({ exitCode: -1058471934, signal: null, stderr: '', platform: 'win32' })?.reason).toBe('blocked')
  })

  it('treats a throwing System32 check as "present" rather than failing the classification', () => {
    const boom = (): boolean => {
      throw new Error('EPERM')
    }
    expect(classifyLoadFailure({ exitCode: 3221225781, signal: null, stderr: '', platform: 'win32', systemDllExists: boom })?.reason).toBe('files-damaged')
  })
})

describe('classifyLoadFailure — macOS (dyld wording; not measured on hardware)', () => {
  it('an engine dylib that cannot be found = damaged engine files', () => {
    const stderr =
      'dyld[4242]: Library not loaded: @rpath/libggml-base.dylib\n  Referenced from: <ABC> /Volumes/HR/runtime/llama.cpp/mac/llama-server\n  Reason: tried: \'/Volumes/HR/runtime/llama.cpp/mac/libggml-base.dylib\' (no such file)\n'
    expect(classifyLoadFailure({ exitCode: null, signal: 'SIGABRT', stderr, platform: 'darwin' })).toEqual({
      reason: 'files-damaged',
      os: 'mac',
      name: 'libggml-base.dylib',
      exit: 'signal SIGABRT'
    })
  })

  it('a system library or symbol the OS lacks = a macOS too old', () => {
    expect(
      classifyLoadFailure({ exitCode: null, signal: 'SIGABRT', stderr: 'dyld[1]: Library not loaded: /usr/lib/libfoo.1.dylib\n', platform: 'darwin' })
    ).toMatchObject({ reason: 'system-too-old', name: 'libfoo.1.dylib' })
    expect(
      classifyLoadFailure({
        exitCode: null,
        signal: 'SIGABRT',
        stderr: 'dyld[1]: Symbol not found: __ZNSt3__1foo\n  Referenced from: <X> /Volumes/HR/llama-server\n  Expected in: <Y> /usr/lib/libc++.1.dylib\n',
        platform: 'darwin'
      })
    ).toMatchObject({ reason: 'system-too-old', name: '__ZNSt3__1foo' })
    expect(
      classifyLoadFailure({ exitCode: null, signal: 'SIGABRT', stderr: 'dyld: built for macOS 15.0 which is newer than running OS\n', platform: 'darwin' })
    ).toMatchObject({ reason: 'system-too-old' })
  })
})

describe('classifySpawnError / pathFreeSpawnError — the program never started', () => {
  // The `syscall` Node 24 sets (measured on Windows): `spawn <path>` on the 'error' event, `spawn` on a throw.
  const spawnErr = (code: string, syscall = 'spawn C:\\Kit\\runtime\\llama.cpp\\win\\llama-server.exe'): Error =>
    Object.assign(new Error(`spawn C:\\Kit\\runtime\\llama.cpp\\win\\llama-server.exe ${code}`), { code, syscall })

  it('on Windows, EPERM / UNKNOWN / EACCES (policy, security software, quarantine) are a block', () => {
    for (const code of ['EPERM', 'UNKNOWN', 'EACCES']) {
      expect(classifySpawnError(spawnErr(code), 'win32')).toEqual({ reason: 'blocked', os: 'win', exit: `spawn error ${code}` })
      expect(classifySpawnError(spawnErr(code, 'spawn'), 'win32')?.reason).toBe('blocked')
    }
  })

  it('says nothing for ENOENT, for other systems, for an error without a code, or for a failed kill', () => {
    expect(classifySpawnError(spawnErr('ENOENT'), 'win32')).toBeNull()
    expect(classifySpawnError(spawnErr('EACCES'), 'linux')).toBeNull()
    expect(classifySpawnError(new Error('boom'), 'win32')).toBeNull()
    expect(classifySpawnError(null, 'win32')).toBeNull()
    // A child's 'error' event also reports a kill() Windows refused: no verdict about running it.
    expect(classifySpawnError(Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }), 'win32')).toBeNull()
  })

  it('drops the absolute path Node writes into the message', () => {
    expect(pathFreeSpawnError(spawnErr('EACCES'))).toBe('spawn EACCES')
    expect(pathFreeSpawnError(new Error('spawn /media/someone/HR/llama-server EACCES'))).toBe('spawn EACCES')
  })
})

describe('EngineCannotRunError', () => {
  it('is path-free and carries the problem', () => {
    const problem = { family: 'llama_cpp' as const, reason: 'library-missing' as const, os: 'linux' as const, name: 'libgomp.so.1', exit: 'exit code 127' }
    const err = new EngineCannotRunError('llama-server', problem)
    expect(err.message).toBe('llama-server cannot run on this computer — a system library is missing: libgomp.so.1 (exit code 127)')
    expect(err.problem).toBe(problem)
    expect(isEngineCannotRunError(err)).toBe(true)
    expect(isEngineCannotRunError(new Error('llama-server cannot run on this computer'))).toBe(false)
  })
})

describe('the session verdict store', () => {
  const gomp = { family: 'llama_cpp' as const, reason: 'library-missing' as const, os: 'linux' as const, name: 'libgomp.so.1', exit: 'exit code 127' }

  it('notifies on a new or different verdict and on a clear — not on a repeat', () => {
    const listener = vi.fn()
    const off = onEngineProblemsChanged(listener)
    reportEngineProblem(gomp, LLAMA)
    reportEngineProblem(gomp, LLAMA) // the same refusal again (every spawn re-reports it)
    expect(listener).toHaveBeenCalledTimes(1)
    reportEngineProblem({ ...gomp, reason: 'system-too-old', name: 'GLIBC_2.34' }, LLAMA)
    expect(listener).toHaveBeenCalledTimes(2)
    clearEngineProblem('llama_cpp', 'started')
    clearEngineProblem('llama_cpp', 'started') // nothing left to clear
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    reportEngineProblem(gomp, LLAMA)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  // #532: a "files damaged" verdict about the program an install just put on the drive is about a
  // fresh, SHA-256-checked copy — the UI then stops offering yet another reinstall.
  it('after an install, marks a damaged-files verdict about the fresh program — and nothing else (#532)', () => {
    const damaged = { family: 'llama_cpp' as const, reason: 'files-damaged' as const, os: 'linux' as const, name: 'libllama.so', exit: 'exit code 127' }
    reportEngineProblem(damaged, LLAMA)
    const listener = vi.fn()
    onEngineProblemsChanged(listener)
    engineInstalled('llama_cpp', LLAMA)
    // The old copy's verdict no longer describes the new one; screens hear that it went.
    expect(engineProblemFor('llama_cpp')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    reportEngineProblem(damaged, LLAMA)
    expect(engineProblemFor('llama_cpp')).toEqual({ ...damaged, afterInstall: true })
    // The cpu/ safety net is another program, which the install left as it was.
    reportEngineProblem(damaged, LLAMA_CPU)
    expect(engineProblemFor('llama_cpp')).toEqual(damaged)
    // A refusal no reinstall can fix is reported as it is, fresh copy or not.
    reportEngineProblem(gomp, LLAMA)
    expect(engineProblemFor('llama_cpp')).toEqual(gomp)
    // Only the installed family: the voice engine's copy is not fresh.
    reportEngineProblem({ ...damaged, family: 'whisper_cpp' }, WHISPER)
    expect(engineProblemFor('whisper_cpp')?.afterInstall).toBeUndefined()
  })

  // A clear runs inside LlamaServer.start()'s healthy path (#654): a listener that throws there must not fail it.
  it('never lets a throwing listener break a report or a clear', () => {
    onEngineProblemsChanged(() => {
      throw new Error('boom')
    })
    onEngineProblemDropped(() => {
      throw new Error('boom')
    })
    expect(() => reportEngineProblem(gomp, LLAMA)).not.toThrow()
    expect(engineProblemFor('llama_cpp')).toEqual(gomp)
    expect(() => clearEngineProblemFor('llama_cpp', LLAMA)).not.toThrow()
    expect(engineProblemFor('llama_cpp')).toBeNull()
  })
})
