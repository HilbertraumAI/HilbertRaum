# Security Policy — HilbertRaum

_Last updated: 2026-06-29. Security-relevant changes since the Phase 9 baseline: the audit log
(Phase 19), the deny-by-default renderer permission handler (Phase 31), the v2 vault envelope with
O(1) password change (Phase 32), encrypted-at-rest diagnostics log, malicious-document resource caps,
the fail-closed packaged-build policy, on-device scanned-PDF/photo OCR (Phase 38), and image
understanding (local vision analysis with encrypted, deletable history)._

## Supported versions

This project is a pre-1.0 MVP. Security fixes target the `main` branch only until a stable release
is tagged.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers (a dedicated security contact
will be published before any public release). Do not open public issues for undisclosed
vulnerabilities. There is **no paid bug bounty** at this stage.

## Local threat model (summary)

HilbertRaum is a **local-first, offline** application. Full details live in
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
- **Deny-by-default renderer permissions** (Phase 31) — geolocation, notifications, camera, and
  screen capture are refused; the single exception is microphone access for voice dictation.
- **No model weights or user data in version control.**
- **Encrypted workspace** (implemented, Phase 9; v2 envelope Phase 32) — a password-derived key
  (**Argon2id** KDF for new vaults; scrypt remains supported for vaults created under the earlier
  default) encrypts the whole database file with AES-256-GCM at rest, **and each stored
  imported-document copy** (`workspace/documents/*.enc`) **and the diagnostics log
  (`logs/app.log.enc`)** with the same vault key. The password is **never stored** — only the salt,
  KDF parameters, an authenticated verifier, and (v2 envelope) a password-wrapped copy of the random
  data key (which enables O(1) password changes — only the wrapped key is re-sealed, the database is
  not re-encrypted) are kept in an unencrypted `config/workspace.json` descriptor. The DB is decrypted
  to a working file on unlock and re-encrypted + shredded on lock/quit. See
  [`docs/security-model.md`](docs/security-model.md) for the full design.
- **Tamper-evident audit log** (Phase 19) — records only ids, model ids, filenames, and counts;
  never chat content, document text, or passwords.
- **Malicious-document resource caps** — parse timeout, byte ceiling, PDF page cap, and a
  DOCX-decompression-bomb check bound the cost of a hostile import.
- **Fail-closed packaged policy** — a packaged commercial build enforces its `policy.json` strictly
  (e.g. downloads disabled) regardless of the user setting.

## Known limitations
- Offline enforcement in the MVP is by **design + policy/UX**, not a hard OS-level firewall.
- The MVP may permit a **plaintext developer workspace** for speed; this is gated by policy, clearly
  labelled, and is not the commercial default.
- **A decrypted working copy of the database exists on disk while the app is unlocked.**
  `node:sqlite` requires a real file, so the encrypted workspace is decrypted to `hilbertraum.sqlite` on the
  drive while running and re-encrypted (and the plaintext shredded) on lock/quit. Re-indexing an
  encrypted document likewise decrypts it to a **transient** working file that is shredded when
  parsing finishes. A hard crash or power loss can leave such plaintext files behind; the app shreds
  any stray plaintext DB (incl. its WAL/SHM and `.tmp` write-temps) **and** stray transient document
  copies on the next startup before re-unlocking, and attempts a best-effort lock on an uncaught
  fatal error. (Secure erase is still best-effort on SSDs — see below.)
- **Documents imported before document-cache encryption existed** (or into a plaintext workspace)
  remain plaintext under `workspace/documents/` until re-indexed; re-indexing in an encrypted
  workspace upgrades the stored copy to `.enc` in place. The diagnostics log is **encrypted at rest**
  (`logs/app.log.enc`) under the vault key on an encrypted workspace, and is plaintext only on a
  `plaintext_dev` workspace. In either case it never contains document contents or chat text, but may
  contain file names/paths and model ids.
- **Secure erase is best-effort.** Shredding overwrites then deletes the plaintext copy, but on SSDs
  wear-levelling may leave the original blocks recoverable.
- **No password recovery.** The workspace password is never stored; if it is lost, the encrypted
  workspace cannot be opened.
- Local-model answers can be wrong or incomplete (hallucination risk); the app is honest about this.
- OCR ("Make searchable") runs **on-device only** — bundled German + English tesseract language
  files, no cloud OCR. Recognition quality varies with scan quality and is not guaranteed.

## Out of scope (MVP)
- Multi-user access controls, enterprise admin/policy enforcement, hardware DRM/dongles.
