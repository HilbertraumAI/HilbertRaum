import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from '../logging'
import {
  llamaOsDir,
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
const STDERR_TAIL_MAX = 2_000

/**
 * Run one `kiwix-manage LIBRARY add ZIM` invocation. kiwix-manage reads only the ZIM
 * header (fast even for a 100 GB archive) and appends a `<book …>` element carrying
 * the archive's metadata to the library XML. Rejects with the captured stderr tail on
 * a non-zero exit, a spawn failure, or the (defensive) timeout; the caller decides
 * how to surface it. `spawnFn` is the test seam.
 */
export function kiwixManageAdd(
  managePath: string,
  libraryXmlPath: string,
  zimPath: string,
  spawnFn: SpawnFn
): Promise<void> {
  // kiwix-manage on Windows REJECTS forward-slash absolute paths ("Cannot add ZIM …" —
  // spike 2026-08-22). `join()`-built paths are already native, but an env/config-sourced
  // path may not be; normalizing here removes the whole failure class.
  const native = (p: string): string => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p)
  return new Promise((resolve, reject) => {
    let child: ChildProcessLike
    try {
      child = spawnFn(managePath, [native(libraryXmlPath), 'add', native(zimPath)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    let stderrTail = ''
    let settled = false
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* best-effort */
      }
      settle(new Error(`kiwix-manage timed out after ${MANAGE_TIMEOUT_MS}ms`))
    }, MANAGE_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()

    child.stderr?.on('data', (chunk: unknown) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })
    child.once('error', (err: unknown) => {
      settle(err instanceof Error ? err : new Error(String(err)))
    })
    child.once('exit', (code: unknown) => {
      if (code === 0) settle()
      else {
        const tail = stderrTail.trim()
        settle(
          new Error(
            `kiwix-manage exited with code ${String(code)}${tail ? ` — ${tail}` : ''}`
          )
        )
      }
    })
  })
}
