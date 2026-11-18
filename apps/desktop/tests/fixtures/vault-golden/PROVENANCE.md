# Golden vault descriptors (#845)

Two `config/workspace.json` files written by the vault code of published releases themselves, with a throwaway
password, on an empty scratch root. They hold no user data: a random salt, the verifier, and a random data key wrapped
under the throwaway password. `workspace-vault-format-guard.test.ts` reads each one with this build's checked reader
(it must read as current, never as newer), derives the key from the password, checks the verifier, unwraps the data
key, builds a vault around it, unlocks and locks it, and requires the descriptor to stay byte for byte.

They guard the format guard against over-broadening: a "newer" verdict on a descriptor a shipped release wrote would
lock its owner out.

| File | Release tag | Commit | Throwaway password | sha256 |
|---|---|---|---|---|
| `v0.1.65-workspace.json` | `v0.1.65` | `8744818afe47e2fadc7f5ecdd1d693b2e5e012d9` | `golden-throwaway-v0.1.65` | `eace4d6f3982e42992f5e3757133bedbdc505d0e544101c89437fb28825848f4` |
| `v0.1.50-workspace.json` | `v0.1.50` | `ca38dcec1ca805c5ee17da78fd4e54a39380e3e3` | `golden-throwaway-v0.1.50` | `1d524326f2f0721c282a2c26fddb1b22518b66929aabd9d3932ddf25a41a0a4c` |

v0.1.50 is the first published GitHub release, v0.1.65 the newest at capture time (2026-11-18).

## How they were captured

For each tag, a temporary detached worktree outside the repository (`git worktree add --detach <dir> <tag>`), with
`node_modules` and `apps/desktop/node_modules` linked to an existing install, and one throwaway test file in it that
calls that tag's own `createEncryptedVaultOnDisk(vaultPaths, password)` with no KDF argument and no options (the
production default: `WorkspaceController.create` makes the same call), then unlocks and locks the vault with the same
tag's `unlockEncryptedVault` / `lockEncryptedVault` and checks the descriptor did not change, and copies
`config/workspace.json` out. Run from `<dir>/apps/desktop` with Node 24.13.0:

```
GOLDEN_PASSWORD=<password> GOLDEN_OUT=<dir> node ../../node_modules/vitest/vitest.mjs run tests/golden-capture.test.ts
```

The worktrees were removed afterwards. The installed dependencies were the ones `package-lock.json` pins at
`61a083cc`. That lockfile is identical to v0.1.65's. For v0.1.50 it differs: `@noble/hashes` (the Argon2id
implementation) is 2.4.0 where v0.1.50 pinned 2.2.0. Both versions derive the same key: the known-answer row in
`tests/unit/crypto.test.ts` ("derives the known key … with the default KDF") was computed with both.

## Why two files stand for every published release (git evidence)

The descriptor's reader, envelope builder and writer are the same function bodies at every tag from v0.1.6 to v0.1.65,
and every tag's default KDF is the same Argon2id setting. sha256 (first 16 hex digits) of each function's text, from
`export function readVaultDescriptor(` (resp. `function buildEnvelopeDescriptor(`, `export function
writeVaultDescriptor(`) to the first line that is a bare `}`, in `apps/desktop/src/main/services/workspace-vault.ts`
at each tag:

| Tags | `readVaultDescriptor` | `buildEnvelopeDescriptor` | `writeVaultDescriptor` | `DEFAULT_KDF` | Frame magic |
|---|---|---|---|---|---|
| v0.1.0 – v0.1.3 | `12fe64712612cbcb` | (none: v1 only) | `45185fed09dd0a22` | argon2id, m 19456, t 2, p 1, keyLen 32 | `PAIDENC1` |
| v0.1.6 – v0.1.8 | `1ec5dc5460b7d05d` | `d7c7c993dd7d8ab2` | `f318ce7a4bcd82d3` | the same | `PAIDENC1` |
| v0.1.19 – v0.1.65 (every tag) | `1ec5dc5460b7d05d` | `d7c7c993dd7d8ab2` | `f318ce7a4bcd82d3` | the same | `HRAUMEN1` |

(There are no tags v0.1.4, v0.1.5 or v0.1.9 – v0.1.18. v0.1.51 is a tag without a release.)

So every published release (v0.1.50, v0.1.52 – v0.1.65) writes a descriptor of exactly this shape: `version` 2,
`mode` `encrypted`, Argon2id with these parameters, `saltB64`, `verifier`, `dataKey`, and the frame `HRAUMEN1`. Only
the unpublished v0.1.0 – v0.1.3 wrote v1 descriptors, and no tag ever defaulted to scrypt.
