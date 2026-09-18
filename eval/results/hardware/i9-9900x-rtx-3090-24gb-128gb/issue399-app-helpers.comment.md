### Leg B — does an ordinary documents ask evict its own prefix every turn? (issue #399, D1)

The current-master dev build driven through Playwright `_electron`, with `HILBERTRAUM_LLAMA_BIN`
pointed at a tee wrapper (the leg-7 / #298 method), so every task the app puts on the chat runtime
shows up in one log. Driver: `tmp/399-legb/leg-b.mjs` (a git-ignored working paper); the tee logs are
committed as `issue399-app-helpers-{skills,noskills}.stderr.log` with the filtered
`.cache-lines.txt` and the driver trace `.run.log` beside them.

1. **Model / launch, as the app resolved it (not typed in):**
   `llama-server --host 127.0.0.1 --port 38989 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf
   --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format
   deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2` — rung 1a, `backend=gpu`,
   `healthy=true`. The launched window is **8,192** (`recommendedContextTokens`;
   `settings.contextTokensOverride` is null, so the 4,096 `settings.contextTokens` retrieval knob
   does not reach `--ctx-size`).
2. **The document:** one synthetic 5,241-word plant handbook (`tmp/399-legb/plant-handbook.txt`),
   `status=indexed`, 13 chunks. Below the deep-index size gate as intended: at ctx 8,192
   `summaryBudgetWords` is 5,676 words per window against a 12-window ceiling, so
   `planSummaryWindows().truncated` is false. Confirmed live — `getActiveDocTask()` **null**,
   `listActiveDocTasks()` **[]**, no tree / deep-index line in the app log. **No background job was
   running during any turn below.**
3. **Skills:** the nine `app-skills/` skills install **enabled** (`registry.ts:277` — DS19's
   disabled-by-default applies to `user-skills/` drop-ins only), so the classifier has candidates
   out of the box. The control run disabled all nine.

#### The measurement

`total` is the task's `task.n_tokens`; `kept` is what the slot still held (`total − prefilled`).

**With skills (classifier has candidates)**

| conversation | turn | question class | model tasks | task | total | prefilled | kept |
|---|---|---|---|---|---|---|---|
| C1 | 1 | ordinary | **1** | 6 | 2591 | 2591 | 0 |
| C1 | 2 | ordinary | **1** | 23 | 2374 | 2147 | **227** |
| C2 | 1 | ordinary | **1** | 38 | 2591 | 2364 | **227** |
| C2 | 2 | aggregation-shaped | **2** | 50 (classify) | 191 | 191 | 0 |
| | | | | 56 (answer) | 2380 | 2380 | **0** |
| C3 | 1 | ordinary | **1** | 86 | 2591 | 2364 | **227** |
| C3 | 2 | compare, no second doc | **2** | 98 (classify) | 171 | 171 | 0 |
| | | | | 104 (answer) | 2642 | 2642 | **0** |

**Without skills (same questions, same document, classifier has no candidates)**

| conversation | turn | question class | model tasks | task | total | prefilled | kept |
|---|---|---|---|---|---|---|---|
| C1 | 1 | ordinary | **1** | 6 | 2591 | 2591 | 0 |
| C1 | 2 | ordinary | **1** | 22 | 2371 | 2144 | **227** |
| C2 | 1 | ordinary | **1** | 36 | 2591 | 2364 | **227** |
| C2 | 2 | aggregation-shaped | **1** | 52 | 2392 | 2165 | **227** |
| C3 | 1 | ordinary | **1** | 83 | 2591 | 2364 | **227** |
| C3 | 2 | compare, no second doc | **1** | 98 | 2650 | 2423 | **227** |

#### Verdict on D1

**No. An ordinary documents ask is one model task and evicts nothing.** Four ordinary asks in the
skills run produced one task each and no classifier call. That matches the code, not the issue's
description of it: `isClassificationTrigger` (`services/analysis/classify.ts:65`) fires only on an
aggregation-shaped coverage-extract turn or a low-confidence relevance fallback — never on the
step-5 fallthrough — so "whenever there are skill candidates" in the second comment is not what runs.

**On the two trigger-class turns the classifier does evict, and the cost is the shared system
prefix, not the history.** Reading the two tables against each other, with the control's totals as
the baseline:

- the classifier's own call: **191** and **171** tokens of prefill, 1.07 s and 1.05 s;
- the answer task then starts from `cached n_tokens = 0` instead of 227, so it prefills
  **+215** (2380 vs 2165) and **+219** (2642 vs 2423) tokens more than the same turn without it.

**Total measured cost of a triggered helper call: about 400 extra prefilled tokens, ~1.4 s** on this
model at ~600 tok/s in-app prefill. Turn-level wall clock: 9 s with the classifier against 7 s
without.

#### The part that contradicts the issue's second comment

Point 2 predicted that if the helpers evict, "a documents ask re-prefills its whole history on
**every** turn". Two separate things are wrong with that.

1. **The history is re-prefilled on every documents turn anyway — with or without any helper.** Look
   at C1 turn 2 in the control: 2,371-token prompt, 2,144 prefilled, **227 kept**. Nothing evicted
   that slot; the retrieved-excerpt block simply changes from turn to turn, so a documents prompt
   diverges from the previous one right after the system prompt. RT-2's hoisting keeps the grounding
   rules in that 227-token prefix, and that prefix is the *whole* of what in-slot reuse can save on a
   documents ask.
2. **Therefore the eviction's marginal cost is bounded by that same 227-token prefix, not by
   conversation length.** It does not scale with a 20k-token conversation the way the issue's cost
   model assumes, because on this path the conversation was never being reused in the first place.

The length-proportional cost the issue describes is real, but it belongs to the case leg 7 actually
measured: an **ordinary chat conversation** (`mode: 'chat'`, no retrieval), where the prompt IS
append-only and in-slot reuse works — leg 7's 171 → 22 → 22 tokens. Neither helper call runs on that
path; only the yielding deep-index build can take the slot there.

#### What this leg could not measure

- **The ZIM query expander.** No knowledge pack is installed on this rig and none was fetched, so
  the once-per-pack-scoped-ask expansion call (`registerRagIpc.ts:776`, D-Z20 "always") was never
  exercised. It has the same shape as the classifier — its own system prompt, low prefix similarity,
  one bounded call before the answer — so the classifier figures above are the best available proxy,
  but that is an inference, not a measurement.
- **A long conversation.** Every turn here assembled ~2.4–2.6k tokens against the 8,192 window. The
  finding that a documents turn keeps only the system prefix is independent of length, but the
  absolute figures are not.
- **The deep-index yielding build** — deliberately excluded (the document is below the size gate) so
  the helper calls could be isolated. That case is leg 7.
- Only `qwen3.8-27b-ud-q5km` was driven in-app. The leg-A table says which other models share its
  behaviour; none of them was run through the app.
