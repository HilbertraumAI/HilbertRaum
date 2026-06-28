# HilbertRaum — Backend Code Audit

**Date:** 2026-06-27
**Auditor:** Multi-persona read-only backend audit (Claude Opus 4.8)
**Branch:** `skills-tools-audit-2026-06-26` (HEAD `c26d361`)
**Scope:** Electron **main process** + shared/preload of `apps/desktop` (the only workspace). Read-only: no application code was modified.
**Method:** Documentation read first (CLAUDE.md, BUILD_STATE.md, `docs/`), then full reads of the security-critical core (crypto, vault, db, preload, IPC) plus eight subsystem deep-dives. Two headline findings were reproduced against the real `node:sqlite` driver.

> **Status: FULLY REMEDIATED across Phases 1–8** (branch `backend-audit-2026-06-27-fixes`). Every finding's disposition — code fix, doc fix, or accepted residual — is recorded in the per-finding close-out ledger at [`docs/architecture.md`](../docs/architecture.md) **§24** ("Backend audit (2026-06-27) — remediation close-out"). This report is retained as the historical deliverable; the working-paper remediation plan was deleted under the doc-lifecycle rule (recoverable in git history).

---

## 1. Executive summary

HilbertRaum is a mature, unusually well-hardened offline local-LLM workspace. It has been through **many** prior multi-persona audits (2026-06-09, -06-13, -06-14, -06-21, and the just-closed Skills & Tools audit), and it shows: the cryptographic vault, the offline posture, the Electron window hardening, the zip importer, the subprocess-spawn discipline, the FTS query sanitisation, the RRF fusion, and the embedding-mismatch guard are all **correct and well-tested**. Most classes of bug an auditor reaches for first (path traversal, ReDoS, SQL injection, prototype pollution, decompression bombs, orphaned processes, content in logs) have already been found and fixed in earlier rounds.

This audit therefore focuses on what those rounds did *not* cover, and the **single most consequential finding is a data-integrity bug introduced by the newest feature work** (the bank-statement/invoice "skills" tables):

- **DATA-1 (High):** `deleteDocument` cannot delete any document that a user ran the bank-statement or invoice extraction tool on. The `bank_statements`/`invoices` tables reference `documents(id)` **without** `ON DELETE CASCADE` and are **not** cleaned up by `deleteDocument`, so with `PRAGMA foreign_keys = ON` the `DELETE FROM documents` throws a foreign-key violation — *after* the function has already shredded the on-disk copy and deleted the chunks + embeddings. The result is a permanently corrupt, undeletable document. **Reproduced** against `node:sqlite`. This directly contradicts a documented invariant (known-limitations.md §39–46 states deletes are safe *because* the related tables declare CASCADE).

The other notable findings:

- **BL-1 (High):** the money scanner (`MONEY_RE`) matches a `dd.mm.20yy` date fragment as an amount, so a bank statement that prints a **value-date column** (Buchung + Valuta — common in DACH statements) can drop or mis-value real transactions.
- A cluster of **reliability gaps** around cancellation/timeouts: audio transcription during ingestion is uncancellable and unbounded (REL-1); OCR recognition and dictation have no per-operation timeout (REL-2/REL-3).
- A cluster of **honesty/quality** issues: a "across the whole document" coverage over-claim in multi-document scopes (RAG-1); the reranker silently no-ops on CJK/Thai corpora (EMB-1).
- A **trust-model** observation: a user-imported `kind: tool` skill can drive the Tier-2 bank/invoice/redaction tools with no trust gate (SEC-1) — bounded by a structural ceiling, but broader than the docs imply.

No Critical findings. No remote-exploitable issues (the app is offline by construction). The two High findings are both reachable through ordinary user journeys and both touch user data, so they should be prioritised.

**Counts:** 2 High · 9 Medium · 14 Low · 8 Info (plus numerous verified-clean areas recorded so they are not re-flagged).

---

## 2. Scope reviewed

| Area | Files |
|---|---|
| Crypto / vault | `services/security/crypto.ts`, `services/workspace-vault.ts`, `services/workspace.ts` |
| Data layer | `services/db.ts` (schema + migrations), delete/reindex teardown paths |
| IPC surface | `preload/index.ts`, `shared/ipc.ts`, `shared/types.ts`, all `ipc/register*Ipc.ts`, `ipc/chat-stream.ts`, `ipc/save-export.ts`, `ipc/inflight.ts` |
| Electron bootstrap | `main/index.ts`, `services/offlineGuard.ts`, `services/permissions.ts`, `services/policy.ts`, `services/audit.ts`, `services/logging.ts` |
| Ingestion / parsers | `services/ingestion/*` (index, chunker, limits, parsers: txt/markdown/csv/docx/pdf/pdf-layout/image/audio) |
| RAG / analysis | `services/rag/*`, `services/retrieval-scope.ts`, `services/fts.ts`, `services/analysis/*`, `services/context.ts`, `ipc/registerRagIpc.ts` |
| Doctasks / skills analysis | `services/doctasks/*`, `services/skills/categorizer.ts`, `services/skills/tools/*`, `services/skills/analysis/*` |
| Skills runtime | `services/skills/*` (installer, loader, manifest, registry, selector, suggest, autofire, run, run-controller, tool-runs, tool-registry, scope, doc-lock), `shared/skill-manifest.ts`, `ipc/registerSkillsIpc.ts` |
| Runtime / downloads | `services/runtime/*`, `services/launcher.ts`, `services/preflight.ts`, `services/downloads.ts`, `services/runtime-download.ts`, `services/models.ts`, `services/binary-verifier.ts`, `services/assets.ts` |
| OCR / transcriber / vision | `services/ocr/*`, `services/transcriber/*`, `services/vision/*`, `ipc/registerDictationIpc.ts`, `ipc/registerImagesIpc.ts`, `renderer/ocr/main.ts` |
| Embeddings / reranker | `services/embeddings/*`, `services/reranker/*` |
| Docs cross-checked | `CLAUDE.md`, `docs/architecture.md`, `docs/rag-design.md`, `docs/security-model.md`, `docs/known-limitations.md`, `docs/drive-layout.md`, `docs/model-policy.md`, `docs/packaging.md` |

**Out of scope:** the renderer/React UI (except where IPC contracts touch it), the packaging scripts beyond their security-relevant behaviour, and the actual llama.cpp/whisper binaries.

---

## 3. Backend architecture overview

HilbertRaum is a single Electron desktop app (`apps/desktop`) split into three sandboxed layers:

- **Renderer** — React/TS, no Node/network access; talks to main only through the typed `window.api` bridge in `preload/index.ts` (contextIsolation on, nodeIntegration off, sandbox on, strict CSP, navigation guards).
- **Preload** — the single allow-list of `ipcRenderer.invoke` wrappers. Nothing reaches main that is not declared here.
- **Main** — all privilege lives here: the SQLite workspace (`node:sqlite`), the encrypted-vault lifecycle, ingestion/RAG, the llama.cpp sidecar(s), OCR/whisper/vision subprocesses, downloads, and the skills subsystem.

**Storage.** One SQLite DB per workspace (`hilbertraum.sqlite`), opened with WAL + `foreign_keys = ON` + USB-tuned PRAGMAs (`db.ts:597`). In **encrypted** mode the entire DB file is encrypted at rest (`hilbertraum.sqlite.enc`) under a random data key; the password-derived KEK only wraps that key (descriptor-v2 envelope). Document copies and the diagnostics log are encrypted under the same data key. Unlock decrypts to a working file on the drive; lock re-encrypts + shreds.

**Key flows.**
- *Ingestion*: pick/drag → `expandPaths` → per-file `prepareDocument` (parse under byte/page/inflate/time caps → chunk → embed) → `finalizeDocument`. FTS5 mirror kept by triggers.
- *RAG*: question → embed query → hybrid retrieval (vector cosine over a resident decoded-vector cache + FTS5 keyword) → RRF fusion → optional rerank → grounded prompt → streamed answer with citations. Scope filtering is centralised in one `buildScopeFilter`.
- *Whole-doc analysis*: a per-document RAPTOR-lite summary tree + a per-chunk structured-extraction pass feed "summarise"/"list every X"/"compare" doctasks with honesty gates.
- *Skills*: instruction/tool packages discovered on disk (`app-skills/`, `user-skills/`) and indexed into the `skills` table; Tier-2 "tools" (bank/invoice extraction, redaction, categorize) run app-orchestrated over a single in-scope document, serialised by a per-document async mutex (`doc-lock.ts`).
- *Runtime*: `llama-server` spawned as a loopback sidecar (array argv, no shell), hash-verified before spawn, with a GPU→CPU fallback ladder.

**Concurrency model.** The main process is single-threaded JS; "concurrency" hazards are cooperative interleaving across `await` points. The codebase guards these with explicit arbiters (`ModelSlotArbiter`, the chat slot, the per-document lock) rather than relying on the event loop.

---

## 4. Documentation compliance summary

Compliance with CLAUDE.md's hard rules is **strong**:

| Rule | Status | Evidence |
|---|---|---|
| No cloud / hosted AI APIs | ✅ | Only `fetch` users are the two user-gated downloaders + loopback sidecar; offline guard tripwire; CSP `connect-src 'self'`. |
| No telemetry / analytics / remote crash reporting | ✅ | `policy.ts` hardcodes telemetry off; audit/log are local; `audit-ipc.test.ts` sentinel-greps every `runtime_events` row. |
| Never commit weights/user-data/logs | ✅ | Content-class tables documented; exports go only to user-chosen dialog paths. |
| Fully usable offline | ✅ | No automatic network calls in any core path. |
| User data local + encrypted by default | ✅ | Envelope vault, document cache + log encrypted at rest. |
| No hardcoded dev absolute paths | ✅ | Paths resolved from the drive root; dev-only env overrides ignored when packaged. |
| Windows first-class, mac/Linux supported | ✅ | Path handling, `windowsHide` (mostly — see REL-7), portable relative paths. |
| Clean service boundaries | ✅ | Factory + interface pattern (runtime/embedder/reranker/ocr/transcriber all swappable, mock variants). |

The **per-phase ritual** (tests green, docs updated, BUILD_STATE updated) is visibly followed — BUILD_STATE.md is an exhaustive 631 KB running log and each subsystem carries a §-numbered design record in `architecture.md`/`rag-design.md`. This is a healthy, well-documented codebase.

The gaps are in **drift**: a few docs describe superseded behaviour, and the newest skills tables broke one explicitly-documented data-integrity invariant without the docs catching up (see §5).

---

## 5. Documentation gaps and contradictions

### DOC-1 (High, contradiction) — known-limitations.md guarantees document deletes are FK-safe; the skills tables break that guarantee
`docs/known-limitations.md:39–46` states deletion "stays safe **only because** those membership/link tables declare `ON DELETE CASCADE`: the old app's direct `DELETE FROM documents` (with `PRAGMA foreign_keys = ON`) cascade-removes the orphan rows instead of raising a foreign-key violation." The bank/invoice tables added for the skills feature (`bank_statements`, `invoices`, and their children) reference `documents(id)` **without** CASCADE and are not manually cleaned up, so the documented guarantee is now false for any document with extractions. This is the documentation face of **DATA-1**. *Type: contradiction + code bug.*

### DOC-2 (Info, drift) — rag-design.md §3 still describes silent chunk-cap truncation
`docs/rag-design.md:138–139` ("once hit, remaining text is dropped and the document still reaches `indexed`") describes the **legacy** behaviour. The current code (`ingestion/index.ts:645–655`, `chunker.ts:239–246`) **rejects** an over-cap document with a "split it" error before the destructive chunk replacement. The two docs now contradict each other (the chunker's own comment is correct). *Type: doc gap.*

### DOC-3 (Low, drift) — E5 prefix omission is documented as a known ceiling but not in known-limitations
The E5 embedder runs without the model-card-required `query:`/`passage:` prefixes (`embeddings/e5.ts`), acknowledged in `rag-design.md` §12.1 as the reason `ragMinSimilarity` must stay 0 and the reranker is load-bearing — but it is not surfaced in `known-limitations.md` where a future maintainer would look for retrieval-quality caveats. *Type: doc gap.* (See EMB-3.)

### DOC-4 (Info) — `summary_cache` unbounded growth is documented in a SQL comment only
`db.ts:220` notes "the cache grows unbounded (eviction is a future policy)." This is an accepted v1 trade-off but is not in `known-limitations.md`. On a long-lived portable drive this table grows without bound. *Type: doc gap.* (See MAINT-3.)

### DOC-5 (Info) — SEC-1 trust posture is incidental, not documented
The docs frame Tier-2 tools as trusted/app-orchestrated, but nothing restricts a user-imported `kind: tool` skill from declaring and running them (SEC-1). Whatever the intended posture, it should be stated explicitly. *Type: doc gap.*

---

## 6. Security findings

> The security posture is the strongest part of the codebase. Findings here are mostly defense-in-depth completeness items; there are no exploitable Critical/High security holes given the offline, no-remote-code architecture.

### SEC-1 (Medium) — A user-imported `kind: tool` skill can drive Tier-2 tools with no trust gate
**Files:** `services/skills/tool-runs.ts:93–97` (`runnableToolNames`), `ipc/registerSkillsIpc.ts:299–347` (`startSkillRun`), `shared/skill-manifest.ts:417–435`.
`startSkillRun` gates on `enabled`/compatibility/confirm but **not** on `source === 'app'` / `trusted_level`. The manifest parser keeps a declared `allowedTools` for any non-instruction kind regardless of source, and `resolveEffectiveTools(declared, declared)` makes the "user grant" collapse to "whatever the package declared." So a user can import a `.skill.zip` with `kind: tool` + `allowedTools: ['extract_transactions','redact_document','export_transactions_csv', …]`, enable it, and run the app's bank/invoice/redaction machinery over their own documents.
**Why it matters:** broader than the "trusted product content only" mental model the docs imply. The blast radius **is** bounded by a structural ceiling — the tool context has no FS/DB/network handle, scope is a frozen single document, and write/export are confirm-gated to a user-chosen path — so this is **not** a privilege escape, but the trust decision is incidental rather than explicit.
**Fix:** either gate `runnableToolNames`/`startSkillRun` to `source === 'app'` until a real per-tool grant UI exists, or document deliberately that any enabled `kind: tool` skill (incl. user-imported) may run the wired tools, and add a test pinning the chosen posture. *Type: design gap + missing test.*

### SEC-2 (Low) — No `setPermissionCheckHandler` to complement the request handler
**File:** `main/index.ts:403–406`. Only `setPermissionRequestHandler` is installed. Electron's separate synchronous *permission-check* path (`navigator.permissions.query`, the `getUserMedia` check) is not covered, so it falls back to Electron's default. Deny-by-default is one API short of complete. **Fix:** install `setPermissionCheckHandler` returning `false` except the audio/dictation case from the app origin; add a unit test. *Type: defense-in-depth gap.*

### SEC-3 (Low) — No `will-redirect` navigation guard
**File:** `main/index.ts:424–427` (and OCR window `rasterizer.ts:89`). `will-navigate` is guarded but `will-redirect` is not; a server/meta redirect can reach a remote origin without firing `will-navigate`. Minimal practical risk under the prod `file://` + CSP, but it is the standard hardening pair. **Fix:** attach the same predicate to `will-redirect` on both windows. *Type: defense-in-depth gap.*

### SEC-4 (Low) — Pre-spawn binary verification is session-cached by path (verify→spawn TOCTOU widens to per-session)
**Files:** `services/binary-verifier.ts:147–165`, consumed at `runtime/sidecar.ts:312`, `runtime/gpu.ts:109–113`. `verifyBinaryBeforeSpawn` memoises the verdict per path for the whole session, so only the *first* spawn re-hashes; subsequent model switches / fallback restarts reuse the cached `ok`. A tamper that lands *after* the first spawn (then a model switch re-spawns) is not re-detected within the session. This is a deliberate, documented trade-off (the probe/start race needs one consistent decision). **Fix:** document the residual as session-scoped in `security-model.md`, or re-hash on every chat-sidecar spawn. *Type: accepted-risk to document.*

### SEC-5 (Low) — `imageAnalyze` raw bytes are not bound to the picker capability token
**File:** `ipc/registerImagesIpc.ts:178–229` vs the token path `:138–171`. The `chooseImage`/`readBytes` token (D2) protects *path-based* reads, but `imageAnalyze` takes `req.imageBytes` directly (required for drag-drop) and validates only size/MIME/pixels. A code-exec'd renderer (the stated threat) can still submit arbitrary bytes for analysis + history persistence. Confidentiality impact is limited (offline, bytes never leave the device). **Fix:** document the boundary, or require a token for picker-sourced analyses so only drag-drop uses raw bytes. *Type: documented-boundary clarification.*

### SEC-6 (Low) — `decodedPixelCount` returns `null` for malformed headers, silently disabling the pixel-bomb cap
**File:** `services/vision/limits.ts:99–103, 138–141`. The decompression-bomb guard (D4) only applies when the PNG/JPEG header parses; a crafted-but-claimed png/jpeg whose minimal parser returns `null` falls through to byte-cap-only (20 MiB). Narrow window, low likelihood. **Fix:** treat a `null` pixel count for a claimed png/jpeg as suspicious (reject or apply a stricter byte cap). *Type: defense-in-depth gap.*

### SEC-7 (Info) — Verified clean (recorded so they are not re-investigated)
Crypto/vault: Argon2id default + scrypt legacy, descriptor-bound KDF params with sane bounds, GCM verifier checked before any DB decrypt, streaming file crypto with atomic temp+rename, key zeroing on lock and on wrong-password, journaled v1→v2 rekey that recovers old-or-new per file. Zip importer: enumerate-before-inflate, path/symlink/extension/size re-validation, content-free error codes, no zip-slip. Manifest parsing: no eval/Function/require of package content, no prototype-pollution sink (own-enumerable `__proto__`, fresh sanitized object). Subprocess spawns: array argv, no shell, hash-verified, drive-root escape guards. Offline guard: IPv4-anchored loopback check, fails safe. Audit/log: ids/counts/filenames only, sentinel-grep enforced, log encrypted at rest. Confused-deputy: picker capability tokens; drag-drop symlink-rejected + realpath-canonicalised.

---

## 7. Correctness and business-logic findings

### BL-1 (High) — `MONEY_RE` matches a `dd.mm.20yy` date fragment as an amount → dropped/mis-valued transactions on value-date statements
**Files:** `services/skills/tools/money.ts:42` (`MONEY_RE`), `services/skills/tools/bank-statement.ts:103–125` (`parseLine`).
`MONEY_RE = /[-+(]?\s{0,4}\d[\d.,]{0,30}[.,]\d{2}\s*\)?-?/g` reads the `.20` of a day-first year as a 2-decimal tail, so a printed date matches as money. `parseLine` strips only the **first** whitespace token as the booking date. A statement that prints **both** a booking date and a value date (Buchungstag + Wertstellung/Valuta — common in DACH bank statements) leaves the value date inside `rest`:
- value date leading `rest` → `first = matches[0]` at index 0 → `description = ''` → the row is **silently dropped** (`if (!description) return null`).
- value date trailing the description → the date fragment becomes the **amount** (`parseAmount('01.04.20') → 1.04`), a wrong figure.
**Why it matters:** the bank-statement skill's entire value proposition is correct financial figures. Dropped rows undercount; a mis-parsed amount feeds the verified total. **Mitigations** (why High, not Critical): the auto-run path uses geometry layout reconstruction (`layout: true`, bank only) which may reorder columns; and the completeness gate (`opening + Σ == closing`) can downgrade a mis-summed statement to `contradicted`/`unverified` rather than presenting a wrong "verified" total — but a legitimately-complete statement can be wrongly flipped to `contradicted`, and the line-parser fallback + the invoice path (no layout pass) remain exposed. **Fix:** strip recognised leading date column(s) before the money scan (run `parseDate` on each leading token, not just the first), or tighten `MONEY_RE` with a negative lookahead so a `\d{2}` decimal tail cannot be immediately followed by two more digits forming a year. Add a 4-column `Buchung Valuta Betrag Saldo` fixture. *Type: code bug + missing test.*

### BL-2 (Medium) — `assessCompleteness` / `reconcileBalances` sum amounts across currencies
**File:** `services/skills/tools/bank-statement.ts:277–297` (`assessCompleteness`), `:457` (`reconcileBalances`). `sumCents += toCents(r.amount)` ignores `r.currency`, then compares against opening/closing. On a mixed-currency statement the tie is meaningless, so the status can spuriously pass (`complete`) or fail (`contradicted`). `buildBankAnswer` currently guards by checking mixed currency *first*, so the misleading total is suppressed today — but `isStatementComplete` is a public, unit-pinned predicate and a future caller trusting the status would be misled. **Fix:** return `unverified`/unknown when rows are not single-currency (mirror the `summarizeCashflow` `currencies.size === 1` guard). *Type: code bug (latent).*

### RAG-1 (Medium) — Coverage listing over-claims "across the whole document" in a multi-document scope
**Files:** `services/analysis/extract.ts:296–367` (`aggregateExtractions`), `services/analysis/listing-answer.ts:82–84`, `ipc/registerRagIpc.ts:52–61`. `fullyChunked` is computed as "no in-scope indexed doc has a NULL `fully_chunked` marker" — independent of whether extraction actually ran over those docs. `buildListingAnswer` then selects the wording purely on that flag, while the router gate only requires that *some* `__scan__` marker exists anywhere in scope (`LIMIT 1`). So a 2-document scope where extraction ran on only one document still prints *"across the whole document"* even though `scannedChunks < totalChunks`. This is exactly the over-claim the H7 honesty invariant forbids (`fully_chunked` proves "stored chunks are complete," not "we scanned every document in scope"). **Fix:** gate `coverageWhole` on `fullyChunked && scannedChunks >= totalChunks`, or scope the counts to documents that actually have extraction records. *Type: correctness/honesty bug.*

### BL-3 (Low) — `categoryTotals` aggregates signed amounts across currencies into one figure
**File:** `services/skills/analysis/bank-statement.ts:271–289`. `entry.amount += row.amount` has no currency key; the breakdown is currently rendered only on the single-currency branch, so it is gated in practice, but the function itself is currency-blind and any reuse outside that branch mixes currencies. **Fix:** key the accumulator by `(category, currency)` or assert single-currency input. *Type: latent code bug.*

### BL-4 (Low) — Redaction misses US-ordered and 2-digit-year dates; never masks names/addresses
**File:** `services/skills/tools/redaction.ts:99–161`, `money.ts:98–109` (`parseDate`). `maskDates` validates candidates with the **day-first** `parseDate`, so `04/13/2026` (read as day 4, month 13 → invalid) is left unmasked; `01.02.26` (2-digit year) is unsupported. Names/addresses/long account numbers are never masked. This is the documented best-effort posture and there is **no path where masked text is un-masked or detected values reach a log/audit** (verified) — it is under-detection, not a leak of restored content. **Fix (optional):** note the date-locale asymmetry in known-limitations, or mask any `parseDate`-shaped candidate regardless of validity if privacy-maximal masking is the goal. *Type: doc gap / by-design.*

### BL-5 (Info) — CSV rows wider than the header are silently truncated
**File:** `services/ingestion/parsers/csv.ts:33–39`. Output iterates `header.map`, so cells in a data row **beyond** the header width are dropped from the extracted/embedded text — silent content loss (unsearchable, no failure signal) for ragged CSVs. **Fix:** iterate `Math.max(header.length, row.length)` and emit bare/`colN:` values for overflow columns. *Type: code bug.*

---

## 8. Reliability and operational findings

### REL-1 (Medium) — Audio transcription during ingestion is uncancellable and time-unbounded
**Files:** `services/ingestion/parsers/index.ts:38–49` (no `signal` on `ParseContext`), `services/ingestion/index.ts:629–635` (audio exempt from the parse timeout), `services/ingestion/parsers/audio.ts:142–146`, `services/transcriber/cli.ts:172–234`. The ingestion code threads no `AbortSignal` into the audio parser and explicitly skips `withParseTimeout` for audio; `WhisperCliTranscriber` installs an abort listener that is never armed (no signal supplied) and has **no per-spawn timeout**. Cancelling an audio-import doc task is therefore a no-op for the in-flight whisper child, and a pathological audio file that makes whisper spin hangs that ingestion slot indefinitely. **Fix:** add `signal?: AbortSignal` to `ParseContext`, pass `task.controller.signal` through `AudioParser.parse → transcribe`, and add a generous per-spawn watchdog that kills + rejects. *Type: code bug + missing test.*

### REL-2 (Medium) — OCR recognition has no per-page timeout/abort; one image can wedge the shared worker
**File:** `services/ocr/tesseract.ts:87–134`. `recognize()` checks `signal.aborted` only *before* `await worker.recognize(image)`; once the WASM recognition is in flight it cannot be interrupted and has no timeout. Because recognitions are serialised through `this.chain`, a single crafted/huge image in a 500-page scan can wedge OCR for the whole session, and the user's Cancel only takes effect between pages. **Fix:** wrap `worker.recognize` in `Promise.race` with a per-page timeout; on timeout/abort `terminate()` the worker (recreated lazily) and reject so the chain recovers. *Type: code bug.*

### REL-3 (Medium) — Dictation IPC has no timeout, no cancellation, no concurrency guard
**File:** `ipc/registerDictationIpc.ts:41–67`. `transcriber.transcribe(tempPath, { workDir })` is called with no signal, no wall-clock bound, and no guard against concurrent invocations (whisper is not internally serialised). A wedged child on a malformed 64 MB WAV hangs the mic spinner forever; rapid mic presses spawn N concurrent whisper processes. **Fix:** pass an `AbortSignal` + a max-duration timeout, and serialise (or reject) concurrent dictations. *Type: code bug.*

### REL-4 (Medium) — OCR PDF page images have no byte/pixel cap on the IPC-returned PNG
**Files:** `renderer/ocr/main.ts:24–59`, `services/ocr/rasterizer.ts:182–190`. The rasterizer caps canvas *dimensions* (`MAX_RENDER_PIXELS` ~4096/side) but the resulting PNG `Uint8Array` is returned to main and fed to `worker.recognize` with no size check — unlike the vision path, which enforces `VISION_MAX_IMAGE_BYTES` + a header pixel-bomb cap. A crafted PDF rasterising near the cap across many pages (with the 1-deep look-ahead holding two PNGs resident) can drive main-process memory hard. **Fix:** add a byte cap on the returned PNG mirroring the vision subsystem; justify/lower `MAX_RENDER_PIXELS` against worst-case RGBA + PNG-encode memory. *Type: defense-in-depth gap.*

### REL-5 (Medium) — Document preview re-parse bypasses the entire ingestion cap stack
**File:** `services/ingestion/index.ts:954–961` (`extractDocumentPreview`), `:994–1014` (`extractDocumentPreviewPage`). `prepareDocument` wraps parsing in pre-parse byte cap + `withParseTimeout` + `maxPages` + `maxInflatedBytes`. The preview re-parse threads **none** of them (only `maxPages` in layout mode) and re-extracts the **whole** document per "Show more" page. A pathological-but-already-indexed file (e.g. a 4000-page PDF) re-parses on every preview with no wall-clock timeout, wedging the main process where import would have killed it. The stored-file byte ceiling is the only cap still effectively in force. **Fix:** resolve `IngestionLimits` in the preview path and pass `maxPages`/`maxInflatedBytes`; wrap non-audio previews in `withParseTimeout`. *Type: code bug.*

### REL-6 (Low) — Transcriber transient transcript defaults to OS tmpdir, outside the crash sweep
**File:** `services/transcriber/cli.ts:117`. `join(opts.workDir ?? tmpdir(), ...)` — when `workDir` is omitted, the whisper `-oj` transcript (recognised speech = content) lands in the OS tmpdir, which `shredStalePlaintext` never reaches. Both production callers pass `workDir`, so the default is not hit today, but it is a latent privacy trap for any future caller. **Fix:** make `workDir` required (no tmpdir fallback), or fall back to a workspace `.parse`-named dir the sweep covers. *Type: latent bug.*

### REL-7 (Low) — Sidecar + GPU-probe spawns omit `windowsHide`
**Files:** `runtime/sidecar.ts:329–331`, `runtime/gpu.ts:118`. The two highest-frequency spawns (every model start; once-per-session `--list-devices`) lack `windowsHide: true`, unlike the tar spawn and transcriber CLI. On Windows a console-subsystem child can flash a console window. Cosmetic but inconsistent with the codebase's own discipline and the non-technical-buyer polish bar. **Fix:** add `windowsHide: true` to both. *Type: polish/consistency.*

### REL-8 (Low) — GPU probe child is not tracked by `shutdown()`
**File:** `runtime/gpu.ts:115–151`. The probe child is held only inside the `probeGpuDevices` promise; `shutdown()` (`index.ts:461`) doesn't know about it. It self-cleans via a 10 s SIGKILL, but an app quit during a wedged probe briefly orphans it. **Fix:** `child.unref()` after spawn and/or register the in-flight probe so `shutdown()` can kill it. *Type: minor lifecycle gap.*

### REL-9 (Low) — `expandPaths` follows symlinked directories with no visited-set or depth cap
**File:** `services/ingestion/index.ts:1406–1432` (esp. `:1428`). The non-Dirent fallback `statSync`-follows links and recurses into linked directories with no cycle guard; a symlink cycle (`a/loop -> ..`) drives unbounded recursion → stack overflow on import preflight/expansion. User-initiated, so bounded, but a self-referential tree hangs the walk. (Distinct from the path-escape angle already noted in audit-2026-06-14 L-5.) **Fix:** track visited `realpathSync` dirs in a `Set`, or cap recursion depth. *Type: code bug (DoS).*

### REL-10 (Low) — `resolvePageYear` spreads a whole page's y-array into `Math.max(...)`
**File:** `services/ingestion/parsers/pdf-layout.ts:443–446`. `Math.max(...ys)` / `Math.min(...ys)` spread every positioned fragment's y as function args; a crafted page with hundreds of thousands of fragments throws `RangeError: Maximum call stack size exceeded`. Layout mode only (bank seam), but reachable via the preview layout path which (per REL-5) has no timeout backstop. **Fix:** compute min/max with a single loop/`reduce`. *Type: code bug.*

---

## 9. Data / database findings

### DATA-1 (High) — `deleteDocument` corrupts and cannot delete a document that has bank/invoice extractions
**Files:** `services/ingestion/index.ts:1361–1378` (`deleteDocument`), `db.ts:315–324` (`bank_statements` FK), `:381–397` (`invoices` FK), called un-transacted from `ipc/registerDocsIpc.ts:467–474`.
`bank_statements.document_id` and `invoices.document_id` reference `documents(id)` with **no** `ON DELETE CASCADE`, and `deleteDocument` deletes only `embeddings`, `chunks`, and the `documents` row — it never touches the bank/invoice tables. With `PRAGMA foreign_keys = ON`, the final `DELETE FROM documents` throws `SQLITE_CONSTRAINT_FOREIGNKEY`. Because the function runs **un-transacted** and the failing delete is **last**, by the time it throws it has already:
1. `shredFile(stored_path)` — destroyed the on-disk copy,
2. deleted the document's `embeddings`,
3. deleted the document's `chunks`,
then thrown — leaving a `documents` row with `status='indexed'`, zero chunks, no stored file, orphaned `bank_statements`/`bank_transactions`/`invoices`, no audit event, and an unhandled error to the renderer. Every retry re-throws at the same point, so the document is **permanently corrupt and undeletable**.

**Reproduced** with the real driver:
```
$ node fkcheck.mjs   # documents + bank_statements, FK without CASCADE, foreign_keys=ON
DELETE THREW: ERR_SQLITE_ERROR — finding CONFIRMED
```
Trigger: run the bank-statement or invoice skill tool on a document (creates the rows), then Remove the document.

**Why it matters:** silent data corruption + a hard failure on a routine user action, on user financial data, with no recovery path in the UI. It also contradicts the explicitly-documented safety invariant (DOC-1). The schema authors clearly knew the pattern — the `document_collections` comment (`db.ts:144–147`) calls CASCADE "load-bearing... without CASCADE a delete would hit an FK violation and dangling rows" — but the later-added skills tables were not given the same treatment, nor manual cleanup.

**Fix (preferred):** add `ON DELETE CASCADE` to `bank_statements.document_id` and `invoices.document_id` (and confirm the child tables — `bank_transactions`/`bank_corrections`/`invoice_line_items` — cascade from their parents or are deleted in FK order), **and** wrap `deleteDocument` in a single transaction so a future FK miss rolls back instead of half-committing. As a migration, since `CREATE TABLE IF NOT EXISTS` cannot alter existing FKs, either rebuild the tables or add an explicit ordered manual delete of the bank/invoice rows in `deleteDocument`. Add an integration test that runs an extraction then deletes the document. *Type: code bug + schema gap + missing test + doc contradiction.*

### DATA-2 (Low) — Compare-path `decodeVector` lacks the truncated-blob guard every other call site has
**File:** `services/doctasks/manager.ts:1175, :1201`. `decodeVector(blob, dims)` throws `RangeError` when `blob.length < dims*4`; `resident-cache.ts:96` and `node-vectors.ts:203` guard this first, but the two compare-path decodes do not — a single physically-truncated `vector_blob` crashes the whole compare task instead of skipping the bad row. **Fix:** move the `length < dimensions*4` guard into `decodeVector` (skip/zero), or replicate the per-row skip. *Type: robustness gap.*

### DATA-3 (Info) — `summary_cache` grows unbounded
**File:** `db.ts:221–230`. No size/age eviction in v1 (documented in the comment, not in known-limitations). On a long-lived drive this table grows without bound. **Fix:** add an LRU/age eviction policy, or at least document the growth in known-limitations + expose it in diagnostics. *Type: maintainability.* (See MAINT-3.)

### DATA-4 (Info) — `documentApproxTokenTotal` reads without `ORDER BY` while `retrieveWholeDocument` reads ordered
**File:** `services/rag/index.ts:421–428`. The token *sum* is order-independent so this is harmless today, but the budget computation and the actual read use different query shapes; a future change to early-out would silently diverge. **Fix:** none required; optionally add `ORDER BY chunk_index` for consistency. *Type: note.*

**Verified clean:** FKs are enforced (`foreign_keys = ON`); migrations are idempotent (`ensureColumn`/`ensureChunksFts` guarded, identifier-validated against injection at `db.ts:459–462`); FTS5 mirrors are trigger-synced and self-contained (VACUUM-safe); `deleteConversation` deletes messages in correct FK order; `extraction_records`/`tree_nodes`/`document_collections`/`conversation_documents`/`image_turns` all CASCADE correctly; the prepared-statement cache is keyed by constant SQL only.

---

## 10. API / contract findings

### API-1 (Low) — Chat IPC handlers surface a raw, unlocalized "Workspace is locked" instead of `requireUnlocked()`
**File:** `ipc/registerChatIpc.ts` (all DB-touching handlers, e.g. `:78, :148, :164, :270`). `registerDocsIpc`/`registerCollectionsIpc`/`registerDocTasksIpc` each define a `requireUnlocked()` that throws a localized friendly message; `registerChatIpc` has none, so a locked-vault chat call reaches `ctx.db` and throws the raw English `'Workspace is locked — unlock it first.'` (`workspace-vault.ts:749`). Not a security hole (operation still blocked, no sensitive data in the string) and normally unreachable behind the renderer unlock gate, but it is an inconsistency. **Fix:** add the `requireUnlocked()` preamble to the chat handlers + a test. *Type: consistency + missing test.*

### API-2 (Info, documented residual) — `importPreflight` accepts raw renderer paths and drives a recursive directory walk
**File:** `ipc/registerDocsIpc.ts:461–465` → `summarizeImportPaths` → `expandPaths`. Unlike `importDocuments` (token-bound) and `imageReadBytes` (token-bound), `importPreflight` takes raw paths and recursively walks them, returning counts/sizes only. Gated by `requireUnlocked()`, type-filtered, no content crosses the boundary, and explicitly documented as a lower-impact accepted residual (`security-model.md:792`). Noted for completeness: `expandPaths` `add()`s an explicit top-level path without verifying it is a regular file, so a code-exec'd renderer could use preflight as a metadata/existence oracle (counts only, no network sink). *Type: accepted residual.*

### API-3 (Info) — `documentCount` in skill-run audit/state is hard-coded to 1
**Files:** `services/skills/tool-registry.ts:293`, `ipc/registerSkillsIpc.ts:341`. Correct for the single-document v1 scope, but the field conveys nothing and must become real (not a constant) if multi-document tools arrive, else the audit understates scope. No privacy impact. *Type: future-proofing note.*

**Verified clean:** the preload bridge is a closed allow-list; every handler validates id/array shapes; exports always go to a `dialog.showSaveDialog` user-chosen path (`save-export.ts`); image/doc/skill-run jobs use async-with-polling consistently; unknown job ids resolve to terminal `failed` rather than throwing.

---

## 11. Testing gaps

| ID | Gap | Severity | Note |
|---|---|---|---|
| TEST-1 | **No test deletes a document that has bank/invoice extractions** (DATA-1). The `audit-ipc` suite deletes translation/compare/audio docs but never one with a tool run. | High | This would have caught DATA-1 immediately. |
| TEST-2 | No fixture for a **value-date (2-date) bank statement line** (BL-1) or a 4-column `Buchung Valuta Betrag Saldo` row. | High | Add to `skills-bank-statement-tool.test.ts`. |
| TEST-3 | No test for **multi-document coverage wording** where extraction ran on only some in-scope docs (RAG-1). | Medium | Pin `coverageWhole` vs `coverageSections`. |
| TEST-4 | No test for **cancellation/timeout** of audio ingestion (REL-1), OCR per-page (REL-2), or dictation (REL-3). | Medium | These are exactly the wedge paths users hit. |
| TEST-5 | No test for **CJK/Thai reranker truncation** (EMB-1) — the function returns the input unchanged and the reranker silently no-ops. | Medium | A CJK passage > context should still rerank. |
| TEST-6 | No **mixed-currency completeness** test asserting `unverified` (BL-2). | Low | |
| TEST-7 | No **truncated `vector_blob`** test for the compare path (DATA-2); other call sites guard but are also not adversarially tested. | Low | |
| TEST-8 | No **user-`kind:tool`-skill → runnable tools** test pinning the intended trust posture (SEC-1). | Medium | |
| TEST-9 | No **double-EOCD / duplicate-name zip** adversarial fixture for the installer (accepted residual). | Low | Pin the documented behaviour. |

Overall the suite is **large and high-quality** (2282 passing) with strong privacy sentinel-greps, teeth-verified regressions, and good integration coverage. The gaps cluster precisely around the newest feature surface (skills tool runs) and around cancellation/timeout behaviour, which the suite tends to test for completion but not for *interruption*.

---

## 12. Maintainability and refactoring opportunities

- **MAINT-1 — Centralise the document-teardown logic.** `deleteDocument` (ingestion), the reindex chunk-phase delete (`index.ts:667–687`), and `deleteBankStatementsForDocument` (skills/run.ts) each know a partial slice of "what hangs off a document." DATA-1 is a direct consequence of that knowledge being spread out. A single `purgeDocumentDerivatives(db, id)` (or comprehensive CASCADE) would make "everything derived from a document" one authoritative list.
- **MAINT-2 — Unify the truncation/token-budget helpers.** The E5 embedder uses CJK/Thai-aware `truncateToApproxTokens` while the reranker uses a naive whitespace word-split (EMB-1). A shared budget helper removes the divergence class.
- **MAINT-3 — `summary_cache` eviction policy** (DATA-3) — even a simple age/size cap with a diagnostics counter.
- **MAINT-4 — Make the cap stack a single decorator.** REL-5 (preview) and REL-1 (audio) both stem from cap enforcement being threaded per-call rather than wrapped once. A `parseWithLimits(parser, source, limits)` used by *every* parse entry point would make "did we cap this path?" un-missable.
- **MAINT-5 — Endianness assertion in the vector codec.** `codec.ts` assumes native LE with no guard; a one-line module-load assert documents and enforces the locked assumption at negligible cost (EMB-4).

---

## 13. Quick wins

These are low-effort, high-confidence, low-risk:

1. **REL-7** — add `windowsHide: true` to the sidecar + GPU-probe spawns (one line each).
2. **DOC-2** — correct rag-design.md §3 "Cap" to describe over-cap rejection (the chunker comment is already right).
3. **SEC-3** — add the `will-redirect` guard alongside `will-navigate`.
4. **DATA-2 / EMB-2** — move the `length < dimensions*4` guard into `decodeVector` so all callers are uniformly safe.
5. **REL-10** — replace the `Math.max(...ys)` spread with a loop in `resolvePageYear`.
6. **API-1** — add `requireUnlocked()` to the chat IPC handlers for a localized message.
7. **EMB-4** — add the LE endianness module-load assert to `codec.ts`.
8. **BL-5** — fix the CSV over-wide-row truncation (`Math.max(header.length, row.length)`).

---

## 14. Highest-priority recommended actions

1. **Fix DATA-1 (High).** Add `ON DELETE CASCADE` to the bank/invoice→document FKs (or explicit ordered cleanup in `deleteDocument`), wrap `deleteDocument` in a transaction, add the regression test (TEST-1), and update known-limitations.md (DOC-1). This is the one finding that silently corrupts user data on a routine action.
2. **Fix BL-1 (High).** Stop `MONEY_RE`/`parseLine` from reading a `dd.mm.20yy` date as an amount; add the value-date fixture (TEST-2). This protects the core correctness promise of the financial-extraction skill.
3. **Close the cancellation/timeout cluster (REL-1/2/3, Medium).** Thread an `AbortSignal` + per-operation timeout into audio ingestion, OCR recognition, and dictation so a single crafted input can never wedge a shared worker for the session.
4. **Fix the honesty/quality pair (RAG-1, EMB-1, Medium).** Gate the "whole document" wording on actual scan coverage; truncate reranker inputs token-aware so the reranker isn't a silent no-op on CJK/Thai.
5. **Resolve SEC-1 (Medium) deliberately.** Either gate Tier-2 tool runs to app skills, or document + test that user `kind:tool` skills may run them.
6. **Sweep the quick wins (§13).**

---

## 15. Open questions / assumptions

1. **DATA-1 migration:** is rebuilding the `bank_statements`/`invoices` tables to add CASCADE acceptable for existing drives, or is an explicit ordered manual delete in `deleteDocument` preferred? (Both close the bug; the table rebuild is the cleaner long-term shape but is a heavier migration.)
2. **SEC-1 intent:** are user-imported `kind: tool` skills *meant* to be able to run the bank/invoice/redaction tools, or is that an accident of the parser keeping `allowedTools` for any non-instruction kind? The fix differs accordingly.
3. **BL-1 layout coverage:** how reliably does the geometry layout reconstruction (`layout: true`) reorder a value-date column on the auto-run path? If it is robust, BL-1's practical impact is concentrated on the line-parser fallback + the invoice path; if not, it is broader.
4. **REL-1/2/3 product stance:** is "a wedged transcription/OCR can hang a slot until app restart" a known accepted limitation, or an oversight? It is not in known-limitations.md.
5. **Assumption:** I treated `PRAGMA foreign_keys = ON` as always in force (it is set unconditionally in `openDatabase`), and the main process as single-threaded JS (so "races" are await-interleavings). Both were verified in code.

---

*End of report. This is a read-only audit; no application code was modified. Two headline findings (DATA-1, and the FK semantics underlying it) were reproduced against the real `node:sqlite` driver; the remaining findings are cited to file:line and were verified by reading the code (and, for several, by the subsystem deep-dive agents running the relevant functions directly).*
