import { readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

// Issue #190 — the evidence half of the diagnostic's safety contract.
//
// "The tool never writes to the drive" is the single claim the whole thing rests on, and a claim
// backed only by careful code review is exactly the kind that decays. This turns it into an
// assertion: fingerprint the drive tree, run the diagnostic, fingerprint again, require the two
// identical. The integration test does that in CI against a synthetic vault; the manual harness
// does the same against the real drive and FAILS THE RUN if anything moved.
//
// The fingerprint deliberately includes mtime as well as size: `openDatabase`'s `db.exec(SCHEMA)`
// + `ensureColumn` sweep — the accidental write this guards against — can leave a same-size file
// with a new mtime, and a size-only witness would sleep through it. It also lists directory
// ENTRIES, so a `.recovery` rolled forward, a staged `.enc.new` swapped in, or a plaintext working
// DB decrypted onto the drive all show up as an added or removed path.
//
// It hashes rather than reads content: the fingerprint of a user's drive must not itself become a
// pile of file names in a test log.

export interface TreeFingerprint {
  /** Number of entries walked (files + directories). */
  entries: number
  /** SHA-256 over `relpath|size|mtimeMs` of every entry, in sorted order. */
  digest: string
}

/** Directories that legitimately change while the app is not running — none today; kept so a
 *  future exclusion has one obvious home rather than being sprinkled through call sites. */
const IGNORED = new Set<string>()

/**
 * Walk `root` and hash the shape of everything under it.
 *
 * Best-effort per entry: an unreadable file contributes `?` rather than aborting the walk, because
 * a witness that throws on a transiently-locked file (Windows AV/indexer) would turn a clean run
 * into a scary failure. A file that becomes unreadable BETWEEN the two fingerprints still changes
 * the digest, which is the behaviour we want.
 */
export function fingerprintTree(root: string): TreeFingerprint {
  const lines: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      lines.push(`${relative(root, dir).split('\\').join('/')}|?|?`)
      return
    }
    for (const name of entries.sort()) {
      if (IGNORED.has(name)) continue
      const full = join(dir, name)
      const rel = relative(root, full).split('\\').join('/')
      try {
        const st = statSync(full)
        lines.push(`${rel}|${String(st.size)}|${String(st.mtimeMs)}`)
        if (st.isDirectory()) walk(full)
      } catch {
        lines.push(`${rel}|?|?`)
      }
    }
  }
  walk(root)
  return {
    entries: lines.length,
    digest: createHash('sha256').update(lines.join('\n')).digest('hex')
  }
}

/** True when the tree is byte-for-byte, mtime-for-mtime unchanged. */
export function treeUnchanged(before: TreeFingerprint, after: TreeFingerprint): boolean {
  return before.entries === after.entries && before.digest === after.digest
}
