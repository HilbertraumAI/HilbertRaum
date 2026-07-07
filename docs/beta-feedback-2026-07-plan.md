# Beta feedback wave 1 — remediation plan (issues #22–#28)

_Status: **WORKING PAPER — Phases 1 (#28, DE citation labels) + 2 (#25, memory meter) + 3 (#27, one model action) + 4 (#26, single-doc scope + visible scope) + 5 (#24, coverage line) + 6 (#22 pt.1, span-transform engine) DONE; Phases 7–10 open.**
Per the CLAUDE.md doc-lifecycle rule this stays a standalone plan while work is open; once all
phases land (or are consciously dropped), condense into design records folded into
`docs/architecture.md` (Skills record — redaction/transform), `docs/rag-design.md` (scope +
coverage), and `docs/design-guidelines.md` (meter/labels), and delete this file.
Decision numbering continues the repo series after the result-tables wave's D59–D67
(**this plan: D68–D78**)._

Source: the first beta session (2026-07-06, lawyer, mac M1/16GB + win/32GB, Qwen3.5 9B, app
0.1.40) → GitHub issues **#22 #23 #24 #25 #26 #27 #28** on `comilionas/AI_Drive`. The rolling
beta themes (redaction as the legal-vertical killer use case; users routing around the
Documents view; trust needs proof of coverage; papercuts in the core loop) are the product
context — theme numbers below refer to that insights summary.

---

## 1. The issues, clustered

| Cluster | Issues | Shape |
|---|---|---|
| **A. UX papercuts** | #28 (S1 reads as "Seite 1"), #25 (context % reads as progress), #27 (Auswählen vs. Modell starten) | Small, independent, renderer + i18n (+ one IPC seam for #27) |
| **B. Scope & coverage trust** | #26 (library-by-default scope), #24 (no coverage statement on the default chat path) | Medium; main-side scope/coverage seams + renderer |
| **C. Format-preserving document transforms** | #22 (redaction misses names/addresses, loses layout), #23 (targeted edits regenerate + hallucinate) | The big wave: a new span-transform engine + LLM locate pass + same-format DOCX export |

Phases 1–5 are independent of each other and of the C wave; run them in any order, one per
session. Phases 6–10 are the C wave and build on each other (7, 8 need 6; 9 needs 6–8's
engine; 10 closes out).

---

## 2. Current-state review — the document-redaction skill & tools (requested audit)

What exists today (verified in code, 2026-07-06):

- **`app-skills/document-redaction/SKILL.md`** — Tier-2 `kind: tool`, one tool
  (`redact_document`), `autoFire: true`, `documents: selected_only`, `network: denied`. The
  body is a routing instruction: the model must deflect to the app button and never run the
  tool itself; the tool is confirm-gated and always asks before saving.
- **Detection** (`apps/desktop/src/main/services/skills/tools/redaction.ts`) is
  **deterministic, offline, regex-only** over six categories — email, URL, IBAN, card (Luhn),
  date, phone — run in a fixed non-overlapping order over a same-length Unicode "detection
  shadow" (SKA-3), with conservative miss-over-eat validators. **No ML, no NER, no
  name/address detection** — stated plainly in SKILL.md and `known-limitations.md`.
- **Replacement is already mechanical span-splicing** (`maskStep`), never model generation:
  unmasked text stays **byte-identical** to the extracted source (the D58 verbatim posture).
  Masks are fixed-width tokens (`[EMAIL]`, `[PHONE]`, …), so lengths change.
- **Output** (`run.ts` `runDocumentRedaction` → `saveTextFile('redacted.txt', …)`,
  `shared/skill-tools.ts` `DIALOG_REDACTED`): always a flat **`.txt`** file. Input formatting
  is flattened even earlier — DOCX import is `mammoth.extractRawText` (structure discarded),
  PDF import is per-page text.
- **No targeted-edit capability exists at all.** #23's hallucinated edits come from the
  generic chat path regenerating prose; there is no span-editing tool to route such asks to.
- **No document-writing code exists** (no DOCX/PDF writer, no zip dep in `dependencies` —
  `jszip@^3` is present transitively under mammoth).
- Tests: `skills-redaction-tool.test.ts` (detectors), `skills-redaction.test.ts` (run seam),
  `skills-analysis-redaction.test.ts` (routing/dry-run), plus privacy-guard/vocabulary/parity
  suites.

**Gap analysis vs. the beta requirements (#22/#23):**

| Requirement | Today | Gap |
|---|---|---|
| Names/addresses redacted | Not detected (by design) | Needs a locate pass with judgement — the local LLM (Phase 7) |
| Prompt-steerable scope ("keep the city") | Fixed six categories | Phase 7 instruction plumbing |
| Layout preserved | Fixed-width tokens; `.txt` from flattened text | Length-preserving masks (Phase 6) + segment-faithful text (Phase 9) |
| Same-format export (DOCX) | `.txt` only | DOCX rewrite via `word/document.xml` text nodes (Phase 9) |
| Diff-verifiable "unchanged outside spans" | Already true on the extracted text (byte-verbatim splice) | Keep by construction; extend to the DOCX writer |
| Targeted term edits without regeneration | Doesn't exist | New tool sharing the span engine (Phase 8) |

The architecture the issues ask for — *locate spans, replace mechanically, never regenerate*
— is exactly the posture `redaction.ts` already has. The wave **extends** that engine rather
than replacing it; the regex detectors remain as the deterministic floor under the new LLM
locate pass.

---

## 3. Decisions

| # | Decision | Lean | Why |
|---|---|---|---|
| D68 | Citation markers stay machine-stable `S{n}` internally (prompt contract, persisted `Citation.label`, model output); the rename is **display-time only** (DE shows `Q{n}`) | Renderer mapping at the two display sites | The marker is baked into `GROUNDING_RULES` and emitted inline by the model; persisting a locale-dependent label would break existing conversations and the model contract |
| D69 | The context meter becomes a **labeled "conversation memory" meter**: visible label, `role="meter"` (not `progressbar`), tooltip explains fill/summarize behavior | Relabel + ARIA + copy; no removal | The current bare `%` + progressbar role invites the progress misreading (#25); coverage (#24) is a separate, answer-anchored statement — do not conflate them in one widget |
| D70 | Model screen: **collapse to one primary action** "Use this model" = select + start runtime; Stop stays; the Starting/Active/Running badges carry the state | Merge, with the two-button variant as the recorded fallback | Selected models already auto-start at launch (default-on), so Select≠Start only matters mid-session; chat-send never auto-starts (`registerChatIpc.ts` contract), so the merged action must start the runtime. **Owner veto = keep two buttons, add explanatory tooltips/labels instead** |
| D71 | A conversation created **with an attachment or from "Ask selected"** scopes to those documents by default (Library becomes the explicit widen), and the active scope is always visible at the composer | Change the creation-time persisted scope, not the `resolveScope` fallback | Fixes the #26 friction where it starts (the single-doc workflow) without changing the meaning of existing conversations; the Library default for plain conversations stays |
| D72 | **Relevance answers stamp a real `CoverageInfo`** (today `undefined`) and the coverage line renders for every grounded answer — e.g. "based on N of M sections of {doc}" for a single-doc scope | Compute at answer time from citations + `documentChunkCount` | All inputs already exist at the stamp site; the honesty gates (never "whole document" without `fully_chunked` etc.) carry over unchanged |
| D73 | Redaction v2 = **LLM locate-spans + mechanical replacement**; the model only ever *locates* (grammar-constrained JSON, D55); the app verifies and splices; the model **never generates output text** | Extend `redaction.ts`'s engine | Kills both #22 failure modes structurally: hallucination is impossible (output = source bytes outside verified spans), and misses are reduced by judgement + the sweep in D75 |
| D74 | File output masks become **length-preserving per-character** (`█` per masked char) so line layout survives; category tokens remain for the chat dry-run counts | New replacement strategy in the engine; per-char is the file-write default for v2 | The beta spec is literal: placeholder per character, everything else byte-identical. `█` (one BMP unit) keeps the shadow same-length invariant and idempotency (no digit/@/scheme) |
| D75 | **Verified-span discipline**: an LLM-proposed span must match the source verbatim at its anchored location or it is dropped (and counted as dropped); every *confirmed* entity string is then swept mechanically across the whole document (all occurrences masked) | Verbatim-anchor + global sweep | The model can miss a repeat occurrence; the sweep makes one confirmation cover them all — deterministic completeness on top of probabilistic detection |
| D76 | Targeted edits (#23) **share the same engine**: locate (occurrence-anchored find→replace pairs from the instruction) → verify → splice; a per-pair change count is shown before the confirm-gated write | One `span-transform` core, two tools | Same architectural root as #22 (the issues say so); grammatical-agreement edits need occurrence-level anchoring, which the engine already models as spans |
| D77 | Same-format export v1 = **DOCX only**, by rewriting text inside `word/document.xml` `<w:t>` nodes (offset-mapped over the node-concatenated text layer) and rezipping — every other zip part copied byte-identical; `jszip` promoted to a direct dep. **PDF re-export stays out of scope** (per #23); PDF/TXT output becomes segment-faithful text (Phase 9) | Direct XML text-node rewrite, not a DOCX builder | Formatting/styles/numbering survive because runs are untouched — only text content changes; a builder (docx/docxtemplater) would regenerate structure and violate the diff-verifiability requirement |
| D78 | The **honesty posture stays**: best-effort first pass, review-before-share, never "fully anonymized", never legal-compliance claims; the run report states counts, categories, and what was *dropped as unverifiable* | SKILL.md + report copy carry it | The LLM pass adds judgement, not a guarantee; overclaiming would be worse than the current under-delivery |

---

## 4. Phase 1 — German citation labels (#28) ✅ DONE

**Goal:** DE users see `Q1/Q2` ("Quelle"), EN keeps `S1` — with zero change to persisted data
or the model contract (D68).

**Shipped:** new `chat.sources.marker` i18n key (EN `S{n}` / DE `Q{n}`); `formatCitationLabel`
(displayMap) relabels the `SourcesDisclosure` source-card label; `localizeServerCopy` rewrites
inline `[S(\d+)] → [Q$1]` in prose only (fenced/inline-code guard mirroring
`normalizeMathDelimiters`), applied to both streaming and persisted turns via `Transcript.tsx`.
Machine contract untouched (label sites, `GROUNDING_RULES`, `citations_json`). Tests:
`display-map.test.ts` (+12: DE rewrite, EN identity, code-span/fence guards, `formatCitationLabel`,
a pin that `GROUNDED_SYSTEM_PROMPT` still emits `[S1]`), `CitationMarkers.test.tsx` (+5: persisted +
streaming turn, card + body, DE/EN, code-span guard). Folded into `rag-design.md` §3 citation-label
note. Suite 3658/47, typecheck + build green.

- `apps/desktop/src/renderer/chat/SourcesDisclosure.tsx:76` — the card label `[{c.label}]`:
  render via a localized formatter (new i18n key, e.g. `chat.sources.marker` = `'S{n}'` EN /
  `'Q{n}'` DE) mapping the stored `S{n}` index; provenance mode (no labels) unaffected.
- Inline body markers: display-time rewrite `\[S(\d+)\]` → `[Q$1]` for DE in
  `localizeServerCopy` (`apps/desktop/src/renderer/lib/displayMap.ts`) — already the display
  choke point called from `Transcript.tsx` for both streaming and persisted turns. Skip
  fenced code/inline code spans (mirror the `normalizeMathDelimiters` guard) so a literal
  `[S1]` in quoted code stays verbatim.
- Do **not** touch: label assignment (`rag/index.ts:343/519/573/740/933`,
  `coverage.ts:111`), `GROUNDING_RULES`, `buildGroundedPrompt`, grounded-data mode's
  no-markers rule, persisted `citations_json`.
- Tests: renderer (DE renders `[Q2]` card + body, EN unchanged, code-span guard, persisted
  turn + streaming turn); a pin that the prompt builder still emits `[S1]`.

**Done =** suite green, DE transcript shows Q-markers end-to-end, docs (`rag-design.md`
citation note) + BUILD_STATE updated, commit references #28.

## 5. Phase 2 — context meter is not a progress bar (#25) ✅ DONE

**Goal:** the indicator reads unambiguously as "how full this conversation's memory is" (D69).

**Shipped (2026-07-07):** `ContextMeter` now renders a visible label (`chat.context.label` — EN
**"Memory"** / DE **"Speicher"**; "context"/"Kontext" kept out of the visible label per the no-jargon
rule) beside the bar + `%`, switched `role="progressbar"` → **`role="meter"`** (keeps
`aria-valuemin/max/now` + `aria-valuetext`; `aria-label` = the label). Tooltip reworded to the fill/
auto-summarize mental model with `{pct}` + the approximate `{used}/{window}` token figures for honesty
(EN *"Memory for this conversation: {pct}% full (about {used} of {window} tokens)."* + amber heads-up
*"When it fills up, older messages are summarized automatically to make room."*; DE mirror — placeholder
parity holds). Tone bands + 0.85 trigger unchanged; coverage (#24) kept separate. Tests: new
`ContextMeter.test.tsx` (+7) + updated `ChatCompaction.test.tsx`; suite 3665/47, typecheck + build green.
Folded into `design-guidelines.md` §11.9; a `context-meter`/`-de` preview case added for the eyeball.

- `apps/desktop/src/renderer/chat/ContextMeter.tsx`: add a visible short label (new keys, e.g.
  `chat.context.label` = EN `'Memory'` / DE `'Speicher'` — final copy per
  `design-guidelines.md` no-jargon rules: "context" stays out of the visible label), switch
  `role="progressbar"` → `role="meter"` with `aria-label` from the new key, keep the tone
  bands.
- Reword the tooltip pair (`chat.context.usageTooltip`, `chat.context.willSummarize`) to the
  mental model: "Speicher für dieses Gespräch: {pct} % belegt — bei vollem Speicher fasst die
  App ältere Nachrichten automatisch zusammen" (and the EN mirror).
- CSS (`styles.css` `.context-meter-*`): visually differentiate from a progress bar (label +
  meter); keep the 56px track or restyle to a compact "N %" + label chip — smallest change
  that kills the misreading wins.
- Tests: renderer snapshot/role assertions (meter role, label present, amber/near-full copy).

**Done =** suite green, `screenshot-verify` eyeball of the composer footer, docs
(`design-guidelines.md`) + BUILD_STATE updated, commit references #25.

## 6. Phase 3 — one action on the model screen (#27) ✅ DONE

**Goal:** a first-time user needs exactly one obvious action to chat (D70).

**Shipped (2026-07-07 — COLLAPSE, not the veto):** installed chat cards now show ONE primary
**"Use this model" / „Dieses Modell verwenden"** button (`models.use`) that selects the model AND
starts its runtime via a new MAIN-side `useModel(modelId)` IPC (`registerModelIpc.ts`) — the §7.4
install gate + RAM gate run once, one audit chain (`model_selected` then `runtime_started`), a
non-chat role rejected before any persist, no rollback on a start failure (the fresh selection
stands; auto-start + retry cover it). The button is NOT disabled on `active` (an active-but-stopped
model still needs it to start). Retired `models.select` / `models.startRuntime` / `models.startTitle`;
reworded `chat.noModel.hint*` to "Use this model". Kept: Stop, Starting… spinner, Active/Running
badges, RAM gate, demo-mode developer card, automatic non-chat roles. Tests: `useModel` integration
(persists + starts; install/RAM gates refuse & don't start; non-chat rejected; deep-index abort) +
renderer (one action per installed card, disabled while RAM-gated/busy/anyStarting, Starting…, Stop,
demo, DE label). Preview cases `models` / `models-de` added (PNG capture deferred to CI/POSIX). Folded
into `design-guidelines.md` §11.10; `user-guide.md` model step reworded. Suite green, typecheck +
build clean.

- `apps/desktop/src/renderer/screens/ModelsScreen.tsx:517-560`: replace the Select + Start
  pair with one primary **"Use this model" / "Dieses Modell verwenden"** button →
  `selectModel(id)` then `startRuntime(id)` (sequenced renderer-side or via a new
  `useModel` IPC that does both main-side — prefer the IPC so the audit trail is one event
  and the RAM/install gates run once). States: `Starting…` spinner (exists), running+active
  card shows the Stop button + Active/Running badges (exist).
- Edge cases to keep: RAM gate (`ramTooLow` disable + hint), checksum/install gate (already
  in `startModelRuntime`), demo-mode button, non-chat roles untouched, switching models
  mid-session = the new button on the other card (its start path already handles the swap),
  `autoStartActiveModel` setting unchanged.
- Update the chat empty state (`chat.noModel.*`) and any user-guide copy that says
  "Select, then Start".
- i18n: new `models.use` key; retire/repurpose `models.select`/`models.startRuntime` labels
  (keep `models.stopRuntime`, `models.starting`).
- Tests: renderer (one primary action per installed card; disabled while starting; stop shown
  when running), main (the combined IPC selects **and** starts; gates still enforced).

**Owner veto path (recorded):** keep both buttons, add `models.selectHint`/tooltip and rename
labels ("Als Standard wählen" / "Jetzt laden"). If vetoed, this phase shrinks to copy+tooltip.

**Done =** suite green, `screenshot-verify` of the model card states, docs (`user-guide.md`,
`architecture.md` model-screen note) + BUILD_STATE updated, commit references #27.

## 7. Phase 4 — single-document scope by default + visible scope (#26) ✅ DONE

**Goal:** "ask about exactly this one document" needs zero scope fiddling, and the active
scope is always visible before asking (D71).

**Shipped (2026-07-07):** creation-time docs-only default + an always-visible "Answering from:"
chip, with retrieval semantics (`buildScopeFilter`) untouched. **Seam = renderer-side:**
`ChatScreen.createDocsConversationForAttach` now persists an **empty EXPLICIT** scope
(`{collectionIds:[], documentIds:[]}`) when the user set none, instead of `null` — `resolveScope`
reads that as its v2 branch (no collections) and unions the chat attachments in, so an
attachment-born chat answers from **just its attachment(s)**, not Library ∪ attachment. (Main-side
was rejected: the `conversation_documents` link doesn't exist yet at create time.) `pendingScope` /
"Ask selected" already persisted docs-only, so that path was already correct. Plain conversations
untouched — `createConversationInMode` still creates with `null` → `resolveScope`'s **Library
fallback is byte-identical**; no migration of existing chats. Empty-explicit (not attachment ids in
`documentIds`) keeps `hasExplicitDocSelection=false` (N2). **Attach-to-existing** whole-library chats
raise a one-time `ScopeNarrowDialog` (Just this file → narrow / Whole library → keep), sticky per
conversation. **Display:** the scope popover trigger became the *"Answering from: {source}"* /
*"Antwortet aus: {source}"* chip (`scopeChipLabel` over the extracted `scopeSources`, single-sourced
with `scopeFooterLabel`); single doc/attachment named directly; whole-library reads *"your whole
library — N documents"*. `chat.scopeNotice` one-shot toast kept. New keys: `chat.scope.answeringFrom`,
`chat.scope.wholeLibrary.one/.other`, `chat.scope.narrow{Title,Body,Just,Whole}` (EN+DE, placeholder
parity). Tests: `collections.test.ts` (+2 main: empty-explicit + attachment resolves to just the
attachment / plain stays Library / "Ask selected" resolves to those docs), `ScopePopover.test.tsx`
(chip states + DE + picker-opens), `ScopeNarrowDialog.test.tsx` (+4 narrow/widen round-trip + DE);
stale ChatAttach/ChatHomeNav/ChatUnmount/GermanSmoke footer-copy assertions rewritten in place. Suite
3688/47, typecheck + build + preview:build green. Preview cases `scope-chip` / `-de` added (PNG
deferred to CI/POSIX). Folded into `rag-design.md` §10 scope section; `user-guide.md` scope step
reworded.

- **Creation-time default:** in the conversation-creation paths that carry documents
  (`ChatScreen.tsx` `createConversationInMode` attachment path; the Documents screen
  "Ask selected" → `initialScopeDocumentIds`), persist `scope_v2` = those `documentIds`
  instead of leaving the scope empty (= Library via `resolveScope`,
  `collections.ts:474-478`). Attaching a document to an **existing** conversation with no
  explicit scope: offer the narrow ("Just this document / Whole library" choice at attach
  time — sticky per conversation once chosen). `resolveScope`'s Library fallback for plain
  conversations stays byte-identical.
- **Visible scope:** the footer label (`scopeFooterLabel`, `ScopePopover.tsx:45-69`) already
  exists but under-communicates. Strengthen to an explicit "Answering from: {doc}" /
  "Antwortet aus: {doc}" chip near the input incl. the whole-library case with a count
  ("your whole library — N documents"), one click opens the picker. Keep the one-shot
  filename auto-scope notice (`chat.scopeNotice`) — it complements, not replaces.
- Retrieval semantics unchanged (`buildScopeFilter` untouched); this phase only changes what
  gets *persisted* as scope at creation/attach and how scope is displayed.
- Tests: main (created-with-attachment conversation resolves to the attachment only; plain
  conversation still Library; existing persisted scopes untouched), renderer (chip shows doc
  name / library+count; picker round-trip).

**Done =** suite green, docs (`rag-design.md` scope section) + BUILD_STATE updated, commit
references #26.

## 8. Phase 5 — coverage statement on every grounded answer (#24) ✅ DONE

**Goal:** after a document-grounded answer the user can see what was actually consumed (D72).

**Shipped (2026-07-07):** the relevance branch of `generateGroundedAnswer`
([rag/index.ts](../apps/desktop/src/main/services/rag/index.ts)) now stamps a real `relevance`
`CoverageInfo` (was `undefined` ⇒ persisted NULL) computed at the stamp site: `chunksCovered` = the
**distinct cited chunks**, `chunksTotal` = **Σ `documentChunkCount` over the DISTINCT documents the
retrieved chunks came from** (single-doc → that doc's total; multi-doc **sums** across the cited docs),
`fullyChunked` = true iff every such doc is `fully_chunked` (new local `documentIsFullyChunked`
helper). `CoverageMeter.breadthOf()`'s relevance branch renders the fraction (new key
`coverage.relevance.counted` — EN **`Based on {covered} of {total} sections`** / DE **`Basiert auf
{covered} von {total} Abschnitten`**, `{covered}/{total}` parity) **only when `chunksTotal > 0`**; a
NULL/legacy turn (the `chunksCovered:0, chunksTotal:0` fallback `Transcript.tsx` passes) keeps the flat
`coverage.relevance` label **byte-identical**. `mode` stays `relevance` (multi-doc honest via wording,
never "whole document"); the whole-document/tree/capped/extract stamps + honesty gates are untouched; an
empty retrieval still persists no coverage. Two `rag-skill-analysis.test.ts` assertions that pinned the
old relevance⇒undefined behavior updated to `mode==='relevance'` (still proving no analysis handler
fired). Tests: new `rag-relevance-coverage.test.ts` (+5: single-doc counts; `fullyChunked` false for a
legacy doc; multi-doc SUMS over the DISTINCT cited docs only — a decoy doc's sections excluded;
empty-retrieval persists no coverage; whole-document still stamps `capped`); `Coverage.test.tsx` (+3:
counted fraction renders EN, NULL/legacy keeps the flat label, DE fraction forced via
`UI_LANGUAGE_STORAGE_KEY` + asserted from the de catalog). Preview cases `coverage-line`/`-de` added
(counted fraction + flat fallback; PNG deferred to CI/POSIX). Suite 3696/47, typecheck + build +
preview:build green. Folded into `rag-design.md` §14.4 (D72 note); `user-guide.md` chat step gains the
honesty-line note.

- **Stamp:** in `generateGroundedAnswer`'s relevance branch (`rag/index.ts:1525-1542` →
  persist at `:1683-1691`), build `CoverageInfo{ mode:'relevance', chunksCovered: distinct
  cited chunk count, chunksTotal: Σ documentChunkCount(db, docId) over the documents the
  citations came from (single-doc scope → that doc's total), fullyChunked }` instead of
  `undefined`. Multi-document scopes stay honest: covered/total then describes "sections
  retrieved of the N documents drawn on" — wording, not math, carries the distinction.
- **Render:** `CoverageMeter.tsx` `breadthOf()` relevance branch (`:39-41`) gains the
  fraction line — new keys alongside `coverage.relevance`, e.g. `coverage.relevance.counted`:
  EN `'based on {covered} of {total} sections'` / DE `'basiert auf {covered} von {total}
  Abschnitten'`; keep the flat label for NULL-coverage legacy turns (the `Transcript.tsx:276`
  `chunksCovered:0` fallback must keep rendering byte-identical for old messages).
- **Honesty gates carry over:** never "whole document" from this path; the §14.5 wording gate
  and the tree/capped meters are untouched. Pages vs sections: sections (chunks) is the
  established denominator; page numbers ride on citations already and stay in the source
  cards.
- Tests: main (relevance answer persists coverage with correct counts; multi-doc counts;
  legacy NULL turns unaffected), renderer (fraction renders for new turns, flat label for
  legacy).

**Done =** suite green, docs (`rag-design.md` §14.4 extension) + BUILD_STATE updated, commit
references #24 (and note the #25 companion line).

## 9. Phase 6 — span-transform engine groundwork (#22 part 1) ✅ DONE

**Goal:** generalize `redaction.ts`'s splice core into a reusable, replacement-strategy-aware
span engine (D74, the substrate for D73/D76).

**Shipped (2026-07-07):** new pure `services/skills/tools/span-transform.ts` — `applySpans(text, spans)`
(the generalized `maskStep`: sorted single-pass splice, byte-identity outside spans by construction,
overlap/out-of-bounds spans skipped **and reported**), the two D74 replacement strategies (`token` /
`perChar` = `█` U+2588 per code unit, same-length + idempotent + shadow-invariant-safe), and
`locateOccurrences(text, needle, {line?, nth?})` (verbatim, non-overlapping, line/nth-anchored,
drop-on-mismatch — the D75/D76 verify half). `redaction.ts`'s `maskStep` refactored onto `applySpans`
(the **shadow discipline stays a redaction concern**: the SAME span list is spliced into both the text
and its same-length shadow, since a `token`/`█` replacement carries no shadow-mapped char);
`redactText(input, strategy)` threads the strategy through the six fixed-order passes; the exported
one-shot detectors stay token. The `redact_document` input schema gained an **optional `strategy` enum**
(gate-validated). **Decision — the WRITTEN FILE stays `token` this phase (option b, lower risk):** the
run seam passes no strategy, so `redacted.txt` is **byte-for-byte the current `[EMAIL]`-token output**;
Phase 7's user-visible wave flips the default to `perChar` (a one-line caller change) alongside the
SKILL.md/report/known-limitations copy — the plan explicitly allows this deferral, and it keeps every
existing redaction pin green. No SKILL.md / routing / confirm-gate / `saveTextFile` change; no LLM pass;
no detector/order change; D58 verbatim-outside-spans + SKA-3 shadow invariants intact. Tests:
`skills-span-transform.test.ts` (+18), `skills-redaction-tool.test.ts` (+3 tool-level strategy plumbing).
No renderer surface changed → no preview case. Suite 3717/47, typecheck + build green. Folded into
`architecture.md` "Skills — design record" **§20**.

- New `apps/desktop/src/main/services/skills/tools/span-transform.ts` (pure, main-side):
  - `applySpans(text, spans: Array<{start,length,replacement}>)` — non-overlapping,
    validated, single-pass splice (extracted/generalized `maskStep`); byte-identity outside
    spans by construction; returns per-span applied/skipped.
  - Replacement strategies: `token` (existing `[EMAIL]`-style) and `perChar` (`'█'.repeat`
    over the span's char length, D74) — per-char keeps line lengths, so extracted-text layout
    survives.
  - Occurrence-anchored find: `locateOccurrences(text, needle, {line?, nth?})` for D75/D76
    verification (verbatim match at the anchored location or drop).
- `redactText` refactors onto the engine (existing detectors unchanged; token masks for the
  dry-run counts, per-char for the file path — plumb a strategy option through
  `redact_document` input schema, default per-char for the written file). All existing
  redaction tests must stay green with token strategy; new tests pin per-char (length
  preserved, line count preserved, idempotent, Unicode shadow invariant holds).
- No SKILL.md / UI change yet (behavior change lands with Phase 7's wave in one user-visible
  step); the per-char default for the written file MAY land here if the copy is updated —
  decide at implementation, record in BUILD_STATE.

**Done =** suite green (all existing redaction pins), engine unit-tested, BUILD_STATE updated.

## 10. Phase 7 — LLM-located redaction: names, addresses, steerable scope (#22 part 2)

**Goal:** "replace all names and addresses, keep the city" works — model locates, app
replaces (D73, D75, D78).

- **New locate pass** (main-side, e.g. `skills/tools/redaction-locate.ts`): feed the document
  text in line-numbered windows to the active local model with a grammar-constrained JSON
  schema (D55, `runtime/llama.ts`) — output
  `{ entities: [{ text, category: name|address|org|other, line }] }`. No free-text parsing;
  temp 0; window overlap so entities straddling window edges are seen whole; per-window
  cancel/abort via the existing seam discipline.
- **Verification + sweep (D75):** each proposed entity must match verbatim at/near its
  anchored line (`locateOccurrences`) or is dropped and counted; every confirmed entity
  string is then masked at **all** occurrences document-wide. The regex detectors keep
  running first as the deterministic floor (emails/IBANs/… never depend on the model).
- **Steerability:** the user's instruction (from the run UI / chat routing) rides into the
  locate prompt as the scoping directive ("names and street addresses; keep city names").
  The category set in the output schema is fixed; the instruction only widens/narrows what
  the model proposes — the app never interprets prose.
- **Flow & gates:** stays user-initiated + confirm-gated (`export-file`); the dry-run answer
  gains the new categories' counts; `skill_runs` metadata stays content-free (entity VALUES
  never logged — same privacy boundary as today). Model-unavailable → the run degrades to
  the deterministic floor with an honest note (offline rule-based mode), never a silent
  partial.
- **Report (D78):** the completion surface states per-category counts, dropped-unverifiable
  count, and the review-before-share reminder.
- **SKILL.md rewrite:** the "no AI judgement and no name detection" honesty block becomes
  "AI-assisted best-effort with a deterministic floor — still not a guarantee"; keywords
  unchanged (vocabulary parity test); routing posture ("do the routing, not the work")
  unchanged.
- Tests: locate-pass unit (schema-forced parse, window overlap, drop-unverifiable), sweep
  (one confirmation masks all occurrences), integration over the run seam (mock runtime
  returns fixture entities; counts; cancel mid-window; model-missing degrade), privacy-guard
  extension (no entity value in logs/audit/run rows).

**Done =** suite green, docs (SKILL.md, `known-limitations.md` redaction bullet,
`architecture.md` Skills record pointer) + BUILD_STATE updated, commit references #22.

## 11. Phase 8 — format-preserving targeted edits (#23)

**Goal:** "Vollmachtgeber → Vollmachtgeberin including dependent pronouns" without touching
anything else (D76).

- **New tool `apply_document_edits`** (same Tier-2 pattern as `redact_document`; new SKILL.md
  under `app-skills/` or an extension of an existing document skill — lean: a new
  `document-edit` skill so the redaction skill's privacy posture stays untangled):
  - Locate pass: the instruction + line-numbered text → grammar-constrained JSON of
    occurrence-anchored edits `{ line, find, occurrence, replace }` — this anchoring is what
    makes context-dependent grammatical agreements (der→die only where referring) expressible
    as spans.
  - Verify each `find` verbatim at its anchor (D75 discipline; drop + count otherwise), splice
    via the Phase-6 engine.
  - Pre-write confirm shows the change summary (per-pair counts, dropped count) — the
    "diff-verifiable" acceptance criterion is met by construction (only verified spans
    change) and by the summary.
- Routing: vocabulary + analysis handler mirror the redaction pattern (deflect to the
  user-initiated run; a chat ask never silently rewrites); the chat path's whole-document
  regeneration is NOT removed, but the suggestion surfaces the tool when the ask is
  edit-shaped.
- Tests: mirror Phase 7's (anchored verify, agreement-style multi-pair fixture in German,
  cancel, confirm gate, content-free rows).

**Done =** suite green, docs (new SKILL.md, `architecture.md` Skills record pointer,
`user-guide.md`) + BUILD_STATE updated, commit references #23.

## 12. Phase 9 — same-format output: DOCX rewrite + faithful text (#22/#23 export half)

**Goal:** DOCX in → DOCX out with formatting intact; PDF/TXT output preserves the text layout
we actually have (D77).

- **DOCX writer** (`services/export/docx-rewrite.ts`): open the ORIGINAL stored file bytes
  with `jszip` (promote to a direct dependency — already in the tree via mammoth; dev-time
  install only, offline at runtime); build the text layer by concatenating `<w:t>` node
  contents (in document order, with a node→offset map); run the span pipeline (Phases 6–8)
  over that text layer; write replacements back per node via the offset map (spans crossing
  run boundaries split across nodes); rezip with every other part byte-identical. XML is
  touched only inside `<w:t>` text content — styles, numbering, tables, headers survive
  untransformed.
  - Constraint honored: redaction/edit pipelines re-run their locate+verify on the DOCX text
    layer (it differs from the mammoth-extracted chunk text), so spans are anchored in the
    text that is actually rewritten.
  - New save dialog descriptor (`.docx`) beside `DIALOG_REDACTED`; the format follows the
    source document's type — DOCX source → `.docx` default, everything else → `.txt`.
- **Faithful text output:** the `.txt` path switches from collapsed `chunks` to the
  newline-preserving parser segments (`readDocumentSegments` via `resolveDocumentReader` —
  the reader redaction already has access to), so PDF line structure survives as well as
  extraction allows; with D74 per-char masks, line lengths hold.
- **Out of scope (recorded):** PDF re-export (writing PDFs) — per #23; scanned/image PDFs
  redact only their OCR text layer (documented in known-limitations).
- Tests: docx-rewrite unit over fixture .docx (formatting parts byte-identical, only targeted
  `<w:t>` text changed, span-across-runs, umlauts/UTF-8), integration (redact a DOCX → saved
  copy opens as valid zip, all non-document.xml parts byte-equal), packaging test extension
  if the dep graph changes.

**Done =** suite green, docs (`architecture.md` export record, `known-limitations.md`,
`drive-layout.md` if the dep changes packaging) + BUILD_STATE updated, commit references
#22 + #23.

## 13. Phase 10 — wave close-out

- Gold-set fixtures: 2–3 synthetic lawyer-shaped documents (Vollmacht, letter with
  names/addresses/IBAN) as eval fixtures for the locate pass (mock-runtime replay in CI;
  the real-model eyeball is a PAID_* manual harness note, `model-benchmarks.md`).
- End-to-end eyeball on the real app (`npm run dev` / electron-eyeball): redact + edit a DOCX
  and a PDF, verify against the #22/#23 acceptance criteria; capture findings.
- Docs: fold this plan into the design records per the doc-lifecycle rule (architecture.md
  Skills record §-extension for the span engine/tools, rag-design.md for scope+coverage,
  design-guidelines.md for the meter), add the §-anchor legend, **delete this file**; update
  `user-guide.md` and `troubleshooting.md` (redaction section).
- Close #22–#28 on GitHub with per-issue outcome notes; BUILD_STATE close-out entry.

---

## 14. Constraints & risks (apply to every phase)

- **Hard rules hold:** offline, no cloud/telemetry, no hosted AI APIs — the locate pass uses
  the already-integrated local llama.cpp runtime only; `jszip` is the only dependency change
  (transitive → direct), no native deps.
- **Privacy boundary:** detected entity values and edit strings are CONTENT — never in logs,
  audit, `skill_runs` metadata, or error messages (the existing content-free discipline).
- **Honesty (D78):** no "fully anonymized"/compliance claims anywhere; coverage and
  redaction reports state what was NOT covered/verified.
- **Per-phase ritual (CLAUDE.md):** tests green (`npm test` from repo root), app builds,
  affected `docs/` updated, BUILD_STATE updated, commit references the phase + issue number.
- **Risks:** small-model locate quality (mitigated by the deterministic floor, D75 sweep,
  window overlap, and the gold set — measure before promising); DOCX text-layer vs. extracted
  chunk-text divergence (mitigated by re-anchoring on the DOCX text layer, Phase 9); display
  rewrite of `[Sn]` colliding with literal bracketed text (mitigated by code-span guards +
  narrow regex, Phase 1); the D70 collapse surprising users who relied on select-without-load
  on low-RAM machines (RAM gate still blocks; the veto path is recorded).
