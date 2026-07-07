# Skills audit — 2026-07-07 (app-skills content ↔ runtime truth)

**Scope.** All 9 bundled skills in `app-skills/` (SKILL.md frontmatter + bodies, the two
bank-statement auxiliary files), verified against the runtime they describe: the tool registry and
tool implementations, the whole-doc/compare engines, the redaction/edit seams, the suggestion/auto-fire
heuristic, the loader/parity plumbing, and the renderer i18n. Working paper under the CLAUDE.md doc
lifecycle rule — retire into the architecture Skills record once remediated.

**Prior-audit dedup.** Findings already fixed or accepted in the 2026-07-02/03 waves (SKA-1…45),
the invoice audit (arch §43), and the beta wave (#22–#28, arch §20–§23) are NOT re-reported.
Accepted residuals (§22-M2 location trust, DS20 non-confidentiality, SKA-43/45) were left alone.

**Verdict.** The skills are in good shape where prior waves already looked: tool gating claims,
button labels, the redaction floor list, the PII pre-scan list, A/B labels, keyword parity (all 9
pinned), and minAppVersion gating all verify exactly against code. The issues found are
(a) **staleness** — text written for an earlier phase that shipped features have since falsified,
(b) one **unsafe completeness instruction** with a real (if narrow) code-side trigger, and
(c) scope/wording promises the engines don't keep.

Severity: 2 High · 5 Medium · 8 Low · 3 Info.

---

## HIGH

### SK-1 (HIGH, staleness) — document-edit still promises a plain `.txt` copy; Phase 9 ships same-format DOCX
`app-skills/document-edit/SKILL.md:55-56`: *"This phase writes a plain `.txt` copy; keeping the
original file format is a later step."* The run seam (`services/skills/run.ts:1781-1789`) now writes
**docx → `edited.docx`** (`verifyAndSpliceEdits` → `applySpansToDocx` → `saveBinaryFile`); only
txt/md/pdf (and a corrupt-DOCX fallback, run.ts:1696-1699) take the `.txt` branch. The model will
tell a DOCX user they're getting a `.txt` — contradicting the shipped headline feature (#23, D77).
Note document-redaction (same Phase-9 mechanism, run.ts:1519-1523) correctly makes **no** format
claim; the two skills describe the identical seam inconsistently.
**Fix:** replace the sentence with the true matrix — "a `.docx` document keeps its format; other
formats (PDF, plain text) save as a plain-text copy" — or drop the format sentence entirely like
document-redaction. Bump the skill version (see SK-12).

### SK-2 (HIGH, unsafe instruction + code corner) — "treat the diff as complete and exact" is false past 200 rendered changes
`app-skills/what-changed/SKILL.md:52-55` instructs: when given the deterministic word-level diff,
*"treat it as complete and exact — it already found every changed word"*. The chat compare path
guards the token-budget case (truncated → the prompt itself says "This list is PARTIAL",
`rag/index.ts:1172-1176`) — but `renderChangesForModel`/`renderRedline` are called with **no `max`**
(`rag/index.ts:902,909`), defaulting to a **200-change cap** (`diff/index.ts:284,309`) that does
**not** set `truncated`. A pair with >200 coalesced changes (allowed: `DEFAULT_MAX_EDITS = 1200`,
`isPreciseDiffUseful` tolerates up to 50% changed) whose capped rendering still fits the budget gets
`truncated=false` (`rag/index.ts:910`) → the prompt asserts "complete and exact" while changes past
#200 were dropped. The embedded "(+N further change(s) not listed)" line (`diff/index.ts:324`)
softens but does not retract the completeness assertion — and the SKILL.md body doubles down on it.
This is the invented-completeness class prior waves hunted (cf. SKA-4/5 honesty gates).
**Fix (both sides):** (code) treat `changes.length > renderCap` as truncation — set `truncated=true`
or thread an explicit `max` and compare; (skill) soften to "treat it as complete unless the block
itself notes further unlisted changes".

---

## MEDIUM

### SK-3 (MEDIUM, engine/skill composition) — the what-changed fence rides incoherently onto non-compare turns
The body's absolute claim (`what-changed/SKILL.md:44-48`: the app *"replies with that guidance
itself before you are ever called"* at ≠2 docs) holds only when the question matches compare
vocabulary and ≥1 doc is in scope: the deterministic `selectTwo` reply fires at
`registerRagIpc.ts:233-267` gated on `intends() && !applies()`. A **non-compare question** (e.g.
"who is the landlord?") with what-changed sticky at 1 or 3 docs has `intends()` false and falls
through to the ordinary top-k path **with the what-changed fence still attached**
(`registerRagIpc.ts:609-637`) — a fence that says "Assume you have been given exactly the two
documents… get straight to comparing them." At 0 docs the `selectTwo` branch is also skipped
(`inScope.length >= 1`, :265).
**Fix options:** (a) skill wording: scope the assumption to compare-shaped turns ("when you are
asked to compare, the app has already ensured exactly two documents…"); (b) runtime: suppress the
compare fence when the turn routes to the relevance path (mirror of the A4/SKA-8 fall-through
philosophy). (a) is the cheap safe half; (b) is the structural one.

### SK-4 (MEDIUM, over-promise) — deadline-obligation-finder claims "one or more documents"; the engine is single-doc
`deadline-obligation-finder/SKILL.md:4` ("in one or more documents") and `:45-47` ("across one or
more selected documents") vs `analysis: whole-doc`, whose `applies()` requires **exactly one**
in-scope doc (`whole-doc-skills.ts:99-103`, `common.ts:21-27`). At multi-doc scope the W2 pre-pass
narrows to a single matching doc or replies `selectOne` (`registerRagIpc.ts:268-289`,
`en.ts:837-839`); a generic question falls to top-k — never a multi-doc whole-doc scan. The skill
sets an expectation ("all deadlines across my documents") the engine answers with a
one-document-at-a-time reality.
**Fix:** reword description/body to single-document ("in a document") + add a scope note in the
body mirroring what-changed's "the app handles document scope" rule (the app narrows or asks;
don't police it) — or, long-term, build a multi-doc deadline sweep (out of scope here).

### SK-5 (MEDIUM, staleness, package hygiene) — bank-statement auxiliary files still describe the instruction-only v1
- `app-skills/bank-statement/examples/reading-a-statement.md` teaches the model/reader to **decline
  to sum, validate, categorize, or export** ("this version doesn't do that… Those are Tier-2 tool
  behaviours") — all five tools have long since shipped. Confirmed never injected at runtime
  (no code path reads `examples/`), **but** it rides along on skill export
  (`installer.ts:840-862` `collectExportFiles`) and is the first thing a human contributor reads.
- `schemas/transaction.schema.json:5` self-describes *"NO tool reads or produces it in this
  instruction-only v1"* — `extract_transactions` now produces exactly this shape
  (`tools/bank-statement.ts:187-195`).
**Fix:** rewrite the example around the Tier-2 reality (quote printed figures; the tools do the
arithmetic; exports ask first) or delete it; fix the schema `description`.

### SK-6 (MEDIUM, drift risk) — transaction.schema.json is a hand-maintained mirror with no parity pin
The live contract is the inline `TRANSACTION_ROW_SCHEMA` (`tools/bank-statement.ts:50-65`, comment
"mirror[s] the committed transaction.schema.json"); nothing loads the JSON file and **no test pins
the two together** — the packaged schema can silently drift from the shipped shape (they match
today, field-for-field). **Fix:** a small unit test that loads the JSON file and deep-compares it
against `TRANSACTION_ROW_SCHEMA` (modulo `category`, which is deliberately input-only), or delete
the file and let the TS schema be the only contract.

### SK-7 (MEDIUM, i18n consistency) — share-safe-review cross-references sibling skill/UI by English name only
`share-safe-review/SKILL.md:78-79`: *"Run the **Document Redaction** skill…"* — a German user's UI
says **"Dokument schwärzen"**; the model answers in German but only knows the EN name. SKA-42
established the name-both-languages precedent for exactly this class (redaction's button labels,
`document-redaction/SKILL.md:49`). Related: the §3 hidden-data warning and §4 wording are quoted
English boilerplate under a rule requiring the user's language — the model must silently translate
text presented as a verbatim quote. **Fix:** name both ("Document Redaction / Dokument schwärzen"),
and preface the boilerplate quotes with "say, in the user's language, the equivalent of:".

---

## LOW

### SK-8 (LOW) — "just below the chat box" is spatially wrong
Both tool-routing skills (`document-redaction/SKILL.md:49`, `document-edit/SKILL.md:38`) and the
i18n copy place the button "just below the chat box"; the `SkillRunBar` renders **above** the
composer input (between transcript and input, `ChatScreen.tsx:1721,1736`). If "chat box" = the
input field, "below" is wrong. Consistent everywhere, so cheap to fix everywhere at once
("just above the message box" / "direkt über dem Eingabefeld").

### SK-9 (LOW) — redaction body omits the steerable fourth locate category
`LocateCategory` includes `'other'` → `[REDACTED]` (`redaction-locate.ts:27-28`,
`redaction.ts:516-521`), reachable when the user steers scope with a custom instruction; the body
enumerates only "names, addresses, and organisation names" (`document-redaction/SKILL.md:56-57`).
Off by default (`DEFAULT_LOCATE_DIRECTIVE` is exactly the three), so merely incomplete. **Fix:** add
"…and, when you ask for more, other items it can locate are masked as [REDACTED]" or leave as
default-behavior description deliberately (then note it in the body comment).

### SK-10 (LOW) — invoice body under-describes validation (2 of 3 checks)
`validateInvoiceTotals` runs `lineItemsSumToNet`, `netPlusTaxIsGross`, **and** `taxMatchesRate`
(`tools/invoice.ts:1109-1135`); `invoice/SKILL.md:51-52` names only the first two. An under-claim,
not a falsehood. **Fix:** "…or the tax doesn't match the stated rate" in the honesty rule.

### SK-11 (LOW) — document-edit "never repeat document text back to them" is over-broad
`document-edit/SKILL.md:49-50`. The find/replace strings are **user-typed** and already sit in the
chat transcript; forbidding their mention makes natural confirmations ("replaced 'Müller' with
'Mustermann'") awkward while protecting nothing. The rule's real target is *surrounding document
content* (context around matches). **Fix:** narrow to "never quote the document's own text beyond
the terms the user themselves wrote".

### SK-12 (LOW) — version discipline: 8 of 9 bundled skills frozen at 1.0.0 despite material body changes
For app skills `version:` is display-only (upgrade `compareSemver` is gated on `existingUser`,
`installer.ts:626,713`) — but an **exported** bundled skill re-imported becomes a user skill whose
upgrade/downgrade decisions DO compare semver, so a forever-1.0.0 version defeats that path.
Redaction's Phase-7 rewrite and document-edit's upcoming SK-1 fix are exactly the kind of change a
bump should mark (meeting-protocol already did this once → 1.1.0). **Fix:** adopt
bump-minor-on-body-change as a convention (checklist line in the Skills design record).

### SK-13 (LOW) — DOCX "byte-for-byte identical" is character-, not byte-accurate inside touched nodes
`document-edit/SKILL.md:45`. Untouched `<w:t>` nodes and all other zip parts are byte-identical
(`docx-rewrite.ts:170-194`), but a **rewritten** node is unescape→re-escape'd
(`docx-rewrite.ts:94,132-148,177`) and `xmlEscape` emits only `&amp;/&lt;/&gt;` — an unchanged
`&#233;` or `&quot;` inside a touched node re-emerges as its literal character. Visible text is
identical. **Fix:** "character-for-character" (or scope the byte claim to untouched text), and align
the `docx-rewrite.ts:130-131` comment.

### SK-14 (LOW, doc-only) — "score ≥ 3" comments read as the suggestion bar
The autoFire comments in the four tool skills cite "the score ≥ 3 bar"; that is the **auto-fire**
threshold (`selector.ts:47`). The *suggestion* bar is **≥ 2 with a mandatory keyword hit**
(`selector.ts:37,219`) — a lone keyword can suggest. Easy to misread when tuning vocabulary.
**Fix:** one clarifying clause in the comment template ("suggest bar is 2 + keyword").

### SK-15 (LOW) — what-changed tells the model to recognize an "Exact changes" block it never sees
`what-changed/SKILL.md:52-53` names *"an 'Exact changes'/redline block"*. The skill's own engine
labels the block **"Exact word-level changes (redline):"** (`rag/index.ts:1168`) plus "Differences
from Document A to Document B:" (:1189); the literal heading "Exact changes (word-level diff)"
exists only in the **doctask button** path (`doctasks/compare.ts:320-322`), which is not this
skill's engine. "redline" still matches, so recognition likely works. **Fix:** quote the actual
runtime label when fixing SK-2's sentence anyway.

---

## INFO (no action required; recorded so the next audit doesn't re-litigate)

- **SK-16** — `validate_statement_balances` does a per-row running-balance chain
  (`tools/bank-statement.ts:815-864`); the opening+Σ=closing tie lives in `assessCompleteness`
  (:504-531) on the answer layer. The body's honesty rule is satisfied by the composition; the tool
  name just covers less than the sentence implies. Same class: `categorize_transactions` computes,
  the run seam persists (:1001-1037, run.ts) — "persisted by a categorize run" stays accurate.
- **SK-17** — meeting-protocol's "audio transcript" works via the **audio-file import** path
  (AudioParser → document); **live dictation** returns composer text and never becomes a document
  (`registerDictationIpc.ts:76-120`), so the skill can't run "over" a dictation — only over the
  message it produced. Consider a body clause if beta users hit it.
- **SK-18** — invoice/bank `mimeTypes` omit `text/plain` while the bodies say "or pasted text";
  pasted text isn't a document (no mime signal), and a lone keyword (=2) already clears the suggest
  bar, so this is consistent — noting so nobody "fixes" it into a precision regression.

## Verified-accurate (positive confirmations)
Tool gating (read-only auto-run vs confirm-gated exports) matches both tool skills' claims
end-to-end (`tool-registry.ts:181-330`, `analysis/invoice.ts:647-665`); button labels match
character-for-character in both locales via the shared descriptor key (`en.ts:204-205`,
`de.ts:217-218`); the redaction floor's six categories and the share-safe pre-scan's six categories
match the code one-for-one (`redaction.ts:42`, `rag/index.ts:1052-1064`); locate-only/no-rewrite,
no-model degrade, skipped-edit reporting, counts, and the informational dry-run all verify; A/B
import-order labels verify (`scope-documents.ts:53`, `rag/index.ts:699-702,1142-1144`); keyword
parity is pinned for **all 9** skills (`skills-skillmd-parity.test.ts:44-54`,
`vocabulary.ts:58-68`); grounded-data blocks realize "work from the extracted table"
(`grounded-data.ts:18-70`); minAppVersion gating is enforced at all six use-sites; the partial-doc
notice and share-safe verdict gate compose correctly (`rag/index.ts:1032-1064`).

## Suggested remediation order
1. **Wave A (skill text only, no code):** SK-1, SK-4 (wording half), SK-5, SK-7, SK-8, SK-9, SK-10,
   SK-11, SK-13 (wording), SK-14, SK-15 + version bumps per SK-12. Pure `app-skills/` edits + the
   i18n placement strings; parity test guards the keyword blocks (don't touch them).
2. **Wave B (code):** SK-2 (render-cap → truncated), SK-6 (schema parity test), SK-3(b) (fence
   suppression on relevance fall-through) if wanted beyond the wording fix.
