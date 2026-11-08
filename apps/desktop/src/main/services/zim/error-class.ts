import { errnoCode } from '../runtime/sidecar'
import { KiwixServeStartError } from './serve'
import { KiwixManageError } from './tools'

/**
 * A path-free description of a knowledge-pack failure for the log — D-Z1's sentinel rule
 * ("counts only — never a pack title, never a path"), one spelling for every site (#712).
 *
 * Never a foreign error's MESSAGE: a Node `fs` or `spawn` error names its path (`EACCES:
 * permission denied, mkdir '<workspace>\zim-transient'`), and the kiwix children print the
 * workspace's library path and the archive's — whose file name names what the user reads. The two
 * kiwix error classes are built path-free, so they contribute their kind and details; anything
 * else contributes its class name and, for a Node system error, its errno code.
 *
 *   KiwixServeStartError → `serve:exit:code 1:library-unreadable`, `serve:launch:ENOENT`, …
 *   KiwixManageError     → `manage:exit`, `manage:timeout`, …, and `manage:exit:non-ascii-path`
 *                          when the tool ran and refused with a non-ASCII character still on its
 *                          Windows argv (#787) — the same rule as `path-unsupported`, so a launch
 *                          failure or a timeout is never blamed on the path
 *   a Node system error  → `Error:EACCES`
 *   anything else        → its `name` (`AbortError`, `TypeError`, …), its class's name when it
 *                          never set one (`ArticlePathError`), or `unknown`
 */
export function zimErrorClass(err: unknown): string {
  if (err instanceof KiwixServeStartError) return `serve:${err.diagnostic()}`
  if (err instanceof KiwixManageError) {
    return `manage:${err.kind}${err.kind === 'exit' && err.nonAsciiArgv ? ':non-ascii-path' : ''}`
  }
  if (err instanceof Error) {
    const name = err.name === 'Error' && err.constructor.name !== 'Error' ? err.constructor.name : err.name
    const code = errnoCode(err)
    return code ? `${name}:${code}` : name
  }
  return 'unknown'
}
