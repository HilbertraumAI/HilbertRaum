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

Round 2 (2026-11-25, after the first Fable review of F-8, finding R1-5 and its disposition): thirteen vectors, C14's
reviewer vectors, hand-written from the review's text (the reviewer ran each on a copy of the reader, outside this
tree) and the disposition, with the O-answers and RFC 8259 as sources, before any run here and never from this
reader's output; each names its source in `why`. `updates` and `max_version` twice, both ways round (the last wins,
O-6); a key and a value spelt with JSON escapes (RFC 8259 §7); one byte-order mark then whitespace, read, and
whitespace then a mark, unreadable (O-2; U+FEFF is not JSON whitespace, RFC 8259 §2); a key with a trailing space
(O-7); a 300-digit major (O-10's length cap); CRLF line ends; and the two file tokens the disposition decided as
built: a dangling link at `policy.json` reads as absent (`none` on a root without `drive.json`, `unreadable` on a
prepared drive; O-1, O-5), and a folder at the name is `unreadable` either way. The review's (g) (no config folder)
and (j) (deep nesting) stay unpinned, as it allows. Every earlier vector is unchanged, byte for byte.

Not golden, on purpose (T3.7's review, F8-3, and its disposition, 2026-11-26):
`tests/fixtures/prepare-drive-policy-bytes.json`, the `policy.json` bytes the prepare-drive twins write for a DIY and a
developer drive (no `updates` key), sits outside this folder and outside `../../golden-fixtures.sha256`. It pins those
bytes against an accidental change (the prepare-drive rows of `script-orchestration.test.ts` compare each written file
with it, byte for byte); a deliberate change of the DIY or developer posture updates it in the same change. What
release 1 reads for ever is this folder's; the Kit's own block is locked here (`vectors.json`, `writers.kit`).
