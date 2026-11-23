import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// #1024 final round: `ensureWorkspaceDirs` (services/workspace.ts) reads a refusal that Node's recursive mkdir masks as
// ENOENT by making the missing folders one level at a time. The case here: the recursive attempt failed at the highest
// missing folder (another start made it a moment later, or a medium refused it once), so the re-read can make that
// folder, and a deeper folder is refused. A second recursive mkdir from there would mask that refusal again as ENOENT;
// one plain mkdir per level reports it as it is.
//
// No real drive refuses this way on demand, and Node's own recursive mkdir makes the higher folders before it fails
// (measured: it then fails at the refused level, which the re-read already reports), so the medium is faked at the
// dependency: `node:fs`'s `mkdirSync`, which passes through to the real one unless the row names a refusal. The rows
// over real folders (a dangling link at a folder's name, the root and its parent missing) are workspace.test.ts's.

type Refusal = (path: string, recursive: boolean) => NodeJS.ErrnoException | null
const medium = vi.hoisted(() => ({ refuse: null as Refusal | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const mkdirSync = ((path: Parameters<typeof actual.mkdirSync>[0], options?: Parameters<typeof actual.mkdirSync>[1]) => {
    const recursive = typeof options === 'object' && options !== null && options.recursive === true
    const refused = medium.refuse?.(String(path), recursive)
    if (refused) throw refused
    return actual.mkdirSync(path, options)
  }) as typeof actual.mkdirSync
  return { ...actual, mkdirSync, default: { ...actual, mkdirSync } }
})

import { ensureWorkspaceDirs, resolvePaths } from '../../src/main/services/workspace'
import { tempRoot } from '../helpers/db-fixtures'

/** An error as `node:fs` builds it for a refused mkdir. */
function mkdirError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused, mkdir '${path}'`), { code, syscall: 'mkdir', path })
}

afterEach(() => {
  medium.refuse = null
})

describe('ensureWorkspaceDirs reads a deeper refusal one level at a time (#1024)', () => {
  it('the highest missing folder can be made, the next one is refused: the refusal is that folder’s own', () => {
    const base = tempRoot('create-folder-deeper')
    const kits = join(base, 'kits')
    const root = join(kits, 'hilbertraum')
    // The read-only medium under `kits`: a recursive mkdir under it fails as Node reports such a refusal (the ENOENT
    // of its follow-up stat, having made nothing), a plain mkdir of `hilbertraum` gets the real EROFS, `kits` itself
    // can be made.
    medium.refuse = (path, recursive) => {
      if (!path.startsWith(kits)) return null
      if (recursive) return mkdirError('ENOENT', path)
      return path === root ? mkdirError('EROFS', path) : null
    }
    let thrown: unknown
    try {
      ensureWorkspaceDirs(resolvePaths({ envRoot: root, fallbackRoot: root }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ code: 'EROFS', syscall: 'mkdir' })
    expect(existsSync(kits)).toBe(true)
  })
})
