import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'

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
