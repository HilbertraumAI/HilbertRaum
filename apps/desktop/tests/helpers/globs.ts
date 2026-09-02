/**
 * Translate a minimatch-style electron-builder `files`/`asarUnpack` glob to a coarse RegExp.
 * Shared by `packaging.test.ts` (L18 canvas exclusion) and `asar-unpack-closure.test.ts`
 * (#232) so the two pins cannot drift apart. Coarse on purpose: `**​/` →
 * any directory prefix, `**` → anything, a single `*` → one path segment; enough for the
 * `node_modules/<pkg>/**` shapes both tests check, not a full minimatch.
 */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/(?<!\.)\*/g, '[^/]*') +
      '$'
  )
}
