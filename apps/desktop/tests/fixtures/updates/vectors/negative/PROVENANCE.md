# F-1 / F-2 / F-4 negative contract vectors (app-update wave, T4.4b)

Written on 2026-11-26 by the wave's negative-vector writer (Fable 5.2, task T4.4b), against the record at commit
`930b7d4c` (branch `feat/updates-trust-core`), **without reading the update verifier, its tests or their briefs**
(§10.7 "Independence"; C14). Every `expect` is stated by hand in `generate.mjs` from a row of the record, which the
vector's `why` names by section and row; none comes from the code under test. Release 1 gives these answers for ever:
the set is frozen with F-1, F-2 and F-4. A new case is a new vector; a changed vector after release 1 is an owner call
(§1.5). Locked by `../../../golden-fixtures.sha256`.

Before which code existed: the set was written at `930b7d4c`, before the verifier was committed; T4.1 was writing it
in the same tree, and this writer saw only its file names in one `git status` line and opened none of them. The
verifier was committed later the same day (`d6618f79`, `937f6e7b`); the eleven vectors of the review round (below)
were added after that, again without opening it.

**The merge rule.** Every commit this file cites (the record's `930b7d4c`, `5e01fff0`, `f1864cbf` and `8ea9d58c`;
the verifier's `d6618f79` and `937f6e7b`; the review's `aeda35af`; `d2784a2b`, which holds the generator of the first
five files) is a commit of the phase branch `feat/updates-trust-core`. Each stays reachable, and so citable, only if
the phase's pull request is merged with a merge commit (as PR #1055 was), not squashed or rebased.

An independent review (Opus 5.5, the same day) re-derived every `expect` from the record with its own code, written
before it opened this generator: no `expect` was wrong. Its mutation run (231 deliberate verifier bugs) found eight
that no vector caught; eleven vectors were added for them and for three cases the first round had left out
(`cap-payload-largest-accepted`, `order-win32-form-before-host-glibc`, `pay-other-floors-not-with-a-files-refusal`,
`pay-min-pre-release-and-build-above-running`, `pay-floor-linux-host-leading-zero-below`,
`env-text-not-utf8-lead-f5`, `env-entry-sig-four-spaces-inside-alone` and `-then-good-accepted`,
`pay-files-install-as-empty-accepted`, `ver-running-build-metadata-equal`,
`ver-running-build-metadata-above-accepted`), the generator was run again (new keys and signatures throughout), and
the reviewer's checker agreed with all 849.

**Added on 2026-11-26, before release 1: `vectors-edges.json`** (20 vectors; the adversarial review of the trust
core, T4.4d). The five files above stay byte for byte as committed; the new file has its own section below
("`vectors-edges.json`"), with its sources, its run and what its writer opened.

**Added on 2026-11-26, before release 1: `vectors-review2.json`** (4 vectors; the second review of F-1–F-4, T4.5:
its M-1, m-7 and m-6). The six files above stay byte for byte as committed; the new file has its own section below
("`vectors-review2.json`"). The same round wrote out in full every sha256 this file cites, named the commit of the
earlier generator, and stated the merge rule above and the limit on working papers below (the review's m-12).

**Changed on 2026-11-26, before release 1 (after P4's docs at `8ea9d58c`; their review's m-10): this file only.** The
two places in "`vectors-review2.json`" that waited for a later commit of the record (the M-1 wording and "`-0` is 0")
name `8ea9d58c`, and one limit says what the run of every vector under Electron at P4's exit settles, each with its
_Was:_; the merge rule names `8ea9d58c`. No vector and no other file of the set changed.

## Sources

| Source | Version | Used for |
|---|---|---|
| `docs/app-updates.md` §2.3, §2.4, §2.5, §2.7, §2.8, §2.10, §4.3, §4.4, §4.5, §4.7, §5.8, §8.5, §10.7 | commit `930b7d4c` | every `expect` |
| DSSE `protocol.md`, `envelope.md` | `secure-systems-lab/dsse` commit `75a79b6ed61c63dabf291657e076d120d95a39a1` | the PAE every signature is made over; the envelope's fields |
| RFC 8032 §5.1.7 | January 2017 | `env-verify-signature-s-not-below-l` (S is below the group order L) |
| semver.org 2.0.0 §11 | as `version.ts` cites it | the version rule's order vectors |
| `src/main/services/updates/version.ts`, `drive-release.ts` (frozen in P3, read, not imported) | commit `930b7d4c` | which strings are versions; how `rootApps` lists a root |
| `docs/app-updates.md` §2.3, §2.4, §2.5, §2.10, §4.3, §4.5, §10.7; `version.ts` (read, not imported) | commit `5e01fff0` | every `expect` of `vectors-edges.json` |
| `docs/app-updates.md` §2.3, §2.4, §2.7 ("A weak key": the `y` of the order-8 points), §2.10, §4.3, §4.4, §10.7 | commit `f1864cbf` | every `expect` of `vectors-review2.json` |
| The second review's disposition table (the orchestrator, 2026-11-26; a working paper, not in the repository): the rows M-1, m-6 and m-7, and the orchestrator's note of the same day on m-6 | 2026-11-26 | which of RFC 8032 §5.1.7's two equations release 1 checks; that a `size` of `-0` is carried as 0 (below, "`vectors-review2.json`") |
| RFC 8032 §5.1 (the constants), §5.1.2, §5.1.3, §5.1.4, §5.1.5, §5.1.6, §5.1.7 | January 2017 | the curve arithmetic, the signature and the two equations of `rev2-verify-cofactored-only-…` |

**The reference copies.** DSSE's files and the RFC were read from copies the orchestrator fetched on 2026-11-26. They
are working papers of the wave and are not in the repository; a reader who fetches the same versions can compare:

| Copy | Version | sha256 of the copy |
|---|---|---|
| DSSE `protocol.md` | `secure-systems-lab/dsse` commit `75a79b6ed61c63dabf291657e076d120d95a39a1` | `6c0d965475162230f9f461acf634b4d4b409eab1a1839d31a9c24c76b3676253` |
| DSSE `envelope.md` | the same commit | `3a8e7370671354cf3d3417c818a44dcda02cbc57dce6f4b6a75a84c41c483074` |
| RFC 8032, plain text (RFC Editor) | January 2017 | `ed63657ff389301282b169b0abde9b5dd2c7e4d524fdfa5da6ff3094fc93c4c3` |

DSSE's Python reference implementation (`signing_spec.py`) was not opened and is no oracle here (§2.3).

## Every file the writer opened

The task's two briefs (`impl/p4/T4.4b/brief.md`, `impl/p4/brief-common.md`); `impl/p4/T4.0/values.md`;
`impl/p4/inputs/SOURCES.md`, `dsse-protocol.md`, `dsse-envelope.md`, `rfc8032.txt` (§7.1);
`docs/app-updates.md` (§1.6, §2, §4.3–§4.7, §5.8, §8.5, §10.7, §12.1's legend table);
`apps/desktop/src/main/services/updates/version.ts` and `drive-release.ts`;
`apps/desktop/src/shared/i18n/languages.ts` (the ten codes);
`apps/desktop/tests/fixtures/readers/f8-policy/PROVENANCE.md` (the form);
the first lines of `apps/desktop/tests/fixtures/golden-fixtures.sha256` and the golden-manifest rows of
`apps/desktop/tests/integration/repo-hygiene.test.ts`; `.gitattributes` (that `apps/desktop/tests/fixtures/**` is
`-text`, so the bytes stay as written). One `git status --short | head -5` in the tree printed the names of T4.1's
then uncommitted verifier files: names only, no content.

In the review round: its brief (`impl/p4/T4.4b/fix-brief.md`), the orchestrator's answers (`decisions.md`), the
review (`review/review.md`) and the reviewer's scripts, which are its own reading of the record and not the verifier
(run read-only over the new set; `run.mjs` read, the first lines of `ref.mjs` and `mutate.mjs`, the invocation lines
of the others); and the record's §2.3, §2.4, §2.5, §2.10 and §10.7 again.

Nothing else: not `envelope.ts`, `payload.ts`, `keys.ts`, `keys.json`, `member-name.ts`, `bundle-check.ts`,
`src/shared/updates/`, any `updates-*.test.ts`, the positive set or its generator, nor the working papers of the
verifier's tasks.

## The files

873 vectors: 849 in the five files of the first writing, 20 in `vectors-edges.json`, 4 in `vectors-review2.json`. An
id that ends in `-accepted` has the code `accepted`; every other vector is a refusal.

**A test routes a vector by its form, never by its file or by `expect.stage`** (§10.7 "A vector"):

- a vector with an `envelope` runs the whole pipeline: the envelope, then the payload with the version rule inside it,
  whatever its `expect.stage` says (`envelope`, `payload` or `version-rule`);
- a vector with `version` and no `envelope` runs the version rule alone;
- `expect.stage` is then compared as part of the answer, like `code`, `params` and `flags`.

A test that picked its vectors by `expect.stage` would drop the eleven envelope-form vectors whose stage is
`version-rule` (§10.7 "`expect`": "a vector with an `envelope` whose answer is `UPD-SAME-OR-OLDER` has
`version-rule`"): `ver-envelope-equal-running`, `-below-running`, `-below-drive`, `-key-proof` and
`-build-metadata-equal-running` in `vectors-payload.json`; `order-version-rule-before-cap`, `-before-requires`,
`-before-linux-floor`, `-before-own-floor`, `-before-files` and `order-stale-flag-with-same-or-older` in
`vectors-order.json`. A payload test never sees them by stage, and a version-rule test cannot run them (they hold no
`version` and no rule inputs alone).

| File | Vectors | Holds | Form | Read by |
|---|---|---|---|---|
| `vectors-envelope.json` | 237 | §2.3's table row by row: the key set, text, JSON, `signatures`, `payloadType`, `payload`, the base64 grammar, each skipped signature entry, the deciding rule, `keyid` as a hint, what is signed, a verified envelope's type | all with an `envelope` | the pipeline's tests: `tests/unit/updates-envelope.test.ts` and `updates-payload.test.ts` (57 of its vectors have the stage `payload`: 56 accepted, one refused by the payload's reading) |
| `vectors-payload.json` | 480 | §2.4's table: reading, `format`, `product`, `kind`, `channel`, `version`, `min_upgrade_from`, the policy's cap, `requires` and the floors on each host, `issued`, `summary`, `files[]` (§4.3) and the member-name rule (§4.4); six version-rule answers behind an envelope (five of them with the stage `version-rule`) | all with an `envelope` | the pipeline's tests |
| `vectors-order.json` | 66 | §4.5's order: pairs of two failing checks with different codes, the earlier one expected; `staleDriveVersion` before and after the version rule; the address set's `runningVersion` (stages `envelope`, `payload` and, for six, `version-rule`) | all with an `envelope` | the pipeline's tests |
| `vectors-version-rule.json` | 57 | §2.5, the version rule alone (§10.7's second form) | all with `version`, none with an `envelope` | `tests/unit/updates-payload.test.ts`'s version-rule runner (T4.4, 2026-11-26: the T4.2 sheet's Q5 put both runners in that file; _Was:_ `tests/unit/updates-version.test.ts`) |
| `vectors-caps.json` | 9 | the large boundary vectors: the 4,194,304-byte envelope (as `parts` with `repeat`), 4,096 / 4,097 `files[]` entries, and the largest payload an envelope at the cap can carry (3,145,523 bytes) | all with an `envelope` | the pipeline's tests |
| `vectors-edges.json` | 20 | the cases the adversarial review found without a vector: a payload's unused base64 bits beyond the lowest one (§2.3), a line feed after a `sha256`, a `version` and an `issued`, a parameter with build metadata as written, a `payloadType` equal to the release type only after Unicode normalisation, and three versions that only the writers' duties forbid (its own section below) | all with an `envelope` | the pipeline's tests |
| `vectors-review2.json` | 4 | the second review's cases: a signature by the embedded key that satisfies only the equation with the factor 8 of RFC 8032 §5.1.7, with its control; lone surrogates, written as JSON escapes, in strings release 1 never interprets; a `files[]` `size` written `-0`, carried as 0 (its own section below) | all with an `envelope` | the pipeline's tests |
| `generate.mjs` | — | how the set was made | — | — |

Each file is a JSON array with one vector per line, plain ASCII (every other character is a `\u` escape). An envelope
whose bytes are plain UTF-8 text is held as `{"parts": [{"text": …}]}`, so it can be read; any other as base64.

## What every 64-character hex value is

A raw 32-byte seed cannot be told from a public key or a hash by its looks (§10.7 "No private key"), so, for a reader
who meets one in these files:

- every `files[].sha256` (in a payload and in an accepted `expect`) is the SHA-256 of a fixed label, not of a file:
  `generate.mjs`'s `H('apply.cmd')`, `H('exe')`, `H('start')`, `H('member')` and `H('x')`. The vectors that test the
  `sha256` rule itself change such a value (its case, its length, one character) and say so in `why`;
- every 64-character `keyid` is the SHA-256 of an SPKI (§2.7): a key of the vector's `keys`, or a key this run made
  and wrote nowhere else (an unknown signer), or such an id changed on purpose (upper case, a trailing space);
- a `sig` is 64 bytes in base64, never hex, except `env-entry-sig-hex-*`, which hold a signature as 128 hex
  characters.

No other 64-character hex value is written. A reviewer's scan tried every 32-byte value of every layer (the files'
text, each envelope's decoded bytes, each decoded payload, each `sig`) as an Ed25519 seed against the set's public
keys and key ids, and found none.

## Keys and signatures

`node generate.mjs --out <an empty folder>`, Node 24.13.0 (OpenSSL), Windows 11; the run that wrote this set made 696
key pairs. Each pair is made in memory with `generateKeyPairSync('ed25519')`; the private half signs inside the
generator and is never exported to a file, printed or logged; only the public half is written, as §2.7's SPKI in
base64. **No file holds a private key**, a seed, a PEM or JWK text or a PKCS#8 structure. The generator's last step
scans what it wrote (and itself) for those forms and for every seed of its own run, which it holds in memory only for
that scan. That scan reads the files' text only, not the bytes inside the envelopes and payloads they hold; the
reviewer's seed scan (above, "What every 64-character hex value is") covered those layers.

So a new run gives other keys and other signatures: **the committed vectors are the golden**, and the generator
documents how they were made; it refuses to write into a folder that already holds vectors. Every signature is a real
Ed25519 signature over the exact `DSSEv1` PAE bytes (byte counts), except where a vector's `why` says what was signed
instead. The committed vectors are the output of one run of the committed `generate.mjs`, unchanged since.

## Self-check and review

A second script, written after the generator from the record's tables and kept with the task's working papers (not in
the repository), rebuilt every envelope's bytes from its vector, decoded each base64 string strictly, rebuilt the PAE,
verified the signatures with `node:crypto` and derived the whole `expect` again: 849 of 849 agree. It shares this
writer's reading of the record, so it proves the vectors are what they claim, not that the reading is right.

**A limit: the checkers are not in the repository.** Every self-check script of this set (this section's, the one of
`vectors-edges.json`, the one of `vectors-review2.json`) and every reviewer's checker and mutation run named in this
file are working papers of the wave, kept outside the repository. A later reader cannot run them again from the
repository: what the repository holds is the vectors, this generator and the tests that read the vectors. The
agreement counts in this file are a record of runs made on 2026-11-26, not something the repository proves.

The reviewer's checker is the independent half: another model's reading of the same record rows, written before it
opened this generator or the self-check. It agrees with all 849 vectors, every field of `expect` compared, and its
eight uncaught mutations are caught by the vectors named above.

## `vectors-edges.json` (added 2026-11-26; the adversarial review, T4.4d)

An adversarial review of the trust core (Fable 5.2, at `aeda35af`) found the verifier sound and named cases that no
vector held: its M-2, m-5 and m-9. The same writer as the rest of this set (Fable 5.2, task "T4.4b edges") wrote a
vector for each **from the record at commit `5e01fff0` only**: §2.3 ("The base64 grammar", "`payload`", "A verified
envelope's type"), §2.4 ("Reading", "`version`", "`issued`", "`files`", "Later writers: `version`"), §2.5 ("Order"),
§2.10 ("The parameters"), §4.3 ("`files[]` entries", "DSSE `payloadType`"), §4.5 ("Order of an import") and §10.7.
Every `expect` is stated by hand in `generate.mjs` from those rows; none comes from the code under test. The verifier
was being changed in the tree at that time (its fix round 4); neither it, its tests nor their working papers were
opened.

**What the writer opened for this file:** its brief (`impl/p4/T4.4b/edges-brief.md`) and `impl/p4/brief-common.md`;
the review's disposition table (`impl/p4/T4.4d/review-disposition.md`: one line per finding, with the inputs; not the
review itself); the record's sections named above and §2.7, §2.8, §2.9, §5.3 ("The 24-byte version cap") at
`5e01fff0`; `apps/desktop/src/main/services/updates/version.ts` at `5e01fff0` (frozen in P3: which strings are
versions, and their order); this set's own committed files and the reports of its earlier rounds; `impl/ledger.md`'s
two lines CF-51 and CF-52; `impl/p4/inputs/SOURCES.md`. Nothing else: not `envelope.ts`, `payload.ts`, `keys.ts`,
`keys.json`, `member-name.ts`, `bundle-check.ts`, `src/shared/updates/`, any `updates-*.test.ts`,
`tests/helpers/update-vectors.ts`, the positive set, nor the review's own text and scripts.

| Finding | Vectors | Expect | Record row |
|---|---|---|---|
| M-2: a payload whose last base64 character has an unused bit set, other than the lowest one in the standard alphabet | `edge-b64-payload-highest-pad-bit-one-pad` (`AAC=`), `-highest-pad-bit-two-pads` (`AI==`), `-pad-bit-url-safe` (`-_9=`): the group as the whole payload; and each again with `-last-group`: the group after the base64 of a real payload | `UPD-FILE-DAMAGED` (envelope) | §2.3 "The base64 grammar" ("The unused bits of the last character before the padding are zero"), "`payload`" |
| M-2, the controls | `edge-b64-payload-…-control-zero-bits` (3): the same envelope and signature with `AAA=`, `AA==`, `-_8=` | `UPD-TOO-NEW` (payload): the string is in the grammar, the signature verifies, and the two bytes (or one) are no JSON text or no UTF-8 | §2.3 "The base64 grammar"; §2.4 "Reading" |
| m-5: a `sha256` with a line feed | `edge-files-sha256-line-feed-after`, `-before` | `UPD-TOO-NEW` | §4.3 "`files[]` entries" ("64 hex characters"); §2.4 "`files`" |
| m-5: a version with a line feed | `edge-version-line-feed-after-pre-release` (`1.0.1-a` + LF), `-after-build` (`1.0.1+b` + LF) | `UPD-TOO-NEW` | §2.4 "`version`" |
| m-5: `issued` with a line feed | `edge-issued-line-feed-after-old-accepted`, `-future-accepted` | accepted, `issued` null, no notice | §2.4 "`issued`" ("exactly … 20 ASCII bytes"; "anything else: no date is shown and neither clock check runs") |
| m-5: a parameter as written | `edge-cap-version-build-metadata-as-written` (`2.0.0+b` over the cap `1.5.0`) | `UPD-ABOVE-MAX-VERSION`, `version` `2.0.0+b`, `maxVersion` `1.5.0` | §2.10 "The parameters" |
| m-5: a type equal only after normalisation | `edge-type-full-width-plus-known-key` (U+FF0B for `+`) | `UPD-FOR-NEWER-HILBERTRAUM` (envelope) | §2.3 "A verified envelope's type" ("code unit for code unit"); §4.3 "DSSE `payloadType`" |
| m-9: versions only the writers' duties forbid | `edge-writer-duty-build-metadata-accepted` (`1.0.1+b`), `-pre-release-case-accepted` (`1.0.0-rc1` over a running `1.0.0-RC1`), `-60-digit-major-accepted` (a 60-digit major, 64 bytes) | accepted, the version as written | §2.4 "`version`"; §2.5 "Order" |

**The M-2 vectors.** `AAC=` and `AI==` set only the highest unused bit of their last character (the first writing's
`env-b64-payload-non-zero-pad-bits-…` vectors set the lowest); `-_9=` sets an unused bit in the URL-safe alphabet. A
decoder that does not look at those bits reads `00 00`, `00` and `fb ff`. In each vector the embedded key's signature
is over exactly those bytes (after the real payload's bytes in the `-last-group` vectors), so a reader with a lenient
decoder verifies the signature and goes on, and only the grammar refuses the file. The generator holds this with its
own lenient reading and with Node's `Buffer.from(…, 'base64')`, which is lenient too; the self-check holds it again
with a strict and a lenient decoder of its own. Such a lenient reader would answer `UPD-TOO-NEW` from the payload (the
bytes are no JSON text), not `accepted`: no last group with a non-zero unused bit can end a JSON text here, since the
three strings fix the last bytes. Each control shares its vector's key and signature and differs in the one
character.

**The m-9 vectors pin release 1's reader, and no writer may write these versions.** Release 1 accepts all three for
ever: its `version` rule is SemVer 2.0.0 of at most 64 bytes. §2.4's "Later writers: `version`" forbids the first two
(no build metadata; no two releases that differ only in the case of a pre-release identifier). The record names no
writer bound for the third beyond the 64 bytes (§5.3's "24-byte version cap" only says how `update.log` shows a longer
version); the release tools are to refuse all three before a release is signed (P5's `check-draft`; the wave's
ledger, CF-52).

**How the file was made.** `node generate.mjs --out <an empty folder> --only=vectors-edges.json`, Node 24.13.0
(OpenSSL), Windows 11. That form builds every vector of the set as a full run does (so an id of the new file cannot
repeat an older one) and writes this file alone; the run made 709 key pairs, of which this file's vectors use 17
(the other 692 belong to vectors that were built and not written). A full run (`--out` alone) writes all six files,
the five of the first writing with other keys and signatures than the committed ones. Both forms refuse a folder that
holds a vectors file, so neither can replace a committed file: **the committed files are the golden**, and of the six
only `vectors-edges.json` is the output of the `generate.mjs` committed with it; the other five are the output of
the generator as it stood before this file was added (sha256
`59421ef8ce1b023e11925c0eb366dc15f373dc052730f5ed3204d50687b05baf`: the `generate.mjs` of commit `d2784a2b`, "add the
negative and spec contract vectors", in the phase's history), whose vector-building code for them is unchanged. Keys as in "Keys and signatures" above: made in memory, the private half
never written, the generator's last step scanning what it wrote.

**Self-check.** A second script (with the task's working papers, not in the repository), written after the generator
from the same record rows with its own strict and lenient base64 decoders, its own PAE and its own reading of the
payload, rebuilt each envelope's bytes, verified the signatures with `node:crypto` and derived each `expect` again:
20 of 20 agree. It shares this writer's reading of the record. The first writing's reviewer did not see these 20.

**Limits.** No M-2 vector covers a `sig` (the first writing's `env-entry-sig-non-zero-pad-bits…` vectors hold the
lowest bit there, and a skipped signature entry is never a refusal of its own). The line-feed vectors hold U+000A
only, at the end (and, for `sha256`, at the start), not other control characters.

## `vectors-review2.json` (added 2026-11-26; the second review, T4.5)

The second review of F-1–F-4 (Fable 5.2, at `f1864cbf`; its lens: a later maintainer writes a second reader from the
record alone) found no disagreement between code and record, and named cases that no vector held: its M-1, m-7
and m-6. The same writer as the rest of this set (Fable 5.2, task "T4.4b review-2 vectors") wrote the four vectors
**from the record at commit `f1864cbf`, RFC 8032 §5.1 and the review's disposition table only** (with the
orchestrator's note of the same day on m-6). Every `expect` is
stated by hand in `generate.mjs`; none comes from the code under test. The verifier's payload check was being changed
in the tree at that time; neither the verifier, its tests nor their working papers were opened.

**What the writer opened for this file:** its brief (`impl/p4/T4.4b/review2-brief.md`) and `impl/p4/brief-common.md`;
the review's disposition table (`impl/p4/T4.5/review-disposition.md`: one line per finding, and the orchestrator's
measurement for M-1; not the review itself, nor its scripts); the record's §2.3, §2.4, §2.7, §2.10, §4.3, §4.4 and
§10.7 at `f1864cbf`; RFC 8032 §5.1's table of constants and §5.1.3, §5.1.6, §5.1.7 in the reference copy;
`impl/p4/inputs/SOURCES.md`; this set's committed files, the `PROVENANCE.md` of the `spec/` and `positive/` sets, and
`spec/ed25519.json` (RFC 8032 §7.1's five vectors, read by the self-check to prove its arithmetic); the reports of
this set's earlier rounds; the update lines of `golden-fixtures.sha256`; `git log` of the phase branch. Nothing else:
not `envelope.ts`, `payload.ts`, `keys.ts`, `keys.json`, `member-name.ts`, `bundle-check.ts`, `src/shared/updates/`,
`tests/unit/updates-envelope.test.ts`, `updates-payload.test.ts`, `tests/helpers/update-vectors.ts`, the positive
set's vectors or generator, nor the working papers of the verifier's tasks.

| Finding | Vector | Expect | Record row |
|---|---|---|---|
| M-1: RFC 8032 §5.1.7 allows two group equations, and they disagree on some signatures | `rev2-verify-cofactored-only-order-8-in-r`: one signature, made with the embedded key's private half and named by its `keyid`, that satisfies `[8][S]B = [8]R + [8][k]A` and not `[S]B = R + [k]A` | `UPD-NOT-GENUINE` (envelope) | §2.3 "Verification" (Ed25519 "through `crypto.verify(null, …)`"), as the disposition states it: `S` below L and `[S]B = R + [k]A` without the factor 8; "No signature verifies" (an entry names an embedded key's id) |
| M-1, the control | `rev2-verify-cofactored-only-control-standard-signature-accepted`: the same key, payload and envelope with the key's standard RFC 8032 signature | accepted | §2.3 "Verification" |
| m-7: an escaped lone surrogate in a string release 1 does not interpret | `rev2-lone-surrogates-in-ignored-strings-accepted`: the JSON escapes for U+D800 and U+DFFF in an ignored key of the envelope and its value, in the `keyid` of a first signature entry that no embedded key verifies (the embedded key's entry follows), in an ignored key of the payload, its value and a nested value, and in the `group` and the `install_as` of two `files[]` entries | accepted; `group` and `installAs` carried as written (the code units) | §2.3 "JSON" (`JSON.parse`; unknown keys ignored; keys compared code unit for code unit), "`keyid`", "Verification" (the first entry that one key verifies accepts); §2.4 "`group`", "`install_as`"; §2.10 "An accepted payload" |
| m-6: a `files[]` `size` written `-0` | `rev2-files-size-minus-zero-carried-as-zero-accepted`: the base payload with its first entry's `size` written `-0` | accepted; that entry's `size` is 0 | §4.3 "`files[]` entries" (the value `JSON.parse` gives is a safe integer from 0 to 8,589,934,591: -0 is one); §2.10 "An accepted payload"; that the entry carries 0 and never -0 is the orchestrator's decision of 2026-11-26 on m-6 ("`-0` is 0") |

**Where the M-1 answer comes from.** The record at `f1864cbf` names RFC 8032 §5.1.7 and `crypto.verify`; §5.1.7 step
3 gives the equation with the factor 8 and says the one without it is sufficient, so the RFC alone does not decide
this vector. The answer is the review's disposition (the orchestrator, 2026-11-26): release 1 checks `S` below L and
`[S]B = R + [k]A` without the factor 8, which is what Node 24.13.0's OpenSSL 3.5.4 and Electron 43.8.10's BoringSSL
both decide; the record's §2.3 "Verification" says so since commit `8ea9d58c` (T4.D, P4's docs), which is this
vector's record row. _Was:_ "is to say so in a commit after `f1864cbf`, which this file cannot name yet. If that
wording does not land, this vector has no record row and is an owner call."

**How the M-1 signature was made.** The generator holds Ed25519's curve arithmetic of its own in BigInt (RFC 8032
§5.1: the constants, the encoding, §5.1.3's decoding, the addition law; proved in the run on the base point as the
RFC prints it and on its order L). It makes one key pair at run time, takes the pair's scalar as §5.1.5 derives it
from the seed (checked: the scalar times the base point is the pair's public key), draws a random nonce r, and forms
`R` = [r]B + T and `S` = (r + k * scalar) mod L, with k the SHA-512 of `R`, the key and the PAE as §5.1.6 step 4 says.
T is a point of order 8: the first of the two `y` values that §2.7 "A weak key" prints, sign bit clear, decoded by
§5.1.3 and proved in the run ([8]T is the neutral point, [4]T is not). Before the vector is written the run proves,
with that arithmetic and no library: `R` decodes and is in its canonical form; `S` is below L; the equation with the
factor 8 holds; the one without it does not; `R` is no small-order point and its part outside the prime-order group
has order exactly 8; the key is a point of order L (so no weak key of §2.7); the control's signature satisfies both
equations. Then `crypto.verify` is asked: it refuses the signature and accepts the control's, or the run stops.

**Both runtimes** (the self-check, below, run once on each, over the committed file): Node 24.13.0 (OpenSSL 3.5.4)
and the unpacked Electron 43.8.10 (BoringSSL; its Node 24.22.1, with `ELECTRON_RUN_AS_NODE`) both give `false` for
the M-1 signature and `true` for the control's, and the same answers for the two entries of the third vector.

**The private half.** The pair's seed, its scalar and the nonce stay in the variables of the generator's block; none
is exported to a file, printed or logged, and all are gone when the process ends (C8; §10.7 "No private key"). The
block checks that none of them stands in the two envelopes' bytes, and the last step scans the written file's text
for them (hex, base64, base64url) with the other seeds of the run. A signature with a random nonce reveals nothing
about the key as long as the nonce is not reused or revealed; this nonce signed once.

**The m-7 strings.** A lone surrogate has no UTF-8 form (§2.3 "Text"), so it stands in a JSON text only as an escape,
and the text is plain ASCII: the envelope holds `\uD800` twice and `\uDFFF` once, the payload `\uD800` six times and
`\uDFFF` five times. One `group` is U+D800 alone and the other is U+DFFF followed by U+D800 (two lone surrogates, no
pair), so a reader that replaced them (by U+FFFD, on a way through UTF-8) would hand back other strings than the
`expect` holds, and could no longer tell the two groups' code units apart from any other replaced string. In the
vector file the `expect`'s strings are `\ud800` and `\udfff` escapes as well. §2.4's "Later writers" rows do not yet
forbid such strings; the disposition gives the writers that duty (write none), and the release tools are to refuse
them. This vector pins release 1's reader only.

**The m-6 size.** `JSON.stringify` writes the number -0 as `0`, so the payload's text is made by replacing the first
entry's number with the two characters `-0`; the run checks that `JSON.parse` gives -0 for it (`Object.is`). The
record at `f1864cbf` accepts the value (§4.3: a safe integer in the range) and does not say which zero an accepted
payload carries; the orchestrator's decision on m-6 is that it carries 0, and the record's §4.3 says "`-0` is 0"
since commit `8ea9d58c` (_Was:_ "is to say … in a commit after `f1864cbf`, which this file cannot name yet"). The
vector's `expect` holds `0`, as JSON writes either zero: **a test whose equality does not tell -0 from 0 (a
comparison of JSON texts, or `==`) does not prove this vector's point**; one that does (`Object.is`, or a deep
equality that tells the two apart) does.

**How the file was made.** `node generate.mjs --out <an empty folder> --only=vectors-review2.json`, Node 24.13.0
(OpenSSL 3.5.4), Windows 11. Like the `--only=vectors-edges.json` form it builds every vector of the set (so an id of
the new file cannot repeat an older one) and writes this file alone; the run made 713 key pairs, of which this file's
vectors use four (the M-1 pair, the third vector's embedded key and the key of its first signature entry, which the
verifier does not embed, and the fourth vector's key). Both `--only` forms and a full run refuse a folder that holds a vectors file. **The
committed files are the golden**, and of the seven only `vectors-review2.json` is the output of the `generate.mjs`
committed with it: `vectors-edges.json` is the output of the generator at `f1864cbf` (sha256
`2d8dddb9279cadee790abf5e674ba78ddd62c89c1ecc1c736067966236e62a78`), and the first five of the generator at
`d2784a2b` (sha256 `59421ef8ce1b023e11925c0eb366dc15f373dc052730f5ed3204d50687b05baf`); the vector-building code for
those six is unchanged, and a full run of this generator to a scratch folder gave their 869 ids with the same `why`,
`host` and `expect` as the committed files.

**Self-check.** A second script (with the task's working papers, not in the repository), written after the generator
with curve arithmetic of its own in another form (extended coordinates, RFC 8032 §5.1.4), its own strict base64
reading and its own PAE: its arithmetic verifies RFC 8032 §7.1's five vectors (`spec/ed25519.json`) under both
equations; it re-derived each `expect` (4 of 4 agree), confirmed each claim above for the M-1 signature and its
control, counted the escapes, found no replacement character, found the one `-0` in the fourth payload's text, and tried every 32-byte window of each envelope,
payload and signature as an Ed25519 seed, and each signature half as a scalar, against the vectors' keys (none). It
shares this writer's reading of the record. No reviewer has seen these four vectors.

**Limits.** One M-1 vector: the part of order 8 stands in `R`, of a signature whose key is an ordinary one. A key
with such a part is not covered here (§2.7's weak-key row covers only the small-order keys, as it says). The vector
holds a part of order 8, not one of order 2 or 4. The m-7 vector holds U+D800 and U+DFFF only, and no lone surrogate
in a field release 1 interprets: `payloadType` (refused: `env-type-…` in `vectors-envelope.json`) and `summary`
(ignored: `pay-summary-lone-surrogate-…`) have their vectors; a member `name` with one breaks §4.4's character rule.

## Limits a reader should know

- `now` has whole seconds (§10.7), so the vectors past the 24-hour and 365-day boundaries are 1,000 ms past them, not
  1 ms.
- No vector expects a depth refusal, and none nests deeper than a few levels (§10.7 "Depth").
- `env-verify-signature-s-not-below-l` holds under Node's OpenSSL here, and gave the same answer under Electron
  43.8.10's BoringSSL, with every vector of this set as committed at `8ea9d58c` (measured at P4's exit, outside the
  repository). _Was:_ "T4.4c runs it under Electron's BoringSSL."
- Not covered, because §10.7's schema cannot say it: a host `osVersion` of `null` on `win32` or `darwin` (the schema
  types it as `process.getSystemVersion()`'s string there).
- A `files[]` `size` written `-0` is accepted and carried as 0 (`JSON.parse` gives -0, a safe integer in §4.3's range;
  the orchestrator's decision of 2026-11-26 on the second review's m-6: "`-0` is 0"). Its vector is
  `rev2-files-size-minus-zero-carried-as-zero-accepted` in `vectors-review2.json`. _Was:_ "Left out, though the
  record decides it: … a vector's `expect` cannot hold the value" (true of -0 itself; the expected value is now 0,
  which a vector can hold).
- `cap-payload-largest-accepted` carries its padding inside the payload; one letter in an ignored envelope key fits
  the base64's blocks of four characters to the cap. The other cap vectors pad an ignored envelope key around a small
  payload.
- The routing rule above ("The files") is the tests' duty: nothing in a vector file enforces it.
