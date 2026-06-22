# Plan — skill-aware whole-document engine (Wave 2)

> **Status: OPEN working paper.** Wave 1 (the `document-redaction` routing handler) is done and
> recorded in [`architecture.md`](architecture.md) §19 (D49a). This plan covers the four Tier-1
> **instruction** skills. Direction approved with the user 2026-06-22: **option A — a skill-aware
> whole-document engine.** Fold into `architecture.md` §19 (or a new §20) once implemented, then
> delete this file (doc-lifecycle rule, [`CLAUDE.md`](../CLAUDE.md)).

## 1. The problem (audit finding, 2026-06-22)

Every chat turn (`rag:ask` in [`registerRagIpc.ts`](../apps/desktop/src/main/ipc/registerRagIpc.ts))
picks exactly one answer engine, in this precedence:

1. **Skill analysis handler** (`exhaustive`) — whole document, deterministic, **no model call**;
   honors the skill via *hardcoded TS*, not the SKILL.md body. Only `bank-statement` + `invoice`.
2. **coverage-extract** ("list every / how many" + precomputed extract data) — whole document, 0
   model calls, generic listing. **Skill body ignored.**
3. **tree-summary** ("summarize / whole document" + a ready deep index) — generic; skill body not
   applied.
4. **compare** (compare intent + ≥2 docs).
5. **relevance** → `generateGroundedAnswer` **with the SKILL.md fence injected** in the grounded
   user turn. Top-k passages; coverage = `relevance` → the "most relevant passages, NOT the whole
   document" badge.

**The structural defect:** the SKILL.md instruction body is honored on **exactly one** engine — the
top-k **relevance** path. Every whole-document engine ignores it. So a `kind: instruction` skill can
be **whole-document _or_ formatted-to-its-spec, never both.**

### Per-skill impact (all `kind: instruction`, none registers a handler today)

| Skill | Typical request | Lands on | Whole doc? | Skill format honored? | Verdict |
|---|---|---|---|---|---|
| **meeting-protocol** | "write minutes" / "summarize meeting" | tree-summary (if indexed) else relevance | tree: ✅ / rel: ❌ | **NO** on both | **Worst** — minutes from top-k miss decisions/actions; "summarize" can hijack to a generic tree-summary that ignores the 8-section format |
| **contract-brief** | "summarize this contract" | tree-summary else relevance | partial | NO on whole-doc path | Brief from top-k is incomplete (the skill body itself admits "When you answer from only a few retrieved passages, use cautious wording") |
| **share-safe-review** | "review before sharing" | relevance (no trigger match) | ❌ | ✅ but top-k | Can't find *all* sensitive info from top-k; no engine routes it whole-doc |
| **deadline-obligation-finder** | "find all deadlines" | coverage-extract (if extracts) else relevance | coverage: ✅ generic / rel: ❌ | NO on coverage path | Best-served, but the rich 5-section format is dropped on the whole-doc path |
| what-changed | "compare versions" | compare (if ≥2 docs) | compare path | needs verify | Probably OK — confirm the compare engine honors the skill |

## 2. Goal

For an `instruction` skill that declares it wants whole-document analysis, run an engine that feeds
the model the **whole document** (or a deep-index pass) **with the SKILL.md fence applied**, and
stamp **honest coverage** (not `relevance`). Keep all hard rules: offline, no telemetry, single
local model, §14 capability ceiling, the prompt-injection fence/guard around the untrusted body.

## 3. Open design questions (resolve before building)

1. **Opt-in mechanism.** A new SKILL.md frontmatter flag (e.g. `analysis: whole_document`) vs. a new
   `SkillAnalysisHandler` `mode` (e.g. `'grounded-whole-doc'`) registered per skill. Frontmatter is
   author-facing and declarative; a handler keeps it app-owned. Likely: a thin per-skill handler
   (precedent: Wave 1's routing handler) whose `run()` calls a shared **grounded-whole-doc** helper.
2. **How "whole document" reaches the model under the context budget.** Options, in order of
   ambition: (a) **stuff** the full `extractDocumentPreview` segments when they fit the context
   window (with the fence + answer reserve via `skillFenceBudgetTokens`); (b) **map-reduce** over the
   deep-index tree (the tree-summary machinery) but with the skill fence applied at each step;
   (c) **tiered** — stuff when small, fall back to the tree pass when large. Note D47's caution:
   top-k RAG exists *because* raw documents overflow context — so (a) needs a hard size gate, and
   large docs need (b).
3. **Single-doc vs multi-doc.** meeting-protocol/contract-brief/share-safe-review are single-doc;
   what-changed is inherently 2-doc (the compare engine). Scope Wave 2 to **single-doc** first.
4. **Honest coverage.** Reuse `CoverageInfo`: `mode:'tree'` when answered via the deep-index pass
   (with the ready/partial gating already in `CoverageMeter`), or a `capped`-style mode when the
   doc was stuffed whole. Never claim "whole document" for a doc that wasn't fully read.
5. **Refusal vs degrade.** Mirror D45: if the skill needs the whole doc and it isn't fully chunked /
   indexed, refuse with the Re-index affordance, OR degrade to relevance with an honest badge?
   Minutes/brief lean **refuse** (a partial is misleading); a review may **degrade** with a warning.
6. **`what-changed`.** Verify whether the existing `compare` engine applies the skill fence; if not,
   fold it into the same mechanism.

## 4. Proposed shape (subject to §3)

- Add a shared `groundedWholeDocAnswer(...)` helper in `services/skills/analysis/` that: resolves the
  single in-scope doc, reads its faithful segments via `readDocumentSegments`, applies the SKILL.md
  fence through `buildSkillFence`/`skillFenceBudgetTokens`, calls the model once (or map-reduces over
  the tree for large docs), and returns `{ answer, citations, coverage }` with honest coverage.
- Each adopting skill registers an `exhaustive`-style handler whose `applies()` matches its
  analysis-shaped intent (per-skill keyword set, EN+DE) over a single in-scope doc, and whose `run()`
  delegates to the helper. This reuses the Wave 1 seam and the existing `registerRagIpc` wiring
  (including the D45 fully-chunked refusal, which now *does* apply to these read-the-whole-doc skills).
- No new DB/FS/net capability; the only content reach stays the injected segment reader (§14).

## 5. Test strategy

- Per-skill `applies()` matrix (analysis-shaped vs off-topic; single vs multi-doc; fully vs partly
  chunked) mirroring `skills-analysis-invoice.test.ts`.
- A `groundedWholeDocAnswer` test with the mock runtime asserting the fence is present in the model
  turn and coverage is NOT `relevance`.
- An IPC-level test (mirror `rag-skill-analysis.test.ts`) proving the turn no longer takes the top-k
  path for an adopting skill, and that the partly-chunked refusal fires.
- A regression test that an **off-topic** question with an adopting skill active still keeps the
  relevance path (no force-routing).

## 6. Out of scope for Wave 2

- Multi-document analysis beyond the existing 2-doc compare (`what-changed` stays on its current path
  unless §3.6 finds it broken).
- Changing the deep-index build itself; this plan only *consumes* a ready tree.
