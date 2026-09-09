### Leg A — architecture sweep: which chat models lose the host-cache restore (issue #399, D2)

Raw `llama-server`, no app. One start per model, the app's argv shape held identical across
models, three requests per start, the whole stderr captured. Driver + exact prompt bytes:
`issue399-arch-sweep.mjs` (`--print-prompts <dir>` dumps them).

1. **Runtime:** pinned `version: 9849 (799fcc04a)`, the b9849 Ubuntu Vulkan build (GNU 11.4.0),
   the same binary and sha256 as the leg-1 / leg-7 captures.
2. **Argv (every model):**
   `llama-server --host 127.0.0.1 --port <n> --model <drive>/models/chat/<id>.gguf --ctx-size 8192
   --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1`
   **No MTP flags on any model in this leg.** The 27B is therefore measured without the second
   `rs_seq` MTP adds; it is hybrid/recurrent either way (`llama_memory_recurrent`, below), and the
   leg-7 verdict reproduces exactly.
3. **Machine:** Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic, RTX 3090 24,822 MiB (23,564 MiB free
   at the first spawn), NVIDIA **595.91.07** (595.84 in the leg-1/leg-7 captures — an unattended
   upgrade replaced the userspace mid-session; see "What this run could not measure"). Idle P8,
   405 MHz memory clock before each spawn, `clocks.max.memory` 9,751 MHz. **Every model in the
   table below offloaded fully** (the `layers` column), so no verdict rests on a partial offload.
4. **The three requests** (`temperature: 0`, `max_tokens: 16`, no streaming, `cache_prompt` left at
   its default): **R1** conversation A = a ~40-token shared system message + a fixed synthetic
   ~1,450-token user message; **R2** conversation B = the *same* system message + a ~20-token
   unrelated user message; **R3** back to A = R1's messages + R1's assistant reply + one new
   ~20-token user turn. Byte-stable across models except R1's assistant reply, which is the model's
   own; that is why the totals differ by a few tokens per family.

#### The table

`prefilled` is `prompt eval time = … / N tokens`; `of` is the request's whole `prompt_tokens`.

| model | arch | n_swa | recurrent state | layers | R1 prefilled | R2 prefilled | R3 prefilled | kept | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `qwen3-8b-instruct-q4` | qwen3 | 0 | none | 37/37 | 1441 of 1441 | 18 of 62 | **21 of 1462** | 1441 | **RESTORED** |
| `qwen3-30b-a3b-q4` | qwen3moe | 0 | none | 49/49 | 1441 of 1441 | 18 of 62 | **21 of 1462** | 1441 | **RESTORED** |
| `qwen3.5-2b-ud-q4kxl` | qwen35 | 0 | 19.27 MiB (24 layers) | 25/25 | 1508 of 1508 | 23 of 64 | **1488 of 1529** | 41 | **RE-PREFILLED** |
| `qwen3.5-4b-ud-q4kxl` | qwen35 | 0 | 50.25 MiB (32 layers) | 33/33 | 1508 of 1508 | 23 of 64 | **1488 of 1529** | 41 | **RE-PREFILLED** |
| `qwen3.5-9b-ud-q4kxl` | qwen35 | 0 | 50.25 MiB (32 layers) | 33/33 | 1508 of 1508 | 23 of 64 | **1488 of 1529** | 41 | **RE-PREFILLED** |
| `qwen3.5-35b-a3b-ud-q4kxl` | qwen35moe | 0 | 62.81 MiB (40 layers) | 41/41 | 1508 of 1508 | 23 of 64 | **1488 of 1529** | 41 | **RE-PREFILLED** |
| `qwen3.8-27b-q4` | qwen35 | 0 | 149.62 MiB (64 layers) | 66/66 | 1546 of 1546 | 23 of 102 | **1492 of 1571** | 79 | **RE-PREFILLED** |
| `qwen3.8-27b-ud-q4km` | qwen35 | 0 | 149.62 MiB (64 layers) | 66/66 | 1546 of 1546 | 23 of 102 | **1492 of 1571** | 79 | **RE-PREFILLED** |
| `qwen3.8-27b-ud-q5km` ★ | qwen35 | 0 | 149.62 MiB (64 layers) | 66/66 | 1546 of 1546 | 23 of 102 | **1492 of 1571** | 79 | **RE-PREFILLED** |
| `gemma4-e2b-it-qat-q4` | gemma4 | 512 | none | 36/36 | 1493 of 1493 | 21 of 64 | **1471 of 1514** | 43 | **RE-PREFILLED** |
| `gemma4-e4b-it-qat-q4` | gemma4 | 512 | none | 43/43 | 1493 of 1493 | 21 of 64 | **1471 of 1514** | 43 | **RE-PREFILLED** |
| `gemma4-12b-it-qat-q4` | gemma4 | 1024 | none | 49/49 | 1493 of 1493 | 21 of 64 | **1471 of 1514** | 43 | **RE-PREFILLED** |
| `gemma4-26b-a4b-it-qat-q4` | gemma4 | 1024 | none | 31/31 | 1493 of 1493 | 21 of 64 | **1471 of 1514** | 43 | **RE-PREFILLED** |
| `ministral3-8b-instruct-2512-q4` | mistral3 | 0 | none | 35/35 | 1447 of 1447 | 14 of 55 | **14 of 1471** | 1457 | **RESTORED** |

`kept` is the `cached n_tokens` R3 started from. On every RE-PREFILLED row it is exactly the shared
system prefix (41 / 43 / 79 tokens) — the part that never left the slot, not a restore. On the three
RESTORED rows it is A's whole prefix (1,441 / 1,441 / 1,457 tokens): only the new assistant reply
plus the new user turn (21 / 21 / 14 tokens) were processed.

Every model reports `n_slots = 1`, `n_ctx_slot = 8192`, `kv_unified = false`, `n_seq_max = 1`.
No model logs `llama_memory_hybrid`; the qwen35 family logs `llama_memory_recurrent` with
`1 cells, N layers, 1 seqs 0 rs_seq`.

#### What it answers (D2)

**The split is exactly the one llama.cpp's message names, and it has two positive controls.**
A model with neither a sliding window nor recurrent state restores its evicted prefix from the host
prompt cache — on a dense (`qwen3`), a MoE (`qwen3moe`) and a third-vendor dense (`mistral3`)
architecture — so #386's recorded
"the cost is a restore, not a full re-prefill" IS true, for those two models. Every model that has
SWA (all four `gemma4` manifests) **or** recurrent state (every `qwen35` / `qwen35moe` manifest,
including all three 27B quants) re-prefills its whole history down to the shared system prefix.

That is the entire modern Qwen/Gemma catalog. Of the fourteen measured, eleven are affected; the
three that are not are the two legacy `qwen3` entries and `ministral3-8b-instruct-2512-q4` (the DIY
default-set chat model, rank kept — the one ranked model in the catalog that is NOT affected). In particular
**both 8–12 GB tier picks are affected** (`gemma4-e2b`, `gemma4-e4b`), which is the case the issue's
second comment flagged as unaffordable, and so is the bundled/catalog-default `qwen3.5-4b-ud-q4kxl`
and the DIY 9B. Ministral 3 is the one ranked model that keeps the restore.

#### Two things that contradict the issue as written

1. **`forcing full prompt re-processing due to lack of cache data` did not appear once in this
   leg** — not on the 27B Q5 control, not on any Gemma. It is in the leg-7 capture because that
   start carried the MTP flags (`prompt_save: … (draft: 1.708 MiB)` there versus `(draft: 0.000 MiB)`
   here). **The log line is not the diagnostic.** On every affected model here the server instead
   logged `load: - found better prompt with f_keep = 0.990, sim = 0.983`, i.e. it FOUND A's cached
   prompt, and then silently prefilled the whole thing anyway. Anyone reproducing this by grepping
   for `forcing full` will conclude, wrongly, that the restore works. The token count is the only
   honest read.
2. **The affected set is not "the two 27B quants, and probably Gemma".** It is every ranked chat
   model in the catalog. The issue's point 5 guessed the set was "probably wider"; it is wider than
   that guess, because the whole Qwen 3.5 / 3.8 line is recurrent, not just the 27B.

#### Cost side-observation (D5)

On the affected models the host prompt cache is written on every hand-back and never read. Sizes
from the capture, for one eviction of a ~1,500-token conversation: `qwen3.8-27b-*` 247.22 MiB saved,
456.19 MiB resident after three requests; `qwen3.5-35b-a3b` 92.59 / 189.98 MiB; `gemma4-12b` 343.59 /
357.34 MiB; `gemma4-e2b` 14.86 / 15.38 MiB. The default limit is 8,192 MiB of host RAM. On the two
RESTORED models the same bytes are written and then actually used.

#### What this run could not measure

- **Six catalog entries could not be started at all**: `gemma-4-26b-q4`, `gemma4-coding-q8`,
  `qwen3.5-0.8b-q6`, `qwen3.5-9b-q8`, `qwen3.6-27b-q4`, `qwen3.6-27b-q5` are broken symlinks on this
  rig, pointing into the eval drive deleted on 2026-09-04. `qwen3.8-flash-next-ud-q4kxl` (a 111 GB
  four-shard set, dev-only, licence PENDING) is out of scope for a 24 GB card.
- **`gemma4-31b-it-qat-q4`, `qwen3.5-27b-ud-q4kxl`, `granite-4.1-8b-q4`** and the remaining
  never-fetched manifests are not on this rig and were not downloaded.
- **R1 prompt-eval times are not comparable across rows.** The NVIDIA userspace was upgraded to
  595.91.07 today, so the driver's Vulkan pipeline cache was cold: the first model's R1 took 75.7 s
  for 1,546 tokens (20 tok/s), the second 39.0 s, and later models 0.6–3.5 s for the same work. R3
  is the clean figure (e.g. 27B Q5: 1,492 tokens in 1,661 ms = 898 tok/s). **No verdict in this
  table depends on a timing** — every one is a token count.
- Nothing here was run at a context above 8,192, and nothing was run with MTP. Both are deliberate
  (the leg holds the argv identical); leg C covers MTP at `-np 1` and `-np 2`.
