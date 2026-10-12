import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Plugin } from 'vite'

// Issue #646 — one source file, one module.
//
// On Windows, Vite's resolver turns a resolved file into its module id with `fs.realpathSync`
// (which keeps the letter case it is given) until an `exec("net use")` it fires on first use
// calls back, and with `fs.realpathSync.native` (the file system's own spelling) after that.
// A build started from `c:\work\…` — a spelling some terminals hand out, VS Code's among them —
// therefore met the entry and its direct imports as `c:/…` and everything resolved later as
// `C:/…`. A module reachable both ways got two ids, Rollup bundled it twice, and each copy kept
// its own module-level state: 41 main modules, of which `index.ts` alone bound to the `c:`
// copies. It initialised the OS locale, the logger, binary verification and more on copies
// nothing else read (docs/packaging.md "Build paths — design record (#646)").
//
// So every build config derives its paths from `canonicalCase(__dirname)`, and every build
// runs `oneModulePerFile()`, which fails it if one file still arrives under two ids.

/**
 * `path` as the file system spells it, when the given spelling differs from that only in
 * letter case (`c:\work\…` for `C:\work\…`); otherwise `path` unchanged. A spelling that differs
 * in more than case (a junction, a `subst` drive, a mapped network drive) is left alone: Vite
 * has its own canonical form for those, and `oneModulePerFile` fails a build they split.
 */
export function canonicalCase(path: string): string {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    return path
  }
  // Compared in `resolve`'s form, so `/` separators or a trailing separator do not hide a case
  // difference.
  const given = resolve(path)
  return real !== given && real.toLowerCase() === given.toLowerCase() ? real : path
}

/** The on-disk identity of a module id, or null for an id that names no file. */
function fileIdentity(id: string): string | null {
  if (id.startsWith('\0')) return null // a plugin's virtual module
  const q = id.indexOf('?')
  const file = q === -1 ? id : id.slice(0, q)
  // An external by name ('electron', 'node:fs', a dependency left to node_modules) is no file.
  if (!isAbsolute(file)) return null
  try {
    // `?raw` / `?url` imports of a file are distinct modules of it, so the query stays part of
    // the identity.
    return realpathSync.native(file) + (q === -1 ? '' : id.slice(q))
  } catch {
    return null
  }
}

/**
 * Fails a build in which one file on disk was bundled as two modules (#646). Two copies of a
 * module are two copies of its state: a setting, a registry or a cache written through one is
 * not there for code bound to the other, and nothing else in the build notices.
 */
export function oneModulePerFile(): Plugin {
  return {
    name: 'hilbertraum:one-module-per-file',
    apply: 'build',
    buildEnd(error) {
      if (error) return
      const idsByFile = new Map<string, string[]>()
      // One native realpath per file id: ~120 ms for the ~800 ids of a full build (measured on
      // Windows with a virus scanner), about 1 % of it.
      for (const id of this.getModuleIds()) {
        const file = fileIdentity(id)
        if (file === null) continue
        const ids = idsByFile.get(file)
        if (ids) ids.push(id)
        else idsByFile.set(file, [id])
      }
      const split = [...idsByFile.values()].filter((ids) => ids.length > 1)
      if (split.length === 0) return
      const listed = split
        .slice(0, 10)
        .map(([first, ...rest]) => `  ${first}\n${rest.map((id) => `    also as ${id}`).join('\n')}`)
      this.error(
        `${split.length} file(s) were bundled more than once, each copy with its own module ` +
          `state (#646):\n${listed.join('\n')}${split.length > 10 ? '\n  …' : ''}\n` +
          'Build paths must come from canonicalCase(__dirname) (path-casing.ts). A case-only ' +
          'difference usually means the build started from a working directory spelled in ' +
          'another letter case than the file system (c:\\ for C:\\), or an import names a file ' +
          'in another case than its name on disk.'
      )
    }
  }
}
