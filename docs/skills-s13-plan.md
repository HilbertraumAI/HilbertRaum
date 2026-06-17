# Skills Phase S13 — Auto-fire triggers, behind an evaluation harness (working-paper plan)

> **Status: OPEN working paper — authored 2026-06-17, owner sign-off pending.** S13 is the only
> remaining *feature* in the skills roadmap (the S2→S12 wave is closed). It is **gated**: auto-fire —
> the app applying a skill to a turn *without* a tap — ships **only after** an offline evaluation
> harness proves it clears a precision bar on a labelled corpus. This file refines, never contradicts,
> the **"Skills — design record (Phases S2–S12, §1–§12)"** in
> [`architecture.md`](architecture.md) (especially §5 selection/prompt, §6 suggestion) and the
> security model in [`security-model.md`](security-model.md). It folds back into the design record at
> the end of S13 and is then deleted (doc-lifecycle rule); until then it is the build reference for
> S13.
>
> **The owner has stated: in-depth testing happens BEFORE any auto-fire behaviour is implemented.**
> So **S13a (the harness + corpus + a baseline measurement) is the deliverable that proceeds now**;
> the auto-fire mechanics (S13b) and the surprise-mitigation UX (S13c) are each **gated on S13a's
> numbers clearing the bar** ratified in §2.

## 0. The starting line — what S2–S12 already shipped (so S13 doesn't re-derive it)

- **Selection is deterministic, offline, one-skill-per-turn** (DS4/DS18). `messages.skill_id` stamps
  the turn; `conversations.active_skill_id` is the sticky default the composer pre-fills.
- **A suggestion already exists, but is inert** (DS14). `services/skills/selector.ts`
  (`scoreSkillTriggers`, `SUGGEST_SCORE_THRESHOLD = 2`, `selectSuggestion`) +
  `services/skills/suggest.ts` (`suggestSkillsForTurn(db, conversationId, question?)`) score each
  **enabled** skill's cached `triggers` (keyword in the draft question = the strong signal; in-scope
  doc MIME / filename glob = supporting) and return **at most one** offer. The offer is surfaced
  **only inside the composer picker** and is **never auto-applied** — the user must tap it.
- **The transparency surfaces already exist** (DS16): the composer "Skill: …" picker, the pinned
  one-tap offer (`.skill-suggest`), and the per-message **skill glyph** on the answer a skill shaped
  (stamped only when the fence was actually placed; a deleted skill resolves to NULL).
- **The skill is resolved in ONE place for both channels:** `resolveTurnSkill`
  (`services/skills/turn.ts`) feeds `registerChatIpc` (`sendChatMessage`) **and** `registerRagIpc`
  (`askDocuments`). This is where an auto-fire decision would slot in.
- **Security is NOT the gate.** Only **enabled** skills are candidates (the user already approved
  them), so crafted document/chat content can never *introduce* a skill — auto-fire's gate is
  **quality/evaluation**, not containment (DS18/§14). The structural ceilings (§14) are unchanged.

## 1. Goal & the one hard rule

**Goal:** when the app is *confident enough*, apply the right skill to a turn automatically — saving
the tap — **without ever silently surprising the user** and **without degrading answers** when it
guesses wrong.

**Hard rule (the gate):** the **offline evaluation harness IS the ship gate.** Auto-fire behaviour
does not ship until the harness, run over a labelled fixture corpus, clears the **precision bar**
ratified in §2. A miss is cheap (fall back to today's tap-offer); a *false fire* is the costly event,
so the bar is set on **precision**, and the harness is built and the baseline measured **before** any
behaviour change. No model call, no network (consistent with DS4 — selection stays deterministic).

## 2. Decisions to ratify (OWNER sign-off — proposals + rationale)

These are the choices that shape S13. Proposed defaults are the conservative reading of the wave's
existing posture; **none is ratified yet.** Mirror of the S11 "ratified scope cut" — but here the
table is the *agenda*, not a settled contract.

| # | Decision | Proposed default | Rationale / alternative |
|---|---|---|---|
| **D1** | **The precision bar** auto-fire must clear before it ships | **≥ 95% precision** on the corpus (of the turns where auto-fire *would* fire, ≥95% are the correct skill or correctly *none*); recall is secondary | A false fire shapes an answer the user didn't ask for — costly + erodes trust; a miss just falls back to the tap-offer (cheap). The exact % is the owner's call after seeing the baseline (§3.3) |
| **D2** | **Confidence model** | **Deterministic score, a SEPARATE higher threshold** than `SUGGEST_SCORE_THRESHOLD` (e.g. require a keyword hit, not a lone doc signal) | Keeps DS4 (no model, offline, reproducible — the harness can regression-test it). Alternative (a model-scored trigger) reintroduces template/latency/variance risk for little gain |
| **D3** | **Surprise-mitigation UX** | **Silent apply + the existing glyph + a one-click "Answer without the skill" undo** on the turn | DS16 — "never silently surprises": the glyph makes it visible, the undo re-runs the turn skill-free. Alternative (confirm *before* firing) defeats the point (it's just today's tap) |
| **D4** | **Trust / opt-in gate** | **Opt-in, and APP-skills only in v1** of auto-fire | §14 says opt-in. App-only is the conservative default (a user/imported skill needs a deliberate tap); user-skill auto-fire can come later once trusted. Alternative: a per-skill `triggers.autoFire` flag + a global user toggle |
| **D5** | **Precedence vs the sticky default** | **Auto-fire only when the turn has NO skill set** (no sticky default, no per-turn pick) | Never override an explicit user choice; auto-fire fills only the "user set nothing" gap. Simplest, least surprising |
| **D6** | **Schema** | Add **`triggers.autoFire?: boolean`** to the SKILL.md frontmatter (author declares *eligibility*; the app still adjudicates via D1/D2/D4) | Additive, parser-validated (the `shared/skill-manifest.ts` precedent); a skill that doesn't declare it is never an auto-fire candidate |

## 3. The evaluation harness (S13a) — the deliverable that proceeds NOW

This is pure measurement: it changes **no** runtime behaviour. It can land before any of D1–D6 is
ratified, and its baseline (§3.3) is what the owner needs to *set* D1/D2.

### 3.1 The fixture corpus (offline, committed, NO user data)

A labelled corpus of **synthetic** turns — each `{ question, inScopeDocs: [{title, mimeType}], expected:
<skillId | 'none'> }`. Hand-authored + reviewed, committed under `apps/desktop/tests/fixtures/
skill-triggers/` (text only — no real statements, no user data; honours the offline/no-telemetry
rules). It must include the hard cases the bar lives or dies on:
- **True positives** — turns that clearly want the bank skill (de-AT + EN phrasings; a statement file
  in scope).
- **True negatives** — turns with a statement in scope but an *unrelated* question (must NOT fire), and
  turns with bank words but no relevant doc.
- **Near-misses / adversarial** — a document whose filename merely contains "statement"; a question
  that mentions "transfer" generically; mixed-language phrasings.

### 3.2 Metrics

A deterministic vitest-runnable harness that scores the corpus through the selector and reports
**precision, recall, and a confusion matrix** (fired-correct / fired-wrong / missed / correctly-abstained).
"Fired-wrong" (a false positive) is the number D1 is set against. The harness **is the regression
guard**: any change to `selector.ts` re-runs it, and the bar is an assertion.

### 3.3 Baseline — measure the CURRENT deterministic selector

Run today's `scoreSkillTriggers` / `selectSuggestion` (threshold 2) over the corpus and record where
it stands. Two outcomes, both useful:
- If the current scorer already clears (or nearly clears) the D1 bar at a higher threshold → D2 is a
  one-line threshold change and S13b is small.
- If it doesn't → the baseline quantifies exactly what trigger-rule work S13b needs, and we tune
  against the harness rather than by guesswork (OQ-1).

**S13a ships when:** the corpus + harness exist, the baseline is recorded in this plan, and the suite
runs it green (as a measurement, not yet a gate-assertion). **Then the owner sets D1/D2 from real
numbers.**

### 3.3.1 Baseline — measured (S13a, 2026-06-17)

**Shipped.** Corpus: 33 hand-authored synthetic turns under
[`apps/desktop/tests/fixtures/skill-triggers/corpus.json`](../apps/desktop/tests/fixtures/skill-triggers/corpus.json)
(17 skill-expected — de-AT + EN, keyword-only and doc-corroborated; 16 `none` — 5 doc-in-scope-but-
unrelated, 2 filename-near-miss, 4 generic-substring adversarial, 5 neutral). Label space = the four
real enabled app skills. Harness:
[`apps/desktop/tests/eval/skill-triggers.ts`](../apps/desktop/tests/eval/skill-triggers.ts) +
`skill-triggers.test.ts` — scores every turn through the **real** `scoreSkillTriggers` /
`selectSuggestion` (a guard pins `threshold-2` ≡ `selectSuggestion` exactly), no model, no network, no
DB (DS4). Numbers below are reproducible via `npx vitest run tests/eval/skill-triggers.test.ts`.

Precision = fired-correct / (fired-correct + fired-wrong) — of the turns where it *fired*, how many
were right. Recall = fired-correct / (fired-correct + missed). "fired-wrong" (the cost D1 is set
against) folds together a fire where `none` was right and a fire of the wrong skill.

| policy | precision | recall | fired-correct | fired-wrong | missed | correctly-abstained |
|---|---|---|---|---|---|---|
| **threshold-2** (today's selector: score ≥ 2 — one keyword **or** MIME+filename) | **60.7%** | 100.0% | 17 | **11** | 0 | 5 |
| **keyword-required** (D2: keyword hit ≥ 1 — a lone doc signal never fires; a lone keyword still does) | **81.0%** | 100.0% | 17 | 4 | 0 | 12 |
| **threshold-3** (score ≥ 3 — a keyword corroborated by ≥ 1 doc signal) | **100.0%** | 88.2% | 15 | 0 | 2 | 16 |
| **threshold-4** (score ≥ 4 — two keywords, or keyword + both doc signals) | **100.0%** | 70.6% | 12 | 0 | 5 | 16 |

**What the numbers say (for D1/D2):**
- **Today's threshold (2) is nowhere near an auto-fire bar — 60.7% precision.** Its 11 false fires are
  the lone-doc-signal traps (a statement/invoice/meeting-named file in scope + an unrelated question =
  7) plus the generic-substring keyword hits (`balance` in "work-life balance", `bill` the name,
  `minutes` of time, `Datenschutz`-erklärung = 4). Fine for an *inert in-picker offer* (a wrong offer
  costs a glance); unacceptable for *silent auto-apply*.
- **Requiring a keyword (D2) removes the lone-doc traps but not the substring ones → 81.0%.** The 4
  residual false fires are exactly the adversarial substring cases — a deterministic keyword gate
  **cannot** distinguish "balance" the bank term from "balance" the lifestyle word. This is the
  **precision ceiling** of the current keyword model and the strongest argument that *keyword-alone is
  not enough for auto-fire*.
- **Requiring a keyword AND a doc signal (threshold-3) clears 100% precision at 88.2% recall on this
  corpus.** The only cost is 2 missed keyword-only turns (the user asked but attached no document yet)
  — and a miss is cheap (it just falls back to today's tap-offer, §1). This is the natural D2 setting
  if the owner's D1 bar is ≥ 95%.
- **threshold-4 buys nothing over threshold-3** (precision already 100%) while dropping recall to
  70.6% — too strict.

Caveats the owner should weigh before reading these as final: the corpus is **33 hand-authored items**,
deliberately dense with hard cases, so the *absolute* rates are illustrative, not population estimates;
the *ordering* and the *failure modes* are the durable signal. The substring-keyword ceiling (the 4
that survive `keyword-required`) is intrinsic to the current deterministic model — closing it would
need a tokenization/word-boundary change to `scoreSkillTriggers` (OQ-1 / out-of-scope §8), which the
harness would then regression-measure. Recall here counts a keyword-only turn as a target; if the
owner decides auto-fire *should* require a doc in scope (the conservative D5-adjacent reading), those 2
"misses" are by-design and threshold-3's effective recall is 100%.

## 4. Auto-fire mechanics (S13b — GATED on §3 clearing D1)

Once D1–D6 are ratified and the harness clears the bar:
- **Schema (D6):** `shared/skill-manifest.ts` gains `triggers.autoFire?: boolean` (additive, clamped,
  parser-validated + a round-trip test). Only `autoFire: true` skills are candidates.
- **The decision path:** a new `resolveAutoFireSkill(db, conversationId, question)` — same main-side
  scope resolution as `suggest.ts` (§22-C4), the **separate higher threshold** (D2), **app-skills
  only** + the user opt-in (D4), firing **only when `resolveTurnSkill` would otherwise return null**
  (D5). It plugs into `resolveTurnSkill` / both chat channels so a documents conversation auto-fires
  too (the §22-A1 single-resolution-path invariant).
- **The harness becomes the gate assertion** (the bar is now a hard test).

## 5. Surprise-mitigation UX (S13c — GATED)

Per D3: the auto-fired turn carries the **existing per-message glyph** (so it's visible, never silent)
plus an **"Answered with <skill> — answer without it"** affordance that re-runs the turn skill-free
(the regenerate precedent). A global **opt-in toggle** (D4) in Settings → Skills, off by default. EN +
DE copy.

## 6. Security & privacy posture (unchanged ceilings)

- **No new capability.** Auto-fire only changes *which* enabled skill is selected; the skill still only
  injects fenced reference text (Tier-1) or runs an app-orchestrated, validated, confirm-gated tool
  (Tier-2) behind the unchanged §14 ceiling. A wrongly-fired skill is, at worst, a worse answer + a
  one-click undo — never an action the user didn't authorize.
- **Still enabled-only candidates** (DS18): content cannot introduce a skill; app-only (D4) further
  narrows the auto-fire set to trusted product skills.
- **The question stays content:** it is scored main-side and **never logged or audited** (the existing
  `suggest.ts` posture); the corpus is synthetic, so no user data is committed. A sentinel-grep guard
  extends the S12 consolidated test to the auto-fire path.

## 7. Sub-phase breakdown + gating

- **S13a — the eval harness + corpus + baseline** *(proceeds now; the "in-depth testing" deliverable)*:
  the fixture corpus, the precision/recall harness, the baseline measurement of the current selector.
  **No behaviour change.** Output: numbers the owner uses to ratify D1/D2.
- **S13b — auto-fire mechanics** *(GATED on S13a clearing D1 + D1–D6 ratified)*: the `triggers.autoFire`
  schema, `resolveAutoFireSkill`, the decision path in `resolveTurnSkill`/both channels, the harness as
  a hard gate-assertion.
- **S13c — surprise-mitigation UX** *(GATED)*: the glyph (exists) + the "answer without the skill" undo
  + the opt-in toggle, EN/DE.

Each sub-phase = its own commit + the full per-phase ritual (tests green, build/launch, docs +
`BUILD_STATE.md` updated).

## 8. Out of scope for S13

- **Model-scored / LLM triggers** (D2 keeps it deterministic; a future option, not this wave).
- **User/imported-skill auto-fire** (D4 is app-only in v1; revisit once trusted-skill auto-fire has a
  track record).
- **Multi-skill-per-turn** (DS18 holds — auto-fire picks at most one).
- **Cross-conversation learning / adaptive thresholds** (the harness is a fixed corpus, not online
  learning).

## 9. Acceptance criteria

1. **S13a:** a committed, synthetic, no-user-data corpus + a deterministic precision/recall harness; the
   current selector's baseline recorded in this plan; suite green.
2. **D1–D6 ratified** (AskUserQuestion, owner) from the baseline numbers **before** S13b.
3. **S13b/S13c:** auto-fire clears the ratified D1 bar as a hard test; fires **only** app-skills, **only**
   on opt-in, **only** when no skill is otherwise set; every auto-fire is visible (glyph) + reversible
   (one-click undo); the §14 ceilings + the S12 sentinel guard still hold; EN/DE; docs +
   `BUILD_STATE.md` updated.
4. At S13 close: fold this plan into the **architecture.md "Skills — design record"** (extend §6) +
   `security-model.md` if needed, update in-code citations, and **delete this file** (original in git
   history).
