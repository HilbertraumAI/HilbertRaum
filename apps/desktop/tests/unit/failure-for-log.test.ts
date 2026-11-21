import { describe, it, expect } from 'vitest'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { causeFailure, failureForLog } from '../../src/main/services/failure-for-log'
import { tempRoot } from '../helpers/db-fixtures'

// #956: the one rule every workspace and quit failure line follows (registerWorkspaceIpc's arms, shutdown.ts's, the
// VaultLockError cause). A file error's message names the drive's or the profile's paths, and app.log is what
// Diagnostics → Copy and Save log hand out, so it logs its kind, code and bare system call only; any other error keeps
// its message. The arms' wiring is held at their boundaries (workspace-ipc, vault-recovery-guards, shutdown); these
// rows hold the rule.

const ROOT = 'C:\\Users\\someone\\AppData\\Local\\Temp\\hr-956\\workspace'

/** What Node throws for a file operation: code, syscall, path, and a message naming the path. */
function nodeFileError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failed, ${syscall} '${path}'`), { code, syscall, path, errno: -1 })
}

/** The line a log call writes for these fields: what must not carry the path. */
const logged = (fields: Record<string, unknown>): string => JSON.stringify(fields)

describe('failureForLog (#956)', () => {
  it('a Node file error logs its kind, code and system call, never its message or path', () => {
    const fields = failureForLog(nodeFileError('EISDIR', 'open', `${ROOT}\\hilbertraum.sqlite.enc.tmp`))
    expect(fields).toEqual({ error: 'Error', code: 'EISDIR', syscall: 'open' })
    expect(logged(fields)).not.toContain('hr-956')
  })

  // N-8: an error built with only an errno code (a wrapper, a rethrow that kept `code`) still carries the path in its
  // message; before #956 only a `syscall`, `path` or `dest` marked a file error.
  it('an errno code alone makes a file error (N-8)', () => {
    const err = Object.assign(new Error(`EPERM: operation not permitted, rename '${ROOT}\\x.enc.new'`), { code: 'EPERM' })
    expect(failureForLog(err)).toEqual({ error: 'Error', code: 'EPERM', syscall: null })
  })

  // Security review V S-2: Node's own `ERR_FS_*` errors are file errors too. A real one from `cpSync` carries no
  // `syscall`, `path` or `dest`, and its message names the source and the target ("Cannot copy … to a subdirectory of
  // self …").
  it('a Node ERR_FS_* error (a real cpSync refusal) logs its code, never its message or path', () => {
    const root = tempRoot('failure-for-log')
    const dir = join(root, 'copied-folder')
    mkdirSync(dir)
    writeFileSync(join(dir, 'f'), 'f')
    let err: unknown = null
    try {
      cpSync(dir, join(dir, 'sub'), { recursive: true })
    } catch (caught) {
      err = caught
    }
    expect((err as NodeJS.ErrnoException | null)?.code).toBe('ERR_FS_CP_EINVAL')
    const fields = failureForLog(err)
    expect(fields).toEqual({ error: (err as Error).name, code: 'ERR_FS_CP_EINVAL', syscall: null })
    expect(logged(fields)).not.toContain('copied-folder')
    expect(logged(fields)).not.toContain(basename(root))
  })

  // A spawn error's `syscall` is `spawn <binary path>` (runtime/sidecar.ts `errnoCode`): only a bare name is kept.
  it('a system call that is not a bare name is dropped (a spawn error names the binary)', () => {
    const err = nodeFileError('ENOENT', `spawn ${ROOT}\\runtime\\llama-server.exe`, `${ROOT}\\runtime\\llama-server.exe`)
    const fields = failureForLog(err)
    expect(fields).toEqual({ error: 'Error', code: 'ENOENT', syscall: null })
    expect(logged(fields)).not.toContain('hr-956')
  })

  // Node's own `ERR_*` codes are no errno codes: SQLite's error keeps its message (SQLite's fixed text) with its result
  // code and description, as #844's create row reads them.
  it('a SQLite error is no file error: its message, code and SQLite description stay', () => {
    const full = Object.assign(new Error('database or disk is full'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 13,
      errstr: 'database or disk is full'
    })
    expect(failureForLog(full)).toEqual({
      error: 'Error',
      message: 'database or disk is full',
      code: 'ERR_SQLITE_ERROR',
      sqliteCode: 13,
      sqlite: 'database or disk is full'
    })
  })

  it('any other error keeps its kind and message (a bug in a later step must still say what went wrong)', () => {
    const cause = "Cannot read properties of undefined (reading 'lastBenchmark')"
    expect(failureForLog(new TypeError(cause))).toMatchObject({ error: 'TypeError', message: cause })
  })

  // S-5: a content-free error that carries what caused it (VaultLockError, #844's VaultOpenFailedError) logs that, and
  // the cause's message, which named the path, is nowhere in the line.
  it('an error carrying a content-free failure logs it, never the cause’s message', () => {
    const lockError = Object.assign(new Error('Could not lock the workspace'), {
      name: 'VaultLockError',
      failure: causeFailure(nodeFileError('ENOSPC', 'write', `${ROOT}\\hilbertraum.sqlite.enc.tmp`))
    })
    const fields = failureForLog(lockError)
    expect(fields).toMatchObject({ error: 'VaultLockError', code: 'ENOSPC', syscall: 'write' })
    expect(logged(fields)).not.toContain('hr-956')
  })
})
