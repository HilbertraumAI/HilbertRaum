# F-13 golden drive-release record (app-update wave, T3.3a)

Hand-written on 2026-11-25 at commit `5f8d6123`, before the reader and the helper existed (tests first), from W-20 and
F-13 (plan §2, Appendix B, as edited for the P3 entry), the record's §8.5, §5.10 table B.11, §5.1, §4.4 and §2.5
(`docs/app-updates.md`), the P3 entry decisions 7, 11 and 12, the T3.3a blast-radius sheet (its reader table R01-R27,
the helper's fields and byte rules, its §4 tree) and the orchestrator's answers to the sheet's questions (Q2: an
existing `app_version` that a root app still carries is kept when the root gives no single version), with semver.org
2.0.0, RFC 8259 and ECMA-262's `JSON.parse` as the outside sources each vector names in `why`. No expected value was
taken from the reader's or the helper's output.

Three files:

- `vectors.json`: `read`, the files a drive may hold at `config/drive-release.json`, each with the result release 1's
  reader gives it for ever and the one value a decision may use (`decision`); `noCache`; `artifacts`, the drive-root
  names release 1's root globs count as apps, with the version each carries; `tree`, the golden drive root (it lists
  entries the record must never name: `config/`, `models/`, `logs/`, `workspace/`, `updates/`, docs, macOS litter);
  `writes`, changes of that tree and existing records with what the HEAD helper writes for each. Bytes the repo hygiene
  nets refuse in a text file under `tests/` (a byte-order mark) and bytes that are not UTF-8 are held as base64; long
  runs are `repeat` parts. The tree lives in this file, not as files: `logs/`, `workspace/` and `*.log` are git-ignored.
- `expected-record.json`: the exact bytes the helper writes for `tree` (two-space indent, LF, no byte-order mark, the
  fields `format`, `app_version`, `systems`, `files` in that order, `files` sorted by path in UTF-16 code-unit order).
  Its sha256 values were computed with coreutils `sha256sum` (Git for Windows' `usr/bin/sha256sum.exe`) over the
  tree's ASCII texts, without a line end, and they equal the ones in the T3.3a sheet, which were computed the same way.
- `PROVENANCE.md`: this file.

Who reads which part: `tests/integration/drive-release.test.ts` runs `read`, `noCache` and `artifacts` against the
reader module, and `tree` and `writes` through the helper's command line in a real Node child (so every CI leg also
proves that the helper loads the TypeScript reader through Node's type stripping). Locked by
`../../golden-fixtures.sha256`. What T3.3b adds for `config/kit-support.txt` (F-13 includes it) joins this folder with
its own lines.

What is frozen and what is not: `read` and `noCache` are F-13, release 1's reader, for ever; no answer there ever
changes, and a new case is a new vector. `artifacts`, `tree` and `writes` (with `expected-record.json`) pin the HEAD
helper and the root-name rule `rootArtifactOf`, which are replaceable: a later builder's helper may write differently
within F-13's field meanings, and P6 freezes the root names (F-18). The case rule is P6's to decide (CF-33; review m7:
`rootArtifactOf` matches a name byte for byte, while the Windows start file's glob ignores case). A change there
updates those vectors and this folder's manifest lines, never `read` or `noCache`.

Added in T3.3a's fix round 1 (2026-11-25, at `6f1b388f`), by hand like the rest: `R27` (review m1: a `config/` that is
itself a link is followed, the sheet's residual R27) and `W30` (review M1: what the helper makes of kept values that a
double cannot hold, derived from ECMA-262's `JSON.parse` and `JSON.stringify` over IEEE binary64 and checked with
integer arithmetic, never taken from the helper's output). The test file's rows R28 (something put at the name between
the reader's `lstat` and its open), R29 (a close that fails), W31 (a reader that cannot be loaded) and W32 (a record
that does not read back) take their expected values from `read` (R12a), `expected-record.json` and the helper's
documented lines; they add no file here.
