# BUILD STATE — HilbertRaum

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`CLAUDE.md`](CLAUDE.md)).
> It carries: current status, decisions, shared data contracts, next actions, open issues.


_Last updated: 2026-06-18 — **Performance audit Wave P1 SHIPPED (branch `performance-tuning`).** Six
high-ROI, low-risk, constant-factor/batching wins from `docs/performance-audit-2026-06-18.md` §6,
targeting the two hottest user operations (import a document, ask a question) on the CPU-only USB
target — no behavior change. **Shipped (one commit per finding):** (1) **DB-1 (Critical)** —
`processDocument` was the lone batch writer not wrapping its inserts; the delete-then-insert chunk
phase and the embedding-insert phase are each now one `BEGIN…COMMIT` (`ROLLBACK` on throw,
`tree-build.ts` pattern), the async `embedder.embed()` await kept OUTSIDE the txn (`node-vectors.ts`
precedent). Collapses ~3000 fsync'd auto-commits/doc (1000 chunks ×(insert+FTS trigger) + 1000
embeddings) → 2. (2) **DB-2 (High)** — after WAL, `openDatabase` now sets `synchronous=NORMAL`,
`busy_timeout=5000`, `mmap_size=268435456`, `cache_size=-16000`, `temp_store=MEMORY`. (3) **DB-4/6/7
(Medium)** — additive `CREATE INDEX IF NOT EXISTS` (after `ensureColumn`): `idx_embeddings_model`,
`idx_extract_type_nv(record_type, normalized_value)`, `idx_documents_status`,
`idx_bank_transactions_category`; **`run_id` indexes deliberately OMITTED** — `run_id` is only ever
INSERTed, never joined/filtered (would be pure USB write-amplification). (4) **RAG-2/ING-1 (High)** —
compare mode-(b) now decodes doc-B's `(id,text,chunk_index,vector)` ONCE into a resident array and
cosines in memory (local `nearestB()` reproducing `VectorIndex.search` ranking) instead of
re-`search`ing + re-decoding all of doc-B per A-chunk and re-fetching B's text per window; mirrors
`alignNodes` (`compare.ts`). (5) **DB-3/ING-2 (High)** — `listDocuments` per-row COUNT +
per-indexed-row COUNT+JOIN (1+2N queries, polled at 400 ms during import) → two `GROUP BY document_id`
queries into Maps (mirrors the memberships join beside it); removed the now-unused `chunksEmbeddedUnder`
helper. (6) **RT-1 (High)** — chat sidecar left `--batch-size`/`--ubatch-size` at llama-server's 512
default, throttling prompt prefill (the dominant TTFT cost, 3.5–15 s CPU per Skills §17); new opt-in
`LlamaServerOptions.physicalBatchSize` (emitted by `buildArgs`) set by the chat runtime to
`min(contextTokens, CHAT_MAX_PHYSICAL_BATCH=2048)` — embedder/reranker untouched (they set their own
batch via `extraArgs`); new `llama-runtime.test.ts` arg assertion mirrors the reranker test. **New /
changed data contracts:** PRAGMA `synchronous=NORMAL` (WAL-safe durability change — only the last txn
is at risk on OS/power loss, never corruption) + the four other PRAGMAs; four new indexes; ingestion
writes are now atomic per phase; new sidecar arg `physicalBatchSize` ⇒ chat spawns with
`--batch-size`/`--ubatch-size`. **Docs:** lasting decisions folded into `docs/architecture.md`
"Performance — design record (perf audit 2026-06-18, Wave P1)"; the audit report is RETAINED (findings
record) with each P1 finding tagged **✅ IMPLEMENTED** and §6 Wave P1 checked off. **Verification:** full
suite **1757 passed / 25 skipped** (+1, the RT-1 arg test), typecheck + build clean. **NEXT ACTION:**
Wave P2 (renderer responsiveness — FE-1/FE-2/FE-7/FE-3-5) when picked up; Waves P3/P4 tracked in the
audit §6._

_(prior) 2026-06-17 — **Skills Phase S13c SHIPPED — surprise-mitigation UX; S13 (auto-fire) is
now FULLY CLOSED.** The S13b mechanics are now reachable by a user, behind the two ratified D3/D4
surfaces, both EN/DE. **Shipped:** (1) **The opt-in toggle (D4):** a Switch in **Settings → Skills**
([`SkillsTab.tsx`](apps/desktop/src/renderer/screens/settings/SkillsTab.tsx)) reads/writes the existing
`skillsAutoFireEnabled` setting through the shared `updateSettings` patch path — **off by default**,
hidden until settings load (never implies an unconfirmed state). This is the ONLY control that makes
S13b reachable; until it ships auto-fire could not be enabled. (2) **The per-turn undo (D3):** an
auto-fired turn stamps an **additive, nullable `messages.auto_fired` column**
([`db.ts`](apps/desktop/src/main/services/db.ts)) — set only when the auto-fire path placed the skill
AND the fence fit (the §22-A5 stamp-only-when-fenced precedent), so it lines up 1:1 with the glyph and a
deleted skill drops glyph+undo together. Threaded additively via `TurnSkill.autoFired` (set by
`resolveAutoFireSkill`) → `appendMessage`/both generators (`chat.ts` `generateAssistantMessage`,
`rag/index.ts`) → `Message.autoFired` (read back in `rowToMessage`). The [`Transcript`](apps/desktop/src/renderer/chat/Transcript.tsx)
glyph on an auto-fired turn reads **"Answered with `<skill>`"** + a one-click **"answer without it"** on
the LAST assistant turn; tapping it ([`ChatScreen`](apps/desktop/src/renderer/screens/ChatScreen.tsx)
`onAnswerWithoutSkill`) re-runs the SAME question with the skill **explicitly cleared
(`skillInstallId: null`)** — the explicit per-turn clear stamps no skill AND suppresses a re-auto-fire.
Reuses the regenerate path in BOTH modes; `askDocuments` gained a symmetric `regenerate` arg (drop the
last assistant turn, re-use the existing last user turn — never a duplicate user row). Skill title
localized via `skillI18n.ts`. **DECISION (recorded):** the renderer learns a turn was auto-fired via the
additive `auto_fired` column (privacy-safe boolean, mirrors the additive-schema + stamp-only-when-fenced
precedents) — chosen over "show the undo on every skill turn" (which would surface it on explicit picks,
contradicting D3). **Safe-merge property INTACT:** default-off setting + no bundled skill declaring
`triggers.autoFire` ⇒ a fresh install behaves identically to pre-S13. **§6/§14 ceilings unchanged:** the
undo is a re-run not a new capability; no auto-fire path logs the question or adds an audit event; the
S12 sentinel guard still holds. **Docs:** `docs/skills-s13-plan.md` **folded into
`architecture.md` "Skills — design record" §18 (+ §6 cross-ref + legend rows) and DELETED** (doc-lifecycle
rule; original in git history). **New contracts:** `messages.auto_fired` (additive nullable);
`Message.autoFired` / `TurnSkill.autoFired`; `skillsAutoFireEnabled` is now user-toggleable;
`askDocuments(convId, question, skillInstallId?, regenerate?)`. Full suite green (**1756 passed / 25
skipped**, +9), typecheck + build clean. **NEXT ACTION: none — S13 is done.** Auto-fire is now
user-enableable (default off) with a visible glyph + a per-turn undo; product opt-in (a bundled skill
declaring `triggers.autoFire`) remains a later deliberate choice._

_(prior) 2026-06-17 — **Skills Phase S13b SHIPPED — auto-fire MECHANICS, behind a default-off
opt-in (INERT in production until S13c).** The ratified D1–D6 contract (§2.1) is now built; auto-fire
fires only when a user opts in AND a skill declares it AND no skill is otherwise set. **Safe-merge
property: with the new `skillsAutoFireEnabled` setting defaulting FALSE and no S13c toggle yet, S13b
changes NOTHING in production behaviour** — `resolveAutoFireSkill` is a true no-op when off, and no
bundled app skill declares `triggers.autoFire` yet, so the candidate set is empty regardless. **Shipped:**
(1) **Schema (D6):** `triggers.autoFire?: boolean` in [`skill-manifest.ts`](apps/desktop/src/shared/skill-manifest.ts)
— additive + lenient (only boolean `true` opts in; non-boolean noted+clamped to false; absent/false →
`undefined` so existing `manifest_json` is byte-unchanged), parser-validated (camelCase + `auto_fire`),
round-trip tested; mirrors the `localized`/`reservesTools` precedent. (2) **Threshold (D2):**
`AUTOFIRE_SCORE_THRESHOLD = 3` in [`selector.ts`](apps/desktop/src/main/services/skills/selector.ts)
(distinct from `SUGGEST_SCORE_THRESHOLD = 2` — suggestion UNCHANGED) + `selectAutoFire` sharing a
`selectByThreshold` helper with `selectSuggestion` (differ only in the gate). Score ≥ 3 structurally =
"keyword + ≥1 doc signal". (3) **Decision path:** new [`autofire.ts`](apps/desktop/src/main/services/skills/autofire.ts)
`resolveAutoFireSkill(db, deps, conversationId, question)` — candidates = enabled + available +
**app-only** (`source==='app'`, D4) + **`triggers.autoFire===true`** (D6) + **compatible**
(`skillNeedsNewerApp`, §6.5/M1), scored via the existing `scoreSkillTriggers`, gated at the new
threshold, deterministic installId tie-break. Shares the **factored-out**
[`scope-signals.ts`](apps/desktop/src/main/services/skills/scope-signals.ts) `inScopeDocSignals` with
`suggest.ts` (no duplication). LOGS NOTHING (question is content — §6). (4) **Opt-in (D4):** persisted
`skillsAutoFireEnabled` boolean in `AppSettings`/`DEFAULT_SETTINGS` (default **false**); the resolver
reads it first and no-ops when off. (5) **Plumbing (D5/§22-A1):** `resolveTurnSkill`(+`FromRegistry`)
gains an optional `question` and calls auto-fire **only** in the would-return-null branch AND only when
`requestedInstallId === undefined` (so a sticky default, a per-turn pick, and an explicit per-turn
clear `null`/`''` are all respected); both chat channels (`registerChatIpc`/`registerRagIpc`) pass the
turn text so a documents conversation auto-fires too. (6) **Harness is now the GATE:**
[`skill-triggers.test.ts`](apps/desktop/tests/eval/skill-triggers.test.ts) asserts the `threshold-3`
policy (sharing `AUTOFIRE_SCORE_THRESHOLD`) clears D1 as **`fired-wrong == 0` AND `precision ≥ 0.95`**
(owner-set form, survives corpus growth) ALONGSIDE the kept baseline printout. (7) **Privacy guard
extended:** the S12 sentinel test drives a sentinel-bearing question through `resolveAutoFireSkill` —
reaches no console stream, never the resolved skill object. **New contracts:** `AUTOFIRE_SCORE_THRESHOLD = 3`;
`resolveAutoFireSkill`; setting key `skillsAutoFireEnabled` (default false); the harness-as-gate
(fired-wrong==0 ∧ precision≥0.95). `docs/skills-s13-plan.md` §4 folded to "implemented" but STAYS OPEN
(deleted only when S13c closes). Full suite green (**1747 passed / 25 skipped**, +21), typecheck + build
clean. **NEXT ACTION: S13c (surprise-mitigation UX)** — the Settings → Skills opt-in TOGGLE (flips
`skillsAutoFireEnabled`, off by default) + the per-turn "Answered with <skill> — answer without it"
UNDO affordance (re-runs the turn skill-free, the regenerate precedent), EN/DE copy. The glyph already
stamps an auto-fired turn (visible). Until S13c ships the toggle, auto-fire cannot be enabled by a
user, so S13b is inert._

_(prior) 2026-06-17 — **Skills Phase S13a SHIPPED — auto-fire EVALUATION HARNESS + corpus +
baseline (NO runtime behaviour change).** S13 (auto-fire triggers) is gated: auto-fire ships only after
an offline harness proves a precision bar on a labelled corpus. S13a is that harness + the baseline —
pure measurement, no behaviour change; S13b (auto-fire mechanics) and S13c (UX) stay GATED and unstarted
until the owner ratifies D1–D6 from these numbers. **Shipped:** (1) a **synthetic, no-user-data** corpus
of **33 labelled turns** ([`apps/desktop/tests/fixtures/skill-triggers/corpus.json`](apps/desktop/tests/fixtures/skill-triggers/corpus.json))
— de-AT + EN true positives, lone-doc-signal true negatives, filename-near-miss + generic-substring
adversarials; label space = the four real enabled app skills. (2) a deterministic vitest harness
([`apps/desktop/tests/eval/skill-triggers.ts`](apps/desktop/tests/eval/skill-triggers.ts) +
`skill-triggers.test.ts`) that scores the corpus through the **real** `scoreSkillTriggers`/
`selectSuggestion` (no model/network/DB — DS4) and reports precision/recall + the four-cell confusion
matrix, sweeping a few higher thresholds (the D2 proposal). A faithfulness guard pins `threshold-2` ≡
`selectSuggestion`; a privacy guard pins that no corpus question reaches any console stream (extends the
S12 sentinel posture — the question is content, §6). Runs as a MEASUREMENT, not yet a gate-assertion
(the bar lands in S13b). **Baseline** (recorded in `docs/skills-s13-plan.md` §3.3.1): threshold-2 (today)
**60.7%** precision / 100% recall (11 false fires); keyword-required (D2) **81.0%** / 100% (4 residual
substring false fires — the deterministic-keyword precision ceiling); **threshold-3** (keyword + ≥1 doc
signal) **100%** / 88.2% (only 2 keyword-only misses, and a miss is cheap); threshold-4 100% / 70.6%
(too strict). **Reading:** today's threshold is far below an auto-fire bar; a keyword gate alone can't
close the substring false fires; threshold-3 is the natural D2 setting for a ≥95% D1 bar. **D1–D6 RATIFIED by the owner 2026-06-17**
(recorded in `docs/skills-s13-plan.md` §2.1): D1 ≥95% precision; **D2 = `threshold-3` — fire only on a
keyword hit corroborated by ≥1 doc signal** (the literal "require a keyword" was refined up, since it
scores only 81%); D3/D4/D5/D6 as proposed (silent-apply + glyph + undo; opt-in, app-only; fire only when
no skill is set; additive `triggers.autoFire?: boolean`). S13b's hard gate-assertion form is owner-set:
**fired-wrong == 0 AND precision ≥ 0.95** (not a brittle `==100%`), and the corpus should grow with
real-world phrasings. **NEXT ACTION: S13b (auto-fire mechanics)** — `AUTOFIRE_SCORE_THRESHOLD = 3`, the
`triggers.autoFire` schema, `resolveAutoFireSkill` plugged into `resolveTurnSkill`/both chat channels
(app-only + opt-in + only-when-no-skill-set), and flip the harness to the hard gate. Was deferred out of
this session by directive; ready to start. `docs/skills-s13-plan.md` stays OPEN (deleted only when S13
fully closes). Full suite green
(**1726 passed / 25 skipped**), typecheck + build clean._

_(prior) 2026-06-17 — **Skills — active-skill turn-latency: measured root cause + prefix-cache fix
(no new phase).** Report: "chat with a skill active feels slower than with no skill." **Measured before
theorizing** (temporary content-free perf harness over the real bundled SKILL.md files + synthetic
bodies, deleted after measuring — §22-M1). Findings: main side is **< 1 ms/turn** for a bundled skill
(`loadSkillPackage` ≈ 0.65 ms, `buildSkillFence` ≈ 0.06 ms) — NOT the cause. The real driver is the
**measured 288–381-token** body (≈ 447 tokens with framing/guard) injected per skill, paid in **prefill**:
sub-100 ms on GPU but **~3.5–15 s on a laptop CPU** — explains the "noticeably slower" feel and the
CPU/GPU difference. Whether that prefill is one-time (plain chat, fence in the **stable system prefix**)
or per-turn (grounded, fence rides the **varying user turn** by §22-H2 placement) is governed by KV-cache
prefix reuse — which the app was leaving to the llama-server default. **Two low-risk fixes (behind the
unchanged §7 ceiling — offline, audit ids/counts-only, no i18n surface):** **(PERF-1)** the chat request
now sends **`cache_prompt: true` explicitly** ([`runtime/llama.ts`](apps/desktop/src/main/services/runtime/llama.ts)
`chatStream`) so the slot reuses the longest common prefix instead of relying on a release-dependent
default → plain-chat fence is a **one-time** prefill, not per-turn (asserted in `llama-runtime.test.ts`).
**(PERF-2)** the per-turn `loadSkillPackage` ([`skills/loader.ts`](apps/desktop/src/main/services/skills/loader.ts))
is **cached by SKILL.md (mtime,size)** — measured **~33 µs hit vs ~650 µs** uncached (~20×; far more on a
slow portable drive, and it elides the O(paragraphs²) ~19 ms re-size for a 64 KB user skill). DS1/DS2
honoured (an on-disk edit re-parses); reconcile/installer call `parseSkillManifestFromDir` **directly**,
bypassing the cache, so disk→DB stays fresh (new `skills-loader-cache.test.ts`). **Recommended, not done**
(scope/risk, recorded in the design record): grounded fence stays per-turn by placement (keep bodies
small); a large user skill's question-dependent fence trim can shift the plain-chat prefix and defeat
PERF-1 — a fixed user-turn reserve would stabilize it but changes the §22-A6 budget contract (no-op for
every shipped skill). Design record: **architecture.md "Skills — design record" §17**. Full suite green
(**1718 passed**), typecheck + build clean._

_(prior) 2026-06-17 — **Skills — per-locale DISPLAY localization (no new phase).** Skill content
(title/description) was English-only in a German UI (the chrome is i18n'd, but the manifest carried a
single title/description) — visible in the composer picker, the per-message glyph, and Settings →
Skills. Fixed for the **display metadata** (the body stays single-language — the model is multilingual,
D-L6). Design record: **architecture.md "Skills — design record" §16**. **Additive manifest block:**
`SKILL.md` may carry `localized:` (locale → {title?, description?}), parsed in
[`skill-manifest.ts`](apps/desktop/src/shared/skill-manifest.ts) (lenient: malformed/blank/over-long/
multi-line → noted+skipped, never an error; ≤16 locales; keys lower-cased). `SkillManifest.localized` +
`SkillInfo.localized` are optional/additive (manifest_json round-trips it); `recordToInfo` projects it.
**Renderer pick:** a pure helper [`renderer/lib/skillI18n.ts`](apps/desktop/src/renderer/lib/skillI18n.ts)
(`localizedSkillTitle`/`localizedSkillDescription` + `skillTitleResolver` for the glyph), used by
`SkillPicker`, the Settings → Skills cards + detail, and the `Transcript` glyph (installId→title resolver
threaded from `ChatScreen`, built from the full skills list with a stamped-title fallback); every pick
falls back to canonical text. **Bundled skills:** all four (`bank-statement`/`invoice`/`document-redaction`/
`meeting-protocol`) gained a `localized.de` title+description (triggers were already bilingual). Display
only — nothing threads locale into `resolveTurnSkill`/the prompt, so the §7 gate + ceiling are unchanged
and the injected body is byte-identical regardless of UI language. Tests: manifest parser (parse/lenient/
bounds/single-line), the renderer helper (`skill-i18n.test.ts`), and the real bundled manifest's de
override projected through `recordToInfo`. Full suite green (**1713 passed**), typecheck + build clean.
EN/DE app-string parity still compile-enforced._

_(prior) 2026-06-17 — **Skills — LOW / residual follow-ups (no new phase).** The four remaining
LOW/residual items after the §14 audit, all fixed behind the unchanged §7 ceiling (no new capability,
still offline, audit still ids/counts-only, EN/DE parity compile-enforced). Full design record:
**architecture.md "Skills — design record" §15**. **(1) Docs:** [`user-guide.md`](docs/user-guide.md)
gained a §8 "Skills" section (composer picker, per-message glyph, one-tap suggestion, tool skills +
run bar + confirm/cancel, Settings → Skills with import/enable/delete, drop-ins install disabled, the
"Needs newer app" badge) and [`troubleshooting.md`](docs/troubleshooting.md) gained four entries
(drop-in disabled DS19, structural import-rejection reasons, the "Needs newer app" badge, "the skill
tool found nothing"). **(2) `reconcileBalances` honesty:** the lone **baseline** row (first row, or any
row whose predecessor printed no balance) is now `unknown`, not `ok` — `reconciled` needs ≥1 row
genuinely compared against a predecessor (`okCount > 0`), so a single-transaction statement reports
`reconciled: false` / `resultKind: 'unchecked'` instead of "reconciled having verified nothing". The
downstream `resultKind` logic was already keyed off `unknown` (unchanged); the baseline now persists
`reconciled = NULL`. Invoice (`validateInvoiceTotals`) has no baseline concept → no change.
**(3) Cancel ⇄ audit consistency:** when `ctx.signal.aborted`, the gate
([`tool-registry.ts`](apps/desktop/src/main/services/skills/tool-registry.ts)) suppresses the
`skill_run_failed` audit event (a cancelled run audits as started-then-no-terminal), so it agrees with
the `skill_runs` row the seam records as `cancelled`; a genuine non-cancel `!ok` still audits failed.
**(4) minAppVersion gate airtight (the §14/M1 residual):** the use-sites now gate on **compatibility**,
not just `enabled`, reusing `skillNeedsNewerApp`. App version (already threaded via `app.getVersion()`
in §14) carried into `resolveTurnSkill` (`turn.ts` + the registry handle's new `appVersion` field),
`suggestSkillsForTurn` (`suggest.ts`), and `runnableToolNames`/`runnableToolsForSkill` (`tool-runs.ts`,
threaded at both the `listRunnableTools` and `startSkillRun` IPC sites) — so a skill edited on disk to
need a newer app while already enabled is skipped at turn-resolution, never suggested, and refused at
run start. Tests added/extended for each fix (bank-statement unit: single-row/all-baseline/genuine
match+mismatch; tool-registry unit: mid-run-cancel emits no `skill_run_failed`; turn/suggest/tool-run-IPC
integration: enabled-but-incompatible excluded from all three use-sites). Full suite green, typecheck +
build clean._

_(prior) 2026-06-17 — **Skills — content-reach + compatibility audit fixes (no new phase).**
A follow-up audit of the whole skills surface (bugs + docs-vs-code) found one HIGH + three MEDIUMs,
all fixed behind the unchanged §7 ceiling. **H1 (the headline fix):** the Tier-2 content-reading tools
(`extract_transactions`/`extract_invoice`/`redact_document`) had been reading the stored `chunks` table
through `readDocumentChunks` — but those are RETRIEVAL windows (newlines collapsed to spaces, ~80-token
overlap), so the line-oriented extractors got ≈0 rows and the redaction copy was de-formatted/duplicated
on actually-ingested documents (the tests masked it by seeding single chunks with real `\n`). Fix: the IPC
now injects a `readDocumentSegments` capability (the same `extractDocumentPreview` the doc-tasks use —
ordered, non-overlapping, newline-preserving parser segments re-extracted from the stored copy), and the
run seams build the tool reader from it via [`resolveDocumentReader`](apps/desktop/src/main/services/skills/run.ts);
the legacy chunk-table reader stays as the no-injection fallback. Ceiling unchanged — the SEAM holds the
FS/cipher closure, the reach stays frozen to the in-scope id, a failed re-extraction surfaces through the
tool's own "could not be read" path. The tool-run IPC tests now seed a REAL stored `.txt` so they exercise
the production path end-to-end (+ new bank/redaction seam tests prove the injected verbatim reader is
preferred over collapsed chunks). **M1:** the §6.5 `minAppVersion` gate is now ENFORCED (was parsed but
ignored) via a pure [`skillNeedsNewerApp`](apps/desktop/src/shared/skill-manifest.ts) — incompatible app
skills reconcile DISABLED, imports install disabled, the enable IPC refuses (`main.skills.incompatible`),
`SkillInfo` gains `incompatible`/`minAppVersion`, and the Skills tab shows a "Needs newer app" badge with
the toggle off; app version threaded from `app.getVersion()` through registry+installer deps+IPC. **M2:**
`skills.tool.note.active` is now domain-free (it had shown bank-tool copy for the invoice + redaction
skills). **M3:** the terminal-run acknowledge handshake is wired (`skills:clearToolRun` IPC + preload →
`SkillRunController.clear`, previously dead code). Full suite green (**1693 passed**, 25 skipped),
typecheck clean. Design record: **architecture.md "Skills — design record" §14**; drive-layout.md
"instruction stub" line corrected (four bundled skills). EN/DE i18n parity kept (compile-enforced)._

_(prior) 2026-06-17 — **Skills — third Tier-2 bundled app skill: `document-redaction` (content +
tests, no new phase).** A FOURTH app skill ships in `app-skills/`: **`document-redaction`**
(`id: document-redaction`, German "Anonymisierung"), the **third Tier-2 tool skill** and the
**read-transform-export** shape the bank/invoice domains don't exercise. ONE tool in
[`tools/redaction.ts`](apps/desktop/src/main/services/skills/tools/redaction.ts): `redact_document`
(permissions `['read-selected-docs','export-file']` ⇒ confirm-gated) reads the **whole** selected document
(the same `readDocumentChunks` reach over the frozen scope), masks personal data with **deterministic,
offline, regex-only** detectors (email/url/iban/date/phone — each a small pure exported function; dates
validated via the shared `parseDate`, IBANs by structure + per-country length, phones conservative
+country/0-leading shapes), applied in a **fixed order so masks never overlap**
(`email → url → iban → date → phone`) with a fixed category token per match (so redaction is **idempotent**),
and returns `{ redactedText, counts{email,phone,iban,date,url}, totalRedactions }` (JsonSchema-validated).
**Data contract: NO content-class table and NO `BEGIN…COMMIT`** — the deliverable is a FILE: the seam
[`runDocumentRedaction`](apps/desktop/src/main/services/skills/run.ts) records only the `skill_runs`
lifecycle row (started → terminal; `result_ref` stays **NULL**), writes `redactedText` via the existing
confirm-gated MAIN-side `saveTextFile('redacted.txt', …)` boundary, honours the cancelled-before-write
guard (B2) + B4, and surfaces only `totalRedactions` (a count) + a content-free `resultKind`
(`'redacted'`/`'clean'`). **Privacy (the strongest of the three):** the detected values never reach any
log/audit/`skill_runs` row; the redacted text lands ONLY in the user-chosen file. **Honesty:** regex
redaction is **best-effort, not a guarantee** (no ML, no name detection) — SKILL.md body + "done" copy say
review the copy before sharing; `docs/known-limitations.md` records the limit. Wired name `redact_document`
(`tool-registry.ts` REGISTRY + `tool-runs.ts` WIRED_TOOL_NAMES/buildToolRunner — null without
`saveTextFile`). New i18n EN/DE keys (`chat.skill.tool.redactDocument`, `chat.skill.run.done.redacted.*` +
`…redactedClean`); `SkillRunBar` gains the label + the redaction `resultKind` branch (handled like
`validate`). **No IPC / shared-type / controller change.** New tests:
[`skills-redaction-tool.test.ts`](apps/desktop/tests/unit/skills-redaction-tool.test.ts) (each detector
in isolation incl. near-misses + the full pass + idempotence + cancellation + the gate),
[`skills-redaction.test.ts`](apps/desktop/tests/integration/skills-redaction.test.ts) (committed SKILL.md
parse → kind:tool + 1 allowedTool + reservesTools; reconcile-enabled; dispatch descriptor; the read→mask→
write seam incl. clean/dismissed/throwing-save) + extensions to `skills-suggest.test.ts` (German "Bitte
dieses Dokument anonymisieren" clears the threshold), `skills-privacy-guard.test.ts` (a secret email+IBAN
through `redact_document` is **masked out of the saved copy** AND absent from audit/log/console/`skill_runs`),
`skills-tool-run-ipc.test.ts` (the confirm-gated redaction IPC writes `redacted.txt`, count-only state), and
the `skills-tool-registry.test.ts` registered-names list. Full suite green (1690 passed), typecheck + build
clean. Design record: **architecture.md "Skills — design record" §8** (redaction as the read-transform-export
Tier-2 reference, no data table — counts-only run row) + **known-limitations.md** (best-effort caveat)._

_(prior) 2026-06-17 — **Skills — second Tier-2 bundled app skill: `invoice` (content + tests, no
new phase).** A THIRD app skill ships in `app-skills/`: **`invoice`** (`id: invoice`), the **second
Tier-2 tool skill** — it mirrors `bank-statement` layer-for-layer to prove the gate generalizes to a
second content-class domain, with strong EN+DE coverage. Three tools in
[`tools/invoice.ts`](apps/desktop/src/main/services/skills/tools/invoice.ts): `extract_invoice`
(read-only; reads the selected invoice's chunks → header + line items + totals, deterministic/offline,
**conservative** — labeled-line header/totals, ambiguous data dropped, header fields optional),
`validate_invoice_totals` (read-only; half-cent checks — line items→net, net+tax→gross, tax vs. rate —
each ok/mismatch/unknown + a `reconciled` verdict + `resultKind`), and `export_invoice_csv`
(confirm-gated `export-file`; line-items CSV). The deterministic money/date primitives + the CSV
formula-injection `csvField` are now **shared** by both domains in
[`tools/money.ts`](apps/desktop/src/main/services/skills/tools/money.ts) (bank-statement.ts re-exports
them for compat; `detectCurrency` improved to scan all 3-letter tokens so an invoice number's "INV"
never blocks a later "EUR"). The run seam is the sibling
[`invoice-run.ts`](apps/desktop/src/main/services/skills/invoice-run.ts) (reuses `run.ts`'s
`buildReadDocumentChunks`/`finishRun`): same `skill_runs` lifecycle, atomic persist
(BEGIN…COMMIT/ROLLBACK), B2/B4 guards, latest-invoice-for-document downstream target, structured input
(no new `SkillToolContext` accessor — §14 ceiling unchanged). **Data contract:** two new content-class
tables — `invoices` (id, document_id, run_id, vendor, invoice_number, invoice_date, due_date, currency,
net_total, tax_total, tax_rate, gross_total, totals_reconciled, created_at) + `invoice_line_items` (id,
invoice_id, run_id, row_index, description, quantity, unit_price, line_total, currency, created_at),
indexed by document_id / invoice_id; `skill_runs.result_ref` now points at a `bank_statements.id` **or**
an `invoices.id`. Wired tool names: `extract_invoice` / `validate_invoice_totals` / `export_invoice_csv`
(`tool-registry.ts` REGISTRY + `tool-runs.ts` WIRED_TOOL_NAMES + buildToolRunner). New i18n EN/DE keys
(`chat.skill.tool.extractInvoice|validateInvoiceTotals|exportInvoiceCsv`, the invoice done/validate copy);
`needsExtraction` copy genericized "statement"→"document"/"Dokument". `SkillRunBar` gains the three labels
+ the invoice `resultKind` branch. **No IPC / shared-type / controller change** (the generic infra already
supports an arbitrary wired tool). New tests:
[`skills-invoice-tool.test.ts`](apps/desktop/tests/unit/skills-invoice-tool.test.ts) (parsers + each tool
through the gate + CSV formula-injection),
[`skills-invoice.test.ts`](apps/desktop/tests/integration/skills-invoice.test.ts) (committed SKILL.md
parse → kind:tool + 3 allowedTools + reservesTools; reconcile-enabled; dispatch descriptors; extract →
validate → export seams; needs-extraction guard; cancelled-save calm path) + extensions to
`skills-suggest.test.ts` (German "Prüfe die Beträge auf dieser Rechnung" clears the threshold),
`skills-privacy-guard.test.ts` (a secret through invoice extract→validate→export reaches only the
`invoice_*` tables + the CSV, never audit/log/console/`skill_runs`), and the `skills-tool-registry.test.ts`
registered-names list. Full suite green (1662 passed), typecheck + build clean. Design record:
**architecture.md "Skills — design record" §8/§10 + DS17**, **security-model.md** content-class list._

_(prior) 2026-06-17 — **Skills — second bundled app skill: `meeting-protocol` (content + tests
only, no new phase).** A second app skill now ships in `app-skills/`, chosen to exercise the paths the
bank-statement skill never touches. **`meeting-protocol`** is **Tier-1 instruction-only**
(`kind: instruction`, `allowedTools` empty / `reservesTools` false — it only injects fenced guidance,
no tools), and is the **bilingual-trigger** reference: its `triggers.keywords` carry German + English
terms, with umlaut singular/plural pairs listed separately (`beschluss`/`beschlüsse`,
`aufgabe`/`aufgaben`) because the §6 selector matches case-insensitive **substring**
(`question.includes`), so an umlaut breaks the substring. Pure folder drop-in — discovery is the
wholesale `resolveAppSkillsDir → listSkillFolders` scan, so **no IPC / shared-type / main-process
change**. New tests: [`skills-meeting-protocol.test.ts`](apps/desktop/tests/integration/skills-meeting-protocol.test.ts)
(parse → kind:instruction + `allowedTools===[]` + `reservesTools===false`; English+German trigger
coverage incl. the umlaut pairs; reconcile-enabled; resolveTurnSkill → fence with `SKILL_GUARD_LINE`
last) + a focused case in [`skills-suggest.test.ts`](apps/desktop/tests/integration/skills-suggest.test.ts)
(a German "Erstelle bitte ein Protokoll dieser Besprechung" clears `SUGGEST_SCORE_THRESHOLD` and is the
returned offer against the **real** selector; a neutral question returns none). Nothing pins the
app-skill set (the bank-statement test asserts `toContain`, not equality; commercial-drive tests use
synthetic temp fixtures). Design record: **architecture.md "Skills — design record" §1 / DS17**. Full
suite green (one unrelated **flaky** `logging.test.ts` rekey timing assertion passes in isolation),
typecheck + build clean._

_(prior) 2026-06-17 — **Skills — frontend IA + modal follow-ups (manual-test fixes, no new phase).**
Two issues found while eyeballing the running Skills surface, both fixed. **(1) Skills is now a top-level
rail destination, not a Settings tab.** `ScreenId` gains `'skills'`; `SettingsTab` drops it; a thin
[`SkillsScreen`](apps/desktop/src/renderer/screens/SkillsScreen.tsx) wraps the unchanged `SkillsTab`
body in `.screen` chrome (h1 = `skills.title`). `App.tsx` `NAV_TOP` adds `{ id:'skills', icon:'puzzle' }`
(new Lucide puzzle glyph in `Icon.tsx`) → rail is now Home · Chat · Documents · AI Model · **Skills** ‖
Settings. `resolveNavTarget('skills')` → the screen; the legacy `settings:skills` alias still resolves
(now to `{ screen:'skills' }`). New i18n `nav.skills` + `skills.title` (EN/DE); the unused
`settings.tab.skills` key removed. design-guidelines §2 updated (5 primary + 1 utility). **(2) The content
`Modal` now scrolls.** `Modal` wrapped its `{children}` directly in `.dialog`, so a tall body — e.g. a
skill's expanded "Technical details" — overflowed the dialog's `max-height` with no scrollbar (broken
layout). Children now sit in the existing `.modal-body` scroll region (flex:1 + min-height:0 + overflow-y),
matching `ConfirmDialog`. Tests updated (`InformationArchitecture`, `rail-labels`); full suite **1625
passed / 25 skipped**, typecheck + build clean._

_(prior) 2026-06-17 — **Skills — post-S12 audit follow-ups SHIPPED (no new phase; the wave stays
closed).** A second multi-persona audit of the whole skills surface (bugs + docs-vs-code) found **no
CRITICAL/HIGH**; the fixes landed behind the unchanged §14 ceiling (no new capability, still offline,
audit still ids/counts-only). Full design record: **architecture.md "Skills — design record" §13**.
**Bugs:** **B1/B2** — the run controller no longer re-derives a run's outcome from `signal.aborted`; the
seam is the authority (a dismissed CSV save dialog is a **cancel**, not a failure; a success that
out-races a late Cancel is reported `done` — never "cancelled, nothing changed"; `runCsvExport`
re-checks abort before the FS-write so nothing is written under a cancel). **B3** — `summarize_cashflow`
`net` is derived from the rounded totals (self-consistent). **B4** — `runBankExtraction` /
`prepareStatementRun` guard everything after the `skill_runs` 'started' insert, so an unexpected throw
drives a terminal `failed` (never a stranded `started` row). **CSV leading-whitespace** formula
injection (`"  =cmd"`) is now neutralized. **Reconcile one-active-per-id** (DS12) safety net: a DB
rebuild / late app skill that leaves two same-id rows enabled is collapsed to one (trust→version→
recency). **i18n:** **I1/I2** — run-failure copy and
import-preview errors now carry content-free reason **codes** (`SkillRunState.errorCode` /
`SkillPreview.errorCodes`) the renderer maps to EN/DE, so a German user never sees an English
failure/import string; the seam/controller stay i18n-free; EN/DE parity is compile-enforced
(`de: Record<keyof typeof en, string>` — the audit's "parity is convention-only" finding was wrong).
**Security:** **S1** — clamp/`manifest.json`-conflict **notes** no longer echo the raw frontmatter value
(closes the one §22-M1 gap where attacker text rode the `SkillPreview` IPC payload into the UI); **S2** —
`filenamePatterns` ReDoS bounded (parser caps length ≤200 / count ≤64; `selector.globToRegExp` refuses
>10 wildcards). **Docs:** **D1** removed the non-existent `skill_selected` audit event from §11; a new
**§-anchor legend** in the design record makes the ~130 historical `skills plan §N` citations + the kept
docs' `§9.5/§13/§14/§22-*` references resolvable (the fold had only retargeted the filename-style cites);
the stale S1 plan snapshot below is marked **superseded** (revoked DS11 + never-built DS13). New/updated
tests in `skill-manifest`, `skills-selector`, `skills-run`, `skills-installer`, `skills-tool-run-ipc`,
`skills-run-controller`, `SkillRunBar`; full suite **green**, typecheck clean. **No open SL-#.**_

_(prior) 2026-06-17 — **Skills Phase S12 SHIPPED — security audit pass + plans folded into the
§-records. The ENTIRE Skills wave (S2→S12) is now CLOSED.** The repo's multi-persona audit ran end to
end over the whole skills surface against the untrusted-skill-as-input threat principle (§14): import
(zip-slip / symlink / zip-bomb / nested-archive / magic-byte), prompt-injection containment (fenced data
turn + the guard line winning + base/grounding always winning), the Tier-2 gate (frozen `documentIds`, no
`Db`/SQL/FS/net handle, input+output validation, confirm-gating, the CSV FS-write boundary), content-class
isolation (`bank_*` + `skill_runs` never logged/audited/exported), ids/counts-only audit, and
`requireUnlocked` on every DB-backed channel. **No CRITICAL/HIGH.** ONE LOW fixed: spreadsheet
**formula-injection** in `export_transactions_csv` — `transactionsToCsv` now prefixes a leading
`= + - @`/tab/CR free-text field with `'` so a crafted statement can't execute on CSV open (numeric
columns untouched; unit-tested). The scattered S10/S11 sentinel tests were **consolidated** into a new
[`tests/integration/skills-privacy-guard.test.ts`](apps/desktop/tests/integration/skills-privacy-guard.test.ts):
one secret driven through every sink (import error, loader, all five tool runs, the CSV export, the IPC
`SkillRunState`) **plus a console spy**, proving absence in audit/log/console/run-metadata while confirming
the deliberate exceptions (content-class tables + the user-chosen CSV); a prompt-injection containment test
proves the guard line stays structurally last even with a hostile body forging the fence delimiter. Two LOW
residuals accepted + documented in `known-limitations.md` (prompt text-injection contained by the structural
ceiling not delimiter-escaping; a user skill's `filenamePattern` is a bounded RegExp run only on a user
action). **Fold (doc-lifecycle rule):** a NEW **"Skills — design record (Phases S2–S12, §1–§12)"** in
`architecture.md` consolidates `skills-plan.md` §1–§19 + `skills-s11-plan.md` (Storage narrative trimmed to a
pointer); the security bits extend `security-model.md` ("Skill tool ceiling" + the S12 audit note + the
CSV-injection note); the 14 in-code/test plan-FILE citations now cite "Skills — design record §N"; **BOTH
plan files deleted** (`git rm`; originals in git history). 8 new tests; full suite **1614 passed / 25
skipped**, typecheck + build clean. **No open SL-#.** **Carry-forward (RESIDUAL, forwarded one last time):**
the running-model Playwright eyeball of the run surfaces (busy row + the now-production-firing export confirm
modal + the result rows) was NOT captured — it needs a seeded indexed statement + a live run + a stubbed
native save dialog, not reliably author-and-verifiable here; the residual + a concrete recipe live in
[`docs/design-review/skills-s12/README.md`](docs/design-review/skills-s12/README.md), and every visual state
is unit-covered by `SkillRunBar.test.tsx`. See the **"Skills — S12 handoff"** block below. **The Skills wave
is done.**_

_(prior) 2026-06-17 — **Skills Phase S11c SHIPPED — remaining bank tools + data tables +
SKILL.md flip to `kind:'tool'`.** The LAST sub-phase of S11. Adds the four downstream bank tools to
`tools/bank-statement.ts` + the `REGISTRY`: `validate_statement_balances` (reconciles each row's
printed vs computed running balance → a per-row `reconciled` flag; honest 'ok'/'mismatch'/'unknown'
status, never invented), `categorize_transactions` (deterministic rule-based → `category_id`, seeding
the built-in `bank_categories`/`bank_category_rules`), `summarize_cashflow` (read-only inflow/outflow/
net totals), `export_transactions_csv` (confirm-gated `export-file`). **Design (recorded):** the
three downstream tools operate on the ALREADY-EXTRACTED rows, which the seam loads (the LATEST
`bank_statements` for the in-scope doc) and passes as STRUCTURED INPUT — tools stay pure, **no new
`SkillToolContext` accessor** (the §14 ceiling is unchanged). New seam fns in `run.ts`
(`runBalanceValidation`/`runCategorization`/`runCashflowSummary`/`runCsvExport`) persist atomically
(BEGIN…COMMIT/ROLLBACK, no-partial-persist). **The CSV export is the first FS-write from a skill
tool:** the pure tool only *produces* the CSV; the IPC layer's `saveTextFile` writes it MAIN-side to a
user-chosen path (save dialog + `writeFile`), gated on `export-file` + the confirm — **path + content
never logged/audited** (only "saved N rows" surfaces). Additive content-class DDL in `db.ts`
(`bank_categories`/`bank_category_rules`/`bank_corrections` + `bank_transactions.category_id/reconciled/
confidence`; never logged/audited/exported). `tool-runs.ts`: `buildToolRunner` gains a case per tool
(+ an opaque `saveTextFile` dep) and `runnableToolNames` is **retargeted** from the `reservesTools`
gate to `resolveEffectiveTools(allowedTools ∩ registry ∩ grant)` now that the flip makes `allowedTools`
effective. **The flip:** `app-skills/bank-statement/SKILL.md` → `kind:'tool'` (SL-1 path keeps the
declared list) + the §6.6 reconcile body; S5 drawer note → the real tool list (`skills.tool.note.active`)
+ the kind-gated "✓ Use approved local tools" line. Generic infra gained ONE content-free field
(`SkillRunState.resultKind` — validate's 'reconciled'/'unreconciled'/'unchecked' verdict; the bank
meaning lives only in the renderer's copy map). EN+DE („du"). 26 new tests (downstream tool units 13,
run-seam integration incl. the export sentinel/cancel/no-confirm 7, IPC export confirm→save 4, the DDL
+ flip-contract + resolveEffectiveTools retarget + SkillRunBar outcome tests). Full suite **1606
passed / 25 skipped**, typecheck + build clean. Docs: architecture.md + security-model.md (the S11c
tool set + the CSV FS-write boundary), `docs/skills-s11-plan.md` (§2 S11c done; status → CLOSED, ready
to fold at S12). SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright eyeball
of the busy row + the (now production-firing) export confirm modal is still uncaptured (the S6-style
walk needs a seeded indexed statement + a live run). See the **"Skills — S11c handoff"** block below.
Next: **S12** (fold `docs/skills-s11-plan.md` into the §-records per the §18 fold-map, then delete it;
the skills security hardening/audit pass)._

_(prior) 2026-06-17 — **Skills Phase S11b SHIPPED — app-orchestrated run trigger + busy row +
write-confirm modal.** The S11a `run.ts` seam is now startable from a USER action (DS4 — never the
model). New generic, bank-free [`services/skills/run-controller.ts`](apps/desktop/src/main/services/skills/run-controller.ts)
(`SkillRunController`: single active run, polling state, Cancel via `AbortSignal`, one-at-a-time) +
[`services/skills/tool-runs.ts`](apps/desktop/src/main/services/skills/tool-runs.ts) — the ONE place
that maps a tool name → the `run.ts` seam (bank specifics stay out of the generic infra, §13), resolves
the in-scope document(s) MAIN-side from the conversation (§22-C4), and bridges the app `AuditRecorder`
down to the ids/counts-only `SkillToolAudit`. Four GENERIC `skills:*` IPC channels (`listRunnableTools` /
`startSkillRun` / `getSkillRun` / `cancelSkillRun` — NOT bank-named, so S11c slots its tools in with no
renderer/IPC change), all `requireUnlocked`, **logging NOTHING content-bearing** (scope is content;
responses are ids/counts only) + preload. Renderer: [`renderer/lib/skillruns.ts`](apps/desktop/src/renderer/lib/skillruns.ts)
(the doc-task polling-store precedent — no new event channel) + [`renderer/chat/SkillRunBar.tsx`](apps/desktop/src/renderer/chat/SkillRunBar.tsx)
(calm OFFER "Extract transactions" → RUNNING "Running: `<tool>` on `<N>` documents… Cancel" → RESULT
"Extracted N transactions"; the **`ConfirmDialog` write/export path** built now even though the read-only
`extract_transactions` skips it), wired into ChatScreen. The trigger keys off the skill's `reservesTools`
signal (the instruction-kind parser discards declared tool NAMES, S9/SL-1) — it switches to the effective
`allowedTools ∩ registry ∩ grant` set at the S11c flip with no renderer change. EN+DE („du"). The bank
skill **stays `kind: instruction`** (the flip + the other 4 tools + reconcile body are S11c). 17 new tests
(run-controller 6 incl. cancel + the synthetic-write-tool confirm gate, tool-run-ipc 5 incl. the "logs
nothing" sentinel, SkillRunBar 6). Full suite **1580 passed / 25 skipped**, typecheck + build clean.
Docs: architecture.md ("Bank-statement tools + the run seam" → the S11b trigger/UI paragraph),
security-model.md ("Skill tool ceiling" — the run trigger + IPC add no content to the log), this plan §2.
SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright eyeball of the busy row +
confirm modal is deferred (the S6-style walk; needs a seeded doc + a live run). See the **"Skills — S11b
handoff"** block below. Next: S11c (the other 4 tools + flip SKILL.md to `kind:'tool'` + reconcile body)._

_(prior) 2026-06-17 — **Skills Phase S11a SHIPPED — `extract_transactions` + `skill_runs` +
bank data tables behind the gate.** First Tier-2 *feature* slice (the plan doc
[`docs/skills-s11-plan.md`](docs/skills-s11-plan.md) was authored + the scope cut RATIFIED by the owner
first: ship `extract_transactions` only; defer `export_transactions_csv` to S11c; content-read =
page-addressable chunks; runs are purely user-initiated). Adds to `SkillToolContext` the ONLY content
reach a tool gets — `readDocumentChunks(documentId) → {text,page,index}[]`, scope-bounded to the frozen
`documentIds` (out-of-scope id ⇒ `[]`; still no `Db`/SQL/FS/net handle). New
[`tools/bank-statement.ts`](apps/desktop/src/main/services/skills/tools/bank-statement.ts) (deterministic
offline parser — bank specifics OUT of the generic registry, §13) defines `extract_transactions`
(read-only); it's listed in the static `REGISTRY` (gate unchanged). New
[`services/skills/run.ts`](apps/desktop/src/main/services/skills/run.ts) `runBankExtraction` is the
app-orchestrated seam (DS4, never model `tool_calls`): records a `skill_runs` lifecycle row (ids/refs
only) → builds the narrow ctx → runs through `runSkillTool` → on success persists the **content-class**
`bank_statements` + `bank_transactions` atomically (ROLLBACK ⇒ no partial rows). Additive DDL in
`db.ts` (`skill_runs` per §8.2 + the two bank tables); content-class tables never logged/audited + NOT
exported (§9.5). Bank skill **stays `kind: instruction`** (the flip + UI are S11b/S11c). 15 new tests
(bank-statement-tool 9, skills-run 6 incl. the §22-M1 sentinel grep, migration, scope, cancel, export
exclusion); the S10 registry test updated for the new tool + ctx key. Full suite **1563 passed / 25
skipped**, typecheck + build clean. Docs: architecture.md (bank tools + run seam), security-model.md
("Skill tool ceiling" S11a), `docs/skills-s11-plan.md` (the open working paper). SL log clean (no new
`SL-#`). See the **"Skills — S11a handoff"** block below. Next: S11b (the user-action run trigger + the
inline "Running: <tool>…" busy row + the write-confirm modal in the transcript)._

_(prior) 2026-06-17 — **Skills — S6 composer-picker live eyeball CAPTURED (carry-forward
closed).** The one open carry-forward from the Skills wave (every UI phase since S6 forwarded the
chat-composer `SkillPicker` "live eyeball" as uncaptured, because the walk harness never brought up
a running model) is now done. New committed walk
[`scripts/walk-skills-composer.mjs`](apps/desktop/scripts/walk-skills-composer.mjs) starts a chat
runtime with no weights present → the factory falls back to the **mock runtime** (clearing ChatScreen
gate A), and the bundled `app-skills/bank-statement/` skill is installed-enabled in dev (gate B), so
the composer + picker finally render for the camera. Captures **5 surfaces × light/dark × EN/DE = 20
PNGs** into [`docs/design-review/skills-s6/`](docs/design-review/skills-s6/): closed picker
("Skill: No skill"), open picker (None + the enabled skill + its description hint), the S8
"Suggested: …" one-tap offer pinned on top, the active state after picking, and the per-message
`.msg-skill` glyph on a mock-runtime answer. **No source behaviour changed** — the walk surfaced NO
rendering/wiring defect (SL log stays clean); Playwright stays an ad-hoc dev tool (NOT in
package.json). Suite still **1548 passed / 25 skipped**, typecheck + build clean. See the **"Skills —
S6 eyeball capture"** block below. No open carry-forward._

_(prior) 2026-06-17 — **Skills Phase S10 SHIPPED — Tier-2 tool-registry design + the
validate→run→validate gate.** New file
[`services/skills/tool-registry.ts`](apps/desktop/src/main/services/skills/tool-registry.ts): the
static app-owned `SkillTool` map (a skill can never register a tool), the effective-set intersection
`resolveEffectiveTools(declared, userGrant)` = `declared ∩ registry ∩ userGrant`, a dependency-free
JSON-Schema-subset validator (`validateJsonSchema` — CLAUDE.md §0, no validator dep), and
`runSkillTool` — the **app-orchestrated** gate (DS4/§2, NOT model `tool_calls`): abort-check →
validate input (refuse before run) → confirm-gate for write/export tools → run inside a **narrow,
frozen-scope `SkillToolContext`** → validate output (wrong shape fails the run) → ids/counts-only
audit. Ships **one harmless reference tool** (`count_selected_documents`, read-only over the frozen
`documentIds`) to prove the gate; **NO bank tools, NO `skill_runs` table, NO data tables** (all S11).
Additive types in `shared/types.ts` (`JsonSchema`, `ToolPermission`, `ToolResult`, `SkillToolAudit`,
`SkillToolContext`, `SkillTool`) + three `skill_run_*` audit events (+ DiagnosticsTab labels + EN/DE
catalogs). 16 new tests (`tests/unit/skills-tool-registry.test.ts`, incl. the §22-M1 sentinel grep).
Full suite **1548 passed / 25 skipped**, typecheck + build clean. Docs: architecture.md (tool registry
+ gate) + security-model.md ("Skill tool ceiling (Tier-2)"). SL log clean. See the **"Skills — S10
handoff"** block below. Next: Phase S11 (bank-statement tools + `skill_runs` + data tables — likely
its own follow-up plan doc)._

_(prior) 2026-06-17 — **Skills Phase S9 SHIPPED — built-in bank-statement instruction stub.**
The FIRST real app skill: committed [`app-skills/bank-statement/`](app-skills/bank-statement/)
(`SKILL.md` + `schemas/transaction.schema.json` + `examples/reading-a-statement.md`, text-only product
content — DS17). The body is **guidance-honest (§22-D1):** quote the statement's own printed figures,
decline to derive unstated ones, flag what can't be confirmed — it makes **no** extraction/reconcile
promise (the §6.6 reconcile body returns with the Tier-2 tools at S11). `kind: instruction`; it
**reserves** its five Tier-2 tools via `allowedTools` (declared intent). **SL-1 (resolved):** the S2
parser empties `allowedTools` for instruction skills (a frozen contract test), so the "tool-reserved"
signal can't ride `allowedTools` — added an **additive `SkillManifest.reservesTools`** (parser sets it
from the *declared* list for any kind; `allowedTools` still `[]` for instruction) + additive
`SkillInfo.reservesTools`; the S5 detail drawer's Tier-2 note now triggers on `reservesTools || kind
=== 'tool'` (was `kind === 'tool'`), so the instruction stub shows "tools arrive with Tier-2" while its
permission block stays kind-gated (no false "can use tools"). `prepare-drive.{ps1,sh}` now **copy
`app-skills/` wholesale** (like `model-manifests/`; `planPrepareDrive.appSkillsToCopy` is the dry-run
reference via `drive.ts listSkillFolders`); `assertCommercialDrive` + `build-commercial-drive.{ps1,sh}`
now **assert ≥1 app skill present + `user-skills/` empty** (`checks.appSkillsPresent`/`userSkillsEmpty`).
14 new tests (skills-bank-statement 8 + commercial 3 + manifest 2 + drive 1; SkillsTab note retargeted).
Full suite **1532 passed / 25 skipped**, typecheck + build clean. Docs: drive-layout.md, packaging.md,
security-model.md, known-limitations.md (the THREE ratified residuals). See the **"Skills — S9
handoff"** block below. Next: Phase S10 (Tier-2 tool-registry design — no heavy tools)._

_(prior) 2026-06-17 — **Skills Phase S8 SHIPPED — skill selector heuristics.** New files:
[`services/skills/selector.ts`](apps/desktop/src/main/services/skills/selector.ts) (pure deterministic
`triggers` scoring — keyword/MIME/filename, fixed threshold, tie-break by installId) and
[`services/skills/suggest.ts`](apps/desktop/src/main/services/skills/suggest.ts)
(`suggestSkillsForTurn` — resolves the conversation scope MAIN-side from the conversationId, §22-C4,
scores ENABLED skills, returns ≤1 offer). New IPC `suggestSkills(conversationId, question?)→
SkillSuggestion[]` (requireUnlocked; logs nothing — the question is content) + preload + the new
`SkillSuggestion` shared type. The composer `SkillPicker` pins the offer **on top, in-picker only**
(owner decision 2026-06-17: no canvas chip), **inert until tapped** (never auto-applies — auto-fire is
the deferred S13 wave). 14 new tests (selector 8, suggest 5, picker 3 added to SkillChat). Full suite
**1518 passed / 25 skipped**, typecheck + build clean. Docs: architecture.md (selector paragraph). See
the **"Skills — S8 handoff"** block below. Next: Phase S9 (built-in Bank-Statement instruction stub +
the three known-limitations.md entries)._

_(prior) 2026-06-17 — **Skills Phases S6+S7 SHIPPED (one unit) — manual activation + prompt
integration.** Skills now actually shape answers. New files:
[`services/skills/prompt.ts`](apps/desktop/src/main/services/skills/prompt.ts) (the fenced data block
+ guard line + the pre-sized token budget — §11) and
[`services/skills/turn.ts`](apps/desktop/src/main/services/skills/turn.ts) (`resolveTurnSkill` — the
ONE resolver shared by both chat channels) +
[`renderer/chat/SkillPicker.tsx`](apps/desktop/src/renderer/chat/SkillPicker.tsx) (composer footer
"Skill: …" picker). `chat.ts` gains the `buildSystemPrompt(skillFence?)` seam, `appendMessage.skillId`,
`getConversationDefaultSkill`/`setConversationDefaultSkill`, and a `listMessages` LEFT JOIN that
resolves a **deleted** skill → NULL (carry-forward invariant, §22-C3); `rag/index.ts` places the fence
in the **grounded user turn** (`buildGroundedPrompt(…, skillFence?)`), never `system` (§22-H2). Both
`registerChatIpc.sendChatMessage` AND `registerRagIpc.askDocuments` resolve+stamp the skill (§22-A1);
new IPC `setConversationDefaultSkill`. The assistant row is stamped **only when the fence was placed**
(§22-A5/A6); the renderer shows a per-message skill glyph (Transcript) + the picker. `Conversation`
gains `activeSkillId`, `Message` gains `skillId`/`skillTitle`, `ChatOptions` gains `skillInstallId`.
~6 EN/DE keys. 27 new tests (skills-prompt 14, skills-turn 9, SkillChat 4). Full suite **1504 passed /
25 skipped**, typecheck + build clean. Docs: architecture.md ("Chat & streaming" skill-selection
paragraph) + rag-design.md (§8 grounded fence note). See the **"Skills — S6+S7 handoff"** block below.
Next: Phase S8 (skill selector heuristics — the in-picker "Suggested: …" offer)._

_(prior) 2026-06-17 — **Skills Phase S5 SHIPPED — Settings → Skills UI.** New file:
[`renderer/screens/settings/SkillsTab.tsx`](apps/desktop/src/renderer/screens/settings/SkillsTab.tsx)
(the installed-skills list with compact rows · `App`/`Made by you` trust chip · enable Switch ·
duplicate-id / files-missing / `Review` chips · "⋯" overflow Export + Delete (Delete hidden for
`source === 'app'`); a toolbar **Import skill…** dropdown → `pickSkillPackage(file|folder)` →
`previewSkillPackage` → a ConfirmDialog showing the calm ✓/✕ permission block + collision/upgrade/
downgrade banners (confirm BLOCKED when `downgradeBlocked` or `!ok`) → `importSkill`; a detail
drawer (Modal) with metadata + the permission block + a tool-skill "guidance only" note (§13/D1) +
a closed-by-default "Technical details" raw-structural disclosure; the DS7 review banner →
`acknowledgeSkillWarning`; empty state). NO new IPC/shared types/main code — pure consumer of the
S4 surface. Registered in `SettingsScreen` (tab order General · **Skills** · Privacy · Diagnostics),
`'skills'` added to `SettingsTab` + nav alias `settings:skills`. **[superseded — see the top
entry: Skills graduated to a top-level rail destination; it is no longer a Settings tab.]** ~70 EN/DE catalog keys (informal
„du"); skill-row + permission-block CSS. 11 new renderer tests
([`tests/renderer/SkillsTab.test.tsx`](apps/desktop/tests/renderer/SkillsTab.test.tsx)). Full suite
**1482 passed / 25 skipped**, typecheck + build clean, Playwright eyeball walk green (list/drawer/
empty in EN+DE × light/dark — `docs/design-review/skills-s5/`, untracked). No docs touched (no new
broadly-reusable UI pattern — §18.0-E). See the **"Skills — S5 handoff"** block below. Next: Phases
S6+S7 (manual activation + prompt integration, shipped together)._

_(prior) 2026-06-17 — **Skills Phase S4 SHIPPED — import/export/install/delete lifecycle + IPC.**
New files: [`services/skills/installer.ts`](apps/desktop/src/main/services/skills/installer.ts) (the
lifecycle core + a NET-NEW dependency-free safe zip extractor — built-in `node:zlib` + a hand-rolled
central-directory parser, NOT JSZip/tar; §22-A2) and
[`ipc/registerSkillsIpc.ts`](apps/desktop/src/main/ipc/registerSkillsIpc.ts) (10 channels:
list/get/pick/preview/import/export/delete/enable/disable/acknowledgeWarning). Import VALIDATES
(traversal/symlink/zip-bomb-on-inflated-bytes/nested-archive-magic/extension-allowlist/§6.4 caps) →
places PLAIN files at `user-skills/<id>/` → reconciles to enabled-with-warning (DS7); coexist-disabled
when an enabled app skill shares the id (trust-first, DS12); downgrade dev-mode-gated (DS15); delete is
a one-txn ref-clear sweep + rm folder (no FK, §22-C3); export writes the package tree only (§9.5). New
shared types `SkillInfo`/`SkillPreview` + `summarizeSkillPermissions` (shared, structural) + audit
events `skill_imported/deleted/enabled/disabled` (ids/counts only). `createSkillRegistry` now
reconciles disk→DB once-per-session on first read (the ratified post-unlock lazy reconcile). Every
reject is a fixed STRUCTURAL string (never echoes attacker content — §22-M1). 24 new tests
(`tests/integration/skills-installer.test.ts` extractor matrix + lifecycle; `skills-ipc.test.ts`
round-trip + sentinel-grep). Full suite **1471 passed / 25 skipped**, typecheck + build clean. Docs:
security-model.md ("Skill-import defences") + architecture.md (lifecycle + IPC table). No Settings UI /
prompt path / activation yet (S5+). See the **"Skills — S4 handoff"** block below. Next: Phase S5
(Settings → Skills UI)._

_(prior) 2026-06-17 — **Skills Phase S3 SHIPPED — registry & persistence (plaintext plain-folder
model).** New files: [`services/skills/registry.ts`](apps/desktop/src/main/services/skills/registry.ts)
(uniform disk discovery + reconcile of `app-skills/` + `user-skills/`, `mark-unavailable`, drop-in →
DISABLED, enable/disable, the `createSkillRegistry` handle) and
[`services/skills/loader.ts`](apps/desktop/src/main/services/skills/loader.ts) (ONE mode — read the
folder — for both sources). Schema: additive `skills` table + nullable `conversations.active_skill_id`
+ `messages.skill_id` (no FK into `skills`). [`services/drive.ts`](apps/desktop/src/main/services/drive.ts)
gains `app-skills`+`user-skills` in `DRIVE_LAYOUT_DIRS` (+ both prepare-drive scripts, parity) and
`resolveAppSkillsDir`/`resolveUserSkillsDir`; `AppContext.skills` wired in `main/index.ts` (best-effort
startup reconcile). 17 new integration tests (`tests/integration/skills-registry.test.ts`); full suite
**1447 passed / 25 skipped**, typecheck + build clean. No IPC/UI/prompt path (S4+). See the **"Skills —
S3 handoff"** block below. Next: Phase S4 (import/export/install/delete lifecycle + IPC)._

_(prior) 2026-06-17 — **Skills Phase S2 SHIPPED — skill package schema & parser (pure, Electron-free).**
New files: [`shared/skill-manifest.ts`](apps/desktop/src/shared/skill-manifest.ts) (the frozen type
contract + `parseSkillMarkdown`/`validateSkillManifest`), plus main-side wrappers
[`services/skills/manifest.ts`](apps/desktop/src/main/services/skills/manifest.ts) (single I/O point
that reads SKILL.md + optional manifest.json and runs the shared validator — §8.1) and
[`services/skills/limits.ts`](apps/desktop/src/main/services/skills/limits.ts) (env-overridable §6.4
caps). 55 new unit tests; suite was **1430 passed / 25 skipped** at S2. See the **"Skills — S2 handoff"**
block below for the four-field handoff._

_**Skills — OWNER DECISION REVISION (2026-06-17), folded into [`docs/skills-plan.md`](docs/skills-plan.md)
§0 (authoritative).** Skills are now stored **UNENCRYPTED as plain folders** — `<root>/app-skills/`
(read-only) + `<root>/user-skills/` (read-write, power-user droppable), both outside `workspace/` —
because a skill package is **non-secret task knowledge, not user content** (DS20). This **revokes
DS11** (no encrypted blob / decrypt-transient / shred), **rewrites DS3/DS1** (disk-is-truth uniform
reconcile for both sources), and **adds DS19** (a folder dropped into `user-skills/` is discovered but
installs **DISABLED** until the user enables it; a deliberate zip-import via the view keeps DS7
enabled-with-warning) and **DS20** (confidentiality boundary: secret material goes in an encrypted
document, never a skill; `user-skills/` must be included in the workspace backup). **Dropped from the
plan:** §22-**C1** orphan recovery (disk is truth), §22-**A3** crash-sweep extension (no encryption
transients), and §22-**C2** downgraded from invariant to cache convenience. **§22-M2 (app-skill
integrity) RESOLVED as accept + document** the drive-provisioning residual (a hash manifest on a
writable drive is unanchored; real integrity = off-drive signing, a Tier-3 prerequisite — same
residual already accepted for the engine binary). **Still mandatory:** the NEW safe member-by-member
zip extractor (§22-A2) + `services/skills/limits.ts` — a view-imported `.skill.zip` is still
attacker-supplied and is now unzipped straight to a real on-disk folder. **Impact on the shipped S2
commit: none** — `shared/skill-manifest.ts` is storage-agnostic and `parseSkillManifestFromDir` is now
the single read path for both sources. S3 spec, S4 spec, §7/§8/§9/§14/§17/§19/§20 + the §18 matrices
updated accordingly._

### Skills — S12 handoff (2026-06-17) — THE WAVE IS CLOSED

**What this phase did** (the closing phase: the security audit ritual + the doc fold — primarily
hardening + documentation, no new feature):

**(A) Multi-persona security audit of the whole skills surface.** Personas: import/extractor security,
prompt-injection containment, the Tier-2 gate + data-flow privacy, audit/log privacy. **No CRITICAL,
no HIGH.** The shipped gate was NOT redesigned — the audit added tests + one small hardening fix.
- **Fixed (LOW) — CSV spreadsheet formula-injection (F4).** `transactionsToCsv` (`tools/bank-statement.ts`)
  now neutralizes a free-text field whose first char is a formula trigger (`= + - @`, tab, CR) by
  prefixing `'`, so a crafted statement description can't execute when the exported CSV is opened in
  Excel/Sheets/LibreOffice. Numeric columns (amount/balance) are formatted separately and untouched.
  This is the one real FS-write boundary, so it earns the hardening. + a unit test.
- **Consolidated sentinel guard (NEW `tests/integration/skills-privacy-guard.test.ts`, 7 tests).** One
  secret driven through EVERY sink — import error payload, loader, all five tool runs, the CSV export,
  the IPC `SkillRunState` — **plus a console spy** (the gap the per-layer S10/S11 sentinels lacked),
  proving absence in audit/log/console/run-metadata while confirming the deliberate exceptions land
  (the content-class `bank_transactions` + the user-chosen CSV — correct). Plus a **prompt-injection
  containment** pair: a hostile body that forges the `--- END LOCAL SKILL ---` delimiter and shouts
  "ignore previous instructions" cannot displace the guard line (it is structurally last) — and per
  §14 the structural ceiling means a text-level injection can't act anyway.
- **Accepted LOW residuals (documented in `known-limitations.md`):** (1) prompt text-injection is
  contained by the **structural ceiling**, not by escaping the fence delimiter (we deliberately don't
  sanitize the body); (2) a user skill's `triggers.filenamePattern` compiles to a bounded RegExp, run
  only on a user action (no auto-fire). Verified the existing S9 residuals (DS20 confidentiality, the
  §22-M2 app-skill integrity-by-location, the DB-rebuild-resets-enable) — present, not duplicated.

**(B) Folded the two plans into the §-records, then deleted them (doc-lifecycle rule).**
- **NEW `architecture.md` "Skills — design record (Phases S2–S12, §1–§12)"** consolidates
  `skills-plan.md` §1–§19 + `skills-s11-plan.md` (§1 Decisions, §2 Hard rules, §3 Storage/registry,
  §4 Import lifecycle, §5 Selection/prompt, §6 Suggestion, §7 Tier-2 gate, §8 Bank tools + run seam,
  §9 Run trigger/UI, §10 Data model, §11 IPC/audit, §12 Trade-offs + the S12 audit). The long Storage
  narrative was **trimmed to a one-paragraph pointer** (condense, not duplicate).
- **`security-model.md`** — the "Skill tool ceiling" record gained the CSV-injection-neutralization
  note + a closing **"S12 — the closing multi-persona audit"** paragraph (no CRITICAL/HIGH, the one
  fix, the consolidated guard, the residuals, the §14 unchanged guarantees held). The "Skill-import
  defences" + "App-skill provisioning…" records were already complete.
- **In-code citations:** the 14 plan-FILE references (`docs/skills-s11-plan.md §…` / `docs/skills-plan.md
  §…`) in `db.ts`, `run.ts`, `tools/bank-statement.ts` + four test headers now cite
  **"Skills — design record §N"** (data model → §10, run seam/tools → §8, controller → §9). The §-anchors
  are stable so future code can keep citing them.
- **Deleted `docs/skills-plan.md` + `docs/skills-s11-plan.md`** (`git rm`; full originals in git history —
  `git show <S12^>:docs/skills-plan.md`).

**Non-negotiable invariants HELD (§14 "unchanged guarantees"):** CSP, the deny-by-default permission
handler, the offline guard, the encryption posture, and packaging were **not touched**. App-orchestrated
only (DS4). Audit stays ids/counts-only. No new native dep, offline. No user data/weights/generated files
committed. The untracked `docs/design-review/skills-s5/` was left out of the commit.

**Tests/build:** 8 new tests (privacy-guard 7 + the CSV-injection unit). Full suite **1614 passed / 25
skipped**, `npm run typecheck` + `npm run build` clean.

**Open landmines:** **none. SL log final — no open `SL-#`** (SL-1 was resolved in S9). **Carry-forward
(RESIDUAL — forwarded one final time, NOT faked):** the running-model Playwright eyeball of the
`SkillRunBar` run surfaces (OFFER → busy row → result rows for extract/validate/categorize/summarize +
the now-production-firing export confirm modal, EN/DE × light/dark) was **not captured**. It needs a
seeded **indexed** statement (so `listRunnableTools` is non-empty) + a live extract→export run + a stubbed
native save dialog — which couldn't be authored-and-verified in this headless/no-Playwright/de-AT dev
environment without risking a broken committed harness, and a fake capture is worse than an honest gap.
Every visual state is unit-covered by `tests/renderer/SkillRunBar.test.tsx`; the residual + a concrete
capture recipe live in `docs/design-review/skills-s12/README.md`. (The composer-picker half was captured
live at S6 — `docs/design-review/skills-s6/`.)

**What's next:** nothing in the Skills wave — it is **CLOSED**. The only deferred skills work is the
post-v1 **S13** (auto-fire triggers, gated on an evaluation harness) and the standing residuals above.

### Skills — S6 eyeball capture (2026-06-17)

**What this closed.** The Skills wave's one open carry-forward: the S6 chat-composer `SkillPicker`
"live eyeball" that every UI phase S6→S10 forwarded as uncaptured. It was never a bug or a missing
feature — the picker's behaviour is covered by `SkillChat.test.tsx`; what was missing was the
mandatory Playwright screenshot-walk artifact (design-guidelines §11.4), because the walk harness had
never brought up a running model, so the composer (gated behind a RUNNING runtime) never rendered.

**How.** New committed walk
[`scripts/walk-skills-composer.mjs`](apps/desktop/scripts/walk-skills-composer.mjs) (mirrors the
`walk-docs-subnav.mjs` shape: gate flow, `shotBoth(theme)`, per-locale loop, seeding via
`window.api`). It clears **both** ChatScreen gates: (A) it calls `window.api.selectModel` +
`startRuntime` on a chat manifest with **no weights on the fresh eyeball root**, so the start gate's
developer-leniency path falls back to the built-in **mock runtime** (`registerModelIpc` →
`services/runtime/mock.ts`), which both renders the composer AND streams a simulated reply; (B) the
bundled `app-skills/bank-statement/` skill is discovered + installed-enabled in dev, so
`enabledSkills.length > 0` for free. Plaintext-dev policy (no unlock gate), offline, window widened
to 1360px so the conversation list (and its "New chat" reset between locales) is visible.

**Captured** — `docs/design-review/skills-s6/`, **5 surfaces × light/dark × EN/DE = 20 PNGs**
(committed alongside the script, per the `skills-s5/` precedent): `composer-<loc>-skill-none` (closed
picker), `picker-<loc>-open` (None + the enabled skill + its description hint), `picker-<loc>-suggest`
(the S8 "Suggested: Bank Statement Analysis — use it?" offer pinned on top, fired by the draft
"reconcile this bank statement" scoring the `triggers`), `composer-<loc>-skill-active` (closed trigger
now showing the picked skill's title), and `message-<loc>-skill-glyph` (the per-message `.msg-skill`
"brain" glyph on a mock-runtime answer).

**Findings.** The walk ran clean and exposed **NO** rendering/wiring defect — **SL log stays clean,
no new `SL-#`.** Surfaces matched the unit-test expectations: the suggestion pins above the radio
group only while unselected; the active footer + the glyph both stamp the skill title (English
author-language) regardless of UI locale. No source behaviour was changed.

**Process / tooling notes.** Playwright is an **ad-hoc dev tool, NOT in `package.json`** (CLAUDE.md
§0 no-new-committed-deps bias) — install with `npm i playwright --no-save -w apps/desktop` (or `-D`
then revert the manifest), run, done; node_modules carries it uncommitted. The walk must `npm run
build` first (it drives the BUILT bundle out/main, which vitest never exercises) and **strip
`ELECTRON_RUN_AS_NODE`** from the child env (the VSCode host exports it). `docs/design-review/` also
holds untracked `skills-s5/` PNGs from the S5 walk — unrelated to this chore, left as-is.

### Skills — S11c handoff (2026-06-17)

**What this phase added** (the last S11 sub-phase — the remaining tools + tables + the flip):
- **`tools/bank-statement.ts`** — four new PURE tools + exported helpers (unit-tested without DB/
  Electron): `validate_statement_balances` (`reconcileBalances` → per-row `ok`/`mismatch`/`unknown`,
  overall verdict = a checkable row exists AND no mismatch), `categorize_transactions`
  (`categorizeRow`/`categorizeRows` over `BUILTIN_CATEGORY_RULES`; sign fallback Spending/
  Uncategorized), `summarize_cashflow` (`summarizeCashflow` — currency only when uniform, honest),
  `export_transactions_csv` (`transactionsToCsv` — RFC-4180 quoting, fixed-dp amounts, blanks for
  nulls). All deterministic/offline, §22-D1 honest. Registered in `tool-registry.ts` `REGISTRY`.
- **`db.ts`** — additive content-class DDL: `bank_categories`, `bank_category_rules`, `bank_corrections`
  (created now, written by a future correction UI — out of S11c scope) + `ensureColumn`
  `bank_transactions.category_id/reconciled/confidence`. Never logged/audited/exported (§9.5).
- **`run.ts`** — `runBalanceValidation` / `runCategorization` / `runCashflowSummary` / `runCsvExport`
  over a shared `prepareStatementRun` prefix (begin run → locate the **latest** statement → load rows
  → run the pure tool through the gate with structured input). Persistence atomic + no-partial-persist;
  `ensureBuiltinCategories` seeds categories + rules once. `runCsvExport` takes an injected
  `saveTextFile` (no FS handle in the seam itself); a cancelled save → run `cancelled`, friendly copy.
- **`tool-runs.ts`** — `buildToolRunner` is now a switch with a case per tool (+ a `ToolRunDeps`
  carrying `saveTextFile`; the export case returns `null` if it's absent). `runnableToolNames`
  retargeted to `resolveEffectiveTools(skill.manifest.allowedTools, skill.manifest.allowedTools)`
  filtered to wired names (grant = declared; no per-tool UI in v1). `WIRED_TOOL_NAMES` lists all five.
- **`registerSkillsIpc.ts`** — a closure `saveTextFile` (focused-window save dialog → `writeFile`,
  logging NOTHING) passed into `buildToolRunner`. The channels/preload are otherwise unchanged.
- **Generic infra** — ONE additive content-free field: `ToolRunOutcome.resultKind` + `SkillRunState
  .resultKind` (an opaque discriminator; the controller copies it on success). The bank meaning lives
  only in the renderer's copy map.
- **Renderer** — `SkillRunBar.tsx` gains `TOOL_LABEL_KEY`/`TOOL_DONE_KEY` entries + a `doneMessage`
  that keys per-tool copy and renders validate from `resultKind`. `SkillsTab.tsx` shows
  `skills.tool.note.active` (the real tool list) for `kind:'tool'` (the "arrive with Tier-2" note now
  only for a reservesTools *instruction* skill); the "✓ Use approved local tools" line is already
  kind-gated in `PermissionBlock`, so the flip lights it up. EN+DE catalogs extended.
- **The flip** — `app-skills/bank-statement/SKILL.md` → `kind:'tool'` + the §6.6 reconcile body
  (honest: app-orchestrated only, never invents a figure, work from the extracted table).

**Decisions taken (record):**
- **Downstream tools take STRUCTURED INPUT, not a new context accessor** (the seam loads the rows). The
  §14 ceiling is unchanged — a tool still has only the frozen `documentIds` + `readDocumentChunks`.
- **A run targets the LATEST `bank_statements` for the in-scope document** (`ORDER BY created_at DESC,
  id DESC`); no statement ⇒ a friendly "read the statement first" failure (no figure invented).
- **CSV write is MAIN-side to a user-chosen path; path + content are never logged/audited.** Only
  "saved N rows" surfaces; a cancelled save persists nothing. Gated on `export-file` + the confirm.
- **`summarize_cashflow` figures are NOT surfaced in v1** (content; the busy row stays ids/counts) —
  the run reports a count; a dedicated view / the model-explains step surfaces the totals later.
- **Permissions:** validate/categorize/summarize are `read-selected-docs` (no per-call prompt) — they
  persist only DERIVED annotations (reconciled flag / category id), the same content-class posture as
  extract; only the FS-writing `export_transactions_csv` is `export-file` (confirm-gated).

**Open landmines:** none. SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright
eyeball (busy row + the now-production-firing export confirm modal, EN/DE × light/dark) is still
uncaptured — the S6-style walk needs a seeded indexed statement + a live extract→export run.

**What S12 consumes:** S11 is CLOSED. Fold `docs/skills-s11-plan.md` into the §-records per its §18
fold-map (tools/registry/run orchestration → architecture.md "Skills — design record"; the tool
ceiling + content-class data + the CSV FS-write boundary → security-model.md), then **delete the plan
file** (the original stays in git history). Then the skills security hardening/audit pass.

### Skills — S11b handoff (2026-06-17)

**What this phase added** (UI/IPC only — NO new tools, tables, or SKILL.md flip):
- **`services/skills/run-controller.ts`** (new, GENERIC — no bank knowledge): `SkillRunController` —
  one active run, `start(runner)` kicks off without awaiting + returns the `running` snapshot,
  `get(handle)` polls a copy, `cancel(handle?)` aborts the `AbortSignal`, `clear(handle)` drops a
  terminal run; merges the tool's `onProgress` into the polled `SkillRunState`. One-at-a-time.
- **`services/skills/tool-runs.ts`** (new, the DISPATCH — allowed to know bank, like the tool file):
  `buildToolRunner(db, toolName, …, audit)` maps `extract_transactions` → `runBankExtraction`;
  `runnableToolsForSkill`/`runnableToolNames` (gated on `reservesTools`); `resolveInScopeDocumentIds`
  (scope resolved MAIN-side from the conversation, §22-C4); `toolRunNeedsConfirmation` (registry-
  driven); `toSkillToolAudit` (bridges the 3-arg `AuditRecorder` → the 2-arg ids/counts-only sink).
- **IPC (`registerSkillsIpc.ts`)**: four generic `skills:*` channels — `listRunnableTools` (offer),
  `startSkillRun` (→ `{started, run} | {needsConfirmation} | {error}`), `getSkillRun`, `cancelSkillRun`
  — all `requireUnlocked`, logging nothing content-bearing. A closure-held controller (no AppContext
  plumbing — at most one run). + preload methods + `main.skills.run.*` EN/DE copy.
- **Renderer**: `lib/skillruns.ts` (module-level polling store, the `doctasks.ts` precedent) +
  `chat/SkillRunBar.tsx` (offer/busy/result + the `ConfirmDialog` write/export path) + ChatScreen
  wiring (`useSyncExternalStore`, `listRunnableTools` effect, `onRunTool`) + `.skill-run-bar` CSS +
  `chat.skill.run.*`/`chat.skill.tool.*`/`chat.skill.confirm.*` EN/DE keys.

**Decisions taken (record):**
- **Channel shape = GENERIC `skills:*`, not bank-named.** Rationale: S11c adds `export_transactions_csv`
  et al. by adding a `buildToolRunner` case + a wired-tool entry — the channel/controller/renderer/
  preload do not change. Bank specifics are confined to `tool-runs.ts` + `run.ts` (§13).
- **The trigger keys off `reservesTools`, not the effective tool set.** The instruction-kind parser
  empties `allowedTools` (S9/SL-1), so the declared tool NAMES are gone for the bank stub; v1 offers the
  wired registry tools to any `reservesTools` skill (in v1 only the bank skill qualifies, and
  `extract_transactions` safely no-ops on a non-statement). At the **S11c flip to `kind:'tool'`**, switch
  `runnableToolNames` to the effective `allowedTools ∩ registry ∩ grant` — renderer unchanged.
- **Confirmation is decided up-front by the renderer from `RunnableTool.requiresConfirmation`** (main-
  computed, authoritative) and **enforced defensively by the gate** (`runSkillTool` confirm-gate +
  the `startSkillRun` `needsConfirmation` guard). For v1 (read-only only) the modal never fires in
  production; the path is proven by a synthetic write tool (controller + renderer tests).
- **No `run.ts`/gate change was needed** — the seam already exposes `signal`/`onProgress`/`audit`.

**Open landmines:** none. SL log clean (no new `SL-#`). **Carry-forward:** the running-model Playwright
eyeball of the busy row + confirm modal is uncaptured (needs a seeded indexed doc + a live extract run;
the S6-style walk). SkillRunBar.test.tsx covers every visual state; the walk is the only gap.

**What S11c consumes:** add the remaining 4 tools to the `REGISTRY` + `tools/bank-statement.ts`; add a
`buildToolRunner` case per tool (`export_transactions_csv` is confirm-gated `export-file` — the
`SkillRunBar` modal already gates it); add the categories/rules/corrections/reconciliation tables; then
**flip `app-skills/bank-statement/SKILL.md` to `kind:'tool'`** (makes `allowedTools` effective) + swap to
the §6.6 reconcile body + update the S5 drawer note to the real tool list + the "✓ Use approved local
tools" line. When flipped, retarget `runnableToolNames` to `resolveEffectiveTools`.

### Skills — S11a handoff (2026-06-17)

**Phase 0 (ratified before code):** authored [`docs/skills-s11-plan.md`](docs/skills-s11-plan.md) — the
OPEN working-paper plan (folds into the §-records at S12). Owner ratification (AskUserQuestion):
(1) first slice ships **`extract_transactions` only**; (2) **`export_transactions_csv` deferred to
S11c**; (3) content-read = **page-addressable chunks**; (4) runs are **purely user-initiated** in v1.
Sub-phases: **S11a** (tools behind the gate, no UI — this), **S11b** (run trigger + busy row +
write-confirm modal), **S11c** (the other 4 tools + flip SKILL.md to `kind:'tool'` + reconcile body).

**Contracts produced** (what S11b/S11c consume):
- **`shared/types.ts`** — additive: `DocumentChunkRead = {text, page, index}` + a `readDocumentChunks(documentId)
  → DocumentChunkRead[]` method on `SkillToolContext`. It is the WHOLE content reach a tool has:
  scope-bounded to the frozen `documentIds` (out-of-scope id ⇒ `[]`), still **no `Db`/SQL/FS/net handle**.
- **`db.ts`** — additive DDL (`IF NOT EXISTS`, no data migration): `skill_runs` (per §8.2 — ids/refs only:
  `document_ids_json` ids, `status` started|done|failed|cancelled, `result_ref` a `bank_statements.id`,
  `error` friendly/technical) + the **content-class** `bank_statements` + `bank_transactions` (real
  figures — encrypted DB only, never logged/audited, NOT exported §9.5). Categories/rules/corrections are
  additive at S11c (no overbuild, §13).
- **`services/skills/tools/bank-statement.ts`** (new): `extractTransactionsTool` (read-only,
  `read-selected-docs`) + the deterministic/offline parser (`parseDate`/`parseAmount`/`detectCurrency`/
  `extractTransactionRows`, exported for unit tests). Drops ambiguous rows / never invents currency
  (§22-D1 honesty). Bank logic kept OUT of the generic registry (§13).
- **`tool-registry.ts`**: `REGISTRY` now lists `count_selected_documents` + `extract_transactions`; the
  gate itself is **unchanged**.
- **`services/skills/run.ts`** (new): `runBankExtraction(db, {skillInstallId, conversationId?, documentId},
  {audit, signal?, onProgress?, now?}) → {ok, runId, statementId?, transactionCount?, error?}` — the exact
  app-orchestrated seam S11b's IPC/UI will call. Builds the narrow ctx (incl. the `readDocumentChunks`
  closure over a per-doc chunk SELECT), runs through the gate, persists atomically.

**Decisions taken or changed:**
- **The gate audits the TOOL run; the seam owns the `skill_runs` TABLE + bank data.** Two distinct sinks:
  `runSkillTool` brackets the run on the ids/counts-only AUDIT sink; `run.ts` writes the run-history row
  + content tables. Both stay content-free except the bank tables (content-class by design).
- **Currency is required per row; a row with no detectable currency is DROPPED, not invented** (honesty).
  A statement with no ISO code/symbol yields zero rows — acceptable for the deterministic v1 extractor
  (parse quality is a known limitation that improves later, not an ML claim).
- **No-partial-persist via `BEGIN…COMMIT`/ROLLBACK** (the `node-vectors.ts`/`tree-build.ts` precedent):
  the `started` row is committed first; bank rows + the `done` update are one transaction; a write error
  ROLLBACKs and the run is marked `failed` with a friendly error.

**Open landmines:** none. SL log clean (no new `SL-#`). The bank skill stays `kind: instruction` — the
flip to `kind:'tool'` (which makes `allowedTools` effective via the SL-1 parser path) + the reconcile
body + the drawer/permission-line update are an explicit **S11c** sub-phase.

**What S11b consumes:** the `run.ts` seam (wrap it in IPC — `requireUnlocked`, log nothing: the
question/scope is content) + the `skill_runs`/bank tables for a results view; add the inline calm
"Running: <tool> on <N> documents… (Cancel)" busy row (doc-task busy-row precedent) + the write/export
confirm modal (model-download/lock-now precedent), EN/DE. The run is triggered from a USER action (DS4).

### Skills — S10 handoff (2026-06-17)

**Contracts produced** (what S11 consumes):
- **`shared/types.ts`** — additive (the S2 spine is unchanged; these are net-new Tier-2 types):
  - `JsonSchema` — the validated subset (type/properties/required/additionalProperties/items/enum/
    min·maxLength/min·maximum/min·maxItems/pattern). Hand-rolled, no validator dep (CLAUDE.md §0).
  - `ToolPermission = 'read-selected-docs' | 'write-generated-doc' | 'export-file'` — **no
    `read_arbitrary_fs`/`network`/`raw_sql` token exists** (structural ceiling).
  - `ToolResult = {ok:true,output,resultRef?} | {ok:false,error}` (friendly, content-free error).
  - `SkillToolAudit = (type, meta?) => void` — ids/counts-only sink (no free-text message arg).
  - `SkillToolContext = { documentIds: readonly string[]; signal; onProgress?; audit }` — **no
    Db/SQL/FS/net handle**. The gate hands the tool a **frozen** `documentIds` (cannot widen scope).
  - `SkillTool = { name; description; inputSchema; outputSchema?; permissions; run(input, ctx) }`.
  - Three audit events: `skill_run_started` / `skill_run_done` / `skill_run_failed` — metadata
    `{skillId, toolName, documentCount}` ONLY (+ DiagnosticsTab `AUDIT_TYPE_LABELS` + EN/DE catalogs).
- **`services/skills/tool-registry.ts`** (new):
  - `validateJsonSchema(schema, value, path?) → string[]` (structural errors, never echoes input
    values — §22-M1), `validateToolInput` / `validateToolOutput`.
  - `getRegisteredTool(name)` (own-property only), `listRegisteredToolNames()`,
    `resolveEffectiveTools(declared, userGrant)` = `declared ∩ registry ∩ userGrant`
    (unregistered/ungranted dropped, deduped, declared order preserved).
  - `toolRequiresConfirmation(tool)` = true iff a write/export token is present.
  - `runSkillTool(tool, {skillId, input, ctx, confirmed?}) → Promise<ToolResult>` — the gate
    (abort → input-validate → confirm-gate → run-on-frozen-ctx → output-validate → audit).
  - `count_selected_documents` — the ONE shipped reference tool (pure, offline, read-only, needs
    only `read-selected-docs`, no confirm). It is the registry's only entry.

**Decisions taken or changed:**
- **SkillToolContext exposes NO raw `Db` (refines the §12.1 sketch toward the §12.2/§14 intent).**
  The plan's §12.1 type sketch showed `db: Db`, but §12.2 + §14 require a *narrow read API, no
  fs/net/sql handle*. S10 resolves this: the v1-of-Tier-2 context exposes only the frozen id scope
  (+ signal/progress/audit). **S11 adds a NARROW, scope-bounded content-read method** (e.g.
  `readDocumentText(id)` confined to `documentIds`) — still never a raw `Db`/SQL/FS/net handle. This
  also keeps the tool types fully shared-safe (no `main/` import leaks into `shared/types.ts`).
- **Pre-run refusals are NOT audited as runs.** Abort / invalid-input / missing-confirm return
  `{ok:false}` *without* a `skill_run_*` event — the run audit log records actual runs only. An
  actual run is bracketed `started → done|failed`. (The sentinel grep pushes a secret through a
  *successful* run to prove the audit payload stays ids/counts-only.)
- **The validator is a hand-rolled JSON-Schema subset, not a dep.** Honors CLAUDE.md §0 (no new
  native deps / offline). It covers what tool I/O contracts need (incl. the committed
  `transaction.schema.json` shape) and is the same dependency-free posture as `ingestion/limits.ts`.

**Open landmines:** none. SL log stays clean (SL-1 was resolved in S9). Carry-forward: **CLOSED** —
the S6 composer-picker live eyeball was captured in the follow-up chore (see the **"Skills — S6
eyeball capture"** block above this one); no open carry-forward remains.

**What S11 consumes:** the whole `tool-registry.ts` gate + types above. S11 adds the real
bank-statement tools (`extract_transactions` et al.) into the registry, the `skill_runs` table + the
bank-statement data tables, the narrow content-read method on `SkillToolContext`, and the
app-orchestrated chat/UI integration (the inline "Running: <tool>…" busy row + the write-confirm
modal wired into the transcript). The committed `schemas/transaction.schema.json` is the typed I/O
contract those tools validate against; the bank-statement stub's `reservesTools`/`allowedTools`
declaration names the tools the registry will wire (and its SKILL.md body swaps to the §6.6
reconcile/validate body once the tools are effective for a `kind: 'tool'` skill).

### Skills — S9 handoff (2026-06-17)

**Contracts produced** (what S10/S11 + the sell pipeline consume):
- **`app-skills/bank-statement/`** (committed): `SKILL.md` (`kind: instruction`, guidance-honest body,
  `allowedTools` reserving the 5 Tier-2 tools, `triggers`), `schemas/transaction.schema.json` (the
  Tier-2 row contract, present early — S11 reads it), `examples/reading-a-statement.md` (honest worked
  example). InstallId resolves to **`app:bank-statement`** (deterministic natural key, S3).
- **`shared/skill-manifest.ts`**: additive `SkillManifest.reservesTools?: boolean` — the parser sets it
  `true` whenever the frontmatter DECLARES a non-empty tool list, **for any kind**; `allowedTools`
  still stays `[]` for an instruction skill (the frozen S2 contract — it cannot USE tools in v1). This
  is the durable "tool-reserved" display signal that survives reconcile (cached in `manifest_json`).
- **`shared/types.ts`**: additive `SkillInfo.reservesTools?: boolean` (`recordToInfo` sets it from
  `manifest.reservesTools`).
- **`services/drive.ts`**: `listSkillFolders(dir) → string[]` (subdirs containing a `SKILL.md`, sorted)
  — shared by the prepare plan + the commercial gate; `PreparePlan.appSkillsToCopy` +
  `PreparePlanOptions.appSkillsDir` (dry-run reference for the wholesale copy).
- **`services/commercial-drive.ts`**: `assertCommercialDrive` gains `checks.appSkillsPresent` (≥1 app
  skill under `app-skills/`) + `checks.userSkillsEmpty` (`user-skills/` empty) — both always-on; a
  missing app skill OR any `user-skills/` entry flips `ok` to false with a `problems[]` line.
- **Scripts:** `prepare-drive.{ps1,sh}` copy `app-skills/` wholesale; `build-commercial-drive.{ps1,sh}`
  natively cross-check the same app-skills-present + user-skills-empty invariants (parity).

**Decisions taken or changed:**
- **DS17/drawer-note tension resolved — keep `kind: instruction`, trigger the note off
  `reservesTools` (not `kind`).** The stub is instruction-only (§2/§6.6), so it can't be `kind: 'tool'`;
  but the drawer's Tier-2 note must show. Since the parser empties `allowedTools` for instruction
  skills, the signal is the new `reservesTools` flag. The permission-block "✓ Use approved local
  tools" line stays `kind === 'tool'`-gated, so the instruction stub honestly shows NO current tool
  capability while still surfacing "tools arrive with Tier-2".
- **Commercial gate checks are ALWAYS-ON** (not opt-in like the runtime/ocr pins): they need only
  `rootPath`. The 5 existing `ok:true` commercial tests were updated to provision an app skill; the
  exact-shape `checks` assertion gained the two keys. (Suite stays green; count grows.)
- **`minAppVersion: 0.1.29`** in the stub matches the running app (no version-gate disable; the
  registry does not enforce `compatibility` anyway in v1).
- **Integrity residual = accept + document (§22-M2):** the gate proves *provisioning*, not a runtime
  hash; trust is by drive location. Real integrity = off-drive signing (Tier-3). Same as the engine
  binary. Documented in security-model.md + known-limitations.md (with the DS20 confidentiality
  boundary + the DB-rebuild-resets-enable note — all three ratified entries landed together).

**Open landmines:** **SL-1 — RESOLVED in S9** (the instruction-skill `allowedTools` empties to `[]`, so
the tool-reserved signal needed the additive `reservesTools` flag rather than reading `allowedTools`).
No open `SL-#`. Carry-forward (not S9's job): the S6 composer-picker live eyeball still uncaptured
(needs a model-running walk step); covered by `SkillChat.test.tsx`.

**What S10 consumes:** the committed `schemas/transaction.schema.json` (the typed Tier-2 I/O contract
the tool registry validates against) + the `reservesTools`/`allowedTools` declaration on the stub (the
tool names the registry will wire); when the Tier-2 tools land (S11) the SKILL.md body is swapped to the
§6.6 reconcile/validate body and `allowedTools` becomes effective for a `kind: 'tool'` skill.

### Skills — S8 handoff (2026-06-17)

**Contracts produced** (what S9+ / a future S13 auto-fire consume):
- **`services/skills/selector.ts`** (pure, no DB): `scoreSkillTriggers(triggers, {question, docTitles,
  docMimeTypes}) → number`; `selectSuggestion(candidates, ctx) → SkillCandidate | null`;
  `SUGGEST_SCORE_THRESHOLD` (=2). Weights: keyword ×2, mime +1, filename +1 — a lone document signal
  is below threshold (never fires on "there's a PDF in scope" alone). Glob `*`/`?` filename matching,
  case-insensitive. Deterministic tie-break by `installId` asc. **The S13 confidence threshold tunes
  here; this same suite is its regression guard.**
- **`services/skills/suggest.ts`**: `suggestSkillsForTurn(db, conversationId, question?) →
  SkillSuggestion[]` — resolves scope via `resolveScope` + `buildScopeFilter` MAIN-side, candidates =
  `listSkills(db).filter(enabled && !unavailableAt)`, returns ≤1. Empty-tolerant (unknown/locked conv →
  keyword-only). **Read-only / inert** — never writes `active_skill_id`.
- **IPC**: `suggestSkills(conversationId, question?) → SkillSuggestion[]` (`shared/ipc.ts`
  `skills:suggest`, preload mirrored, handled in `registerSkillsIpc`; `requireUnlocked`; reconciles
  once then suggests; **no log/audit** — reads aren't audited and the question is content).
- **Shared type** `SkillSuggestion {installId, title}` (`shared/types.ts`) — structural only (§22-M1).
- **Renderer**: `SkillPicker` gains `suggestion?`/`onOpenChange?`; ChatScreen recomputes the offer on
  picker-open with the current draft + activeId. Key `chat.skill.suggested`; `.menu-item.skill-suggest`
  accent style.

**Decisions taken or changed:**
- **In-picker only (owner decision 2026-06-17):** the offer rides the picker the user already opened —
  no canvas chip, no `AppSettings` key (DS14/§22-D3). Recomputed on picker-open (one IPC per open with
  the live draft), not on every keystroke.
- **Threshold = 2 closes OQ-1** for v1: one keyword OR mime+filename together. Tunable in one constant.
- **Auto-fire stays deferred to S13** behind the offline evaluation harness (§10.4) — S8 ships only the
  inert one-tap offer. The selector is the harness's scoring unit when that lands.

**Open landmines:** none new (no `SL-#`). (The S6 composer-picker live eyeball is still the one
deferred capture — see the S6+S7 block; the picker incl. the new suggestion row is covered by
`SkillChat.test.tsx`.)

**What S9 consumes:** nothing from S8 directly — S9 commits the `app-skills/bank-statement/` instruction
stub (guidance-honest body + the detail-drawer Tier-2 note), wires `prepare-drive` copy + the
commercial-drive assert, and lands the **three ratified `known-limitations.md` entries** (§22-M2, DS20,
DB-rebuild-resets-enable — now bound into the §18.1 S9 spec + the §18.0-E doc-map). A real bundled
app skill will exercise the whole S2→S8 path end-to-end (its `triggers` make it the first real
selector candidate).

### Skills — S6+S7 handoff (2026-06-17)

**Contracts produced** (what S8 consumes):
- **`services/skills/turn.ts`**: `resolveTurnSkill(db, {appSkillsDir,userSkillsDir,limits?}, conversationId,
  requestedInstallId?) → TurnSkill | null` (requested `undefined`=sticky, `null`/`''`=none, string=that
  skill; skips disabled/deleted/unavailable) + `resolveTurnSkillFromRegistry(db, registry|undefined, …)`
  (the IPC wrapper). `TurnSkill = {installId, title, body}` (exported from `chat.ts`).
- **`services/skills/prompt.ts`**: `buildSkillFence({title,body}, budgetTokens?) → {text|null, omitted,
  trimmed}` (whole-paragraph reduction; omit-not-truncate); `skillFenceBudgetTokens({contextTokens,
  reserveTokens,fixedTokens})`; `composeSystemPromptWithSkill(base, fence)`; `approxPromptTokens`;
  `SKILL_GUARD_LINE`. Fence framing/guard are English (D-L6); body is author's language.
- **`chat.ts`**: `buildSystemPrompt(skillFence?)`, `buildChatMessages(db, convId, contextTokens?,
  skillFence?)`, `appendMessage({…, skillId?})`, `generateAssistantMessage(…, {skill?})`,
  `getConversationDefaultSkill`/`setConversationDefaultSkill`. `listMessages` LEFT JOINs `skills`
  (deleted → `skillId`/`skillTitle` NULL).
- **`rag/index.ts`**: `buildGroundedPrompt(question, chunks, skillFence?)` (fence in the USER turn);
  `generateGroundedAnswer(…, {skill?})` (stamps only when fence placed AND chunks found).
- **Shared types**: `Conversation.activeSkillId?`, `Message.skillId?`/`skillTitle?`,
  `ChatOptions.skillInstallId?`. **IPC**: `setConversationDefaultSkill(convId, installId|null)→void`;
  `askDocuments` gained a 3rd `skillInstallId?` arg. Preload mirrors both.
- **Renderer**: `renderer/chat/SkillPicker.tsx` (Radix RadioGroup, "None" + enabled skills) +
  the Transcript per-message glyph (`.msg-skill`). `chat.skill.{trigger,none,used,usedTitle}` keys.

**Decisions taken or changed:**
- **Budget approach (a), pre-size in `prompt.ts`** (not the yieldable-second-message option (b)):
  the fence is trimmed to `contextTokens − reserve − base − finalTurn (− excerpts)` BEFORE placement,
  so `fitMessagesToContext` (unchanged) only drops older history; base/final/excerpts never starve.
- **Stamp only when the fence was actually placed** (omitted-for-budget ⇒ no stamp), so the glyph is
  1:1 with a prompt that carried the skill (§22-A5/A6). No-context/listing answers stamp NULL.
- **Deleted-skill → NULL resolved at READ time via a LEFT JOIN in `listMessages`** (recommendation #2
  bound into code + a test) — a *disabled/unavailable* skill still shows the past glyph (row exists);
  only a truly deleted row drops it.
- **Renderer includes `skillInstallId` in `sendChatMessage` options only when non-null** (a cleared
  skill is the conversation's persisted null sticky default) — keeps no-skill turns' call shape and
  avoids churning existing chat tests.
- **`Conversation.activeSkillId` is OPTIONAL** in the type (additive; `rowToConversation` always
  populates it) so existing conversation fixtures stay valid.

**Open landmines:** none new (no `SL-#`). The S6 composer-picker **live eyeball was not captured**
(the chat composer's visibility in the walk harness depends on runtime state); the picker is identical
in styling to the shipped `DepthMenu` footer affordance and is covered by `SkillChat.test.tsx`
(picker behavior) + the Transcript glyph test. Not a blocker; flagged for the S8 walk to re-capture
once a model-running harness step is added.

**What S8 consumes:** the same enable/default surface; the picker is where the S8 deterministic
**"Suggested: …" one-tap offer** pins (DS14 — no settings key, no canvas chip). S8 adds
`services/skills/selector.ts` + a `suggestSkills(conversationId, question?)` IPC (scope resolved
main-side, §22-C4) scoring enabled skills' cached `manifest_json.triggers`; it is **inert until
picked** (never auto-applies — auto-fire is the deferred S13 wave).

### Skills — S5 handoff (2026-06-17)

**Contracts produced** (what S6 reuses):
- **`renderer/screens/settings/SkillsTab.tsx`** — the Settings → Skills surface. Components S6
  can reuse: `SkillRow`-style compact rows (icon · clickable title/desc · trailing chips/Switch/⋯),
  the `PermissionBlock` (the calm ✓/✕ capability list, **derived from the already-clamped
  `permissions` + `kind` — it localises the result, it never re-decides what a skill may do**), and
  the detail `Modal` drawer. All internal to the file (no new exported component module — S6 lifts
  what it needs).
- **Nav:** `SettingsTab` (`renderer/navigation.ts`) gains `'skills'`; `resolveNavTarget`
  resolves `settings:skills` → `{ screen: 'settings', settingsTab: 'skills' }`. `SettingsScreen`
  `TAB_CHOICES` order is General · Skills · Privacy · Diagnostics. **[superseded — Skills is now a
  top-level rail destination (`ScreenId 'skills'`), not a Settings tab; `settings:skills` is kept as a
  legacy alias resolving to `{ screen:'skills' }`. See the top status entry.]**
- **i18n:** ~70 `skills.*` keys + `settings.tab.skills` in BOTH catalogs (EN/DE, informal „du").
  Parity test green.
- **CSS:** `.skills-toolbar/.skills-intro/.skills-list/.skill-row*/.skill-perm*/.skill-import`
  in `renderer/styles.css` (modelled on the Documents `.doc-row` pattern; tokens-only).

**Decisions taken or changed:**
- **Permission display is rendered from the structural `permissions` object + `kind`, NOT from the
  `permissionSummary` string.** `summarizeSkillPermissions`/`permissionSummary` is a single English
  sentence (computed main-side); the §15 spec mandates a localised ✓/✕ "can / cannot" block, so the
  renderer maps the **already-clamped** enum values to EN/DE catalog copy. This is presentation, not
  re-validation (DS6 clamping stays main-authoritative) — it keeps the German UI honest where the
  raw `permissionSummary` would leak English. `permissionSummary` remains available on
  `SkillInfo`/`SkillPreview` for any non-localised use (S6 picker tooltip, etc.).
- **Import is a dropdown (file / folder), not a single button.** `pickSkillPackage` needs a `mode`
  (Windows can't mix file+dir in one OS dialog — S4 §22-A2 note), so "Import skill…" opens a
  Radix menu with **From a file (.skill.zip)…** + **From a folder…**, each calling `pick(mode)`.
- **The detail drawer reads the row's `SkillInfo` directly** (it carries every field) rather than
  round-tripping `getSkill` — fewer IPC calls, and the open drawer is re-synced to the freshest row
  after any mutation via a `useEffect` keyed on the refreshed list. `getSkill` stays available but
  unused by S5.
- **Enable of a `duplicateId` skill shows a "replace the other?" ConfirmDialog first** (DS12), then
  calls `enableSkill`; the server still enforces one-active-per-id, so the prompt only surfaces the
  intent. Disable never prompts. Every mutation (`enable/disable/import/delete/acknowledge`)
  re-`list()`s so sibling state (the disabled-other) reflects immediately.
- **Confirm is blocked (button `disabled`) when `preview.ok === false` OR `downgradeBlocked`**
  (DS15); the dialog still renders the structural `errors`/`notes` + the collision/upgrade/replace/
  downgrade banners so the user sees *why*.
- **No `design-guidelines.md` change** (§18.0-E): the skill row reuses the `.doc-row` §11.6 pattern
  and the ✓/✕ block is a skill-specific content layout (Badge/list idioms), not a new broadly-
  reusable pattern. Recorded here per the doc-map.

**Open landmines:** none new (no `SL-#` opened in S5).

**What S6 consumes:** the same `window.api` enable/default surface S4 produced; the `SkillInfo`
shape + `PermissionBlock`/drawer presentation it can lift from `SkillsTab.tsx`; the
`messages.skill_id` stamp (S6/S7) + the carry-forward invariant — **the glyph/turn-skill read MUST
resolve a deleted/vanished `messages.skill_id` to NULL** (no FK; S4 delete relies on it). The
composer picker, the "Using skill" chip, the per-message glyph, `resolveTurnSkill`, and the prompt
fence are **S6/S7 — NOT built in S5**.

### Skills — S4 handoff (2026-06-17)

**Contracts produced** (what S5–S8 import):
- **Shared types** (`shared/types.ts`): `SkillInfo` (decoded `skills` row + `permissionSummary` +
  `duplicateId` + `unavailable`) and `SkillPreview` (manifest summary + permission summary +
  collision/upgrade/downgrade/downgradeBlocked flags + structural `errors`/`notes`). **NEW frozen
  contract** — S5 (list/import drawer), S6 (picker), S8 (selector) consume these. `shared/skill-manifest.ts`
  gains `summarizeSkillPermissions(perms) → string` (pure, structural, shared with the renderer).
- **IPC channels** (`shared/ipc.ts` + `preload/index.ts`, all 1:1): `skills:list` `()→SkillInfo[]`,
  `skills:get` `(installId)→SkillInfo|null`, `skills:pick` `(mode?: 'file'|'folder')→path|null`,
  `skills:preview` `(source)→SkillPreview` (NO write), `skills:import` `(source)→SkillInfo`,
  `skills:export` `(installId)→path|null` (save dialog), `skills:delete` `(installId)→void`,
  `skills:enable`/`skills:disable` `(installId)→SkillInfo`, `skills:acknowledgeWarning`
  `(installId)→SkillInfo`. All DB-backed handlers `requireUnlocked` (friendly `main.skills.locked`);
  validation is resolved MAIN-side only (preview is the single truth — the renderer never re-validates).
- **`services/skills/installer.ts`** signatures: `previewSkillPackage(db, source, deps, {developerMode?})
  → SkillPreview`; `importSkill(db, source, deps, {developerMode?}) → {info: SkillInfo, fileCount}`;
  `exportSkill(db, installId, destPath, deps) → number`; `deleteSkill(db, installId, deps) →
  {deleted}`; `recordToInfo(record, duplicateId)`/`skillInfo(db, record)`. `SkillInstallerDeps =
  {appSkillsDir, userSkillsDir, limits?, now?}`. Exports `SkillImportError` + `SKILL_IMPORT_ERRORS`
  (the fixed structural reason strings).
- **Audit events** (`shared/types.ts` `AuditEventType`): `skill_imported`, `skill_deleted`,
  `skill_enabled`, `skill_disabled` — metadata `{id, source[, fileCount]}` ONLY (ids/counts, §22-M1).
  Diagnostics labels + EN/DE catalog keys added (`diag.audit.skill_*`).
- **Registry change** (`services/skills/registry.ts`): `createSkillRegistry` now reconciles disk→DB
  **once per session on the first `list()`/`get()`** (a `reconciledThisSession` guard set only on a
  successful reconcile; a read while locked retries next call). `reconcile()` still forces it.

**Decisions taken or changed:**
- **ZIP MECHANISM (the §22-A2 contract): a net-new, DEPENDENCY-FREE extractor** — Node's built-in
  `node:zlib` (`inflateRawSync` with `maxOutputLength` as the authoritative zip-bomb backstop) + a
  hand-rolled zip **central-directory** reader (the `declaredZipInflatedSize` style). NOT JSZip, NOT
  the validation-blind shell-tar path. Reads every entry from the central directory BEFORE inflating;
  STORE+DEFLATE only; encrypted/ZIP64 refused. Export writes a minimal STORE-method zip the same way.
  (JSZip appears ONLY in test fixtures, via the existing transitive dep — zero new runtime dependency.)
- **Collision + DS7 interplay (refines DS12):** a view-import installs **enabled-with-warning**, BUT
  if an **enabled app skill** shares the id it installs **disabled** (coexist) so a user skill can
  never silently shadow trusted product content (trust-first). **Enable enforces one-active-per-id**
  server-side (enabling X disables same-id siblings) — the "offer to disable the other" is realized as
  an invariant the S5 UI just surfaces.
- **Delete-during-active-stream:** handled by the documented rule "a stamp whose skill vanished
  mid-turn resolves to NULL" + a single transaction (so a reader never sees a row-gone-but-refs-present
  half state). The registerSkillsIpc layer has no in-flight set; S6's glyph read must tolerate a
  missing skill (resolve→NULL). No SL opened.
- **Export is not a distinct audit event** in v1 (plan §16 enumerates import/delete/enable/disable);
  a local log line suffices (the chosen path is user-private).

**Open landmines:** none new (no `SL-#` opened in S4). One carry-forward for S6: the glyph/turn-skill
read MUST resolve a vanished/deleted `messages.skill_id` to NULL (the delete path relies on it; there
is no FK and no stream guard in the skills IPC layer).

**What S5 consumes:** `window.api.{listSkills,getSkill,pickSkillPackage,previewSkillPackage,importSkill,
exportSkill,deleteSkill,enableSkill,disableSkill,acknowledgeSkillWarning}` + the `SkillInfo`/
`SkillPreview` shapes + `summarizeSkillPermissions` for the permission-summary line; the import drawer
shows `SkillPreview.permissionSummary` + collision/downgrade flags before calling `importSkill`; the
list renders `SkillInfo.{enabled,warningAck,duplicateId,unavailable,permissionSummary}`. (S6 consumes
the same enable/default surface + `messages.skill_id`; S8 consumes cached `manifest_json.triggers`.)

### Skills — S3 handoff (2026-06-17)

**Contracts produced** (what S4–S9 import):
- **Schema** (`services/db.ts`): additive `skills` table (full SQL in `SCHEMA`, `IF NOT EXISTS`) +
  nullable `conversations.active_skill_id` + `messages.skill_id` (ensureColumn). Columns:
  `install_id` (PK), `id`, `title`, `version`, `kind`, `source`, `path`, `enabled`, `warning_ack`,
  `trusted_level`, `manifest_json`, `unavailable_at`, `installed_at`, `updated_at`; `idx_skills_id`
  on `id`. **No FK from any core table into `skills`** (audit C3) — refs are cleared by an app-level
  sweep in S4, never a cascade.
- **`services/skills/registry.ts`**: `reconcileSkills(db, {appSkillsDir, userSkillsDir, limits?, now?})
  → ReconcileResult {inserted, updated, markedUnavailable, present, errors}`; `discoverSkillsInDir(dir,
  source, {limits?})`; `listSkills(db)`, `getSkill(db, installId)`, `getSkillsByDeclaredId(db, id)`,
  `setSkillEnabled(db, installId, enabled, now?)`, `markSkillUnavailable(db, installId, now?)`,
  `skillInstallId(source, id)`. Types: `SkillRecord`, `SkillSource` (=`SkillTrustedLevel`),
  `DiscoveredSkill`, `ReconcileResult`. The handle: `createSkillRegistry({getDb, appSkillsDir,
  userSkillsDir, limits?}) → SkillRegistry {appSkillsDir, userSkillsDir, reconcile(), list(), get(),
  setEnabled()}`.
- **`services/skills/loader.ts`**: `loadSkillPackage(record, {appSkillsDir, userSkillsDir, limits?})
  → SkillParseResult`; `loadSkillFromDir(dir, {limits?})`; `skillRecordDir(record, opts)`. ONE mode —
  reuses S2's `parseSkillManifestFromDir`; no decrypt/transient/shred.
- **`services/drive.ts`**: `DRIVE_LAYOUT_DIRS` now contains `app-skills`+`user-skills` (after
  `workspace`); both `scripts/prepare-drive.{ps1,sh}` updated to match (script-drift parity).
  `resolveAppSkillsDir(rootPath, appPath?)` (on-drive → repo-source dev fallback) +
  `resolveUserSkillsDir(rootPath)` (always `<root>/user-skills`).
- **`AppContext.skills?: SkillRegistry`** (`services/context.ts`), wired in `main/index.ts` with a
  best-effort startup reconcile.

**Decisions taken or changed:**
- **PK = deterministic natural key `install_id = "<source>:<id>"`** (NOT a random uuid) — the OPEN
  decision §0/§8.2 left to S3. Rationale: under revised §0 user-skill folders are named by `id`, so
  two same-id user skills can't coexist on disk; a disk-derived key is **stable across a DB rebuild**,
  so the FK-less `conversations.active_skill_id`/`messages.skill_id` refs keep resolving (a re-minted
  uuid would orphan them — the very thing §0 promises against). Same-id app vs user → distinct keys
  (`app:x` / `user:x`), so DS12's collision handling holds. `path` stores the folder **basename**
  (relative to its source dir), resolved by the loader — portable, no machine-specific absolute path.
- **Added column `skills.unavailable_at`** (NULL = present; ISO ts = folder vanished) — not in the
  §8.2 sketch, but required to persist the "mark-unavailable, never blind-delete" flag (DS1/§7.4). The
  NULL-sentinel convention (`scope_v2_json` precedent).
- **Reconcile insert-vs-update split is load-bearing:** a NEW row applies the source default
  (app → enabled+ack; user drop-in → disabled, DS19); an EXISTING row re-derives cached fields but
  PRESERVES `enabled`/`warning_ack` and only writes when something actually changed (idempotent — no
  spurious `updated_at` bumps). Consequence: a DB rebuild re-derives user skills as **disabled** (they
  must be re-enabled) — consistent with DS19 (a rebuild is a fresh discovery, not a confirmed import).
- **Discovery rejects** a folder whose name fails `SKILL_ID_RE` or whose SKILL.md fails validation
  (error + skip); silently skips a folder with no SKILL.md; dedupes same-`id` within a source (first
  wins). Trust is APP-assigned (app dir → `app`, user dir → `user`); a self-declared `trust` is already
  ignored by the S2 parser.

**Open landmines:** none new (no `SL-#` opened in S3). Two residuals carry RATIFIED guidance (owner,
2026-06-17) — spec for S4, not landmines:
- **Post-unlock reconcile is not yet wired** (the startup reconcile is best-effort and no-ops while an
  encrypted DB is locked). **Ratified approach for S4: lazy reconcile-once-per-session on first registry
  read** — add a `reconciledThisSession` guard inside `createSkillRegistry` so the first `list()`/`get()`
  after unlock reconciles, and have the S4 importer/deleter call `reconcile()` explicitly after they
  mutate disk. NOT an unlock-handler hook (keeps skill I/O off the crowded unlock critical path; covers
  plaintext + encrypted uniformly; chat resolves a sticky default via the persisted row regardless).
- **A workspace DB rebuild resets user-skill `enabled`/`warning_ack` to the drop-in default (disabled).**
  **Ratified: accept + document** — it is the safe direction (DS19), and persisting enable-state in a
  per-folder marker would split state across disk+DB and break "the table is a pure cache." Add one line
  to `known-limitations.md` at S9/S12: *"a workspace DB rebuild resets skill enable/acknowledgement
  state; skills must be re-enabled."*

§22-M2 (app-skill integrity residual) + DS20 confidentiality boundary stay documented-as-known-limitations
for S9.

**What S4 consumes:** the `skills` table + `SkillRecord`/registry functions (installer upserts via the
same row shape, sets `enabled`+`warning_ack` for a view-import per DS7, clears refs on delete per C3);
`resolveAppSkillsDir`/`resolveUserSkillsDir` + `resolveSkillLimits` for the new safe extractor that
unzips a `.skill.zip` straight into `user-skills/<id>/` (**ratified: importer writes the folder named by
`id` so folder-name == manifest `id` always agree; the drop-in path already tolerates a mismatch**);
`loadSkillPackage` for preview; `markSkillUnavailable`/`reconcileSkills` for the post-delete/post-import
refresh. (S6/S7 consume `messages.skill_id` + `conversations.active_skill_id`; S8 consumes cached
`manifest_json.triggers`.)

### Skills — S2 handoff (2026-06-17)

**Contracts produced** (frozen — the spine every later phase imports, §18.0-B):
- `shared/skill-manifest.ts` types: `SkillManifest`, `SkillPermissions`, `SkillTriggers`,
  `SkillCompatibility`, `SkillKind` (`'instruction'|'tool'`), `SkillTrustedLevel` (`'app'|'user'`),
  `SkillDocuments/Filesystem/NetworkPermission`, `SkillManifestValidation`, `SkillParseResult`,
  `SkillParseOptions`. Functions: `parseSkillMarkdown(source, opts)`, `validateSkillManifest(raw)`.
  Consts: `SKILL_ID_RE` (`^[a-z0-9][a-z0-9-]{1,62}$`), `SKILL_SEMVER_RE` (strict MAJOR.MINOR.PATCH),
  `SKILL_V1_PERMISSION_CEILING`, `SKILL_KINDS`, `SKILL_TRUSTED_LEVELS`, `DEFAULT_SKILL_MAX_BODY_CHARS`.
- `SkillManifest` carries `triggers` + `compatibility` and JSON-round-trips unchanged (audit **C2**
  proved by test) — S3 caches it verbatim into `skills.manifest_json`. `trustedLevel` is NOT on the
  manifest (app-assigned by the registry in S3); a self-declared `trust` field is ignored with a note.
- `services/skills/manifest.ts`: `parseSkillManifestFromDir(dir, {limits?})` +
  `parseSkillManifestSource(source, {limits?, manifestJson?})` — the main-side validation entry points.
- `services/skills/limits.ts`: `SkillLimits`, `DEFAULT_SKILL_LIMITS`, `resolveSkillLimits(env?)`.
- **New env caps** (§6.4, no doc change needed per §18.0-E — recorded here): `HILBERTRAUM_SKILL_MAX_FILE_BYTES`
  (1 MiB), `_MAX_TOTAL_BYTES` (8 MiB), `_MAX_FILES` (200), `_MAX_PATH_LEN` (255), `_MAX_DEPTH` (4),
  `_MAX_BODY` (64 KiB). Only `maxBodyChars` is enforced in S2 (the parser); the rest are consumed by
  the S4 extractor.

**Decisions taken or changed:**
- **Permission ceiling resolves by CLAMPING, never failing** (DS6 / §6.7 / §17). The §6.6 frontmatter
  comment "a non-'denied' network value *fails validation*" is superseded: a recognized-but-broader
  value (e.g. `network: allowed`, `documents: all`) is clamped DOWN to the ceiling with a non-fatal
  note; an absent or unrecognized value resolves to the ceiling (the default instruction posture — it
  can never exceed the ceiling, so this is not an elevation). This matches DS6 "restrict-only" and the
  §17 "permission-ceiling clamping" test wording. (Note kept here, not a plan edit, since the plan's
  normative text already says clamp.)
- Frontmatter accepts both camelCase (the §6.6 canonical form) and snake_case for multi-word keys
  (`minAppVersion`/`min_app_version`, `mimeTypes`/`mime_types`, `filenamePatterns`/`filename_patterns`,
  `allowedTools`/`allowed_tools`). Unknown keys are ignored. Required fields: `id`, `title`,
  `description`, `version`; `kind` defaults to `instruction`.
- `DEFAULT_SKILL_MAX_BODY_CHARS` lives in `shared/skill-manifest.ts`; `limits.ts` imports it so the
  body cap has one source of truth.

**Open landmines:** none (no `SL-#` opened in S2). The §22 items remain spec, not landmines.

**What S3 consumes:** the `SkillManifest` shape + `parseSkillManifestFromDir` (registry discovers
app-skills folders → parse → assign `trustedLevel` → upsert `skills` row with `manifest_json` =
JSON.stringify(manifest)); `resolveSkillLimits()` for the loader/installer; `SKILL_ID_RE` for the
on-disk-name safety check. S3 still owns the table, reconcile, loader, `DRIVE_LAYOUT_DIRS`/`app-skills`,
and the `shredStalePlaintext` extension (audit A3/A4/C1).

_(prior) 2026-06-16 — **Skills feature — durable design plan written (planning only, NO
code).** ⚠️ **HISTORICAL SNAPSHOT — partially SUPERSEDED. Do not treat as the current contract.** Two
decisions in this block were later revoked and the as-built design lives in the architecture.md "Skills
— design record (§1–§12)": **DS11 (encrypted blob per user skill, decrypted to a shredded transient)
was REVOKED** — user skills are now plain unencrypted folders under `user-skills/` outside the workspace
(DS3/DS19/DS20; the loader has one mode, no decrypt/shred); and the **`skill_selected` audit event (DS13)
was never built** — selecting a skill is an unaudited sticky-default write (there is no such
`AuditEventType`). The rest of the block (DS1/DS2/DS4–DS10/DS12/DS14–DS18) holds. New working paper
[`docs/skills-plan.md`](docs/skills-plan.md): local, user-installable
**Skills** (instruction packages that inject reviewed prompt text; Tier-2 app-owned tools designed
but deferred; Tier-3 script execution excluded). Key decisions: files-on-disk are truth + `skills`
table is a reconciled index (DS1, the `services/models.ts` pattern); `SKILL.md` YAML frontmatter
canonical via a shared `shared/skill-manifest.ts` (DS2); **user skills live INSIDE the encrypted
workspace (`workspace/skills/`, `.enc`), app skills OUTSIDE (`app-skills/`, read-only)** (DS3);
v1 selection is manual/deterministic with no model-native tool calling (DS4); skill text is a
fenced system section with fixed precedence below the base + grounding rules + a guard line (DS5);
permissions are app-computed `min(declared, ceiling, grant)`, never self-granting (DS6). Additive
schema only (`skills`/`skill_runs` tables + nullable `conversations.active_skill_id`); no CSP/
permission/offline/packaging changes. Phased S1–S12 (S1 = this plan). **Q1–Q9 RESOLVED + refined
with the owner (DS7–DS18):** imports install **enabled-with-warning** (DS7, `skills.warning_ack`);
**one encrypted blob per user skill** `<install_id>.skill.zip.enc`, decrypted to a shredded
transient on activation, app skills stay plain folders (DS11); **duplicate ids COEXIST with a
warning, one active per id** — table keyed by generated `install_id`, declared `id` non-unique
(DS12, revised from reject); **`skill_runs` not in v1** — added with Tier-2, v1 uses the
`skill_selected` audit event (DS13); trigger = **one-tap suggestion inside the picker** in v1, no
settings key (DS14) — **auto-fire deferred to Phase S13 behind an offline evaluation harness**
(precision/recall over a labelled corpus + threshold + undo + opt-in; not a security blocker since
enable/disable bounds candidates, §10.4); downgrade **dev-mode only** (DS15); literal assembled fence
**developer-mode only** + a per-message glyph backed by `messages.skill_id` (DS16); app skills
**committed to the repo, copied by prepare-drive** (DS17); **one skill per TURN, many per
conversation** — `messages.skill_id` per turn + `conversations.active_skill_id` as the sticky
default; per-turn skill rides `ChatOptions.skillInstallId` on send (DS18, reframed from
per-conversation). New schema: `skills` table (PK `install_id`) + nullable
`conversations.active_skill_id` + `messages.skill_id`. A dedicated **Settings → Skills** screen with
an **Import** button (pick → validate → encrypt → store) is the add-flow. **Plan then AUDITED
(4 personas, repo-grounded) and REMEDIATED in place — see skills-plan.md §22.** Headline fixes
folded back: (A1) skills must reach BOTH chat IPC AND the separate `askDocuments` RAG channel via a
shared `resolveTurnSkill()` (else document conversations silently drop the skill); (A2) **no
reusable safe zip extractor exists** — `.skill.zip` needs a NEW member-by-member extractor and must
never hit the validation-blind `tar -xf`; (A3) the crash-sweep is hard-scoped to
`workspace/documents/` — extend `shredStalePlaintext` to `workspace/skills/` (the "crash-sweep
covered" claim was false); (A4) `app-skills` must enter `DRIVE_LAYOUT_DIRS` + drive-layout.md in
**S3**, not S9; (A5) `messages.skill_id` stamps the **assistant** row (OQ-4 resolved) — a 5–6
call-site + `appendMessage` API change; (A6) the fence can't just append to the system message or it
silently starves history. Precedent-claim corrections: `policy.ts` is a boolean AND not a 3-way
`min()`; `buildSystemPrompt()` is an arg-less pass-through (needs a seam); untrusted skill text goes
in the **user/data turn** (RAG) like excerpts, not `system`; "mark-unavailable" is a NEW helper, not
a collections precedent. Coherence: user-skill blobs orphan on DB rebuild (added orphan-recovery
reconcile); `manifest_json` MUST carry `triggers`; doc-menu "Use a skill…" deferred to Tier-2;
bank-statement v1 stub body made guidance-honest. **Still S1 — plan only; no code, no schema, no
version bump.** Non-blocking impl-time items remain (OQ-1..3; OQ-4 now resolved). Next: Phase S2
(package schema + parser), carrying the §22 corrections into S3/S6/S7/§16._

_(prior) 2026-06-16 — **Dev-setup bugfix: Electron's platform binary silently fails to
extract onto an NTFS-on-Linux mount (beta builder report).** A Linux dev setting up the drive on an
NTFS (ntfs-3g/FUSE) volume hit electron-vite's opaque `Electron uninstall` ("binary not found"). Root
cause: `npm install` ran Electron's postinstall, the ~113 MB download succeeded (valid zip in
`~/.cache/electron`), but `extract-zip` **silently dropped the binary** when writing onto the NTFS
mount — leaving only an empty `dist/locales/`. And because the lockfile then matched, npm considered
electron installed and **never re-ran its postinstall**, so a repeat `npm install` couldn't repair it;
the breakage only surfaced much later at launch. **Fix:** new root **`postinstall`**
(`scripts/verify-electron.mjs`, cross-platform Node — NOT a `.ps1/.sh` mirror) that runs on EVERY
`npm install` (cached deps or not). It mirrors `electron/index.js`'s own logic (read `path.txt` →
`dist/version` → `dist/<binary>` exists & non-empty); on a healthy install it's a couple of stat()s
and exits 0. When broken it removes the half-written `dist/`, force-re-runs `electron/install.js`
(re-extract from the cached zip), re-verifies, and on persistent failure **exits non-zero with an
actionable message** (put `node_modules` on a native fs — ext4/Btrfs/APFS; the portable DRIVE can
stay NTFS) instead of letting the opaque error surface later. Honors `ELECTRON_SKIP_BINARY_DOWNLOAD` /
`ELECTRON_OVERRIDE_DIST_PATH` / `HILBERTRAUM_SKIP_ELECTRON_CHECK`. **Files:** `package.json`
(root `postinstall`), `scripts/verify-electron.mjs` (new). **Docs:** `CONTRIBUTING.md` (Dev setup
warning), `docs/packaging.md` (scripts table row). **Tests:** detection logic exercised against
half-extract / missing-binary / empty-binary / healthy fixtures (all correct); `npm run postinstall`
green on the real (healthy) install. No version bump, no schema change._

_(prior) 2026-06-16 — **Bugfix: chat/RAG failed with `HTTP 400 exceed_context_size_error`
on a long analysis session + the friendly error never showed (beta-tester report).** Symptom: a
tester analysing a 5-page bank statement hit `ChatRequestError: Chat request failed: HTTP 400 —
request (9600 tokens) exceeds the available context size (8192 tokens)` — and saw that RAW string,
not the friendly copy. **Two distinct root causes.** (1) **Overflow:** `buildChatMessages`
(plain chat) and `buildGroundedChatMessages` (RAG) replay the WHOLE persisted history with no
budget against the model context — only the retrieval cap `ragMaxContextTokens` (2500) bounded the
*retrieved chunks*, never the *total* prompt. An accumulating multi-turn conversation (history +
a fresh chunk block + system + template) crept past `contextTokens` and llama-server rejected it
before generation. The doc-task windows already sized inputs to `contextTokens`; the conversational
path was the gap left by the 0.1.20 fix. (2) **Dead friendly mapping:** the overflow IS mapped to
`main.model.contextExceeded` in `withChatStream`, but that text was sent only over the `chat:error`
event — which the renderer's `stream()` never subscribes to. The renderer surfaces the invoke
REJECTION, and `withChatStream` re-threw the RAW error; `friendlyIpcError` then only stripped an
`Error:` prefix, not the `ChatRequestError:` subclass name → the raw HTTP 400 + class name leaked.
**Fixes:** (1) new `fitMessagesToContext` (chat.ts, single owner) trims history to fit
`contextTokens` — keeps leading system message(s) + the FINAL turn (current question/grounded
prompt, never dropped), drops older turns oldest-first as a **contiguous tail** (role alternation
preserved), with a `CHAT_RESPONSE_RESERVE_TOKENS` (1024) answer headroom. Both builders take an
optional `contextTokens` (production passes `getSettings(db).contextTokens`; omitted = pure builder
for tests); `generateAssistantMessage` + `generateGroundedAnswer` thread it. (2) `withChatStream`
now THROWS the mapped friendly message on overflow (so the invoke rejection the renderer shows is
friendly), and `friendlyIpcError` strips any `WordError:` class-name prefix. Raw reason still goes
to the local log only. **Files:** `services/chat.ts`, `services/rag/index.ts`, `ipc/chat-stream.ts`,
`renderer/lib/errors.ts`. **Docs:** `architecture.md` ("Chat & streaming" — history budget + error
surfacing), `rag-design.md` (grounded assembly now whole-prompt budgeted), `known-limitations.md`
(third instance of the token-budget class). **Tests:** typecheck clean, full vitest **1375 passed /
25 skipped** (+10: `fitMessagesToContext` keep/trim/contiguous-tail/oversize-last, `buildChatMessages`
+ `buildGroundedChatMessages` trim, `withChatStream` overflow→friendly on event AND rejection,
`friendlyIpcError` subclass-name stripping). No version bump, no schema change._

_(prior) 2026-06-16 — **Adaptive Home CTA + one app-wide privacy indicator + AI-Model
de-jargon.** A **renderer + EN/DE i18n only** wave (no IPC/schema/data-contract/main-process logic
changes), folded into [`design-guidelines.md`](docs/design-guidelines.md) **§11.7** (new record),
**§11.3 D-UI3** (hero now adaptive), and **§12.1 #2** (single indicator moved, superseded note).
**(A) Home hero CTA adaptive (D-UI3).** Home led with a loud "Start chatting" even while the hub
showed "⚠ Needs a model", dead-ending at the no-model empty state. The hero is now driven by the
SAME readiness signal as the row badges (`needsModel = status != null && !modelRunning &&
!status.activeModelId`): needs-a-model → loud primary **"Choose a model" / „Modell auswählen"** (→
AI Model), with "Start chatting"/"Ask my documents" demoted to secondary (still clickable, never
hard-disabled); ready → loud **"Start chatting" / „Chat starten"**. Exactly one loud primary; the
model row keeps its own *secondary* "Choose a model". No new state. **(B) One app-wide privacy
indicator (§1.2/§7).** Reversed §12.1 #2 (chat-header-only, which left Home/Documents/AI
Model/Settings with no signal). Revived the dormant `LocalIndicator variant="sidebar"` +
`.local-indicator-sidebar` CSS at the **foot of the app rail** (restyled to match the rail —
icon-over-short-label, 12px floor, quiet/muted), removed the chat-header instance → **exactly one**
signal on every screen. Reflects the EFFECTIVE state (`PolicyStatus.offlineMode`, App-owned: folds
the policy ceiling AND the network toggle — policy-forces-off reads "Offline" even with the toggle
on): off → closed padlock + **"Offline"**; allowed → open padlock (new `lock-open` `Icon` glyph) +
**"Downloads on" / „Downloads an"** (tooltip "Downloads allowed — chats and documents stay local").
Short one-word rail labels (`indicator.short.*`); full reassurance in the tooltip; wraps at its
space like "AI Model". Click → `settings:privacy` (unchanged). **(C) AI Model de-jargon (§3/§7).**
"Start mock runtime" / „Demo-Runtime starten" → **"Try in demo mode" / „Im Demo-Modus testen"** (+
de-jargoned start-title & `diag.accel.mock`); the affordance is already developer-gated in MAIN
(`startableAsMock = missing ∧ chat ∧ developerMode`), so end users never see it — relabel chosen
over hiding. Per-card tidy: the disabled **Select** (and the disabled Start-runtime on a no-mock
card) is **hidden until downloaded** → a "Not downloaded" card's one clear action is **Download**
(+ demo on the dev path); Select returns once installed. **Files:** `HomeScreen.tsx`, `App.tsx`,
`ChatScreen.tsx` (drop header indicator + `offline` prop), `LocalIndicator.tsx`, `Icon.tsx`
(`lock-open`), `ModelsScreen.tsx`, `styles.css`, `shared/i18n/{en,de}.ts`. **Tests:** typecheck +
`npm run build` clean; full vitest from `apps/desktop` **1365 passed / 25 skipped** (IA single
rail-foot indicator + honest "Downloads on"; `LocalIndicator` short-label/honest-state; `ChatHomeNav`
adaptive-CTA incl. exactly-one-loud-primary + both locales; `ModelsScreen` no-disabled-Select +
"Try in demo mode"; removed the obsolete chat-header-indicator test; copy-tone bans "Start mock
runtime"/„Demo-Runtime"). Playwright `_electron` eyeball walk BOTH themes AND both locales (EN/DE):
Home needs-a-model vs ready; rail-foot indicator on all five screens OFF vs ON; AI Model cards —
captures in `docs/design-review/home-privacy-aimodel/` (`scripts/walk-home-privacy-aimodel.mjs`).
**No version bump, no schema change. Next:** open work unchanged (Phase 30 big-slot/embeddings —
D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Docs-screen-refinement polish: rail label hyphenation +
import-failure copy + failed-row actions + sub-nav density.** A renderer-only wave (plus the one
scoped main-process user-facing string exception, §11.2) on the Documents screen + app shell,
folded into [`design-guidelines.md`](docs/design-guidelines.md) **§12.1 #1** (rail) and **§11.6**
(extended, §-anchors stable). **No IPC/schema/data-contract changes.** **(A) Rail labels never
break mid-word.** The compact app rail hyphenated long labels ("Docu-ments"/"Doku-mente"/
"Einstel-lungen") via soft hyphens (U+00AD) baked into the i18n strings + `hyphens: manual`. Fixed:
soft hyphens **stripped** from `nav.documents`/`nav.settings` (EN+DE); `.nav-label` →
`hyphens: none; overflow-wrap: normal; word-break: normal`; the `.app-shell` grid column **widened
80px → 100px** so the longest single-word label ("Einstellungen", DE, ~72px) fits one line at the
**12px floor** (the label was also 11px → 12px); narrow breakpoints (≤760/≤520px) no longer shrink
below the fit width. **(B) Import-failure copy localized + softened (§7).** The raw English
`Unsupported file type: .xyz` (persisted + shown, leaking English into the German UI) now routes
through a new **interpolated** persist-canonical key `main.ingest.unsupportedType` (`{ext}` param;
EN "This file type isn't supported (.xyz). Try TXT, PDF, DOCX, CSV, or a supported audio format.",
DE informal „du"). [`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts) persists
canonical English via `t('en', …, {ext})` (preview sibling uses `tMain`); the D-L4 display map
([`displayMap.ts`](apps/desktop/src/renderer/lib/displayMap.ts)) gains an **interpolated matcher**
(template→regex recovers `{ext}`, re-renders in-language) + a **legacy matcher** so pre-change rows
still localize. The key is OUTSIDE `DISPLAY_MAP_KEYS` (exact set) → new `INTERPOLATED_MAP_KEYS`;
copy-tone guard now bans the raw literal. **(C) Failed-row actions.** A failed import has no text →
**Preview is meaningless**; failed rows now show inline **Remove** (reuses the delete handler;
clearable from BOTH the All-docs list and "Failed imports" view) and **Try again** (re-index) ONLY
when retryable (`isRetryableFailure` — false for unsupported-type/file-too-large/too-many-sections);
no "⋯" on a failed row. The red Failed badge + in-context banner stay, banner now **compact**
(`.doc-row-main .banner`). **(D) Sub-nav density** tightened (inter-group `8px→3px`, head `4px→2px`,
group label `11px→12px`). **Files:** `shared/i18n/{en,de}.ts`, `ingestion/index.ts`, `displayMap.ts`,
`DocumentsScreen.tsx`, `styles.css`. **Tests:** typecheck + `npm run build` clean; full vitest from
`apps/desktop` **1356 passed / 25 skipped** (display-map interpolated/legacy/hygiene; DocumentsScreen
failed-row Remove/Try-again/no-Preview + `isRetryableFailure`; new `rail-labels` guard; copy-tone
stale-literal; ingestion softened-English; i18n soft-hyphen strip). Playwright `_electron` eyeball
walk BOTH themes AND both locales (EN/DE): rail on all five screens (labels measured one-line/
unclipped, longest "Einstellungen" 72px/100px col), failed import (localized banner, Remove not
Preview, compact banner), "Failed imports" view — captures in `docs/design-review/rail-and-failed/`
(`scripts/walk-rail-and-failed.mjs`). **No version bump, no schema change. Next:** open work
unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documents screen: suggested-project FEATURE REMOVAL + sub-nav
regroup/collapse.** Two changes folded into [`design-guidelines.md`](docs/design-guidelines.md)
**§11.6** (extended, §-anchor stable). **(A) Removed the auto "suggested project" feature** —
an intentional product decision (it surfaced a near-equal row affordance for a low-value guess).
Deleted across the stack: the per-row suggestion chip + Apply/Dismiss + renderer state
([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)); the read-only
`docs:filingSuggestions` IPC handler ([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts))
+ its preload bridge + the `IPC.filingSuggestions` channel; the pure rule engine
`services/filing-suggestions.ts` (**deleted**); the `FilingRuleId`/`FilingTarget`/`FilingSuggestion`/
`FilingSuggestionResult` types + the `AppSettings.dismissedFilingSuggestions` setting (+ default)
([`shared/types.ts`](apps/desktop/src/shared/types.ts)); the `docs.suggest.*` i18n keys (EN+DE);
the `.doc-suggest*` styles. Filing stays fully manual via the row **⋯** / selection toolbar
(`addToCollection`/`createCollection`). `source_folder_label` import metadata is **retained**
(generic ingestion metadata, not suggestion-specific); the generic string[]-setting sanitizer in
[`settings.ts`](apps/desktop/src/main/services/settings.ts) stays as defensive code (comment
generalized — no string[] setting ships today). Tests: removed `filing-suggestions.test.ts`,
`filing-suggestions-ipc.test.ts`, the db-settings string[] case, the 4 DocumentsScreen suggestion
cases, the GermanSmoke suggestion-chip case, and the audit-ipc FOLDER_SENTINEL; **added** a
no-suggestion-renders guard + a `copy-tone` stale-phrase guard (EN+DE "Suggested project"/
„Vorgeschlagenes…"). **(B) Sub-nav (`SectionRail`) regrouped + densified + collapsible.** Was
~14 near-equal items; now four headed groups in order — **All documents** (default landing, no
header, slightly-emphasized active fill) · **Projects** (header + "+", per-project "⋯") ·
**Locations** (Library/Temporary/Generated/Archived under ONE header — presentation only, data
model untouched) · **Views** (common filters Recently added/Unfiled/Needs re-index always
visible; rare diagnostics Large files/Failed imports/Audio/Scanned-OCR behind a remembered
**"More ▾"** disclosure [real `<button aria-expanded>`], and an empty rare view hidden entirely).
Nav rows densified to ~36px, uniform hover; **active = `--row-selected-bg` fill + `aria-current`,
not a ring**. The **whole panel collapses** ("«" hides → list full-width; "»" re-opens),
remembered in localStorage (`hilbertraum.docs.railCollapsed`/`…viewsMoreOpen`), mirroring the
chat `ConversationList` collapse. New i18n keys `docs.section.locations`/`docs.smart.more`/
`docs.rail.hide`/`docs.rail.show` (EN+DE, type-enforced parity; German „Speicherorte"/„Mehr"/
„Bereiche aus-/einblenden"). **RESOLVES the standing "sub-nav vs global-rail stacking" watch
item** — the second column is now dismissable, not permanent. **Tests:** typecheck + `npm run
build` clean; full vitest from `apps/desktop` **1344 passed / 25 skipped**. Playwright `_electron`
eyeball walk in BOTH themes AND both locales (EN/DE): no suggestion banner; the regrouped sub-nav
with "More" collapsed + expanded; the sub-nav collapsed (full-width) + expanded; active fill;
German labels fit without hyphenation/overflow — captures in `docs/design-review/docs-subnav/`
(`scripts/walk-docs-subnav.mjs`). **Watch item still open:** the **location-taxonomy** ambiguity
(Library/Temporary/Generated/Archived mix collection membership / lifecycle / origin) — now
grouped under one "Locations" header as PRESENTATION ONLY; the data model still needs a future
pass to decide exclusive-locations vs additive-flags. **No version bump, no schema change. Next:**
open work unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documents-screen UI refinement — follow-up pass (renderer-only,
presentation only).** Four visual fixes after the compact-row restructure shipped; **no IPC,
schema, persistence, or main-process changes**, document-task handlers untouched. Folded into
[`design-guidelines.md`](docs/design-guidelines.md) **§11.6** (the same design record the prior
pass added — extended, §-anchor stable). **What changed:** (1) **Right-aligned trailing cluster
+ reading column** — chips/badges/Preview/"⋯" wrapped in one `.doc-row-trailing`
(`flex-shrink:0`, right-aligned) next to the flex-filling `.doc-row-main` (`flex:1;min-width:0`),
so filenames use the available width and ellipsize only when truly long while Preview/"⋯" align in
a clean column down the list; the list is capped to a ~1000px reading column (`.doc-list`) and the
**Documents screen widened past the 860px `.screen` prose cap** (`.docs-screen{max-width:1180px}`,
left-aligned, not centred — a list needs more width than a reading column), with
`.docs-main{min-width:0}` as the grid-blowout guard so a long unbreakable name ellipsizes instead
of pushing the trailing actions off the edge. (2) **Tags read as tags** — row Chips restyled
(`.doc-row-chips .chip`) to a quiet filled `--surface-hover` neutral, no hard border, `--text-xs`
`--text-muted`, clearly distinct from the bordered Secondary Preview button (≥4.6:1 both themes).
(3) **Status hierarchy — one green, the rest neutral** — only the readiness badge stays green
(`success`); **Summary** and **Deeply indexed** demoted to `neutral` capability badges, each with
its own glyph (`≡`/`▦`), separating "is it ready" from "what's been done to it"; exactly one
`pill-success` per row, all icon+word (1.4.1). (4) **"⋯" overflow** confirmed present,
keyboard-focusable/tabbable (hover-revealed but never out of tab order), `aria-label` "More actions
for <filename>", full secondary set incl. the separated danger **Delete → `ConfirmDialog`** — no
regression. **Files:** `renderer/screens/DocumentsScreen.tsx` (trailing-cluster wrap, reading-column
wrap, badge tones/glyphs), `renderer/styles.css` (`.doc-list`, `.doc-row-trailing`, `.docs-screen`/
`.docs-main` width + min-width, quiet `.doc-row-chips .chip`). **No i18n/string changes** (badge
glyphs are decorative; copy-tone guard green). **Tests:** typecheck + `npm run build` clean; full
vitest from `apps/desktop` **1357 passed / 25 skipped** (+4 in `DocumentsScreen.test.tsx`:
flex-fill name + right-aligned cluster order, quiet-chip-distinct-from-Preview, one-green status
hierarchy [Ready `pill-success` vs Summary/Deeply-indexed `pill-neutral`], "⋯" keyboard-focusable).
Playwright `_electron` eyeball walk of the Documents screen in BOTH themes (a long filename
ellipsizing cleanly with room beside it, the aligned Preview/"⋯" column, quiet chips vs the Preview
button, Ready-green-only with neutral Summary/Deeply-indexed, the "⋯" menu open incl. Delete) —
before/after captures in `docs/design-review/docs-refinement/{before,after}/`. **Row-alignment and
"⋯"-reachability are now verified** (long-name breathing + aligned trailing column + keyboard-
reachable overflow). Watch items unchanged: the **location-taxonomy** ambiguity (Library/Temporary/
Generated/Archived chips over a mixed collection/lifecycle/origin model — data untouched) and the
**sub-nav vs global-rail** stacking note. **No version bump, no schema change. Next:** open work
unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documents-screen UI refinement (renderer-only; extends the Phase
23–27 wave).** A presentation-only pass on the Documents screen — **no IPC, schema, persistence,
or main-process changes**; every document task keeps its existing handler/IPC. Folded into
[`design-guidelines.md`](docs/design-guidelines.md) **§11.6** (the design record; code/i18n
comments cite it). **What changed:** (1) the per-card bank of 6–7 equal-weight buttons collapsed
to **one inline Preview (Secondary) + a "⋯" Radix `DropdownMenu` overflow** (Summarize/again,
Translate, Re-index, Build deep index [hidden once deeply indexed], Make searchable (OCR) for
scans, Add to project…, Export for generated docs, and a separated **danger Delete** behind the
existing `ConfirmDialog`) — mirrors the chat `ConversationList` ⋯ pattern; trigger `aria-label`
"More actions for <filename>", keyboard-tabbable, right-click opens it too. (2) **All state reads
as Badges** (icon + word, never buttons): one processing/ready status badge + small **Summary**
(neutral) and **Deeply indexed** (success) badges in one right-aligned cluster — the green "✓
Deeply indexed" *button* and the scattered "Summary ✓" meta + blue "Temporary" badge are gone.
(3) **Library/Temporary/Generated/Archived + project tags all render as the SAME neutral `Chip`**,
grouped, separate from the status badges. (4) **Tall cards → compact list rows** (≥40px, ~56px;
ellipsized filename + muted `--text-xs` meta "PDF · 2.0 KB · 7 sections"); hover highlight +
right-click menu; **selected rows reuse the nav/history selection treatment** — new role tokens
**`--row-selected-bg`** fill + **`--row-selected-bar`** accent left bar (per theme, ramp-reused),
not an outline ring. ~3× more docs per screen. (5) **`friendlyMimeLabel`** (pure, exported,
display-only — stored MIME unchanged) maps "application/pdf"→"PDF" etc. (6) **A non-stacking
sticky selection toolbar** (Ask these documents · Compare (2), enabled only at exactly two ·
Add to project… · mark Temporary/Archived · Delete behind `ConfirmDialog`) carries the
multi-document ops so rows stay minimal. (7) **Refresh → quiet icon button** (new `refresh` glyph
in `Icon`); Import files (Primary) + Import folder (Secondary) carry the toolbar. **Files:**
`renderer/screens/DocumentsScreen.tsx`, `renderer/components/Icon.tsx`, `renderer/tokens.css`,
`renderer/styles.css`, `shared/i18n/{en,de}.ts` (+`docs.moreActions`/`chip.generated`/
`chip.archived`/`meta.sectionsCount`/`bulk.delete*`/`selectionAria`, EN/DE parity, D-L7 informal
„du"). **Tests:** typecheck + `npm run build` clean; full vitest from `apps/desktop` **1353
passed / 25 skipped** (+5; updated the Summary/Translate/Compare/Coverage/GermanSmoke +
DocumentsScreen suites off the old button set / equal-weight Delete / "Deeply indexed" button /
blue "Temporary" badge / raw "application/pdf"; added overflow-exposes-actions, MIME-helper,
selection-toolbar + Compare-at-exactly-two, and status-as-Badge cases). Playwright `_electron`
eyeball walk of the Documents screen in BOTH themes (empty, populated, "⋯" open, Summary +
Deeply-indexed badges, Temporary/Generated/Archived chips, selection toolbar with two selected →
Compare enabled). **Risks / watch items:** (a) **Location taxonomy ambiguity** — Library /
Temporary / Generated / Archived are rendered as additive chips, but the data model mixes
collection memberships (library/temporary/project) with a lifecycle enum (permanent/temporary/
archived) and `origin` (generated); whether these are meant to be mutually-exclusive *locations*
vs additive *flags* is unresolved. The UI was made consistent (uniform chips) **without** touching
the data — a future pass should decide the taxonomy. (b) **Sub-nav vs global-rail stacking** —
checked: the 80px compact global rail + the 200px Documents sub-nav (`.docs-rail`) is one icon
rail + a 200px filter column (it collapses to a horizontal strip ≤760px), NOT the two-fat-columns
problem the chat refinement fixed; no redesign this pass, flagged only as a watch item. **No
version bump, no schema change. Next:** open work unchanged (Phase 30 big-slot/embeddings —
D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Bugfix: translation import failed with `Embedding request failed:
HTTP 500` (beta-tester report).** Symptom: translating a document ran to completion, then the
materialized output failed to import with `Embedding request failed: HTTP 500`
([`e5.ts`](apps/desktop/src/main/services/embeddings/e5.ts)), surfaced to the user as "The task could
not be finished. Make sure the model is still running." **Root cause (same class as the 0.1.20 HTTP 400
fix, but in the embedder):** the chunker now sizes chunks by space-aware `approxTokenCount` (~500), but
`E5Embedder.truncateForContext` still truncated each chunk by a **naive whitespace-word split** at an
**English-calibrated 1.4 tokens/word** (`maxInputWords = floor(512/1.4) ≈ 365`). The embedder is the
**multilingual** E5 and the translation target was **German**, which is subword-heavy at ~2 real BPE
tokens/word (see [`translation.ts`](apps/desktop/src/main/services/doctasks/translation.ts) output-token
note) — so 365 German words ≈ 730 real tokens, well over the sidecar's `--ctx-size 512`
([`sidecar.ts`](apps/desktop/src/main/services/runtime/sidecar.ts)), and llama-server's embeddings
endpoint returns **HTTP 500** for an over-context sequence (chat returns 400; embeddings 500). Space-less
scripts (CJK/Thai — the whole-word-collapse case) had the same exposure. **Fix:** `truncateForContext`
now reuses the chunker's space-aware **`truncateToApproxTokens`** and budgets against the context with a
conservative **real-BPE safety factor `REAL_TOKENS_PER_APPROX_TOKEN = 2.2`** (→ ~232 approx tokens →
~464 real worst-case German, ~50-token headroom for BOS/EOS + slop). The vector still covers the chunk's
head (adjacent chunks overlap by ~80 tokens), so retrieval is unaffected in practice. **Tests:** typecheck
clean, `npm test` **1348 passed / 25 skipped** (+2 in
[`e5-embedder.test.ts`](apps/desktop/tests/integration/e5-embedder.test.ts): the existing truncation test
now asserts `approxTokenCount(sent) ≤ floor(512/2.2)`; a new regression embeds a glued space-less run + a
2000-char CJK run and asserts both are truncated within the approx-token budget — i.e. can't overflow the
sidecar). **Docs:** [`known-limitations.md`](docs/known-limitations.md) token-budgeting bullet gained the
embedder-side NB. No version bump, no schema change. **Documents embedded before this fix are unaffected
(their vectors already persisted); the bug only ever blocked NEW imports of subword-heavy/space-less
text.** **Next:** open work unchanged (Phase 30 big-slot/embeddings — D38–D43; owner-gated doc-org Phase
E.2)._

_(prior) 2026-06-15 — **Document-summary preview UI fixes (3 reported bugs).** The summary in
the document preview modal ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)
`PreviewModal`) had three frontend problems, all fixed. **(1) Layout/scroll:** the summary `<details>`
block sat ABOVE the single `.modal-body` scroll region, so a long summary grew past the dialog's
`max-height` with no scrollbar — it's now moved INSIDE `.modal-body` (summary + extracted text share one
scroll region) and `.modal-body` got `flex: 1 1 auto` so it absorbs the leftover height ([`styles.css`](apps/desktop/src/renderer/styles.css)).
**(2) Copy + Save:** the summary action row now always offers **Copy** (→ `window.api.copyToClipboard`,
the MAIN clipboard bridge) and **Save** (→ new `exportSummary` IPC: dialog + fs in MAIN, writes the
summary as Markdown, audited as `summary_exported` with id-only metadata — the exportDocument pattern),
alongside the existing Regenerate. **(3) Markdown:** the summary rendered as raw text (literal `**`); it
now reuses the chat `AssistantMarkdown` (react-markdown + GFM, http(s)-only link sanitizer) under the
`.msg-content.md` styles. New i18n keys (`docs.previewModal.copy/save/copied/copyFailed/savedTo`,
`main.dialog.exportSummary`, `diag.audit.summary_exported`) in both en/de; new `summary_exported`
AuditEventType. Typecheck clean; `npm test` **1346 passed** + 1 new DocumentSummary case (Markdown render
+ Copy/Save bridge calls). No schema change. **Next:** open work unchanged (Phase 30
big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2)._

_(prior) 2026-06-15 — **Documentation + code-comment audit (release 0.1.26).** A deep,
whole-repo doc audit: every doc cross-checked against the code, plus a comment-quality sweep. No
behavior change — docs/comments only (the 8 touched source files are comment-only edits; typecheck
clean, `npm test` **1346 passed / 25 skipped**, unchanged from baseline). **Most consequential fixes
(security/privacy honesty):** `SECURITY.md` said the diagnostics log is "not encrypted" — it **is**
(`app.log.enc` under the vault key); the "Phase 9" stamp was refreshed with the controls added since
(deny-by-default permission handler, v2 vault envelope/O(1) password change, audit log, malicious-doc
caps, fail-closed packaged policy). `PRIVACY.md` contradicted itself on the network default (one line
"on by default", another "off") — `allowNetwork` is **ON by default** (policy-gated); also completed
the vault-descriptor description (verifier + wrapped data key). `security-model.md` + `downloads.ts`
comments corrected the same default-OFF→ON error. **Systemic fixes:** the deleted plan files
(`whole-document-analysis-plan`, `document-organization-plan`) left ~80 inline `plan §x` comments —
rather than churn them against the repo's "resolve via git history" convention, **completed the
`rag-design.md` §14 anchor-mapping table** (added §3.2/§3.3/§4.4/§5.1/§5.2) so they all resolve, and
fixed only the genuinely-misleading "Phase N = future / later phases / NULL until Phase 4" status
comments (`collections.ts`, `doctasks/manager.ts`, `db.ts`, `tree-build.ts`, `node-vectors.ts`,
`coverage.ts`, `CoverageMeter.tsx`); also dropped the false "`summary_cache` pruned by size/age"
claim. **`architecture.md` was a feature-wave behind** — added the whole-document-analysis subsystem
(`services/analysis/`, the `tree`/`extract` task kinds, 4 DB tables, the yielding `ModelSlotArbiter`
concurrency model), the whisper.cpp sidecar, the ~35-service overview, the full table list,
`analysis:`/`chat:scope` IPC, audio/image parsers, and corrected `CollectionService` (nonexistent) →
`collections.ts`. **`user-guide.md`:** moved the Local indicator off the (removed) sidebar to the chat
header (2 places); documented deep index/coverage/tiers, drag-drop into chat, the composite source
picker, filing-suggestion new-project variant, the missing model/document statuses; replaced the
hardcoded thinking-mode model list with the manifest-driven rule; corrected the network-default copy.
**model/benchmark docs:** recommendation engine corrected to RAM-best-fit (`recommendModelIdByRam`)
with the real-hardware matrix; Whisper added to the catalog + license line; E5 size 0.24→0.25;
Ministral band aligned to 16–24 GB. **Decision-number collision:** the open `big-slot-embeddings-plan`
used D23–D28 (colliding with the document-task wave's D23–D37) — renumbered to **D38–D43** and updated
all cross-refs. **rag-design body:** removed the nonexistent `TREE_GROUP_TOKENS`; corrected the
`assertChatStreamReady`/`acquireChatSlot` attribution, `buildScopeFilter` signature, `summary_cache`
column list, node-count estimate, and the compound `idx_tree_edges_child`. **Smaller:**
`known-limitations.md` (removed a misplaced "DONE" item, added the 5000-row audit cap, fixed the
`ready`/`not_recommended` claim, noted symmetric truncation), `troubleshooting.md` (`.jpeg`,
mock-runtime conditions, error-string heading), `design-guidelines.md` (D-L7 done, Phase-27 superseded
note, contrast resolved, removed nonexistent "Reading your documents" copy), `packaging.md` (aria2c
scope, Node-version guard, copy glob), `CONTRIBUTING`/`README`/`CLAUDE` (typecheck + Node in dev setup,
dead plan path, Ministral-vs-4B default, `package:win`, "llama.cpp later"→done). **Version** bumped
0.1.24 → 0.1.25 → **0.1.26** (audit merged to master at v0.1.25, then a release-version increment to
v0.1.26). No schema change. **Next:** open work is unchanged (Phase 30
big-slot/embeddings — D38–D43; owner-gated doc-org Phase E.2). (Version 0.1.25 was tagged on the
audit commit; this release-version increment to 0.1.26 supersedes it as the current release.)_

_(prior) 2026-06-15 — **Whole-document analysis — second-pass review follow-up (2 fixes).** A
high-effort re-review of the closeout diff surfaced two honesty gaps the first pass left, both now fixed in
[`manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts). **(1) Mode-(b) belt parity:**
`runCompareSectionMatched`'s reduce-input belt was structurally identical to the one M-1 fixed in mode (c)
but still returned only `plan.truncated` (the map-ceiling flag) — so a model that overruns `maxTokens`
could silently condense the asymmetric report with no notice. It now returns `plan.truncated ||
beltTruncated`; the belt cuts the later doc-A windows, so the existing `compareTruncationNotice` ("covers
its beginning") wording is accurate. **(2) Symmetric loss is now mirror-even:** the Only-A/Only-B notes in
`runCompareSymmetricTrees` are **interleaved** (A, B, A, B …) before the belt instead of appended all-A-
then-all-B, so a tail-truncating reduce sheds both documents' unique content roughly evenly — preserving
the mirror property under truncation (swapping A/B drops the same sections, off by ≤1 note at an odd
boundary) rather than always sacrificing the Only-B tail. Folded into
[`rag-design.md`](docs/rag-design.md) §14.6. **Tests:** typecheck clean, `whole-doc-compare` suite 6/6
green (the M-1 truncation test still passes; the alignNodes mirror unit tests are unaffected — the
interleave is manager-level, the pure function is unchanged). No version bump, no schema change. Feature
remains COMPLETE._

_(prior) 2026-06-15 — **Whole-document analysis — post-merge code review closeout.** Reviewed the
full wave diff (`6c27cef..f3ae4e4`) against the seven priority areas (shared-connection transactions,
the arbiter handshake, H5 staleness, mirror symmetry, grounding honesty, offline/no-leak, compare cost).
**No High/Critical findings** — the concurrency machinery, transaction discipline, and the
H5/M2/M13/mirror invariants all held. **Fixed (M-1, Medium — honesty):** a *lopsided* symmetric compare
(few aligned sections but many free Only-A/Only-B notes, e.g. A=3 vs B=40 — admitted by the min-section
gate) could let the reduce-input belt condense the note tail (Only-B notes are last) and silently
under-report B, with **no** truncation notice — exactly the H8 failure mode the asymmetric label exists to
prevent. `runCompareSymmetricTrees` ([`manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts))
now returns `truncated` when the belt fires, and `runCompare` materializes the new
**`compareSymmetricTruncationNotice`** ([`compare.ts`](apps/desktop/src/main/services/doctasks/compare.ts) —
document-neutral wording, NOT mode-(b)'s "beginning of A"; English literal per the existing notice
precedent, EN/DE parity untouched). **Fixed (L-3, Low — robustness):** `ensureNodeEmbeddings`
([`node-vectors.ts`](apps/desktop/src/main/services/analysis/node-vectors.ts)) now throws a clear error if
the sidecar returns a vector count ≠ the input count, instead of an opaque `encodeVector(undefined)` throw.
**Deferred (acknowledged, not fixed):** L-2 (dedup identical node summaries before the sidecar batch —
efficiency), L-4 (`nodeVectorSearch` is reserved/unused in prod — semi-global QA is §14.8-deferred), L-5
(`stampMetaEmbedder` silently no-ops on missing/malformed `tree_meta_json` — bookkeeping only; the
authoritative scoping is `tree_nodes.embedding_model_id`), L-6 (verify the embedder sidecar serializes
concurrent `embed` from the import loop — pre-existing architecture), and a naming nit ("greedy
mutual-best-match" is really greedy global-best-first). **Docs:** the M-1 fix folded into
[`rag-design.md`](docs/rag-design.md) §14.6; the spent `docs/whole-doc-analysis-review-prompt.md`
**deleted** (its own header said to). **Tests:** typecheck clean, build OK, `npm test` **1346 passed /
25 skipped** (+1: `whole-doc-compare.test.ts` "labels the symmetric report truncated when a lopsided pair
overflows the reduce budget (M-1)" — asserts the notice appears AND the symmetric path was still taken,
not the asymmetric fallback). No version bump, no schema change. **The whole-document-analysis feature
remains COMPLETE (Phases 1–4 shipped); this is the review closeout.**_

_(prior) 2026-06-15 — **Whole-document analysis — Phase 4 (symmetric compare + lazy node
embeddings) + FEATURE CLOSEOUT.** Final phase of the whole-document-analysis plan (§6 Phase 4;
mechanisms §4.3 symmetric compare, §3.1 node vectors). Completes the feature and folds the four-phase
plan into a §-record. **The point:** make a long-document comparison HONEST and mirror-symmetric, and
make node vectors (stored NULL since Phase 1 — L6) earn their keep as their first and only consumer.
**(1) Lazy node embeddings + node-cosine helper** (new
[`services/analysis/node-vectors.ts`](apps/desktop/src/main/services/analysis/node-vectors.ts)):
`ensureNodeEmbeddings(db, documentId, embedder)` embeds each tree node's `summary_text` on the **CPU
embedder sidecar** (`--device none`, NOT the chat slot) in one batch, reusing the exact `encodeVector`
LE-Float32 encoding, stores the blob in `tree_nodes.embedding_blob`/`dimensions`/`embedding_model_id`,
and writes it back to `summary_cache` so a **rebuild refills from the cache** (0 sidecar calls — the
rebuild mints fresh NULL-vector rows with the same `content_hash`). **Scoped by `embedding_model_id`
[H5]:** a node under a different embedder (mock↔real / model swap) is **re-embedded** under the active
one — a mixed-embedder alignment NEVER silently happens; stamps `tree_meta_json.embeddingModelId`.
`nodeVectorSearch`/`loadNodeVectors` read **only `tree_nodes`** (never the chunk `embeddings` table —
node vectors stay out of citation-grade chunk retrieval, §3.6); they are NOT `VectorIndex` [H4].
**(2) Pure alignment** ([`doctasks/compare.ts`](apps/desktop/src/main/services/doctasks/compare.ts)):
`alignNodes(a, b)` — **greedy mutual-best-match** by node-vector cosine with a **swap-invariant**
tie-break (the canonical pair key) above `SYMMETRIC_MATCH_MIN_SCORE` (0.5) → pairs + unmatched-A +
unmatched-B; pure ⇒ the **mirror property** (swap A/B ⇒ Only-A ↔ Only-B, Same/Different stable) is
unit-tested without the model [M11]. Plus `compareNodePairPrompt` (equal-footing diff),
`comparePairOutputCap`, `compareAsymmetricNotice`, `SYMMETRIC_COMPARE_CALL_CEILING` (24).
**(3) Symmetric compare** ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)):
`runCompare` now picks a mode — **(a)** single-pass (already symmetric, unchanged); **(c)
`runCompareSymmetricTrees`** when BOTH docs have a `ready` tree under the active embedder AND the smaller
has ≤ ceiling level-1 sections (`bothTreesReadyForSymmetric`): lazily embed both trees' nodes, align
level-1 sections, diff each pair with one `generate`, attribute unmatched sections to Only-A/Only-B with
NO model call (node summaries fed as notes — M2, never `[Sn]` citations), reduce into the four-section
report; **(b)** the existing A-driven section-matched map-reduce as the LABELLED asymmetric fallback
(`compareAsymmetricNotice` materialized into the report when the two docs aren't both deeply indexed —
H8). The node-embed pass runs INSIDE the (non-yielding) compare DocTask, so it's still one model job at
a time (chat is refused during compare). **Data contracts (now real):** `tree_nodes.embedding_blob`/
`dimensions`/`embedding_model_id` columns are POPULATED (were NULL since Phase 1); `tree_meta_json.
embeddingModelId` records the active embedder for the staleness guard; the node-cosine helper + the
symmetric compare strategy + the embedder-staleness re-embed are the new machinery.
**Decisions flagged (not silently made):** (a) **lazy-embed on first compare**, not an explicit
"prepare compare" action (Q-default); (b) **fall back to the labelled asymmetric mode (b)** when a tree
is missing, offering the existing per-doc "Build deep index" action rather than auto-building or
requiring it (Q4-default); (c) the node-embed pass is **folded into `runCompare`**, NOT its own
DocTaskKind (it's a sidecar embed, not a chat-slot job; the compare task already serializes). The compare
in-document notices stay **English literals** (the existing `compareTruncationNotice`/`compareAttributionLine`
precedent — the report body itself is in the documents' language; a D-L7 candidate, NOT a new i18n key,
so EN/DE parity is untouched). **NOT built (deferred):** the collection "tree of trees"; a live full-scan
for unmapped extract types; semi-global QA (node summaries as derived context); node vectors in chunk
retrieval/citations; a symmetric compare above the 24-section ceiling (→ labelled asymmetric). **Tests:**
typecheck clean, build OK, `npm test` **1345 passed / 25 skipped** (+12: unit
[`node-align.test.ts`](apps/desktop/tests/unit/node-align.test.ts) — alignNodes identical→pair/orthogonal→
unmatched, the **mirror** property incl. tied scores [swap-invariant tie-break], match-floor + dim-mismatch
skip, `comparePairOutputCap` bounds; integration
[`whole-doc-compare.test.ts`](apps/desktop/tests/integration/whole-doc-compare.test.ts) — symmetric path
taken + node vectors populated under the active embedder = node count, second compare reuses [0 extra
node-embeds], rebuild refills from `summary_cache` [0 sidecar], H5 re-embed under a NEW embedder [never a
silent empty align], labelled asymmetric fallback reached only without both trees, node vectors persist +
decode after a DB reopen [whole-file-encrypted round-trip]). No version bump, no schema change (Phase 1's
nullable node-vector columns suffice). **FEATURE CLOSEOUT (doc-lifecycle):** the whole four-phase
`docs/whole-document-analysis-plan.md` is condensed into **[`docs/rag-design.md`](docs/rag-design.md) §14
(analysis design record, §14.1–§14.8)** and the plan file is **deleted** (full original incl. all three
audit passes: `git show 4071685:docs/whole-document-analysis-plan.md`). §14.x anchors are stable; the two
in-code "plan §x" path pointers ([`db.ts`](apps/desktop/src/main/services/db.ts) → §14.2,
[`whole-doc-analysis.test.ts`](apps/desktop/tests/integration/whole-doc-analysis.test.ts) → §14.1–§14.3)
are repointed (inline "plan §x" comments resolve via git history, per the doc-org precedent);
[`known-limitations.md`](docs/known-limitations.md) compare entry updated (symmetric-when-both-deeply-
indexed, else labelled one-directional). **Risks / next:** the symmetric path is O(sections) `generate`
calls (bounded by the 24-section ceiling → labelled asymmetric above it) — a heavy but user-initiated
background task on weak CPUs; the mock embedder is structure-only so semantic diff quality is a manual/
PAID smoke, not the mock suite. **The whole-document-analysis feature is COMPLETE (Phases 1–4 shipped).**_

_(prior) 2026-06-15 — **Whole-document analysis — Phase 3 (structured extract-then-aggregate).**
Third phase of [`docs/whole-document-analysis-plan.md`](docs/whole-document-analysis-plan.md) (§6 Phase 3;
mechanisms §3.3 schema, §4.2 extract+aggregate, §4.4 router, §5.1 IPC). Moves "list every X / how many"
off top-k relevance and onto a precomputed, provenance-backed SQL aggregation answered at **zero
query-time model calls** — exhaustive OVER INDEXED SECTIONS, never "complete" [H7]. **(1) Schema**
([`db.ts`](apps/desktop/src/main/services/db.ts)): additive `extraction_records` table (one item row per
surfaced item + one `__scan__` marker row/chunk recording `ok`/`unparsed`; `chunk_id` **FK ON DELETE
CASCADE** ⇒ re-index self-invalidates [H1 free win, under `PRAGMA foreign_keys = ON`]) + `idx_extract_doc_type`/
`idx_extract_chunk`; `documents.extract_status` column via `ensureColumn` (NULL|pending|extracting|ready|stale|
failed, mirrors `tree_status`); `reconcileStuckExtracts` (mirror of `reconcileStuckTrees`, `extracting`→
`pending`); re-index resets `extract_status`→`stale` in the chunk-replacement block (rows cascade away).
**(2) Extract pass** (new [`services/analysis/extract.ts`](apps/desktop/src/main/services/analysis/extract.ts)):
`extractDocument` — the second YIELDING build (same arbiter handshake/park/cancel/lock discipline as the
tree, [H3/H9/H10]); one `generate`/chunk over the fixed v1 type set (`generic|date|amount|party|obligation`),
strict JSON-array prompt at temp 0, tolerant `parseExtraction` (recovers fenced/prose-wrapped arrays;
`[]` is a valid empty parse) + **retry-once**, then an `unparsed` `__scan__` marker — **never drops the
chunk** [H7]; per-`(chunk_id, content_hash)` **resume cache** = **0** calls on re-run; per-chunk
`try{BEGIN…COMMIT}catch{ROLLBACK}` [H11]; `normalized_value` dedup; node vectors out of scope.
`aggregateExtractions` — query-time GROUP BY `normalized_value` through the shared
`buildScopeFilter('document_id')` [M3], **0** model calls, returns items+counts+source-chunk provenance +
`scannedChunks`/`totalChunks`/`unparsedChunks`/`fullyChunked`. **(3) DocTaskManager**
([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)): new `extract` `DocTaskKind`
+ `runExtract` (registers/unregisters the arbiter like `runTreeBuild`), validated like `tree` (one doc,
runtime required, **`fully_chunked` gate [C4]**); `isYieldingKind` makes `abortActiveBuild`/`cancelDocTask`
arbiter-reject treat extract like tree (chat-stream's pause-vs-refuse already keys off the arbiter).
**(4) Router** (new [`services/analysis/router.ts`](apps/desktop/src/main/services/analysis/router.ts),
pure): `routeQuestion` — EN+DE classification (list/every/each/how many/count + jede/alle/wie viele/
sämtliche/liste/zähl), fixed precedence **explicit-button > compare(2 docs) > coverage-extract >
tree-summary > relevance** [M7], closed-vocab→type synonym map (`mapQuestionToRecordType`, EN+DE, default
generic), **low-confidence / no-extract-data / compare-without-2-docs → labelled relevance** (never an
empty "no items" or a false "complete"). **(5) rag:ask wiring**
([`registerRagIpc.ts`](apps/desktop/src/main/ipc/registerRagIpc.ts)): after scope resolve + filename
auto-scope, a `coverage-extract` decision over a mapped pre-extracted type streams the deterministic
listing (new [`services/analysis/listing-answer.ts`](apps/desktop/src/main/services/analysis/listing-answer.ts)
— coverage line + per-item provenance + caveat, built via `tMain`) at 0 model calls; **everything else
falls through to the existing relevance path byte-unchanged**. **(6) IPC**: `analysis:listAll`
([`registerDocTasksIpc.ts`](apps/desktop/src/main/ipc/registerDocTasksIpc.ts)) → `ExtractionListing|null`
(read-only, content stays in DB); mirrored in [`preload`](apps/desktop/src/preload/index.ts); channel in
[`shared/ipc.ts`](apps/desktop/src/shared/ipc.ts). **(7) Shared contracts**
([`shared/types.ts`](apps/desktop/src/shared/types.ts)): `ExtractRecordType`/`EXTRACT_RECORD_TYPES`,
`ExtractStatus`, `ExtractionListing`/`ExtractionListingItem`/`ExtractionListingRequest`; `DocTaskKind +=
'extract'`; `CoverageMode += 'extract'` + `CoverageInfo.unparsedChunks`/`fullyChunked` (the reserved Phase-2
field, now real); `DocumentInfo.extractStatus` (threaded via `DocumentRow`/`rowToInfo`). **(8) Renderer**:
`CoverageMeter` ([`CoverageMeter.tsx`](apps/desktop/src/renderer/components/CoverageMeter.tsx)) gains the
`extract` listing copy ("every match … N sections scanned (k unparsed)", whole-document wording gated on
`fullyChunked`, NEVER "complete"). **i18n**: EN+DE `analysis.kind.*`/`analysis.listing.*`/`coverage.extract.*`/
`docs.task.extract*` (type-enforced parity; forbidden-UI-words honoured — "sections", no chunk/record/extract
jargon; German flagged **D-L7**). **Decisions flagged (not silently made):** (a) extract is **manual-only**
(started via `startDocTask`), NOT auto-enqueued at import — avoids surprise multi-minute CPU spend (Q4
default); (b) a **separate `extract_status` column** (NOT folded into a shared `deep_index_status`) — tree +
extract run independently; (c) an unmapped/ad-hoc "{X}" falls back to **labelled relevance** in v1 (no live
full-scan task — deferred), so the 0-call completeness claim is only ever made for a mapped pre-extracted
type. The chat listing surfaces its honesty IN-TEXT (coverage line + caveat) rather than threading a new
per-message `CoverageInfo` payload (avoids a `messages`-table change); the `extract` CoverageMeter mode is
wired for the meter component + future preview use. **NOT built (Phase 4):** symmetric/both-trees compare,
node-vector align, node embeddings (node vectors stay NULL — L6); the collection "tree of trees"; a live
full-scan for unmapped types. **Tests:** typecheck clean, build OK, `npm test` **1333 passed / 25 skipped**
(+27: unit [`extract-router.test.ts`](apps/desktop/tests/unit/extract-router.test.ts) — router classification/
precedence/low-confidence→relevance/open-vocab→type EN+DE + `parseExtraction` JSON tolerance/empty-vs-unparsed/
unknown-type-coerce; integration [`whole-doc-extract.test.ts`](apps/desktop/tests/integration/whole-doc-extract.test.ts)
— O(n) calls + per-chunk markers, unparsed marker [H7], warm-cache re-run = 0 calls, per-chunk ROLLBACK +
connection-survives + resumable [H11], aggregation GROUP BY via buildScopeFilter = 0 calls + ground-truth
count + per-item provenance, archived-excluded [M3], re-index cascade→stale [H1], honest listing answer
"sections scanned"+caveat + unparsed surfaced; renderer [`Coverage.test.tsx`](apps/desktop/tests/renderer/Coverage.test.tsx)
— extract meter whole-vs-sections + unparsed, never "complete"; +1 GermanSmoke extract meter). No version
bump, no schema-version (additive table/column). **Risks / next:** the extract pass is a multi-minute
serialized CPU pass on weak hardware (manual, size-unbounded — a UI trigger + size gate like the deep index
is a follow-up); per-chunk recall/dedup/overlap caveats are surfaced, not solved (the H7 honesty point);
**Next:** Phase 4 — symmetric, coverage-oriented compare + lazy node embeddings._

_(prior) 2026-06-15 — **Whole-document analysis — Phase 2 (coverage meter + tiers +
provenance UI).** Second phase of [`docs/whole-document-analysis-plan.md`](docs/whole-document-analysis-plan.md)
(§6 Phase 2; mechanisms §4.5 coverage tiers, §5.1 IPC + `CoverageInfo`, §5.2 renderer). The
honesty layer over Phase 1's deep index: surface BREADTH (whole document vs the most relevant
passages) and DEPTH (tier) as two separate, honest statements — **breadth ≠ fidelity [C1/L2]**,
"100%"/"deeply indexed" shown ONLY for a `ready` tree, and node summaries are NEVER `[Sn]`
citations [M2]. **(1) Shared contracts** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)):
new `CoverageInfo` (`mode:'tree'|'relevance'|'capped'`, `treeStatus?`, `chunksCovered/Total`,
`treeLevels?`, `tier?`, `truncated?`; `unparsedChunks` reserved for Phase 3), `DocumentCoverage`
(`{coverage, provenance: Citation[]}`), `TreeBuildStatus`, `CoverageTier`; `DocumentSummary.tier?`;
`DocumentInfo.treeStatus`/`fullyChunked`/`treeLevels` (additive/optional, threaded via
`DocumentRow`/`rowToInfo`/`listDocuments`/`getDocument` in
[`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts); `parseSummary` now keeps
`tier`). **(2) Coverage + provenance reader** (new
[`services/analysis/coverage.ts`](apps/desktop/src/main/services/analysis/coverage.ts)):
`reachableLeafChunkIds` (the PRODUCTION `tree_edges`→leaf-chunk walk, replacing Phase 1's test-only
helper), `documentLeafProvenance` (leaf SOURCE chunks → `Citation[]`, M2-safe), `documentCoverage`
(breadth+depth — ready ⇒ whole-document at tier; building/stale/pending ⇒ partial fraction, never
100%; no tree ⇒ capped/beginning), plus `maxTreeLevel`/`nodeSummariesAtLevel` for the tiers. Pure DB
reads, no model call; all CONTENT-derived (never logged/audited). **(3) Coverage tiers** in
`runSummary` ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts) new
`summarizeFromTree`): requested via the `summary` task `params.tier` (no-arg = **Tier 1**, so the
one-click summary is byte-unchanged) — **Tier 1** = stored root verbatim (**0** model calls, Q6);
**Tier 2** = ONE reduce over the root's children (the layer that fit the root's single budget group,
so always one window); **Tier 3** = ALL level-1 nodes reduced in budget batches **bounded by node
count**, never document size. All tiers cover the whole document (`truncated:false`). **(4) IPC**:
`analysis:coverage(documentId)` ([`registerDocTasksIpc.ts`](apps/desktop/src/main/ipc/registerDocTasksIpc.ts))
→ `DocumentCoverage|null` (read-only; provenance only for a `ready`-tree summary); mirrored in
[`preload`](apps/desktop/src/preload/index.ts); channel in
[`shared/ipc.ts`](apps/desktop/src/shared/ipc.ts). **(5) Renderer**: new
[`components/CoverageMeter.tsx`](apps/desktop/src/renderer/components/CoverageMeter.tsx) — `CoverageMeter`
(breadth pill + depth line) and `TierMenu` (reusing the `DepthMenu` Radix pattern); the
PreviewModal ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)) renders
the meter (augmenting the truncated banner), the tier selector (only with a ready deep index), and
`SourcesDisclosure` provenance — fetched via `documentCoverage` on open; the chat
[`Transcript`](apps/desktop/src/renderer/chat/Transcript.tsx) labels every grounded (cited) answer
mode `relevance` ("the most relevant passages — not the whole document"); a **"Build deep index"** /
**"Re-index for deep index"** (C4) / **"Deeply indexed"** badge row action on `DocumentsScreen`
(`onBuildDeepIndex`/`onSummarizeTier`). **i18n**: new EN+DE `coverage.*` + `docs.deepIndex.*` +
`docs.previewModal.sources` (type-enforced parity; forbidden-UI-words honoured — "deeply indexed"/
"sections"/"passages", no tree/node/chunk/vector/embedding leak; German flagged for **D-L7**). **NOT
built (Phases 3–4):** `extraction_records`/`extract.ts`, the "list every X" router rule, symmetric
compare, node embeddings (node vectors stay NULL — L6). **Tests:** typecheck clean, build OK,
`npm test` **1306 passed / 25 skipped** (+22: 8 integration in
[`whole-doc-analysis.test.ts`](apps/desktop/tests/integration/whole-doc-analysis.test.ts) — ready-tree
whole-document coverage at tier, reachable-leaves==chunk-count + leaf provenance [M2], tree-less
capped truncated/whole, building reports partial-not-ready [C1], Tier 1/2/3 = 0/1/bounded calls +
absent-param-defaults-Tier-1; 10 renderer in
[`Coverage.test.tsx`](apps/desktop/tests/renderer/Coverage.test.tsx) — meter honesty [relevance label,
ready whole+tier, building never 100%, capped never complete], chat relevance label on/off, Build-deep-
index starts a `tree` task, C4 "Re-index first" re-indexes not a dead build, ready "Deeply indexed"
badge, PreviewModal meter+selector from `analysis:coverage`; +2 GermanSmoke — deep-index action +
CoverageMeter German). No version bump, no schema change (Phase 1's columns/tables suffice). **Risks /
next:** the row "Build deep index" is offered on any indexed non-generated doc without a ready tree
(user-initiated, may be a multi-minute CPU build on weak hardware); **Next:** Phase 3 —
`extraction_records`/`extract.ts` + the "list all/every/how many" router rule._

_(prior) 2026-06-15 — **Whole-document analysis — Phase 1 (cap honesty + ingest-time
summary tree).** First phase of [`docs/whole-document-analysis-plan.md`](docs/whole-document-analysis-plan.md)
(§6 Phase 1; mechanisms §3.1–§3.5, §4.1, §5.1). Moves whole-document coverage from query time
to ingest time via a persistent hierarchical summary tree (RAPTOR-lite), and makes the
1 000-chunk cap HONEST. Offline, one model job at a time, node vectors deferred (NULL) to Phase 4.
**(1) Cap honesty [C1/C2/C4/M13].** New single source of truth `MAX_CHUNKS_PER_DOCUMENT`
([`chunker.ts`](apps/desktop/src/main/services/ingestion/chunker.ts)); `processDocument`
([`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts)) now chunks with
`maxChunks = cap + 1` and **rejects an over-cap document** with a persist-canonical
`main.ingest.tooManyChunks` **BEFORE** the destructive `DELETE FROM chunks` (M13 — a re-index of
an over-cap doc keeps its existing searchable chunks; the gate fails closed), and stamps a
`documents.fully_chunked` marker at the ONE indexing-success site (every path funnels through it —
C4), so "the stored chunks ARE the whole document" is provable. A legacy `fully_chunked IS NULL`
doc must re-index before any deep index / 100 %-coverage. **(2) Schema** ([`db.ts`](apps/desktop/src/main/services/db.ts)):
additive `tree_nodes` / `tree_edges` (polymorphic `child_id`, NO FK to chunks) / `summary_cache`
tables in `SCHEMA`; `documents.tree_status` / `tree_meta_json` / `fully_chunked` columns via
`ensureColumn`; `reconcileStuckTrees` (mirror of `reconcileStuckDocuments`, flips a stuck
`building` → `pending`); **tree teardown** in the chunk-replacement block (`DELETE FROM tree_nodes`,
edges cascade via `parent_id`; `tree_status` → `stale` when a tree existed — H1/H2). Everything
inherits whole-file encryption; node summaries / cache are CONTENT (never logged/audited).
**(3) Model-slot arbiter [H9/H10/M9]** (new [`services/analysis/model-slot-arbiter.ts`](apps/desktop/src/main/services/analysis/model-slot-arbiter.ts)):
the single in-process owner of the chat runtime slot for a YIELDING build — `shouldYield`/`reacquire`
(builder PARKS, does NOT return) / `acquireForChat` (chat requests a pause, awaits the handoff,
gets a release fn) / `abort` (rejects the parked reacquire on cancel/lock/quit). **(4) Yielding
per-node build** (new [`services/analysis/tree-build.ts`](apps/desktop/src/main/services/analysis/tree-build.ts)):
packs chunks → summarizes each group into one fresh node → recurses to one root; **one
`try{BEGIN…COMMIT}catch{ROLLBACK;rethrow}` per node** (H11 — a thrown insert never poisons the
shared connection); summary text from the content cache keyed `(content_hash, model_id)` (C3 — a
rebuild/resume over a warm cache costs **0** chat calls; node identity is a fresh row per
position so boilerplate can't collapse the tree); **node vectors NULL** (L6 — embedded lazily in
Phase 4); resume = discard partial tree + rebuild from cache; model pinned via `tree_meta.modelId`
(M12). **(5) DocTaskManager** ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)):
new `tree` DocTaskKind (validates `fully_chunked`), `runTreeBuild` (registers/unregisters with the
arbiter), `isYieldingBuildActive` / `acquireChatSlot` / `abortActiveBuild`, and
`maybeEnqueueTreeBuild` (auto-offer, size-gated on `planSummaryWindows().truncated`, runtime-gated →
`pending`). `runSummary` now **serves the ready tree root verbatim** (`truncated:false`, 0 extra
calls — M1) and falls back to the capped map-reduce when there is no tree. **(6) Chat handoff**
([`chat-stream.ts`](apps/desktop/src/main/ipc/chat-stream.ts) now **async** + branches on the
running task's kind; `withChatStream` acquires the slot before any model call and releases it in
`finally`; callers `registerChatIpc`/`registerRagIpc` await it). Lock/quit
([`registerWorkspaceIpc.ts`](apps/desktop/src/main/ipc/registerWorkspaceIpc.ts), `index.ts`
`shutdown`) call `abortActiveBuild()` before the sidecar teardown (M9); `listDocuments`
([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)) reconciles stuck trees when
no task is live, and import/reindex call `maybeEnqueueTreeBuild`. **i18n:** `main.ingest.tooManyChunks`
+ `docs.task.treeBusy`/`treeBusyTitle` (EN+DE, type-enforced parity; "deep index" is the user word —
no chunk/node/tree jargon; German flagged for the standing **D-L7** review); `tooManyChunks` added
to the D-L4 display map. **Docs:** plan status banner → "Phase 1 shipped"; `known-limitations.md`
(over-cap rejection behavior change + deep-index coverage note). **NOT built (Phases 2–4):** the
coverage-meter UI, `extraction_records`/`extract.ts`, symmetric compare, node embeddings.
**Tests:** typecheck clean, build OK, `npm test` **1284 passed / 25 skipped** (+21: 6 unit
[`model-slot-arbiter.test.ts`](apps/desktop/tests/unit/model-slot-arbiter.test.ts) — pause/resume,
last-chat-resumes, abort-rejects, no-hang-on-finish, idempotent release; 15 integration
[`whole-doc-analysis.test.ts`](apps/desktop/tests/integration/whole-doc-analysis.test.ts) — over-cap
rejection + never-partial, M13 re-index-fails-closed, `fully_chunked`, structural root→every-leaf
incl. the last chunk [M11], tree-first summary [M1], tree-less fallback, warm-cache rebuild = 0
calls + re-index→stale→cache reuse despite chunk-id churn [C3/H1/H2], C4 legacy gate, H11
ROLLBACK + connection survives, H10 chat-pauses-build-resumes-in-session + cancel-rejects-parked,
DB-reopen persistence, reconcileStuckTrees). No version bump. **Risks / next:** auto-enqueue runs
a multi-minute serialized build on weak CPUs (size-gated to docs the capped summary can't cover);
the chat↔chat double-send race in the now-async guard is theoretical (UI prevents it) and can't
cause two model jobs; **Next:** Phase 2 — `CoverageInfo` + the coverage-meter/tier/provenance UI._

_(prior) 2026-06-15 — **Diagnostics copy/save + download resilience (beta-tester
feedback).** Three small improvements, rebased on top of the 0.1.21 document-organization wave.
**(1) Copy buttons** on the Settings → "Diagnostics (advanced)" cards: **App & runtime**, **Hardware
benchmark**, and **Logs** each gained a **Copy** button that writes a plain-text rendering of exactly
the rows shown to the clipboard (toast-confirmed), so a user can paste diagnostics into a support
message. The on-screen rows and the copied text share the same builders
(`runtimeStatusLine`/`buildAppRuntimeReport`/`buildBenchmarkReport` in `DiagnosticsTab.tsx`) so they
can't drift — the App-card runtime row was refactored onto `runtimeStatusLine` to dedupe. Copy goes
through a new **`window.api.copyToClipboard`** that writes from the **MAIN process** (`clipboard:write`
IPC → Electron's `clipboard.writeText`), **not** `navigator.clipboard` — the latter needs a secure
context + focused document and threw a "can't copy to clipboard" error in the `file://`-loaded
renderer (beta-tester report). **The write MUST be in main:** the renderer is `sandbox: true`, and a
sandboxed preload has no access to the `clipboard` module (only `ipcRenderer`/`contextBridge`/
`webFrame`/`nativeImage`/`webUtils`) — an initial preload-side `clipboard.writeText` silently failed
the same way until it was moved to main. The same bridge is used by the chat message-copy action. **(2) Save
logs to a file:** the Logs card gained **Save to file…** → new `exportLog` IPC (`logs:export`) →
`saveTextExport`, writing the **whole** current log (new `readLogFull()` in `logging.ts`, not just the
`getLogTail` tail) as **plaintext** to a user-chosen path. The on-disk `app.log` stays **encrypted**
at rest; the export is a deliberate user action to take a copy *outside* the vault for support (never
uploaded, no telemetry). **(3) Flaky-connection download hardening:** a beta tester's link dropped
mid-`curl` and lost the download. `curl --retry` alone doesn't retry a mid-transfer DROP on older
curl, so every `curl` in the fetch scripts now goes through a wrapper (`Invoke-CurlResilient` in
`.ps1`, `curl_resilient` in `.sh`) — an **outer retry loop** (5 attempts, growing back-off) that
**resumes the partial file** (`-C -`) each attempt, plus strengthened per-call flags (`--retry 3
--retry-delay 2 --retry-connrefused --connect-timeout 30`). SHA-256 verification AFTER download is
unchanged, so resume can't weaken integrity. **Files:** `services/logging.ts` (+`readLogFull`),
`shared/ipc.ts` (+`exportLog`, +`writeClipboard`), `ipc/registerCoreIpc.ts` (export + clipboard
handlers), `preload/index.ts` (+`exportLog`, +`copyToClipboard`),
`renderer/screens/settings/DiagnosticsTab.tsx`, `renderer/screens/ChatScreen.tsx` (main-clipboard
copy), `shared/i18n/{en,de}.ts`
(+`diag.copy*`/`diag.logs.save`/`diag.logs.savedTo`/`main.dialog.exportLog`),
`scripts/fetch-runtime.{ps1,sh}`, `scripts/fetch-models.{ps1,sh}`. Two follow-up polish passes:
benchmark-card buttons restyled to match App & runtime (small secondary, not a large primary) + 8px
gap above the results; clipboard write moved preload → main (sandbox fix). **Docs:** `architecture.md`
("Diagnostics & transcript export" copy/save bullet), `packaging.md` ("Resilient downloads" para).
**Tests:** typecheck clean, build OK, `npm test` **1263 passed / 25 skipped** (+7 over the 0.1.21
doc-org baseline: 4 renderer copy/save in `DiagnosticsCopySave.test.tsx`, +1 `readLogFull` in
`logging.test.ts`, +2 `writeClipboard` handler in `core-model-ipc.test.ts`; the copy assertions point
at the `copyToClipboard` bridge). Released as **0.1.23** (the wave's working `v0.1.22` tag was
superseded by the version bump), tagged `v0.1.23`._

_(prior) 2026-06-15 — **Merged the document-organization wave (Phases A–F) to `master`; release
0.1.21.** The whole Library/Projects/Temporary/Generated/Archive feature + its audit remediation
(DM-1/DM-2/RAG-1/SEC-1 + UX-1/UX-2/UX-3) + the D-L7 doc-org German pass are now on `master`; a focused
security review of the branch came back clean (no findings). Merged on top of `master`'s
document-analysis `HTTP 400` fix (0.1.20) — the overlapping service/i18n files auto-merged; only the two
`package.json` versions (→ 0.1.21) and this handoff narrative needed hand-resolution. Tagged `v0.1.21`.
Per-entry detail for both lines below._

_(prior) 2026-06-14 — **Bugfix: document analysis failed with `HTTP 400` on space-less
text (beta-tester report).** Symptom: every document **summary** and **document answer** failed
with `Chat request failed: HTTP 400` while plain chat worked, across two models (qwen3-4b-2507 /
4096 ctx and qwen3-8b / 8192 ctx). **Root cause:** `tokenize`/`approxTokenCount`
([`chunker.ts`](apps/desktop/src/main/services/ingestion/chunker.ts)) counted whitespace WORDS, so
text with no word breaks — CJK/Thai, or a glued PDF/extraction run — collapsed to ~1 "token". That
silently defeated every context budget (chunker, summary/translation/compare windows, the RAG cap),
so the assembled prompt overflowed the model context and llama-server returned
`exceed_context_size_error` (a 400). Reproduced + verified the fix end-to-end against the user's exact
build (b9585 `d73cd0767` on `D:`): an un-windowed space-less doc → 400, a budget-sized window → 200.
**Fixes:** (1) `approxTokenCount` now counts space-less scripts per character and charges over-long
no-space runs by length; new `windowByTokens`/`truncateToApproxTokens` do content-preserving,
budget-bounded windowing (space-less runs hard-cut by char, nothing inserted). `chunkSegments`,
`packIntoWindows` (summary+translation), `planCompareWindows`, and the manager reduce/pair clamps all
switched off raw word slicing onto these. **Normal prose is unchanged (word≈token), so existing
budget tests stayed green; documents indexed before the fix keep their old chunks until Re-indexed.**
(2) `LlamaRuntime.chatStream` now throws a typed **`ChatRequestError`** that includes the server's
`{error:{message,type}}` body (it used to be discarded); `isExceedContextError` maps the overflow to
the friendly, localized **`main.model.contextExceeded`** in the doctask manager + chat/RAG stream
wrapper. (3) Secondary latent bug fixed: a failed answer left an orphan user turn, so a later turn
sent **consecutive user messages** → some templates raise `HTTP 500` ("roles must alternate");
`collapseToAlternating` (applied in `buildChatMessages`/`buildGroundedChatMessages`) keeps strict
role alternation. **Files:** `services/ingestion/chunker.ts`, `services/doctasks/{summary,compare,
manager}.ts`, `services/runtime/llama.ts`, `services/chat.ts`, `services/rag/index.ts`,
`ipc/chat-stream.ts`, `shared/i18n/{en,de}.ts`. **Docs:** `rag-design.md` (token estimate +
windowing), `architecture.md` "Chat & streaming" (role alternation + surfaced errors),
`known-limitations.md` (token-budget bullet corrected + re-index note). **Tests:** typecheck clean,
`npm test` **1155 passed / 25 skipped** (+13: chunker space-less/windowing, summary CJK window,
llama-runtime error-body + `isExceedContextError`, `collapseToAlternating`). No version bump._

_(prior) 2026-06-14 — **D-L7 German-copy review (document-organization slice) + UX-3.**
Closing the i18n/a11y items deferred by the doc-org audit remediation. Surveyed the German catalog
against the pinned informal-„du" glossary ([`de.ts`](apps/desktop/src/shared/i18n/de.ts) header, D-L7):
the Phase D/E/F doc-org copy was clean **except** for **7 formal „Sie/Ihre" strings**, all now recast
informal — `chat.scope.sourcesTitle` („Wähle deine Quellen", **UX-2**), `chat.scope.librarySourceHint`
(„Deine gesamte Wissensbasis", **UX-2**), `chat.scope.archivedFallback`, `docs.project.deleteBody`/
`deleteKeepHint`/`deleteWithHint`, and the adjacent `docs.reindexAllConfirm.body`. (Verified the three
other `Sie/Ihr` hits at `de.ts:714/839/940` are the pronoun „it/its", not address — left as-is.) The
six `D-L7-Review ausstehend`/`…markiert` markers on the doc-org blocks (de.ts + en.ts) now read
**`erledigt (2026-06-14)`**. **UX-3 (a11y):** attachment processing/added is now announced on the
keyboard/picker path — a visually-hidden polite **`role="status"` aria-live** region in the chat surface
([`ChatScreen.tsx`](apps/desktop/src/renderer/screens/ChatScreen.tsx)) driven by a new
**`chat.attach.added`** key (EN „Added {name} to this chat" / DE „{name} zu diesem Chat hinzugefügt");
processing reuses `chat.attach.processing`; failures stay on `ErrorBanner`. en/de key parity stays
type-enforced. **Tests:** typecheck clean, **`npm test` 1243 passed / 25 skipped** (count unchanged;
`ChatAttach` "pending chip" test now asserts the text appears in BOTH the visible chip AND the sr-only
announcer — i.e. covers UX-3). No version bump. **Audit findings now fully closed:** UX-1/UX-2/UX-3 (the
last open doc-org items). Docs: `known-limitations.md` flipped the deferral note to DONE. **Next:** the
broader Phase 39–42 German sign-off (user's standing D-L7 pass) is still open; owner-gated Phase E.2; the
unremediated security audit (`docs/security-audit-2026-06-14.md`); or new work._

_(prior) 2026-06-14 — **Document-organization audit remediation** (the audit report
`docs/document-organization-audit-2026-06-14.md` was deleted once fully remediated — the final version
incl. the remediation banner is recoverable via
`git show e294377:docs/document-organization-audit-2026-06-14.md`).
Implementation pass fixing the audit's correctness bugs + adding the tests that should have caught them.
**FIXED (closed):** **DM-1 (High)** — M1 crash-resume now files by pending destination on EVERY
indexing success: `fileFromPendingDestination` is called inside
[`reindexDocument`](apps/desktop/src/main/services/ingestion/index.ts) (not only the import loop), so a
crash-interrupted Project/Temporary/conversation import that the user re-indexes lands in its intended
destination, not Library; the helper now also **skips generated docs** (`origin_json` set ⇒ never filed,
D3/N1) so re-indexing a translation can't sweep it into Library. **DM-2 (Medium)** — generated
`origin_json` is now stamped at `createQueuedDocument` time (new `origin` option) BEFORE the row can be
`indexed`, so the Library backfill's `origin_json IS NULL` guard holds across a mid-materialize crash
(`materializeDocument` passes `origin` at create; the post-success `setDocumentOrigin` only re-asserts it
+ clears `original_path`). **RAG-1 (Medium)** — `generateGroundedAnswer` now passes the same scope
retrieval used to `corpusNeedsReindex` (`normalizeScope(opts.scope ?? opts.scopeDocumentIds)`), so the
re-index-vs-empty honesty holds on the legacy doc-id path too (whole-corpus/composite paths
byte-identical). **SEC-1 (Low)** — `updateSettings` now validates array-typed defaults element-wise
(require `Array.isArray`, keep only strings, cap at 10 000) so `dismissedFilingSuggestions` can't persist
a non-array/oversized renderer value. **DM-3 (Low)** — `expandPathsWithSource` matches a picked root on a
separator boundary (`=== dir || startsWith(dir+sep)`), no sibling-prefix mislabel. **RAG-3 (Low)** — the
FTS scope predicate moved from the JOIN `ON` to `WHERE` (param order preserved; LEFT-JOIN-safe). **UX-1
(Low)** — the filing-suggestion chip is `role="group"`+`aria-labelledby` with the reason tied to Apply via
`aria-describedby`. **DOC-1 (Low)** — softened the "doc-org record §N" convention sentence. **RAG-2
(Low)** — clarifying comment (inheriting `includeArchived` is correct/consistent with `documentsInScope`;
no leak); no risky pin. **DEFERRED (with reason):** **UX-2** (formal "Sie/Ihre") + **UX-3** (attachment
`aria-live`, needs a new German "added" string) — both folded into the pending **D-L7 German-copy review**
rather than fixed ad hoc; noted in [`known-limitations.md`](docs/known-limitations.md). RAG-4/DOC-2/4 etc.
are correct-by-spec or stale-but-permitted nits (left as-is). **Tests:** typecheck clean, build OK,
`npm test` **1243 passed / 25 skipped** (+8): **TEST-1** (real crash-resume flow through the
`reindexDocument` IPC — reconcile→failed→re-index→asserts PROJECT membership; fails pre-DM-1) + a
generated-guard test; **DM-2/TEST-9** (origin stamped while `queued`; re-open backfill never files it);
**TEST-8** (a doc in BOTH a picked collection AND `documentIds` counts each chunk once); **TEST-2**
(folder exact-before-contains ordering + cohort tie-break most-common-then-lexicographic-id) + **TEST-5**
(engine tolerant of a malformed `origin` shape); **SEC-1** settings array validation. **Docs updated:**
architecture.md §1 M1 row + §4 (single indexing-success entry point) + §6 (origin stamped at queue time);
rag-design.md §13.6 (legacy-path scoped honesty); known-limitations.md (UX-2/UX-3 deferred). No version
bump, no skipped hooks. **Next:** the D-L7 German-copy review (UX-2/UX-3 + the Phase D/E/F German flags);
owner-gated Phase E.2; or new work._

_(prior) 2026-06-14 — **Document organization — Phase F (Filing suggestions, rule-based +
non-silent).** Sixth and final v1 phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md)
(esp. §5 non-goals, §11.2, §12.3, §16, §17, §19, §20 "Phase F", §21 Q8/Q9). **Rule-based ONLY — no
model, no network, no telemetry, never silent, never auto-file.** **Engine** (new pure, LOCAL,
deterministic [`filing-suggestions.ts`](apps/desktop/src/main/services/filing-suggestions.ts)):
`suggestFilingForDocument(doc, collections, allDocs)` returns ranked, de-duped suggestions
(`{ruleId, target: existingProject|newProject, reasonKey: MessageKey, reasonParams}`) via three rules,
highest-confidence first — **(1) folder-name match** (`source_folder_label` equals/contains an active
project name), **(2) same-source-folder cohort** (other docs sharing the folder are filed in project X),
**(3) bilingual filename pattern** (small documented EN-canonical+German token tables: invoice/receipt/
bill/statement·Rechnung/Beleg/Quittung/Kontoauszug, contract/agreement·Vertrag/Vereinbarung → a matching
existing project else a `newProject` with a canonical English name). **Subjects EXCLUDED** (D3/§7):
generated (`origin != null`), Temporary/archived lifecycle, and already-project-filed docs — and archived
projects are never suggestion targets. Tolerant: missing/empty metadata ⇒ no suggestion, never throws;
**deterministic** (no clock, no randomness). **Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)):
new `FilingRuleId`/`FilingTarget`/`FilingSuggestion`/`FilingSuggestionResult` (reason is an i18n KEY +
params, NOT free text); new `AppSettings.dismissedFilingSuggestions: string[]` (DEFAULT `[]`) — dismissals
persist in the **existing settings JSON blob, NOT a new `documents` column** (additive, tolerant, sticky
across restart). **IPC** ([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)): new
**read-only `docs:filingSuggestions`** ⇒ `suggestFilingForDocuments(listDocuments, listCollections)`;
mirrored in [`preload`](apps/desktop/src/preload/index.ts). **Apply reuses existing channels** (existing ⇒
`docs:addToCollection`; new ⇒ `collections:create` + `docs:addToCollection`); no new audit event — applying
records only `documents_added_to_collection` (id/type/count), so the suggestion REASON
(folder/pattern/project name) is **never** logged. **Renderer**
([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)): a quiet, dismissible
per-row chip ("Suggested project: Tax 2025 — Apply?" + a localized reason line + **Apply**/**Dismiss**) on
unfiled docs (its natural home is the Phase-E **Unfiled** view, also shown in All); Apply files via the
membership path then the doc leaves Unfiled; Dismiss hides it + persists via `updateSettings`; suppressed
once dismissed or when the target project vanished; reflow-safe (`.doc-suggest` flex-wrap, plan §12 L4).
**i18n**: new flat `docs.suggest.*` (chipExisting/chipNew/apply/dismiss/titles + reason.folder/cohort/
filename) EN+DE — reason strings are keyed templates; **German copy flagged for the D-L7 review.**
Forbidden-UI-words honoured. **Decisions locked:** rule-based only in v1 (local-AI classification is a
LATER owner-gated step, NOT built); auto-creating projects from top-level folders at import (§11.2/§21 Q8)
is a separate deferred follow-up (NOT built); dismissals in AppSettings (not a column); no new audit event
(reuse `documents_added_to_collection`, sentinel stays clean). **Tests:** typecheck clean, build OK,
`npm test` **1235 passed / 25 skipped** (+19: new [`filing-suggestions.test.ts`](apps/desktop/tests/unit/filing-suggestions.test.ts)
[12 — each rule incl. EN/DE patterns, ranking+de-dup, exclusions, archived-target, tolerance, determinism,
batch]; new [`filing-suggestions-ipc.test.ts`](apps/desktop/tests/integration/filing-suggestions-ipc.test.ts)
[2 — expected set + Apply existing via addToCollection + leaves-unfiled; Apply new via createCollection;
audit folder-label content-free]; `DocumentsScreen` [+4 — chip render+Apply-clears, Apply newProject,
Dismiss-persists-and-sticks-across-refresh, no-suggestion-no-chip]; GermanSmoke [+1 — German chip];
`audit-ipc` sentinel-grep extended with a FOLDER_SENTINEL (suggestion-reason) + the filingSuggestions
flow). No version bump. **Deliverable proof (covered by tests):** importing receipts from a "Tax 2025"
folder (or invoice/rechnung filenames) surfaces a quiet "Suggested project: Tax 2025 — Apply?" on Unfiled;
one click files the doc via the existing membership path; nothing is filed without that click; no model is
called, no network touched, and the audit log records only ids/counts — never the suggestion reason or any
name. **DOC-LIFECYCLE CLOSE-OUT (DONE — owner-confirmed 2026-06-14):** the whole v1 feature (Phases A–F;
E.2 owner-deferred) was condensed into §-numbered design records and
`docs/document-organization-plan.md` was **deleted** (full original in git: `git show
477f803:docs/document-organization-plan.md`). The records: **[`docs/architecture.md`](docs/architecture.md)
"Document organization — design record" §1–§8** (decisions D1/D2/D3 + the audit fixes, data model,
services, IPC, generated provenance, audit, trade-offs); **[`docs/rag-design.md`](docs/rag-design.md) §13**
(the scope/retrieval half — `DocumentScope`, `resolveScope`, the arg-5 `RetrievalScope` union H3, the
membership-OR-id SQL filter, C1 archive, D3/N1 generated exclusion, N2 filename auto-scope, M2 scoped
re-index); **[`docs/user-guide.md`](docs/user-guide.md) §7** (the user-facing Library/Projects/Temporary/
Generated/Archived + source picker + filing suggestions copy). The two in-code doc pointers
([`types.ts`](apps/desktop/src/shared/types.ts), [`db.ts`](apps/desktop/src/main/services/db.ts)) and the
`known-limitations.md` C4 note were repointed to the new records (existing inline "plan §x" comments
resolve via git history). **Next:** owner-gated Phase E.2 (explicit retention + Temporary review
dashboard); local-AI filing suggestions (owner-gated); or new work._

_(prior) 2026-06-14 — **Document organization — Phase E (Smart views + generated staleness).**
Fifth phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §5,
§7.5/§7.6, §8.2, §12.1, §15.3, §16, §17, §19, §20 "Phase E"). **Additive, query-time only — no new
column, no migration, no parser/chunker/embedder change, no new audit events.**
**Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)): new `LARGE_FILE_BYTES` (10 MB),
`SmartListView`/`SmartViewPredicate`, a pure **`matchesSmartView(doc, view)`** (the single source of truth
for the smart-view predicates so the renderer rail and the `docs:list` filter never drift), and
`GeneratedStaleness`/`GeneratedStaleReason` + a pure **`generatedStaleness(doc, sources)`**.
**Smart views (§7.6/§12.1):** the remaining query-time views ship as section-rail entries + `docs:list`
`smart` predicates — Recently added (createdAt desc — **no new column**), Unfiled (no *project* membership;
Library/Temporary builtins don't count as filed), Needs re-index (`staleEmbeddings`), Large files
(`sizeBytes >= LARGE_FILE_BYTES`), Failed imports (`status='failed'`), Audio (audio mime / generated
transcript), OCR/scanned (`ocr != null || scanDetected`). **IPC**
([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)): `DocumentListFilter.smart` widened
to `SmartListView`; `filterDocuments` routes `recent`⇒createdAt-desc order, `all`⇒no-op, else
`matchesSmartView`. **Renderer** ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)):
`DocSection` union + `inSection` extended (generated/archived/unfiled/needsReindex/large/failed/audio/ocr
delegate to `matchesSmartView`; `recent` ordered in `visibleDocs`); a **Views** rail group reusing the
projects-group layout so the existing 760px reflow applies (L4, no horizontal page scroll). **Generated
staleness (§15.3):** `generatedStaleness` is a tolerant derivation over the already-listed `updatedAt`/
`lifecycle` fields (**no hot-path write**) — flags `source-changed` when a source was updated after the
output's `createdAt`, `source-removed` when a source is missing/archived; a legacy origin shape or a
malformed/empty `createdAt` ⇒ no flag (never throws); a non-generated doc is never evaluated. Surfaced as a
quiet **Badge (icon + word, never color-only) + "re-run to update" copy** on the Generated rows; re-running
the task stays the only fix (snapshot semantics unchanged). **i18n**: new flat `docs.smart.*` (heading +
7 view labels) + `docs.provenance.stale{Badge,Changed,Removed}` EN+DE — **German copy flagged for the D-L7
review.** Forbidden-UI-words list honoured (no bucket/vector/scope_json/FTS/collection_id/membership/
embedding). **Decisions locked:** smart views are query-time predicates, **not** stored collections
(`CollectionType` keeps `'smart'` reserved-unused) and **not** pickable retrieval scopes in v1 (§13.2);
"Recently added" uses `createdAt` (no column) — `last_used_at`/"Recently used" (L2) stays deferred.
**Explicitly DEFERRED (owner-gated Phase E.2, NOT built):** explicit retention + Temporary review dashboard
(§14.3 — needs the reserved `expires_at` column, a review-before-delete UI, default Never, must never touch
Library/generated/project-filed docs, must shred sidecars under an encrypted workspace); `last_used_at`
(§8.2 L2). **Tests:** typecheck clean, build OK, `npm test` **1216 passed / 25 skipped** (+16: new
[`smart-views.test.ts`](apps/desktop/tests/unit/smart-views.test.ts) [each predicate incl. Unfiled
project-vs-Library-only + the 7 staleness cases]; `docs-ipc` smart-view filter + recent ordering;
`DocumentsScreen` smart-rail filter + staleness-badge-on-stale-not-fresh; GermanSmoke extended for the new
keys). No version bump. **Deliverable proof (covered by tests):** the Documents screen exposes the full
smart-view set; a translation whose source was re-indexed after it was generated shows a quiet "source
changed — re-run to update" badge in Generated while an untouched one does not — with no new column, no
retrieval change, and the audit log still content-free. **Next:** Phase F — filing suggestions (rule-based
first, never silent); or owner-gated Phase E.2 (explicit retention + Temporary review dashboard)._

_(prior) 2026-06-14 — **Document organization — Phase D (Generated provenance, D3/N1).**
Fourth phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §2.3, §7.4,
§15.1–§15.3, §16, §17, §19, §20 "Phase D"; decisions D3/M4 + audit N1). Gives generated
translation/comparison documents **structured provenance** and locks the **no-membership** invariant.
**Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)): new `GeneratedProvenance`
(`{kind:'summary'|'translation'|'compare'|'transcript'|'other', sourceDocumentIds[], sourceCollectionIds?,
modelId?, createdAt}`) + `GeneratedKind`; `DocumentOrigin` widened to the union
`TranslationOrigin | CompareOrigin | GeneratedProvenance` (reuses `origin_json` — **no new column**); a new
**`provenanceView(origin)`** normalizer collapses old+new shapes to `{kind, sourceDocumentIds}` so the UI
has one code path. **Read** ([`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts)):
`parseOrigin` now reads the structured shape FIRST (by `kind`+`sourceDocumentIds`, narrowed via a
`GENERATED_KINDS` tuple), then falls back to the legacy `type`/`translatedFrom`/`comparedFrom` branches
**unchanged** (old rows keep parsing); malformed ⇒ null, never throws (tolerant — `createdAt` defaulted to
`''` when absent). **Write** ([`doctasks/manager.ts`](apps/desktop/src/main/services/doctasks/manager.ts)):
a new `buildProvenance(kind, sourceIds, modelId)` builds the `GeneratedProvenance` translation/compare now
write (capturing `modelId=runtime.modelId` + a de-duped `sourceCollectionIds` snapshot via new
[`collectionIdsForDocument`](apps/desktop/src/main/services/collections.ts)); `materializeDocument`'s
`origin` param is now `GeneratedProvenance`. **N1/D3 locked:** a generated row still gets **NO**
`document_collections` membership at all (doctasks call `createQueuedDocument`+`processDocument` directly,
never `fileFromPendingDestination`/`fileIntoLibraryIfUnfiled`), so it is **structurally excluded** from
every collection-derived scope and reachable only via explicit `documentIds` (or download + re-import).
`role='generated'` stays a reserved-unused enum string; the `role <> 'generated'` predicate stays dropped.
**Renderer** ([`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)):
`provenanceLine` + the PreviewModal origin line now render from `provenanceView` (kind+source ids), not the
parsed display strings — "Translated from …" / "Comparison of … and …" / new "Summary of …" /
"Generated from …"; source titles still resolve tolerantly (deleted source ⇒ "a removed document"). The
Generated section view (`origin != null`) + Export/Download are unchanged; snapshot semantics unchanged
(no auto-update; **staleness UI is Phase E** — v1 only persists `createdAt`+`sourceDocumentIds`). **i18n**:
new flat `docs.provenance.summaryBefore`/`generatedBefore` EN+DE — **German copy flagged for the D-L7
review.** **Decisions locked:** generated docs out of the DEFAULT corpus structurally (no predicate);
summaries stay `summary_json` metadata (NOT materialized — `kind:'summary'`/`'transcript'` reserved for
forward use); additive/nullable only, `origin_json` reused, tolerant parse everywhere; no parser/chunker/
embedder change; no new audit events. **Tests:** typecheck clean, build OK, `npm test` **1200 passed /
25 skipped** (+3 net: doctasks-translation gains structured-provenance+zero-membership+sourceCollectionIds
and new-shape-round-trip/old-shape-back-compat/malformed-null tests; DocumentTranslate gains a
new-structured-shape label render; existing doctasks-translation/compare + audit-ipc origin assertions
updated to the new shape — extended, not broken; audit sentinel stays clean). No version bump.
**Deliverable proof (covered by tests):** translate report.pdf ⇒ the output shows "Translated from
report.pdf" from structured provenance, sits in Documents → Generated, carries ZERO collection membership
(so it's absent from a Library/project answer), is answerable only when hand-picked, and is made durable by
Download + re-import (Phase C). **Out of scope (Phase E+):** smart views beyond Generated; explicit
retention; staleness/auto-update UI; converting summaries to documents. **Next:** Phase E — Smart views +
cleanup (Generated/Recently added/Unfiled/Needs re-index/… + optional explicit retention with review UI)._

_(prior) 2026-06-14 — **Document organization — Phase C (Temporary analysis).**
Third phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §2.5, §7.3,
§11.1–§11.4 D2, §13.1/§13.3/§13.5, §14.1/§14.2, §16, §17, §19, §20 "Phase C"; audit C3/H1/H2/M1/N3/N4/N12).
Builds the **net-new chat attach / drag-drop intake** + import-destination filing over the Phase-A/B
backend. **Data contract** ([`shared/types.ts`](apps/desktop/src/shared/types.ts)): new `ImportDestination`
(`{kind:'library'} | {kind:'collection';collectionId} | {kind:'temporary'} | {kind:'conversation';conversationId}`)
+ `ImportOptions` (`{destination?, preserveRelativePaths?}`). **Ingestion**
([`ingestion/index.ts`](apps/desktop/src/main/services/ingestion/index.ts)): `createQueuedDocument(db, path,
opts)` now persists the resolved destination into `documents.pending_destination_json` **at queue time**
(M1) + folder `source_relative_path`/`source_folder_label`; new `expandPathsWithSource` (N12 folder
metadata, L3 basename fallback); a bare-string 3rd arg still means `displayTitle` (doctasks caller
unchanged). **Filing** ([`collections.ts`](apps/desktop/src/main/services/collections.ts)): new
`fileFromPendingDestination` (the single indexing-success entry point — reads `pending_destination_json`,
files, clears; NULL ⇒ Library default so old options-less imports stay byte-for-byte; also the crash-resume
path), `fileDocumentByDestination`, `linkConversationDocument` (**FK-guarded N3** — verifies the conversation
exists, try/catch the check-then-insert race; skip the link, keep the doc in Temporary if it's gone;
append-only `ON CONFLICT DO NOTHING`), `conversationAttachmentIds`, `parsePendingDestination` (tolerant).
A conversation/temporary destination ⇒ Temporary membership + `lifecycle='temporary'`; conversation also
writes the `conversation_documents` link (C3) — **never** `scope_json` (H4/N5). **IPC/preload**:
`docs:import` extended to `(paths, options?)` (the loop now files via `fileFromPendingDestination`, replacing
the Phase-B blanket `fileIntoLibraryIfUnfiled`); new **`chat:listAttachments`** (the conversation's
`conversation_documents` docs for the footer); both mirrored in [`preload`](apps/desktop/src/preload/index.ts).
A renderer-untrusted `ImportDestination` is sanitized in the IPC (`sanitizeDestination` ⇒ Library fallback).
**Renderer**: [`ChatScreen.tsx`](apps/desktop/src/renderer/screens/ChatScreen.tsx) gains a chat-surface
**drag-drop target** + a Composer **📎 attach** picker (`onAttach`), the **intake** (`attachFiles` →
`importDocuments(paths,{destination:{kind:'conversation',…}})`), **plain-chat drop routing** (§13.5/H2:
documents chat ⇒ attach in place; empty ⇒ switch in place to a new documents conversation; an in-progress
plain chat ⇒ **create+commit a NEW documents conversation before** the import references its id (N3), focus
it, toast — **never** mutate/clear the plain chat), and the **pending chip → live attachment** transition
(N4, driven by the existing `getImportJob` polling); [`ScopePopover.tsx`](apps/desktop/src/renderer/chat/ScopePopover.tsx)
shows a read-only **"Files in this chat"** line (attachments always unioned in, NOT removable chips; a
processing one is a pending chip) + a "· N file(s) in this chat" footer suffix;
[`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx) "Move to project" on a
**Temporary** doc now also makes it permanent + drops Temporary membership (§14.1; Keep-in-Library already did).
**i18n**: new flat `chat.attach.*` keys (button/drop/processing/newDocChat/failed) EN+DE — **German copy
flagged for the D-L7 review.** **Decisions locked:** temporary attachments live in `conversation_documents`
(C3), never `scope_v2_json`; the LINK (not Temporary membership) is authoritative for "files in this chat";
duplicate import is always-new (D2 — no sha dedup); deleting a conversation removes only the link (CASCADE),
never the doc (§14.2); no retention sweep in v1 (Phase E); no new audit events. **Out of scope (Phase D+):**
generated provenance; smart views / explicit retention. **Tests:** typecheck clean, build OK, `npm test`
**1197 passed / 25 skipped** (+18: destination filing round-trip + M1 crash-resume + N3 FK-guard + idempotent
link + `parsePendingDestination` in `collections.test.ts`; `docs-ipc` destination round-trip (temporary/
conversation/project + options-less Library); `chat-ipc` `listAttachments`; renderer `ChatAttach.test.tsx`
[empty-drop new conversation + pending chip, pending→live N4, plain-chat-with-messages new conversation +
toast, read-only Files-in-this-chat]; DocumentsScreen Keep-in-Library / Move-from-Temporary; GermanSmoke
attach button). No version bump. **Deliverable proof (covered by tests):** drop invoice.pdf into a chat ⇒
it imports as a Temporary `conversation_documents` attachment answerable in that chat, appears in Documents →
Temporary, and is NOT in Library until the user explicitly Keeps it. **Next:** Phase D — Generated provenance
(D3: `GeneratedProvenance`, no membership, structurally excluded, downloadable + re-importable)._

_(prior) 2026-06-14 — **Document organization — Phase B (Projects + composite scope, D1).**
Second phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md) (esp. §0.1 D1,
§8.3, §10.1, §12, §13, §16). Builds the user-facing surface over the Phase-A backend.
**Data contract** ([`chat.ts`](apps/desktop/src/main/services/chat.ts)): `Conversation` gains
`collectionId: string|null` + `scope: DocumentScope|null` (parsed tolerantly from `scope_v2_json` via the
relocated, now-exported `parseDocumentScope` in [`collections.ts`](apps/desktop/src/main/services/collections.ts));
`createConversation` gains `opts.collectionId`/`opts.scope`; new `setScope` (persists `scope_v2_json`,
empty scope = explicit "All documents", null clears) + `setConversationCollection` writers.
`updateConversationScope`'s legacy replace semantics are **unchanged** (H4/C3). **IPC/preload** (plan §16):
new [`registerCollectionsIpc.ts`](apps/desktop/src/main/ipc/registerCollectionsIpc.ts)
(`collections:list/create/rename/setArchived/delete`); [`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts)
gains `docs:addToCollection`/`removeFromCollection`/`setLifecycle` + a `docs:list` filter
(`{collectionId?,lifecycle?,smart?}`) + **imports default-file into Library** on indexing success
(`fileIntoLibraryIfUnfiled`, zero-membership-guarded so re-index never re-files a project-only doc, keeping
"Library == all"); [`registerChatIpc.ts`](apps/desktop/src/main/ipc/registerChatIpc.ts) gains
`chat:setScope`/`setCollection` + the two `createConversation` opts. "Move" = add + remove (no channel).
**delete-project two modes** (plan §12.3): `membershipOnly` (CASCADE) and `withDocuments` (deletes ONLY
genuinely project-only docs — the C2 `projectOnlyDocumentIds` predicate counts ALL memberships so a Library
member is spared; reuses ingestion `deleteDocument`, which **now `shredFile`s** the stored copy instead of
`rmSync` — M5). Every channel mirrored 1:1 in [`preload/index.ts`](apps/desktop/src/preload/index.ts).
**Live ask path** ([`registerRagIpc.ts`](apps/desktop/src/main/ipc/registerRagIpc.ts)): now calls
`resolveScope(db, conversationId)`, passes the `RetrievalScope` to `generateGroundedAnswer` via `opts.scope`
(so `corpusNeedsReindex` is scope-aware — M2), and runs filename auto-scope **within** the resolved scope
(`documentsInScope` + `buildScopeFilter`), skipping it only when `hasExplicitDocSelection` (N2); the
STREAM.scope notice is kept. **DocumentInfo** gains `collections[]` (joined in `listDocuments`), `lifecycle`
(NULL⇒permanent), `sourceFolderLabel` (NOT `lastUsedAt` — L2). **Audit** (plan §17): `collection_created/
renamed/archived/deleted` + `documents_added_to_collection/removed_from_collection/document_lifecycle_changed`
— **id/type/count ONLY, never the project NAME** (asserted by the extended `audit-ipc` sentinel-grep with a
project-name sentinel). **Renderer**: [`DocumentsScreen.tsx`](apps/desktop/src/renderer/screens/DocumentsScreen.tsx)
left **section rail** (Library/Projects/Temporary/Generated/Archived/All — responsive collapse at 760px) +
membership chips + lifecycle pills + an Organize per-row menu + bulk move/lifecycle + project
create/rename/archive/delete (two-mode confirm); [`ScopePopover.tsx`](apps/desktop/src/renderer/chat/ScopePopover.tsx)
is now a **multi-select source picker** (Library + each non-archived project + "Specific documents…" +
one-tap "All documents"; Temporary/Generated not pickable — N10/D3) writing a persisted `DocumentScope`;
the composer footer summarizes the composed union (`scopeFooterLabel`);
[`ChatScreen.tsx`](apps/desktop/src/renderer/screens/ChatScreen.tsx) derives the picker scope, persists via
`setConversationScope`, project-defaults the anchor on create, and shows the dangling/archived-project →
Library fallback notice (§13.4); [`ConversationList.tsx`](apps/desktop/src/renderer/chat/ConversationList.tsx)
groups by the creation-anchor `collection_id` with an "Other / Library" group when any chat is anchored
(`groupByProject`, additive — date grouping otherwise unchanged, N8). **i18n**: new flat `docs.section.*`/
`docs.action.*`/`docs.project.*`/`chat.scope.*`/`chat.list.otherGroup`/`diag.audit.collection_*` keys in
[`{en,de}.ts`](apps/desktop/src/shared/i18n) — **German copy flagged for the D-L7 review.** **Forbidden UI
words** (bucket/vector/scope_json/FTS/collection_id/membership/embedding) avoided. **Out of scope (Phase C+):**
chat attach/drag-drop INTAKE + `conversation_documents` writes + plain-chat drop; generated provenance;
smart views/retention. **Tests:** typecheck clean, build OK, `npm test` **1179 passed / 25 skipped** (+16:
new [`collections-ipc.test.ts`](apps/desktop/tests/integration/collections-ipc.test.ts) [CRUD, membership+
lifecycle+filtered list, C2 delete-with-documents spares a Library member, `chat:setScope` round-trip across
a DB reopen, resolveScope-in-IPC filename auto-scope + N2 skip] + chat scope/collection round-trip & writers &
C2 predicate in `collections.test.ts` + the audit sentinel/event extensions + renderer rail/project/picker
tests + GermanSmoke). No version bump. **Deliverable proof (covered by tests):** create project "Tax 2025",
ask over "Library + Tax 2025 + contractA.pdf" in one documents chat, and the composite scope persists across
an app restart (`scope_v2_json`). **Next:** Phase C — Temporary analysis (chat attach/drag-drop intake +
`conversation_documents` + destination chooser)._

_(prior) 2026-06-14 — **Document organization — Phase A (Collections core, backend
foundation).** First phase of [`docs/document-organization-plan.md`](docs/document-organization-plan.md).
Adds a collection-membership layer over the existing pipeline — one stored file, one chunk set,
one vector set per document; organization is metadata. **Schema** ([`db.ts`](apps/desktop/src/main/services/db.ts)):
three additive tables in the `SCHEMA` constant — `collections`, `document_collections`,
`conversation_documents` (the last two with **`ON DELETE CASCADE` on both FKs**, plan C4: with
`PRAGMA foreign_keys = ON` a pre-feature app's direct `DELETE FROM documents` would otherwise hit an
FK violation; CASCADE makes any build delete a doc cleanly) — plus indexes, plus nullable
`ensureColumn` additions (`documents.lifecycle`/`source_relative_path`/`source_folder_label`/
`pending_destination_json`/`expires_at`, `conversations.collection_id`/`scope_v2_json`; all NULL-sentinel
since the `ensureColumn` DDL grammar forbids DEFAULT/NOT NULL). **Migration** (`seedCollections`, run in
`openDatabase`, idempotent): seeds one **Library** + one **Temporary** built-in (by `type`, canonical
English names, UI localizes by type) and back-fills Library membership for every `status='indexed'`,
**`origin_json IS NULL`** (generated docs get NO membership — D3/N1), **unfiled** document (the
`NOT EXISTS` guard makes re-open a no-op; the `status='indexed'` gate is M1). **Services** (new
[`collections.ts`](apps/desktop/src/main/services/collections.ts)): CollectionService CRUD
(create/rename/archive/delete — built-ins undeletable/unarchivable, delete is membership-only via
CASCADE) + membership (add/remove, idempotent `ON CONFLICT DO NOTHING`) + `docLifecycle` coalesce +
**`resolveScope`** (a conversation's stored scope → a `RetrievalScope`: `scope_v2_json` composite ⇒
authoritative union; else legacy `scope_json`⇒specific docs / `collection_id`⇒project / else Library
default; chat attachments from `conversation_documents` always unioned in; `hasExplicitDocSelection`
set from hand-picks BEFORE merging attachments — N2; tolerant parse → never throws). **Retrieval**:
new neutral [`retrieval-scope.ts`](apps/desktop/src/main/services/retrieval-scope.ts) `buildScopeFilter`
(membership-OR-id UNION + document-level archived exclusion, plan §10.2/C1/D1) shared by `VectorIndex`
([`embeddings/index.ts`](apps/desktop/src/main/services/embeddings/index.ts)), `keywordSearchChunks`
([`rag/hybrid.ts`](apps/desktop/src/main/services/rag/hybrid.ts)), and scope-threaded `corpusNeedsReindex`
(M2); `retrieve`'s arg-5 is now a normalized union **`string[] | RetrievalScope | null`** (H3 — a bare
array/null still means legacy doc-ids, so **every existing positional caller/test is byte-identical**),
`generateGroundedAnswer` gains `opts.scope`. **Data contract:** `RetrievalScope`, `DocumentScope`,
`Collection`/`CollectionType`/`DocumentCollectionRole`/`DocumentLifecycle` in
[`shared/types.ts`](apps/desktop/src/shared/types.ts). **Deliberately deferred to later phases:** no IPC/
preload/renderer surface, no `Conversation.scope`/`collectionId` fields, no project UI, no chat attach
UI, no delete-with-documents, no audit events for collection ops, no `last_used_at` (L2) — Phase A is
backend-only and leaves observable behaviour **identical** (Library == all documents on day one). The
live ask path ([`registerRagIpc.ts`](apps/desktop/src/main/ipc/registerRagIpc.ts)) is **unchanged**;
`resolveScope` is built + tested but wired into the IPC in Phase B. **Docs:** version-skew note added to
[`known-limitations.md`](docs/known-limitations.md); the plan stays open (condensed into §-records +
deleted only when the whole feature ships — CLAUDE.md doc-lifecycle rule). **Tests:** typecheck clean,
build OK, `npm test` **1163 passed / 25 skipped** (+21: new `collections.test.ts` [seed/backfill,
CRUD, membership idempotency, CASCADE version-skew, resolveScope, no-network] + `rag-collections.test.ts`
[collection∪doc union, archived exclude/include + project-archive-doesn't-exclude C1, generated
structurally excluded + explicitly selectable D3, M2 empty-vs-stale split, legacy arg-5 unchanged]). No
version bump. **Next:** Phase B — projects + composite scope (IPC + multi-select source picker +
`Conversation.scope`/`scope_v2_json` wiring + conversation-list grouping)._

_(prior) 2026-06-13 — **Three post-MVP UI fine-tunes.** (1) **Chat example chips matched
the mode.** Plain Chat has no document access, yet its empty-state examples were document-shaped
("Summarize this contract" / payment terms / indemnity). Split into two key sets: `chat.exampleChat.*`
(explain a concept / write a polite email / brainstorm — general-purpose) for chat mode and
`chat.example.*` (now "Summarize this document" …) for the "Ask my documents" mode; `ChatScreen`
picks by `mode`. (2) **Nav rail labels no longer truncate.** `.nav-label` was `overflow:hidden +
text-overflow:ellipsis`, which clipped single long words on the ~80px rail ("Documents",
"Dokumente", "Einstellungen"). **Electron's Chromium ships no hyphenation dictionaries**, so
`hyphens:auto` is inert and a bare `break-word` splits mid-word with no hyphen ("Dokument"/"e").
Fix: the long labels carry explicit **soft hyphens (U+00AD)** in the i18n strings
(`nav.documents` = `Docu­ments`/`Doku­mente`, `nav.settings` = `Ein­stel­lungen`),
honored by `.nav-label { hyphens:manual; overflow-wrap:break-word }` — they wrap to a clean
hyphenated second line ("Doku-/mente", "Einstel-/lungen"); invisible when the word fits and in the
button `title=` tooltip. (`break-word` stays only as a last-resort net.) (3) **Engine banner no longer cries "demo mode" when chat works.**
The "Install the AI engine" warning gated on `EngineStatus.installed` (every fetchable family
present). A drive with the chat engine (`llama_cpp`) but no voice engine (`whisper_cpp`, empty
`runtime/whisper.cpp/win/` — the real cause on D:) showed the alarming demo-mode banner even though
chat answers for real. `ModelsScreen` now reads `missingFamilies`: strong **warning** only when
`llama_cpp` is missing; chat-present + voice-missing shows a quiet **info** note
(`models.voiceEngine.*`, "Add voice dictation (optional)"). **Files:** `renderer/screens/ChatScreen.tsx`,
`renderer/screens/ModelsScreen.tsx`, `renderer/styles.css`, `shared/i18n/{en,de}.ts`,
`tests/renderer/{ChatRestructure,GermanSmoke}.test.tsx`. **Docs:** `packaging.md` (banner-per-concern
bullet). **Tests:** typecheck clean, build OK, `npm test` **1142 passed / 25 skipped** (unchanged;
two assertions repointed to the new chat-example keys). No version bump._

_(prior) **Chat stream survives screen navigation.** A reply that was still
streaming when the user left the Chat screen and came back looked **idle** (the screen unmounts,
destroying its `streaming` state + token listeners), yet a new message was rejected with "a response
is already being generated" (the main-process generation, registered in `inFlightStreams`, kept
running). Fix: `withChatStream` now mirrors the accumulated answer + reasoning into a shared
**`streamBuffers`** snapshot (`ipc/inflight.ts`, cleared in lockstep with the `AbortController`) —
both `sendToken` and a new `sendReasoning` handed to `runFn` write to it, so chat + RAG buffer
identically. New read-only **`getActiveStream(conversationId)`** IPC returns the live snapshot (or
null). On mount/conversation-change the Chat screen, when it does **not** own a live stream, polls
`getActiveStream` (`STREAM_RECOVER_POLL_MS = 300`, only while one is in flight) and drives the same
streaming UI — live bubble (`streamText`/`streamThinking`), locked composer, Stop — via a derived
**`busyStreaming = streaming || recovering`** that replaced the bare `streaming` in every "no new
turn while answering" gate. The missed token events are not replayed; the snapshot carries the full
text so the bubble resumes complete, and completion (snapshot → null) refreshes the transcript from
the DB. **Files:** `ipc/inflight.ts` (+`streamBuffers`/`StreamBuffer`), `ipc/chat-stream.ts`
(`withChatStream` buffers + `sendReasoning`), `ipc/registerChatIpc.ts` (`getActiveStream` handler,
reasoning via `sendReasoning`), `shared/ipc.ts` + `shared/types.ts` (`getActiveStream` +
`ActiveStreamSnapshot`), `preload/index.ts`, `renderer/lib/polling.ts`,
`renderer/screens/ChatScreen.tsx`. **No streaming-contract change** (token/done/error/reasoning
channels untouched; the recovery path is additive + poll-based). **Tests:** typecheck clean, build
OK, `npm test` **1142 passed / 25 skipped** — +2 in `chat-stream.test.ts` (buffers content +
reasoning then clears on done; clears on error). _(No version bump this change, per request.)_

_(prior) **Two first-start UX fixes (follow-ups to the progress bar).**
**(1) Progress bar jumped "1 of 1" ↔ "2 of 2" on the AI Model screen.** `listModels` runs as
**overlapping passes** (a dev-StrictMode remount, the download poll), each computing a different
`modelCount` as the hash cache warms, and the progress events broadcast to the renderer — so the
bar flipped between interleaved passes. `ModelVerifyProgress` gained a **`runId`** (`randomUUID` per
`buildModelList` pass); the gate + Models renderers **lock onto the first `runId`** they see and
ignore the others until that pass's `done`. **(2) Model could be started twice (a disruptive
restart).** `RuntimeManager.start()` serialized but `doStart` stop-and-restarts when a runtime is
already current; with no "starting" state the AI Model screen's Start button stayed enabled while a
large GGUF loaded (tens of seconds), so a **revisit re-clicked Start** → two "Start runtime" log
lines, two backend selections (exactly the user's log). `start()` is now **idempotent** for the
in-flight/running model (a *switch* to a different model still stops the old one first), tracks
`startingModelId` (set synchronously, cleared on settle), and surfaces it on
**`RuntimeStatus.startingModelId`**. The AI Model screen now reads runtime status (polling while a
start is in flight) and shows a disabled **"Starting…"** button that survives a remount (the
per-click `busy` flag does not); the Chat no-model state says "your model is starting" while it is
set. **Files:** `shared/types.ts` (`ModelVerifyProgress.runId`, `RuntimeStatus.startingModelId`),
`services/models.ts` (per-pass `runId`), `services/runtime/index.ts` (idempotent start +
`startingModelId` in `status()`), `renderer/screens/{WorkspaceGate,ModelsScreen,ChatScreen}.tsx`,
`shared/i18n/{en,de}.ts` (`models.starting`/`models.startingTitle`, `chat.noModel.starting`).
**Docs:** `architecture.md` "Models & runtime" (progress-bar bullet + new idempotent-start bullet).
**Tests:** typecheck clean, build OK, `npm test` **1140 passed / 25 skipped** — repurposed the
concurrent-start test as a model *switch*, added **2** runtime tests (same-model double-start is one
start, no restart; already-running start is a no-op). German copy still wants the D-L7 review._

_(prior) **First-run model-verification progress bar.** The first cold pass
over a fresh drive hashes the multi-GB GGUF weights (minutes of USB I/O) behind what was an opaque
spinner. `buildModelList` now accepts an optional `onProgress(p: ModelVerifyProgress)` sink: a cheap
pre-pass (`statSync` + cache lookup, **no hashing**) sums only the bytes that will actually hash
(cached/missing/placeholder-hash weights excluded) into `overallBytesTotal`; `sha256File` streams a
running byte count (throttled to one callback per **64 MB** + a final exact-total flush) which the
loop re-weights into the overall total plus a 1-based `modelIndex / modelCount` step label; a terminal
`done` event settles the bar to 100%. **`overallBytesTotal === 0` (all cached — the common 2nd run) ⇒
no events, no bar.** The `listModels` IPC forwards the sink to the calling renderer over the new
`EVENTS.modelVerifyProgress` channel via `event.sender` (guarded by `isDestroyed()`); preload exposes
`api.onModelVerifyProgress`. **Surfaces (Gate + Models, per the chosen scope):** the first-run
`WorkspaceGate` *finishing* step and the first cold **AI Model** screen visit render the existing
`Progress` component (byte-weighted %, "Checking model N of M: name") in place of the spinner — both
keep their fallbacks (the gate's Skip + never-trap `catch`; the screen's calm "Checking…" hint).
**Additive behind the locked `listModels` contract**; no sink ⇒ zero overhead (legacy callers/tests
unchanged). **Files:** `shared/types.ts` (+`ModelVerifyProgress`), `shared/ipc.ts`
(+`EVENTS.modelVerifyProgress`), `services/models.ts` (`sha256File`/`sha256FileCached`/
`verifyChecksum`/`computeInstallState`/`buildModelList` + the no-hash `pendingHashBytes` pre-pass),
`ipc/registerModelIpc.ts` (forward via `event.sender`), `preload/index.ts`
(`onModelVerifyProgress`), `renderer/screens/{WorkspaceGate,ModelsScreen}.tsx`, `shared/i18n/{en,de}.ts`
(`gate.finishing.progress`, `models.checkingProgress`). **Docs:** `architecture.md` "Models & runtime"
→ new "Model verification progress (first-run bar)" bullet. **Tests:** typecheck clean, build OK,
`npm test` **1138 passed / 25 skipped** — +4 in `models.test.ts` (final-flush event; byte-weighted
monotonic progress + terminal `done`; no-events-when-cached; missing/placeholder excluded from the
denominator) and +1 renderer (`WorkspaceGate` drives the determinate bar then unsubscribes). **Open:**
the new strings still want the D-L7 German review; the Models-screen bar covers only the initial
loading state (a post-download cold re-hash isn't in that state — out of scope this pass)._

_(prior) **Onboarding follow-ups: whisper auto-install, embeddings card,
policy cleanup, responsive screens (0.1.14 cont.).** (1) **Engine installer generalized to all
families.** [`runtime-download.ts`](apps/desktop/src/main/services/runtime-download.ts) now drives
an `ENGINE_FAMILIES` list — `llama_cpp` (chat, `llama-server`) **and `whisper_cpp` (voice,
`whisper-cli`)`; one install fetches every missing family for the host (a family with no host build,
e.g. whisper on mac/linux, is skipped). `EngineStatus` gained `missingFamilies`; the banner copy
covers chat + voice. Doc: [`packaging.md`](docs/packaging.md) "In-app engine install" — how to add a
future family. (2) **Embeddings model card bug.** The document-search (embeddings) card showed
Select/Start (Start threw — only chat models are activatable) and an inconsistent "Active" badge.
Embeddings is now treated as **automatic** (like reranker/transcriber): no Select/Start, no Active
badge — "Used automatically once installed." Safe because retrieval uses `embedder.id` directly
([`registerDocsIpc.ts`](apps/desktop/src/main/ipc/registerDocsIpc.ts) already passes it), not the
`activeEmbeddingModelId` setting. (3) **policy.json cleanup.** `allow_telemetry` removed from the
generated file ([`drive.ts`](apps/desktop/src/main/services/drive.ts) `buildPolicyJson` +
prepare-drive `.ps1`/`.sh`) — the app has no telemetry and `buildPolicyStatus` hardcodes
`telemetryAllowed:false`; the runtime parser still tolerates the field. **`encryption_required` was
KEPT** — it is a deliberate, audited security control: `assertCommercialDrive` reads it from the
file using the DEFAULT (non-STRICT) base **on purpose** (M-4), so a sold drive must *explicitly*
declare encryption-required and cannot pass via the fallback. (Flagged to the user.) (4)
**Responsive screens.** Only Chat adapted below ~1150px (its JS list-collapse); added
[`styles.css`](apps/desktop/src/renderer/styles.css) `@media (max-width: 760px / 520px)` so Home /
AI Model / Documents / Settings / Diagnostics also reflow — slim nav rail, tighter gutters, stacked
`.kv` grids, wrapping card heads, scrollable segmented switchers. **Tests:** typecheck clean, build
OK, `npm test` **1133 passed / 25 skipped** (+2 engine family tests)._

_(prior) 2026-06-13 — **Onboarding fixes: network-on-by-default, in-app engine
installer, voice discoverability.** Three issues found testing the first-run flow.
**(1) Downloads possible by default:** `DEFAULT_SETTINGS.allowNetwork` flipped `false → true`
([`shared/types.ts`](apps/desktop/src/shared/types.ts)) so a fresh install can fetch models
out of the box. The **policy ceiling is still authoritative** — a commercial `policy.json`
with `allow_model_downloads: false` (or the packaged-build `STRICT_POLICY` fallback) keeps the
app offline regardless; telemetry stays hardcoded off. Updated `smoke.test.ts` +
`db-settings.test.ts` (the old "offline-first default" asserts) + the `policy.ts`/`types.ts`
"default off" comments; `download-ipc.test.ts` `makeCtx` now sets the setting explicitly so the
setting-off gate is still exercised. **(2) In-app engine installer (the real fix for "I
downloaded a model but it said mock mode"):** the model downloader fetches WEIGHTS only — without
the `llama-server` engine binary a started model falls back to the demo runtime
([`runtime/factory.ts`](apps/desktop/src/main/services/runtime/factory.ts) — "no llama-server
binary on the drive"). New [`services/runtime-download.ts`](apps/desktop/src/main/services/runtime-download.ts)
`EngineDownloadManager` fetches + SHA-256-verifies + extracts the host's prebuilt build from
`runtime-sources.yaml` into `runtime/llama.cpp/<os>/` (download → verify → clean → extract →
flatten → install marker — mirrors the canonical fetch-runtime scripts), with the network
(`fetchImpl`) and extraction (`extractImpl`, default `tar -xf`) behind injected seams (suite stays
zero-network/zero-shell). Same gates as model downloads (policy ∧ `allowNetwork`), re-checked in
main. New `engine:status`/`download`/`getJob`/`cancel` IPC + preload + a **Models-screen
"Install the AI engine" banner** (warning tone, progress/cancel, demo-mode explanation) shown when
the engine is missing but a host build exists. New shared types `EngineDownloadJob`/`EngineStatus`;
12 tests in `engine-download.test.ts`. **(3) Voice mic discoverability:** the dictation mic was NOT
removed by the chat-UI polish pass (the Composer block is byte-identical) — it is availability-gated
on `ctx.transcriber != null` (whisper engine + model present). Per the "keep gated, improve
discoverability" decision the transcriber card copy now states it unlocks the 🎤 voice button
(EN+DE `models.hint.transcriber`). **Tests:** typecheck clean, build OK, `npm test` **1131 passed /
25 skipped** (+12). **Manual-smoke TODO:** the real network fetch + `tar` extraction of the b9585
build is only exercised by the injected seams in CI — verify end-to-end on a real drive (like the
GPU/PAID smokes)._

_(prior) 2026-06-13 — **Security-hardening wave (audit 2026-06-13 remediation).**
Fixed every MEDIUM + the quick-win LOW findings from the same-day multi-persona security
audit. (Per the doc lifecycle rule the audit report was condensed into this entry +
`security-model.md` and then deleted — the full report is recoverable from git history at
commit `f99bc86`, which added it.)
**M-1/M-2/M-3 (parser DoS):** new `services/ingestion/limits.ts` adds env-overridable
pre-parse caps — a **byte ceiling** (`HILBERTRAUM_MAX_DOC_BYTES`, 1 GiB), a **parse wall-clock
timeout** (`HILBERTRAUM_PARSE_TIMEOUT_MS`, 30 min; **audio exempt** so long transcriptions
aren't killed), a **PDF page cap** (`HILBERTRAUM_PDF_MAX_PAGES`, 5 000), and a **DOCX zip-bomb
guard** (`declaredZipInflatedSize` over the zip central directory; `HILBERTRAUM_DOCX_MAX_INFLATED_BYTES`,
1 GiB) — wired into `processDocument` + `pdf.ts`/`docx.ts`; rejection → friendly persist-canonical
`main.ingest.fileTooLarge`/`parseTimeout` (new i18n keys EN+DE + display map). **M-4/M-6 (policy
fail-open):** `policy.ts` gained `STRICT_POLICY` + an `{ isDev }` option on `loadPolicy`/`parsePolicy`/
`buildPolicyStatus`; a **packaged** build with a missing/malformed/partial `policy.json` now fails
**CLOSED** to the strict commercial posture (encryption required, plaintext off, models must verify,
network denied) — `isDev` threaded from `index.ts` + every model/download/core IPC call site. The
commercial sell gate keeps the DEFAULT base on purpose (no policy.json must FAIL the gate). This
neutralizes M-6 (unverified weight can't load on a packaged drive). **M-5 (arbitrary binary):**
`HILBERTRAUM_LLAMA_BIN`/`HILBERTRAUM_WHISPER_BIN` honoured **dev-only** (`resolveLlamaServerPath`/
`resolveWhisperCliPath` gained `{ isDev }`, default false=ignore+log; threaded through the
runtime/embedder/reranker/transcriber factories + benchmark probe). **LOW:** L-1 anchored the
loopback regex (`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`) + a "never gate enforcement" comment; L-2
rejects non-`https:` download URLs (`validateManifest` + the `downloadToFile` seam, new `isHttpsUrl`);
L-3 added `requireUnlocked()` + string-array filter to `importPreflight`; L-6 zeroes the KDF-derived
key before throwing `WrongPasswordError`. **Open hardening (deferred — see "Open hardening items"
below):** L-4 (opaque pick-token import redemption), L-5 (`lstatSync` symlink guard in `expandPaths`),
L-7 (build-script archive containment), L-8 (`npm ci` + committed lockfile in the build pipeline).
**Docs:** `security-model.md` (policy fail-closed §1, parser caps + env-override gating sections,
loopback note); the audit report itself was condensed here + deleted (recoverable at git `f99bc86`).
**Tests:** typecheck clean,
build OK, `npm test` **1119 passed / 25 skipped** (+24: ingestion-limits, policy fail-closed,
sidecar/transcriber override-gating, manifest/assets https, importPreflight gate, vault key-zero,
model-IPC fail-closed)._

_(prior) 2026-06-13 — **Encrypt the diagnostics log at rest.** `logs/app.log`
could carry file names/paths + model ids but sat in plaintext beside the encrypted DB; it is
now sealed under the **same vault key** as the DB/document cache. `services/logging.ts` became a
three-state machine: **`buffering`** (pre-unlock — lines held in a bounded in-memory buffer, no
disk writes; lost on a kill while still locked, the accepted trade), **`encrypted`** (after
`attachVaultKey(key)` from the unlock/create IPC — buffer + decrypted history sealed to
`app.log.enc`; rewritten on every `error`, on rotation `app.1.log.enc`, and on lock/quit via
`detachVaultKey()` before `lock()` zeroes the key; `info`/`warn` ride the next flush;
`readLogTail` reads the in-memory buffer), and **`plaintext`** (after `usesPlaintextLog()` for a
`plaintext_dev` workspace — plain `app.log`, matching the unencrypted dev DB). The vault key
reaches logging via new `WorkspaceController.encryptionKey()` (same data key as `documentCipher()`).
**Password change** calls `rekeyVaultLog(newKey)` *after* a successful change — it re-seals the same
in-memory buffer under the now-current key (v1→v2 rotates the data key; v2 keeps it) **without**
re-loading from disk, which would discard history under a rotated key or **double** it under an
unchanged one. (The earlier detach-before/re-attach-after dance had exactly that doubling bug on the
common v2 path — fixed in the code-review pass.) **Hardening from the review:** buffer caps + the
rotation threshold are measured by **UTF-8 byte length** (not char count, so multibyte paths can't
blow past them); `loadEncrypted` trims on a **line boundary**; `app.1.log.enc` is written
**atomically** like the live `.enc`. Durability/rotation windows (info/warn lost on a hard kill;
`app.1.log.enc` recovery-only; stuck-at-gate session discarded) are now documented in code + docs.
**Migration:** `attachVaultKey` shreds any stale plaintext `app.log`/`app.1.log` an older build
left on an encrypted drive. **Files:** `services/logging.ts` (rewrite), `services/workspace-vault.ts`
(+`encryptionKey()`), `ipc/registerWorkspaceIpc.ts` (attach/detach/rekey in unlock/create/lock/change),
`main/index.ts` (plaintext switch at startup; flush before lock on quit + uncaughtException).
**Docs:** `security-model.md` ("Logs are local-only AND encrypted at rest" + design record),
`PRIVACY.md`, `known-limitations.md`, `drive-layout.md`. **Tests:** typecheck clean, build OK,
`npm test` **1095 passed / 25 skipped** (full suite green). logging.test.ts covers **14
tests** across the 3 modes + encrypted rotation + the migration shred + cross-session re-unlock +
the rekey no-double / v1 key-rotation + byte-boundary trim (+9 over the prior 5). _(Reminder: run the suite via `npm test` or from `apps/desktop` — a bare
`npx vitest` from the repo root finds no config, drops the `@shared`/`@renderer` aliases + jest-dom
setup, and falsely fails every renderer suite. See the run-vitest memory.)_

_(prior) **Chat-UI polish pass (branch `chat-ui-polish`).** A
focused, renderer-only calm/premium pass on the Chat screen + conversation history
(design-guidelines §3/§7). **What changed:** ① app nav → a compact ~80px **icon+label
rail** (`.app-shell` grid `80px 1fr`), active = soft neutral fill (accent reserved for the
focus ring); the **duplicate lower-left "Local · Offline" badge was removed** (the chat
header keeps the one ambient signal) and the lock became a quiet rail button. ② **history
rows** restyled: soft selected *fill* (the blue selection outline that read as keyboard
focus is gone), structured row (title + a quiet "📄 Documents" meta line replacing the loud
filled `DOC` badge), ≥40px tall; search mode gained a **"Results for '…'" header** +
2-line snippets + calmer empty copy ("I didn't find a match. Try rephrasing."). ③
**messages softened**: user turns → neutral tinted surface (no strong blue border),
assistant turns borderless (read as text, not nested cards), uppercase role chips → quiet
**You** / **HilbertRaum** labels; source cards lightened. ④ **composer** is now one bordered
shell with the Send/Ask button inside it (shell takes the focus ring). ⑤ **truthful
doc-scope copy**: "Using all 0 documents" is gone — zero docs → "📄 No documents yet · Add
documents" (jumps to Documents), some → "Using N documents", all → "Using all documents"
(no count). ⑥ **responsive**: history **auto-collapses ≤1150px** (`LIST_AUTO_COLLAPSE_PX`,
a `matchMedia` listener in ChatScreen OR-ed with the persisted preference; a session "peek"
override re-opens it while narrow), gutters tighten at ≤1280/≤1150px. **History was already
collapsible — refined, not reimplemented.** **Files:** `renderer/App.tsx`,
`renderer/styles.css`, `renderer/chat/{ConversationList,Composer,ScopePopover}.tsx`,
`renderer/screens/ChatScreen.tsx`, `shared/i18n/{en,de}.ts` (new keys `nav.aria`,
`chat.list.title/aria/docMeta`, `chat.search.resultsFor`; changed `chat.role.*`,
`chat.scope.*`, `chat.search.noMatches`; removed `chat.list.docBadge`/`chat.scope.usingAll.*`
plurals). **No backend / data-contract / IPC changes.** **Tests:** typecheck clean, build OK,
vitest **1085 passed / 25 skipped** (updated `InformationArchitecture` — the ambient
indicator is now header-only — and the scope/no-match copy assertions; +1 test). Eyeball
walk + before/after screenshots: `docs/design-review/chat-screenshots-after/` (BEFORE set:
`docs/design-review/chat-screenshots/`). Design record folded into `docs/design-guidelines.md`
§12. **Open:** German copy for the new strings still wants the D-L7 human review._

_(prior) **Rebrand: "Private AI Drive Lite" / "PAID" → "HilbertRaum".**
Repo-wide rename across code, design, and docs. User-facing brand "Private AI Drive Lite"
(and the bare "Private AI Drive") → **HilbertRaum** everywhere (window title, renderer brand,
i18n EN/DE copy, system prompt, READ ME FIRST, all docs + the spec, now
`CLAUDE_HilbertRaum_MVP.md`). The **`PAID` acronym was also retired from code identifiers**
(decision: full-depth rename, no in-field drives to preserve): env-var prefix `PAID_*` →
`HILBERTRAUM_*` (incl. every `PAID_*_SMOKE` manual harness + `HILBERTRAUM_DRIVE_ROOT` /
`HILBERTRAUM_MANIFESTS_DIR` / `HILBERTRAUM_LLAMA_BIN` / `HILBERTRAUM_WHISPER_BIN`); on-disk
working DB `paid.sqlite` → `hilbertraum.sqlite` (+ `.enc`/`-wal`/`-shm`); runtime install
marker `.paid-runtime.json` → `.hilbertraum-runtime.json`; **encryption format magic
`PAIDENC1` → `HRAUMEN1`** (8 bytes, encode/decode in `security/crypto.ts`); vault verifier
plaintext `paid-vault-verifier-v1` → `hilbertraum-vault-verifier-v1`; localStorage keys
`paid.uiLanguage` / `paid.chat.listCollapsed` → `hilbertraum.*`. Package names →
`hilbertraum` / `@hilbertraum/desktop`; electron-builder `appId` →
`space.hilbertraum.app`, `productName`/artifact → `HilbertRaum`; launcher files renamed
(`Start HilbertRaum.cmd`/`.command`, `start-hilbertraum.sh`). **These on-disk changes are
NOT backward-compatible** — an existing pre-rebrand vault/drive would not be recognized;
acceptable per the user decision (MVP not yet shipped). Typecheck clean, build OK, tests
green (1084 passed / 25 skipped — unchanged baseline)._

_(prior) UX polish: live dictation waveform in the chat composer —
`renderer/chat/Waveform.tsx`; record: wave-3 plan §10 + `architecture.md` "Voice dictation"._

_**Phase 42 (German QA + closeout) is DONE ⇒ the i18n wave
(Phases 39–42) is COMPLETE.** The working paper `docs/i18n-plan.md` was condensed into
the design record per the doc lifecycle rule — `docs/architecture.md`
"Internationalization — design record" (D-L1–L8; code comments cite "i18n record §N") +
`docs/design-guidelines.md` §7 "German microcopy"; full original:
`git show 5059ed8:docs/i18n-plan.md`. **One open item: the user's human review of the
German copy (D-L7 sign-off) — the Phase-42 change list was handed over for review.**_

**Where the project stands:** the MVP (Phases 0–13) is feature-complete and four post-MVP
audit rounds are fully remediated (§8). Every shipped wave since is DONE and condensed into a
design record per the CLAUDE.md doc lifecycle rule:

- **GPU acceleration (Phases 14–16)** + a same-day audit round —
  `docs/architecture.md` "GPU acceleration — design record" (§1–§8) + the as-built
  probe/ladder subsection.
- **Functionality wave 1 toward the Office edition (Phases 17–20):** RAG trust & scoped
  asking · in-app model downloader · audit log · answer-depth modes — record folded into
  the topic docs: `docs/rag-design.md` §10 (17) · `docs/architecture.md` "In-app model
  downloader" (18), "Audit log" (19), "Chat & streaming" (20).
- **Phase 21 retrieval quality** (hybrid FTS5 + RRF, optional reranker) —
  `docs/rag-design.md` §11 (as built) + §12 (design record, D8–D15); both manual
  measurements done (rerank smoke; `ragMinSimilarity` confirmed 0).
- **UI polish wave (Phases 23–27)** — [`docs/design-guidelines.md`](docs/design-guidelines.md)
  (ADOPTED; its §11 is the rollout record incl. decisions D-UI1–4).
- **Model catalog wave 1 + benchmark (Phases 28–29)** —
  [`docs/model-benchmarks.md`](docs/model-benchmarks.md) (protocol + first-run results +
  the §7 design record, D16–D22) + `docs/model-policy.md` (catalog + quality-aware
  recommendation + the disqualified-candidates list).
- **Functionality wave 3 (Phases 31–38):** conversation search · vault password change ·
  document tasks + summary · translation · compare · audio transcription · dictation · OCR —
  [`docs/functionality-wave-3-plan.md`](docs/functionality-wave-3-plan.md) (D23–D37; research
  gates R-S1/R-T1–2/R-W1–4/R-O1–3 with their banked findings in its §14).
- **i18n wave (Phases 39–42):** English + German UI (`uiLanguage` setting + picker,
  pre-unlock gate language, full renderer sweep, the two-rule main-process boundary,
  German QA) — `docs/architecture.md` "Internationalization — design record" (D-L1–L8)
  + `docs/design-guidelines.md` §7 "German microcopy".

**Open:** Phase 22 (signed offline update bundles) is 🔴 blocked on a key-management design;
Phase 30 (opt-in big slot + embeddings) has a drafted working paper
([`docs/big-slot-embeddings-plan.md`](docs/big-slot-embeddings-plan.md)); the i18n wave's
German copy awaits the **user's human review pass (D-L7)** — the Phase-42 change list +
screenshots were handed over. Release-wise the
remaining work is **manual acceptance only** (§5). Consciously-accepted gaps live in
[`docs/known-limitations.md`](docs/known-limitations.md).

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
| 30 | Opt-in big slot + embeddings (D21 → D38–D43) | ⚪ not started — plan drafted (`docs/big-slot-embeddings-plan.md`) |
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
Repo root: `f:\_coding\ai_drive`.

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
  [`docs/functionality-wave-3-plan.md`](docs/functionality-wave-3-plan.md) (per-phase
  records §4–§11, decisions D23–D37 resolved in §13, research-gate findings banked in §14):**
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
  a measurable floor) — rider recorded in `big-slot-embeddings-plan.md` �4.4; full
  rationale in `rag-design.md` �10 (D1).

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

> Source of truth for cross-module/cross-phase types. Keep in sync with `apps/desktop/src/shared/`.
> Phases append/refine here so later phases know the exact shapes.

### IPC command surface (spec §9.1) — target
```ts
getAppStatus(): Promise<AppStatus>
getDriveStatus(): Promise<DriveStatus>
runBenchmark(): Promise<BenchmarkResult>
listModels(): Promise<ModelInfo[]>
selectModel(modelId: string): Promise<{ activeModelId; activeEmbeddingModelId }>
startRuntime(modelId: string): Promise<RuntimeStatus>
stopRuntime(): Promise<void>
createConversation(): Promise<Conversation>
sendChatMessage(conversationId, message, options): stream → events
askDocuments(conversationId, question): stream → events
importDocuments(paths: string[]): Promise<ImportJob>
getImportJob(jobId: string): Promise<ImportJobStatus>
listDocuments(): Promise<DocumentInfo[]>
deleteDocument(documentId: string): Promise<void>
getSettings(): Promise<AppSettings>
updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
```
_Status: TypeScript types in `apps/desktop/src/shared/types.ts`; channel names in `src/shared/ipc.ts`.
Wired so far: core (Phase 1) + `listModels`/`selectModel`/`startRuntime`/`stopRuntime` (Phase 2) +
`createConversation`/`listConversations`/`listMessages`/`sendChatMessage`/`stopGeneration` (Phase 3) +
`pickDocuments`/`importDocuments`/`getImportJob`/`listDocuments`/`deleteDocument`/`reindexDocument`
(Phase 4) + `askDocuments` (Phase 6) + `runBenchmark` (Phase 7) + `getPolicy` (Phase 8) +
`getWorkspaceState`/`unlockWorkspace`/`createWorkspace`/`lockWorkspace` (Phase 9) +
`runPreflight` (Phase 13) + `getRuntimeStatus`/`exportConversation`/`getLogTail` (audit round 4 —
spec §7.6 export + §7.11 Diagnostics) + `getRuntimeInstall` (`runtime:install`, Phase 16) +
`tryGpuAgain` (`gpu:try-again`, GPU audit round) + the `runtime:notice` main→renderer event
channel (Phase 15, `EVENTS.runtimeNotice`, preload `onRuntimeNotice`) +
`deleteConversation` (`chat:deleteConversation`), `verifyModel` (`models:verify`) and
`previewDocument` (`docs:preview`) from the post-MVP UX polish rounds +
`updateConversationScope` (`chat:updateScope`, Phase 17 — replace/clear a documents
conversation's "ask selected documents" scope) +
`downloadModel`/`getDownloadJob`/`cancelDownload` (`downloads:start/get/cancel`, Phase 18 —
the in-app model downloader, async-with-polling) +
`getAuditEvents(limit?, beforeId?)`/`exportAuditLog` (`audit:list`/`audit:export`, Phase 19 —
the Diagnostics Activity panel, newest-first paging + save-dialog export) +
`searchConversations` (`chat:search`, Phase 31) + `changeWorkspacePassword`
(`workspace:changePassword`, Phase 32) +
`startDocTask`/`getDocTask`/`cancelDocTask` (`doctasks:start/get/cancel`, Phases 33–35 —
document tasks, async-with-polling; `cancelDocTask()` with no jobId cancels the active task;
shapes `StartDocTaskRequest`/`DocTaskStatus`/`DocumentSummary` in `shared/types.ts`, and
`DocumentInfo` gained an optional `summary` from the additive `documents.summary_json` column;
Phase 34: `kind: 'translation'` takes `params.targetLang: TranslationTargetLang ('de'|'en')`,
`resultRef.documentId` = the NEW materialized document, and `DocumentInfo` gained an optional
`origin: DocumentOrigin` from the additive `documents.origin_json` column;
Phase 35: `kind: 'compare'` takes exactly TWO distinct `documentIds` and `DocumentOrigin` is
now a discriminated union — `{ type: 'translation', translatedFrom, targetLang }` |
`{ type: 'compare', comparedFrom: [a, b] }`; Phase-34 rows persisted without `type` parse as
`'translation'`, an additive migration) +
`exportDocument` (`docs:export`, Phase 34 — save-dialog export of a text document's stored
content, the `exportConversation` pattern; resolves with the path or null on cancel) +
`importPreflight` (`docs:importPreflight`, Phase 36 — read-only selection summary driving the
large-audio import confirm; `DocumentInfo` gained optional `transcriptionProgress`) +
`transcribeDictation(audio: Uint8Array): Promise<string>` (`dictation:transcribe`, Phase 37 —
voice dictation: 16 kHz mono WAV bytes in, plain text out; request/response, nothing persisted,
no audit; `AppStatus` gained the additive `dictationAvailable: boolean` gate).
Phase 38: `kind: 'ocr'` on the same doc-task channels (one PDF; the target must be
scan-detected or already OCR'd; needs the OCR engine, not the chat runtime);
`DocumentInfo` gained the DERIVED `scanDetected` flag + optional `ocr: DocumentOcrInfo`
(metadata of the additive `documents.ocr_json` column — the recognized text itself is
content and never leaves the DB); `AppStatus` gained the additive
`ocrAvailable: boolean` gate. The internal `OCR_RASTER` channels (shared/ipc.ts) bind
ONLY the hidden rasterizer window's preload, never the app bridge.
(`pickDocuments` + `reindexDocument` are Phase-4 additions to the `IPC` registry beyond the spec
§9.1 list — picker + re-index UX; `getPolicy` is a Phase-8 addition; the four `workspace:*` channels
are Phase-9 additions.) `createConversation` now also accepts an optional `mode`
('chat' | 'documents') and an optional `scopeDocumentIds` (Phase 17); `Conversation` carries
`scopeDocumentIds: string[] | null` (additive `conversations.scope_json` column, guarded
ALTER-TABLE migration in `db.ts`)._

### DB schema
✅ Implemented in `src/main/services/db.ts` — all spec §8 tables created idempotently (WAL mode,
foreign keys on). `Db` type = `InstanceType<typeof DatabaseSync>`. Loaded via `createRequire`
(see Decision log). Helpers: `openDatabase(path)`, `listTables(db)`.

### Settings storage
✅ `src/main/services/settings.ts` — key/value rows; `getSettings` merges over `DEFAULT_SETTINGS`;
`updateSettings(patch)` upserts; `seedSettings` seeds on first run. Default `allowNetwork:false`,
`workspaceMode:'plaintext_dev'`, `contextTokens:4096`. **Phase 7 added `lastBenchmark`**
(JSON `BenchmarkResult | null`, default `null`) — the persisted hardware profile lives here.
**The post-MVP UX round added `autoStartActiveModel`** (boolean, default `true`) **and
`checksumCache`** (`Record<path, {size, mtimeMs, sha256}>`, default `{}` — the persisted L2 of
the weight-file hash cache).
⚠️ **Settings live INSIDE the (possibly encrypted) DB** — unreadable before unlock (Phase 9). The
unencrypted `config/workspace.json` vault descriptor is the only pre-unlock artifact;
`workspaceMode` is set to the active mode by the `WorkspaceController` on open.

### Workspace/paths
✅ `src/main/services/workspace.ts` — `resolvePaths({envRoot,fallbackRoot})` → `ResolvedPaths`
(rootPath, workspacePath, modelsPath, logsPath, configPath, dbPath, isPreparedDrive).
`ensureWorkspaceDirs`, `buildDriveStatus` (adds platform/arch/free/writable). See `docs/drive-layout.md`.

### Core IPC (Phase 1 live)
✅ `getAppStatus`, `getDriveStatus`, `getSettings`, `updateSettings` registered in
`src/main/ipc/registerCoreIpc.ts`, invoked from `initBackend()` in `main/index.ts`.

### Models + runtime (Phase 2 live)
✅ **Manifest** schema/validator in `src/shared/manifest.ts` (`ModelManifest`, `validateManifest`,
`isRealSha256`). YAML files under `model-manifests/` (originally chat: Qwen3 4B/8B/14B Q4 + 30B-A3B
MoE + embeddings: E5 small F16 — five; 1.7B dropped, see §9). **The live catalog is now 11 manifests**
(8 chat + E5 + bge-reranker + whisper transcriber, in `model-manifests/{chat,embeddings,reranker,
transcriber}/`) — `model-policy.md` is the authoritative list.
✅ **`services/models.ts`** — `resolveManifestsDir`, `discoverManifests`, `sha256File`,
`verifyChecksum`, `computeInstallState`, `recommendModelId`, `buildModelList`, `selectModel`.
States: `unsupported→missing→checksum_failed→installed` (+`running` overlay). `ModelInfo` shape per
`shared/types.ts`. `local_path` resolved against the **drive root**.
✅ **`services/runtime/`** — `ModelRuntime` interface + `RuntimeManager` (single active runtime,
restart on switch) + `MockRuntime` (health ok; `chatStream` stubbed until Phase 3). Factory swap →
`LlamaRuntime` in Phase 10. `RuntimeStatus` shape per `shared/types.ts`.
✅ **IPC** `src/main/ipc/registerModelIpc.ts` — `listModels`, `selectModel`, `startRuntime`,
`stopRuntime`; wired in `initBackend()`. `ctx` now carries `runtime` + `manifestsDir`. Runtime stopped
on `will-quit`. Preload exposes all four. **Models screen** renders states/license/recommend/verify/
select/start-stop. Hardware profile now comes from the **persisted Phase-7 benchmark**
(`lastBenchmark?.profile ?? 'UNKNOWN'`); the old `LITE` stub is gone.

### Chat + streaming (Phase 3 live)
✅ **`services/chat.ts`** (spec §7.6) — `createConversation`, `listConversations`,
`getConversation`, `listMessages`, `appendMessage`, `deleteLastAssistantMessage`,
`maybeSetTitleFromFirstMessage`, `buildSystemPrompt` (verbatim spec §7.6 base prompt, exported as
`BASE_SYSTEM_PROMPT`), `buildChatMessages`, and the streaming orchestrator
`generateAssistantMessage(db, runtime, conversationId, { signal, onToken })`. UUID v4 ids,
ISO-8601 UTC timestamps. **Message order = `created_at ASC, rowid ASC`** (rowid breaks
equal-ms ties → stable turn order). **System prompt is built per request, NOT persisted**; the
`messages` table holds only user/assistant turns. `Conversation`/`Message` shapes per
`shared/types.ts`. `messages.citations_json` stays null until Phase 6.
✅ **Title:** new conversations are `"New chat"`; first user message sets the title (≤60 chars),
later messages don't overwrite it. Conversations list newest-updated first.
(Phase 42: the default is persist-canonical English — `t('en', 'main.chat.defaultTitle')`,
value unchanged — and display-mapped to the UI language at render, D-L4.)

### Streaming contract (LOCKED — Phase 3; one ADDITIVE channel in Phase 20)
Main → renderer over per-conversation IPC event channels keyed by the **conversation id**
(one active stream per conversation): `chat:token:<id>` (one token/event) / `chat:done:<id>`
(final assistant `Message`) / `chat:error:<id>` (error string). Helpers in `src/shared/ipc.ts`
`STREAM`. Preload exposes `onToken/onDone/onError(requestId, cb) → unsubscribe`. In addition,
`sendChatMessage(conversationId, content, options?)` resolves with the final assistant `Message`,
so callers can simply `await` it; the event channels drive incremental UI.
**Phase 20 (additive):** `chat:reasoning:<id>` (preload `onReasoning`) carries Deep-mode
thinking deltas; token events still carry ONLY answer text. Reasoning is never persisted and
never replayed (D6) — see "Answer-depth modes" below.
**Cancellation:** `ipc/registerChatIpc.ts` keeps a per-conversation `AbortController` map;
`stopGeneration(conversationId)` aborts it → `chatStream` stops on `options.signal`, the partial
reply is persisted, a normal `done` fires.
**Regenerate:** `sendChatMessage` with `options.regenerate = true` deletes the last assistant
message and re-streams from existing history (no new user turn).
**Decision (documented):** `sendChatMessage` does **not** auto-start a runtime — a chat needs a
model explicitly started on the Models screen. No active runtime → handler throws; Chat screen
shows a "start a model" empty state linking to Models. (Heavy llama.cpp start in Phase 10 stays an
explicit user action; keeps the boundary clean.)
✅ **`MockRuntime.chatStream`** now emits a deterministic reply token-by-token (12 ms/token) that
echoes the last user message, honouring `options.signal` for prompt cancellation. **Chat screen**
(`renderer/screens/ChatScreen.tsx`): conversation list, streamed transcript with a live cursor,
stop, regenerate, per-message copy, and the no-runtime empty state.

### Answer-depth modes (Phase 20 live)
✅ `ChatOptions.mode` (`'fast' | 'balanced' | 'deep'` = `ChatDepthMode`) is **read** now:
per message over IPC (enum-guarded in `registerChatIpc`), sticky per conversation in the
renderer for the session (NOT persisted — no schema change). Threads
`generateAssistantMessage` → `RuntimeChatOptions.mode`; the single mapping site is
`runtime/llama.ts` `requestParamsForMode` (D4): fast = thinking off + temp 0.7 + 1024-token
cap · balanced/omitted = thinking off, server defaults · deep = thinking on + temp 0.6.
Explicit `maxTokens`/`temperature` win over mode-derived values.
✅ **Thinking switch (D5):** per-request `chat_template_kwargs: { enable_thinking }` on
`/v1/chat/completions`, ALWAYS sent explicitly (the b9585 default is thinking ON for capable
templates). Chat sidecars spawn with **`CHAT_SERVER_ARGS` = `--jinja --reasoning-format
deepseek`** (pins the mechanism's preconditions; embedder excluded). Reasoning streams as
separate `delta.reasoning_content` frames → `RuntimeChatOptions.onReasoning(delta)` →
`chat:reasoning:<id>`; the generator yields answer text only.
✅ **D6:** `stripThinkBlocks` (services/chat.ts) scrubs `<think>…</think>` (incl. an unclosed
trailing block) from persisted assistant content (chat + grounded) and from assistant turns
replayed as history. The collapsed live "Thinking…" block in the streaming bubble is the only
reasoning surface, and it disappears once the persisted reply lands.
✅ **Deep gating:** manifest `supports_thinking_mode` → `ModelManifest.supportsThinkingMode`
(optional boolean, default false) → `RuntimeStatus.supportsThinkingMode` (enriched by the
`getRuntimeStatus` handler for the running model only) → the composer offers Deep only when
true (stale Deep choices coerce to Balanced at send). `askDocuments` never passes a mode —
document answers always run balanced (deep-grounded = wave 2).

### Document ingestion (Phase 4 live)
✅ **`services/ingestion/`** (spec §7.7). Full detail in [`docs/rag-design.md`](docs/rag-design.md).
- **`parsers/`** — `DocumentParser` interface (`{ segments: ExtractedSegment[], mimeType }`) +
  registry (`selectParser`, `supportedExtensions`). Adapters: `TxtParser` (.txt/.text/.log),
  `MarkdownParser` (.md/.markdown/.mdown; segment per ATX heading, `sectionLabel`), `PdfParser`
  (.pdf; pdfjs-dist **legacy** build, no worker; segment per page, `pageNumber`), `DocxParser`
  (.docx; mammoth raw text; segment per paragraph), `CsvParser` (.csv/.tsv; papaparse; rows →
  `header: value` lines). Pure-JS, **lazy-imported** inside `parse()`.
  **Phase 36 additions:** `AudioParser` (.wav/.mp3/.flac/.ogg — the R-W2-verified list; packs
  whisper segments into ≤400-word `ExtractedSegment`s labeled `sectionLabel: "mm:ss–mm:ss"`),
  and `parse(filePath, ctx?)` gained an ADDITIVE optional `ParseContext`
  (`{ transcriber?, onProgress?, workDir? }`) — text parsers ignore it. `IngestionDeps` gained
  optional `transcriber` + `onTranscribeProgress(documentId, percent)` (the embedder-injection
  precedent); `isAudioPath()` + `summarizeImportPaths()` exported for the IPC layer.
- **`chunker.ts`** — `chunkSegments(segments, opts?)` → `DocumentChunk[]`. `CHUNK_DEFAULTS =
  { chunkSizeTokens: 500, chunkOverlapTokens: 80, maxChunks: 1000 }`. **Token counting is an
  approximation** (1 whitespace word ≈ 1 token; `tokenize`/`approxTokenCount`). Windows step by
  `size − overlap`, overlap clamped `< size`, no chunk crosses a segment boundary (so each chunk
  has exactly one `pageNumber`/`sectionLabel`), global cap at `maxChunks`.
- **`index.ts`** — lifecycle + persistence. `createQueuedDocument`, `processDocument` (never
  throws: failures → `failed` + `error_message`), `reindexDocument`, `listDocuments`,
  `getDocument`, `deleteDocument`, `expandPaths`, `documentsDir`. Statuses
  `queued→extracting→chunking→embedding→indexed` (+`failed`/`deleted`); **`embedding` is a
  pass-through** until Phase 5 (no vectors written yet).
- **DB:** `documents` (status, `original_path`, `stored_path`, `sha256`, `mime_type`,
  `size_bytes`) + `chunks` (`chunk_index`, `text`, `source_label` = document title,
  `page_number`, `section_label`, `token_count`). `chunkCount` is computed per `listDocuments`.
- **Types:** `DocumentInfo`, `ImportJob`, `ImportJobStatus`, `IngestionStatus` (already in
  `shared/types.ts`) filled to match.

### Document storage + import model (LOCKED — Phase 4)
- **Stored copy.** Imports are **copied into `workspace/documents/<id><ext>`** (`stored_path`);
  `original_path` is also kept. Self-contained drive: re-index re-parses the stored copy; delete
  removes the stored copy + chunks + embeddings + row (never the original).
- **Async-with-polling.** `importDocuments(paths)` expands the selection, inserts `queued` rows,
  returns `{ jobId, documentIds }`, then ingests **sequentially in the background**. The
  `documents` table is the per-file source of truth (survives restart); the `ImportJobStatus`
  aggregate is **in-memory** in `registerDocsIpc.ts`, read via `getImportJob(jobId)` (unknown job
  → `done:true` so pollers stop). The **Documents screen** polls `getImportJob` + `listDocuments`
  every 400 ms while a job runs. No streaming channel is used (ingestion progress is coarse).
- **Picker.** `pickDocuments('files' | 'folder')` opens the OS dialog in **main**
  (renderer has no dialog access); Windows can't mix file+dir selection, hence the mode.
- **Documents screen** (`renderer/screens/DocumentsScreen.tsx`): import files/folder, per-file
  status badge + chunk count + size, error surfacing, delete + re-index.

### Embeddings + vector search (Phase 5 live)
✅ **`services/embeddings/`** (spec §6, §7.8, §9.2). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §6.
- **`index.ts`** — `Embedder` interface (`id`, `dimensions`, `embed(texts) =>
  Promise<Float32Array[]>` — L2-normalized, one per input); `encodeVector`/`decodeVector`
  (Float32 ↔ BLOB; decode copies to a 4-byte-aligned buffer); `cosineSimilarity`; and the
  `VectorIndex` class (`search(queryVector, topK)` linear-scan cosine → `{ chunkId, score }[]`
  sorted desc, dimension-mismatched rows skipped; `searchText(query, topK)` embeds then searches).
- **`mock.ts`** — `MockEmbedder` (`createMockEmbedder`): deterministic feature-hashing vectors
  (SHA-256 tokens → signed buckets → L2-normalize), zero network. `MOCK_EMBEDDING_DIMENSIONS =
  384`, `MOCK_EMBEDDING_MODEL_ID = 'mock-embedder'`.
- **Ingestion wiring:** `processDocument`/`reindexDocument` accept `IngestionDeps
  { embedder?, embeddingModelId? }`; the `embedding` step embeds all chunks in one batch and
  inserts `embeddings` rows. `registerDocsIpc` passes `ctx.embedder` +
  `getSettings(db).activeEmbeddingModelId`. **`AppContext` now carries `embedder`** (created in
  `main/index.ts`).
- **`embeddings` table** (spec §8, already existed): `chunk_id` PK, `embedding_model_id`,
  `vector_blob` (raw Float32 bytes), `dimensions`, `created_at`. No new IPC (askDocuments = Phase 6).

### RAG chat with citations (Phase 6 live)
✅ **`services/rag/index.ts`** (spec §7.6, §7.8). Full detail in [`docs/rag-design.md`](docs/rag-design.md) §8.
- **`retrieve(db, embedder, question, settings)`** → `{ chunks: RetrievedChunk[], citations:
  Citation[] }`. Embeds the question, `VectorIndex.searchText(topKInitial)`, joins hits →
  `chunks`, drops `< minSimilarity`, **dedups by `(document_id, page_number)`** (page-less
  chunks keyed by chunk id), trims to `topKFinal` under `maxContextTokens` (chunker's
  `approxTokenCount`; top chunk always kept), assigns `[S1]…` labels **per query (not
  stored)**.
- **`buildGroundedPrompt(question, chunks)`** — pure; spec §7.8 template verbatim (rules +
  `Question:` + numbered `Document excerpts:` as `[Sn] File: X | Page: 4` / `| Section: Y` +
  quoted text + trailing `Answer:`). `buildGroundedChatMessages` replaces the **last user
  turn** with the grounded prompt; system stays `BASE_SYSTEM_PROMPT`.
- **`generateGroundedAnswer(...)`** — streams via the runtime and persists the assistant turn
  **with `Citation[]`** (→ `citations_json`). **Empty corpus / weak retrieval → runtime NOT
  called**; persists `NO_DOCUMENT_CONTEXT_ANSWER`, no citations.
- **`ipc/registerRagIpc.ts`** — `askDocuments(conversationId, question)`; **reuses the locked
  Phase-3 streaming contract** (`chat:token/done/error:<id>`) + the **shared in-flight
  registry** (`ipc/inflight.ts`) so `stopGeneration` cancels it. Requires a running runtime
  (same error as chat). Registered in `initBackend()`.
- **Settings:** `ragTopKInitial`/`ragTopKFinal`/`ragMaxContextTokens`/`ragMinSimilarity` on
  `AppSettings` + `DEFAULT_SETTINGS` (spec §7.8 defaults), read via `ragSettingsFrom`.
- **`Citation`** gained optional `snippet` (truncated chunk text, ≤ 600). **Renderer**:
  `ChatScreen` Chat/Ask-Documents toggle (mode is per-conversation), `askDocuments` path, and
  a per-message **Sources** panel with expandable cited snippets.
- **Phase 21 (hybrid + rerank — see the §3 entry / `docs/rag-design.md` §11):** `retrieve()`
  gained a keyword pass (`rag/hybrid.ts` over the trigger-synced `chunks_fts` FTS5 table) fused
  by RRF (k=60), and an optional trailing `reranker?: Reranker | null` param (also on
  `GroundedAnswerOptions.reranker`) that reorders candidates between fusion and dedup. Absent
  reranker + no keyword hits ⇒ byte-identical to the Phase-6 pipeline. `RetrievedChunk.score`
  is stage-dependent (cosine / RRF / rerank logit); `minSimilarity` stays a PRE-rerank cosine
  floor; citations still persist NO scores. `Reranker` lives in `services/reranker/`
  (`AppContext.reranker`, availability-selected, null default). `Embedder`/`Reranker` gained
  optional **`suspend()`** — the workspace-lock teardown that allows a lazy restart (`stop()`
  stays permanent for will-quit).

### Hardware benchmark + recommendation (Phase 7 live)
✅ **`services/benchmark.ts`** (spec §7.3, §11). Full detail in [`docs/benchmark.md`](docs/benchmark.md).
- **`detectSystem()`** (`node:os`) → `{ os, arch, cpuModel, cpuCores, ramGb, gpu }`; never
  throws (failed probe → `''`/`0`); `detectSystem` itself always reports `gpu: null` — the
  REAL probe lives in `runtime/gpu.ts` and is **injected** by the IPC layer (Phase 16:
  `RunBenchmarkDeps.gpu: { name, useful }`), keeping this module `child_process`-free.
- **`classifyProfile(ramGb, { tokensPerSecond?, gpuUseful? })`** — pure; spec §11.3
  thresholds + the conservative Phase-16 GPU bump (`gpuUseful` is precomputed by
  `gpuUsefulForProfile`: ≥ 6144 MiB AND not integrated) + low-tok/sec downgrade; invalid
  RAM → `UNKNOWN`.
- **`measureDriveSpeed(workspacePath)`** → `{ readMbps, writeMbps, error? }`; 8 MB temp file
  written **inside the workspace**, timed write(`fsync`)+read, **always cleaned up**, failure
  → `null` + `error`.
- **`measureTokensPerSecond(runtime)`** → number | `null` (only when a runtime is active;
  prompt + ≤64 tokens). Mock now, real in Phase 10.
- **`buildWarnings(...)`** — spec §11.4 friendly copy (weak hardware / slow drive /
  un-measurable drive); slow drive warns, never blocks.
- **`runBenchmark(deps)`** → `BenchmarkResult` (the existing `shared/types.ts` shape):
  detection + drive + optional tokens/sec + `classifyProfile` + `recommendModelId` + warnings.
- **`ipc/registerBenchmarkIpc.ts`** — `runBenchmark()` (`benchmark:run`); runs it, persists to
  `settings.lastBenchmark`, returns the result. Registered in `initBackend()`; exposed on
  preload `api.runBenchmark` + `PreloadApi`.
- **Renderer:** `DiagnosticsScreen` Run-benchmark button → RAM / CPU / OS-arch / drive
  read-write / tokens-sec / profile / recommended model + warnings; re-loads `lastBenchmark`
  on mount. `HomeScreen` profile reflects the persisted value via `getAppStatus`.

### Privacy & offline policy (Phase 8 live)
✅ **`services/policy.ts`** (spec §3.5/§3.6/§6). Pure + resilient; never throws.
- **Types** (in `shared/types.ts`): `PrivacyPolicy` (`network`/`workspace`/`models`),
  `NetworkPolicy`/`WorkspacePolicy`/`ModelsPolicy`, `PolicyStatus`. `DEFAULT_POLICY` lives in
  `policy.ts` (main-only).
- **`parsePolicy(contents, onWarn?)`** → `PrivacyPolicy` merged over `DEFAULT_POLICY`; malformed JSON
  → defaults + warn. **`mergePolicyObject(base, raw)`** maps snake_case JSON → camelCase, taking a
  field only when it is a real boolean. **`loadPolicy(configDir, onWarn?)`** → `{ policy,
  policyFilePresent, driveFilePresent, allowNetworkByDefault }` (reads optional `policy.json` +
  `drive.json`).
- **`resolveNetwork(policy, allowNetworkSetting)`** → `{ networkAllowedByPolicy, networkAllowed,
  offlineMode }` (effective = policy ∧ setting). **`buildPolicyStatus(configDir, allowNetworkSetting,
  onWarn?)`** → `PolicyStatus` (the `getPolicy()` IPC shape; `telemetryAllowed` hardcoded false).
✅ **`services/offlineGuard.ts`** — `isLoopbackHost(host)` (127.0.0.0/8, ::1, localhost exempt),
  `checkOutboundHost(host, offline)` → `{ host, violation }`, `installOfflineNetworkGuard({ offline,
  onViolation })` (wraps `net.Socket.prototype.connect`, logs remote attempts, **never blocks**,
  returns an uninstaller; no-op when not offline), `assertOfflinePosture({ posture, installGuard,
  log, warn })` (startup self-check; logs posture, installs the guard in ALL builds when offline).
✅ **IPC** `registerCoreIpc.ts`: `getPolicy` (`policy:get`) returns `buildPolicyStatus(...)`;
  `getAppStatus.offlineMode`/`networkAllowed` now come from the policy resolution. Preload exposes
  `api.getPolicy` + `PreloadApi`. `main/index.ts` calls `assertOfflinePosture()` in `initBackend()`
  and applies the dev/prod CSP response header in `createWindow()`.
✅ **Renderer:** `PrivacyScreen.tsx` (spec §7.10/§18.1 copy) replaces the placeholder — offline
  statement, "where your data lives" (`getDriveStatus`), live network state (off by default /
  disabled by policy), plaintext-dev-mode caveat, logs-local guarantee. Sidebar `offline-badge` is a
  live button (reads `getPolicy`, links to Privacy).

### Encrypted workspace (Phase 9 live)
✅ **`services/security/crypto.ts`** (spec §3.5) — pure KDF + AEAD, no I/O.
- **KDF:** `deriveKey(password, salt, params)` → 32-byte key. `KdfParams` is per-algo
  (`argon2id: m/t/p` · `scrypt: N/r/p`); `DEFAULT_KDF = { argon2id, m=19456, t=2, p=1, keyLen=32 }`
  for NEW vaults, `SCRYPT_KDF = { scrypt, N=32768, r=8, p=1 }` still unlocks legacy vaults (see the
  §3 KDF decision). `generateSalt()` → 16 random bytes. Deterministic for the same
  password+salt+params.
- **AEAD:** `encrypt(key, plaintext) → { iv(12), tag(16), ciphertext }` (AES-256-GCM, fresh IV),
  `decrypt(key, blob)` (throws on wrong key/tamper). `serializeBlob`/`deserializeBlob`
  (`MAGIC(8)|iv|tag|ct` on-disk frame). `makeVerifier(key)`/`verifyKey(key, verifier)` (password
  check via a known-plaintext GCM blob — never touches the DB).
✅ **`services/workspace-vault.ts`** (spec §7.9) — the lock/unlock lifecycle.
- **Descriptor:** `VaultDescriptor { version, mode:'encrypted', kdf, saltB64, verifier }` at
  **`config/workspace.json`** (unencrypted; the only pre-unlock artifact).
  `readVaultDescriptor`/`writeVaultDescriptor` (atomic). `vaultPathsFrom({configPath,dbPath})` →
  `VaultPaths { descriptorPath, encPath = <dbPath>.enc, dbPath }`.
- **File crypto + hygiene:** `encryptFile`/`decryptFile` (atomic temp+rename), `shredFile`
  (overwrite-random + unlink, best-effort), `cleanSidecars` (shred `-wal`/`-shm`).
- **Lifecycle:** `createEncryptedVaultOnDisk(vaultPaths, password, kdf?)` (writes descriptor + seeds
  an initial DB + encrypts → `.enc` + shreds, leaving it LOCKED); `unlockEncryptedVault(vaultPaths,
  password) → { db, key, descriptor }` (verify → decrypt → open; throws **`WrongPasswordError`**);
  `lockEncryptedVault(vaultPaths, db, key)` (checkpoint+close → re-encrypt → shred).
  `plaintextAllowed(policy, {isDev, developerMode})` gates plaintext (now **enforced**).
- **`WorkspaceController`** (stateful, on `AppContext`): `init()` (startup: plaintext opens
  immediately, encrypted stays locked, else uninitialized), `getState() → WorkspaceStateInfo`,
  `requireDb()` (throws while locked), `isUnlocked()`, `unlock(password)`, `create(password, mode)`,
  `lock()` (no-op for plaintext).
✅ **IPC** `ipc/registerWorkspaceIpc.ts` — `getWorkspaceState` (`workspace:getState`) →
  `WorkspaceStateInfo`; `unlockWorkspace(password)` / `createWorkspace(password, mode)` →
  **`WorkspaceActionResult`** (`{ok:true,state}` | `{ok:false, reason:'wrong_password'|'refused'|
  'error', message}` — a wrong password / policy refusal is a normal result, not a throw);
  `lockWorkspace` → `WorkspaceStateInfo`. Registered in `initBackend()`; exposed on preload `api` +
  `PreloadApi`.
- **Types** (`shared/types.ts`): `WorkspaceStateName` (`uninitialized|locked|unlocked`),
  `WorkspaceStateInfo { state, mode, plaintextAllowed, encryptionRequired }`, `WorkspaceActionResult`.
✅ **`AppContext.db` is now a getter** over `workspace.requireDb()` (throws while locked) +
  `AppContext.workspace: WorkspaceController`. `main/index.ts` builds the controller from
  `loadPolicy(...).policy` + `isDev`, calls `init()`, and locks on `will-quit`. `registerCoreIpc`'s
  `getAppStatus` now derives `workspaceReady = workspace.isUnlocked()` and `workspaceMode` from the
  controller (reads settings only when unlocked); `getPolicy`/status default `allowNetwork=false`
  while locked (offline ceiling stays intact pre-unlock).
✅ **Renderer:** `screens/WorkspaceGate.tsx` — the pre-app create-password / unlock gate (encrypted
  vs plaintext choice when policy allows, confirm + strength hint, wrong-password error). `App.tsx`
  fetches `getWorkspaceState()` on mount and renders the gate until `unlocked`; sidebar **Lock now**
  button (encrypted only) calls `lockWorkspace`. The Settings workspace card reflects the real mode.

### Real runtime + embedder (Phase 10 live)
✅ **`services/runtime/sidecar.ts`** — discovery + `LlamaServer` lifecycle.
- `resolveLlamaServerPath(rootPath, platform, env)` → binary path | null (`runtime/llama.cpp/<os>/`,
  `HILBERTRAUM_LLAMA_BIN` override); `llamaServerDir`/`llamaServerBinaryName`/`llamaOsDir`; `findFreePort()`;
  `defaultThreadCount()`; `LOOPBACK_HOST = '127.0.0.1'`.
- **`LlamaServer`** owns one child process: `start()` (spawn `--host 127.0.0.1 --port <random> --model
  --ctx-size --threads` + `extraArgs`, then poll `/health` with a **timeout** → throw on crash/timeout),
  `health() → HealthStatus`, `fetch(path, init)` (loopback), `stop()` (kill **and wait for exit**).
  Test seams: injectable `spawn` / `fetchImpl` / `findPort` (+ `ChildProcessLike`/`SpawnFn`/`FetchFn`).
✅ **`services/runtime/llama.ts`** — `LlamaRuntime implements ModelRuntime` (composes `LlamaServer`);
  `chatStream` → OpenAI-compatible `/v1/chat/completions` (`stream:true`, role/content, `max_tokens`/
  `temperature`), `readChatSSE(body, signal)` exported (SSE delta parser). `createLlamaRuntime(opts, deps)`.
✅ **`services/runtime/factory.ts`** — `createSelectingRuntimeFactory({ rootPath, resolveBin?,
  modelExists?, makeLlama?, makeMock?, onSelect? }) → RuntimeFactory` (real iff binary + weights present,
  per `start()`; else mock). Used by `RuntimeManager` in `main/index.ts`.
✅ **`services/embeddings/e5.ts`** — `E5Embedder implements Embedder` (id = manifest id, 384 dims,
  L2-normalized; lazy `llama-server --embedding --pooling mean` sidecar; additive `stop()`).
  `createE5Embedder(opts)`. **`Embedder` gained optional `stop?(): Promise<void>`** (mock omits it).
✅ **`services/embeddings/factory.ts`** — `createSelectedEmbedder({ rootPath, model, … }) → Embedder`
  (real `E5Embedder` iff binary + E5 weights present; else `MockEmbedder`). `EmbeddingModelInfo {
  id, modelPath, dimensions?, contextTokens? }`.
✅ **`VectorIndex`** — optional 3rd ctor arg `{ embeddingModelId? }`: a non-empty id scopes the cosine
  scan to `WHERE embedding_model_id = ?` (mismatch guard); default scans all rows. **`rag.retrieve`**
  passes `{ embeddingModelId: embedder.id }`.
✅ **`main/index.ts`** — builds the selecting runtime factory + selected embedder; `resolveEmbeddingModel`
  reads the embeddings manifest pre-unlock; `will-quit` now also calls `ctx.embedder.stop?.()`.
  **R5: live inference is manual** (binaries + GGUF not in repo); everything else is tested with a mocked
  child process / mocked loopback `fetch`.

### Drive layout, scripts & packaging (Phase 11 live)
✅ **`services/drive.ts`** — the canonical, unit-tested reference for drive prep (the scripts mirror it):
- `DRIVE_OS_DIRS = ['win','mac','linux']`, `DRIVE_LAYOUT_DIRS` (workspace, models/{chat,embeddings},
  model-manifests, runtime/llama.cpp/{win,mac,linux}, logs, config, docs), `driveLayoutDirs(root)`.
- `buildDriveJson(opts) → DriveJson` (the `config/drive.json` marker, spec §6 shape);
  `buildPolicyJson({dev?}) → PolicyJson` (snake_case; network always denied; commercial vs dev posture).
- `verifyDriveModels(root, manifests) → ModelVerifyResult[]` (status `verified|unverified_placeholder|
  mismatch|missing|unsupported`, reusing `models.ts` `verifyChecksum`/`isRealSha256`);
  `buildChecksumsJson(root, manifests) → ChecksumsJson` (generate-mode capture of present-weight hashes).
- `planPrepareDrive(root, manifests, opts) → PreparePlan` (dirs + config files + manifest copies +
  weight destinations + `configWouldOverwrite`) + `formatPlan` (the dry-run report).
✅ **`scripts/`** (repo root, self-contained; no Node/npm needed to prep a drive):
- `prepare-drive.{ps1,sh}` — `-Target`/`--target` (required), `-DryRun`/`--dry-run`, `-Force`/`--force`,
  `-Dev`/`--dev`. Creates the layout, copies `model-manifests/` + user docs onto the drive, writes
  `config/{drive,policy}.json`. Idempotent; config only (re)written with `--force`.
- `verify-models.{ps1,sh}` — `-Target`/`--target`, `-Generate`/`--generate`. Flat-YAML line-parses the
  manifests, SHA-256s present weights, prints `VERIFIED/UNVERIFIED/MISMATCH/MISSING/UNSUPPORTED`,
  **exit 1 on a real-hash mismatch**; `--generate` writes `config/checksums.json`.
- `setup-dev.{ps1,sh}` — `NODE_OPTIONS=--use-system-ca npm install` (R6) + build + test smoke.
✅ **Packaging** — `apps/desktop/electron-builder.yml` (portable Windows + mac/linux parity;
  `model-manifests/` as `extraResources`; asar; Electron ≥37). `npm run package` / `package:win`
  (root + workspace). New dev dep **`electron-builder ^26.15.2`**. Output → `apps/desktop/release/`
  (git-ignored, added to `.gitignore` alongside the existing `models/`/`*.gguf`/`/runtime/` ignores).
✅ **Docs** — `docs/user-guide.md` (non-technical §17 path) + `docs/troubleshooting.md` (§18) added;
  `docs/packaging.md` + `docs/drive-layout.md` extended (portable build, the scripts, win/mac/linux
  reconciliation). prepare-drive copies user-guide/troubleshooting + `PRIVACY.md` onto the drive.

### Provisioning / asset loader (Phase 12 live)
✅ **Schema** — `shared/manifest.ts` `DownloadSpec` + optional `ModelManifest.download` (validated only
  when present; real `download.sha256` must equal a real top-level `sha256`). `shared/runtime-sources.ts`
  `RuntimeBuild`/`RuntimeSources` + `validateRuntimeSources` (mirror `validateManifest`). The committed
  model manifests (the original six, incl. the later 14B/30B-A3B) carry real upstream URLs + placeholder hashes.
  **(Updated since Phase 12 — see `model-policy.md` for the live catalog: the catalog is now 11
  manifests (8 chat + E5 + bge-reranker + whisper transcriber), and `runtime-sources.yaml` is pinned
  to the REAL `ggml-org/llama.cpp@b9585` release with real URLs + SHA-256, plus `whisper_cpp:`/`ocr:`
  asset blocks — the original "b9196 placeholder / one CPU build per OS" text below is the Phase-12
  as-built snapshot.)** The Phase-12 snapshot: `runtime-sources.yaml` referenced
  `ggml-org/llama.cpp@b9196` as a PLACEHOLDER, one CPU build per OS.
  `models.ts` `RESERVED_MANIFEST_FILES` excludes `runtime-sources.yaml` from model discovery.
✅ **`services/assets.ts`** — the canonical, unit-tested asset logic (mirrors `drive.ts`; NO real network):
- `planModelDownloads(root, manifests, {only?, acceptLicense?}) → ModelDownloadTask[]` — only manifests
  with a `download` block; reads fs to mark `present-verified`/`present-unverified`/`download`/
  `license-blocked` (license gate ∧ `acceptLicense`); reuses `weightPath`/`verifyChecksum`.
- `selectRuntimeBuild(sources, {os, arch, backend?}) → RuntimeBuild | null` (default = first os/arch
  match = the CPU build) · `planRuntimeDownload(root, build, version) → {url, zipDest, extractTo,
  binaryPath, sha256, ...}` (escape-guarded) · `runtimeBinaryName(os)`.
- `verifyDownloadedFile(path, expected) → {ok, actual, reason}` (placeholder/missing/mismatch are NOT a
  pass) · `downloadToFile(url, dest, {fetchImpl?, onProgress?})` + `fetchAndVerify(task, deps)` (injected
  fetch; mismatch deletes the partial + throws) · `formatAssetPlan(modelTasks, runtimePlan)`.
✅ **`scripts/`** (self-contained, dual `.ps1`/`.sh`, OS-native downloader; `.ps1` pure ASCII):
- `fetch-models.{ps1,sh}` — `-Target`/`--target` (req), `-Only`/`--only`, `-AcceptLicense`/
  `--accept-license`, `-DryRun`/`--dry-run`. Per `download`-block manifest: download (resume via
  `curl -C -`/`aria2c`) → SHA-256-verify vs the manifest → mismatch deletes partial + **exit 1**;
  placeholder → *UNVERIFIED*; present+verified → skip. License gate before the first fetch.
- `fetch-runtime.{ps1,sh}` — `-Target`/`--target` (req), `-Os/-Arch/-Backend` overrides, `-DryRun`.
  Reads `runtime-sources.yaml`, picks the host build (default CPU), downloads + verifies the zip,
  `Expand-Archive`/`unzip`/`ditto` into `runtime/llama.cpp/<os>/`, `chmod +x` on mac/linux. Idempotent.
- `prepare-drive.{ps1,sh}` gained `-WithAssets`/`--with-assets` (+ forwards `-AcceptLicense`): after the
  layout, runs `fetch-models` + `fetch-runtime` so one command yields a launch-ready drive. Without the
  flag, behaviour is unchanged. Then points the user at `verify-models --generate`.
  - **Fast-setup default (2026-06):** `-WithAssets` fetches a small but complete **default set** —
    `ministral3-8b-instruct-2512-q4` (chat) + `multilingual-e5-small-q8` (embeddings) +
    `bge-reranker-v2-m3-f16` (reranker) + `whisper-small-multilingual` (transcriber), each via
    `fetch-models --only` (looped, since `--only` takes one id) — **plus both sidecar runtimes**:
    `fetch-runtime` (llama.cpp, default family) AND `fetch-runtime --family whisper_cpp`. Not all ~11
    models; the user pulls the rest (larger chat models) from the app on demand. `-AllModels`/`--all-models` restores fetch-everything
    (one `fetch-models` call, no `--only`); the runtimes are fetched either way. The default id list is
    a `$DefaultModelIds`/`DEFAULT_MODEL_IDS` constant at the top of each script (keep in sync with
    `model-manifests/`). The whisper.cpp runtime fetch is **best-effort**: prebuilt binaries are
    Windows-only, so on a mac/linux host the "no build" miss is a warning, not a failure (those drives
    build whisper.cpp from source). The commercial build (`build-commercial-drive`) calls `fetch-models`
    directly, so it still pre-loads every model — unaffected.
✅ **In-app downloader (the provisioning plan's deferred item)** — ~~deferred~~ **shipped in Phase 18** (see the contract
  section below). **Real downloads + USB-drive launch = manual (R5).**

### In-app model downloader (Phase 18 live)
✅ **Types** (`shared/types.ts`): `DownloadJobStatus = 'queued'|'downloading'|'verifying'|'done'|
  'failed'|'cancelled'`; `DownloadJob { jobId, modelId, status, receivedBytes, totalBytes,
  unverified, error }` (`unverified` = placeholder-hash download, the model stays UNVERIFIED);
  `ModelInfo.download?: ModelDownloadInfo { url, sizeBytes, licenseUrl, licenseApproved }`.
✅ **`services/downloads.ts`** — `DownloadGates { policyAllows, settingAllows }`,
  `assertDownloadAllowed(gates)` (friendly, cause-specific refusals: policy vs. Settings),
  `partPath(dest)`, `DownloadManager({ fetchImpl?, log? })` with `start({rootPath, manifest,
  gates, licenseAccepted?, hashStore?}) → Promise<DownloadJob>`, `get(jobId)`, `cancel(jobId)`
  (keeps the `.part`), `activeJob()`. One live job at a time; `.part` → verify → rename;
  mismatch deletes the partial; success invalidates the checksum-cache entry.
✅ **`assets.ts` seam (additive):** `DownloadDeps += { signal?, headers?, append?, onResponse? }`,
  `downloadToFile → DownloadToFileResult { status, received, contentLength }` (append only on a
  real 206); `PlanModelOptions += { hashStore? }` (present multi-GB weights are not re-hashed).
✅ **IPC** `ipc/registerDownloadIpc.ts` — `downloadModel(modelId, {licenseAccepted?})`,
  `getDownloadJob(jobId)`, `cancelDownload(jobId)`; gates re-read per call (policy from disk,
  setting from the possibly-locked DB ⇒ off). Preload exposes all three. **Renderer:**
  ModelsScreen Download button (missing/checksum_failed models with a manifest `download`
  block), gate explanations, the confirmation modal (size/license/URL + license-ack checkbox),
  progress + cancel via 1 s polling; SettingsScreen hint updated.

### Audit log (Phase 19 live)
✅ **Types** (`shared/types.ts`): `AuditEventType` (25 values as of Phase 38 — wave 3 added
  document-task/export/password-change events);
  `AuditEvent { id, type, message, metadata: Record<string,unknown> | null, createdAt }`.
✅ **`services/audit.ts`** — `AUDIT_MAX_ROWS = 5000`, `recordEvent(db, type, message, metadata?,
  createdAt?)` (never throws; prunes on insert), `pruneAuditEvents(db, maxRows?)`,
  `listAuditEvents(db, { limit?, beforeId? })` (newest-first; unknown cursor reads from the top),
  `createAuditRecorder(getDb) → AuditRecorder` (locked-vault memory buffer, bounded 100,
  flush-in-order with original timestamps). **`AppContext.audit?: AuditRecorder`** — optional, so
  partial test contexts stay valid; every call site is `ctx.audit?.(…)`.
✅ **`services/downloads.ts` seam (additive):** `DownloadManagerDeps.audit?` (`DownloadAuditType` =
  the three `model_download_*` values) — injected by `registerDownloadIpc` in production.
✅ **`services/offlineGuard.ts` seam (additive):** `AssertOfflinePostureDeps.onViolation?(host)`.
✅ **IPC** `ipc/registerAuditIpc.ts` — `getAuditEvents`, `exportAuditLog` (JSON, save-dialog
  pattern). **Renderer:** Diagnostics Activity card (on-demand, type filter, paging, export).
⚠️ The privacy rule (ids/filenames/counts, never content) is a CONTRACT for every future call
  site — extend the sentinel test when adding events.

### Plug-and-play distribution (Phase 13 live)
✅ **`services/launcher.ts`** — `resolveDriveRootFromLauncher(launcherPath, flavor?: 'win32'|'posix'|
  'auto')` → the drive root (the launcher's own directory; pure path math, no fs). Handles Windows
  drive-letter + POSIX/macOS paths; throws on empty/relative. **No hardcoded path** — the canonical
  reference the launcher scripts mirror.
✅ **`launchers/`** (repo templates copied to the drive root by the pipeline) — `Start Private AI
  Drive.cmd` (`%~dp0` → set `HILBERTRAUM_DRIVE_ROOT` → spawn `HilbertRaum-*-portable.exe`), `Start
  HilbertRaum.command` (macOS, exec the `.app` binary with the env exported), `start-private-ai-
  drive.sh` (Linux, next to the AppImage), `READ ME FIRST.txt` (friendly first-run + SmartScreen/
  Gatekeeper "Run anyway" copy).
✅ **`services/preflight.ts`** — `runPreflight({ rootPath, measureSpeed?, minFreeBytes? }) →
  PreflightResult { rootPath, writable, freeBytes, slowDriveWarning, problems[] }` (spec §11.4 tone;
  non-blocking). Reuses `buildDriveStatus` + `measureDriveSpeed`/`buildWarnings`. `LOW_FREE_SPACE_BYTES
  = 2 GB`. `PreflightResult` lives in `shared/types.ts`. IPC `runPreflight` (`preflight:run`) in
  `registerCoreIpc` → preload `api.runPreflight`; **HomeScreen** shows a non-blocking note.
✅ **`services/commercial-drive.ts`** — `planCommercialDrive({ target, os?, acceptLicense? }) →
  CommercialStep[] { id, title, command, manual, description }` (ordered: prepare → fetch-models →
  fetch-runtime → **package [manual]** → copy-app → verify → assert) + `formatPlan`; and
  `assertCommercialDrive(rootPath, manifests) → CommercialAssertion { ok, problems[], checks{
  policyCommercial, networkDenied, weightsVerified, noUserData }, modelResults }` (reuses `loadPolicy`
  + `verifyDriveModels`; flags network-allowed / plaintext / unverified-or-mismatch weights / present
  user data — `workspace/hilbertraum.sqlite[.enc]`, `config/workspace.json`, non-empty `workspace/documents/`).
✅ **`scripts/build-commercial-drive.{ps1,sh}`** — self-contained dual-shell master pipeline mirroring
  the plan; `-Target`/`--target` (req), `-AcceptLicense`/`--accept-license`, `-AppArtifact`/
  `--app-artifact` (a pre-built signed app to copy), `-SkipPackage`/`--skip-package`, `-DryRun`/
  `--dry-run`. Orchestrates prepare-drive (`-Force`) → fetch-models → fetch-runtime → (package =
  manual) → copy launchers+docs → verify-models `--generate` → native posture cross-check (exit 1 if
  not sellable). PS uses **hashtable** splatting for named params. Both dry-run-smoke-tested.
✅ **Packaging/signing** — `electron-builder.yml` `win.signtoolOptions` + `mac.notarize`/
  `hardenedRuntime`/`gatekeeperAssess:false`/`entitlements: build/entitlements.mac.plist`; secrets are
  env-driven + git-ignored. The green gate does NOT sign (it never runs electron-builder).
✅ **Tests** — `tests/integration/launcher.test.ts` (11: `resolveDriveRootFromLauncher` Win/POSIX/auto/
  empty/relative; `runPreflight` ok/slow/read-only/low-space/unmeasurable with an injected speed fn) +
  `tests/integration/commercial-drive.test.ts` (8: ordered plan + manual package + `--accept-license`
  threading + `formatPlan`; `assertCommercialDrive` passes verified-commercial, fails network/plaintext/
  placeholder-weight/user-data). **Signing + notarization + the real USB launch = manual (R5/R7).**

### MVP Definition of Done (§4 / spec §22) — checklist
| Criterion | Status |
|---|---|
| App builds on ≥1 OS | ✅ `npm run build` green (Windows) |
| Architecture supports Win/macOS/Linux | ✅ path/OS abstractions + 3 sidecar dirs + 3 builder targets |
| Local model chat works | ✅ mock now; real `LlamaRuntime` wired (live = manual, R5) |
| Local doc Q&A works | ✅ ingestion + embeddings + RAG (mock + real backends) |
| Citations work | ✅ Phase 6 (`citations_json`, source panel) |
| Manifests work | ✅ discover/validate/verify/recommend/select |
| Drive layout works | ✅ `prepare-drive` (dry-run tested); `resolvePaths` marker |
| User data local | ✅ no network in core path; loopback-only sidecars |
| Privacy docs exist | ✅ PRIVACY.md, Privacy screen, security-model |
| Setup script exists | ✅ `scripts/setup-dev.{ps1,sh}` |
| Benchmark recommendation exists | ✅ Phase 7 |
| Non-technical demo possible | ✅ documented end-to-end (user-guide.md); live run = manual (R5) |
| No cloud API | ✅ enforced (offline guard, CSP, deny-by-default policy) |
| No model weights in git | ✅ `.gitignore` (`models/`, `*.gguf`, `/runtime/`, `release/`) |
| README explains DIY | ✅ (+ user-guide + packaging + drive-layout) |
| Commercial drive layout documented | ✅ drive-layout.md + packaging.md |

**Remaining = MANUAL acceptance only (R2/R5):** producing the real portable `.exe` (Electron binary
download R2; npm-workspace dep hoisting may need a tweak) and a live USB-drive run with real weights +
sidecar binaries (not in repo). The selectors fall back to mocks when those files are absent, so dev +
CI are unaffected.

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
   workspace, different drive letter). The `electron-builder.yml` hooks + the pipeline are
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
4. **Phase 30 — opt-in big slot + embeddings:** working paper drafted
   ([`docs/big-slot-embeddings-plan.md`](docs/big-slot-embeddings-plan.md), D38–D43): Track A
   (Gemma 4 26B-A4B etc. vs the incumbent Qwen3 30B-A3B, reusing the Phase-29 benchmark) +
   Track B (a better embedder — the reindex-forcing swap; D42 eval-set hardening is the
   prerequisite). Key verified fact: the pinned b9585 already runs Gemma 4 — no runtime bump.
5. **ANN vector index** only if a real corpus outgrows the linear scan (rag-design §12.2 D15 —
   explicitly not built).

**Current gate (2026-06-13, post i18n wave + FULL audit remediation — every HIGH/MEDIUM/LOW closed — on
branch `audit-2026-06-13-high-fixes`): typecheck clean, 1083 tests pass (25 skipped — the manual
tests behind `HILBERTRAUM_*` env vars: GPU/thinking/rerank/minsim/RAG-quality/bring-up/
eval/concurrency-probe/translation/compare/whisper/dictation/OCR smokes — skipped in CI),
`npm run build` green. Full-suite runs on a loaded machine can flake 1–2 timeout failures
(different tests each run; each passes in isolation — see the §3 2026-06-13 entry).** Per-phase gate history (test counts, bundle sizes, per-phase test
inventories) lives in git history.

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
- **L-7 — Runtime-archive extraction doesn't prevent member traversal (build-time only).**
  `Expand-Archive` / `tar -xzf` in `scripts/fetch-runtime.{ps1,sh}` run on the drive **builder's**
  trusted machine, not the shipped app. A crafted archive (attacker controlling both URL and its
  placeholder hash) could write outside `extract_to`. Fix: list/extract members with an explicit
  containment check.
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
