// The shipped `scripts/*.{ps1,sh}` run on a fresh machine with no Node, so each pair repeats its logic and the suites read
// or run both. This is the shell half of those suites: the two legs, and the array parser the twin rows compare with.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { testBudgetMs } from './hang-budget'
import { REPO_ROOT } from './repo-files'

const SCRIPTS = join(REPO_ROOT, 'scripts')

// The child is killed before vitest's own budget expires, so a hung script fails with its output attached. A child timeout is
// invisible to `testTimeout`, so it widens on CI by hand: at a flat 60 s a starved windows runner killed scripts that take 2 s
// (#458, the `status: null` runs of the builder's gate row).
const CHILD_TIMEOUT_MS = testBudgetMs(60_000)

/**
 * The entries of a script array: `$Dirs = @(` or `DIRS=(`, to the first line that is exactly `)`. Comments, quotes and commas
 * go. Closing on a line, not on the first `)`, is the point: a comment such as `# chat (benchmark-winning 8B)` holds one.
 * Throws when the header or the close is missing, or when the array is empty, so a parity row cannot compare nothing.
 */
export function extractScriptArray(src: string, header: string): string[] {
  const start = src.indexOf(header)
  if (start < 0) throw new Error(`array header not found: ${header}`)
  const lines = src.slice(start + header.length).split(/\r?\n/)
  const close = lines.findIndex((line) => line.trim() === ')')
  if (close < 0) throw new Error(`no closing line for array: ${header}`)
  const entries = lines
    .slice(0, close)
    .flatMap((line) => line.replace(/#.*$/, '').split(','))
    .map((entry) => entry.replace(/['"]/g, '').trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new Error(`array is empty: ${header}`)
  return entries
}

export interface RunOptions {
  timeoutMs?: number
  /** Variables set on top of this process's environment. A `PATH` here replaces the inherited one, whatever its case. */
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface ScriptLeg {
  name: string
  skip: boolean
  ext: 'ps1' | 'sh'
  /** A flag in this leg's spelling: `flag('DryRun')` is `-DryRun` or `--dry-run`. */
  flag(name: string): string
  /** Runs `scripts/<script>`. */
  run(script: string, args: string[], opts?: RunOptions): SpawnSyncReturns<string>
}

/** This process's environment with `overrides` on top. Windows env names are case-insensitive, so a `PATH` override drops `Path`. */
function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const replaced = Object.keys(overrides).map((k) => k.toLowerCase())
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!replaced.includes(k.toLowerCase())) env[k] = v
  return { ...env, ...overrides }
}

/**
 * Windows PowerShell 5.1's environment. GitHub's windows runner exports a PSModulePath meant for PowerShell 7; inherited by 5.1
 * it hides 5.1's own module directory, so `Get-FileHash` (a script function of 5.1's Microsoft.PowerShell.Utility) fails to
 * autoload and every hashing script dies with CommandNotFoundException. Replace it, case-insensitively as Windows env names
 * are, with 5.1's own default module path, which is what any user's machine gives the script.
 */
function powershellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!/^psmodulepath$/i.test(k)) env[k] = v
  const sysRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  env.PSModulePath = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'WindowsPowerShell', 'Modules') : null,
    join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  ]
    .filter((p): p is string => p !== null)
    .join(';')
  return env
}

/** Git Bash on a Windows dev box can run the bash legs too: HILBERTRAUM_SCRIPT_SH_LEG=1. */
export const bashLegSkipped: boolean = process.platform === 'win32' && !process.env.HILBERTRAUM_SCRIPT_SH_LEG

export const SCRIPT_LEGS: ScriptLeg[] = [
  {
    name: 'PowerShell scripts (.ps1)',
    skip: process.platform !== 'win32',
    ext: 'ps1',
    flag: (n) => `-${n}`,
    run: (script, args, opts = {}) =>
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPTS, script), ...args],
        {
          encoding: 'utf8',
          timeout: opts.timeoutMs ?? CHILD_TIMEOUT_MS,
          windowsHide: true,
          env: powershellEnv(childEnv(opts.env)),
          cwd: opts.cwd
        }
      )
  },
  {
    name: 'bash scripts (.sh)',
    skip: bashLegSkipped,
    ext: 'sh',
    flag: (n) => `--${n.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    run: (script, args, opts = {}) =>
      spawnSync('bash', [join(SCRIPTS, script), ...args], {
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? CHILD_TIMEOUT_MS,
        env: childEnv(opts.env),
        cwd: opts.cwd
      })
  }
]

export const outputOf = (r: SpawnSyncReturns<string>): string => `${r.stdout ?? ''}\n${r.stderr ?? ''}`

/**
 * A scratch drive root for a script row. Its last segment holds a space and a `[`, the two characters a careless shell
 * script or a non-literal PowerShell path cmdlet trips on: `Test-Path '…\Kit [1]'` reads `[1]` as a wildcard, finds
 * nothing, and fetch-models and verify-models then fell back to the repo's manifests (#767).
 */
export function scriptRoot(prefix: string): string {
  const root = join(mkdtempSync(join(tmpdir(), `hilbertraum-${prefix}`)), 'Kit [1]')
  mkdirSync(root)
  return root
}

const ARIA2 = ['aria2c', 'aria2c.exe', 'aria2c.cmd', 'aria2c.bat']
const pathKey = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? 'PATH'

/** A copy of `dir` made of symlinks, minus aria2c: on a POSIX runner aria2c sits in /usr/bin beside every tool the scripts need. */
function mirrorWithoutAria2(dir: string): string {
  const mirror = mkdtempSync(join(tmpdir(), 'hilbertraum-path-'))
  for (const name of readdirSync(dir)) if (!ARIA2.includes(name)) symlinkSync(join(dir, name), join(mirror, name))
  return mirror
}

/**
 * Overrides for a row that really downloads, from a `file://` URL. Every CI runner image ships aria2c, which the scripts
 * prefer and which reads no `file://` URL, so it leaves PATH: a Windows directory holding it (a choco shim folder) is
 * dropped, a POSIX one is mirrored without it. `firstDir` (a stub downloader) goes first. `STUB_NODE` names this node for
 * the stubs.
 */
export function downloadEnv(firstDir?: string): NodeJS.ProcessEnv {
  const dirs: string[] = []
  for (const dir of (process.env[pathKey] ?? '').split(delimiter)) {
    if (!dir) continue
    if (!ARIA2.some((n) => existsSync(join(dir, n)))) dirs.push(dir)
    else if (process.platform !== 'win32') dirs.push(mirrorWithoutAria2(dir))
  }
  return { PATH: [...(firstDir ? [firstDir] : []), ...dirs].join(delimiter), STUB_NODE: process.execPath }
}
