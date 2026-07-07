# Chat & Documents remediation plan — 2026-07-07

Companion to [`chat-docs-audit-2026-07-07.md`](chat-docs-audit-2026-07-07.md). That report says
*what* is wrong; this plan says *how* to fix each finding **without introducing new issues**, split
into independent sessions each sized for a fresh Claude Code context window.

Every fix below was designed against the real code (not the audit summary): each carries a concrete
change, the edge cases it must handle, a non-regression argument tied to this repo's named
invariants, and a test **with teeth** ("revert the fix → this assertion reddens"). Where a naive fix
would regress, the safer alternative was chosen and the rejected option is recorded so it isn't
re-litigated.

## How to use this plan
- Run the sessions **in order** — later sessions depend on earlier ones (dependency graph in
  [§ Execution order](#execution-order)). Within a session, do the steps in the listed order.
- Each session ends with the repo's **per-phase ritual** (CLAUDE.md): `npm test` green, app builds,
  affected `docs/` updated, `BUILD_STATE.md` updated, commit referencing the session.
- Do **not** batch unrelated sessions into one commit — the point of the split is reviewable,
  bisectable units.
- Line numbers are as of 2026-07-07; re-anchor by symbol name if they have drifted.

## Design decisions that override the audit's first-pass suggestions
These were settled during fix design and are binding for the sessions below:

1. **CB-7 (per-token IPC batching) → DEFER, do not implement now.** The renderer already coalesces
   re-renders (`ChatScreen` flush timer); the only residual cost is a structured-clone of a short
   string, and batching it would add a lifecycle seam to the app's most safety-sensitive path
   (stream teardown / `streamSettled`) for a negligible, unmeasured gain. Revisit only if profiling
   shows contextBridge volume is a real bottleneck. Recorded in Session 5's docs note.
2. **CR-9 (Stop targets `activeId`) → LATENT hardening, not a live bug.** Reachability was traced:
   `ConversationList` disables every non-active row while streaming (`disabled={streaming &&
   !active}`), and every `activeId`-mutating path is `busyStreaming`-guarded, so `streamConvId ===
   activeId` in every state where the Composer Stop renders. The one-line `streamConvId ?? activeId`
   change is byte-equivalent today; adopt it as future-proofing plus a documented reachability note,
   not as a bug fix.
3. **DB-3 → gate on `hasActiveTask()`, NOT the `PROCESS_START_ISO` watermark.** The `now` watermark
   is load-bearing for mid-session-lock recovery (a lock-interrupted import leaves rows whose
   `updated_at` is *after* process start; a `PROCESS_START_ISO` watermark would never reconcile
   them → perpetual wedge). Keep `now`; add the task gate.
4. **DB-5 → decline the count-map cache; do a covering index + an embedded-count early-out.** A
   `document_id` count-map needs a wider invalidation surface than the resident-vector cache (it must
   also catch chunk writes that carry no embedding, plus out-of-band writers); a stale map surfaces
   as a **user-visible wrong chunk badge / false stale-embeddings flag**. The risk/benefit is poor
   for a poll-path optimization.

---

## Session 1 — Documents backend data integrity (DB-1, DB-2, DB-3)

**Why first.** DB-1 is the only finding with **permanent** per-document consequences (a deleted
collection wedges every future re-index of the doc *forever*); DB-2 is a genuine
concurrent-file-corruption race. Both are user-reachable. No dependencies on other sessions.

**Files.** `apps/desktop/src/main/services/collections.ts`, `.../services/ingestion/index.ts`,
`.../ipc/registerDocsIpc.ts`; tests in `tests/integration/docs-ipc.test.ts`.

### DB-1 — collection-destination filing FK-violates → doc wedged forever
**Root cause.** `fileDocumentByDestination`'s `collection` case
([collections.ts:324-326](apps/desktop/src/main/services/collections.ts#L324-L326)) calls the raw
`addToCollection` INSERT whose `ON CONFLICT` catches only the PK, not the FK; with `PRAGMA
foreign_keys = ON` a deleted/unknown `collectionId` throws `FOREIGN KEY constraint failed`. Thrown
inside the import loop's try → doc miscounted `failed`, audit event + deep-index offer skipped, and
`pending_destination_json` **never cleared** → every future `reindexDocument` rethrows. The sibling
conversation branch already has the guard (the N3 fix).

**Fix.** Mirror N3 in the collection case: existence-check the collection, wrap the insert in
try/catch for the check-then-insert race, and **degrade to the Library default** on miss; log the
degrade with ids only. This makes `fileDocumentByDestination` *total* (cannot throw for the FK
reason), so the existing `pending_destination_json = NULL` clear at
[collections.ts:363](apps/desktop/src/main/services/collections.ts#L363) now always runs on both the
in-session and crash-resume reindex paths — no separate clear-pending change needed.

```ts
case 'collection': {
  const exists = db.prepare('SELECT 1 FROM collections WHERE id = ?').get(destination.collectionId)
  if (exists) {
    try { addToCollection(db, [documentId], destination.collectionId, 'source'); break }
    catch { /* deleted between check and insert — fall through to Library */ }
  }
  log.warn('Import destination collection missing; filed into Library instead',
    { documentId, collectionId: destination.collectionId })
  fileIntoLibraryIfUnfiled(db, documentId)
  break
}
```
Add `import { log } from './logging'` to `collections.ts`. **Belt-and-suspenders:** move the
pending-clear `UPDATE` into a `finally` in `fileFromPendingDestination` so a future unforeseen throw
still clears it (the generated-doc early return at
[collections.ts:355](apps/desktop/src/main/services/collections.ts#L355) intentionally does not
clear — those rows carry no destination). Also fix the false `sanitizeDestination` comment at
[registerDocsIpc.ts:92-95](apps/desktop/src/main/ipc/registerDocsIpc.ts#L92-L95) (it claims an
unknown id is "harmless and ignored").

**Non-regression.** Routes the miss through `fileIntoLibraryIfUnfiled` (unfiled-guarded, "Library ==
all"); the generated-doc origin early-return still fires first, so a work-product is never swept into
Library (D3/N1). Adds only a membership row → DATA-1/CASCADE untouched. Existing tests
*"imports into a project via the collection destination"* and *"crash-resume re-index files by the
pending destination"* use **real** collections → existence check passes → still green.

**Tests (teeth).**
1. Import with `destination:{kind:'collection', collectionId:'ghost-id'}` → assert `status.failed===0`,
   doc `indexed`, filed into **Library**, `document_imported` audit fired, `pending_destination_json`
   NULL, and a follow-up `reindexDocument` resolves `indexed` (not the "throws forever" rejection).
   Teeth: revert the guard → the import counts the doc failed and the reindex rejects.
2. Mirror the M1 crash-resume test but `deleteCollection` before reconcile+reindex → assert the doc
   reconciles then reindexes into Library, pending NULL.

### DB-2 — deterministic `.parse-preview` transient shredded by concurrent same-doc readers
**Root cause.** [ingestion/index.ts:1038-1041](apps/desktop/src/main/services/ingestion/index.ts#L1038-L1041)
builds `${documentId}.parse-preview${ext}` keyed only by doc id; shared by the preview IPC,
`buildDocumentSegmentReader`, and `extractSegmentTexts`. Two concurrent same-doc reads decrypt into
and `shredFile` the *same* path.

**Fix.** Unique per call, keeping the `.parse` infix so the startup crash-sweep
(`workspace-vault.ts` matches `name.includes('.parse')`) still covers a leak:
```ts
parseSource = join(storeDir, `${documentId}.parse-preview-${randomUUID()}${ext}`)
```
`randomUUID` is already imported. Every caller uses the returned `parseSource` local (none
reconstructs the name), so nothing depends on the deterministic form. Apply the same uniqueness to
the sibling export transients (`.parse-export`, `.parse-export-bin` at
[ingestion/index.ts:1349](apps/desktop/src/main/services/ingestion/index.ts#L1349) /
[:1393](apps/desktop/src/main/services/ingestion/index.ts#L1393)) — same hazard, and it composes with
DB-7 in Session 5.

**Non-regression.** PERF-1 `decryptFileAsync` unchanged; `.parse` sweep coverage preserved (no
plaintext-lingering regression). No DB write / cache hook touched. Windows MAX_PATH headroom is
ample (+37 chars).

**Tests (teeth).** In an encrypted workspace inject a fake `DocumentCipher` whose `decryptFileAsync`
copies after a `setTimeout(0)` (forces interleave); `await Promise.all([extractDocumentPreview(id),
extractDocumentPreview(id)])` → both resolve with equal non-empty segments, no ENOENT. Optional:
assert no residual `*.parse-preview*` remains. Pre-fix flakes/throws; post-fix stable.

### DB-3 — `reconcileStuckDocuments` flips a live doctask ingestion to `failed`
**Root cause.** The sweep gate at
[registerDocsIpc.ts:477-480](apps/desktop/src/main/ipc/registerDocsIpc.ts#L477-L480) is only
`!importActive && processing.size === 0`; translation-materialize and OCR re-ingest drive `documents`
rows *outside* that bookkeeping, so a `listDocuments` poll during their `chunking`/`embedding`
window flips a live row to `failed`.

**Fix (Option A — the safe one).** Gate the docs sweep on `!ctx.docTasks?.hasActiveTask()` too
(trees/extracts already are); **keep the `now` watermark**. Do **not** switch to `PROCESS_START_ISO`
(rejected: it would never reconcile a mid-session-lock-stranded import whose `updated_at` is after
process start — the exact wedge the `now` watermark exists to fix).
```ts
const taskActive = ctx.docTasks?.hasActiveTask() ?? false
if (!importActive && processing.size === 0) {
  if (!taskActive) { const n = reconcileStuckDocuments(ctx.db, new Date().toISOString()); /* warn */ }
  const nr = reconcileStuckSkillRuns(ctx.db, PROCESS_START_ISO); /* unchanged */
  if (!taskActive) { /* trees + extracts, unchanged */ }
}
```
**Non-regression.** M5/M1 tests pass `docTasks: undefined` → `taskActive=false` → sweep still fires.
Genuinely-stuck prior-session rows still reconcile on the next no-task poll (tasks are one-at-a-time
and finish — bounded latency).

**Tests (teeth).** Seed a doc `status='embedding'` with an old `updated_at`; `listDocuments` with a
fake `docTasks.hasActiveTask:()=>true` → row **still** `embedding`; flip to `false` → reconciles to
`failed`. Teeth: remove the gate → the first list flips the live row.

**Acceptance.** No FK-throw path from filing; a deleted-collection import no longer wedges future
re-index; concurrent same-doc readers never corrupt each other; a live doc-task ingestion is never
flipped to `failed`. **Docs:** note DB-1 degrade + DB-3 gate (and the deliberate `now`-watermark
choice) in the architecture document-organization/reliability record; note DB-2's per-call transient
in the `.parse-preview` sentence. **Risk:** Low — all additive guards.

---

## Session 2 — Chat renderer correctness + stream-recovery tests (CR-1…CR-9, T-1, T-2)

**Why here.** CR-1 is user-visible input loss on a routine failure path; the T-1/T-2 recovery tests
this session lands are the safety net every later chat change relies on, so doing them early de-risks
Sessions 4–5. All changes are in one file cluster (ChatScreen + Transcript) → land together to avoid
merge churn.

**Files.** `apps/desktop/src/renderer/screens/ChatScreen.tsx`, `.../renderer/chat/Transcript.tsx`;
tests in `tests/renderer/`. **Global constraint:** no fix may add an unstable prop to a memoized
child (`Transcript`/`MessageBlock`/`ConversationList`) on the keystroke/flush hot path.

### CR-1 (Medium) — draft + optimistic bubble lost on pre-persist send failure
Keep the early `setInput('')` (responsive; the optimistic bubble shows the text) but **restore on
failure into a still-empty composer**, and only when the user turn did *not* persist (so a
stopped-but-persisted reply doesn't duplicate). Have `stream` report whether the user turn persisted
(derive from the post-`refreshIfVisible` message list — no new IPC); in `onSend`:
```ts
const ok = await stream(convId, text, false, depth, turnSkill)   // false ⇒ pre-persist failure
if (!ok) restoreDraft(text)
// catch (ensureConversation/synchronous throw): setError(...); restoreDraft(text)
function restoreDraft(text: string) { setInput((cur) => (cur === '' ? text : cur)) }
```
The `cur === ''` guard preserves newer text typed during flight; the persisted-check prevents a
duplicate on the M-U2 stopped-partial path. **Rejected:** clearing input only after the guard passes
(would show the text alongside the optimistic bubble for seconds, reading as "not sent" and inviting
a re-send).

**Tests:** (a) reject pre-persist + empty refresh → composer refills, banner shows; (b) type "world"
during flight, reject → composer stays "world"; (c) reject but refresh shows a persisted user turn →
no restore (no duplicate). Teeth on each.

### CR-2 (Medium) — transcript scroll / bottom-pin bleed across conversation switches
**Fix: `key={activeId ?? 'new'}` on the `Transcript` instance.** A fresh instance per conversation
resets `atBottomRef` and the DOM `scrollTop`; the mount scroll effect pins the new conversation to
bottom. **Rejected:** the prop+reset alternative (keep the instance, reset on a `conversationId`
effect) — keying on `activeId` (not `messages`) is decisive: an intra-conversation `refreshIfVisible`
and streaming reattach keep their scroll state (no remount), while only genuine switches remount.
**Non-regression:** `activeId` is stable during keystrokes/streaming → key stable → `React.memo` still
skips Transcript on the hot path; remount cost lands only on rare switches.

**Test:** two conversations; scroll up in A, switch to B → assert `scrollTo` fires for B's
`scrollHeight` on switch. Teeth: remove the key → mount scroll effect doesn't refire.

### CR-3 (Low-Med) — second attach orphans the first import's poll
**Fix: block a second attach while one is pending** (the UI models exactly one `pendingImport`
chip): `if (paths.length === 0 || busyStreaming || pendingImport != null) return` in `attachFiles`,
and gate the composer attach affordance while `pendingImport != null`. **Documented alternative** (if
concurrent attaches are later required): a `Map<jobId, interval>` keyed like the skillruns store +
`pendingImports` map + iterate-clear on unmount. **Non-regression:** an absent `onAttach` handler is
already supported (mirrors `onTryAgain ? h : undefined`); `pendingImport` changes are import-lifecycle,
not hot path.

**Test:** drop A (parks its job), drop B before A completes → only one `importDocuments` for the
window; B ignored/announced. Teeth: remove the guard → two calls, first poll orphaned.

### CR-4 (Low) — stopping a *recovered* stream shows no toast, leaks `stopped.current`
In the recovery tick's completed branch
([ChatScreen.tsx:490-506](apps/desktop/src/renderer/screens/ChatScreen.tsx#L490-L506)), honor the
stop flag (the recovered path has no local `stream()` `finally`):
```ts
if (stopped.current && activeIdRef.current === activeId) showToast(t('chat.stopped'))
stopped.current = false
```
Same predicate shape as the local `finally` → the two paths are mutually exclusive, no double-toast.
Reuses the existing `chat.stopped` key. **Test:** drive recovery, click Stop, next poll `null` →
`chat.stopped` toast, and a subsequent fresh send does not re-show it (flag reset). Teeth on both.

### CR-5 (Low) — reattach `mode` mismatch when `listConversations` throws
Make `stream`'s branch authoritative on the **conversation's** mode, not the screen `mode` state:
```ts
const convMode = conversations.find((c) => c.id === convId)?.mode ?? mode
if (convMode === 'documents') { await window.api.askDocuments(...) } else { await window.api.sendChatMessage(...) }
```
Removes the dependency on `mode` being synced after a failed list fetch; keep the `setMode` at the
reattach site as the cosmetic footer sync. **Test:** fresh mount, `listActiveStreamConversations →
['c1']`, `listConversations` rejects on the re-select; on the recovered documents conversation a send
calls `askDocuments` (not `sendChatMessage`). Teeth: revert to `mode`-based branch.

### CR-6 (Low) — error banner persists across conversation/mode switch
Add an effect `useEffect(() => { setError(null) }, [activeId])`, placed **before** the history-load
effect so the clear runs first and a switch-induced async `listMessages` failure (which resolves
later) still surfaces. Covers select + delete + mode-deselect. **Non-regression:** the only
switch-caused error is the async history-load failure, which lands after the synchronous effect flush
— safe; a stale in-flight `stream` for the old conversation already guards on `activeIdRef.current
=== convId`. **Test:** `listMessages` rejects for A → error shown; select B (resolves) → banner gone.
Teeth: remove the effect.

### CR-7 (Low, latent) — switch-time loads lack the stale-response guard
Add the `cancelled` / `activeIdRef.current === convId` guard (the sibling-effect idiom) to the three
setters — history load ([L415-425](apps/desktop/src/renderer/screens/ChatScreen.tsx#L415-L425)),
`refreshContextInfo`, `refreshAttachments` — right before each `setState`. Pure guard additions, no
behavior change on the non-switching path. **Test:** slow `listMessages` for A resolves after
switching to B → transcript stays B; repeat for `listAttachments`. Teeth: remove guards.

### CR-8 (Low) — `depths['new']` never re-keyed (SKA-18 inconsistency)
In `ensureConversation`, delete the `'new'` depth key alongside the SKA-18 skill re-key so "New chat
starts clean" (a Thorough pick on the 'new' composer must not silently default every later new chat):
```ts
setDepths((prev) => { if (!('new' in prev)) return prev; const next = { ...prev }; delete next['new']; return next })
```
Keep the existing per-conversation `depths[convId]` write. **Recommended over documenting stickiness**
— consistency with SKA-18 is the non-surprising behavior. **Test:** pick Thorough on 'new', send,
New chat → depth menu reads the default. Teeth: remove the delete.

### CR-9 (latent hardening) — `onStop` target
Per design decision #2, adopt the byte-equivalent hardening and document the reachability:
```ts
function onStop() { const target = streamConvId ?? activeId; if (target) { stopped.current = true; void window.api.stopGeneration(target) } }
```
No behavior change in any reachable state. Record the reachability argument (ConversationList
disables mid-stream switches) in the architecture chat record so a future change doesn't relax that
guard without re-checking.

### T-1 (High coverage) — stream-recovery renderer tests
New `tests/renderer/ChatStreamRecovery.test.tsx` (jsdom, fake timers, `stubApi`, the `scrollTo`
`beforeAll` stub, `advanceTimersByTimeAsync`). Three tests:
1. **live bubble + locked composer + refresh-on-completion:** `getActiveStream` returns a snapshot
   for N ticks then `null`; assert the live bubble text, Stop visible + input disabled, then on
   completion the persisted message replaces the bubble and Stop→Send. Fold in CR-4's recovered-stop
   assertion.
2. **fresh-mount re-select + mode mirror:** `activeId` null, `listActiveStreamConversations →
   ['c1']`, `listConversations → [docConv('c1')]`; assert auto-select + documents mode mirrored +
   recovery bubble. Fold in CR-5's list-fetch-failure branch assertion.
3. **user-click-not-yanked:** click c2 before the re-select resolves → assert `activeId` stays c2
   (the `activeIdRef.current != null` guards held). Teeth on each (break the respective branch).

### T-2 (Medium) — conversation-switch mid-stream + Stop target
Assert the **invariant that keeps CR-9 safe:** while streaming c1, the c2 row is `disabled`
(`streaming && !active`), and Stop calls `stopGeneration('c1')` (the streaming conversation). Include
a commented pointer to the reachability argument; optionally a recovery-seam variant asserting
`streamConvId ?? activeId` directly.

**Acceptance.** Failed send keeps the draft; switching conversations shows the right scroll, no stale
banner, no stale snapshot, correct mode branch; recovered-stop confirmed; the recovery flow has
tests. **Docs:** short "FE audit 2026-07-07" §-record note (CR-9 reachability, CR-2 rationale).
**i18n:** none required (reuses `chat.stopped`; optional `chat.attach.busy` for CR-3). **Risk:**
Medium — touches the most intricate renderer effect; lean on the new characterization tests first.
Land CR-4/CR-5 together (both edit the recovery region); CR-6 before CR-7 (effect ordering).

---

## Session 3 — Documents renderer polish (DR-1…DR-9)

**Why here.** Self-contained; parallelizable with Session 2 (different files) but lower urgency.
**Files.** `apps/desktop/src/renderer/screens/DocumentsScreen.tsx`,
`.../screens/documents/{DocRow,SectionRail,format}.tsx`; tests in `tests/renderer/`.

| ID | Fix | Teeth-test |
|---|---|---|
| **DR-1** (Med) | [DocumentsScreen.tsx:444-448](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L444-L448): on id-mismatch/closed modal return **`cur`** not `next` (drop the late page). | Open preview A with cursor, hold `previewDocumentPage`, close modal, resolve → modal stays closed. Revert to `: next` → reopens. |
| **DR-2** (Med) | Monotonic seq token in `refresh`: `const seq = ++refreshSeq.current; …; if (!mountedRef.current) return; if (seq !== refreshSeq.current) return; setDocs/prune`. The **single choke point** covering every caller (poll, toolbar, `run`, mount) — gate before both `setDocs` and the selected-prune so they use the same authoritative snapshot. **Rejected:** serializing only the poll tick (misses tick↔toolbar overlaps). | Out-of-order `listDocuments` (A held, B resolves first, release A last) → `docs` shows B. Remove the check → A clobbers B. |
| **DR-3** (Low) | [L958](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L958): `onClick={() => { void refresh().catch((e) => setError(friendlyIpcError(e))) }}` (already imported). | `listDocuments` rejects on toolbar refresh → banner shows. Revert → no banner + unhandled rejection. |
| **DR-4** (Low) | Replace global `previewLoading` with `previewLoadingId: string \| null`; pass `previewLoading={previewLoadingId === d.id}` per row (DocRow prop stays `boolean`, **no DocRow change**). This *tightens* `DocRow.memo` (a shared boolean busts every row; a per-row `false` is stable). | Open row A's preview (held) → row B's Preview not disabled, not relabeled; assert B's render count unchanged. |
| **DR-5** (Low) | Gate Import on `busy !== null` (all four import buttons). Main-side job exclusivity is the correctness backstop; the renderer gate is the honest affordance. | Bulk re-index running on mount → Import disabled. Revert to `busy === 'import'` → enabled during reindex. |
| **DR-6** (Low, a11y) | [SectionRail.tsx:158-167](apps/desktop/src/renderer/screens/documents/SectionRail.tsx#L158-L167): add the `active` class + `aria-current` to archived projects, mirroring active ones. | Select an archived project → wrapper `active` + `aria-current="true"`. Remove → none. |
| **DR-7** (Low, i18n) | [L476-477](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L476-L477): `setError(localizeServerCopy(t, status.error))` (already imported). | Failed task with a known canonical error under `de` → localized copy. Revert → raw English. |
| **DR-8** (Low, UX) | Loading branch when `docs == null && error == null`: `<div role="status"><Spinner/> {t('docs.loading')}</div>`. New key `docs.loading` in `en.ts` + `de.ts`. | Hold `listDocuments` → spinner present before resolve, gone after. Remove → blank. |
| **DR-9** (Low) | [format.tsx:211-218](apps/desktop/src/renderer/screens/documents/format.tsx#L211-L218): add a GB tier (`const GB = MB*1024; if (bytes < GB) …; return `${fmt(bytes/GB)} GB``). `toLocaleString(lang)` decimal handling unchanged. | `formatSize(2*1024**3,'en')==='2.0 GB'`; `(1.5*1024**3,'de')==='1,5 GB'`. Remove tier → "2048.0 MB". |

**Acceptance.** No modal resurrection; stale refresh can't stick; correct per-row preview labels;
Import gated during any exclusive op; archived-project a11y; localized task errors; first-mount
spinner; GB sizes. **Docs:** none beyond the FE §-record note. **i18n:** `docs.loading` (both
locales). **Risk:** Low. Note DR-4 *improves* memoization and DR-2 *reduces* spurious list swaps.

---

## Session 4 — Chat backend foundations (CB-1, CB-6)

**Why split from Session 5.** CB-1 is a pure-function fix with no collaborators (land first). CB-6
introduces `getLatestMessage`, which CB-2 (Session 5) reuses and CB-3's reorder depends on — landing
it here gives Session 5 a stable base.

**Files.** `apps/desktop/src/main/services/chat.ts`; tests in `tests/integration/chat.test.ts`,
`tests/integration/skills-turn.test.ts`.

### CB-1 — `fitMessagesToContext` user-first normalization
After the fill loop (only in the trimmed branch), drop a leading assistant so the kept tail is
user-first — which also guarantees the synthetic compaction pair is never replayed
ack-without-intro (a lone kept ack *is* that leading assistant):
```ts
while (keptReversed.length > 1 && keptReversed[keptReversed.length - 1].role === 'assistant') keptReversed.pop()
if (keptReversed.length === turns.length) return messages   // identity check stays AFTER the loop
return [...system, ...keptReversed.reverse()]
```
`while` (not `if`) is defensive; the length-1 guard never drops the mandatory final user turn, never
empties. **Belongs in `fitMessagesToContext`** (single owner for chat + RAG; user-first-after-system
is a general template invariant; the split-pair case is a subset). **Non-regression:** identity path
unchanged (`fits→same array`); "contiguous recent tail" assertion is satisfied by a one-shorter
suffix; solo-oversize-final preserved; compaction assembly tests call `buildChatMessages` with no
budget so `fit` isn't invoked. **Tests:** (1) even-count trim → `fitted[1].role==='user'`, dropped
assistant absent, `fitted.at(-1)` is the final user turn; (2) pair-never-split fixture → no leading
ack, no bare ack; (3) solo oversize final → `[sys, final]`. Teeth on each.

### CB-6 — `getLatestMessage` LIMIT-1 twin + single `getSettings` read
Add `getLatestMessage(db, conversationId): Message | null` — a `LIMIT 1` twin of
`getLatestUserMessage` returning a full `Message` (same JOIN/`EXISTS`/ordering as `listMessages`, so
byte-identical to `listMessages(...).at(-1)`; `kind IS NOT 'compaction'`). Use it in `buildTurnFence`
(`const finalTurn = getLatestMessage(db, conversationId)?.content ?? ''`) instead of the heavy
full-history `listMessages`. Then collapse the 3× `getSettings` in `generateAssistantMessage` to one
read, threading the compaction toggle into `buildChatMessages` via a new optional
`compactionOn: boolean = compactionEnabled(db)` last param (backward-compatible — no existing caller
passes it). **Non-regression:** fence content/budget identical → stamp decisions unchanged
(skills-turn tests hold); default param identical to today for all 15 call sites; single-turn
snapshot can't diverge (no mid-turn settings write). **Tests:** `getLatestMessage` returns the tail,
excludes a checkpoint row, null on empty; fence text unchanged old-vs-new; (optional) assert
`buildChatMessages(db,id,ctx,fence,false)` ignores an existing checkpoint (threaded boolean honored).

**Acceptance.** No assistant-first / split-pair prompt possible; per-turn history reads reduced to a
tail `LIMIT 1` + one `getSettings`. **Docs:** one sentence each in the architecture chat-streaming
record (CB-1 user-first + CB-6 tail read). **Risk:** Low (CB-1 pure fn; CB-6 additive twin + default
param).

---

## Session 5 — Chat backend robustness (CB-3, CB-2, CB-4, CB-5) + docs D-1…D-4 + T-5

**Depends on Session 4** (CB-2 reuses `getLatestMessage`; CB-3 reuses the fence reorder). Order the
work CB-3 → CB-2 → CB-4 → CB-5 and sequence the friendly-error `message =` chain
`runtimeUnresponsive → emptyCompletion → overflow → raw`.

**Files.** `apps/desktop/src/main/services/chat.ts`, `.../services/chat/compaction.ts`,
`.../ipc/chat-stream.ts`, `.../services/runtime/llama.ts`, `shared/i18n/{en,de}.ts`; tests in
`tests/integration/chat-compaction.test.ts`, a new `tests/integration/chat-stream-regenerate.test.ts`,
`tests/unit/read-chat-sse.test.ts`, `tests/unit/chat-stream.test.ts`, `tests/integration/chat.test.ts`.

### CB-3 — compaction threshold capped at the L1 budget + estimate fold-in
Cap the trigger at L1's own floor so small windows compact **before** L1 drops history:
```ts
const l1Budget = Math.max(256, window - CHAT_RESPONSE_RESERVE_TOKENS)
const threshold = Math.min(COMPACT_THRESHOLD * window, l1Budget)
if (estimated < threshold) return
```
Crossover proof: `0.85·window ≤ window−1024 ⟺ window ≥ 6827`, so windows ≥ 6827 (8k/16k/32k) select
`0.85·window` **unchanged**; only 2048/4096 get the lower trigger — the fix. **Fold-in** the pre-pass
estimate under-count: use the real `compactionSummaryPair(summary)` token cost (not bare
`summary`+`''`), and add the fixed system-prompt cost + a caller-supplied `reservedTokens` (the
already-built fence's token cost). Add `reservedTokens?: number` to `CompactionOptions`; reorder in
`generateAssistantMessage` to build the fence *before* `ensureCompacted` (free — `buildTurnFence`
doesn't depend on any checkpoint) and pass its cost. **Non-regression:** each existing
`chat-compaction.test.ts` trigger/region/fallback/assembly test verified to still pass (large-window
trigger byte-identical; region-count guard independent of the threshold; +system-prompt keeps
below-threshold cases below). **Tests:** small-window (4096) estimate tuned between 3072 and 3482 →
now fires (old code wouldn't); large-window (8192) trigger unchanged; fold-in fires one turn sooner
than the old `''`-ack estimate.

### CB-2 — regenerate restores the prior reply when the new generation persists nothing
In `withRegenerateGuard`, use the unambiguous `content === ''` "unpersisted-empty" sentinel (the sole
empty-return path of `generateAssistantMessage`) to restore on a Stop-before-first-token (which
*resolves*, not throws):
```ts
const result = await runFn(...)
if (deleted && result.content === '') { restoreMessage(db, deleted); return getLatestMessage(db, conversationId) ?? result }
return result
```
`restoreMessage` re-inserts the original id/`created_at` → no duplicate, and `getLatestMessage` (from
Session 4) returns it as the turn's result so `chat:done` carries the answer to re-show. The `catch`
(non-abort restore) is unchanged. **Composes with CB-4:** once CB-4 turns the completed-zero-token
case into a *throw*, the only resolve-with-empty case is the genuine abort — CB-2 is correct either
way. **Non-regression:** non-regenerate turns unchanged; a real partial (`content !== ''`) keeps the
delete (existing regenerate test green); `deleted === null` benign race skipped. **Tests** (new
`chat-stream-regenerate.test.ts`): stop-before-first-token restores byte-faithfully (id preserved,
rich citations/coverage/skill stamp survive); successful regenerate keeps the delete (ids differ);
non-regenerate empty stop persists nothing.

### CB-4 — completed-but-empty stream surfaces an error instead of a silent blank
Narrow the empty case: keep today's silent-empty for an **abort-before-first-token** and an
**all-think/fence-echo completion** (tokens arrived but stripped to empty); throw only on a
**completed stream that produced zero tokens**:
```ts
const receivedAnyToken = content !== ''            // BEFORE stripThinkBlocks/stripSkillFenceEcho
// … strip …
if (content === '') {
  if (wasAborted || receivedAnyToken) return emptyAssistantMessage(conversationId)
  throw new EmptyCompletionError()
}
```
Track `wasAborted` in the stream catch (covers signal-abort and the name-only `AbortError`). Add
`EmptyCompletionError`/`isEmptyCompletionError`; map to `main.chat.emptyCompletion` in `withChatStream`
(rethrow friendly, like overflow). New i18n key both locales. **Design choice — throw over flagged
persist:** reuses the `chat:error` rail, gives a retry signal, and composes with CB-2. **Non-regression:**
the abort-before-first-token and all-think tests both stay in the silent-empty branch (the design
deliberately narrows to zero-token); no existing test scripts a clean zero-token completion (verified).
**Tests:** zero-token completion throws `EmptyCompletionError`, user turn only persisted; all-think
still persists nothing (no throw) — the narrowing pin; friendly mapping on both event + rejection.

### CB-5 — two-phase idle watchdog in `readChatSSE`
Race each `reader.read()` against an idle timer, armed per-read so a slow-but-alive prefill is safe:
`PREFILL_IDLE_MS = 120_000` until the first chunk (prefill is legitimately slow on a near-window
regenerate), then `STREAM_IDLE_MS = 30_000` between chunks (inter-token gaps are ms; 30 s = wedged).
Reasoning deltas count as chunks (reset the timer → long "thinking" safe). On timeout `reader.cancel()`
+ reject `RuntimeUnresponsiveError`; a `settled` guard prevents double-settle; a signal-abort errors
the read first (never converted to unresponsive → partial persists as today). Add an injectable
`idle` param (defaults → production unchanged). Map `RuntimeUnresponsiveError` →
`main.chat.runtimeUnresponsive` in `withChatStream`. **Scope note:** covers post-response streaming
only (the finding's L285-302); a hang in the initial `server.fetch` is a separate seam. **Non-regression:**
4-arg callers unchanged; normal streams never trip the timer (byte-identical output); abort tests
still see `AbortError`. **Tests** (new `tests/unit/read-chat-sse.test.ts`): a never-enqueuing stream
with tiny injected budgets rejects `RuntimeUnresponsiveError`; a steady stream under budget iterates
clean (per-chunk reset proven); friendly mapping in `chat-stream.test.ts`.

### Docs D-1…D-4 (land in this session, same files)
- **D-1** [architecture.md:963](docs/architecture.md#L963) & **D-2** [rag-design.md:478-479](docs/rag-design.md#L478-L479):
  replace "callers pass `getSettings(db).contextTokens`" with `effectiveContextWindow(runtime,
  getSettings(db))` — the launched `--ctx-size` (§L0), settings only as fallback.
- **D-3** [architecture.md:1069-1070](docs/architecture.md#L1069-L1070): the in-flight
  `AbortController` map is `inFlightStreams` in **`ipc/inflight.ts`** (shared with the RAG channel),
  not `registerChatIpc.ts`.
- **D-4**: add a "Deterministic teardown (R1)" bullet documenting `streamSettled` /
  `awaitInFlightStreamsSettled` — resolves (never rejects) in `withChatStream`'s finally after
  `runFn` unwinds; teardown MUST `abort()` all streams first, then await settle, then close the DB.
  Add the CB-2/CB-4/CB-5 sentences to the streaming/cancellation record.

### T-5 (Boundary-2 now; Boundary-1 here after CB-3)
- **Boundary-2 (region count, CB-3-independent):** `region.length === MIN_COMPACTABLE_TURNS`
  proceeds vs `MIN−1` returns — import the constants, don't hardcode. Teeth: flip `<`→`<=`.
- **Boundary-1 (size threshold):** now that CB-3 makes the threshold `min(COMPACT_THRESHOLD·window,
  window−reserve)`, express the boundary against the **final** expression — compute `estimated`
  in-test from `messageTokens`, invert to an integer-friendly `window`, pin `===threshold` proceeds
  vs `threshold−1` returns. Leave a comment tying it to CB-3.

**Acceptance.** No assistant-first prompt; regenerate never loses the prior answer (stop *or* empty);
completed-empty surfaces a friendly error; a hung sidecar aborts with a distinct error instead of
wedging; compaction fires before L1 drops on small windows; docs consistent. **Risk:** Low–Medium
(CB-1 already landed in S4; CB-3/CB-5 change boundaries/timeouts — the invariant + unit tests are the
guard). **CB-7 is intentionally not done** (design decision #1) — add the one-line deferral note to
the streaming record.

---

## Session 6 — Documents backend performance (DB-4, DB-5, DB-6, DB-7) + D-5

**Why after Session 1.** Shares `ingestion/index.ts` / `registerDocsIpc.ts` with Session 1 — sequence
to avoid merge churn. Performance only bites at scale, so it follows the correctness work.

**Files.** `apps/desktop/src/main/services/ingestion/index.ts`, `.../ipc/registerDocsIpc.ts`,
`.../services/db.ts`; tests in `tests/integration/docs-ipc.test.ts`.

### DB-4 — batch the folder-import queue phase
Extract the bare INSERT into `insertQueuedRow` (returns id, no `SELECT *` re-read); add
`createQueuedDocuments(db, files)` that `statSync`s sizes **outside** the transaction then wraps N
inserts in one `BEGIN…COMMIT` (ROLLBACK+rethrow on a mid-batch failure → the caller's lease-release
catch handles it, nothing half-queued); keep `createQueuedDocument`'s signature/return **byte-identical**
(single-doc callers + materialize + ~60 tests unaffected). Point `importDocuments` at the batch. **Keep
the directory walk synchronous** — `importDocuments` returns `{jobId, documentIds}` synchronously and
tests/renderer depend on ids at return; note this deferral. **Non-regression:** ING-3 ordering
preserved (in-order push); per-file *processing* failure accounting is later in the loop, untouched;
BEGIN…COMMIT of N inserts is the existing idiom. **Tests:** all N rows `queued` immediately after
`importDocuments` returns (locks batch behavior); a direct `createQueuedDocuments` unit (3 paths + 1
nonexistent → 3 ids in order, sizes where statable).

### DB-5 — index + embedded-count early-out (cache declined, decision #4)
Add covering `CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)` in `db.ts`
(verify it doesn't already exist), and short-circuit the embeddings⋈chunks GROUP BY in `listDocuments`
when `!force && rows.every(r => r.status !== 'indexed')` — no indexed row can be flagged stale, so the
join scan is pure waste on the common mid-import polls. **Non-regression:** DB-3/ING-2 two-query shape
retained; F12/PERF-1 resident-vector delta untouched (no new invalidation coupling — the reason the
cache is declined); the M7 stale-embedding test has an indexed row so `embeddedCounts` is still built.
**Test:** a mid-import list (no `indexed` rows) returns correct `chunkCount` and
`staleEmbeddings===undefined` (early-out changes nothing observable). Index change is perf-only.

### DB-6 — cap the `jobs` map (evict done-only)
`IMPORT_JOB_CAP = 16`; after `jobs.set`, evict oldest **done** jobs only (never an in-flight one),
mirroring `PICKER_TOKEN_CAP`. A late poll on an evicted id still gets the synthetic `done:true` and
stops gracefully (existing test). **Non-regression:** the "unknown import job → done:true" test holds;
a just-completed job survives 16 newer jobs — ample for the renderer's final poll. **Test:** run > 16
single-file imports → the first `jobId` returns synthetic `total:0`, the newest returns real counts;
an in-flight job is never evicted (predicate deletes only `s.done`).

### DB-7 — async decrypt on export readers
Make `readStoredDocumentText` / `readStoredDocumentBytes` `async`, switch to `decryptFileAsync` +
`await readFile` (both callers — `exportDocument` handler, `buildOriginalDocumentReader` — are already
async). Combine with DB-2's `randomUUID` uniqueness on the `.parse-export` transients. **Non-regression:**
completes the PERF-1 invariant (a fix, not a break); the `finally` shred runs after the await;
content-boundary §22-M1 unchanged. **Test:** encrypted export round-trips via `decryptFileAsync`
(assert the sync `decryptFile` is not called); a concurrent double-read of the same doc both succeed
(DB-2 sibling).

### D-5 — docs-IPC inventory
Replace the stale enumeration at
[architecture.md:1181-1185](docs/architecture.md#L1181-L1185) with a single-source pointer to
`shared/ipc.ts` (docs group) naming the notable families (import / listing+lifecycle / single+bulk
re-index / bounded preview / export), so future channels don't re-stale it.

**Acceptance.** No multi-second freeze importing a few-thousand-file folder; export doesn't stall the
main process; `jobs` bounded; `listDocuments` cheaper at scale with no correctness risk; the IPC
inventory is accurate. **Risk:** Low–Medium (DB-4/DB-5 touch hot DB paths — the ING-3 ordering and M7
stale-flag tests are the guard). **Docs:** record DB-4 (batch + walk-deferral rationale), the DB-5
decline-the-cache decision (durable, so it isn't re-litigated), DB-6, DB-7 in the reliability/perf
record.

---

## Session 7 — Test & doc closeout (T-3, T-4, T-6, T-7, T-8, D-6) + retire this plan

**Why last.** Pure tests/docs; can absorb anything deferred. Closes the wave and folds this plan into
a durable design record per the CLAUDE.md doc-lifecycle rule.

**Files.** `tests/integration/{docs-ipc,chat-ipc,chat-compaction}.test.ts`,
`tests/renderer/ChatUnmount.test.tsx`; `docs/architecture.md`; `BUILD_STATE.md`.

- **T-3 — docs-IPC guard preconditions.** Park an import on a promise-gated embedder so the doc sits
  in `processing`; assert `deleteDocument`/`reindexDocument`/`previewDocument` reject
  (`/still being processed/`); a variant with `docTasks.isDocumentBusy → true` asserts delete/reindex
  reject (`/task is running/i`) with a **negative control** that `previewDocument` resolves (pins the
  asymmetry — preview only consults `requireNotProcessing`). Mirrors the chat "refuses to delete while
  streaming" test.
- **T-4 — import-loop lock-mid-job break.** A hand-built `mutableCtx()` whose `isUnlocked` flips false
  inside the embedder on the first file; assert `job.done`, `completed===1`, f1 non-terminal
  (raw SELECT, no reconcile), lease balanced; then backdate f1's `updated_at`, flip unlock, and assert
  `listDocuments` reconciles f1 → `failed`. Teeth: remove the drain's `processing.delete` → the gate
  never opens → f1 never reconciles.
- **T-6 — over-mock cleanup.** In `ChatUnmount.test.tsx`, replace the `clearTimeout`-with-specific-id
  spy with a behavioral assertion (advance past `STREAM_FLUSH_MS`, assert no "state update on an
  unmounted component" `console.error`) — refactor-robust (survives a `clearTimeout`→`mountedRef`
  change), keeps the (b) `listDocuments`-count assertion.
- **T-7 — de-flake.** Gate the `cancelReindexAll` embedder (release per file) so cancellation is
  deterministic (`completed===1` exact, not `< total` racing wall-clock); bump the non-racy poll
  ceilings.
- **T-8 — chat export handlers.** Extend the file-level electron mock with `dialog` + `BrowserWindow`;
  assert `exportConversation` sanitizes the `defaultPath` (`Report: Q1/Q2 <draft>` → `Report Q1Q2
  draft.md`), returns null-on-cancel (no audit), and audits `{conversationId}` **only** (no
  title/path leak); brief `exportMessageTable` static-name + null-on-no-table companion. Teeth: weaken
  the `safeName` regex → the `/`-bearing defaultPath assertion reddens.
- **D-6 — chat-IPC inventory.** Replace the stale
  [architecture.md:1127-1135](docs/architecture.md#L1127-L1135) enumeration with a single-source
  pointer to `shared/ipc.ts` (chat group), noting `suggestSkills` in that group is registered by the
  skills IPC, not here.

**Retire the plan into a design record.** Once Sessions 1–6 are merged, fold this plan +
`chat-docs-audit-2026-07-07.md` into **`docs/architecture.md` §45 — "Chat & Documents audit
(2026-07-07) — remediation ledger + close-out"** (append after §44): a per-finding disposition table
(id → severity → fixing commit → status) and a **§-anchor legend** keeping the `CB-n`/`CR-n`/`DB-n`/
`DR-n`/`T-n`/`D-n` code-comment citations resolvable. Explicitly record the deferred/latent items so
the record doesn't read as fully closed: **CB-7 deferred** (decision #1), **CR-9 latent-hardened**
(decision #2), **DB-5 cache declined** (decision #4), and the **walk-stays-sync** deferral (DB-4).
Then `git rm` both plan files (recoverable in history). No GitHub issue is attached (unpushed
local-master wave) — the close-out gate is docs + `BUILD_STATE.md` + owner push.

**Acceptance.** Docs-IPC guards, lock-mid-job break, and export handlers covered; the two over-mock/
flaky patterns fixed; IPC inventories accurate; the wave folded into §45 and the plan files removed.
**Risk:** Low (tests + docs only).

---

## Execution order

```
Session 1  Docs backend data integrity (DB-1, DB-2, DB-3)          ← first: permanent-consequence bugs
Session 2  Chat renderer correctness + recovery tests (CR-*, T-1/2) ← lands the safety net for S4/S5
Session 3  Docs renderer polish (DR-1…DR-9)                         ∥ parallelizable with S2 (diff files)
Session 4  Chat backend foundations (CB-1, CB-6)                    ← getLatestMessage base for S5
Session 5  Chat backend robustness (CB-3, CB-2, CB-4, CB-5) + D-1…4 ← depends on S4
Session 6  Docs backend performance (DB-4…7, D-5)                   ← after S1 (shared files)
Session 7  Test & doc closeout (T-3,4,6,7,8, D-6) + retire plan     ← last
```

**Hard dependencies.**
- **Session 5 → Session 4:** CB-2 reuses `getLatestMessage` (CB-6); CB-3's estimate fold-in reuses
  CB-6's build-fence-before-compaction reorder. Do not start S5 before S4 merges.
- **T-5 Boundary-1 (in S5) → CB-3 (in S5):** write the size-threshold boundary test only after the
  CB-3 threshold expression is final; Boundary-2 (count-based) is independent.
- **Session 6 ⟂ Session 1 files:** both touch `ingestion/index.ts` + `registerDocsIpc.ts`; run S1
  first and rebase S6 to avoid conflicts.

**Soft / none.** Sessions 1, 2, 3 are mutually independent (different subsystems) and may be worked in
any order or in parallel by different sessions; the order above is by risk/priority.

**Cross-finding compositions to preserve** (each a reason to keep the paired items in the same
session): CB-2+CB-4 (a regenerate that produces nothing never loses the prior answer — whether it
stops or completes empty); CB-4+CB-5 friendly-mapping chain (`runtimeUnresponsive → emptyCompletion →
overflow → raw`); CB-3+CB-6 (fence reorder supplies `reservedTokens`).

---

## Coverage map — every audit finding is accounted for

| Finding | Session | Disposition |
|---|---|---|
| CB-1 | 4 | fix (user-first normalization) |
| CB-2 | 5 | fix (restore on unpersisted-empty) |
| CB-3 | 5 | fix (threshold capped at L1 budget + estimate fold-in) |
| CB-4 | 5 | fix (throw on completed-zero-token; narrow empty case) |
| CB-5 | 5 | fix (two-phase idle watchdog) |
| CB-6 | 4 | fix (`getLatestMessage` + single `getSettings`) |
| CB-7 | 5 | **deferred** (documented; renderer already batches) |
| CR-1 | 2 | fix (guarded draft restore) |
| CR-2 | 2 | fix (`key={activeId}` remount) |
| CR-3 | 2 | fix (block second attach) |
| CR-4 | 2 | fix (recovered-stop toast) |
| CR-5 | 2 | fix (branch on conversation mode) |
| CR-6 | 2 | fix (clear error on `activeId` change) |
| CR-7 | 2 | fix (stale-response guards) |
| CR-8 | 2 | fix (delete `depths['new']`) |
| CR-9 | 2 | **latent hardening** (proven unreachable) |
| CR-10 | — | **known/accepted** (PERF-2 chat-transcript half; not in scope) |
| DB-1 | 1 | fix (FK-guarded collection filing) |
| DB-2 | 1 | fix (per-call unique transient) |
| DB-3 | 1 | fix (`hasActiveTask()` gate; keep `now` watermark) |
| DB-4 | 6 | fix (batch queue inserts; walk stays sync) |
| DB-5 | 6 | fix (index + early-out; **cache declined**) |
| DB-6 | 6 | fix (cap `jobs`, evict done-only) |
| DB-7 | 6 | fix (async decrypt) |
| DR-1…DR-9 | 3 | fix (all nine) |
| D-1, D-2 | 5 | doc fix (context-budget wording) |
| D-3, D-4 | 5 | doc fix (inflight module + teardown contract) |
| D-5 | 6 | doc fix (docs-IPC inventory) |
| D-6 | 7 | doc fix (chat-IPC inventory) |
| T-1, T-2 | 2 | tests (stream recovery + switch/Stop) |
| T-3, T-4 | 7 | tests (docs guards + lock-mid-job) |
| T-5 | 5 | tests (compaction boundary; Boundary-1 after CB-3) |
| T-6, T-7, T-8 | 7 | tests (de-mock + de-flake + export handlers) |

*Companion to the audit report. Fix designs were produced by four parallel design passes (chat
backend, docs backend, chat renderer, tests/docs) each reading the real code, with the load-bearing
mechanisms (the CB-2 persisted-signal, CB-6 tail-read template, DB-1 filing path) re-verified by the
lead. No code was changed in producing this plan.*
