import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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

const SCRIPT = resolve(__dirname, '..', '..', '..', '..', 'scripts', 'verify-electron.mjs')

interface VerifyElectronModule {
  LAZY_DOWNLOAD_MAJOR: number
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
function makeInstall(opts: {
  pathTxt?: string | null
  distVersion?: boolean
  binary?: 'ok' | 'empty' | 'missing'
}): void {
  const { pathTxt = 'electron.exe', distVersion = true, binary = 'ok' } = opts
  if (pathTxt !== null) writeFileSync(join(dir, 'path.txt'), pathTxt)
  const distDir = join(dir, 'dist')
  mkdirSync(distDir, { recursive: true })
  if (distVersion) writeFileSync(join(distDir, 'version'), '43.4.0')
  if (binary === 'ok') writeFileSync(join(distDir, 'electron.exe'), 'MZ-not-really-a-binary')
  else if (binary === 'empty') writeFileSync(join(distDir, 'electron.exe'), '')
}

describe('verify-electron: the Electron 42 lazy-download boundary (DEP-4 §A)', () => {
  it('pins the boundary at major 42', () => {
    expect(mod.LAZY_DOWNLOAD_MAJOR).toBe(42)
  })

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

  it('on Electron 41 a missing path.txt IS broken — the fallback-ladder case', () => {
    makeInstall({ pathTxt: null, distVersion: false, binary: 'missing' })
    // 41 still ships `postinstall: node install.js`, so path.txt should exist by now.
    expect(mod.diagnose(dir, 41)).toMatch(/path\.txt is missing/)
  })

  it('on Electron 39 a missing path.txt IS broken', () => {
    makeInstall({ pathTxt: null, distVersion: false, binary: 'missing' })
    expect(mod.diagnose(dir, 39)).toMatch(/path\.txt is missing/)
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
