import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hangBudgetMs } from '../helpers/hang-budget'
import { REPO_ROOT, repoText } from '../helpers/repo-files'

// Wave DEP-4 (Electron 39 -> 43). `scripts/verify-electron.mjs` runs as the ROOT postinstall on
// every contributor's `npm ci` and on every release runner, and until this wave it was WRONG in
// a way nothing could see:
//
//   Electron >= 42 removed the postinstall binary download. `path.txt` is therefore ABSENT
//   after a healthy fresh install — the binary now arrives lazily on first bin invocation. The
//   old script read an absent `path.txt` as "extract did not finish", deleted dist/, and
//   spawned install.js — re-creating the ~100 MB postinstall download Electron had just removed
//   for supply-chain reasons, while printing a false "binary looks broken" NTFS diagnosis.
//
// CI could never catch it (it sets HILBERTRAUM_SKIP_ELECTRON_CHECK and the script early-exits),
// and the script had no tests at all. These pin the decision itself.
//
// The version boundary is load-bearing, not decoration: 39 and 41 still HAVE the postinstall,
// 42 and 43 do not (verified against the registry at this wave's P2). This repo's documented
// Electron-43 fallback ladder includes ^41.7.2, so a version-blind script would silently lose
// the NTFS half-extract protection on exactly that path.

const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-electron.mjs')

interface VerifyElectronModule {
  diagnose(electronDir: string, major: number): string | null
  readElectronMajor(electronDir: string): number | null
}

let mod: VerifyElectronModule

beforeAll(async () => {
  // Dynamic import with a non-literal specifier: the script is plain .mjs outside the app's
  // tsconfig, and importing it must have NO side effects (its CLI half is argv-guarded).
  mod = (await import(pathToFileURL(SCRIPT).href)) as unknown as VerifyElectronModule
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hr-verify-electron-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Build a plausible electron package dir. Omit a piece to simulate each damaged state. */
function makeInstall(
  opts: {
    pathTxt?: string | null
    distVersion?: boolean
    binary?: 'ok' | 'empty' | 'missing'
  },
  at = dir
): void {
  const { pathTxt = 'electron.exe', distVersion = true, binary = 'ok' } = opts
  if (pathTxt !== null) writeFileSync(join(at, 'path.txt'), pathTxt)
  const distDir = join(at, 'dist')
  mkdirSync(distDir, { recursive: true })
  if (distVersion) writeFileSync(join(distDir, 'version'), '43.4.0')
  if (binary === 'ok') writeFileSync(join(distDir, 'electron.exe'), 'MZ-not-really-a-binary')
  else if (binary === 'empty') writeFileSync(join(distDir, 'electron.exe'), '')
}

describe('verify-electron: the Electron 42 lazy-download boundary (DEP-4 §A)', () => {
  it('THE LANDMINE: on Electron 43 a missing path.txt is NORMAL, not a broken install', () => {
    makeInstall({ pathTxt: null, distVersion: false, binary: 'missing' })
    // A fresh `npm ci` on Electron >= 42 looks exactly like this. Returning a problem here is
    // what made the old script delete dist/ and re-download ~100 MB during postinstall.
    expect(mod.diagnose(dir, 43)).toBeNull()
  })

  it('on Electron 42 (the boundary itself) a missing path.txt is likewise normal', () => {
    makeInstall({ pathTxt: null, distVersion: false, binary: 'missing' })
    expect(mod.diagnose(dir, 42)).toBeNull()
  })

  // 41 is the fallback-ladder case: it still ships `postinstall: node install.js`, so path.txt should exist by now.
  it.each([41, 39])('on Electron %i a missing path.txt IS broken', (major) => {
    makeInstall({ pathTxt: null, distVersion: false, binary: 'missing' })
    expect(mod.diagnose(dir, major)).toMatch(/path\.txt is missing/)
  })
})

describe('verify-electron: the genuine half-extract is still caught on every version', () => {
  // This is the bug the script exists for (NTFS-on-Linux drops the large files during unzip
  // while still creating the folders). It is version-independent: once path.txt exists, the
  // download HAS run, so anything missing below is real damage.
  for (const major of [39, 41, 42, 43]) {
    it(`Electron ${major}: path.txt present but the binary is missing -> problem`, () => {
      makeInstall({ binary: 'missing' })
      expect(mod.diagnose(dir, major)).toMatch(/platform binary is missing/)
    })

    it(`Electron ${major}: a zero-length binary -> problem`, () => {
      makeInstall({ binary: 'empty' })
      expect(mod.diagnose(dir, major)).toMatch(/platform binary is empty/)
    })

    it(`Electron ${major}: a healthy install -> no problem`, () => {
      makeInstall({})
      expect(mod.diagnose(dir, major)).toBeNull()
    })
  }

  it('a missing dist/version is a half-extract', () => {
    makeInstall({ distVersion: false })
    expect(mod.diagnose(dir, 43)).toMatch(/dist\/version is missing/)
  })

  it('an empty path.txt is a half-extract', () => {
    makeInstall({ pathTxt: '   ' })
    expect(mod.diagnose(dir, 43)).toMatch(/path\.txt is empty/)
  })
})

describe('verify-electron: readElectronMajor', () => {
  it('reads the major from the installed package.json', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '43.4.0' }))
    expect(mod.readElectronMajor(dir)).toBe(43)
  })

  it('returns null when there is no package.json to read', () => {
    expect(mod.readElectronMajor(dir)).toBeNull()
  })

  it('returns null on an unparseable version, so the caller can fall back', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: 'not-a-version' }))
    expect(mod.readElectronMajor(dir)).toBeNull()
  })
})

// main(): the script runs from a scratch copy, because its repo root comes from its own path, against a stub electron
// package, so nothing here downloads. The root must be canonical: main() runs only when argv[1] equals import.meta.url,
// which is the real path, while macOS's tmpdir is a symlink and windows-latest's can be an 8.3 name. A skipped main()
// exits 0, which only the repair rows can tell from a pass.
describe('verify-electron: the script itself', () => {
  // ci.yml sets the first one, so the child must not inherit it.
  const SKIP_ENV = ['HILBERTRAUM_SKIP_ELECTRON_CHECK', 'ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_SKIP_BINARY_DOWNLOAD']
  const MARK = `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(__dirname,'install-ran'),'');`
  const WRITES_DIST =
    MARK +
    `fs.mkdirSync(p.join(__dirname,'dist'),{recursive:true});` +
    `fs.writeFileSync(p.join(__dirname,'dist','version'),'43.4.0');` +
    `fs.writeFileSync(p.join(__dirname,'dist','electron.exe'),'MZ');`

  /** A scratch repo: a copy of the script, and a stub electron package whose install.js is `installJs`. */
  function scriptRepo(pkg: Record<string, unknown>, installJs: string): string {
    const root = realpathSync.native(dir)
    const electron = join(root, 'node_modules', 'electron')
    mkdirSync(electron, { recursive: true })
    mkdirSync(join(root, 'scripts'))
    copyFileSync(SCRIPT, join(root, 'scripts', 'verify-electron.mjs'))
    writeFileSync(join(electron, 'package.json'), JSON.stringify({ name: 'electron', ...pkg }))
    writeFileSync(join(electron, 'install.js'), installJs)
    return electron
  }
  /** path.txt and dist/version present, the binary gone, plus a leftover that shows whether dist/ was replaced. */
  function halfExtract(electron: string): void {
    makeInstall({ binary: 'missing' }, electron)
    writeFileSync(join(electron, 'dist', 'stale'), '')
  }
  function runScript(electron: string, env: NodeJS.ProcessEnv = {}) {
    const clean = { ...process.env }
    for (const key of SKIP_ENV) delete clean[key]
    return spawnSync(process.execPath, [join(electron, '..', '..', 'scripts', 'verify-electron.mjs')], {
      encoding: 'utf8',
      env: { ...clean, ...env },
      timeout: hangBudgetMs(10_000)
    })
  }
  const installRan = (electron: string): boolean => existsSync(join(electron, 'install-ran'))
  const VERSION = { version: '43.4.0' }

  it('runs as the root postinstall', () => {
    const { scripts } = JSON.parse(repoText('package.json')) as { scripts: Record<string, string> }
    expect(scripts.postinstall).toBe('node scripts/verify-electron.mjs')
  })

  it('a healthy install exits 0 and runs no installer', () => {
    const electron = scriptRepo(VERSION, WRITES_DIST)
    makeInstall({}, electron)
    const r = runScript(electron)
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect(installRan(electron)).toBe(false)
  })

  it('a half-extract is repaired: dist/ is replaced and the script exits 0', () => {
    const electron = scriptRepo(VERSION, WRITES_DIST)
    halfExtract(electron)
    const r = runScript(electron)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('Re-extract succeeded')
    expect(existsSync(join(electron, 'dist', 'stale'))).toBe(false)
    expect(existsSync(join(electron, 'dist', 'electron.exe'))).toBe(true)
  })

  it('a repair that leaves the binary missing exits 1 and names the fix', () => {
    const electron = scriptRepo(VERSION, MARK)
    halfExtract(electron)
    const r = runScript(electron)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('still not installed (dist/version is missing (extract did not finish))')
    expect(r.stderr).toContain('native filesystem')
  })

  it('a repair whose installer exits non-zero exits 1 even when the files look right', () => {
    const electron = scriptRepo(VERSION, `${WRITES_DIST}process.exit(3);`)
    halfExtract(electron)
    const r = runScript(electron)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('install.js exited 3')
  })

  it.each(SKIP_ENV)('%s skips the check: a half-extract is left alone', (key) => {
    const electron = scriptRepo(VERSION, WRITES_DIST)
    halfExtract(electron)
    expect(runScript(electron, { [key]: '1' }).status).toBe(0)
    expect(installRan(electron)).toBe(false)
    expect(existsSync(join(electron, 'dist', 'stale'))).toBe(true)
  })

  // `exports: {}` makes the resolve throw right here. A missing package would make it walk up past the scratch root,
  // and a real electron above the temp folder is not this test's to repair.
  it('an electron package it cannot resolve exits 0 quietly', () => {
    const electron = scriptRepo({ ...VERSION, exports: {} }, WRITES_DIST)
    const r = runScript(electron)
    expect([r.status, r.stderr]).toEqual([0, ''])
    expect(installRan(electron)).toBe(false)
  })

  it('an unreadable version counts as the lazy-download line, so a missing path.txt is left alone', () => {
    const electron = scriptRepo({ version: 'not-a-version' }, WRITES_DIST)
    expect(runScript(electron).status).toBe(0)
    expect(installRan(electron)).toBe(false)
  })
})
