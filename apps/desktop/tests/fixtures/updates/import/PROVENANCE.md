# The import's golden inputs (app-update wave, T6.0b; F-5, F-11's import events, F-12, F-14, F-16, F-18)

Written on 2026-11-27 by the wave's golden-input writer (Fable 5.2, task T6.0b), against the record at commit
`f7dae3ba` and then at `6a520533` ("T6.0 fix 4"), `b0265b94` ("T6.0 fix 5") and `d12e1c6f` ("T6.0 fix 6"), the three
commits that rule the points this task raised (branch `feat/updates-import-core`; `docs/app-updates.md`; the table as
it stands agrees with `d12e1c6f`), **before any of P6's code existed** (tests first; the import is written afterwards by another model against these
files). Every expected value is stated from a row of the record, which the entry's `why` names by section and row; none
comes from the code under test, and none from P3's or P4's update modules, which the writer did not open. Release 1
gives these answers for ever. A new case is a new row; a changed row after release 1 is an owner call (record §1.5).
Locked by `../../golden-fixtures.sha256`.

## What the writer read

`docs/app-updates.md` §1.6, §2.3, §2.4, §2.10, §3.5–§3.7, §4 (all), §5.3, §5.8, §5.10, §8.2, §8.4, §10; the T6.0 value
summary and the task's two briefs (working papers); `tests/helpers/archives.ts`; `readers/f11-update-log/PROVENANCE.md`
and the head and tail of `vectors-unlock.json`, `updates/vectors/positive/PROVENANCE.md` (its first 40 lines) and
`golden-fixtures.sha256`, for the form only; the golden-manifest, private-key and M-1 rows of `repo-hygiene.test.ts`.
Not read: anything under `src/main/services/updates/` or `src/shared/updates/`, `tests/unit/updates-*.test.ts`,
`tests/helpers/update-vectors.ts`, P4's vector generators, and the record's §2.7, §5.1 and §8.1 (outside the task's
list). §2.5 (the version rule) and §5.4's "Pre-check" row were read only in the later rounds, for the cases the review
and the rulings asked for (below); the first writing had shaped its cases to need neither.

## The files

| File | What it holds | Read by |
|---|---|---|
| `cases.json` | the hostile-case table: 372 cases (288 of one import call, 22 of several calls, 54 of the start step and its sweep, 8 of the discard); none is open. Each has `id`, `why`, how the file is built (declaratively: the payload's exact text, the members, header fields, cuts, a zero-filled tail, the prefix), the drive before, the host inputs, and `expect` (the answer, the code and its parameters, the `update.log` line or none, the drive afterwards). Its `schema` says how to read it | the import's tests (T6.1–T6.3) through `tests/helpers/update-bundles.ts`; `tests/unit/archives-writer.test.ts` (each file builds as stated) |
| `ustar-writer.json` | table A.2's writer bytes, field by field, for one header | `tests/unit/archives-writer.test.ts` |
| `f5-staged.json` | the exact `staged.txt` and `staged.json` of the two committed golden update files (`../golden.hrupdate`, `../golden-win32-only.hrupdate`), member 0's size and sha256, each member's offset, size and sha256 | T6.2's tests |
| `f12-support-dates.json` | 97 golden dates of `supportNotice` | T6.4a's tests |
| `f14-locked-channels.json` | the channels `registerUpdatesIpc` registers in PR-6a | T6.3's tests |
| `last-result.json` | 31 readings of `updates/last-result.txt` for the commit's `cleared` line (one whose last line ends CR LF), and the appended line's form | T6.2's tests |
| `case-owners.json` | which test file runs each of `cases.json`'s 372 cases: `bundle` (213), `staging` (126) or `service` (33); written by T6.2 part 2 (below) | `tests/unit/updates-bundle.test.ts`, `tests/unit/updates-staging.test.ts`, `tests/integration/updates-service.test.ts` (a guard row in each) |
| `../../readers/f11-update-log/vectors-import.json` | 106 lines of the five import events (`import-refused`, `import-staged`, `import-cancelled`, `staging-swept`, `staging-discarded`), valid and refused-field cases, in the form of `vectors-unlock.json` beside it; `vectors.json` and `vectors-unlock.json` were not touched | T6.2's tests (`update-log.test.ts`) |

## How the values were stated

- **Answers, codes, parameters, lines, the drive afterwards**: by hand, in the task's authoring scripts (kept with the
  wave's working papers), each from the record row its `why` names. The scripts hold the values as literals and only
  lay them out as JSON (one case per line), so a `\r` or a non-ASCII byte is written as a JSON escape or as hex, never
  as a raw control byte.
- **A log line** is the frame of record §5.3 ("The app's lines") over the event's keys in the order record §4.5 gives
  ("`update.log` events of the import"). The reading of the key order and of the caps was checked against the record's
  own number: `import-refused` with every key at its cap and an 8-byte OS token comes to exactly 226 bytes (vector
  `i54`), as the record says.
- **Each built file's `size`, `head` and `maskedSha256`** (`cases.json`, `file`): by the authoring tool's own builder,
  a second writing of table A.2 that shares no code with `tests/helpers/archives.ts` and `update-bundles.ts`; row (c)
  of `archives-writer.test.ts` compares the two for every case. The masked sha256 is taken over the file with member
  0's data bytes set to zero, so it does not depend on the key the test makes.
- **The member hashes inside the payloads** are inputs (the sha256 of the stated member bytes), not expectations.
- **F-5's bytes** (`f5-staged.json`): from the committed golden files, read back by a reader written for the purpose
  (which also verified the signature and every member), and laid out by record §4.6: `<size> <name>` and LF per member
  present, in `files[]` order; `{"format":1,"version":…,"files":[…]}` with the keys `name`, `size`, `sha256`, then
  `group`, no whitespace and no line end.
- **F-12's dates**: each expected notice and `ageMonths` was worked out by hand from the rows "Dates", "The build day",
  "The age", "The support end", "The answer" and "Parameters" of record §8.4; the month arithmetic is written into each
  `why`.
- **The 4 MiB and 4,096-entry cases** are built at test time (a `padTo` envelope, a `seq` payload), so no large file is
  committed.

## What the record did not decide, and how it was ruled ("T6.0 fix 4")

The first writing (against `f7dae3ba`) stopped at twelve points and stated no expected value for them: seven built
cases without an expectation and five formatter questions. The record's author then ruled each in the record (tag
"T6.0 fix 4", 2026-11-27, committed as `6a520533`; the writer read it as that change to `docs/app-updates.md`:
§4.3 "Member 0", "Members after member 0", "The header walk", "Then the data pass"; §4.5 the order, "Free space", "The
start step", "The start-up sweep" and the events' new paragraph "What the formatter writes"; §4.7; §5.4 "Pre-check"),
and the second writing, the same day, states them from those rows:

| Point | Ruling | Case or vector |
|---|---|---|
| one zero block, then the end of the file | `UPD-DOWNLOAD-INCOMPLETE`, whatever members were seen | `end-one-zero-block-then-end`, `end-one-zero-block-then-end-member-missing` |
| a short file with the right name and a wrong magic | tested on every byte it holds, field by field: `UPD-NOT-AN-UPDATE` | `first-short-right-name-wrong-magic` and six `first-short-…` cases for the other fields |
| a zero-filled tail inside member 0 | member 0's own check decides: `UPD-FILE-DAMAGED` | `m0-zero-tail-inside-envelope` |
| member 0's name in another letter case | byte for byte: `UPD-NOT-AN-UPDATE` | `m0-name-other-case` |
| a listed member present only in another letter case | unlisted: `UPD-FILE-DAMAGED`, found by the walk | `walk-listed-member-other-case-only` |
| free bytes of exactly 64 MiB before the dialog | passes | `pre-margin-exactly-64-mib` |
| `statfs` with a block size of 0 | `c` is 1 MiB and free bytes are `bavail × c`, for the margin too | `space-bsize-zero-at-the-formula`, `space-bsize-zero-one-under`, `pre-margin-bsize-zero-below` |
| the five formatter points | each key alone; a version that fails V dropped (the caller passes `unknown` for 25 to 64 bytes); pairings written as given; a system call that fails C dropped; a count kept only as decimal text that passes I | `vectors-import.json` `i87` to `i106`; its vectors now hold what the formatter is handed (a count as text, `unknown` with `run.version`) |

The same rulings checked the writer's own readings. Confirmed: `files=` and the free-space sum count the `files[]`
members present, not member 0; a plain file at `updates/applying` is present; a `<w>/` whose `staged.json` cannot be
read is never the staged update; the key id is the lower-case hex sha256 of the SPKI DER. **Corrected: member 0's
padding** is checked by the header walk, so `m0-padding-not-zero` is refused before the data pass and removes nothing
(the first writing had it in the data pass); the padding of every member after member 0 stays in the data pass
(`data-padding-not-zero`, both staging folders removed).

Readings that stand, each named in its case's `why`: in member 0's header every field that fails, its checksum apart,
answers `UPD-NOT-AN-UPDATE` (record §4.3 "Header check order": only a checksum failure is `UPD-FILE-DAMAGED`), a link
name or a prefix that is not zero included, and wrong version bytes (263–264) fail the magic check, since "Magic and
version" is one row.

**Spike 9's same-length rows** (T1.11 S9-6; the orchestrator's mapping of the spike's refusal rows 7, 8, 10, 26 and
27, which the record does not list): a pax `x` header before a member, a GNU `L` long-name header, a hard-link member,
a member whose `prefix` field is used and a member with a base-256 size, each placed so that the file is exactly as
long as the well-formed standard file (9,728 bytes; the authoring tool refuses to write the row otherwise) with a right
magic and checksum, so no length check can refuse it: `s9-row-7-…` to `s9-row-27-…`, each `UPD-FILE-DAMAGED` by the
header walk.

## Fix round 1 (the review of all cases; "T6.0 fix 5", `b0265b94`)

An independent review (Opus 5.5, 2026-11-27) read every case against the record at `6a520533`, built the files a third
time from the schema text alone (no mismatch) and found no wrong value; it asked for more cases and clearer wording,
and the record's "T6.0 fix 5" (`b0265b94`) ruled three readings. Applied the same day:

- **Cases whose host inputs decide** (review M-1, from record §2.5 and §2.4, which the writer read for this round): the
  drive's `app_version` ahead and counting, stale (`stale_drive_version=yes`), kept when the root cannot be listed, and
  equal to the update (`ver-drive-…`); the Linux glibc below, at and without a floor, an absent glibc, a `linux` floor
  that breaks the grammar on Windows, a macOS floor (`floor-…`); the `summary` in the UI language and its `en`
  fallback (`summary-ui-language-…`).
- **The path check** (fix 5): "listed" means the members present. The two first-writing cases that counted a name of an
  absent group were replaced by `path-absent-member-name-not-counted` and the pair `path-present-99-byte-name-at-259`
  / `-at-260`.
- **When `updates/staging/` is made** (fix 5): by the data pass, never earlier. `unchanged` now says that a path absent
  before is still absent; `walk-refusal-makes-nothing-under-updates` and `confirm-stop-makes-nothing-under-updates`
  state it outright.
- **The complete end** (fix 5, §4.7): cited by the three cases that rest on it.
- **Wording**: the `mkdir` injections hit every `mkdir` of `updates/`, the log appender's own included; the cancel of
  `data-cancel-before-payload` comes before member 0 is read; table A.6's rows 14 to 17 are cited by their numbers at
  `6a520533`; `vectors-import.json`'s `files` rule uses the record's wording.
- **A link's target survives** a sweep's and a discard's removal (two `unchanged` targets, `discard-link-inside`).
- **Behaviours that had no case**: the 10 s wait, another version's staging not counted as free, a file that grows
  after the open, a redeem on a file no longer old and on a file of another version, arguments without an own
  `confirmToken`, a discard during a run, the repeated-refusal rule in two more settings, a failed listing, a failed
  `lstat` of `updates/applying` at the start, a cancel before the dialog, and five more F-12 dates (a `dismissed` that
  is no object).

One value was not in the record then and was not chosen: whether a line is written when the import's own listing of
the drive root fails while `updates/` is a real folder. The record's "T6.0 fix 6" (`d12e1c6f`) ruled it and two
readings the round had named: the refusal is written, `import-refused code=UPD-CANT-WRITE-DRIVE err=EIO
syscall=scandir link=updates` (`pre-updates-listing-fails`, vector `i107`), and "no file receives `link=updates`"
holds only while `updates/` is not a real folder (`pre-updates-is-a-file`, `pre-updates-is-a-link`, vector `i43`); a
failed listing is a thrown error, so `pre-staging-listing-fails` carries `err=EIO syscall=scandir link=staging`
(vector `i108`); and a `dismissed` that is not a plain object counts as no dismissal at all, an entry under another key
being ignored (the five F-12 dates `dismissed-null` to `dismissed-unknown-key-only`).

## `case-owners.json` (T6.2 part 2, 2026-11-27)

Written by the T6.2 part 2 implementer (Opus 5.5) after the reader (T6.1, `ea9c8aeb`, `d6407c36`) and staging (T6.2
part 1, `cfcc2b42`, `6807e392`) were committed, so that every case is run in exactly one test file (T6.1 review m-2). It
holds no expected value: it says only which file runs a case. Its source is the split as those two commits pinned it, read
from git HEAD by a script kept with the wave's working papers (`impl/p6/T6.2/case-owners-2.mjs`): T6.1's rule in
`updates-bundle.test.ts` (every id outside the service's prefixes and named ids is the reader's: 213), and part 1's two
lists in `updates-staging.test.ts` (`RUN_HERE`: staging, 126; `LEFT_TO_SERVICE`: the update service, 33). The script
refuses to write unless the three sets partition the table's ids exactly as the two files pinned them; the entries stand
in `cases.json`'s order. The two files then read their lists from it (their counts stay pinned), and the service's file
runs the 33. A case moves between files only with an edit here and the guard rows; no case's `expect` was changed.

## No key

`update-bundles.ts` makes its key pairs in memory at test time; no file here holds a key, a signature or a seed. The
golden update file's public key is `../golden-keys.json` (see `../PROVENANCE.md`).
