// Text helpers shared by the two notice builders (#770): scripts/lib/third-party-notices.mjs
// (THIRD-PARTY-NOTICES.md) and scripts/lib/drive-notices.mjs (DRIVE-NOTICES.md). Both files are
// byte-gated against a regeneration (third-party-notices.test.ts, drive-notices.test.ts), so a change
// here shows up in both gates at once.

/**
 * Case-folded code-unit order (codepoint order for these ASCII names), NOT localeCompare
 * (REL-1, full-audit 2026-07-12b): this order feeds the byte-exact notices drift gates,
 * and no-locale localeCompare depends on the HOST ICU collation (dev = de-AT, CI = en/C).
 * Pure code-unit order would REORDER the committed file today (ICU's primary strength is
 * case-insensitive, so `cmaps` < `LICENSE` inside pdfjs-dist; raw code units put
 * `LICENSE` first) — so we case-fold first, which reproduces the committed
 * ICU-primary-strength order byte-identically, and tiebreak equal folds by raw code
 * units. `String.prototype.toLowerCase()` is locale-INDEPENDENT (Unicode default case
 * conversion — unlike toLocaleLowerCase), so this is fully deterministic across hosts
 * and ICU versions.
 */
export function foldedCodepointCompare(a, b) {
  const fa = a.toLowerCase()
  const fb = b.toLowerCase()
  if (fa !== fb) return fa < fb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Wrap verbatim license text in a code fence that cannot collide with its content. */
export function fence(text) {
  const runs = text.match(/`+/g) ?? []
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0)
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}\n${text}\n${f}`
}

/**
 * Normalize a license text for a notices file: LF endings, no BOM, no trailing blank lines; a NUL
 * byte is a hard error (repo hygiene). The two builders differ in one step, and each passes it
 * explicitly: THIRD-PARTY-NOTICES.md strips the trailing spaces and tabs of every line
 * (`trimLineEnds: true`), DRIVE-NOTICES.md keeps the pinned texts' lines as written
 * (`trimLineEnds: false`; licenses/LGPL-2.1.txt has such lines). Changing either one rewrites that file.
 */
export function cleanText(raw, source, { trimLineEnds }) {
  const t = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (t.includes('\u0000')) throw new Error(`NUL byte in license text: ${source}`)
  return (trimLineEnds ? t.replace(/[ \t]+$/gm, '') : t).trimEnd()
}
