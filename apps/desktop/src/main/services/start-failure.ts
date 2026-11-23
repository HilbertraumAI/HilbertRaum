import type { BackendStartFailure, StartFailureCause, WorkspaceStateInfo } from '../../shared/types'

// #1024: what the gate is told about a back-end start that threw. Electron-free, so the runner (`main/backend-start.ts`)
// and a unit test share one rule.
//
// The state crosses to the renderer and its code is shown on the screen, so it carries a cause the gate words and the
// error's code, and nothing else. Never the message: a Node file error's names the drive's paths (`EPERM: operation not
// permitted, mkdir 'D:\logs'`), the #956 rule. Never free text either: a custom error may put anything in its `code`.

/** The codes the screen may show: an errno code (`EPERM`) or a Node code (`ERR_INVALID_ARG_TYPE`), and short. */
const SHOWN_CODE = /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/
const SHOWN_CODE_MAX = 40

/** The drive refused the write: an access rule that denies new folders (`EPERM` on Windows), a folder mode without write
 *  (`EACCES` on POSIX), a read-only mount (`EROFS`). At the start these come from `mkdir` (`ensureWorkspaceDirs`): the
 *  encrypted workspace's start steps absorb their own file errors (#242, #911, #1015). */
const NOT_WRITABLE = new Set(['EROFS', 'EPERM', 'EACCES'])
/** #1024 CR-2: the system calls a refusal above counts as a refused write for. EPERM and EACCES say "refused", not
 *  "refused to write": a refused program start (`spawnSync <path>`) or listing (`scandir`) is "something else", whose
 *  text does not point at a lock switch. `open` stays in: a Node error does not carry the open flags, so a refused read
 *  and a refused write look the same, and the start's writes are what the text is for. No system call at all (an error
 *  built with the code alone) stays in too. */
const WRITE_SYSCALLS = new Set(['mkdir', 'rename', 'write', 'unlink', 'rmdir', 'copyfile', 'symlink', 'open'])
const FULL = new Set(['ENOSPC', 'EDQUOT'])
/** SQLite's primary result codes (`errcode & 0xff`) for the plaintext dev workspace's open. #1024 CR-4, a deliberate
 *  choice: CANTOPEN (14) stays "something else". It is also a folder at the database's name, a missing folder or a lock
 *  file SQLite cannot create, so it does not prove a drive that refuses writing. */
const SQLITE_READONLY = 8
const SQLITE_FULL = 13

/** The cause and the code of a thrown value (any value: a start can throw anything). */
export function startFailureFrom(err: unknown): BackendStartFailure {
  const e =
    typeof err === 'object' && err !== null ? (err as { code?: unknown; errcode?: unknown; syscall?: unknown }) : null
  const errcode = e?.errcode
  // A `node:sqlite` error's `code` is always `ERR_SQLITE_ERROR`, which tells nobody anything: show SQLite's own number.
  if (typeof errcode === 'number' && Number.isInteger(errcode) && errcode >= 0 && errcode <= 0xffff) {
    const primary = errcode & 0xff
    const cause: StartFailureCause =
      primary === SQLITE_READONLY ? 'drive_not_writable' : primary === SQLITE_FULL ? 'drive_full' : 'other'
    return { cause, code: `SQLITE_${errcode}` }
  }
  const raw = e?.code
  const code = typeof raw === 'string' && raw.length <= SHOWN_CODE_MAX && SHOWN_CODE.test(raw) ? raw : null
  const syscall = e?.syscall
  const aWrite = syscall === undefined || syscall === null || (typeof syscall === 'string' && WRITE_SYSCALLS.has(syscall))
  const cause: StartFailureCause =
    code !== null && NOT_WRITABLE.has(code) && aWrite
      ? 'drive_not_writable'
      : code !== null && FULL.has(code)
        ? 'drive_full'
        : 'other'
  return { cause, code }
}

/** What `getWorkspaceState` answers in the failure state. The other fields fail closed: nothing in this state may offer
 *  a plaintext workspace. */
export function startFailedState(failure: BackendStartFailure): WorkspaceStateInfo {
  return {
    state: 'start_failed',
    mode: null,
    plaintextAllowed: false,
    encryptionRequired: true,
    startFailure: { cause: failure.cause, code: failure.code }
  }
}
