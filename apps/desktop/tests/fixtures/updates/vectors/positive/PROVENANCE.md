# F-1 / F-2 / F-4 positive contract vectors (app-update wave, T4.4)

Written on 2026-11-26 by the wave's positive-vector writer (Opus 5.5, task T4.4), against the record at commit
`10989dd1` (branch `feat/updates-trust-core`; `docs/app-updates.md`), with its own generator `generate.mjs`. Each
vector is a well-formed update file's envelope (member 0) that release 1 must **accept**, now and in ten years: the
kinds of file the record lets a later writer make. Every `expect` is stated in `generate.mjs` from a row of the record,
which the vector's `why` names by section and row; none comes from the code under test. Release 1 gives these answers
for ever: the set is frozen with F-1, F-2 and F-4. A new case is a new vector; a changed vector after release 1 is an
owner call (§1.5). Locked by `../../../golden-fixtures.sha256`.

**Independence** (§10.7 "Independence"; C14): `generate.mjs` imports `node:crypto`, `node:fs`, `node:path` and
`node:url` only, nothing from `src/` and nothing of the verifier. Its DSSE PAE (`DSSEv1`, byte counts in ASCII
decimal), its base64 writer (both alphabets, with padding) and its JSON text (key order and spelling written out) are
its own, so a positive envelope is not the verifier's own output. Its generated output is checked against Node's own
base64 only (`Buffer`), never against `envelope.ts`.

Before which code existed: unlike the negative set, this set was written after the verifier (`envelope.ts`, T4.1) and
the payload check (`payload.ts`, `member-name.ts`, `version.ts`'s rule, T4.2) were committed (`10989dd1`). The writer
read their exports and the two runners, to call them from the tests, and the generator imports none of them. The
expected values were stated from the record before the set was first run through the code; that first run (76
vectors) agreed for every one, and no vector was changed after a run. One vector was added afterwards from the record
for a case the set had left out (`pos-pay-total-size-beyond-one-member`, §4.3 "Total size"), and the generator was run
once more: that run is the committed set. The record commit `10989dd1` stays citable only while the phase's pull
request keeps it reachable (a merge commit, not a squash).

## Sources

| Source | Version | Used for |
|---|---|---|
| `docs/app-updates.md` §2.1, §2.2, §2.3, §2.4, §2.5, §2.7, §2.10, §4.3, §4.4, §4.5, §6.5, §9.3, §9.6, §10.7 | commit `10989dd1` | every `expect`, every `why` |
| DSSE `protocol.md`, `envelope.md`, as the record cites them (§2.3) | `secure-systems-lab/dsse` commit `75a79b6ed61c63dabf291657e076d120d95a39a1` | the PAE every signature is made over; "consumers MUST ignore unrecognized fields"; "verifiers MUST accept either" alphabet |
| RFC 4648 §4, §5 | October 2006 | the base64 writer (both alphabets, padding) |
| RFC 8032 §5.1 (Ed25519 signatures are 64 bytes; Ed448's 114) | January 2017 | which entries count; the Ed448-sized entry |
| FIPS 204 (ML-DSA-65: 3,309-byte signatures), FIPS 205 (SLH-DSA-SHA2-128s: 7,856; SLH-DSA-SHA2-192f: 35,664) | August 2024 | the sizes of the later schemes' entries. They only make entries of another length: no expected value rests on them |

## The files

77 vectors, every one accepted (`expect.code` `accepted`, `expect.stage` `payload`). Every vector has an `envelope`
(held as `parts`); none is of the version-rule-only form. Refusals are the negative set's.

| File | Vectors | Holds | Read by |
|---|---|---|---|
| `vectors-envelope.json` | 25 | §2.3: unknown fields of every JSON type in the envelope and its signature entry, non-ASCII ones, an own `__proto__` key, 10,000 levels of nesting in an ignored key (§10.7 "Depth"), another key order and JSON whitespace, the URL-safe alphabet in `payload`, in `sig` and in both, the three padding lengths; one valid signature among later schemes' entries (first, middle, last), 64 counting entries with the valid one last, 63 entries the size of a hash-based signature and the valid one (3,003,403 bytes, §4.3 "Member 0"); two and three embedded keys signed by each in turn, 16 keys signed by the last, a `keyid` naming the other embedded key, two embedded keys both signing, a newer key's signature before the embedded key's | `tests/unit/updates-envelope.test.ts` (the envelope stage) and `tests/unit/updates-payload.test.ts` (the whole pipeline) |
| `vectors-payload.json` | 38 | §2.4, §4.3, §4.4: unknown fields at the payload's top level (the engine fields among them), in every `files[]` entry, in `requires` (unknown platforms, new keys of every value type) and in `summary` (languages release 1 does not know), and at every level at once; `summary` in all ten codes shown in each, the `en` fallback, ten values of exactly 400 code points; a pre-release version, a pre-release running app, a 64-byte version; `min_upgrade_from` met (equal, below); `updates.max_version` met (equal, above); `issued` in the future and older than 365 days (the notices with an accepted payload); the floors met on each system with the other systems' floors shown; number spellings, a pretty-printed payload in another key order, upper-case `sha256`; a 99-byte member name, an 8,589,934,591-byte member, nine such members (§4.3 "Total size"), engine archives (§6.5 "The escape hatch"), group labels of later shapes | the same two |
| `vectors-drive.json` | 8 | §2.5: the drive's `app_version` that is stale (above the file and carried by no root app, only a root file of no known version, an empty root, a carrier of its pre-release) and accepts with `staleDriveVersion`; one that counts and is met (equal to the file on a lagging system, a root `*.app` folder, an unlistable root, below the file) | the same two |
| `vectors-release.json` | 5 | §9.3 step 1: a full release's payload (the three apps, both apply scripts, the start files with `install_as`, `READ ME FIRST.txt`; `requires`, `summary` in ten codes, `issued`, `min_upgrade_from`, the engine fields) on each system, read in de, fr and uk; a fix-line patch (§9.6); the full release signed by the active and the standby key (§2.1, §9.3 step 2) | the same two |
| `vectors-largest.json` | 1 | every bound at its largest legal value in one file: 4,096 `files[]` entries with a 99-byte name and an 8,589,934,591-byte member, a 64-byte version, ten 400-code-point summaries beside unknown languages, 16 keys signed by the last, 64 signatures (63 of a hash-based scheme's size), `min_upgrade_from` and `updates.max_version` each equal to their bound; 3,710,143 bytes | the same two |
| `generate.mjs` | — | how the set was made | — |

Each file is a bare JSON array with one vector per line, plain ASCII (every other character is a `\u` escape), LF.
An envelope is held as `{"parts": [...]}`: `text` parts (its UTF-8 text), and `repeat` parts where an envelope repeats
(the 10,000 brackets; the 63 identical large signature entries), so a 3.7 MB envelope stays a 1.4 MB vector.

## Where each expected value comes from

| Field | Value | Record row |
|---|---|---|
| `stage`, `code`, `params` | `payload`, `accepted`, `{}` | §10.7 "`expect`" |
| `version`, `issued` | the payload's text as written | §2.10 "An accepted payload", "The parameters" |
| `summary` | the UI language's value when it counts, else `en`'s, else null; each vector names the text | §2.4 "`summary`" |
| `files` | in payload order: `name`, `size` (the value `JSON.parse` gives), `sha256` lower-cased, `group` or null, `installAs` (`install_as` when a string) or null | §2.10 "An accepted payload"; §2.4 "`install_as`"; §4.3 "`files[]` entries" |
| `flags.otherSystemFloors` | the floors of the systems other than the host's with an app at the root (all named ones when the root could not be listed), in the order win32, darwin, linux; stated per vector | §2.4 "The other systems' floors"; §2.10 |
| `flags.issuedInFuture`, `flags.oldFile` | `issued` more than 86,400,000 ms after `now`; `now` more than 31,536,000,000 ms after `issued`; stated per vector | §2.4 "`issued` in the future", "`issued` old" |
| `flags.staleDriveVersion` | the drive's `app_version` is not null and no root app carries it byte for byte, no root `*.app` folder exists and the root was listed; stated per vector | §2.5 "Which `app_version` counts" |

## Keys and signatures

`node generate.mjs --out <a folder that does not exist yet>`, Node 24.13.0 (OpenSSL), Windows 11 Pro; it refuses to
write into an existing folder. The run that wrote this set made **149 key pairs** (one per vector at least; the
URL-safe vectors made more until a signature held both `+` and `/`; the 64-entry vector's newer keys; the 16-key sets).
Each pair is made in memory with `generateKeyPairSync('ed25519')`; the private half signs inside the generator and is
never exported to a file, printed or logged; only the public half is written, as §2.7's SPKI in standard base64.
**No file holds a private key**, a seed, a PEM or JWK text or a PKCS#8 structure. The generator's last step scans every
file it wrote, and itself, as text for those forms and for every seed of its own run (hex in both cases, base64 with
and without padding, base64url), and scans every envelope's bytes, its decoded payload and every decoded `sig` for the
raw seeds and for the PKCS#8 start; it holds the seeds in memory for that scan only, then drops them.

So a new run gives other keys and other signatures (and other random later-scheme bytes): **the committed vectors are
the golden**; the generator documents how they were made. Two runs give the same `id`, `why`, `host`, `expect` and
payload bytes for every vector (checked when the set was made). Every Ed25519 entry that verifies is a real signature
over the exact `DSSEv1` PAE bytes of its envelope; the generator checks that some entry of each vector verifies under
one of its `keys` (its own PAE and `node:crypto`'s `verify`).

What every value that looks like key material is:

- every `files[].sha256` is the SHA-256 of the text `positive-vector <label>` (`generate.mjs`'s `H`), not of a file;
- every 64-character `keyid` is the SHA-256 of an SPKI (§2.7): of a key in the vector's `keys`, or of a newer key this
  run made and wrote nowhere else; a `keyid` with a scheme prefix (`ml-dsa-65:`, `slh-dsa-sha2-128s:`,
  `slh-dsa-sha2-192f:`, `ed448:`) carries 32 hex characters of such a label hash;
- a later scheme's `sig` is `crypto.randomBytes` output of that scheme's length, except the 35,664-byte entries, which
  are the bytes `SLH` repeated; an Ed25519 entry over another construction is a real signature over a `DSSEv2`-labelled
  encoding (§2.3 "Writers: `keyid`": another construction carries another `keyid` or none).

## Limits a reader should know

- `pos-env-depth-10000-in-ignored-key` nests 10,000 levels inside the ignored key, as §10.7 "Depth" says; with the
  envelope's own object that is 10,001 levels.
- The writer duties of §2.3 and §2.4 hold in every vector except where a vector's case is the point:
  `pos-keyid-names-the-other-embedded-key` breaks "Writers: `keyid`" (a release-1 key's signature carries its own id)
  on purpose, since §2.3 says a `keyid` is a hint and decides nothing.
- The `requires` floors and host versions are written once (`10.0.17763`, `12.0`, `2.28`; hosts `10.0.26100`,
  `14.6.1`, glibc `2.39`); the floor grammar's bounds are the negative set's.
- No vector is engine-dependent: every key is a generated point (T4.4c runs the set under Electron's BoringSSL).
- The routing rule (§10.7 "File shape and routing") is the tests' duty: both runners read this set through
  `tests/helpers/update-vectors.ts`, which fails the test file when a listed set does not exist or holds no vector.
