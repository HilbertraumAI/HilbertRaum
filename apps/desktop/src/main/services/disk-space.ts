import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Bytes free to this process on the volume that holds `path`, or null when the OS cannot say.
 * `path` need not exist yet: a model's folder before its first download is measured at its
 * nearest existing ancestor, ultimately the drive root. One definition for the drive status
 * (`workspace.ts`) and the downloader's room check (`downloads.ts`, #768).
 */
export async function freeBytes(path: string): Promise<number | null> {
  let dir = path
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}
