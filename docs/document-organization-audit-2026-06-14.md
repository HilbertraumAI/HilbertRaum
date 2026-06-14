# Document-organization feature — multi-persona audit (2026-06-14)

**Scope.** The document-organization feature on branch `Improved-Document-Structure`:
Library / Projects / Temporary / Generated / Archive containers, composite chat scope
(D1), generated provenance (D3/N1), smart views, scope-aware retrieval, and rule-based
filing suggestions — Phases A–F plus the doc-lifecycle condensation.

**Branch / commit range.** `master..HEAD` (`Improved-Document-Structure`):
`5c70021` (A) · `7bcd4a1` (B) · `39531e8` (C) · `e0bff6b` (D) · `499c3ab` (E) ·
`477f803` (F) · `550d749` (condensation). Full diff: `git diff master...HEAD`
(52 files, +6679/−298). The plan file `docs/document-organization-plan.md` was deleted in
the condensation; the original is recoverable at `git show 477f803:docs/document-organization-plan.md`.

**Date.** 2026-06-14.

**Remediation status (2026-06-14, branch `Improved-Document-Structure`).** **REMEDIATED.** All Tier-1
correctness bugs are fixed (**DM-1, DM-2, RAG-1**) with the tests that should have caught them
(**TEST-1, TEST-8, TEST-2**, the DM-2 regression, plus TEST-5). Hardening fixes applied: **SEC-1, DM-3,
RAG-3, UX-1, DOC-1** (RAG-2 addressed by a clarifying comment, not a pin — pinning would regress a scope
that deliberately includes archived docs). **Deferred:** **UX-2** (formal "Sie/Ihre") and **UX-3**
(attachment `aria-live`, needs a new German string) are folded into the pending **D-L7 German-copy
review** rather than fixed ad hoc; RAG-4 / DOC-2 / DOC-4 and similar are correct-by-spec or
stale-but-permitted nits. Design records updated (architecture.md §1/§4/§6, rag-design.md §13.6,
known-limitations.md). See `BUILD_STATE.md` top entry for the full close-out. Suite: **1243 passed / 25
skipped**.

**Method.** READ-ONLY. Six independent persona passes, each opening the cited code and
confirming line numbers and behaviour against the design records
(`architecture.md` "Document organization — design record" §1–§8, `rag-design.md` §13,
`user-guide.md` §7) and the `BUILD_STATE.md` Phase A–F + close-out claims. Findings are
labelled **bug** (wrong behaviour) / **doc-drift** (code right, docs stale) /
**gap** (undocumented behaviour or missing test) / **contradiction**. No source, test, or
design-record doc was modified — the only file created is this report. The headline bug
(crash-resume) was independently re-verified by the coordinator (see DM-1 evidence).

**Personas.**
1. Retrieval / RAG correctness
2. Data model / migration / version-skew
3. Privacy / security / offline
4. Frontend / UX / accessibility / i18n
5. Docs ↔ code consistency
6. Test-quality skeptic

---

## Summary table

| ID | Severity | Type | One-line |
|---|---|---|---|
| **DM-1** | **High** | bug / contradiction | Crash-resume (M1) re-index path never calls `fileFromPendingDestination` — a crash-interrupted Project/Temporary/conversation import silently lands in Library (or nowhere until the next restart's backfill). |
| **DM-2** | Medium | bug / gap | Generated-doc `origin_json` is stamped *after* `status='indexed'`; a crash in that window lets the Library backfill wrongly file the work-product (D3/N1 violation). |
| **RAG-1** | Medium | bug | `corpusNeedsReindex` is called with whole-corpus visibility on the legacy `scopeDocumentIds` path while retrieval is scoped — wrong re-index/empty-context diagnosis (M2 holds only for the composite-`scope` path). |
| **TEST-1** | High | bug-not-covered | The only M1 crash-resume test calls the *helper* directly and sidesteps the real `reindexDocument` flow, so the suite is green despite DM-1. |
| **TEST-8** | Medium | gap | Union de-dup (a doc in both a picked collection *and* `documentIds`) is never asserted to be counted once. |
| **TEST-2** | Medium | weak-test / gap | Intra-rule ordering (exact-before-contains; cohort tie-break) is never asserted — only the trivial same-target collapse is tested. |
| **SEC-1** | Low | gap | `dismissedFilingSuggestions` is type-checked as `object`, not `string[]`; a non-array/oversized renderer value is persisted unvalidated (degrades to "dismissals stop persisting", no crash). |
| **DM-3** | Low | bug (display-only) | `expandPathsWithSource` sibling-prefix match can mis-attribute `source_folder_label`. |
| **RAG-2** | Low | bug / robustness | Filename auto-scope re-expresses docs purely as `documentIds`, inheriting `includeArchived` by spread — latent archived-leak coupling, no live leak. |
| **RAG-3** | Low | gap | FTS scope predicate lives on the `JOIN … ON` clause, not `WHERE` — correct for INNER join, fragile if ever changed to LEFT JOIN. |
| **RAG-4** | Low | contradiction / doc-drift | One hand-picked doc in a composite scope disables filename auto-scope for the *entire* union; correct-by-spec but easy to miss. |
| **UX-1** | Low | gap (a11y) | Filing-suggestion chip group has no `role`/`aria-label` and the reason text is not `aria-describedby`-tied to Apply. |
| **UX-2** | Low | bug (i18n) | Two new German scope strings use formal "Sie/Ihre" against the pinned informal-"du" glossary (D-L7-tracked). |
| **UX-3** | Low | gap (a11y) | Attachment processing/success has no `aria-live` announcement on the keyboard path; drop overlay is `aria-hidden`. |
| **DOC-1** | Low | gap / contradiction | The architecture record states a "doc-org record §N" code-comment convention that **no** code comment uses (all still say `plan §x`). |
| **TEST-5** | Low | gap | Engine tolerance to a malformed/odd `origin` shape is not asserted at the engine boundary. |
| **TEST-9** | Low | gap | Generated-doc-with-malformed/null-`origin_json` (the crash window of DM-2) is untested. |
| **SEC-2** | Info | observation | `setConversationScope` logs collection/doc *counts* to `app.log` (not the audit log) — id/count only, no name; no action. |
| **DM-4 / DOC-3 / DOC-4 / RAG-5 / RAG-6 / UX-4 / TEST-3 / TEST-12** | Nit | doc-drift / weak-test | Cosmetic alias/signature drift, minor weak-tests; see bodies. |

**Clean areas (no issues found):** SQL parameterization across all scope filters (no injection
vector); the audit data-class (id/type/count only — no name/reason leak in any flow, sentinel
grep is genuinely complete); offline/no-network/no-model in the filing engine; encryption-at-rest
(no unencrypted sidecar); en/de key parity (0 mismatches); C2 delete-project predicate; FK CASCADE
wiring (C4); the D1 union semantics and C1 archive exclusion in retrieval; tolerant parse of
`scope_v2_json`/`pending_destination_json`.

---

## Persona 1 — Retrieval / RAG correctness

**Verified correct:** D1 union (`buildScopeFilter`, `retrieval-scope.ts:46-60`, a genuine
`EXISTS(membership) OR docId IN(...)` — not a short-circuit; attachments always merged in
`resolveScope`, `collections.ts:473-478`); H3 arg-5 normalization
(`normalizeScope`, `rag/index.ts:15-17`, exactly `Array.isArray(scope)||scope==null ?
{documentIds: scope??null} : scope`; every legacy positional caller stays byte-identical;
`generateGroundedAnswer` precedence `opts.scope ?? opts.scopeDocumentIds`); **all ids are
bound `?` parameters everywhere** (`retrieval-scope.ts`, `hybrid.ts`, `embeddings/index.ts`,
`registerRagIpc.ts`) — no injection; C1 doc-level archive exclusion is a separate ANDed
`NOT EXISTS(... lifecycle='archived')` over the whole union, and archiving a *project* never
touches it; D3/N1 generated exclusion is structural (no `role='generated'` predicate exists
anywhere); N2 `hasExplicitDocSelection` is set before attachments/expansion merge; empty-context
⇒ no `chatStream` call holds and strengthens under scope.

### RAG-1 — Medium — bug — M2 re-index honesty is whole-corpus on the legacy `scopeDocumentIds` path
**Location:** `apps/desktop/src/main/services/rag/index.ts:420,437`
**Evidence:**
```ts
const scopeArg = opts.scope ?? opts.scopeDocumentIds            // retrieval IS scoped
...
const answer = corpusNeedsReindex(db, embedder.id, opts.scope ?? undefined)  // check is NOT
```
When a caller uses the legacy `opts.scopeDocumentIds` (no composite `opts.scope`), retrieval runs
scoped to those ids but `corpusNeedsReindex` is handed `undefined` — the whole-corpus visibility
check. If the selected docs are all stale for the active embedder yet *some other* corpus doc is
visible, the user gets `NO_DOCUMENT_CONTEXT_ANSWER` ("nothing relevant") when the truthful answer
is `REINDEX_NEEDED_ANSWER`; conversely a spurious re-index prompt is possible. The §13.6 "scoped
honesty" guarantee therefore holds only for the composite-`scope` path.
**Why it matters:** Latent (the in-tree production caller `registerRagIpc` always passes `scope`),
but any future legacy-path caller inherits a wrong diagnosis — a correctness regression in the
grounding-honesty contract.
**Remediation:** Pass the same scope to the check: `corpusNeedsReindex(db, embedder.id,
normalizeScope(scopeArg))`. If byte-identical legacy behaviour must be preserved, document the
intentional asymmetry and pin it with a test.

### RAG-2 — Low — bug/robustness — Filename auto-scope inherits `includeArchived` by spread
**Location:** `apps/desktop/src/main/ipc/registerRagIpc.ts:72-75`
**Evidence:** `scope = { ...scope, collectionIds: null, documentIds: detected.ids }` — the narrowed
scope drops `collectionIds`, re-expresses the docs as explicit `documentIds` (a UNION term that
bypasses membership), and keeps the original `includeArchived`. No live leak today because both
`documentsInScope` and `retrieve` apply the same `buildScopeFilter`; the risk is a latent coupling.
**Why it matters:** If `documentsInScope` and `retrieve` ever diverged on the archived filter, a
hand-named archived doc would become answerable via the explicit-id branch.
**Remediation:** Add an integration test (name an archived in-scope doc; assert auto-scope can't
surface it) and consider pinning `includeArchived: false` on the narrowed scope.

### RAG-3 — Low — gap — FTS scope predicate is on the JOIN `ON` clause, not `WHERE`
**Location:** `apps/desktop/src/main/services/rag/hybrid.ts:74-83`
**Evidence:** `docFilter` (membership/archived predicate) is concatenated onto
`JOIN embeddings e ON e.chunk_id = c.id AND e.embedding_model_id = ?` rather than the `WHERE`.
Correct today (all INNER joins make ON/WHERE equivalent); the vector path
(`embeddings/index.ts:177-180`) and `corpusNeedsReindex` correctly use `WHERE`/subquery, so this
is an inconsistency that would silently stop excluding rows if the join ever became `LEFT JOIN`.
**Remediation:** Move `docFilter` into the `WHERE` clause; no behaviour change today.

### RAG-4 — Low — contradiction/doc-drift — one hand-picked doc disables auto-scope for the whole union
**Location:** `apps/desktop/src/main/services/collections.ts:457-462`
**Evidence:** The v2 path sets `hasExplicitDocSelection = v2.documentIds.length > 0`; a composite
scope of `collectionIds=[project]` *plus* one hand-picked doc sets the flag `true` and suppresses
filename auto-scope across the *entire* union, even though the collections are still in play. This
is correct-by-spec (§13.5 "skipped only when hasExplicitDocSelection is true") but the UX
consequence is easy to miss.
**Remediation:** None required; add a §13.5 note that one hand-picked doc disables auto-scope for
the whole union.

**Nits.** RAG-5 — the archive `NOT EXISTS` keeps a candidate that has no `documents` row (orphaned
chunk); theoretical given FK integrity. RAG-6 — §13.3 sample SQL is faithful but obscures that the
FTS predicate lands in the `ON` clause (see RAG-3).

---

## Persona 2 — Data model / migration / version-skew

**Verified correct:** additive nullable columns only (`ensureColumn` regex `/^[A-Za-z0-9_ ]+$/`,
`db.ts:150-162`, makes `DEFAULT`/`NOT NULL`/quotes impossible; every new column is a bare nullable
`TEXT` coalesced in code); seed idempotency (`ensureBuiltin`, `db.ts:244-255`, selects-then-inserts
by `type`); Library backfill SQL gates on `status='indexed' AND origin_json IS NULL AND NOT
EXISTS(membership)` (`db.ts:259-266`) — idempotent, generated/failed/queued correctly skipped;
C4 CASCADE on both FKs of both link tables (`db.ts:120-121,133-134`) with `PRAGMA foreign_keys =
ON` and a direct `DELETE FROM documents` (`ingestion/index.ts:1012-1026`); C2
`projectOnlyDocumentIds` counts all other memberships so a Library+project doc is spared
(`collections.ts:207-217`); N3 FK-guarded `linkConversationDocument` (`collections.ts:284-305`).

### DM-1 — High — bug/contradiction — M1 crash-resume re-index never re-files by pending destination
**Location:** `apps/desktop/src/main/ipc/registerDocsIpc.ts:465-486` (`reindexDocument` handler) ·
`apps/desktop/src/main/services/ingestion/index.ts:800-811` (`reindexDocument`) ·
`:953-962` (`reconcileStuckDocuments`) · claim at `docs/architecture.md:~1119` / `BUILD_STATE.md:169`.
**Evidence:** `fileFromPendingDestination` has exactly **one** caller — the in-session import loop
at `registerDocsIpc.ts:273` (whose own comment at line 272 calls it "the crash-resume entry point
(M1)"). The *actual* crash-resume sequence does not pass through that loop:
1. App killed mid-import → row left `queued`/`extracting`, `pending_destination_json` still set.
2. Next open: `reconcileStuckDocuments` flips it to `failed` (and does **not** clear the pending JSON).
3. User clicks Re-index → `reindexDocument` IPC (`:465-486`) → `setStatus('queued')` →
   `processDocument` → reaches `indexed` and **returns**. The handler never calls
   `fileFromPendingDestination`.
The doc reaches `indexed` with its destination intent still recorded but unused and **zero
membership**. On the *next* app open the migration backfill (`db.ts:259-266`) sweeps it into
**Library** (origin is NULL), never the intended Project / Temporary / conversation. For a
`conversation`/`temporary` destination this leaks a meant-to-be-temporary doc into permanent
Library knowledge — a privacy-adjacent regression. The architecture record asserts the opposite:
*"M1 … A crash mid-import re-files to the intended Project/Temporary, not Library."*
**Why it matters:** The headline M1 guarantee is false for the exact scenario it was designed for,
and `pending_destination_json` is never cleared (dead data).
**Remediation:** Call `fileFromPendingDestination(ctx.db, documentId)` on indexing-success in the
`reindexDocument` handler (and/or inside `reindexDocument`). It is idempotent (Library is
unfiled-guarded, pending cleared on first success), so making *every* driver-to-`indexed` file the
doc is the robust single-entry-point fix — and would make the line-272 comment actually true.

### DM-2 — Medium — bug/gap — generated-doc origin stamped after `indexed`; crash window defeats D3/N1
**Location:** `apps/desktop/src/main/services/doctasks/manager.ts:942-953` (`materializeDocument`) ·
backfill `db.ts:259-266`.
**Evidence:** The materialize sequence reaches `indexed` first, stamps origin second, no transaction:
```js
const result = await processDocument(db, storeDir, info.id, …)  // → 'indexed', origin_json NULL
if (result.status !== 'indexed') { … throw … }
setDocumentOrigin(db, info.id, origin)                          // origin_json set HERE
```
A generated doc killed *between* these two steps satisfies the backfill predicate (indexed, no
membership by D3, `origin_json IS NULL`) and is swept into Library on the next open — exactly what
D3/N1 forbids ("generated docs get NO membership … reachable only by explicit doc-id"). The
`catch` at `:962-964` deletes the half-born row but a process kill is not a JS throw.
**Why it matters:** A translation/comparison work-product can silently become trusted Library
corpus after an ill-timed crash, polluting default-scope retrieval. Low probability, silent failure.
**Remediation:** Stamp `origin_json` *before* the row can be `indexed` (e.g. set origin at
`createQueuedDocument` time, or wrap status-flip + origin-write in one transaction) so the backfill
`origin_json IS NULL` guard holds across crashes.

### DM-3 — Low — bug (display-only) — `expandPathsWithSource` sibling-prefix false match
**Location:** `apps/desktop/src/main/services/ingestion/index.ts:1119-1124`
**Evidence:** `const root = roots.find((r) => path.startsWith(r.dir))` matches by raw string prefix
with no separator boundary, so a file under `…\taxes` can false-prefix a picked root `…\tax`.
`cleanRelative` self-heals the relative path (the `..`-escape falls back to basename) but
`source_folder_label` can be attributed to the wrong picked root.
**Why it matters:** `source_relative_path`/`source_folder_label` are documented display-only
(never used for I/O), so this is cosmetic — a wrong folder chip, not a data-integrity issue.
**Remediation:** Compare on a normalized path with a trailing separator
(`path === r.dir || path.startsWith(r.dir + sep)`).

**Nit.** DM-4 — `fileIntoLibraryIfUnfiled` uses a `1: number` literal cast; harmless.

---

## Persona 3 — Privacy / security / offline

**Verified correct (the hard rules hold):** every collection/membership/lifecycle audit call
records ids + type + counts and nothing else (`registerCollectionsIpc.ts:48-101`,
`registerDocsIpc.ts:363-396`); `createCollection`/`renameCollection` receive the name but the IPC
layer never puts it in metadata; the filing path emits **no** audit event at all
(`registerDocsIpc.ts:410-414`), so the suggestion reason cannot reach the log by construction. The
sentinel-grep test seeds both a project-name and a folder-label sentinel and exercises every new
audit-emitting flow (see TEST-6). `filing-suggestions.ts` has zero `Date`/`Math.random`/network/
model imports — deterministic and offline by construction. `sanitizeDestination` falls back to
Library on garbage; `safeIdArray` filters to strings; all SQL is parameterized. New tables live in
the single workspace DB (encrypted at rest); dismissals live in the `settings` blob, no plaintext
sidecar. No org code path touches the network.

### SEC-1 — Low — gap — `dismissedFilingSuggestions` validated as `object`, not `string[]`
**Location:** `apps/desktop/src/main/services/settings.ts:38-39`
**Evidence:**
```ts
const def = (DEFAULT_SETTINGS as ...)[key]            // for this key, def === []
if (def !== null && value !== null && typeof value !== typeof def) continue
```
`typeof [] === 'object'`, so the guard accepts any non-null object — a renderer sending
`dismissedFilingSuggestions: { x: 1 }` or a 100k-element array passes and is JSON-stringified into
the encrypted settings blob verbatim. No array-ness check, no element-type filter, no length cap
(contrast the enum keys just below at `:43-45`, which get exact-value validation).
**Why it matters:** Read back at `DocumentsScreen.tsx:183` as `new Set(s?.dismissedFilingSuggestions
?? [])`; `new Set(nonArrayObject)` throws, but a `try/catch` (`:184`) keeps the prior set, so the
blast radius is "dismissals silently stop persisting", not a crash. No main-side code iterates the
field, so no SQL path is exposed. Still a real contract gap (declared `string[]`) with no size bound
on a renderer-controlled persisted value.
**Remediation:** In `updateSettings`, special-case array-typed defaults: require `Array.isArray(value)`,
coerce to `value.filter(x => typeof x === 'string')`, optionally cap length — mirroring the existing
`safeIdArray`/`parseDocumentScope` pattern.

### SEC-2 — Info — observation — scope counts logged to `app.log`
**Location:** `apps/desktop/src/main/ipc/registerChatIpc.ts:95-99,117-120`
`log.info('Conversation scope set', { conversationId, collections: …length, documents: …length })`
is `app.log` (local, no telemetry), id/count only — never names/reasons. Does **not** violate the
audit data-class. No action; noted to confirm coverage.

---

## Persona 4 — Frontend / UX / accessibility / i18n

**Verified correct:** the filing-suggestion chip is genuinely non-silent — Apply
(`DocumentsScreen.tsx:820-828`) and Dismiss (`:829-836`) are the only paths and nothing files
without an explicit Apply (`onApplySuggestion`, `:559-568`); dismissal persists via `updateSettings`
→ `dismissedFilingSuggestions`, reloaded by `refreshSuggestions` (`:181-186`) and survives refresh;
target-vanished suppression (`suggestionTargetName` returns `''` → `:811` bails); `.doc-suggest`
flex-wraps with no horizontal page scroll at 760/520px (`styles.css:1094,1112-1118,1060-1067`);
**forbidden-UI-words list is clean** in all new user-facing copy (all grep hits are code
identifiers/comments); **en/de key parity is exact** (`docs.suggest.*` 9/9, `docs.smart.*` 8/8,
`docs.provenance.*` 8/8, `chat.attach.*` 5/5; whole-catalog diff 0/0, also typewall-enforced);
the D-L7 flag is **real** (concrete markers at `de.ts:232,1015,1064,1078,1089,1109` +
`architecture.md:870` + `design-guidelines.md:270,501`); staleness badge is icon+word, not
color-only (`:870-872`); Add-to-project menu and scope popover are keyboard-operable with
`aria-label`/`aria-expanded`.

### UX-1 — Low — gap (a11y) — chip group has no accessible grouping; reason not tied to Apply
**Location:** `apps/desktop/src/renderer/screens/DocumentsScreen.tsx:813-837`
**Evidence:** the container is a bare `<div className="doc-suggest">` (no `role`/`aria-label`); the
reason sentence (`docs.suggest.reason.*`) is a loose `<span>` not referenced via `aria-describedby`.
A screen-reader user tabbing to Apply hears its `title` ("File this document into Tax 2025") but not
the *rationale* that makes the suggestion trustworthy.
**Remediation:** wrap in `role="group"` with an `aria-label`; add `aria-describedby` on Apply
pointing at the reason span's id.

### UX-2 — Low — bug (i18n) — two new German scope strings use formal "Sie/Ihre"
**Location:** `apps/desktop/src/shared/i18n/de.ts:1099,1101`
**Evidence:** `'chat.scope.sourcesTitle': 'Wählen Sie Ihre Quellen'` and
`'chat.scope.librarySourceHint': 'Ihre gesamte Wissensbasis'` contradict the pinned informal-"du"
glossary (`de.ts:7`, D-L7). This is a *tracked* gap (the D-L7 review exists to catch it), not
undocumented drift, but it is a concrete pre-existing defect.
**Remediation:** recast informal ("Wähle deine Quellen" / "Deine gesamte Wissensbasis") in the D-L7 pass.

### UX-3 — Low — gap (a11y) — no `aria-live` for attachment processing/success on the keyboard path
**Location:** `apps/desktop/src/renderer/screens/ChatScreen.tsx:836-840`
**Evidence:** the drop overlay is `aria-hidden="true"` (defensible — drag-drop is pointer-only), but
the subsequent pending/processing → live-attachment transition lives in a closed `ScopePopover`
(`ScopePopover.tsx:218-222`) with no live region, so a keyboard/SR user who attaches via the picker
gets no audible "processing"/"added" confirmation (failures *are* announced via `ErrorBanner`).
**Remediation:** add an `aria-live="polite"` status line (or a toast) for processing/added.

**Nit.** UX-4 — Apply/Dismiss are globally disabled while any org op runs (`disabled={busy !== null}`)
with no per-chip busy affordance; functionally correct (prevents double-apply), just no feedback.

---

## Persona 5 — Docs ↔ code consistency

**Verified accurate:** the in-code doc pointers were genuinely repointed
(`shared/types.ts:841-842` and `db.ts:92` → the new records, not the deleted plan); the §3 data
model matches `db.ts` SCHEMA exactly (columns, CASCADE on both FKs, composite PKs, `idx_doccoll_*`;
`last_used_at` correctly absent); the §5 IPC table matches `shared/ipc.ts` channel-for-channel; the
§13.3 SQL sample is faithful (membership EXISTS/IN disjunction + global archive `NOT EXISTS`); every
named symbol exists with the described behaviour (`resolveScope`, `buildScopeFilter`,
`corpusNeedsReindex`, `projectOnlyDocumentIds`, `fileFromPendingDestination`,
`linkConversationDocument`, `provenanceView`, `generatedStaleness`, `matchesSmartView`,
`suggestFilingForDocument`); D1/D2/D3, C1/C2/C3/C4, M1/M2, N1/N2/N3 are all implemented as
documented (the one *behavioural* exception is the M1 crash-resume hole, DM-1 — the doc says the
crash re-files to the intended destination, the code does not on the re-index path). No behaviour in
code is left unexplained by a record.

### DOC-1 — Low — gap/contradiction — the "doc-org record §N" comment convention is unused
**Location:** `docs/architecture.md:~1104-1105` vs code
**Evidence:** the record states *"§ numbers below are stable — new code comments cite them as
'doc-org record §N'."* `grep -rn "doc-org record" apps/desktop/src` → **zero hits**;
`grep -rn "plan §" apps/desktop/src` → ~90 hits, all still using the deleted plan's numbering
(`plan §10.2`, `plan §20 Phase F`, …) which does *not* map onto the new §1–§8 / §13.x scheme.
**Why it matters:** the promised forward convention is followed by no comment, and the surviving
`plan §x` citations point at a deleted file with no lookup table to the new anchors. The CLAUDE.md
doc-lifecycle rule *permits* leaving inline `plan §x` to resolve via git history (so it is acceptable
by policy), but the "new comments cite doc-org record §N" sentence is aspirational, not real.
**Remediation:** soften the sentence to "future comments *should* cite…", or drop it. No code change.

**Nits.** DOC-3 — §13.3 sample uses alias `d`; code uses `da` (`retrieval-scope.ts:66`). DOC-4 —
`docLifecycle` is described as `docLifecycle(row)` but takes the value string; §7 elides the
`documents_` prefix on `documents_removed_from_collection`; §5 omits `archived` from the smart-view
list. All cosmetic. DOC-2 — the ~90 surviving `plan §x` citations are stale-but-permitted (flagged
for completeness only).

---

## Persona 6 — Test-quality skeptic

**Genuinely well-tested:** filing-engine tolerance (null/empty/whitespace folder labels, missing
`collections`) and EN+German filename patterns and archived-target exclusion
(`filing-suggestions.test.ts:82,92,141-161`); the audit privacy sentinel across event_type +
message + metadata_json and all org flows (TEST-6); RAG archive / empty-scope / no-model-call
(`rag-collections.test.ts:94-168`); C2 spare-Library at both the service and IPC layers
(`collections.test.ts:342-352`, `collections-ipc.test.ts:175-201`); renderer
dismissal-persistence-across-refresh and German chip copy (`DocumentsScreen.test.tsx:301-331`,
`GermanSmoke.test.tsx:139-190`).

### TEST-1 — High — bug-not-covered — M1 crash-resume is tested at the helper, not the flow
**Location:** `apps/desktop/tests/integration/collections.test.ts:450-472` vs
`registerDocsIpc.ts:465-486` / `ingestion/index.ts:800-811`
**Evidence:** the only M1 test seeds a `queued` doc with `pending_destination_json`, then **manually
flips status to `indexed` and calls `fileFromPendingDestination(db, 'resume')` directly** — it never
drives the real resume path (`reconcileStuckDocuments` → `failed` → user Re-index →
`reindexDocument`, which never calls `fileFromPendingDestination`). So the suite is green despite
DM-1. The test proves the helper works but asserts nothing about the flow M1 promises.
**Remediation:** add an integration test that imports with a `{kind:'collection'}` destination,
leaves the doc `queued` + pending, calls `listDocuments` (trigger reconcile→failed), then the
re-index IPC, and asserts membership in the target project. That test fails today.

### TEST-8 — Medium — gap — union de-dup is never asserted
**Location:** `apps/desktop/tests/integration/rag-collections.test.ts:71-92`
**Evidence:** the D1 union test puts `inProject` in a project and `specific` as a separate doc in
`documentIds`; it never puts the **same** doc in both branches to prove its chunks aren't
double-counted. If the UNION emitted a doc's chunks twice, retrieval ranking / token budget would
skew silently.
**Remediation:** add a doc that is both a project member and in `documentIds`; assert each chunk id
appears once.

### TEST-2 — Medium — weak-test/gap — intra-rule ordering and cohort tie-break untested
**Location:** `apps/desktop/tests/unit/filing-suggestions.test.ts:107-119` vs
`filing-suggestions.ts:109-124,139`
**Evidence:** the "ranking" test only proves two rules pointing at the *same* target collapse to
length 1. There is no case with two *different* projects where one is an exact folder match and one
is a contained match (the documented "exact before contains", code comment `:108`), and the cohort
tie-break (most-common, then lexicographic id, `:139`) is never exercised with competing projects.
Ordering *is* the product — the UI shows `suggestions[0]`.
**Remediation:** add (a) folder `"Tax 2025 archive"` with projects `"Tax 2025"` (exact) + `"Tax"`
(contained) → assert `out[0]` is exact; (b) a cohort with 2-in-A vs 1-in-B → assert A wins, and an
A/B tie → assert id determinism.

**Lower-severity test findings.** TEST-3 (Low) — the determinism test
(`filing-suggestions.test.ts:163-169`) uses a single-project single-rule input with no sort
pressure, so it proves "no clock/RNG" but not stable ordering; re-run on the multi-project input.
TEST-5 (Low) — engine tolerance to an odd/malformed `origin` shape is not asserted at the engine
boundary. TEST-9 (Low) — the generated-doc-with-malformed/null-`origin_json` crash window (DM-2) is
untested. TEST-12 (Nit) — "Apply clears the chip" (`DocumentsScreen.test.tsx:233-268`) proves the
re-fetch wiring via mocked `filingSuggestions`, not end-to-end removal (the engine-side removal is
proven separately in `filing-suggestions-ipc.test.ts`). TEST-7 caveat (Low) — the sentinel grep is
an allowlist of known events, not an auto-complete check against the audit-emitter surface; worth a
comment.

---

## Verdict on the locked decisions

| Decision | Code | Docs | Status |
|---|---|---|---|
| **D1** composite union scope | ✓ genuine UNION (`buildScopeFilter`, `resolveScope`) | ✓ §13.1-13.3 | **Consistent.** |
| **D2** always-new import (no sha-dedup) | ✓ import never dedups | ✓ §1/§8 | **Consistent.** |
| **D3 / N1** generated = zero membership, no predicate | ✓ structural, doctasks bypass filing | ✓ §3/§6/§13.4 | **Consistent — but** the stamp-after-`indexed` ordering opens a crash window that the Library backfill can violate (**DM-2**, Medium). |
| **C1** doc-level archive only | ✓ global `NOT EXISTS(lifecycle='archived')`; project archive never drops a member | ✓ §13.4 | **Consistent.** |
| **C2** delete-project spares shared docs | ✓ `projectOnlyDocumentIds` counts all memberships | ✓ §1 | **Consistent** (well-tested both layers). |
| **C3** temp attachments via `conversation_documents` | ✓ link, never `scope_json` | ✓ §1 | **Consistent.** |
| **C4** CASCADE on both link tables | ✓ both FKs, `foreign_keys=ON`, direct `DELETE FROM documents` | ✓ §3 + known-limitations | **Consistent.** |
| **M1** crash-resume re-files to intended destination | ✗ **only the import loop files; the re-index resume path does not** | docs claim it works | **NOT consistent — DM-1 (High), TEST-1 (High).** The single documented guarantee that is actually broken in code. |
| **M2** scope-aware re-index honesty | ✓ for the composite-`scope` path; ✗ on the legacy `scopeDocumentIds` path | ✓ §13.6 | **Partially consistent — RAG-1 (Medium).** |
| **N2** filename auto-scope within scope, skip on explicit pick | ✓ `hasExplicitDocSelection` set pre-merge | ✓ §13.5 | **Consistent** (one-hand-pick-disables-union UX is correct-by-spec, RAG-4). |
| **N3** FK-guarded conversation link | ✓ exists-check + try/catch race + `ON CONFLICT DO NOTHING` | ✓ §4 | **Consistent.** |

**Overall.** The feature is implemented carefully and the design records are unusually faithful to
the code — privacy/audit, offline, encryption, SQL-injection safety, CASCADE wiring, and the D1/C1/
C2/C3/C4/N1/N2/N3 decisions are all correct in both code and docs. The one decision that is **wrong
in code** is **M1**: the crash-resume re-index path (`reindexDocument`) never calls
`fileFromPendingDestination`, so a crash-interrupted Project/Temporary/conversation import loses its
destination intent (lands in Library after the next backfill, or nowhere until then) — and the only
M1 test sidesteps that flow, so CI is green (**DM-1 / TEST-1**). Secondary correctness issues are the
generated-doc crash window (**DM-2**) and the legacy-path re-index diagnosis (**RAG-1**). Everything
else is Low/Nit drift, a11y polish, the unused "doc-org record §N" convention (**DOC-1**), and a
handful of missing edge-case tests (**TEST-8 / TEST-2**). No Critical defects, no security or privacy
leak, no scope leak in retrieval.
