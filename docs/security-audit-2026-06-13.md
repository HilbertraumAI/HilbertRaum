# Security audit — HilbertRaum (2026-06-13)

_In-depth, multi-persona security review of the MVP. Read-only audit: no code was
changed. Scope is the shipped Electron application (`apps/desktop`) and the build/provisioning
scripts. The threat model and the controls being verified are described in
[`security-model.md`](security-model.md); this report tests them against the code as built._

## Method & viewpoints

The codebase was reviewed end-to-end from five attacker/reviewer personas, each owning a
distinct surface:

1. **Electron / desktop-platform reviewer** — the renderer↔main IPC boundary, the preload
   bridge, window `webPreferences`, CSP, navigation/window-open handling, permission requests.
   Renderer treated as **partially trusted** (XSS via malicious model output or document
   content is in scope).
2. **Cryptography / data-at-rest reviewer** — KDF, AEAD, key lifecycle (derive→use→zero),
   the descriptor/envelope format, password change, working-file shredding.
3. **Malicious-document reviewer** — a user imports an attacker-crafted PDF / DOCX / CSV /
   image / audio file. Path construction, resource exhaustion, ReDoS, XXE, decompression
   bombs, child-process handling.
4. **Network / offline / supply-chain reviewer** — the offline guarantee, the in-app model
   downloader (the one network feature), sidecar process spawning, manifest/checksum
   verification, dependency posture.
5. **Privacy / data-leak reviewer** — verifying the core promise that no chat/document text or
   passwords ever reach logs, the audit trail, temp files, or any off-device sink.

## Overall assessment

**The security architecture is strong and matches its documented threat model.** The
load-bearing controls are all present and correctly implemented:

- Renderer is locked down: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`; a single typed `contextBridge` surface; strict production CSP
  (`default-src 'self'`, no remote `connect-src`); deny-by-default permission handler with one
  narrowly-scoped audio exception; safe-scheme-only external-link handling.
- **No SQL injection** anywhere — every query is parameterized.
- **No command injection** — every `child_process.spawn` uses an argv array, never `shell: true`.
- **No path-traversal write primitive** reachable from the renderer — stored copies use
  UUID-derived internal paths; export destinations come from the OS save dialog; download/extract
  destinations are resolved and re-rooted under the drive.
- Crypto is sound: AES-256-GCM with fresh IVs, Argon2id KDF (audited pure-JS `@noble/hashes`),
  a v2 envelope (data-key wrapped by a password-derived KEK), authenticated password verifier
  that never touches the DB, descriptor holds only ciphertext. Keys are zeroed after use on the
  primary paths.
- The **privacy promise holds**: across 60+ log call sites and every audit event, only ids,
  model ids, filenames/titles, counts, and enum/boolean setting values are recorded — never chat
  text, document content, or passwords. The pre-unlock log buffer is genuinely memory-only; the
  encrypted-log key is the controller's own buffer, flushed before it is zeroed.
- Rendered model output is XSS-safe: `react-markdown` builds React elements (no `innerHTML`, no
  `rehype-raw`), with a `http(s)`-only href whitelist on top of the CSP
  ([`Transcript.tsx:213`](../apps/desktop/src/renderer/chat/Transcript.tsx#L213)).

**No HIGH-severity findings.** The findings below are MEDIUM and lower. The single most
important theme is **resource-exhaustion DoS via crafted documents** (no size/page/inflation
caps before a parser runs), and a **fail-open policy default** that places the entire commercial
hardening posture on the provisioning pipeline writing a restrictive `policy.json`.

## Findings summary

| ID | Sev | Area | Finding |
|----|-----|------|---------|
| M-1 | MEDIUM | Parsers / DoS | No file-size cap before any parser runs (txt/csv/md/pdf/image read fully into memory) |
| M-2 | MEDIUM | Parsers / DoS | Unbounded PDF page loop in text extraction (no page cap, no timeout) |
| M-3 | MEDIUM | Parsers / DoS | DOCX/zip decompression bomb (JSZip inflates with no size/ratio ceiling) |
| M-4 | MEDIUM | Policy | Missing/malformed `policy.json` fails **open** to permissive dev defaults |
| M-5 | MEDIUM | Runtime | `HILBERTRAUM_LLAMA_BIN` spawns an arbitrary, unverified binary; the sidecar binary is never hash-checked before spawn |
| M-6 | MEDIUM | Downloads | Placeholder-hash weight is moved into place as "done" (unverified); usable when `allowUnverifiedModels` (default true) |
| L-1 | LOW | Offline guard | `/^127\./` misclassifies `127.evil.com` / `127.0.0.1.evil.com` as loopback (detection-only, so contained) |
| L-2 | LOW | Downloads | No `https:`-only enforcement on manifest download URLs (cleartext `http://` accepted) |
| L-3 | LOW | IPC | `importPreflight` is neither unlock-gated nor type-filtered; a filesystem-walk oracle |
| L-4 | LOW | IPC / import | `importDocuments` trusts renderer-supplied absolute source paths (arbitrary local-file *read*/ingestion) |
| L-5 | LOW | Parsers | `expandPaths` follows directory symlinks (`statSync`), no cycle guard |
| L-6 | LOW | Crypto | KDF-derived key not zeroed on the wrong-password throw path |
| L-7 | LOW | Build scripts | `Expand-Archive` / `tar -xzf` of runtime archives don't prevent member traversal (build-time only) |
| L-8 | LOW | Supply chain | Mixed version pinning; ensure committed lockfile + `npm ci` in the build pipeline |
| I-* | INFO | various | Error-tone leaks, NaN-permissive limit clamp, `--` argv terminator — see details |

---

## Remediation status — hardening wave (2026-06-13)

All MEDIUM and the quick-win LOW findings were fixed in the same-day hardening wave that
followed this audit. Deferred LOW items are tracked in `BUILD_STATE.md` as open hardening
items. Status:

| ID | Status | What changed |
|----|--------|--------------|
| M-1 | ✅ Fixed | Pre-parse byte ceiling in `processDocument` (1 GiB default, env-overridable `HILBERTRAUM_MAX_DOC_BYTES`) — checked against `size_bytes` (cheap, pre-decrypt) AND a `statSync` on the resolved parse source. `services/ingestion/limits.ts`. |
| M-2 | ✅ Fixed | PDF page cap (`pdf.ts`, default 5 000, `HILBERTRAUM_PDF_MAX_PAGES`) + a wall-clock parse timeout around `parser.parse` (30 min default, `HILBERTRAUM_PARSE_TIMEOUT_MS`; audio exempt — see below). |
| M-3 | ✅ Fixed | DOCX zip-bomb guard: `declaredZipInflatedSize` sums the zip central-directory uncompressed sizes and refuses anything over the ceiling (1 GiB default, `HILBERTRAUM_DOCX_MAX_INFLATED_BYTES`) before mammoth inflates. Rejection → friendly, persist-canonical `main.ingest.fileTooLarge`. |
| M-4 | ✅ Fixed | `loadPolicy`/`parsePolicy` take an `{ isDev }` option; a **packaged** build with a missing/malformed/partial `policy.json` now fails CLOSED to the new `STRICT_POLICY` (encryption required, plaintext off, models must verify, network denied). `isDev` is threaded from `index.ts` + every model/download/core IPC call site. The commercial sell gate keeps the DEFAULT base on purpose (a missing policy.json must FAIL the gate). |
| M-5 | ✅ Fixed | `HILBERTRAUM_LLAMA_BIN` / `HILBERTRAUM_WHISPER_BIN` are honoured ONLY in a dev build (`resolveLlamaServerPath`/`resolveWhisperCliPath` gained an `{ isDev }` opt, default false = ignore + log). `isDev` threaded through the runtime/embedder/reranker/transcriber factories + the benchmark probe. |
| M-6 | ✅ Neutralized | The M-4 fail-closed packaged policy sets `allowUnverifiedModels: false`, so a placeholder-hash/unverified weight cannot be loaded on a packaged drive. Added a model-IPC test proving a packaged build with no `policy.json` refuses the unverified mock fallback even with `developerMode` on. |
| L-1 | ✅ Fixed | Loopback regex anchored to `/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` + a code comment that `isLoopbackHost` must never gate enforcement. `offlineGuard.ts`. |
| L-2 | ✅ Fixed | `validateManifest` rejects a non-`https:` `download.url`; the network seam `downloadToFile` refuses any non-HTTPS URL before fetching (covers model + runtime + OCR). New `isHttpsUrl` in `shared/manifest.ts`. |
| L-3 | ✅ Fixed | `importPreflight` now `requireUnlocked()` + string-array type-filters its paths, matching `importDocuments`. `registerDocsIpc.ts`. |
| L-6 | ✅ Fixed | `unlockEncryptedVault` zeroes the KDF-derived key (`key.fill(0)`) before throwing `WrongPasswordError`. |
| L-4, L-5, L-7, L-8 | ⏸ Deferred | Open hardening items tracked in `BUILD_STATE.md` — opaque pick-token import redemption, `lstatSync` symlink guard in `expandPaths`, build-script archive containment, `npm ci` + lockfile in the build pipeline. |

Every fix added or extended unit tests; `npm test` stays green (1119 passed / 25 skipped),
typecheck clean, production build OK. Behavior changes are recorded in
[`security-model.md`](security-model.md) (parser caps, policy fail-closed, env-override
gating) and `BUILD_STATE.md`.

---

## MEDIUM findings

### M-1 — No file-size cap anywhere in the ingestion path

**Where:** [`parsers/txt.ts:10`](../apps/desktop/src/main/services/ingestion/parsers/txt.ts#L10),
[`csv.ts:23`](../apps/desktop/src/main/services/ingestion/parsers/csv.ts#L23),
[`markdown.ts:17`](../apps/desktop/src/main/services/ingestion/parsers/markdown.ts#L17),
[`pdf.ts:54`](../apps/desktop/src/main/services/ingestion/parsers/pdf.ts#L54),
[`image.ts:48`](../apps/desktop/src/main/services/ingestion/parsers/image.ts#L48).

`readFile(filePath, 'utf8')` / `readFile(filePath)` reads the entire file into a single
string/buffer in the main process with no size limit. The downstream chunk count is capped
(`chunker.ts` `maxChunks: 1000`), but that runs *after* the whole file is parsed and tokenized, so
it does not protect the parse step. A multi-GB text/CSV/PDF/image OOMs or freezes the main
process. `createQueuedDocument` already records `size_bytes`, so the value is on hand.

**Recommendation:** add a configurable max-bytes guard in `processDocument` before dispatching to
a parser, and a wall-clock timeout around `parser.parse`.

### M-2 — Unbounded PDF page loop in text extraction

**Where:** [`pdf.ts:62`](../apps/desktop/src/main/services/ingestion/parsers/pdf.ts#L62).

`for (let pageNumber = 1; pageNumber <= numPages; pageNumber++)` iterates `doc.numPages` with no
cap, awaiting `getPage` + `getTextContent` per page and accumulating `segments` in memory. pdfjs
allows tiny PDFs that declare enormous page counts / deeply nested resources. The OCR rasterizer
path has per-step timeouts and backpressure; the *text* parse has neither. **Recommendation:** a
max-page guard and/or a wall-clock timeout around the parse.

### M-3 — DOCX (zip) decompression bomb

**Where:** [`docx.ts:16`](../apps/desktop/src/main/services/ingestion/parsers/docx.ts#L16) →
`mammoth` → JSZip 3.x.

JSZip 3.x does not enforce an uncompressed-size limit, so a "zip bomb" `.docx` (a few KB that
inflate to gigabytes of `document.xml`) is fully inflated into memory, then mammoth builds an
in-memory DOM of it. With no pre-parse size/ratio guard this is a main-process OOM from a small
crafted file. **Recommendation:** combine with M-1 (pre-parse size ceiling) and, ideally, an
inflated-size ceiling.

> **Note on XXE (no finding):** DOCX XML is parsed via `@xmldom/xmldom@0.8.13`, which does **not**
> resolve external general/parameter entities or fetch external DTDs. No file-disclosure/SSRF via
> a crafted DOCX. Keep the pin current.

### M-4 — Missing/malformed `policy.json` fails open to permissive defaults

**Where:** [`policy.ts:37`](../apps/desktop/src/main/services/policy.ts#L37) (`DEFAULT_POLICY`),
[`policy.ts:70`](../apps/desktop/src/main/services/policy.ts#L70) (`mergePolicyObject`),
[`policy.ts:97`](../apps/desktop/src/main/services/policy.ts#L97) (`parsePolicy`).

`DEFAULT_POLICY` is developer-friendly: `allowUnverifiedModels: true`, `requireSha256Match:
false`, `allowPlaintextDevMode: true`. A **missing** `policy.json`, **malformed JSON**, or a
**partial/junk** file all degrade to these dev defaults — i.e. a corrupted policy **loosens**
toward dev rather than failing safe. The policy *precedence* is correct (policy can only restrict
the network ceiling, never expand it), and on a packaged build plaintext is additionally gated by
`isDev`, so the most security-relevant default — encrypted-by-default — still holds for a
commercial build. But model-integrity enforcement (`allowUnverifiedModels` / `requireSha256Match`)
rests **entirely** on the provisioning pipeline writing a restrictive `policy.json`
(`assertCommercialDrive`). If a shipped drive lacks it or it is corrupted, unverified models run.

**Recommendation:** in a packaged build, treat a *missing or malformed* `policy.json` as the
**strict commercial posture** (fail-closed), not the dev-friendly default. Reserve the permissive
defaults for `isDev`. This also defends against an attacker who deletes/corrupts `policy.json` on
a removable drive to weaken integrity checks.

### M-5 — `HILBERTRAUM_LLAMA_BIN` spawns an arbitrary, unverified binary

**Where:** [`sidecar.ts:42`](../apps/desktop/src/main/services/runtime/sidecar.ts#L42)
(`resolveLlamaServerPath`).

If `HILBERTRAUM_LLAMA_BIN` is set and the path exists, that binary is spawned, bypassing the
on-drive `runtime/llama.cpp/<os>/` location and any install-marker checks. More broadly, **the
sidecar binary is never integrity-verified before spawn** in the app — trust is placed entirely in
drive provisioning. An attacker who can set the process environment (or ships a malicious launcher
script) gets code execution as the app. The override is documented as a dev affordance and its
existence is validated, but it is honored in all builds.

**Recommendation:** ignore `HILBERTRAUM_LLAMA_BIN` (and `HILBERTRAUM_WHISPER_BIN`) in
packaged/production builds — gate them on `isDev`/developer-mode the way the offline guard is
gated — or verify the resolved binary against the `runtime-sources.yaml` hashes before spawn.

### M-6 — Placeholder-hash weight is installed unverified

**Where:** [`downloads.ts:298`](../apps/desktop/src/main/services/downloads.ts#L298).

The verify-before-trust ordering is correct for **real** hashes (stream to `.part`, verify, then
`renameSync` into place; a mismatch deletes the partial and fails). But a `placeholder` verify
reason still renames the file into the real weight path and marks the job `done` with
`unverified: true`. The file is now present and bit-for-bit unverified. This is *honest* (the
Models screen shows UNVERIFIED, the "verified" audit event is suppressed, and
`computeInstallState` reports `checksum_failed` outside developer mode), but whether such a model
can actually be **run** depends on `allowUnverifiedModels` — which defaults to `true` (see M-4). So
on a default-policy drive, a model fetched against a placeholder hash runs with no integrity check.

**Recommendation:** tie this to the M-4 fix — with a fail-closed packaged policy,
`allowUnverifiedModels` is false and the unverified weight cannot be loaded. Optionally refuse to
*download* against a placeholder hash entirely in a packaged build.

---

## LOW findings

### L-1 — Offline-guard loopback regex over-matches `127.*` hostnames

**Where:** [`offlineGuard.ts:22`](../apps/desktop/src/main/services/offlineGuard.ts#L22).

`/^127\./.test(h)` returns true for `127.evil.com` and `127.0.0.1.evil.com` — remote hosts wrongly
classified as loopback. This is a miss in *detection* only: the guard is detection-only by design
(audit M-S1), so a misclassification means a missing audit line, never an allowed-vs-blocked
decision. Contained, but `isLoopbackHost` is **exported** and could be misused as an allow-list by
future enforcement code. **Recommendation:** anchor the IPv4 form
(`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`) and document that the function must never gate enforcement.

### L-2 — No `https:`-only enforcement on download URLs

**Where:** [`manifest.ts` download validation](../apps/desktop/src/shared/manifest.ts),
[`assets.ts` `downloadToFile`](../apps/desktop/src/main/services/assets.ts).

`fetch` (undici) keeps TLS verification on by default (no `rejectUnauthorized: false`, no custom
agent — good), but a manifest may specify an `http://` URL and it is fetched in cleartext. SHA-256
still protects integrity (for real hashes), but cleartext leaks *which* model is fetched and is
downgrade-friendly. **Recommendation:** reject non-`https:` download URLs in `validateManifest` /
`planModelDownloads`.

### L-3 — `importPreflight` is ungated and unfiltered

**Where:** [`registerDocsIpc.ts:231`](../apps/desktop/src/main/ipc/registerDocsIpc.ts#L231).

Unlike `importDocuments`, this handler has **no `requireUnlocked()` gate and no string-array
type-filter**. A compromised renderer can pass arbitrary absolute paths and trigger a recursive
`statSync`/`readdirSync` walk of any directory. It returns only counts (no names/content), so it
is a filesystem-existence/count oracle plus a mild walk-amplification DoS, not a content leak.
**Recommendation:** apply the same string-array filter + `requireUnlocked()` that
`importDocuments` already uses.

### L-4 — `importDocuments` trusts renderer-supplied source paths

**Where:** [`registerDocsIpc.ts:122`](../apps/desktop/src/main/ipc/registerDocsIpc.ts#L122),
[`ingestion/index.ts` `expandPaths`/`createQueuedDocument`](../apps/desktop/src/main/services/ingestion/index.ts).

The handler correctly type-filters to `string[]`, requires unlock, and holds a doc-work lease — but
the path *values* are not constrained to the OS-picker output, so a compromised renderer can submit
any user-readable absolute path and have it copied (encrypted) into the searchable, exportable
corpus. There is no traversal *write* (destination is always `storeDir/uuid.ext`); this is
arbitrary local-file *read*/ingestion, inherent to a local-import feature but worth recording: the
renderer, not only the dialog, chooses the source. **Recommendation (defense-in-depth):** have
`pickDocuments` return opaque tokens that `importDocuments` redeems, rather than trusting
renderer-supplied paths.

### L-5 — `expandPaths` follows directory symlinks

**Where:** [`ingestion/index.ts` `walk()`](../apps/desktop/src/main/services/ingestion/index.ts).

`walk()` uses `statSync` (follows symlinks) and recurses into any `isDirectory()`. A picked folder
containing a symlink to e.g. `C:\Windows`, or a cyclic link, traverses outside the selection or
loops. Blast radius is "indexes files the user didn't intend" (only supported extensions are
added), not RCE. **Recommendation:** use `lstatSync` for directory entries (skip symlinks) or guard
cycles with a visited-realpath set.

### L-6 — KDF-derived key not zeroed on the wrong-password path

**Where:** [`workspace-vault.ts` `unlockEncryptedVault`](../apps/desktop/src/main/services/workspace-vault.ts) (~L630).

On a failed `verifyKey`, the derived `key` is left for GC without `fill(0)`. The data-key paths
*are* explicitly zeroed; this is a minor residual-in-heap exposure of the derived key, consistent
with the project's documented best-effort posture. **Recommendation:** `key.fill(0)` before
throwing `WrongPasswordError`, for symmetry.

### L-7 — Runtime-archive extraction doesn't prevent member traversal (build-time only)

**Where:** `scripts/fetch-runtime.ps1` (`Expand-Archive`), `scripts/fetch-runtime.sh` (`tar -xzf`).

These run on the drive **builder's** trusted machine, not in the shipped app, so this is a
build-pipeline concern, not an end-user runtime risk. Still, neither `Expand-Archive` nor `tar`
prevents `../` member traversal; if an attacker controlled both the runtime-sources URL and its
(placeholder) hash, a crafted archive could write outside `extract_to` at build time.
**Recommendation:** list/extract members explicitly with a containment check in the fetch scripts.

### L-8 — Mixed version pinning / lockfile discipline

**Where:** `package.json` (root + `apps/desktop`).

Radix and `tesseract.js` are exact-pinned; most others use caret ranges. Runtime deps are all
pure-JS, offline-safe, with **no analytics/telemetry/crash-reporter/updater packages** and no
native addons (`node:sqlite` is built-in). The integrity anchor is the committed lockfile.
**Recommendation:** confirm `package-lock.json` is committed and the provisioning/build scripts use
`npm ci` (not `npm install`) so a build cannot silently float a caret range to a newer minor.

---

## INFO / verified-clean (notable positives)

- **`tesseract.js` is correctly wired offline** — `langPath` → the drive's `ocr/` dir, `gzip:
  true`, `cacheMethod: 'none'`, explicit `workerPath` (with the `app.asar` →
  `app.asar.unpacked` rewrite). The library's CDN/cache-to-cwd defaults are all overridden
  ([`tesseract.ts:100`](../apps/desktop/src/main/services/ocr/tesseract.ts#L100)). **No phone-home.**
- **Rendered model output is XSS-safe** — `react-markdown` (no `innerHTML`/`rehype-raw`),
  `http(s)`-only href whitelist, on top of the strict CSP
  ([`Transcript.tsx:213`](../apps/desktop/src/renderer/chat/Transcript.tsx#L213)).
- **Workspace lifecycle IPC is exemplary** — `unlock`/`create`/`changePassword` type-guard the
  password, enforce a minimum length, gate `changePassword` on unlock, and **never log/audit the
  password** in any branch; wrong-password is a normal result, not a throw.
- **`transcribeDictation`** validates `Uint8Array`, non-zero, `≤ 64 MB`; the WAV transient is
  UUID-named and shredded in `finally`; raw errors stay local, friendly copy goes to the renderer.
- **`child_process.spawn` is always argv-array, never `shell: true`** (sidecar + whisper CLI);
  sidecars always bind `127.0.0.1` in production; the model path is a discrete argv element so an
  adversarial path is never shell-interpreted.
- **Verify-before-trust ordering is correct** for real hashes; placeholder hashes never *silently*
  pass (they surface as UNVERIFIED — see M-6 for the policy-default caveat).
- **Path-traversal guards** on weight (`weightPath`), runtime (`resolveWithinRoot`), and OCR
  destinations all `resolve()` + re-root under the drive.
- **Vault key hygiene** — KEK and old data keys zeroed after use on the primary paths; descriptor
  stores only ciphertext; the plaintext working DB + `-wal`/`-shm` are shredded on lock/quit, and
  `shredStalePlaintext` sweeps crash leftovers at startup.
- **Audit/log privacy rule holds** across every reviewed call site (ids/filenames/counts/enums
  only). `settings_changed` records only the three privacy-relevant keys and their values.

A handful of INFO-level consistency notes were also recorded: several DB-reading handlers (chat /
model / audit) leak the raw `"Workspace is locked — unlock it first."` string to the renderer when
called while locked (tone, not data — the docs/doctasks handlers added a clean message and the
others did not); `getAuditEvents`' limit clamp is `NaN`-permissive for a non-numeric input
(harmless, parameterized); and the whisper `filePath` argv could use a `--` terminator as
belt-and-suspenders (not exploitable — it sits after `-f`).

---

## Prioritized recommendations

1. **Add pre-parse resource caps (M-1, M-2, M-3).** A max-bytes guard in `processDocument` (the
   `size_bytes` is already available), a PDF max-page guard, and a wall-clock timeout around
   `parser.parse`. This closes the only systematic DoS class found.
2. **Fail closed on policy in packaged builds (M-4, and it neutralizes M-6).** A missing/malformed
   `policy.json` in a packaged build should adopt the strict commercial posture, not dev defaults.
3. **Gate the binary-path env overrides to dev (M-5).** Ignore `HILBERTRAUM_LLAMA_BIN` /
   `HILBERTRAUM_WHISPER_BIN` in production, or hash-verify the sidecar before spawn.
4. **Small hardening (L-1, L-2, L-3, L-6).** Anchor the loopback regex; require `https:` download
   URLs; type-filter + unlock-gate `importPreflight`; zero the derived key on the wrong-password
   throw.
5. **Build-pipeline hygiene (L-7, L-8).** Containment-check archive extraction in the fetch
   scripts; confirm committed lockfile + `npm ci`.

None of these block the MVP's stated offline/privacy guarantees, which hold as designed. The
MEDIUM items are the right next hardening wave before a commercial release.
