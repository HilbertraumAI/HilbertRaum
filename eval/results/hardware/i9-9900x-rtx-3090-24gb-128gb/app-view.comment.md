### App view: i9-9900x-rtx-3090-24gb-128gb · Performance screen Copy report versus the six starts

Pasted by the owner after the six starts, from the current source build (checkout = today's `origin/master`, the app's config directory as drive root, the pinned b9849 as `HILBERTRAUM_LLAMA_BIN`), Performance screen > Copy report. Stored as `app-report-dev-performance-screen.txt` and under `app_report` in every start's JSON.

```text
This computer
Speed: 48.3 tokens / s (Measured with Qwen3.8 27B UD-Q4_K_M on 9/6/2026, over 64 tokens)
Memory: 125.5 GB RAM
CPU: Intel(R) Core(TM) i9-9900X CPU @ 3.50GHz (20 cores)
Graphics memory: 24.2 GB VRAM (NVIDIA GeForce RTX 3090)
Drive: 2,044.3 MB/s read
Assigned profile: PRO
Recommended for the next start: Qwen3.8 27B UD-Q4_K_M (graphics memory)
Recommended at the time of the check: Qwen3.8 27B UD-Q5_K_M
Context size: 32,768 tokens
Last run: 9/6/2026, 6:45:55 PM
```

9. **App view (fills the pending item 9 of the six start comments above):** starred **`qwen3.8-27b-ud-q4km`** ("Recommended for the next start: Qwen3.8 27B UD-Q4_K_M (graphics memory)") · memory class **discrete**, basis graphics memory · budget device **NVIDIA GeForce RTX 3090, 24.2 GB VRAM** (probe total 24,822 MiB; the picker's budget is the probe's free figure, 23,546–23,603 MiB across the session) · profile PRO, 125.5 GB RAM · "Recommended at the time of the check: Qwen3.8 27B UD-Q5_K_M" is the RAM pick (rank 3, 32 GB tier) the 2026-09-06 hardware check recorded, i.e. exactly the demotion rule C predicts: RAM says Q5, the card says Q4. The Copy report carries no "Your model" line; the estimate that row shows is `placementVerdict` (`performance.ts:301-345`), computed from the same `estimateGraphicsNeedMib` as the star: Q4 need 20,246 MiB ≤ budget → **"fits the card"**; Q5 need 23,866 > budget → **"partial", estimated spill 263–320 MiB** from RAM.

**Predicted versus measured, side by side** (this card, 8k context, the app's own argv; figures from the six starts):

| model | app star / estimate | measured under rung 1a (the app's first attempt, MTP on, `-np` auto) | measured under rung 1 (MTP off) | measured `-np 1` (not what the app passes) |
|---|---|---|---|---|
| `qwen3.8-27b-ud-q4km` | ★ starred; estimate: fits the card | **66/66**, peak 19,420 MiB, decode 53.8 tok/s, prefill 970 | not started | not started |
| `qwen3.8-27b-ud-q5km` | not starred; estimate: partial, ~263 MiB spill | **62/66**, ~1,173 MiB actually on the host (1,029 MiB of layers + 32 KV + 112 RS, beyond the 682 MiB embedding table every start keeps host-mapped), peak 21,578 MiB, decode 30.4 tok/s | **66/66**, peak 20,768 MiB, decode 30.7 tok/s | **66/66**, peak 21,248 MiB, decode 51.0 tok/s |

- The star is right and the estimate's direction is right for what the app actually spawns first: Q5 under rung 1a is a partial start. The estimated spill (~263 MiB) undercounts the real host share by ~900 MiB, because the estimate does not know that MTP adds a 552 MiB draft context and triples the recurrent state (rs_seq 2: +1,197 MiB at 4 sequences); the 1.15 working share and the 1.1 GiB cache term cover the rest.
- The estimate is wrong in direction for rung 1: without MTP, Q5 fits the card with 3 GiB to spare. Since a refused or latched-off rung 1a (`factory.ts:569-597`, `factory.ts:123-137`) lands on rung 1, the app CAN end up running Q5 fully offloaded on this card while its screen calls it partial.
- The app's 48.3 tok/s hardware-check figure for Q4 (64 tokens, short prompt, 2026-09-06 start, MTP on) sits between this session's 53.8 (512 tokens after a 2,015-token prefill, MTP on) and the non-MTP 27B figures in §6.6; consistent.
- Ubatch 512 (65/66, 38.9 tok/s) and `--fit-target 512` (64/66, 34.7 tok/s) each buy layers but not the full offload; `-np 1` (66/66, 51.0 tok/s, MTP kept) is the only variant that makes Q5 run at card speed on a 24 GB card, at the cost of one slot.
