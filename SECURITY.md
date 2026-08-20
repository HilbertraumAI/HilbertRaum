# Security Policy — HilbertRaum

## Supported versions

This project is a pre-1.0 MVP. Security fixes target the `master` branch only until a stable release
is tagged.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **security@hilbertraum.ai**. Do not open
public issues for undisclosed vulnerabilities. Where available, GitHub's **private vulnerability
reporting** on this repository is an alternative channel. We are a small team: expect an
acknowledgement within a few business days. There is **no paid bug bounty** at this stage.

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
- **The one inbound surface is opt-in and loopback-bound** — the optional local API (Settings →
  Privacy & data) listens only on `127.0.0.1`/`::1`, is **off by default**, exists only while the
  workspace is unlocked, requires a Bearer access key by default, and can be forbidden outright by
  drive policy — a drive that forbids it must say so **explicitly** (`allow_local_api: false`,
  which is what `prepare-drive` writes), because a policy file written before the feature
  existed has no such key and inherits the permissive default rather than being silently denied. It validates the `Host` header, refuses `http(s)` origins whose host is not
  a loopback address, refuses `OPTIONS`, never emits CORS headers, and caps request bodies —
  so browser JavaScript is structurally locked out. It serves **chat completions plus a
  one-model listing and nothing else**: there is no route to documents, conversations, or any
  other workspace data. There is no LAN mode and no setting
  that could produce one. The access key is compared in constant time, is stored in the workspace
  database (encrypted at rest with everything else, never in renderer state, never crossing IPC in
  full), and **rotating it aborts every in-flight request the old key admitted** — auth is checked
  once at admission, so a live stream must not outlive the credential that let it in. Request
  bodies are capped at 1 MB counted as bytes arrive (`Content-Length` is never trusted) and
  connections at 16. The full posture, the wire contract, and the accepted residuals are in
  [`docs/local-api.md`](docs/local-api.md).
- **The model sidecars authenticate their own requests** — each `llama-server` spawn is given a
  fresh random API key through its **environment** (never argv, so it is not visible in a process
  list), and the key is redacted from captured stderr before that text can reach an error message,
  the audit trail, the log, or a support export.
- **No model weights or user data in version control.**
- **Engine binaries re-hashed before every spawn** — each bundled `llama-server` (chat + translation
  sidecars), whisper, and GPU-probe binary is verified against its recorded install hash immediately
  before it is executed. A packaged build refuses to spawn a tampered binary and falls back; dev
  builds are inert. Downloaded model files are separately checksum-verified before first use.
- **User skill packs are treated as untrusted input** — a drop-in `SKILL.md` pack is third-party
  content, so it is size-gated on import (over-cap packs are rejected) and its tools run through the
  same audited bridge with a **frozen document scope they cannot widen**.
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
- **Tamper-evident audit log** (Phase 19) — records only ids, model ids, statuses, and counts;
  never chat content, document text, document titles/filenames, or passwords. (User-chosen document
  titles/filenames were removed as content in a 2026-06-30 hardening — a `documentId`, not its name,
  goes on record, since the whole log is exportable as plaintext; model ids are not user content.)
- **Malicious-document resource caps** — parse timeout, byte ceiling, PDF page cap, and a
  DOCX-decompression-bomb check bound the cost of a hostile import.
- **Fail-closed packaged policy** — a packaged commercial build enforces its `policy.json` strictly,
  regardless of the user setting. A policy can only *restrict*: e.g. it may disable model downloads
  entirely (drives ship with downloads permitted by default, so this is an available restriction, not
  the shipped default).

## Known limitations
- Offline enforcement in the MVP is by **design + policy/UX**, not a hard OS-level firewall.
- The MVP may permit a **plaintext developer workspace** for speed; this is gated by policy, clearly
  labelled, and is not the commercial default.
- **A decrypted working copy of the database exists on disk while the app is unlocked.**
  `node:sqlite` requires a real file, so the encrypted workspace is decrypted to `hilbertraum.sqlite` on the
  drive while running and re-encrypted (and the plaintext shredded) on lock/quit. Re-indexing an
  encrypted document, **translating a whole document**, or opening an image-analysis entry likewise
  decrypts it to a **transient** working file (`*.parse*`/`*.tmp`) that is shredded when the operation
  finishes. A hard crash or power loss can leave such plaintext files behind; the app shreds any stray
  plaintext DB (incl. its WAL/SHM and `.tmp` write-temps) **and** stray transient document/image
  copies under `workspace/documents/` and `workspace/images/` on the next startup before re-unlocking,
  and attempts a best-effort lock on an uncaught fatal error. (Secure erase is still best-effort on
  SSDs — see below.)
- **Documents imported before document-cache encryption existed** (or into a plaintext workspace)
  remain plaintext under `workspace/documents/` until re-indexed; re-indexing in an encrypted
  workspace upgrades the stored copy to `.enc` in place. The diagnostics log is **encrypted at rest**
  (`logs/app.log.enc`) under the vault key on an encrypted workspace, and is plaintext only on a
  `plaintext_dev` workspace. In either case it never contains document contents or chat text, but may
  contain file names/paths and model ids.
- **Secrets in this process are only as private as the account running it.** The sidecar API key is
  passed through the child's environment and the local API's access key lives in the workspace
  database, so both defend against *other users*, process listings, and log/stderr exposure — they
  do **not** defend against a debugger running as **you** (`/proc/<pid>/environ`,
  `ReadProcessMemory`) or against a full-memory crash dump written to disk. On Windows we
  recommend leaving crash dumps at the **minidump** default rather than full dumps, so process
  memory holding a key is not persisted.
- **The local API trusts every program running as you.** A loopback endpoint cannot tell one local
  program from another; the access key is the boundary, and any program that can read your workspace
  could read the key. This is why the feature is off by default, asks for explicit consent, and
  keeps the key requirement on unless you turn it off.
- **Secure erase is best-effort.** Shredding overwrites then deletes the plaintext copy, but on SSDs
  wear-levelling may leave the original blocks recoverable.
- **No password recovery.** The workspace password is never stored; if it is lost, the encrypted
  workspace cannot be opened.
- Local-model answers can be wrong or incomplete (hallucination risk); the app is honest about this.
- OCR ("Make searchable") runs **on-device only** — bundled German + English tesseract language
  files, no cloud OCR. Recognition quality varies with scan quality and is not guaranteed.

## Out of scope (MVP)
- Multi-user access controls, enterprise admin/policy enforcement, hardware DRM/dongles.
