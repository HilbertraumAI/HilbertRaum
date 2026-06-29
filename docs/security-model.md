# Security model — HilbertRaum

_Last updated: 2026-06-20 (Image-understanding V8 — encrypted, deletable image-analysis history;
its write/read temps now joined the startup crash sweep)_

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
| `will-navigate` **and `will-redirect`** block remote origins (SEC-3) | `services/navigation-guard.ts`, installed in `main/index.ts` + OCR window |
| `setWindowOpenHandler` opens external links in the OS browser, denies in-app | `main/index.ts` |
| **Content-Security-Policy** (meta tag + response header) | `renderer/index.html`, `main/index.ts` |
| **Deny-by-default permission handlers** — both the *request* and the *check* path (Phase 31; single scoped microphone allow added in Phase 37; check handler added SEC-2) | `services/permissions.ts`, installed in `main/index.ts` |
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

### Renderer permissions: deny by default, one scoped exception — request *and* check (Phases 31 + 37; SEC-2)
Electron's default with **no** permission handler installed is to **GRANT** every permission
(geolocation, notifications, media, …) — found by the 2026-06-11 wave-3 plan audit. `services/
permissions.ts` therefore installs a deny-by-default handler on the window's session (next to the
CSP setup in `main/index.ts`, identical in dev and prod). Since Phase 37 there is exactly **one**
exception, for voice dictation: `media` is granted **iff** it comes from the app's **own
WebContents** (reference-compared against the main window) **and** the requested capture is
**audio and nothing else**. Video capture, screen capture, an unverifiable scope, every other
permission, and any other WebContents stay denied — the unit test drives the full scope matrix
against a fake session, so the allow cannot silently widen. Denials are logged by permission
*name* only — never content.

**Both Electron permission paths are covered (SEC-2, backend-audit-2026-06-27).** Electron exposes
two *independent* paths and the default-grant pitfall applies to both: the asynchronous **request**
path (`setPermissionRequestHandler`, e.g. `getUserMedia`'s prompt) and the synchronous **check**
path (`setPermissionCheckHandler`, e.g. `navigator.permissions.query` and the internal
pre-`getUserMedia` capability check). Previously only the request handler was installed, so the
check path fell back to Electron's default. `installPermissionCheckHandler` now installs the
synchronous counterpart on the same session. **Both handlers share one grant predicate
(`grantsMicrophone`)** — only `media`, audio-scoped, from the app's own WebContents — so request
and check can never drift out of sync; both are deny-by-default except app-origin audio. (The
check path carries a *scalar* `mediaType`, not the request path's `mediaTypes` array; the shared
predicate takes the path-specific audio test as an argument so the core decision stays identical.)
The check handler does **not** log denials: the check path is high-frequency (e.g. `permissions.
query` polling) and the request handler already records denials.

### In-app navigation: block remote origins on *both* navigation events (SEC-3)
A strict prod CSP + `file://` origin already bound what the renderer can reach, but the standard
hardening is to refuse any top-level navigation the window has no business making.
`services/navigation-guard.ts` `installNavigationGuard` attaches one deny-by-default predicate to
**both** `will-navigate` **and `will-redirect`** (SEC-3, backend-audit-2026-06-27). The pair must
be guarded together: a server-side (3xx) or `<meta http-equiv="refresh">` redirect can reach a
remote origin via `will-redirect` **without ever firing `will-navigate`** — guarding only
`will-navigate` (the prior state) left the redirect path on Electron's default (allow). The **main
window** allows only its own shell (Vite's localhost in dev, the bundled `file://` page in prod);
the **OCR rasterizer's hidden window** — which renders untrusted PDF bytes and only ever loads
`ocr.html` — denies *all* navigation (`() => false`). The installer is unit-tested with a fake
WebContents that proves both events are registered and a remote redirect is prevented.

### Voice dictation data path (Phase 37, decision D30)
The composer mic records **in the renderer** (`getUserMedia` → `MediaRecorder`), resamples to
16 kHz mono and encodes a WAV **in-page**, and sends the **bytes** (never a path) over the
`dictation:transcribe` IPC. The main process writes them to a transient
`<uuid>.parse-dictation.wav` under `workspace/documents/` — the `.parse` infix puts it under the
same startup `shredStalePlaintext` crash sweep as every ingestion transient — runs the Phase-36
whisper transcriber (whose own transcript JSON transient is steered into the same swept
directory), returns the text, and **shreds the WAV in `finally`** (success or failure). Nothing
about a dictation is persisted: the text goes only into the composer input for review (never
auto-sent), there is **no audit event** (dictation is content-adjacent, like search), and errors
returned to the renderer are fixed friendly copy — the technical reason goes to the local log
only (transcriber error tails are stderr-only by the Phase-36 guarantee, never transcript
content). The OS microphone indicator is the recording signal; the app adds no overlay of its own.

## Offline posture (spec §3.6)

The app makes **no outbound network calls in its core path** — this is a property of the code, not a
firewall. Two layers make it visible and defensible:

### 1. Policy precedence (`services/policy.ts`)
`config/policy.json` and `config/drive.json` are **optional** (developer runs fall back to defaults)
and are merged over `DEFAULT_POLICY`, where **update checks and telemetry are off** (no toggle
exists for either) and — since Phase 18 (wave-1 decision D3 — architecture.md "In-app model downloader") — `allow_model_downloads` is
**permitted**, so that with no policy file the spec §3.6 user toggle is the effective downloads
gate. The policy models the spec §6 shape (`network` / `workspace` / `models` blocks).

**Fail-closed on a packaged build (audit M-4, 2026-06-13).** The base the file is merged over —
and the fallback for a **missing / malformed / partial** `policy.json` — depends on the build type
(`loadPolicy(configDir, onWarn, { isDev })`):

- **Dev build** (`!app.isPackaged`): base = `DEFAULT_POLICY` (developer-friendly — plaintext + unverified
  models allowed, downloads permitted). Unchanged.
- **Packaged build**: base = `STRICT_POLICY` (`encryption_required: true`, `allow_plaintext_dev_mode:
  false`, `allow_unverified_models: false`, `require_sha256_match: true`, all network denied). A
  corrupted or deleted `policy.json` on a removable drive therefore **tightens** toward the commercial
  posture instead of loosening toward dev — it can no longer silently disable model-integrity
  enforcement. A partial/junk file leaves every unspecified field at the strict value. This also
  neutralizes M-6: an unverified/placeholder-hash weight cannot be loaded when the fallback forbids it.

`isDev` is threaded from `initBackend()` into every policy read (the model/download/core IPC handlers).
The commercial **sell gate** (`assertCommercialDrive`) deliberately keeps the DEFAULT base: a drive
shipping *no* `policy.json` must FAIL the gate, not pass on the strict fallback.

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
- **The shipped default permits downloads, but only when a policy also allows them.** `allowNetwork`
  defaults **ON** (`DEFAULT_SETTINGS`) so a fresh dev install can fetch models out of the box;
  however a packaged commercial drive ships a `policy.json` with downloads disabled, which overrides
  the user setting and keeps it offline (`networkAllowed = networkAllowedByPolicy && userSetting`).
  While the workspace is locked the setting is unreadable and treated as off.
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
AI Model screen uses the same distinction to explain why downloads are unavailable.

### 2. Startup self-check (`services/offlineGuard.ts`)
At startup (`initBackend()`), `assertOfflinePosture()` logs the offline posture and, while offline,
installs a defensive tripwire over `net.Socket.prototype.connect` in **all builds** (so a production
regression that tried to phone home would still be recorded locally). While offline, any connection to
a **remote** host is logged as a violation.

**Loopback is not "network".** `127.0.0.0/8`, `::1`, and `localhost` are explicitly exempt — the dev
renderer loads from `http://localhost` today and the Phase-10 `llama.cpp` sidecar binds `127.0.0.1`.
Only genuinely remote origins are flagged. The guard **only logs; it never blocks or throws**, so a
wrong host guess can never break local IPC or the sidecars. Real runtimes MUST bind
`127.0.0.1` only. The IPv4 loopback test is **anchored** (`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`,
audit L-1) so a hostname like `127.evil.com` is not misclassified as loopback; `isLoopbackHost` is a
detection helper only and must never gate an allowed-vs-blocked decision.

#### Detection-only, not enforcement — a recorded decision (audit M-S1, 2026-06-13)

The tripwire deliberately **logs and audits** a remote connect, then **calls the original
`connect` anyway**. It is a regression detector, not a firewall. Audit finding M-S1 asked whether
to upgrade it to *reject* non-loopback connects while offline (feasible, since `isLoopbackHost`
already exempts the sidecar). **Decision: keep detection-only.** Rationale:

- The offline guarantee already rests on two stronger, structural controls: **no remote-calling
  code exists** in the core path (no hosted-AI SDKs, no telemetry — spec §0, enforced by review +
  the no-dependency posture) and the **prod CSP** (`connect-src` excludes remote origins for the
  renderer). The tripwire is a third, defence-in-depth *signal* that those held — not the primary
  guarantee.
- The patch monkey-patches `net.Socket.prototype.connect` **process-wide**. Throwing on a
  misclassified host would convert a host-extraction edge case (`extractHost` returning the wrong
  value for some future connect shape) into a **hard offline failure that breaks loopback IPC or a
  sidecar** — strictly worse than today's silent-log-plus-audit. A detector that is wrong merely
  logs noise; an enforcer that is wrong takes the app down offline.
- A firing at all already indicates a regression worth investigating (the core path makes zero
  remote calls), and it is **recorded in the audit log**, so the operator sees it.

OS-level network blocking remains explicitly **out of scope** (see "Out of scope (MVP)" below):
offline is by design + policy/UX, not a kernel-level block. If a hard block is ever wanted, the
right layer is the OS firewall / a sandbox profile, not an in-process `connect` shim.

## Logs are local-only AND encrypted at rest (spec §7.11, §3.5)
`services/logging.ts` writes a rotating diagnostics log under the workspace `logs/` directory and
never uploads. Diagnostics surfaces local data only; it transmits nothing off-device.

**The log is encrypted at rest on an encrypted workspace** — `app.log` can carry file
names/paths and model ids (never document or chat text — a hard call-site rule), so it is sealed
under the **same vault key as the database and the document cache** (AES-256-GCM, the framed
`MAGIC | iv | tag | ciphertext` blob), at rest as `logs/app.log.enc` (rotated copy
`app.1.log.enc`). On a `plaintext_dev` workspace the log stays a plain rotating `app.log`,
matching the unencrypted dev DB.

### Design record — encrypted log (2026-06-13)

The wrinkle is **timing**: logging starts at app launch, *before* the vault is unlocked, so the
key does not yet exist (startup, policy load, and the unlock attempts themselves all log). The log
therefore runs as a three-state machine (`services/logging.ts`):

- **`buffering`** (pre-unlock, the initial state after `initLogging`): every line is held in a
  bounded in-memory buffer (≤ 2 MB by UTF-8 byte length, oldest whole lines dropped on a line
  boundary). **Nothing touches disk.** Lines logged before the user authenticates are lost if the
  app is killed while still locked — a deliberate trade for "no sensitive bytes on disk before
  unlock." The same applies to a session spent entirely at the unlock gate (never unlocked): it
  stays in `buffering` and is discarded on quit.
- **`encrypted`** (after `attachVaultKey(key)`, called from the unlock/create IPC path): the buffer
  is folded together with any persisted history decrypted from `app.log.enc`, then re-sealed. New
  lines append to the in-memory buffer; the `.enc` snapshot is rewritten **on every `error`**
  (so a crash keeps the failure), on **rotation**, and on **lock/quit** (`detachVaultKey()`, called
  before `WorkspaceController.lock()` zeroes the key). `info`/`warn` lines ride the next flush
  rather than re-encrypting ~1 MB per line — so a **hard kill** (SIGKILL/OOM/power loss/drive
  removal, no `uncaughtException` flush) loses the `info`/`warn` accumulated since the last flush;
  the price of not thrashing the drive on the hot path. Both the live `.enc` and the rotated
  `app.1.log.enc` are written **atomically** (temp + fsync + rename). `readLogTail` reads the
  in-memory buffer (the on-disk copy is ciphertext). **On lock (`detachVaultKey()`), after the final
  encrypted flush, the in-memory buffer is ZEROED** (audit-postmerge-2026-06-29 **F14**): the buffer
  still holds the just-ended session's lines (file names, paths, model ids, settings keys — metadata,
  never document/chat text), and because the read path falls back to `buffering` mode and
  `getLogTail`/`exportLog` are deliberately not lock-gated (they must work pre-unlock for
  troubleshooting), leaving it would let a still-mounted Diagnostics screen / compromised renderer read or *export* the
  prior session after lock. The lines are persisted to `app.log.enc` first, so the next unlock
  repopulates the tail from disk — nothing is lost, only the post-lock RAM residue is cleared. The
  zeroing is guarded on `mode === 'encrypted'`, so the pre-FIRST-unlock `buffering` window (logs
  deliberately readable for troubleshooting) is untouched. **Rotation keeps one prior generation**:
  `app.1.log.enc` is recovery-only — `readLogTail`/`loadEncrypted` read only the live `.enc`/buffer,
  so the Diagnostics tail shows the current generation (mirroring the plaintext rotation, whose tail
  reads only `app.log`).
- **`plaintext`** (after `usesPlaintextLog()`, called when a `plaintext_dev` workspace opens at
  startup): the buffer is flushed to a plain `app.log` and appended in real time.

A **password change** swaps in a fresh data key on a v1→v2 migration and zeroes the old one (v2 keeps
the same data key). After a *successful* change the IPC handler calls `rekeyVaultLog(newKey)`, which
re-seals the **same in-memory buffer** under the now-current key **without re-loading from disk** —
the buffer already holds the full session-plus-history log, so a re-load would discard history under
a rotated key, or **double** it under an unchanged one. On a *failed* change the key never moved, so
the log is left untouched (it keeps writing under the unchanged live key).

**Migration:** an older (pre-encryption) build, or a crash before this build's first lock, can leave
a plaintext `app.log`/`app.1.log` on an encrypted drive. `attachVaultKey` **shreds** them on the
first encrypted attach (best-effort, same `shredFile` as the DB working copy). The vault key is
exposed to logging via `WorkspaceController.encryptionKey()` (the same data key as
`documentCipher()`); the caller must not retain it past a lock.

## Audit log data class (Phase 19)

`services/audit.ts` records app activity into the spec §8 `runtime_events` table. The recorded
families (`AuditEventType` in `shared/types.ts`) span model starts/stops and downloads; document
imports/deletes and lifecycle/collection changes (`document_lifecycle_changed`, `collection_*`);
document tasks and exports (`document_task_*`, `document_exported`/`summary_exported`); conversation
lifecycle (`conversation_*`); skill management and runs (`skill_imported`/`deleted`/`enabled`/
`disabled`, `skill_run_*`); workspace lock/unlock; privacy-relevant settings changes; policy
warnings; and offline-guard detections. (`shared/types.ts` is the authoritative enum.) Its data
class is defined by a **hard privacy rule**:

- Events carry **ids, model ids, filenames, and counts only** — NEVER chat content, document
  text, or passwords. A chat transcript export records only the conversation id (even the
  chosen filename is excluded — it derives from the conversation title, which is chat
  content); `settings_changed` records the **privacy-relevant keys** (`allowNetwork`,
  `gpuMode`, `developerMode`) and their boolean/enum values, never any other setting's value.
  Enforced by a sentinel-grep test (`tests/integration/audit-ipc.test.ts`) that pushes secret
  strings through the wired flows and proves their absence from every recorded row.
- The log lives **inside the workspace DB** ⇒ on an encrypted workspace it is encrypted at
  rest exactly like chats. It is FOR THE USER (spec §7.11): local only, surfaced on the
  Diagnostics **Activity** panel, exported only by an explicit user save-dialog action.
  This is not telemetry — nothing uploads anywhere.
- Recording **never throws** (`recordEvent` swallows failures; the `ctx.audit` recorder
  buffers in memory while the vault is locked, bounded at 100 events, and flushes after the
  next unlock — which is how `workspace_unlock_failed` reaches the log at all). An audit
  failure can never break the operation it records.
- Retention: pruned to the **newest 5 000 rows on every insert** (`AUDIT_MAX_ROWS`, wave-1 decision
  D7 — fixed for wave 1; configurability is Office-edition admin surface).

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
  `keyLen = 32` (~0.5 s/unlock — a deliberate one-time cost); legacy scrypt `N = 32768 (2^15)`, `r = 8`,
  `p = 1`. Because the params are stored alongside the salt, unlock derives **exactly** the same key —
  derivation is deterministic. The params are tunable without changing the on-disk format.

**Accepted residual — offline password guessing on a lost/stolen drive (full-audit-2026-06-29 SEC-1, Low).**
The unlock IPC path (`unlockWorkspace`) has **no attempt counter, escalating delay, or lockout**, and the
only password floor is **length ≥ 8** (`MIN_PASSWORD_LENGTH`); there is no strength meter at create/change
time. Against the explicitly-modeled lost/stolen-drive threat, an attacker who has the drive can ignore the
IPC layer entirely and brute-force the descriptor's authenticated verifier offline, so a UI rate-limit would
not bind them — a weak-but-≥8 password (e.g. a dictionary word + two digits) is realistically guessable
offline at the **interactive-minimum** Argon2id cost (`m≈19 MiB, t=2, p=1`, ~0.5 s/derive, chosen for unlock
latency on portable hardware). The **at-rest Argon2id + AES-256-GCM encryption is the primary mitigation**
(the plaintext DB and document copies never rest on the drive — only the encrypted blobs + the small
verifier descriptor), and there is **no leak path** for a wrong guess (a wrong key fails the GCM tag without
touching the DB). On an offline, single-user, local-only product this is a **defensible trade-off and is
recorded here as an accepted residual.** *Optional, unscheduled follow-up:* an escalating-delay / attempt
counter on the IPC unlock path (cheap defence against scripted GUI guessing, not against raw offline
attack) plus a create/change-time strength meter/floor — the **code half of SEC-1**, deliberately **not**
implemented in the Phase-6 docs-only close-out (see architecture.md §26).

### AEAD (encryption at rest)
- **AES-256-GCM.** Every encryption uses a fresh random 12-byte IV; the 16-byte auth tag is stored
  alongside the ciphertext. A wrong key or any tampering fails the GCM tag → `decrypt` throws, which
  upstream is treated as "wrong password" (the DB is never opened with a bad key).
- The encrypted DB file is framed as `MAGIC(8) | iv(12) | tag(16) | ciphertext` (`hilbertraum.sqlite.enc`).

### Whole-file encryption-at-rest (no SQLCipher under `node:sqlite`)
`node:sqlite` has no SQLCipher, so the **whole database file** is encrypted at rest, not
individual rows — the spec §8 schema is identical in both modes.

- **On unlock:** derive the key → verify the password against the descriptor's authenticated
  **verifier** (a known plaintext encrypted under the key; a wrong key fails the GCM tag **without
  touching the DB**) → decrypt `hilbertraum.sqlite.enc` → `hilbertraum.sqlite` **on the drive** (never a temp/cloud
  dir) → `openDatabase()`.
- **On lock / quit:** `PRAGMA wal_checkpoint(TRUNCATE)` + `close()` (flush WAL into the main file) →
  re-encrypt the working file → `hilbertraum.sqlite.enc` → **shred + delete** the plaintext working file and
  its `-wal`/`-shm` sidecars.
- **WAL sidecars:** WAL mode creates `hilbertraum.sqlite-wal` / `-shm`, which can hold plaintext pages.
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
  `*.parse*`/`*.tmp` transients under `workspace/documents/` **and `workspace/images/`** plus the
  DB's `.tmp` write-temp (the stored copies — `<id><ext>.enc` — match neither pattern, so they
  survive).
- **Legacy migration:** a document imported before this existed (or in plaintext mode) keeps its
  plaintext stored copy until **re-indexed**, which upgrades it to `.enc` in place and shreds the
  plaintext.
- The wiring: ingestion receives a `DocumentCipher` from `WorkspaceController.documentCipher()` —
  non-null only for an unlocked encrypted workspace (`plaintext_dev` keeps plaintext copies, as
  labelled).

### Encrypted image-analysis history (added 2026-06-20)
The Images screen used to persist **nothing** (analyses were ephemeral). It now saves an automatic
**history** — the analyzed image plus its Q&A turns — so it rests under the **same encryption contract
as the document cache** (the analyze request itself still base64-inlines the bytes to the loopback
sidecar and writes no temp; only the history copy lands on disk).

- **At rest:** the image is stored under `workspace/images/` as `<id><ext>.enc` (same
  `MAGIC | iv | tag | ciphertext` framing, same vault key, fresh IV per file) via the same
  `DocumentCipher`. The Q&A turns live in the `image_turns` table (so they are covered by the
  encrypted DB). `plaintext_dev` workspaces store a raw `<id><ext>` copy (`encrypted=0`), as labelled.
- **Write path:** the bytes are written to a short-lived plaintext temp (`<id>.tmp`), `encryptFile`-d
  to the `.enc` sidecar, and the temp **shredded** — the same transient-then-shred posture as document
  parse.
- **Read path (open an entry):** the `.enc` is decrypted to a **per-call unique** transient temp
  (`<id>.read-<pid>-<uuid>.tmp`), read, then **shredded**. The uuid (added vuln-scan-2026-06-21) keeps two
  concurrent reads of the same session — e.g. a double-click — from colliding on one staging file.
- **In-memory residue at lock:** `VisionService.stop()` (wired to workspace lock + quit) aborts in-flight
  jobs, tears down the sidecar, AND **clears the per-process job map** so a completed answer (content
  derived from the private image) does not survive the vault re-encrypt — consistent with the lock path
  purging resident RAG vectors and zeroing the vault key (added vuln-scan-2026-06-21). The map is also
  bounded (`VISION_MAX_JOB_HISTORY`) so terminal jobs don't accumulate across a session, and
  `imageGetJob`/`imageCancel` are gated on unlock like the other vision handlers.
- **Crash recovery:** both temps end in `.tmp`, so the startup `shredStalePlaintext` sweep of
  `workspace/images/` removes any leftover from a process killed mid-write or mid-read.
- **Delete:** removing a history entry **shreds** the stored image and cascade-removes its turns
  (`image_turns.session_id` FK `ON DELETE CASCADE`); shredding is best-effort (a missing/locked copy
  never blocks the DB cleanup), matching `deleteDocument`.
- **Logging/audit unchanged:** the vision path still records **zero** audit rows and never logs
  image/prompt/answer content — asserted by `tests/integration/vision-security.test.ts` (whose former
  "writes nothing to disk" check now asserts the stored copy is **encrypted**, no plaintext leak).

### Vault descriptor (the only pre-unlock artifact)
Settings — including `workspaceMode` — live **inside** the encrypted DB, so the app cannot read them
before unlocking. A small **unencrypted** descriptor at **`config/workspace.json`** is the only thing
read pre-unlock. Since Phase 32 it is the **v2 envelope** format:

```jsonc
{ "version": 2, "mode": "encrypted",
  "kdf": { "algo": "argon2id", "m": 19456, "t": 2, "p": 1, "keyLen": 32 },
  "saltB64": "…",
  "verifier": { "ivB64": "…", "tagB64": "…", "ciphertextB64": "…" },
  "dataKey":  { "ivB64": "…", "tagB64": "…", "ciphertextB64": "…" } }
```

- **v2 (envelope, the default for new vaults):** a random 32-byte **data key** encrypts the DB
  file and every document sidecar; the password-derived key is only a **KEK** that wraps the
  data key (`dataKey` = AES-256-GCM of the data key under the KEK). Unlock: derive the KEK →
  check the verifier → unwrap the data key → zero the KEK. This makes a password change O(1)
  (re-wrap one blob) and is the foundation for future key features (recovery codes, rotation).
- **v1 (legacy, still fully supported):** no `dataKey` — the data is encrypted directly under
  the password-derived key. v1 vaults unlock unchanged forever; they migrate to v2 only on
  their **first password change** (never on unlock — a vault that never changes its password
  is never rewritten).

It holds **only** salt + KDF params + the verifier + (v2) the *wrapped* data key — never the
password, the derived key, or the plaintext data key, which exist **only in memory** while
unlocked. (Verified: tests scan the descriptor and the `.enc` blobs and assert that neither
password nor the raw/base64/hex data-key bytes appear.)

### Password change (Phase 32, decision D24)
`WorkspaceController.changePassword(current, next)` — Settings → General → "Change password",
IPC `workspace:changePassword`. Runs **unlocked only**; the **current** password is verified
against the existing verifier first (a wrong one is the same failure class as a wrong unlock —
audited as `workspace_unlock_failed`, never a new event). Hidden entirely in `plaintext_dev`.

- **v2 vault → O(1) re-wrap:** write a fresh envelope descriptor — new random salt, KEK under
  `DEFAULT_KDF` (so a legacy **scrypt** vault silently upgrades to **Argon2id** here), new
  verifier, the *same* data key re-wrapped — as one atomic descriptor replace (write temp,
  fsync, rename). No data file is touched; the in-memory key is unchanged; no re-lock needed.
- **v1 vault → one-time journaled migration to v2:** composed from the existing primitives
  (`encryptFile`'s `.tmp`-then-rename, `shredFile`, the startup sweep):
  1. **Stage:** checkpoint the WAL, re-encrypt the live DB and every `<id><ext>.enc` document
     sidecar under a fresh random data key, each written as `<file>.new` and fsynced. The
     transient plaintext per sidecar ends in `.tmp`, so `shredStalePlaintext` covers a crash.
  2. **Commit:** the atomic v2-descriptor replace — the *single* commit point.
  3. **Swap:** shred each old file, rename `<file>.new` into place.
  **Crash recovery** (`recoverPendingRekey`, run at startup and before every unlock decrypt):
  staged `.new` files with a **v1** descriptor mean the crash was pre-commit → discard them,
  the old password + old files win; with a **v2** descriptor the commit happened → roll the
  staged files forward, the new password wins. Old-or-new, never a mix — tests cut the journal
  at every step and prove both directions.
- **Race guard:** an import/re-index job writes `.enc` sidecars, so `changePassword` refuses
  to start while document work holds a lease (`beginDocumentWork`), and document work refuses
  to start mid-change — both with friendly copy (`VaultBusyError`), never corruption.
- **Audit:** success records the additive `workspace_password_changed` — id-free and
  content-free; passwords never appear in any log or audit row.
- **Compatibility note:** a pre-Phase-32 build cannot open a v2 vault (the unlock fails with a
  generic error, harming nothing) — see `known-limitations.md`.

### Plaintext gating (Phase-8 policy now enforced)
`plaintextAllowed(policy, { isDev })` decides whether plaintext is even offered:
`workspace.encryptionRequired` is an absolute veto; `workspace.allowPlaintextDevMode` must be true;
and the caller must be a developer. The `developerMode` *setting* lives in the encrypted DB, so it
cannot gate the decision of whether that DB opens at all — the dev-build flag (`isDev`) is the
developer signal. A commercial build (not dev, `encryptionRequired` or no policy file) therefore
**defaults to encrypted** and onboarding does not offer plaintext.

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
  limitation. Re-indexing an encrypted document similarly uses a transient decrypted
  file, shredded after parsing; startup sweeps any crash leftovers (`.parse*`, `.tmp`, WAL/SHM).
- **Logs are encrypted at rest** on an encrypted workspace (`logs/app.log.enc`, under the vault key);
  plaintext only on a `plaintext_dev` workspace. The log never contains document contents or chat
  text, but may contain file names/paths and model ids — which is why it is sealed. The narrow
  residual: lines logged *before unlock* are buffered in memory only (never persisted), so they are
  lost on a kill while still locked. See "Logs are local-only AND encrypted at rest" above.
- **Secure erase is best-effort.** Shredding overwrites then unlinks, but on SSDs wear-levelling may
  leave original blocks recoverable. We do not over-promise this.
- **No password recovery.** The password is never stored and the key is unrecoverable without it —
  losing the password means losing the workspace. Onboarding copy says so.

## Malicious-document resource caps (audit M-1/M-2/M-3, 2026-06-13)

A user can import an attacker-crafted file. The ingestion pipeline now bounds the work
**before** a parser touches the bytes, so a crafted document fails the one document instead of
OOMing or hanging the main process. The caps live in `services/ingestion/limits.ts` and are
generous (a legitimate large recording/scan still imports) and env-overridable:

- **Byte ceiling** (`HILBERTRAUM_MAX_DOC_BYTES`, default 1 GiB) — checked in `processDocument`
  against the queued `size_bytes` (cheap, before any copy/decrypt) AND against a `statSync` of the
  resolved parse source (covers a decrypted transient / an unknown queue-time size).
- **Parse wall-clock timeout** (`HILBERTRAUM_PARSE_TIMEOUT_MS`, default 30 min) around
  `parser.parse` — a backstop for a wedged parser. **Audio is exempt**: a long recording
  legitimately transcribes for many minutes and the whisper child manages its own lifecycle.
- **PDF page cap** (`HILBERTRAUM_PDF_MAX_PAGES`, default 5 000) — a tiny PDF can declare an
  enormous page count; the text loop walks at most this many pages and logs the truncation.
- **DOCX inflated-size ceiling** (`HILBERTRAUM_DOCX_MAX_INFLATED_BYTES`, default 1 GiB) — sums the
  zip central-directory declared uncompressed sizes and refuses a zip bomb before mammoth/JSZip
  inflates it. (Declared sizes can be spoofed; the byte cap + timeout remain the backstop.)

A rejection surfaces as the friendly, persist-canonical `main.ingest.fileTooLarge` /
`main.ingest.parseTimeout` on the document row (display-mapped at render, like the other ingestion
failures). The downstream `maxChunks` cap still applies after parsing.

## Skill-import defences — the safe extractor (skills plan §9.2 / §22-A2, Phase S4, 2026-06-17)

A user-imported skill `.skill.zip` (or folder) is **attacker-supplied and unsigned**, and — unlike
the original encrypted-blob design — it is now unzipped **straight into a plain on-disk folder**
under `<root>/user-skills/<id>/` (revised plan §0). So the importer cannot lean on any existing
machinery: the only other archive→disk path in the app is the validation-blind shell-tar extractor
used for runtime downloads, whose safety rests on the archive being **SHA-verified against an
app-controlled source list first** — the opposite trust model. A `.skill.zip` must **never** be
routed through it (asserted by a test that greps the installer source). (That extractor now also
resolves `tar` to an **absolute** OS path — see "Engine extraction pins an absolute `tar`" below — so
a `tar.exe` planted in the process CWD cannot hijack the interpreter.)

`services/skills/installer.ts` therefore ships a **net-new, dependency-free, member-by-member
extractor** built on Node's built-in `node:zlib` + a hand-rolled zip central-directory parser (the
same style as `ingestion/limits.ts` `declaredZipInflatedSize`). It reads the **central directory
first** and validates every member **before inflating a byte**, then validates the whole tree in a
staging dir and only places it on a clean pass. Each defence:

- **Path traversal / absolute / drive-letter / UNC** — every member name is normalized to forward
  slashes and rejected if it contains `..`/`.`, is absolute, or carries a drive letter; after the
  final `join` the resolved path must still sit inside the target (belt-and-braces).
- **NUL / control-character member names (SEC-N1, full audit 2026-06-28).** `safeRelPath` also rejects
  a member name containing a NUL (`\u0000`) with the fixed structural `invalidPath` reason, **before any
  write**. A NUL passes the `..`/drive/depth checks but makes the path invalid for the OS, so
  `writeFileSync` would throw `ERR_INVALID_ARG_VALUE` whose **raw message embeds the attacker-controlled
  path** — which `previewSkillPackage` (its materialize step had a `try/finally` with no catch, and the
  preview IPC handler none) would have serialized to the renderer, breaking both its documented "never
  throws / returns `ok:false`" contract and the §22-M1 content-free posture. As defence in depth,
  `previewSkillPackage` now also wraps its materialize/validate body in a catch that maps **any** residual
  throw to a fixed structural reason; `importSkill` was already protected by its IPC `try/catch`. The
  §22-M1 sentinel-grep test pushes a NUL-bearing member name through preview and asserts the path/sentinel
  never appears in the payload (teeth: neuter the `safeRelPath` check → the code falls to the generic
  `unreadableZip`; neuter both layers → preview throws the raw error).
- **Symlink rejection** — a member whose UNIX mode word (zip external attributes) is `S_IFLNK` is
  refused outright (no "safe handling" in v1); the placed tree is re-walked with `lstat` afterwards
  so no symlink can survive.
- **Zip-bomb — two layers.** A cheap early reject sums the central-directory **declared**
  uncompressed sizes against `HILBERTRAUM_SKILL_MAX_TOTAL_BYTES`; the **authoritative** backstop is
  `zlib.inflateRawSync(member, { maxOutputLength })`, which aborts the moment a member's **actual**
  inflated output exceeds `HILBERTRAUM_SKILL_MAX_FILE_BYTES` — a lying declared size cannot get
  past it. Only STORE and DEFLATE are accepted; encrypted/ZIP64 archives are refused.
- **Inflate-input bound (DoS, audit S-1, Phase 8).** The output cap above bounds what inflate
  *produces*, but the compressed slice handed to the synchronous `inflateRawSync` could still be as
  large as the ~8 MiB total cap (the cheap pre-check only sums the *spoofable* `uncompressedSize`),
  so a crafted member could stall the main thread inflating it. `inflateEntry` therefore rejects any
  member whose central-directory **`compressedSize` exceeds the per-file cap** *before* it slices or
  inflates — bounding the inflate **input** for both STORE and DEFLATE (a legitimate text member never
  compresses past the cap). Impact was always bounded (import is a user action), so this is a DoS-only
  hardening, not an escape.
- **Duplicate stripped-path collision (audit S-2, Phase 8).** A `.skill.zip` may wrap its files under
  one shared top-level folder, which the importer strips; that stripped path was not otherwise
  re-validated, and two distinct central-directory members (e.g. a duplicate name) could collapse to
  the **same** `relPath`, where the final `writeFileSync` is last-writer-wins — so a later duplicate
  could silently shadow a `SKILL.md` the preview already validated. The stager now **re-asserts
  `safeRelPath` on the stripped path** (belt-and-braces) and **rejects a colliding `relPath`** with the
  structural `duplicatePath` reason, so the materialized tree is one-write-per-path.
- **Nested-archive sniff (E2)** — every inflated member's leading bytes are checked against archive
  signatures (zip `PK`, gzip, xz, zstd, tar `ustar`), so a zip renamed `data.csv` is rejected even
  though its extension is allowlisted.
- **Extension allowlist (§6.3)** — `.md`/`.txt`/`.json`/`.csv` only.
- **§6.4 caps** — six resource ceilings, all env-overridable (`services/skills/limits.ts`),
  mirroring the malicious-document caps above and named here in full (DOC-N1, full audit 2026-06-28):
  per-file (`HILBERTRAUM_SKILL_MAX_FILE_BYTES`, default 1 MiB), total-uncompressed
  (`HILBERTRAUM_SKILL_MAX_TOTAL_BYTES`, default 8 MiB), file-count (`HILBERTRAUM_SKILL_MAX_FILES`,
  default 200), path-length (`HILBERTRAUM_SKILL_MAX_PATH_LEN`, default 255), folder-depth
  (`HILBERTRAUM_SKILL_MAX_DEPTH`, default 4), and SKILL.md body length
  (`HILBERTRAUM_SKILL_MAX_BODY`, default 64 KiB).

Every rejection is a **fixed, structural English string** (`SKILL_IMPORT_ERRORS`) — it never
interpolates a member path, file name, or body text, so a malicious package can never echo its
content into an IPC error payload, the audit log, or `app.log` (the content-class rule, §22-M1;
proven by a sentinel-grep test). A failed/partial import **deletes** the staging dir and persists
nothing — a plain cleanup, not a shred (nothing is secret under revised §0). Placement into
`user-skills/<id>/` is **atomic**: the staging dir is a `mkdtemp` on the same filesystem, so the
importer moves any existing install aside to a `.skill-backup-<id>` dir, `renameSync`es staging into
place, then drops the backup — restoring the backup if the rename fails — so a mid-place error can
never leave the user with neither the old nor a valid new skill (the earlier `rmSync` + `cpSync`
could). Export writes the
package tree (SKILL.md + `examples/schemas/prompts/resources`, never the `manifest.json` cache or
run history) as a minimal STORE-method zip built the same dependency-free way. **App-shipped skills
are read-only and cannot be deleted or overwritten** (the built-in-collection precedent); the
residual that a hash manifest on a writable drive is unanchored (real integrity = off-drive
signing) is the same one already accepted for the engine binary (§22-M2).

**Accepted residual (EOCD-first-match, audit S-3-adjacent, Phase 8).** The central-directory locator
scans backward for the first End-Of-Central-Directory record and uses it — a classic
**parser-differential** vs a stock `unzip` (a crafted archive could embed a second EOCD that a
different tool would prefer). This is **hardening-only, not an escape**: every member that the chosen
EOCD's central directory enumerates is still fully path-/symlink-/extension-/size-validated and
re-checked against its local header, so a divergent reading cannot smuggle an unvalidated file onto
disk. A `cdOffset+size` self-consistency check was considered and **deliberately not built** — it buys
no security over the existing per-member validation. Documented and accepted, not papered over.

### App-skill provisioning + the accepted integrity residual (skills plan §22-M2, Phase S9, 2026-06-17)

App-shipped skills are **non-secret, read-only product content**, committed to the repo under
`app-skills/` (text only — `SKILL.md` + JSON schemas + Markdown examples) and **copied wholesale onto
the drive by `prepare-drive`**, exactly like `model-manifests/` (no network — DS17). On a sold drive
the commercial gate (`assertCommercialDrive` + the native cross-check in
`build-commercial-drive.{ps1,sh}`) **requires at least one app skill present** (a folder with a
`SKILL.md`) and **asserts `user-skills/` is empty** — a sellable drive ships only trusted product
skills, the "ships empty / no user data" rule extended to the plaintext skills area.

**Accepted residual (§22-M2, resolved 2026-06-17 as *accept + document*).** A skill's
`trusted_level: app` is assigned by **disk location** (it sits in `app-skills/`), not by a signature.
On a removable drive `app-skills/` is writable, so "verified" means *build-time provisioning*, not a
runtime hash check — an attacker with physical write access to the drive could alter a shipped skill,
exactly as they could alter the engine binary or any on-drive asset. A hash manifest stored on the
same writable drive would be **unanchored** (the attacker rewrites it too), so it buys nothing; real
integrity needs **off-drive signing**, a Tier-3 prerequisite not in scope. This is the **same residual
already accepted for the engine binary and the on-drive sidecars** — documented here and in
`known-limitations.md`, not papered over. The blast radius is bounded: a tampered instruction skill is
still only injected reference text behind the prompt-injection guard — it cannot run code, reach the
network, read other files, or widen document scope (the structural ceilings, §14).

## Skill tool ceiling (Tier-2) — the SkillToolContext + validate→run→validate gate (skills plan §12/§14, Phases S10–S11b, 2026-06-17)

Tier-2 is where a skill can finally *do* something beyond inject text — so S10 builds the **gate
before the tools**. A skill still cannot register a tool: tools live only in the app's static
`services/skills/tool-registry.ts` map, and a skill merely *declares* names via `allowedTools`. The
effective set is the three-way intersection `declared ∩ registry ∩ userGrant` — a name the registry
doesn't know, or the user hasn't granted, is dropped. Runs are **app-orchestrated** (DS4/§2): the
model never parses `tool_calls`; the app invokes `runSkillTool` and the model only *explains* the
validated, structured result.

The containment is **structural, not policy** — it rests on what the tool's context does and does not
expose:

- **No raw handle.** `SkillToolContext` carries a fixed read-only `documentIds` scope, an
  `AbortSignal`, an optional progress callback, and an **ids/counts-only audit sink**. There is
  **deliberately no `Db`/SQL handle, no filesystem handle, and no network handle** — and the
  `ToolPermission` enum has **no `read_arbitrary_fs`, `network`, or `raw_sql` token**, so those
  capabilities are unreachable by construction, not merely undeclared. This closes the
  confused-deputy / model-over-reach rows of §14.
- **Fixed, un-widenable scope.** The gate hands the tool a **frozen** copy of `documentIds`, so a tool
  (or a model coaxing one) cannot reach beyond the documents the user selected for the turn.
- **Validate → run → validate.** Input is checked against the tool's `inputSchema` **before** `run`
  and refused without ever calling the tool on a bad shape; output is checked against `outputSchema`
  **after**, and a wrong shape **fails the run** so no half-trusted output reaches the model. (The
  validator is a hand-rolled JSON-Schema subset — no validator dependency, CLAUDE.md §0.)
- **Confirm for writes.** Any tool whose permissions include a write/export/destructive token
  (`toolRequiresConfirmation`) is refused unless the call carries `confirmed:true`; read-only tools
  (`read-selected-docs`) run without a per-call prompt.
- **Cancellable, no partial persist.** An already-aborted signal refuses the run; a thrown/aborted/
  rejected run yields a **friendly, content-free** error (the technical reason to the local log only)
  and persists nothing.
- **ids/counts-only audit.** `skill_run_started`/`done`/`failed` carry `{skillId, toolName,
  documentCount}` only — never inputs, outputs, member names, or document/chat content (§22-M1, proven
  by a sentinel-grep test pushing a secret string through a successful run).

S10 shipped the gate with **one harmless reference tool** (`count_selected_documents`). **S11a** adds
the first real tool, the content reach it needs, and the run/data tables — without widening the ceiling:

- **The only content reach is `readDocumentChunks`.** S11a adds one scope-bounded method to
  `SkillToolContext`: `readDocumentChunks(documentId) → {text, page, index}[]`, the page-addressable
  chunks of a document **in the frozen scope** (an out-of-scope id returns `[]`). It is supplied by the
  app's run seam as a closure over a narrow per-document SELECT — still **no raw `Db`/SQL/FS/net
  handle**. `extract_transactions` (read-only) is the first consumer; the bank parsing lives in
  `services/skills/tools/bank-statement.ts`, kept out of the generic registry (§13).
- **Run history + bank data are content-class and never leave the encrypted DB.** The `skill_runs`
  table records the app-orchestrated run lifecycle with **ids/refs only** (`document_ids_json` is ids,
  `result_ref` is a `bank_statements.id`, `error` is a friendly/technical reason — never content). The
  extracted figures land in `bank_statements` + `bank_transactions`, which are **content-class**: they
  live only in the encrypted workspace DB, are never logged/audited (audit stays ids/counts — the
  sentinel-grep test proves a secret in a transaction description never reaches audit/log/`skill_runs`),
  and are **excluded from every export** (§9.5). This is distinct from the non-secret skill packages
  (DS20): a transaction row is as sensitive as a document; the SKILL.md is not.
- **App-orchestrated, no-partial-persist.** `services/skills/run.ts` (`runBankExtraction`) is triggered
  by a user action (DS4 — never model `tool_calls`); persistence is atomic (`BEGIN…COMMIT`, ROLLBACK on
  any write error) so a failed run leaves no partial rows.

**The run trigger + IPC add no content to the log (S11b).** The four `skills:*` tool-run channels
(`listRunnableTools` / `startSkillRun` / `getSkillRun` / `cancelSkillRun`) all `requireUnlocked` and
carry **no content**: the renderer passes a `skillInstallId` + `toolName` + `conversationId` (the scope
is resolved main-side, §22-C4 — the renderer never assembles document ids), and every response is
**ids/counts only** (`RunnableTool` = name + a confirm flag; `SkillRunState` = state/progress/counts —
never the extracted rows). The handlers log nothing (the question/scope/figures are content); the only
record is the existing gate audit (`skill_run_*`, ids/counts), proven by the S11b "logs nothing"
sentinel test. The generic `SkillRunController` never touches content (the bank seam runs behind an
opaque runner — §13). **Read-only tools (`extract_transactions`) run without a per-call prompt but are
surfaced (the busy row); write/export tools are confirm-gated** (`toolRunNeedsConfirmation`, registry-
driven) before any run starts — the gate also enforces it defensively.

**S11c — the full bank tool set, the FS-write boundary, and the `kind:'tool'` flip.** Four more tools
ship behind the unchanged ceiling: `validate_statement_balances`, `categorize_transactions`,
`summarize_cashflow` (all read-only, no per-call prompt) and `export_transactions_csv` (confirm-gated).
They operate on the **already-extracted rows**, which the seam loads (the latest statement for the
in-scope document) and passes as **structured input** — so the `SkillToolContext` gains **no new accessor**
and the §14 ceiling is exactly as before (no raw `Db`/SQL/FS/net handle in a tool). The S11c data tables
(`bank_categories`, `bank_category_rules`, `bank_corrections`, + `bank_transactions.category_id/reconciled/
confidence`) are **content-class**: encrypted DB only, never logged/audited, never exported (§9.5).
- **The CSV export is the first real FS-write from a skill tool — kept main-side and off every log.** The
  pure tool only *produces* the CSV string (validated against its `outputSchema`); the **seam** does the
  write, via a main-side `dialog.showSaveDialog` + `writeFile` to a **user-chosen path** — the deliberate
  user-export-of-content precedent (`exportConversation`/`exportSkill`). There is **no FS handle in the
  `SkillToolContext`**; the save capability is injected into the dispatch as an opaque `saveTextFile`. It is
  gated twice: the `export-file` permission ⇒ the renderer's confirm modal ⇒ `confirmed: true` ⇒ the gate
  runs the tool. **The chosen path and the CSV content are NEVER logged or audited** — only "saved N rows"
  (a count) is surfaced; a cancelled save persists nothing. The sentinel-grep test pushes a secret through
  a successful export and proves it lands in the user-chosen CSV (correct) + the content-class tables but
  **never** the audit/log/`skill_runs` row/IPC `SkillRunState` payload.
  - **Spreadsheet formula-injection is neutralized at the write boundary (S12 audit, F4).** The CSV
    carries the user's own extracted statement text, but a crafted document could embed a cell that
    begins with a formula trigger (`= + - @`, tab, CR) and execute when opened in Excel/Sheets/
    LibreOffice. `transactionsToCsv` prefixes any such free-text field with a single quote so the cell
    reads as text; numeric columns (amount/balance) are formatted separately and never neutralized.
- **The `kind:'tool'` flip makes `allowedTools` effective.** The bank `SKILL.md` is now `kind:'tool'`, so
  the S2 parser keeps its declared tool list (an instruction skill's stays `[]` — SL-1); the run dispatch
  retargets to `resolveEffectiveTools(allowedTools ∩ registry ∩ grant)`. The skill still **cannot register
  or self-grant** a tool — the registry is app-owned and the effective set only ever shrinks.

**The invoice domain — a SECOND Tier-2 content class behind the SAME ceiling.** The bundled `invoice`
skill (`kind:'tool'`) registers three tools (`extract_invoice` read-only, `validate_invoice_totals`
read-only, `export_invoice_csv` confirm-gated) that mirror the bank tools exactly. The ceiling is
unchanged: the tools are pure main-side TS (no `Db`/SQL/FS/net handle), the extractor's only content reach
is `readDocumentChunks` over the frozen scope, the downstream tools take the already-extracted invoice as
**structured input** (no new `SkillToolContext` accessor), persistence is atomic in the
`invoice-run.ts` seam (ROLLBACK ⇒ no partial rows), and the CSV export is the same user-chosen,
formula-injection-neutralized FS-write boundary (the neutralization is now the **shared** `csvField` in
`tools/money.ts`, used by both domains). The new content-class tables `invoices` + `invoice_line_items`
hold the real figures (vendor, line items, totals): **encrypted DB only, never logged/audited, never
exported** (§9.5) — `skill_runs.result_ref` points at an `invoices.id`, never inline content. The
consolidated `skills-privacy-guard.test.ts` drives one secret through the invoice extract→validate→export
pipeline + a console spy and proves it lands ONLY in the `invoice_*` tables and the user-chosen CSV, never
in the audit/log/console/`skill_runs` row.

**S12 — the closing multi-persona audit of the whole skills surface (2026-06-17).** The repo's audit
ritual ran end to end against the untrusted-skill-as-input threat principle (§14): import (zip-slip /
symlink / zip-bomb / nested-archive / magic-byte), prompt-injection containment (the fenced data turn,
the guard line winning, base + grounding always winning), the Tier-2 gate (frozen `documentIds`, no
`Db`/SQL/FS/net handle, input+output validation, confirm-gating for write/export, the CSV FS-write
boundary), content-class isolation (`bank_*` + `skill_runs` never logged/audited/exported), ids/counts-
only audit, and `requireUnlocked` on every DB-backed channel. **No CRITICAL/HIGH.** One LOW was fixed
(the CSV formula-injection above); the scattered S10/S11 sentinel tests were consolidated into a single
`skills-privacy-guard.test.ts` that drives one secret through every sink (import error, loader, all five
tool runs, the CSV export, the IPC `SkillRunState`) **plus a console spy** and proves absence in
audit/log/console/run-metadata while confirming the deliberate exceptions (content-class tables + the
user-chosen CSV). Two LOW residuals were accepted + documented in
[`known-limitations.md`](known-limitations.md): prompt text-injection is contained by the structural
ceiling (not by escaping the fence delimiter), and a user skill's `triggers.filenamePatterns` are compiled
to a bounded RegExp run only on a user action (no auto-fire). The §14 **unchanged guarantees** held — CSP,
the deny-by-default permission handler, the offline guard, the encryption posture, and packaging were not
touched.

**Post-S12 audit follow-ups (2026-06-17).** A second multi-persona audit found **no CRITICAL/HIGH**; the
hardening landed behind this same ceiling (full record: architecture.md "Skills — design record" §13).
Security-relevant items: **(S1)** the import-preview clamp/`manifest.json`-conflict **notes** no longer
echo the raw frontmatter value — closing the one §22-M1 gap where attacker text could ride the
`SkillPreview` IPC payload into the UI (the structural *errors* were already clean); **(S2)** the
`filenamePatterns` residual above is now actively bounded — the parser caps each entry's length (≤200)
and count (≤64) and the glob is matched by a **linear, non-backtracking two-pointer matcher**
(`selector.globMatches`), so backtracking is structurally impossible regardless of input. (S12
originally compiled the glob to a bounded RegExp with a >10-`*` wildcard cap; **vuln-scan 2026-06-21
replaced that compile with the linear matcher** — see the parsing-DoS section below.) The B1/B2 cancel-semantics and I1/I2
localization fixes added no content to any log/audit and no new capability.

**SEC-1 (backend-audit 2026-06-27, Phase 6) — Tier-2 tools run for APP skills only; the trust
decision is now explicit.** The `kind:'tool'` flip above made a declared `allowedTools` *effective*
for any non-instruction skill, and the run/runnable surface gated on enabled/compatibility/confirm but
**never on `source`** — while `resolveEffectiveTools(declared, declared)` collapsed the "user grant"
to "whatever the package declared." So a user could import a `.skill.zip` with
`kind: tool` + `allowedTools: [extract_transactions, redact_document, export_transactions_csv, …]`,
enable it, and drive the bank/invoice/redaction machinery over their own documents. The blast radius
**is** structurally bounded (the §14 ceiling: no `Db`/SQL/FS/net handle, a single frozen-scope
document, writes/exports confirm-gated to a user-chosen path), so this was **not** a privilege escape
— but the trust posture was *incidental*, not deliberate (DOC-5).

The deliberate posture, now enforced and tested: **only built-in `source === 'app'` skills may run
the wired Tier-2 tools.** A user-imported `kind:'tool'` skill may still **declare** `allowedTools`
(the S2 parser keeps them; the import warning surfaces "reserves tools") — kept for a future
**per-tool user-grant UI** — but it runs **none** of them until that UI exists. The gate is a single
named predicate `skillCanRunTools(skill)` (`source === 'app'`; the registry assigns trust from the
folder, so a self-declared frontmatter `trust` is irrelevant), applied at the **runnable-tools choke
point** `runnableToolNames` — so `listRunnableTools` and the run bar offer a user tool skill nothing —
and again, defense-in-depth, at `startSkillRun` so a **forged IPC call** carrying a user skill's id is
refused before anything runs. The refusal reuses the generic, **content-free** `run.unavailable`
string (no skill title/id/path interpolated), so nothing content-bearing is surfaced or logged (the
§22-M1 ids/counts-only posture holds; the privacy sentinel-grep stays green). App skills are
completely unaffected. The gate is **not** at parse time: a user skill keeps its declared `allowedTools`
so the future grant UI can reason about what it asked for. Pinned by `skills-tool-run-ipc.test.ts`
(user tool skill ⇒ `runnableToolNames`/`listRunnableTools` `[]`, `startSkillRun` refused + nothing
audited; an app skill with the same tools unchanged — teeth-verified by flipping the gate).

> **§-anchor note.** This section cites the original skills-plan's section numbers (`§12`, `§14`,
> `§9.5`, `§13`, `§22-*`); those were not renumbered into the design record's §1–§12. The
> **§-anchor legend** at the end of architecture.md "Skills — design record" maps each to where it now
> lives, so the references stay resolvable.

## Unverified-binary env overrides are dev-only (audit M-5, 2026-06-13)

`HILBERTRAUM_LLAMA_BIN` and `HILBERTRAUM_WHISPER_BIN` point the sidecar resolvers at an explicit,
**unverified** binary. They are a dev affordance and are now honoured **only in a dev build**:
`resolveLlamaServerPath` / `resolveWhisperCliPath` take an `{ isDev }` option (default `false` =
ignore + log), and `isDev` is threaded through the runtime / embedder / reranker / transcriber
factories and the benchmark probe. In a packaged build the override is ignored and resolution falls
back to the on-drive `runtime/<family>/<os>/` location, so process environment alone cannot make the
app spawn an arbitrary binary. (The on-drive sidecar is now **re-hashed before spawn** in packaged
builds — see "Re-hash sidecar binaries before spawn" below; the dev-only env overrides are deliberately
NOT hash-gated, since they point at an explicitly unverified path.)

## Parsing-DoS hardening — the content tools' regexes are now linear (vuln-scan 2026-06-21)

The #1 attacker goal in this app's threat model is **resource exhaustion while parsing a hostile
document** (or an enabled, attacker-authored `.skill.zip`). A vuln scan found three regexes that
backtracked **super-linearly** on adversarial input and ran **synchronously on the main process**, so
a single crafted document/skill could freeze the whole app. All three were made **provably linear** by
bounding their quantifiers (the accepted token set is unchanged for every realistic input; the unit
suites pin the parse behaviour, and each carries a 200k-char "returns in < 1 s" regression test):

- **`skills/tools/money.ts` `MONEY_RE`** (shared by the bank-statement + invoice extractors) — the
  unbounded `\s*\d[\d.,]*` backtracked O(N²) on a long digit/separator run with no decimal tail. Now
  `\s{0,4}\d[\d.,]{0,30}[.,]\d{2}` — a 30-char integer/grouping bound is ~10²³, far beyond any printed
  amount, so each match attempt is O(1) and the global scan is O(N).
- **`skills/tools/redaction.ts` `EMAIL_RE`** — the unbounded local-part/domain runs backtracked O(N²)
  on a long `a.a.a.…` string (no `@`). Now length-bounded to the RFC limits (local ≤ 64, domain ≤ 255).
- **`skills/selector.ts`** — the glob→RegExp compile is replaced by a **linear two-pointer matcher**
  (see the known-limitations note); a `*?*?…` trigger pattern can no longer backtrack.

These are DoS (polynomial, never RCE) and are local-only, but the project treats main-process freezes
from hostile content as in-scope, so the hardening is principled (linearize the algorithm) rather than
a length cap that would silently drop legitimate content.

## Engine extraction pins an absolute `tar` (vuln-scan 2026-06-21)

The in-app engine installer's default extractor used `spawn('tar', …)` with a **bare** command name.
On Windows, libuv resolves a separator-less command against the process **current directory before**
System32/PATH, so a `tar.exe` planted in an attacker-influenced CWD (plausible for a portable-drive
app) would execute in our place with the main process's privileges on an engine install — and the
archive SHA-256 protects the *contents*, not the *interpreter*. `runtime-download.ts` now resolves
`tar` to its **absolute OS location** (`%SystemRoot%\System32\tar.exe`, `/usr/bin/tar`, `/bin/tar`)
via `resolveTarBinary`, falling back to the bare name only when none exist (an exotic host), and spawns
with a controlled `cwd`. Mirrors the absolute-path discipline already used for the sidecar spawns.

## Hostile model manifests can't break the whole Models list (vuln-scan 2026-06-21)

`model-manifests/` is user-writable (the threat model's #1 attacker surface). A manifest with an
escaping `local_path` (e.g. `../../../../etc/passwd`) passed `validateManifest` (which only checked
non-empty) and was caught later by `safeDrivePath`'s **throw** — but that throw was unhandled on the
`IPC.listModels` path, so **one** bad manifest errored the entire Models screen. Two defenses now:
**(1)** `validateManifest` rejects any `local_path`/`mmproj.local_path` that is absolute (leading `/`,
a `C:`-style drive letter, a UNC root) or contains a `..` segment, so `discoverManifests` records it in
`errors` and **skips** it (the rest of the list still renders); **(2)** `buildModelList`'s per-manifest
loop wraps `computeInstallState` in try/catch, so any manifest that still throws becomes an errored
entry rather than failing the whole list — mirroring the existing `pendingHashBytes` pre-pass.
`weightPath`/`safeDrivePath` keep their own runtime escape guard (defense in depth).

## Least-privilege hardening of the renderer↔main file/network seams (vuln-scan 2026-06-21, option D)

The renderer is the **untrusted** boundary (M-S2) and threat #1 is a hostile imported doc/skill
achieving code-exec in the context-isolated renderer. Four main-side IPC seams trusted renderer
input more than that model allows; all four are now tightened (`registerDocsIpc.ts`,
`registerImagesIpc.ts`, `services/assets.ts`, `services/vision/limits.ts`).

### D1 — `importDocuments` is bound to a picker capability token (not raw renderer paths)
`importDocuments(paths)` accepted arbitrary renderer-controlled absolute paths and `expandPaths`
did no base-dir containment, so a code-exec'd renderer could use main as a **confused deputy** to
read any supported-type file anywhere on disk (the text is then reachable via
`previewDocument`/`exportDocument`/RAG). The OS picker is owned by **main**, so:
- `pickDocuments` mints a **one-time token** per dialog (`randomUUID`, a bounded map, single-use)
  bound to the exact paths it returned, and returns `{ token, paths }` (paths are renderer
  **display/preflight only**).
- A PICKER import passes `options.pickerToken`; main **resolves+consumes** it to those exact paths
  and **ignores** the renderer-supplied `paths`. A forged/replayed/unknown token imports nothing.
- **Drag-drop residual (documented, accepted):** a native OS drop is delivered to the *renderer*,
  so main cannot mint a token for it. That seam still passes raw paths but is now **hardened** —
  each top-level path is `lstat`-checked and a **symlink is rejected**, then `realpathSync`-
  canonicalized (a `.pdf`-named symlink can't reach a sensitive target through the importer). A
  compromised renderer can still drive this seam with on-disk paths, but the offline guarantee
  means there is **no network sink to exfiltrate** read content, and the dominant picker surface is
  now non-forgeable. `importPreflight` still takes raw paths (counts/sizes only — lower impact).

### D2 — `imageReadBytes` takes an opaque token, never a renderer path
`imageChooseImage` now returns `{ token, name, sizeBytes }` — the absolute path stays in main,
keyed by a one-time bounded token. `imageReadBytes(token)` resolves+consumes it and reads with an
**open→fstat→read on the same fd** (the byte cap is authoritative for those exact bytes — closes
the prior `stat`→`read` TOCTOU). A renderer can no longer name a path, so the `.png`-named-symlink /
arbitrary-read confused-deputy vector is gone. (Drag-drop decodes the `File` in the renderer and
never calls this.)

### D3 — `downloadToFile` re-validates every redirect hop + caps the body
TLS was enforced only on the **initial** URL; `fetch` then followed redirects automatically, so a
30x from a compromised/hostile origin could **SSRF to a LAN/loopback host** (e.g.
`http://169.254.169.254/…`) or **downgrade to cleartext http**, and there was no streamed-size cap
(disk-fill). Now redirects are `redirect: 'manual'` and each hop (initial + every `Location`) is
re-checked by `assertSafeDownloadUrl`: **https-only** *and* a **loopback/private-range deny**
(127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `localhost`, IPv6 `::1`/`fe80:`/`fc`/`fd`), with a
**max-redirect** cap. The body is rejected once it exceeds the smallest of {`Content-Length`,
caller `maxBytes`} + margin, with a global backstop when neither is known. All callers (model
weights, runtime sidecar, OCR files) get this for free because they share the seam.

**F15 (audit-postmerge-2026-06-29) — IPv4-mapped IPv6 closed.** The deny-list classifier
(`isPrivateOrLoopbackHost`) matched the mapped form only in its **dotted-decimal** spelling
(`::ffff:127.0.0.1`), but `new URL()` **canonicalizes** the literal to the hex-compressed form
(`[::ffff:127.0.0.1]` → host `::ffff:7f00:1`, `[::ffff:169.254.169.254]` → `::ffff:a9fe:a9fe`), which
matched neither the dotted regex nor the `::1`/`fe80:`/`fc`/`fd` checks — so mapped loopback, RFC-1918,
and the `169.254.169.254` cloud-metadata address **slipped the deny-list** (reachable via a hostile
model-manifest `download.url` or a redirect `Location:`). The classifier now **denies any host
containing `::ffff:`** (no legitimate download target uses a mapped-IPv6 literal), robust against
every canonicalization the parser emits. (The detection-only `offlineGuard.isLoopbackHost` is
deliberately left as-is — it gates no enforcement decision, so an under-match there only ever costs an
audit line.)

**F17 (audit-postmerge-2026-06-29) — size cap always bounded.** The backstop was the disk-fill
escape hatch: the **engine** downloader passed **no** `maxBytes`, and the **model** downloader passed
one only when the manifest carried `size_bytes`, so a redirected / `Content-Length`-less endpoint
collapsed the cap to the 64 GiB backstop (a disk-fill nuisance on small USB drives; the bytes fail
SHA verify afterwards). Now **both downloaders always pass a bounded cap**: the engine path passes a
per-family ceiling (`ENGINE_DOWNLOAD_MAX_BYTES` = 2 GiB — engine archives are tens-to-low-hundreds of
MB), and the model path passes the manifest's exact `size_bytes` when known, else a bounded **per-role
default** (`modelWeightMaxBytes`: chat/vision 40 GiB, transcriber 8 GiB, embeddings/reranker 4 GiB).
The backstop itself was lowered 64 → 48 GiB and is now unreachable from production (defence-in-depth
for a future caller). Residual: the cap is a disk-fill bound, not an integrity control — wrong bytes
are still caught by the post-download SHA verify; and the DIY `fetch-*` scripts use the OS-native
downloader (curl), not this seam.

### D4 — the authoritative vision guard now bounds decoded pixels, not just bytes
`validateAnalyzeRequest` (SEC-3) capped bytes but not decoded dimensions, and `runtime.ts` inlines
the **original** bytes to the sidecar — so a small (<20 MiB) **decompression bomb** PNG/JPEG that
decodes to billions of pixels passed the guard and OOM'd the sidecar. The renderer's `MAX_DIMENSION`
downscale is display-only and doesn't bound what the sidecar decodes. The main guard now parses the
image **header** (PNG IHDR / JPEG SOF) for `width*height` — no full decode — and rejects above a
**pixel budget** (`VISION_MAX_IMAGE_PIXELS`, ~50 MP default, env-overridable via
`HILBERTRAUM_MAX_IMAGE_PIXELS`) as `tooLarge`. This sits alongside the **byte cap** that bounds the
raw input before any decode (`VISION_MAX_IMAGE_BYTES`, ~20 MiB default, env-overridable via
`HILBERTRAUM_MAX_IMAGE_BYTES`; named here per DOC-N1, full audit 2026-06-28 — only the sibling
pixel cap was documented before).

**SEC-6 (backend-audit-2026-06-27) — a `null` pixel count for a claimed png/jpeg is now rejected.**
`validateAnalyzeRequest` previously let an *unknown* pixel count fall through to the byte cap. But the
MIME is already known to be png/jpeg at that point, so a `null` from `decodedPixelCount` means a
**claimed** png/jpeg whose header won't parse — malformed or forged bytes that silently disabled the D4
pixel-bomb guard. It is now treated as undecodable (`decodeFailed`) and rejected before its bytes reach
the sidecar. (`decodedPixelCount` still returns `null` for a genuinely unknown MIME; that path is
unreachable from `validateAnalyzeRequest`, which validates the MIME to png/jpeg first.)

### Accepted residual — `imageAnalyze` raw bytes are not bound to the picker token (SEC-5, backend-audit-2026-06-27)
The picker capability token (D2) protects **path-based** reads: `chooseImage` returns an opaque token and
`imageReadBytes` only reads the file that token names, so a code-exec'd renderer can't make main read an
arbitrary path. But `imageAnalyze` takes `req.imageBytes` **directly** — required for the drag-drop path,
where the renderer reads the dropped `File`'s bytes itself and never touches a path — and validates only
size / MIME / pixels (the D4 + SEC-6 guards above), not provenance. So a renderer running attacker code
(the stated threat) could still submit **arbitrary bytes** for analysis + history persistence. **Accepted,
because the impact is bounded:** the offline posture means those bytes never leave the device; analysis is
local; the answer/image are content-class and never logged/audited (the vision sentinel test enforces
this); and binding picker-sourced analyses to a token would not help the drag-drop case, which is
legitimately raw-bytes. Requiring a token *only* for picker-sourced analyses (so drag-drop alone uses raw
bytes) remains a possible future tightening; the boundary is recorded here rather than changed.

## Re-hash sidecar binaries before spawn (vuln-scan 2026-06-21, item B — design record)

Each sidecar (`llama-server`, `whisper-cli`, the `--list-devices` GPU probe) was SHA-256-verified at
**download/install** time but **not re-hashed immediately before `spawn`**. On a portable offline drive a
local adversary who can overwrite `runtime/<family>/<os>/<bin>` between install and the next launch gets
code-exec at the app's privileges — a TOCTOU deviation from the stated re-hash-before-exec policy. The
spawns are arg-array (no shell), so the only residual was the missing pre-spawn re-verification, now
closed. (The long-tracked audit-2026-06-14 "engine-binary not re-hashed before spawn" is the same item.)

**The fix rests on three facts the deferral called out, each now addressed:**

1. **The install marker records each binary's own SHA-256.** `RuntimeInstallMarker` gained an optional
   `binaries: Record<relPath, sha256>` field (`assets.ts`), keyed by the binary's path **relative to the
   extract dir** with posix `/` separators (`markerBinaryKey`) so a marker written on Windows reads the
   same on another OS. `readRuntimeMarker` parses it **tolerantly** — a malformed map is dropped, and a
   marker with no valid entry deep-equals the historical `{version,backend,os,arch}` so legacy reads are
   unchanged. The hash is recorded by **all three** marker writers: the in-app installer
   (`runtime-download.ts`, hashing `plan.binaryPath` after the flatten — best-effort, a hash failure
   still writes a usable hash-less marker), and the DIY `fetch-runtime.{ps1,sh}` scripts.

2. **One shared, session-cached verifier.** `binary-verifier.ts` exposes
   `verifyBinaryBeforeSpawn(binPath)` → `ok | skip-legacy | skip-dev | mismatch`. It walks **up** from the
   binary's directory to the nearest install marker (so the `cpu/` safety-net binary finds the family
   marker one level above when its own dir has none), looks up the recorded hash for that binary, and
   re-hashes the on-disk bytes. The result is **cached per resolved path for the session** — the GPU probe
   and the server start race for the very same path (`factory.ts` kicks the probe concurrently with the
   start), so both read one consistent decision off a single hash. An unreadable binary fails **safe**
   (`mismatch`).

3. **Non-breaking, fail-safe rollout.** `initBinaryVerification(isDev)` is called once at startup
   (`index.ts`): packaged builds **enforce**, dev builds **skip** (`skip-dev`) — the on-drive binary may
   be a local build and the dev-only `HILBERTRAUM_*_BIN` overrides point at an explicitly unverified path,
   so neither is hash-gated (consistent with audit M-5 above). A binary **with** a recorded hash is
   verified; a binary with **no** recorded hash (a drive provisioned before this shipped) is **tolerated**
   (`skip-legacy`, logged) so it still launches. Before init the verifier is inert, which keeps the
   headless unit suite — which constructs sidecars with fake paths and no marker — unaffected.

**Behaviour at each spawn seam (a `mismatch` only ever fires in a packaged build):**
- **`LlamaServer.start()` (`sidecar.ts`)** — throws before allocating a port/child, so the start **ladder
  falls to the next rung / MockRuntime** with a content-free tamper warning to the local log. This one
  method funnels **every** llama-server spawn (chat runtime, embedder, reranker, vision), so all are
  covered by the single check.
- **`probeGpuDevices()` (`gpu.ts`)** — resolves **`[]`** (reads as "no GPU"); the probe's contract is that
  it never throws, so a tampered binary is simply never executed for enumeration.
- **`WhisperCliTranscriber.run()` (`transcriber/cli.ts`)** — refuses before spawn; the audio import fails
  per-file with the generic failure copy (raw reason to the local log only).

**Commercial sell-gate (`commercial-drive.ts`).** `assertCommercialDrive` now **requires** the marker to
carry the binary's hash and to match the on-disk bytes — a drive provisioned by a `fetch-runtime` that
predates this field, or whose binary was modified after install, **fails the gate** (forcing a rebuild),
so a sold drive always ships re-verifiable binaries.

Logs are content-free (no paths/hashes/secrets). **Residual:** a drive provisioned by a `fetch-runtime`
predating this change has no recorded hash and is tolerated (`skip-legacy`) until rebuilt — trust there
still rests on drive provisioning + filesystem integrity (and an attacker who can write the runtime dir
can usually also tamper the app's own Electron code). See `known-limitations.md`.

**Accepted residual — verification is session-cached by path, not per-spawn (SEC-4, backend-audit-2026-06-27).**
`verifyBinaryBeforeSpawn` memoises its verdict per resolved path **for the whole session**, so only the
*first* spawn of a given binary re-hashes; later model switches / fallback restarts reuse the cached `ok`.
A tamper that lands *after* the first spawn (then a model switch re-spawns the same path) is not
re-detected within that session. This is a **deliberate** trade-off: the GPU probe and the server start
race for the very same path (`factory.ts` kicks the probe concurrently with the start), and the cache is
exactly what makes them read **one consistent decision** off a single hash rather than disagreeing on a
file changing under them. The exposure window is one app session on a drive an adversary can already write
to (who, as above, can usually tamper the app's own Electron code too); a relaunch re-hashes from cold.
Accepted as-is; a future hardening could re-hash on every chat-sidecar spawn if the consistency concern is
otherwise solved.

## Phase-7 security polish (full audit 2026-06-28)

**Benchmark IPC `requireUnlocked` parity (SEC-N2).** `registerBenchmarkIpc`'s `runBenchmark` /
`tryGpuAgain` touch `ctx.db` (via `updateSettings`/`getSettings`) and were *fail-closed* already — the
`ctx.db` getter throws when the workspace is locked — but surfaced the **raw English** "Workspace is
locked — unlock it first." string instead of the friendly localized copy. They now call an explicit
`requireUnlocked()` preamble (the same pattern as every other DB-backed channel), surfacing the
localized `main.benchmark.locked`. A structural lock test (`chat-ipc.test.ts`, TEST-N8) enumerates every
registered DB-touching handler — chat + these benchmark handlers — and asserts each refuses with the
friendly copy (never the raw string) when locked.

**Sidecar `serverMessage` is structural-only — accepted Info residual (SEC-N3).** `ChatRequestError`
(runtime/`llama.ts`) keeps up to 500 chars of a non-JSON error body as `serverMessage`, surfaced via
`chat-stream.ts` and `doctasks/manager.ts`. The sidecar is **our own loopback llama.cpp server** and its
error bodies are upstream-structural (an HTTP status + a reason code/type), never user document/prompt
content, so the tail carries nothing content-bearing. This is **accepted as an Info residual**: the
500-char cap bounds size and a one-line `INVARIANT (SEC-N3)` comment at the cap pins the expectation and
asks for a re-verify on every llama.cpp pin bump; if a future server ever echoed request content into an
error body, the fallback should be sanitized to a fixed structural string + numeric status.

## Out of scope (MVP)
- OS-level firewall enforcement (offline is by design + policy/UX, not a hard network block).
- Multi-user access controls, enterprise admin/policy signing infrastructure, hardware DRM.

## Future improvements
- Sign `policy.json` and verify the signature before honouring it (enterprise edition).
- Optional OS-level network denylist / firewall helper.
- Field-level encryption of sensitive rows in addition to whole-file encryption.
