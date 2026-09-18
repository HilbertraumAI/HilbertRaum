### Issue #446 — the three chat entries the #399 sweep could not start

The leg-A protocol of #399, re-run unchanged against the three catalog entries that were never in
that sweep. Same driver (`issue399-arch-sweep.mjs`, unmodified — its prompts are byte-stable, so
these rows are directly comparable to the fourteen in `issue399-arch-sweep.comment.md`), same
argv shape, same pinned binary, same machine, **no MTP flags**.

1. **Runtime:** the same pinned `version: 9849 (799fcc04a)` b9849 Ubuntu Vulkan build (GNU 11.4.0)
   at `<runtime>/llama-server` that the `issue399-*` captures used.
2. **Argv (every model):**
   `llama-server --host 127.0.0.1 --port <n> --model <drive>/models/chat/<id>.gguf --ctx-size 8192
   --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1`
3. **Machine:** Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic, RTX 3090 24,576 MiB, NVIDIA
   595.91.07. **All four starts below offloaded FULLY** (the `layers` column), so no verdict rests
   on a partial offload. Every one reports `n_slots = 1`, `n_ctx_slot = 8192`, `kv_unified = false`,
   `n_seq_max = 1`.
4. **The three requests** are #399's: **R1** conversation A (shared ~40-token system message + a
   fixed synthetic ~1,450-token user message), **R2** conversation B (same system message, a short
   unrelated question) takes the slot, **R3** back to A with one new short turn.

#### Getting the weights (this was the blocker)

`qwen3.6-27b-q4` and `qwen3.6-27b-q5` were broken symlinks into `<home>/llama.cpp/models/`, the eval
drive deleted on 2026-09-04 — the directory still exists and is empty. Both were re-fetched from the
manifest's `download.url`, and `granite-4.1-8b-q4` was fetched for the first time. **Each was
verified against its manifest `sha256` AND its `size_bytes` before it was measured**, because a
truncated GGUF would have produced a verdict rather than an error:

| model | bytes | sha256 (manifest = fetched) |
|---|---|---|
| `qwen3.6-27b-q4` | 16,817,244,384 | `5ed60d0a…638392a0` ✓ |
| `qwen3.6-27b-q5` | 19,509,790,944 | `cfecab16…316ccbde` ✓ |
| `granite-4.1-8b-q4` | 5,347,914,400 | `ed902ac9…fac5309e` ✓ |

#### The table

`prefilled` is `prompt eval time = … / N tokens`; `of` is the request's whole `prompt_tokens`;
`kept` is the `cached n_tokens` R3 started from.

| model | arch | n_swa | recurrent state | layers | R1 prefilled | R2 prefilled | R3 prefilled | kept | verdict |
|---|---|---|---|---|---|---|---|---|---|
| `qwen3.6-27b-q4` | qwen35 | 0 | 149.62 MiB (64 layers) | 65/65 | 1508 of 1508 | 23 of 64 | **1488 of 1529** | 41 | **RE-PREFILLED** |
| `qwen3.6-27b-q5` | qwen35 | 0 | 149.62 MiB (64 layers) | 65/65 | 1508 of 1508 | 23 of 64 | **1488 of 1529** | 41 | **RE-PREFILLED** |
| `granite-4.1-8b-q4` | granite | 0 | none | 41/41 | 1377 of 1377 | 18 of 62 | **22 of 1414** | 1392 | **RESTORED** |
| `qwen3.8-27b-ud-q5km` (control) | qwen35 | 0 | 149.62 MiB (64 layers) | 66/66 | 1546 of 1546 | 23 of 102 | **1492 of 1571** | 79 | **RE-PREFILLED** |

**The control reproduced the #399 sweep token for token** — 1,492 of 1,571 with 79 kept, the same
149.62 MiB recurrent state over 64 layers, the same 66/66 offload. So the setup is the sweep's, and
the three new rows sit in the same table as the fourteen old ones.

#### What it answers

**`qwen3.6` is AFFECTED, and for the measured reason, not the expected one.** Both quants report
arch **`qwen35`** — the same architecture as the `qwen3.5` line and the `qwen3.8` 27Bs — with a
149.62 MiB `llama_memory_recurrent` state over 64 layers. They land on exactly the `qwen3.5` row's
numbers (1,488 of 1,529, 41 kept), not the `qwen3.8` 27B's (1,492 of 1,571, 79 kept), because the
system prefix tokenises the same way for them. The two quants are identical in every column, which
is what a family-level rule expects. → `qwen3.6` joins `PROMPT_CACHE_RESTORE_BROKEN_FAMILIES`.

**`granite` RESTORES, which is the result nobody predicted.** Arch `granite`, `n_swa` 0, no
`llama_memory_recurrent` line at all: R3 re-prefilled **22 tokens of 1,414** and started from A's
whole 1,392-token prefix. The 217.517 MiB it saved on the hand-back was actually read back. It is a
fourth positive control alongside `qwen3`, `qwen3moe` and `mistral3` — and the reason the
conservative cache-ON default was worth having. → `granite` stays off the list, now for a measured
reason instead of an absent one.

That closes the last two families in the catalog with no verdict. Every `family:` a manifest
declares is now on one side of the architecture split.

#### The trap, reproduced a fourth time

`forcing full prompt re-processing due to lack of cache data` appears **0 times** in all four
stderr captures — including in the two `qwen3.6` runs that demonstrably re-prefilled 1,488 tokens.
What the server logged instead, on both affected models, was
`load: - found better prompt with f_keep = 0.989, sim = 0.985`: it FOUND A's cached prompt, reported
a 98.9 % keep fraction, and then prefilled the whole thing anyway. Granite logged the same
reassuring shape (`f_keep = 1.000, sim = 0.984`) and actually restored. **The log line does not
distinguish the two cases; only the token count does.**

#### Cost side-observation

Per eviction of a ~1,500-token conversation: `qwen3.6-27b-q4` and `-q5` both save 244.843 MiB for A
plus 154.566 MiB for B and read neither back — that is the waste `--cache-ram 0` now stops.
`granite-4.1-8b-q4` saves 217.517 MiB and 11.252 MiB, and uses them.

#### What this run could not measure

- Nothing here was run above `--ctx-size 8192`, and nothing with MTP — deliberate, so the argv
  stays identical to the fourteen rows this extends.
- The remaining broken symlinks on this rig are untouched: `gemma-4-26b-q4`, `gemma4-coding-q8`,
  `qwen3.5-0.8b-q6`, `qwen3.5-9b-q8`. All four are additional weights of families that already have
  a measured verdict (`gemma4`, `qwen3.5`), so they cannot change the rule, only add rows.
- **R1/R3 timings are not a speed result.** The card idles at a 405 MHz memory clock on this rig and
  does not always reach P0, so the tok/s implied here is not comparable to a clean benchmark run.
  No verdict in the table depends on a timing — every one is a token count.
