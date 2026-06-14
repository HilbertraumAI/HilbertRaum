# BUILD STATE — HilbertRaum

> **This is the handoff/transport file between build steps and sessions.**
> Read this FIRST at the start of every session. Update it at the END of every phase
> (see "Per-phase ritual" in [`CLAUDE.md`](CLAUDE.md)).
> It carries: current status, decisions, shared data contracts, next actions, open issues.


_Last updated: 2026-06-15 — **Merged the document-organization wave (Phases A–F) to `master`; release
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
| 30 | Opt-in big slot + embeddings (D21 → D23–D28) | ⚪ not started — plan drafted (`docs/big-slot-embeddings-plan.md`) |
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
   ([`docs/big-slot-embeddings-plan.md`](docs/big-slot-embeddings-plan.md), D23–D28): Track A
   (Gemma 4 26B-A4B etc. vs the incumbent Qwen3 30B-A3B, reusing the Phase-29 benchmark) +
   Track B (a better embedder — the reindex-forcing swap; D27 eval-set hardening is the
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
