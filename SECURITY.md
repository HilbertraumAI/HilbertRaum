# Security Policy — Private AI Drive Lite

_Last updated: 2026-06-09 (Phase 9)_

## Supported versions

This project is a pre-1.0 MVP. Security fixes target the `main` branch only until a stable release
is tagged.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers (a dedicated security contact
will be published before any public release). Do not open public issues for undisclosed
vulnerabilities. There is **no paid bug bounty** at this stage.

## Local threat model (summary)

Private AI Drive Lite is a **local-first, offline** application. Full details live in
[`docs/security-model.md`](docs/security-model.md).

### Assets we protect
- Imported documents, extracted text, embeddings
- Chat history and generated outputs
- Local logs and settings
- The workspace encryption key material

### Primary mitigations
- **No network in the core path** — no cloud, telemetry, or remote endpoints.
- **Context-isolated, sandboxed renderer** — the UI has no direct Node/file/network access; it only
  calls a typed, audited bridge.
- **Strict Content-Security-Policy** — no remote origins are permitted.
- **No model weights or user data in version control.**
- **Encrypted workspace** (implemented, Phase 9) — a password-derived key (**Argon2id** KDF for new
  vaults; scrypt remains supported for vaults created under the earlier default) encrypts the whole
  database file with AES-256-GCM at rest, **and each stored imported-document copy**
  (`workspace/documents/*.enc`) with the same vault key. The password is **never stored** — only the
  salt, KDF parameters, and an authenticated verifier are kept in an unencrypted
  `config/workspace.json` descriptor. The DB is decrypted to a working file on unlock and
  re-encrypted + shredded on lock/quit. See [`docs/security-model.md`](docs/security-model.md) for
  the full design.

## Known limitations
- Offline enforcement in the MVP is by **design + policy/UX**, not a hard OS-level firewall.
- The MVP may permit a **plaintext developer workspace** for speed; this is gated by policy, clearly
  labelled, and is not the commercial default.
- **A decrypted working copy of the database exists on disk while the app is unlocked.**
  `node:sqlite` requires a real file, so the encrypted workspace is decrypted to `paid.sqlite` on the
  drive while running and re-encrypted (and the plaintext shredded) on lock/quit. Re-indexing an
  encrypted document likewise decrypts it to a **transient** working file that is shredded when
  parsing finishes. A hard crash or power loss can leave such plaintext files behind; the app shreds
  any stray plaintext DB (incl. its WAL/SHM and `.tmp` write-temps) **and** stray transient document
  copies on the next startup before re-unlocking, and attempts a best-effort lock on an uncaught
  fatal error. (Secure erase is still best-effort on SSDs — see below.)
- **Documents imported before document-cache encryption existed** (or into a plaintext workspace)
  remain plaintext under `workspace/documents/` until re-indexed; re-indexing in an encrypted
  workspace upgrades the stored copy to `.enc` in place. The local log file is not encrypted (it
  never contains document contents or chat text, but may contain file names/paths).
- **Secure erase is best-effort.** Shredding overwrites then deletes the plaintext copy, but on SSDs
  wear-levelling may leave the original blocks recoverable.
- **No password recovery.** The workspace password is never stored; if it is lost, the encrypted
  workspace cannot be opened.
- Local-model answers can be wrong or incomplete (hallucination risk); the app is honest about this.
- Scanned-PDF OCR is **not** included in Lite.

## Out of scope (MVP)
- Multi-user access controls, enterprise admin/policy enforcement, hardware DRM/dongles.
