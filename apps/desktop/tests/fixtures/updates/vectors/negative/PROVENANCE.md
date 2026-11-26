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

The record commit `930b7d4c` stays citable only while the phase's pull request keeps it reachable: merged with a
merge commit (as PR #1055 was), not squashed.

An independent review (Opus 5.5, the same day) re-derived every `expect` from the record with its own code, written
before it opened this generator: no `expect` was wrong. Its mutation run (231 deliberate verifier bugs) found eight
that no vector caught; eleven vectors were added for them and for three cases the first round had left out
(`cap-payload-largest-accepted`, `order-win32-form-before-host-glibc`, `pay-other-floors-not-with-a-files-refusal`,
`pay-min-pre-release-and-build-above-running`, `pay-floor-linux-host-leading-zero-below`,
`env-text-not-utf8-lead-f5`, `env-entry-sig-four-spaces-inside-alone` and `-then-good-accepted`,
`pay-files-install-as-empty-accepted`, `ver-running-build-metadata-equal`,
`ver-running-build-metadata-above-accepted`), the generator was run again (new keys and signatures throughout), and
the reviewer's checker agreed with all 849.

## Sources

| Source | Version | Used for |
|---|---|---|
| `docs/app-updates.md` §2.3, §2.4, §2.5, §2.7, §2.8, §2.10, §4.3, §4.4, §4.5, §4.7, §5.8, §8.5, §10.7 | commit `930b7d4c` | every `expect` |
| DSSE `protocol.md`, `envelope.md` | `secure-systems-lab/dsse` commit `75a79b6ed61c63dabf291657e076d120d95a39a1` | the PAE every signature is made over; the envelope's fields |
| RFC 8032 §5.1.7 | January 2017 | `env-verify-signature-s-not-below-l` (S is below the group order L) |
| semver.org 2.0.0 §11 | as `version.ts` cites it | the version rule's order vectors |
| `src/main/services/updates/version.ts`, `drive-release.ts` (frozen in P3, read, not imported) | commit `930b7d4c` | which strings are versions; how `rootApps` lists a root |

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

849 vectors. An id that ends in `-accepted` has the code `accepted`; every other vector is a refusal.

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
| `vectors-version-rule.json` | 57 | §2.5, the version rule alone (§10.7's second form) | all with `version`, none with an `envelope` | `tests/unit/updates-version.test.ts` |
| `vectors-caps.json` | 9 | the large boundary vectors: the 4,194,304-byte envelope (as `parts` with `repeat`), 4,096 / 4,097 `files[]` entries, and the largest payload an envelope at the cap can carry (3,145,523 bytes) | all with an `envelope` | the pipeline's tests |
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

The reviewer's checker is the independent half: another model's reading of the same record rows, written before it
opened this generator or the self-check. It agrees with all 849 vectors, every field of `expect` compared, and its
eight uncaught mutations are caught by the vectors named above.

## Limits a reader should know

- `now` has whole seconds (§10.7), so the vectors past the 24-hour and 365-day boundaries are 1,000 ms past them, not
  1 ms.
- No vector expects a depth refusal, and none nests deeper than a few levels (§10.7 "Depth").
- `env-verify-signature-s-not-below-l` holds under Node's OpenSSL here; T4.4c runs it under Electron's BoringSSL.
- Not covered, because §10.7's schema cannot say it: a host `osVersion` of `null` on `win32` or `darwin` (the schema
  types it as `process.getSystemVersion()`'s string there).
- Left out, though the record decides it: a `files[]` `size` of `-0`. `JSON.parse` gives -0, a safe integer in range,
  so §4.3's row accepts it; but `JSON.stringify` writes -0 as `0`, so a vector's `expect` cannot hold the value, and
  a test's deep equality tells -0 from 0.
- `cap-payload-largest-accepted` carries its padding inside the payload; one letter in an ignored envelope key fits
  the base64's blocks of four characters to the cap. The other cap vectors pad an ignored envelope key around a small
  payload.
- The routing rule above ("The files") is the tests' duty: nothing in a vector file enforces it.
