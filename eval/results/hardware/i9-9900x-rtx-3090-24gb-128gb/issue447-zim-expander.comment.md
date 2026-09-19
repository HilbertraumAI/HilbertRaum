### Does the ZIM query expander evict a pack-scoped ask's own prefix every turn? (issue #447)

Leg B of #399 (`issue399-app-helpers.comment.md`) extended to the one helper call it could not
reach. The current-master dev build (`1e59e901`) driven through Playwright `_electron`, with
`HILBERTRAUM_LLAMA_BIN` pointed at a tee wrapper, so every task the app puts on the chat runtime
shows up in one log. Driver: `issue447-zim-expander.mjs`; the tee logs are committed as
`issue447-zim-expander-{qwen3.8-27b-ud-q5km,qwen3.5-9b-ud-q4kxl}.stderr.log` with the filtered
`.cache-lines.txt` and the driver trace `.run.log` beside them. No product code was changed.

1. **Model / launch, as the app resolved it — read from the OS process list
   (`/proc/<pid>/cmdline`), not from our code:**
   `llama-server --host 127.0.0.1 --port 43445 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf
   --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format
   deepseek -lv 4 -np 1 --cache-ram 0 --spec-type draft-mtp --spec-draft-n-max 2` — `backend=gpu`,
   `healthy=true`, pinned b9849. **`--cache-ram 0` is present** (#399 D5), on both models; it was
   absent from leg B's argv, which predates D5. The second data point, `qwen3.5-9b-ud-q4kxl`, is the
   same argv without the two `--spec-*` flags: a **non-MTP** start of an affected family.
2. **The pack:** one small ZIM, `wikipedia_en_physics_mini_2026-07.zim` ("Physics by Wikipedia",
   `eng`, 99,397 articles, 56.7 MB) in `<drive>/zim/`, served by the pinned kiwix-tools 3.8.1
   installed with `scripts/fetch-runtime.sh --family kiwix_tools` (hash marker written). The app
   lists it `enabled=true available=true searchable=yes`. **Retrievable, confirmed before anything
   was measured:** a pack-only preflight ask returned `packOutcomes` `searched`, 5 found / 5
   admitted, and an answer citing `archive:Neutron star`. The preflight also absorbs the
   first-ever task on the slot, which is always a cold 0.
3. **The document:** leg B's synthetic plant handbook, `status=indexed`, 13 chunks, no background
   job (`getActiveDocTask()` null). It is the control's corpus.
4. **Skills:** all nine disabled (leg B's `noskills` mode), so the classifier has no candidates.
   **The expander is the only helper call in these logs.**

#### The measurement

Two ordinary questions per fresh conversation — "What is the Doppler effect?", then "And what does
the Heisenberg uncertainty principle state?". **P** = the pack ticked alongside all documents;
**C** = the same two questions with the pack scope off; **PO** = the pack alone (`documentsOff`,
what "Ask this pack" opens). Each run twice, interleaved P1, C1, P2, C2, PO1, PO2.

`total` is the task's `task.n_tokens`; `kept` is what the slot still held (`total − prefilled`).
The last task of a turn is the answer.

**`qwen3.8-27b-ud-q5km` (MTP start) — leg B's model**

| conversation | turn | model tasks | task | total | prefilled | kept | prompt eval ms | decode tok / ms | turn wall s |
|---|---|---|---|---|---|---|---|---|---|
| P1 | 1 | **2** | 130 (expand) | 142 | 142 | 0 | 846 | 53 / 1474 | 12.8 |
| | | | 152 (answer) | 2248 | 2248 | **0** | 3761 | 256 / 6586 | |
| P1 | 2 | **2** | 261 (expand) | 146 | 146 | 0 | 844 | 71 / 1984 | 11.4 |
| | | | 290 (answer) | 2723 | 2723 | **0** | 4559 | 169 / 3793 | |
| C1 | 1 | **1** | 355 | 2312 | 2085 | **227** | 3166 | 38 / 975 | 4.2 |
| C1 | 2 | **1** | 375 | 2382 | 2155 | **227** | 3320 | 40 / 857 | 4.2 |
| P2 | 1 | **2** | 393 (expand) | 142 | 142 | 0 | 849 | 53 / 1400 | 12.7 |
| | | | 415 (answer) | 2248 | 2248 | **0** | 3726 | 273 / 6607 | |
| P2 | 2 | **2** | 525 (expand) | 146 | 146 | 0 | 823 | 71 / 2003 | 12.9 |
| | | | 554 (answer) | 2740 | 2740 | **0** | 4557 | 240 / 5409 | |
| C2 | 1 | **1** | 648 | 2312 | 2085 | **227** | 3183 | 74 / 1643 | 4.9 |
| C2 | 2 | **1** | 680 | 2418 | 2191 | **227** | 3506 | 93 / 1928 | 5.5 |
| PO1 | 1 | **2** | 718 (expand) | 142 | 142 | 0 | 855 | 53 / 1413 | 12.6 |
| | | | 740 (answer) | 1257 | 1257 | **0** | 2454 | 312 / 7724 | |
| PO1 | 2 | **2** | 867 (expand) | 146 | 146 | 0 | 838 | 71 / 2029 | 13.3 |
| | | | 896 (answer) | 2709 | 2709 | **0** | 4619 | 243 / 5719 | |
| PO2 | 1 | **2** | 994 (expand) | 142 | 142 | 0 | 838 | 53 / 1477 | 12.1 |
| | | | 1016 (answer) | 1257 | 1257 | **0** | 2429 | 304 / 7285 | |
| PO2 | 2 | **2** | 1131 (expand) | 146 | 146 | 0 | 828 | 71 / 1985 | 12.4 |
| | | | 1160 (answer) | 2701 | 2701 | **0** | 4623 | 224 / 4803 | |

**`qwen3.5-9b-ud-q4kxl` (non-MTP start) — second data point, same driver, same questions**

| conversation | turn | model tasks | task | total | prefilled | kept | prompt eval ms | decode tok / ms | turn wall s |
|---|---|---|---|---|---|---|---|---|---|
| P1 | 1 | **2** | 393 (expand) | 142 | 142 | 0 | 271 | 70 / 1332 | 8.0 |
| | | | 466 (answer) | 2248 | 2248 | **0** | 1354 | 277 / 4832 | |
| P1 | 2 | **2** | 747 (expand) | 146 | 146 | 0 | 260 | 63 / 1187 | 8.1 |
| | | | 813 (answer) | 2764 | 2764 | **0** | 1614 | 283 / 4897 | |
| C1 | 1 | **1** | 1101 | 2312 | 2085 | **227** | 1165 | 101 / 1742 | 3.0 |
| C1 | 2 | **1** | 1205 | 2441 | 2214 | **227** | 1279 | 99 / 1703 | 3.1 |
| P2 | 1 | **2** | 1308 (expand) | 142 | 142 | 0 | 266 | 70 / 1371 | 6.5 |
| | | | 1381 (answer) | 2248 | 2248 | **0** | 1355 | 192 / 3385 | |
| P2 | 2 | **2** | 1577 (expand) | 146 | 146 | 0 | 260 | 69 / 1313 | 8.8 |
| | | | 1649 (answer) | 2679 | 2679 | **0** | 1553 | 316 / 5499 | |
| C2 | 1 | **1** | 1970 | 2312 | 2085 | **227** | 1141 | 52 / 875 | 2.1 |
| C2 | 2 | **1** | 2025 | 2392 | 2165 | **227** | 1273 | 52 / 885 | 2.2 |
| PO1 | 1 | **2** | 2081 (expand) | 142 | 142 | 0 | 270 | 66 / 1307 | 7.7 |
| | | | 2150 (answer) | 1334 | 1334 | **0** | 833 | 276 / 5151 | |
| PO1 | 2 | **2** | 2429 (expand) | 146 | 146 | 0 | 260 | 63 / 1193 | 9.6 |
| | | | 2495 (answer) | 2793 | 2793 | **0** | 1597 | 364 / 6379 | |
| PO2 | 1 | **2** | 2864 (expand) | 142 | 142 | 0 | 264 | 70 / 1342 | 7.3 |
| | | | 2937 (answer) | 1334 | 1334 | **0** | 825 | 262 / 4788 | |
| PO2 | 2 | **2** | 3202 (expand) | 146 | 146 | 0 | 259 | 63 / 1191 | 7.9 |
| | | | 3268 (answer) | 2779 | 2779 | **0** | 1634 | 270 / 4691 | |

#### Verdict

**The expander evicts the prefix, on every pack-scoped turn. This is NOT the "expected, harmless"
case the issue predicted.** On turn 2 of run P the answer task starts from `kept = 0`, not 227 — on
**16 of 16** measured pack-scoped turns across both models, turn 1 and turn 2 alike, with documents
on (P) or off (PO). The control keeps **227 on 8 of 8** turns. The expander call itself is real and
unconditional: exactly **one** extra task per pack-scoped turn, never zero, never more than one.

**The mechanism, from the tee log, is a two-way thrash of the one slot.** The expander's prompt
shares **3 tokens** with the answer's (`checking checkpoint with [226, 226] against 3`), so its
arrival erases the answer's 227-token context checkpoint; the answer's arrival then erases the
expander's own 123-token checkpoint. Neither system prefix survives a turn: the expander's
`kept` is 0 every time as well, although 123 of its 142–146 tokens are an unchanging system prompt.
The control shows the counterfactual in the same session — `restored context checkpoint
(n_tokens = 227)`, even directly after a pack-scoped answer.

**The cost per pack-scoped turn, against run C:**

| | `qwen3.8-27b-ud-q5km` | `qwen3.5-9b-ud-q4kxl` |
|---|---|---|
| extra model tasks | **1** | **1** |
| expander prefill | 142–146 tokens, 0.82–0.86 s | 142–146 tokens, 0.26–0.27 s |
| expander decode | 53–71 tokens, 1.40–2.03 s | 63–70 tokens, 1.19–1.37 s |
| answer prefix re-prefilled (227 → 0) | +227 tokens, ≈ 0.35 s at the control's 650–660 tok/s | +227 tokens, ≈ 0.13 s at ~1,790 tok/s |
| **extra prefilled tokens** | **369–373** | **369–373** |
| extra seconds, prefill only (leg B's basis) | **≈ 1.2 s** | **≈ 0.4 s** |
| extra seconds, the whole call incl. its decode | **≈ 2.6–3.2 s** | **≈ 1.6–1.8 s** |

Read against the classifier proxy (leg B: one extra task, ~400 extra prefilled tokens, ~1.4 s):

- **Tasks and tokens are inside the proxy** — one task, 369–373 prefilled tokens.
- **Seconds depend on the basis, and the two bases disagree.** Leg B's ~1.4 s is a *prefill*
  figure (the classifier's 1.07 s prompt eval plus ~0.36 s for the lost prefix; its reply was 7
  tokens, 0.17 s). On that basis the expander is ≈ 1.2 s, inside the proxy. But the expander
  *decodes* a 53–71-token grammar-constrained plan where the classifier decodes 7 tokens, so the
  whole call costs **≈ 2.6–3.2 s per turn on the 27B — about twice the proxy** — and it is paid
  on every pack-scoped turn, not on two rare trigger classes.
- **Which part is new.** The decode cost is the call itself, not a cache effect, and its shape was
  already on the D-Z20 record (#423: "the cost is DECODE, not prefill"; the ruling accepted
  "~1–3 s"), though never measured on this model. What #447 adds is the **cache** part: the
  eviction is real, it is per-turn, and its marginal cost is **the 227-token system prefix —
  ≈ 0.35 s here, bounded, independent of conversation length**, exactly as leg B's bound said it
  would be, because a documents turn never reuses more than that prefix anyway (control, turn 2:
  2,382 total, 227 kept).

**Owner ruling, 2026-09-18: this does not reopen D-Z20's "always".** The decode cost was already
accepted in that ruling (#423); only the 227-token cache part is new, and it is bounded. The
expander was not changed.

**Turn wall clock is NOT the cost.** P turns took 11.4–13.3 s against the control's 4.2–5.5 s on
the 27B, but most of that gap is answer length, not the expander: the pack can answer these
questions (169–312 decoded tokens), the handbook cannot ("The provided document excerpts do not
contain information about…", 38–93 tokens). The two model tasks account for the P turn to within
~0.2 s (P1 turn 1: 2.32 s + 10.35 s of 12.8 s), so the pack search itself is negligible here.

#### The trap, a fifth time — and it cut the other way

`forcing full prompt re-processing due to lack of cache data` appears **18 times in each log** —
on exactly the 18 pack-run tasks (9 turns × 2) and on none of the 4 control tasks — **including on
the non-MTP `qwen3.5-9b` start**, where the #399 record says it does not appear. Here it happens
to coincide with `kept = 0`, because in these runs every task that lost its checkpoint also logged
it. That is a coincidence of this workload, not a property of the line: the #446 sweep recorded it
**0 times** across captures that re-prefilled. The token counts above were read first and are the
only thing the verdict rests on.

#### What this could not measure

- **A long pack-scoped conversation.** Every turn assembled 1.3–2.8k tokens against the 8,192
  window. The eviction's marginal cost is bounded by the 227-token prefix regardless of length
  (the control proves a documents turn keeps nothing else), but the absolute figures are not
  length-independent.
- **CPU-only and slower GPUs.** The decode share scales with 1/decode-rate: #423 measured
  10.3–12.6 tok/s on an i9-14900K at `-ngl 0`, where a 53–71-token plan is ~4–7 s. Nothing here
  re-measures that; both models ran fully offloaded on the RTX 3090.
- **More than one pack, other languages, other question shapes.** One English pack, two English
  questions. The expander runs once per ask, never per pack, so the task count should not change
  — but that is the code's claim, not something this run exercised. Reply length (and so decode
  cost) is set by the question; two questions are not a distribution. §17 F1's `core200` run
  measured a p99 of 99 reply tokens against the 104-token cap.
- **`gemma4`**, the third affected family (SWA rather than recurrent). Not run in-app.
- **Whether a second slot would stop the thrash.** #399 leg C found `-np 2` routes by LCP
  similarity and halves `n_ctx_slot`; that was not re-tested against this two-prompt pattern.
- **With skills enabled**, a trigger-class turn in a pack-scoped chat would carry both helper
  calls. Deliberately excluded so the expander could be isolated.
