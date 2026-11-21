import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { limitCoreDumps, reportCoreDumpLimit } from '../../src/main/services/core-dump-filter'

// #982 (part 2): on Linux a crash of the main process (a lost session's lock that overruns Electron's 10 s shutdown
// limit, or any fatal error) is a kernel core dump of the whole heap, the unlocked vault key included, and many hosts
// store it (systemd-coredump by default; a pipe handler ignores the core-size limit). A dump filter of 0 keeps every
// memory mapping out of it. The kernel's side is checked under WSL with a real Electron (follow-ups wave 6, lane P);
// these rows hold what the app writes, where, and when, and how a refusal is reported.

function recorder() {
  const writes: Array<[string, string]> = []
  const warnings: Array<[string, unknown]> = []
  return {
    writes,
    warnings,
    writeFile: (path: string, data: string) => void writes.push([path, data]),
    log: { warn: (message: string, meta?: unknown) => void warnings.push([message, meta]) }
  }
}

/** What Node throws when the write is refused: an errno code, the system call, and a message naming the path. */
function refusal(code: unknown) {
  const path = '/proc/self/coredump_filter'
  return () => {
    throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code, syscall: 'open', path })
  }
}

describe('limitCoreDumps (#982)', () => {
  it('on Linux writes 0 to the core dump filter of this process, once', () => {
    const r = recorder()
    expect(limitCoreDumps({ platform: 'linux', writeFile: r.writeFile })).toEqual({ status: 'limited' })
    expect(r.writes).toEqual([['/proc/self/coredump_filter', '0']])
  })

  it.each<NodeJS.Platform>(['win32', 'darwin'])('on %s touches nothing', (platform) => {
    const r = recorder()
    expect(limitCoreDumps({ platform, writeFile: r.writeFile })).toEqual({ status: 'not-linux' })
    expect(r.writes).toEqual([])
  })

  // Review round 1 (F4): only an errno-shaped code is kept; anything else (a code that carries a path) becomes null.
  it.each<[string, unknown, string | null]>([
    ['an errno code', 'EACCES', 'EACCES'],
    ['a code that carries a path', "open '/proc/self/coredump_filter'", null],
    ['no code', undefined, null]
  ])('a refused write is swallowed and returned as failed with %s kept as its code only', (_case, code, kept) => {
    let result: ReturnType<typeof limitCoreDumps> | undefined
    expect(() => (result = limitCoreDumps({ platform: 'linux', writeFile: refusal(code) }))).not.toThrow()
    expect(result).toEqual({ status: 'failed', code: kept })
  })
})

// Review round 1 (F2): the filter runs before logging exists, and `initLogging` starts an empty buffer, so a line
// logged then never reached app.log. The outcome is kept and reported once, after `initLogging`.
describe('reportCoreDumpLimit (#982)', () => {
  it('a failure logs one line with its code, never the path', () => {
    const r = recorder()
    reportCoreDumpLimit({ status: 'failed', code: 'EACCES' }, r.log)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0][1]).toEqual({ code: 'EACCES' })
    expect(JSON.stringify(r.warnings)).not.toMatch(/coredump_filter|\/proc/)
  })

  it.each([{ status: 'limited' as const }, { status: 'not-linux' as const }])('$status logs nothing', (limit) => {
    const r = recorder()
    reportCoreDumpLimit(limit, r.log)
    expect(r.warnings).toEqual([])
  })
})

// Source-text pins (idiom: window-security.test.ts): index.ts cannot be imported under vitest.
describe('index.ts wiring (#982)', () => {
  const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')

  // The filter must be set before any child is started, so every sidecar inherits it: a whole unindented line is module
  // scope, and it comes before the single-instance lock and the `ready` handler (inside a function it could run after
  // either).
  it('index.ts calls it at module scope, before the single-instance lock and app.whenReady', () => {
    const call = 'const coreDumpLimit = limitCoreDumps({ platform: process.platform, writeFile: writeFileSync })'
    expect(src.split('\n')).toContain(call)
    expect(src.split('limitCoreDumps(').length - 1, 'called once').toBe(1)
    const at = src.indexOf(call)
    for (const later of ['app.requestSingleInstanceLock()', 'app.whenReady().then(']) {
      expect(src.indexOf(later), later).toBeGreaterThan(0)
      expect(at, `before ${later}`).toBeLessThan(src.indexOf(later))
    }
  })

  it('index.ts reports the outcome once, in initBackend, after initLogging', () => {
    const start = src.indexOf('function initBackend(')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    const report = '\n  reportCoreDumpLimit(coreDumpLimit, log)\n'
    expect(src.split('reportCoreDumpLimit(').length - 1, 'reported once').toBe(1)
    expect(body.indexOf(report), 'inside initBackend').toBeGreaterThan(0)
    expect(body.indexOf('\n  initLogging(paths.logsPath)\n'), 'initLogging in initBackend').toBeGreaterThan(0)
    expect(body.indexOf(report), 'after initLogging').toBeGreaterThan(body.indexOf('\n  initLogging(paths.logsPath)\n'))
  })
})
