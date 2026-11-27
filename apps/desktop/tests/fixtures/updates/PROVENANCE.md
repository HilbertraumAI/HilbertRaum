# The golden update file (app-update wave, T6.0b; F-16)

Written on 2026-11-27 by the wave's golden-input writer (Fable 5.2, task T6.0b), against the record at commit
`f7dae3ba` (branch `feat/updates-import-core`; `docs/app-updates.md`; the record's later rulings for this task are
committed as `6a520533`, "T6.0 fix 4", `b0265b94`, "T6.0 fix 5", and `d12e1c6f`, "T6.0 fix 6", and change no byte of
the golden files),
**before any import code existed**: no bundle
reader, no staging and no `updates:*` channel was in the tree, and the writer read none of P3's or P4's update modules
(`src/main/services/updates/`, `src/shared/updates/`), their tests, their vector helper or their generators. The files
are frozen with F-16, F-5 and F-18: release 1 reads them the same way for ever. A new case is a new file or a new row
of `import/cases.json`; a changed golden after release 1 is an owner call (record §1.5). Locked by
`../golden-fixtures.sha256`.

This folder holds, beside P4's `vectors/` (which have their own provenance):

| File | What it is | Source of its bytes |
|---|---|---|
| `golden.hrupdate` | a real update file: member 0 a DSSE envelope signed with Ed25519, then eight small members in an order that differs from `files[]`, then two zero blocks | `golden-generate.mjs`, one run (below) |
| `golden-win32-only.hrupdate` | the same envelope, byte for byte, in a file that lacks the groups `posix`, `darwin` and `linux` whole: a per-system file (record §2.4 `group`, §4.8 "Absent groups") | the same run |
| `golden-keys.json` | the public key both files are signed with: its SPKI DER in standard base64 (`keys`, the form of record §10.7 "`keys`") and its id (`keyIds`: the lower-case hex sha256 of the SPKI DER) | the same run |
| `golden-generate.mjs` | the generator: plain Node, `node:crypto`, `node:fs` and `node:path` only, no import from the repository | written by hand from the record rows below |
| `import/` | the hostile-case table, F-5's expected bytes, F-12's dates, F-14's list, the `last-result.txt` reading and table A.2's writer bytes | `import/PROVENANCE.md` |

## No file holds a private key

The generator makes the key pair in memory (`generateKeyPairSync('ed25519')`, inside one function), signs once, exports
the public half only and never writes, prints or exports the private half; the pair ends with the process. No seed, PEM,
JWK, PKCS#8 or raw secret was written to any file, the task's scratch folder included. So **a new run makes another key
and another signature, and the committed files are the golden**: a run reproduces every byte except the key id and the
signature inside member 0 (and so the key file). The generator refuses a folder that holds anything, so no run replaces
a committed file. The key is a test key: it must never stand in `keys.json`, in a build or in a doc as a real key;
`repo-hygiene.test.ts` (the M-1 row, widened by this task to every `.json` under `tests/fixtures/updates/`) fails a
`keys.json` that holds it.

## The run that made the committed files

`node golden-generate.mjs --out <an empty scratch folder>` on Node 24.13.0 (OpenSSL), Windows 11, 2026-11-27; the three
output files were copied here unchanged.

- `golden.hrupdate`: 14,336 bytes, sha256 `b237ae8defed4c99c1a9f3ba1ff3b551be98bdd4d01d3b8c6d04219dcdb62f1f`
- `golden-win32-only.hrupdate`: 10,240 bytes, sha256 `8eb69fc67c903f89be29f5dc617bcf3d5f4d51cdd559c6cef1ba9cca1b6f4d91`
- member 0: 2,248 bytes; the payload: 1,491 bytes, sha256 `6a950d46ab61011356e73db05d3f2fcded7487af3aa6fcf9b711fe9127613451`
- the key's id: `308e591fd49f6bfe3e4f5b7725a59af56340bbf95e0948b43dd36af8c40e2dd4`

## The source of every byte

| Bytes | Record row |
|---|---|
| each 512-byte header: the name and NULs; mode `0000644` NUL; uid and gid `0000000` NUL; the size as 11 zero-padded octal digits and NUL; mtime `00000000000` NUL; the checksum as 6 zero-padded octal digits, NUL, space (the unsigned sum, its own field counted as spaces); type `0`; magic `ustar` NUL and version `00`; devmajor and devminor `0000000` NUL; every other byte zero | §4.3 (table A.2): "Format", "Magic and version", "Checksum", "Type", "Name", "Link name, prefix", "Size", "Ignored fields" |
| each member's bytes zero-padded to a multiple of 512; the end as exactly two zero blocks | §4.3 "Format", "The end" |
| member 0's name `hilbertraum-release.dsse.json`; no separate payload member | §4.3 "Member 0", "Where the payload lives" |
| the envelope: `{"payloadType":…,"payload":…,"signatures":[{"keyid":…,"sig":…}]}`, UTF-8 without a byte-order mark, standard base64 with padding, one signature | §2.3 "Writers: the form", "Writers: the caps and the signer", "Writers: `keyid`" |
| the signature: Ed25519 (`crypto.sign(null, …)`) over `DSSEv1`, a space, the type's byte count, a space, the type, a space, the payload's byte count, a space, the payload | §2.3 "Verification" |
| the `payloadType` `application/vnd.hilbertraum.release+json` | §4.3 "DSSE `payloadType`" |
| the payload: `format` 1, `product` `hilbertraum`, `kind` `release`, `channel` `stable`, `version` `1.2.0`, `issued` `2026-11-27T12:00:00Z`, `requires` (three floors in the floor grammar), `summary` (`en`, `de`), `files` | §2.4, its table: "`format`" to "`files`", "`group`", "`install_as`", "`role`", "Later writers" |
| `files[]`: every member after member 0 with `name`, `size`, `sha256` (lower-case hex), `group` where it has one, `role`, and `install_as` for the start file | §2.4 (`files[]`, `group`, `install_as`), §4.3 "`files[]` entries" |
| the member names (`[A-Za-z0-9._-]`, a root artifact under its root name, `apply.cmd` and `apply.sh` byte-exact) | §4.4, §4.5 "Staged names" |
| the member contents | stated in `golden-generate.mjs`; stand-ins, none is a program or an archive |
| the key id: the lower-case hex sha256 of the key's SPKI DER | the form `repo-hygiene.test.ts`'s M-1 row computes (`idOf`, citing record §2.7 "A key's id"); the writer did not read §2.7 (outside the task's reading list), and the orchestrator confirmed the form against §2.7 in the "T6.0 fix 4" round; verification never depends on a `keyid` (§2.3 "`keyid`") |

## Checks made on the committed files

By a reader written for the purpose (not the generator's writer, not the import), kept with the wave's working papers:
the envelope parses and its one signature verifies with `node:crypto` under `golden-keys.json`'s key; every member's
size and sha256 equal its `files[]` entry; every header equals table A.2's writer bytes; all padding is zero; the file
ends with exactly two zero blocks; in `golden-win32-only.hrupdate` every group is present whole or absent whole and
member 0 is byte-identical to `golden.hrupdate`'s. Two members' sha256 were also taken with `sha256sum` over the bytes
cut out with `tail` and `head`. The expected `staged.txt` and `staged.json` of both files are in
`import/f5-staged.json`.

## Who reads these files

The import's tests (T6.1 the bundle reader, T6.2 staging, T6.3 the channels), with `golden-keys.json`'s key as the key
set; P5's builder is tested against the reader, never used to make a golden (plan C14).
