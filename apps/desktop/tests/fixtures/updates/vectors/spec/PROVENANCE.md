# F-1 / F-3 specification vectors (app-update wave, T4.4b)

Written on 2026-11-26 by the wave's negative-vector writer (Fable 5.2, task T4.4b), against the record at commit
`930b7d4c` (`docs/app-updates.md` §2.3, §2.7, §10.7), from the sources below only. Before which code existed: written
at `930b7d4c`, before the verifier was committed; T4.1 was writing it (the envelope's verifier, the key-set parser and
their tests) in the same tree, and this writer saw only its file names in one `git status` line and opened none of
them. No expected value was taken from the code under test. Frozen with F-1 and F-3: a new case is a new vector; a
changed vector after release 1 is an owner call (§1.5). Locked by `../../../golden-fixtures.sha256`.

**The merge rule.** Every commit this file cites (the record's `930b7d4c`, `63201772` and `5e01fff0`) is a commit of
the phase branch `feat/updates-trust-core`. Each stays reachable, and so citable, only if the phase's pull request is
merged with a merge commit, not squashed or rebased.

**Changed on 2026-11-26, before release 1 (weak keys; owner's decision after T4.4c, Δ-78).** The record's §2.7 gained
the row "A weak key" at commit `63201772`: the key-set parser refuses a weak key, and with it the whole set. The same
writer (Fable 5.2) updated `key-set.json`, `generate.mjs` and this file to that row, from the record at `63201772` and
RFC 8032 §5.1.3 only; the parser was being changed in the tree at that time, and neither it nor its tests were opened.

- **Two vectors changed their expected value** (ids and inputs kept): `any-32-bytes-all-zero` and
  `any-32-bytes-all-ff` expected `{"valid": true, "ids": […]}` under the earlier wording ("any 32 bytes", no check of
  the curve point) and now expect `{"valid": false}`: 32 bytes `00` are `y` = 0, one of the five small-order values;
  32 bytes `ff` are `y` = 2^255 - 1, not below p. Their `why` lines changed with them.
- **29 vectors were added** (54 to 83): 14 one-key sets with a weak key (`weak-small-order-…`, `weak-non-canonical-…`),
  three sets where a weak key stands among good ones (`weak-key-…`), and 12 controls that read (`not-weak-…`).
- `sixteen-keys` and `seventeen-keys` hold other run-time keys than before (the generator ran again); their expected
  values are of the same form. No other vector changed, and none was removed. `pae.json` and `ed25519.json` are byte
  for byte the files of the first writing.

**Changed on 2026-11-26, before release 1 (the adversarial review's M-1).** The review of the trust core (T4.4d) found
no vector for a non-canonical key strictly inside the range p + 1 to 2^255 - 1, so a parser that refused only the
values p, p + 1 and 2^255 - 1 would have passed. The record's §10.7 row "`spec/key-set.json`" names the two values
since commit `5e01fff0`. The same writer (Fable 5.2) added them from the record at `5e01fff0` (§2.7 "A weak key",
§10.7) only; the parser was being changed in the tree at that time, and neither it nor its tests were opened.

- **Four vectors were added** (83 to 87), each a one-key set that is invalid by "A weak key" (`y` is not below p):
  `weak-non-canonical-y-p-plus-2` and `-sign-set` (`y` = p + 2: key bytes `ef`, 30 × `ff`, then `7f` or `ff`), and
  `weak-non-canonical-y-2-255-minus-2` and `-sign-set` (`y` = 2^255 - 2: `fe`, 30 × `ff`, then `7f` or `ff`).
- `sixteen-keys`, `seventeen-keys` and the three `not-weak-generated-key-…` vectors hold other run-time keys than
  before (the generator ran again); their expected values are of the same form. No other vector changed, and none was
  removed. `pae.json` and `ed25519.json` are byte for byte the files of the first writing.

**Changed on 2026-11-26, before release 1 (the second review's m-12): this file only.** Every sha256 it cites is
written out in full, the merge rule above covers every cited commit, and "Limits" says that the checkers are not in
the repository. No vector and no other file of the set changed.

## Sources

| Source | Version | Used for |
|---|---|---|
| DSSE `protocol.md` | `secure-systems-lab/dsse` commit `75a79b6ed61c63dabf291657e076d120d95a39a1` (the copy's sha256 `6c0d965475162230f9f461acf634b4d4b409eab1a1839d31a9c24c76b3676253`) | `pae.json` |
| RFC 8032, §7.1 "Test Vectors for Ed25519" | RFC 8032, January 2017, plain text (the copy's sha256 `ed63657ff389301282b169b0abde9b5dd2c7e4d524fdfa5da6ff3094fc93c4c3`) | `ed25519.json`, the keys of `key-set.json` |
| `docs/app-updates.md` §2.7 ("Shape", "The empty set", "A key's id", "A set that does not read", "The file readers"), §2.3 ("The base64 grammar", "JSON"), §10.7 | commit `930b7d4c` | `spki`, `keyId`, every `expect` of `key-set.json` but the weak-key vectors' |
| `docs/app-updates.md` §2.7 ("A weak key", and "A set that does not read" as it then stands) | commit `63201772` | the `expect` of the `weak-…`, `not-weak-…` and `any-32-bytes-…` vectors |
| `docs/app-updates.md` §2.7 ("A weak key"), §10.7 ("`spec/key-set.json`": "one value strictly between: `y` = p + 2 and 2^255 − 2, each sign bit") | commit `5e01fff0` | the `expect` of the four `weak-non-canonical-y-p-plus-2…` and `…-y-2-255-minus-2…` vectors |
| RFC 8032, §5.1.3 "Decoding" and §5.1's curve constants | the same copy | a cross-check of the row's five `y` values (below); no expected value comes from it |

The two copies are working papers of the wave and are not in the repository; a reader who fetches the same versions
can compare the sha256 values above.

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
- **`key-set.json`** (87 vectors, 22 that read and 65 that do not; read by the key-set parser's unit rows, and in the
  packaged probe app by T4.4c). The empty set; one, two, three, five and sixteen keys; a whole `keys.json` as
  committed; and one or more invalid vectors per clause of §2.7's "A set that does not read" that an input can reach,
  and of "The file readers". No vector stands for "an entry that `crypto.createPublicKey` throws on": no such input is
  known (§2.7). A byte-order mark in a `keysJson` text is written as its JSON escape. The weak-key vectors have their
  own section below.
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

`key-set.json` holds nine more keys that read and are no RFC key: the controls next to the weak-key boundaries, whose
32 bytes are fixed. Their SPKI and ids, by `xxd`, `base64` and `sha256sum` from the hex typed on the command line
(equal to `node:crypto`'s; `certutil` was not run for these nine):

| Vector of `key-set.json` | Key bytes | id (`node:crypto` = `sha256sum`) | SPKI (`node:crypto` = `base64`) |
|---|---|---|---|
| `not-weak-y-2` | `0200000000000000000000000000000000000000000000000000000000000000` | `c8833536e575a572a49bd3c3a34fbfa71c7df11d01405a7b4100c253af80885b` | `MCowBQYDK2VwAyEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` |
| `not-weak-y-3` | `0300000000000000000000000000000000000000000000000000000000000000` | `0e7fd30080f13ed31972902c75303a143c4c4540d9396f8080246547ed73c23d` | `MCowBQYDK2VwAyEAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` |
| `not-weak-y-p-minus-2` | `ebffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f` | `b370a9f679de92b42090b3bf8a509465592e914a98dd3b1626e885706ea95ab1` | `MCowBQYDK2VwAyEA6////////////////////////////////////////38=` |
| `not-weak-y-p-minus-3` | `eaffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f` | `fa3b7ed858b9e51ddaeab269f4b51dda6e46f61b315707e7b6692eb60648deef` | `MCowBQYDK2VwAyEA6v///////////////////////////////////////38=` |
| `not-weak-y-p-minus-3-sign-set` | `eaffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` | `810762dbec6b667a35efbe9a4b07a197275389f6fbae94483e103decf807c729` | `MCowBQYDK2VwAyEA6v////////////////////////////////////////8=` |
| `not-weak-order-8-a-first-byte-plus-1` | `27e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05` | `ce5eb6f01209ab4673343e4e7c6b9f2091dd325083db5df297dea61e8c4eb1aa` | `MCowBQYDK2VwAyEAJ+iVj8KyJ7BFw/SJ8u+Y8NXfrAXTxjM5sTgCiG1T/AU=` |
| `not-weak-order-8-a-last-byte-plus-1` | `26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc06` | `f5fcafdf8bc098bef561a577eb2b3d2889eb1942d32e8934cfe41b6c24802c6a` | `MCowBQYDK2VwAyEAJuiVj8KyJ7BFw/SJ8u+Y8NXfrAXTxjM5sTgCiG1T/AY=` |
| `not-weak-order-8-b-first-byte-minus-1` | `c6176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a` | `704a1c917009dd7b82f13a5c520158deeb80f17173565b97cf32d1215c6d705e` | `MCowBQYDK2VwAyEAxhdqcD1N2E+6PAt2DRBnDyogU/osOczGTsf9d5KsA3o=` |
| `not-weak-order-8-b-last-byte-minus-1` | `c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03f9` | `823202f3229e7efc8a014bc3feddf31a314e24c3637816b5b32beb8b50e785c7` | `MCowBQYDK2VwAyEAxxdqcD1N2E+6PAt2DRBnDyogU/osOczGTsf9d5KsA/k=` |

The two `any-32-bytes-…` vectors (32 bytes `00`, 32 bytes `ff`) held an id each until the weak-key change
(`722abd12e99a5367f375aeb9672a8e07712e03c2add16fa8d6914d1cfa2efe0c` for the 32 bytes `00`,
`78dc9cff8cfe1cf8348551902edb54b43b5509bdeb242207698344b5fa1f1e44` for the 32 bytes `ff`: the SHA-256 of §2.7's
12-byte prefix followed by those bytes, computed again with `xxd` and `sha256sum` when these values were written out
in full); they now expect an invalid set and hold none.

The ids of the run-time keys in `sixteen-keys`, `seventeen-keys` and the three `not-weak-generated-key-…` vectors are
computed by the generator alone; the id form they follow is the one the fourteen rows above hold twice.

## The weak-key vectors (§2.7 "A weak key", record commit `63201772`)

The rule, as the row words it: read the 32 key bytes as a little-endian number and clear its top bit (bit 255); that
is `y`. The key is weak when `y` is not below p = 2^255 - 19, or when `y` is 0, 1, p - 1 or one of the two values the
row prints as bytes, with either sign bit. The generator applies exactly that with BigInt arithmetic over the bytes of
each key as written; no crypto library decides whether a key is weak, and a vector whose computed answer differs from
the one its writer declared stops the run.

| Encodings | Vectors | Expect |
|---|---|---|
| the five small-order `y` values, each with the sign bit clear and set (10) | `any-32-bytes-all-zero` (`y` = 0, sign clear), `weak-small-order-y-0-sign-set`, `weak-small-order-y-1`, `…-y-1-sign-set`, `…-y-p-minus-1`, `…-y-p-minus-1-sign-set`, `…-order-8-a`, `…-order-8-a-sign-set`, `…-order-8-b`, `…-order-8-b-sign-set` | invalid |
| `y` not below p, at its edges: p, p + 1 and 2^255 - 1, each sign (6) | `weak-non-canonical-y-p`, `…-y-p-sign-set`, `…-y-p-plus-1`, `…-y-p-plus-1-sign-set`, `…-y-2-255-minus-1`, `any-32-bytes-all-ff` (`y` = 2^255 - 1, sign set) | invalid |
| `y` not below p, strictly inside the range: p + 2 and 2^255 - 2, each sign (4; record commit `5e01fff0`, the review's M-1) | `weak-non-canonical-y-p-plus-2`, `…-y-p-plus-2-sign-set`, `…-y-2-255-minus-2`, `…-y-2-255-minus-2-sign-set` | invalid |
| a weak key first, in the middle and last of three keys | `weak-key-first-of-three`, `weak-key-among-good-keys`, `weak-key-last-of-three` | invalid as a whole |
| the values next to each boundary: 2, 3, p - 2, p - 3 (both signs), and each order-8 value with its first or its last byte one off | the nine `not-weak-…` vectors of the table above | reads |
| three keys from `generateKeyPairSync('ed25519')` | `not-weak-generated-key-1` to `-3` | reads |

**The cross-check of the five values** (the writer's notes, BigInt arithmetic written for it, no library): with
d = -121665/121666 mod p, RFC 8032 §5.1.3's decoding gives a point on -x^2 + y^2 = 1 + d x^2 y^2 for the eight encodings
`y` = 0 (both signs, order 4), `y` = 1 (sign clear: the neutral point, order 1), `y` = p - 1 (sign clear, order 2)
and the two printed values (both signs, order 8 each): eight different points with the orders 1, 2, 4, 4, 8, 8, 8, 8,
the whole subgroup of order 8. The two printed values add up to p, and they are the two `y` for which the doubled
point has `y` = 0 (found from d y^4 + 2 y^2 - 1 = 0 without the record's bytes). `y` = 1 and `y` = p - 1 with the sign
bit set have x = 0, which step 4 of the decoding refuses; the row counts them as weak ("either sign bit"). Every `y`
from p to 2^255 - 1 (19 values) fails step 1.

**Not every control is a curve point**, and the row does not ask for one: no point has `y` = 2, p - 2, the first
order-8 value plus 1 or the second minus 1; `y` = 3, p - 3 and the two last-byte neighbours are points of large
order. Each `why` says which. All nine load with `createPublicKey` on Node 24.13.0 (OpenSSL).

## How the files were made

`node generate.mjs --rfc <rfc8032.txt> --dsse <dsse protocol.md> --out <an empty folder>`, Node 24.13.0, Windows 11.
`pae.json` and `ed25519.json` come out byte for byte the same on every run (checked: a second run compared with
`cmp`; and again after the weak-key change and after the M-1 change, against the committed files). `key-set.json`'s `sixteen-keys` and
`seventeen-keys` vectors need more keys than the RFC has, and the three `not-weak-generated-key-…` vectors need keys
from a key generator, so the generator makes fifteen key pairs at run time with `generateKeyPairSync('ed25519')` and
writes their public halves only; a new run gives other keys there, so **the committed file is the golden** and the
script documents how it was made. The generator stops if a generated key is weak by the row's rule (none was).

**No file holds a private key.** The private half of each of the fifteen pairs was never exported, written or printed.
The weak-key vectors and the nine boundary controls use key bytes written from a number, not from a key pair: nobody
made a private key for them.

## Limits a reader should know

- **The checkers are not in the repository.** The self-check scripts of this set, the writer's notes on the weak-key
  values and every reviewer's checker are working papers of the wave, kept outside the repository, as are the two
  reference copies. A later reader cannot run them again from the repository: what it holds is the vectors, this
  generator (which needs the two copies as its inputs) and the tests that read the vectors. The second-tool lines
  above ("`spki` and `keyId`, computed twice") can be run again by anyone, from the hex this file prints.

- The four controls that are no curve point (`not-weak-y-2`, `not-weak-y-p-minus-2`,
  `not-weak-order-8-a-first-byte-plus-1`, `not-weak-order-8-b-first-byte-minus-1`) expect a set that reads, as §2.7
  says: only a weak key is refused, and no library is asked whether a key is a point. Node 24.13.0's OpenSSL loads
  them. Whether Electron's BoringSSL loads them is T4.4c's run; a throw there would make them invalid by §2.7's own
  `createPublicKey` clause. No signature verifies under such a key.
- The weak-key vectors hold the ends of the non-canonical range (p, p + 1, 2^255 - 1) and two values inside it
  (p + 2, 2^255 - 2), not all 19 values.
- A `keys.json` with a duplicate `key_set` key has no vector: §2.7 does not say which one counts.
