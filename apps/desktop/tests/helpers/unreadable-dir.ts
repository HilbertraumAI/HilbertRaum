import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

// A folder its owner cannot list, for the rows where the sell gate must refuse what it cannot look into (#893). POSIX: a
// mode without the read bit (`traverse` keeps the execute bit, so a file inside still opens by its path while the folder
// cannot be listed). Windows: a deny entry for Everyone on the "List folder" right, which icacls sets on a folder the user
// owns without admin rights; a file inside still opens by its path. Root reads any mode, so a POSIX row needs a normal user.

/** False where this process cannot be refused a listing (POSIX root). */
export const canMakeUnreadable: boolean = process.platform === 'win32' || process.getuid?.() !== 0

const EVERYONE = '*S-1-1-0'

function icacls(args: string[]): void {
  const r = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`icacls ${args.join(' ')} failed: ${r.stdout ?? ''}${r.stderr ?? ''}`)
}

/**
 * Takes the listing right on `dir` away and returns the undo. Run the undo in `finally`: the temp-root sweep cannot remove
 * a folder it cannot list.
 */
export function makeUnreadable(dir: string, opts: { traverse?: boolean } = {}): () => void {
  if (process.platform === 'win32') {
    icacls([dir, '/deny', `${EVERYONE}:(RD)`])
    return () => icacls([dir, '/remove:d', EVERYONE])
  }
  chmodSync(dir, opts.traverse ? 0o111 : 0o000)
  return () => chmodSync(dir, 0o755)
}

/**
 * #1024: takes the right to create a folder inside `dir` away and returns the undo (run it in `finally`). Windows: a deny
 * entry for Everyone on "Create folders / append data" (AD), which icacls sets without admin rights on a folder the user
 * owns, as an access rule on a drive does; a folder already inside still opens. POSIX: mode r-x. Then it tries a folder
 * itself, and throws when the folder still takes one (POSIX root ignores the mode), so a row can never pass on a drive
 * that was never refused.
 */
export function denyNewFolders(dir: string): () => void {
  let undo: () => void
  if (process.platform === 'win32') {
    icacls([dir, '/deny', `${EVERYONE}:(AD)`])
    undo = () => icacls([dir, '/remove:d', EVERYONE])
  } else {
    chmodSync(dir, 0o555)
    undo = () => chmodSync(dir, 0o755)
  }
  const probe = join(dir, `.deny-new-folders-${process.pid}`)
  try {
    mkdirSync(probe)
  } catch {
    return undo // refused, as the row needs
  }
  rmdirSync(probe)
  undo()
  throw new Error(`denyNewFolders: ${dir} still takes a new folder (POSIX root ignores the mode); run as a normal user`)
}
