// The update file's member names (app-update F-18's name half, frozen with F-2 in P4; docs/app-updates.md §4.4, table
// A.3; Δ-75 row 14; CF-45). Release 1 applies the rule for ever: to every name in a signed payload's `files[]` (a name
// that breaks it is UPD-TOO-NEW, payload.ts), and from P6 on to every header name of the update file and to
// `staged.json`. The rule keeps a space, a leading `-` and a Windows device name out of the apply scripts' lines
// (`staged.txt`, read by cmd and bash), and every name fetchable as a GitHub asset name.
//
// What it does not do: the root globs (`HilbertRaum-*-portable.exe` and the rest, and which version a root app carries)
// are drive-release.ts's `rootArtifactOf`; member 0's own name is checked by the container reader (P6), which reads it
// as exactly ENVELOPE_MEMBER_NAME.
//
// P5's writer, P6's staging and any script load this file through Node's own type stripping, with or without the
// sibling-import hook: so it imports nothing at all and holds only TypeScript that stripping can erase.

/** The longest member name: the ustar name field's 100 bytes, less its NUL. */
export const MEMBER_NAME_MAX_BYTES = 99

/** Member 0's name, the signed envelope (§4.3); reserved for it, so no other member takes it in any case (§4.4). */
export const ENVELOPE_MEMBER_NAME = 'hilbertraum-release.dsse.json'

/** ASCII letters, digits, `.`, `_` and `-` only (no space, no `+`), the first a letter or a digit. */
const CHARACTERS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The Windows device names, alone or before a `.` (`nul.txt`), compared after the fold. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/

/**
 * Table A.3, every row: a string of 1 to 99 bytes of `[A-Za-z0-9._-]`, the first character a letter or a digit, the
 * last not `.`; not a Windows device name alone or before a `.`, and not member 0's name, both compared case-folded.
 * The characters are ASCII, so the length in characters is the length in bytes. Never throws.
 */
export function isMemberName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length > MEMBER_NAME_MAX_BYTES || !CHARACTERS.test(name) || name.endsWith('.')) return false
  const folded = foldMemberName(name)
  return !DEVICE_NAME.test(folded) && folded !== ENVELOPE_MEMBER_NAME
}

/** `A`–`Z` folded to `a`–`z` and nothing else (never a locale's rule: `toLowerCase` would fold the Kelvin sign to `k`). */
export function foldMemberName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

/** Whether two of `names` are equal after the fold (table A.3, "Uniqueness": NTFS, exFAT and APFS must hold them all). */
export function hasFoldedDuplicate(names: readonly string[]): boolean {
  const seen = new Set<string>()
  for (const name of names) {
    const folded = foldMemberName(name)
    if (seen.has(folded)) return true
    seen.add(folded)
  }
  return false
}
