import { describe, it, expect, vi } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Executes the drive-root launchers (#235, #257). Every launcher derives the drive root from
// its own location, so each case copies the launcher into a scratch root beside 0-byte app
// artifacts. Two app versions on one drive must be refused, naming both, before anything is
// started or written; `--check` (`.sh` / `.command`) and `/check` (`.cmd`) resolve the app and
// exit without starting it — the single-artifact control. The `.cmd` leg runs on Windows, the
// two bash legs elsewhere (Git Bash on a Windows dev box: HILBERTRAUM_SCRIPT_SH_LEG=1).

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const LAUNCHERS = join(REPO_ROOT, 'launchers')
const CMD = 'Start HilbertRaum.cmd'
const COMMAND = 'Start HilbertRaum.command'
const SH = 'start-hilbertraum.sh'

// A launcher that reaches its launch line on a 0-byte artifact hangs (Windows shows an error
// dialog for a bad exe) — the child is killed well before vitest's own budget so the failure
// carries the launcher's output.
const CHILD_TIMEOUT_MS = 10_000
vi.setConfig({ testTimeout: 60_000 })

const REFUSAL = /More than one HilbertRaum app was found on this drive/
const NOT_STARTED = /Nothing was started/

const text = (r: SpawnSyncReturns<string>): string => `${r.stdout ?? ''}\n${r.stderr ?? ''}`

function scratchRoot(launcher: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-launcher-'))
  copyFileSync(join(LAUNCHERS, launcher), join(root, launcher))
  return root
}

/** 0-byte artifacts, the NEWER name created first so a creation-order pick cannot pass. */
function twoArtifacts(root: string, names: [string, string]): void {
  writeFileSync(join(root, names[1]), '')
  writeFileSync(join(root, names[0]), '')
}

const runCmd = (root: string, args: string[]): SpawnSyncReturns<string> =>
  spawnSync('cmd.exe', ['/d', '/c', `""${join(root, CMD)}"${args.map((a) => ` ${a}`).join('')}"`], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: true,
    windowsHide: true
  })

const runBash = (
  root: string,
  launcher: string,
  args: string[],
  env: Record<string, string> = {}
): SpawnSyncReturns<string> =>
  spawnSync('bash', [join(root, launcher), ...args], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  })

const bashSyntaxOk = (launcher: string): SpawnSyncReturns<string> =>
  spawnSync('bash', ['-n', join(LAUNCHERS, launcher)], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS })

describe.skipIf(process.platform !== 'win32')('Start HilbertRaum.cmd (Windows)', () => {
  const two: [string, string] = ['HilbertRaum-0.1.57-portable.exe', 'HilbertRaum-0.1.59-portable.exe']

  it('refuses two portable apps, naming both, and starts nothing', () => {
    const root = scratchRoot(CMD)
    twoArtifacts(root, two)
    const r = runCmd(root, [])
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
  })

  it('/check refuses two portable apps the same way', () => {
    const root = scratchRoot(CMD)
    twoArtifacts(root, two)
    const r = runCmd(root, ['/check'])
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
  })

  it('/check with one app names it and starts nothing (exit 0)', () => {
    const root = scratchRoot(CMD)
    writeFileSync(join(root, two[1]), '')
    const r = runCmd(root, ['/check'])
    const out = text(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain(two[1])
    expect(out).toMatch(NOT_STARTED)
  })

  it('/check with no app fails with the existing not-found message', () => {
    const root = scratchRoot(CMD)
    const r = runCmd(root, ['/check'])
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(out).toMatch(/Could not find the HilbertRaum app/)
  })
})

// Git Bash exists on the Windows CI runner too — gate the bash legs so they run once.
const bashSkip = process.platform === 'win32' && !process.env.HILBERTRAUM_SCRIPT_SH_LEG

describe.skipIf(bashSkip)('start-hilbertraum.sh (Linux)', () => {
  const two: [string, string] = ['HilbertRaum-0.1.57.AppImage', 'HilbertRaum-0.1.59.AppImage']

  /** An exec-able stand-in for the AppImage: records the drive root it was started with. */
  function stubAppImage(root: string, name: string): void {
    const p = join(root, name)
    writeFileSync(p, '#!/usr/bin/env bash\nprintf %s "$HILBERTRAUM_DRIVE_ROOT" > "$(dirname "$0")/launched-$(basename "$0").txt"\n')
    chmodSync(p, 0o755)
  }
  const launched = (root: string, name: string): boolean => existsSync(join(root, `launched-${name}.txt`))

  it('parses under bash -n and runs under set -euo pipefail (#257)', () => {
    expect(bashSyntaxOk(SH).status).toBe(0)
    expect(readFileSync(join(LAUNCHERS, SH), 'utf8')).toMatch(/^set -euo pipefail$/m)
  })

  it('refuses two AppImages, naming both, and starts neither', () => {
    const root = scratchRoot(SH)
    stubAppImage(root, two[1])
    stubAppImage(root, two[0])
    const r = runBash(root, SH, [])
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
    expect(launched(root, two[0])).toBe(false)
    expect(launched(root, two[1])).toBe(false)
  })

  it('--check refuses two AppImages the same way', () => {
    const root = scratchRoot(SH)
    twoArtifacts(root, two)
    const r = runBash(root, SH, ['--check'])
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(two[0])
    expect(out).toContain(two[1])
  })

  it('--check with one AppImage names it and starts nothing (exit 0)', () => {
    const root = scratchRoot(SH)
    stubAppImage(root, two[1])
    const r = runBash(root, SH, ['--check'])
    const out = text(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain(two[1])
    expect(out).toMatch(NOT_STARTED)
    expect(launched(root, two[1])).toBe(false)
  })

  it('with one AppImage and no argument it starts it (no unbound-variable abort)', () => {
    const root = scratchRoot(SH)
    stubAppImage(root, two[1])
    const r = runBash(root, SH, [])
    const out = text(r)
    expect(r.status, out).toBe(0)
    expect(out).not.toMatch(/unbound variable/)
    expect(launched(root, two[1])).toBe(true)
    // The stub saw the drive root the launcher derived from its own location.
    expect(readFileSync(join(root, `launched-${two[1]}.txt`), 'utf8')).toContain('hilbertraum-launcher-')
  })
})

describe.skipIf(bashSkip)('Start HilbertRaum.command (macOS)', () => {
  const zips: [string, string] = ['HilbertRaum-0.1.57-mac-arm64.app.zip', 'HilbertRaum-0.1.59-mac-arm64.app.zip']

  function extractedApp(root: string, name: string): void {
    mkdirSync(join(root, name, 'Contents', 'MacOS'), { recursive: true })
  }

  /** A scratch HOME: the refusal must land before the launcher writes its unpack cache. */
  function scratchHome(): string {
    return mkdtempSync(join(tmpdir(), 'hilbertraum-launcher-home-'))
  }
  const cacheTouched = (home: string): boolean => existsSync(join(home, 'Library'))

  it('parses under bash -n and runs under set -euo pipefail', () => {
    expect(bashSyntaxOk(COMMAND).status).toBe(0)
    expect(readFileSync(join(LAUNCHERS, COMMAND), 'utf8')).toMatch(/^set -euo pipefail$/m)
  })

  it('refuses two extracted .app bundles, naming both', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    extractedApp(root, 'HilbertRaum.app')
    extractedApp(root, 'HilbertRaum 2.app')
    const r = runBash(root, COMMAND, [], { HOME: home })
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain('HilbertRaum.app')
    expect(out).toContain('HilbertRaum 2.app')
    expect(cacheTouched(home)).toBe(false)
  })

  it('refuses two .app.zip archives, naming both, before touching the unpack cache', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    twoArtifacts(root, zips)
    const r = runBash(root, COMMAND, [], { HOME: home })
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain(zips[0])
    expect(out).toContain(zips[1])
    expect(cacheTouched(home)).toBe(false)
  })

  it('refuses an extracted .app beside a newer .app.zip (the .app used to win silently)', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    extractedApp(root, 'HilbertRaum.app')
    writeFileSync(join(root, zips[1]), '')
    const r = runBash(root, COMMAND, [], { HOME: home })
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(r.status, out).not.toBeNull()
    expect(out).toMatch(REFUSAL)
    expect(out).toContain('HilbertRaum.app')
    expect(out).toContain(zips[1])
    expect(cacheTouched(home)).toBe(false)
  })

  it('--check with one zip names it, writes nothing under $HOME and starts nothing', () => {
    const root = scratchRoot(COMMAND)
    const home = scratchHome()
    writeFileSync(join(root, zips[1]), '')
    const r = runBash(root, COMMAND, ['--check'], { HOME: home })
    const out = text(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain(zips[1])
    expect(out).toMatch(NOT_STARTED)
    expect(cacheTouched(home)).toBe(false)
  })

  it('--check with one extracted .app names it and starts nothing', () => {
    const root = scratchRoot(COMMAND)
    extractedApp(root, 'HilbertRaum.app')
    const r = runBash(root, COMMAND, ['--check'], { HOME: scratchHome() })
    const out = text(r)
    expect(r.status, out).toBe(0)
    expect(out).toContain('HilbertRaum.app')
    expect(out).toMatch(NOT_STARTED)
  })

  it('--check with no app fails with the existing not-found message', () => {
    const root = scratchRoot(COMMAND)
    const r = runBash(root, COMMAND, ['--check'], { HOME: scratchHome() })
    const out = text(r)
    expect(r.status, out).not.toBe(0)
    expect(out).toMatch(/Could not find the HilbertRaum app/)
  })
})
