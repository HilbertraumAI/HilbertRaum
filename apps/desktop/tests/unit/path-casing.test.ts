import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { build, loadConfigFromFile, normalizePath, type Plugin } from 'vite'
import { loadConfigFromFile as loadElectronViteConfig } from 'electron-vite'
import { canonicalCase, oneModulePerFile } from '../../path-casing'

// Issue #646: a build started from `c:\…` bundled ~41 main modules twice (one under `c:/…`, one
// under `C:/…`), each copy with its own module state. The configs now build every path from
// `canonicalCase(__dirname)`, and `oneModulePerFile()` fails any build that still splits a file.
// Below: both pieces, and the configs as their own loaders see them from a `c:\…` directory.
// (Whether a real build from `c:\…` splits depends on when Vite's `net use` probe answers, so the
// config is pinned instead of a build; the guard covers a split from any other cause.)

let root: string
let realDir: string
let linkDir: string

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hilbertraum-path-casing-')))
  realDir = join(root, 'src')
  linkDir = join(root, 'link')
  mkdirSync(realDir)
  // A directory link to `src`: a second spelling of the same files that differs in more than
  // letter case, like a subst drive or a junction (no admin rights needed on Windows).
  symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(realDir, 'state.js'), 'export const state = new Map()\n')
  writeFileSync(
    join(realDir, 'entry.js'),
    "import { state } from './state.js'\nimport { state as again } from 'second-spelling'\nexport default state === again\n"
  )
})

/** The `c:\…` spelling of a canonical `C:\…` path (Windows only). */
function lowerDrive(path: string): string {
  return path[0]!.toLowerCase() + path.slice(1)
}

describe('canonicalCase (#646)', () => {
  it.runIf(process.platform === 'win32')('gives a path typed with a lower-case drive letter the file system\'s spelling', () => {
    expect(canonicalCase(lowerDrive(realDir))).toBe(realDir)
  })

  it('leaves the canonical spelling, and a spelling that differs in more than case, as given', () => {
    expect(canonicalCase(realDir)).toBe(realDir)
    // Through the link the file system's spelling is `realDir`, but rewriting it would trade the
    // form Vite uses for a mapped network drive (Z:\) for its UNC path; the guard covers those.
    expect(canonicalCase(linkDir)).toBe(linkDir)
  })
})

/** Builds `entry.js`, with `second-spelling` resolved to `state.js` under `secondPath`. */
async function buildWithSecondSpelling(secondPath: string): Promise<void> {
  const secondSpelling: Plugin = {
    name: 'test:second-spelling',
    // What Vite's resolver did in #646: hand back a module id spelled differently from the
    // one an earlier import of the same file got (in Vite's own `/` form, as its ids are).
    resolveId: (source) => (source === 'second-spelling' ? normalizePath(secondPath) : null)
  }
  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    plugins: [secondSpelling, oneModulePerFile()],
    build: { write: false, lib: { entry: join(realDir, 'entry.js'), formats: ['es'] } }
  })
}

describe('hilbertraum:one-module-per-file (#646)', () => {
  it('builds when both imports reach the file under one spelling', async () => {
    await expect(buildWithSecondSpelling(join(realDir, 'state.js'))).resolves.toBeUndefined()
  })

  /** The guard's error for a build whose second import met `state.js` as `secondPath`. */
  async function guardMessage(secondPath: string): Promise<string> {
    const error = await buildWithSecondSpelling(secondPath).then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(error, 'the build should have failed').not.toBeNull()
    return error!.message
  }

  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /** Both spellings are listed, one of them as "also as" (which comes first is resolution order). */
  function expectBothSpellings(message: string, second: string): void {
    const first = normalizePath(join(realDir, 'state.js'))
    expect(message).toContain(first)
    expect(message).toContain(normalizePath(second))
    expect(message).toMatch(new RegExp(`also as (${escapeRegExp(first)}|${escapeRegExp(normalizePath(second))})`))
  }

  it('fails a build that bundles one file under two spellings, naming both', async () => {
    const second = join(linkDir, 'state.js')
    const message = await guardMessage(second)
    expect(message).toMatch(/1 file\(s\) were bundled more than once.*\(#646\)/)
    expectBothSpellings(message, second)
  })

  it.runIf(process.platform === 'win32')('fails a build that met the file as c:\\… and C:\\… (the #646 split)', async () => {
    const second = lowerDrive(join(realDir, 'state.js'))
    expectBothSpellings(await guardMessage(second), second)
  })
})

/** Every absolute path string in a loaded config. Plugins are skipped: they carry no paths of ours. */
function absolutePaths(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return isAbsolute(value) ? [value] : []
  if (value === null || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  return Object.entries(value).flatMap(([key, v]) => (key === 'plugins' ? [] : absolutePaths(v, seen)))
}

describe.runIf(process.platform === 'win32')('the build configs, loaded from a c:\\… working directory (#646)', () => {
  const env = { command: 'build', mode: 'production' } as const
  /** The app directory as the file system spells it, and as a `c:\…` terminal would. */
  const desktop = (): string => realpathSync.native(join(__dirname, '..', '..'))
  const lowerDesktop = (): string => lowerDrive(desktop())
  /** The paths not spelled as the file system spells the app directory they all live in. */
  const misspelled = (paths: string[]): string[] => paths.filter((p) => !p.startsWith(desktop()))

  it('electron.vite.config.ts hands Vite only canonical paths', async () => {
    const loaded = await loadElectronViteConfig(env, undefined, lowerDesktop())
    expect(loaded.path.startsWith(normalizePath(lowerDesktop())), 'the loader met the c:\\… spelling').toBe(true)
    const paths = absolutePaths(loaded.config)
    // main/preload/renderer roots, three entries, two pages, two aliases.
    expect(paths.length).toBeGreaterThanOrEqual(10)
    expect(misspelled(paths)).toEqual([])
  })

  it.each(['vite.tools.config.ts', 'vite.preview.config.ts'])('%s hands Vite only canonical paths', async (file) => {
    const loaded = await loadConfigFromFile(env, join(lowerDesktop(), file), lowerDesktop(), 'silent')
    expect(loaded?.path.startsWith(normalizePath(lowerDesktop())), 'the loader met the c:\\… spelling').toBe(true)
    const paths = absolutePaths(loaded?.config)
    expect(paths.length).toBeGreaterThanOrEqual(3)
    expect(misspelled(paths)).toEqual([])
  })
})
