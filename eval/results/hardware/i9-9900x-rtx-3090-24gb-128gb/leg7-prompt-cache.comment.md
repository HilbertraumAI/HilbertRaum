### Leg 7, #319's optional third data point: the one-slot prompt cache, on `i9-9900x-rtx-3090-24gb-128gb`

Beyond #391's acceptance list. #319's leg-7 recipe named this as "a useful third data point if the machine is free", with the counter-evidence spelled out: "`slot … | task … | re-using cached prompt` in the log is the evidence; a full re-prefill of the conversation would be the counter-evidence." The machine was free. It is the counter-evidence.

Both probes run on the app's own rung-1a launch of `qwen3.8-27b-ud-q5km`, `-np 1`, pinned b9849, `n_slots = 1`. Evidence: `leg7-app-q5km-prefix-reuse.*` and `leg7-app-q5km-evicted-prefix.*` (`.cache-lines.txt` is the filtered log, `.stderr.log` the whole redacted capture).

**1. Consecutive turns in one conversation: the prefix IS reused.** Three turns, nothing else touching the slot, `prompt eval time = … / N tokens` per task:

| task | what | prefilled |
|---|---|---|
| 0 | warm-up | 13 |
| 6 | turn 1 | 171 |
| 18 | turn 2 | **22** (`cached n_tokens = 190`) |
| 28 | turn 3 | **22** |

Nothing wrong here, and this is the common case.

**2. After something else takes the slot: the conversation is re-prefilled, not restored.** Conversation A, then one turn in a new conversation B, then back to A:

```
task  6 | prompt eval time = 1582.49 ms /  415 tokens      <- A turn 1
        srv prompt_save: - saving prompt with length 435, total state size = 178.530 MiB
        srv load: - looking for better prompt, base f_keep = 0.345, sim = 0.888
task 17 | prompt eval time =  580.81 ms /   22 tokens      <- B takes the slot
task 27 | cached n_tokens = 147, memory_seq_rm [147, end)  <- back in A
task 27 | prompt eval time = 1391.18 ms /  305 tokens      <- 305 of 452 re-processed
```

A's 452-token turn-2 prompt came back 305 tokens short of cached. The 147 that survived are the system prefix, common to every conversation, which simply never left the slot; none of A's own body was restored. The server says why, on every start of this model:

```
slot operator(): id 0 | task 6 | forcing full prompt re-processing due to lack of cache data
  (likely due to SWA or hybrid/recurrent memory, see llama.cpp PR #13194)
```

Both 27B quants are hybrid/recurrent, so the host-RAM cache fills as designed (`cache state: 2 prompts, 629.350 MiB`) and is never usable for them.

**What this changes.** `model-benchmarks.md` §6.6's #319 amendment recorded the accepted cost as "a restore, not a full re-prefill". That half is false for these models, and the cost scales with conversation length instead of being constant: 1.4 s at the measured 452 tokens, but a 20k-token conversation re-prefills 20k tokens on every hand-back. The `-np 1` decision itself is untouched and its benefit is confirmed by this same leg. Record corrected in §6.6; follow-up opened as #399.
