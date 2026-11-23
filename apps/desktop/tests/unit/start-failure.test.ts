import { describe, it, expect } from 'vitest'
import { startFailedState, startFailureFrom } from '../../src/main/services/start-failure'
import type { BackendStartFailure } from '../../src/shared/types'

// #1024: what the gate is told about a back-end start that threw. The state crosses to the renderer, so it carries a
// cause the gate words and the error's code, and nothing else: no message, no path, no free text a custom error put in
// its `code`. The integration rows (backend-start-failure.test.ts) drive real throws (a refused mkdir, a broken plaintext
// database) through the runner; this table holds the mapping for the codes no CI drive can produce (a read-only mount, a
// full drive, SQLite's read-only and full results).

/** A Node file error as `node:fs` builds it: an errno code, a system call, and a message naming the path. */
function fileError(code: string, syscall = 'mkdir'): Error {
  return Object.assign(new Error(`${code}: refused, ${syscall} 'C:\\Users\\someone\\drive\\logs'`), { code, syscall })
}

/** A `node:sqlite` error: Node's own code, and SQLite's result code and fixed text. */
function sqliteError(errcode: number): Error {
  return Object.assign(new Error('sqlite says no'), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'sqlite says no' })
}

describe('startFailureFrom: the cause the gate words, and the code it shows (#1024)', () => {
  it.each<[string, unknown, BackendStartFailure]>([
    ['an access rule that denies new folders (Windows)', fileError('EPERM'), { cause: 'drive_not_writable', code: 'EPERM' }],
    ['a folder mode without w (POSIX)', fileError('EACCES'), { cause: 'drive_not_writable', code: 'EACCES' }],
    ['a read-only mount', fileError('EROFS'), { cause: 'drive_not_writable', code: 'EROFS' }],
    ['a full drive', fileError('ENOSPC'), { cause: 'drive_full', code: 'ENOSPC' }],
    ['a full quota', fileError('EDQUOT'), { cause: 'drive_full', code: 'EDQUOT' }],
    ['a file where a folder should be', fileError('EEXIST'), { cause: 'other', code: 'EEXIST' }],
    ['a drive that is not there', fileError('ENOENT'), { cause: 'other', code: 'ENOENT' }],
    ['a disk error', fileError('EIO', 'open'), { cause: 'other', code: 'EIO' }],
    ['SQLite READONLY', sqliteError(8), { cause: 'drive_not_writable', code: 'SQLITE_8' }],
    ['SQLite READONLY, an extended code (8 | 1 << 8)', sqliteError(264), { cause: 'drive_not_writable', code: 'SQLITE_264' }],
    ['SQLite FULL', sqliteError(13), { cause: 'drive_full', code: 'SQLITE_13' }],
    ['SQLite NOTADB', sqliteError(26), { cause: 'other', code: 'SQLITE_26' }],
    ['SQLite CANTOPEN_ISDIR', sqliteError(526), { cause: 'other', code: 'SQLITE_526' }],
    ['a fault in the app', new TypeError("Cannot read properties of undefined (reading 'x')"), { cause: 'other', code: null }],
    ['a Node code from a fault', Object.assign(new TypeError('bad'), { code: 'ERR_INVALID_ARG_TYPE' }), { cause: 'other', code: 'ERR_INVALID_ARG_TYPE' }]
  ])('%s', (_label, err, expected) => {
    expect(startFailureFrom(err)).toEqual(expected)
  })

  // The `code` crosses to the renderer and is shown on the screen: only a code's own shape passes, so a custom error
  // that put a path, a sentence or a number in its `code` shows none.
  it.each<[string, unknown]>([
    ['a path', 'C:\\Users\\someone\\drive'],
    ['a sentence', 'the drive said no'],
    ['a lower-case word', 'eperm'],
    ['a number', 13],
    ['an errno shape that never ends', `E${'A'.repeat(200)}`]
  ])('a custom code that is %s shows none', (_label, code) => {
    expect(startFailureFrom(Object.assign(new Error('x'), { code }))).toEqual({ cause: 'other', code: null })
  })

  it.each<[string, unknown]>([
    ['a fraction', 8.5],
    ['a negative number', -8],
    ['a string', '8']
  ])('a SQLite result code that is %s is no SQLite error', (_label, errcode) => {
    expect(startFailureFrom(Object.assign(new Error('x'), { errcode }))).toEqual({ cause: 'other', code: null })
  })
})

describe('startFailedState: what getWorkspaceState answers in the failure state (#1024)', () => {
  it('is the start_failed state with the failure, and offers no plaintext workspace', () => {
    expect(startFailedState({ cause: 'drive_full', code: 'ENOSPC' })).toEqual({
      state: 'start_failed',
      mode: null,
      plaintextAllowed: false,
      encryptionRequired: true,
      startFailure: { cause: 'drive_full', code: 'ENOSPC' }
    })
  })
})
