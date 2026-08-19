# BUILD STATE — HilbertRaum

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`CLAUDE.md`](CLAUDE.md)).
> It carries: current status, decisions, next actions, open issues — plus dated entries for
> the **currently-open waves only**. Shared data contracts live in
> [`docs/data-contracts.md`](docs/data-contracts.md) (§4 below is a pointer stub).

> **Retention rule (2026-07-12):** this file must stay readable in one pass — a hard budget
> (≤ 300 KB / ≤ 2,000 lines) is enforced by `repo-hygiene.test.ts`. At each wave close-out,
> after the durable design record is folded into the topic doc (CLAUDE.md doc lifecycle rule),
> move the wave's dated entries **verbatim, newest-first** to the top of
> [`docs/build-log.md`](docs/build-log.md). New entries stay short: outcome + pointers to the
> design record and commits, not a full narrative — the narrative belongs in the record.

> **Snapshot correction (2026-07-10):** the "UNPUSHED" / "UNMERGED" state notes inside earlier log
> entries were true when written but are snapshots — as of 2026-07-10 `master` is pushed (in sync
> with origin through `ac4f315`) and the 2026-06-30 audit branch stack is merged. Only the branches
> named in §5's branch analysis still carry unmerged work.

_2026-08-20 — **Stored-copy diagnostic REBUILT — issue #190 phase 1 (no hardware, no password, fully
CI-verified).**_ `architecture.md` §6 said the #188 root-cause diagnostic "was written and
smoke-tested against a synthetic vault" and only needed the owner's password. **It never existed**:
it lived in the git-excluded working paper and went with it at close-out — nothing matching it was
ever committed on any branch. So #190 checkbox 1 was never hardware-blocked; it was ordinary CI-able
work, and that is what this wave did. §6 now carries the correction and a new **§9** records the
tool as built. Shape: a **pure classifier + renderer** (`tests/helpers/stored-copy-audit.ts` — rows
+ a directory listing in, report out, no I/O), a **read-only collector**
(`stored-copy-audit-run.ts` — copy → decrypt the COPY → open `{ readOnly: true }` → probe the schema
→ query → walk `documents/` → shred the scratch), a **witness** (`read-only-witness.ts`), the
env-gated operator shell (`tests/manual/stored-copy-diagnostic.test.ts`), and both CI halves. It is
test-tree code on purpose — it must not ship in the bundle as dead code, and `tsconfig.web.json`
already typechecks `tests/`. Three things are load-bearing: every MUTATING vault entry point is
forbidden by name (`unlockEncryptedVault` commits/discards staged rekeys and can roll a `.recovery`
over the `.enc`; `openDatabase` writes the schema + ~20 `ensureColumn` calls just by opening), the
`stored_name` column is **probed** because the reporting drive predates #189, and the report is
public-issue-safe **by construction** (counts, two closed allowlists, 8-char shape tokens — no
titles, content, paths or file names, asserted against a vault full of planted secrets). Seven
mutations each turned the intended test red, incl. the dangerous one — a loose `.enc` match that
files a live `<id><ext>.enc.new` as an orphan. The first end-to-end operator smoke against a
synthetic drive earned its keep: it exposed a phantom orphan (a row whose corrupt strings name
nothing left its healthy copy unclaimed), fixed by making a file’s LEADING id a fourth ownership
source — over-counting orphans is the one error direction that can cost data.
**D4 rider:** orphans are NOT inert —
`listEncryptedDocSidecars` walks the directory, so a **v1** vault's first password change re-encrypts
every orphan and stages an `.enc.new` for each (a v2 rekey is O(1) and does not); that asymmetry is
why the report carries the descriptor version. **Deliberately not built:** any cleanup/sweep —
#190 checkbox 2 is an owner decision that needs the orphan count first. Suite 5363/361 files green.

_2026-08-19 — **Model occupancy — wave CLOSED (issues #185/#186).**_ The two issues the local-API
wave filed out of scope were one defect seen from two sides, and were fixed together as both asked.
"Who has the model" was answered by three registries and one hole: chat had `inFlightStreams`, doc
tasks had their queue, **skill runs had per-DOCUMENT bookkeeping that is not a global busy signal
(#186), and the benchmark had nothing at all (#185)** — so `startSkillRun` consulted neither of the
other two, and two Diagnostics clicks (or one during a chat answer) both reached the model. The
generation gate could not be the fix: it counts in-flight `chatStream` **pulls**, so a multi-step
job reads IDLE between two of its own calls and a guard riding it would admit a second job into that
gap. Shape: a **span** registry (`services/runtime/occupancy.ts`) on the `RuntimeManager`, held by
the three BACKGROUND lanes only — chat keeps `inFlightStreams` as its one record, and the guards
compose the sources (`ipc/model-busy.ts`) rather than mirroring them. `isExternallyBusy()` folds the
spans in, so the local API now waits on a background job honestly instead of slipping into its gap.
The skill lane is **declared in the descriptor table** (`SkillToolDescriptor.modelLane`), pinned to
the dispatch by a source test — `'direct'` (redact/edit) takes a span, `'doctask'`
(`categorize_transactions`) takes NONE, because its model call happens inside a task it enqueues and
a span there would refuse its own task (the D26 deadlock). Two non-guards are load-bearing: a doc
task never refuses on the doc-task span it holds itself (the #38 tree→extract chain enqueues from
inside `run()`), and **chat is never refused by the benchmark** — the first-run benchmark fires right
after unlock, so it YIELDS instead: the tokens/sec probe re-checks before it starts and on every
chunk and **discards** a contended reading, which matters because a depressed reading steps the
profile AND the recommendation down and is then PERSISTED (the one case where the issues'
"degraded, not corruption" understates it). The discard raises the new persist-canonical
`warnSpeedSkipped` — never a silent hole. **Durable record:** `docs/architecture.md` "Model
occupancy — design record (issues #185/#186, §1–§6)" — decisions D1–D8, the full exclusion table,
the leak posture, and what the wave deliberately did not do. **User-facing:**
`docs/troubleshooting.md` "The model is busy — one job at a time". Suite 5312/50; 39 new tests in
`model-occupancy.test.ts` + `model-occupancy-ipc.test.ts`. No hardware gate owed — every lane is
exercised by scripted fake runtimes.

_2026-08-19 — **MTP speculative decoding — wave CLOSED in code, TWO HARDWARE GATES OWED (issue
#182).**_ The Qwen3.8 GGUFs already contained a trained-in draft head (`blk.64.nextn.*`) that
llama-server loaded and ignored — the "unused tensor" warnings in every §4 log were the feature
sitting unused. `qwen3.8-27b-q4` and `qwen3.8-27b-q5` now carry a new manifest field
`speculative_decoding: mtp`, worth a **measured +38–45 % decode** on the §9.4 rig. Shape:
the manifest **opts in**, the start ladder **decides**. The field is a **closed enum** the runtime
maps to a fixed flag pair, never a free-form arg list — manifests are on-drive and user-editable,
and `buildArgs` appends extras LAST, so a smuggled `--host 0.0.0.0` would beat the loopback-only
invariant. Mechanism: a new **rung 1a** above the plain GPU rung, so rung 1 IS the automatic
fallback (an older runtime, a weight without the head, a driver refusal → one failed attempt, then
exactly today's behavior). Three guards, all conservative-by-construction because llama.cpp answers
a VRAM shortfall by *silently offloading fewer layers* rather than failing (the #42 class): the rung
is skipped unless the session-cached probe shows ONE device with the weight's bytes + 3.5 GiB free
(the measured sum — it independently reproduces "Q6_K does not fit 24 GB"); a rung-1a start failure
never persists `gpuAutoDisabled` and latches the model off for the session; a mid-session rung-1a
crash takes its own handler that restarts **on the GPU** with MTP off, instead of exiling the
machine to CPU over an optional speed-up. Forced-CPU rungs never carry the flags — that is issue
gate 3 ("harmless on CPU, or drop it off-GPU") closed structurally, without hardware. "Try GPU
again" re-arms the latch. **Durable record:** `docs/architecture.md` "MTP speculative decoding —
design record (issue #182, §1–§7)" — decisions, the precondition arithmetic, the failure paths, and
what the wave deliberately did not do. Field reference: `docs/model-policy.md` "Manifest fields";
status + gate figures: `docs/model-benchmarks.md` §9.4 "Gate results". **Both hardware gates RAN
AND PASSED 2026-08-19 on the i9-9900X + RTX 3090 rig** (tracked in §5 item 8b): the §2 grounded-QA
re-run with MTP on held score parity inside cross-run tolerance for both quants (q4 F1 .3499 vs
.3500, q5 .3518 vs .3523; zero hallucinations and 1.0000 unanswerable-abstention held; 92/100 resp.
91/100 answers byte-identical, every diff a near-tie token flip), and the §9.1 smoke legs on the
b9849 pin passed for both quants incl. rung-1a selection, full offload with 24 GB headroom (peak
VRAM 19.7 / 21.5 GiB), clean teardown, and the shim-forced fall-through + re-arm legs. No RAM/VRAM
line was retuned: the manifests keep their pre-MTP measured numbers until re-measured with the
flag on.

_2026-08-19 — **Portable stored copies — wave CLOSED (issue #188).**_ `documents.stored_path` was
persisted **absolute** and consumed with a bare `existsSync` at six hand-written ladders, so a
portable drive returning under a different mount point took **every** stored copy stale at once —
row intact, bytes intact, only the recorded string wrong. It was the **last absolute path in
persisted state** (images, skills, checksum cache, runtime marker and `source_relative_path` had
each already been made portable by a named prior finding), and the vault layer already disagreed:
rekey enumerates `workspace/documents/` by directory walk. The reported export failure was the
SMALLEST of three defects sharing that cause: **"Delete document" silently did not delete** — the
shred's `existsSync` guard conflated "already gone, nothing to do" with "I looked in the wrong
place", leaving encrypted user content on the drive with no row left to ever reference it
(**measured** pre-fix, not inferred) — and re-index degraded a healthy row to `failed`. Fixed at
the **resolver**, not the reporting screen: new `services/ingestion/stored-copy.ts` +
`documents.stored_name` (portable leaf, lazily healed), adopted by all six sites including the
shred; `DocumentInfo.storedCopy` so the `⋯` menu stops offering what cannot succeed;
`original_path` demoted to a sha256-checked last resort. **Durable record:** `docs/architecture.md`
"Portable stored copies — design record (wave 188, issues #188/#190, §1–§9)" — decisions D1–D6, the
safety guard the shred rests on, the verified-clean list, and the bundler landmine (§8: a string
literal ending in the bare word `import` makes electron-vite wedge its CommonJS shim inside the
literal; typecheck and the full suite pass and only `npm run build` fails — now tripwired in
`repo-hygiene.test.ts`, and the standing argument for the typecheck → build → test gate order).
**STILL OPEN, both now tracked in issue #190 (see the 2026-08-20 entry above):** the real
relocated-drive run (the code is now correct; the second-laptop continuity check is only *answered*
by hardware), and the read-only root-cause diagnostic on the reporting drive — which §6 wrongly
claimed already existed. It has since been REBUILT and CI-proven (§9); running it on that drive
needs the owner's password and would settle whether its rows are in fact stale (the issue reports
"Vorschau works" alongside the export failure, and preview and export share one ladder, so both
cannot describe the same document) and count the orphaned `.enc` files past silent deletes left
behind.

_2026-08-18 — **Local API endpoint — wave CLOSED (P1–P6), PR #184.**_ The loaded chat model
can now be used by **other programs on the same computer** through an opt-in, loopback-only,
OpenAI-compatible endpoint — **off by default**, behind a consent dialog, access-key-protected by
default, existing only while the workspace is unlocked, and forbiddable by drive policy. The wave
also closed a latent gap it did not create: every `llama-server` sidecar is now authenticated with
a per-spawn env-delivered key, redacted from every stderr-derived surface. **Durable record:**
`docs/architecture.md` "Local API endpoint — design record (wave local-api, PR #184, §1–§9)" —
decisions D1–D9, owner options O1–O6, the as-built gate/HTTP/UX design, the deliberate omissions,
what the audits changed, and the §-anchor legend for the retired plan's citations. **Security half:**
`docs/security-model.md` "The fifth threat: same-machine processes". **Wire contract:**
`docs/data-contracts.md`. **User-facing:** `PRIVACY.md`, `SECURITY.md`, `docs/user-guide.md`
("Use HilbertRaum from other apps"), `docs/troubleshooting.md` ("Connecting another app").
Citations use PR # + the `local-api-p<N>` phase prefix + a record §, never a branch SHA (O6 —
the repo squash-merges). **Filed out of scope, deliberately** (pre-existing in-app concurrency the
new gate makes visible but does not serialize): the benchmark has no re-entrancy guard, and a skill
run can generate alongside a chat stream — filed as **#185** and **#186** (both CLOSED 2026-08-19, see the model-occupancy entry above). **Post-closeout fix (owner decision 2026-08-18, prompted by a REAL attached drive):** a `policy.json` that PREDATES `allow_local_api` now inherits the permissive default instead of a packaged build's STRICT base — otherwise every drive already in the field would have read "turned off by your drive's policy" with no way to distinguish that from a deliberate ban. An explicit `false` still denies (O4 intact); a junk value and a malformed file still fail closed. Recorded as **O4b** in the design record. **Real-model smoke DONE 2026-08-18** on a real attached drive (H:, prepared "lite", encrypted
workspace, pinned b9849 vulkan engine) against `gemma4-e2b-it-qat-q4` on GPU: default-off proven
with the vault unlocked, 401 unauthenticated, a real non-streaming completion and a full streaming
one, every Host/Origin/method/type refusal, **O5's dual loopback vindicated** (both `::1` and
`localhost` answer on this Win11 box), 4×~10k-char endurance streams, **D8 pre-emption**
(`preempted_by_user`, `[DONE]` absent) and **D7 lock kill** (`server_stopped` 449 ms BEFORE the
vault teardown — the pinned stop-first order). Evidence table in the design record §9. Remaining
manual gap: no PACKAGED-build smoke (this was a dev run via `HILBERTRAUM_DRIVE_ROOT`), and the
key-off/regenerate dialogs were not captured.

_Older dated entries (2026-08-16 and earlier) and the Skills S2–S12 handoff sections were
moved **verbatim** to [`docs/build-log.md`](docs/build-log.md) — 2026-07-09-and-earlier plus the
Skills handoffs on 2026-07-12, the 2026-07-10 block on 2026-08-09 (images-wave close-out, for the
retention budget), the 2026-07-11…2026-08-16 closed-wave block on 2026-08-18 (pre-wave archive
ritual) — citations of the form "BUILD_STATE <date> entry" / "BUILD_STATE V1" /
"Skills — Sn handoff" resolve there._

---

## 1. Current status

| Phase | Name | Status |
|---|---|---|
| 0 | Repo skeleton & tooling | 🟢 done |
| 1 | App shell, workspace & settings | 🟢 done |
| 2 | Model manifests & runtime contract | 🟢 done |
| 3 | Basic chat (mock runtime) | 🟢 done |
| 4 | Document ingestion & chunking | 🟢 done |
| 5 | Embeddings & vector search (mock) | 🟢 done |
| 6 | RAG chat with citations | 🟢 done |
| 7 | Hardware benchmark & recommendation | 🟢 done |
| 8 | Privacy & offline hardening | 🟢 done |
| 9 | Encrypted workspace | 🟢 done |
| 10 | Real llama.cpp runtime & embeddings | 🟢 done |
| 11 | Drive layout, scripts & packaging | 🟢 done |
| 12 | DIY asset loader (`fetch-assets`) | 🟢 done |
| 13 | Plug-and-play distribution (commercial drive) | 🟢 done |
| 14–16 | GPU acceleration (Vulkan distribution · probe/ladder runtime · surface) | 🟢 done 2026-06-10 — `architecture.md` GPU record §1–§8 |
| 17 | RAG trust & document-scoped asking | 🟢 done 2026-06-10 — `rag-design.md` §10 |
| 18 | In-app model downloader | 🟢 done 2026-06-10 — `architecture.md` "In-app model downloader" |
| 19 | Audit log (`runtime_events`) | 🟢 done 2026-06-10 — `architecture.md` "Audit log" + `security-model.md` |
| 20 | Answer-depth modes (Fast/Balanced/Deep) | 🟢 done 2026-06-10 — `architecture.md` "Chat & streaming" |
| 21 | Retrieval quality (reranker + hybrid FTS5 search) | 🟢 done 2026-06-10 — `rag-design.md` §11 (as built) + §12 (record); both manual measurements done |
| 22 | Signed offline update bundles | 🔴 blocked (key-management design) — outline in §5 item 3 |
| 23–27 | UI polish wave (tokens/theming · components · chat restructure · IA regroup · microcopy/ambient signal/first-run) | 🟢 done, merged to master 2026-06-10 — `docs/design-guidelines.md` (+ its §11 rollout record) |
| 28 | Model catalog wave 1 (challenger manifests, D16–D18/D22) | 🟢 done 2026-06-10 — 4 Apache-2.0 challengers, real hashes, all 10 catalog weights VERIFIED on `D:\`, bring-up smokes PASS |
| 29 | Benchmark protocol + first comparison run (D19/D20) | 🟢 done 2026-06-11 — judge-free QA+speed+RSS protocol run on all 8 models; RAM mins recalibrated, recommender quality-aware (`recommendation_rank`), Gemma thinking flag ON. Optional dev-box speed sweep = completeness only |
| 30 | Opt-in big slot + embeddings (D21 → D38–D43) | ⚪ retired 2026-07-12 unimplemented — Track A superseded by the Qwen3.5/3.6 pipeline (§5 item 8), Track B deferred post-MVP (§5 item 4); disposition `model-benchmarks.md` §9.2 |
| 31 | Conversation search + permission-handler rider | 🟢 done 2026-06-11 — wave-3 record §4 |
| 32 | Vault password change (descriptor v2 envelope) | 🟢 done 2026-06-11 — wave-3 record §5 |
| 33 | Document tasks foundation + one-click summary | 🟢 done 2026-06-11 — wave-3 record §6 |
| 34 | Document translation workflow | 🟢 done 2026-06-11 — wave-3 record §7 |
| 35 | Compare two documents | 🟢 done 2026-06-11 — wave-3 record §8 |
| 36 | Audio transcription as ingestion (whisper.cpp sidecar family) | 🟢 done 2026-06-11 — wave-3 record §9 |
| 37 | Voice dictation in the composer | 🟢 done 2026-06-11 — wave-3 record §10 |
| 38 | Scanned-PDF / photo OCR (tesseract.js + `ocr/` assets) | 🟢 done 2026-06-11 — wave-3 record §11; **wave 3 COMPLETE** |
| 39 | i18n foundation + proof slice (shared `t()` + catalogs, `uiLanguage` + picker, pre-unlock language) | 🟢 done 2026-06-13 — `architecture.md` i18n record (§3.1/§3.2 + R-L1 finding) |
| 40 | i18n renderer string sweep (all screens/components, plurals, dates/numbers, shared-component `t` prop) | 🟢 done 2026-06-13 — `architecture.md` i18n record §5 |
| 41 | i18n main-process boundary (emissions via `tMain()`, persist-canonical English + D-L4 display map, dialog titles) | 🟢 done 2026-06-13 — `architecture.md` i18n record §3.3 |
| 42 | i18n German QA + closeout (de review, text-expansion audit, eyeball walk, docs) | 🟢 done 2026-06-13 — **wave COMPLETE**; record + Phase-42 QA notes in `architecture.md`; German human review (D-L7) handed to the user |
| 43 | Invoice hardening (incident 2026-07-04: format-negation replay, reconciliation gating, glyph-soup refusal + geometry retry, recipient field, export BOM) | 🟢 done 2026-07-04 — `architecture.md` Skills record §42 |

Legend: ⚪ not started · 🟡 in progress · 🟢 done · 🔴 blocked

> Remaining for *release* = **manual acceptance only** (§5): a real signed/notarized build +
> a USB spec-§17 demo (R5/R7), the GPU hardware matrix (§5 item 1b), the Activity-panel
> live-UI eyeball, the packaged-app OCR smoke.

---

## 2. Environment (verified 2026-06-09)

| Tool | Status |
|---|---|
| Node | v24.13.0 ✅ |
| npm | 11.6.2 ✅ |
| corepack | 0.34.5 ✅ (pnpm available if needed) |
| git | 2.54.0.windows.1 ✅ |
| winget | available ✅ |
| Rust / Cargo / rustup | ❌ NOT installed |
| Python | ❌ NOT installed |

OS: Windows 11 Pro (10.0.26200). Shell: PowerShell + bash both available.
Repo root: the repo checkout (any path/drive — no path assumptions).

---

## 3. Decisions log

- **Stack = Electron + React + TS + Vite** (user choice; Rust not installed). Spec §4 permits Electron fallback.
- **Package manager = npm** with workspaces.
- **SQLite = `node:sqlite`** → fallback `sql.js` (WASM) if unstable. Avoid native `better-sqlite3`.
  ⚠️ **`node:sqlite` lives in the bundled Node of *Electron's main process*, not the system Node.**
  It needs Node ≥ 22.5. Electron 33 bundles Node 20 (no `node:sqlite`), so **Electron is pinned to
  `^37` (Node 22.x)**. Validate `node:sqlite` *inside Electron* at the start of Phase 1, not against
  system Node.
- **Mock-first:** `MockRuntime` + `MockEmbedder` so the app runs with zero model files. Real llama.cpp/embeddings deferred to Phase 10, behind the same interfaces.
- **Vector search = cosine over SQLite-stored vectors** for MVP.
- **Plaintext dev workspace allowed in dev**; encrypted is the commercial default (Phase 9).
- **YAML parsing = `yaml` npm package** (Phase 2 decision). Pure JS, no native deps, MIT, offline.
  Chosen over hand-rolling for reliability; parsing happens in the main process only. Validation is a
  hand-written pure function in `shared/manifest.ts` so it is shared with the renderer and unit-tested
  without I/O.
- **Manifest `local_path` is relative to the drive root** (existing Phase 0 manifests already include
  the `models/` prefix), so weight files resolve to `<root>/models/...`. Recommendation is data-driven
  via an optional `recommended_profiles` list on each manifest.
- **Ingestion parser libs (Phase 4): pure-JS, lazy-imported, externalized.** `pdfjs-dist` (PDF),
  `mammoth` (DOCX), `papaparse` (CSV) — no native deps, consistent with the `node:sqlite` choice.
  Imported lazily inside `parse()`. Marked **external** via `externalizeDepsPlugin` in
  `electron.vite.config.ts` (also externalizes `yaml`) so the large pdfjs ESM bundle is
  `require`/`import`-ed from `node_modules` instead of bundled (resolves R3). Main bundle shrank
  253 kB → 47 kB as a result.
- **PDF parsing approach (Phase 4):** use pdfjs-dist's **legacy** build
  (`pdfjs-dist/legacy/build/pdf.mjs`), which runs in the Node main process with **no Web Worker /
  no DOM** (validated). The `standardFontDataUrl` warning is harmless (rendering-only). Minimal
  ambient typings in `parsers/pdfjs.d.ts` (pdfjs ships no `exports` map for the legacy path).
- **Imported files are copied into the workspace** (`workspace/documents/`, `stored_path`), keeping
  `original_path` too → self-contained, re-indexable drive (spec privacy ethos). See Phase-4 contract.
- **Import = async with polling** (not the chat stream): documents table is per-file truth, job
  aggregate is in-memory via `getImportJob`. See Phase-4 contract for rationale.
- **Embedder placement (Phase 5):** `services/embeddings/` behind an `Embedder` interface
  (spec §9.2), mirroring `ModelRuntime`. A single `embedder` lives on `AppContext` (created in
  `main/index.ts` as `createMockEmbedder()`); the real E5/llama.cpp embedder is a localized
  Phase-10 swap. Ingestion takes the embedder as **optional deps** (`{ embedder?,
  embeddingModelId? }`) so Phase-4 callers/tests stay valid (no embedder → pass-through).
- **Vectors = `Float32Array`** (not `number[][]`) so BLOB encoding is a direct byte view and the
  real GGUF embedder fills typed arrays without conversion. **Dimensions = 384**, matching the
  E5-small manifest (`multilingual-e5-small-q8`) so the real swap is drop-in.
- **Embedding BLOB encoding (LOCKED):** `vector_blob` = raw little-endian Float32 bytes
  (`Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)`). Decode **copies** into a fresh
  4-byte-aligned buffer first (SQLite blobs can be unaligned → `Float32Array` view would
  otherwise `RangeError`). Tagged with `settings.activeEmbeddingModelId`, falling back to
  `embedder.id`.
- **Vector search = linear scan cosine** over the `embeddings` table for MVP (`VectorIndex`),
  with an ANN (sqlite-vec/HNSW) upgrade path behind the same `search` signature.
- **MockEmbedder = feature hashing** (SHA-256 tokens → signed buckets → L2-normalize),
  deterministic + fully offline (uses only `node:crypto`).
- **RAG service placement (Phase 6):** `services/rag/` (separate from `chat.ts`) holds the
  whole grounded path — `retrieve`, `buildGroundedPrompt`, `buildGroundedChatMessages`,
  `generateGroundedAnswer`, and the retrieval-settings mapper — reusing chat helpers
  (`appendMessage`/`listMessages`/`BASE_SYSTEM_PROMPT`) so the Phase-3 chat path is
  untouched. `askDocuments` is its own IPC module (`registerRagIpc.ts`).
- **Retrieval defaults (spec §7.8, LOCKED on `AppSettings`):** `ragTopKInitial = 12`,
  `ragTopKFinal = 6`, `ragMaxContextTokens = 2500`, `ragMinSimilarity = 0`. Read per request
  via `ragSettingsFrom(settings)`.
- **Dedup strategy:** dedup retrieved chunks by `(document_id, page_number)`, keeping the
  highest-scoring chunk per page. Page-less chunks (txt/md) are keyed by chunk id so they are
  **not** collapsed (page dedup would otherwise drop all but one window of a text file). The
  token budget always includes the single top chunk before enforcing `maxContextTokens`.
- **`[Sn]` labels assigned per query, never stored** (confirmed). Only the resolved
  `Citation[]` is persisted in `messages.citations_json`. **Retrieval is the source of truth
  for citations** — the mock runtime's echo has no real `[Sn]` markers, so computed citations
  are persisted directly (a real model emitting inline `[Sn]` still resolves against them).
- **`Citation.snippet` (additive):** `Citation` gained an optional `snippet` (truncated chunk
  text, ≤ `SNIPPET_MAX_CHARS` = 600) so the renderer's source panel shows the cited text and
  it survives reload via `citations_json`. Additive + optional → old rows are unaffected.
- **Grounding / empty-corpus copy:** when retrieval finds no usable chunks, the runtime is
  **not called**; a fixed `NO_DOCUMENT_CONTEXT_ANSWER` ("I couldn't find anything about that
  in your documents…") is persisted with no citations. Makes the no-hallucination guarantee
  deterministic + testable.
- **Grounded-prompt placement:** the grounded template (rules + question + numbered excerpts)
  replaces the **last user turn** sent to the runtime; the system message stays
  `BASE_SYSTEM_PROMPT`. The DB keeps the raw question (transcript/title).
- **Shared in-flight registry (`ipc/inflight.ts`):** chat + RAG share one
  `Map<conversationId, AbortController>` so the existing `stopGeneration` cancels either path.
- **Benchmark is strictly local (Phase 7):** `services/benchmark.ts` uses only `node:os` +
  `node:fs` + `node:crypto` — no `child_process`, no remote/GPU probes, no telemetry. A
  no-network assertion guards the whole path. Every probe is independently resilient: a
  failure yields a `null` value + a friendly warning, never a throw (a machine where
  everything fails still yields a valid `UNKNOWN` result).
- **Profile thresholds (spec §11.3, LOCKED):** RAM in **GiB** (`totalmem()/1024³`, rounded
  0.1); `≤8 → TINY`, `≤16 → LITE`, `≤32 → BALANCED`, else `PRO`; invalid RAM → `UNKNOWN`.
  **Downgrade rule:** `tokensPerSecond < VERY_LOW_TOKENS_PER_SECOND (3)` drops one step (never
  below TINY). **GPU rule:** a useful GPU bumps one step toward PRO (capped) — ~~GPU
  detection is best-effort `null` for now, dormant~~ **superseded by Phase 16**: the
  `--list-devices` probe feeds a precomputed `gpuUseful` hint (≥ 6144 MiB AND not
  integrated — `gpuUsefulForProfile`); `benchmark.ts` itself still never probes.
- **Drive-test bounds:** writes `DRIVE_PROBE_BYTES = 8 MB` of random bytes **inside the
  workspace**, times write (`fsync`) then read → MB/s; **always cleaned up** (`try/finally`);
  failure → `null` Mbps + `error`. **Slow-drive warning** at `< SLOW_DRIVE_MBPS (30)` MB/s —
  warn, never block.
- **Tokens/sec is optional in the mock era:** measured only when a runtime is active (prompt
  *"Write one sentence about privacy."*, up to 64 tokens); `null` otherwise. Real numbers land
  in Phase 10.
- **Benchmark persistence:** spec §8 has **no `benchmarks` table**, so the last result lives in
  the settings store as `AppSettings.lastBenchmark` (JSON `BenchmarkResult`, default `null`).
  **"Never benchmarked yet" default = `UNKNOWN`.** Both former stubs now read
  `lastBenchmark?.profile ?? 'UNKNOWN'`: `getAppStatus().hardwareProfile` and
  `buildModelList`'s `profile` (the `LITE` stub is gone). User-facing copy follows spec §11.4
  (never "your hardware is bad").
- **Policy shape + deny-by-default (Phase 8):** `services/policy.ts` models the spec §6
  `network`/`workspace`/`models` blocks as a camelCase `PrivacyPolicy`. `DEFAULT_POLICY` is
  **deny-by-default for network + telemetry** (both off); workspace/model defaults are
  developer-friendly (plaintext dev + unverified models allowed) since encryption enforcement is
  Phase 9 and model verification already gates on the `developerMode` setting. `config/policy.json`
  + `config/drive.json` are **optional**; missing/malformed → safe defaults **+ a warning, never a
  throw** (`bool()` only accepts real booleans, so junk fields can't weaken the policy).
- **Effective-network rule (LOCKED, Phase 8):** `networkAllowedByPolicy =
  allowModelDownloads || allowUpdateChecks`; `networkAllowed = networkAllowedByPolicy ∧
  user.allowNetwork`; `offlineMode = !networkAllowed`. A (future signed) policy is **authoritative**
  — it can only **restrict**, never expand, the user toggle. With no policy file the deny-by-default
  ceiling keeps the app offline even if `allowNetwork` is on (no network features ship before
  Phase 11 anyway). **Telemetry is always off** (no toggle, hardcoded `telemetryAllowed: false`).
- **`AppStatus.offlineMode` is now policy-aware** (was `!allowNetwork`); added
  `AppStatus.networkAllowed`. New `getPolicy` IPC (`policy:get`) returns `PolicyStatus` (effective
  policy + derived flags) so the UI distinguishes "off by choice" from "disabled by policy"
  (spec §3.6).
- **Loopback exception (LOCKED, Phase 8):** the offline self-check treats `127.0.0.0/8`, `::1`, and
  `localhost`/`*.localhost` as **not** network (dev renderer now; llama.cpp sidecar on 127.0.0.1 in
  Phase 10). Only remote origins are violations. `services/offlineGuard.ts`
  `installOfflineNetworkGuard` wraps `net.Socket.prototype.connect` and **only logs** a remote
  attempt — it never blocks or throws (a wrong host guess must not break local IPC/sidecar). The
  guard is installed in ALL builds when offline (an audit-round fix superseded the original
  dev-only gating); `assertOfflinePosture()` always logs the posture.
- **CSP dev-vs-prod split (Phase 8):** strict CSP applied as a response header
  (`session.webRequest.onHeadersReceived`) on top of the `index.html` meta tag. **Prod:**
  `default-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. **Dev:** relaxes `connect-src` to `ws://localhost:* http://localhost:*`
  and adds `'unsafe-inline'`/`'unsafe-eval'` to **`script-src`** (+ `'unsafe-inline'` on `style-src`)
  for Vite HMR (a strict policy breaks `npm run dev`).
- **Logs-local guarantee (Phase 8):** confirmed `services/logging.ts` is the only log writer
  (rotating `app.log` under `logsPath`); nothing writes logs/crash data off-device. Stated as fact
  on the Privacy screen + PRIVACY.md. **Superseded 2026-06-13 (encrypted-log change):** still the
  only writer, but on an encrypted workspace it writes `app.log.enc` (sealed under the vault key),
  not plaintext — see the "Encrypt the diagnostics log at rest" entry at the top + `security-model.md`.
- **KDF = Argon2id (default for new vaults), scrypt still supported (Phase 9 → audit round 2, R4):**
  NEW vaults derive the key with **Argon2id** (OWASP-recommended) via the pure-JS, audited
  **`@noble/hashes`** — no fragile native `argon2` build (the original R4 blocker). Default params
  `m=19456 KiB (19 MiB), t=2, p=1, keyLen=32` (~0.5 s/unlock). `node:crypto` **`scrypt`** is fully
  supported still (`SCRYPT_KDF` = `N=2^15, r=8, p=1`) so any vault created under the earlier scrypt
  default unlocks unchanged: the descriptor records `algo` + params and `deriveKey` dispatches on them
  — **no on-disk format change**. `KdfParams` fields are per-algo (`scrypt: N/r/p` · `argon2id: m/t/p`),
  validated in `deriveKey`. New dep: `@noble/hashes` (pure-JS, externalized like the parser libs).
- **Whole-DB-FILE encryption-at-rest (Phase 9, plan §4b):** `node:sqlite` has no SQLCipher, so the
  whole file is encrypted (AES-256-GCM, fresh 12-byte IV/encryption, 16-byte tag) — **the spec §8
  schema is identical in both modes**. At-rest artifact = `hilbertraum.sqlite.enc` (framed
  `MAGIC|iv|tag|ciphertext`). **On unlock:** verify password against an authenticated verifier (no
  DB touched) → decrypt `.enc` → `hilbertraum.sqlite` **on the drive** → `openDatabase`. **On lock/quit:**
  `PRAGMA wal_checkpoint(TRUNCATE)` + close → re-encrypt → `.enc` → **shred** the plaintext working
  file + `-wal`/`-shm`. The plaintext working copy on disk while unlocked is a **documented
  limitation**; secure-erase is **best-effort** on SSDs (wear-levelling).
- **Vault descriptor = unencrypted `config/workspace.json` (Phase 9):** settings (incl.
  `workspaceMode`) live INSIDE the encrypted DB, so the app can't read them pre-unlock. The
  descriptor `{ version, mode:'encrypted', kdf{algo,N,r,p,keyLen}, saltB64, verifier{iv,tag,ct} }` is
  the **only** pre-unlock artifact; it holds salt + KDF params + an AES-GCM **verifier** (known
  plaintext under the key) — **never** the password or key (both memory-only). Tests scan the
  descriptor + `.enc` and assert the password is absent.
- **Plaintext gating now ENFORCED (Phase 9):** `plaintextAllowed(policy, {isDev, developerMode})` —
  `workspace.encryptionRequired` is an absolute veto; `allowPlaintextDevMode` must be true; AND the
  caller must be a developer (dev build / developer mode). Pre-unlock `developerMode` is unreadable
  (in the encrypted DB) so `isDev` is the proxy. ⇒ a commercial build (not dev, encryptionRequired
  or no policy file) **defaults to encrypted** and onboarding never offers plaintext.
- **Lock-on-quit + Lock-now (Phase 9):** `WorkspaceController.lock()` runs on `will-quit` (alongside
  `runtime.stop()`) and from a sidebar **Lock now** button. `lock()` is a **no-op for plaintext_dev**
  (nothing to protect; closing it would wedge the app back into onboarding) — the plaintext DB just
  stays open until process exit. `db` on `AppContext` is a **getter** over the controller
  (`requireDb()` throws while locked), so all existing `ctx.db` call sites are unchanged and track
  unlock/lock at call time.
- **Sidecar discovery + env override (Phase 10):** `resolveLlamaServerPath(rootPath, platform, env)`
  finds `runtime/llama.cpp/<os>/llama-server[.exe]` (`win`/`mac`/`linux` sub-dirs, spec §6); a
  `HILBERTRAUM_LLAMA_BIN` env var overrides for dev. Pure `existsSync` — the "binary present?" check has no
  I/O surprises. `findFreePort()` picks a free **loopback** port (listen `127.0.0.1:0` → read → close;
  an inbound bind, not the outbound `connect` the offline guard watches).
- **Localhost-only binding (LOCKED, Phase 10):** every sidecar is spawned with `--host 127.0.0.1` and
  every fetch targets `http://127.0.0.1:<port>`. **Never** `0.0.0.0`/a routable interface. The Phase-8
  offline guard exempts loopback for exactly this; the no-network assertions assume loopback-only. A
  unit test asserts the spawn args + fetch URLs are `127.0.0.1`, never `0.0.0.0`.
- **OpenAI-compatible streaming endpoint (Phase 10):** `LlamaRuntime.chatStream` POSTs to
  `/v1/chat/completions` with `stream:true`, sending `messages` as plain role/content (**the server
  applies the model's chat template** — we never hand-roll Qwen's prompt format) and mapping
  `maxTokens`/`temperature`. `readChatSSE` parses `data:` frames (partial-line buffering, ignore
  keep-alives, stop on `[DONE]`), `yield`s each delta, honours `options.signal`. Feeds the **locked
  Phase-3 streaming contract** unchanged ⇒ `measureTokensPerSecond` reports **real** tokens/sec once a
  real runtime streams.
- **Real-embedder backend = `llama-server --embedding` (Phase 10, R6):** `E5Embedder` composes the
  **same** prebuilt `llama-server` binary (`--embedding --pooling mean`) over loopback `/v1/embeddings`.
  Chosen over ONNX (onnxruntime-node + tokenizer = a heavier **native** add) because it adds **zero new
  npm deps** and no fragile native build — consistent with the `node:sqlite`/pure-JS theme. **Lazy-
  started on first `embed()`** and reused; an additive optional `Embedder.stop()` kills it (wired into
  `will-quit`). Same **id (manifest) + 384 dims + L2-normalized** output ⇒ drop-in behind the
  `Embedder` interface; the locked Float32 BLOB encoding + `VectorIndex` are unchanged.
- **Embedding-model-mismatch handling = filter by id (LOCKED, Phase 10):** mock (`mock-embedder`) and
  real E5 vectors are **both 384-dim**, so the dimension guard can't separate them — mixing them
  silently corrupts ranking. `VectorIndex` takes an optional `{ embeddingModelId }` that scopes the
  cosine scan to `WHERE embedding_model_id = ?`; `rag.retrieve` passes the **active embedder's id**.
  Chosen over a forced reindex-on-switch (cheaper, no re-embed pass; a reindex still re-embeds with the
  active model). Default (no id) scans all rows ⇒ existing callers/tests unchanged. A test proves a
  mock↔real switch can't blend vector spaces.
- **Script logic in a tested TS module + self-contained shell scripts (Phase 11):** the canonical
  layout/config/checksum logic lives in `services/drive.ts` and is unit-tested by vitest; the
  `scripts/*.{ps1,sh}` **re-implement the same plan natively** rather than shelling out to Node.
  Rationale: a drive must be preparable on a **fresh machine with no Node/npm** (and no TS runner is
  installed — tsx/ts-node absent), and tests must run in CI without PowerShell/bash. `drive.ts` is the
  documented source of truth; the small drift surface (dir list + JSON shapes) is cross-checked (the
  PS + bash + TS emit **semantically-equivalent** config — valid JSON the app parses identically).
  ⚠️ Not literally byte-identical: timestamps differ per run, and `ConvertTo-Json` whitespace differs
  from the bash here-docs. The PS scripts now write **UTF-8 without a BOM** (`Set-Content -Encoding
  UTF8` on PS 5.1 would emit a BOM that breaks Node's `JSON.parse`) — audit fix.
- **Drive-layout naming reconciliation (LOCKED, Phase 11):** the prepared-drive dirs follow the
  **code**, not the spec's prose. Sidecar OS sub-dirs are **`win`/`mac`/`linux`** (`sidecar.ts`
  `llamaOsDir`), and manifests live in a **top-level `model-manifests/`** (`models.ts`
  `resolveManifestsDir`) — NOT `windows/macos/linux` or `models/manifests/`. `drive.ts`
  `DRIVE_LAYOUT_DIRS` is canonical; `docs/drive-layout.md` was corrected to match.
- **Config-generator defaults (Phase 11):** `prepare-drive` writes `config/drive.json` (the
  prepared-drive marker `resolvePaths` keys off) + `config/policy.json`. **Network is ALWAYS
  deny-by-default** (the offline guarantee — `resolveNetwork` is policy ∧ user setting). The default
  posture is **commercial** (spec §6 example: encryption required, no plaintext, models must verify);
  a `-Dev`/`--dev` flag flips to a developer-friendly drive (plaintext + unverified allowed) but
  **still denies network**. JSON shapes are exactly what `parsePolicy`/`mergePolicyObject` accept
  (snake_case booleans). Files are written onto the **drive**, never committed.
- **checksums.json shape (Phase 11):** `{ drive_format_version, generated_at, algorithm:'sha256',
  entries:[{ id, local_path, sha256|null, size_bytes|null, present }] }`. Written by `verify-models
  --generate` from the weights present on the drive. **Informational** — the app still verifies
  against the manifest `sha256`; checksums.json records what a drive builder captured. Placeholder
  manifest hashes report **UNVERIFIED** (not pass, not fail), mirroring `computeInstallState`'s
  developer-mode gate (R5 checksum honesty).
- **Portable Windows target via electron-builder (Phase 11):** `electron-builder.yml` defines a
  `portable` Windows `.exe` (launch-from-drive) + `mac`(dir)/`linux`(AppImage) for parity.
  `model-manifests/` ship as `extraResources` (found via `resolveManifestsDir(app.getAppPath())` →
  `resources/model-manifests`; `HILBERTRAUM_MANIFESTS_DIR` overrides); prod deps (the externalized parser
  libs) ship inside `app.asar`; Electron stays **≥37** so `node:sqlite` exists. `npm run package` /
  `package:win` wired. **Building the real artifact is a MANUAL step** (R2 Electron download; npm
  workspace dep-hoisting may need attention) — it is NOT part of the green gate.
- **Graceful-fallback rule (LOCKED, Phase 10):** the real backends are **opt-in by availability**.
  `createSelectingRuntimeFactory` (per `start()`, when the model path is known) and
  `createSelectedEmbedder` return the real `LlamaRuntime`/`E5Embedder` **only when BOTH** the
  `llama-server` binary **and** the GGUF weights exist; else the mock. ⇒ the app launches and the whole
  suite passes with **zero model files** (the repo/CI default). The embedder reads its model from the
  **manifest** (settings live in the possibly-encrypted DB, unreadable pre-unlock).
- **Optional manifest `download` block (Phase 12, additive):** `shared/manifest.ts` gained an
  **optional** `download: { url, sha256, size_bytes?, license_url? }` validated **only when present**,
  so every existing manifest stays valid. A **real** `download.sha256` must equal a **real** top-level
  `sha256` (same file); placeholders pass through. The four committed model manifests now carry real
  upstream URLs (Qwen3 GGUF + multilingual-E5) with `sha256` left as the `REPLACE_WITH_REAL_HASH`
  placeholder (a placeholder = "fetch then capture via `verify-models --generate`"). The legacy
  `download_url: null` field was removed.
- **`runtime-sources.yaml` (Phase 12):** the `llama-server` sidecar is NOT a model, so it gets a
  committed `model-manifests/runtime-sources.yaml` (`llama_cpp: { version, builds:[{os,arch,backend,
  url,sha256,extract_to}] }`) validated by `shared/runtime-sources.ts` (`validateRuntimeSources`,
  mirroring `validateManifest`). **Excluded from model discovery** via `RESERVED_MANIFEST_FILES` in
  `models.ts` (it would fail `validateManifest`). **Default backend = CPU** (AVX2 win/x64, Metal
  mac/arm64, plain CPU linux/x64) — broadest-compatible for an unknown laptop; GPU is an opt-in
  `--backend` override. `selectRuntimeBuild` returns the **first** os/arch match when no backend is
  given (the CPU build is listed first per OS).
- **Build-time network ≠ runtime network (LOCKED, Phase 12):** the `fetch-*` scripts make the
  project's first deliberate network access, but run on the **drive-builder's online machine at build
  time, NOT in the app at runtime**. The app stays 100% offline by default; the optional in-app
  downloader (the then-deferred provisioning item, later Phase 18) stays policy-gated (`network.allow_model_downloads`, deny-by-default) **and**
  behind the user `allowNetwork` setting. The offline guarantee is unchanged. The in-app downloader
  was **DEFERRED** (not required for the DIY acceptance criteria).
- **Verify-before-trust + license gate (LOCKED, Phase 12):** every downloaded artifact is
  SHA-256-verified **before** it counts as installed — a real-hash mismatch deletes the partial and
  exits non-zero; a **placeholder** expected hash downloads but reports *UNVERIFIED* (never a silent
  pass). The license gate refuses to plan/fetch a model whose `license_review.status != approved`
  unless `--accept-license`/`-AcceptLicense` is set (license + `license_url` printed first). Downloads
  are **resumable** (`curl -C -` / `aria2c`) and **idempotent** (present + verified → skip fast).
- **`services/assets.ts` is the canonical asset-loader logic (Phase 12):** mirrors `drive.ts` — the
  scripts re-implement the same plan natively (self-contained, no Node/npm). Pure/testable:
  `planModelDownloads` (fs reads, NO network), `selectRuntimeBuild`, `planRuntimeDownload`
  (escape-guarded paths reusing `weightPath` semantics), `verifyDownloadedFile`, and an injected-fetch
  `downloadToFile`/`fetchAndVerify` seam (the network seam a future §12.3 downloader reuses; tests
  drive it with a fake `fetch` so the **no-network assertion holds**). The scripts' `.ps1` files are
  **pure ASCII** (Windows PowerShell 5.1 reads non-BOM scripts in the ANSI codepage; a UTF-8 em-dash's
  `0x94` byte decodes to `"` and breaks a double-quoted string — same class of bug as the Phase-11
  BOM issue).
- **Launcher resolves the drive root from its OWN location (LOCKED, Phase 13):** the per-OS launcher
  (`Start HilbertRaum.{cmd,command}` / `start-hilbertraum.sh`) sets `HILBERTRAUM_DRIVE_ROOT` from
  where it sits (`%~dp0` / `dirname "$0"`), **never** a hardcoded drive letter — drive letters/mounts
  change per machine, and the same drive must continue the **same encrypted workspace** on a second
  laptop (success criterion #10; `resolvePaths` already redirects all state onto the drive). Canonical,
  unit-tested resolver = `services/launcher.ts` `resolveDriveRootFromLauncher(launcherPath, flavor?)`
  (handles Windows drive-letter + POSIX paths, rejects empty/relative). The launcher scripts mirror it.
  **Autorun is dead** (Windows disabled `autorun.inf` from removable drives) — the app cannot
  auto-launch on plug-in and must not try; the drive opens a window and the buyer double-clicks the
  well-named launcher (+ a root `READ ME FIRST.txt`).
- **Signing/notarization is a documented MANUAL step; the green gate never signs (LOCKED, Phase 13):**
  `electron-builder.yml` wires `win.signtoolOptions` + `mac.notarize`/`hardenedRuntime` +
  `build/entitlements.mac.plist`, but ALL secrets come from **env vars / a git-ignored secrets file on
  the build machine** (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; `CSC_LINK`/`APPLE_ID`/
  `APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) and **never enter the repo** (`.gitignore` excludes
  `*.pfx`/`*.p12`/`*.cer`/`*.key`/`signing.env`/`*.provisionprofile`). The green gate
  (`typecheck`/`test`/`build`) does not invoke electron-builder, so signing is off the critical path
  (like the R2 Electron download). EV (Windows) builds SmartScreen reputation fastest; macOS without
  notarization is quarantined. The unsigned DIY "Run anyway" / right-click→Open fallback stays in
  `docs/troubleshooting.md`. New procurement risk **R7** (cert cost/lead-time) blocks only the
  *commercial* acceptance.
- **`build-commercial-drive` = plan + final posture assertion, mirrored by scripts (LOCKED, Phase 13):**
  `services/commercial-drive.ts` is the canonical, unit-tested reference (like `drive.ts`/`assets.ts`):
  `planCommercialDrive(opts) → CommercialStep[]` + `formatPlan` (the ordered steps: prepare → fetch-
  models → fetch-runtime → **package/sign [manual]** → copy launcher+app+docs → verify-models --generate
  → assert) and `assertCommercialDrive(root, manifests) → { ok, problems[], checks, modelResults }`
  which **reuses `loadPolicy` + `verifyDriveModels`** to assert the **commercial posture** (encryption
  required, plaintext off, models must verify, **network denied**) + **every weight VERIFIED** + **no
  user data present** (spec §12.2 — fails loudly otherwise). `scripts/build-commercial-drive.{ps1,sh}`
  orchestrate the existing Phase-11/12 scripts (NOT re-implementing them) + a native cross-check of the
  same invariants. ⚠️ PS gotcha fixed: invoke sibling scripts via **hashtable** splatting
  (`& $path @{Target=…}`), not array splatting (array splat binds positionally → `-Target` is rejected);
  reset `$global:LASTEXITCODE = 0` before each call so a stale code isn't misread.
- **Launch preflight reuses the benchmark; non-blocking (LOCKED, Phase 13):** `services/preflight.ts`
  `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) → PreflightResult` reuses
  `buildDriveStatus` (writable + free space) + `measureDriveSpeed`/`buildWarnings` (the spec §11.4
  slow-drive copy) — it does NOT add a second drive probe. Friendly + **non-blocking** (read-only / low
  space → `problems[]`, slow drive → `slowDriveWarning`; never "bad hardware", never blocks). The
  drive-speed fn is **injected** in tests (deterministic, no real I/O, no network). Surfaced on Home via
  the `preflight:run` IPC (`registerCoreIpc`, preload `api.runPreflight`). **Encrypted-by-default kept:**
  the commercial first-run still lands on the existing `WorkspaceGate` (no plaintext offered when the
  policy forbids it); only the copy was softened for zero-technical-knowledge users.

- **GPU acceleration (Phases 14–16, 2026-06-10) — design record now `docs/architecture.md`
  "GPU acceleration — design record" (§1–§8):** Vulkan-first distribution +
  `cpu/` safety net + `.hilbertraum-runtime.json` install markers (§1/§4), the 4-rung start ladder +
  `--list-devices` probe (§5 — never pass `-ngl`; `--device none` is the only CPU-forcing
  mechanism), mid-generation crash auto-fallback over the `runtime:notice` channel (§5.3),
  E5 embedder pinned to CPU (§7), conservative profile bump via `gpuUsefulForProfile` (§8),
  Settings toggle + Diagnostics Acceleration/runtime-build/"Try GPU again" surface, and the
  `HILBERTRAUM_GPU_SMOKE` manual harness. New `AppSettings` keys: `gpuMode 'auto'|'off'` (default
  `'auto'`), `gpuAutoDisabled`, `gpuLastError`, `gpuProbe`.
- **GPU audit round (2026-06-10, post-Phase-16 — all findings remediated; commit `4549934`):**
  ① fetch-runtime upgrade bug (HIGH): re-fetching over an existing install never re-flattened
  the nested tarballs (old root binary survived under a fresh vulkan marker) — both scripts now
  pre-clean the extract dir (everything except the fresh archive + `cpu/`); ② sell gate
  hardened: binary required (not just a marker), backend verified natively, `extract_to`
  escape-guarded; ③ probe correctness: resolve on the child's `close` (not `exit`),
  `invalidate()` added, probe runs concurrently with the rung-1 start; ④ "Try GPU again" became
  a dedicated `gpu:try-again` IPC (clears flags AND invalidates AND re-probes; hidden while the
  Settings toggle is OFF); ⑤ `gpuProbe` refreshed once per session, not benchmark-only (a drive
  moved between machines kept the old GPU); ⑥ `looksIntegrated` broadened for real driver
  strings (RADV APUs, "AMD Radeon(TM) 780M", Meteor-Lake "Intel(R) Arc(TM) Graphics" — discrete
  Arc "A###" still bumps); ⑦ small: `gpuMode` enum-guarded, `fetch-runtime.ps1` pure ASCII,
  stale docstrings fixed.
- **Post-MVP UX polish round (2026-06-10)** — four user-reported issues, all behind existing
  contracts (tests in `chat-ipc`, `core-model-ipc`, `models`, `tests/renderer/ChatHomeNav`):
  1. **Conversation deletion:** `deleteConversation` (`chat:deleteConversation`) removes a
     conversation — chat AND documents mode — plus its messages (messages first; the FK has no
     CASCADE). Refused while a stream is in flight for that conversation (the persisted assistant
     turn would resurrect/FK-violate after the delete). UI: a ✕ per sidebar row with a confirm.
  2. **Persisted checksum cache:** the H5 in-memory cache died with the session, so the FIRST
     Models/Chat visit after every launch still re-hashed multi-GB GGUFs with no feedback. New
     `AppSettings.checksumCache` (`path → {size, mtimeMs, sha256}`, default `{}`) is the L2
     behind the in-memory L1 — `HashStore` is injected (`createSettingsHashStore(db)`) through
     `verifyChecksum`/`computeInstallState`/`buildModelList`, so an unchanged weight is hashed
     **once ever**; size/mtime changes re-hash. Living in settings (lastBenchmark precedent — no
     schema change) it is encrypted at rest on encrypted workspaces. **"Verify checksum" is now a
     true re-verify** via the new `verifyModel` IPC (`models:verify`): `invalidateChecksum`
     (memory + store) then a fresh `computeInstallState`. Models screen got a spinner +
     first-check copy; the accepted same-size/mtime-tamper limitation is recorded in
     `docs/known-limitations.md`.
  3. **Active-model auto-start:** a restarted app showed an "active" model whose runtime wasn't
     running. The `startRuntime` handler's §7.4 gate logic moved to an exported
     `startModelRuntime(ctx, modelId)`; new `maybeAutoStartActiveModel(ctx)` (mirrors
     `maybeRunFirstBenchmark` — background, never throws/blocks) fires at startup (plaintext dev)
     and after unlock/create (encrypted). Opt-out: `AppSettings.autoStartActiveModel` (default
     `true`) + a Settings toggle. ChatScreen's "no model" empty state now polls
     `getRuntimeStatus` every 2.5 s (and says the model may still be loading) so it flips to the
     composer by itself; its runtime check uses `getRuntimeStatus` instead of `listModels`
     (cheaper, no hashing).
  4. **Home navigation fix:** "Ask My Documents" used to land on the import screen. App.tsx now
     has a central `navigate()` with a virtual `'ask-documents'` target → Chat screen with
     `initialMode='documents'` (new optional `ChatScreen` prop); sidebar "Chat" resets to chat
     mode.
- **Post-MVP UX polish round 2 (2026-06-10):**
  1. **Chat output renders Markdown:** assistant replies (persisted AND the live streaming
     bubble) render GFM via **`react-markdown` + `remark-gfm`** (new RENDERER deps — pure JS,
     MIT, bundled by Vite into the renderer; NOT main-process/externalized). Safe by
     construction: react-markdown builds React elements (no `innerHTML`) and raw HTML in model
     output renders as **literal text** (renderer test proves no `<img>` injection). Links get
     `target="_blank"` → the existing window-open handler (http/https → OS browser, else deny).
     **User turns stay plain text** (`.msg-content` pre-wrap); assistant bubbles use
     `.msg-content.md` (white-space normal + scoped element styles in styles.css).
  2. **"Lock now" stops the sidecars:** `lockWorkspace` now aborts all in-flight generations
     (`inFlightStreams`), `Promise.allSettled`-stops the chat runtime AND the E5 embedder (a
     llama-server holds recent prompts in its KV cache), THEN `workspace.lock()` — a wedged
     sidecar never blocks the re-encrypt. Unlock restarts the chat runtime via the existing
     `maybeAutoStartActiveModel`; the embedder restarts lazily on next `embed()`.
- **Post-MVP UX polish round 3 (2026-06-10):**
  1. **RAM gate + RAM-best-fit recommendation:** `machineRamGb()` (totalmem, **whole-GB
     `Math.round`** so a "16 GB" machine reading 15.9 GiB still counts as 16) feeds
     `buildModelList` → new `ModelInfo.insufficientRam` (min RAM > machine RAM). UI: a
     "Needs ≥N GB RAM" badge + disabled Select/Start (§11.4 copy: "pick a smaller model —
     quality stays great"); MAIN gate: `startModelRuntime` refuses to load INSTALLED weights
     that don't fit (mock fallback ungated — uses no real RAM). **Recommendation is now
     RAM-best-fit** (`recommendModelIdByRam`): largest model whose `recommended_ram_gb` fits,
     else lightest meeting its minimum, else none — used by `listModels` AND the benchmark
     (same whole-GB rounding ⇒ the surfaces can never disagree); profile-table lookup stays
     as the no-RAM fallback. `AppStatus.machineRamGb` added (badge copy).
  2. **Read-only in-app document preview:** new `extractDocumentPreview` + `previewDocument`
     IPC (`docs:preview`) + a Documents-screen modal. RE-PARSES the stored copy (chunks
     overlap ~80 tokens — concatenating them duplicates boundary text); falls back to the
     original file if the copy is gone. Encrypted workspaces decrypt to a transient
     `.parse-preview` file shredded on the way out (the `.parse` infix keeps it under the
     startup crash sweep); without a cipher an `.enc` copy is refused. Deliberately TEXT-only
     (never `shell.openPath`): the original bytes must never reach an external viewer in
     plaintext. Tested: ingestion + encrypted-leak tests + renderer modal tests.
- **Post-MVP UX polish round 4 (2026-06-11) — two frontend issues:**
  1. **Password "Show" toggle → eye icon:** the password-reveal control in the shared
     `PasswordField` was a text "Show"/"Hide" Button; now an inline eye / eye-off SVG
     (`currentColor`, muted→full on hover, decorative `aria-hidden`). A11y
     preserved/improved: the Button keeps `aria-pressed` and carries a descriptive
     `aria-label`/`title` ("Show password"/"Hide password"). Test name-queries updated.
     (Merge note: the PR targeted the pre-Phase-32 copy inside `WorkspaceGate`; the change
     was ported to the extracted `renderer/components/PasswordField.tsx`, so the Unlock,
     first-run AND Settings → Change-password fields all get the icon.)
  2. **Filename auto-scope for document chat:** other documents were cited as sources when a
     question named one file, because document retrieval is **corpus-wide by default** —
     nothing parsed the question for a filename (the scope plumbing itself was correct
     end-to-end). New pure `detectFilenameScope(question, docs)` (`services/rag/scope.ts`,
     unit-tested) matches a file by its title/stem as a whole-token run (token-boundary, lone
     generic words ignored, whole-corpus match = no match). `askDocuments` applies it **only**
     when the conversation has no explicit "ask selected documents" scope, as the per-request
     `scopeDocumentIds` — narrows only, never widens; explicit scope always wins. Visible +
     honest: a one-shot non-persisted `STREAM.scope` notice (`api.onScopeNotice`) → an
     *"Answering from contract.pdf only"* toast in Chat. Tests: `tests/unit/rag-scope.test.ts`
     + a `tests/integration/rag.test.ts` case proving unscoped surfaces both docs while the
     detected scope returns only the named file. Design record: `docs/rag-design.md` §10.
- **Doc lifecycle: finished plans become design records (2026-06-10):** implemented plan docs
  are condensed to short design records (decisions + load-bearing facts + the design as built)
  or deleted, with the full original in git history — finished plans otherwise drift and
  contradict code (the GPU audit proved it). Applied: `docs/IMPLEMENTATION_PLAN.md` **deleted**
  (per-phase ritual lives in CLAUDE.md; spec-§22 Definition of Done folded into §5; the dead
  Phase-0 `PlaceholderScreen.tsx` went with it); `docs/gpu-support-plan.md` and
  `docs/provisioning-and-distribution-plan.md` **condensed** with their cited section anchors
  kept stable (gpu §1–§8; provisioning §0/§12/§12.3/§13). In the 2026-06-12 housekeeping both
  were folded onward and deleted: provisioning → `docs/packaging.md`; the GPU record →
  `docs/architecture.md` "GPU acceleration — design record" (§-anchors preserved). Rule recorded in
  CLAUDE.md ("Doc lifecycle rule"). Full originals: `git show 4549934:docs/<file>`. **Also applied at
  wave-1 closeout (2026-06-10): `docs/post-mvp-functionality-plan.md` condensed** to the
  wave-1 design record (full original: `git show 2a46ca3:docs/post-mvp-functionality-plan.md`);
  in the 2026-06-12 housekeeping that record — and `docs/retrieval-quality-plan.md` +
  `docs/model-catalog-expansion-plan.md` — were folded into the topic docs (rag-design §10/§12,
  architecture, model-benchmarks §7, model-policy) and deleted.
- **Functionality wave 1 — Phases 17–20 (2026-06-10) — design record folded into the topic
  docs (full original: `git show 2a46ca3:docs/post-mvp-functionality-plan.md`):**
  **Phase 17** RAG trust & document-scoped asking (`docs/rag-design.md` §10 incl. D1/D2 —
  ask-selected-documents scope, plain-chat document-awareness notice, vector-tag fix,
  reindex-needed answer). **Phase 18** in-app model downloader (`docs/architecture.md`
  "In-app model downloader" incl. D3 — triple-gated:
  policy ∧ default-off setting ∧ per-download confirmation; `.part` + verify-before-rename,
  Range resume, async-with-polling IPC). **Phase 19** audit log on `runtime_events`
  (`docs/architecture.md` "Audit log" incl. D7
  + `docs/security-model.md` — never-throws recorder with locked-vault buffering, hard
  privacy rule ids/filenames/counts never content (sentinel-grep-tested), 5 000-row
  prune-on-insert, Diagnostics Activity panel + export). **Phase 20** answer-depth modes
  (`docs/architecture.md` "Chat & streaming" incl. D4–D6 — per-request
  `chat_template_kwargs.enable_thinking`,
  the ADDITIVE `chat:reasoning:<id>` stream channel, reasoning stripped from persistence;
  the `--reasoning auto` silent-delta research finding and the `CHAT_SERVER_ARGS` pin are
  recorded there).
- **Phase 21 — retrieval quality: reranker + hybrid keyword search (2026-06-10) — design
  record `docs/rag-design.md` §12 (decisions
  D8–D15 + research facts, incl. the rerank-mode `n_ubatch=512` HTTP-500 trap and its
  batch-size fix, §12.1 R1) + §11 (as built):** FTS5 keyword pass + RRF
  fusion in `retrieve()`; optional CPU-pinned `bge-reranker-v2-m3` sidecar behind a
  `Reranker` interface whose absent default keeps retrieval byte-identical. Real-hardware
  smokes on `D:\` (i7-1185G7): F16 loads on b9585, relevance correct, worst-case
  12-candidate batch ≈ 24.7 s CPU; `ragMinSimilarity` measured → stays 0 (§12.1 R3 —
  prefix-less E5 compresses all cosines into ~0.87–0.94, separation is the reranker's job);
  the `HILBERTRAUM_RAG_QUALITY` end-to-end run validated the reranker rescuing the true clause
  from #3-behind-distractors to #1 (the concrete justification for its ~25 s worst case).
- **UI polish wave — Phases 23–27 (2026-06-10, branch `ui-phase-23-tokens-theming`, merged
  to master same day) — durable reference [`docs/design-guidelines.md`](docs/design-guidelines.md)
  (ADOPTED), rollout record + decisions D-UI1–4 + the eyeball-walk verification pattern in
  its §11:** Phase 23 tokens + theming (additive `AppSettings.theme`; the gate always follows
  the OS theme, D-UI2) · 24 shared component layer on four pinned, license-reviewed Radix
  primitives (D-UI1) · 25 chat restructure per guidelines §3 (the wave's priority) · 26 IA
  regroup nav 7→5 + Privacy/Diagnostics as Settings tabs (legacy `privacy`/`diagnostics` nav
  aliases kept working; Home stays as the readiness hub, D-UI3) · 27 copy sweep + the
  "Local · Offline" ambient indicator + the 3-step first-run create flow + the WCAG 2.2 AA
  sweep (accepted items and the bundled-app `WrongPasswordError` instanceof/tree-shake quirk
  are recorded in `docs/known-limitations.md`).
- **Phases 28–29 — model catalog wave 1 + benchmark (2026-06-10/11) — design record
  [`docs/model-benchmarks.md`](docs/model-benchmarks.md) §7 (D16–D22) + its §0–§6
  (protocol, tooling, first-run
  results) + `docs/model-policy.md` (catalog table, license reviews, recommendation,
  disqualified candidates):**
  four Apache-2.0 challenger manifests landed with vendor-verified sources and real hashes
  (all 10 catalog weights VERIFIED on `D:\`; bring-up smokes PASS on real b9585). The
  judge-free benchmark (scorer `tests/eval/score.ts`, harness `tests/manual/model-eval.test.ts`,
  100-item `eval/{corpus,rag}_de_en.jsonl`) ran on the i7-1185G7 for all 8 models (QA
  reproduced bit-for-bit on the dev box). Applied live: `recommended_min_ram_gb` recalibrated
  from measured peak RSS, the recommender made quality-aware via the new `recommendation_rank`
  manifest field (≤12 GB → Qwen3-4B / 16 GB → Ministral / ≥32 GB → Gemma 4; Granite + 30B
  never auto-recommended), Gemma's `supports_thinking_mode` flipped ON after its thinking
  check. Headline discriminator: hallucination resistance on unanswerables (Ministral 0/15
  best); grounded EM saturates (~96–98 %) — the D27 eval-hardening motivation. Only the
  optional dev-box speed sweep remains (QA + RSS are machine-independent).
- **Functionality wave 3 — Phases 31–38 (2026-06-11) — design record
  [`docs/architecture.md`](docs/architecture.md) "Functionality wave 3 — design record"
  (decisions D23–D37 in §13, research-gate findings banked in §14, plus the §-anchor legend
  mapping the retired plan's per-phase §4–§11 to their topic-doc homes):**
  **31** conversation search (`messages_fts` mirroring the D13 index shape, bm25 ranking,
  `chat:search`, ConversationList search UI; + the deny-by-default
  `setPermissionRequestHandler` session-hardening rider) · **32** vault password change
  (descriptor v2 envelope with a wrapped data key — new vaults v2, O(1) re-wrap per change
  with a free scrypt→argon2id upgrade, one-time journaled v1→v2 migration on first change
  with crash-cut recovery tests, `workspace:changePassword` + Settings card, import↔change
  race guard) · **33** document-task engine + one-click summary (`DocTaskManager` queue/
  cancel/polling reused by 34–35; strict one-at-a-time vs chat both ways; budgeted map-reduce
  summary in `documents.summary_json`; R-T1: b9585 serves concurrent requests on PARALLEL
  slots — the app-side guard is the only serialization) · **34** translation (re-extracted
  parser segments, never the overlapping chunks — D36; R-T2-measured window math, German out
  ≈ 2.0 tok/word; retry-once-then-mark; materialized corpus document under the Phase-32
  lease + `documents.origin_json` provenance; new `docs:export`) · **35** compare two
  documents (auto mode-switch by token math — D37 segments for input AND decision;
  section-matched mode pairs windows via the existing `VectorIndex`, deterministic, ceiling
  12 with an honest in-report notice; embedder-visibility guard fails friendly before any
  model call; two smoke rounds hardened the prompts against silent per-pair omission) ·
  **36** audio transcription as ingestion (whisper.cpp **v1.8.6** as the SECOND sidecar
  family — `whisper_cpp:` yaml block, `fetch-runtime --family`, commercial gates; the
  `whisper-small-multilingual` manifest, `role: transcriber`, covered by the Phase-18
  downloader with zero new code; `services/transcriber/` + `AudioParser` packing
  time-labeled segments → `"mm:ss–mm:ss"` citations, 1 chunk = 1 segment; D35 = keep the
  audio copy, re-index = re-transcription; the runtime↔format pair matrix in
  `computeInstallState` and the `selectModel` non-chat-role refusal shipped with it) ·
  **37** voice dictation (renderer MediaRecorder → 16 kHz mono WAV → `dictation:transcribe`
  → transient `.parse-dictation.wav`, shredded in `finally` → insert-at-cursor, NEVER
  auto-sent; the single scoped audio-only own-WebContents `media` permission allow;
  availability-driven `AppStatus.dictationAvailable`) · **38** scanned-PDF / photo OCR
  (R-O1 SPLIT design: hidden-window pdfjs-LEGACY rasterization behind a pull-based
  `OCR_RASTER` protocol + MAIN-side tesseract.js **Node mode** on Buffers, pinned 7.0.0 +
  `asarUnpack`; R-O3 → **best_int** traineddata (float `tessdata_best` crashes the WASM
  core); step-0 scan detection with friendly copy; D33 "Make searchable (OCR)" task →
  `documents.ocr_json` → re-ingest via the PdfParser `ocrPages` hook ⇒ page citations
  unchanged; photos OCR on import; `ocr:` asset class + `fetch-runtime --family ocr` +
  commercial gates; `AppStatus.ocrAvailable`). Wave close: **968/968 tests green** (+25
  `HILBERTRAUM_*` manual skips), `HILBERTRAUM_OCR_SMOKE` + built-app eyeball walks PASSED on real assets.
- **Docs-vs-code audit + comment quality pass (2026-06-13):** a full systematic comparison of
  every doc against `apps/desktop/src` (8 parallel read-only audits, findings re-verified before
  changes) found the docs largely accurate; the real doc bugs fixed were: a never-shipped TINY
  warning string in `benchmark.md`, the user-guide's "all chat models support Thorough" claim
  (Ministral/Granite/2507 don't), troubleshooting's pre-Phase-38 "OCR is not included", stale
  §4 contract lines here (DEFAULT_KDF, `selectModel` return, AuditEventType count), and the
  architecture "Data flow" pipeline that predated hybrid retrieval. A **comments-only quality
  pass** over all of `apps/desktop/src` (~100 files) trimmed history/provenance narration
  (Phase/D/R/H/M ids, audit stories) while keeping every LOCKED/security/platform constraint;
  verified mechanically — esbuild-stripped output of every changed file is byte-identical to
  the pre-pass HEAD. Dead-info pass: resolved `~~strikethrough~~` entries deleted from
  `known-limitations.md`; dangling §-references to retired plan files repointed
  (model-benchmarks, security-model, rag-design); future-tense "lands in Phase N" rewritten as
  shipped behavior. The test-infra nuisance noted here (1–2 timeout flakes under the FULL
  parallel suite on a loaded machine) was mitigated in the remediation entry below.
- **Audit-findings remediation (2026-06-13):** the code findings banked by the audit are
  fixed (commits "Audit fix A/B/C"). A — user-visible strings: phase jargon retired from the
  mock-runtime reply, the DiagnosticsTab fallbacks, and the commercial-drive step
  descriptions; the doctasks materialize-failure log is kind-aware. B — robustness: orphaned
  `OCR_RASTER.error` frames are logged; the E5 embedder gained the reranker's failed-start
  latch with ONE deliberate difference — it **clears on `suspend()`** (the embedder has no
  graceful degradation, so replace-the-GGUF + lock/unlock must make imports retryable;
  architecture.md updated); `plaintextAllowed` is now honestly `(policy, { isDev })` — the
  old `developerMode` parameter was always fed `isDev` (the proxy rule is documented;
  `encryptionRequired` stays the absolute veto; security-model.md updated); `ensureColumn`
  asserts identifier/DDL shape before interpolating; downloads detect a cancel race via the
  AbortSignal (cast removed) and prune terminal jobs beyond the most recent 20; preflight
  selects the slow-drive warning by content, not `[0]`; `rag.retrieve` joins fused candidates
  in one `IN (…)` query (placeholders, fused order preserved); `RUNTIME_POLL_MS` is shared
  (`renderer/lib/polling.ts`); the triplicated export save-dialog step is one helper
  (`ipc/save-export.ts` — audit calls stay per-site, per the privacy rule); the runtime
  status `'cpu'` fallback is a named default (`UNLABELLED_BACKEND`). C — test infra: the
  parallel-suite timeout flakes were CPU starvation tripping vitest's 5 s default, so
  `testTimeout: 15_000` (3× headroom) in `vitest.config.ts` — chosen over capping
  `maxWorkers` because it leaves a clean run's wall time unchanged. Suite: **969 tests
  green** (968 + the new e5 failed-start-latch test).
- **Multi-persona audit + MEDIUM remediation (2026-06-13, branch `audit-2026-06-13-high-fixes`,
  NOT yet merged):** a fresh five-persona audit (`docs/audit-2026-06-13.md`, a working report
  outside the doc-lifecycle rule). No CRITICAL. **Round 1** fixed the 4 code HIGHs + M-S3 (H1
  import lease-leak, H2 RAG token budget ×1.3, H3 truncated-blob guard, H4 OCR rasterizer
  busy-flag, M-S3 OCR-window nav guards). **Round 2** added the H5/M-A1 drift test
  (`tests/integration/script-drift.test.ts`) + the M-D1/2/3 stale-doc fixes. **Round 3** banked
  the prioritized MEDIUMs: M-C1/2/3 sidecar lifecycle (a post-ready `'error'` without `'exit'`
  now fires the GPU crash auto-fallback **and** resolves `stop()`; `stop()` escalates to SIGKILL
  even when `child.kill()` throws; the auto-fallback re-arms on a synchronous `restart()` throw —
  the fix surfaced a secondary bug: `stop()` clears `ready`, so the `'error'` handler must record
  the exit during teardown too or the SIGKILL escalation double-fires `kill()`); M-C4 RRF
  tiebreak on best-rank-across-both-lists (exact-term keyword-only hits no longer suppressed);
  M-C5 caller abort signal plumbed `retrieve → embed/rerank` via a shared `combineSignals`
  (`runtime/sidecar.ts`); M-S2 per-handler IPC arg-shape guards (`createWorkspace` `password.length`
  TypeError + unlock/changePassword/importDocuments); M-S1 offline guard kept **detection-only by
  decision** (`security-model.md` §2 "Detection-only, not enforcement" — enforcing via the
  process-wide `net.Socket.connect` shim would turn a host-extraction edge case into a hard offline
  failure breaking loopback IPC/sidecar; the guarantee rests on the no-remote-code posture + the
  prod CSP). **Round 4** banked the a11y trio + the M-A1 follow-up: L8 (composer `aria-label`
  mirroring the mode prompt), M-U1 (new `ErrorBanner` — an always-mounted `role="alert"`
  `display:contents` wrapper that swaps text; Banner took a `role` override so the inner one is
  `status` not a nested alert; chat/documents/models error banners migrated), L7 (the visible
  streaming markdown is no longer a live region — a separate `.sr-only` `StreamAnnouncer` announces
  only newly-completed sentences, markdown-stripped, resetting per stream), and M-A1 **completed**
  (drift test extended to the `config/{drive,policy}.json` payloads vs `buildDriveJson`/`buildPolicyJson`
  for both editions, plus the `verify-models.{ps1,sh}` sha256 regex vs `isRealSha256` and the
  runtime/format gate vs the now-exported `SUPPORTED_RUNTIMES`/`SUPPORTED_FORMATS`). Suite **1043 green**,
  typecheck + build clean. **Round 5** banked the remaining LOWs (except L16–L19). Correctness: L2
  (`cosineSimilarity` throws `RangeError` on a length mismatch — the only caller dimension-guards first,
  so a mismatch is a real bug not a prefix to score); L3 (E5 batch reorder handles all-indexed → sort,
  none-indexed → trust array order, and **throws** on a partial mix that would silently misalign
  vectors↔chunks); L4 (embedder `suspend()` clears the failed-start latch **after** teardown — teardown
  awaits an in-flight start, so a racing failure during it would otherwise re-arm the latch and force a
  second lock/unlock); L5 (transcriber `suspend()`/`stop()` track each child against a promise that
  resolves only after its transient-transcript shred runs, then **await** them — the parent can no longer
  exit on quit leaving an un-shredded transcript in `tmpdir()`, which the workspace crash-sweep never
  reaches); L6 (`parseCitations`/`isCitation` validate the `citations_json` shape on read, mirroring
  `parseScope`). a11y: L1 (markdown `a` renderer whitelists http(s), else inert text); L9 (`docs` literal
  → single `home.preflight.continue` key with a `{folder}` placeholder the UI splits to bold); L10
  (`friendlyIpcError` at the remaining `String(e)` sites in Chat/Documents/Models screens); L11
  (`<Spinner>` with `aria-hidden` baked in, replacing every bare `.spinner` span); L12 (`aria-describedby`
  on the ConfirmDialog body via `useId`); L13 (strength meter is no longer a `role="status"` live region —
  a separate debounced `.sr-only` region announces the word only after typing settles); L14
  (search-results `aria-live="polite"` + an `.sr-only` count); L15 (Thinking `<button aria-expanded>`
  instead of a `preventDefault`-driven `<details>`, reasoning kept mounted-but-`hidden` when collapsed).
  Suite **1058 green**, typecheck + build clean. **Round 6 — batch 1 (branch
  `audit-2026-06-13-high-fixes`):** the deps/test-gap LOWs + one locale MEDIUM. L17 (`logging.ts` had
  zero tests — added `tests/unit/logging.test.ts`: MAX_BYTES rotation, circular-meta non-throw,
  `readLogTail`); L18 (`@napi-rs/canvas` native `.node` excluded from app.asar via a `!**/@napi-rs/
  canvas*/**` `files` glob in `electron-builder.yml` + `tests/integration/packaging.test.ts` asserting
  it); L19 (captured the real **b9585** `--list-devices` stdout into `tests/fixtures/` — CRLF kept
  binary — and parse it as a `gpu.test.ts` regression); L16 (extracted `resolveSidecarSelection` in
  `services/select-sidecar-backed.ts` — the shared model→binary→weights ladder behind the three
  sidecar factories); M-U5 (tech-disclosure GB / Diagnostics MB-s + tokens-s / Settings context-tokens
  now route through locale `toLocaleString` helpers). Suite **1070 green**, typecheck + build clean.
  **Round 6 — batch 2 (branch `audit-2026-06-13-high-fixes`):** the UX + architecture MEDIUMs, closing
  the audit. UX: M-U2 (a stopped chat stream now toasts `chat.stopped` — a truncated reply is no longer
  mistaken for a complete one); M-U3 (the no-model chat state routed through the shared `EmptyState`);
  M-U4 (offline state lifted to App as the single ambient truth — the chat header `LocalIndicator` takes
  it as a prop instead of self-fetching, so it can't disagree with the sidebar); M-U6 (`Re-index all
  stale` gated behind a `ConfirmDialog` + a determinate `Progress` bar). Architecture: M-A2
  (`ipc/chat-stream.ts` — `assertChatStreamReady` + `withChatStream` collapse the duplicated guard
  preamble + stream lifecycle that registerChatIpc/registerRagIpc kept in hand-synced lockstep); M-A3
  (`resolveModelByRole` + `composeServices` extracted from `initBackend`); M-A4 (the 1582-line
  `doctasks.ts` split into `doctasks/{summary,translation,compare,manager}.ts` behind a byte-identical
  re-export barrel); M-A5 (the `HILBERTRAUM_*` manual-harness matrix documented as a required pre-release gate
  in `packaging.md` + the canned-real-output regression-fixture policy). **The 2026-06-13 audit is now
  fully remediated** (every HIGH, MEDIUM, and LOW closed; the `docs/audit-2026-06-13.md` working report
  was deleted per its own lifecycle rule — the full annotated report, incl. the "Confirmed NON-issues"
  list of accepted limitations, stays recoverable from git history). Suite **1083 green**, typecheck +
  build clean.
- **D1 re-affirmed — unified auto-RAG chat stays NOT built (2026-06-12):** the Phase-21 data
  the original deferral waited for is in, and it argues AGAINST unifying now: no cheap
  relevance gate exists under prefix-less E5 (the measured-floor overlap, rag-design �12.1
  R3), the reranker gate is optional equipment at up to ~25 s worst-case CPU per message, and
  the wrong-tab failure is already triple-defended (awareness notice, mode subtitles,
  filename auto-scope). **Revisit trigger = Phase 30 Track B** (a prefix-using embedder with
  a measurable floor) — rider + full rationale recorded in `rag-design.md` §10 (D1); the Phase-30 plan that
  also carried the rider was retired 2026-07-12 (model-benchmarks §9.2).

- **Phase 39 — i18n foundation + proof slice (2026-06-13; condensed record:
  `architecture.md` "Internationalization — design record"; full original plan
  `git show 5059ed8:docs/i18n-plan.md` §4):** hand-rolled typed i18n in `shared/i18n/` — `en.ts` flat
  source-of-truth catalog (`MessageKey = keyof typeof en`), `de.ts` typed
  `Record<MessageKey, string>` so **typecheck enforces catalog parity**, `t`/`tCount`
  (`.one`/`.other`, n === 1 rule)/`resolveUiLanguage` — synchronous, **zero new deps**
  (D-L1 LOCKED). New `AppSettings.uiLanguage: 'system'|'en'|'de'` (default `'system'`,
  theme-style enum guard; D-L2 LOCKED) + a Settings → General SegmentedControl picker
  (System/English/Deutsch — language names untranslated). Renderer `renderer/i18n.tsx`
  `I18nProvider`/`useT()`: re-resolves on settings load/patch, sets `<html lang>`, mirrors
  the RESOLVED language to `localStorage('hilbertraum.uiLanguage')`; the pre-unlock gate resolves
  mirror → `navigator.language` (D-L3 LOCKED). Main `services/i18n.ts`: cached language
  from `app.getLocale()` (set after whenReady), re-resolved at plaintext startup, after
  unlock/create, and on `uiLanguage` patches; `tMain()` localizes ephemeral emissions —
  first use = the gate's wrong-password message, English byte-identical (D-L5 LOCKED).
  Proof slice migrated: App shell (nav/lock/notice chrome), SettingsScreen (tabs + General
  tab fully), WorkspaceGate (all steps); German copy is informal „du" (D-L7) with the §3.5
  glossary pinned atop `de.ts`. **R-L1 finding:** on this de-AT Windows 11 machine
  `app.getLocale()` returns the BARE tag `'de'` (not `de-*`) and `navigator.language`
  matches — `resolveUiLanguage` accepts bare `'de'`; the dev machine is German-locale
  (not EN as the plan assumed), but the suite is locale-independent (jsdom pins
  `navigator.language` to `en-US`). Tests: 990 green from `apps/desktop`; new
  `tests/unit/i18n.test.ts`, `tests/unit/main-i18n.test.ts`, `tests/renderer/I18n.test.tsx`
  (picker patch + mirror + German gate smoke); one scoping edit in `Theme.test.tsx` (the
  General tab now has two "System" radios — scope by radiogroup, don't rename). Persisted
  DB strings and LLM prompts untouched (D-L4/D-L6 wait for Phases 41/42).
- **Phase 40 — i18n renderer string sweep (2026-06-13; sweep conventions kept as
  `architecture.md` i18n record §5; grep-audit result in the original plan §5,
  `git show 5059ed8:docs/i18n-plan.md`):** every remaining renderer screen/component migrated to the
  shared catalogs in five batch commits (① Home + chat components + App leftovers ②
  Documents ③ Models ④ Privacy/Diagnostics tabs ⑤ shared components), catalogs now
  ~440 keys/language with **English values byte-identical** (D-L8 — the pre-existing
  role+name assertions passed unchanged). Label maps kept their structure with
  `labelKey: MessageKey` values (`STATUS_BADGE`, `STATE_BADGE`, `AUDIT_TYPE_LABELS`,
  `TASK_BUSY_*`, `DEPTH_LABEL_KEYS`, `ConversationGroup.labelKey`); hand-rolled plurals
  → `tCount`; the two `toLocale*String()` date sites + file-size/RAM formatting take the
  resolved locale from `useT().lang` (`useGrouping: false` keeps EN output identical).
  **Shared components RECEIVE a bound `t` prop/argument** (`components/translator.ts`:
  `Translator` type + `englishTranslator` default for provider-less tests) — Banner
  Dismiss, Modal Close, ConfirmDialog Cancel, Chip Remove, PasswordField Show/Hide +
  strength `labelKey`/`hintKey`, LocalIndicator label/detail. Phase-41 boundary
  untouched: persisted `documents.error_message` renders as-is, `DOC_TASK_BUSY_MESSAGE`
  recognition unchanged, raw IPC/job/audit error strings pass through;
  `MIC_BLOCKED_MESSAGE` stays canonical in `lib/dictation.ts` and is exact-matched +
  localized at display in `DictationButton`. Untranslated by design: product name/"Lite",
  picker language names, technical ids/paths. Tests: 997 green from `apps/desktop`; new
  `tests/renderer/GermanSmoke.test.tsx` (German render smoke per migrated screen + the
  shared-component built-ins); grep audit clean (remaining capitalized literals =
  comments, dev-internal throws, `e.key` names — recorded in plan §5).
- **Phase 41 — i18n main-process boundary (2026-06-13; condensed as `architecture.md`
  i18n record §3.3; fact-5 classification findings in the original plan §6,
  `git show 5059ed8:docs/i18n-plan.md`; D-L4 LOCKED):** the §3.3 two-rule
  boundary applied across the main process in four step commits. **Rule 1 (persist
  canonical, LOCKED D-L4):** everything written to the DB / settings stays canonical
  English via explicit `t('en', …)` + a §3.3 comment — the 7 parser-failure constants
  (`scanDetected` exact-match contract untouched), source-missing + reconcile messages,
  `NO_DOCUMENT_CONTEXT_ANSWER` **and `REINDEX_NEEDED_ANSWER`** (fact-5 correction:
  also persisted into `messages.content`), `DOC_TASK_BUSY_MESSAGE` (canonical ON THE
  WIRE — ChatScreen's `error.includes` recognition), and `buildWarnings` (persisted in
  `settings.lastBenchmark`). The renderer translates them at display via the new
  exact-match **display map** (`renderer/lib/displayMap.ts`, `localizeServerCopy`) in
  DocumentsScreen failure rows, Transcript (persisted + live bubble), the ChatScreen
  banner (busy-message substring case), DiagnosticsTab warnings, and Home preflight
  notes; unknown strings (raw library errors, the interpolated `Unsupported file
  type: …`) render as-is — accepted. Old pre-i18n rows re-translate retroactively on a
  language switch (byte-identical English, D-L8). **Rule 2 (emit localized, D-L5):**
  `tMain()` at every emission site — doc-task guards/status errors (**verified
  in-memory only**, never persisted), download refusals + job errors, the IPC guards
  (docs/chat/rag/doctasks/models/downloads), preview/export throws, preflight problems
  (transient; the slow-drive note stays canonical — shared with persisted benchmark
  warnings — and is display-mapped), the GPU compatibility-mode notice, the remaining
  workspace gate/change-password results, the `VaultBusyError` lease message, and the
  five native dialog titles + picker filters (window title stays the product name).
  `FRIENDLY_TASK_ERRORS` became the exported `isFriendlyTaskError()` checking both
  catalogs (guard throws are now localized). Audit-log messages stay English in DB +
  export (privacy rule, accepted); LLM prompts untouched (D-L6). Tests: full suite
  **1007 green**; new `tests/integration/i18n-boundary.test.ts` +
  `tests/unit/display-map.test.ts`; built bundle launch-smoked on this de-AT machine
  (German home, German no-model IPC refusal in vivo).
- **Phase 42 — i18n German QA + closeout (2026-06-13) ⇒ i18n wave (39–42) COMPLETE;
  plan condensed to `architecture.md` "Internationalization — design record" +
  `design-guidelines.md` §7 "German microcopy" and DELETED
  (`git show 5059ed8:docs/i18n-plan.md`); ~51 code comments retargeted from
  "i18n-plan §" to "i18n record §" (§-numbers preserved):**
  ① full `de.ts` review pass — 9 value fixes (imperative consistency prüfe→prüf,
  Mock→Demo-Runtime, grammar/idiom fixes; commit `a4d91de`), the user holds the final
  D-L7 human-review pass. ② German eyeball walk (`%TEMP%\hilbertraum-eyeball\walk-phase42.mjs`,
  shots in `shots-p42`): encrypted first-run gate flow + every screen at BOTH window
  extremes (880×600 / 1920×1040) with a programmatic overflow scan, plus an English
  regression leg via the picker. Three text-expansion findings, all fixed with LAYOUT:
  `.chat-header` wraps (the German mode label + ambient indicator clipped at 880),
  chat empty-state example chips wrap instead of ellipsizing at the 240px chip cap,
  `.kv dd` uses `overflow-wrap: anywhere` (break-all cut German words mid-word).
  ③ Untranslated-string finding fixed: the persisted default conversation title
  `'New chat'` is persist-canonical with a behavioral exact-match
  (`maybeSetTitleFromFirstMessage`) ⇒ new `main.chat.defaultTitle` key (persist-canonical
  section), `DEFAULT_TITLE = t('en', …)`, display-map entry, `ConversationList` passes
  titles through `localizeServerCopy` (real user titles pass through). ④ Catalog hygiene
  tests extended: plural-pair completeness + `DISPLAY_MAP_KEYS` ↔ persist-canonical
  section pinned key-for-key (`display-map.test.ts`). ⑤ **All seven acceptance criteria
  verified explicitly:** (1) instant System/English/Deutsch switch + `<html lang>` in
  vivo; (2) German gate/first-run/post-unlock with zero stored state in vivo (cleared
  localStorage + reload); (3) no English remnant in the German walk (product
  name/technical values excepted — the one finding was ③, fixed); (4) scanned-PDF under
  German UI: scanDetected intact, German failure row, OCR offer present, same row
  canonical English after switching (display map works both ways); (5) wrong-password +
  no-model refusals German in vivo, download/policy refusal copy pinned by
  main-i18n/boundary tests; (6) suite 1010 green + typecheck green, removing a de.ts key
  ⇒ TS2741 (demonstrated); (7) zero new deps / no network / audit-log untouched (phase
  diff inspected). ⑥ `known-limitations.md` "Internationalization" section added (D-L6
  documented ⇒ RESOLVED; audit-log English; interpolated/library errors render as-is;
  user-guide/README English-only for now; mixed-language transcripts accepted).

---

## 4. Shared data contracts (the actual "transported data")

> **Moved verbatim to [`docs/data-contracts.md`](docs/data-contracts.md)** (2026-07-12) — the
> per-phase contract sections (IPC command surface, DB schema, streaming contract, workspace
> paths, model/runtime, RAG, encryption, …) live there now; existing "BUILD_STATE §4"
> citations resolve via this stub. When a phase changes shared shapes, update them THERE.

---


## 5. Next actions (do these next) — POST-MVP

**Everything shipped is summarized in §1/§3 and detailed in the design records. What remains:
manual release acceptance, one blocked phase (22), one drafted phase (30).** In rough priority:

> **Definition of Done (MVP, spec §22 — folded in from the retired `docs/IMPLEMENTATION_PLAN.md`):**
> app builds on ≥1 OS; architecture supports Win/macOS/Linux; local model chat works; local doc
> Q&A with citations works; manifests work; drive layout works; user data local; privacy docs
> exist; setup scripts exist; benchmark recommendation exists; non-technical demo possible; no
> cloud API; no model weights in git; README explains DIY; commercial drive layout documented.
> All code-verifiable items are ✅; the demo items are the manual acceptance below.

1. **Commercial-drive manual acceptance (needs certs + a real USB run, R5/R7):** obtain the
   code-signing certs (Windows OV/EV + Apple Developer ID), produce a **signed** Windows
   portable `.exe` + a **signed & notarized** macOS `.app`, run `build-commercial-drive`
   end-to-end onto a real drive (`-AppArtifact` the signed build), then do the spec §17 demo on
   a **fresh laptop with Wi-Fi off** + the **second-laptop continuity** check (same encrypted
   workspace, different drive letter). **⚠️ 2026-08-19, wave 188 — this check has already
   FIRED once, from a real drive, before it was ever run deliberately:** issue #188 was exactly the
   failure it exists to catch (`documents.stored_path` absolute ⇒ every stored copy stale under a
   different mount point, and "Delete document" silently not deleting). The code is fixed and
   covered by `stored-copy-portability.test.ts`, but the manual check is **NOT** answered — a
   moved-directory unit test is not a relocated drive. When it is finally run, cover **export
   original / preview / re-index / delete** on a workspace populated under a DIFFERENT letter, and
   confirm the rows self-heal (`documents.stored_name` populated after the first read).
   **Also still owed (issue #190):** RUN the read-only stored-copy diagnostic on the reporting
   drive. It exists as of 2026-08-20 and is CI-proven (architecture.md record §9); the run needs
   the owner's password, and the tool never writes to the drive. From `apps/desktop/`, in an
   interactive shell (it prompts for the password with no echo):
   `$env:HILBERTRAUM_STORED_COPY_AUDIT = "H:\"; npx vitest run tests/manual/stored-copy-diagnostic.test.ts`
   Its output is public-issue-safe by construction — paste it into #190. It settles whether that
   drive's rows are stale, counts the orphaned `.enc` files left by past silent delete no-ops (the
   number #190 checkbox 2 waits on), and its extension histogram settles the checkbox-3
   contradiction (leading hypothesis: one AUDIO document — audio preview reads the stored chunks
   and never touches the file). **It also doubles as the continuity check's evidence collector:**
   run it before and after the relocation; `stale` / `healable` / `stored_name populated` is the
   self-heal proof in pasteable form. The `electron-builder.yml` hooks + the pipeline are
   wired; only the secrets + hardware are missing. **GPU additions:** a SmartScreen sanity
   re-check (the Vulkan build adds one more unsigned DLL of the same class) and re-running
   `build-commercial-drive` end-to-end with the two-build fetch. **Phase-38 addition:** a
   packaged-app OCR smoke (worker_threads cannot read asar — the `asarUnpack`/workerPath
   rewrite must be exercised in the built app).
1b. **GPU manual hardware matrix (THIS list is canonical — release acceptance, cannot be CI'd):**
   ① Win11 + discrete NVIDIA (dev box RTX 3080 Ti — ✅ done via the Phase-15 smoke; capture tok/s
   for release notes) · ② Win + discrete AMD (Adrenalin) · ③ Win laptop, Intel Iris Xe only
   (modest gain; profile does NOT bump) — **✅ done 2026-06-10 (i7-1185G7 + Iris Xe, `HILBERTRAUM_GPU_SMOKE`
   on `D:\`): probe sees "Intel(R) Iris(R) Xe Graphics" (8108 MiB), rung-1 starts as backend=gpu and
   streams, `gpuMode:off`→cpu, simulated rung-1 failure lands on the rung-3 CPU safety net; Iris Xe is
   integrated so `gpuUsefulForProfile` keeps the profile from bumping (unit-tested)** · ④ Win with no
   GPU / Server VM / RDP session (empty probe → silent CPU, no scary UI) · ⑤ Win with a pre-Vulkan-1.2
   GPU (clean rung-1 degradation) ·
   ⑥ Linux + NVIDIA and/or AMD (symlink-materialized libs load from exFAT) · ⑦ mac arm64
   regression (Metal unchanged) · ⑧ any GPU box: kill the driver mid-generation
   (`dxcap -forcetdr`) → §5.3 auto-fallback + friendly notice + next-message-works · ⑨ a
   `build-commercial-drive` drive moved between machines ①↔④ (flags/probe re-evaluate per machine;
   encrypted workspace continuity). The fake-spawn unit tests cover the *logic*; this matrix covers
   the *drivers*. Both are required before the release checkbox ticks.
1c. **Security + CoC contact — ✅ RESOLVED 2026-07-10 (docs-audit DOC-009).** `SECURITY.md`
   ("Reporting a vulnerability") and `CODE_OF_CONDUCT.md` (Enforcement) now name
   **security@hilbertraum.ai** as the private channel (same mailbox for both, owner decision
   2026-07-10). Remaining owner actions: create/monitor the mailbox, and enable **GitHub private
   vulnerability reporting** at flip time (confirmed NOT enabled as of 2026-07-06 —
   `GET /repos/comilionas/AI_Drive/private-vulnerability-reporting` → 404; re-confirmed still 404
   on the renamed `HilbertraumAI/HilbertRaum` 2026-07-11 — the enable-at-flip action now lives in
   item 10; SECURITY.md phrases it as "where available" so the doc stays honest until then).
2. **Small live-UI leftovers:** the Diagnostics **Activity-panel eyeball** on a real drive
   (events appear; export saves — the last wave-1 live-UI item); an icon/`buildResources` for
   electron-builder; the **optional** Phase-29 dev-box speed sweep (completeness only — QA +
   RSS are machine-independent).
3. **Phase 22 — signed offline update bundles** (spec §12.3): 🔴 blocked. Outline (kept here
   from the retired wave-1 record): a signed bundle (manifests + optionally weights/runtime/
   app) dropped into `updates/incoming/`, verified (ed25519 via the already-shipped `@noble`
   family — no new dep class), applied atomically, recorded in `updates/applied/` + the audit
   log. **Blocking decision = key management** (who holds the signing key, rotation, whether
   DIY drives trust a repo key) — needs its own short design doc before any code. The
   commercial pitch ("signed update bundles", spec §1.3) makes this the first priority once
   drives actually ship.
4. **Embedder swap (ex-Phase-30 Track B) — deferred post-MVP; write a fresh short plan when it
   actually starts.** The 2026-06-11 big-slot plan was retired unimplemented on 2026-07-12 (file
   deleted; disposition + the durable Track-B facts: `model-benchmarks.md` §9.2; full text
   `git show 1e5d17e:docs/big-slot-embeddings-plan.md`). Track A (a bigger chat model) is
   superseded by item 8's Qwen3.5/3.6 promotion pipeline. Reopen prerequisites: item 8's scorer
   fix + eval-set hardening (ex-D42), the b9849 embedder-compat re-check (the F16/q8_0 hazard,
   §9.2 fact 3), and a fresh embedder-candidate survey.
5. **ANN vector index** only if a real corpus outgrows the linear scan (rag-design §12.2 D15 —
   explicitly not built).
6. **Format-preserving PDF output for redact/edit (issue #45 stages 1–2 — OWNER DECISION needed).**
   Stage 3 (the confirm dialog states the `.txt` output up front) shipped 2026-07-10; the format
   cliff itself stands (D77: "writing PDFs is a separate problem"). Going further means: (a) a
   **PDF-writing dependency** — `pdf-lib`-class, MIT, offline-capable; only the reader `pdfjs-dist`
   is in the tree — and, for the regenerated-copy path, (b) a **shipped embeddable Unicode font**
   (none in repo; the pdfjs `standard_fonts` are WinAnsi-bound, which can't encode the `█` masks —
   mask runs would render as drawn rects instead). Redaction-first is the tractable slice (the
   segment-faithful masked text already contains no leakable original — regenerating from it is
   TRUE redaction by construction); full in-place PDF text replacement (reflow/fonts/kerning) stays
   out. Needs its own short plan + the dependency sign-off before any code.
7. **Full-audit 2026-07-10 residuals (registered at the Phase-14 close-out; ledger + §-legend:
   [`docs/architecture.md`](docs/architecture.md) §46):**
   - **TS-3 (owner design):** make the real-model smoke gate mechanical — e.g. a release-workflow
     step that fails unless a smoke-run record (date + env fingerprint) is newer than the last
     model/runtime-affecting commit; today the `HILBERTRAUM_*` matrix is human-remembered.
     - **Manual-smoke-only coverage inventory (CODE-9/TQ-6, full-audit 2026-07-11):** the release
       checklist must name exactly which behaviors a green CI does **NOT** evidence. Everything
       above the runtime rides mocks/fakes (the mock never emits `reasoning_content`, always
       finishes `stop`; `finish_reason:'length'` is fake-driven), so these are covered ONLY by the
       env-gated `HILBERTRAUM_*` manual smokes — a pin bump or a new model manifest can change any
       of them while CI stays green:
       - (a) the **real llama-server SSE wire contract** — `reasoning_content` deltas,
         `finish_reason` (`stop`/`length`), and error-frame shapes. The parser is well covered but
         only against hand-authored fixtures, now provenance-pinned to the b9849 output shape in
         `read-chat-sse.test.ts` + `llama-runtime.test.ts` (**re-verify those frames on a runtime
         pin bump**).
       - (b) **real-model + RAG answer quality** (grounding, citations, refusal discipline).
       - (c) **`ragMinSimilarity` vs the real E5 distance distribution** (the mock embedder's
         distances are synthetic).
       - (d) **server concurrency** (multiple slots / overlapping requests on one sidecar).
       - (e) **per-model bring-up + prompt-template / stop-token leak** (each GGUF's chat template).
       - (f) **all perf numbers** (tok/s, peak RSS, model load time).
       - (g) **real GPU behavior** — the fake-spawn unit tests cover the ladder LOGIC, not drivers;
         see item 1b's ①–⑨ hardware matrix for the driver-level legs.
       - (h) **b9849 verbatim-capture re-take (F-40, audit-2026-07-16)** — the GPU `--list-devices`
         fixture (`list-devices-b9585-vulkan-rtx3080ti.txt`) and the vision SSE sample
         (`vision-sse-sample.txt`, still `system_fingerprint b9585-…`) were captured on b9585; the
         runtime pin is b9849. On the next smoke session re-run `llama-server --list-devices` + one
         vision stream, commit b9849-named captures, and MOVE the byte-pinned assertions with them
         (`gpu.test.ts` freeMb 11525 / the CRLF check; `vision-sse.test.ts` the split-UTF-8
         "Müller & Söhne" reconstruction — a fresh capture must preserve a multibyte-split frame).
         If the parse fails, that parser fix is the real payload. Until then the b9585 fixtures
         guard the b9585 shape only (M-A5 is observation-triggered — see the `gpu.test.ts` header).
       - (i) **real-server mid-stream error-frame smoke (F-02 / §Q Q-2, audit-2026-07-16)** —
         Phase 4 made `readChatSSE` REJECT on an in-band error frame (`data: {"error":{…}}` or a
         bare `error: {…}` field line), pinned only against hand-authored b9849-shaped fixtures.
         Force a REAL llama-server mid-stream failure (tiny `--ctx-size` + context-shift disabled,
         `HILBERTRAUM_*` env) and verify the reader rejects and the friendly `main.chat.streamError`
         copy surfaces (never raw model/runtime text). Also watch the PARTIAL-frame case: an error
         frame truncated mid-write (`data: {"error":{"mess` + close, no `[DONE]`) must parse as a
         keep-alive and end the stream CLEANLY (Phase 4's scoped close-without-`[DONE]` semantics).
   - **TS-7 (owner call — CI minutes):** add a `macos-latest` CI leg. The suite is offline and
     Electron-binary-free, and cross-platform path bugs have historically been caught only by the
     Ubuntu leg.
   - **TS-9 (pending owner D1):** the S13a suggestion-selector eval tier measures + prints its
     baseline without a hard bar (the AUTO-FIRE precision bar IS a live CI gate); ratify the
     suggestion bar (record: [`docs/architecture.md`](docs/architecture.md) §18 "Suggestion-selector
     baseline", the durable home since `docs/skills-s13-plan.md` §3.3 was deleted at S13 close) so
     measurement-without-assertion doesn't silently become permanent.
   - **BE-1 rider:** the `rag*` numeric settings knobs remain deliberately unclamped (they flow
     into retrieval via `ragSettingsFrom`; clamping changes behavior for extreme-value users —
     needs its own small decision before any bound).
   - **SC-1 (owner-observed):** the SHA-pinned workflow actions are validated by the next tag /
     `workflow_dispatch` run (the packaging tests don't execute workflows).
   - Watch-items **PF-5** (listDocuments load-all at ~10k docs — known-limitations, with DB-8) and
     **PF-8** (resident-cache RAM at the 1M-chunk bound — the architecture P4b deferral record)
     are recorded at those sites.
8. **Qwen3.5/3.6 + Gemma 4 QAT wave promotion — CLOSED 2026-08-03 (issues #48/#53/#82 closed;
   record: model-benchmarks §9.3 "Wave outcome — RATIFIED" + the 2026-08-03 entry above).**
   Steps (a)–(e) are done: (a) scorer v3 + all-dump rescore (canonical numbers), (b) both i9
   runs ratified as the §9 record, (c) §3/§4 speed/RSS rows for the promoted set + wave
   (RAM lines confirmed on the vulkan basis, kept), (d) §9.1 smokes for the 9B + both 27Bs +
   26B-A4B + 31B, (e) Qwen3.6 productized 2026-07-12. Coupled edits landed together (ranks
   26B-A4B 2 / 35B-A3B 1, wave test pins, manifest eval-standing notes; picker mapping
   unchanged). The rescored table did NOT contradict the §6.4 promoted ranks. The STR-1 §5.4
   thinking-checkpoint criterion is discharged for these families: every Gemma 4 size + the
   promoted Qwen set honor `enable_thinking` with clean suppression (structured surfaces safe;
   §9.3 "Thinking per size"). **Remaining work moved to the wave follow-up issue #95** (filed
   at close). *(Update 2026-08-09, `feat/issue-95-close-out` — the 2026-08-09 entry above:
   the option-2 signal-aware picker is BUILT (§6.5 design record, resolves #52's downgrade
   question) and the 35B-A3B §9.1 smoke PASSED. Still open on #95: the weak-16 GB-box
   measured-tok/s leg (decides E2B's rank; needs the designated weak-iGPU box) and the
   Windows-basis peak-RSS re-measure standing rule (§9.3 "§4 RSS") for any RAM-line retune.)*
8b. **MTP speculative decoding — the two hardware gates: BOTH PASSED 2026-08-19 (issue #182;
   adoption shipped 2026-08-19, record: architecture.md "MTP speculative decoding"; full figures:
   model-benchmarks.md §9.4 "Gate results").** Run on the i9-9900X + RTX 3090 rig with
   `speculative_decoding: mtp` active on `qwen3.8-27b-q4` + `qwen3.8-27b-q5`:
   - **§2 grounded-QA re-run, both quants: PASSED.** Score parity inside cross-run tolerance vs
     the committed pre-MTP baseline (the gate was parity, NOT byte identity: MTP breaks temp-0
     byte-reproducibility by construction). q4 F1 .3499 vs .3500, q5 .3518 vs .3523; EM,
     citation-correct, grounded columns unchanged; hallucinations 0 and unanswerable-abstention
     1.0000 held on both. Flags argv-verified on every scored server; item dumps audited (92/100
     resp. 91/100 byte-identical, the rest near-tie token flips). Committed:
     `eval/results/i9-9900X-qwen38-mtp-q{4,5}-vulkan-{quality.csv,items.jsonl}`.
   - **§9.1 smoke legs on the b9849 pin, both quants: PASSED** through the app's real IPC path
     (CDP/Playwright `_electron`). Rung 1a selected (log + argv), full offload with 24 GB
     headroom (peak VRAM 19.7 / 21.5 GiB, no spill), balanced chat zero reasoning frames, Deep
     32 / 31 frames, grounded DE ask exact fact + `[S1]`, abort 3 ms, stop + quit teardown
     clean. Fall-through leg (shim rejecting `--spec-type`): rung 1a fails, plain rung 1 comes
     up at `backend: gpu`, `gpuAutoDisabled` NOT persisted, session latch skips 1a, "Try GPU
     again" re-arms it.
   - **STILL OPEN:** re-measure §4 peak RSS/VRAM with the flag on before touching any
     `recommended_min_ram_gb` (§9.3 Windows-basis standing rule; the manifests deliberately
     still carry the PRE-MTP numbers). Data point from the smokes: `VmHWM` with MTP on matched
     the pre-MTP record byte-for-byte (17.14 / 19.68 GiB); the draft head lives in VRAM.
9. **Issue #51 residuals (owner decisions — the app-side quit close + docs shipped 2026-07-11):**
   - **Idle posture:** checkpoint + release the DB when the app is idle, so an unplug while "open
     but not in use" is harmless. New machinery (no app-level idle detector exists); the
     injected-clock idle-teardown in `translation/runtime.ts` is the pattern to mirror.
   - **In-app "Eject drive" button** (flush everything, then trigger the OS eject) — the safest
     UX for non-technical kit customers; needs per-OS eject plumbing.
   - **Downloads on quit:** a running model download's `.part` write stream is not torn down by
     `performShutdown` (the process exit closes the fd; `.part` resume re-validates) — harmless
     today, but a `downloads.cancelAll()`-style teardown would make quit-mid-download tidy.
   - **Kit quick-start card:** the printed "Before unplugging" note (quit → wait → eject) is a
     kit-material task, not a repo doc — the wording now exists in user-guide §13.
10. **Public flip checklist (folded from the launch working papers at the 2026-07-11 close-out —
    the papers are deleted, NEVER committed, no git-history copy; this item is the durable record.
    Owner executes at flip time.)** Repo state as of 2026-07-11: transferred + renamed
    **`comilionas/AI_Drive` → `HilbertraumAI/HilbertRaum`** (the checklist's repo-name item is
    thereby DONE; the hardcoded cla.yml URLs updated the same day); still **private**; **v0.1.46
    is published** (pre-release, 5 assets) — the Phase-7 release-flow test PASSED end-to-end
    (tag → three build legs + SHA256SUMS → draft → owner smoke → Publish; testers filed #48–#53
    against the shipped build).
    - [x] **Push `master` to origin BEFORE flipping** (full-audit 2026-07-12 GAP-1) —
      **DONE 2026-07-12**: the owner's push surfaced 3 remote-only commits (two staged-preview
      commits + a remote djuro-agent allowlist restore duplicating flip-batch item 5); merged
      (sole conflict `cla.yml`, local commented version kept) and pushed with the v0.1.48
      checkpoint. The `v0.1.47` tag was already on origin (decision resolved). Still open, as
      its own deliberate decision: pushing the **v0.1.48** tag triggers `release.yml`'s draft
      build.
    - [ ] **Branch cleanup** (2026-07-10 interim owner call was keep-ALL; decide at flip).
      Real unmerged work — decide keep/kill, don't blind-delete: `origin/mkg` (5 commits — the
      conversation-folders feature: nested collections, folder browser, rail tree; the only
      genuinely unmerged feature) and `origin/loader-integration` (23 commits — alternate nix/
      USB-image packaging track incl. an in-app "Updates tab"; superseded in spirit by the
      Phase-12/18 loaders but never formally killed). Stale, safe to delete after re-verifying
      0-ahead immediately beforehand: local `pr-13`, local `backend-audit-2026-06-27-fixes` (its
      only delta is the `full-audit` skill doc — cherry-pick that file first if wanted), remotes
      `models/qwen35-fast-tier`, `mkg-public`, `mkg2`, `nix-dev-shell`,
      `chore/portable-build-cleanup`, `full-audit-2026-06-28-fixes`, `screenshot-verify`,
      `performance-tuning`, plus ~25 merged locals; probably-stale CI experiments `ci/mac-build`,
      `ci/mac-build-042`, `ci/win-build-042` (verify, then delete — their function lives in
      release.yml now). **CORRECTION to the original analysis: `origin/cla-signatures` is
      LOAD-BEARING, not stale** — it is cla.yml's `branch:` for storing CLA signatures (and the
      action can't recreate it); never delete it.
    - [ ] **File the known open work as GitHub issues** (good first public-tracker content; then
      add issue cross-references where the Phase-4 readability sweep left plain-language gap
      descriptions): signed offline update bundles (item 3, blocked on key management) · big slot
      + embeddings (item 4) · PDF→PDF output for redact/edit (item 6, #45) ·
      generic result-tables residuals (architecture.md result-tables record §6: invoice
      `TableSpec` port, derived-column eval, no-skill tabular routing, remaining §5 deferrals) ·
      security-hardening lows L-4/L-5/L-7 (§8; L-8 is closed
      — `npm ci` everywhere) · the `IBAN_CANDIDATE_RE` backtracking hazard (known-limitations) ·
      restart-required mid-session installs for transcriber/reranker/embedder · the open GPU
      hardware-matrix legs (item 1b: ② ④ ⑤ ⑥ ⑦ ⑧ ⑨).
    - [x] **Flip to public** — **DONE 2026-07-12** (observed via the GitHub API 2026-07-13 at
      the PR #57 merge review): repo public, **private vulnerability reporting ENABLED** (item
      1c satisfied — SECURITY.md's "where available" phrasing is fully true), `master` ruleset
      active (changes via PR + required **`ci-success`**, no deletion/force-push), Projects
      disabled (wiki was already off). Issue templates = nice-to-have, still open.
    - [ ] **Hygiene re-grep immediately before the flip** (a full-tree sweep for dev
      paths/secrets, not just deltas since the 2026-07-10 scan; that scan verified NO secrets/PII anywhere in the working tree or git
      history — history publishes as-is, owner decision 2026-07-10).
    - Owner sidebars (any time, not flip-gated): monitor `security@hilbertraum.ai` · Apple
      Developer enrollment (packaging.md signing stage 1; when the `APPLE_*`/`CSC_*` secrets land,
      remove the one `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` line from release.yml) · restore
      `djuro-agent` to cla.yml's allowlist once the post-launch CLA smoke-test PR is green (the
      removal note sits in cla.yml).

11. **Full-audit 2026-07-11 — ROUND COMPLETE (close-out 2026-07-11; durable ledger + §-anchor
    legend: [`docs/architecture.md`](docs/architecture.md) **§47**).** Nine-pass pre-release audit
    at `dda1d25`: 1 High code (CODE-1 vault-lock silent data loss) + 2 High docs (DOC-1/2 stale
    RAM tiers) + 13 Medium + ~46 Low/Info, 0 Critical; the dedicated security pass found no new
    vulnerabilities. Remediated across phases A–I + close-out J, commits `e7cda05` → `815b3c0`
    (+ six in-wave review follow-ups), suite 4053 → **4165/47**, typecheck + build green
    throughout. Both working papers were deleted at close-out (uncommitted for their whole life —
    NO git-history copy; §47 is the only durable record: per-finding dispositions, the executed
    owner decisions GAP-1 provenance-survives / CODE-31 relabel / CODE-15+16 approved, premise
    corrections, and the complete residuals register). Actionable leftovers:
    - the **CODE-9/TQ-6 manual-smoke-only coverage inventory** lives in item 7's TS-3 bullet
      (the labelled (a)–(g) sub-list; SSE fixtures carry b9849 provenance comments —
      re-verify on a runtime pin bump);
    - **fix-when-touched polish candidates** (all Low; mechanisms in §47): mock-backend engine
      first-install refusal exemption (CODE-13) · SettingsScreen mounted-guard narrowing
      (CODE-7) · the `generateGroundedAnswer` canned-answer persist guard (CODE-18) ·
      PreviewModal `key={preview.id}` (CODE-35) · SkillsTab `setAutoFire` failure key (CODE-37) ·
      the `diag.bench.cores` plural pair (CODE-8 net allowlist) · the older DE ASCII-quote
      closers sweep (CODE-25) · a direct GAP-5 batch-skip test · exporting `TOKENS_PER_WORD` for
      the compare-budget tests;
    - **accepted/no-action residuals** are recorded in §47's rows (CODE-1 F3 double-failure,
      CODE-2 triple-overlap, CODE-11 crash-bypass orphan, CODE-13 cancel-during-extract +
      download-vs-start race, the torn-FTS-content-backfill observation, the CODE-48 watch trio,
      DOC-13 PVR-at-flip → item 10).
12. **Full-audit 2026-07-12 — ROUND COMPLETE (close-out 2026-07-12; durable ledger + §-anchor
    legend: [`docs/architecture.md`](docs/architecture.md) **§48**).** Final pre-public-flip
    audit at baseline `b4017be`: **0 Critical, 0 High**; 4 Medium (SEC-1 zero-key sidecar on
    lock-during-import, GAP-1 no push-first flip step, DOC-1 relocation-dead archive links,
    DOC-2 inverted `allowNetwork` default) + a Low/Info tail; the dedicated security,
    vault/shutdown, manifest-chain and cross-platform passes all returned clean (verdicts
    preserved in §48). Remediated across Phases 1–5, commits `9ca8b79` → `032b014` (every phase
    independently reviewer-approved BEFORE landing; one repair round all wave), suite
    4168 → **4190/47**, typecheck + build green throughout. Both working papers were deleted at
    close-out (uncommitted for their whole life — NO git-history copy; §48 is the only durable
    record).
    - _2026-07-12 Phase 1 (vault correctness & reliability), two commits:_ **SEC-1** fixed
      `9ca8b79` — "Lock now" mid-import can no longer write a zero-key document sidecar:
      `documentCipher()` closures re-read the live key per invocation and throw a typed
      `VaultLockedError`; the drained prepare fails clean (row reconciles `failed`). Red-verified
      characterization + gated-`sha256File` integration tests; security-model "Lock failure &
      durability" lock-during-import bullet; the optional orphan-`.enc` sweep stays OUT (the
      startup sweep runs while the DB is locked — known-limitations note). **REL-1 / REL-2 /
      REL-4 / REL-3 / CODE-1** fixed `6a33f25` (commit 2) — `preserveNewerPlaintext` pre-shreds a spent
      `.recovery` before the salvage rename; unlock's roll-forward freshness probe is
      exception-guarded (probe error → leave `.recovery`, unlock normally, retry next unlock);
      the in-flight-stream settle await is bounded (`STREAM_SETTLE_TIMEOUT_MS` 5 s in
      `awaitInFlightStreamsSettled`, covering quit AND interactive lock); security-model's
      `.recovery` confidentiality window qualified "under this app version or newer";
      `cleanRelative` persists posix separators (display-only `source_relative_path`). All five
      forced-failure tests watched red pre-fix (src stashed) then green. Suite 4168 → 4178/47.
    - _2026-07-12 Phase 2 (docs-only, `docs/build-log.md`):_ **DOC-1** fixed — the BUILD_STATE
      restructure relocated the archive from repo root to `docs/`, breaking its relative markdown
      links. One scripted pass de-linkified **258** relative links to inline code (F6 recipe: the
      already-`` `code` `` link text kept, only the `](target)` wrapper dropped, prose otherwise
      byte-identical); the `../BUILD_STATE.md` header link stays live and **6** non-link `](…)`
      sequences are untouched (2 regex/call-syntax false positives + 4 inside a stray-backtick
      paragraph — all confirmed non-links by rendering through `marked`/CommonMark, the ground
      truth vs the audit's naive 264/265 regex count). Archive header gains a relocation note.
      Byte-verified NUL-free + LF, line count unchanged; `marked` re-parse shows 0 relative links
      left. Suite unchanged **4178/47** (docs-only, no new tests). The optional
      `repo-hygiene.test.ts` link-resolvability assertion is DEFERRED to Phase 5 (owns that file).
    - _2026-07-12 Phase 3 (BUILD_STATE prose + owner batch — docs/process only, suite unchanged
      4178/47):_ **GAP-1** (checklist half) — item 10 gained "push `master` first / decide the
      `v0.1.47` tag push deliberately" as its first unchecked step. **SEC-2** (doc half) — §8's
      L-7 row corrected from "build-time only" to cover the in-app `extractWithTar` path
      (tar-implicit `..` refusal + pre-extraction sha256 recorded as the current posture;
      optional explicit-containment hardening is Phase 5's call — the close-out appends its
      outcome). **Owner-decision batch (surfaced here, NOT executed — audit §3):**
      ① **GAP-1 execution** — the actual `git push` (local `master` 5 ahead of origin as of this
      entry) and the tag-push decision. ② **PF-2** — optionally reword the unpushed `41acc47`
      "docs update" commit (a 2,125-deletion structural commit: spec retirement + stamp removal
      + architecture.md NUL fix); verified 2026-07-12 that no tracked file cites `41acc47` or
      its restructure successor. ⚠️ Trade-off: a rebase-reword rewrites the hashes of ALL later
      commits (the restructure commit + this round's three so far) — the hashes cited by this
      item's Phase 1/2 entries would then be stale and need updating; only possible while
      unpushed, so couple with ①. ③ **LIC-2** — generate/ship a THIRD-PARTY-NOTICES for bundled
      npm deps (pdfjs-dist/tesseract.js are Apache-2.0, which asks for NOTICE preservation) or
      defer past the flip. ④ normalize `reviewed_by: comilionas` →
      "project maintainer" in `model-manifests/translation/translategemma-12b-it-q4.yaml` (as
      the other manifests) or keep the handle. ⑤ restore `djuro-agent` to cla.yml's allowlist —
      confirm the post-launch CLA smoke PR is green first (item 10 sidebar). ⑥ confirm the
      tracked `.claude/skills/screenshot-verify/SKILL.md` is deliberately published at flip.
    - _2026-07-12 Phase 4 (docs-only accuracy sweep, suite unchanged 4178/47):_ **DOC-2..DOC-11**
      fixed — all numbers/names re-derived from code/repo at edit time. `data-contracts.md`:
      `allowNetwork` default false→**true** (+ policy-ceiling caveat, mirroring `types.ts:301-303`);
      catalog "11 manifests"→**19 model manifests across 6 role dirs** (14 chat + E5 + reranker +
      whisper + translation + vision, both occurrences); runtime pin `b9585`→**b9849**; launcher
      names → `Start HilbertRaum.cmd` / `Start HilbertRaum.command` / `start-hilbertraum.sh` /
      `READ ME FIRST.txt`; `AuditEventType` "25"→**42** (enum authoritative). `README.md`: disk
      upgrade figures ~10/~19→**~11/~21 GB** (7 GB default set + swap 8B→14B/30B, manifest
      `size_bytes` + sidecars); added a **product-vision.md** Documentation-table row; offline-guard
      sentence aligned with PRIVACY.md ("logs, never blocks … while offline"); Qwen3-4B row
      relabeled "preconfigured-drive default" to break the "default" collision with the DIY
      `--with-assets` chat model (Ministral). `product-vision.md`: voice "input/output"→**input**
      only (no TTS — grep-verified). `model-policy.md`: Chat-default purpose disambiguates
      catalog/preconfigured default vs the DIY default-set model. `architecture.md` **§22 legend
      row ONLY** re-pointed directly at `data-contracts.md` "MVP Definition of Done" (drops the
      BUILD_STATE §4 hop) — §47 ledger untouched, file byte-verified NUL-free. No doc-pinning test
      asserts any changed sentence; every edited doc byte-verified NUL-free. Docs-only ⇒ build
      unaffected.
    - _2026-07-12 Phase 5 (test-net, coverage, licensing — suite 4178 → **4190/47**):_ **TQ-1**
      fixed — the hygiene NUL net now also walks `app-skills/**` + `.github/**` (same extension
      filter; skill frontmatter is the class a stray byte breaks silently), and a new UTF-8 BOM
      ban (first-3-bytes EF BB BF) covers every NUL-net root + root `*.md` (642 files, all
      verified clean first). **TQ-2** fixed — `qwen3-4b-instruct-2507-q4` joined the incumbents
      presence pin + gained a Phase-29 invariant block (rank 1 AND original-4B rank 2 pinned as a
      pair, apache-2.0 approved, real sha256 = download hash, no mmproj); the five non-chat roles
      get a one-manifest-per-role presence + real-hash pin (license posture deliberately NOT
      pinned — TranslateGemma `pending` is the standing sell-gate decision). **SEC-2 (code half)**
      landed as the containment sweep ONLY: `install()` now runs an exported
      `assertExtractedSymlinksContained` over the FINAL post-flatten layout — any symlink/junction
      member resolving outside `extractTo` fails the install (job `failed`, no marker; lexical
      `readlink` resolution so broken links are still caught). The `--no-same-owner
      --no-same-permissions -k` tar flags were DROPPED per the plan's criterion: bsdtar 3.8.4
      (Windows) accepts them (verified live), but GNU tar's `-k` makes an existing file a HARD
      error and no GNU tar exists on this machine to verify against — sweep-only avoids the
      untestable flag semantics. `placeholder`-verify still extracts with `job.unverified` (posture
      unchanged). **DOC-1 hand-off** done — `repo-hygiene.test.ts` pins docs/build-log.md to
      exactly one relative markdown link (`../BUILD_STATE.md`, must resolve) after stripping
      code fences + CommonMark-paired inline spans (the archive's 6 non-link `](…)` false
      positives stay invisible to it). **LIC-1** fixed — `apps/desktop/package.json` declares
      `"license": "GPL-3.0-or-later"` (matches root; electron-builder.yml carries no conflicting
      field). Teeth demonstrated live for all new nets: planted BOM + NUL files and a dead
      archive link each failed their assertion; disabling the sweep call turned the escaping-link
      job `done` — all reverted/restored byte-verified. New `engine-extract-containment.test.ts`
      (7 tests, junction-based so unprivileged on Windows); typecheck + build green.
    - _2026-07-12 Phase 6 (close-out):_ round complete — the audit folded into
      [`docs/architecture.md`](docs/architecture.md) **§48** (per-finding dispositions, the
      clean verdicts, §-anchor legend: every `full-audit 2026-07-12 <ID>` citation in
      code/tests/commits resolves there); both working papers deleted (never committed, no
      history copy); **PF-1** fixed here (the `flake.nix` garbled comment word); §8's L-7 row
      gained the Phase-5 containment-sweep outcome. Final gate **4190/47**, typecheck clean,
      build unaffected (no `apps/desktop/src` touch this phase). **Round residuals (register of
      record):**
      - **Owner batch ①–⑥** (the Phase-3 entry above) — **④⑤⑥ EXECUTED 2026-07-12
        post-close-out (owner-directed):** ④ `reviewed_by` normalized to "project maintainer
        (Claude-assisted review, HF card/LFS verification)" · ⑤ `djuro-agent` restored to
        cla.yml's allowlist (smoke PR #55 verified green: block → sign → ✅, signature recorded
        on `cla-signatures`) · ⑥ owner decided **NOT** to publish —
        `.claude/skills/screenshot-verify/SKILL.md` untracked via `git rm --cached` (file stays
        on disk for local dev; `.gitignore`'s `.claude` rule, which never applied to the
        already-tracked file, now covers it). ② PF-2 **EXECUTED 2026-07-12** (owner-approved,
        while still unpushed): the spec-retirement commit reworded from "docs update" to a
        message naming the retirement + stamp removal + NUL fix (now `41acc47`; rebase rewrote
        all 11 unpushed hashes) and the stale-hash sweep applied — 28 citations across
        BUILD_STATE (§5 item 12, §8 L-7 row) + architecture.md §48 updated to the post-reword
        hashes; trees byte-identical before/after. Still open: ① GAP-1 push + tag decision
        ONLY. ③ LIC-2 **EXECUTED 2026-07-12** (owner-approved): committed generated
        `THIRD-PARTY-NOTICES.md` (226 shipped packages — asar prod closure minus the yml
        negations; no NOTICE files exist in the set; KaTeX OFL font notice included) +
        `scripts/generate-third-party-notices.mjs` (+ shared `scripts/lib/shipped-packages.mjs`),
        shipped via `extraResources`, freshness-gated by
        `tests/integration/third-party-notices.test.ts` (suite 4190 → 4195/47).
      - **SEC-1 orphan-`.enc` sweep — deferred (Info):** the startup sweep runs while the DB is
        LOCKED, so it cannot know which document ids are live; a pre-fix zero-key sidecar
        self-heals only on re-index (known-limitations note shipped with Phase 1). Same family,
        also unswept: a hard crash mid-lock-encrypt leaves a partial-CIPHERTEXT `<enc>.tmp`
        (exposure nil, overwritten next lock; one `rmSync` in the sweep would tidy).
      - **README default-set vision omission — FIXED 2026-07-12 (full-audit 2026-07-12b DOC-1):**
        README + packaging.md corrected (default set ≈10.4 GB incl. `qwen2.5-vl-3b-instruct-q4`,
        vision row + 3 packaging.md spots + model-policy.md "Opt-in only" line), swap figures
        recomputed on the corrected basis (~14 GB 14B / ~24 GB 30B-A3B).
      - **Nuance notes (recorded in the §48 rows):** REL-1's in-code "spent or garbage"
        justification slightly overstates (a REL-2 probe-error corner can leave an
        unconsumed-FRESH `.recovery`); REL-3's confidentiality window can extend one unlock
        further under an active probe error; SEC-2 reviewer N1 — the containment sweep removes
        only the FIRST offender before throwing (the next install's pre-clean removes the rest).
      - **TS-7 (macOS CI leg)** remains the standing owner call — item 7.

13. **Full-audit 2026-07-12b — ROUND COMPLETE (close-out 2026-07-12; durable ledger + §-anchor
    legend: `docs/architecture.md` §49; working paper DELETED, never committed, no history
    copy).** Baseline `06920c1`; 24 findings (23 fixed across Phases 1–5, SEC-2 owner-declined
    → §8 L-7 watch-item); phase commits `015c9d9`/`a93e970`/`e49630e`/`486c96c`/`c16f433` +
    close-out; gate 4195/47 → **4216/49**. Residuals/watch-items (all also in §49):
    ① SEC-2 hardlink hypothesis — §8 L-7 watch clause, re-open on extraction-path/tar change;
    ② DRIVE-NOTICES.md's GPL source-availability URL assumes the public repo — true at flip
    (couple with §5 item 10); ③ LIC-2 LICENSE.txt presence in the packaged artifact rides the
    next manual R2 package smoke; ④ `.ps1`/`.sh` remain outside the hygiene-net extension
    filter (Phase-2 reviewer nit — candidate for a future net widening).
    - _2026-07-12 Phase 1 (docs accuracy + onboarding sweep, docs-only, suite unchanged 4195/47):_
      **DOC-1..DOC-6, DOC-8, GAP-1, PF-1** fixed — all numbers re-derived from manifests/scripts at
      edit time. **DOC-1:** vision (`qwen2.5-vl-3b-instruct-q4`) IS in the `--with-assets` default set
      (≈**10.4 GB**, not ~7 GB) — corrected across `packaging.md` (3 spots), `README.md` (basis +
      vision row), and `model-policy.md`'s stale "Opt-in only" line; README swap figures recomputed
      **~14 GB** (14B) / **~24 GB** (30B-A3B). **DOC-2:** Qwen3.5 27B/35B `16.7/20.6`→**17.6/22.2 GB**
      (README + model-policy, 6 cells). **DOC-3:** model-policy catalog gains the two fast-tier rows
      (0.8B surviving §9 candidate / 2B failed). **DOC-4:** `translation` role added to README repo-tree.
      **DOC-5:** data-contracts b9585 present-tense reworded (verified b9585 / expected b9849).
      **DOC-6:** architecture R-2 walk-script path qualified `apps/desktop/scripts/` (line 5334 only;
      §47/§48 untouched). **DOC-8:** CONTRIBUTING spec §9.2 → architecture.md pointer. **GAP-1:**
      corporate-proxy `setup-dev`/`--use-system-ca` note in CONTRIBUTING + README. **PF-1:** §2 dev
      absolute path neutralized + item-10 re-grep widened to a full-tree sweep. Docs-only ⇒ build
      unaffected; every edited file byte-verified NUL + BOM clean.
    - _2026-07-12 Phase 2 (packaging + test-net hardening, suite 4195/47 → 4199/49, +6 tests):_
      **CODE-1** `!out/preview/**` negation in electron-builder.yml (+ packaging.md sentence),
      pinned in packaging.test.ts. **TQ-1** hygiene nets widened to `mjs|cjs|mts|yml|yaml` + both
      scripts/ roots + model-manifests/ (all pre-verified clean); teeth ritual done (planted
      BOM + NUL under scripts/ each failed the net, deleted, re-green). **TQ-2** 3 containment
      tests (relative escape, contained relative, dangling link — the 2 relative ones probe-gated,
      skip on this box, run on the Ubuntu leg); red-verified: root-anchor / drop-target / realpath
      mutations each flipped exactly one new test red while the old 7 stayed green, reverted
      byte-identical. **TQ-4** license pin apps/desktop = root = GPL-3.0-or-later.
    - _2026-07-12 Phase 3 (notices-generator robustness + logging belt, suite 4199/49 → 4201/49,
      +2 tests):_ **REL-1** both notices sorts localeCompare → deterministic code-unit order
      (license-file sort case-folded to reproduce the committed ICU-primary order); regeneration
      byte-identical ("unchanged"). **REL-2** not-installed shipped package (platform-gated
      optional) now emits a lockfile-metadata fallback section + warning instead of ENOENT — the
      package stays in the list so the gate stays in sync. **TQ-3** non-optional peerDependencies
      folded into the closure walk (byte-identical today) + an independent lockfile-derived belt
      test (red-verified by mutation) + the packaging.test.ts mirror copy kept exact. **SEC-1**
      diagnostics-log belt: `persistEncrypted`/`rotateEncryptedIfNeeded` refuse an all-zero vault
      key (the changePassword v1→v2 in-place-zero window; the refused line flushes after
      `rekeyVaultLog`), red-verified unit test + security-model.md clause. Reviewer pass: 1 real
      catch repaired pre-commit (peer fold had silently broken the documented shipped-packages ↔
      packaging.test.ts closure-mirror invariant).
    - _2026-07-12 Phase 4 (LIC-1 drive attribution, owner-ratified; suite 4201/49 → 4214/49,
      +13 tests):_ **LIC-1** the sold drive now carries LICENSE + THIRD-PARTY-NOTICES.md +
      **DRIVE-NOTICES.md** at drive root (copied by `prepare-drive.{ps1,sh}`); DRIVE-NOTICES.md
      is committed + generated (`scripts/generate-drive-notices.mjs` from runtime-sources.yaml +
      all 19 manifests + pinned texts in the new `licenses/` dir — upstream zips ship no LICENSE),
      deterministic, drift+coverage-gated (`drive-notices.test.ts`, coverage leg YAML-independent);
      the step-7 SELLABLE gate (both scripts) **and** the TS canonical `assertCommercialDrive`
      fail on a missing/empty artifact (red-verified: the old assert passed a zero-attribution
      drive green); `script-drift.test.ts` pins all 4 scripts to `DRIVE_LICENSE_ARTIFACTS`;
      hygiene nets +`txt`+`licenses/`. **LIC-2** root LICENSE ships as `LICENSE.txt` beside
      app.asar (extraResources + test pin). Reviewer APPROVE, 1 should-fix repaired pre-commit
      (MIT weights' upstream copyright lines pinned offline). ⚠️ DRIVE-NOTICES.md's GPL
      source-availability URL assumes the public repo — true once §5 item 10 flips.
    - _2026-07-12 Phase 5 (owner-batch execution, suite 4214/49 → 4216/49, +2 tests):_ **PF-2**
      preview marketing header id → `ministral3-8b-instruct-2512-q4` (ranked, shipping;
      owner-ratified swap). **LIC-3** `scripts/lib/extra-notices.mjs`: pinned verbatim texts for
      the 6 no-license-file packages + the leptonica license appended to tesseract.js-core
      (pinned-from-upstream convention; map applies only on the no-license-file path so a future
      shipped file wins); THIRD-PARTY-NOTICES.md regenerated (+~200 lines, zero pointer-only
      sections left), 2 test pins. **GAP-2** architecture.md gains a 15-line "layout of this
      file" block (pure insertion, ledgers untouched, whole-file byte-verified). **DOC-7** the
      two present-tense design-review pointers tense-fixed (596, 802); the three
      verbatim-keep mentions untouched. **SEC-2** owner ratified SKIP probe → registered as a
      close-out watch-item. Reviewer APPROVE (2 nits applied: provenance-sentence precision,
      test-comment sequencing).
    - _2026-07-12 Phase 6 (close-out):_ round folded into `docs/architecture.md` **§49**
      (24-finding disposition table, owner-batch ratifications, per-phase reviewer outcomes,
      clean verdicts, §-anchor legend — every `full-audit 2026-07-12b <ID>` citation in
      code/tests/docs resolves there); architecture.md layout block updated §24–§48 → §24–§49;
      §8 L-7 gains the SEC-2 hardlink watch clause; working paper deleted after verifying no
      tracked file references it; final gate green.
14. **Full-audit 2026-07-16 — REMEDIATION IN PROGRESS (wave opened 2026-07-17).** Baseline
    `4e02a48` (v0.1.50); 41 verified findings (F-01…F-41; 0 Critical/High, 14 Medium, 27 Low).
    Report: `git show 886be68:docs/audit-2026-07-16.md` (frozen working paper, deleted at
    close-out); executable plan + wave ledger:
    `git show bb2da00:docs/audit-2026-07-16-remediation-plan.md` (deleted at close-out; §D owner
    decisions recorded 2026-07-17 — D-A add CSV BOM, D-B relabel/drop cached read figure,
    D-C approve async image-history port, D-D CSP investigation pre-authorized both ways,
    D-E stacked branches + one wave-close PR). Branch chain `fix/audit-2026-07-16-p1…p9`,
    merged once at Phase 10; both working papers deleted at close-out after the durable
    record is folded into `architecture.md` §50.
    **Phase 1 done 2026-07-17** (branch `fix/audit-2026-07-16-p1`): model-catalog + eval
    docs/comment accuracy — F-08 (corrected the incumbent eval figures misattributed in §6.4 /
    the two promoted manifests / model-policy row 26), F-07 (benchmark.md tier table → the four
    §6.4 tiers), F-09 (supersede annotations on the pre-promotion model-policy/§9 wave text),
    F-20 (data-contracts manifest counts → model-policy pointer), F-21 (presets 4k–128k), F-17
    (dated promotion append to both license_review.notes), F-27 (preload 51-code comment), F-37
    (stale soft-hyphen comment). Docs/comments only; gate unchanged at **4217/49**, typecheck +
    build green. Details: plan §L Phase-1 ledger entry.
    **Phase 2 done 2026-07-17** (branch `fix/audit-2026-07-16-p2`): model-catalog data hygiene —
    F-06 (qwen3.5-9b-q8 `recommended_context_tokens` 98304→8192, the catalog's safe-local
    convention: the 14 GB hard start-gate no longer admits machines a 96k f16 KV cache can't fit;
    capable owners restore a big context via the in-app Settings override), F-16 (Qwen3.6 27B
    Q4/Q5 `size_on_disk_gb` normalized GiB→decimal GB, 15.7→16.8 / 18.2→19.5 = `size_bytes/1e9`;
    README + model-policy display cells + the manifests' own GiB-labelled comments follow). Two new
    `committed-catalog.test.ts` invariants (ctx ≤ 2048 tok/GB of hard-min RAM; `|size_on_disk_gb −
    size_bytes/1e9| < 0.15` for real download blocks), both red-green-demonstrated. Recommendation
    mapping unchanged (`benchmark.test.ts` byte-identical). Gate **4219/49** (+2 invariants),
    typecheck green, build n/a (tests/manifests/docs only). Details: plan §L Phase-2 ledger entry.
    **Phase 3 done 2026-07-17** (branch `fix/audit-2026-07-16-p3`): DIY drive & script parity —
    F-05 (added the `ocr` family fetch to `--with-assets` in BOTH prepare-drive siblings, so DIY
    drives now ship scanned-PDF/photo OCR; new sh↔ps1 parity net pins it; ~10.4 GB figure
    unchanged, OCR data ≈4 MB; #59 provisioning root cause fixed — its in-app warning-copy half
    queued §Q Q-1 → Phase 7, and a ready-to-post #59 comment left for Phase 10 in §L), F-03
    (`prepare-drive.sh` empty-array expansion made bash-3.2/`set -u`-safe via the M23 idiom — the
    macOS DIY abort), F-04 (`fetch-models.sh` continues past a mid-batch download failure + prints
    the summary + exits 1, matching the .ps1), F-18 (`setup-dev.ps1` `--use-system-ca` probe → a
    redirect-free `node -p` introspection, no more EAP-Stop crash on Node < 22.15), F-19
    (`fetch-runtime.sh` archive name strips `?query`/`#fragment`, converging with the ps1/TS
    siblings). Dry-run ps1↔sh parity + F-04/F-18 teeth verified manually (win32; bash 3.2 not
    available — F-03 argued by idiom + M23 precedent). Gate **4221/49** (+2 F-05 parity assertions),
    typecheck green, build n/a (scripts/docs/one test only). Details: plan §L Phase-3 ledger entry.
    **Phase 4 done 2026-07-17** (branch `fix/audit-2026-07-16-p4`): streaming honesty & extract
    freshness — F-02 (`readChatSSE`/`parseSseLine` now REJECT with a typed `ChatStreamError` on
    llama-server's two in-band mid-stream error carriers — `data: {"error":{…}}` frame and bare
    `error: {…}` field line — instead of ending cleanly; a failed generation can never persist
    as a clean answer. Consumer sweep pinned by tests: main chat turn propagates (partial never
    silently persisted), a mid-way-failed compaction summary writes NO checkpoint, both grounded
    paths propagate; new friendly `main.chat.streamError` EN+DE copy via `withChatStream`,
    content-free. Real-server error-frame smoke queued §Q → Phase 9's consolidated smoke
    checklist), F-01 (extract scan-cache hit lookup now carries `AND model_id = ?` — a chat-model
    swap re-extracts on the next explicit run; hash pinned byte-identical, same-model re-run
    stays 0-call, #50 economy holds). All red-green-demonstrated. Gate **4233/49** (+12),
    typecheck + build green. Details: plan §L Phase-4 ledger entry.

    **Phase 5 done 2026-07-17** (branch `fix/audit-2026-07-16-p5`): download & sidecar recovery
    dead-ends closed — F-13 (a COMPLETE `.part` is verified in place instead of re-requesting an
    unsatisfiable `Range` → the HTTP 416 loop with no in-app remedy is gone; typed
    `RangeNotSatisfiableError`), F-34 (the `.part` is fsynced to the device before rename — the
    post-completion power-cut/unplug torn-weight window is closed; CODE-10 wiring pin), F-14 (vision
    sidecar gains the TA-6 M1 identity-compared `onUnexpectedExit` so a mid-session OOM crash
    cold-starts the next analyze instead of failing for a full idle window), F-33 (`extractWithTar`
    gains a 5-min deadline + SIGKILL escalation + abort-signal threading, and a cancelled-but-unsettled
    `run()` counts as busy — the only unbounded child is bounded and the concurrent-install window
    narrows to the ≤2 s kill grace, an accepted residual),
    F-32 (the engine in-use guard is widened per family via a family-partitioned sidecar PID registry:
    a `llama_cpp` install is refused while ANY llama-server sidecar — embedder/reranker/vision/
    translation — is live, a `whisper_cpp` install mid-transcription; new EN+DE
    `main.engine.transcriptionRunning`). All red-green-demonstrated. Gate **4247/49** (+14),
    typecheck + build green. Details: plan §L Phase-5 ledger entry.

    **Phase 6 done 2026-07-17** (branch `fix/audit-2026-07-16-p6`): ingestion & export
    correctness — F-11 (docx-rewrite parses a self-closing `<w:t …/>` as an EMPTY node instead of
    swallowing following markup into the text layer — the D77 corruption on POI/lxml-produced
    files is gone), F-22 (md/txt parsers strip one leading UTF-8 BOM — the app's own BOM'd `.md`
    exports re-import with correct section labels, round-trip proven), F-24 (chunker slice cuts
    are surrogate-pair-aligned, boundary-only — no more lone surrogates at chunk edges for glued
    emoji/astral runs; chunk counts pinned unchanged for non-astral corpora), F-23 (`wordDiff`
    of two zero-word texts returns identical instead of null via an OOB Int32Array read), F-15
    (citation snippets at coverage.ts/common.ts cut by CODE POINT via the new shared
    `services/text.ts`; compare.ts `oneLine` too; RAG-2 pin byte-identical), F-10 (per owner
    decision **D-A**: `.csv` exports carry the UTF-8 BOM — Excel-friendly; the two no-BOM pins +
    one audit-unlisted anchored header pin flipped WITH the fix; BOM'd-CSV re-import round-trip
    proven through papaparse). All red-green-demonstrated. Gate **4264/49** (+16), typecheck +
    build green. Independent review: ACCEPT; its one nit (the F-24 degenerate extend branch was
    untested) closed with a coprime-config test, mutation-red-proven → **4265/49**. Details:
    plan §L Phase-6 ledger entry (incl. the review note).

    **Phase 7 done 2026-07-17** (branch `fix/audit-2026-07-16-p7`): renderer & IPC correctness
    polish — F-25 (translate IPC now detaches each job's `destroyed` listener on the lock/quit
    purge — the third stream terminal the F-4 detach missed, via `TranslateJobService.onStop`;
    no more one-listener-per-lock leak), F-26 (visionSession.analyze ports translate's L6a busy
    guard `activeJobId || analyzing` — a second analyze during the start round-trip no longer
    clobbers the live job's flag), F-28 (preload `listDocuments` smart filter typed as the shared
    `SmartListView`; dead `ChatOptions.useDocuments` removed — type-only), F-36 (marketing
    `getWorkspaceState` override is now case-aware `encrypted` under `isMkt()`, so shell captures
    show the Lock-now rail control that matches the encrypted privacy card — captures re-run +
    eyeballed), F-38 (StagedShell keeps observing after readiness and clears the sticky
    `data-marketing-ready` flag if the goal vanishes, so a post-readiness remount can't yield a
    silently-wrong capture; give-up path now prints — verified). Plus **Q-1** (#59 copy half): the
    scanned-PDF/OCR dead-end warnings (`docs.scan.ocrMissing`, `main.task.needsOcr`) gained an
    actionable EN+DE "how to get the OCR files" hint (`--with-assets` / `fetch-runtime --family
    ocr`); user-guide + troubleshooting cross-refs added. F-25/F-26 red-green-demonstrated. Gate
    **4267/49** (+2), typecheck + build green. Details: plan §L Phase-7 ledger entry (incl. the
    updated #59 comment for Phase 10 and the §Q Q-1 disposition).

    **Phase 8 done 2026-07-17** (branch `fix/audit-2026-07-16-p8`): performance & posture —
    F-29 (skill-suggestion whole-corpus doc signals now memoized in `scope-signals` by a
    `(scope, indexed-COUNT/MAX-rowid, document_collections-COUNT/MAX-rowid)` signature — 5 typing
    pauses → 1 materialization, invalidates on import/delete/membership; `documentsInScope`
    untouched), F-30 (`loadPolicy` caches the parsed policy per config dir keyed by each file's
    mtime/size — the 4 s TranslateScreen poll stops re-reading policy.json+drive.json off the drive;
    a live edit still re-reads), F-31 (Documents `watchJob`+`watchReindex` completion refreshes
    coalesced by a leading+trailing throttle `REFRESH_THROTTLE_MS=1500` — a rapid small-file import
    no longer re-derives the whole library ~2.5×/s; FE-7 pins preserved, new coalescing test),
    F-35⟨D-B⟩ (drive-READ probe relabelled "(cached)" EN+DE — it reads the OS page cache, ~100×
    inflated; `driveWriteMbps` is the honest headline; slow-drive warning gated on write only; old
    persisted values render sanely), F-39⟨D-D⟩ (**verdict: KEEP** `style-src 'unsafe-inline'` —
    KaTeX emits per-expression inline `style=` attributes with no nonce/hash alternative, e.g.
    `x^2 + y^2` → 11; documented in the buildCsp header + security-model.md; CSP string/pin test
    UNCHANGED), F-12⟨D-C⟩ (image-history store/open/delete now ASYNC — `encryptFileAsync`/
    `decryptFileAsync` + `fs.promises` + new `shredFileAsync` twin; analyze handler awaits
    `ensureSession` before `done` so sessionId still rides the event; retires the §35 PERF-1
    sync carve-out. Dev-box `monitorEventLoopDelay`, 16 MiB encrypted store: main-thread stall
    mean 22.4 ms → 3.4 ms, max ~95 → ~24 ms; USB run not reproducible on the dev box). F-29/F-30/
    F-31 red-green-demonstrated; **NF-1** (unlisted F-12 pinning test `vision-security.test.ts`
    waited on job state → now waits on the streamed done event) fixed in-phase. Gate **4270/49**
    (+3), typecheck + build green. Details: plan §L Phase-8 ledger entry.

    **Phase 9 done 2026-07-17** (branch `fix/audit-2026-07-16-p9`): test-infra hygiene + §Q sweep —
    F-40 (corrected the stale `gpu.test.ts` comment — the `--list-devices` fixture was captured on
    b9585, the pin is b9849, a re-capture is owed; the false "fails in CI" guarantee is gone), F-41
    (converted the five heaviest `as never` stub-cast files to typed builders/narrow named casts —
    `fileTranslateSession` 28, `ImagesScreen` 23, `TranslateScreen` 21, `AppLock` 12,
    `translateSession` 9 → all real casts removed; the outer `stubApi(...)` payloads are now checked
    against `Partial<PreloadApi>`. New one-way ratchet `as-never-ratchet.test.ts` (baseline **110**,
    comments stripped) fails if the tests/ cast count ever climbs — TEETH shown 110→111 red→110).
    **§Q swept EMPTY:** Q-2 (real-server error-frame smoke, incl. the partial-frame case) resolved
    by registration into item 7's consolidated smoke checklist above (new items (h) b9849 re-capture
    / (i) mid-stream error-frame smoke, coupling F-40 + F-02). Cast conversions changed no assertion.
    Gate **4271/49** (+1 = the ratchet test), typecheck green (test-only phase — no
    `apps/desktop/src` touched, build n/a). Details: plan §L Phase-9 ledger entry.

    **Phase 10 (close-out folding) done 2026-07-17** (on branch `fix/audit-2026-07-16-p9`):
    **round COMPLETE pending the owner confirmations below.** Durable ledger folded into
    `docs/architecture.md` **§50** (41-finding disposition table, §D decisions as executed,
    Q-1/Q-2/NF-1 + review outcomes + deviations, clean verdicts, residuals, §-anchor legend —
    every `audit 2026-07-16 F-xx` citation resolves there; layout block updated §24–§49 →
    §24–§50). Final wave gate **4271/49** (kickoff baseline 4217/49; +54), typecheck clean.
    **Owner confirmations received 2026-07-17 — ALL THREE EXECUTED, ITEM CLOSED:** ① both
    working papers deleted (full text: `git show 886be68:docs/audit-2026-07-16.md`,
    `git show bb2da00:docs/audit-2026-07-16-remediation-plan.md`; §50 carries the pointers) and
    the CLAUDE.md doc-lifecycle sentence restored; ② **PR #60 rebase-merged to `master`**
    (head `ae6d588`) after green `ci-success` (both OS legs + CLA), the #59 both-halves comment
    posted and **#59 closed**; ③ version checkpoint below (PR #61, tag v0.1.51 local until
    owner-pushed). Final post-merge gates on `master`: **4271/49**, typecheck clean, build
    green. ⚠️ **Branch note (load-bearing, like `cla-signatures`):**
    `origin/fix/audit-2026-07-16-p9` must be KEPT — the rebase-merge rewrote the wave's commit
    shas onto master, so §50's per-finding commit citations and the two `git show` paper
    pointers (`886be68`, `bb2da00`) resolve ONLY through that branch's history; deleting it
    would orphan them. The local p1–p8 labels are ancestors of p9 (redundant, cleaned up);
    `release/v0.1.51` cleaned up after merge (nothing cites its pre-rebase sha).

Version checkpoint: **v0.1.47 tagged 2026-07-11** (0.1.46 → 0.1.47, root + apps/desktop +
lockfile; CHANGELOG header mention updated) — marks the full-audit 2026-07-11 remediation
round complete at the 4165/47 gate. The tag is on origin (observed 2026-07-12), so the
push-the-tag decision from the flip checklist is resolved.

Version checkpoint: **v0.1.48 tagged 2026-07-12** (0.1.47 → 0.1.48, root + apps/desktop +
lockfile; CHANGELOG header mention updated) — marks the full-audit 2026-07-12 round complete
at the 4195/47 gate, plus the merge of the three remote-only commits that had landed on
origin/master beside the local round (two staged-preview commits + the remote's own
djuro-agent allowlist restore, which duplicated flip-batch item 5 — the sole conflict,
resolved by keeping the commented local version of `cla.yml`). Tag is local until the owner
pushes it (a pushed tag triggers the release workflow's draft build).

Version checkpoint: **v0.1.49 tagged 2026-07-12** (0.1.48 → 0.1.49, root + apps/desktop +
lockfile version fields only; CHANGELOG header mention updated) — marks the full-audit
2026-07-12b pre-public-release round complete at the **4216/49** gate (durable ledger
architecture.md §49; LIC-1 drive-attribution mechanism + SELLABLE-gate artifact check
landed). Like v0.1.48, the tag is local until the owner pushes it (a pushed tag triggers
the release workflow's draft build).

Version checkpoint: **v0.1.50 tagged 2026-07-12** (0.1.49 → 0.1.50, root + apps/desktop +
lockfile version fields only; CHANGELOG header mention updated) — marks the **PR #56 merge**
(newest-Qwen promotion, owner decision 2026-07-12, model-benchmarks.md §6.4: recommendation
tiers now Qwen3.5 4B / 9B / Qwen3.6 27B Q4 / Q5, the Qwen3.6 pair productized, the stub
`[PRO]` profile hijack that had broken master CI at `0883020` fixed), rebase-merged as
`a42254f` after all four checks (incl. the now-required `ci-success` — master is ruleset-
protected since 2026-07-12) went green. Like its predecessors, the tag is local until the
owner pushes it (a pushed tag triggers the release workflow's draft build).

Version checkpoint: **v0.1.51 tagged 2026-07-17** (0.1.50 → 0.1.51, root + apps/desktop +
lockfile version fields only; CHANGELOG header mention updated; bump PR #61 rebase-merged as
`7448942` after green `ci-success`) — marks the **full-audit 2026-07-16 remediation wave
complete** (PR #60, 41/41 findings, durable ledger `docs/architecture.md` §50) at the
**4271/49** gate. Like its predecessors, the tag is local until the owner pushes it (a pushed
tag triggers the release workflow's draft build).

15. **OCR-R wave deferrals (registered at the 2026-07-18 close-out; durable ledger =
    `architecture.md` "OCR audit (2026-07-18) — remediation ledger", PR #75):**
    (a) **mid-session OCR-asset refresh** — the engine is composed once at startup; installing
    `ocr/` files mid-session needs a relaunch (documented). Options: the translator-#40
    `onModelInstalled` re-composition analogue for the `ocr` role, or a "Check again" affordance
    on the `ocrMissing` banner — owner UX call. (b) **packaged OCR smoke, recognition leg** —
    the wave's machine carries no `*.traineddata.gz`; the CSP-exposed rasterizer leg WAS
    verified inside a packaged build (P5 probe). Run the full `tests/manual/ocr-smoke.test.ts`
    flow on an asset-carrying drive before the next release. **SUPERSEDED 2026-07-19 (DEP-1 P4):
    this deferral fired and the answer is a CRASH** — packaged OCR kills the whole app (the
    `asarUnpack` list omits the worker's hoisted deps, which stay inside `app.asar`) while
    `ocrAvailable` still reports true; pre-existing, version-independent, dev mode unaffected.
    **Do NOT run this smoke as a release step**; it is blocked behind item 16(b)'s fix bundle.
    (c) **macOS/Linux packaged CSP + OCR smoke** (P5 measured Windows
    only). (d) **BE-7 memory profile** of a real 300+-page
    scan (confirms `page.cleanup()` keeps the hidden renderer flat). (e) **pdfjs-side
    `renderer/ocr/main.ts` automated tests** (audit test-gap #4; the P5 harness covers the
    protocol level). (f) **PreviewModal `ocrInfo` line renderer test** and a
    **two-queued-OCR-tasks-on-one-doc pin** (P6 review residuals; the behavior is benign —
    serialize + overwrite = the D33 redo — but unpinned).
16. **DEP-1 follow-up register (owner-facing; registered at the 2026-07-19 close-out; durable
    ledger = `docs/architecture.md` "Dependency remediation — design record (wave DEP-1, PR
    #77)"):** (a) **`electron-builder.yml`/`electron` devDep parity test** — nothing guards that
    `electronVersion:` tracks the installed `electron` version; its absence let the first P4
    `package:win` silently ship Electron 37 after the npm bump. (b) **Packaged-OCR fix bundle** —
    `asarUnpack` the tesseract.js worker's hoisted deps, add graceful task-failure degradation,
    make `ocrAvailable` honest, and re-check the OCR window's header∩meta `blob:` intersection
    once the packaged path is reachable again (a pre-existing, version-independent crash found
    by the P4 packaged smoke). (c) **`test:coverage` parallelism cap or a documented RAM floor**
    — full-width coverage starves this 16 GB machine; `--maxWorkers=2` is the current workaround
    (script/CI unchanged). (d) **Recommend `.github/dependabot.yml`** with grouped weekly npm
    updates so the next wave arrives as PRs, not an audit (recommendation only — not
    implemented).
18. **DEP-4 follow-up register (owner-facing; registered at the 2026-08-18 close-out; durable
    ledger = `docs/architecture.md` "Electron 39 → 43 — design record (wave DEP-4, PR #187)"):**
    Wave DEP-4 cleared the LAST open Dependabot alert (#83 / issue #179) by moving Electron
    39.8.10 → 43.4.0 — Chromium 142 → 150, Node 22.22.1 → 24.18.1, SQLite 3.51.2 → 3.53.1;
    `extract-zip` is gone from the tree and `npm audit` is clean. OS floors unchanged
    (Win 10+/macOS 12+), no on-disk format change. Open items:
    (a) **`.github/dependabot.yml`** — DEP-1 §5 #4, owner-APPROVED during this wave (D-4) to
    land as its **own PR**; this was the fourth hand-rolled dependency batch. Supersedes item
    16(d).
    (b) **Packaged-OCR fix bundle** — unchanged, still open; see item 16(b). DEP-4 did not touch
    it (the defect is an `asarUnpack` gap, not a runtime-version effect).
    (c) **OCR assets on a build machine** — two DEP-4 measurement gaps exist ONLY because this
    machine carries no `*.traineddata`: dev-mode OCR recognize, and the OCR window's RUNTIME
    CSP leg (its baked meta WAS verified byte-exact from the shipped asar; the header is
    page-agnostic, so the mechanism is proven by the main window). Running the packaged
    measurement on an asset-carrying drive closes both.
    (d) ⚠️ **Electron 44 is a CUSTOMER-FACING decision, not a routine bump** — it removes macOS 12
    support and drops 32-bit Windows (ia32) + Linux armv7l. **E43 is the last series shipping
    prebuilt 32-bit binaries, supported until January 2027.** Decide deliberately with the drive
    product's OS matrix in hand; do not let it arrive as a Dependabot PR.
    (e) **electron-builder air-gapped builds** (upstream #10039) — eb fails in air-gapped
    environments even with a seeded cache, because `@electron/get` always fetches
    `SHASUMS256.txt`; fixed on master only, not in any 26.15.x. Affects BUILD machines, not the
    shipped app, but it rubs against the offline-first posture.
    (f) **Manual legs still owed by the owner** (P4's human-only items): the `defaultPath`
    dialog probe that decides whether Electron 43 pre-selects the host Downloads folder
    (owner decision D-2, conditional — if it fires, pass an explicit root at the
    `save-export.ts` seam), a real OS drag-and-drop onto the composer (`webUtils`), and a
    double-click launch of the portable `.exe`.
17. **STR-1 follow-up register (owner-facing; registered at the 2026-07-20 close-out; durable
    ledger = `docs/architecture.md` "Skills & tools architecture review (2026-07-19) — design
    record (wave STR-1, 2026-07-20)"):** (a) **Issue #80** — the constrained
    model-classification router fallback (review §5.2, the #54 intent class): hybrid cascade,
    single-shot grammar-constrained enum classification at temp 0 on the low-confidence residue
    only, suggest-never-activate; owner decisions are whether a model call on the fallback path
    is acceptable at all, the enum's member set, and the confidence boundary — wants a short
    design note first (couples with item 8's option-2 signal-aware-picker note). (b)
    **Suggestion scale-up revisit trigger** (review §5.3, recorded in the Skills record §6):
    re-evaluate embedding-based suggestion when the skill catalog approaches ~10–20 entries.
    (c) **`supports_tools` watch item** (review §5.6): if a future wave makes 14B–27B models
    primary, native tool calls only as single-shot grammar-constrained selection with app-side
    argument validation — never an agent loop; the capability flag lands on the
    currently-ignored `supports_tools` manifest key (model-policy.md). (d) The §5.4
    thinking-checkpoint criterion is folded into item 8's ratify sequence, not a separate action.

**Current gate (2026-07-12, full-audit 2026-07-12 Phase 6 close-out — round complete, durable ledger `docs/architecture.md` §48, both working papers deleted; the round moved the suite 4168 → 4190 across Phases 1–5): typecheck clean, 4190 tests pass (47 skipped —
the manual tests behind `HILBERTRAUM_*`/`PAID_*` env vars: GPU/thinking/rerank/minsim/RAG-quality/
bring-up/eval/concurrency-probe/translategemma/categorizer/compare/whisper/dictation/OCR/vision/
real-data smokes — skipped in CI), `npm run build` green. The historical loaded-machine 1–2
timeout flakes were retired by the fixed-sleep sweep (full-audit 2026-07-10 TS-1; three
consecutive full runs, zero flakes).** Per-phase gate history (test counts, bundle sizes,
per-phase test inventories) lives in git history.

---

## 6. Open issues / risks

- **R1 `node:sqlite` ✅ RESOLVED** — works in Electron 37 (Node 22.21) main process and in
  vitest (system Node); bundler resolution via `createRequire` in `db.ts`; the `sql.js`
  fallback was never needed.
- **R2 Electron binary download** — `npm i electron` and electron-builder packaging need
  dev-time network; the *app* stays offline. ⚠️ npm-workspace hoisting: prod deps live in the
  **root** `node_modules`; if electron-builder can't collect them, build from `apps/desktop`
  or adjust hoisting.
- **R3 PDF/DOCX parsers ✅ RESOLVED** — pdfjs legacy build runs in the Node main process (no
  worker/DOM); `mammoth`/`papaparse` pure-JS; all three externalized
  (`externalizeDepsPlugin`). Ambient typings in `parsers/pdfjs.d.ts`.
- **R4 Argon2id ✅ RESOLVED** — new vaults use pure-JS `@noble/hashes` Argon2id; scrypt vaults
  unlock unchanged forever (the descriptor records `algo` + params; see the §3 KDF decision).
- **R5 Real llama.cpp ⚠️ PARTIALLY RESOLVED** — all mechanics are implemented + tested against
  mocked processes/fetch, and every real-hardware smoke (`HILBERTRAUM_*`) has passed on provisioned
  drives; but binaries/weights are not in the repo, so the live spec-§17 demo from a real
  commercial drive remains the one manual acceptance step.
- **R6 TLS-intercepting proxy on this machine** — `npm install` fails with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (corporate root CA). Workaround:
  `NODE_OPTIONS=--use-system-ca npm install` (Node 24 reads the Windows cert store). Dev-only;
  the app stays offline.
- **R7 Code-signing certificates — PROCUREMENT, blocks only the *commercial* acceptance.**
  The `electron-builder.yml` hooks are wired (win signtool, mac notarize + hardened runtime +
  entitlements) and driven by env vars / a git-ignored secrets file; the OV/EV Windows cert +
  Apple Developer ID cost money + lead time. The green gate does NOT sign; the DIY path uses
  the unsigned "Run anyway" fallback (`docs/troubleshooting.md`).

---

## 7. Conventions

- IDs: UUID v4 (`crypto.randomUUID()`). Timestamps: ISO-8601 UTC.
- No network in core path. No telemetry. Models/workspace/logs are git-ignored.
- Every service hides behind an interface from spec §9.2 to keep the Tauri/Rust swap open.

---

## 8. Post-MVP audits & hardening (2026-06-09 → 2026-06-10) — ALL REMEDIATED

After Phase 13, four multi-persona audit rounds (security/privacy · spec-compliance · bug-hunt ·
docs-vs-code · release/build engineering) reviewed the full repo. **Every Critical, High, and Medium
finding plus the actionable Lows were fixed** across six remediation waves. The detailed
per-finding records and the final audit report were removed in the 2026-06-10 docs cleanup — they
live in git history (`docs/audit-2026-06-09-multi-persona.md` and BUILD_STATE §8–§14 before this
commit). Highlights of what was fixed:

- **Security / data-loss:** encrypted document cache (spec §3.5 — stored copies are `.enc` in an
  encrypted workspace, with transient decrypts shredded after parsing); vault-wipe guards (`create`
  refuses over any existing vault artifact; a corrupt descriptor reports `locked`, never
  `uninitialized`); streaming file crypto + chunked shred (> 2 GiB safe); KDF param bounds-checking;
  key zeroing on lock; startup sweep of crash leftovers (`.tmp`/`.parse*`/WAL/SHM).
- **Process lifecycle:** `RuntimeManager` start/stop serialized through an op queue;
  `E5Embedder.stop()` awaits an in-flight lazy start; SIGKILL escalation gated on actual exit;
  awaited `will-quit` stops — every orphaned-`llama-server` path closed.
- **Commercial pipeline:** `fetch-runtime` sha256 parsing fixed (the key regex was structurally
  dead in both shells); `verify-models --strict` weight gate wired into `build-commercial-drive`
  step 7 (a placeholder-hash drive now exits 1); per-OS sidecar loop (one drive ships win+mac+linux);
  license-review ship gate (`checks.licensesApproved`, NOT overridable by `--accept-license`).
- **Correctness cluster:** regenerate-after-failure, conversation-switch-mid-stream,
  per-document concurrency, and lock-while-importing races; DOCX chunk packing (coalesce
  same-label segments); E5 context truncation + batching + request timeouts; checksum verification
  cached on `(path, size, mtimeMs)` (no more multi-GB re-hashing per screen mount); the spec §7.4
  model gate enforced in the MAIN process (role + install state + policy); `developerMode` defaults
  to **false**.
- **Spec completions:** automatic first-run benchmark (§2.1); chat transcript export (§7.6); full
  Diagnostics incl. local log viewer (§7.11); drive detection without the launcher
  (`config/drive.json` marker walk-up from the exe location, §7.2).
- **Manual-acceptance prep (2026-06-10):** `runtime-sources.yaml` pinned to the REAL release
  **`ggml-org/llama.cpp@b9585`** (real per-OS URLs + SHA-256 checksums, verified end-to-end from a
  Windows host for all three OSes; tar.gz + symlink-materialization + flatten handling in
  `fetch-runtime`; schannel `--ssl-revoke-best-effort` proxy fix). **License reviews COMPLETED**
  (spec §13): all six manifests are `license_review.status: approved` (Qwen3 GGUFs = apache-2.0;
  E5 = MIT via the base model, caveat recorded in the manifest notes).

Final gate: typecheck clean, **361/361 tests**, build green, no new runtime deps.

**Still open by choice:** the consciously-accepted items are documented in
[`docs/known-limitations.md`](docs/known-limitations.md) (that list is live; several
MVP-era examples from this audit — the depth-mode plumbing, `runtime_events` — have
since shipped in Phases 19–20).

### Open hardening items — security audit 2026-06-13 (deferred, NOT yet fixed)

The 2026-06-13 hardening wave fixed every MEDIUM + the quick-win LOWs (see the entry at the
top of this file; the full audit report is in git history at commit `f99bc86`). These four
LOW items were consciously deferred — they are defense-in-depth / build-pipeline, none blocks
the offline/privacy guarantees:

- **L-4 — `importDocuments` trusts renderer-supplied source paths.** The handler type-filters +
  unlock-gates, but the path *values* are not constrained to the OS-picker output, so a
  compromised renderer could ingest any user-readable absolute path (arbitrary local-file *read*,
  no traversal *write*). Fix: have `pickDocuments` return **opaque tokens** that `importDocuments`
  redeems, instead of trusting renderer-supplied paths. (Discuss before implementing — it changes
  the import IPC contract.)
- **L-5 — `expandPaths` follows directory symlinks.** `walk()` uses `statSync` (follows links) with
  no cycle guard, so a picked folder with a symlink to e.g. `C:\Windows` traverses outside the
  selection. Blast radius: "indexes files the user didn't intend" (supported extensions only), not
  RCE. Fix: `lstatSync` for directory entries (skip symlinks) or a visited-realpath cycle guard.
- **L-7 — Runtime-archive extraction doesn't prevent member traversal (build-time AND in-app;
  scope corrected 2026-07-12, full-audit SEC-2 — the earlier "build-time only" framing was
  wrong).** `Expand-Archive` / `tar -xzf` in `scripts/fetch-runtime.{ps1,sh}` run on the drive
  **builder's** trusted machine — but the shipped app's engine installer performs the same
  extraction (`runtime-download.ts` `extractWithTar`: `tar -xf … -C extractTo` via the OS
  `tar`) of an archive whose source list (`runtime-sources.yaml`) lives on the user-writable
  drive. Current in-app posture: the archive's sha256 is verified **before** extraction
  (tampering needs drive write access to both the archive/URL and the matching hash; a
  placeholder hash extracts flagged `unverified`), and the OS `tar` refuses `..` members by
  default — containment rests on tar's *implicit* behavior rather than the explicit member
  check this fix calls for; symlink members are the residual soft spot. (The skills importer
  does NOT share this gap — it enumerates and validates every member's path/symlink before
  inflating, arch §22-A2.) Fix: list/extract members with an explicit containment check.
  **Update (close-out 2026-07-12):** Phase 5 (`032b014`) added the explicit in-app containment
  check L-7's fix called for: `install()` now runs a post-extract symlink/junction containment
  sweep (`assertExtractedSymlinksContained`, over the final post-flatten layout — an escaping
  member fails the install, no marker written), closing the symlink residual; the
  `--no-same-owner --no-same-permissions -k` tar flags were deliberately dropped (GNU tar `-k`
  hard-errors on the legitimately-retained archive `cpu/` dir). The build-time
  `scripts/fetch-runtime.*` half of L-7 remains as previously recorded.
  **Watch-item (full-audit 2026-07-12b SEC-2, owner-declined probe):** the sweep covers
  symlink/junction dirents but not tar HARDLINK members (a hardlink is not a symlink dirent) —
  labeled hypothesis, likely moot (libarchive/bsdtar checks linknames; hardlinks need an
  existing same-volume target; the archive hash is owner-pinned). Owner ratified 2026-07-12:
  skip the one-time fixture probe; re-open only if the extraction path or tar binary changes.
- **L-8 — Lockfile / `npm ci` discipline.** Confirm `package-lock.json` is committed and the
  provisioning/build scripts use `npm ci` (not `npm install`) so a build can't float a caret range
  to a newer minor. Integrity anchor = the committed lockfile.

---

## 9. First real Windows `D:\` drive bring-up — durable lessons (2026-06-10)

The first real-drive provisioning + RAG run surfaced a cluster of provisioning, path,
manifest-source and embedding bugs — all fixed same-day (the full narrative is in git
history). What still matters:

- **PowerShell arg forwarding = hashtable splatting, never array splatting.**
  `@('-Target', $t, '-AcceptLicense')` binds positionally (the `-`-prefixed string is NOT a
  parameter name), which broke `prepare-drive -WithAssets`. Convention recorded in §3;
  both call sites use hashtables now.
- **Bare-drive-root containment false positive:** `resolve('D:\')` keeps the trailing
  separator, so the `base + sep` prefix check doubled it (`D:\\`) and rejected every
  legitimate weight — latent because only a real drive-root launch hits it.
  `weightPath`/`resolveWithinRoot` normalize (`prefix = base.endsWith(sep) ? base : base + sep`);
  regression-tested with a real root (`parse(process.cwd()).root`).
- **Hash promotion is durable only in the REPO manifests:** `verify-models --generate` writes
  `config/checksums.json`, never the manifest `sha256`, and any `prepare-drive` re-run
  overwrites drive-local manifest edits. Promote real hashes into the repo manifest, then
  re-sync to the drive.
- **Broken upstream sources found by the fetch:** `qwen3-1.7b-instruct-q4` → 404 (the official
  repo ships no Q4_K_M) — manifest **dropped**; the 4B took over TINY/UNKNOWN
  (`recommended_profiles`). `multilingual-e5-small` quant repo went 401 — switched to the
  `cstr/` mirror, provenance recorded in the manifest license note.
- **The E5 embedder GGUF must be F16 on b9585** (the failure mode
  `tests/manual/rerank-smoke.test.ts` guards against): q8_0 builds either lack
  `token_type_count` (BERT/XLM-R metadata) or crash warmup
  (`binary_op: unsupported types: dst f32, src1 q8_0`). Shipped
  `keisuke-miyako/multilingual-e5-small-gguf-f16` (242 MB, 384-dim, VERIFIED); the `-q8`
  manifest id is kept as the opaque vector tag.
- **The first real-drive hallucination was the plain-Chat tab, not the RAG engine** — the
  question never reached retrieval (the grounded path has a hard empty-corpus guard). This
  finding motivated Phase 17 (rag-design.md §10). Related: a document ingested under the
  mock embedder is invisible to E5 retrieval (vectors are scoped by `embedder.id`) —
  re-upload/re-index after an embedder change.
