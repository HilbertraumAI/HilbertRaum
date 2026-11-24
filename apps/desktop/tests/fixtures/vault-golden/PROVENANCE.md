# Golden vault descriptors (#845)

One `config/workspace.json` per published release, written by that release's vault code itself, with a throwaway
password, on an empty scratch root. They hold no user data: a random salt, the verifier, and a random data key wrapped
under the throwaway password. `workspace-vault-format-guard.test.ts` reads each one with this build's checked reader
(it must read as current, never as newer), derives the key from the password, checks the verifier, unwraps the data
key, builds a vault around it, unlocks and locks it, and requires the descriptor to stay byte for byte.

They guard the format guard against over-broadening: a "newer" verdict on a descriptor a shipped release wrote would
lock its owner out. Their bytes are locked by `../golden-fixtures.sha256` (`repo-hygiene.test.ts`).

| File | Release tag | Commit | Throwaway password | sha256 | Argon2id code (`@noble/hashes`) |
|---|---|---|---|---|---|
| `v0.1.65-workspace.json` | `v0.1.65` | `8744818afe47e2fadc7f5ecdd1d693b2e5e012d9` | `golden-throwaway-v0.1.65` | `eace4d6f3982e42992f5e3757133bedbdc505d0e544101c89437fb28825848f4` | 2.4.0, the tag's pin |
| `v0.1.50-workspace.json` | `v0.1.50` | `ca38dcec1ca805c5ee17da78fd4e54a39380e3e3` | `golden-throwaway-v0.1.50` | `1d524326f2f0721c282a2c26fddb1b22518b66929aabd9d3932ddf25a41a0a4c` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.52-workspace.json` | `v0.1.52` | `eeaf0c0fcb07277042bab7474825b898cd95e7e6` | `golden-throwaway-v0.1.52` | `6b65f30f2335da9fff59580d95fe686a105eb1975927ebe35b252a844f458aa7` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.53-workspace.json` | `v0.1.53` | `e29b5100ebd64acc1827be01046290971581d6d1` | `golden-throwaway-v0.1.53` | `f27698d22067937211c682d91587e5597613c80254f0134622b1f16a89b9a29d` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.54-workspace.json` | `v0.1.54` | `e6af01b9be12165205f6b466683cebdcedc13285` | `golden-throwaway-v0.1.54` | `3dd42ab32459165cf44c312e369be2b86809a7ba5e31c57349c11a57c430a80f` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.55-workspace.json` | `v0.1.55` | `bbf26addcc9e92e5580ff029f65bfa7c2e553c4d` | `golden-throwaway-v0.1.55` | `27b43bc4ef6bf1ebe1e12c8c34172d6be12bf5738bad57e47a28e93251f2ca1a` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.56-workspace.json` | `v0.1.56` | `e8342345057013ff8a80907ec9324bd1bb61697d` | `golden-throwaway-v0.1.56` | `c236decd45e141f2d02a6054ec972c924053428a430486c7e2300ec2aa33c518` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.57-workspace.json` | `v0.1.57` | `bf26c07c219f9b530f7a4a5c6d9bf9591b97fbcc` | `golden-throwaway-v0.1.57` | `a8eb5930dc4dd3947a19a11bfd7d7bb86f5877839930db801f835b75fba6a843` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.58-workspace.json` | `v0.1.58` | `9903c1ddf81db3475444c541745d2881a935c81e` | `golden-throwaway-v0.1.58` | `265712e921f47f69518ba911fbd5250e6084bb77441c8bbf3adf18bde6a78e05` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.59-workspace.json` | `v0.1.59` | `b087ea65118496e09c2b6ab480e439163a44a3e4` | `golden-throwaway-v0.1.59` | `29e4c6b567f416f22bf148675322bb1578cb7a4f32a0edaad10cf07d76466c61` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.60-workspace.json` | `v0.1.60` | `5a4894ae17fef711d71c4c8d74229de018139b2f` | `golden-throwaway-v0.1.60` | `d5f03b5b32f407ca07b3f37089df9de7bbe25ff45865e7f09ffe26fddfabea89` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.61-workspace.json` | `v0.1.61` | `7169f9ee6b9327a3f10da80820652830219e7366` | `golden-throwaway-v0.1.61` | `49731bf60d575e085bd9ddb3165698606f3443f0e85a6cdea1ad3dee8d233bb8` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.62-workspace.json` | `v0.1.62` | `143f3328bf1bd831b027b0344650a1cdf5b3185f` | `golden-throwaway-v0.1.62` | `ecf2e4265a0d76d781e7544dd70a3f64e14f35a96288882a2d2b368dfcd6ce42` | the tag pins 2.2.0; 2.4.0 stood in |
| `v0.1.63-workspace.json` | `v0.1.63` | `1b1464a0dce7d93af8713e7067648279f5ee9252` | `golden-throwaway-v0.1.63` | `542d4550a66ec8201984ca823d5a134164a524e886fb4882acfae7a8e94139de` | 2.4.0, the tag's pin |
| `v0.1.64-workspace.json` | `v0.1.64` | `7f0dff94d811602ecaa5f8990abf0839a82c8044` | `golden-throwaway-v0.1.64` | `9ecc217c7d085c68c7755fc03b9b8e66bbbd0c7d97557e4251efe5eda22da2ad` | 2.4.0, the tag's pin |
| `v0.1.66-workspace.json` | `v0.1.66` | `c62a45f24d99917060c5bd2e002b23ed8ce6c652` | `golden-throwaway-v0.1.66` | `d277868c63b1ff684be9d19c44f49987769a42ecf02705851966189a0c2fab57` | 2.4.0, the tag's pin |

v0.1.50 is the first published GitHub release. **v0.1.51 is skipped:** it is a tag that was never published, so no
user holds a descriptor it wrote (`golden-descriptors.mjs` refuses it). A later tag gets its file the same way
(W-80 (d): every tag cut before release 1).

## How they were captured

**v0.1.50 and v0.1.65 (2026-11-18, kept as they are).** For each tag, a temporary detached worktree outside the
repository (`git worktree add --detach <dir> <tag>`), with `node_modules` and `apps/desktop/node_modules` linked to an
existing install, and one throwaway test file in it that calls that tag's own `createEncryptedVaultOnDisk(vaultPaths,
password)` with no KDF argument and no options (the production default: `WorkspaceController.create` makes the same
call), then unlocks and locks the vault with the same tag's `unlockEncryptedVault` / `lockEncryptedVault` and checks
the descriptor did not change, and copies `config/workspace.json` out. Run from `<dir>/apps/desktop` with Node 24.13.0:

```
GOLDEN_PASSWORD=<password> GOLDEN_OUT=<dir> node ../../node_modules/vitest/vitest.mjs run tests/golden-capture.test.ts
```

The worktrees were removed afterwards. The installed dependencies were the ones `package-lock.json` pins at
`61a083cc`.

**The other fourteen (2026-11-24, T2.8).** `node scripts/release/golden-descriptors.mjs --tag <tag> …` with Node
24.13.0, the same calls in the same order, on the tag's own sources: `git archive` of the tag (read-only), bundled by
this checkout's vite 6.4.6 in library mode. It keeps an existing file (a rerun never reproduces one: the salt, the IVs
and the data key are random). A rerun for v0.1.50 and v0.1.65 into a scratch folder gave files of the same 502 bytes
that differ from the committed ones only in `saltB64` and the `ivB64` / `tagB64` / `ciphertextB64` of the verifier and
the data key.

**The key derivation.** Every published tag's vault code imports Argon2id from `@noble/hashes`. Every file here was
written with the 2.4.0 this checkout installs (resolved only from `<repo>/node_modules`). The tags v0.1.50 – v0.1.62
pinned 2.2.0, v0.1.63 – v0.1.66 pin 2.4.0 (each tag's `package-lock.json`; the table's last column). Argon2id is a
fixed standard, and the known-answer row in `tests/unit/crypto.test.ts` ("derives the known key … with the default
KDF") was computed with both versions, so the stand-in derives the key those releases derive.

## Every published release writes the same shape (git evidence)

The descriptor's envelope builder and writer are the same function bodies at every tag from v0.1.6 to v0.1.66, and
every tag's default KDF is the same Argon2id setting. Over those tags the reader changed once, at v0.1.66 (the
writing side did not). sha256 (first 16 hex
digits) of each function's text, from `export function readVaultDescriptor(` (resp. `function
buildEnvelopeDescriptor(`, `export function writeVaultDescriptor(`) to the first line that is a bare `}`, in
`apps/desktop/src/main/services/workspace-vault.ts` at each tag:

| Tags | `readVaultDescriptor` | `buildEnvelopeDescriptor` | `writeVaultDescriptor` | `DEFAULT_KDF` | Frame magic |
|---|---|---|---|---|---|
| v0.1.0 – v0.1.3 | `12fe64712612cbcb` | (none: v1 only) | `45185fed09dd0a22` | argon2id, m 19456, t 2, p 1, keyLen 32 | `PAIDENC1` |
| v0.1.6 – v0.1.8 | `1ec5dc5460b7d05d` | `d7c7c993dd7d8ab2` | `f318ce7a4bcd82d3` | the same | `PAIDENC1` |
| v0.1.19 – v0.1.65 (every tag) | `1ec5dc5460b7d05d` | `d7c7c993dd7d8ab2` | `f318ce7a4bcd82d3` | the same | `HRAUMEN1` |
| v0.1.66 | `5f6e2d990b861ffe` | `d7c7c993dd7d8ab2` | `f318ce7a4bcd82d3` | the same | `HRAUMEN1` |

(There are no tags v0.1.4, v0.1.5 or v0.1.9 – v0.1.18. The v0.1.50 – v0.1.66 rows were measured again on
2026-11-24.)

So every published release (v0.1.50, v0.1.52 – v0.1.66) writes a descriptor of exactly this shape: `version` 2,
`mode` `encrypted`, Argon2id with these parameters, `saltB64`, `verifier`, `dataKey`, and the frame `HRAUMEN1`.

**No published release wrote a v1 descriptor or a scrypt one.** At every published tag:
- the only places that write a descriptor are the create (`workspace.create(password, mode)` →
  `createEncryptedVaultOnDisk(this.vaultPaths, password)`) and the password change (`changePassword(currentPassword,
  nextPassword)`). Both take the default KDF, Argon2id, and both write version 2;
- `SCRYPT_KDF` appears only in its own declaration in `security/crypto.ts`, where it is kept for unlocking older vaults;
- `createEncryptedVaultOnDisk`'s `legacyV1` option, which writes a v1 descriptor (it exists for test fixtures), is
  passed by no source file outside `workspace-vault.ts`, and the create there does not pass it.

Only the unpublished v0.1.0 – v0.1.3 wrote v1 descriptors, and no tag ever defaulted to scrypt.
