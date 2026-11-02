// The shipped `scripts/*.{ps1,sh}` run on a fresh machine with no Node, so each pair repeats its logic and the suites read
// or run both. This is the shell half of those suites: the two legs, and the array parser the twin rows compare with.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-files'

const SCRIPTS = join(REPO_ROOT, 'scripts')

// The child is killed before vitest's own budget expires, so a hung script fails with its output attached.
const CHILD_TIMEOUT_MS = 60_000

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

export interface ScriptRunOptions {
  timeoutMs?: number
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
  run(script: string, args: string[], opts?: ScriptRunOptions): SpawnSyncReturns<string>
}

/**
 * Windows PowerShell 5.1's environment. GitHub's windows runner exports a PSModulePath meant for PowerShell 7; inherited by 5.1
 * it hides 5.1's own module directory, so `Get-FileHash` (a script function of 5.1's Microsoft.PowerShell.Utility) fails to
 * autoload and every hashing script dies with CommandNotFoundException. Replace it, case-insensitively as Windows env names
 * are, with 5.1's own default module path, which is what any user's machine gives the script.
 */
function powershellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^psmodulepath$/i.test(k)) env[k] = v
  const sysRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  env.PSModulePath = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'WindowsPowerShell', 'Modules') : null,
    join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  ]
    .filter((p): p is string => p !== null)
    .join(';')
  return { ...env, ...extra }
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
          env: powershellEnv(opts.env),
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
        env: { ...process.env, ...opts.env },
        cwd: opts.cwd
      })
  }
]

export const outputOf = (r: SpawnSyncReturns<string>): string => `${r.stdout ?? ''}\n${r.stderr ?? ''}`
