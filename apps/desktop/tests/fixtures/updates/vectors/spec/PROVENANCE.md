# F-1 / F-3 specification vectors (app-update wave, T4.4b)

Written on 2026-11-26 by the wave's negative-vector writer (Fable 5.2, task T4.4b), against the record at commit
`930b7d4c` (`docs/app-updates.md` §2.3, §2.7, §10.7), from the sources below only. Before which code existed: written
at `930b7d4c`, before the verifier was committed; T4.1 was writing it (the envelope's verifier, the key-set parser and
their tests) in the same tree, and this writer saw only its file names in one `git status` line and opened none of
them. No expected value was taken from the code under test. The record commit stays citable only while the phase's
pull request keeps it reachable (a merge commit, not a squash). Frozen with F-1 and F-3: a new case is a new vector; a changed vector after release 1 is an owner
call (§1.5). Locked by `../../../golden-fixtures.sha256`.

## Sources

| Source | Version | Used for |
|---|---|---|
| DSSE `protocol.md` | `secure-systems-lab/dsse` commit `75a79b6ed61c63dabf291657e076d120d95a39a1` (the copy's sha256 `6c0d9654…76253`) | `pae.json` |
| RFC 8032, §7.1 "Test Vectors for Ed25519" | RFC 8032, January 2017, plain text (the copy's sha256 `ed63657f…3c4c3`) | `ed25519.json`, the keys of `key-set.json` |
| `docs/app-updates.md` §2.7 ("Shape", "The empty set", "A key's id", "A set that does not read", "The file readers"), §2.3 ("The base64 grammar", "JSON"), §10.7 | commit `930b7d4c` | `spki`, `keyId`, every `expect` of `key-set.json` |

The two copies are working papers of the wave and are not in the repository.

## The files

- **`pae.json`** (5 vectors; read by the PAE's unit rows, `tests/unit/updates-envelope.test.ts`). `dsse-protocol-example`
  is the "Test Vectors" block of DSSE `protocol.md` as printed: `PAYLOAD_TYPE`, `SERIALIZED_BODY` and the `PAE` line
  (`DSSEv1 29 http://example.com/HelloWorld 11 hello world`); its signature example is ECDSA P-256 and is not used.
  The four `derived-…` vectors apply the specification's definition (`"DSSEv1" SP LEN(type) SP type SP LEN(body) SP
  body`, `LEN` the byte length in ASCII decimal without leading zeros) by hand; each `why` shows the count. DSSE's
  Python reference implementation was not used as an oracle.
- **`ed25519.json`** (5 vectors; read by the verification's unit rows). `publicKey`, `message` and `signature` are RFC
  8032 §7.1's TEST 1, TEST 2, TEST 3, TEST 1024 and TEST SHA(abc), as printed. The RFC's secret-key lines were never
  copied into any file. `spki` is §2.7's fixed 12 bytes `302a300506032b6570032100` followed by the 32 key bytes, in
  standard base64; `keyId` is the lower-case hex SHA-256 of those 44 bytes.
- **`key-set.json`** (54 vectors; read by the key-set parser's unit rows, and in the packaged probe app by T4.4c). The
  empty set; one, two, three, five and sixteen keys; a whole `keys.json` as committed; and one or more invalid vectors
  per clause of §2.7's "A set that does not read" that an input can reach, and of "The file readers". No vector stands
  for "an entry that `crypto.createPublicKey` throws on": no such input is known (§2.7). A byte-order mark in a
  `keysJson` text is written as its JSON escape.
- **`generate.mjs`**: how the three files were made (below).

## `spki` and `keyId`, computed twice

The generator computes them with `node:crypto`. A second computation with other tools (Git Bash's `xxd`, `base64` and
`sha256sum`, and Windows' `certutil`), from the RFC's hex typed on the command line, gave the same values:

```
printf '302a300506032b6570032100%s' <PUBLIC KEY hex> | xxd -r -p | sha256sum
printf '302a300506032b6570032100%s' <PUBLIC KEY hex> | xxd -r -p | base64 -w0
certutil -hashfile rfc8032-test-1.spki.der SHA256      (the 44 bytes in a scratch file)
```

| Vector | `keyId` (`node:crypto` = `sha256sum`) | `spki` (`node:crypto` = `base64`) |
|---|---|---|
| `rfc8032-test-1` | `06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9` | `MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=` |
| `rfc8032-test-2` | `deb2ded39dc26fce0e6085b6fc34bf6b5941913bbfe2ea614113cff9e004c170` | `MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=` |
| `rfc8032-test-3` | `8d39ba50abe50f77b6bb8ae7b6927aff7ffbeba35ad2837c0e51e82bcbcc60d5` | `MCowBQYDK2VwAyEA/FHNjmIYoaONpH7QAjDwWAgW7RO6MwOsXeuRFUiQgCU=` |
| `rfc8032-test-1024` | `e4f982b51ad0bdd87be820b259fe80337ef636e72b9fa7a8867a6949eb610fd6` | `MCowBQYDK2VwAyEAJ4EX/BRMcjQPZ9DyMW6Dhs7/vyskKMnFH+98WX8dQm4=` |
| `rfc8032-test-sha-abc` | `e77db4a9572e9f6552c22bc751d5499ad218a73bdf7e15dc6ea0fc69246a44de` | `MCowBQYDK2VwAyEA7Bcrk61eVjv0kyxw4SRQNMNUZ+8u/U1k6/gZaDRn4r8=` |

`certutil -hashfile` over the 44 bytes gave the same id for each of the five. The ids in `key-set.json` for these five
keys are the same values. The generator also checks that each RFC signature verifies under the key as written (Node
24.13.0, OpenSSL).

`key-set.json` holds two more keys that are no RFC key, the 32 bytes `00` and the 32 bytes `ff`. Their SPKI and ids,
by the same two tools from the hex typed on the command line (`sha256sum` and `certutil` agree with `node:crypto`):

| Vector of `key-set.json` | Key bytes | id (`node:crypto` = `sha256sum` = `certutil`) | SPKI (`node:crypto` = `base64`) |
|---|---|---|---|
| `any-32-bytes-all-zero` | 32 bytes `00` | `722abd12e99a5367f375aeb9672a8e07712e03c2add16fa8d6914d1cfa2efe0c` | `MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` |
| `any-32-bytes-all-ff` | 32 bytes `ff` | `78dc9cff8cfe1cf8348551902edb54b43b5509bdeb242207698344b5fa1f1e44` | `MCowBQYDK2VwAyEA//////////////////////////////////////////8=` |

The ids of the run-time keys in `sixteen-keys` and `seventeen-keys` are computed by the generator alone; the id form
they follow is the one the seven rows above hold twice.

## How the files were made

`node generate.mjs --rfc <rfc8032.txt> --dsse <dsse protocol.md> --out <an empty folder>`, Node 24.13.0, Windows 11.
`pae.json` and `ed25519.json` come out byte for byte the same on every run (checked: a second run compared with
`cmp`). `key-set.json`'s `sixteen-keys` and `seventeen-keys` vectors need more keys than the RFC has, so the generator
makes twelve key pairs at run time with `generateKeyPairSync('ed25519')` and writes their public halves only; a new run
gives other keys there, so **the committed file is the golden** and the script documents how it was made.

**No file holds a private key.** The private half of each of the twelve pairs was never exported, written or printed.
The two `any-32-bytes-…` vectors use 32 bytes `00` and 32 bytes `ff`, for which nobody holds a private key.

## Limits a reader should know

- `any-32-bytes-all-zero` and `any-32-bytes-all-ff` expect `valid: true`, as §2.7 says ("any 32 bytes"; the parser
  does not check the curve point). Node 24.13.0's OpenSSL loads both. Whether Electron's BoringSSL loads them is
  T4.4c's run; a throw there would make them invalid by §2.7's own `createPublicKey` clause.
- A `keys.json` with a duplicate `key_set` key has no vector: §2.7 does not say which one counts.
