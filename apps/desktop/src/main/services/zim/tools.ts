import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from '../logging'
import { verifyBinaryBeforeSpawn, type BinaryVerifyResult } from '../binary-verifier'
import {
  llamaOsDir,
  registerSidecarChild,
  unregisterSidecarChild,
  type ChildProcessLike,
  type ResolveBinOptions,
  type SpawnFn
} from '../runtime/sidecar'

// kiwix-tools binary discovery (knowledge packs). Third sidecar family after
// llama.cpp and whisper.cpp; the resolution rules are the transcriber's
// (transcriber/cli.ts): on-drive `runtime/kiwix-tools/<os>/`, dev-only env
// override, packaged builds resolve only from the drive (security audit M-5).
//
// MVP scope note: the family is NOT yet wired into runtime-sources.yaml / the
// in-app engine downloader / DRIVE-NOTICES generation — the binaries are placed
// manually (or by a future provisioning wave). Absence is a first-class state:
// every consumer reports "kiwix-tools not installed" instead of failing.

/** Platform-specific `kiwix-serve` executable name. */
export function kiwixServeBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'kiwix-serve.exe' : 'kiwix-serve'
}

/** Platform-specific `kiwix-manage` executable name. */
export function kiwixManageBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'kiwix-manage.exe' : 'kiwix-manage'
}

/** Directory that holds the kiwix sidecar family: `runtime/kiwix-tools/<os>/`. */
export function kiwixToolsDir(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  return join(rootPath, 'runtime', 'kiwix-tools', llamaOsDir(platform))
}

/**
 * Resolve the `kiwix-serve` binary, or `null` when absent (mirrors
 * `resolveWhisperCliPath`). `HILBERTRAUM_KIWIX_BIN` points at an explicit binary in
 * DEV ONLY; a packaged build ignores it (it would spawn an arbitrary, unverified
 * binary — security audit M-5).
 */
export function resolveKiwixServePath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveBinOptions = {}
): string | null {
  const override = env.HILBERTRAUM_KIWIX_BIN?.trim()
  if (override) {
    if (opts.isDev) return existsSync(override) ? override : null
    log.warn('Ignoring HILBERTRAUM_KIWIX_BIN in a packaged build (dev-only override)')
  }
  const candidate = join(kiwixToolsDir(rootPath, platform), kiwixServeBinaryName(platform))
  return existsSync(candidate) ? candidate : null
}

/**
 * Resolve `kiwix-manage` as a SIBLING of the resolved `kiwix-serve` binary — the two
 * always ship in one archive, and deriving it from the serve path keeps the dev
 * override working for both without a second env var.
 */
export function resolveKiwixManagePath(
  servePath: string | null,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!servePath) return null
  const candidate = join(dirname(servePath), kiwixManageBinaryName(platform))
  return existsSync(candidate) ? candidate : null
}

const MANAGE_TIMEOUT_MS = 30_000
const MANAGE_KILL_GRACE_MS = 1_000
const MANAGE_FORCE_KILL_WAIT_MS = 2_000
const STDERR_TAIL_MAX = 2_000

/** Resolves after `ms`, unref'd so a pending manager wait never keeps the process alive
 *  (matches the sidecar's own timers). */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.()
  })

/** Whether the child process is known to still exist (`'not-spawned'`: never spawned —
 *  the verifier/abort/sync-throw refusals; `'exited'`: reached a terminal `exit`/`error`
 *  state; `'uncertain'`: kill()/SIGKILL were sent but no terminal state was observed
 *  within the bound — the PID stays in the reaper registry, R-7). */
export type KiwixManageChildState = 'not-spawned' | 'exited' | 'uncertain'

/** Rejection shape for `kiwixManageAdd` (§9.15 item 8 / M9). `childState` tells a
 *  caller whether it is safe to clean up anything the child might still be writing to:
 *  only `'uncertain'` means "maybe still running". */
export class KiwixManageError extends Error {
  readonly kind: 'verify' | 'spawn' | 'exit' | 'timeout' | 'abort'
  readonly childState: KiwixManageChildState
  constructor(message: string, kind: KiwixManageError['kind'], childState: KiwixManageChildState) {
    super(message)
    this.name = 'KiwixManageError'
    this.kind = kind
    this.childState = childState
  }
}

export interface KiwixManageOptions {
  /** Caller cancellation (e.g. a lock/quit teardown). Checked once right after the
   *  pre-spawn verifier (no spawn if already aborted) and for the life of the child. */
  signal?: AbortSignal
  /** Re-hash the binary immediately before spawn (vuln-scan B). Defaults to the shared
   *  `verifyBinaryBeforeSpawn` (session-cached). Injected by tests. */
  verifyBinary?: (binPath: string) => Promise<BinaryVerifyResult>
  /** Defensive ceiling on the whole invocation (default 30s — kiwix-manage reads only
   *  the ZIM header, so a healthy run finishes in well under this). */
  timeoutMs?: number
  /** Grace period after the polite `kill()` before escalating to `SIGKILL` (default 1s —
   *  kiwix-manage is a short-lived CLI, not a long-running server). */
  killGraceMs?: number
  /** How long to wait for a terminal state after `SIGKILL` before giving up and settling
   *  `'uncertain'` (default 2s). */
  forceKillWaitMs?: number
}

/** One `log.warn` per process for a hashless install marker (R-1) — never per call, and
 *  never with a path (the sentinel rule). */
let warnedManageSkipLegacy = false

/** Test-only: let each test see its own first-warn behaviour. */
export function _resetKiwixManageSkipLegacyWarnForTests(): void {
  warnedManageSkipLegacy = false
}

/**
 * Run one `kiwix-manage LIBRARY add ZIM` invocation. kiwix-manage reads only the ZIM
 * header (fast even for a 100 GB archive) and appends a `<book …>` element carrying
 * the archive's metadata to the library XML.
 *
 * Order: pre-spawn integrity verification (a packaged-build tamper refuses with NO
 * spawn) → the caller's abort is rechecked → spawn → the PID is registered with the
 * crash-reap registry for as long as the child may be running. A timeout or a caller
 * abort escalates `kill()` → grace → `SIGKILL` → a bounded wait, and the promise
 * SETTLES ONLY AFTER the child reaches a terminal state or that bound expires — never
 * synchronously — so a caller can never delete something the child might still be
 * writing (e.g. the throwaway library.xml directory) while it races a SIGKILLed child.
 * `spawnFn` is the test seam.
 */
export async function kiwixManageAdd(
  managePath: string,
  libraryXmlPath: string,
  zimPath: string,
  spawnFn: SpawnFn,
  opts: KiwixManageOptions = {}
): Promise<void> {
  const verifyBinary = opts.verifyBinary ?? verifyBinaryBeforeSpawn
  const timeoutMs = opts.timeoutMs ?? MANAGE_TIMEOUT_MS
  const killGraceMs = opts.killGraceMs ?? MANAGE_KILL_GRACE_MS
  const forceKillWaitMs = opts.forceKillWaitMs ?? MANAGE_FORCE_KILL_WAIT_MS
  const signal = opts.signal

  // Re-hash kiwix-manage against its install marker BEFORE spawning it (vuln-scan B) —
  // the same pre-spawn gate every llama-server spawn already runs (sidecar.ts doStart).
  const verdict = await verifyBinary(managePath)
  if (verdict === 'mismatch') {
    throw new KiwixManageError(
      'kiwix-manage failed pre-spawn integrity verification',
      'verify',
      'not-spawned'
    )
  }
  if (verdict === 'skip-legacy' && !warnedManageSkipLegacy) {
    warnedManageSkipLegacy = true
    log.warn('hashless install marker — kiwix-manage integrity not verified (R-1)')
  }
  // 'ok' / 'skip-dev' are silent — nothing to warn about.

  // A teardown may have begun while the verifier awaited — don't even spawn.
  if (signal?.aborted) {
    throw new KiwixManageError('kiwix-manage add aborted before spawn', 'abort', 'not-spawned')
  }

  // kiwix-manage on Windows REJECTS forward-slash absolute paths ("Cannot add ZIM …" —
  // spike 2026-08-22). `join()`-built paths are already native, but an env/config-sourced
  // path may not be; normalizing here removes the whole failure class.
  const native = (p: string): string => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p)

  let child: ChildProcessLike
  try {
    child = spawnFn(managePath, [native(libraryXmlPath), 'add', native(zimPath)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
  } catch (err) {
    throw new KiwixManageError(err instanceof Error ? err.message : String(err), 'spawn', 'not-spawned')
  }

  // CODE-11/F-32: reachable by the crash-exit reap and the engine-installer's in-use
  // guard for as long as the child may be running. Unregistered ONLY by the terminal
  // handler below (exit/error) — never by the timeout/abort escalation directly, so an
  // `'uncertain'` outcome deliberately leaves the PID registered (R-7).
  registerSidecarChild(child.pid, 'kiwix_tools')

  return new Promise<void>((resolve, reject) => {
    let stderrTail = ''
    let settled = false
    // Set once a timeout/abort begins the kill escalation: from that point the eventual
    // settlement is always a timeout/abort rejection (never the ordinary exit-code path),
    // matching the "settle-before-cleanup" rule — see `beginCancel` below.
    let cancelling = false
    let terminalReached = false
    let resolveTerminal: () => void = () => {}
    const terminalPromise = new Promise<void>((res) => {
      resolveTerminal = res
    })

    const cleanupTimers = (): void => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      cleanupTimers()
      if (err) reject(err)
      else resolve()
    }

    child.stderr?.on('data', (chunk: unknown) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })

    // Terminal handlers ALWAYS unregister the PID and resolve `terminalPromise` — even
    // after the promise has already settled via the cancel path (a late exit/error must
    // still free the reaper registry, and must change nothing else, per M9's contract).
    child.once('error', (err: unknown) => {
      terminalReached = true
      unregisterSidecarChild(child.pid)
      resolveTerminal()
      if (!cancelling) {
        settle(new KiwixManageError(err instanceof Error ? err.message : String(err), 'spawn', 'exited'))
      }
    })
    child.once('exit', (code: unknown) => {
      terminalReached = true
      unregisterSidecarChild(child.pid)
      resolveTerminal()
      if (!cancelling) {
        if (code === 0) settle()
        else {
          const tail = stderrTail.trim()
          settle(
            new KiwixManageError(
              `kiwix-manage exited with code ${String(code)}${tail ? ` — ${tail}` : ''}`,
              'exit',
              'exited'
            )
          )
        }
      }
    })

    // Timeout or caller abort: kill() → race terminal vs killGraceMs → SIGKILL → race
    // terminal vs forceKillWaitMs → settle. The promise never settles here before that
    // race resolves, so the child is either confirmed terminal or the bound has expired.
    const beginCancel = (kind: 'timeout' | 'abort'): void => {
      if (cancelling || settled) return
      cancelling = true
      void (async () => {
        try {
          child.kill()
        } catch {
          /* best-effort */
        }
        await Promise.race([terminalPromise, delay(killGraceMs)])
        if (!terminalReached) {
          try {
            child.kill('SIGKILL')
          } catch {
            /* best-effort */
          }
          await Promise.race([terminalPromise, delay(forceKillWaitMs)])
        }
        const label = kind === 'timeout' ? `timed out after ${timeoutMs}ms` : 'aborted'
        if (terminalReached) {
          settle(new KiwixManageError(`kiwix-manage ${label}`, kind, 'exited'))
        } else {
          log.warn(`kiwix-manage child did not reach a terminal state after SIGKILL — PID ${String(child.pid)} left registered for the crash reaper (R-7)`)
          settle(new KiwixManageError(`kiwix-manage ${label} — cleanup not confirmed`, kind, 'uncertain'))
        }
      })()
    }

    const timer = setTimeout(() => beginCancel('timeout'), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()

    const onAbort = (): void => beginCancel('abort')
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
