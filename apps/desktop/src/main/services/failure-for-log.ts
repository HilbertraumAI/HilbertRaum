// What a failure log line may say about an error (#956). Electron-free, so the workspace IPC, the quit teardown
// (`main/shutdown.ts`) and the vault's own `VaultLockError` share one rule, and a unit test can hold it without IPC.
//
// A file error's message names absolute paths (the drive's, the user profile's: `EISDIR: illegal operation on a
// directory, open 'C:\Users\…\hilbertraum.sqlite.enc.tmp'`), and app.log is what Diagnostics → Copy and Save log
// hand out. So a file error logs only its kind, code and system call. Any other error keeps its message: a bug in a
// post-unlock step, a `TypeError`, must still say what went wrong (#807 review round).

/** The fields of a thrown value this module reads. */
type ErrorFields = {
  name?: unknown
  message?: unknown
  code?: unknown
  syscall?: unknown
  path?: unknown
  dest?: unknown
  errcode?: unknown
  errstr?: unknown
  failure?: unknown
} | null

/** A Node errno code (`ENOENT`, `EPERM`, `EISDIR`, `ENOSPC`, …). Node's own `ERR_*` codes are not errno codes: an
 *  `ERR_SQLITE_ERROR` keeps its message and SQLite's fixed description. */
const ERRNO_CODE = /^E[A-Z0-9]+$/

/** Node's own file-system codes (`ERR_FS_EISDIR`, `ERR_FS_CP_EINVAL`, …): security review V S-2, a `cpSync` error
 *  carries one with no `syscall`, `path` or `dest`, and its message names both paths. Only this family: every other
 *  `ERR_*` (`ERR_SQLITE_ERROR`) keeps its message. */
const NODE_FS_CODE = /^ERR_FS_[A-Z0-9_]+$/

/** A bare system-call name (`open`, `rename`, `copyfile`, `scandir`). A spawn error's `syscall` is `spawn <binary
 *  path>`, so anything else is dropped. */
const BARE_SYSCALL = /^[a-z_]+$/

/** The error's system call when it is a bare name, else null (#956: a spawn error's names the binary's path). */
export function bareSyscall(syscall: unknown): string | null {
  return typeof syscall === 'string' && BARE_SYSCALL.test(syscall) ? syscall : null
}

/**
 * True for a Node file or system error: one carrying a `syscall`, a `path` or a `dest`, an errno code (N-8: an error
 * built with only `code: 'EPERM'` still has the path in its message), or a Node `ERR_FS_*` code.
 */
export function isFileError(err: unknown): boolean {
  const e = err as ErrorFields
  if (e == null || typeof e !== 'object') return false
  if (e.syscall !== undefined || e.path !== undefined || e.dest !== undefined) return true
  return typeof e.code === 'string' && (ERRNO_CODE.test(e.code) || NODE_FS_CODE.test(e.code))
}

/**
 * The log fields for a failure (#807, #956). A file error: `{ error, code, syscall }`, never its message (`syscall`
 * only as a bare name). An error that carries its own content-free `failure` (#844's `VaultOpenFailedError`, #956's
 * `VaultLockError`): its kind, its fixed message and that `failure`. Anything else: its kind, its message, its code,
 * and SQLite's result code and fixed description when it has them.
 */
export function failureForLog(err: unknown): Record<string, unknown> {
  const e = err as ErrorFields
  const kind = typeof e?.name === 'string' ? e.name : typeof err
  const code = typeof e?.code === 'string' ? e.code : null
  if (isFileError(err)) return { error: kind, code, syscall: bareSyscall(e?.syscall) }
  const message = err instanceof Error ? err.message : String(err)
  if (e?.failure && typeof e.failure === 'object') return { error: kind, message, ...e.failure }
  return {
    error: kind,
    message,
    code,
    sqliteCode: typeof e?.errcode === 'number' ? e.errcode : null,
    sqlite: typeof e?.errstr === 'string' ? e.errstr : null
  }
}

/**
 * {@link failureForLog} for the lines that log whatever was thrown (#1024 review L-1, L-3): the back end's start, the
 * uncaught exception, the unhandled rejection. It never throws: `failureForLog` falls back to `String(err)`, which throws
 * for an object with no prototype, and reading a `code` getter may throw too. Then the line says only that the error
 * could not be read, so a start still gets its failure state and the crash handler still reaches its emergency lock.
 */
export function safeFailureForLog(err: unknown): Record<string, unknown> {
  try {
    return failureForLog(err)
  } catch {
    return { error: 'unreadable' }
  }
}

/** What a content-free error keeps of its cause (`VaultLockError`, #956 S-5): never the cause's message. */
export interface CauseFailure {
  /** The cause's `name` (`Error`, `LockStoppedError`, …), or its `typeof`. */
  kind: string
  /** Its Node error code (`ENOSPC`, `EPERM`, `ERR_SQLITE_ERROR`, …), or null. */
  code: string | null
  /** Its system call, as a bare name only (see {@link bareSyscall}), or null. */
  syscall: string | null
  /** SQLite's result code and fixed description, when the cause is a SQLite error. */
  sqliteCode: number | null
  sqlite: string | null
}

/** The content-free part of `cause`: what failed, never the message (which names paths, or quotes what was read). */
export function causeFailure(cause: unknown): CauseFailure {
  const c = cause as ErrorFields
  return {
    kind: typeof c?.name === 'string' ? c.name : typeof cause,
    code: typeof c?.code === 'string' ? c.code : null,
    syscall: bareSyscall(c?.syscall),
    sqliteCode: typeof c?.errcode === 'number' ? c.errcode : null,
    sqlite: typeof c?.errstr === 'string' ? c.errstr : null
  }
}
