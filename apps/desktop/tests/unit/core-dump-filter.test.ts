import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { limitCoreDumps } from '../../src/main/services/core-dump-filter'

// #982 (part 2): on Linux a crash of the main process (a lost session's lock that overruns Electron's 10 s shutdown
// limit, or any fatal error) is a kernel core dump of the whole heap, the unlocked vault key included, and many hosts
// store it (systemd-coredump by default; a pipe handler ignores the core-size limit). A dump filter of 0 keeps every
// memory mapping out of it. The kernel's side is checked under WSL with a real Electron (follow-ups wave 6, lane P);
// these rows hold what the app writes, where, and when.

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

describe('limitCoreDumps (#982)', () => {
  it('on Linux writes 0 to the core dump filter of this process, once, and logs nothing', () => {
    const r = recorder()
    limitCoreDumps({ platform: 'linux', writeFile: r.writeFile, log: r.log })
    expect(r.writes).toEqual([['/proc/self/coredump_filter', '0']])
    expect(r.warnings).toEqual([])
  })

  it.each<NodeJS.Platform>(['win32', 'darwin'])('on %s touches nothing', (platform) => {
    const r = recorder()
    limitCoreDumps({ platform, writeFile: r.writeFile, log: r.log })
    expect(r.writes).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('a refused write is swallowed and logged once, by its code, without the path', () => {
    const r = recorder()
    const path = '/proc/self/coredump_filter'
    const refuse = () => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', syscall: 'open', path })
    }
    expect(() => limitCoreDumps({ platform: 'linux', writeFile: refuse, log: r.log })).not.toThrow()
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0][1]).toEqual({ code: 'EACCES' })
    expect(JSON.stringify(r.warnings)).not.toMatch(/coredump_filter|\/proc/)
  })

  // Source-text pin (idiom: window-security.test.ts): index.ts cannot be imported under vitest. The filter must be set
  // before any child is started, so every sidecar inherits it: a whole unindented line is module scope, and it comes
  // before the single-instance lock and the `ready` handler (inside a function it could run after either).
  it('index.ts calls it at module scope, before the single-instance lock and app.whenReady', () => {
    const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const call = 'limitCoreDumps({ platform: process.platform, writeFile: writeFileSync, log })'
    expect(src.split('\n')).toContain(call)
    expect(src.split('limitCoreDumps(').length - 1, 'called once').toBe(1)
    const at = src.indexOf(call)
    for (const later of ['app.requestSingleInstanceLock()', 'app.whenReady().then(']) {
      expect(src.indexOf(later), later).toBeGreaterThan(0)
      expect(at, `before ${later}`).toBeLessThan(src.indexOf(later))
    }
  })
})
