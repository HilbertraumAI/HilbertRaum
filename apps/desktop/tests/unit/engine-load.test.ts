import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EngineCannotRunError,
  classifyLoadFailure,
  classifyLoadFailureMessage,
  classifySpawnError,
  clearEngineProblem,
  clearEngineProblemFor,
  pathFreeSpawnError,
  describeExit,
  describeLoadFailure,
  engineProblemFor,
  engineProblemReportedSince,
  engineProblemSeq,
  engineProblems,
  isEngineCannotRunError,
  onEngineProblemsChanged,
  reportEngineProblem,
  resetEngineProblemsForTest,
  VC_RUNTIME_DLLS
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

  it('names the first missing Visual C++ runtime DLL when System32 lacks one', () => {
    const exists = (dll: string): boolean => dll !== 'vcruntime140_1.dll'
    expect(classifyLoadFailure({ exitCode: 3221225781, signal: null, stderr: '', platform: 'win32', systemDllExists: exists })).toEqual({
      reason: 'vc-runtime-missing',
      os: 'win',
      name: 'vcruntime140_1.dll',
      exit: 'exit code 0xC0000135'
    })
    expect(VC_RUNTIME_DLLS).toEqual(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
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
  const spawnErr = (code: string): Error =>
    Object.assign(new Error(`spawn C:\\Kit\\runtime\\llama.cpp\\win\\llama-server.exe ${code}`), { code })

  it('on Windows, EPERM / UNKNOWN / EACCES (policy, security software, quarantine) are a block', () => {
    for (const code of ['EPERM', 'UNKNOWN', 'EACCES']) {
      expect(classifySpawnError(spawnErr(code), 'win32')).toEqual({ reason: 'blocked', os: 'win', exit: `spawn error ${code}` })
    }
  })

  it('says nothing for ENOENT, for other systems, or for an error without a code', () => {
    expect(classifySpawnError(spawnErr('ENOENT'), 'win32')).toBeNull()
    expect(classifySpawnError(spawnErr('EACCES'), 'linux')).toBeNull()
    expect(classifySpawnError(new Error('boom'), 'win32')).toBeNull()
    expect(classifySpawnError(null, 'win32')).toBeNull()
  })

  it('drops the absolute path Node writes into the message', () => {
    expect(pathFreeSpawnError(spawnErr('EACCES'))).toBe('spawn EACCES')
    expect(pathFreeSpawnError(new Error('spawn /media/someone/HR/llama-server EACCES'))).toBe('spawn EACCES')
  })
})

describe('describeExit / describeLoadFailure', () => {
  it('formats POSIX codes in decimal, NTSTATUS in hex, signals by name', () => {
    expect(describeExit(127, null)).toBe('exit code 127')
    expect(describeExit(3221225781, null)).toBe('exit code 0xC0000135')
    expect(describeExit(null, 'SIGABRT')).toBe('signal SIGABRT')
    expect(describeExit(null, null)).toBe('no exit status')
  })

  it('reads as one path-free English line', () => {
    expect(describeLoadFailure({ reason: 'library-missing', os: 'linux', name: 'libgomp.so.1', exit: 'exit code 127' })).toBe(
      'a system library is missing: libgomp.so.1 (exit code 127)'
    )
  })
})

describe('classifyLoadFailureMessage — healing state written before #530', () => {
  it('recognises the embedder/ladder message shape that rows and gpuLastError stored', () => {
    const stored = `llama-server exited before becoming healthy (code 127) — last output: ${missing(LLAMA, 'libgomp.so.1').trim()}`
    expect(classifyLoadFailureMessage(stored, linux)).toMatchObject({ reason: 'library-missing', name: 'libgomp.so.1', exit: 'exit code 127' })
    // gpuLastError carries an ISO timestamp first.
    expect(classifyLoadFailureMessage(`2026-10-01T07:00:00.000Z — ${stored}`, linux)?.reason).toBe('library-missing')
    // The Windows shape carries no tail at all — the code decides.
    expect(
      classifyLoadFailureMessage('llama-server exited before becoming healthy (code 3221225781)', { platform: 'win32', systemDllExists: () => true })?.reason
    ).toBe('files-damaged')
  })

  it('leaves a genuine GPU or model failure alone', () => {
    expect(
      classifyLoadFailureMessage(
        'llama-server exited before becoming healthy (code 1) — last output: ggml_vulkan: Device memory allocation of size 123 failed.',
        linux
      )
    ).toBeNull()
    expect(classifyLoadFailureMessage('llama-server did not become healthy within 180000ms', linux)).toBeNull()
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
  const voice = { ...gomp, family: 'whisper_cpp' as const }

  it('lists the chat engine first and clears per family', () => {
    reportEngineProblem(voice)
    reportEngineProblem(gomp)
    expect(engineProblems().map((p) => p.family)).toEqual(['llama_cpp', 'whisper_cpp'])
    clearEngineProblem('llama_cpp')
    expect(engineProblemFor('llama_cpp')).toBeNull()
    expect(engineProblemFor('whisper_cpp')).toEqual(voice)
  })

  it('notifies on a new or different verdict and on a clear — not on a repeat', () => {
    const listener = vi.fn()
    const off = onEngineProblemsChanged(listener)
    reportEngineProblem(gomp)
    reportEngineProblem(gomp) // the same refusal again (every spawn re-reports it)
    expect(listener).toHaveBeenCalledTimes(1)
    reportEngineProblem({ ...gomp, reason: 'system-too-old', name: 'GLIBC_2.34' })
    expect(listener).toHaveBeenCalledTimes(2)
    clearEngineProblem('llama_cpp')
    clearEngineProblem('llama_cpp') // nothing left to clear
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    reportEngineProblem(gomp)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('tells "Check again" whether a refusal landed after it began, even an identical one', () => {
    reportEngineProblem(gomp)
    const seq = engineProblemSeq()
    expect(engineProblemReportedSince('llama_cpp', seq)).toBe(false)
    reportEngineProblem(gomp)
    expect(engineProblemReportedSince('llama_cpp', seq)).toBe(true)
  })

  it('a healthy start of the SAME program clears its verdict; another program of the family does not', () => {
    reportEngineProblem(gomp, '/k/runtime/llama.cpp/win/llama-server.exe')
    // A Windows Kit's cpu/ build runs beside a damaged main folder: the verdict stays.
    clearEngineProblemFor('llama_cpp', '/k/runtime/llama.cpp/win/cpu/llama-server.exe')
    expect(engineProblemFor('llama_cpp')).toEqual(gomp)
    // The refused program itself now runs (an intermittent block that went away): stale, dropped.
    clearEngineProblemFor('llama_cpp', '/k/runtime/llama.cpp/win/llama-server.exe')
    expect(engineProblemFor('llama_cpp')).toBeNull()
    // A verdict reported without a program path is never cleared this way.
    reportEngineProblem(gomp)
    clearEngineProblemFor('llama_cpp', '/k/runtime/llama.cpp/win/llama-server.exe')
    expect(engineProblemFor('llama_cpp')).toEqual(gomp)
  })

  it('never lets a throwing listener break a report', () => {
    onEngineProblemsChanged(() => {
      throw new Error('boom')
    })
    expect(() => reportEngineProblem(gomp)).not.toThrow()
    expect(engineProblemFor('llama_cpp')).toEqual(gomp)
  })
})
