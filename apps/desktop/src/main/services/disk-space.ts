import { existsSync, statfsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Bytes free to this process on the volume that holds `path`, or null when the OS cannot say.
 * `path` need not exist yet: a model's folder before its first download is measured at its
 * nearest existing ancestor, ultimately the drive root. One definition for the drive status
 * (`workspace.ts`), the downloader's room check (`downloads.ts`, #768) and, through
 * {@link freeBytesSync}, the vault's startup salvage (#892).
 */
export async function freeBytes(path: string): Promise<number | null> {
  const dir = nearestExisting(path)
  if (dir === null) return null
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** {@link freeBytes} for a caller that cannot await: the vault controller's `init()`, which runs before any IPC
 *  (#892). */
export function freeBytesSync(path: string): number | null {
  const dir = nearestExisting(path)
  if (dir === null) return null
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

function nearestExisting(path: string): string | null {
  let dir = path
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return dir
}
