# Chat & Documents audit — 2026-07-07

**Scope.** The Chat view (`ChatScreen` + `renderer/chat/*` + the main-process chat service, IPC,
and compaction) and the Documents view (`DocumentsScreen` + `renderer/screens/documents/*` + the
docs IPC layer and ingestion/collections services). Goal: bugs, correctness/reliability issues, and
performance. Read-only — **no code was changed.** Method: five parallel auditor passes (chat
backend, chat renderer, docs backend, docs renderer, tests+docs-accuracy), each finding then
re-verified by the lead against the cited source lines. Findings that turned out to be already
guarded were dropped rather than reported.

This audit deliberately does **not** re-report items already tracked and accepted in the
architecture ledgers — see [§ Already-known / accepted](#already-known--accepted-not-re-filed) at
the end.

---

## 1. Executive summary

**Overall health: good.** Both features are mature and heavily audited already. The streaming
lifecycle, in-flight bookkeeping, stop/abort semantics, regenerate data-safety, delete atomicity,
and the locked-vault guards are all correct and (on the main side) genuinely well tested against a
real SQLite DB with only the IPC transport faked. Nothing Critical was found. No data-loss bug on a
routine path was found in the backend.

**Highest-priority risks (all Medium):**

1. **`CB-1` — context-trim can emit an assistant-first message tail that strict chat templates
   (Mistral-family) reject with HTTP 500.** Latent today because the bundled catalog is
   Qwen3/Gemma (tolerant templates); a landmine for any future Mistral-style manifest.
2. **`DB-1` — a destination-filing FK violation** when a project/collection is deleted while its
   import is running: the doc is mis-counted as *failed*, its audit event is skipped, and **every
   future single re-index of that doc throws forever**. Reachable by a user, and by a code-exec'd
   renderer at will.
3. **`CR-1` — typed input is silently lost** when a send fails before the user turn persists
   (document-task busy, no model running, slot held by another window). Both the composer text and
   the optimistic bubble vanish — precisely when the banner invites a retry.
4. **`DR-1` / `DR-2` — two document-list races**: a late "Show more" preview page can resurrect a
   closed modal or clobber a different document, and an out-of-order `listDocuments` response can
   overwrite a newer snapshot and *stick* (no self-correcting poll).

**Biggest opportunities:**

- **Renderer stream-recovery has zero tests** (`T-1`) — the single most intricate effect in
  `ChatScreen` (navigate-away-and-back-mid-stream), documented as a headline behavior, is
  completely uncovered on the renderer side. Its main-side halves are well tested.
- **Two synchronous main-process hot paths** at document scale (`DB-4` folder-import queue,
  `DB-5` `listDocuments` full-corpus aggregate per poll) — both freeze the UI on a large workspace
  on the portable drive.
- **A cluster of small, cheap renderer polish fixes** (`DR-3…DR-9`, `CR-4…CR-8`) that individually
  are Low but together account for most of the rough edges a user would actually hit.

**Coverage honesty.** Main-process chat + docs logic is excellently tested (real DB, transport-only
mocking, teeth-checked regression assertions, a structural lock-guard enumeration). The one real
hole is the renderer's stream-recovery and cross-conversation stream bookkeeping. Docs are accurate
for users; the mismatches found are internal (two self-contradicting statements about the context
budget, stale module attributions, incomplete IPC inventories).

### Severity roll-up

| Severity | Chat backend | Chat renderer | Docs backend | Docs renderer | Tests | Docs |
|---|---|---|---|---|---|---|
| High | — | — | — | — | 1 (coverage) | — |
| Medium | 1 | 3 | 3 | 2 | 3 | 2 |
| Low | 6 | 5 | 4 | 7 | 4 | 4 |

---

## 2. Findings — Chat backend

### CB-1 — `fitMessagesToContext` can produce an assistant-first tail; strict templates 500
- **Category:** correctness (latent, model-dependent) · **Severity:** Medium · **Confidence:** Medium
- **Location:** [chat.ts:1116-1128](apps/desktop/src/main/services/chat.ts#L1116-L1128)
- **Description.** After keeping the mandatory final (user) turn, the fill loop walks older turns
  newest→oldest and breaks **purely on budget**, never on role parity. Because roles strictly
  alternate post-`collapseToAlternating`, keeping an *even* number of turns yields a trimmed suffix
  `system, assistant, user, …`. Mistral-family templates require the first non-system turn to be
  `user` and `raise_exception` otherwise → llama-server returns HTTP 500. The kept tail is also
  blind to the compaction pair as a unit: a budget break can land *between* the summary-intro
  (user) and its ack (assistant), leaving a dangling "Understood — I'll continue…" with no summary.
- **Evidence.** The loop (`for (let i = turns.length - 2; i >= 0; i--) { … if (used + cost > budget)
  break … }`) has no role check; the function's own docstring at
  [chat.ts:1097-1098](apps/desktop/src/main/services/chat.ts#L1097-L1098) claims "keeping a
  contiguous tail preserves the strict user/assistant alternation" — true for *contiguity*, false
  for *first-role parity*.
- **Consequence.** On a Mistral-template GGUF near the window, a turn count that trims to an even
  tail → `chat:error` on that turn, and it can stay stuck (each persisted answer changes the count
  by 2, preserving parity).
- **Why it hasn't bitten.** The bundled models are Qwen3/Gemma, whose templates tolerate an
  assistant-first tail.
- **Fix.** After the fill loop, if the oldest kept turn is `assistant`, drop that one turn (or
  normalize the kept slice user-first). One line; budget only improves.
- **Testing.** Add a `fitMessagesToContext` case asserting the oldest non-system kept turn is never
  `assistant` when any trim occurred.

### CB-2 — Regenerate + Stop-before-first-token permanently deletes the prior answer
- **Category:** correctness (data-loss edge) · **Severity:** Low · **Confidence:** High
- **Location:** [chat-stream.ts:119-128](apps/desktop/src/main/ipc/chat-stream.ts#L119-L128),
  [chat.ts:1300-1304](apps/desktop/src/main/services/chat.ts#L1300-L1304)
- **Description.** `withRegenerateGuard` deletes the prior reply inside the stream and restores it
  only on a **non-abort** failure. A user Stop that lands before the first token (slot park,
  compaction pre-pass, or a multi-second prefill on a near-window regenerate — exactly when users
  mash Stop) resolves with `content === ''` → `emptyAssistantMessage` persists nothing, and the
  abort branch deliberately keeps the delete. Net: two clicks (Regenerate, Stop) delete an answer
  with nothing in its place.
- **Consequence.** Transcript ends on the user question; the answer is gone from the DB.
- **Fix.** In the guard, also restore the snapshot on abort when the run resolved with an empty,
  unpersisted message (distinguish "aborted, nothing persisted" from "a new partial stands"). This
  matches the docstring's stated intent — an empty *nothing* is not "the new partial/empty reply".
- **Testing.** Regenerate → abort before first token → assert the prior reply row still exists.

### CB-3 — Small context windows drop history before L2 compaction ever fires
- **Category:** correctness / design boundary · **Severity:** Low · **Confidence:** High
- **Location:** [compaction.ts:29](apps/desktop/src/main/services/chat/compaction.ts#L29),
  [compaction.ts:110](apps/desktop/src/main/services/chat/compaction.ts#L110),
  [chat.ts:1106](apps/desktop/src/main/services/chat.ts#L1106)
- **Description.** L1 trim starts dropping oldest turns at `window − reserve(1024) − systemTokens`;
  L2 compaction only fires at `0.85 · window`. These cross at `window ≈ (1024 + sys)/0.15 ≈ 7.5k`.
  Below that (e.g. a 4096 window: L1 trims from ~2970 tokens, compaction fires at 3482) there is a
  ~500-token band, several turns wide, where the prompt silently loses its oldest turns with **no
  checkpoint and no signal** — the exact silent-drop that L2 exists to prevent. Not data loss
  (stored rows survive; a later compaction can summarize them from the DB), but the feature
  systematically arrives late on 4k-window models.
- **Fix.** Derive the compaction threshold from the same budget L1 uses:
  `min(COMPACT_THRESHOLD · window, window − reserve − fixedTokens)`, or fire compaction when
  `fitMessagesToContext` *would* drop turns.
- **Related nit (fold in).** The pre-pass estimate at
  [compaction.ts:104-114](apps/desktop/src/main/services/chat/compaction.ts#L104-L114) omits
  `COMPACTION_SUMMARY_INTRO` + the ack text and the skill fence — a few dozen tokens optimistic,
  same direction as the band.

### CB-4 — A completed reply that strips to empty persists nothing, silently
- **Category:** correctness (edge) · **Severity:** Low · **Confidence:** High
- **Location:** [chat.ts:1297-1304](apps/desktop/src/main/services/chat.ts#L1297-L1304)
- **Description.** The `content === ''` early return is documented for the *stop-before-first-token*
  case, but it also fires on a **completed, non-aborted** stream whose text stripped to empty — a
  server emitting inline `<think>` (the very case `stripThinkBlocks` defends against) or a genuinely
  empty completion. The renderer gets a `done` with an unpersisted empty message; after reload the
  turn shows an unanswered user question with no error, and the `truncated`/`finishReason` signal is
  discarded. On a regenerate this compounds with `CB-2`.
- **Fix.** Distinguish "aborted with no tokens" (keep current behavior) from "completed but
  stripped/empty" — surface the latter as an error (or persist a flagged empty reply).

### CB-5 — No inactivity timeout on the completion stream; a hung sidecar wedges the conversation
- **Category:** reliability gap · **Severity:** Low · **Confidence:** High
- **Location:** [llama.ts:285-302](apps/desktop/src/main/services/runtime/llama.ts#L285-L302)
  (reached from [chat.ts:1267](apps/desktop/src/main/services/chat.ts#L1267))
- **Description.** The only cancellation source is the user's AbortSignal. A sidecar that *dies* is
  handled well (socket error → non-abort throw → friendly error, snapshot restored, in-flight entry
  cleared). But a sidecar that *hangs* (GPU driver stall, deadlocked slot) leaves the stream
  awaiting the next SSE read forever: the conversation stays in `inFlightStreams`, new sends are
  rejected with `streamInFlight`, and `deleteConversation` refuses — recoverable only because Stop
  works (hence Low).
- **Fix.** An idle watchdog around `readChatSSE` (no chunk for N seconds → abort with a distinct
  "runtime unresponsive" error). Cheap and additive.

### CB-6 — Per-turn redundant O(history) work; `buildTurnFence` pages the whole message list for one row
- **Category:** performance · **Severity:** Low · **Confidence:** High
- **Location:** [chat.ts:1348-1349](apps/desktop/src/main/services/chat.ts#L1348-L1349), plus
  `ensureCompacted` + `buildChatMessages` history scans and 3× `getSettings` per turn.
- **Description.** Each turn runs: `ensureCompacted` (checkpoint + `listConversationTurns` +
  regex/token-count over every post-checkpoint turn), then `buildTurnFence` calling the **heavy**
  `listMessages` variant (per-row `EXISTS(result_tables)` subquery, skills JOIN, full
  citations/coverage JSON parse) purely to read the *last* message's content, then
  `buildChatMessages` (checkpoint + `listConversationTurns` again). `getSettings` is hit 3×. All
  synchronous on the main process. Constants are small and post-compaction histories are bounded, so
  Low — but `buildTurnFence` should use a `LIMIT 1` read (a `getLatestMessage` twin of the existing
  `getLatestUserMessage`).
- **Fix.** One-line: add and use a `getLatestMessage(db, conversationId)` in `buildTurnFence`;
  optionally thread one `getSettings` read through the turn.

### CB-7 — Token streaming is one IPC send per token, unbatched
- **Category:** performance (observation) · **Severity:** Low · **Confidence:** High
- **Location:** [chat-stream.ts:172-178](apps/desktop/src/main/ipc/chat-stream.ts#L172-L178)
- **Description.** Each SSE delta triggers a structured-clone IPC message and typically a renderer
  re-render. Acceptable at local rates (~20–80 tok/s) and keeps latency-to-first-paint minimal — an
  observation, not a defect. A ~30 ms micro-batch (flush accumulated deltas per animation frame)
  would cut IPC + renderer churn several-fold on fast GPUs with no perceptible latency cost;
  deep-mode `reasoning` deltas double the volume during thinking.

---

## 3. Findings — Chat renderer

### CR-1 — Composer input + optimistic bubble both lost when a send fails pre-persist
- **Category:** correctness (input loss) · **Severity:** Medium · **Confidence:** High
- **Location:** [ChatScreen.tsx:1199-1219](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1199-L1219);
  main guards run before the user turn is written
  ([registerChatIpc.ts:234-250](apps/desktop/src/main/ipc/registerChatIpc.ts#L234-L250)).
- **Description.** `onSend` does `setInput('')` then appends an optimistic bubble then `await
  stream(...)`. The stream's catch runs `refreshIfVisible()` → `setMessages(persisted)`, which
  removes the optimistic bubble (the turn was never persisted); nothing restores the composer text.
  Failure modes: document-task busy (`DOC_TASK_BUSY` — whose banner explicitly offers a retry),
  "no model running" mid-session, or a second window holding the stream slot.
- **Consequence.** A long typed question disappears from both composer and transcript at the exact
  moment the UI invites the user to retry.
- **Fix.** Restore the draft when `stream` rejects before any token/refresh shows the turn:
  `setInput((cur) => (cur === '' ? text : cur))`; or clear the input only after the send passes the
  guard (first token / usage event).
- **Testing.** Renderer test: gate `sendChatMessage` to reject with `DOC_TASK_BUSY` → assert the
  composer still holds the text and the banner shows.

### CR-2 — Transcript scroll position + bottom-pin bleed across conversation switches
- **Category:** correctness (UX) · **Severity:** Medium · **Confidence:** High
- **Location:** [Transcript.tsx:91-106](apps/desktop/src/renderer/chat/Transcript.tsx#L91-L106);
  instantiated without a `key`/convId prop at
  [ChatScreen.tsx:1660-1680](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1660-L1680).
- **Description.** The Transcript instance persists across conversation switches, so both the DOM
  `scrollTop` and `atBottomRef` carry over. Scroll up in conversation A, click B → `atBottomRef` is
  `false`, the pin-to-bottom effect skips, and B renders at A's leftover offset (clamped) instead of
  at the newest messages; if streaming starts in B, auto-scroll stays off until the user manually
  scrolls down.
- **Fix.** Pass the conversation id and, on change, reset `atBottomRef.current = true` and scroll to
  bottom — or `key={activeId}` the Transcript (heavier: full remount).

### CR-3 — A second attach orphans the first import's watcher (silent per-file failure loss)
- **Category:** correctness (bounded) · **Severity:** Low–Medium · **Confidence:** High
- **Location:** [ChatScreen.tsx:1369-1414](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1369-L1414),
  singletons at [ChatScreen.tsx:225-230](apps/desktop/src/renderer/screens/ChatScreen.tsx#L225-L230)
- **Description.** `pendingImport` and `attachPollRef` are singletons; `watchAttachJob` clears the
  previous job's poll and `attachFiles` guards only `busyStreaming`, not an in-flight import. Attach
  `a.pdf` to chat A, switch to B, attach `b.pdf` before A finishes → A's poll is killed. It
  self-heals on revisit via `refreshAttachments`, but if `a.pdf` *fails to index*, its per-file
  error banner never fires and the file silently never appears.
- **Fix.** Key polls per `jobId` (a map like the skill-runs store), or block/queue a second attach
  while one is pending.

### CR-4 — Stopping a *recovered* stream never confirms the stop (M-U2 gap)
- **Category:** correctness (UX) · **Severity:** Low · **Confidence:** High
- **Location:** [ChatScreen.tsx:1247-1252](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1247-L1252)
  (`onStop`); the stopped-toast lives only in the local `stream()` finally
  ([~L1194](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1194)); the recovery path
  ([L464-516](apps/desktop/src/renderer/screens/ChatScreen.tsx#L464-L516)) has no finally.
- **Description.** For a recovered stream (navigated away and back mid-reply) there is no local
  `stream()` call, so the `finally` that consumes `stopped.current` and shows `t('chat.stopped')`
  never runs; the recovery tick just swaps in the persisted partial with no "stopped" confirmation.
  The M-U2 requirement ("a stopped partial must not look like a normal complete turn") is unmet on
  exactly the path where the user is most disoriented.
- **Fix.** In the recovery tick's completed branch, if `stopped.current`, show the stopped toast and
  reset the ref.

### CR-5 — Fresh-mount stream reattach can leave `mode` mismatched with the reattached conversation
- **Category:** correctness (rare) · **Severity:** Low · **Confidence:** Medium
- **Location:** [ChatScreen.tsx:526-554](apps/desktop/src/renderer/screens/ChatScreen.tsx#L526-L554)
  (and the parallel skill-run reattach)
- **Description.** On reattach, `setMode(conv.mode)` runs only if `listConversations` succeeded and
  the conv was found. If the fetch throws (`convs = []`), the screen reattaches to a *documents*
  conversation while `mode` stays `'chat'`; because `stream()` branches on the `mode` **state**
  (not the conversation's own mode), the next send routes a documents conversation through
  `sendChatMessage` and the footer shows the wrong controls.
- **Fix.** Derive the streaming branch from `activeConversation?.mode ?? mode`, or fetch/retry the
  single conversation before setting `activeId`.

### CR-6 — Error banner persists across conversation and mode switches
- **Category:** correctness (UX) · **Severity:** Low · **Confidence:** High
- **Location:** `error` state at [ChatScreen.tsx:199](apps/desktop/src/renderer/screens/ChatScreen.tsx#L199);
  neither `onSelectConversation` ([L1295-1298](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1295-L1298))
  nor `onSelectMode` ([L1318-1326](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1318-L1326))
  clears it.
- **Description.** A dictation error or `DOC_TASK_BUSY` refusal in conversation A stays displayed
  after switching to B — including its actionable "Cancel the document task" button, now
  contextless. It is dismissible (not a stuck spinner), but it misattributes a stale error to the
  wrong conversation.
- **Fix.** `setError(null)` on `activeId` change / in `onSelectConversation` / `onSelectMode`.

### CR-7 — Conversation-switch data loads have no stale-response guard (pattern deviation)
- **Category:** correctness (latent) · **Severity:** Low · **Confidence:** Medium
- **Location:** history load [ChatScreen.tsx:415-425](apps/desktop/src/renderer/screens/ChatScreen.tsx#L415-L425),
  `refreshContextInfo` [L394-412](apps/desktop/src/renderer/screens/ChatScreen.tsx#L394-L412),
  `refreshAttachments` [L429-442](apps/desktop/src/renderer/screens/ChatScreen.tsx#L429-L442)
- **Description.** Every *other* async consumer in this file guards with `cancelled` /
  `activeIdRef.current === convId`, but these three setters do not. Today Electron `invoke` to
  synchronous DB handlers is FIFO so it self-corrects; the moment one handler becomes async
  main-side (context-usage already awaits), a slow B response can stamp onto conversation C's view.
- **Fix.** Add the same `cancelled` / `activeIdRef` guard as the sibling effects (also removes the
  transient old-conversation flash between switch and resolve).

### CR-8 — `depths['new']` is never re-keyed away, unlike the skill pick (SKA-18 inconsistency)
- **Category:** maintainability / minor UX · **Severity:** Low · **Confidence:** High
- **Location:** [ChatScreen.tsx:1213](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1213) vs the
  SKA-18 delete of `'new'` keys at [L657-676](apps/desktop/src/renderer/screens/ChatScreen.tsx#L657-L676)
- **Description.** A Thorough/Quick pick made on the 'new' composer silently becomes the default for
  every subsequent new chat this session, contradicting the SKA-18 "new chat starts clean" principle
  applied one state over — with no comment claiming the divergence is intentional.
- **Fix.** Delete `next['new']` in the same update, or add a comment documenting deliberate depth
  stickiness.

### CR-9 (candidate) — Stop while viewing a different conversation than the streaming one is a silent no-op
- **Category:** correctness (candidate bug) · **Severity:** Low–Medium · **Confidence:** Medium
- **Location:** [ChatScreen.tsx:1247-1252](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1247-L1252)
- **Description.** `onSelectConversation` intentionally lacks a `busyStreaming` guard (switching
  mid-stream is by design), but `onStop` calls `stopGeneration(activeId)` — the *currently viewed*
  conversation. If the Composer's Stop renders while viewing a different conversation than
  `streamConvId`, pressing it is a no-op on main
  ([registerChatIpc.ts:312-318](apps/desktop/src/main/ipc/registerChatIpc.ts#L312-L318) — no
  controller for that id) and the real stream keeps running. Needs a live UI check of `busyStreaming`
  semantics to confirm reachability (hence Medium confidence).
- **Fix (if confirmed).** Target `streamConvId ?? activeId` in `onStop`; add the renderer test in
  `T-2`.

### CR-10 — Transcript / conversation-list rendering is un-virtualized (known, low urgency)
- **Category:** performance · **Severity:** Low · **Confidence:** High
- **Location:** [Transcript.tsx:132-152](apps/desktop/src/renderer/chat/Transcript.tsx#L132-L152),
  [ConversationList.tsx:306-324](apps/desktop/src/renderer/chat/ConversationList.tsx#L306-L324)
- **Description.** The *streaming* path is well defended (memoized `MessageBlock` keyed by immutable
  id; block-memoized Streamdown re-parses only the last block per 40 ms flush). The residual costs:
  (a) first render of a 300-turn conversation runs `localizeServerCopy` + a full Streamdown parse
  for every assistant turn synchronously; (b) the O(buffer) per-flush passes
  (`localizeServerCopy`, `estimateLiveTokens`, `normalizeMathDelimiters`) are O(n²) aggregate with
  tiny constants. Fine at typical scale. This is the deferred **chat-transcript half of PERF-2** —
  see Already-known.
- **Fix (if it ever bites).** `content-visibility: auto` on `.msg-block` is a cheap first step;
  incremental live-token counting removes the biggest per-flush pass.

---

## 4. Findings — Documents backend

### DB-1 — Collection-destination filing FK-violates when the collection is gone
- **Category:** correctness · **Severity:** Medium · **Confidence:** High
- **Location:** `fileDocumentByDestination` collection case
  [collections.ts:324-326](apps/desktop/src/main/services/collections.ts#L324-L326) → unguarded
  `addToCollection` INSERT [collections.ts:174-180](apps/desktop/src/main/services/collections.ts#L174-L180);
  called in the import loop's try at
  [registerDocsIpc.ts:416](apps/desktop/src/main/ipc/registerDocsIpc.ts#L416), counted failed at
  [registerDocsIpc.ts:432-434](apps/desktop/src/main/ipc/registerDocsIpc.ts#L432-L434); FK enforced
  ([db.ts:156](apps/desktop/src/main/services/db.ts#L156) + `PRAGMA foreign_keys = ON`);
  unguarded re-index call at
  [ingestion/index.ts:1203](apps/desktop/src/main/services/ingestion/index.ts#L1203).
- **Description.** `sanitizeDestination`'s comment claims an unknown collection id "simply yields a
  dangling membership row, harmless and ignored." **False** — `foreign_keys` is ON and
  `document_collections.collection_id` has an enforced FK, so `addToCollection`'s INSERT throws
  `FOREIGN KEY constraint failed` (its `ON CONFLICT DO NOTHING` only catches the PK conflict). The
  conversation branch got exactly this guard (the N3 fix: existence check + try/catch at
  [collections.ts:300-306](apps/desktop/src/main/services/collections.ts#L300-L306)); the collection
  branch never did — a clear asymmetry.
- **Failure scenario.** Start an import targeting project X, delete project X while it runs (or
  before re-indexing a crash-interrupted row). Each doc reaches `indexed`, then
  `fileFromPendingDestination` throws: (1) the loop counts it *failed* and skips the
  `document_imported` audit event + deep-index offer (violating the "no corpus document without an
  audit trail" invariant); (2) `pending_destination_json` is never cleared, so **every subsequent
  single re-index of that doc rejects with a raw FK error** — permanent until delete-and-reimport. A
  code-exec'd renderer can trigger this at will via `options.destination.collectionId`.
- **Fix.** Mirror the N3 pattern in the collection case: verify the collection exists + try/catch,
  falling back to `fileIntoLibraryIfUnfiled`; always clear `pending_destination_json` even when
  filing degrades.
- **Testing.** Import with a destination collectionId that does not exist → assert the doc lands
  `indexed`, files into Library, emits the audit event, and re-indexes cleanly afterward.

### DB-2 — Deterministic `.parse-preview` transient path; concurrent same-doc readers shred each other
- **Category:** correctness (race) · **Severity:** Medium · **Confidence:** Medium (mechanism High)
- **Location:** [ingestion/index.ts:1038-1041](apps/desktop/src/main/services/ingestion/index.ts#L1038-L1041)
  (`${documentId}.parse-preview${ext}` + decrypt-into + `finally` shred); shared callers:
  [registerDocsIpc.ts:587-618](apps/desktop/src/main/ipc/registerDocsIpc.ts#L587-L618) (preview),
  `buildDocumentSegmentReader` ([documentSegments.ts:32-40](apps/desktop/src/main/ipc/documentSegments.ts#L32-L40)),
  `extractSegmentTexts` ([doctasks/handlers/shared.ts:29-34](apps/desktop/src/main/services/doctasks/handlers/shared.ts#L29-L34)).
- **Description.** The transient filename is keyed only by document id. A doc task (or skill run) and
  a user-triggered preview of the **same** document run concurrently: caller B's `decryptFileAsync`
  truncates the file caller A is parsing, and whichever finishes first `shredFile`s it under the
  other's parse.
- **Failure scenario.** Encrypted workspace; start "Translate document", then open the same
  document's preview → the task fails "source unreadable" (or translates zeroed garbage), or the
  preview errors. No persistent data damaged (transients only).
- **Fix.** Make the transient name unique per call
  (`${documentId}.parse-preview-${randomUUID()}${ext}` — the `.parse` infix keeps the crash sweep
  covering it), or serialize same-doc extraction with a per-document read lock.

### DB-3 — `reconcileStuckDocuments` flips a live doctask ingestion to `failed` mid-flight
- **Category:** correctness (reporting; self-heals) · **Severity:** Low · **Confidence:** High
- **Location:** gate [registerDocsIpc.ts:477-480](apps/desktop/src/main/ipc/registerDocsIpc.ts#L477-L480)
  (only `!importActive && processing.size === 0`, watermark = `new Date().toISOString()` = *now*);
  the UPDATE [ingestion/index.ts:1417-1426](apps/desktop/src/main/services/ingestion/index.ts#L1417-L1426);
  uncovered writers `doctasks/handlers/shared.ts:109-115` and `doctasks/handlers/ocr.ts:76-81`.
- **Description.** The protection assumes "a live job continuously bumps `updated_at` past *process
  start*" — valid for a process-start watermark (which `reconcileStuckSkillRuns` correctly uses via
  `PROCESS_START_ISO`), but the documents sweep passes *now*, and `updated_at` is only bumped at
  phase transitions, so during a long chunk/embed phase it is strictly `< now`. Doctask ingestions
  (translation materialize, OCR re-ingest) run outside this module's `processing` set, so they are
  not gated.
- **Failure scenario.** A translation materializes while the user sits on Documents; any
  `listDocuments` poll during its `chunking`/`embedding` window flips it to `failed` +
  "interrupted", flashing a failed row for a succeeding task and firing a spurious warn-log. The
  final `setStatus('indexed')` overwrites the flip — wrong transient status + misleading logs, not
  data loss.
- **Fix.** Add `!ctx.docTasks?.hasActiveTask()` to the documents-sweep gate (matching the
  tree/extract sweeps), or pass `PROCESS_START_ISO` as the watermark like the skill-run sweep.

### DB-4 — Folder-import queue phase runs synchronously in the IPC handler (N auto-commits + sync walk)
- **Category:** performance · **Severity:** Medium · **Confidence:** High
- **Location:** [registerDocsIpc.ts:324-340](apps/desktop/src/main/ipc/registerDocsIpc.ts#L324-L340);
  each `createQueuedDocument` = `statSync` + one auto-commit INSERT + a `SELECT *` re-read
  ([ingestion/index.ts:469-509](apps/desktop/src/main/services/ingestion/index.ts#L469-L509)).
- **Description.** For an N-file folder import the synchronous handler performs a full recursive
  `readdirSync` walk, N `statSync`, **N single-statement write transactions**, and N `SELECT *`
  re-reads — all before the invoke returns, on a DB living on a high-latency USB drive. This is the
  per-row auto-commit pattern the DB-1 chunk-insert fix eliminated elsewhere; the queue loop was
  never batched, and the `getRow` re-read is pure waste (the caller uses only `.id`).
- **Failure scenario.** Importing a folder of a few thousand files freezes the UI (main blocked) for
  the whole queue phase before the job even starts.
- **Fix.** Wrap the queue-row batch in one `BEGIN…COMMIT`; return ids without the re-read; optionally
  move the directory walk off the hot handler.

### DB-5 — `listDocuments` pays O(corpus) aggregates and ships an unbounded payload per poll
- **Category:** performance · **Severity:** Low · **Confidence:** High
- **Location:** [ingestion/index.ts:1482-1541](apps/desktop/src/main/services/ingestion/index.ts#L1482-L1541);
  polled by the renderer during imports.
- **Description.** Every call runs `SELECT … COUNT(*) FROM chunks GROUP BY document_id` (full chunk
  scan) plus an embeddings⋈chunks GROUP BY over the whole embeddings table, builds three full Maps,
  and returns every non-deleted document — no pagination. `filterDocuments` also filters *after*
  building the full list. The N+1 it replaced (DB-3/ING-2) was worse, but at ~100k chunks this is a
  full-corpus aggregate per poll tick on the main thread.
- **Fix (if scale bites).** Cache the count maps and invalidate on the same named-delta hooks
  `invalidateResidentVectors` uses, or push the filter into SQL.

### DB-6 — `jobs` map grows unbounded for the session
- **Category:** maintainability · **Severity:** Low · **Confidence:** High
- **Location:** [registerDocsIpc.ts:138](apps/desktop/src/main/ipc/registerDocsIpc.ts#L138) /
  `jobs.set` at [L354](apps/desktop/src/main/ipc/registerDocsIpc.ts#L354); contrast the capped
  `pickerTokens` (`PICKER_TOKEN_CAP = 16`).
- **Description.** Tiny objects, but every import in a long session is retained forever and
  `importActive` iterates all of them per list poll. Prune done jobs after a grace period or cap
  them like the tokens.

### DB-7 — Export paths use synchronous decrypt/read (inconsistent with the PERF-1 async convention)
- **Category:** performance · **Severity:** Low · **Confidence:** High
- **Location:** `readStoredDocumentText`
  [ingestion/index.ts:1349-1360](apps/desktop/src/main/services/ingestion/index.ts#L1349-L1360),
  `readStoredDocumentBytes` [L1393-1404](apps/desktop/src/main/services/ingestion/index.ts#L1393-L1404).
- **Description.** Every other decrypt on these flows was converted to `decryptFileAsync` "so a large
  import no longer blocks the main process" (PERF-1); the export readers still use sync
  `cipher.decryptFile` + `readFileSync`. Exporting a large document/DOCX original in an encrypted
  workspace blocks the main process for the full decrypt+read.
- **Fix.** Convert both to the async decrypt helper.

---

## 5. Findings — Documents renderer

### DR-1 — Preview "Show more" late response resurrects a closed modal / clobbers a different doc
- **Category:** correctness (race) · **Severity:** Medium · **Confidence:** High
- **Location:** [DocumentsScreen.tsx:444-448](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L444-L448)
- **Description.** The guard correctly detects "current preview is gone or is a different document",
  but then installs the stale page anyway (`: next`) instead of dropping it. **A:** click "Show
  more", press Esc before the IPC resolves → `preview` is `null` → the updater returns `next` → the
  modal re-opens showing a mid-document slice with a wrong "shown/total". **B:** a doc-task completes
  while a load-more is in flight; the done-task effect auto-opens the new document's preview, then
  the late page replaces it with a partial preview of the old document under the new modal.
- **Fix.** Return `cur` instead of `next` when the id mismatches / the modal is closed.

### DR-2 — `refresh()` has no ordering guard; an older `listDocuments` can clobber a newer one and stick
- **Category:** correctness (race) · **Severity:** Medium · **Confidence:** Medium
- **Location:** `refresh` [DocumentsScreen.tsx:219-230](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L219-L230);
  the 400 ms `watchJob` tick [L255-284](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L255-L284).
- **Description.** `refresh` sets `docs` with no sequence check, and the poll tick is async and not
  serialized. If a tick's `getImportJob` + `refresh()` exceeds 400 ms (large library, busy embedder)
  multiple `refresh()` calls are in flight; manual Refresh, `run()`'s refresh, and the done-task
  effect add more. Out-of-order resolution lets an older snapshot overwrite a newer one — and if the
  clobber lands on the final post-completion refresh, the interval is already cleared, so the stale
  list (missing the last doc / showing "Preparing…") sticks until the user manually refreshes.
- **Fix.** A monotonic request counter in `refresh` (`const seq = ++refreshSeq; … if (seq !==
  refreshSeq) return`), or skip a poll tick while one is already in flight.

### DR-3 — Toolbar Refresh button: rejection unhandled, error never surfaced
- **Category:** correctness · **Severity:** Low · **Confidence:** High
- **Location:** [DocumentsScreen.tsx:958](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L958)
  (`onClick={() => void refresh()}`)
- **Description.** Every other `refresh()` call site catches, but the toolbar button's does not, and
  `refresh` lets `listDocuments()` rejections propagate. On a locked workspace / IPC failure the
  click yields an unhandled rejection, no banner, and the list silently stays stale — the exact
  moment the user asked for fresh data.
- **Fix.** `onClick={() => void refresh().catch((e) => setError(friendlyIpcError(e)))}`.

### DR-4 — Screen-global `previewLoading` re-labels and disables *every* row's Preview button
- **Category:** UX + performance · **Severity:** Low · **Confidence:** High
- **Location:** passed to all rows at
  [DocumentsScreen.tsx:877](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L877);
  consumed at [DocRow.tsx:272-279](apps/desktop/src/renderer/screens/documents/DocRow.tsx#L272-L279)
- **Description.** Clicking Preview on one row makes every visible row's button read "Opening…" and
  disables it — the user can't tell which document is opening — and flips a memo-busting prop on
  every visible row twice per preview (bounded by virtualization, so perf impact is modest).
- **Fix.** Pass a per-row boolean (`previewLoadingId === d.id`) for the label; keep a global disable
  if desired.

### DR-5 — Single `busy` scalar shared by two concurrent job pollers
- **Category:** correctness (state fighting) · **Severity:** Low · **Confidence:** Medium
- **Location:** import gate only `busy === 'import'`
  ([DocumentsScreen.tsx:946-949](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L946-L949));
  each poller does `setBusy(null)` on its own completion (L272, L314).
- **Description.** While a bulk re-index runs (`busy === 'reindex-all'`) the Import buttons are not
  disabled; starting an import overwrites `busy` to `'import'`, and whichever job finishes first
  sets `busy` to `null` while the other still runs, prematurely re-enabling `busy !== null` gates.
  Mostly cosmetic — main-side job exclusivity is the real backstop.
- **Fix.** Gate Import on `busy !== null`, or track the two jobs in separate state and derive `busy`.

### DR-6 — Archived projects in the section rail never show the active state
- **Category:** a11y / UX · **Severity:** Low · **Confidence:** High
- **Location:** [SectionRail.tsx:158-167](apps/desktop/src/renderer/screens/documents/SectionRail.tsx#L158-L167)
  (no `active` class / `aria-current`, unlike active projects at
  [L127-131](apps/desktop/src/renderer/screens/documents/SectionRail.tsx#L127-L131))
- **Description.** Selecting an archived project filters the list but no rail item highlights — the
  user and screen readers lose track of the current section.
- **Fix.** Apply the same `is({kind:'project', id:p.id})` class / `aria-current` to the archived
  branch.

### DR-7 — Doc-task failure copy skips `localizeServerCopy` — English error on the German UI
- **Category:** i18n · **Severity:** Low · **Confidence:** Medium
- **Location:** [DocumentsScreen.tsx:476-477](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L476-L477)
  (`setError(status.error)`)
- **Description.** `DocRow` localizes persisted canonical-English errors and `ChatScreen` localizes
  its banner, but a failed summary/translation/OCR task's `status.error` goes into the banner raw. On
  the de-AT machine a known canonical constant renders in English.
- **Fix.** `setError(localizeServerCopy(t, status.error))` (the import is already in scope).

### DR-8 — No loading state on first mount — blank list until `listDocuments` resolves
- **Category:** UX · **Severity:** Low · **Confidence:** High
- **Location:** `empty` derivation [DocumentsScreen.tsx:579](apps/desktop/src/renderer/screens/DocumentsScreen.tsx#L579);
  render at L944/L1074/L1091
- **Description.** With `docs === null` (initial fetch in flight), `empty` is false, so the list area
  is simply blank — no Spinner, no EmptyState. On a large/slow encrypted workspace the screen looks
  broken for the duration.
- **Fix.** Render a Spinner/skeleton when `docs == null`.

### DR-9 — `formatSize` tops out at MB — GB-scale files render as "2457.6 MB"
- **Category:** cosmetic · **Severity:** Low · **Confidence:** High
- **Location:** [format.tsx:211-218](apps/desktop/src/renderer/screens/documents/format.tsx#L211-L218)
- **Description.** The app explicitly supports large files (the "Large files" smart view; long audio
  recordings), so a 2.4 GB recording shows "2457.6 MB" in the meta line and the confirm dialog.
  Locale handling itself is correct (`toLocaleString(lang)` gives the comma decimal on `de`).
- **Fix.** Add a GB tier.

---

## 6. Documentation audit

All doc mismatches are **internal-accuracy** issues (a maintainer/agent reading them, not a user).
The user-facing docs (`user-guide.md` §6/§7, `known-limitations.md`, `troubleshooting.md` chat/docs
entries) were cross-checked against code and are **accurate** — including the honest documentation of
the `onTryAgain` optimistic-drop residual (F7).

| ID | Severity | Doc claim | Code reality | Fix |
|---|---|---|---|---|
| **D-1** | Medium | [architecture.md:963](docs/architecture.md#L963): production callers pass `getSettings(db).contextTokens` | [chat.ts:1237](apps/desktop/src/main/services/chat.ts#L1237): `effectiveContextWindow(runtime, getSettings(db))` — the launched window wins. **The same doc says the opposite at [:977-978](docs/architecture.md#L977-L978).** | Rewrite the parenthetical to cite `effectiveContextWindow` / the launched window (§L0). |
| **D-2** | Medium | [rag-design.md:478-479](docs/rag-design.md#L478-L479): history trimmed "passed `getSettings(db).contextTokens`" | [rag/index.ts:1416](apps/desktop/src/main/services/rag/index.ts#L1416): `effectiveContextWindow(...)`; rag-design §15 states the correct rule. | Same one-phrase correction; consider one canonical "context budget" anchor both docs cite. |
| **D-3** | Low | [architecture.md:1069-1070](docs/architecture.md#L1069-L1070): in-flight `AbortController` map "in `ipc/registerChatIpc.ts`" | The map is `inFlightStreams` in [inflight.ts:9](apps/desktop/src/main/ipc/inflight.ts#L9), shared with the RAG channel; the doc's own "Stream recovery" bullet already says `inflight.ts`. | Point the cancellation bullet at `inflight.ts`; note the RAG sharing (it's why `stopGeneration` can cancel either path). |
| **D-4** | Low–Med | Streaming-contract section never mentions `streamSettled` / `awaitInFlightStreamsSettled` | [inflight.ts:27-50](apps/desktop/src/main/ipc/inflight.ts#L27-L50): a teardown-ordering-critical contract ("caller MUST abort every in-flight stream FIRST") with 3 dedicated tests; only appears in the §40 audit-ledger, not the feature section. | Add one bullet: settled-promise purpose + abort-first contract + pointer to `lock-stream-persistence.test.ts`. |
| **D-5** | Low | [architecture.md:1181-1185](docs/architecture.md#L1181-L1185): docs-IPC inventory | Omits `previewDocumentPage`, `exportSummary`, `startReindexAll`, `getReindexAllJob`, `cancelReindexAll` (documented elsewhere). | Complete the list or replace with "see `shared/ipc.ts` (docs group) — single source of truth". |
| **D-6** | Low | [architecture.md:1127-1135](docs/architecture.md#L1127-L1135): chat-IPC inventory | Omits `listAttachments`, `getConversationContextUsage`, `getConversationSummary`, `setConversationDefaultSkill`, `exportMessageTable`. | Same fix as D-5. |

---

## 7. Testing audit

**Strengths (verified by reading test code — state these with confidence).** The main-process chat +
docs suites are integration-grade: they run the **real** chat service / import loop against a real
temp SQLite DB and fake only the Electron IPC transport. Covered with teeth: token/done/error
channel ordering, concurrent-second-stream rejection without clobbering the first controller,
stop→abort→partial-persist→`done`-not-`error`, `streamSettled` R1 resolution on success *and* throw,
regenerate delete/restore byte-faithful both directions, compaction trigger boundaries + chained
re-compaction + FTS exclusion of checkpoints + a real schema-migration test, `fitMessagesToContext`
invariants, a **structural** locked-vault guard enumeration with a count floor, and the docs import
loop (crash-resume reconcile→re-index filing, destination filing, picker-token capability binding,
malformed-arg lease-leak). Renderer unmount guards carry explicit "drop the guard → this fails"
comments. Flakiness posture is good (fake timers in the timing-sensitive renderer tests).

| ID | Severity | Gap | Where the behavior lives | Recommended test |
|---|---|---|---|---|
| **T-1** | High (coverage) | Renderer stream-recovery flow (navigate away and back mid-stream) completely untested — `getActiveStream` only ever stubbed to `null`; `listActiveStreamConversations` consumption zero tests. | [ChatScreen.tsx:464-516](apps/desktop/src/renderer/screens/ChatScreen.tsx#L464-L516), [:526-554](apps/desktop/src/renderer/screens/ChatScreen.tsx#L526-L554) | jsdom + fake timers: stub `getActiveStream` non-null for N ticks then null; assert live bubble, locked composer, transcript refresh on completion; a second test for fresh-mount re-select + a third asserting a user click is not yanked. |
| **T-2** | Medium | Conversation-switching mid-stream untested; also triages the `CR-9` candidate (`onStop` targets `activeId`, not `streamConvId`). | [ChatScreen.tsx:1247-1252](apps/desktop/src/renderer/screens/ChatScreen.tsx#L1247-L1252), `streamConvId` bookkeeping | Start a stream in A, click B; assert B's transcript isn't overwritten, no live bubble in B, and Stop actually aborts A (this last will currently fail → triage code vs expectation). |
| **T-3** | Medium | Docs-IPC `requireNotProcessing` / `requireNoActiveTask` guards untested (chat side has the analogous test; docs side is an asymmetry). | [registerDocsIpc.ts:208-221](apps/desktop/src/main/ipc/registerDocsIpc.ts#L208-L221) | Park an import (gated embedder) so the doc sits in `processing`; assert delete/reindex/preview reject with the friendly copy; same with `docTasks.isDocumentBusy → true`. |
| **T-4** | Medium | Import-loop lock-mid-job break path untested (the drain-look-ahead block exists because of a real deadlock). | [registerDocsIpc.ts:385-452](apps/desktop/src/main/ipc/registerDocsIpc.ts#L385-L452) | Flip `isUnlocked` to false after the first file; assert the job settles `done`, look-ahead drained, lease released, rows reconcile after "unlock". |
| **T-5** | Low | Compaction threshold / `MIN_COMPACTABLE_TURNS` equality boundary asserted only by construction (`<` vs `<=` off-by-one would slip). | [compaction.ts:110-114](apps/desktop/src/main/services/chat/compaction.ts#L110-L114) | Two boundary cases built from `messageTokens`-computed sizes. |
| **T-6** | Low | Mild over-mocking / implementation-detail assertions: scope-picker tests assert the mock's args with scripted list-refresh (contract covered from both sides, acceptable); `ChatUnmount.test.tsx` asserts `clearTimeout` was called with a specific timer id (redundant with the behavior assertion). | `ChatHomeNav.test.tsx`, `ChatUnmount.test.tsx` | Keep the behavior assertions primary; drop the timer-id detail if the flush mechanism ever changes. |
| **T-7** | Low | Flaky-pattern risk: real-timer poll loops (`for (i<200) await setTimeout(5)` = 1 s ceiling) and a cancel test that races wall-clock. | `docs-ipc.test.ts` runImport / reindex polls / cancel | Gate the embedder (release per-file) instead of racing the clock; bump poll ceilings. |
| **T-8** | Low | Chat export handlers' behavior (sanitized `defaultPath`, null-on-cancel) untested (only the structural guard touches the channels). | [registerChatIpc.ts:342-394](apps/desktop/src/main/ipc/registerChatIpc.ts#L342-L394) | One test faking `dialog.showSaveDialog` asserting the sanitized default path and null-on-cancel. |

**Over-mocking guidance.** The suite does not over-mock — keep the existing "real service + real DB +
faked transport" discipline. The new tests above should follow the same pattern (gate promises,
don't sleep; assert observable behavior, not spy internals).

---

## 8. Performance audit

| Item | Path | Impact | Validate by |
|---|---|---|---|
| **DB-4** | Folder-import queue: N auto-commit INSERTs + sync directory walk + N wasted `SELECT *` in the IPC handler | Main-process freeze proportional to file count, on the USB-latency DB, before the job starts | Time `importDocuments` for a 2–3k-file folder before/after batching in one transaction |
| **DB-5** | `listDocuments` full-corpus `COUNT(*)`/embeddings GROUP BY + unbounded payload, per poll tick | Grows with corpus; a poll every 400 ms during imports | Measure at ~100k chunks; check the count-map cache invalidates only on the named-delta hooks |
| **DB-7** | Export decrypt/read is synchronous (`readStoredDocumentText`/`Bytes`) | Main-process block for the full decrypt of a large DOCX in an encrypted workspace | Export a large original; confirm no main-thread stall after converting to `decryptFileAsync` |
| **CB-6** | Per-turn 3× history scans + heavy `listMessages` for one row + 3× `getSettings` | Small constants, bounded history — Low; one-line `LIMIT 1` win | Micro-bench `generateAssistantMessage` prompt-assembly on a compacted 40-turn conversation |
| **CB-7** | One IPC send per token, unbatched | Fine at local rates; several-fold IPC/render churn on fast GPUs | A/B a 30 ms micro-batch; confirm no perceptible latency-to-first-paint change |
| **CR-10** | Un-virtualized transcript + full-parse of every turn on first open (deferred PERF-2 chat half) | Felt on multi-hundred-turn chats only | `content-visibility: auto` on `.msg-block`; incremental live-token counting |
| **DR-4** | Global `previewLoading` re-renders every visible row twice per preview | Modest (bounded by virtualization) | Per-row boolean removes the fan-out |

No unnecessary re-render **storms** were found on the streaming hot path — that path is genuinely
well defended (memoized message blocks keyed by immutable id; block-memoized Streamdown; stable
`useEventCallback` handlers; `@tanstack/react-virtual` windowing on the document list). The
performance items above are scale- and hot-loop concerns, not present-day storms.

---

## 9. Phased remediation plan

Each phase is independent and sized for a fresh session. Every phase ends with tests + doc updates
per the repo's per-phase ritual.

### Phase 1 — Documents backend data-integrity (highest priority)
- **Goal.** Close the FK-violation filing bug and the transient-file collision.
- **Scope / files.** `services/collections.ts`, `services/ingestion/index.ts`, `ipc/registerDocsIpc.ts`.
- **Steps.** (1) `DB-1`: guard the collection case in `fileDocumentByDestination` (existence check +
  try/catch → `fileIntoLibraryIfUnfiled`), always clear `pending_destination_json`; fix the false
  `sanitizeDestination` comment. (2) `DB-2`: make the `.parse-preview` transient name unique per call
  (`randomUUID()` infix, keep `.parse`), or add a per-document read lock.
- **Tests.** Import with a non-existent destination collectionId → indexed + filed to Library + audit
  event + clean re-index. Concurrent same-doc preview vs doc-task extraction → both succeed.
- **Docs.** None beyond code comments.
- **Acceptance.** No FK throw path from filing; a deleted-collection import no longer wedges future
  re-index; concurrent readers never shred each other.
- **Risk.** Low; both fixes are additive guards.

### Phase 2 — Chat input & conversation-switch correctness
- **Goal.** Stop losing typed input and stop cross-conversation state bleed.
- **Scope / files.** `renderer/screens/ChatScreen.tsx`, `renderer/chat/Transcript.tsx`.
- **Steps.** `CR-1` restore draft on pre-persist send failure; `CR-2` reset scroll/bottom-pin on
  conversation change; `CR-6` clear `error` on conversation/mode switch; `CR-7` add the
  `cancelled`/`activeIdRef` guard to the three switch-time loads; triage `CR-9` (`onStop` target).
- **Tests.** The `T-1`/`T-2` renderer tests belong here (stream recovery + mid-stream switch + Stop
  target). Add a "send fails with DOC_TASK_BUSY → composer keeps text" case.
- **Docs.** If `CR-9` is a real bug, note the fix; otherwise none.
- **Acceptance.** Failed send keeps the draft; switching conversations shows the right scroll,
  no stale banner, no stale snapshot; the recovery flow has tests.
- **Risk.** Medium — touches the most intricate renderer effect; lean on the new characterization
  tests first.

### Phase 3 — Documents renderer polish cluster
- **Goal.** Fix the list-race + the small UX/i18n/a11y defects.
- **Scope / files.** `DocumentsScreen.tsx`, `documents/DocRow.tsx`, `documents/SectionRail.tsx`,
  `documents/format.tsx`.
- **Steps.** `DR-1` return `cur` on id-mismatch; `DR-2` monotonic `refresh` seq guard; `DR-3` catch
  the toolbar Refresh rejection; `DR-4` per-row preview-loading; `DR-5` gate Import on `busy !==
  null`; `DR-6` archived-project active state; `DR-7` localize task-failure copy; `DR-8` first-mount
  spinner; `DR-9` GB tier.
- **Tests.** Renderer tests for `DR-1` (Esc mid-load-more → modal stays closed), `DR-2` (out-of-order
  refresh keeps newest), `DR-7` (German task error localized).
- **Acceptance.** No modal resurrection; stale refresh can't stick; correct labels/locale/a11y.
- **Risk.** Low.

### Phase 4 — Chat backend robustness
- **Goal.** Template-safety + the regenerate/empty-reply edges + a hang watchdog.
- **Scope / files.** `services/chat.ts`, `ipc/chat-stream.ts`, `services/chat/compaction.ts`,
  `services/runtime/llama.ts`.
- **Steps.** `CB-1` drop an assistant-first oldest kept turn; `CB-2` restore snapshot on abort with
  no persisted reply; `CB-4` surface completed-but-empty as an error; `CB-3` align the compaction
  threshold with the L1 budget; `CB-5` idle watchdog around `readChatSSE`.
- **Tests.** `fitMessagesToContext` never-assistant-first; regenerate+early-Stop keeps the reply;
  completed-empty surfaces an error; `T-5` compaction boundary.
- **Docs.** Fix `D-1`/`D-2` (context-budget wording) while in `chat.ts`.
- **Acceptance.** No assistant-first prompt; no two-click answer deletion; compaction fires before
  L1 drops on small windows.
- **Risk.** Low–Medium (`CB-1`/`CB-3` change trim/compaction boundaries — the invariant tests are
  the guard).

### Phase 5 — Performance & main-thread hygiene
- **Goal.** Unblock the main process on large workspaces.
- **Scope / files.** `ipc/registerDocsIpc.ts`, `services/ingestion/index.ts`, `ipc/chat-stream.ts`.
- **Steps.** `DB-4` batch the queue-row inserts + drop the re-read; `DB-7` async decrypt on export;
  `DB-5` cache the count maps (invalidate on the named-delta hooks); `DB-6` prune/cap `jobs`; `CB-6`
  `LIMIT 1` read in `buildTurnFence`; optionally `CB-7` micro-batch tokens.
- **Tests.** Timing/characterization for the folder-import batch; a `jobs`-prune test; keep the
  existing import-poll-efficiency test green.
- **Acceptance.** No multi-second freeze importing a few-thousand-file folder; export doesn't stall.
- **Risk.** Low–Medium (`DB-4`/`DB-5` touch hot DB paths — cover with characterization tests first).

### Phase 6 — Tests & docs closeout
- **Goal.** Land the remaining coverage and doc-accuracy fixes not folded into earlier phases.
- **Scope.** `T-3`, `T-4`, `T-8`, `T-7` (de-flake); `D-3`, `D-4`, `D-5`, `D-6`.
- **Acceptance.** Docs-IPC guards + lock-mid-job break + export handlers covered; docs internally
  consistent; IPC inventories accurate or replaced with a single-source pointer.
- **Risk.** Low (tests + docs only).

---

## 10. Recommended execution order

1. **Phase 1** first — it is the only finding with **permanent** per-document consequences (`DB-1`
   wedges future re-index) and a genuine data-corruption race (`DB-2`). No dependencies.
2. **Phase 2** next — `CR-1` is user-visible input loss on a routine failure path; the `T-1`/`T-2`
   characterization tests it carries are also the safety net every later chat change relies on, so
   landing them early de-risks Phase 4.
3. **Phase 3** — self-contained renderer polish; parallelizable with Phase 2 (different files) but
   lower urgency.
4. **Phase 4** depends on Phase 2's tests existing (shares chat test infrastructure) but not on its
   code.
5. **Phase 5** last among the fixes — performance only bites at scale; do it after correctness, and
   after Phase 1 (which touches the same ingestion/docs-IPC files, avoiding merge churn).
6. **Phase 6** closeout — pure tests/docs; can absorb any items deferred from earlier phases.

**Dependencies.** Phases 1 and 3 are independent of everything. Phase 4 should follow Phase 2 (test
harness). Phase 5 shares files with Phase 1 (ingestion/docs-IPC) — sequence them to avoid conflicts.
The doc fixes `D-1`/`D-2` are folded into Phase 4 (same file); `D-3…D-6` into Phase 6.

---

## Already-known / accepted (not re-filed)

These surfaced during the audit but are already tracked/accepted in the architecture ledgers; listed
so the report is honest about overlap, not as new work:

- **Chat-transcript list windowing** — the deferred **chat half of PERF-2** (the documents-list half
  is closed, arch §36). `CR-10` is the same territory; kept as Low with a cheap first step.
- **`listMessages` full-history re-marshal per turn** — arch §40 **P4** (carried forward). `CB-6`
  overlaps from the `buildTurnFence` angle (a `LIMIT 1` read is the incremental win short of the
  full `listMessagesSince` refactor P4 proposes).
- **`onTryAgain` optimistic drop before regenerate (self-heals)** — full-audit-2026-06-30 **F7**,
  accepted and documented in `known-limitations.md:590-596`. Not re-reported.
- **E5 `query:`/`passage:` prefix migration + the coupled `ragMinSimilarity` floor (F13)** — carried
  forward; out of this audit's chat/docs UI scope.

---

*Auditors: 5 parallel passes (chat backend, chat renderer, docs backend, docs renderer,
tests+docs-accuracy); every High/Medium finding re-verified by the lead against the cited source
lines. No code was modified.*
