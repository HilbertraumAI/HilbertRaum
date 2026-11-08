import { describe, expect, it } from 'vitest'
import { zimErrorClass } from '../../src/main/services/zim/error-class'
import { KiwixServeStartError } from '../../src/main/services/zim/serve'
import { KiwixManageError } from '../../src/main/services/zim/tools'

// #712: the one path-free describer every knowledge-pack log line uses (D-Z1's sentinel rule).
// Whatever the input, the output is built from a class, a kind and codes — never from a message,
// which for a Node fs/spawn error or a kiwix child's output names a path.

const PATH = 'C:\\Users\\XSENTINEL_712\\AppData\\Roaming\\HilbertRaum\\workspace\\zim-transient'

describe('zimErrorClass (#712)', () => {
  it.each([
    ['a start that exited', new KiwixServeStartError('exit', { exitCode: 1, output: 'library-unreadable' }), 'serve:exit:code 1:library-unreadable'],
    ['a start killed by a signal', new KiwixServeStartError('exit', { exitSignal: 'SIGSEGV' }), 'serve:exit:signal SIGSEGV'],
    ['a start that could not launch', new KiwixServeStartError('launch', { launchCode: 'ENOENT' }), 'serve:launch:ENOENT'],
    ['a start that timed out', new KiwixServeStartError('timeout', { timeoutMs: 20_000, output: 'unrecognised' }), 'serve:timeout:unrecognised'],
    ['a tampered binary', new KiwixServeStartError('integrity'), 'serve:integrity'],
    ['a manager failure', new KiwixManageError(`kiwix-manage exited — Cannot add ZIM ${PATH}\\a.zim`, 'exit', 'exited'), 'manage:exit'],
    // #787: a reconcile skips such a pack at every pass; the log names why, never the path.
    [
      'a manager failure over a path with no ASCII spelling',
      new KiwixManageError(`kiwix-manage exited — Cannot add ZIM ${PATH}\\Jürgen.zim`, 'exit', 'exited', null, true),
      'manage:exit:non-ascii-path'
    ],
    // …but only a tool that ran and refused, as `path-unsupported` reads it: a launch failure
    // (an antivirus refusing the exe) over the same path is not the path's.
    ['a manager that could not launch over such a path', new KiwixManageError('kiwix-manage failed to launch (EPERM)', 'spawn', 'exited', null, true), 'manage:spawn'],
    [
      'a Node system error',
      Object.assign(new Error(`EACCES: permission denied, mkdir '${PATH}'`), { code: 'EACCES', path: PATH }),
      'Error:EACCES'
    ],
    ['a code that is not an errno code', Object.assign(new Error(PATH), { code: PATH }), 'Error'],
    ['an abort', new DOMException('The knowledge-pack operation was cancelled', 'AbortError'), 'AbortError'],
    ['a subclass that never set its name', new (class DependencyError extends Error {})(PATH), 'DependencyError'],
    ['a programming error', new TypeError(`Cannot read properties of undefined (reading '${PATH}')`), 'TypeError'],
    ['a thrown string', PATH, 'unknown']
  ])('%s', (_name, err, expected) => {
    expect(zimErrorClass(err)).toBe(expected)
  })
})
