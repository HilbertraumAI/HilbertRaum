# Multi-Persona Audit Report — Private AI Drive Lite (Round 4)

_Date: 2026-06-09 · Scope: full repo at Phases 0–13 complete ("MVP feature-complete")_

> **REMEDIATION STATUS (2026-06-09, same day):** all **Critical and High** findings — C1, C2,
> H1–H7 — are **FIXED** (plus M9 and M8, closed alongside H1/H6). See BUILD_STATE §11 for the
> remediation record. Gate after fixes: typecheck clean, **343/343 tests** (+20 regression tests),
> build green. The Medium/Low findings below (except M8/M9) remain open and prioritized in §8.

## 1. Methodology

Five independent audit personas reviewed the actual code (not BUILD_STATE claims), each instructed
**not** to re-report findings already fixed in the three prior audit rounds (BUILD_STATE §8/§9/§10)
and to verify a sample of those claimed fixes:

| Persona | Focus |
|---|---|
| **SEC** — adversarial security/privacy auditor | crypto, vault, offline guarantee, Electron hardening, IPC trust, sidecars, data-at-rest |
| **SPEC** — spec-compliance auditor | every requirement in `CLAUDE_Private_AI_Drive_Lite_MVP.md` vs code; gaps/contradictions/creep |
| **BUG** — senior-engineer bug hunt | logic errors, races, leaks, cross-platform, SQL/IPC/renderer correctness |
| **DOCS** — documentation auditor | every doc/README/PRIVACY/SECURITY claim vs code; stale/false statements |
| **REL** — release/build engineer | scripts (`.ps1`/`.sh`) vs canonical TS modules, packaging, launchers, manifests |

Independent verification performed during the audit:
- `npm test` → **323/323 tests pass (32 files)**, exit 0.
- `npm run build` → green; main bundle **105.09 kB**.
- Several script behaviors verified **empirically** (PS 5.1 regex tests, real dry-runs against temp targets).

**Verified prior-fix claims (spot-checked, present in code):** awaited `will-quit` sidecar stops;
SIGKILL escalation gated on actual exit (`this.exited`); startup shred of stale plaintext DB;
E5 dimension assertion; `shell.openExternal` http(s) allowlist; loopback-only sidecar binding;
policy junk-resistance (`bool()` strictness); Electron hardening (contextIsolation/sandbox/CSP/
will-navigate); fresh GCM IV per encryption; timing-safe verifier; `.cmd` first-match launcher fix;
hashtable splatting + WAL/SHM checks in `build-commercial-drive`; HTTPS-only download URLs.

## 2. Verdict

The offline/privacy core, RAG pipeline, data model, and the TS-side drive tooling are genuinely
spec-faithful and well-tested. However the audit found **2 Critical** findings (both in the shell
scripts that build the commercial drive — the canonical TS gates are correct but the native
re-implementations drifted), **7 High** findings (one spec hard-rule violation around plaintext
document copies, two new orphan-process races, a vault-wipe path, a perf landmine that makes a real
drive unusable, a broken documented first-run journey, and an incomplete multi-OS drive build), and
a substantial set of Medium issues. The recurring themes: **(a)** script↔TS drift in exactly the
safety-critical spots, **(b)** real-runtime/real-drive behavior that mock-first testing cannot see,
and **(c)** enforcement living in the renderer/docs instead of the main process.

---

## 3. Critical

### C1 [REL] — `fetch-runtime` never parses `sha256`: runtime-binary verification is structurally dead in both shells
**Files:** `scripts/fetch-runtime.ps1:84`, `scripts/fetch-runtime.sh:83`
The flat-YAML key regex is `[A-Za-z_]+` — **no digits** — so the line `sha256: …` never matches
(empirically confirmed in both shells). `$build.sha256` stays empty → the placeholder branch always
runs → the script prints "zip UNVERIFIED (placeholder hash)" and extracts anyway, **even after a
real hash is committed** to `runtime-sources.yaml`. The canonical TS path (`assets.ts`
`verifyDownloadedFile`) verifies correctly; the scripts — the thing a drive builder actually runs —
will silently install a tampered/corrupt `llama-server` onto a sellable drive, and the message looks
like the expected placeholder state so nobody notices. Verify-before-trust (a LOCKED Phase-12
decision) is dead code in the native path.
**Fix:** change the key class to `[A-Za-z0-9_]+` in both scripts; fail loudly if a selected build is
missing `sha256`/`url`/`extract_to`.

### C2 [REL] — `build-commercial-drive` final gate is weaker than `assertCommercialDrive`: exits 0 for a drive the canonical gate rejects
**Files:** `scripts/build-commercial-drive.ps1:126-160`, `scripts/build-commercial-drive.sh:111-144`
vs `apps/desktop/src/main/services/commercial-drive.ts:256-266`
The TS gate requires `modelResults.length > 0 && every status === 'verified'`. The scripts' step 7
checks only policy posture + user-data artifacts and then prints a **manual instruction** ("Confirm
verify-models reported every weight VERIFIED"). `verify-models` exits 1 **only on MISMATCH** —
MISSING and UNVERIFIED exit 0 (verified empirically: 6× MISSING → exit 0). With today's
placeholder-hash manifests the entire pipeline runs green and ends "Done. Test the drive…" while
**zero weights are verified** — and per C1 the runtime zip is unverified too. The native pipeline
ships a wrong posture with exit code 0. (BUILD_STATE §10 P2 claimed the scripts "mirror
assertCommercialDrive exactly" — they mirror the policy/user-data checks but not the weight gate.)
**Fix:** add a strict weight gate to step 7 (fail unless every manifest with a `local_path` is
VERIFIED and the count is > 0), e.g. via a new `verify-models --strict` flag the pipeline passes.

---

## 4. High

### H1 [SPEC+DOCS+SEC] — Imported document copies are stored in plaintext even in an encrypted workspace, and the docs over-promise the opposite
**Files:** `apps/desktop/src/main/services/ingestion/index.ts:191-192` (`copyFileSync` →
`workspace/documents/<id><ext>`), `workspace-vault.ts` (encrypts only `paid.sqlite`);
`launchers/READ ME FIRST.txt` ("This password encrypts **everything on the drive**" — false),
`PRIVACY.md:68-69`, `docs/user-guide.md:57-58`, `SECURITY.md` + `docs/security-model.md` (known-
limitations lists omit it).
Spec hard rule (§0.2): "must not store user documents in plaintext unless the user explicitly
chooses an unencrypted workspace"; §3.5: encrypt "workspace database **and document cache**". The
vault encrypts only the SQLite file. Every import is copied verbatim to `workspace/documents/` and
survives lock/quit unencrypted — anyone who finds the drive reads every imported document without
the password. Chat history/chunks/embeddings ARE protected; the original documents are not. The gap is
**both unimplemented and undocumented**, and `READ ME FIRST.txt` actively asserts the opposite to a
commercial buyer. (`commercial-drive.ts:205-209` itself classifies `workspace/documents/*` as user
data — the ship gate knows these files matter.)
**Fix (minimum, before any drive ships):** correct READ ME FIRST / PRIVACY / user-guide / SECURITY /
security-model to state exactly what is and isn't encrypted (incl. plaintext logs). **Fix (real):**
encrypt the document cache (e.g. AES-GCM per file with the vault key) or store extracted text only.

### H2 [BUG] — `RuntimeManager` start/stop races orphan real `llama-server` processes
**File:** `apps/desktop/src/main/services/runtime/index.ts:55-86` (+ `ipc/registerModelIpc.ts`)
`this.current` is only assigned after a fully successful start; there is **no in-flight tracking**.
During a real GGUF load (up to the 60 s health timeout): (a) a second `startRuntime` (the renderer
`busy` guard is component-local state, lost on navigating away/back) sees `current == null`, skips
the stop, spawns a **second** server — the first is never stopped (orphan holding GBs of RAM + a
port); (b) `stopRuntime` during an in-flight start is a no-op, then the start commits — UI says
stopped, server runs; (c) quit during start → `shutdown()` stops nothing, `app.exit(0)`, the child
survives. This is the same orphan class previous audits fixed elsewhere, reintroduced via the
start window.
**Fix:** track the in-flight start (promise + pending instance) in `RuntimeManager`; serialize
`start()`; make `stop()` await/stop the pending runtime too.

### H3 [BUG] — `E5Embedder.stop()` during the lazy start orphans the embeddings sidecar
**File:** `apps/desktop/src/main/services/embeddings/e5.ts:124-128`
`this.server` is assigned only after the lazy `start()` resolves; `stop()` reads `this.server`,
sees `null` while `this.starting` is in flight, and returns. Sequence: first `embed()` begins
spawning → user quits → `will-quit` awaits `embedder.stop()` (no-op) → the start completes →
`app.exit(0)` → orphan `llama-server --embedding`.
**Fix:** in `stop()`, `await this.starting?.catch(()=>{})` first, then stop whatever exists; set a
stopped flag that `ensureStarted` checks so a racing start can't resurrect it.

### H4 [BUG] — `WorkspaceController.create()` can silently destroy an existing encrypted vault
**File:** `apps/desktop/src/main/services/workspace-vault.ts:366-382` (+ `readVaultDescriptor:106-115`)
The only guard is `isUnlocked()`; `createEncryptedVaultOnDisk` unconditionally overwrites the
descriptor and re-encrypts an **empty** DB over `paid.sqlite.enc`. `readVaultDescriptor` returns
`null` on **any** JSON parse/shape error → state reports `uninitialized` → the WorkspaceGate shows
the **create** flow → the user's "Create workspace" click irreversibly wipes all chats/documents/
settings. A recoverable 200-byte descriptor corruption becomes total data loss. Any caller invoking
`createWorkspace` while `locked` does the same with no confirmation.
**Fix:** refuse `create` when `vaultPaths.encPath` exists (require an explicit destructive reset
API); surface a distinct "descriptor unreadable" state instead of `uninitialized`.

### H5 [BUG] — `listModels` SHA-256-hashes every model file on every call: Models **and Chat** screens become unusable on a real drive
**Files:** `apps/desktop/src/main/services/models.ts:163-182` (no caching) ← `registerModelIpc`
`listModels` ← `ModelsScreen.refresh()` **and** `ChatScreen.checkRuntime()` (`ChatScreen.tsx:35-38`)
`computeInstallState` runs a full-file `sha256File` per manifest with no mtime/size cache. With a
4–9 GB GGUF (or several — six manifests now) on a USB drive, every Models-screen visit and **every
Chat-screen mount** re-reads entire model files: minutes of I/O per navigation, drive thrash, UI
stuck on "Loading models…". Invisible in dev/CI (no weights present) — guaranteed on the commercial
drive.
**Fix:** cache verification keyed on `(path, size, mtimeMs)`, or compute install state from
existence and verify hashes on demand/in the background.

### H6 [DOCS] — README/user-guide first-run journey is broken: you cannot chat with the "built-in mock model" from a fresh clone
**Files:** `README.md:55-57`, `docs/user-guide.md:89-91`, `docs/troubleshooting.md:57-58` vs
`services/models.ts:171-172`, `ModelsScreen.tsx:72,134`, `runtime/factory.ts`
Docs promise the app "starts immediately on a built-in mock model so you can explore … chat, Q&A".
Reality: chat requires an explicitly started runtime; with zero weight files every manifest computes
`missing` and the Models screen **disables** Start for non-installed models; the mock fallback only
engages inside `start()`, which the UI never allows you to reach. Fresh-clone users dead-end at a
"start a model" empty state with every button greyed out — the documented evaluation path does not
exist.
**Fix:** either allow starting the mock with no weights (e.g. an explicit "Try with mock model"
affordance in dev builds) or rewrite README/user-guide/troubleshooting to describe reality.

### H7 [REL] — Commercial drive ships without mac/linux sidecars; `fetch-runtime.ps1` is host-OS-blind
**Files:** `scripts/fetch-runtime.ps1:104,115,146`; `scripts/build-commercial-drive.ps1:86-89`,
`.sh:71-75` vs `commercial-drive.ts:115-121`
(a) `fetch-runtime.ps1` hardcodes `llama-server.exe` regardless of `-Os` and its idempotency check
is `-and $Os -eq 'win'` — fetching the mac/linux build from a Windows build machine re-downloads
every run and always warns spuriously (the bash script does this correctly). (b) The pipeline runs
`fetch-runtime` once with no OS override, so a Windows-built "sellable" drive carries an **empty**
`runtime/llama.cpp/mac` + `linux` — while `READ ME FIRST.txt` promises "move it to another computer
at any time". No gate checks sidecar presence (not even `assertCommercialDrive`), so this ships
silently.
**Fix:** derive the binary name from the selected build's `os`; loop the pipeline over win/mac/linux
(skipping absent builds); consider a sidecar-presence check in `assertCommercialDrive`.

---

## 5. Medium

### Code correctness (BUG persona)

- **M1 — Regenerate deletes the wrong assistant message.** `chat.ts:177-187` deletes the most
  recent **assistant** row even when the conversation's last turn is a user message (e.g. after a
  failed generation). Clicking Regenerate then permanently deletes the answer to a *previous*
  question and the renderer's optimistic slice diverges from the DB. Fix: delete only if the
  conversation's last message is the assistant turn; otherwise just generate.
- **M2 — Switching conversation / New chat during streaming corrupts the transcript.**
  `ChatScreen.tsx` disables the mode tabs while streaming but **not** the sidebar/new-chat buttons;
  the streaming bubble has no conversation key, and stream completion does
  `setMessages(listMessages(convId))` for the **old** conversation while `activeId` points at the
  new one — conversation B's view is replaced by A's messages. Fix: track `streamingConvId`; gate
  bubble rendering and the completion refresh on it (or disable switching while streaming).
- **M3 — No per-document concurrency guard.** `deleteDocument`/`reindexDocument` are accepted while
  the background import loop processes the same id. Delete-mid-process → FK violation → caught →
  `getRow` returns null → **TypeError out of a "never throws" function**; reindex racing import can
  leave **two full chunk sets** (no uniqueness constraint on `(document_id, chunk_index)`) and
  doubled retrieval hits; `rmSync` can hit EBUSY against the parser's open handle on Windows. Fix:
  per-document in-flight set in the docs IPC layer + null-guard in the catch path.
- **M4 — Lock-while-importing wedges documents with no in-session recovery.** "Lock now" mid-import
  closes the DB; the loop's failure leaves rows at `extracting`/`embedding` inside the re-encrypted
  snapshot; `reconcileStuckDocuments` runs once per process (`reconciled` flag) and its cutoff
  predates the rows anyway; the Documents screen disables Re-index/Delete for active statuses. User
  must restart the app. Fix: abort/await the import loop in `WorkspaceController.lock()` or rerun
  reconciliation on unlock with a fresh cutoff.
- **M5 — Vault file crypto + shred break above ~2 GiB.** `encryptFile`/`decryptFile` use whole-file
  `readFileSync` (throws `ERR_FS_FILE_TOO_LARGE` ≥ 2 GiB) and `shredFile` does
  `writeFileSync(path, randomBytes(size))` — `randomBytes` throws ≥ 2 GiB **and the `rmSync` is in
  the same try**, so a large DB is neither shredded nor unlinked while `lock()` "succeeds": the app
  quits leaving `paid.sqlite` in plaintext, and the vault can no longer be locked/reopened. Even
  below the limit, lock/unlock spikes memory by the full DB size. Fix: stream encrypt/decrypt;
  shred in bounded chunks with the unlink in its own try.
- **M6 — DOCX chunking is broken by design drift.** `parsers/docx.ts` emits one segment per
  paragraph and its comment says "the chunker recombines them" — but `chunkSegments` **never packs
  multiple segments into one window**. Every paragraph becomes a tiny chunk; retrieval quality
  collapses; a >1000-paragraph document hits `maxChunks` and the rest is **silently dropped** while
  reporting `indexed`. Fix: merge consecutive same-label segments up to `chunkSizeTokens` before
  windowing (or emit one segment from the DOCX parser).
- **M7 — Real-embedder mismatch: 500-"word" chunks vs `--ctx-size 512`, one giant batch, no timeout.**
  500 whitespace words ≈ 650+ BPE tokens → real E5 requests routinely exceed context and the whole
  document fails (mock masks this in every test). `embedChunks` sends up to 1000 chunks in a single
  `/v1/embeddings` call with no AbortSignal — a wedged sidecar parks the document in `embedding`
  forever (combined with M4: unrecoverable). Fix: size chunks against the embedder context or raise
  it; batch smaller; bound with `AbortSignal.timeout`.
- **M8 — `startRuntime` happily loads an embeddings model as the chat runtime.** No `role` check in
  `registerModelIpc.ts:39-52`; the Models screen renders an enabled Start button on the E5 card →
  garbage chat with no hint why. Fix: reject `role !== 'chat'` in the handler; hide the button.

### Security/privacy (SEC persona)

- **M9 — Plaintext `paid.sqlite.tmp` is never shredded.** `decryptFile` writes the **entire
  decrypted DB** to `${dbPath}.tmp` before rename; crash in that window leaves a full plaintext DB
  the startup sweep ignores (`shredStalePlaintext` covers only `dbPath` + `-wal`/`-shm`). Fix: add
  the `.tmp` path to the shred set. (Same class as the audited H1-round-1 fix; this is the missed
  fourth artifact.)
- **M10 — Spec §7.4 model-verification gate is renderer-only; policy `models` block unenforced in-app;
  `developerMode` defaults `true`.** `startRuntime` performs no existence/checksum/state check (the
  disabled button is the only gate); `policy.models.allowUnverifiedModels`/`requireSha256Match` are
  parsed but consumed only by the ship-time assertion; `DEFAULT_SETTINGS.developerMode = true`
  (`shared/types.ts:157`) makes checksum strictness dev-lenient out of the box in **every** build,
  including from a commercial drive whose policy says `require_sha256_match: true`. Fix: enforce
  state + policy in the `startRuntime` handler; default `developerMode` to `false` (or derive from
  `isDev`).
- **M11 — License gate is bypassable and unchecked at ship time.** All six manifests are
  `license_review.status: pending`, so the documented commercial invocation **requires**
  `--accept-license`, which overrides the *review* gate (not just user acceptance) — and
  `assertCommercialDrive` never checks license status at all. A drive built over `pending` reviews
  passes every automated gate, contradicting spec §13. Fix: complete the reviews; add a
  license-approved check to `assertCommercialDrive` + the scripts' step 7 that `--accept-license`
  does **not** override.

### Spec gaps (SPEC persona)

- **M12 — No first-run benchmark, no onboarding flow, recommendation is semi-automatic.** Spec §2.1
  "first-run hardware benchmark" + §7.1 Onboarding screen + plan Phases 1/7 onboarding integration:
  `runBenchmark` is reachable only via the Diagnostics button; profile stays `UNKNOWN` until the
  user finds it; `WorkspaceGate` covers only the password step; nothing auto-selects/auto-recommends
  on first run.
- **M13 — "Export chat transcript" (§7.6) not implemented.** No IPC, no service function, no UI
  (only per-message Copy).
- **M14 — Diagnostics screen (§7.11/§10.7) missing: viewable logs, runtime status/health, app/runtime
  version, selected model, model verification.** No log viewer exists anywhere in the app.
- **M15 — §12.3 manual-update mechanism: no implementation, no documentation, and the spec §6
  `updates/incoming|applied` + `workspace/backups/` dirs are absent from `DRIVE_LAYOUT_DIRS`** —
  divergences not noted in drive-layout.md's reconciliation list.
- **M16 — Direct app launch from the drive bypasses the drive workspace (§7.2 / success criterion #10).**
  Drive detection rides solely on `PAID_DRIVE_ROOT` (set by the launchers); a buyer who double-clicks
  the portable `.exe` directly gets a silent fresh app-data workspace instead of their encrypted
  drive workspace. Fix: in-app fallback — walk up from `app.getPath('exe')` looking for the
  `config/drive.json` marker.

### Scripts/packaging (REL persona)

- **M17 — Inline YAML comment leaks into parsed values.** `version: b9196   # PLACEHOLDER …` is
  captured verbatim by both shells (zip temp name contains spaces/`#`/em-dash). Strip ` #…` suffixes
  after capture; same latent issue in the manifest parsers.
- **M18 — `extract_to` is escape-guarded in TS but not in either script.** A tampered drive-local
  `runtime-sources.yaml` (the scripts prefer the drive copy) with `extract_to: ../../…` extracts
  outside the drive root. One reject-regex per script.
- **M19 — `setup-dev` hard-fails on Node 22.5–22.14.** `NODE_OPTIONS=--use-system-ca` exists only
  from 22.15+, but `engines` permits ≥22.5 — bootstrap aborts with an unrelated-looking error. Bump
  engines or probe first (also: it clobbers pre-existing `NODE_OPTIONS`).
- **M20 — `.gitattributes` forces LF onto `launchers/Start Private AI Drive.cmd`** (`* text=auto
  eol=lf`; confirmed `i/lf w/lf`). LF-only batch files are an unsupported cmd.exe configuration with
  documented multi-line-block edge cases, and this file ships verbatim to customers. Add
  `launchers/*.cmd text eol=crlf`.
- **M21 — Two manifest sources of truth.** The packaged app reads `resources/model-manifests`
  (extraResources); the scripts verify against `<drive>/model-manifests`. A drive-side manifest
  update diverges from what the app loads; launchers don't set `PAID_MANIFESTS_DIR`. Unify or
  document.
- **M22 — `prepare-drive.ps1` relative `-Target` splits across two CWDs.** Dirs are created via the
  PS location, config via `[System.IO.File]::WriteAllText` (the .NET process CWD) → config lands in
  the wrong tree or throws. Normalize `$Target` to a full path up front.
- **M23 — bash 3.2 + `set -u`: empty `MANIFEST_FILES[@]` expansion crashes `fetch-models.sh`/
  `verify-models.sh`** when `model-manifests/` exists but is empty. Guard the count first.
- **M24 — `build-commercial-drive.sh` posture check greps raw JSON text** (key matched anywhere in
  the file, fixed single-space `": *true"`), vs PS's real `ConvertFrom-Json`. Tolerable for
  machine-generated files only; tighten the regex and document the constraint.

### Documentation drift (DOCS persona)

- **M25 — SECURITY.md still describes scrypt as the KDF** ("leaves room for an Argon2id upgrade");
  Argon2id has been the default since hardening round 2 (`crypto.ts:51-56`).
- **M26 — PRIVACY.md invents a setting** ("or references to them, depending on your setting") —
  imports are always copied; no such setting exists. PRIVACY.md is also still stamped "(Phase 8)".
- **M27 — Offline-guard gating described three contradictory ways.** Code installs it in **all**
  builds (`main/index.ts:133-135`); `docs/architecture.md:141-143` and BUILD_STATE §3/§4 still say
  dev/developerMode-only (contradicting BUILD_STATE §8 M3 in the same file).
- **M28 — `docs/architecture.md` not updated for Phases 11–13** (ritual violation): module map omits
  `drive.ts`, `assets.ts`, `launcher.ts`, `preflight.ts`, `commercial-drive.ts`, `workspace-vault.ts`,
  the `runPreflight` IPC.
- **M29 — BUILD_STATE stale: "322/322 tests" (actual 323), "main 104.75 kB" (actual 105.09), "four
  committed model manifests" / "1.7B/4B/8B" (now six incl. 14B + 30B-A3B)** — the Qwen-14B/30B
  commit (`48154b3`) skipped the per-phase ritual. `model-manifests/README.md:7` has the same stale
  catalog line. BUILD_STATE also says runtime-sources "pins ggml-org/llama.cpp@b9196" without the
  placeholder caveat every other doc carries.
- **M30 — `npm run lint` is documented (plan Phase 0 acceptance) but broken**: the script exists in
  both package.json files, but eslint is not a dependency and no config exists — it fails
  immediately. Add eslint+config or remove the scripts/claims.
- **M31 — `docs/rag-design.md` states "the embedder uses only `node:crypto`"** — true only for the
  mock; the real E5 spawns a sidecar (doc stamped Phase 6, never bumped for Phase 10).

---

## 6. Low (summary)

- **[SEC]** Unbounded attacker-supplied KDF params in the descriptor → unlock-time OOM/DoS
  (validate bounds; `keyLen === 32`). Key buffer never zeroed on lock (`key.fill(0)`).
  Offline tripwire covers Node sockets only — `electron.net` would bypass it silently (document the
  boundary). `updateSettings` persists arbitrary renderer keys (no allowlist). `importDocuments`
  trusts arbitrary renderer paths (post-compromise file exfil into the workspace; honor only
  picker-returned paths). Zip-slip surface while runtime hashes are placeholders.
- **[BUG]** Non-OK chat response body never drained (connection held). Stop before first token
  persists an empty assistant bubble. Port TOCTOU between the two sidecars (retry on bind failure).
  `onRegenerate` can throw an unhandled rejection. `App.tsx` fakes `unlocked` when
  `getWorkspaceState` rejects → raw IPC errors on every screen instead of one fatal state.
- **[SPEC]** Model states `ready`/`not_recommended` declared but never produced. `ChatOptions.mode`
  (Fast/Balanced/Deep) is dead plumbing — accepted over IPC, read by nothing — while the benchmark
  warning copy points users at "Fast Mode", a concept with no UI. Home screen lacks the §10.2
  "Run Benchmark" quick action. No per-document "ask selected documents" scope (§10.4). Settings
  missing Models/Performance/About sections (§10.6). GPU detection permanently `null` with a stale
  "Phase 10" promise in the comment. No `sample-contract.pdf` for the canonical §17 demo.
  §18.3/§18.5 sample copy unused; §7.10 required text paraphrased (the "unless you explicitly
  export them" clause never appears). Stale phase-era UI copy ships to users: "mock until Phase 10"
  tooltip, "encrypted workspace arrives in Phase 9", "Backend services land in Phase 1".
  Manifest fields `supports_thinking_mode`/`supports_tools`/`bundled_on_preconfigured_drive` are
  parsed by nothing (see also REL note: the bundled flag's intent — don't ship 8B/14B/30B — is
  unimplemented; the pipeline fetches all six weights, ~37 GB).
- **[REL]** `fetch-models` dry-run exits 1 on license-block (TS plan just reports). prepare-drive
  dry-run omits TS's overwrite warning. `manifest.ts:56` doc comment says `local_path` is relative
  to `models/` (it's drive-root-relative). `.gitignore` lacks `*.sqlite-wal`/`-shm`. `verify-models`
  doesn't exclude `runtime-sources.yaml` (fragile). Stale `.aria2` control file left after mismatch
  cleanup. Windows-on-ARM arch detection reports AMD64. `react`/`react-dom` in `dependencies` get
  packed into the asar despite being renderer-bundled. `.command` `open` fallback drops
  `PAID_DRIVE_ROOT` (silently non-drive workspace — fail with a message instead).
- **[DOCS]** README "Start" vs actual "Start runtime" button; "Missing" vs "Not downloaded" status.
  README "Node ≥ 22" vs engines `>=22.5`. Drive-copied docs contain links that 404 on the drive.
  drive-layout.md basic tree omits `workspace/documents/` + `.enc`. BUILD_STATE §4 IPC list omits
  `runPreflight`. Phase stamps lag content across PRIVACY/SECURITY/security-model/rag-design.
  PRIVACY.md describes the deferred in-app downloader as if it exists behind the toggle.
  `sample-data/README.md` still says embeddings are a Phase-5 pass-through. `mac.notarize` "wired"
  overstates a comment in the yml. CLAUDE.md omits `package`/`package:win`.

---

## 7. Cross-cutting themes & recommendations

1. **Script↔TS drift is the #1 systemic risk.** Both Criticals and H7 live in the shell
   re-implementations of logic whose TS originals are correct and tested. The "scripts mirror the
   canonical module" rule has no enforcement. *Recommendation:* add a parity test layer — golden
   fixtures (a fake drive + fake manifests incl. a **real** sha256) that each script family must
   process with byte-comparable outcomes, run in CI on Windows + bash; or generate the scripts'
   data tables from the TS source.
2. **Mock-first testing has a blind spot for real-runtime behavior.** H2/H3/H5/M5/M6/M7 are all
   invisible with zero weights and a 12 ms/token mock. *Recommendation:* a manual pre-ship checklist
   item — one real-model session covering: model switch mid-load, quit mid-load, import a 50-page
   DOCX, lock during import, a >2 GiB workspace, Models-screen latency with real GGUFs.
3. **Enforcement must move out of the renderer.** H4 (create-over-vault), M8 (role check), M10
   (verification gate), and the disabled-button-as-only-gate pattern all trust the UI. The main
   process is the security boundary; every IPC handler should re-validate.
4. **The privacy story must match the bytes on the drive.** H1/M9/M26: before any commercial drive
   ships, either encrypt the document cache + logs or say plainly that they are not encrypted.
5. **Ritual compliance slipped once** (the 14B/30B commit, M29): cheap to fix, worth a
   pre-commit reminder since BUILD_STATE is the session handoff.

## 8. Suggested remediation order

| Priority | Items | Why |
|---|---|---|
| P0 — before any further drive-build work | C1, C2, H7 | the commercial pipeline currently ships unverified/incomplete drives with exit 0 |
| P0 — before any real-model use | H2, H3, H5 | orphaned processes + unusable screens on real hardware |
| P1 — data-loss/privacy | H1 (docs now, encryption next), H4, M5, M9 | vault wipe path, >2 GiB plaintext leak, `.tmp` leak, false buyer promise |
| P1 — first-run truth | H6, M12 | the documented evaluation path doesn't work |
| P2 — correctness cluster | M1–M4, M6–M8, M10, M11 | chat/ingestion races, DOCX quality, ship-time license gate |
| P3 — docs/ritual sweep | M25–M31 + Lows | one batched docs pass; restore BUILD_STATE accuracy |

---

_Audit performed by five parallel reviewer personas (security, spec-compliance, bug-hunt, docs,
release engineering) with independent test/build verification. Findings were deduplicated and
verified against code; file:line references are to the working tree at commit `48154b3`._
