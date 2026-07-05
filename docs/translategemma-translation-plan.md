# TranslateGemma adoption + Translate view — implementation plan (TG wave)

_Status: **OPEN** (plan file per the CLAUDE.md doc-lifecycle rule — retire into a design record
folded into `docs/architecture.md` + `docs/model-policy.md` at TG-6). Written 2026-07-05 after a
multi-agent investigation (code + primary-source web research, adversarially verified). All
external facts below were checked against primary sources on 2026-07-05; re-verify the items in
§7 at implementation time. Implementation commits go **directly to `master`**, one phase per
session, per-phase ritual (tests green → docs → BUILD_STATE → commit) applies to every phase._

## §0 Summary and owner decisions (2026-07-05)

Adopt **google/translategemma-12b-it** (via the `mradermacher` Q4_K_M GGUF) as HilbertRaum's
**dedicated translation model**, served by a **new `translation` manifest role + its own
llama-server sidecar**, and add a new top-level **Translate view** (text in → translation out,
plus drag-and-drop document translation). The existing chat-model-based translation doc-task
backend is **replaced**, not augmented.

Owner decisions (asked and answered 2026-07-05):

| # | Decision | Choice |
|---|---|---|
| O1 | License posture (Gemma Terms of Use) | **`license_review: pending`** now; in-app download works behind the existing explicit license-acknowledgement gate; commercial-drive approval is a separate later review. Not bundled. |
| O2 | Fallback when TranslateGemma absent | **Require TranslateGemma.** Translation (doc-task *and* Translate view) refuses with a friendly "install the translation model" notice + deep link. The chat-model translation path is removed. |
| O3 | Model sizes | **12B only** (`translategemma-12b-it`). 4B/27B become manifest-only follow-ups once the role exists. |
| O4 | Languages | **Curated set, ~10**: `de, en, fr, es, it, pt, nl, pl, cs, uk` (adjustable at TG-3). All are inside TranslateGemma's 55 WMT24++-evaluated languages — that evaluation + our TG-6 per-language smoke is the "widen deliberately, with evidence" evidence. Because of O2 the set applies unconditionally (there is no chat fallback left to gate). |

## §1 Verified facts this plan rests on

### 1.1 TranslateGemma (primary sources, adversarially re-verified 2026-07-05)

- **Released January 2026**, not July (HF repos created 2026-01-12; Google blog 2026-01-15;
  weights last modified 2026-01-28). The 2026-07-05 "release" the team saw was a re-surfacing.
- **Architecture: plain Gemma 3** — `Gemma3ForConditionalGeneration`, `model_type: gemma3`,
  tags `image-text-to-text` (source: `https://huggingface.co/api/models/google/translategemma-12b-it`).
  No new architecture string; llama.cpp has loaded `gemma3` since 2025 → **the b9849 runtime pin
  (cut 2026-06-30) loads it**; no pin bump required.
- **Family**: `google/translategemma-{4b,12b,27b}-it`, all gated (`manual`) under
  **`license: gemma`** (Gemma Terms of Use, `https://ai.google.dev/gemma/terms`). **No Google QAT
  and no Google GGUF exist** (unlike Gemma 4) and no Apache-2.0 variant exists anywhere; community
  GGUFs inherit the Gemma license.
- **GGUF source**: `mradermacher/translategemma-12b-it-GGUF` (created 2026-01-16; the de-facto
  standard — unsloth/bartowski/ggml-org/lmstudio-community/QuantFactory published **nothing**,
  verified via author-scoped HF API queries). File **`translategemma-12b-it.Q4_K_M.gguf`**,
  **7,300,794,112 bytes** (byte-verified via the HF tree API). The repo also ships `mmproj-f16` /
  `mmproj-Q8_0` projectors (image translation — **out of scope**, see §6). Repo is public (tree
  API readable unauthenticated) even though Google's base repo is gated.
- **Input budget: the model card states "Total input context of 2K tokens"** (verified verbatim
  on the 12b and 27b cards). The gemma3 arch supports 128K, but the fine-tune is trained/evaluated
  for ≤2K-token inputs → document translation must chunk to ≤~2K tokens per request (§2 D4).
- **Prompt format** (single-user-turn, no system role; reconstructed from the GGUF template —
  **verify verbatim at TG-2**, §7 V1):
  `<start_of_turn>user\nYou are a professional {SourceLangName} ({src_code}) to {TargetLangName} ({tgt_code}) translator. … Produce only the {TargetLangName} translation, without any additional explanations or commentary. Please translate the following {SourceLangName} text into {TargetLangName}:\n\n\n{TEXT}<end_of_turn>\n<start_of_turn>model\n`
  It **requires a source language** (no documented auto-detect; omitted languages render as
  "English (en-GB)"). Stop token `<end_of_turn>`. No official sampling recommendation; Ollama
  ships Gemma-3 defaults (`top_k 64, top_p 0.95`); MT norm is greedy/low temperature.
- **llama.cpp status — the critical operational fact**: dedicated TranslateGemma support (PRs
  #18956/#19019/#19043/#19052, request-level `chat_template_kwargs {source_lang_code,
  target_lang_code}`) merged 2026-01-24, **inside the pin**. BUT a chat-parsing rework (PR #19419,
  first bad tag b7981) **regressed the `--jinja` embedded-template path** — "Unable to generate
  parser for this template … std::bad_alloc" (issue #20305, stale-closed unfixed; fix PR #20956
  **still open as of 2026-07-05**, even on master). **Therefore: the sidecar must NOT use
  `--jinja`** — format the trained prompt in app code and call the raw **`/completion`** endpoint
  (the workaround endorsed in #20305). This also rules out running TranslateGemma as a `role: chat`
  model (our chat sidecar hard-codes `CHAT_SERVER_ARGS = ['--jinja', …]`,
  `services/runtime/llama.ts:30`).
- **Cautionary open issues** to smoke against: #22908 (translategemma-4b produced no output on
  b8089 / failed load on b9000; stale-closed unresolved) and #25142 (2026-06-29: Windows
  Vulkan/Intel Arc hang under **parallel** translation load) → run `--parallel 1`, sequential
  windows, and smoke on the exact pin binaries (Windows Vulkan **and** CPU) before TG-3.
- **Quality claims** (arXiv:2601.09012; WMT24++ MetricX-24↓/COMET22↑): 4B 5.32/80.1, 12B
  **3.60/83.5**, 27B 3.09/84.4; 12B beats the Gemma 3 27B baseline. 55 evaluated languages
  (+~500 experimental pairs).

### 1.2 As-built code facts (verified against source, file:line)

- Translation today runs on the **active chat model**: `getRuntime: () => runtime.active()`
  (`apps/desktop/src/main/index.ts:241`; `doctasks/context.ts:22-23`), guarded at enqueue/dequeue
  (`doctasks/manager.ts:244-245`, `:416-418`). No `translation` role exists
  (`shared/manifest.ts:13`, `ROLES :116`); `selectModel` persists only chat/embeddings
  (`services/models.ts:779-794`); `startModelRuntime` rejects non-chat roles
  (`registerModelIpc.ts:49-51`).
- Prompts/window math: `doctasks/translation.ts` — system prompt `:110-119`, window prompt
  `:121-135`, `TRANSLATION_TEMPERATURE = 0.2` `:41`, reserve 300 `:33`, budget
  `(ctx−300)/(1.3+2.0)` words `:54-62` (constants **measured on Qwen3-4B**, `:34-39`), **no window
  ceiling, no reduce** `:26-30`; segments (never overlapping RAG chunks) feed the windows
  (`handlers/translation.ts:36-42`); one retry then visible `failedWindowNotice`
  (`manager.ts:452-475`; `handlers/translation.ts:48-70`). Window budgets follow the **launched**
  chat `--ctx-size` (`main/index.ts:249-253` → `effectiveContextWindow`, `chat.ts:1030-1039`).
- Target languages are a closed `'de' | 'en'` set (`shared/types.ts:802`, "widen deliberately,
  with evidence" `:799-801`), validated server-side (`manager.ts:217-224`); UI is a two-button
  modal (`DocumentsScreen.tsx:1119-1140`) from the DocRow overflow menu (`DocRow.tsx:296`).
- Output: attribution line + stitched windows, **materialized through the normal ingestion
  pipeline** with `GeneratedProvenance {kind:'translation', sourceDocumentIds, modelId, createdAt}`
  in `documents.origin_json`, zero collection membership (`handlers/translation.ts:75-83`;
  `handlers/shared.ts:55-146`; `types.ts:840-849`).
- **Concurrent sidecars are established practice**: chat + E5 embedder + reranker + vision each
  compose their own `LlamaServer` on an OS-assigned loopback port (`runtime/sidecar.ts:103-113`,
  bind-race retry `:398-406`; the comment at `sidecar.ts:121` names all four). The one-model limit
  is only the chat `RuntimeManager` (`services/runtime/index.ts:107`, stop-on-switch `:194-196`).
  **Vision is the pattern to copy**: lazy start, `--parallel 1`, 120 s soft idle teardown
  (`vision/runtime.ts:23-36, 77-96`, `HILBERTRAUM_VISION_IDLE_MS`), availability-driven activation
  via `resolveModelByRole` + `resolveSidecarSelection` (`select-sidecar-backed.ts:46-62`).
- In-app downloader gates: policy ceiling + `allowNetwork` setting + per-download confirmation
  **with an explicit license-acknowledgement checkbox when `license_review.status !== 'approved'`**
  (`downloads.ts:25-62`) — exactly what O1 needs; no downloader change required.
- Renderer: no screens registry — a new screen touches `renderer/navigation.ts:14` (ScreenId +
  `resolveNavTarget` cases `:42-47`), `App.tsx:38-48` (`NAV_TOP`) and `:288-303` (render block),
  `components/Icon.tsx:13-24` (glyph), i18n `nav.*` keys. Drag-drop path resolution must use
  `window.api.getDroppedFilePath` (preload `webUtils.getPathForFile` bridge,
  `preload/index.ts:319-325`); dropped paths are hardened in main (`registerDocsIpc.ts:166-177`).
  `ImportDestination` supports `{kind:'temporary'}` (`shared/types.ts:1415-1419`) — dropped files
  can be translated without entering the Library. Job-keyed streaming precedent:
  `STREAM.imgToken/imgDone/imgError(jobId)` + `renderer/lib/visionSession.ts` module store.
  `de.ts` is typed `Record<keyof typeof en, string>` — en/de parity is compile-enforced.
  design-guidelines §2 pins "6 primary + 1 utility" nav — adding Translate makes it 7 (deliberate
  IA change, TG-4).

## §2 Design decisions

- **D1 — New manifest role `translation`, dedicated sidecar.** Forced by the `--jinja` regression
  (a chat-slot TranslateGemma would crash template parsing) and desirable anyway: chat stays
  usable, ctx/prompt/sampling are model-specific. Follow the vision sidecar precedent: own
  `LlamaServer`, lazy start on first request, `--parallel 1`, soft idle teardown (120 s default,
  `HILBERTRAUM_TRANSLATION_IDLE_MS` override), availability-driven activation (no settings slot;
  first installed `translation` manifest wins via `resolveModelByRole('translation')`).
- **D2 — No `--jinja`; raw `/completion` with an app-side prompt builder.** The sidecar launches
  WITHOUT `CHAT_SERVER_ARGS`. A new prompt builder emits the trained single-turn format (§1.1)
  with our own `code → English language name` map (the template's own dictionary is unusable
  without jinja). Params: `temperature 0` (greedy — deterministic MT), `stop: ["<end_of_turn>"]`,
  no `top_k/top_p` overrides beyond server defaults. Text placed inside `{TEXT}` is translated,
  not obeyed — so **no "part n of m" scaffolding** (the current window-prompt niceties are
  chat-model artifacts and get removed with the old path).
- **D3 — Hard requirement (O2).** `startDocTask(kind:'translation')` and the Translate view
  require an installed + verified `translation`-role model; otherwise a friendly, actionable
  refusal (new copy key, deep link to the AI Model screen). The chat runtime is **irrelevant** to
  translation after TG-3. The old chat-model prompts (`translationSystemPrompt`/
  `translationWindowPrompt`) are deleted with their tests (git history keeps them).
- **D4 — 2K input budget, structurally enforced.** Launch `--ctx-size 4096` (input + output must
  fit; ctx is read back via the sidecar's own `contextWindow()`, replacing the chat-window
  coupling at `handlers/translation.ts:44`). Extend `planTranslationWindows` with an explicit
  **`maxInputTokens` clamp** (≈1800: 2000 minus prompt scaffold) so the card's 2K input spec is
  enforced even when the word-budget formula would allow more. Keep the Qwen-measured 1.3/2.0
  tokens-per-word constants as **conservative defaults** until TG-6 re-measures them on the Gemma
  tokenizer (they can only over-chunk, never overflow). Consequence: ~1,100-word windows — more,
  smaller windows than today; cross-window terminology drift is a documented limitation.
- **D5 — Languages (O4).** Widen `TranslationTargetLang` to the curated 10 (`de, en, fr, es, it,
  pt, nl, pl, cs, uk`) and introduce `TranslationSourceLang` (same set) — TranslateGemma's format
  requires an explicit source language; v1 has **no auto-detect** (out of scope, §6). UI: the
  two-button modal becomes source+target selects (native-name labels — `Deutsch, English,
  Français, …` — untranslated by design, matching the Settings language picker precedent);
  `translatedDocumentTitle` gains native-name labels per target. Server-side validation widens to
  the set. The "widen deliberately" guard comment is rewritten to cite WMT24++ + the TG-6 smoke.
- **D6 — Translate view = 7th primary destination.** Input textarea + source/target selects +
  swap button + primary "Translate" + streamed output panel (plain-text live buffer, markdown
  parse on completion via `AssistantMarkdown`) + copy-to-clipboard + drop zone (TG-5). New
  **job-keyed streaming IPC** (`translate:start` → jobId; `STREAM.trToken/trDone/trError(jobId)`;
  cancel), mirroring the vision contract, with a `renderer/lib/translateSession.ts` module store
  so navigation doesn't kill a running job. Pasted text longer than one window is planned with the
  same window planner and streamed window-by-window into the output.
- **D7 — Dropped/picked documents in the view ride the existing doc-task.** Drop (or WCAG 2.5.7
  "choose file" button) → import with `destination: {kind:'temporary'}` → existing
  `startTask('translation', …)` → poll → render the materialized Markdown into the output panel +
  offer Export / "show in Documents". No new parsing path; provenance/audit/encryption invariants
  ride along for free. Multi-file drops are rejected (Images precedent).
- **D8 — GPU posture: reuse the chat GPU ladder if its seams allow, else ship CPU-pinned and
  measure.** Unlike e5/reranker/vision (CPU-pinned by design), a 12B *generative* model's decode
  speed dominates UX. TG-2 attempts to reuse `runtime/factory.ts`'s rung-1 (auto-offload) /
  rung-2 (`--device none`) ladder for the translation sidecar; if the factory seams are too
  chat-specific, TG-2 ships `--device none` (CPU) and the TG-2 smoke's tokens/sec decides whether
  GPU work is pulled forward. Windows-Vulkan hang risk (#25142) is contained by `--parallel 1` +
  strictly sequential window requests either way.
- **D9 — Concurrency guards stay, v1.** The doc-task FIFO + both chat↔task exclusion guards
  (`manager.ts:233-235`, `chat-stream.ts:54-56`) remain unchanged even though translation no
  longer occupies the chat slot — RAM co-residency (12B translate + resident chat + embedder at
  materialize) is reason enough. Relaxation (chat during translation) is TG-6-measured, deferred.
- **D10 — Manifest discipline.** `recommendation_rank: 0`, `recommended_profiles: []`,
  `bundled_on_preconfigured_drive: false`, `license_review.status: pending` (O1). `sha256`:
  capture the HF **git-LFS OID** (= file SHA-256) cross-checked with `X-Linked-ETag` at TG-1
  (the qwen3.5-9b precedent, dl-size-cap-2026-07-03) and verify with `verify-models --generate`
  after the first real fetch. `size_bytes: 7300794112` (already byte-verified).
  `recommended_min_ram_gb: 14` as a placeholder mirroring the Gemma-4-12B measurement (~10.6 GiB
  peak RSS) — **replace with the TG-2 measured floor** per model-benchmarks §4 discipline.

## §3 Data-contract changes (all additive unless flagged **BREAKING**)

| Contract | Change |
|---|---|
| `ModelRole` (`shared/manifest.ts:13`, mirrored `shared/types.ts:334`) | + `'translation'`. Older builds skip-with-error such manifests (validator `manifest.ts:247-249`) — acceptable, matches the vision-role rollout. |
| `TranslationTargetLang` (`shared/types.ts:802`) | **BREAKING-ish widen** `'de'\|'en'` → curated 10. Persisted docs are unaffected (targetLang is not persisted in provenance; legacy `TranslationOrigin.targetLang` still parses on read). |
| `StartDocTaskRequest.params` | + required `sourceLang: TranslationSourceLang` for `kind:'translation'` (validated server-side alongside `targetLang`). |
| Doc-task guard | **BREAKING behavior (O2)**: `kind:'translation'` no longer requires the chat runtime; it requires an installed `translation` model. New friendly-copy key (e.g. `main.translation.noModel`). |
| New IPC (view) | `translate:start` / `translate:cancel` (+ `getActiveTranslateJob` for remount recovery) and `STREAM.trToken/trDone/trError(jobId)` — additive, mirrors the image channels (`shared/ipc.ts:281-287`). |
| `ScreenId` | + `'translate'`. |
| i18n | `nav.translate`, `translate.*` (title/lead/placeholders/errors/install-notice), widened `docs.translateModal.*`; en+de in the same change (compile-enforced). |
| Manifest file | `model-manifests/translation/translategemma-12b-it-q4.yaml` (new dir); `models/translation/` added to `DRIVE_LAYout_DIRS` (`drive.ts:47-53`) + `prepare-drive.{ps1,sh}` dir lists. |

## §4 Phases

Each phase is one session, one commit to `master` (stage explicit files only — concurrent
sessions share this working tree), ending with the full per-phase ritual. Suggested commit
subjects included.

### TG-1 — `translation` role + manifest + surfaces (inert; no behavior change)

**Scope**: everything needed for the model to be *discoverable, downloadable, verifiable* —
nothing consumes it yet.
- `shared/manifest.ts`: `ModelRole` + `ROLES` + validator tests (mirror the vision-role tests,
  `tests/unit/manifest.test.ts:195-310` precedent).
- `services/models.ts`: role passes discovery/install-state untouched (verify `resolve-model.ts`
  handles the new role string — it is role-agnostic by design); `selectModel` stays refusing
  (availability-driven role).
- Drive layout: `drive.ts DRIVE_LAYOUT_DIRS` + `prepare-drive.{ps1,sh}` `$Dirs` (+ the `.sh`
  twin), `docs/drive-layout.md` lines 28/68.
- The manifest per D10 (capture LFS-OID sha256 + keep `size_bytes: 7300794112`; download URL
  `https://huggingface.co/mradermacher/translategemma-12b-it-GGUF/resolve/main/translategemma-12b-it.Q4_K_M.gguf?download=true`;
  `license_url: https://ai.google.dev/gemma/terms`; `license_review.status: pending` with notes
  recording the Gemma-Terms flow-down obligations, the Gemma-3-parking precedent, and the
  third-party quantizer provenance).
- `ModelsScreen.tsx`: role grouping (`:320-322`), add `translation` to the `automatic` role list
  (`:441-445`), `plainHintKey` (`:60-66`), i18n (en+de).
- **Verify V2–V4 (§7) during this phase** (URL fetchable unauthenticated, exact filename, LFS OID).
- Docs: `model-policy.md` new "The translation role + TranslateGemma" section (whisper/vision
  sections are the template) incl. the license-review record (pending) and the jinja-regression
  research note; `README.md` "Supporting models (non-chat)" row; `user-guide.md` download note.
- Tests: manifest validation (new role, happy + unknown-role-skip), models-state integration for
  the new role dir, ModelsScreen renderer test additions.
- Exit: `npm test` green; model downloadable in-app behind the license-ack checkbox; shows
  `installed` after hash verify; nothing else changed.
- Commit: `feat(models): translation manifest role + TranslateGemma 12B manifest (TG-1)`

### TG-2 — Translation sidecar service + real-pin load smoke (the go/no-go gate)

**Scope**: a working, tested `services/translation/` sidecar; **no caller changes yet**.
- Runtime module (vision `runtime.ts` as template): own `LlamaServer`; args `--ctx-size 4096
  --parallel 1`, **no `--jinja`**, GPU per D8; lazy start; 120 s soft idle teardown with the
  in-flight interlock; health check; stop on quit/lock.
- Raw `/completion` streaming client (SSE), `stop: ["<end_of_turn>"]`, `temperature 0`,
  abort-signal plumbing (the e5/reranker endpoint clients are precedents for a non-chat client).
- Prompt builder + `code → English name` map for the curated 10 (+ native-name map for UI/titles,
  exported for TG-3): **V1 first** — dump `tokenizer.chat_template` from the downloaded GGUF and
  reconcile the builder verbatim before hardcoding; snapshot-test the exact rendered prompt.
- Wiring: `compose-services.ts` + `resolveSidecarSelection` (model → binary → weights ladder →
  `available: false`).
- **Manual smoke harness** `tests/manual/translategemma-smoke.test.ts`, env-gated
  `HILBERTRAUM_TRANSLATEGEMMA_SMOKE=<drive root>` (translation-smoke/gemma-thinking pattern):
  loads the real pinned b9849 server (Windows Vulkan AND the CPU safety-net binary) with the real
  GGUF; asserts: model loads (#22908 risk), DE→EN + EN→DE sanity, verbatim numbers/dates/codes,
  embedded-instruction adversarial window is translated-not-obeyed, no `<end_of_turn>` leakage;
  records tokens/sec + peak RSS (→ D10 min-RAM recalibration) as the printed artifact. Add the
  row to `packaging.md`'s required harness matrix (`:392-433`).
- Unit/integration tests: fake-server tests for launch args (no `--jinja`, ctx, parallel), idle
  teardown timers, prompt builder, stop/abort, error mapping.
- Docs: `architecture.md` sidecar section stub (full record at TG-6).
- Exit: **smoke PASSES on the real pin** — this is the hard gate for TG-3; if the pin fails
  (#20305-adjacent breakage on `/completion`, or #22908-style silence), STOP and re-plan (options:
  newer pin + full re-smoke matrix, or park).
- Commit: `feat(translation): TranslateGemma sidecar service + b9849 load smoke (TG-2)`

### TG-3 — Doc-task rerouting + language widening (the replacement — **breaking**)

**Scope**: the existing document-translation doc-task switches backend; languages widen.
- `DocTaskDeps` gains the translation service handle; `runTranslation` plans with the **sidecar's**
  `contextWindow()` + the D4 `maxInputTokens` clamp, calls the sidecar per window (sequential,
  one retry, `failedWindowNotice` unchanged), stamps the translation model's id into attribution +
  provenance.
- Guards: `kind:'translation'` requires the translation model (D3, new copy); chat-runtime checks
  no longer apply to it; **all other kinds unchanged**; FIFO + chat↔task exclusion unchanged (D9).
- Remove `translationSystemPrompt`/`translationWindowPrompt` + `TRANSLATION_TEMPERATURE` and their
  unit tests; keep/adapt `translationBudgetWords`/`planTranslationWindows` (+ new clamp tests),
  `failedWindowNotice`, `translationAttributionLine`, `translatedDocumentTitle` (widened labels).
- Widen `TranslationTargetLang` + add `TranslationSourceLang` + server-side validation
  (`manager.ts:217-224`) + `TASK_TRANSLATION_TARGET_MESSAGE` copy.
- `DocumentsScreen` modal: two buttons → source+target selects (native names), remembers last
  choice (session-local); DocRow Translate item gains the model-missing state (query installed
  models via the existing models IPC; disabled item + install hint + Models deep link).
- Update the full test battery: `doctasks-translation.test.ts` (scriptedRuntime now injected as
  the *translation* runtime; new guard tests: no-translation-model refusal, chat-model-absent
  success), `doctasks-windows.test.ts` (clamp, widened titles), `DocumentTranslate.test.tsx`
  (selects, sourceLang payload, install-notice), `audit-ipc.test.ts` (unchanged sweep must stay
  green), `docs-ipc`/`smart-views`/collections neighbors (should be untouched — confirm).
- Docs: `known-limitations.md` translation section rewrite (2K windows + terminology-drift note,
  widened language set + evidence rule, model-required behavior), `user-guide.md` §7 block,
  `architecture.md` doc-task bullets.
- Exit: suite green; translating a document end-to-end through the app uses TranslateGemma
  (manual check via the running app); a machine without the model gets the friendly install path.
- Commit: `feat(doctasks)!: translation runs on the TranslateGemma sidecar; curated 10-language set (TG-3)`

### TG-4 — Translate view (text translation)

**Scope**: the new screen, text path only.
- Nav: `ScreenId 'translate'` + `resolveNavTarget` + `NAV_TOP` entry (after Documents, before
  Images — adjust at review) + render block + new Icon glyph + `nav.translate` (soft-hyphenated
  de label if needed).
- Screen per D6: textarea (input), source/target selects + swap, primary Translate button,
  streamed output (40 ms flush buffer, plain-text live + `AssistantMarkdown` on done,
  `StreamAnnouncer`), copy via `window.api.copyToClipboard` + toast, cancel, friendly errors
  (`friendlyIpcError`), model-missing `EmptyState` → Models deep link, busy gating vs the
  doc-task/chat exclusion (D9: surface "a document task is running" states honestly).
- Main: `translate:start/cancel` job service on the sidecar — single window fast-path; multi-window
  planned text streams window-by-window; remount recovery via `getActiveTranslateJob` +
  `translateSession.ts` store (visionSession template).
- IA: design-guidelines §2 updated to "7 primary + 1 utility" + rationale;
  `InformationArchitecture.test.tsx` + `rail-labels.test.ts` updated.
- Tests: renderer TranslateScreen suite (stubApi; type→translate→stream→copy, cancel, swap,
  model-missing, busy), integration for the new IPC (validation, abort, no-model refusal),
  `GermanSmoke` entry, i18n parity (compile-enforced; add the runtime constant↔catalog test only
  if new persisted/IPC constants appear).
- Docs: `user-guide.md` new numbered section + §4 nav map; `security-model.md` IPC note (audit
  stays content-free — translate jobs log ids/kinds only).
- Exit: suite green; typing text and translating works live against the real sidecar.
- Commit: `feat(ui): Translate view — streaming text translation (TG-4)`

### TG-5 — Drag-and-drop + file translation in the view

**Scope**: documents into the Translate view.
- Drop zone (ImageDropZone template: focusable, drag-over state, WCAG 2.5.7 "choose file" button
  via the `pickDocuments` token flow; multi-drop rejected) over the input panel.
- Flow per D7: `getDroppedFilePath` → `importDocuments(paths, {destination:{kind:'temporary'}})`
  → `startTask('translation', docId, {sourceLang, targetLang})` → poll (`lib/doctasks.ts` store)
  → on done load the materialized doc's text into the output panel + actions: Export
  (`exportDocument`), "Show in Documents" (navigate), Discard-temporary handling documented.
- Progress: window-count progress (`Translating… (3/12)`) in the view; cancel.
- Tests: renderer (drop → import → task → output, picker path, multi-drop rejection, drop of
  unsupported extension → friendly error), integration reuse of the doc-task suite for the
  temporary-destination path.
- Docs: user-guide drag-drop paragraph; known-limitations (temporary-doc lifecycle).
- Exit: dropping a PDF onto Translate produces the translated Markdown in the output box and an
  exportable generated document.
- Commit: `feat(ui): document drag-and-drop translation in the Translate view (TG-5)`

### TG-6 — Calibration, per-language evidence, closure

**Scope**: measurements, promotion record, doc lifecycle.
- Re-measure on the real sidecar: Gemma-tokenizer tokens-per-word (input + output, DE at minimum)
  → update the planner constants + comments (the "measured on Qwen3-4B" notes); peak RSS →
  `recommended_min_ram_gb`; tokens/sec (CPU and, if D8 shipped it, GPU) → D8 revisit; idle
  teardown + co-residency behavior → D9 relax-or-keep decision (record it either way).
- Per-language smoke for the curated 10 (extend the TG-2 harness: one round-trip + verbatim-token
  check per language) — the recorded evidence the widened type cites.
- `model-benchmarks.md`: a §9-style "translation model" record — promotion bar for future
  translation candidates (what a 4B/27B or successor must beat: the 12B's smoke + these
  measurements; public MT benchmarks are not a signal, consistent with §9).
- Doc lifecycle: fold this plan into design records — `model-policy.md` (role + license record),
  `architecture.md` (sidecar + view + doc-task design record with §-anchors), delete this file;
  add the §-anchor legend if code comments cite plan §s.
- BUILD_STATE final wave entry; CHANGELOG.
- Commit: `docs+fix(translation): TG wave calibration, per-language record, design records (TG-6)`

## §5 Risks and mitigations

| Risk | Mitigation |
|---|---|
| `--jinja` regression (#20305, fix unmerged upstream) | Designed around: no jinja anywhere in the sidecar; raw `/completion` + app-side prompt (D2). TG-2 verifies on the real pin. |
| Silent no-output / load failure (#22908, seen on other tags) | TG-2 hard gate on the exact pin binaries before any caller switches (TG-3). |
| Windows Vulkan hang under parallel translation (#25142) | `--parallel 1`, strictly sequential windows, Windows-Vulkan smoke + CPU safety-net binary fallback (existing rung-2/3 mechanics). |
| Gemma Terms (non-permissive, previously a parking reason) | O1: `pending` + existing license-ack download gate; never bundled/auto-recommended; commercial approval is a separate explicit review with flow-down notes drafted in the manifest. |
| 2K input spec vs. our window math | D4 structural clamp + conservative Qwen constants until TG-6 re-measures; over-chunking is the failure mode, not overflow. |
| Hard model requirement breaks existing users' translation (O2) | Friendly install path with deep link everywhere translation is offered; user-guide + CHANGELOG called out; download is resumable and hash-verified. |
| RAM co-residency (12B translate + resident chat + embedder) | D9 keeps serialization; idle teardown bounds the window; TG-2/TG-6 measure real peaks; min-RAM gate on the manifest recalibrated from measurement. |
| Third-party quantizer (mradermacher — new provenance for this catalog) | Same established-quantizer posture as the unsloth entries; hash pinned via LFS OID + `verify-models --generate`; recorded in `license_review.notes`. |
| Cross-window terminology drift (small windows) | Documented limitation (TG-3); candidate future work: sliding glossary/context header — explicitly out of scope. |

## §6 Non-goals / deferred (explicit)

- **Image translation** (the model is image-text→text and mmproj files exist): out of scope; a
  natural later Images-screen integration. Manifest deliberately ships GGUF only (the Gemma-4
  "TEXT-ONLY USE" precedent note).
- **4B / 27B manifests** (O3): manifest-only follow-ups once the role exists; the TG-6 record
  defines their promotion bar.
- **Source-language auto-detect**: no offline langid exists in-app; explicit source select in v1.
- **Chat-during-translation relaxation** (D9) and **GPU work beyond D8's outcome**: TG-6-decided.
- **Streaming tokens inside the doc-task lane**: doc translation keeps coarse window progress.
- **Languages beyond the curated 10**: add per-language evidence first (TG-6 harness makes this cheap).

## §7 Re-verify at implementation time

- **V1 (TG-2)**: the verbatim chat template — dump `tokenizer.chat_template` from the downloaded
  GGUF and reconcile the prompt builder word-for-word (research reconstructed it from the HF
  template viewer; do not hardcode unreconciled).
- **V2 (TG-1)**: download URL works unauthenticated (tree API did on 2026-07-05; the *google* base
  repo is gated, the mradermacher GGUF repo was not).
- **V3 (TG-1)**: exact GGUF filename `translategemma-12b-it.Q4_K_M.gguf` + `size_bytes
  7300794112` via the tree API at fetch time.
- **V4 (TG-1)**: sha256 from the file's git-LFS OID cross-checked with `X-Linked-ETag`, then
  `verify-models --generate` after the first real download (never transcribe an uncomputed hash).
- **V5 (TG-2)**: whether any llama.cpp fix for #20305 merged after 2026-07-05 (PR #20956) — if a
  future pin bump lands it, the no-jinja design still stands (simpler + deterministic), but the
  research note in model-policy should be updated.
- **V6 (TG-3)**: confirm `resolveModelByRole('translation')` returns `recommendedContextTokens`
  for the sidecar launch exactly as it does for vision/reranker.
