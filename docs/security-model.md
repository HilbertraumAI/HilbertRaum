# Security model — Private AI Drive Lite

_Last updated: 2026-06-10 (Phase 18 — the in-app downloader network surface)_

This document describes the local threat model, the security baseline (spec §3.5), the offline
posture (spec §3.6), how the privacy policy is loaded and enforced, and the **encrypted workspace**
(spec §3.5/§7.9, implemented in Phase 9).

## Assets we protect
- Imported documents, extracted text, document chunks
- Embeddings / the local vector index
- Chat history and generated outputs
- Local logs and settings
- the workspace encryption key material (Phase 9)

## Threats considered
- Accidental data exfiltration to a cloud AI provider or telemetry endpoint.
- A compromised or overly-permissive renderer reaching a remote origin.
- A malformed or hostile config file weakening the offline posture.
- Plaintext data at rest on a removable/shared drive (mitigated by the Phase-9 encrypted workspace;
  plaintext dev mode is gated by policy and clearly labelled).

## Security baseline (spec §3.5)

| Control | Where |
|---|---|
| Context isolation, no node integration, sandboxed renderer | `main/index.ts` `webPreferences` |
| Renderer talks only to a typed `contextBridge` (`window.api`) | `preload/index.ts` |
| `will-navigate` blocks remote origins | `main/index.ts` |
| `setWindowOpenHandler` opens external links in the OS browser, denies in-app | `main/index.ts` |
| **Content-Security-Policy** (meta tag + response header) | `renderer/index.html`, `main/index.ts` |
| **No network in the core path** + startup self-check tripwire | `services/offlineGuard.ts` |
| No model weights / user data in version control | `.gitignore` |
| **Encrypted workspace** (AES-256-GCM at rest, Argon2id KDF — scrypt still supported, password never stored) | `services/security/crypto.ts`, `services/workspace-vault.ts` |

### Content-Security-Policy (dev vs prod)
A strict CSP is applied as a response header via `session.webRequest.onHeadersReceived`, on top of
the `index.html` meta tag (defence in depth).

- **Production** (strict): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`. No remote origins are reachable from the renderer.
- **Development** (HMR-compatible): relaxes `connect-src` to allow `ws://localhost:*` /
  `http://localhost:*`, and adds `'unsafe-inline'`/`'unsafe-eval'` to `script-src` (and
  `'unsafe-inline'` to `style-src`) for Vite hot-reload. Without this split, `npm run dev` would break.

## Offline posture (spec §3.6)

The app makes **no outbound network calls in its core path** — this is a property of the code, not a
firewall. Two layers make it visible and defensible:

### 1. Policy precedence (`services/policy.ts`)
`config/policy.json` and `config/drive.json` are **optional** (developer runs fall back to defaults)
and are merged over `DEFAULT_POLICY`, where **update checks and telemetry are off** (no toggle
exists for either) and — since Phase 18 (plan §13 D3, resolved (a)) — `allow_model_downloads` is
**permitted**, so that with no policy file the spec §3.6 user toggle is the effective downloads
gate. The policy models the spec §6 shape (`network` / `workspace` / `models` blocks).

A (future signed) `policy.json` is **authoritative**: it can only **restrict**, never expand, what
the user setting permits — `prepare-drive` keeps writing `allow_model_downloads: false` in both its
postures, so prepared drives deny downloads unless the drive builder deliberately changes that. The
effective network permission is:

```
networkAllowedByPolicy = policy.network.allowModelDownloads || policy.network.allowUpdateChecks
networkAllowed         = networkAllowedByPolicy && userSetting.allowNetwork
offlineMode            = !networkAllowed
```

Consequences:
- **The shipped default is offline.** `allowNetwork` defaults OFF, so a fresh install/drive makes no
  network calls; while the workspace is locked the setting is unreadable and treated as off.
- **Policy forbids → offline**, regardless of the user toggle ("Network access disabled by policy").
- **Policy permits + user opts in → network allowed** — used exclusively by the Phase-18 in-app
  model downloader, which additionally requires a per-download confirmation (and an explicit
  license acknowledgement for manifests whose `license_review` is not approved). The gates are
  re-checked in the **main process** on every `downloadModel` call; the renderer dialog is UX, not
  the enforcement layer. See [`model-policy.md`](model-policy.md) for the full flow
  (`.part` staging, verify-before-rename, mismatch-deletes-partial, one download at a time).
- **Telemetry is always off** — there is no toggle and the app emits none.

The renderer distinguishes "off by choice" from "disabled by policy" via `PolicyStatus`
(`getPolicy()` IPC) and shows it on the **Privacy & Offline** screen and the sidebar badge; the
Models screen uses the same distinction to explain why downloads are unavailable.

### 2. Startup self-check (`services/offlineGuard.ts`)
At startup (`initBackend()`), `assertOfflinePosture()` logs the offline posture and, while offline,
installs a defensive tripwire over `net.Socket.prototype.connect` in **all builds** (so a production
regression that tried to phone home would still be recorded locally). While offline, any connection to
a **remote** host is logged as a violation.

**Loopback is not "network".** `127.0.0.0/8`, `::1`, and `localhost` are explicitly exempt — the dev
renderer loads from `http://localhost` today and the Phase-10 `llama.cpp` sidecar binds `127.0.0.1`.
Only genuinely remote origins are flagged. The guard **only logs; it never blocks or throws**, so a
wrong host guess can never break local IPC or the future sidecar. Real runtimes MUST bind
`127.0.0.1` only.

## Logs are local-only (spec §7.11)
`services/logging.ts` writes a rotating `app.log` under the workspace `logs/` directory and never
uploads. Diagnostics surfaces local data only; it transmits nothing off-device.

## Workspace modes (Phase 9)

The workspace has two modes, owned by `services/workspace-vault.ts` (`WorkspaceController`):

- `plaintext_dev` — developer speed; the SQLite DB opens unencrypted at startup. **Clearly
  labelled** on the Privacy screen and Settings. Permitted **only** when policy allows it AND the
  build is a dev build / developer mode (see *Plaintext gating* below). Not the commercial default.
- `encrypted` — the commercial default. A password-derived key encrypts the whole database **file**
  at rest **and every stored imported-document copy** (see *Encrypted document cache* below).
  Password is **never stored**.

### Key derivation (KDF)
`services/security/crypto.ts` derives a 32-byte AES key from the password + a random 16-byte salt.

- **Algorithm: Argon2id (default), scrypt supported.** New vaults derive the key with **Argon2id**,
  the OWASP-recommended password KDF, via the pure-JS, audited **`@noble/hashes`** — so there is **no
  fragile native `argon2` build** (the original R4 blocker). `node:crypto` **`scrypt`** remains fully
  supported, so a vault created under the earlier scrypt default unlocks unchanged: `deriveKey`
  dispatches on the descriptor's recorded `algo`.
- **Parameters (recorded in the descriptor):** Argon2id `m = 19456 KiB (≈ 19 MiB)`, `t = 2`, `p = 1`,
  `keyLen = 32` (~0.5 s/unlock — a deliberate one-time cost); legacy scrypt `N = 2^15`, `r = 8`,
  `p = 1`. Because the params are stored alongside the salt, unlock derives **exactly** the same key —
  derivation is deterministic. The params are tunable without changing the on-disk format.

### AEAD (encryption at rest)
- **AES-256-GCM.** Every encryption uses a fresh random 12-byte IV; the 16-byte auth tag is stored
  alongside the ciphertext. A wrong key or any tampering fails the GCM tag → `decrypt` throws, which
  upstream is treated as "wrong password" (the DB is never opened with a bad key).
- The encrypted DB file is framed as `MAGIC(8) | iv(12) | tag(16) | ciphertext` (`paid.sqlite.enc`).

### Whole-file encryption-at-rest (no SQLCipher under `node:sqlite`)
`node:sqlite` has no SQLCipher, so the **whole database file** is encrypted at rest (plan §4b), not
individual rows — the spec §8 schema is identical in both modes.

- **On unlock:** derive the key → verify the password against the descriptor's authenticated
  **verifier** (a known plaintext encrypted under the key; a wrong key fails the GCM tag **without
  touching the DB**) → decrypt `paid.sqlite.enc` → `paid.sqlite` **on the drive** (never a temp/cloud
  dir) → `openDatabase()`.
- **On lock / quit:** `PRAGMA wal_checkpoint(TRUNCATE)` + `close()` (flush WAL into the main file) →
  re-encrypt the working file → `paid.sqlite.enc` → **shred + delete** the plaintext working file and
  its `-wal`/`-shm` sidecars.
- **WAL sidecars:** WAL mode creates `paid.sqlite-wal` / `-shm`, which can hold plaintext pages.
  They are checkpointed before encryption and shredded after, so the encrypted snapshot is complete
  and no plaintext leaks in a sidecar.

### Encrypted document cache (spec §3.5: "database AND document cache")
Imports copy each file into `workspace/documents/` so the drive is self-contained. In an encrypted
workspace those copies rest **encrypted** too — encrypting only the DB would leave the raw bytes of
every imported document readable on a lost drive.

- **At rest:** the stored copy is `<id><ext>.enc` (same `MAGIC | iv | tag | ciphertext` framing,
  same vault key, fresh IV per file). `sha256`/`size_bytes` on the document row describe the
  plaintext content in both modes.
- **Import:** the original file (still on disk at import time) is parsed directly; only the
  encrypted copy is written to the workspace — no plaintext copy ever lands there.
- **Re-index:** the stored `.enc` is decrypted to a **transient** working file
  (`<id>.parse<ext>`) for the parser and **shredded** when parsing finishes (success or failure).
- **Crash recovery:** `shredStalePlaintext` (startup, encrypted vaults) also sweeps stray
  `*.parse*`/`*.tmp` transients under `workspace/documents/` and the DB's `.tmp` write-temp.
- **Legacy migration:** a document imported before this existed (or in plaintext mode) keeps its
  plaintext stored copy until **re-indexed**, which upgrades it to `.enc` in place and shreds the
  plaintext.
- The wiring: ingestion receives a `DocumentCipher` from `WorkspaceController.documentCipher()` —
  non-null only for an unlocked encrypted workspace (`plaintext_dev` keeps plaintext copies, as
  labelled).

### Vault descriptor (the only pre-unlock artifact)
Settings — including `workspaceMode` — live **inside** the encrypted DB, so the app cannot read them
before unlocking. A small **unencrypted** descriptor at **`config/workspace.json`** is the only thing
read pre-unlock:

```jsonc
{ "version": 1, "mode": "encrypted",
  "kdf": { "algo": "argon2id", "m": 19456, "t": 2, "p": 1, "keyLen": 32 },
  "saltB64": "…", "verifier": { "ivB64": "…", "tagB64": "…", "ciphertextB64": "…" } }
```

It holds **only** salt + KDF params + the verifier — never the password or the derived key, which
exist **only in memory** while unlocked. (Verified: tests scan the descriptor and the `.enc` blob and
assert the password string is absent.)

### Plaintext gating (Phase-8 policy now enforced)
`plaintextAllowed(policy, { isDev, developerMode })` decides whether plaintext is even offered:
`workspace.encryptionRequired` is an absolute veto; `workspace.allowPlaintextDevMode` must be true;
and the caller must be a developer (dev build or developer mode). Pre-unlock the `developerMode`
setting is unavailable (it lives in the encrypted DB), so `isDev` is the proxy. A commercial build
(not dev, `encryptionRequired` or no policy file) therefore **defaults to encrypted** and onboarding
does not offer plaintext.

### App-shell gate & lifecycle (spec §7.1)
`WorkspaceController.init()` runs at startup: an encrypted descriptor → stay **locked** until unlock;
no descriptor + plaintext permitted → open plaintext (dev); otherwise **uninitialized** → onboarding.
The renderer shows the create-password / unlock gate (`WorkspaceGate`) until `workspaceReady`
(`getWorkspaceState()` IPC). A **Lock now** control re-encrypts on demand — it first aborts any
in-flight generations and stops BOTH sidecars (chat runtime + E5 embedder; a llama-server keeps
recent prompts in its in-memory KV cache), then locks. Unlock restarts the chat runtime in the
background (the active-model auto-start); the embedder restarts lazily on the next embed.
`will-quit` likewise locks (re-encrypt + shred) alongside stopping the sidecars.

### Threat notes / known limitations
- **A decrypted working copy exists on disk while unlocked.** `node:sqlite` needs a real file, so the
  DB is plaintext on the drive while the app runs (re-encrypted + shredded on lock/quit). Documented
  limitation (plan §4b). Re-indexing an encrypted document similarly uses a transient decrypted
  file, shredded after parsing; startup sweeps any crash leftovers (`.parse*`, `.tmp`, WAL/SHM).
- **Logs are not encrypted.** `logs/app.log` never contains document contents or chat text, but may
  contain file names/paths and model ids.
- **Secure erase is best-effort.** Shredding overwrites then unlinks, but on SSDs wear-levelling may
  leave original blocks recoverable. We do not over-promise this.
- **No password recovery.** The password is never stored and the key is unrecoverable without it —
  losing the password means losing the workspace. Onboarding copy says so.

## Out of scope (MVP)
- OS-level firewall enforcement (offline is by design + policy/UX, not a hard network block).
- Multi-user access controls, enterprise admin/policy signing infrastructure, hardware DRM.

## Future improvements
- Sign `policy.json` and verify the signature before honouring it (enterprise edition).
- Optional OS-level network denylist / firewall helper.
- Field-level encryption of sensitive rows in addition to whole-file encryption.
