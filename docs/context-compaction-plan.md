# Context budgeting + conversation compaction — implementation plan

_Status: **PLAN (open)** — drafted 2026-06-19. Not yet implemented. Per the CLAUDE.md doc
lifecycle rule this is a working paper: once shipped, condense into a §-numbered design record
folded into [`rag-design.md`](rag-design.md) (the grounded-chat owner) with a cross-reference from
[`architecture.md`](architecture.md) (the chat-pipeline owner), then delete this file (full original
stays in git history)._

---

## 1. Problem & goals

A conversation grows every turn. Today the assembled prompt is kept under the model's context
window purely by **dropping the oldest turns** (`fitMessagesToContext`, `services/chat.ts`). On the
small local models we target (4K/8K-tier windows, e.g. Qwen3-4B), that silent forgetting bites
quickly: the model loses the user's earlier goal, established facts, and constraints with no signal
to the user that anything was lost.

**Goals**

1. **Preserve meaning, not just fit.** When the history approaches the window, summarize the older
   turns into a compact, structured note and keep recent turns verbatim — instead of dropping the
   old ones outright.
2. **Stay offline & cheap.** Summaries are produced by the **already-running local model**; no
   second model, no network. Summarize **once** and cache it (don't re-summarize every turn) — local
   CPU summarization costs seconds.
3. **Be honest to the user.** Show how full the context window is, and tell the user the moment a
   summary is being produced (it adds latency to that turn).
4. **Never make a turn worse.** Any failure in the new path falls back to today's behaviour; the
   turn always proceeds. No regression to streaming, caching, skills, or RAG grounding.

**Non-goals.** No change to retrieval, no multi-model "utility" runtime, no tool-calling history
(we don't emit `tool_calls`), no cross-conversation memory. Scope is the per-conversation chat
history only.

---

## 2. Current pipeline (what exists today)

Both chat modes funnel through one assembly + one trim helper:

- **Plain chat:** `generateAssistantMessage` (`services/chat.ts`) reads `getSettings(db).contextTokens`,
  pre-sizes the skill fence, calls `buildChatMessages(db, convId, contextTokens, fence)`.
- **Grounded/RAG:** `generateGroundedAnswer` (`services/rag/index.ts`) builds the grounded prompt
  (RAG excerpts `[S1]…` + skill fence + question all in the **final user turn**) and calls
  `buildGroundedChatMessages(...)`.
- Both call **`fitMessagesToContext(messages, contextTokens, reserve=CHAT_RESPONSE_RESERVE_TOKENS)`**
  (`services/chat.ts`): keep every leading `system` message + the final turn (mandatory — it carries
  the question and, on RAG, the citations), drop older turns newest→oldest until the word-estimate
  fits `contextTokens − 1024`.
- **Token estimate:** word-based `approxTokenCount` (`services/ingestion/chunker.ts`) × `1.3`
  (`CHAT_TOKENS_PER_WORD`) + `8`/message. No real tokenizer.
- **History store:** `conversations` + `messages` tables (`node:sqlite`); `listMessages` replays
  every user/assistant turn each request (assistant turns scrubbed of `<think>` via
  `stripThinkBlocks`; roles forced to alternate by `collapseToAlternating`). The `messages` table
  already has a `token_count` column, written `null` today.
- **Streaming + feedback:** `withChatStream` (`ipc/chat-stream.ts`) owns the locked lifecycle and the
  `STREAM.token/done/error/reasoning` channels; there is a one-shot ephemeral **`STREAM.scope`**
  notice fired before a grounded answer — the exact precedent for compaction feedback.
- **Overflow safety net:** an over-window prompt yields HTTP 400, mapped to a friendly
  "too large for this model" message by `isExceedContextError` (`services/runtime/llama.ts`).

**Two gaps this plan closes:**

- **(G1) Wrong budget source.** Assembly trims against `settings.contextTokens` (default 4096), but
  the server is **actually launched** with `manifest.recommendedContextTokens || settings.contextTokens`
  as `--ctx-size` (`ipc/registerModelIpc.ts` → `services/runtime/sidecar.ts`). These can diverge, so
  today we may trim to the wrong window (too-tight wastes capacity; too-loose risks the 400).
- **(G2) No summarization layer.** Old turns are dropped, not condensed.

---

## 3. Design overview

Three cooperating layers, smallest blast radius first:

| Layer | What | New? |
|---|---|---|
| **L0 — window source of truth** | Budget against the real launched `n_ctx`, surfaced on `RuntimeStatus`. | fix (G1) |
| **L1 — hard trim floor** | `fitMessagesToContext` stays the last-resort, LLM-free, synchronous floor. | exists |
| **L2 — summary compaction** | New async pre-pass: at ≥85% window, summarize older turns into a cached checkpoint and replay only turns after it. | new (G2) |
| **UX** | Context-usage gauge + one-shot "summarizing…" feedback + a transcript marker + a settings toggle. | new |

Invariant: **L2 reduces what L1 must drop; L1 still runs after L2 and still guarantees fit.** If L2
is disabled or fails, the system behaves exactly as today.

---

## 4. Detailed design

### 4.1 L0 — context window source of truth

- Add `contextWindow?: number` to `RuntimeStatus` (`shared/types.ts`), populated by the
  `getRuntimeStatus` IPC handler from the value actually passed as `--ctx-size` (the runtime already
  holds it; expose `LlamaRuntime` ctx via a `contextWindow()` accessor on the `ModelRuntime`
  interface; `MockRuntime` returns its configured value).
- `generateAssistantMessage` / `generateGroundedAnswer` budget against **that** value, falling back
  to `settings.contextTokens` only when the runtime can't report one. One helper:
  `effectiveContextWindow(runtime, settings)`.
- Keep `assemblyBudget(window) = window − CHAT_RESPONSE_RESERVE_TOKENS` (unchanged reserve = 1024).

### 4.2 Token accounting

- Keep the cheap word estimate (`messageTokens`) for the hot path and the L1 floor — it is
  deliberately biased to **over-count** (×1.3 + 8/msg), which is the safe direction for a budget.
- **Optional accuracy upgrade (Phase 3):** when the estimate lands within a margin of the compaction
  threshold, call llama-server's `/tokenize` (already exposed by b9585, currently unused) for an exact
  count and cache it on `messages.token_count`. This avoids both false-trigger (summarizing too early,
  burning CPU) and false-negative (a 400 overflow). Not required for v1.

### 4.3 Compaction trigger

- Constant `COMPACT_THRESHOLD = 0.85`. Trigger when
  `estimatedHistoryTokens ≥ COMPACT_THRESHOLD × window` **and** there are at least
  `MIN_COMPACTABLE_TURNS` (≈ 6) turns older than the protected recent tail.
- **Protect a recent tail verbatim:** never summarize the last `KEEP_RECENT_TURNS` (≈ 6) turns or the
  current turn. Recent context matters most and must stay at full resolution (best practice: summarize
  old, keep recent verbatim).
- Below threshold → **no-op, no model call** (keep the common path free).

### 4.4 L2 — the compaction pre-pass + checkpoint persistence

New module `services/chat/compaction.ts` exposing:

```ts
async function ensureCompacted(
  db: Db, runtime: ModelRuntime, conversationId: string,
  window: number, opts: { signal?: AbortSignal; onStart?: () => void }
): Promise<void>
```

Called as an `await` step inside both chokepoints **before** `buildChatMessages` /
`buildGroundedChatMessages`. Algorithm:

1. Load history; estimate tokens; if under threshold or too few turns → return (no-op).
2. Pick the **split point**: everything older than the protected recent tail and newer than the last
   checkpoint is the *region to summarize*. Include the previous checkpoint's summary text as input
   so the new summary subsumes it (chained compaction, §4.7).
3. Fire `opts.onStart()` (drives the UX feedback, §5.2) — exactly once, before the model call.
4. Build the summarizer messages (system = the self-summary prompt §4.8; user = the rendered older
   region, `<think>`-scrubbed) and call `runtime.chatStream(...)` in a **non-thinking, low-temperature**
   configuration, accumulating to a string. Respect `opts.signal`.
5. Persist the result as a **compaction checkpoint** (see schema) and return.

**Checkpoint persistence (the key design choice).** We summarize **once** and store it, rather than
re-deriving every turn (critical on local CPU). Store it as a dedicated row so history replay is a
pure read:

- Add a nullable `kind` column to `messages` (`'message'` default | `'compaction'`) and a
  `covers_through_rowid INTEGER NULL` column (the max `rowid` the summary subsumes). DB migration is
  additive (new nullable columns; existing rows read as `'message'`).
- A checkpoint row stores the summary text in `content`, `role='system'` semantics but is **rendered**
  as a synthetic pair (§4.5). `covers_through_rowid` lets assembly know which real turns it replaces
  and lets the next compaction find "turns since the last checkpoint."
- Checkpoints are **not** shown as normal bubbles and are excluded from `listMessages`' chat-render
  path (a separate `listRenderableHistory` vs `listAssemblyHistory`, or a `kind` filter on the
  existing reader).

**Assembly change.** `buildChatMessages` / `buildGroundedChatMessages`:
`assembly = [systemPrompt] + summaryPair(latestCheckpoint?) + turnsAfter(latestCheckpoint) →
collapseToAlternating → fitMessagesToContext`. When no checkpoint exists, identical to today.

### 4.5 How the summary is represented in the prompt (template safety)

**Do not** inject the summary as a second, mid-history `system` message: several local chat templates
(Qwen, Mistral) accept only one leading system block, and `collapseToAlternating` assumes
leading-system-then-strict-alternation. Instead inject a **synthetic `user → assistant` pair** at the
start of the retained window:

- `user`: `"Here is a summary of our earlier conversation so far:\n\n<summary>"`
- `assistant`: `"Understood — I'll continue with that context in mind."`

This is alternation-safe, survives `collapseToAlternating`, and keeps the real leading **system prompt
byte-stable** so its KV cache (`cache_prompt: true`, RT-2) is still reused. The summary pair changes
only when a *new* checkpoint is cut (infrequent), so prefix-cache churn is rare.

### 4.6 The summarizer call

- **Reuse the active runtime** — precedent exists: document tasks already map-reduce summaries on the
  same llama-server (`services/doctasks/summary.ts`, with budget helpers we can reuse).
- Run **inside** the chat turn, **before** `withChatStream` opens the answer stream — so it's a plain
  sequential `runtime.chatStream` call on the one slot, no concurrency conflict (see §8 risk R4).
- Force a **non-thinking** generation (`mode` with `enableThinking:false`) and a low `maxTokens`
  (`SUMMARY_MAX_TOKENS ≈ 700`) and `temperature ≈ 0.2` for stable, dense output. Strip any stray
  `<think>` from the result defensively.
- **Abort-aware:** thread the turn's `AbortSignal`; if the user cancels, abandon the summary (no
  checkpoint written) and let L1 handle length.

### 4.7 Chained re-compaction

When a conversation compacts a second time, the region to summarize = previous checkpoint summary +
the turns added since. Feeding the prior summary back in keeps a single, rolling checkpoint (no
unbounded stack of summaries). Guardrail: cap summary input at a budget; if the prior summary + new
turns still overflow the summarizer's own window, summarize in two passes (reduce) — reuse
`doctasks/summary.ts` windowing.

### 4.8 The `selfSummaryPrompt`

Designed from current best practice in agent context management: **structured sections act as a
checklist that forces preservation**; **keep concrete references verbatim** (document titles, figures,
dates, names, citation markers `[Sn]`); **never paraphrase a precise value into a vague one**; be
**dense, bounded, no pleasantries**; and **mark uncertainty rather than invent** (a hallucinated fact
in a summary poisons every later turn). Tailored to HilbertRaum: this is a **document-grounded,
offline** workspace, so the sections privilege the user's goal, established facts with their sources,
and open questions — not code/tooling state.

**Iteration log (design-time).**
- *v0* (one line: "Summarize the conversation so far.") — rejected: free-form summaries silently drop
  facts and references; weak small-model output.
- *v1* (sectioned) — added explicit sections. Problem found in review: small 4B models sometimes
  rewrote `[S3]` as "the third source" and rounded figures. Fixed in v2 with an explicit
  "copy identifiers and numbers exactly" rule and a hard length cap.
- *v2 (current)* below. Final wording is to be **validated against golden traces** before merge (eval
  protocol follows) and may be tuned per the dominant shipped model.

```
You are compressing the EARLIER part of a conversation so it can continue within a
limited context window. Write a dense, factual summary that lets the assistant continue
seamlessly. Use exactly these sections; omit a section only if it truly has no content.

## Goal
One or two sentences: what the user is trying to learn or accomplish across the conversation.

## Established facts & answers
- The concrete facts, figures, and conclusions reached so far.
- Copy names, numbers, dates, file/document titles, and source markers like [S2] EXACTLY as
  written. Never round a number or rename a source.

## Documents & sources in play
- Documents, files, or sources referred to, by their exact titles/identifiers.

## Decisions & the user's preferences
- Choices made, and any stated preferences or constraints (language, format, scope, tone).

## Open questions / still to do
- Anything unresolved or explicitly deferred.

Rules:
- Be factual. Do NOT invent details. If something is unclear, write "unclear" rather than guessing.
- Preserve exact identifiers, quotes, and numbers; do not paraphrase them.
- No pleasantries, no meta-commentary, no restating these instructions.
- Keep the whole summary under ~500 words.
```

**Eval protocol (run at dev time, offline, on the shipped local model).**
1. Assemble ~10 golden conversation traces (mix: document Q&A with citations, multi-topic chat,
   a long factual thread with numbers/dates, a German-language thread).
2. For each, generate a summary, then run an **LLM-as-judge** pass (same local model, a separate
   grader prompt) scoring: (a) are all named entities/numbers/`[Sn]` preserved verbatim? (b) any
   invented facts? (c) within length? (d) all sections appropriate? Plus a quick manual read.
3. Iterate wording until ≥ target pass-rate; record the final prompt + the model it was tuned on in
   the design record. Keep the prompt in `services/chat/compaction.ts` as a single exported constant
   (English; the summary is internal context, not user-facing copy — see §5 for the i18n boundary).

---

## 5. UX / design adjustments

Bound by [`design-guidelines.md`](design-guidelines.md) (quiet affordances, no chrome noise) and the
i18n rule (all user-visible strings via `shared/i18n`, en + de; internal prompts stay English).

### 5.1 Context-window usage indicator

**What:** a quiet gauge showing how full the model's context window is for the active conversation —
so the user understands *why* a summary happens and can trust nothing is silently lost.

- **Data:** main computes `usedTokens` (the assembled-prompt estimate) and `window` (L0) per turn and
  reports `{ usedTokens, window }`. Surface it two ways: (a) on the final `STREAM.done` payload / a
  light `getConversationContextUsage(convId)` IPC for the resting state, and (b) live is not required
  — resting + post-turn refresh is enough.
- **Placement:** a thin meter in the composer footer next to the answer-depth control (where the quiet
  affordances already live), e.g. a 0–100% bar with a tooltip "Context: 6.4k / 8k tokens". Reuse
  existing footer styling; no new chrome.
- **Thresholds (visual only):** calm < 75%, amber 75–90%, near-full ≥ 90%. At ≥ threshold the tooltip
  adds "Older messages will be summarized to make room."
- **i18n:** new keys `chat.context.usageTooltip`, `chat.context.willSummarize` (en + de).
- **Note:** the meter reflects the **estimate** (over-counts slightly); label as approximate to avoid
  "why does it say 82% when the model is 8k?" confusion. Honesty over false precision.

### 5.2 Compaction feedback (the "summarizing…" notice)

**What:** the moment a summary starts (it adds latency to *this* turn), tell the user.

- **Channel:** add `STREAM.compaction(requestId)` mirroring `STREAM.scope` — a one-shot ephemeral
  event, never persisted. Payload `{ phase: 'start' | 'done' }` (or just `'start'`; `done` is implicit
  when answer tokens begin).
- **Wiring:** `ensureCompacted`'s `onStart` callback (passed down through `generateAssistantMessage` /
  `generateGroundedAnswer` from `withChatStream`) fires `event.sender.send(STREAM.compaction(id), …)`
  with the same `isDestroyed()` guard as token sends. Preload exposes `onCompaction(requestId, cb)`
  exactly like `onScope`.
- **Renderer:** `ChatScreen` subscribes; while active it shows a quiet inline status line above the
  streaming bubble — "Summarizing earlier messages to free up context…" — using the existing
  `SkillRunBar`/spinner visual vocabulary (there's already a precedent status bar). It clears when the
  first answer token arrives.
- **i18n:** `chat.compaction.inProgress` (en + de).

### 5.3 Transcript marker for a completed summary

A subtle, non-bubble divider in the transcript where a checkpoint sits: "⌄ Earlier messages
summarized" — optionally expandable to read the summary text (the checkpoint `content`). This makes
the compression visible and auditable (the user can confirm context was condensed, not lost), matching
our "honest, local, nothing hidden" posture. Keys: `chat.compaction.markerLabel`,
`chat.compaction.viewSummary`.

### 5.4 Settings toggle

- Add `chatCompactionEnabled: boolean` to `AppSettings` (default **true** — silent drop-oldest is
  strictly worse than a visible summary). When false, behaviour is exactly today (L1 only).
- Respect an explicit user `contextTokens` cap exactly where set (don't auto-expand past a deliberate
  user choice).
- Settings screen: one toggle under the AI/Chat group with a one-line explanation; key
  `settings.chatCompaction.label` / `.help`.

---

## 6. Implementation phases & file-by-file changes

**Phase 0 — window source of truth (S, independently valuable). ✅ SHIPPED 2026-06-19.**
- `shared/types.ts`: `RuntimeStatus.contextWindow?`. `services/runtime/index.ts`: `contextWindow()` on
  the `ModelRuntime` interface; implement in `runtime/llama.ts` + `runtime/mock.ts`.
- `ipc/registerModelIpc.ts` (or the status handler): populate `contextWindow`.
- `services/chat.ts` + `services/rag/index.ts`: budget via `effectiveContextWindow(...)`.
- Tests: estimate/budget uses the launched window; mock reports its value.
- _As built:_ `contextWindow?()` made OPTIONAL on the interface (so the ~15 `ModelRuntime` test-literal
  stubs stay valid; `effectiveContextWindow` falls back to `settings.contextTokens` when unreported/≤0).
  `LadderRuntime` also implements it (returns its fixed `opts.contextTokens`). The window is populated in
  `RuntimeManager.status()` (the natural owner of `this.current`), not the IPC handler. `npm test` 1863 / 29
  skipped, typecheck clean.

**Phase 1 — compaction core (M, the real work). ✅ SHIPPED 2026-06-19.**
- New `services/chat/compaction.ts`: `ensureCompacted`, `COMPACT_THRESHOLD`, `KEEP_RECENT_TURNS`,
  `selfSummaryPrompt`, the summarizer call (reusing `doctasks/summary.ts` helpers).
- `services/db.ts`: additive migration — `messages.kind`, `messages.covers_through_rowid`; a
  checkpoint writer + a "turns since last checkpoint" reader; split `listMessages` into renderable vs
  assembly readers (or add a `kind` filter).
- `services/chat.ts`: `buildChatMessages` injects the summary pair + replays post-checkpoint turns;
  `generateAssistantMessage` awaits `ensureCompacted` before assembly.
- `services/rag/index.ts`: same for `buildGroundedChatMessages` / `generateGroundedAnswer`.
- _As built:_
  - **Migration in `db.ts`** (additive/idempotent, R13): `ensureColumn(messages,'kind')` +
    `ensureColumn(messages,'covers_through_rowid')`; old rows read as plain messages (NULL-sentinel).
    **R8** — the `messages_fts_ai` AFTER INSERT trigger now carries `WHEN new.kind IS NOT 'compaction'`
    (fresh DBs), and `ensureMessagesFtsKindFilter` idempotently rewrites the trigger on a pre-feature DB
    + prunes any indexed checkpoint row; the FTS backfill SELECT also excludes `kind='compaction'`.
  - **Message-table SQL stays in `chat.ts`** (the existing owner of `listMessages`/`appendMessage`), NOT
    `db.ts` — least-disruptive deviation from the plan's letter. New there: `listConversationTurns(db,
    convId, afterRowid)` (rowid-aware, kind-filtered assembly reader), `getLatestCheckpoint` /
    `writeCheckpoint`, `compactionSummaryPair` + the `COMPACTION_SUMMARY_INTRO/_ACK` constants, and a
    `kind IS NOT 'compaction'` filter ON `listMessages` (so renderer/export/fence-sizing auto-skip
    checkpoints — R8). `messageTokens` is now exported (compaction reuses the estimate). `writeCheckpoint`
    deliberately does NOT bump `conversations.updated_at` (internal context, not a user action).
  - **`buildChatMessages` / `buildGroundedChatMessages`**: when a checkpoint exists, inject the §4.5
    synthetic `user→assistant` pair and replay only `rowid > coversThroughRowid` turns; else byte-identical
    to before. The leading system prompt stays byte-stable (RT-2 cache prefix). RAG's live final grounded
    turn (question + `[Sn]`) is still mandatory in `fitMessagesToContext` (R-RAG).
  - **Trigger estimate** (the "summarize once" guarantee): `ensureCompacted` budgets on the ASSEMBLED view
    (existing-checkpoint summary-pair tokens + post-checkpoint turns), so a fresh checkpoint drops the next
    turn below threshold and the summarizer is not re-called until NEW turns re-cross it; chained
    re-compaction folds the prior summary in and map-reduces (doctasks windowing) if it overflows.
  - **Summary call**: `mode:'balanced'` (⇒ `enable_thinking:false`) + explicit `temperature:0.2`,
    `maxTokens:700`. Any failure/abort ⇒ no checkpoint, turn proceeds via L1, no user-visible error (R4/R6).
  - **`KEEP_RECENT_TURNS=6`, `MIN_COMPACTABLE_TURNS=6`, `SUMMARY_MAX_TOKENS=700`, `COMPACT_THRESHOLD=0.85`**
    (D-d: the §4 starting points kept; golden-trace tuning deferred to the eval gate before the wave closes).
  - **`onCompactionStart`** plumbed through `GenerateOptions` / `GroundedAnswerOptions` → `ensureCompacted`'s
    `onStart` (the `STREAM.compaction` UX wiring is Phase 2). The Phase-2 settings toggle is not yet read, so
    compaction is effectively always-on (= the settled D-a default ON).
  - **Tests:** new `tests/integration/chat-compaction.test.ts` (15 cases) — trigger boundaries, one
    checkpoint reused (summarize-once), chained fold, `covers_through_rowid`, post-checkpoint assembly +
    byte-stable system prompt + alternation-safe pair + L1 still fits, summarizer throw/abort fallback, RAG
    raw-turn checkpoint with live citations, and an old-DB migration + R8 FTS-exclusion round-trip.
    `npm test` **1878 passed / 29 skipped** (+15), typecheck + `npm run build` clean.

**Phase 2 — UX (M). ✅ SHIPPED 2026-06-19.**
- `shared/ipc.ts`: `STREAM.compaction`. `preload/index.ts`: `onCompaction`.
- `ipc/chat-stream.ts`: thread an `onStart` notifier into the run fns (or pass `event` down) with the
  `isDestroyed()` guard.
- `shared/types.ts`: `AppSettings.chatCompactionEnabled` (default true) + the context-usage payload
  type; `services/chat.ts` reports `{ usedTokens, window }`.
- Renderer: composer-footer meter, the inline "summarizing…" status line in `ChatScreen` +
  `Transcript`, the transcript summary marker, the settings toggle.
- `shared/i18n/{en,de}.ts`: all keys from §5.
- _As built:_
  - **`STREAM.compaction(requestId)` + `CompactionNotice {phase:'start'}`** (`shared/ipc.ts`) mirror
    `STREAM.scope`. `withChatStream` (`ipc/chat-stream.ts`) gained a 4th `runFn` arg `sendCompaction`
    (a `SendCompaction` notifier) alongside `sendToken`/`sendReasoning` — isDestroyed-guarded, but
    **never written to `streamBuffers`** (R14, ephemeral). Both IPC handlers pass it as
    `onCompactionStart` into the Phase-1 plumbing (`registerChatIpc` plain chat; `registerRagIpc` the
    grounded path only — the refusal/listing runFns make no model call so never fire it). Preload:
    `onCompaction(requestId, cb)` mirrors `onScopeNotice`.
  - **Context meter (§5.1).** New `ContextUsage {usedTokens, window}` (`shared/types.ts`) +
    `getConversationContextUsage(db, runtime|null, convId)` (`chat.ts`): a pure read that assembles
    via `buildChatMessages` over `effectiveContextWindow` (window falls back to `settings.contextTokens`
    when no runtime) and sums `messageTokens` — the same over-counting estimate, labelled approximate.
    Surfaced through the resting IPC `getConversationContextUsage`; the renderer refreshes it on
    conversation switch + after each completed turn (the §5.1 "resting + post-turn refresh"). New
    `renderer/chat/ContextMeter.tsx`: a thin footer bar, calm <75% / amber 75–90% / near-full ≥90%,
    tooltip "Context: 6.4k / 8k tokens (approximate)" + the will-summarize line from the amber band.
    **Deviation (documented):** §5.1 offers the usage on the `STREAM.done` payload OR the resting IPC;
    chose the resting IPC for BOTH surfaces (the renderer awaits the invoke + re-reads history and does
    not consume `onDone`, and `done` is the locked Message contract) — the locked streaming contract is
    untouched.
  - **Transcript marker (§5.3, D-b).** New `ConversationSummaryMarker {summary, beforeMessageId}` +
    `getConversationSummaryMarker(db, convId)` (`chat.ts`): main computes `beforeMessageId` (the first
    rendered turn with `rowid > coversThroughRowid`) since `Message` carries no rowid; null when no
    checkpoint OR compaction disabled. Resting IPC `getConversationSummary`. `Transcript` renders an
    expandable `SummaryMarker` (aria-expanded button, the SourcesDisclosure pattern) before that
    message — reads the checkpoint text.
  - **Settings toggle (§5.4).** `AppSettings.chatCompactionEnabled` default **true** (the defaults-merge
    is the migration — no schema change). `compactionEnabled(db)` gates BOTH the `ensureCompacted`
    pre-pass (no new checkpoints when off) AND the checkpoint READ in `buildChatMessages` /
    `buildGroundedChatMessages` / `getConversationSummaryMarker` — **chosen behaviour: when off, any
    existing checkpoint is ignored and the FULL history replays (pure L1) = byte-identical to the
    pre-feature app**. Settings → General gains a "Chat" card with the toggle. The explicit
    `contextTokens` cap is already respected (`effectiveContextWindow` only ever falls BACK to it).
  - **i18n:** `chat.compaction.inProgress/markerLabel/viewSummary`, `chat.context.usageTooltip/
    willSummarize`, `settings.chat.title`, `settings.chatCompaction.label/help` — en + de (parity test
    green). Internal prompts stay English (Phase 1).
  - **Tests:** `tests/integration/chat-compaction-ux.test.ts` (usage shape + growth + null-runtime
    fallback; marker boundary/none/disabled; toggle-off assembly ignores the checkpoint + no checkpoint
    created), `tests/integration/chat-compaction-ipc.test.ts` (`STREAM.compaction` fires exactly once
    when summarizing, never below threshold), `tests/renderer/ChatCompaction.test.tsx` (meter tooltip/
    tone, marker expand, notice shows + clears on first token). `npm test` **1890 passed / 29 skipped**
    (+12), typecheck + `npm run build` clean.

**Phase 3 — accuracy & polish (S, optional).**
- `/tokenize`-backed exact counts near threshold, cached on `messages.token_count`.

---

## 7. Testing plan

Deterministic, offline, with `MockRuntime` (no network) — consistent with the suite (~1858 tests).

- **Budget math:** threshold/trigger boundaries; no summary call below threshold; budget uses the
  launched window not settings.
- **Checkpoint lifecycle:** one checkpoint written when over threshold; **reused across subsequent
  turns** (assert the summarizer is called once, not per turn); chained re-compaction folds the prior
  summary; `covers_through_rowid` correct.
- **Assembly:** post-checkpoint assembly replays only later turns; the summary pair is alternation-safe
  after `collapseToAlternating`; the leading system prompt stays byte-identical (cache-key stable);
  `fitMessagesToContext` still fits afterward.
- **Fallback:** mock summarizer throws / aborts → no checkpoint, turn proceeds via L1 (no user-visible
  error). Disabled toggle → today's behaviour exactly.
- **RAG path:** checkpoint built from stored raw turns, never the transient grounded prompt; citations
  in the live final turn untouched.
- **UX:** `STREAM.compaction` fires exactly once and only when summarizing; renderer clears it on first
  token; usage payload shape; both `en` + `de` keys present (the i18n parity test already enforces this).
- **Migration:** old DBs (no `kind` column) read as plain messages; round-trip safe.

---

## 8. Risk & interaction analysis

Each risk with its mitigation. This is the "does the plan cause other trouble?" pass.

- **R1 — `cache_prompt` (RT-2) invalidation / prefix-cache thrash.** The summary lives in a `user→
  assistant` pair *after* the system prompt, so the cached system prefix is unchanged; the pair changes
  only on a new checkpoint (rare). **But** the first turn after a checkpoint shifts the whole post-system
  prefix, so that one turn pays a full prompt re-eval. *Mitigation:* acceptable (one turn, already the
  turn that paid for summarization); document it; do not cut checkpoints more often than necessary
  (one threshold crossing → one checkpoint, then steady state).

- **R2 — Skill fence pre-sizing.** The skill fence is pre-sized against `contextTokens`
  (`buildTurnFence`) so it never starves the base preamble or final turn. Changing the budget source
  (L0) and adding a summary pair changes the token math. *Mitigation:* pre-size the fence against the
  **same** `effectiveContextWindow` and compute available room **after** the summary pair is in place;
  keep the existing rule "fence omitted if it doesn't fit → no skill stamp" intact so the skill glyph
  stays 1:1 with prompts that actually carried the skill (§22-A5/A6). Add a test that a near-full
  context still stamps correctly.

- **R3 — Skill stamping on synthetic turns.** The injected summary pair must **never** be persisted as
  real messages nor receive a skill stamp. *Mitigation:* the pair is constructed at assembly time only,
  never written to `messages`; only the checkpoint row is persisted (with `kind='compaction'`, no
  skill_id).

- **R4 — Model-slot concurrency / deadlock.** The one runtime serves chat *or* a doc task, never both
  (`assertChatStreamReady` refuses chat while a non-yielding task runs). The summary is an **extra
  model call inside the same chat turn**. *Mitigation:* run `ensureCompacted` **after**
  `assertChatStreamReady` has granted the slot and **before/within** `withChatStream`, as a plain
  sequential call on the already-claimed slot — it is *part of* the chat turn, not a competing task, so
  it cannot deadlock with the doc-task arbiter. It must honour the same `AbortSignal`. Add a test that a
  cancel during summarization aborts cleanly and releases the slot via the existing `finally`.

- **R5 — Latency on the summarizing turn.** Summarization adds seconds before the first answer token on
  that turn. *Mitigation:* this is exactly what the §5.2 feedback is for; threshold at 0.85 (not higher)
  so it triggers before the model is starved; summarize once then steady-state.

- **R6 — Summary hallucination poisons the thread.** A wrong fact in the checkpoint contaminates all
  later turns. *Mitigation:* the prompt's anti-invention + verbatim-identifier rules (§4.8); keep recent
  turns verbatim (the model still sees real recent context); the §5.3 marker lets the user read/verify
  the summary; low temperature; dev-time golden-trace eval gate before merge.

- **R7 — Message edits / regeneration / deletion stale the checkpoint.** If the user edits or deletes a
  turn that a checkpoint `covers_through_rowid` subsumes, the summary may describe content that no
  longer exists. *Mitigation:* on any mutation of messages at/below a checkpoint's
  `covers_through_rowid`, **invalidate** (delete) checkpoints whose covered range intersects the change;
  the next over-threshold turn re-summarizes. Cheap (rare event). Add to the edit/delete paths +
  regression test. (If the app has no edit/delete-history feature yet, note it as a guardrail for
  whenever one lands.)

- **R8 — Conversation search / export.** `messages` rows feed conversation search (Phase 31) and any
  export. A `kind='compaction'` row is machine context, not a user message. *Mitigation:* exclude
  `kind!='message'` from search indexing and from user-facing export (or export it clearly labelled).
  Verify the FTS indexer's source query filters on `kind`.

- **R9 — Token estimate error around the threshold.** The word estimate can over/under-count, causing an
  early or late trigger. *Mitigation:* over-counting (the current bias) only triggers *earlier* —
  harmless; the L1 floor still guarantees fit if we trigger late; Phase 3 `/tokenize` removes the
  ambiguity at the boundary if it ever matters in practice.

- **R10 — Very long single message.** A single pasted turn can exceed the window alone; summarization of
  *older* turns doesn't help it. *Mitigation:* unchanged from today — `fitMessagesToContext` keeps the
  final turn and the runtime's 400 path surfaces the friendly "too large" message. (A future head+tail
  truncation of a giant single turn is out of scope here; note it.)

- **R11 — Non-thinking models / template variance.** Forcing `enableThinking:false` for the summary on a
  model without thinking support must be a no-op, and the `user→assistant` pair must satisfy every
  shipped chat template. *Mitigation:* the pair is ordinary roles (already exercised by normal history);
  reuse `collapseToAlternating`; add a template-shape test; the summary mode just omits the thinking
  kwarg when unsupported.

- **R12 — i18n / privacy.** The summary prompt and checkpoint text are internal model context — English
  prompt is fine, but the **summary content will be in the conversation's language** (the model summarizes
  German chats in German), which is correct. All *user-visible* strings (gauge, status line, marker,
  setting) go through `shared/i18n` (en + de). Nothing leaves the device — summarization is a local model
  call, consistent with the no-cloud/no-telemetry rule. No new network surface.

- **R13 — DB migration safety.** Additive nullable columns only; old rows default to `'message'`. The
  migration must be idempotent and guarded like existing ones. No backfill needed.

- **R14 — Interaction with `getActiveStream` recovery.** A screen that remounts mid-stream recovers via
  `streamBuffers`. The `compaction` notice is ephemeral and may be missed on remount — acceptable (it's a
  transient hint; the answer still streams). Don't store it in `streamBuffers`.

**Net:** the plan is additive and fail-safe — every new path degrades to today's behaviour, the one
structural change (checkpoint rows) is an additive migration, and the highest-judgement risks (R6
hallucination, R7 stale checkpoint) have concrete, testable mitigations.

---

## 9. Open decisions

- **D-a — Default on or off?** Recommend **on** (silent forgetting is worse). Confirm with product.
- **D-b — Show the summary text to the user (§5.3 expandable) or just a marker?** Recommend expandable
  (auditability fits our ethos); small extra renderer work.
- **D-c — Phase 3 `/tokenize` now or later?** Recommend later (estimate is safe-biased); revisit if the
  threshold proves jumpy in real use.
- **D-d — `KEEP_RECENT_TURNS` / `MIN_COMPACTABLE_TURNS` / `SUMMARY_MAX_TOKENS` exact values** — tune
  against golden traces during Phase 1; the §4 numbers are starting points.

---

## 10. Effort

Phase 0 ≈ S (½ day). Phase 1 ≈ M (summarizer + checkpoint schema + assembly, the real work).
Phase 2 ≈ M (UX across IPC/preload/renderer/i18n). Phase 3 ≈ S incremental. **Net M–L**, reusing three
things we already have: the `fitMessagesToContext` floor, the `doctasks/summary.ts` summarizer pattern,
and `MockRuntime` for deterministic offline tests.
