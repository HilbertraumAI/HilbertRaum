# Known limitations & accepted trade-offs

_Last updated: 2026-07-03 (skills-remediation close-out — the 2026-07-02 audit + its 20-phase plan were folded into architecture.md §39 and both working papers retired; the skills/extraction residual bullets' `audit §N.M` citations now resolve via §39's §-anchor legend, and the still-open residuals — incl. the T1-surfaced `USt ∈ TOTALS_FILLER but ∉ TAX_LABELS` phantom-item gap — are kept). Prior: 2026-06-30 (full-audit-2026-06-30 Phase D — renderer lifecycle & a11y: added the pure-code-block StreamAnnouncer a11y residual (F6) to "Accessibility" and the self-healing optimistic "Try again" slice (F7) to "Engineering trade-offs"; the F1–F8 dispositions live in architecture.md "Renderer robustness" Phase D). Prior: 2026-06-29 (full-audit-2026-06-29 Phase 2 — runtime reliability: whisper SIGKILL escalation + bounded teardown (REL-2) extended the audio-transcription watchdog bullet; the REL-1 port-race retry and REL-3 abort-aware slot handoff are recorded in the architecture.md GPU/runtime + doc-task records). Prior 2026-06-29: Phase 1 — financial correctness: space-disambiguated sign reading (BL-1), figure-region per-row currency (BL-2), German closed-compound categorization (BL-3); extended the bank/invoice line-parser + categorizer bullets under "Document tasks & summaries"). Prior: 2026-06-28 (full-audit-2026-06-28 Phase 1 — financial correctness: per-document date-locale inference, trailing-date balance scrub, amount-column-by-position, grouped-figure support, and redaction phone/IBAN coverage; extended the redaction bullet + added the bank/invoice line-parser assumptions under "Document tasks & summaries" — BL-N1…N6)._

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
  corrupting. Document **deletion** stays safe for those membership/link tables because they declare
  `ON DELETE CASCADE`: a direct `DELETE FROM documents` (with `PRAGMA foreign_keys = ON`)
  cascade-removes the orphan rows instead of raising a foreign-key violation. The later **skills**
  content tables (`bank_statements` / `bank_transactions` / `bank_corrections`, `invoices` /
  `invoice_line_items`) are handled two ways (backend audit 2026-06-27, DATA-1): the current build's
  `deleteDocument` does an **explicit ordered delete** of those rows (`purgeDocumentDerivatives` →
  `purgeSkillDataForDocument`) inside one transaction *before* the `documents` delete, which keeps
  deletion safe on **existing** drives whose FKs predate the fix; and fresh schemas additionally
  declare `ON DELETE CASCADE` down both chains, so even a bare `DELETE FROM documents` (e.g. a future
  caller) cascades cleanly. Note: a **pre-skills** build deleting a document that has bank/invoice
  extractions would hit the un-cleaned FK and fail — the same accepted app-beside-data version-skew
  stance as the vault note above (the *current* build deletes such a document cleanly and atomically).
  (See `docs/architecture.md` "Document organization — design record" §3 and "Skills — design record"
  §10.)
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
- **Skill triggering runs on ONE canonical bilingual vocabulary (Skills W5), word-boundary matched — the
  OFFER is precision-first, ROUTING is recall-first.** `services/skills/vocabulary.ts` single-sources each
  app skill's trigger terms; the SKILL.md `triggers.keywords` (the suggestion manifest) are regenerated
  from it and pinned by a parity test, and the routing gates (`isAnalysisShaped`, the whole-doc shape
  gates, `isRedactionShaped`) read the same source via `routeMatch` — so the two lists can no longer drift.
  A single-token keyword is matched at **word boundaries** (`net` no longer intercepts "Netflix", `bill`
  no longer "billboard"), and a suggestion additionally **requires ≥1 keyword hit** (a lone `statement.pdf`
  in scope no longer stands a permanent question-independent offer). Two deliberate asymmetries remain:
  (1) an OFFER on a single-token German noun is word-anchored, so a closed compound ("Rechnungsposten",
  "Kündigungsfrist") does **not** earn the offer even though the same term **routes** once the skill is
  active (routing uses substring stems — recall beats precision under an already-chosen skill, spec §8.2);
  (2) `meeting` is offer-able as a bare word (the "Summarize this meeting" incident requires the offer to
  fire), so a scheduling ask ("schedule a meeting") can still draw a meeting-protocol offer — the measured
  suggestion precision is ~98 % on the eval corpus, and the offer is inert (in-picker only, never
  auto-applied). The redaction manifest↔handler pair is now **aligned** (Skills U4, audit §4.4): the pure
  legal words (`datenschutz`/`dsgvo`/`gdpr`) were **dropped** from the vocabulary — the handler acts on
  neither `routeMatch` nor the informational PII scan for them ("Was regelt die DSGVO?" is about the LAW,
  not the document), so redaction no longer offers **or** auto-fires on them; the PII-content topics
  (`sensitive data`/`sensible daten`) stay, since the informational dry-run reports per-category counts
  for those.
- **A skill picked in the composer applies PER-TURN, is visible, and is reversible (Skills U3, audit
  §4.3 / ux-6).** Before U3 every picker pick — including accepting a one-off suggestion — was silently
  written to the conversation's persisted default (`active_skill_id`), so a pick made many turns ago
  kept shaping later answers invisibly (a large contributor to "inconsistent results"), and the "answer
  without it" undo existed only for **auto-fired** rows. Now a pick sets a **session override** that
  shapes the turn but is **not** persisted; the composer shows a **persistent chip** with an **×**, and
  the picker gained an explicit **"keep for this conversation"** checkbox that is the **single** writer
  of the sticky default (`active_skill_id`). Every other path — the ×, picking **None**, and un-checking
  keep — **clears** any saved default, so a superseded default can neither resurface on reload against
  the user's visible choice nor contradict the (unchecked) keep-checkbox. Pre-existing sticky defaults
  keep working: an untouched composer still resolves and applies the saved default (and reads as *kept*). The send path passes the
  session pick **verbatim** (`turnSkillArgFor`: an id, an explicit `null` = no-skill-no-auto-fire, or
  `undefined` = "resolve the saved default and maybe auto-fire"), so the chip and the answer can never
  disagree, and the **"answer without this skill"** undo now rides **every** skill-stamped last turn,
  not just auto-fired ones. **ux-6:** the **Summarize/Categorize** run-bar buttons surface their real
  output by routing a question into the transcript answered by the 0-model bank handler; that relay now
  **pins `askDocuments` to the run's document** (the resolved target id, re-validated main-side and
  ignored if out-of-scope), so a multi-document or whole-library scope can no longer scatter the answer
  across the wrong documents — and the two routed buttons (plus the post-extract "Categorize" follow-up)
  are **hidden in plain-chat mode**, where the routed answer would be unreachable. All renderer +
  turn-resolution + scope-pin plumbing — no routing-engine change. **Residual:** the session override is
  in-memory, so a per-turn pick that was never "kept" does not survive an app reload (by design — that
  is the point of per-turn); and the relay pin degrades to the ordinary conversation scope if the run's
  target id was lost (a screen remount with no resolved id), rather than failing.
- **Auto-fire can now reach the three complaint skills, but only on an EXPLICITLY-scoped document — and it
  stays default-off (Skills U4, audit §2.4/§4.4).** Before U4, only `document-redaction` declared
  `triggers.autoFire`, so bank-statement, invoice and meeting-protocol could **never** auto-fire even with
  the user setting on; U4 opts all three in (their `applies()` gates are already single-doc + intent-shaped,
  and the S13c one-click "answer without it" undo exists). Two guards keep the expansion honest: (1) the
  master setting `skillsAutoFireEnabled` remains **default-off** (the safe-merge posture — inert in
  production until the owner flips it); (2) auto-fire's doc-signal corroboration is **narrowed to explicitly
  scoped documents** — a chat attachment or a hand-pick. A whole-corpus **Library/collection** scope
  contributes **no** doc signal, so "keyword + ≥1 doc signal" no longer degrades to "keyword + any matching
  PDF anywhere in the library": a lone keyword with an incidental library match scores only 2 (< the ≥3
  bar) and does not silently fire. Strong intent (two distinct keywords) still auto-fires without an
  explicit doc, and the inert **suggestion** offer deliberately keeps reading the full scope. The measured
  auto-fire gate on the expanded eval corpus (incl. whole-corpus shapes) holds **fired-wrong == 0 and
  precision ≥ 0.95**. **Residual:** the narrowing keys on `scope.documentIds` (explicit selection ∪
  attachments), so a *collection*-scoped conversation — even a small hand-curated folder — is treated as
  whole-corpus for auto-fire and yields no doc signal; that is deliberate (only a document the user put in
  front of the skill corroborates a silent fire), but it means a narrow-collection user must lean on keyword
  strength or an explicit pick.
- **Copy, i18n, and export-dialog polish — six user-facing fixes, no engine change (Skills U5, audit
  ux-12/15/16/17, §3.6, §6.2).** (1) **German assistant-voice → du:** the deterministic bank/invoice analysis
  answers and the routing/redaction answers now address the user informally (`du`) everywhere; a lint-ish guard
  test (`skill-i18n.test.ts`) flags any formal `Sie`/`Ihr` regression in the `skills.*Analysis.*` /
  routing-answer keys, while tolerating a sentence-start pronoun `Sie` (*it/they* — the redaction copy relies on
  `Sie läuft`/`Sie verarbeitet`). (2) The **`needsExtraction`** run-bar error now names the ACTUAL extract
  button to click first, interpolated per the failing tool's domain (bank downstream → "Extract transactions";
  invoice → "Extract invoice"), rendered as plain text with the label in quotes (the bar is not markdown). (3)
  The **"tools run only when you start them"** claim — false since read-only analysis tools auto-run to answer a
  question (D46/the exhaustive path) — is corrected in the settings note (`skills.tool.note.active`), **both**
  SKILL.md bodies, and the user guide to *"read-only tools may run automatically to answer your question;
  anything that writes or exports a file always asks first"* (the model still never invokes a tool itself). (4)
  **Per-export save-dialog metadata (§6.2):** the ONE hardcoded CSV dialog no longer serves every export —
  JSON→`.json`, XML→`.xml`, and the redacted copy gets a *"Save redacted copy"* title + a `.txt` filter (it used
  to fight `redacted.txt` with an "Export transactions"/`.csv` dialog on Windows). The dispatch (`tool-runs.ts`)
  binds the per-tool metadata as **content-free i18n keys** and the IPC `saveTextFile` closure resolves them;
  CSV stays the default. **(A2 later folded this into the self-describing tool registry — each export tool
  names its own dialog in `shared/skill-tools.ts` `descriptor.dialog`, which the dispatch reads.)** (5) A **last-chunks citation stopgap** for long invoices: the
  totals print at the END, past the first `MAX_CITATIONS` cited chunks, so `buildInvoiceCitations` now reserves
  the final `TAIL_CITATIONS` slots for the closing chunks (leading + trailing windows, in document order). (6)
  An **ephemeral "reading the document…" notice** when an exhaustive skill handler starts a long, silent
  extraction (the "one-blob answer reads as a hang" gap, §3.6) — it rides the compaction ephemeral channel with
  a new `kind:'analysis'` and clears on the first answer token (never buffered/persisted, R14). **Residuals:**
  the invoice CSV export still uses the shared "Export transactions" CSV title (the plan scoped per-tool titles
  to JSON/XML/redaction; the filter/extension were the §6.2 defect and are correct for CSV); the citation
  head+tail split is a **stopgap** until per-figure invoice provenance lands (mirroring
  `bank_transactions.source_page`); and one **non-skill** Images string (`images.drop.busy`) still uses formal
  `Sie` (outside U5's skill-string scope).
- **The renderer run store is per-run and conversation-gated (skills-audit-2026-07-03 U6, SKA-6/17/18/25/29/37/38/39/40/41).**
  After A2 made tool runs per-document concurrent MAIN-side, the renderer kept a SINGLE module-level `active`
  run, and ChatScreen rendered that one app-wide run's bar in EVERY conversation. U6 re-architects
  `renderer/lib/skillruns.ts` into a **multi-run store keyed by `runHandle`** (each entry carries
  `{run, conversationId, documentId}`), mirroring the A2 controller; ChatScreen gates the busy/result bar to
  the run whose `conversationId === activeId` and shows a quiet **"a skill is working in another chat"** chip
  for runs elsewhere (SKA-6). A second run no longer silently abandons the first (both outcomes are shown +
  acknowledged); the post-extract **Categorize** offer refuses (hidden) when its remembered document is not in
  the current conversation's scope, and MAIN **hard-refuses** a confirm-gated tool run whose requested document
  is out of scope even when exactly one doc is in scope (SKA-29 — a confirmation for doc X never executes
  against doc Y; read-only tools keep the tested single-doc convenience fallback). A **`listSkillRuns` IPC**
  (ids/counts only) lets a reloaded renderer **re-adopt** in-flight AND terminal-unacknowledged runs — the
  launching conversation + target document are threaded onto the content-free `SkillRunState`
  (`conversationId?`/`documentId?`, additive) so a reload can re-gate + re-pin the routed relay; a busy refusal
  carries the running handle as a fallback re-attach path; never-acknowledged terminal runs are TTL-swept in
  the controller (bounded Map) (SKA-17). The store **shallow-compares** (state/count/resultKind/progress)
  before notifying so a 400 ms no-op poll no longer re-renders ChatScreen ~2.5×/s (SKA-39), and **tolerates N
  consecutive poll failures** then keeps a labelled *"couldn't check on this skill"* row instead of silently
  dropping a live run (SKA-40). The run bar's live region is now **one always-mounted `aria-live` status
  container** whose text swaps (SKA-41, the app's M-U1 lesson). The transcript's *"answer without it"* undo +
  *Try again* render only when the LAST message is that assistant turn (SKA-37 — a trailing unanswered user
  turn no longer misdirects the undo to a later question), and the skill glyph + undo are keyed off the
  persisted `messages.skill_id` with a localized **"(removed skill)"** label, so DELETING a skill keeps the
  provenance (consistent with a disabled skill) (SKA-38). The 'new'-composer skill pick is deleted after being
  carried onto the created conversation, so it no longer resurrects on a later empty composer (SKA-18).
  **Residuals (accepted):** when a single conversation holds two concurrent runs (a multi-document scope,
  different docs), the bar shows only the MOST RECENT one (v1 tools are single-document, so this is rare); a
  reloaded run's busy/result row falls back to the count label until its target name re-resolves (the U-1
  renderer-remembered name is React state, lost on reload — the document id is re-pinned from the store); and a
  run whose polling gave up shows a *"state unknown"* row rather than a definitive outcome (main may still hold
  the true terminal state, re-adopted on the next reload). One narrow re-attach edge: the routed relay
  acknowledges (clears main-side) a routed run BEFORE its answer streams, so a reload normally never re-adopts
  an already-relayed run; but if that `clearSkillRun` IPC silently fails AND the renderer reloads before the
  30-minute TTL sweep, the re-adopted terminal routed run would relay its answer a second time (a duplicate
  transcript turn). Accepted: `clearSkillRun` is a trivial in-process IPC that effectively never fails, and the
  window is a reload before the answer even finished persisting.
- **Skill package lifecycle hardening (skills-audit-2026-07-03 U7, SKA-15/16/30–36/42 + SKA-45 riders).**
  Ten package/manifest/installer/Settings fixes. **(SKA-15)** all 8 bundled SKILL.md bodies merge heading +
  honesty-rules intro + bullets into ONE paragraph — the only paragraph `buildSkillFence` GUARANTEES at a
  tight budget — closing the residual decapitation the U1 reorder left (P0 was the bare `#` heading, so a
  budget-squeezed turn shipped an intro *promising* rules with none delivered; the parity test had pinned
  the wrong paragraph and now trims the REAL bodies through the builder at a rules-only budget).
  **(SKA-16)** a non-file SKILL.md (a directory, from hand-unpacking) or one unreadable folder no longer
  kills ALL reconciliation for the session — the manifest reader requires a real file and discovery guards
  every per-folder read (structural error + continue). **(SKA-30)** the zip/folder duplicate-path guard is
  CASE-FOLDED (+ file-vs-directory merge), so `SKILL.md`+`skill.md` polyglot packages refuse instead of
  installing different instructions per OS; ASCII fold only (`String.toLowerCase`, not the exact NTFS/exFAT
  fold tables) — an exotic non-ASCII casing pair could still merge on write (residual). **(SKA-31)** YAML
  parse errors are a fixed structural string + numeric line/column — never `String(err)` with the yaml code
  frame quoting attacker frontmatter (canary-pinned). **(SKA-32)** discovery/reconcile errors surface:
  startup logs count + structural codes, and Settings → Skills shows "N skill folders could not be read"
  (count only — an invalid folder name is arbitrary user text and never crosses the IPC/log). **(SKA-33)**
  a failed import toast shows the precise localized structural reason (mapped back out of the wrapped IPC
  message), with the generic toast kept for unexpected failures (an ENOSPC/lock throw is deliberately NOT
  mapped — wrong-specific copy is worse than generic). **(SKA-34, decision)** export mirrors import's
  acceptance (everything allowed under the skill dir minus the root manifest.json cache, dot-entries,
  symlinks; the canonical-subdir allowlist deleted) and import now skips dot-named entries too, so
  `export(import(pkg)) == pkg` holds exactly (round-trip test); **residual:** a hand-made DROP-IN folder
  can still hold files an export packs but a re-import refuses (over-cap sizes; a case-colliding pair
  created on a case-sensitive FS) — export applies no size caps to the user's own files by design.
  **(SKA-35)** import-preview notes are localized via stable note CODES + app-fixed params (the error-code
  precedent); the `localized.<key>` family no longer interpolates the attacker-chosen locale key, and
  locales dropped at the 16-cap now emit a note. **(SKA-36)** crash-leftover `.skill-import-*` staging and
  `.skill-backup-*` dirs are swept at reconcile, age-gated > 1 h by mtime (a live import's dirs are never
  swept; the backup's mtime is TOUCHED after the rename so it doesn't inherit the old install's stale
  mtime); a younger leftover is skipped by discovery (dot-names are never packages), so it can't surface as
  a phantom folder error meanwhile. **(SKA-42)** document-redaction's SKILL.md names BOTH button labels
  (EN + DE) so a German fence-answered turn no longer points at a nonexistent affordance. **(SKA-45
  riders)** Unicode bidi direction controls are rejected in every displayed frontmatter string (title/
  description/author/language; ignored-with-note in localized overrides) — cosmetic picker spoofing — and
  the stale S13a-era autoFire comment was refreshed.
- **Run-seam edge hardening (skills-audit-2026-07-03 R9, SKA-24/26/27/28/44).** Five run-seam edges.
  **(SKA-24)** `withDocumentLock` acquisition is **abort-aware**: a run PARKED behind another lane (queued
  behind a long categorize holding the lock for minutes of LLM batches) now rejects on Cancel — the
  controller flips it to `cancelled` immediately instead of a dead "running" spinner + busy refusals until
  the other lane finishes; the aborted waiter settles its already-published chain link, so later callers
  never wedge (pinned by a third-caller test). The chat-analysis turn signal and the categorize doctask
  signal ride the same rail. **Residual (accepted):** cancellation INSIDE the critical section stays
  cooperative (the tools' own signal checks) — abort only interrupts the park; and an already-cancelled
  run facing a FREE lock still runs the seam far enough to record its honest 'cancelled' run row (the
  pre-R9 tested contract). **(SKA-27)** the file-export tail is B4-guarded: a `finishRun` throw after the
  minutes-open save dialog (workspace locked underneath it) no longer strands the run at 'started' NOR
  reports *"failed. Nothing was changed."* after the file WAS written — the outcome reports what happened
  to the FILE; bookkeeping gets one guarded retry and then only a local log. 'done' is stamped at the
  actual write, not the pre-dialog prepare (run history no longer timestamps an export minutes early).
  The adversarial review found `runDocumentRedaction` — the other dialog-shaped seam — carried the same
  class (its unguarded post-write 'done' fell into the outer catch → 'failed' + "Nothing was changed."
  after the copy WAS written); same treatment applied there.
  **Residual:** if the workspace is PERMANENTLY unwritable, the row genuinely cannot reach a terminal
  status — the user still gets the truthful success. **(SKA-28)** `runCashflowSummary` and the file
  exports now hold ONE per-document lock across prepare + load + serialization (the last two downstream
  seams that held none), closing the microtask-narrow TOCTOU where a competing `replaceExisting` extract
  interleaved between the staleness re-extract's release and the row load (empty CSV, "saved 0 rows");
  the export's hold RELEASES before the save dialog, so a parked dialog never blocks the document's other
  lanes. **(SKA-26, decision: flip)** extractor-version staleness is now `v !== CURRENT`, not `v <`: rows
  written by a NEWER extractor re-extract too — on a portable drive the app roams with the workspace, so
  a mismatch means a deliberate rollback (where the newer extractor IS the suspected bug) or a second
  install; serving its rows as fresh was exactly backwards. Deterministic extractors make the flip safe
  (same version ⇒ same rows ⇒ no loop). **Accepted cost:** a workspace alternated between two app
  versions re-extracts on EVERY switch, and each `replaceExisting` re-extract drops the persisted per-row
  categories (the rows changed with the parser; the honest move is recomputing — the next categorize run
  restores them). **(SKA-44, decision: demote)** the EN `transfer` categorizer rule is `confident: false`
  like R3's `sepa`/`überweisung` — "TRANSFER TO NETFLIX…" now reaches the 15-category LLM instead of
  being pre-filtered into 'Transfer' (same rails-not-merchant semantics; the offline deterministic
  fallback still labels it Transfer). No extractor bump; the T1 snapshot is untouched (categories are not
  extraction output).
- **Eval & test-infra sweep close (skills-audit-2026-07-03 T2) — two accepted residuals + one recorded
  test-guard acceptance.** **(SKA-43, decision: accept — no cache)** the needle-downgrade calculus still
  re-scans the document per needle-shaped turn (`documentApproxTokenTotal`'s all-chunks read + KMP
  de-overlap, then `retrieveWholeDocument` repeating the same pass; twice more per compare). NOT cached:
  the passes are milliseconds of in-memory string work against the model call the turn then makes
  (seconds to minutes on CPU), while a memoized per-document token total would need invalidation at every
  chunk-mutation site (re-index, purge — plus any direct `chunks` UPDATE) and a STALE total would silently
  mis-size the needle downgrade and the compare budget split: a correctness-adjacent risk bought for an
  imperceptible win. Revisit only if profiling ever shows the scan itself hot. **(SKA-45, last open
  sub-item)** the `buildSkillFence` O(n²) growth loop stays as written — bounded by the 64 KiB body cap
  (hostile-input worst case ~100–300 ms, once per turn), a perf micro, not a correctness item. With these
  two recorded, every SKA-1…SKA-45 item of the 2026-07-03 audit is dispositioned (fixed or documented
  residual). **(T1 snapshot guard — accepted input-edit exemption)** editing a fixture in the same commit
  exempts its OWN output change from the extractor-version bump (the `inputHash` discriminator): that is
  inherent to legitimate corpus upkeep, and smuggling an extractor change through it would require a
  visible fixture edit in the same diff. The two REAL guard gaps are closed by T2's self-checks: each
  committed hash is recomputed against its own committed output, and the snapshot's recorded extractor
  versions are pinned to the live constants — a hand-edited hash or a bump-without-regenerate now fails
  the default suite.
- **Extractor evaluation infrastructure — a real-layout corpus, an output-snapshot version-bump guard, and an
  opt-in real-model smoke (Skills T1, audit §7 recs 1/2/5).** The recurring wrong-figure incidents
  (INVOICE-TOTALS-1, HVB zero-transactions, the §5.3 NBSP/Unicode family) were real-LAYOUT features that
  post-hoc synthetic fixtures never carried, and no skill path was ever exercised against a real model (the
  RUNTIME-5/6 vision-salad test-blindness class). T1 lands three guards: (1) a single committed real-layout
  fixture corpus (`tests/fixtures/real-layouts/corpus.ts` — constructed AT/DE/CH statements + invoices, never
  real user data, special chars as `\u` escapes) consolidating the incident classes (NBSP/narrow-NBSP,
  U+2212/en-dash signs, Summe/Endbetrag/Rechnungssumme labels, SEPA rows, dd.mm.yy + cross-year dates, wrapped
  descriptions), run through the REAL production extractors with the parsed figures asserted; (2) an
  output-snapshot guard (`extractor-realworld.test.ts` + `extractor-output.snapshot.json`) that hashes each
  fixture's full extractor output keyed by extractor version — any output change FAILS the default suite
  unless the affected `*_EXTRACTOR_VERSION` was bumped and the snapshot regenerated
  (`UPDATE_EXTRACTOR_SNAPSHOT=1 …`), the mechanical backstop for the "every behaviour change bumps the
  version" rule that green synthetic fixtures did not enforce; and (3) an env-gated opt-in real-model smoke
  (`tests/e2e-model/skills-smoke.test.ts`, `SKILLS_SMOKE_MODEL=<gguf>`) driving one bank + one invoice (the
  third-mode grounded-data path) + one German minutes turn against a real local model, asserting STRUCTURE +
  FIGURES (the deterministic echo, the extract count) not prose. Details: [`model-benchmarks.md`](model-benchmarks.md)
  §10. **Residuals:** nothing in the default `npm test` needs a model or the network (the smoke skips cleanly
  without a path and is NOT wired into CI — it is a manual pre-release / post-pin-bump gate); the corpus fed
  the PLAIN-TEXT extractor path only until invoice-hardening-2026-07-04 P4 added the first geometry INVOICE
  fixture (`invoice-de-geometry-columns`, through the real `reconstructPage`) — geometry BANK coverage was
  already there, and the reconstruction's own unit tests remain the deep coverage; and the corpus surfaced
  one still-open gap — the abbreviation `USt` is in the invoice
  `TOTALS_FILLER` set but NOT in `TAX_LABELS`, so a standalone `USt … EUR` tax-total line reads as a phantom
  line item (a spelled-out `Steuer` / `Umsatzsteuer` / `MwSt` label parses correctly) — a candidate for a
  future R-phase, recorded here rather than fixed under a test-infrastructure phase (no extractor change).
- **Glyph-mangled (per-glyph) PDF text layers are DETECTED and refused, not repaired
  (invoice-hardening-2026-07-04, architecture.md "Skills — design record" §42).** A PDF whose text layer
  fragments into single-glyph runs ("1   0 % 3   Article") now stamps `textQuality: 'suspect'`, gets ONE
  re-read through the geometry (`reconstructPage`) path, and — unless the figures then POSITIVELY
  reconcile — an honest "this document's text doesn't extract cleanly" refusal pointing at OCR/the
  original, instead of confident garbage totals (the 2026-07-04 incident class). **Residuals, accepted:**
  (a) the `looksLikeGlyphSoup` heuristic is deliberately conservative (≥ 3 soup-shaped lines AND ≥ 20% of
  non-empty lines) — a lightly-mangled document below both floors still parses without the caveat;
  (b) the geometry retry runs ONCE per document (`suspect-confirmed` is final) — re-import/re-index to
  retry after an upstream fix; (c) geometry reconstruction recovers COLUMN-scrambled layouts, not
  per-glyph spacing (those correctly end at the refusal + OCR guidance); (d) the format-negation window
  is 24 chars — an exotic phrasing with a farther negator falls to the conversation-level
  byte-identical-replay backstop, whose own trade-off is that a *repeat* format ask carrying an unrelated
  negation streams grounded-data (same figures, narrated) instead of re-serving the dump; (e) the new
  `recipient` header field reads LABELED lines only ("Bill to:", "Rechnungsempfänger:", "Kunde:" …) — an
  address-block recipient with no label stays unextracted, and the recipient-shaped question then falls
  through to the relevance path over the document text (by design, never a fabricated party).
- **Document redaction is best-effort, not a privacy/compliance guarantee (Skills S11d).** The
  `document-redaction` skill's `redact_document` tool masks personal data with **deterministic,
  offline regexes only** — e-mail addresses, phone numbers, IBANs, **payment-card numbers**, dates, and
  web links. There is **no
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
  - **Date masking now accepts EITHER field order and a 2-digit year — the BL-N6 leak is closed (U2,
    audit §5.7).** For *redaction* (unlike extraction, which stays day-first) a candidate is masked when it
    parses in **day-first OR month-first** order, so a **US-ordered** `mm/dd/yyyy` value like `12/31/2026`
    now masks alongside its EU counterpart `31/12/2026`, and a **two-digit-year** form like `01.02.26` is a
    candidate and masks too. **Over-masking a date is the intended posture here** (a privacy-favouring miss
    is worse than an over-broad mask on a date-shaped token), the inverse of extraction's day-first-only
    stance — an impossible date (`99.99.9999`) still parses in neither order and is left alone. There is
    **no path where masked text is un-masked or a detected value reaches a log/audit** (the privacy posture
    is unchanged). Residual: a locale-aware, opt-in-by-category matcher is still part of the deferred
    higher-recall wave; the current all-orders masking is deliberately broad.
  - **Payment-card PANs are masked with a Luhn check (U2, audit §5.7).** A 13–19 digit run in the common
    print groupings (compact, or single-space/dash-separated groups — `4111 1111 1111 1111`,
    `4111-1111-1111-1111`) is masked as `[CARD]` when it passes the Luhn mod-10 check with its separators
    removed. The Luhn gate keeps false positives low; a run outside 13–19 digits (e.g. a 20-digit account
    number) or one that fails Luhn is left alone. Cards are masked **before** dates and phones so a PAN is
    never split by them, and **after** IBANs so an IBAN's BBAN digits are not re-read as a card. A card that
    fails Luhn (or one printed in an unusual grouping) is a documented miss — the conservative posture stands.
  - **Phone and IBAN coverage is broader but still pattern-bound (full-audit-2026-06-28 BL-N4; U2).** Phone
    masking catches **punctuated US/national 3-3-4 numbers** (`555-123-4567`, `1-800-555-1234`,
    `555.123.4567`) on top of the `+`-country and leading-`0` forms — but punctuation is **required** (a
    bare 10-digit run is left alone to avoid masking account/ID numbers), so a space-only or run-together
    national number can still slip. **U2 further guards the 0-leading branch (audit §5.7):** a
    **separator-less run of ≥9 digits** that begins with `0` is a reference/account number (a 0-leading
    invoice reference), **not** a phone, so it is left unmasked — this fixed the share-flow false positive
    that corrupted invoices; a 0-leading number *with* a separator still masks. The tradeoff is that a
    run-together 9+-digit 0-leading phone is now missed (the privacy-favouring choice over corrupting a
    figure). IBAN detection is **case-insensitive** (a lowercase compact `de89…` is masked), but a
    *mixed-case space-grouped* IBAN (unconventional) is not specially handled. The case-insensitive compact
    candidate matches a standalone alphanumeric run and is re-validated by per-country length after
    compacting, so a real IBAN **glued** to following alphanumerics with no separator (`de89…013000extra`,
    which does not occur in space-separated extracted text) fails the length check for a known country and
    is left unmasked — a documented residual. These remain best-effort regex detectors — the conservative
    miss-over-over-mask posture stands.
  - **Unicode print variants + the parenthesized US phone now mask (R8, skills-audit-2026-07-03 SKA-3).**
    The detectors used to run on the raw byte-verbatim text (D58), so the common Unicode print separators
    defeated exactly the identifiers redaction exists to mask: an **NBSP/narrow-NBSP/figure-space-grouped
    IBAN or card** yielded zero candidates, a phone with the **non-breaking hyphen U+2011** Word
    auto-inserts (or an en dash) never matched, and the most common US form **`(555) 123-4567`** had no
    branch — while the U2 dry-run/share-safe counts reported 0 for them. R8 closed this with a
    **same-length detection shadow** (match on a 1:1 ASCII-normalized copy — NBSP family → space,
    U+2011/U+2013/U+2212 → `-` — mask the original bytes at the same offsets), so the unmasked remainder
    stays byte-identical and every existing guard (Luhn, per-country IBAN length, the 0-leading reference
    guard, the punctuation anchors) applies to the Unicode twins unchanged; the `(ddd) ddd-dddd` branch
    was added punctuation-anchored. The R8 review hardened the mechanism (see security-model.md R8
    note): a shadow-joined neighbour (one NBSP away) can no longer UN-mask the IBAN/PAN inside a
    failed whole-span candidate (sub-span narrowing), and **en dash / minus in the original bytes are
    range/math typography, never phone/card punctuation** on a non-`+`-led, non-parenthesized match —
    so `Budget 10.000–15.000 EUR`, `05.2025–06.2026`, `PLZ 01067–01099` and a Luhn-lucky en-dash
    invoice-number range stay untouched. **Deliberately still out:** an en-dash-set bare/0-leading
    phone (`Tel. 0664–1234567`) is missed (the refusal above — miss-over-eating; the U+2011 and
    `+`/parenthesized en-dash forms mask); exotic Unicode separators beyond the six
    mapped print variants (e.g. hair/thin/ideographic spaces, U+2014 em dash as a digit separator),
    spelled-out numbers ("null sechs sechs vier…"), and RTL/bidi-reordered digits — the shadow maps only
    what real PDF/Word pipelines emit around identifiers; anything else remains the documented
    best-effort miss (the deferred higher-recall wave). Two residuals shared with the ASCII twins
    (unchanged by R8, now reachable via NBSP/figure space too): digit table CELLS joined by a single
    separator can merge into a Luhn-lucky `[CARD]` or a generic-country `[IBAN]` over-mask
    (privacy-favouring direction), and the review surfaced a **pre-existing** super-linear
    backtracking hazard in `IBAN_CANDIDATE_RE`'s grouped alternative on hostile uppercase runs
    (multi-second on a ~500 KB adversarial document, R7-identical, neither caused nor worsened by
    R8) — an open R-phase candidate for the vuln-scan linearization treatment.
  - **Informational dry-run + share-safe pre-scan (U2, audit §3.4/§3.5).** An INFORMATIONAL redaction
    question ("welche personenbezogenen Daten enthält das Dokument?", "what personal data is in here?")
    over a single document now gets a read-only **counts** answer (`scanRedactionCandidates` — the same
    detectors, run without writing a copy; per-category counts only, never a detected value) instead of the
    button deflection; an *action* ask keeps the deflection (the write tool stays user-initiated). The
    **share-safe-review** whole-document turn injects a deterministic whole-document PII count summary into
    the model prompt and **gates its "Likely low risk after review" verdict on non-truncated coverage** —
    a truncated read (the model was shown only the beginning) forbids the low-risk verdict. Since the
    whole-doc-truncation-fix Phase 1, an over-budget document with NO tree is covered whole via the **chunk
    map-reduce**, whose reduce turn carries the pre-scan block with NO gate (whole-doc coverage legitimately
    permits the low-risk verdict) — so the pre-scan now reaches the common over-budget case. Residual: a
    share-safe review of an over-budget document rescued via the deep-index **tree** map-reduce still does
    not carry the pre-scan block (a narrower edge case — ≥~50-page docs with a ready tree; its own coverage
    stamp still marks any truncation).

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
  - **A manifest `size_bytes` more than ~25% below the real file truncates the download**
    (BUG dl-size-cap-2026-07-03). `size_bytes` feeds a disk-fill body cap; the cap is now
    drift-tolerant (`size_bytes` + headroom), but a grossly-understated size still trips it near
    completion and then the resume fails the checksum. This is a **manifest-data** bug, not a
    downloader bug — capture the real hash + exact `size_bytes` with `verify-models --generate` (or
    from the HF LFS `X-Linked-ETag`/`X-Linked-Size`) from the actual file. *(Instance now fixed: the
    Qwen3.5 27B/35B wave hashes were wrong and their sizes understated by 5–8%; corrected 2026-07-03
    with real values captured from HF LFS — the 9B was already correct.)*
  - **Resume does not send `If-Range`.** A weight **re-uploaded upstream** between an aborted attempt
    and a resume splices two revisions and fails the checksum. It self-heals by discarding the `.part`
    and re-downloading, but does not detect the change up front — an accepted residual until
    `If-Range`/ETag revalidation lands (the `Content-Range` start is validated, which catches a
    wrong-offset 206 but not a same-offset content change).
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

- **Text / Markdown / CSV imports are capped at 64 MiB, separately from the 1 GiB document ceiling
  (PERF-4, full-audit-2026-06-29-followup; [`architecture.md`](architecture.md) §35).** Those parsers
  read the whole file into one UTF-16 JS string (CSV then derives the papaparse row array + the rebuilt
  joined text — ≈3 full copies at once), so a file near the 1 GiB `maxBytes` would exceed V8's ~512 MB
  string limit and OOM-crash the main process. The `textMaxBytes` ceiling (env `HILBERTRAUM_TEXT_MAX_BYTES`)
  makes an oversize text/CSV file hit the friendly "file too large" reject instead. PDF/DOCX/audio/image
  keep the full `maxBytes` (they stream / are page-bounded). A streaming line/row parser would lift the
  cap; the byte ceiling is the safe interim win.
- **The documents list is windowed, so the browser's find-in-page (Ctrl+F) only matches rows that are
  currently rendered (PERF-2, full-audit-2026-06-29-followup; [`architecture.md`](architecture.md) §36).**
  To stop the list DOM (and the per-row Radix menu-root state machines) from growing linearly with library
  size, the documents list virtualizes with `@tanstack/react-virtual` — only the rows in/near the viewport
  are mounted. An inherent windowing trade-off is that Ctrl+F can't find a document whose row isn't mounted;
  the in-app **section / smart-view filters** (which narrow over the full library, not just the visible rows)
  are the intended way to locate a document by name/attribute. Windowing engages only when a real scroll
  viewport is laid out — with none (e.g. a unit test rendering the screen standalone) the list renders every
  row. The trade-off is **deliberately not** applied to the chat transcript (its scroll-to-bottom /
  find-in-page / StreamAnnouncer behavior keeps it un-windowed for now).
- **Chat "Try again" optimistically drops the last answer before regenerating; it self-heals, never
  data loss (full-audit-2026-06-30 F7 — accepted).** `ChatScreen.onTryAgain` slices the last
  assistant turn from the view before calling `stream(...)`, so the regenerate looks immediate. If the
  regenerate IPC throws *before* the backend mutates, or the user switched conversations, that answer
  is briefly missing from the view while the DB still holds it. It is restored without any manual
  action: `stream`'s `catch` re-reads `listMessages(convId)` in place when the user stayed on the
  conversation, and the `activeId`-change effect re-reads on return when they switched away. Deferring
  a "defer the slice / force-refresh on failure" change keeps the immediate optimistic feedback.
  (architecture.md "Renderer robustness" Phase D.)
- **The session-boundary DB unlock/lock decrypt is still synchronous (PERF-1 scope; [`architecture.md`](architecture.md)
  §35).** The per-**import** document-cache crypto was made async (yields between 8 MiB chunks, so a large
  import no longer freezes the main process). The whole-DB decrypt on unlock / encrypt on lock — once per
  session, not per import — stays on the synchronous path because the `uncaughtException` crash-lock must
  re-encrypt the working DB *before* `process.exit` (an async lock couldn't finish first). On a very large
  workspace DB the unlock screen / "Lock now" can therefore still pause briefly; adopting the async vault
  siblings there (keeping a synchronous crash-lock) is a tracked follow-up.
- The per-import `jobs` map in `registerDocsIpc` is never pruned (tiny, ephemeral, per-process).
- `getSettings` does not type-guard stored JSON values (the privacy-critical network path is
  double-gated by the policy AND).
- `expandPaths` follows directory symlinks during import expansion.
- Sidecar port selection has a small TOCTOU window between `findFreePort()` and the spawn.
  `LlamaServer.start` retries a bind-class immediate exit ONCE on a fresh port (REL-1), and a
  transient bind race no longer arms the embedder/reranker start-latch (F4/F7) — so a single port
  collision self-heals; a losing-twice race fails just that one call (the next retries). The startup
  error is diagnosable via the captured stderr tail.
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
  - **Document import / re-index events no longer name the file (full-audit-2026-06-30 S1).**
    The Activity panel rows read a plain "Document imported" / "Document re-indexed" instead of
    interpolating the title/basename, because a user-chosen filename is **content** (it can be as
    sensitive as the text it labels) and the whole log is exported verbatim by the plaintext
    `activity-log.json` action. The event still records the `documentId` + `status` + `chunkCount`,
    so the row is fully resolvable from inside the app; only the human-readable name is withheld
    from the log, matching the chat (conversation title) and collections (project name) channels.

## Retrieval quality (Phase 21, [`rag-design.md`](rag-design.md) §11)

- **The E5 embedder runs WITHOUT its `query:`/`passage:` prefixes — a retrieval-quality ceiling,
  not just a floor problem (backend-audit-2026-06-27 DOC-3; [`rag-design.md`](rag-design.md)
  §12.1).** The model card prescribes asymmetric prefixes; omitting them compresses every
  embedding into a narrow cosine band, which has two consequences a maintainer hunting a
  retrieval-quality caveat should know. **(1) `ragMinSimilarity` stays 0 — a positive cosine floor
  is impossible (MEASURED 2026-06-10, §12.1 R3):** on the real `D:\` drive the relevant and
  irrelevant best-chunk cosine distributions OVERLAP (the ~0.87–0.94 band), so any positive floor
  drops real hits. **(2) The reranker is load-bearing for relevance, not optional polish:**
  relevance separation is delegated to RRF + the reranker (D12), so a workspace without the
  reranker GGUF provisioned keeps the raw, less-separated ordering. Latent improvement: a prefix
  migration would spread the distribution and make a floor meaningful (and lift the ceiling), but
  forces re-embedding every corpus — revisit only as a deliberate migration.
- **Reranker latency on CPU is significant (MEASURED): ≈ 24.7 s worst case** for a 12-candidate
  batch at the full truncation budget on a CPU-pinned i7-1185G7 (~2 s/candidate;
  `HILBERTRAUM_RERANK_SMOKE`, 2026-06-10) — a documents query visibly lengthens on a low-end laptop when
  the reranker is provisioned. Bounded by the candidate cap (≤ 2×`topKInitial`) + word-truncation
  budgets (the tuning levers); the reranker stays an opt-in (provision-the-GGUF) feature, never
  bundled by default. The `HILBERTRAUM_RAG_QUALITY` run is the evidence it earns the cost
  (rag-design §12.3).
- **The embedder/reranker failed-start latch is for a PERMANENT fault only — a transient port-bind
  race no longer arms it (full-audit-2026-06-29-postmerge F4/F7; arch GPU record §5.5b).** Each
  sidecar latches a failed start so it doesn't re-await the full health timeout on every call. That
  latch is meant for a corrupt/incompatible GGUF; it previously also armed for a transient
  port-bind race (the bind retry is bounded to ONE attempt, so a near-simultaneous chat + embedder +
  reranker + vision startup can lose the port twice). That **silently disabled all imports** (the
  embedder has no graceful degradation) / **all reranking** (a silent fall-back to fused order that
  even survived `suspend()`) for the session until lock/unlock. A bind-class start error is now
  excluded from the latch (`isBindRaceError`), so the next `embed()`/`rerank()` re-attempts on a
  fresh port. Residual: a GENUINE load fault still latches — for the embedder it clears on a
  workspace lock/unlock (replace the weight file and retry); for the reranker it persists for the
  session (reranking stays off, retrieval keeps the fused order) by design.
- **The FTS5 index duplicates chunk text inside the workspace DB** (a self-contained table was
  chosen over external-content on `chunks`' implicit rowid, which VACUUM may renumber). Bounded by
  the 1 000-chunk/file cap; encrypted at rest with the same DB file.
- **Keyword search is embedder-visibility-scoped by design**: a document whose vectors were
  produced by a different embedder is not keyword-searchable either, until re-indexed — that is
  the Phase-17 honesty rule, not a gap (`REINDEX_NEEDED_ANSWER` tells the user what to do).

## Document tasks & summaries (Phase 33, wave-3 plan §6)

_The **`audit §N.M`** citations in the skills/extraction residuals below refer to the **2026-07-02 Skills
& Tools audit**, folded (with its 20-phase remediation plan) into [`architecture.md`](architecture.md)
§39 — read them through that record's §-anchor legend._

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
- **The deep-index summary cache (`summary_cache`) is bounded by a row-count cap, not kept
  forever (backend-audit-2026-06-27 DATA-3/MAINT-3).** The cache maps a tree group's content
  hash → its computed summary so a rebuild — or a different document with identical boilerplate
  — skips the model call. It carries no `document_id` and deliberately survives node/tree/document
  deletion (so a rebuild stays cheap), which means no foreign key ever prunes it. To keep a
  long-lived portable drive from growing the table without bound, each tree build opportunistically
  evicts the oldest rows past **`SUMMARY_CACHE_MAX_ROWS`** (50 000 by default; env
  `HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS`) via `evictSummaryCache`. It is a cache, so an evicted row
  only costs a future re-summarize, never data loss; the per-session evicted-row count is exposed
  as content-free diagnostics (`summaryCacheEvictedThisSession`). v1 had no eviction at all (the
  audit's DATA-3) — this bounds it cheaply rather than precisely (eviction runs once per build,
  not on a timer).
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
  total). **A4 (SKA-7 structural, audit §3.2/§8.2) finished the inversion for tool skills:** with the
  bank/invoice skill active over a **single fully-chunked** document that **plausibly is** the skill's
  class (it matches the skill's manifest doc signals, OR a persisted extraction already exists for it),
  **every** non-small-talk question now reaches the handler — the phrasing (`routeMatch`) veto is retired,
  so an on-topic money question that **misses** the ~45-term vocabulary is answered from the **verified
  extract** (grounded-data, which post-W6 honestly declines an off-data question with "the data does not
  carry that") instead of silently degrading to raw top-k chunks + model arithmetic (the pre-W3 incident
  class, on the two highest-stakes skills). A document matching **no** signal and never extracted keeps the
  ordinary relevance path (the W2 plausibility posture, inverted — a contract with the bank skill sticky is
  never force-extracted on "who signed this?"); clear **small talk** ("danke") opts out too (no extraction,
  no narration). An **intent-shaped** question over a **multi-document** scope is narrowed or routed
  (**W2**, audit §2.1, recorded below). `document-redaction` is an action skill: it registers a
  **`routing`** handler (not an exhaustive one — D49a, 2026-06-22), so a redaction-shaped request
  returns a short answer pointing at its run button (no content read, no tool run, **no coverage
  badge**) instead of a top-k Q&A that lectured and falsely claimed a relevance-limited reading; the
  write tool stays user-initiated and confirm-gated. The Tier-1 **instruction** skills
  (meeting-protocol, contract-brief, share-safe-review, deadline-obligation-finder) register
  **`grounded-whole-doc`** handlers (skill-whole-doc engine, Wave 2, §20): an analysis-shaped request
  over a single in-scope, fully-chunked document streams a model answer over the **whole** document
  (read in order, not top-k) with the SKILL.md format applied, stamping honest `capped` coverage. A
  document larger than the context budget that has a **ready deep index** is answered by a skill-fenced
  **map-reduce over its tree** instead of truncating (`tree` badge — Follow-up A, §20); **without** a ready
  tree it is now covered whole by an on-the-fly **map-reduce over its raw chunks** (whole-doc-truncation-fix
  **Phase 1**, 2026-07-04 — `capped`/untruncated badge, "covers the whole document"), which **closes the
  "gap band"** where a document too large for a single read but too small to auto-build a tree was read from
  the beginning only. New residuals: (a) a very large document is covered whole up to a **raised** ceiling —
  since **follow-up #2** (2026-07-05) a window count between `SUMMARY_MAP_CALL_CEILING` (~12 windows, ~50
  pages) and `SUMMARY_MAP_CALL_HARD_CEILING` (~24 windows, ~100 pages) is no longer dropped: every mapped
  window's notes are **condensed** down through bounded fenced intermediate reduces (a hierarchical fold, cap
  `MAX_FOLD_DEPTH`) until they fit one final reduce, so the whole document is covered (`truncated:false`).
  Only **beyond** the hard ceiling (~100 pages) does the tail stay honestly beginning-only (`truncated:true`)
  — that is deep-index **tree** territory (the tree auto-builds at ~this size and is the designed rescue; the
  fold is a bounded query-time lever, deliberately not unbounded — the dominant cost is one map call per
  window on CPU, covered by the Phase 3 progress notice); (b) a mid-size analysis
  now costs 2–12 model calls (map windows + reduce) of extra latency before the first streamed token —
  since **Phase 3** (2026-07-05) that gap carries the ephemeral `'analysis'` progress notice ("Reading the
  whole document…"), fired in the shared map-reduce core only when a real map loop runs (`windows.length >
  1`) and cleared on the first reduce token, so it no longer reads as a hang; (c) on a small (4 k) window a
  very long deliverable used to be **output-cut**:
  since **Phase 2** (2026-07-04) the reduce output reserve is adaptive (`computeReduceBudget`) — it aims
  for `ANALYSIS_RESPONSE_RESERVE_TOKENS` (3072) so a brief completes in full on a ≥ ~8 k window, and on a
  4 k window it **yields the reserve toward `CHAT_RESPONSE_RESERVE_TOKENS`** (never below) so whole-document
  coverage is *preserved* and the *deliverable* shrinks instead (notes-first — Phase 1's gap-band closure
  survives at the default 4 k). **Since Phase 4** (2026-07-05) that output cut is closed by
  **continue-generation**: when the reduce stream ends `finishReason === 'length'` (cut at the ceiling, not a
  user Stop), the shared core re-prompts to FINISH the deliverable — re-sending the same fence + notes +
  question plus a resume anchor (the last ~200 chars, seam de-duplicated) — across at most
  `MAX_REDUCE_CONTINUATIONS` (2) extra passes, each output cap sized against the actual assembled prompt so
  `prompt + output ≤ n_ctx` still holds (no HTTP 400). Only a document whose notes cannot fit alongside even
  the floor output is notes-truncated (honestly badged `coverage.truncated` — the INPUT-coverage flag). The
  continuation engine was **extended to the single-turn grounded path** (follow-up #1, 2026-07-05): any
  grounded answer cut at the context ceiling — relevance top-k, the small-doc fits-budget read, or the
  whole-doc capped read — is now finished the same way (re-sending the whole grounded prompt + a resume
  anchor), so a mid-word grounded reply no longer persists as if complete. **New residual:** a deliverable
  long enough to STILL be cut after the 2-continuation cap keeps an honest **OUTPUT**-truncated badge
  (`Message.truncated`, "Answer truncated — model context limit reached") — this is distinct from
  `coverage.truncated` and never conflated with it (the whole document can be covered while the deliverable is
  output-cut). Guarantee unchanged: `prompt + output ≤ n_ctx` at every context size (no HTTP 400 "exceeds
  context size").
  **`what-changed`** registers a **`grounded-whole-doc-compare`** handler
  (Follow-up B): a compare-shaped request over **exactly two** in-scope docs reads BOTH versions whole
  (budget split size-aware across them, `capped` coverage — `truncated` when either overflowed) and
  presents them as labelled blocks, instead of top-k. A tree-backed compare (the §20 map-reduce applied
  per oversized doc *inside* the compare) remains a documented follow-up — today an oversized compared
  doc is read capped, not tree-reduced.
  **W1 (audit §2.2) made the beginning-read honest AND safe at the default 4096 context.** The grounded
  prompt now carries an explicit **partial-document notice** — the model is told "sections 1–N of M
  provided" and FORBIDDEN to assert an absence ("no decisions found") beyond them — so the answer text
  can no longer claim completeness (the compare fallback prints the notice **per truncated half**). The
  whole-doc AND compare budgets apply the same **1.5 German-subword safety divisor** the relevance path
  uses, so a budget-filling German (subword-dense) whole-doc turn no longer risks the raw
  `HTTP 400 exceed_context_size_error`. Consecutive **same-segment chunks are de-overlapped** (the known
  ~80-token chunk overlap stripped, metadata-gated on page/section) so the read stops wasting ~16 % of
  the scarce budget on duplicated text — and the compare-split sizing measures the same de-overlapped
  totals. The tree map-reduce, which formerly "lied at the margin" (hard-truncated its notes while
  stamping `truncated:false`), now flips to the honest `truncated`/"covers the beginning" badge and a
  softened reduce prompt when it hits the **12-call map ceiling** (`SUMMARY_MAP_CALL_CEILING`) or clamps
  its joined notes to the reduce budget. **Open follow-up (deferred by W1):** auto-building (or one-click
  offering) the deep index when a whole-doc turn truncates (the routing of lookup-shaped questions to top-k
  on truncation was since **done by A3** — the needle-vs-deliverable downgrade below).
  **W2 (audit §2.1/§3.4/§4.5) killed the silent doc-count fallthrough and added a document-plausibility
  gate — all deterministic, zero new model calls.** Before W2, when a tool/whole-doc skill was the turn
  skill but the in-scope document **count** was wrong (a multi-doc scope, or the default whole-library
  scope), `applies()` was false and the turn fell through **silently** to ~2 top-k passages dressed up as
  a whole-document read. Now, when the question is **intent-shaped** (a new doc-count-agnostic
  `SkillAnalysisHandler.intends()`) but `applies()` fails only on count, the chat path (`registerRagIpc`,
  before the existing dispatch) either **(a) narrows** to the ONE in-scope document that matches the
  skill's own **manifest doc signals** (`filenamePatterns`/`mimeTypes`, via the shared
  `matchesSkillDocSignals` in `selector.ts`) — proceeding against it with an honest scope notice
  **prepended to the answer** (`skills.analysis.scopeNarrowed`; the streamed grounded path carries it via
  a new `generateGroundedAnswer` **`answerPrefix`** option, also threaded through the tree-rescue path) —
  or **(b) routes** with a deterministic answer: `skills.analysis.selectOne` ("pick one document") when
  0/≥2 docs match, and `skills.analysis.selectTwo` ("select exactly two") for **`what-changed`** at ≠2
  docs (its SKILL.md no longer asks the *model* to police a scope it cannot see — §3.4). A **0-doc** scope
  is left on the ordinary relevance path (its own "no documents" honesty). The **plausibility gate**
  (§4.5): in bank/invoice `run()`, a **zero-row** extraction on a document that matches **none** of the
  skill's declared signals returns a `fallThrough` result, so the turn takes the ordinary grounded path
  (the LLM answers the actual question) instead of the misleading "I read the whole statement but couldn't
  find any transactions" template — the exact contract-with-bank-skill-sticky failure. Zero rows on a doc
  that **does** look like a statement/invoice keeps the honest empty answer; and — the conservative D56
  posture — a skill that declares **no** signals (or whose row can't be read) does **not** fall through
  (it keeps the empty answer, so a real statement whose rows merely failed to parse is never re-routed to
  a top-k model). **Residual (documented, A3 territory):** the financial skills declare a broad
  `application/pdf` MIME, so the discriminating signal in practice is the **filename** pattern — a
  contract *PDF* (matching the MIME) with the bank skill sticky still keeps the empty template rather than
  falling through; the fix stands for non-PDF/CSV docs and for the multi-doc narrow/route paths.
  **W3 (audit §3.1/§8.1) added the missing THIRD answer mode — an LLM answer over the deterministically
  extracted + validated invoice, with figures quoted verbatim.** Before W3 an invoice question hit either a
  fixed template (`buildInvoiceAnswer`, question-*agnostic* — "who is the vendor?", "wann ist die Rechnung
  fällig?", "warum stimmen die Summen nicht?" and a repeat follow-up all got the byte-identical totals
  template) or the raw-chunk relevance path; the extracted rows never reached the model. Now the invoice
  handler routes by ANSWER SHAPE (not document access — every shape reads the SAME extracted invoice): a
  **format** ask (`detectFormat`) serializes JSON/CSV/XML (unchanged); a **summary/reconcile/list** shape
  (a narrow, word-anchored stem list — `summar`/`überblick`/`zusammenfass`/`reconcil`/`aufstellung`/`list
  the items`/`positionen auflisten`/`\bstimm(en|t)\b`, with a `warum`/`wieso`/`why` explanatory guard so
  "warum stimmen die Summen nicht?" is NOT the template) keeps the deterministic **template**; **everything
  else** that passed `applies()` streams a model answer over the serialized verified object (a new handler
  outcome `{ mode:'grounded-data', dataBlock, postscript }`) via a new `generateGroundedDataAnswer`.
  `buildGroundedDataPrompt` hands the model `buildInvoiceJson` + the reconciliation results + a provenance
  note under FIXED rules (answer ONLY from the data, quote figures character-for-character, NO
  arithmetic/derived numbers, say plainly when the data lacks the fact, answer in the user's language) — the
  LLM **never computes a figure**, it narrates parsed data. Under every grounded-data answer the app appends
  a **deterministic totals postscript** (net/tax/gross as parsed, verbatim) so a model misquote is
  immediately contradicted; the **R5 date caveat also rides that postscript** (a due-date question now
  routes to grounded-data, so its honesty is preserved). **W6 (audit §3.1, SKA-5) then threaded the U1
  `droppedRowCount` into this mode**: the invoice data block gains a MISSING-lines note + a softened
  (non-"whole document") provenance line and the postscript appends the `countPartial` hedge whenever a
  money-bearing line was dropped (an invoice has no balance proof, so any drop hedges) — closing the gap
  where a `dropped>0` invoice answered "how many line items?" over the mode as if the list were complete.
  **W6 (SKA-21)** also fixed the totals/echo currency: a mixed-currency invoice with no header currency now
  stamps **no** code (via `invoiceTotalsCurrency`/`amountText`) instead of misleadingly using `lineItems[0]`'s,
  and no dangling space when the currency is absent. The grounded-data turn uses its OWN system prompt
  (`GROUNDED_DATA_SYSTEM_PROMPT` — no `[Sn]` excerpt-citation rule, since it carries a data object, not
  numbered excerpts) and REPLAYS conversation history, so follow-ups no longer re-trigger the byte-identical
  template. `buildInvoiceAnswer` also gained a **Details block** (vendor / invoice number / invoice + due
  date), so those header fields surface even on the template path (the "who is the vendor" gap dies on both
  paths). Citations + honest `extract` coverage pass straight through (source of truth = the deterministic
  extractor); the data block caps line items at ~150 rows (totals + header always kept). **W4 (audit
  §3.1 bank half / §3.3 / §3.6-low) ported the same third mode to the BANK handler** and closed the
  self-referential escape-hatch copy. The bank `run()` now routes by the same ANSWER SHAPE: a **format**
  ask (`detectFormat`) serializes the statement **inline** — new `buildStatementJson` (transactions +
  cashflow summary + opening/closing balances) or the existing `transactionsToCsv` (rows only) — closing
  the §3.3 gap that the bank template pointed at a CSV export the handler could never produce; a
  **summary / reconcile / total / balance / category / list** shape (a broader stem list than invoice —
  for a statement the **totals ARE the D56-gated headline**, so `total`/`summe`/`saldo`/`kontostand`/`net
  change`/`cashflow` stay on the completeness-gated **template**, plus `\bstimm(en|t)\b` and the
  `warum`/`wieso`/`why` explanatory guard) keeps the deterministic template; **everything else** streams a
  model answer over `buildStatementDataBlock` (the JSON + the balance-reconciliation + the **D56
  completeness verdict** + a deterministic per-category grouping + provenance, capped ~150 rows) with a
  **deterministic in/out/net postscript** (`buildCashflowPostscript` — empty on a mixed-currency statement,
  since there is no single meaningful total; the R5 date caveat rides it too). **W6 (audit §3.1, SKA-4/SKA-5)
  then made this postscript honour the D56 gate** the template already ran: the in/out/net echo prints only on
  `complete` (proven-whole) or `unverified` (with the `unverifiedCaveat` sum-of-rows-read line appended), and
  is **suppressed on `contradicted`** (mirroring the template's `incompleteNoTotal` refusal — no app-authored
  total under the model answer on a statement the balances refute). The `droppedRowCount` hedge also rides,
  but **D56 outranks it** (mirroring U1 / commit 42a4eb9): a `complete` balance proof means the dropped line
  did not move the balance, so **no** hedge fires; it fires only on a non-complete status, and the data block's
  MISSING-lines note + softened provenance follow the same gate. Its label was also corrected — the bank
  in/out/net are **computed sums** (`summarizeCashflow`), so the echo now says "Totals **computed** from the
  parsed transactions" rather than the old "verbatim from the document" (accurate only for the invoice echo,
  whose net/tax/gross **are** printed totals — audit §4.5). The self-referential
  `transactionsMore` copy now names the **real** affordances (the run-bar **Export to CSV** button for a
  saved file + "ask for it as CSV or JSON here in chat"), and the inline **CSV intros** (bank + invoice,
  §3.6-low) state honestly that CSV carries the rows/line-items only while the summary/balances (bank) or
  header/totals (invoice) ride in JSON/XML. Because a non-summary follow-up ("warum stimmen die Summen
  nicht?") now routes to grounded-data (the template can only PRINT figures, never EXPLAIN), a repeat
  intercept no longer re-serves the byte-identical template — pinned by a regression test on both handlers.
  The bank port added **no** extractor-version bump (the serializers are read-side; extraction output is
  byte-identical). **Residual:** bank has no statement **XML** serializer (JSON/CSV only, per the plan), so
  an "as xml" ask falls through to grounded-data rather than an inline XML block.
  **W7 (audit §3.2/§3.3/§3.4) tuned the answer-shape routing** (vocabulary + classifiers only, no
  extractor bump): (a) **SKA-9** German *separable* verb forms — "Fasse … zusammen" / "Liste … auf" — now
  reach the **D56-gated template** via word-anchored two-particle regexes on both handlers' `isSummaryShaped`
  (the joined `zusammenfass`/`auflisten` stems missed them); the preposition "auf" ("Liste die Buchungen auf
  dem Konto") over-fires to the template — the safe deterministic side, accepted. (b) **SKA-10** a
  WHY/how-come **format** question ("Warum fehlt im JSON die MwSt?") is now guarded by `EXPLANATORY_RE`
  **before** `detectFormat`, so it reaches grounded-data (which can explain) instead of re-serving the
  byte-identical serializer dump (the repeat-loop class W3/W4 killed on the summary path). (c) **SKA-20**
  the `spend on`/`spending on` stems were **dropped from `CATEGORY_KEYWORDS`**: "how much did I spend on
  groceries?" (the flagship grounded-data example cited across the W3/W4 record, the in-code comment, and a
  test) now routes to **grounded-data** (the per-category grouping still rides the block, so it stays
  answerable) instead of the category template — removing the tense-flip where the absent `spent on` reached
  grounded-data while `spend on` reached the template. The explicit "break down by category" ask keeps the
  template (`categor`/`breakdown`/`kategor`/`aufschlüssel`). (d) **SKA-7 (vocabulary half)** added route-only
  German money terms to the bank vocabulary (`wie viel`, `wie viele`, `zahlung`-stem, `bezahlt`, `ausgegeben`,
  `payment`) and `fällig`-stem/`due` to invoice, so an on-topic money/due question under an already-active
  tool skill reaches the handler instead of falling to raw top-k (§8.2 — route-only never touches the
  suggestion offer). **The STRUCTURAL half of SKA-7 was then closed in A4** (the tool-skill gate inversion
  above): with the skill active over a plausibly-in-class single fully-chunked doc, a phrasing miss no
  longer falls to top-k — it reaches the handler (grounded-data over the verified extract), so the widened
  vocabulary is now belt-and-suspenders rather than the sole guard.
  **U1 (audit §2.3 / ux-10 / ux-11 / §3.6) made the completeness claim honest and stopped silent row drops
  from masquerading as exhaustive reads.** The bank + invoice extractors now record an additive
  `dropped_row_count` per extraction (`bank_statements`/`invoices`, nullable — pre-U1 rows read NULL and the
  answer simply omits the gate) — how many money-bearing lines the parser **rejected** (a currency-less /
  empty-description / fused-amount / ambiguous-balance-as-amount row; a *money-shaped* token via the shared
  `hasMoneyToken`, so a bare reference integer never counts). A **leading date-SHAPE is required** for a bank
  line to count (`LEADING_DATE_SHAPE_RE` — the SHAPE, not a successful parse, so a mis-read `31.02.2026` /
  no-anchor `03.05.26` booking row still counts), so a memo / FX-reference continuation line (the geometry
  Valuta second baseline, whose DESCRIPTION leads) and a money-less header are excluded — they carry figures
  but were never transactions, and counting them would falsely gate a correctly-read statement. When `> 0`
  the deterministic answer **replaces the "across the whole statement" / "the whole invoice" headline** with
  an honest *"**N** read; **M** line(s) with figures I couldn't parse"* (`countPartial`, EN+DE du-form) —
  **except** when the D56 balance PROOF holds (`status === 'complete'`: printed opening + Σ == closing ties
  out over the kept rows, so a dropped line provably did not move the balance and the read IS whole) — the
  proof outranks the parse-gap hedge and the plain whole-statement count stands. A D56-**contradicted**
  statement uses a **`countContradicted`** headline instead of claiming "the whole statement" over a body that
  refuses a total — killing the self-contradicting count line (both the `complete`- and `contradicted`-status
  interactions were caught by U1's adversarial diff review). The currency-adjacent bare-integer read
  (R1's `totalsMoney` fallback, now the shared `lastCurrencyAdjacentInteger`) is **extended to bank balance
  lines** (`lastMoneyOnLine`), so a round `Opening balance 914 $` feeds the §3.5/D56 completeness gate instead
  of silently losing it. **Both extractor versions → 8.** The **"Every match found …"** structured-extract
  coverage badge is softened to **"Read across …"** (ux-10 — it overclaimed *exhaustive extraction*; a small
  model / odd layout can miss a match), and the **empty-extraction copy** no longer dead-ends — it blames the
  reader not the document and names the next step (OCR a scan; else the layout may not be machine-readable).
  U1 originally gated only the deterministic **template** headline; **W6 (audit §3.1, SKA-5) composed the same
  `droppedRowCount` honesty into the grounded-data mode** (data-block MISSING-lines note + postscript hedge,
  both domains), so the count/list questions the third mode owns no longer silently revert U1 — the bank side
  honouring the D56-outranks rule (a `complete` proof suppresses the hedge). See the W4 bullet above.
  Finally, every shipped SKILL.md body is **reordered so its honesty/safety rules LEAD the first content
  paragraph** (they used to trail, so the budget-driven fence trim — which keeps leading paragraphs —
  silently decapitated them, §3.6) — **U7 (SKA-15) then closed the residual**: the U1 layout still put the
  rules in paragraph[1] while the builder's guaranteed minimum is paragraph[0] only, so a tight budget
  shipped an intro promising rules with none delivered; heading + intro + bullets are now ONE paragraph and
  the parity test trims the REAL bodies through `buildSkillFence` at a rules-only budget — and the
  `buildSkillFence` **`trimmed`/`omitted` flags are now LOGGED**
  (ids/counts only, `logSkillFenceReduction`) at every call site instead of discarded, so a decapitated-rule
  turn is diagnosable. **Residuals (documented):** `droppedRowCount` uses the parser's own `MONEY_RE`
  definition of a figure, so a **round-integer-only** line with no decimal and no currency marker (a bare
  "Office supplies 500") is still not counted — it is genuinely indistinguishable from a quantity/reference;
  and the fence trim/omit surfaces only in the **log**, not yet as a coverage-meter badge (the renderer /
  `CoverageInfo` surface is outside U1's file scope — a follow-up).
  **A3 (audit §6.3/§8.2) made the whole-document engine manifest-declared and INVERTED its gate, so it is
  no longer chosen by per-skill phrasing.** Before A3, whether a skill read the whole document was decided
  by hardcoded app handlers keyed on install ids **and** per-skill, per-language keyword arrays — so every
  phrasing gap silently degraded a whole-document ask to top-k-with-fence (the recurring incident class),
  and **any user-imported instruction skill got top-k only**, never the whole-doc engine (§6.3 "skills are
  portable in name only"). A3 adds an additive manifest field **`analysis: whole-doc | compare | none`**
  (`shared/skill-manifest.ts`, default none, lenient) that an **instruction skill of any source** declares;
  the five bundled instruction skills declare it in SKILL.md (a consistency test pins each declaration to
  its registered handler's mode), and a user-imported instruction skill reaches the SAME engine via
  `manifestAnalysisHandler`. Tool registration stays **app-only** — this is an **engine choice, not a
  capability** (SEC-1 unchanged; a user `kind:'tool'` skill still runs no tool, and the share-safe PII
  pre-scan stays app-keyed). The **gate is inverted** (`registerRagIpc` + `analysis/whole-doc-skills.ts`):
  with an analysis-mode skill active over a matching **fully-chunked** scope the whole-doc (or, at exactly
  two docs, compare) engine is the **DEFAULT**; keywords now play only two skill-agnostic roles —
  **(a)** `isSmallTalk` **opts out** clear chatter (a greeting/thanks/assistant-meta keeps the relevance
  path), and **(b)** `isNeedleShaped` sends a targeted single-fact **lookup** to top-k when the whole-doc
  read would truncate (a needle past the truncation cut would be missed — W1's exact budget calculus is the
  input); a **deliverable** ask (summary/minutes/compare/…) never downgrades.
  **A4 (audit §3.2/§3.3) tuned this composition (SKA-8/SKA-12/SKA-23):**
  **(SKA-8)** the `intends()` predicate — the **W2 count-mismatch routing** gate, consulted only at the
  wrong doc count — was decoupled from `applies()` and made **vocabulary-shaped** (`routeMatch`) for the
  whole-doc/compare handlers too (it had been `!isSmallTalk`, which made the W2 pre-pass intercept **every**
  non-chatter question at multi-doc scope — a sticky instruction skill over a Library turned "who is Angela
  Merkel?" into a "pick one document" dead-end and made the relevance/coverage-extract engines unreachable).
  Now, at a wrong doc count, only a **vocabulary-shaped** question narrows/routes; a general/off-topic one
  **falls through** to the ordinary engines. `applies()` keeps A3's single-doc inversion (any non-chatter
  question over ONE doc still defaults to the engine). A user-imported skill has no routing vocabulary, so it
  never W2-routes (falls through) but still gets the single-doc engine.
  **(SKA-12)** the needle downgrade **dropped the "no ready tree" conjunct**: a needle prefers top-k
  whenever the whole read would truncate, **tree or no tree** — a ~13-call map-reduce over lossy node
  summaries is worse than one top-k retrieval for a single-fact lookup (the tree keeps rescuing
  **deliverables**, which never reach the downgrade).
  **(SKA-23)** the needle downgrade is now evaluated **before** the D45 fully-chunked refusal for
  grounded-whole-doc handlers: a downgraded needle takes the relevance path, which makes **no** whole-document
  claim, so D45's premise (a partial whole read passed off as complete) doesn't apply — a needle over a
  not-fully-chunked doc is served by top-k, not refused; a **deliverable** over a not-fully-chunked doc keeps
  the whole read and still hits the refusal.
  **Residuals (documented):** the off-topic opt-out is a bounded **small-talk** detector, so a genuinely
  off-topic but non-chatter question (e.g. "what colour is the sky?") over a fully-chunked doc — under an
  instruction skill, OR now under a tool skill via the SKA-7 inversion when the doc is plausibly in-class —
  spends a whole-document/extract read and answers "not covered" / "the data does not carry that" rather than
  degrading to top-k, the accepted cost of recall over precision once the user has **explicitly** selected the
  skill; a **row-specific needle** past the tool skill's ~150-row data-block cap gets the honest "N omitted"
  note rather than the row; both shape classifiers are heuristic keyword lists (deliberately conservative — a
  false needle is worse than a false deliverable), so an unusual phrasing of a needle over an over-budget doc
  can still take the truncated whole-doc read (honest via W1's in-prompt "beginning only" notice); and the
  needle downgrade is applied to the single whole-doc path only (**compare** keeps its whole-both read).
- **Bank-statement extraction reads PDF GEOMETRY (Stage 1; architecture.md "Skills — design record"
  §21, Phase 31, D50–D58).** A columnar PDF statement (date · description · amount, with the year in the page header)
  used to arrive as scrambled reading-order text, so almost no transaction survived the line-oriented
  parser (the user-reported HVB "zero transactions" failure). The bank-statement skill now re-parses
  the PDF in a **layout mode** that rebuilds visual rows from pdf.js word coordinates and emits clean,
  year-resolved `DD.MM.YYYY` rows — **deterministic, offline, zero model calls** (`parsers/pdf-layout.ts`).
  Enabled for **bank-statement only** (D58 — invoice/redaction/preview keep byte-unchanged reading-order
  text); `parseDate` is untouched (the year is resolved during reconstruction, §3.2). A **booking-date
  column model** (`detectDatumColumn`) keeps a row from being mis-read as a transaction unless its LEAD
  date sits in the statement's leftmost, densest date column — so a value-date (Valuta) column printed
  on a second baseline, with a foreign-currency reference amount hidden in its description, is no longer
  emitted as a spurious row (the Raiffeisen "Mein ELBA" over-extraction the gold set surfaced). A line
  matching an opening/closing **balance label** (incl. `Kontostand per/am/zum <date>` — all three
  prepositions, skills-remediation R2 §5.4) is treated as a summary and never counted as a transaction
  even when it carries a booking-column date + figure (it is read only by the completeness gate). **Column clustering is still heuristic** (statements vary; an unusual
  column geometry can mis-read a row), so a **completeness gate** (D56, refined by **D56-R** 2026-06-25)
  classifies every answer into one of three outcomes. A **VERIFIED statement total** is presented **only
  when the printed opening + Σamounts == closing balance ties out** (a clean per-row running-balance chain
  is necessary but not sufficient) — `complete`. When the document makes a balance CLAIM the rows refute
  — a non-tying printed opening/closing, or any per-row balance mismatch — the skill **refuses a total**
  and downgrades to an honest "couldn't confirm the whole statement" message (EN+DE) — `contradicted`.
  But when the statement prints **no opening/closing balance at all and nothing contradicts the read**
  (e.g. an online "Umsätze" transaction listing), the skill now presents the figures under an explicit
  caveat — *"a sum of the N rows I read, not a verified statement total"* — rather than refusing a
  perfectly honest number — `unverified`. The cardinal property is unchanged: a number a user could
  mistake for THE statement total never comes from an incomplete read; a clearly-labelled sum of the rows
  shown is not such a number. A bounded transaction listing trails every non-empty answer so the user can
  see the rows that were read. (Before D56-R the no-balance case was refused outright — the over-cautious
  behaviour the bug report flagged.)
  **Stage 2** (a grammar-constrained local-LLM fallback on the residual hard subset, D52/D55) is **not
  built**, but is **expected to be needed eventually** — it lands only if the Stage-1 deterministic
  recall on the local-only gold set (D57) proves insufficient. On the current (small) gold set — three
  text-layer statements (sanitized HVB excerpt, a full Raiffeisen "Mein ELBA", an HVB "Umsätze" page)
  plus one image-only scan — Stage 1 records **0 hallucinated/partial totals and 0 model calls**, the
  gate presents the correct VERIFIED total on the one statement that prints opening/closing balances; the
  two balance-less statements now present `unverified` labelled sums (under D56-R; before the refinement
  they were refused), and the scan degrades safely (0 rows); the live recall/gate numbers are kept in
  `architecture.md` §21, not duplicated here (re-measure locally to refresh them under the refined gate). The corpus is still too narrow to close D52; because real
  layouts vary widely (no-printed-balance statements, ruled/borderless tables, scans), deterministic
  geometry will likely miss some, so Stage 2 should be treated as a **probable future need** — broaden
  the gold-set corpus across more banks/layouts to confirm and trigger it (it is gated, not abandoned).
  **Known boundaries (all SAFE — no wrong total is ever shown):** (1) **[RESOLVED 2026-06-25 for the
  `<date> <currency> <balance>` shape.]** A statement that prints a **per-row running-balance** line shaped
  `<date> <currency> <balance>` (date in the booking column) used to be over-extracted — the balance row
  was mis-read as a phantom transaction. The **currency-token class** now keeps the bare currency code out
  of the description, so the phantom row's description is empty and it is dropped, while a genuine row
  whose payee wrapped onto a continuation baseline is rescued by **multi-baseline row association** (the
  same HVB "Umsätze" fix that recovers lost payees, strips the per-row `EUR`, and folds a separate
  debit/credit sign cell into the amount). The 2026-06-24 finding still holds — the balance and amount are
  right-aligned in one numeric column, so a "money-column model" could not have separated them; the
  token-class + association fix did. **Residual (safe):** a genuine **no-payee** row whose booking line is
  a bare `<date> <currency> <amount>` with no continuation below is indistinguishable from a phantom and is
  also dropped — a recall loss, never a wrong total. (2) An
  **image-only / "blacked-out" or scanned** statement has no text layer, so geometry-aware extraction
  recovers nothing and returns the honest empty/downgrade (never a wrong total); reading it is the OCR
  path's job, not Stage 1. (3) When a PDF producer renders one **amount as two split items** (`2.000` +
  `,00`), neither fragment parses as money, so the row carries no amount and is dropped — the transaction
  silently vanishes (a recall loss). When the statement prints opening/closing, the dropped row breaks the
  tie → `contradicted` → no total; on a balance-LESS statement, D56-R presents an `unverified` sum
  under-counted by the dropped row (honest per its caveat, no longer a refusal). The scoped fix is an
  x-adjacency money re-merge (deferred). The same `architecture.md` §21 entry pins the
  two tuning-constant boundaries (a row whose baselines jitter past the 3-pt tolerance loses its amount; a
  Datum/Valuta gap under 12 pt merges, allowing a spurious row). (4) **[RESOLVED 2026-06-29 follow-up,
  FIN-3 — the balance-as-amount harm.]** The geometry `DATE_TOKEN_RE` used to BACKTRACK a bare-thousands
  amount (`2.500`) into a date and DROP it as an out-of-column value-date, so a `<date> X 2.500 1.000,00`
  row reconstructed as `…X 1.000,00` and the line parser read the running **balance as the movement amount**
  (a confidently-wrong figure). Requiring a year to be preceded by its own dot makes `2.500` un-date-able, so
  it survives into the reconstructed line and the shared `MONEY_RE` (which reads bare-thousands/apostrophe)
  parses it. **Residual (safe):** the geometry `MONEY_TOKEN_RE` was deliberately NOT widened to accept
  bare-thousands (widening would make the split-amount boundary (3) emit a wrong figure — `2.000`+`,00` →
  amount 2000, cents lost), so a row whose **ONLY** figure is a no-cents bare-thousands / apostrophe token
  carries no money token at the classifier and is dropped — a recall loss, never a wrong figure (it
  reconstructs correctly whenever a 2-dp figure also anchors the row, e.g. amount + cents balance).
  (5) **[skills-audit-2026-07-03 R7, SKA-13 — dot-decimal `d.dd` amounts.]** A yearless `d.dd` token
  (`5.04`, `1.12` — the CH/UK/US small-amount forms) is BOTH date- and money-shaped; date-first
  classification ate it as an out-of-column date, so dot-decimal statements reconstructed with the
  running balance as the row's only figure (balance-as-amount) or lost the row. `parseTransactionRow`
  now re-reads such a token as MONEY under **four row-context guards** (out of the Datum band; after
  description text — a dotless VALUTA next to the booking date stays a dropped date; before any
  money-class token; and only on rows with no numeric-TEXT token and no comma-decimal money — an
  apostrophe/bare-thousands "text" figure or a de-AT comma amount on the row keeps the honest legacy
  drop, since reclassifying beside them re-created balance-as-amount in the adversarial R7 review).
  Raw-text and continuation rows keep the conservative date-first read (a kept `d.dd` on a raw line
  could re-enter the line parser as a spurious leading date; a continuation must still absorb its
  wrapped text). **Residuals:** a layout printing a dotless yearless Valuta AFTER the description on a
  dot-decimal statement is shape-identical to `<desc> <amount> <balance>` and still mis-reads (every
  observed Valuta form prints adjacent to the booking date, with a trailing dot, or with a year); and
  the Datum-band bootstrap vote counts ambiguous `d.dd` tokens as dates, so a page with MORE
  date-plausible dot-decimal figures in one band than booking dates could in principle mis-place the
  band (pre-existing lens gap; ties break leftmost, which protects every constructed real layout).
- **The bank/invoice LINE PARSER makes deliberate locale/column assumptions (full-audit-2026-06-28
  Phase 1, BL-N1/N2/N3 + DECISION 2).** The deterministic line parser shared by the bank and invoice tools
  (`tools/money.ts`, distinct from the geometry pass above) carries these accepted behaviors, all pinned by
  adversarial whole-string tests:
  - **Date locale is INFERRED per document, with day-first as the default.** A document is read month-first
    (US `mm/dd/yyyy`) only when it contains an **unambiguously** US-ordered date (a `nn/nn/yyyy` whose
    *second* field is 13–31) and no unambiguously EU-ordered one; otherwise the de-AT **day-first** default
    holds. So a US statement no longer **silently drops** day>12 rows or attaches a wrong month — BUT a
    document whose dates are **all** fully ambiguous (every field ≤ 12, e.g. only `03/05/2026`) is read with
    the day-first default and a genuinely US value there reads as the wrong month. **This is no longer silent
    (skills-remediation R5, audit §5.7):** the extractor records a statement-level `date_order_inferred`
    flag (`'evidence'` | `'default'`, additive nullable column on `bank_statements`/`invoices`) — set to
    `'default'` exactly when the order was NOT fixed by a clean unambiguous vote AND an order-ambiguous
    dotted/slashed date was actually read — and the deterministic answer then appends **one honest caveat
    line** ("this statement gives no sign whether the dates are day-first or month-first, so I read them
    day-first…", en + de, du-form). The **residual** is that the caveat is document-level: there is still no
    PER-ROW channel (the tool output schema is frozen), so a single ambiguous date among evidence-bearing
    ones is read day-first without an individual flag. The vote is **scoped by line kind (full-audit-2026-06-29
    follow-up FIN-4)**: a MONEY-bearing line (a transaction row) votes only on its **leading** date column(s),
    so a foreign-format date in a payee MEMO can no longer flip the whole document's order (which used to
    silently day/month-swap every dotted booking date); a MONEY-less header/label line (an invoice `Invoice
    date 06/15/2026`, a statement period) still votes on any date it carries, so labeled US-invoice dates are
    detected. **Redaction takes the opposite stance** — it masks a date-shaped token that parses in EITHER
    order (over-masking is privacy-favouring there; see the redaction date bullet, U2), rather than inferring
    a single locale.
  - **Two-digit-year and bare dates complete against a document year anchor; cross-year statements roll over
    (skills-remediation R5, audit §5.7).** A `dd.mm.yy` (2-digit year) or a BARE `dd.mm.` date now parses on
    the plain/CSV path (previously `parseDate` dropped BOTH — a `dd.mm.yy` CSV statement extracted **zero
    rows**) — but **only when the document supplies a fully-printed 4-digit-year date** as an anchor
    (`inferDateAnchor`): the century is taken from the anchor for `yy`, and a bare date takes the anchor year.
    Without such an anchor a 2-digit/bare date is still **DROPPED** (drop-don't-guess stands). A bare date
    additionally gets **cross-year month-rollover**: a December/November row on a January/February-anchored
    statement is assigned the **previous** year (the mirror case, the next year), so a statement whose period
    spans year-end no longer stamps one page year on every bare date. This mirrors the geometry path's
    `toFullDate`/`resolvePageAnchor` (which gained the same rollover). **R5 left one gap, closed in R7
    (skills-audit-2026-07-03 SKA-1/SKA-2):** while R5 made `dd.mm.yy` documents a first-class *parsed*
    cohort, every date **scrub** stayed 4-digit-year-only — a `dd.mm.yy` token is money-shaped to
    `MONEY_RE` (`31.03.26` → 3103.26), so a balance/totals line's trailing `per 31.03.26` was read as the
    figure, `Datum: 15.03.26` became a phantom invoice item, money-less dd.mm.yy period lines inflated
    `droppedRowCount`, and a MID-LINE date on a period line (`01.04.2026 bis 30.04.2026`, both year forms)
    was read as an invented transaction/line-item amount by the row money scan. R7 widened both
    `DATE_TOKEN_RE`s with a double-guarded 2-digit-year alternative (`\b` + `(?!\d)(?![.,']\d)` — the
    lookahead accepts terminal punctuation, `per 31.03.26.` / `vom 15.03.26, …`, while refusing a "year"
    that continues into digits or a separator-plus-digit) and runs the row parsers' money scan over a
    SAME-LENGTH date-blanked copy of the line (`scanMoneyWithBlankedDates` — byte offsets preserved, so
    description slicing and figure-region currency detection are untouched; a match's trailing sign/paren
    is re-validated against the ORIGINAL bytes, so a blanked billing-period range after the amount —
    `1.500,00 01.04.2026 - 30.06.2026` — can never read the range dash as a trailing debit minus). Two
    behavior notes from the R7 adversarial review: **(a)** a spaced dash between an amount and a
    FOLLOWING date now reads positive-as-printed (the dash is treated as the range separator; before, the
    date's digits blocked the trailing-minus lookahead AND became a phantom second figure — both readings
    were wrong, the new one is the honest half of BL-1's documented ambiguity); **(b)** the document
    currency vote gained a deliberate widening: a code IMMEDIATELY left of a line's first figure
    (`<desc> EUR 19,15-`, the per-row currency-cell layout) now votes — the scrub widening had removed
    such dd.mm.yy lines' only (accidental) vote, extracting ZERO rows; the FIN-1 memo exclusion is
    unchanged. Descriptions now retain a mid-line/trailing date verbatim (previously the date's digits
    were mis-read as figures; the bytes are kept — cosmetic input to the categorizer). Both extractor
    versions → 9. **Residual:** the anchor is the FIRST
    fully-printed date in document order — a document whose first 4-digit-year date is in a foreign century
    (an old memo date) would expand `yy` into that wrong century (the same first-date-wins risk the geometry
    path already carries); and rollover keys only off the anchor month, so a genuinely multi-year listing with
    no clear period anchor is not disambiguated per-row.
  - **A wrapped description is stitched onto the row it belongs to (skills-remediation R6, audit §5.7).** On
    the plain-text / CSV path a merchant/payee (bank) or line-item (invoice) description that wrapped onto the
    NEXT line — a dateless, money-less follower — used to be **silently dropped** (the row kept only its
    booking-line fragment, degrading the categorizer and the listing). It is now **appended** to the row above
    as a bounded continuation — the plain-text mirror of the geometry **multi-baseline association** — so a
    `SEPA-Lastschrift` row whose `NETFLIX INTERNATIONAL B.V.` payee printed below reads its real payee.
    Bounded to **one** continuation line (the plain path has no column geometry to confirm the association, so
    it is deliberately more conservative than the geometry `MAX_CONTINUATION_ROWS` of 4): a second follower
    line does not glue, and a balance/header/totals/summary line, a blank line, a figure-bearing line, or the
    next row **closes** the association. The association is **per page/segment** — `pending` is scoped to one
    chunk (each chunk is one page on the real path) and never survives the segment boundary, exactly like the
    geometry `reconstructPage` per-page flush, so a repeated column header or footer at the top of the next
    page can never glue onto the previous page's last row. `BANK_EXTRACTOR_VERSION` → 7,
    `INVOICE_EXTRACTOR_VERSION` → 7. **Residual:** a genuine footer/prose line sitting immediately under the
    last row on the SAME page with no boundary between them can still be absorbed (bounded to one line, and
    never a wrong figure — it is description text only).
  - **Line-item column debris is cleaned only when arithmetic confirms the split (skills-remediation R6,
    audit §5.7).** A common invoice table prints `<rowIndex> <description> <qty> <rate>% <unitPrice>
    <lineTotal>`, where the row index, the quantity and the tax-rate percent are **bare** tokens `MONEY_RE`
    ignores, so they stayed glued to the parsed description (`1 Web hosting 12 Monate 1 0%`) — a first-class
    defect once JSON/CSV/XML made the line-item structure a deliverable. The leading row index is stripped and
    the trailing `<qty> <rate>%` run is split into `quantity` + a new optional `taxRatePercent` — but **ONLY**
    when the recovered quantity reproduces the printed line total from the unit price
    (`quantity × unitPrice ≈ lineTotal`, within half a cent). When the identity fails — the audit probe
    `1 Web hosting 12 Monate 1 0% 76,17 914,00` (1 × 76,17 ≠ 914) — **nothing is cleaned**: the description is
    left exactly as parsed (drop-don't-guess, §22-D1), and single-figure rows (no unit price to check against)
    are never cleaned. The recovered `taxRatePercent` is surfaced in the JSON/XML serializers and the
    extract-output schema; it is **not** persisted (the line-item table's columns are unchanged — out of the
    phase's tools-only scope), so it survives only within a fresh extraction. The persisted **and** exported
    win is the **clean description** and the correctly-assigned `quantity`/`unitPrice`. `INVOICE_EXTRACTOR_VERSION`
    → 7 (shared bump with the wrapped-description change above).
  - **The amount column is chosen by POSITION, not the first money-shaped token.** With a running balance
    present (≥2 figures on the row) the parser takes the **second-to-last** figure as the movement amount
    and the last as the balance; with one figure that figure is the amount. So a money-shaped reference in
    the *description* no longer steals the amount/sign — but on an unusual layout (e.g. two amount columns
    and no balance, or a description figure that lands in the amount slot) the position heuristic can still
    pick wrong. The **geometry column model** (above) is the stronger separator where it runs; this is the
    plain-text / CSV / invoice fallback.
  - **An UNCAPTURED amount column drops the row rather than promote the balance (full-audit-2026-06-29-
    postmerge F1).** A whole-euro amount (`50`) or single-decimal (`12,5`) is rejected by the 2-dp money
    scan, so a `Sparen 50 1.234,56` row collapses to ONE money token — the *balance* — and the position
    heuristic above would otherwise read the running **balance as the movement amount** (off by the whole
    balance magnitude — the cardinal confidently-wrong-money harm). The fix is **statement-context-aware**:
    a row with one money token whose description ends in a bare number is *flagged ambiguous* and dropped
    **only when the statement has a balance column** (some other row prints a running balance). On a
    **no-balance "Umsätze" listing** the lone token genuinely IS the amount, so a numeric-ending payee
    (`KARTENZAHLUNG REWE … 1234 -19,15`) is **kept** — dropping it would regress the flagship geometry case.
    **Residual:** a balance-column statement whose row legitimately has a missing balance AND a numeric-
    ending payee is dropped (a recall loss, never a wrong figure); and a *lone* `Sparen 50 1.234,56` with no
    other balance-column row to establish context keeps the old read (it cannot be distinguished in
    isolation). The invoice path mirrors this on the **opposite** side — it reads the line total as the LAST
    figure, so it drops a row with an uncaptured numeric column to the **RIGHT** of the line total
    (`Hosting 12,50 500` → the real total `500` lost) and a bare number to the LEFT is treated as a quantity.
    The right-side drop is scoped to a trailing token that is **itself** a money-shaped-but-rejected bare
    amount (full-audit-2026-06-29 follow-up FIN-2): the region after the last money match must be ENTIRELY
    one such token, so a valid item with a trailing **annotation** (`Service 12,50 (Pos. 3)`, `Beratung
    1.234,56 19% MwSt`, `Line 50,00 EUR 2 Stk`) is **kept**, not deleted by the earlier "any trailing digit
    drops" rule.
  - **Every parsed figure is normalised to 2 decimal places (full-audit-2026-06-29-postmerge T5).**
    `parseAmount` rounds each figure to the nearest cent so `Math.round(x*100)` is its EXACT integer-cent
    value — the load-bearing premise of the completeness/reconcile tie-out math and the CSV `toFixed(2)`.
    A printed figure with a 3rd decimal (only reachable via the both-separator `1.234,567` form) is read to
    the nearest cent (`1234.57`), **not dropped** — a sub-cent normalisation, never a confidently-wrong
    magnitude. (Single-separator 3-digit-group thousands forms `1.000`/`12.345` are integers, unaffected.)
  - **Unicode "side doors" are normalized to ASCII before any figure is read (skills-remediation R1,
    audit §5.3; `money.ts normalizeExtractionText` at every extractor entry, mirrored in the geometry
    path's `pdf-layout.ts rowTokens`).** A Unicode minus — U+2212 / en dash U+2013 / non-breaking hyphen
    U+2011 — becomes `-`, so a `−45,90` debit signs **negative** instead of reading +45,90 (debits were
    parsing as credits). The no-break-space thousands family — NBSP U+00A0 / narrow NBSP U+202F / figure
    space U+2007 — becomes an ASCII space, so `1 234,56` reads **1234,56** whole instead of truncating to
    234,56 (a 1000× error). The Swiss U+2019 apostrophe becomes `'`, so `1’234.56` reads 1234.56. The
    pre-pass is a **no-op for ASCII** (existing fixtures byte-identical) and **idempotent**. Extractor
    versions bumped (`BANK_EXTRACTOR_VERSION` → 4, `INVOICE_EXTRACTOR_VERSION` → 4) so stale rows re-extract.
  - **A figure's sign is read by the SPACE around a minus (full-audit-2026-06-29 BL-1).** A **glued**
    trailing minus is a de-AT debit (`45,90-` → −45,90, even with a running balance after it); a `-<digit>`
    after a space is the next figure's **leading** sign (`2.500,00 -500,00` → +2500 then −500). This
    replaced an earlier trailing `-?` that reached across the column gap and stole the next figure's leading
    minus, flipping both signs while the running chain still tied out (a confidently-wrong total `ok`-rated
    by reconciliation). **Residual:** the genuinely-ambiguous **spaced** trailing minus immediately before a
    balance figure (`45,90 - 1.908,20`) reads as a *positive* amount — no parser can distinguish it from
    subtraction; the glued de-AT convention (`45,90-`) is the unambiguous one and is read correctly.
  - **Per-row currency is detected only in the FIGURE REGION (full-audit-2026-06-29 BL-2; extended to the
    invoice path by full-audit-2026-06-29-postmerge F3).** The row's currency is read from the text
    **at/after the first money token**, not the free-text description, so a payee memo mentioning `USD`/`$`
    on a EUR statement no longer tags that row a foreign currency (which used to suppress the whole
    statement's total + reconciliation). The **invoice line parser** now matches the bank path (the BL-2 fix
    was never applied to it): `USD adapter cable 12,50` on a EUR invoice reads EUR, not USD. A genuine
    foreign-currency row whose code/symbol prints **next to** the amount is still detected (mixed-currency
    honesty preserved). `validateInvoiceTotals` gained the **single-currency guard** the bank gate already
    had — line totals across **mixed** currencies are reported `lineItemsSumToNet: unknown` rather than
    summed into a meaningless cross-currency figure. **Residual:** a foreign symbol **glued immediately
    before** the only figure with no other adjacency (`$50,00` as a row's sole token) can be missed and
    falls back to the document currency — harmless on a single-currency document, a rare mis-tag on a truly
    mixed one. The **document-level fallback currency** (used when a bare-amount row prints no figure-adjacent
    code — the de-AT norm) is now a **MAJORITY VOTE over figure-adjacent detections** (full-audit-2026-06-29
    follow-up FIN-1; `money.ts detectDocumentCurrency`), not the old "first allowlisted code anywhere in the
    document wins". A money line votes only on its figure region (a code in a payee memo, LEFT of the amount,
    is excluded); a money-less header/label line (`Währung EUR`) votes on its whole text. So a stray `USD` in
    a memo can no longer stamp a whole EUR statement — and its VERIFIED total — with the wrong currency.
    **Residual:** a statement that prints **bare amounts and declares its currency nowhere** except inside a
    transaction memo (no header declaration, no figure-adjacent code) yields no document currency → its rows
    are dropped (honest recall loss, never a wrong currency).
  - **Grouped figures without a 2-dp decimal are read as thousands.** A bare `1.000`/`2.500` (de-AT dot =
    thousands), space-grouped `1 234 567,89`, and Swiss-apostrophe `1'234.56` are now read whole. The
    trade-off (accepted, DECISION 2): a **dotted/grouped reference number** in a description — `Rechnung
    2.024` — is now money-shaped (2024) where before it was not, and **space**-grouping can fuse a
    *standalone* 1–3-digit token with a following 3-digit-led figure across a space (`12 300,00` →
    12300,00). A digit group that is the **tail** of a longer token — whether after a digit
    (`778899 300,00`) or a letter (`Ref123 456,78`) — is prevented from fusing by the parser's
    word-boundary anchors; only a genuinely *standalone* short group abutting the amount can still fuse.
    These are recall/precision trade-offs on the
    plain-text path, never a wrong **verified** statement total (the completeness gate still requires the
    printed opening + Σ == closing to tie out). **On the geometry-less INVOICE path** (no completeness gate,
    no balance backstop) a space-grouped token **without a 2-dp decimal tail** (`Widget 10 100` → `10 100`
    → 10100) is treated as a likely column fusion and the row is **DROPPED** (full-audit-2026-06-29-postmerge
    F6) — a real line total almost always prints cents. A decimal-anchored space group (`1 234 567,89`) is a
    real figure and is kept; a space group **with** a decimal (`15 799,00`) stays the accepted trade-off
    (indistinguishable from a real 15 799,00).
  - **A LABELED invoice totals line reads a ROUND total printed WITHOUT a decimal (invoice-totals-2026-07-01).**
    `MONEY_RE` rejects bare ungrouped integers (so a reference number in a description is never read as money),
    which also meant a very common invoice layout — `Total (excl. Tax) 914 $` / `Tax 0 $` / `Total (incl. Tax)
    914 $` — produced an **empty** net/tax/gross block, and the skill answered *"the invoice doesn't print a
    net, tax, or gross total I could read"* on a perfectly clear bill. A net/tax/gross-**labeled** line now
    falls back to the last **currency-adjacent** bare integer (`totalsMoney`): the currency symbol/code touching
    the number is the safety anchor that keeps a stray reference/registration integer (a VAT id `ATU81420204`, a
    `0%` rate) off the totals, while the label already scopes the read to a totals line. **Line items are
    unchanged** — an unlabeled row's bare integer stays ambiguous and is dropped (§22-D1). A **qualified** total
    resolves by its tax phrasing: `Total (excl. Tax)` / "net of tax" → the **net**, `Total (incl. Tax)` → the
    **gross** (`EXCL_TAX_RE`), so a layout that prints both no longer collapses onto the gross alone. The
    abbreviated header label `No.:` no longer leaks its `.:` into the parsed invoice number. **The
    bare-integer fallback keeps the SIGN (skills-remediation R1, audit §5.7-low):** a credit-note total
    printed without a decimal — `Gesamtbetrag -914 EUR` — now reads **−914** (a leading `-`/paren or a
    trailing minus around the integer is honoured via `parseAmount`), not the old +914. `INVOICE_EXTRACTOR_VERSION` → 4.
  - **Invoice totals/header labels match STRUCTURALLY, not as bare prefixes (skills-remediation R2, audit
    §5.2 CRITICAL + §5.4).** A label matched at a line start only when a word boundary follows it
    (`labelBoundaryOk`), so the canonical Austrian tax-advisor line **`Steuerberatung Jänner 500,00 EUR`**
    is no longer swallowed by the `steuer` prefix (which stole its 500 into `taxTotal`, deleted the line
    item, and discarded the real totals block) — it is the line item it is. A label is treated as a
    **totals** line only when its remainder is essentially just the figure (`isFillerOnly`): tax
    qualifiers / currency / `%` may follow, but a real description ("Netto-Miete Objekt 3 1.000,00",
    "Total hours consulting 40,00") means the line **falls through to `parseLineItem`** and stays a line
    item. Header matching is money-gated in two steps: R2 gated only the **date** labels (`Due diligence
    review 2.000,00` — a date label only consumes when a date actually parses), while the **vendor/number**
    labels still consumed unconditionally — `From 01.06.2026 to 30.06.2026 Hosting 49,00` ("from" is a
    vendor label) or `Rechnung Nr. 2026-14 vom 03.05.2026 über 1.500,00 EUR` was swallowed whole: the item
    deleted, `droppedRowCount` NOT incremented, garbage in vendor/invoiceNumber (the 2026-07-03 audit's
    SKA-14; the earlier wording of this bullet overstated R2's fix). **Closed in R7:** `applyHeader`'s
    vendor/number branches fall through on any line carrying **amount-shaped** money
    (`carriesAmountShapedMoney` — a 2-dp decimal figure, or any money token beside a named currency), so
    a figure can never silently vanish behind a header claim. The gate deliberately does NOT fire on a
    bare dotted/thousands GROUP with no currency (`Rechnung Nr. 26.001` — a real DACH `yy.nnn` numbering
    convention — or `Lieferant: Firma 1.000 GmbH`): the adversarial R7 review showed a plain
    `hasMoneyToken` gate INVENTED a €26,001/€1,000 line item from those header values, the inversion of
    the harm this fix closes. **Residual:** a genuine 2-dp figure inside a vendor/number VALUE
    (`Rechnungsnummer 2026/1.234,56`) falls through and is read as a figure — §22-D1 prefers reading a
    printed 2-dp figure as a figure over silently discarding it. `INVOICE_EXTRACTOR_VERSION` → 9. Totals
    are **last-block-wins** (a real
    invoice prints its totals after the items). The German summary vocabulary is extended — `Summe`,
    `Gesamtsumme`, `Rechnungssumme`, `Endsumme`, `Endbetrag`, `summe netto` — and a summary-line guard
    (`isSummaryLabelLine`, mirroring the bank `isBalanceLabelLine`) drops phantom "Summe" items so a
    summary line never becomes a line item while the totals stay empty. `INVOICE_EXTRACTOR_VERSION` → 5.
  - **A trailing number is split as `quantity` only with corroboration (full-audit-2026-06-29-postmerge
    F8, invoice path).** A product-coded description (`iPhone 15`, `Calendar 2026`) used to have its
    trailing number greedily read as a quantity. The split now requires a **unit token** (`x`/`Stk`/`pcs`/…)
    OR a **unit-price column** (a second money token) to corroborate it — so `iPhone 15 1.799,00` keeps
    "iPhone 15" as the description while the columnar `Widget A 2 12,50 25,00` still reads quantity 2. The
    financial `lineTotal` was never affected — this is a metadata fix.
  - **Balance/total lines scrub a TRAILING date before reading the last figure (BL-N2).** Opening/closing
    balances and invoice totals are read as the **last** money token on the line, so a figure followed by a
    trailing date — `Endsaldo 1.234,56 EUR per 30.06.2026` — would otherwise mis-read the date
    (`30.06.20` → 3006.20) as the balance. The last-money readers (`lastMoneyOnLine` / invoice `lastMoney`,
    `tools/money.ts`) now call `stripDateTokens` first, removing every date-shaped token at **either** end
    before the money scan, so the printed figure wins for both the date-leading `Kontostand per <date>
    <figure>` and the date-trailing shape. (This is why the backend-audit §24/§10 "last-token readers were
    never affected" claim was wrong — corrected there: only the *date-first* shape was ever safe.)
  - **A balance-less row still ADVANCES the running-balance chain (full-audit-2026-06-30 C1).**
    `reconcileBalances` carries a `sinceLastPrinted` cents accumulator: a mid-statement row with a real
    amount but no printed running balance (same-day grouping — the bank prints the balance only on the
    day's last line — or an OCR-dropped balance cell) is reported `unknown` (it prints no balance of its
    own to check) but its amount is folded into the **next** printed balance's expected value. The earlier
    code dropped the gap row from the chain, so the next balance-bearing row was judged against a stale
    predecessor with the gap amount **omitted** → a FALSE `mismatch` → `assessCompleteness` returned
    `contradicted` and a correct, verifiable total was **withheld** (the inverse of the confidently-wrong
    harm, equally trust-damaging). A genuine read error still surfaces as a `mismatch` when the carried
    total disagrees with a printed balance. **No persisted-figure change** (`BANK_EXTRACTOR_VERSION`
    unchanged) — reconciliation runs on read, so row statuses / the `reconciled` flag re-validate
    automatically. **Residual:** because `amount` is required on every row, the chain is never "genuinely
    broken" by a missing amount, so a row whose balance was dropped AND whose amount the parser failed to
    read drops earlier (the row vanishes, a recall loss) rather than reaching reconciliation.
  - **A `0.00` row is neither inflow nor outflow (full-audit-2026-06-30 C5).** `summarizeCashflow` totals
    positive amounts as inflow and negative as outflow; a genuine zero counts toward neither, matching
    `categorizeRow`'s `Uncategorized` fallback for a zero amount (the two surfaces previously disagreed —
    the summary's `>= 0` test counted a zero as inflow). The reported totals are unchanged (the figure is
    zero); only the internal attribution is now consistent.
- **Bank-statement categories are model-assisted, not verified (Phase 33).** The per-category breakdown
  is assigned by a local LLM constrained to a **fixed category set** (it can never invent a label; any
  uncertain/unparseable output drops to `Uncategorized`), so a category may be **wrong** — but a mislabel
  only shifts the breakdown, never the **verified statement total** or the **D56 completeness gate** (which
  read the signed amounts, not the labels). The breakdown is shown with an explicit "model-assisted" note.
  With **no model loaded** it degrades to the deterministic rule pass (a smaller, coarser category set).
  The deterministic rules match German keywords **inside closed compounds** (full-audit-2026-06-29 BL-3:
  `kontoführungsgebühr`→Fees, `gehaltszahlung`→Income) via a one-sided word boundary on the unambiguous DE
  keywords (`gebühr`/`gehalt`/`überweisung`/`bargeld`), while short English tokens (`fee`/`atm`) and the
  ambiguous `lohn` keep a strict two-sided boundary. **Transfer boilerplate does NOT veto the model
  (R3 / audit §5.5):** `sepa`/`überweisung` describe the payment rails, not the merchant, so most de-AT
  rows carry them; they are marked `confident: false`, so with a runtime loaded those rows go to the
  15-category LLM (Netflix, rent, a doctor refund no longer all collapse into one `Transfer` bucket). With
  **no model loaded** the deterministic fallback still labels them `Transfer` (coarser, but honest offline).
  **Residuals:** `lohn` is NOT compound-matched (so a
  `monatslohn` *debit* is not deterministically Income — a positive salary is still caught by the sign
  fallback), and the compound `gehalt` could in principle over-match a non-salary compound
  (`alkoholgehalt`) — neither moves a verified figure, only the model-assisted breakdown.
  Categorization runs in the **doctask lane** (D26 — one job at a time), so it cannot run while chat
  streams. Categories are grouped on a **canonical English identifier** (stable across UI locale — the
  enum and the model-assisted detection key on it), but the breakdown **display labels are localized**
  (EN + DE); a future user-defined category with no catalog entry falls back to its raw name.
- **A "categorize … as CSV/JSON" chat turn now serializes WITH the category column, but chat still
  cannot write the file, and the columns are fixed (result-tables plan, Phase 1 — 2026-07-05).** The
  bank format answer categorizes FIRST (persisting, with the honest model-assisted / rule-based note
  under the fenced block — D63) and both CSV surfaces (the inline answer and the confirm-gated export
  button) emit each row's category through one generic table serializer (D60); the column is
  **presence-gated** (D62) — a never-categorized statement keeps its prior 7-column shape rather than
  implying an all-blank categorization. Remaining limits: (a) ~~the file write stays a UI-lane
  action~~ — **closed by Phase 2 (same day)**: a bank format answer now persists its structured
  table (`result_tables`, purged with its message) and carries a message-level **"Export CSV"**
  action that writes it via the standard save dialog — though only answers produced AFTER Phase 2
  carry a table (no backfill), and only the bank format path emits one so far (invoice port
  pending); (b) ~~the column set is fixed~~ — **closed by Phase 3 v1 (same day)**: "… als CSV mit
  einer Spalte Empfänger" pays ONE grammar-constrained parse + a batched per-row fill over the
  whole statement; derived cells are model-filled labels (honesty note under the fence), blank
  where the model was unsure, and ride the persisted result table + message export. Limits: needs
  a running model (offline → the plain table); CSV asks only; ≤ 4 columns; values are not
  persisted on the transactions themselves (re-asking re-pays the fill; the result table persists
  per answer); a plain "als CSV" stays 0-model via the deterministic pre-gate — extra columns must
  be signalled with a column-shaped phrasing (Spalte/column/subcategory/payee …); (c) **without
  the skill active** a tabular ask still routes to top-k relevance, not whole-document — routing
  it through extract-then-enrich needs a generic row extractor that does not exist yet (deferred,
  plan §5).
  **Phase 1.5 (same day) added USER-DEFINED category sets from the prompt** ("Kategorisiere in Miete,
  Lebensmittel, Kinder und Sonstiges … als CSV"): the enum-constrained categorizer runs INLINE in the
  chat slot with the user's labels (+ the `Uncategorized` drop target), persists them as non-builtin
  categories, and reuses a prior run when the persisted labels fit the requested set. Limits: it
  **requires a running model** (with none the ask is refused with friendly copy echoing the parsed
  set — the deterministic rules cannot know the user's labels); the parse is deliberately
  conservative (a categorize stem + ≥ 2 plausible labels; one malformed token rejects the whole list
  rather than categorizing into garbage); a custom label is a MODEL-ASSIGNED label (the honest
  model-assisted note rides every answer; totals and the D56 gate are untouched); and a large
  statement pays the per-batch model latency inside the chat turn (the ephemeral "reading…" notice
  covers the gap, but there is no per-batch progress meter in chat — the "Categorize" button lane
  has one).
  **Phase 1.6 (same day): the taxonomy can live in an imported CSV** — "Kategorisiere nach den
  Kategorien in `taxonomie.csv`" finds the file BY NAME across the indexed library (never by widening
  scope), parses one label per line (2–40; an optional keyword column becomes the model-prompt gloss —
  the accuracy lever), and refuses honestly, naming the file, when it is missing or not parseable as a
  list. Caveats: with NO explicit scope the chat layer's filename auto-scope can narrow the turn to the
  taxonomy file itself and the handler falls through to relevance — select the statement (or keep it in
  scope) when referencing a taxonomy file; a filename with spaces must be quoted; the file's labels are
  otherwise subject to the same model requirement and honesty notes as an inline custom set.
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

- **A similar version pair is compared by a deterministic word-level diff (mode d).** When the two
  documents share most of their text — the real "what changed" case — a Myers word diff finds the
  EXACT changes (down to a single deleted word) and drives both the chat answer and the materialized
  report; the model only interprets the changes into business language, so it can no longer miss a
  subtle change or dismiss repetitive/placeholder text as "identical" (compare-diff record,
  architecture.md §20). The limitations below apply to the FALLBACK modes, which run only when the two
  documents are too different / too large for a precise redline (a rewrite, not a version bump).
- **The diff direction is A→B by a deterministic, honestly-labelled pair — never a guessed old/new
  (audit §5.1, fixed R4).** The app cannot know which of two selected documents is the newer one, so it
  no longer claims to. "Removed"/"Added" follow the A→B order the documents are supplied in: the doctask
  uses the user's explicit A/B selection; the chat *what-changed* path orders the pair **deterministically
  by import date** (`ORDER BY created_at, id`, via the one shared scope helper — no more no-`ORDER BY`
  private query) and labels the blocks `Document A/B: "title" (imported <date>)`, instructing the model
  never to call either the "old" or the "new" version. The *set* of changes is always correct; the
  direction is now stable across runs and truthfully labelled, instead of an unspecified SQL row order
  asserted to the model as exact old→new fact (which could invert a whole report).
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
- **The report covers the BEGINNING of document A when it is very long (fallback modes only).** In the
  asymmetric path the map ceiling (12 calls, the summary's bounded-latency rationale) caps coverage; the
  report itself carries a visible notice when that happens. (The symmetric path can also truncate — a
  lopsided pair with many unmatched sections can overflow the reduce input — in which case it carries its
  own, document-neutral truncation notice instead.) The diff-driven mode (d) does NOT cap this way — it
  reads both documents whole — so a similar version pair is compared in full regardless of length (up to
  the `wordDiff` `maxWords` guard, beyond which it falls back to these modes). Both documents stay fully
  searchable. In the chat diff path, stored chunks overlap by ~80 tokens, so a change landing exactly in
  an overlap region may be listed twice — cosmetic, never a missed change.
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
- **Transcription runs on the CPU at roughly real-time ÷ 1.5 (RTF ≈ 0.67).** Measured (R-W4, small
  model, 4 threads, the reference CPU): a 52-minute meeting took ~35 minutes; peak memory ~1.2 GB. The
  import shows honest "Transcribing… N%" progress and the app stays usable meanwhile.
  GPU-accelerated whisper is a possible later opt-in, never a default risk.
- **A wedged or cancelled transcription self-recovers — it cannot hang the import slot**
  (backend audit 2026-06-27, REL-1). A whisper child that stops producing any output for
  15 minutes (env-tunable) is killed by an inactivity watchdog; because a healthy run emits
  `-pp` progress continuously, this only trips on a genuinely spinning/hung child, never a
  slow-but-advancing one. Cancelling the import (e.g. locking the vault mid-job) also aborts
  the in-flight child immediately. Either way the one document fails friendly and the import
  loop continues. **The watchdog/abort/suspend kills now escalate SIGTERM → SIGKILL after a
  2 s grace (full-audit-2026-06-29, REL-2)**, so a `whisper-cli` wedged in native code that
  ignores SIGTERM is still forced down and the ingestion slot freed. `suspend()`/`stop()` (vault
  lock / app quit) additionally bound their cleanup wait at 10 s: in the vanishingly-rare case a
  child ignores even SIGKILL, teardown returns anyway rather than hanging quit, and the unshredded
  `.parse` transcript transient is reclaimed by the next startup crash-sweep (the documented backstop).
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
  whisper small model's real-time factor — on a short clip nearer RTF ≈ 0.5 (R-W3 measured
  ≈ 0.43–0.46 on short German benchmark clips; a long sustained file runs slower, ≈ 0.67 /
  real-time÷1.5, see "Audio transcription" above), so a 15-second dictation takes a few
  seconds to land. A warm whisper-server mode is the recorded
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
- **One dictation at a time, and a wedged child can't hang the mic forever** (backend
  audit 2026-06-27, REL-3). A second mic press while a dictation is still transcribing is
  refused with friendly copy rather than spawning a concurrent whisper child. A child that
  is still running past a 10-minute wall-clock ceiling (env-tunable; the recording is already
  capped at ~35 min of audio) is killed and the composer gets the friendly failure instead of
  a perpetual spinner.

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
- **A single crafted/huge page can't wedge OCR for the session** (backend audit
  2026-06-27, REL-2). tesseract.js recognitions are serialized through one worker and a WASM
  job isn't cooperatively cancellable, so a page that exceeds a 2-minute per-page ceiling
  (env-tunable) — or a Cancel landing mid-page — terminates the worker (recreated lazily on
  the next page) and fails that OCR task friendly; the engine recovers for the next document.
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
  missing/corrupt projector) fails `weightsVerified`. The in-app `DownloadManager` now fetches **both
  files (GGUF + mmproj) as one job** (DIST-1) — `planDownload` enqueues the language GGUF then its
  `mmproj` projector, the job's `totalBytes`/`receivedBytes` cover both, and a finish of a
  half-installed vision model (GGUF already present, projector missing) fetches just the projector
  (`downloads.test.ts`). The `fetch-models.{sh,ps1}` scripts remain the offline/CLI two-file path.

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
- **A pure-code-block streamed answer announces nothing to screen readers until completion
  (full-audit-2026-06-30 F6 — accepted).** The streaming `StreamAnnouncer` (a visually-hidden
  `role="log"`) feeds AT only completed sentences, falling back to a word boundary once a
  terminator-less tail grows past a soft cap (so tables / lists / run-on prose now announce
  incrementally). But `stripMarkdown` collapses code/markup to spaces, so an answer that is **only**
  a fenced code block strips to ~nothing and stays quiet until the final turn re-renders — voicing
  code punctuation token-by-token is worse a11y than silence. Any surrounding prose still announces
  normally; the visible bubble shows the code in full. (architecture.md "Renderer robustness" Phase D.)
