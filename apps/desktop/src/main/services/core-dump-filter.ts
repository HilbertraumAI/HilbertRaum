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
// always dumps. Not covered: the zygote and the renderers, which Electron starts before the main script runs.
//
// Called once, as the first statement of the main entry (`main/index.ts`), before `app.whenReady`. A failure costs
// only this protection, so it is logged (the error's code, never the path) and the app goes on.

/** The path the kernel reads the calling process's dump filter from (core(5)). */
const CORE_DUMP_FILTER = '/proc/self/coredump_filter'

/** A Node errno code (`EACCES`, `ENOENT`, …): the only part of the error the log line keeps. */
const ERRNO_CODE = /^E[A-Z0-9]+$/

export interface CoreDumpFilterDeps {
  platform: NodeJS.Platform
  writeFile: (path: string, data: string) => void
  log: { warn: (message: string, meta?: unknown) => void }
}

/** On Linux, set this process's core dump filter to 0 (dump no memory mappings). Every other platform: nothing. */
export function limitCoreDumps(deps: CoreDumpFilterDeps): void {
  if (deps.platform !== 'linux') return
  try {
    deps.writeFile(CORE_DUMP_FILTER, '0')
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    deps.log.warn('Startup: crash dumps could not be limited', {
      code: typeof code === 'string' && ERRNO_CODE.test(code) ? code : null
    })
  }
}
