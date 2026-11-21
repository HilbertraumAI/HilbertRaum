import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #975 review round 2 (F8, F9): the exit redaction names the known folders only if the main process registers them,
// and nothing else in the suite would notice a registration that went missing (core-model-ipc.test.ts registers its
// own roots): every exit would quietly fall back to the generic shapes. A source-text wiring pin, as for the other
// `index.ts` call sites (answer-speed-wiring.test.ts): index.ts pulls in the whole Electron main process and cannot be
// imported under vitest.
//
// What it holds:
// - the roots that do not depend on the drive (app data, home, temp, the app's folders, the account) are registered at
//   the module's top level, before the single-instance lock and so before anything in the start can log or fail;
// - the drive root is ADDED (not a replacing call) right after `resolvePaths`, before `ensureWorkspaceDirs` and
//   `initLogging`, so a start that fails on the drive still has every other root.

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const indexSrc = stripComments(readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8'))

/** The argument text of the first `name(` call at or after `from`, or null. */
function callArgs(src: string, name: string, from = 0): { at: number; args: string } | null {
  const at = src.indexOf(`${name}(`, from)
  if (at === -1) return null
  let depth = 0
  for (let i = at + name.length; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return { at, args: src.slice(at + name.length + 1, i) }
  }
  return null
}

describe('wiring pin: index.ts registers the log redaction roots early (#975)', () => {
  it('the drive-independent roots are registered at the top level, before the single-instance lock', () => {
    const early = callArgs(indexSrc, 'setLogRedactionRoots')
    expect(early).not.toBeNull()
    for (const key of ['appData', 'home', 'temp', 'app', 'account']) expect(early?.args).toMatch(new RegExp(`\\b${key}\\s*:`))
    expect(early?.args).not.toMatch(/\bdriveRoot\s*:/)
    const lock = indexSrc.indexOf('app.requestSingleInstanceLock()')
    const initBackend = indexSrc.indexOf('function initBackend(')
    expect(lock).toBeGreaterThan(-1)
    expect(early?.at).toBeLessThan(lock)
    expect(early?.at).toBeLessThan(initBackend)
    // Only one replacing call: a second one later in the start would drop the early roots.
    expect(callArgs(indexSrc, 'setLogRedactionRoots', (early?.at ?? 0) + 1)).toBeNull()
  })

  it('the drive root is added right after resolvePaths, before ensureWorkspaceDirs and initLogging', () => {
    const initBackend = indexSrc.indexOf('function initBackend(')
    const resolve = indexSrc.indexOf('resolvePaths(', initBackend)
    const added = callArgs(indexSrc, 'addLogRedactionRoots', initBackend)
    expect(added).not.toBeNull()
    expect(added?.args).toMatch(/\bdriveRoot\s*:\s*paths\.rootPath\b/)
    expect(added?.at).toBeGreaterThan(resolve)
    expect(added?.at).toBeLessThan(indexSrc.indexOf('ensureWorkspaceDirs(', initBackend))
    expect(added?.at).toBeLessThan(indexSrc.indexOf('initLogging(', initBackend))
  })
})
