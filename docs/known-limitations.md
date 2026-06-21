# Known limitations & accepted trade-offs

_Last updated: 2026-06-20 (added the Image understanding section — CPU prefill latency, RAM co-residency, single-image/no-persistence, OCR-vs-vision separation)._

The MVP (Phases 0–13) is feature-complete. Four post-MVP multi-persona audit rounds (2026-06-09)
found and fixed every Critical, High, and Medium finding plus the actionable Lows — see
BUILD_STATE §8 for the remediation summary; the full final audit report is preserved in git history
(`docs/audit-2026-06-09-multi-persona.md`, removed after remediation). What remains below are the
**consciously-accepted** product/architecture decisions and inherent limitations.

## Security & privacy

The encrypted-workspace limitations — a decrypted working copy on disk while unlocked, pre-unlock
log lines buffered in memory only (lost on a kill before unlock), best-effort shredding on SSDs, no
password recovery — are documented in
[`security-model.md`](security-model.md) ("Threat notes / known limitations"). In addition:

- **The offline guard is detection-only and Node-socket-scoped.** It wraps
  `net.Socket.prototype.connect`, logs remote connection attempts, and never blocks (blocking
  app-wide risks breaking loopback IPC and the sidecars). Electron's own `net` module would bypass
  it. The offline guarantee is a property of the code + CSP + deny-by-default policy; the guard is
  a tripwire, not an enforcement layer.
- **`importDocuments` picker imports are token-bound; drag-drop trusts caller paths (accepted).**
  A PICKER import is bound to a one-time `pickDocuments` capability token (main imports exactly what
  it returned), so a compromised renderer can't forge a picker-origin read of an arbitrary file
  (vuln-scan-2026-06-21 / `security-model.md` D1). A native OS drag-drop is delivered to the
  *renderer*, so main can't tokenize it — that seam still accepts raw paths but rejects symlinks and
  canonicalizes them, and there is no network sink to exfiltrate read content (offline).
- **Archive extraction trusts verified archives.** `fetch-runtime` rejects `extract_to` escapes,
  and archives are SHA-256-verified before extraction — but member paths inside an archive are only
  as trustworthy as the pinned hash in `runtime-sources.yaml`.
- **A pre-Phase-32 build cannot open a v2 (envelope) vault.** New vaults — and any vault after
  its first password change — use the descriptor-v2 envelope (`security-model.md`). An older
  app version derives the correct KEK and even passes the verifier, but then tries to decrypt
  the data files with it and fails the GCM tag, surfacing "Could not open the workspace".
  Nothing is harmed or written; opening the drive with a current build works. Accepted: drives
  ship the app alongside the data, so version skew requires deliberately mixing an old app
  with a new workspace.
- **A pre-document-organization build ignores collections on a post-feature DB — but deletes still
  work.** An older app shows the flat document corpus (it never reads the `collections` /
  `document_collections` / `conversation_documents` tables), so organization is invisible, not
  corrupting. Document **deletion** stays safe only because those membership/link tables declare
  `ON DELETE CASCADE`: the old app's direct `DELETE FROM documents` (with `PRAGMA foreign_keys = ON`)
  cascade-removes the orphan rows instead of raising a foreign-key violation. Same accepted
  app-beside-data version-skew stance as the vault note above. (See `docs/architecture.md`
  "Document organization — design record" §3.)
- **Password-change edge: a post-commit swap interruption can briefly wedge one document.**
  If the one-time v1→v2 migration is interrupted AFTER its descriptor commit but mid file-swap
  (e.g. a transiently locked file on Windows), a not-yet-swapped document sidecar stays under
  the retired key until the next app start, whose recovery rolls it forward; previewing or
  re-indexing exactly that document in the SAME session fails with a friendly error. No data
  loss; self-heals on restart.
- **The persisted checksum cache trusts size+mtime.** Model weights are SHA-256-hashed once and the
  result is cached (in memory and in `AppSettings.checksumCache`) keyed by `(path, size, mtime)` —
  re-hashing multi-GB GGUFs on every visit/launch cost minutes of USB I/O. A same-size,
  mtime-preserving in-place tamper is therefore not re-detected by the app's routine checks (mtime
  is attacker-forgeable anyway). Mitigations: the AI Model screen's **Verify checksum** forces a real
  re-hash, and the ship-time gates (`verify-models --strict`, `assertCommercialDrive`) always hash
  fully.
- **Sidecar binaries built by an OLD `fetch-runtime` carry no pre-spawn hash (accept + document).**
  The re-hash-before-spawn control (vuln-scan B, [`security-model.md`](security-model.md) "Re-hash
  sidecar binaries before spawn") re-verifies `llama-server` / `whisper-cli` against a SHA-256 the
  install marker now records. A drive provisioned by a `fetch-runtime.{ps1,sh}` predating that change
  has no recorded hash, so the verifier **tolerates** the binary (`skip-legacy`) rather than refusing to
  start — it stays unprotected until the runtime is re-fetched (the commercial sell-gate forces this for
  sold drives, but a self-built DIY drive does not). Trust there still rests on drive provisioning +
  filesystem integrity, the same residual already accepted for on-drive sidecars and app skills.
- **App-skill integrity is by location, not signature (Skills §22-M2 — accept + document).** A
  shipped skill's `trusted_level: app` is assigned because it sits in `app-skills/`, copied there at
  drive-build. On a removable drive `app-skills/` is writable, so "verified" means build-time
  provisioning, not a runtime hash; an attacker with physical write access could alter a shipped
  skill. A hash manifest on the same writable drive would be unanchored (rewritten too), so real
  integrity needs **off-drive signing** (a Tier-3 prerequisite, not in scope) — the **same residual
  already accepted for the engine binary and on-drive sidecars**. Blast radius is bounded: a tampered
  instruction skill is still only injected reference text behind the prompt-injection guard (it cannot
  run code, reach the network, read other files, or widen document scope). See
  [`security-model.md`](security-model.md) ("App-skill provisioning…").
- **Skills are non-confidential by design (DS20).** A skill package is task knowledge, **not** secret
  user content: `app-skills/` and `user-skills/` are plain (unencrypted) folders **outside** the
  encrypted `workspace/`. Truly sensitive material belongs in a **document** (which stays encrypted),
  never in a skill. Two consequences: a skill is readable on a lost/shared drive, and because
  `user-skills/` is a top-level directory (not inside `workspace/`), a **workspace backup must also
  include `user-skills/`** or imported user skills are lost.
- **A workspace DB rebuild re-derives user skills as DISABLED and clears the acknowledgement.** The
  `skills` table is a pure derived cache; disk (the skill folders) is the source of truth. A DB
  rebuild/corruption re-discovers every `user-skills/` folder, but a re-discovered drop-in installs
  **disabled with `warning_ack` cleared** (the DS19 safe default — a rebuild is a fresh discovery, not
  a confirmed import). No skill content is lost; the user simply **re-enables** each user skill (and
  re-acknowledges its warning) in Settings → Skills. App skills are unaffected (they re-derive enabled).
- **Prompt-injection in a skill body is contained structurally, not by delimiter purity (Skills S12
  audit).** The selected skill's instructions are injected as a fenced **data** block and the
  app-authored guard line is the last line, but the body is inserted verbatim — a hostile body can
  forge the fence's own `--- END LOCAL SKILL ---` delimiter or shout "ignore previous instructions".
  The guard line still wins structurally (it is appended after the whole block; a consolidated test
  pins this), and the real defence is the **structural ceiling**: an instruction skill can only emit
  text, and a Tier-2 tool sees a frozen `documentIds` scope with no `Db`/SQL/FS/net handle — so even a
  "successful" text-level injection cannot run code, reach the network, read other files, or widen
  scope (§14). We deliberately do **not** sanitize/escape the body delimiter (it would mangle
  legitimate instructions for no real gain). See [`security-model.md`](security-model.md) ("Skill tool
  ceiling").
- **A user skill's `triggers.filenamePatterns` are compiled to a RegExp (Skills S12 audit — now
  actively bounded, post-S12).** The deterministic suggestion heuristic turns a `*statement*`-style
  pattern from a user-installed skill into an anchored, case-insensitive regex matched against the
  in-scope documents' filenames. The skill must already be **enabled by the user**, and the match runs
  only on a user action (the picker) — there is **no auto-fire** (deferred to S13). The earlier-noted
  "length-bounded matcher is future hardening" **has now shipped** (architecture.md "Skills — design
  record" §13, S2): the parser caps each trigger entry's length (≤200) and count (≤64). The earlier
  guard — a regex compiled from the glob with a cap of 10 `*` wildcards — was **replaced (vuln-scan
  2026-06-21) by a linear, non-backtracking two-pointer matcher** (`selector.globMatches`): the old cap
  counted only `*`, so a `*?*?…` pattern (≤10 stars, `?` interleaved) still compiled to a degree-10
  backtracking regex that could freeze the synchronous main-side scoring on a moderately-long document
  title. The two-pointer matcher cannot backtrack at all (and no longer refuses legitimate
  wildcard-heavy globs), so catastrophic backtracking is now **structurally impossible**, not merely
  bounded.
- **Document redaction is best-effort, not a privacy/compliance guarantee (Skills S11d).** The
  `document-redaction` skill's `redact_document` tool masks personal data with **deterministic,
  offline regexes only** — e-mail addresses, phone numbers, IBANs, dates, and web links. There is **no
  ML and no name detection**, so it deliberately **misses** anything without a recognisable pattern:
  most names, postal addresses, unusual number formats, and any text inside images/scans (it sees only
  the extracted chunk text). The detectors are intentionally conservative — they prefer a **false
  negative** (leaving a borderline value) over corrupting ordinary text by over-matching. The redacted
  copy is therefore a **starting point that still needs a human review** before it is shared; the
  SKILL.md body and the run's "done" copy both say so, and the app never describes the output as "fully
  anonymized" or as meeting any legal/GDPR-DSGVO standard. Privacy posture is otherwise the strongest
  of the Tier-2 skills: the redacted text is written **only** to the user-chosen file, the detected
  values never reach any log/audit/`skill_runs` row, and only per-category **counts** are surfaced
  (architecture.md "Skills — design record" §8). A higher-recall redactor (NER, address/name lexicons)
  is a deferred wave.

## Spec features intentionally not built (MVP scope)

- **No dedicated Onboarding wizard (spec §7.1).** The `WorkspaceGate` (create-password / unlock),
  the automatic first-run benchmark, and the Home screen together cover the spec §17 first-run flow.
- **Answer-depth accepted edges** (the modes themselves shipped — architecture.md
  "Chat & streaming"): the depth choice is per-conversation **per session** (not persisted
  to the DB), and document answers always run Balanced (deep-grounded answering is an open
  question).
- **Model state `not_recommended` is declared but never produced** (no code path sets it; it exists
  only in the display map). `ready` is declared and rendered, but the current runtime goes straight to
  `running` after start, so `ready` (loaded-but-idle) is never produced either.
- **Settings lacks the spec §10.6 Models/Performance/About sections** (Models has its own screen;
  Diagnostics shows version/runtime/model info).
- **No `sample-contract.pdf` fixture** for the canonical spec §17 demo script.
- **Manifest fields `supports_tools` / `bundled_on_preconfigured_drive` are unused**
  (`supports_thinking_mode` is load-bearing — it gates the Deep answer mode).
  In particular the bundled flag's intent (don't preload the big models on a commercial drive) is
  unimplemented — the pipeline fetches every downloadable weight in the catalog (now 8 chat + E5 +
  reranker + transcriber); curate with `fetch-models --only <id>`.
- **In-app downloader accepted edges** (the downloader shipped — architecture.md
  "In-app model downloader"):
  - **The startup offline tripwire is not re-evaluated mid-session.** Toggling `allowNetwork` on
    and downloading in the same session leaves the (detection-only, never-blocking) guard
    installed, so the sanctioned download is logged as a remote-connection notice. Cosmetic;
    a restart re-derives the posture.
  - **Download progress display is per-renderer-session.** The job itself runs in the main
    process and survives navigation; after an app restart the progress card is gone but the kept
    `.part` resumes on the next Download click.
- **Drive updates are manual — Phase 22 (signed offline update bundles, spec §12.3) is still
  OPEN.** There is no update mechanism yet; the `updates/` and `workspace/backups/` directories
  are not created. The manual procedure is documented in [`drive-layout.md`](drive-layout.md)
  ("Updating a drive"). **Blocker: the key-management design** — who holds the signing key and
  where it lives (dev-machine key vs. an offline-born production key; HSM/hardware-token class
  questions), what public key drives trust (and whether DIY drives trust a repo key or generate
  their own), offline key rotation/continuity, and rollback protection. Deliberately **not yet
  decided** (discussed 2026-06-10, decision deferred); Phase 22 needs its own short design doc
  (`docs/update-bundles-plan.md`, outline in
  BUILD_STATE §5 item 3) before any code.
  One constraint already understood from that discussion: a trust anchor cannot be
  retroactively strengthened, so whatever key signs during development must never anchor
  commercial drives — the production key would be a different, offline-generated key.

## Engineering trade-offs (noted, intentionally unchanged)

- The per-import `jobs` map in `registerDocsIpc` is never pruned (tiny, ephemeral, per-process).
- `getSettings` does not type-guard stored JSON values (the privacy-critical network path is
  double-gated by the policy AND).
- `expandPaths` follows directory symlinks during import expansion.
- Sidecar port selection has a small TOCTOU window between `findFreePort()` and the spawn (no
  retry-on-bind-failure); the startup error is diagnosable via the captured stderr tail.
- The shell scripts re-implement logic whose canonical source is TypeScript (`drive.ts`,
  `assets.ts`, `commercial-drive.ts`, `launcher.ts`). Parity is maintained by convention + review,
  not code generation — see the rule in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
- Docs copied onto a prepared drive (user-guide, troubleshooting) contain repo-relative links that
  do not resolve when read from the drive.
- **Audit log (Phase 19) accepted edges:** events recorded while the vault is locked are
  buffered in memory only — quitting the app before the next unlock drops them (bounded buffer,
  oldest dropped past 100). The **persisted** audit log is also capped (`AUDIT_MAX_ROWS = 5000`,
  pruned on every insert), so on a very active workspace the oldest events fall off over time.
  Lock-on-**quit** and the implicit stop during a model *switch* are
  not audited (only the explicit "Lock now" / stop actions are). A download that completes
  against a placeholder manifest hash records no `model_download_verified` event (checksum
  honesty — the AI Model screen shows UNVERIFIED).

## Retrieval quality (Phase 21, [`rag-design.md`](rag-design.md) §11)

- **`ragMinSimilarity` stays 0 — a positive cosine floor is impossible under prefix-less E5
  (MEASURED 2026-06-10, [`rag-design.md`](rag-design.md) §12.1 R3).** On the real `D:\` drive the
  relevant and irrelevant best-chunk cosine distributions OVERLAP (everything compresses into a
  ~0.87–0.94 band because E5 runs without its `query:`/`passage:` prefixes), so any positive floor
  drops real hits. Relevance separation is delegated to RRF + the reranker (D12). Latent
  improvement: a prefix migration would spread the distribution and make a floor meaningful, but
  forces re-embedding every corpus — revisit only as a deliberate migration.
- **Reranker latency on CPU is significant (MEASURED): ≈ 24.7 s worst case** for a 12-candidate
  batch at the full truncation budget on a CPU-pinned i7-1185G7 (~2 s/candidate;
  `HILBERTRAUM_RERANK_SMOKE`, 2026-06-10) — a documents query visibly lengthens on a low-end laptop when
  the reranker is provisioned. Bounded by the candidate cap (≤ 2×`topKInitial`) + word-truncation
  budgets (the tuning levers); the reranker stays an opt-in (provision-the-GGUF) feature, never
  bundled by default. The `HILBERTRAUM_RAG_QUALITY` run is the evidence it earns the cost
  (rag-design §12.3).
- **The FTS5 index duplicates chunk text inside the workspace DB** (a self-contained table was
  chosen over external-content on `chunks`' implicit rowid, which VACUUM may renumber). Bounded by
  the 1 000-chunk/file cap; encrypted at rest with the same DB file.
- **Keyword search is embedder-visibility-scoped by design**: a document whose vectors were
  produced by a different embedder is not keyword-searchable either, until re-indexed — that is
  the Phase-17 honesty rule, not a gap (`REINDEX_NEEDED_ANSWER` tells the user what to do).

## Document tasks & summaries (Phase 33, wave-3 plan §6)

- **Very long documents get a beginning-only summary (the map-call ceiling).** The
  budgeted map-reduce caps at **12 map calls** (≈ a ~50-page document at the default
  4096-token context) — Deep map-reduce over a 1000-chunk corpus on a CPU laptop is not a
  v1 promise (D25). The summary is flagged `truncated` and the UI says so honestly; the
  whole document remains searchable/answerable in RAG. A smaller `contextTokens` setting
  shrinks the per-call budget and hits the ceiling sooner.
- **Summary input is the stored chunks, not a re-parse (D25).** Adjacent chunks overlap by
  ~80 tokens, so stitched windows repeat a little text (harmless for summarization).
- **Over-cap documents are now REJECTED at index time, not silently truncated
  (whole-document-analysis Phase 1, C1/C2/M13 — behavior change).** A document that would
  exceed `MAX_CHUNKS_PER_DOCUMENT` (1 000) fails with a friendly "too large to fully index —
  split it" message (`main.ingest.tooManyChunks`) instead of indexing only its first 1 000
  chunks. So every *indexed* document is now the WHOLE document (recorded by the
  `fully_chunked` marker), which is what lets a deep index honestly claim full coverage.
  Consequence: a **legacy** document indexed before Phase 1 (which may have been silently
  truncated) carries no `fully_chunked` marker — it is re-indexed before any deep-index /
  100 %-coverage claim, and if it is genuinely over-cap that re-index fails **closed** (the
  doc becomes `failed`/unsearchable and must be split into parts — the cap check runs before
  the destructive chunk replacement, so it never half-deletes a previously searchable doc).
- **A deep index ("ready" summary tree) gives a whole-document summary; without one the
  capped map-reduce still applies.** When a document has a built tree (`tree_status='ready'`),
  "Summarize" serves the tree root verbatim (full coverage, `truncated:false`) at no extra
  model call. The build is a background, *yielding* job that cedes the model slot to chat
  between nodes; it is auto-offered for documents the capped summary can't fully cover and
  otherwise built on request. The coverage-meter UI is a later phase.
- **A background deep-index build cedes the slot to chat, but not to other document tasks.**
  While an auto-started tree build runs (multi-minute on a weak CPU), an interactive chat
  answer pauses it and is served within ~one node, then the build resumes. A user-started
  Summarize/Translate/Compare, however, queues behind the build until it finishes — the build
  yields only to chat. It is the active task, so it shows as "Building a deep index…" and can
  be cancelled from the busy banner (which lets the queued task run); a cancelled build is
  resumable from the warm cache. An explicit model Stop/switch also aborts it (it re-builds
  under the new model). Finer task-vs-build prioritisation is a later phase.
- **"List every X" answers are exhaustive over the SECTIONS SCANNED — not guaranteed complete
  (whole-document-analysis Phase 3, H7).** When a document has been through the structured-extract
  pass (a manual, yielding background task like the deep index), a "list every / how many {X}"
  question is answered from precomputed data at **zero model calls** with per-item provenance and
  an honest coverage line ("N sections scanned (k unparsed)"). It is **not** a guaranteed-complete
  list: a small model can miss an item, very similar values are merged, an item split across the
  ~80-token section overlap can double-count, and a section whose reply was unparseable is counted
  as "unparsed" (its items may be missing) rather than dropped. The "whole document" wording is
  shown only when every in-scope document is fully indexed (`fully_chunked`). An **unmapped/ad-hoc
  "{X}"** (no precomputed type) is **not** answered as a complete list — it falls back to a labelled
  relevance answer ("based on the most relevant passages"). v1 has no live full-scan for unmapped
  types and does not auto-run the extract pass at import (it is started on request) — both are later
  phases. The extract pass, like the deep index, requires a fully-chunked (re-indexed if legacy) doc.
- **A `kind:tool` skill answers from its whole-document tools — or refuses, never partially
  (full-doc-skills, D44–D49; architecture.md "Skills — design record" §19).** This is the third
  coverage state, distinct from the two above. When a tool skill (bank-statement, invoice) is the
  resolved turn skill and the question is analysis-shaped over a **single, fully-chunked** in-scope
  document, the chat turn does **not** take the top-k relevance path: it auto-runs the skill's
  **read-only** whole-document tools (export stays confirm-gated), computes the figures
  deterministically from the extracted table (zero model calls), and stamps a real `extract` coverage
  whose "whole document" wording is gated on `fully_chunked` (D48 — coverage is now persisted per
  message, not hardcoded `relevance`). If any in-scope doc is **not** fully chunked the turn is
  **refused** with a fixed message pointing at Documents → Re-index — no partial answer, no model call
  (D45) — rather than silently answering from a few passages (for accounting, a partial read is a wrong
  total). A tool skill answering an **off-topic** question, or over a multi-doc scope, keeps the
  ordinary relevance path unchanged. `document-redaction` is an action skill and never registers a
  handler, so it is never force-routed (D49).
- **Strictly one job at a time (D26).** While a summary runs, chat is refused with a
  friendly message + a cancel option, and vice versa — the one local model serves one
  request. The R-T1 probe confirmed the pinned b9585 WOULD serve concurrent requests on
  parallel slots, so this is an app-side product decision (predictable latency, no
  context-memory splitting), not a server constraint; revisit only with evidence.
- **Re-index clears the summary and nothing regenerates it automatically** — the content
  may have changed, so a stale summary must not survive; the user presses Summarize again.
  Accepted edge, mirrored in the user guide.
- **Token budgeting is conservative, not exact.** The window math uses the chunker's
  `approxTokenCount` plus a 1.3 words→tokens safety factor; real token counts vary by
  language/model. Worst case is smaller-than-necessary windows (more map calls), never a
  context overflow. **NB (fix 2026-06-14):** the estimate formerly counted only
  whitespace words, so a *space-less* document — CJK/Thai, or a glued PDF/extraction run
  with no word breaks — collapsed to ~1 "token" and the assembled prompt overflowed the
  model context, which the server rejected with `HTTP 400 exceed_context_size_error` (the
  whole document-analysis path failed). `approxTokenCount` now counts space-less scripts
  per character and charges long no-space runs by length, and `windowByTokens` slices such
  runs instead of leaving them whole. **Documents indexed before this fix keep their
  pre-fix (possibly oversized) chunks until Re-indexed.** Space-less estimates are
  deliberately on the high side (CJK counted ~1 token/char), so CJK summaries window more
  finely than strictly necessary — safe, slightly more map calls. **NB (fix 2026-06-15):**
  the *embedder* sidecar truncation had the same class of bug — it truncated each chunk by a
  naive whitespace-word count at an English-calibrated 1.4 tokens/word, so a subword-heavy
  language (German runs ~2 real tokens/word) or a space-less script stayed over the 512-token
  E5 context and the embeddings endpoint failed with **`HTTP 500`** — which surfaced when a
  machine translation **into German** was imported. The embedder now truncates by
  `approxTokenCount` against a conservative real-BPE safety factor (2.2× for the *multilingual*
  E5), covering worst-case German with headroom; the embedding vector covers the chunk's head
  (adjacent chunks overlap), so retrieval is unaffected in practice. **NB (fix 2026-06-16):** a
  third instance of the same class — the *chat/RAG conversation* path replayed the WHOLE history
  unbudgeted, so a long multi-turn analysis (or a grounded turn carrying a large chunk block)
  accumulated past the model window and the server rejected the request with the same `HTTP 400
  exceed_context_size_error`. The history is now trimmed to `contextTokens` (`fitMessagesToContext`),
  keeping the system prompt + the current turn and dropping older turns oldest-first. The retrieval
  cap (`ragMaxContextTokens`) still bounds only the retrieved chunks; the new budget bounds the whole
  prompt. Unavoidable overflow (a single oversize turn on a tiny-context model) now surfaces the
  friendly `main.model.contextExceeded` copy on the invoke rejection, not the raw `HTTP 400`.

## Document translation (Phase 34, wave-3 plan §7)

- **v1 targets are German and English only** (decided, plan §7). The bundled models and the
  Phase-29 eval set cover DE/EN; a free-text language field would invite silent quality
  failures. Widen only with evidence per language.
- **A translation is a snapshot, not a synced copy (accepted staleness edge).** The
  `origin_json` link records where the document CAME from — re-importing or re-indexing
  the SOURCE does not update an existing translation; the user re-runs Translate. If the
  source is later deleted, the provenance line says so ("a removed document") but the
  translation keeps working.
- **A window the model refuses/garbles is marked, never dropped.** After one retry the
  output carries a visible "could not be translated" notice with the ORIGINAL text kept
  below it; only an all-windows failure fails the whole task. Honesty over silent gaps.
- **Number/date FORMATS may localize even though values survive.** The R-T2 smoke on the
  real Qwen3-4B showed values, names, and invoice-style codes preserved, but formats
  adapted to the target language (*14.03.2026* → *March 14, 2026*; *39,90* → *39.90*).
  Correct translation behavior, stated honestly rather than promised away.
- **Long documents take time — linearly.** There is deliberately NO window ceiling (a
  faithful translation may not cover "the beginning" only, unlike the summary), so a
  100-page document is many model calls on a CPU laptop. Progress is visible per window
  and cancel always works (a cancelled translation persists nothing).
- **Export covers text documents only.** The Export action saves the STORED text
  (materialized translations are Markdown, so it is exact); PDFs/DOCX stored copies are
  original binaries and are not exported through this path.

## Document comparison (Phase 35, wave-3 plan §8)

- **Section-matched comparison is A-driven (asymmetric) UNLESS both documents are deeply
  indexed.** When two documents are too long to compare in full AND both have a ready deep
  index (and the smaller has ≤ 24 summary sections), the comparison is now **symmetric**:
  each document's summary sections are aligned by similarity and diffed pair-by-pair, so
  swapping A and B mirrors the result (rag-design §14.6). Otherwise it falls back to the
  A-driven path — each section of document A is matched with the most RELATED excerpts of
  document B (stored vectors, no new index) — which makes "only in A" findings reliable but
  can MISS content that exists **only in document B**. That fallback now carries a visible
  "one-directional — deeply index both for a complete two-way comparison" notice in the
  report. (The symmetric path lazily embeds each tree's summary sections on the CPU embedder
  sidecar the first time — once, then cached.)
- **The report covers the BEGINNING of document A when it is very long.** In the asymmetric path the
  map ceiling (12 calls, the summary's bounded-latency rationale) caps coverage; the report itself
  carries a visible notice when that happens. (The symmetric path can also truncate — a lopsided pair
  with many unmatched sections can overflow the reduce input — in which case it carries its own,
  document-neutral truncation notice instead.) Both documents stay fully searchable.
- **Report section headings are English even for German documents.** The four headings
  are dictated verbatim so the report structure is deterministic (R-T2-probed: the 4B
  keeps them); the findings under them follow the documents' language. Cosmetic, accepted
  for v1.
- **One-sided clauses may ALSO appear under "What differs" in small-doc compares.** The
  R-T2 smoke showed the 4B sometimes lists a fact present in only one document both as a
  difference ("…while document B does not mention this") and under its "Only in" section
  — accurate but redundant; prompt-tightening fixed the reduce path, the full-compare
  duplication is accepted (visible, never wrong).
- **Mixed-language pairs get a single-language report.** The prompt says "write in the
  language of the documents"; for a German/English pair the model picks one. Compare
  like-language documents (or translate one first — Phase 34 exists for this).
- **A comparison is a snapshot, not a synced copy** — the same `origin_json` staleness
  edge as translations; re-run Compare after the sources change.

## Audio transcription (Phase 36, wave-3 plan §9)

- **m4a/aac recordings are not supported.** The pinned whisper.cpp binary decodes
  WAV/MP3/FLAC/OGG only (probed with real files, R-W2); decoding m4a would require
  bundling ffmpeg (license + surface we deliberately avoid). The friendly failure asks
  to convert the file to WAV or MP3 — most voice-recorder apps offer this.
- **Transcription runs on the CPU at roughly real-time ÷ 1.5.** Measured (R-W4, small
  model, 4 threads): a 52-minute meeting took ~35 minutes; peak memory ~1.2 GB. The
  import shows honest "Transcribing… N%" progress and the app stays usable meanwhile.
  GPU-accelerated whisper is a possible later opt-in, never a default risk.
- **Re-indexing an audio document is a FULL re-transcription** (D35). The stored copy is
  the audio itself (the locked copy-into-workspace contract — also what makes the drive
  self-contained), and there is no separate transcript cache; a sha256-keyed cache is the
  recorded follow-up if re-index proves common. Preview/translate/compare do NOT
  re-transcribe — they read the stored transcript chunks.
- **Audio costs real drive space, twice the size on encrypted workspaces transiently.**
  The recording is copied into the workspace (encrypted at rest); imports >50 MB of
  audio ask first. Recordings also re-encrypt on every vault password change like any
  document sidecar.
- **mac/linux drives need a source-built whisper-cli.** Upstream ships a prebuilt binary
  for Windows only (R-W1); on other OSes audio import fails friendly until the drive
  builder compiles the pinned tag (see `drive-layout.md`). Windows-first, by the
  project's platform priority.
- **Transcription quality is the small model's.** Proper nouns and unusual terms can be
  misheard (R-W3: "LibriVox" → "Librebox"); numbers, names of people/places, and dates
  held up well in the German probes. The transcript is searchable text, not a notarized
  record.

## Voice dictation (Phase 37, wave-3 plan §10)

- **Dictation is click-to-start / click-to-stop, then transcribe — not live.** Streaming
  ASR (words appearing while you speak) is explicitly out of scope (D30); the per-file
  whisper CLI transcribes only a finished recording. The wait after stopping is the
  whisper small model's real-time factor (~0.5× on the reference CPU), so a 15-second
  dictation takes a few seconds to land. A warm whisper-server mode is the recorded
  follow-up if dictation latency ever warrants it (D34's revisit clause).
- **The mic appears only when the speech model is installed** (the same
  availability-driven gate as audio import — no settings key). On a drive without the
  whisper binary + weights there is no dictation affordance at all, by design.
- **Whisper, not the OS, decides what was said.** Dictation quality is the small model's
  (see "Audio transcription" above); the text always lands in the message box for review
  and is never auto-sent — that review step is the accuracy backstop.
- **No interim cancel-without-transcribe control.** Stopping the recording always
  transcribes and inserts; deleting unwanted text is one Ctrl+Z / selection away
  (the insert participates in the input's normal undo history). Leaving the screen
  mid-recording discards the recording and releases the microphone.

## Scanned-PDF / photo OCR (Phase 38, wave-3 plan §11)

- **OCR runs on the CPU at a couple of seconds per page** (R-O3: ~1.3 s recognition +
  ~0.4 s rendering per A4 page on the reference CPU with the shipped `best_int` data).
  That is exactly why it is **never automatic for PDFs** (D33): detection marks the
  scan, the user starts "Make searchable (OCR)" deliberately, sees per-page progress,
  and can cancel. A 200-page scanned book is a ~10-minute, user-chosen job.
- **Language coverage is German + English** — the two shipped traineddata files. Other
  languages will recognize poorly or not at all. Coverage is availability-driven (the
  engine uses whatever `ocr/*.traineddata.gz` the drive carries), so a future language
  is one vendored file away — but only deu+eng are pinned, reviewed, and tested.
- **Recognition quality is the scan's quality.** Clean 150-DPI office scans came back
  near-perfect in the R-O3 probes (103/104 words, umlauts/ß exact); a degraded ~80-DPI
  JPEG still lost 3 of 104 words. The per-page text is searchable content, not a
  notarized record — Preview shows exactly what was recognized.
- **Hybrid PDFs (some text pages, some scanned pages) are not detected as scans.**
  Their real text pages index normally; the scanned pages stay invisible to search.
  Detection only catches documents with NO readable text — per-page hybrid OCR is a
  possible follow-up, not shipped.
- **The recognized text survives re-index; re-running OCR is the explicit redo.**
  Re-index (e.g. after an embedder switch) reuses the stored recognition rather than
  silently re-OCRing for minutes; if the recognition itself was bad, run "Make
  searchable (OCR)" again — it overwrites.
- **Photos are read on import** (the D33 asymmetry — one image, seconds). A photo
  import without the OCR files on the drive fails per-file with friendly copy.
- **Packaged-app OCR needs the asar-unpacked tesseract packages** (worker_threads
  cannot load scripts from inside `app.asar`). Wired in `electron-builder.yml`;
  verifying a real OCR run from the produced portable .exe is a release-acceptance
  item (the green gate never packages — the R2 posture).

## Image understanding (Phases V1–V5, [`architecture.md`](architecture.md) "Image understanding — design record")

- **The first question about a full-resolution image is SLOW on CPU.** CPU prefill of a high-res
  image is ~52 s for ~2800 image tokens off USB (~12 tok/s decode) — measured on b9585 (V1). The
  client **downscale-to-1536 px** (`renderer/images/decode.ts`) is a real latency lever (fewer image
  tokens ⇒ proportionally less prefill), and `cache_prompt` reuse means **follow-up** questions about
  the same image skip the prefill — but the FIRST question per image pays it. GPU is the optimization
  lever (§19.11) if CPU time-to-first-answer is unacceptable; MVP runs CPU-pinned (`--device none`).
- **RAM peak is co-resident, and the idle teardown bounds the window, NOT the active-use peak
  (PROD-1).** The vision sidecar is a SEPARATE `llama-server` (not the chat slot), so at peak you can
  have **chat + E5 embedder + vision = three** processes. Vision peak ~4.6 GB + a 12B chat (~7 GB) +
  the embedder ⇒ **>16 GB** — a **12 GB machine will likely OOM and even 16 GB is tight**. The
  `recommended_min_ram_gb` / RAM-best-fit gate keeps a vision model off machines that can't hold it;
  the idle teardown (default 2 min) reclaims the ~4.6 GB once the user stops asking, but during active
  use the peak stands. Vision is realistically co-resident **only with a small chat model, or after
  the chat sidecar idles out** — not "12B chat + vision simultaneously" (model-benchmarks §8.4).
- **One image at a time; PNG/JPEG only; single-turn-thread per session; persisted but NOT
  searchable.** The Images screen takes a single image (no multi-image compare, no video, no camera);
  WEBP is deliberately out of MVP (no native dep to prove it safe in the import stack). As of the
  2026-06-20 change, an analyzed image and its Q&A turns are **persisted automatically** — the image
  rows live in `image_sessions`/`image_turns` and the bytes rest **encrypted at rest** under the SAME
  `DocumentCipher` as the document cache (`workspace/images/<id><ext>.enc`), browsable in an Images
  history list and **user-deletable** (delete shreds the image + cascade-removes its turns). What is
  still NOT true: this history is **not added to the RAG/document corpus** — it is a separate
  browsable history, never indexed for retrieval/search — and there is no auto-OCR.
- **Image understanding is NOT OCR and NOT image generation.** It reads/interprets one image with a
  vision-language model; scanned **documents** still belong to Documents → "Make searchable (OCR)"
  (tesseract.js), which is untouched. The Images screen never silently OCRs or routes to OCR, and the
  feature never generates/edits images (a permanent non-goal).
- **Context is capped at 4096 tokens** (vs the model's 128 000 train context) — fine for a single
  image + a short question/thread in MVP; long multi-turn threads about one image are not a v1 promise.
- **`imageReadBytes` takes an opaque token, not a path** (vuln-scan-2026-06-21 / `security-model.md`
  D2). `imageChooseImage` returns a one-time token; the absolute path stays in main, so the renderer
  can't make main read an arbitrary file. The byte cap is re-checked on the open fd (no TOCTOU), and
  the main-side guard also rejects decompression bombs by a decoded-pixel budget (D4).
- **No vision model ships on a commercial drive yet, but the sell gate already verifies BOTH files
  (DIST-2).** `assertCommercialDrive` → `verifyDriveModels` iterates the same `manifestFiles` set
  (GGUF + mmproj) that `computeInstallState` requires, so a half-installed vision drive (good GGUF,
  missing/corrupt projector) fails `weightsVerified`. The remaining DIY-only gap: the in-app
  `DownloadManager` still drives only `tasks[0]` (the GGUF); the projector is fetched by the
  `fetch-models.{sh,ps1}` scripts (the canonical two-file path) until a vision drive ships.

## Internationalization (Phases 39–42, [`architecture.md`](architecture.md) i18n record)

- **Task/summary output language follows the model, not the UI (D-L6 — RESOLVED as
  documented).** LLM prompts are pinned English (Phase-29 benchmark comparability; models
  follow the language of the user's question naturally), so a one-click summary of a German
  document may come back in English depending on the model. Making task-output language
  explicit is a separate future feature — it belongs with the existing
  `TranslationTargetLang` machinery, not with UI i18n.
- **Audit-log messages and the activity export stay English.** `runtime_events.message` is
  written and exported as-is (the export is a diagnostic artifact); only the friendly TYPE
  labels in the Diagnostics Activity panel are translated. Per the Phase-19 privacy rule the
  messages carry ids/filenames/counts, never content — a stable English diagnostic record was
  chosen over translated DB rows.
- **Interpolated and library-origin error strings render as-is under German.** The D-L4
  display map is exact-match over the finite persist-canonical set by design, so
  `documents.error_message` values like `Unsupported file type: .xyz` and raw parser-library
  errors (e.g. a pdfjs exception message) show English in a German UI. Rare failure-path
  remnants, accepted.
- **`user-guide.md`, `READ ME FIRST.txt`, and the drive docs are English-only for now.**
  Translating them is content work, tracked separately from UI i18n.
- **A conversation transcript can legitimately mix languages.** Old answers, model output,
  and the fixed RAG answers translate (or don't) independently of the current UI language —
  accepted.

## GPU acceleration (Phases 14–16, [`architecture.md`](architecture.md) GPU record)

- **Integrated GPUs (Intel Iris Xe / UHD, AMD APU "Radeon Graphics") gain little.** They share
  system RAM, so token generation is often near CPU speed (~1–2×); prompt processing improves
  more (2–4×). This is honest physics, not a bug — the app still uses them automatically when
  the driver is stable, but the hardware-profile bump deliberately ignores them so the model
  recommendation stays RAM-based.
- **Vulkan slower than CPU is possible** on weak-iGPU + fast-CPU machines. v1 does **not**
  auto-benchmark CPU vs GPU and pick a winner (decided, GPU record §1); the Settings
  "Use GPU acceleration" toggle covers that case.
- **`win/arm64` and `mac/x64` ship no sidecar build** (decided, GPU record §1). mac/x64 = Intel
  Macs: upstream builds them with Metal **off** and macOS has no Vulkan, so GPU acceleration is
  impossible there regardless; Apple discontinued the line in 2023.
- **Intel Macs are not supported by prepared drives at all** (pre-existing gap surfaced while
  planning the GPU work, not introduced by it): a drive's `mac/` dir holds an **arm64** binary
  that exists but cannot execute on x64, so the runtime selector picks the real backend and
  `start()` fails with a spawn error instead of falling back to the mock — and the fallback
  ladder's rungs 2–3 reuse the same wrong-arch binary. A DIY Intel-Mac user could drop a
  self-built x64 `llama-server` into `runtime/llama.cpp/mac/`; prepared drives do not.
- **A failed first GPU start auto-disables GPU persistently** (`gpuAutoDisabled`) even when the
  underlying cause was not the GPU (e.g. a corrupt model file failing rung 1). Harmless — the
  CPU rungs still run and Diagnostics → "Try GPU again" clears the flag in one click.
- **The probe labels; the ladder guarantees.** `--list-devices` proves enumeration, not stable
  inference — a driver can enumerate fine and crash on the first compute submit. That case is
  handled by the crash auto-fallback (one CPU restart + a friendly notice); the in-flight reply
  is lost, same as today's crash handling.

## Accessibility (Phase-27 WCAG 2.2 AA sweep — consciously accepted)

The Phase-27 sweep contrast-audited every role-token pairing in both themes (fix applied:
`--border-strong` → `--n-500`, the only sub-3:1 non-text boundary that was the SOLE component
identifier), added forced-colors (Windows High Contrast) rules for the two custom-drawn
controls (Switch, strength meter), and verified the reduced-motion kill-switch. Accepted
as-is, with reasons:

- **Hairline `--border` separators are ~1.3:1.** They are decorative row/card separators,
  never the sole identifier of a component (cards pair them with surface fill + shadow;
  inputs use `--border-strong`). WCAG 1.4.11 applies to required boundaries only.
- **The fatal "app could not start" screen shows the raw error string.** §7 keeps error
  codes inside Diagnostics, but when the backend never came up Diagnostics is unreachable —
  the raw string (plus the log pointer) is the only diagnostic the user can relay.
- **The Documents screen's per-row selection checkbox is 15px.** Under the 24px target
  minimum, but WCAG 2.5.8 is satisfied via the spacing exception: the row is ≥40px tall and
  no other target falls within the 24px circle around it.
- **The bundled main process can contain a duplicated, tree-shaken copy of a module**
  (observed: `workspace-vault`'s `WrongPasswordError`/`shredFile`), which breaks cross-copy
  `instanceof`. The wrong-password mapping now also matches `err.name`; other duplications
  are benign (pure functions). Root cause in electron-vite/rollup module ids — not chased
  in this phase.
