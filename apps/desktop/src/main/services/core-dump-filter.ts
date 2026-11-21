// #982 (part 2): keep the workspace key out of a Linux crash file. Electron-free, so a unit test holds it.
//
// Electron's main process runs no crash reporter until JS starts one (the app never does), so a crash there is a
// kernel core dump: a memory image of the whole process, the unlocked vault key and decrypted database pages
// included. A lost session's lock that overruns Electron's fixed 10 s shutdown limit ends in exactly such a crash
// (#982), and so does any other fatal error. Many hosts store that image: systemd-coredump (Fedora, Arch) keeps a full
// core by default, because systemd raises the core-size limit to unlimited for what it starts, and a pipe handler
// (`core_pattern` = `|…`, as under WSL) ignores that limit anyway (core(5)).
//
// `/proc/self/coredump_filter` set to 0 tells the kernel to dump no memory mappings at all, anonymous or file-backed:
// no V8 heap, no malloc arena, no mapped database. The kernel applies it to file and pipe dumps alike, so it holds
// against every handler, and a child inherits it across fork and exec, so every sidecar the app starts later
// (llama-server, whisper-cli, kiwix-serve) is covered too. What a dump still holds: its own headers, every thread's
// registers, the paths of mapped files, the first 80 characters of the command line, and the vdso, which the kernel
// always dumps. Not covered: the zygotes, which Electron starts before the main script runs, and what they fork (the
// renderers and, measured under WSL, the GPU process). They hold no vault key, but a renderer can hold the workspace
// password typed into the unlock field (and the password opens the workspace), the text its window showed, and, in
// the hidden helper windows (the OCR rasterizer, the evidence-pack print window), decrypted document pages that were
// never shown.
//
// Called once, as the first statement of the main entry (`main/index.ts`), before `app.whenReady`. A failure costs
// only this protection, so the app goes on and keeps the outcome: logging does not exist yet (`initLogging` starts an
// empty buffer), so `initBackend` reports it once after `initLogging` (`reportCoreDumpLimit`), by the error's code,
// never the path.

/** The path the kernel reads the calling process's dump filter from (core(5)). */
const CORE_DUMP_FILTER = '/proc/self/coredump_filter'

/** A Node errno code (`EACCES`, `ENOENT`, …): the only part of the error the outcome keeps. */
const ERRNO_CODE = /^E[A-Z0-9]+$/

export interface CoreDumpFilterDeps {
  platform: NodeJS.Platform
  writeFile: (path: string, data: string) => void
}

/** What `limitCoreDumps` did: set the filter, had nothing to do (not Linux), or was refused (errno code or null). */
export type CoreDumpLimit = { status: 'limited' } | { status: 'not-linux' } | { status: 'failed'; code: string | null }

/** On Linux, set this process's core dump filter to 0 (dump no memory mappings). Every other platform: nothing. */
export function limitCoreDumps(deps: CoreDumpFilterDeps): CoreDumpLimit {
  if (deps.platform !== 'linux') return { status: 'not-linux' }
  try {
    deps.writeFile(CORE_DUMP_FILTER, '0')
    return { status: 'limited' }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    return { status: 'failed', code: typeof code === 'string' && ERRNO_CODE.test(code) ? code : null }
  }
}

/** Log a refused filter once, content-free (its errno code only); a set filter or another platform logs nothing. */
export function reportCoreDumpLimit(
  limit: CoreDumpLimit,
  log: { warn: (message: string, meta?: unknown) => void }
): void {
  if (limit.status === 'failed') log.warn('Startup: crash dumps could not be limited', { code: limit.code })
}
