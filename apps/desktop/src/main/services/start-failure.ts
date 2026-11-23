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
const FULL = new Set(['ENOSPC', 'EDQUOT'])
/** SQLite's primary result codes (`errcode & 0xff`) for the plaintext dev workspace's open. */
const SQLITE_READONLY = 8
const SQLITE_FULL = 13

/** The cause and the code of a thrown value (any value: a start can throw anything). */
export function startFailureFrom(err: unknown): BackendStartFailure {
  const e = typeof err === 'object' && err !== null ? (err as { code?: unknown; errcode?: unknown }) : null
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
  const cause: StartFailureCause =
    code !== null && NOT_WRITABLE.has(code) ? 'drive_not_writable' : code !== null && FULL.has(code) ? 'drive_full' : 'other'
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
