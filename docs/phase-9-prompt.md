# Phase 9 kickoff prompt — encrypted workspace

> Paste this as the kickoff prompt for the next session. It mirrors the Phase 7/8 handoff style.

---

You are continuing work on the **Private AI Drive Lite** project (an open-source, offline,
local-LLM desktop app) located at `f:\_coding\ai_drive`.

## START BY READING, IN THIS ORDER

1. **`BUILD_STATE.md`** — the live handoff/state file (current status, decisions, data
   contracts, next actions, risks). Source of truth for where we are. Read **§5 (START OF
   PHASE 9)** carefully, the **Settings storage**, **Workspace/paths**, **Core IPC (Phase 1
   live)**, and **Privacy & offline policy (Phase 8 live)** contract sections, and the
   **Decisions log** (especially the Phase-8 policy entries: `WorkspacePolicy`
   `encryptionRequired`/`allowPlaintextDevMode` is **loaded but not yet enforced**, and the
   plaintext-dev-default decision).
2. **`docs/IMPLEMENTATION_PLAN.md`** — read the **Phase 9** section, the **§4b critique**
   (the encryption-tension paragraph: *whole-DB-file encryption-at-rest because `node:sqlite`
   has no SQLCipher; decrypt to a working file on unlock, re-encrypt + shred on lock/quit*), AND
   the **"Per-phase ritual"** (§3).
3. **`CLAUDE.md`** — the hard rules (no cloud, no telemetry, local-only, no hosted AI APIs,
   swappable interfaces per spec §9.2; **no plaintext workspace unless the user explicitly chooses
   it**). Phase 9 delivers the encrypted default that makes the last rule real.
4. **`docs/security-model.md`** — the Phase-8 security baseline + the **Workspace modes** section
   that already sketches the Phase-9 design (Argon2id/scrypt, AES-256-GCM, whole-DB-file encryption,
   password never stored). Phase 9 implements it and fills in the **encryption** detail.
5. **`CLAUDE_Private_AI_Drive_Lite_MVP.md`** — the source of truth for *what* to build:
   - **§3.5 (Security baseline → Encryption plan)** — the exact design: *user chooses workspace
     password → derive key with Argon2id → encrypt workspace database + document cache → never
     store the password → store salt + KDF parameters → lock workspace on app close*. Plus the
     **Data to protect** list.
   - **§7.9 (Workspace manager)** — responsibilities (create/unlock/lock workspace) and the two
     **workspace modes** (`encrypted`, `plaintext_dev`), including the rule that plaintext mode is
     allowed **only** when env/policy/dev permits it; **commercial preconfigured drives default to
     encrypted**.
   - **§7.1 (App shell)** — "show onboarding if first run" + "verify policy"; the unlock/onboarding
     gate belongs here.
   - **§6 drive layout** — `workspace/encrypted/`, `workspace/plaintext-dev/`, `workspace/backups/`.
   - **Milestone 9** (acceptance) + **§15.1** (unit tests: policy parsing, workspace settings) +
     **§14 (`SECURITY.md` / `docs/security-model.md`)**.

## CONTEXT: Phases 0–8 are complete and committed (latest commit `8f458ab` "Phase 8 / Milestone 8: privacy & offline hardening")

- **Phase 8** delivered `services/policy.ts` (deny-by-default policy loader; effective network =
  `policy ∧ setting`), `services/offlineGuard.ts` (startup self-check + loopback-exempt net
  tripwire), the `getPolicy` IPC (`policy:get`) + policy-aware `AppStatus.offlineMode`/
  `networkAllowed`, a strict **dev-vs-prod CSP** response header, and the real `PrivacyScreen`
  (spec §7.10/§18.1). The Phase-8 **`WorkspacePolicy`** block (`encryptionRequired`,
  `allowPlaintextDevMode`) is **loaded + exposed but NOT enforced** — Phase 9 is where it gates the
  workspace mode.
- **All 137 tests pass**; typecheck clean; `NODE_OPTIONS=--use-system-ca npm run build` green (main
  bundle 70.15 kB). No new dependencies. The core path is guarded by a **no-network assertion**
  (spy `http`/`https`/`net`/`net.Socket`/`fetch`) — **reuse this exact pattern** for any Phase-9
  test that touches the workspace lifecycle.

### Things already in place for Phase 9 (do not rebuild)

- **`AppSettings.workspaceMode`** (`'encrypted' | 'plaintext_dev'`, default **`plaintext_dev`**) and
  **`AppSettings.developerMode`** (default **true**) already exist in `DEFAULT_SETTINGS`. The
  Settings screen renders the developer-mode toggle; `PrivacyScreen` already **labels** plaintext
  vs encrypted and warns about plaintext. Phase 9 makes the mode **real + enforced**, it does not
  invent these fields.
- **`services/workspace.ts`** `resolvePaths(...)` already returns `workspacePath`, `configPath`
  (`<root>/config`), and **`dbPath`** (`<root>/workspace/paid.sqlite`). `ensureWorkspaceDirs`
  creates the dirs. This is where the encrypted blob + the decrypted working file live.
- **`services/db.ts`** `openDatabase(path)` opens a `node:sqlite` `DatabaseSync` on a **file path**
  (WAL mode, FKs on) and runs the idempotent spec §8 schema. Its header already says
  *"Encrypted-at-rest mode (Phase 9) wraps this same file/schema."* — encryption wraps the **file**,
  not the rows; the schema is identical in both modes.
- **`services/policy.ts`** `loadPolicy(configDir)` / `buildPolicyStatus(...)` already expose
  `policy.workspace.encryptionRequired` + `policy.workspace.allowPlaintextDevMode`. Phase 9
  **consumes** these to decide whether plaintext mode is permitted (refuse plaintext when policy
  forbids it).
- **`AppContext`** (`services/context.ts`) carries `db`. **`AppStatus.workspaceReady`** exists
  (currently hardcoded `true`) and **`AppStatus.workspaceMode`** is surfaced — Phase 9 makes
  `workspaceReady` reflect the **unlocked** state.
- **`main/index.ts`** `initBackend()` opens the DB + registers IPC at startup, and `will-quit`
  already stops the runtime — the lock-on-quit hook goes here.
- **No-network test pattern** is established in `tests/integration/{rag,benchmark,policy}.test.ts`.
- **No Onboarding/Unlock screen exists yet** (`App.tsx` has home/chat/documents/models/privacy/
  diagnostics/settings) — Phase 9 introduces the first-run/unlock gate UI fresh.

## YOUR TASK: Implement Phase 9 — "Encrypted workspace" (spec Milestone 9)

Follow `BUILD_STATE` §5 and the Phase 9 plan section, in order:

1. **`services/security/crypto.ts` (new) — KDF + AEAD primitives.** Pure, testable, no I/O.
   - **KDF:** derive a 32-byte key from password + salt. Use **Argon2id** if a native `argon2` is
     available; otherwise a **`node:crypto` `scrypt` fallback** (R4 — native argon2 may not build on
     Node 24). Put both behind one interface (`deriveKey(password, salt, params)`) and **record
     which algorithm + parameters were used** so unlock is deterministic. Prefer the built-in
     `scrypt` path first if adding `argon2` risks the install (document the choice either way).
   - **AEAD:** **AES-256-GCM** encrypt/decrypt of a `Buffer` (random 12-byte IV per encryption, auth
     tag stored alongside). `encrypt(key, plaintext) → { iv, tag, ciphertext }`,
     `decrypt(key, blob) → plaintext` (wrong key/tamper → throws, caught upstream as "wrong
     password").
   - Keep it pure + unit-testable: round-trip, **wrong password fails**, **KDF determinism with
     stored params** (same password+salt+params → same key), tamper detection.

2. **`services/workspace-vault.ts` (or extend `workspace.ts`) — the lock/unlock lifecycle.**
   - **Vault descriptor OUTSIDE the encrypted DB.** ⚠️ Settings live **inside** the SQLite DB
     (`settings` table), so the app cannot read `workspaceMode` *before* unlocking. Store a small
     **unencrypted** descriptor (e.g. `workspace/vault.json` or `config/workspace.json`) holding
     `{ mode, kdf: { algo, params }, saltB64, verifier }` — enough to know a password is required,
     which KDF/params to use, and to **verify** the password (a GCM-authenticated known blob; a
     wrong password fails the tag, never decrypts the DB). The password + derived key are **only
     ever in memory**; the descriptor never contains them.
   - **Whole-file encryption-at-rest** (plan §4b, no SQLCipher under `node:sqlite`): the at-rest
     artifact is `paid.sqlite.enc`. On **unlock**, derive the key, verify, **decrypt to the working
     file** `paid.sqlite` **on the drive** (not a temp/cloud dir), then `openDatabase(dbPath)`. On
     **lock/quit**, **close the DB, checkpoint + remove the WAL/SHM sidecars**, re-encrypt the
     working file → `.enc`, then **shred + delete** the plaintext working file (+ `-wal`/`-shm`).
   - ⚠️ **WAL gotcha:** WAL mode creates `paid.sqlite-wal` + `paid.sqlite-shm`. Before encrypting,
     **`PRAGMA wal_checkpoint(TRUNCATE)` + close** so all data is in the main file, and make sure
     the sidecars are flushed/removed — otherwise the encrypted snapshot is stale or you leak
     plaintext in `-wal`.
   - **plaintext_dev mode** keeps today's behavior exactly (open `paid.sqlite` directly, no
     descriptor needed) so dev + every existing test stays green. Selecting plaintext is **gated**:
     allowed only when `developerMode` (or env) is on **AND** `policy.workspace.allowPlaintextDevMode`
     is true; if `policy.workspace.encryptionRequired` is set, plaintext is **refused**.

3. **App-shell lifecycle gate (`main/index.ts`).** Decide the workspace state at startup:
   - First run, encrypted default (commercial) → **create-password onboarding**; first run, dev →
     plaintext (current behavior).
   - Existing encrypted workspace, locked → **unlock gate** before the DB opens / IPC that needs the
     DB is usable. Keep it defensive: a wrong password re-prompts; nothing crashes. Lock (re-encrypt
     + shred) on `will-quit` (alongside the existing runtime stop) and ideally on an explicit
     **Lock** action.
   - Add the IPC the UI needs (new channels in `shared/ipc.ts`, exposed on preload `api` +
     `PreloadApi`): e.g. `getWorkspaceState()` (`locked | unlocked | uninitialized` + mode),
     `unlockWorkspace(password)`, `createWorkspace(password, mode)`, `lockWorkspace()`,
     `changePassword(old, new)` (optional). `AppStatus.workspaceReady` reflects unlocked.

4. **Onboarding / Unlock UI (new screen).** A pre-app gate (rendered before the normal sidebar when
   `locked`/`uninitialized`): create-password (with confirm + strength hint, encrypted vs plaintext
   choice when policy allows) and unlock (password + wrong-password error). Wire `App.tsx` to show
   the gate until `workspaceReady`. Keep the Privacy screen's plaintext caveat; add a **Lock now**
   control (Settings or sidebar). Copy stays calm/non-technical (spec §10.1).

5. **Tests** (keep all **137** existing green): `crypto.ts` round-trip + **wrong-password failure** +
   **KDF determinism with stored params** + tamper/auth-tag failure; vault **lock→encrypt→unlock**
   round-trip on a temp dir (decrypted DB reads back the same rows; **`.enc` exists, plaintext
   working file is gone after lock**; WAL sidecars cleaned); **no plaintext password persisted**
   (scan the descriptor + on-disk artifacts for the password — assert absent); plaintext-gating
   (policy `encryptionRequired` ⇒ plaintext refused; `allowPlaintextDevMode:false` ⇒ refused);
   `getWorkspaceState`/`workspaceReady` derivation; and a **no-network assertion** across the
   unlock/lock path (reuse the spy pattern). Test the **services directly** (`crypto.ts`,
   vault functions, `getSettings`) — the `register*Ipc` modules import `electron`.

6. **Ritual:** docs — fill in `docs/security-model.md` **Workspace modes / encryption** with the
   real design (KDF choice + params, AES-256-GCM, vault descriptor, WAL handling, lock/unlock/shred
   flow, threat notes) and refresh `SECURITY.md` (encryption now implemented; known limitations:
   plaintext working copy exists on disk while unlocked, secure-erase is best-effort on SSDs due to
   wear-leveling). Bump `_Last updated_`. Update `BUILD_STATE.md` (mark Phase 9 done; add contracts
   for `crypto.ts` / the vault lifecycle / the new IPC / `workspaceReady`; set **Phase 10 — real
   llama.cpp runtime & embeddings** as next actions; log decisions [KDF choice + why, vault-descriptor
   location + shape, whole-file-encryption + WAL handling, plaintext-gating rule, lock-on-quit] and
   risks). Commit.

## Notes / gotchas

- **Settings-in-DB chicken-and-egg.** You cannot read `workspaceMode`/settings before unlocking
  (they live in the encrypted DB). The **unencrypted vault descriptor** is the only thing the app
  reads pre-unlock — keep it minimal (mode + KDF params + salt + a verifier), never the password or
  key.
- **WAL sidecars leak plaintext.** Checkpoint (`TRUNCATE`) + close + remove `-wal`/`-shm` before
  encrypting and after shredding. Forgetting this is the #1 way to leak unencrypted data.
- **Plaintext working copy is a documented limitation.** `node:sqlite` needs a real file, so the
  unlocked DB exists decrypted on disk while the app runs (re-encrypted + shredded on lock/quit).
  This matches plan §4b. **Secure erase is best-effort** on SSDs (wear-leveling) — state this in
  `SECURITY.md`, don't over-promise.
- **R4 — Argon2id vs scrypt.** Native `argon2` may not build on Node 24. Implement the `node:crypto`
  `scrypt` fallback behind the same `deriveKey` interface and **record the algorithm + params** in
  the descriptor so unlock matches what encrypt used. If you add `argon2`, install with
  `NODE_OPTIONS=--use-system-ca npm install argon2` (TLS-intercepting proxy, BUILD_STATE R6) and
  keep the scrypt fallback. Preferring the built-in `scrypt` to avoid a fragile native dep is a
  legitimate, documentable choice.
- **Don't break dev or the existing tests.** Every current test opens `openDatabase(tempPath)`
  directly (plaintext) — keep that path 100% intact. `plaintext_dev` must remain the zero-friction
  default for `npm run dev` and the suite; encryption is opt-in/commercial-default, gated by policy.
- **Same schema both modes.** Encryption wraps the file; the spec §8 schema is identical. Do not
  fork the schema or the services that use the DB.
- **No new *required* deps.** `node:crypto` (`scrypt`, `randomBytes`, `createCipheriv` AES-256-GCM)
  covers everything. `argon2` is the only optional add, behind the fallback.
- **Encryption is the whole point — but Phase 9 is storage-at-rest, not transport.** No network is
  involved; the Phase-8 offline posture stays untouched (and the no-network assertion proves it).

## ENVIRONMENT NOTES (important)

- **Verify commands** (from repo root): `npm run typecheck`, `npm test`, and
  `NODE_OPTIONS=--use-system-ca npm run build`. **Green = typecheck + test + build.** ESLint is NOT
  installed; `npm run lint` fails by design and is NOT part of green. Live `npm run dev` is a manual
  step — don't block on it (but **do** make sure the unlock gate doesn't wedge the dev renderer).
- **All 137 existing tests must stay green.** Platform is Windows/PowerShell; `node:sqlite` lives in
  Electron's bundled Node (loaded via `createRequire` in `db.ts`) but tests run under system Node via
  vitest. `.all(param)` / `.get(param)` bind positional params (pass them). Use the `freshDb` +
  vitest-spy patterns from Phases 5–8.
- The `register*Ipc` modules import `electron`, so (as in prior phases) **test the services
  directly** (`crypto.ts`, the vault lifecycle, `getSettings`/state derivation) rather than the
  `ipcMain` handlers.

## END-OF-PHASE RITUAL (mandatory — a phase is not done until this is complete)

1. `npm test` (all green) + `npm run typecheck` (clean) + `NODE_OPTIONS=--use-system-ca npm run
   build` (green).
2. Update affected docs: `docs/security-model.md` (real encryption design) + `SECURITY.md`
   (encryption implemented + limitations), bump `_Last updated_`.
3. Update `BUILD_STATE.md`: mark Phase 9 done, refresh data contracts (crypto / vault lifecycle /
   new IPC / `workspaceReady`), set **Phase 10 (real llama.cpp runtime & embeddings)** as next
   actions, log new decisions and any risks.
4. Commit referencing **"Phase 9 / Milestone 9"**. Use `git -C f:/_coding/ai_drive` for git (note:
   forward slashes — backslashes get mangled by the Bash tool), and end the commit message with:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   (When committing via the Bash tool, pass the message with a here-doc `-F -`, **not** PowerShell
   `@'...'@`.)

When done, report what was built, test results, and what Phase 10 will tackle.
