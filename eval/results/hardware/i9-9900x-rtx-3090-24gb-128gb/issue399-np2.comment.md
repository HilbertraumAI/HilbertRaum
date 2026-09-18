### Leg C — the `-np 2` fit check (issue #399, pre-decides D3(b))

Two starts of `qwen3.8-27b-ud-q5km` in one session, minutes apart, the app's **rung-1a argv
including the MTP flags**, `--ctx-size 8192`, everything else identical; only `-np` varies. Same
driver and the same three requests as leg A, plus a 192-token generation for a decode figure and a
1 Hz `nvidia-smi` sample for the whole run.

```
llama-server --host 127.0.0.1 --port <n> --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf
  --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja
  --reasoning-format deepseek -lv 4 -np {1|2} --spec-type draft-mtp --spec-draft-n-max 2
```

#### What it costs

| | `-np 1` (what the app ships) | `-np 2` | delta |
|---|---|---|---|
| layers offloaded | **66/66** | **66/66** | — |
| fit projection | 19,692 MiB vs 23,250 free, leaves 3,558 | 20,125 MiB vs 22,801 free, leaves 2,676 | +433 MiB projected |
| recurrent state | 448.88 MiB (1 cells, 64 layers, 1 seqs 2 rs_seq) | **897.75 MiB** (2 cells, 64 layers, 2 seqs 2 rs_seq) | **+448.87 MiB** |
| KV cache | 512.00 MiB (+32.00 MTP draft) | 512.00 MiB (+32.00 MTP draft) | — |
| MTP context estimate | 552.06 MiB | 576.06 MiB | +24 MiB |
| **`n_ctx_slot`** | **8192** | **4096** | **halved** |
| peak VRAM (1 Hz `nvidia-smi`) | 21,079 MiB | 21,536 MiB | +457 MiB |
| decode | 31.0 tok/s | 30.1 tok/s | −0.9 |
| prefill (R1, 1,546 tokens) | 548 tok/s | 527 tok/s | −21 |

**The full offload survives.** `-np 2` still lands 66/66 with 2,676 MiB of headroom, so the
`MTP_VRAM_HEADROOM_MB` worry in D3(b) does not materialise on this card — the recurrent-state cost
is what #318 leg 1 predicted, +448.87 MiB, and the fit absorbs it.

**But `--ctx-size` is the total cache, split across slots.** `n_ctx_slot` goes 8,192 → **4,096**:
every conversation's usable window is halved. Restoring it means `--ctx-size 16384`, which pays the
KV and recurrent-state increase again. That cost is not in the issue's D3(b) sketch.

#### What it does NOT buy

**`-np 2` does not give the conversation a private slot, and it does not fix the re-prefill.**
R3 is identical to `-np 1`, token for token:

| | R1 prefilled | R2 prefilled | R3 prefilled | kept | verdict |
|---|---|---|---|---|---|
| `-np 1` + MTP | 1546 of 1546 | 23 of 102 | **1492 of 1571** | 79 | RE-PREFILLED |
| `-np 2` + MTP | 1546 of 1546 | 23 of 102 | **1492 of 1571** | 79 | RE-PREFILLED |

The slot trace says why, and it is two separate failures:

```
id 1 | selected slot by LRU, t_last = -1                         <- A takes slot 1
id 1 | task 0  | new prompt, n_ctx_slot = 4096, n_tokens = 1546
srv prompt_save: - saving prompt with length 1561, 253.346 MiB   <- A is evicted to host RAM
id 1 | selected slot by LCP similarity, sim_best = 0.804 (> 0.100 thold)
id 1 | task 10 | new prompt, n_ctx_slot = 4096, n_tokens = 102   <- B takes A's slot, NOT the free one
id 0 | selected slot by LRU, t_last = -1                         <- A comes back to the untouched slot 0
srv load:  - found better prompt with f_keep = 0.990, sim = 0.983
id 0 | task 18 | cached n_tokens = 79 ... prompt eval = 1492 tokens
```

1. **The slot picker preferred prefix similarity over the idle empty slot.** Conversation B scored
   `sim_best = 0.804` against A's slot — because the app shares one `BASE_SYSTEM_PROMPT` across
   conversations, the thing that made 79 tokens survive in the first place — comfortably over the
   0.100 threshold, so it evicted A instead of taking slot 0, which had never been used. A second
   slot exists but the arbitration never routes a second conversation into it.
2. **And when A did land in the untouched slot 0, the restore still failed.** The server found its
   cached prompt (`f_keep = 0.990, sim = 0.983`), consumed the cache entry (`cache state: 0 prompts,
   0.000 MiB`), and then prefilled 1,492 of 1,571 tokens anyway — the leg-A behaviour, unchanged by
   the slot count.

So D3(b) as written buys nothing here: it costs 449 MiB of recurrent state and half the context
window per conversation, and both mechanisms that produce the re-prefill survive it. Raising `-np`
further would only make (1) more likely to matter and (2) no less true.

#### Clock state — read this before using any speed above

The card was **not at P0**. Over the two runs `nvidia-smi` sampled `pstate` P3 in 28 of 34 and 29 of
34 samples, at a **5,001 MHz** memory clock against `clocks.max.memory` 9,751; a single sample
reached 9,501. This is the same clock state recorded on this rig on 2026-09-08. **The 31.0 / 30.1
tok/s figures are therefore depressed and must not be compared with the 51.0 tok/s recorded for
`-np 1` on 2026-09-07.** They are comparable *with each other* — same session, same clock state,
minutes apart — which is all the `-np 1` versus `-np 2` question needs. Nothing in the table above
except the two decode/prefill rows depends on clocks.

#### What this leg could not measure

- **`-np 2` with the two conversations forced into different slots.** The picker chose; the driver
  has no way to pin a request to a slot, and llama-server exposes none over the OpenAI-compatible
  route. So "would a genuinely private slot restore the prefix?" is answered only indirectly, by A's
  return into the never-used slot 0 — which still re-prefilled.
- **`--ctx-size 16384 -np 2`**, i.e. buying back the halved window. Not run; it would change two
  things at once, and the fit headroom for it is not established.
- **Any other model.** Leg C is the 27B Q5 only.
- **A P0 decode figure**, for the clock reason above.
