# Documentation Audit Report

## Metadata

- **Audit date:** 2026-06-29
- **Repository branch:** `master`
- **Commit hash:** `4846963`
- **Command used:** `/docs-audit`
- **Scope audited:** Documentation only — `CLAUDE.md`, all root `.md` docs (`README.md`,
  `SECURITY.md`, `PRIVACY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`,
  `CLAUDE_HilbertRaum_MVP.md`, `BUILD_STATE.md`), and every doc under `docs/` (architecture,
  rag-design, security-model, design-guidelines, known-limitations, user-guide, packaging,
  model-policy, model-benchmarks, drive-layout, troubleshooting, benchmark, big-slot-embeddings-plan,
  design-review/skills-s12/README). `LICENSE` text body not line-audited (presence verified).
- **Auditor note:** This is a **documentation-only** audit. Application code was inspected **only** to
  verify factual doc claims (commands, scripts, package names, env vars, folder structure, the
  `allowNetwork` default). No application code was modified and no code changes are recommended except
  where a doc disagrees with how the code actually behaves.
- **Report status:** **Open** — findings recorded, none yet remediated.

## How to use this report

- `/docs-audit` creates and updates this report (the durable source of truth for documentation issues).
- `/docs-fix` should fix **one phase or one set of findings at a time**, then update this report.
- **Every fix must update this report** — set the finding's `Status` and append a row to the
  **Remediation log**.
- **Findings are never deleted.** Mark them `Fixed`, `Verified`, `Blocked`, or `Superseded` instead.
- Finding IDs (`DOC-001`, …) are **stable** and are never reused for a different issue.

## Executive summary

**Overall documentation health: very good.** This repository's docs are unusually well maintained.
The doc-lifecycle discipline in `CLAUDE.md` (fold completed plans into §-numbered design records,
delete the plan file, keep stable §-anchors) is visibly followed: the large design docs
(`architecture.md`, `rag-design.md`, `security-model.md`, `known-limitations.md`) are current
(header dates 2026-06-29), internally consistent, and cross-referenced correctly. Root user-facing
docs (README, SECURITY, PRIVACY, CONTRIBUTING, CHANGELOG, CODE_OF_CONDUCT) are accurate against the
code: verified the `package.json` scripts/engines, the `scripts/` directory contents, the model
manifest catalog (9 chat + embeddings + reranker + transcriber + vision), the CI workflow, the
runtime pin (`llama.cpp` b9585), and the directory structure — all match the docs.

**Biggest strengths**
- Self-honest, deviation-aware docs: the F16-vs-Q8 embeddings change, the dropped Qwen3-1.7B model,
  and the frozen-spec banner are all explicitly reconciled rather than silently drifting.
- Strong cross-doc consistency on the model catalog, licensing (all Apache-2.0 / MIT), security
  posture, and the offline/no-telemetry guarantees.
- Clean, deterministic broken-link surface in the **published** docs (root + `docs/`): **zero**
  broken relative `.md` links among them.

**Highest-priority risk (the one real accuracy bug)**
- **DOC-001:** the model-download **user setting default** is documented inconsistently. The code
  default is **ON** (`DEFAULT_SETTINGS.allowNetwork: true`, fresh install), and README / PRIVACY /
  security-model / architecture / `user-guide.md §10` all say "on by default". But `model-policy.md`
  (in-app-downloader gate 2) says **"default OFF"**, and `user-guide.md §5` says **"off by default"**
  — the latter making `user-guide.md` **contradict itself** (§5 vs §10). For a privacy-focused
  product, a wrong statement about when network access is on is the most important thing to correct.

**Most important contradictions**
1. DOC-001 (above) — the only contradiction that disagrees with the code.
2. None of the large design docs contradict each other or the root docs (verified).

**Most important missing docs**
- Nothing critical is missing. The doc set is complete (setup, dev workflow, testing, packaging,
  security, privacy, architecture, troubleshooting, known limitations, release/contribution). The
  only gaps are navigational: two maintained docs are absent from the README doc index (DOC-004).

**Recommended first phase:** **Phase 1 (DOC-001)** — fix the model-download-default wording in
`model-policy.md` and `user-guide.md` so they match the code and the other docs. Small, safe,
highest value.

**Estimated effort:** Low overall. All six findings are wording/link/navigation fixes; none require
restructuring. ~1–2 short `/docs-fix` sessions total.

## Document inventory

| Document | Apparent purpose | Status | Notes |
|---|---|---|---|
| `CLAUDE.md` | Operating manual: read-order, doc-lifecycle rule, hard rules, stack, per-phase ritual, commands | Good | Commands verified against `package.json`. Accurate. |
| `README.md` | Front door: status, DIY setup, model catalog, dev map, doc index | Good | Verified scripts, structure, model table (9 chat models), Node ≥22.5, b9585 pin. Doc index omits 2 docs (DOC-004). |
| `SECURITY.md` | Security policy + local threat model summary | Good | Last updated 2026-06-29; consistent with `security-model.md`. |
| `PRIVACY.md` | Plain-language privacy notice | Needs update | Last updated 2026-06-20. One circular "below" cross-reference (DOC-003). Network-default wording is correct here. |
| `CONTRIBUTING.md` | Ground rules + dev workflow | Good | Verified CI path, Node version, script↔TS mirror rule. |
| `CHANGELOG.md` | Pre-1.0 release history | Good | Version `0.1.34` matches `package.json`. Tag range dated to 2026-06-22 (informational; see note). |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 | Good | Standard, internally consistent. |
| `CLAUDE_HilbertRaum_MVP.md` | Frozen original spec (intent) | Good | Clearly banner-marked as frozen; deviations reconciled. |
| `BUILD_STATE.md` | Live dev log of record | Needs update | ~9 broken links to deleted plan files (DOC-002). Otherwise the authoritative state file. |
| `docs/architecture.md` | System design + audit design-record ledgers | Good | Current (2026-06-29); cross-refs valid. |
| `docs/rag-design.md` | Retrieval pipeline design + records | Good | Current (2026-06-29). |
| `docs/security-model.md` | Threat model, vault, offline guard, audit log | Good | Current (2026-06-29); matches SECURITY.md + code. |
| `docs/design-guidelines.md` | Design system + UI design records | Needs update | Header "ADOPTED 2026-06-10" lags body (records to 2026-06-19) — DOC-005. Not in README index — DOC-004. |
| `docs/known-limitations.md` | Consciously-accepted gaps | Good | Current (2026-06-29). |
| `docs/user-guide.md` | End-user walkthrough | Contradictory | Last updated 2026-06-20. §5 vs §10 self-contradiction on network default (DOC-001). |
| `docs/packaging.md` | Portable build, sidecars, scripts, CI, manual gate | Good | Verified scripts, flags, b9585, CI section vs `ci.yml`. |
| `docs/model-policy.md` | Manifest schema, catalog, license/runtime pinning | Contradictory | "User setting default OFF" disagrees with code + other docs (DOC-001). Otherwise accurate. |
| `docs/model-benchmarks.md` | Benchmark protocol + measured results | Good | Phase-29 record; historical counts (e.g. "10 catalog weights") are correctly phase-scoped. |
| `docs/drive-layout.md` | On-drive layout + how the app finds data | Good | Last updated 2026-06-20; matches `drive.ts` layout. |
| `docs/troubleshooting.md` | Common problems and fixes | Good | One soft network-default phrasing note (DOC-006, low confidence). |
| `docs/benchmark.md` | In-app hardware-benchmark feature (Phase 7) | Good | Accurate, but not in README index + name-collides with `model-benchmarks.md` (DOC-004). |
| `docs/big-slot-embeddings-plan.md` | The one sanctioned **open** plan (Phase 30) | Good | Reconfirmed open 2026-06-29; correctly exempt from the delete-when-done rule. |
| `docs/design-review/skills-s12/README.md` | Deferred run-surface eyeball residual | Good | Honest "deferred, not faked" residual; intentional open item. |

## Findings index

| ID | Title | Severity | Confidence | Category | Status | Affected document(s) | Phase |
|---|---|---|---|---|---|---|---|
| DOC-001 | Model-download default documented as OFF; code + other docs say ON | Medium | High | Accuracy / Consistency | Open | `docs/model-policy.md`, `docs/user-guide.md` | 1 |
| DOC-002 | `BUILD_STATE.md` links to ~9 deleted `*-plan.md` files | Low | High | Navigation | Open | `BUILD_STATE.md` | 2 |
| DOC-003 | PRIVACY.md circular "described under *Encryption* below" reference | Low | High | Clarity / Navigation | Open | `PRIVACY.md` | 2 |
| DOC-004 | README doc index omits `benchmark.md` + `design-guidelines.md`; benchmark name collision | Low | Medium | Navigation / Completeness | Open | `README.md`, `docs/benchmark.md`, `docs/design-guidelines.md` | 3 |
| DOC-005 | `design-guidelines.md` header date lags its body (~9 days) | Low | High | Accuracy / Staleness | Open | `docs/design-guidelines.md` | 3 |
| DOC-006 | troubleshooting.md "network access is off by default" phrasing | Low | Low | Clarity | Open | `docs/troubleshooting.md` | 3 |

## Detailed findings

### DOC-001: Model-download user-setting default documented as OFF; code and other docs say ON

- **Status:** Open
- **Severity:** Medium
- **Confidence:** High
- **Category:** Accuracy / Consistency
- **Affected document(s):** `docs/model-policy.md`, `docs/user-guide.md`
- **Affected section(s):** `model-policy.md` → "The in-app downloader (Phase 18)" gate 2;
  `user-guide.md` → §5 "Downloading a model (optional, off by default)" (heading + body) vs §10
  "Privacy & offline".
- **Related code or config checked:** `apps/desktop/src/shared/types.ts:251` —
  `DEFAULT_SETTINGS.allowNetwork: true`; `apps/desktop/src/main/services/downloads.ts:25` comment
  ("default ON"). (Note: `apps/desktop/src/main/ipc/registerDownloadIpc.ts:16` carries a **stale code
  comment** "default off" — corroborates the drift; out of scope to fix here, flag for the code owner.)
- **Description:** The user-facing "Allow internet access for model downloads and updates" setting
  defaults to **ON** for a fresh install (it was flipped on in Phase 18 / wave-1 decision D3). README
  ("on by default"), `PRIVACY.md` ("on by default … unless the drive's policy disables it"),
  `docs/security-model.md`, `docs/architecture.md`, and `user-guide.md §10` ("on by default on a
  fresh install") all state this correctly. But two places still say the old default:
  - `model-policy.md` gate 2: *"**User setting** … the spec §3.6 Settings checkbox … **default OFF**."*
  - `user-guide.md §5`: heading *"Downloading a model (optional, **off by default**)"* and body
    *"turn on … (it is **off by default**…)"*.
- **Evidence:**
  - `apps/desktop/src/shared/types.ts:251`: `allowNetwork: true,`
  - `docs/user-guide.md:141` (heading "…off by default") and `:148` ("it is off by default").
  - `docs/user-guide.md:607-608`: "it is **on by default on a fresh install** so you can fetch a model
    out of the box" — **directly contradicts** §5 in the same document.
  - `docs/model-policy.md:184`: "the spec §3.6 Settings checkbox … **default OFF**."
  - `README.md:59`, `PRIVACY.md:58-59`, `PRIVACY.md:79-80`: "on by default".
- **Why it matters:** For a privacy-first product, an incorrect statement about when the app's *only*
  network feature is enabled is a credibility and trust issue. The self-contradiction inside
  `user-guide.md` (§5 says off, §10 says on) is especially confusing for an end user reading top to
  bottom.
- **Recommended fix:** Update both `model-policy.md` gate 2 and `user-guide.md §5` to "default **ON**
  for a fresh DIY/developer install; **prepared commercial drives ship with it off via policy**"
  (mirror the precise, policy-aware wording already in `PRIVACY.md` and `user-guide.md §10`). Keep the
  policy-ceiling nuance: `model-policy.md` gate 1 already correctly says the **default policy permits**
  downloads while `prepare-drive` writes **deny**, so the effective DIY gate is the (ON) user setting.
- **Validation needed after fix:** Re-read both edited sections; confirm `user-guide.md §5` and §10 now
  agree; confirm wording matches `DEFAULT_SETTINGS.allowNetwork: true` and the policy-AND-setting rule
  in `PRIVACY.md`. Grep the docs for any remaining "off by default" near "model download".
- **Documentation update notes:** Also forward to the code owner that
  `registerDownloadIpc.ts:16`'s "default off" comment should be corrected (code change, not part of
  this docs phase).
- **Suggested phase:** 1

### DOC-002: `BUILD_STATE.md` links to ~9 deleted plan files

- **Status:** Open
- **Severity:** Low
- **Confidence:** High
- **Category:** Navigation
- **Affected document(s):** `BUILD_STATE.md`
- **Affected section(s):** Multiple historical log entries throughout the file.
- **Related code or config checked:** Filesystem — none of the linked `docs/*-plan.md` targets exist
  (verified they were folded into topic docs and deleted per the `CLAUDE.md` doc-lifecycle rule).
- **Description:** `BUILD_STATE.md` contains ~30 markdown links (9 distinct targets) of the form
  `[…](docs/<name>-plan.md)` that now 404. The plans were condensed into §-numbered design records and
  deleted (the intended workflow), but the inline links were left as live links rather than de-linked
  or annotated with the git-history pointer.
- **Evidence:** Broken relative-link scan found these missing targets linked from `BUILD_STATE.md`:
  `docs/image-understanding-plan.md`, `docs/context-compaction-plan.md`,
  `docs/performance-audit-2026-06-18.md`, `docs/brand-refresh-plan.md`,
  `docs/full-doc-skills-plan.md`, `docs/skills-s11-plan.md`, `docs/skills-plan.md`,
  `docs/whole-document-analysis-plan.md`, `docs/document-organization-plan.md`.
- **Why it matters:** A reader (or future agent) clicking these gets a dead link. `BUILD_STATE.md` is
  the "always read first" handoff file, so dead links there are higher-visibility than elsewhere.
  Severity is Low because the content was deliberately superseded and recoverable in git history.
- **Recommended fix:** For each occurrence, either (a) convert the markdown link to plain text plus a
  git-history pointer (the pattern already used elsewhere, e.g. `full original via git show <sha>:docs/…`),
  or (b) repoint to the §-anchor of the topic doc that absorbed the plan. Do **not** rewrite the
  historical prose — only neutralize the dead links. Because `BUILD_STATE.md` is append-only and large,
  this can be a mechanical find/replace pass.
- **Validation needed after fix:** Re-run the relative-link scan over root + `docs/`; expect zero
  broken `.md` links (the published docs already pass; this clears `BUILD_STATE.md`).
- **Documentation update notes:** Confirm each repointed §-anchor actually exists in the target doc
  before linking to it.
- **Suggested phase:** 2

### DOC-003: PRIVACY.md circular "described under *Encryption* below" reference

- **Status:** Open
- **Severity:** Low
- **Confidence:** High
- **Category:** Clarity / Navigation
- **Affected document(s):** `PRIVACY.md`
- **Affected section(s):** "## Encryption" → the "**What is not encrypted**" paragraph.
- **Description:** Inside the Encryption section, the sentence describing the vault descriptor says the
  salt/KDF/verifier/wrapped-key are "described under *Encryption* **below**". But the description is in
  the **same** section, **above** that sentence (the opening paragraph of "## Encryption"). The
  pointer is both directionally wrong ("below" → should be "above") and circular (it points to the
  section it is already in).
- **Evidence:** `PRIVACY.md:115-116`: "the vault descriptor `config/workspace.json` (the salt, KDF
  parameters, verifier, and password-wrapped data key **described under *Encryption* below** — it must
  be readable before you unlock…)". The actual description is `PRIVACY.md:102-104`.
- **Why it matters:** Sends the reader looking downward for content that is above; small but it
  undermines the careful, trust-building tone of the privacy notice.
- **Recommended fix:** Drop the misdirection — either delete "described under *Encryption* below"
  (the fields are already enumerated inline) or change it to "described above". Simplest: remove the
  redundant clause.
- **Validation needed after fix:** Read the paragraph in place; confirm it reads cleanly and no longer
  forward-references itself.
- **Documentation update notes:** None.
- **Suggested phase:** 2

### DOC-004: README doc index omits `benchmark.md` and `design-guidelines.md`; benchmark name collision

- **Status:** Open
- **Severity:** Low
- **Confidence:** Medium
- **Category:** Navigation / Completeness
- **Affected document(s):** `README.md`, `docs/benchmark.md`, `docs/design-guidelines.md`
- **Affected section(s):** `README.md` → "## Documentation" table.
- **Description:** The README "Documentation" table is the canonical doc map, but two substantive,
  maintained docs are absent: `docs/benchmark.md` (the in-app **hardware** benchmark + model-recommend
  feature, Phase 7) and `docs/design-guidelines.md` (the design system + UI design records, 65 KB).
  Both are reachable only via `BUILD_STATE.md`/`architecture.md` mentions, not the front-door index.
  Separately, `benchmark.md` and `model-benchmarks.md` have near-identical names but cover different
  topics (the in-app hardware probe vs. the offline model-quality benchmark **protocol/results**),
  which is easy to confuse.
- **Evidence:** `README.md:226-240` lists user-guide, architecture, rag-design, security-model,
  model-policy, model-benchmarks, drive-layout, packaging, troubleshooting, known-limitations,
  BUILD_STATE, CHANGELOG — but not `benchmark.md` or `design-guidelines.md`. Both files exist and are
  dated/maintained (`benchmark.md` Phase-7..29 content; `design-guidelines.md` records through
  2026-06-19).
- **Why it matters:** A new developer/agent using the README as the doc map won't discover the design
  system or the hardware-benchmark design doc. The name collision can send someone to the wrong
  benchmark doc.
- **Recommended fix:** Add both to the README "Documentation" table with one-line "what's inside"
  descriptions that disambiguate them, e.g. `benchmark.md` → "In-app hardware benchmark & model
  recommendation (the machine probe)"; `model-benchmarks.md` → keep "measured speed/RAM/quality + the
  harness"; `design-guidelines.md` → "Design system: tokens, components, UI design records". Optionally
  note in `benchmark.md`/`model-benchmarks.md` headers a one-line "not to be confused with …" pointer.
  (Consider whether `design-guidelines.md` is intended as internal-only; if so, leave it out and only
  add `benchmark.md` — confirm intent before editing.)
- **Validation needed after fix:** Confirm the two new index rows link to existing files; eyeball the
  table renders.
- **Documentation update notes:** Low confidence on whether `design-guidelines.md` *should* be indexed
  (it may be deliberately internal). `benchmark.md` is the stronger case to add.
- **Suggested phase:** 3

### DOC-005: `design-guidelines.md` header date lags its body (~9 days)

- **Status:** Open
- **Severity:** Low
- **Confidence:** High
- **Category:** Accuracy / Staleness
- **Affected document(s):** `docs/design-guidelines.md`
- **Affected section(s):** Header line ("Status: ADOPTED 2026-06-10").
- **Description:** The header states "ADOPTED 2026-06-10" and carries no later "Last updated" marker,
  but the body has been substantially extended since: §11.6 (2026-06-15), §11.7 (2026-06-16), §12
  (2026-06-13), and §13 "Brand refresh — design record" (2026-06-19). A reader trusting the header
  would underestimate the doc's currency.
- **Evidence:** `design-guidelines.md:3` ("ADOPTED 2026-06-10") vs the §13 brand-refresh record and
  §11.6/§11.7 follow-ups dated through 2026-06-19 (corroborated by `BUILD_STATE.md` references to
  `design-guidelines.md §13`).
- **Why it matters:** Minor, but every other topic doc carries an accurate "Last updated" line; this is
  the lone laggard. Consistency of the header convention aids the doc-lifecycle discipline.
- **Recommended fix:** Add/adjust the header to a "Last updated: 2026-06-19 (brand refresh §13; Home
  CTA §11.7)" line while preserving the "ADOPTED 2026-06-10" provenance (adoption date ≠ last-updated).
- **Validation needed after fix:** Confirm the new date matches the latest dated record in the body.
- **Documentation update notes:** Keep the original adoption date visible; only add the freshness line.
- **Suggested phase:** 3

### DOC-006: troubleshooting.md "network access is off by default" phrasing

- **Status:** Open
- **Severity:** Low
- **Confidence:** Low
- **Category:** Clarity
- **Affected document(s):** `docs/troubleshooting.md`
- **Affected section(s):** "## "Offline Mode is ON — is something wrong?""
- **Description:** The section says "It does not need the internet and **network access is off by
  default**." For a **commercial/prepared drive** (the troubleshooting doc's primary audience) this is
  true — policy denies downloads. But for a **DIY/developer fresh install** the model-download setting
  is ON by default (see DOC-001), so the blanket phrasing can read as conflicting with the "on by
  default" wording elsewhere. This is softer than DOC-001 because the audience and the policy ceiling
  make it defensible.
- **Evidence:** `docs/troubleshooting.md:49` ("network access is off by default") vs `PRIVACY.md` /
  `user-guide.md §10` ("on by default on a fresh install; commercial drive ships off").
- **Why it matters:** Minor potential confusion; the core claim (the app's data path is offline) is
  correct regardless. Worth a one-clause clarification when DOC-001 is fixed, to keep the network-default
  story consistent across every doc.
- **Recommended fix:** Reword to scope it to the model-download feature and posture, e.g. "the core app
  never goes online; the optional model-download feature is off on a prepared drive (and asks before
  any download otherwise)." Align with the DOC-001 wording.
- **Validation needed after fix:** Confirm the sentence no longer reads as a global "network off by
  default" claim that conflicts with the DIY default.
- **Documentation update notes:** Bundle with DOC-001 if convenient (same theme), or skip if the
  commercial-audience framing is judged sufficient.
- **Suggested phase:** 3 (or fold into Phase 1 with DOC-001)

## Contradictions

| # | Documents involved | Conflicting statements | Likely source of truth | Recommended resolution | Finding |
|---|---|---|---|---|---|
| 1 | `model-policy.md`, `user-guide.md §5` **vs** README, PRIVACY, security-model, architecture, `user-guide.md §10`, **and code** | "model-download user setting **default OFF**" / "off by default" vs "**on by default** on a fresh install" | **Code** (`DEFAULT_SETTINGS.allowNetwork: true`) + the majority of docs | Fix the two stale docs to "on by default for DIY/dev; off via policy on commercial drives" | DOC-001 |
| 2 | `user-guide.md §5` **vs** `user-guide.md §10` | Same document states both "off by default" (§5) and "on by default on a fresh install" (§10) | §10 (matches code) | Correct §5 | DOC-001 |
| 3 | `troubleshooting.md` **vs** PRIVACY/user-guide §10 (soft) | "network access is off by default" vs "on by default on a fresh install" | Context-dependent (commercial vs DIY) | Scope the phrasing to the download feature/posture | DOC-006 |

No contradictions were found among the large design docs (`architecture.md`, `rag-design.md`,
`security-model.md`, `design-guidelines.md`, `known-limitations.md`), nor between them and the root
docs, on encryption (AES-256-GCM + Argon2id), the audit log (ids/counts only), the offline guard, the
deny-by-default renderer permissions, the model catalog, or licensing.

## Missing documentation

| Missing topic | Why it matters | Suggested file/section | Priority | Finding |
|---|---|---|---|---|
| README index entries for `benchmark.md` + `design-guidelines.md` | Front-door discoverability of two maintained docs | `README.md` "Documentation" table | Low | DOC-004 |

No substantive content gaps were found. Setup (DIY + prepared-drive), dev workflow, testing
(`npm test` + faster-iteration recipe), packaging/build, configuration (`HILBERTRAUM_*` env vars are
documented in packaging/drive-layout), security, privacy, architecture, troubleshooting, known
limitations, contribution, and changelog are all present and accurate.

## Duplicated or overlapping documentation

| Documents involved | Topic | Drift risk | Recommended approach | Finding |
|---|---|---|---|---|
| `docs/benchmark.md` ↔ `docs/model-benchmarks.md` | "benchmark" — but distinct topics (in-app hardware probe vs. offline model-quality protocol/results) | Low (content is non-overlapping; only the **names** collide) | Do **not** merge — disambiguate the names in the README index + optional header cross-note | DOC-004 |

No genuine content duplication was found. The repeated network-default wording across README/PRIVACY/
user-guide is intentional reinforcement, not drift — except where it has gone stale (DOC-001).

## Broken or weak references

- **Broken links (published docs root + `docs/`):** none. A deterministic relative-`.md`-link scan of
  every root and `docs/` markdown file returned **zero** broken links.
- **Broken links (`BUILD_STATE.md`):** ~9 distinct deleted `docs/*-plan.md` targets (DOC-002).
- **Weak/circular reference:** `PRIVACY.md` "described under *Encryption* below" points into its own
  section, wrong direction (DOC-003).
- **Missing cross-links:** `benchmark.md` and `design-guidelines.md` are not linked from the README doc
  index (DOC-004).
- **References to old commands/workflows:** none found — verified `npm` scripts, `scripts/*` names and
  flags, the b9585 runtime pin, and the CI chain all match the current code.

## Documentation remediation plan

### Phase 1: Fix the model-download-default contradiction (DOC-001)

- **Goal:** Make every doc agree with the code that the model-download user setting defaults **ON** for
  a fresh DIY/dev install (and **off via policy** on commercial drives).
- **Findings included:** DOC-001 (and, if convenient, the DOC-006 phrasing).
- **Documents affected:** `docs/model-policy.md` (downloader gate 2), `docs/user-guide.md` (§5 heading
  + body; verify §10 unchanged). Optionally `docs/troubleshooting.md` (DOC-006).
- **Exact intended changes:**
  - `model-policy.md` gate 2: change "default OFF" → wording that states default ON for DIY/dev,
    gated by the policy ceiling (which `prepare-drive` writes as deny on prepared drives).
  - `user-guide.md §5`: change the heading "(optional, off by default)" and the body "it is off by
    default" to match §10 ("on by default on a fresh install; prepared commercial drive ships off").
- **Code/config verification required:** Re-confirm `apps/desktop/src/shared/types.ts`
  `DEFAULT_SETTINGS.allowNetwork: true`; confirm `prepare-drive` writes `allow_model_downloads: false`
  (drive.ts) so the commercial-off statement stays accurate.
- **Validation steps:** Grep docs for "off by default" near "download"/"network"; confirm none remain
  that contradict the code; read §5 and §10 together for agreement.
- **Acceptance criteria:** No doc states the model-download setting is "off by default" for a fresh
  install; `user-guide.md` no longer self-contradicts.
- **Risks:** Low. Wording-only; preserve the policy-ceiling nuance so the commercial-off case stays
  correct.
- **Rollback notes:** Revert the two/three edited sections.

### Phase 2: Repair dead/circular references (DOC-002, DOC-003)

- **Goal:** Eliminate broken and circular links.
- **Findings included:** DOC-002, DOC-003.
- **Documents affected:** `BUILD_STATE.md`, `PRIVACY.md`.
- **Exact intended changes:** De-link or repoint the ~9 `docs/*-plan.md` references in
  `BUILD_STATE.md` (plain text + git-history pointer, or §-anchor of the absorbing topic doc); remove/
  fix the "described under *Encryption* below" clause in `PRIVACY.md`.
- **Code/config verification required:** None (filesystem + git only). Verify any repointed §-anchors
  exist.
- **Validation steps:** Re-run the relative-`.md`-link scan over root + `docs/` + `BUILD_STATE.md`;
  expect zero broken links.
- **Acceptance criteria:** Link scan is clean repo-wide; PRIVACY paragraph reads correctly.
- **Risks:** Low. Do not alter historical prose in `BUILD_STATE.md` beyond neutralizing the links.
- **Rollback notes:** Revert edited lines.

### Phase 3: Navigation & freshness polish (DOC-004, DOC-005, DOC-006)

- **Goal:** Improve discoverability and header accuracy.
- **Findings included:** DOC-004, DOC-005, DOC-006.
- **Documents affected:** `README.md`, `docs/design-guidelines.md`, `docs/troubleshooting.md`
  (DOC-006 if not already done in Phase 1).
- **Exact intended changes:** Add `benchmark.md` (and, if intended-public, `design-guidelines.md`) to
  the README doc index with disambiguating descriptions; add a "Last updated: 2026-06-19" freshness
  line to `design-guidelines.md` (keep the ADOPTED date); reword the troubleshooting network sentence.
- **Code/config verification required:** None.
- **Validation steps:** Confirm new index rows link to existing files; confirm the freshness date
  matches the latest body record.
- **Acceptance criteria:** README index includes the previously-missing maintained docs;
  `design-guidelines.md` header reflects its true currency.
- **Risks:** Low. Confirm whether `design-guidelines.md` is meant to be public before indexing it.
- **Rollback notes:** Revert table/header edits.

## Recommended execution order

1. **Phase 1 (DOC-001)** first — it is the only finding that disagrees with the code, it is
   privacy-relevant, and it resolves a self-contradiction a user would actually hit. Highest value,
   lowest risk.
2. **Phase 2 (DOC-002, DOC-003)** next — mechanical link hygiene; clears the entire repo's broken-link
   surface and one circular reference.
3. **Phase 3 (DOC-004, DOC-005, DOC-006)** last — navigation/freshness polish; nice-to-have, no
   correctness impact. DOC-006 may be folded into Phase 1 since it shares the network-default theme.

## Remediation log

| Date | Phase / finding | Files changed | Summary | Validation performed | Result | Follow-up needed |
|---|---|---|---|---|---|---|
| _(empty — no fixes applied yet)_ | | | | | | |
