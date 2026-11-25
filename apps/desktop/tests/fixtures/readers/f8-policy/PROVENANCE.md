# F-8 golden update policy keys (app-update wave, T3.1)

Hand-written on 2026-11-25 at commit `7c969583`, before the reader existed (tests first), from W-13 and F-8 (plan §2,
Appendix B), the record's §8.1 and §3.6 (`docs/app-updates.md`), the P3 entry decisions 5-7, G-14 (c) built the
simpler way and U1 (b) (owner, 2026-11-23), the T3.1 blast-radius sheet's parse matrix (§2.2-§2.4) with its sixteen
answers O-1 to O-16, and semver.org 2.0.0 (§2, §9, §10, §11 and its FAQ). No expected value was taken from the
reader's output. One file, `vectors.json`: the files a drive may hold at `config/policy.json`, each with the verdict
release 1 gives it for ever (`install`, `maxVersion`, `file`); the junk values of each key; the `updates.max_version`
table; what the HEAD writers emit (the Kit's block, and none on DIY and dev drives); and the SemVer 2.0.0 grammar and
order the table rests on. A byte-order mark, a NUL, UTF-16 and bytes that are not UTF-8 are held as base64: such bytes
in a text file under `tests/` fail the repo hygiene nets.

Release 1 is the oldest version ever sold on a Kit, so what it makes of these keys can never change in the field: an
absent key and `true` allow, `false` blocks every install, a junk value or a present `updates` that is not an object
blocks as "invalid", and a missing or damaged `policy.json` keeps the signed import allowed and is shown as
"unreadable" (G-14's deliberate exception to "a damaged policy never fails open"). `updates.allow_online_check` is a
reserved name the Kit builders write `true`: release 1 reads no value of it, junk included.

Who reads which part: `tests/integration/policy.test.ts` ("F-8 golden") runs `vectors`, `junk` and `maxVersion`, each
file in a temporary `config/`, and holds `loadPolicy` (dev and packaged) to its result for the same file without the
`updates` block; `tests/unit/updates-version.test.ts` runs `semver`; `tests/integration/drive.test.ts` and the
prepare-drive execution rows (`script-orchestration.test.ts`) read `writers.kit`. Locked by
`../../golden-fixtures.sha256`.

Round 2 (after the Fable review): not yet run. Fable is out until 2026-11-29; the negative vectors C14 asks for,
written from the spec by a reviewer who has not read the reader, are added here then, each with its source.
