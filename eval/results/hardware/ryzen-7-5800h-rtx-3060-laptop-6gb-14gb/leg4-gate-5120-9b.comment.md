### Start: ryzen-7-5800h-rtx-3060-laptop-6gb-14gb · leg 4 · gate-5120-9b
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build, Clang 20.1.8) · Windows 11 Home 22H2 build 22621.4387 · AMD Ryzen 7 5800H, 8 cores / 16 logical, 13.86 GiB RAM · laptop (chassis type 10) · **AC connected, Legion Performance Mode verified immediately before the spawn and again after** — see `varied`: the power/thermal state moves the decode figure on this machine by more than anything under test does · driver NVIDIA 591.74 (Vulkan device api 1.4.325, driverVersion 591.74.0.0); the AMD iGPU runs 2.0.233 (api 1.3.217); Vulkan instance 1.4.321 · heaps: RTX 3060 Laptop: ONE device-local heap of 5,994 MiB (budget 5,226 MiB) plus a 7,094 MiB host heap — **no separate BAR heap**, so protocol question (e) has no subject here. Radeon iGPU: device-local 1,792 MiB + 256 MiB (APU carve-out) plus a 6,838 MiB host heap
3. **Argv:** `llama-server --host 127.0.0.1 --port 57016 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 8 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1` (source: identical in shape to the leg-4 baseline start and cited there in full (sidecar.ts:511 `buildArgs`, ctx 8192 = this model's `recommended_context_tokens` via models.ts:176-183, threads 8 = ⌊16/2⌋, batch/ubatch 2048 from llama.ts:460, CHAT_SERVER_ARGS llama.ts:39, rung 1 adds nothing — factory.ts:764). The one change from the 2026-09-07 capture is that `-np 1` is now part of CHAT_SERVER_ARGS itself (#319 / PR #386) and the harness emits it; it is NOT passed via `--extra`, which would duplicate it. The log confirms `n_slots = 1`, `n_ctx_slot = 8192`. No `speculative_decoding` on this manifest, so rung 1a does not apply)
4. **Memory at start:** device_info Vulkan0 (iGPU) 8,441 / 8,886 MiB · **Vulkan1 (card) 5,226 / 5,994 MiB** · CPU 2,587 / 14,188 MiB. The fit's own reading was **5,173 MiB**, 53 MiB below the probe — on 2026-09-07 the same start read **5,022 MiB**, 204 MiB below. That the fit's reading of an idle card moves by ~150 MiB between sessions is worth carrying to leg 2, where the outcome turns on a 133 MiB shortfall. A `--list-devices` taken while the model was loaded still returned `5226 MiB free` for Vulkan1 — unchanged — while nvidia-smi showed 4,329 MiB used at peak · nvidia-smi 177/6144 MiB used/total (5818 free) · desktop: idle — the HilbertRaum app was fully closed for this start, no browser; nvidia-smi 177 MiB used before the spawn
5. **Fit outcome:** offloaded **20/33** layers to GPU — still **PARTIAL**, which is what the check is about, but **two layers more than the 18/33 of 2026-09-07**. Fit pass: `projected to use 5856 MiB of device memory vs. 5173 MiB of free device memory`, `cannot meet free memory target of 1024 MiB, need to reduce device memory by 1706 MiB`, then `start filling device 0, delta=33` → `Vulkan1: 20 layers, 4080 MiB used, 1092 MiB free`. Buffers — card: model 3,393.11 MiB, KV 160.00 MiB, RS 29.31 MiB, compute 498.00 MiB; host: CPU_Mapped model 2,286.14 MiB, CPU KV 96.00 MiB, CPU RS 20.94 MiB, Vulkan_Host compute 128.16 MiB. KV total `256.00 MiB (8192 cells, 8 layers, 1/1 seqs)` — **unchanged from the four-slot launch, exactly as the #386 manifest note predicts**: the KV is sized in cells from `--ctx-size` and does not scale with the slot count. RS total `50.25 MiB (1 cells, 32 layers, 1 seqs)` — **down from 201.00 MiB**, a saving of **150.75 MiB**, which is precisely the figure #391 says leg 2 on the GTX 1070 Ti is riding on; it is now confirmed on hardware for this model. **Vulkan0 (the iGPU) again received nothing.** Two further differences from the September capture: `fused Gated Delta Net (chunked)` is now **`enabled`** (it was `set to disabled` then, alongside the `layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan1` warning — neither line appears now), and `graph splits` fell from 245/32 to **211/22**. **Rung 1** — as before, the ladder sees a healthy start and never learns the offload was partial. The 2,286.14 MiB `CPU_Mapped` figure is **not** usable as `host_mapped_weights_mib`: this is a partial offload and the line is inflated by the 13 layers that did not fit (this model's true full-offload figure, 545.62 MiB, comes from the 3080 Ti's leg-5 start)
6. **Peak use:** 4329 MiB used (nvidia-smi, 1 s polling; +4152 MiB over the pre-spawn figure; 4267 MiB right after load, 177 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 4.15 tok/s (`predicted_per_second`, 512 tokens in 123.4 s) · prefill 538.4 tok/s (`prompt_per_second`, 2015 tokens in 3.7 s) · load to /health 37.5 s
8. **Varied:** none against the app's own launch — but **three companion captures were needed to interpret the decode figure, and all are committed.** (1) `leg4-gate-5120-9b-mixedpower`: the first `-np 1` start, taken just after the machine was switched from battery to AC while the Lenovo thermal mode was still in flux — **2.85 tok/s**, with identical placement (20/33) and identical buffers. (2) `leg4-gate-5120-9b-np4-control`: `--extra "-np 4"`, a deliberate control reproducing the pre-#386 four-slot structure. It lands **18/33**, RS back to 201.00 MiB, chunked Gated Delta Net back to `disabled`, graph splits back to 245/32 — the September start's structure, reproduced — and decodes at **2.51 tok/s** today. Two caveats on it: an explicit `-np 4` yields `kv_unified false` and 2,048 cells per slot where September's auto-4 launch had unified KV at 8,192 cells, and its decode stopped after **33** tokens when the 2,048-token slot filled behind a 2,015-token prompt, so it is a short and noisy sample. (3) This start, with Legion Performance Mode verified before and after: **4.15 tok/s**. The spread between (1) and (3) — same argv, same placement, same buffers, 2.85 vs 4.15 tok/s — is the machine's power/thermal state alone
9. **App view:** unchanged, and reported in full under part (a) of the follow-up: the app stars **`gemma4-e2b-it-qat-q4`**, never this model, and still marks the 9B too large for the card. The 9B is permitted by RAM (`recommended_min_ram_gb` 12 ≤ 14) but is not the RAM pick at 14 GB, and its graphics estimate (**7,285 MiB**) is far above the card's **5,226 MiB** budget, so the app would not start it here by itself; it was started manually for this check. No 'Dein Modell' row: the app never ran it
**Predicted vs measured:** **The check passes on what it actually tests — placement — and the one thing that moved, moved for a reason that is #386's, not #387's.** (1) *Nothing got worse.* The model list still calls the 9B too large for the card, the app still refuses to star it (7,285 MiB estimate against a 5,226 MiB budget), and a manual start still lands **partial**. The lowered gate (6,144 → 5,120) changed placement in no way whatsoever, exactly as predicted — it only made this card the budget device, and llama.cpp's `--fit` was already using the card regardless of what the picker thought of it. (2) *It got slightly better, and not because of the gate.* 18/33 → **20/33**. The cause is visible in the log and is entirely #386's: one server slot returns **150.75 MiB** of recurrent state (201.00 → 50.25 MiB), which buys two more layers, while the KV term stays at 256.00 MiB because it is sized in cells. The `-np 4` control confirms the attribution by reverting to 18/33 the moment four slots come back. So the accurate phrasing is not 'partial exactly as before' but **'still partial, two layers better, and the two layers are #386's'**. (3) *The decode figure does not support a cross-session comparison and must not be read as a regression.* September recorded 5.23 tok/s at 18/33; this session reads **4.15 tok/s** at 20/33 under verified Performance Mode, 2.85 under an unsettled thermal state, and **2.51 for a control that reproduces the September structure exactly**. When a faithful reproduction of the old configuration reads half the old number on the same binary and the same machine, the variable is the machine, not the change under test — decode on a partial offload here is CPU-bound, and September's thermal mode was not recorded. Prefill, by contrast, improved unambiguously and for a structural reason: **42.0 → 538.4 tok/s**, because the chunked Gated Delta Net path is no longer disabled by the layer-0 device mismatch. Question (e) remains unanswerable on this card: no BAR heap
<details><summary>Load-log excerpt (redacted, 56 lines)</summary>

```text
# leg4-gate-5120-9b — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 57016 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 8 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1
0.00.493.571 I cmn  common_param: device_info:
0.00.529.098 I cmn  common_init_: fitting params to device memory ...
0.00.529.099 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.529.314 I common_params_fit_impl: getting device memory data for initial parameters:
0.02.545.826 I common_params_fit_impl: projected to use 5856 MiB of device memory vs. 5173 MiB of free device memory
0.02.545.851 I common_params_fit_impl: cannot meet free memory target of 1024 MiB, need to reduce device memory by 1706 MiB
0.02.545.853 I common_params_fit_impl: context size set by user to 8192 -> no change
0.02.545.858 I common_params_fit_impl: id=0, target=4149 MiB
0.04.314.550 I common_params_fit_impl: memory for test allocation by device:
0.04.314.567 I common_params_fit_impl: id=0, n_layer= 0, n_part= 0, overflow_type=4, mem=   498 MiB
0.04.314.580 I common_params_fit_impl: filling dense layers back-to-front:
0.05.920.450 I common_params_fit_impl: memory for test allocation by device:
0.05.920.458 I common_params_fit_impl: id=0, n_layer=33, n_part= 0, overflow_type=4, mem=  5856 MiB
0.05.920.462 I common_params_fit_impl: start filling device 0, delta=33
0.07.587.913 I common_params_fit_impl: memory for test allocation by device:
0.07.587.927 I common_params_fit_impl: id=0, n_layer=22, n_part= 0, overflow_type=4, mem=  4375 MiB
0.07.588.077 I common_params_fit_impl: set ngl_per_device_high[0].n_layer=22
0.09.244.538 I common_params_fit_impl: memory for test allocation by device:
0.09.244.562 I common_params_fit_impl: id=0, n_layer=20, n_part= 0, overflow_type=4, mem=  4080 MiB
0.09.244.569 I common_params_fit_impl: set ngl_per_device[0].n_layer=20
0.10.828.403 I common_params_fit_impl: memory for test allocation by device:
0.10.828.421 I common_params_fit_impl: id=0, n_layer=21, n_part= 0, overflow_type=4, mem=  4217 MiB
0.10.828.426 I common_params_fit_impl: set ngl_per_device_high[0].n_layer=21
0.10.828.429 I common_params_fit_impl:   - Vulkan1 (NVIDIA GeForce RTX 3060 Laptop GPU): 20 layers,   4080 MiB used,   1092 MiB free
0.10.828.780 I common_fit_params: successfully fit params to free device memory
0.10.828.798 I common_fit_params: fitting params to free memory took 1.55 seconds
0.11.243.472 I llama_prepare_model_devices: using device Vulkan1 (NVIDIA GeForce RTX 3060 Laptop GPU) (0000:01:00.0) - 5223 MiB free
0.11.945.702 I print_info: n_ctx_train           = 262144
0.11.945.735 I print_info: n_swa                 = 0
0.11.945.736 I print_info: is_swa_any            = 0
0.11.945.774 I print_info: n_ctx_orig_yarn       = 262144
0.11.945.810 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.15.878.532 I load_tensors: offloading output layer to GPU
0.15.878.558 I load_tensors: offloading 19 repeating layers to GPU
0.15.878.559 I load_tensors: offloaded 20/33 layers to GPU
0.15.878.568 I load_tensors:   CPU_Mapped model buffer size =  2286.14 MiB
0.15.878.572 I load_tensors:      Vulkan1 model buffer size =  3393.11 MiB
0.27.248.242 I llama_context: n_ctx         = 8192
0.27.248.243 I llama_context: n_ctx_seq     = 8192
0.27.248.247 I llama_context: kv_unified    = false
0.27.248.311 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.27.252.249 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.27.253.065 I llama_kv_cache:        CPU KV buffer size =    96.00 MiB
0.27.302.186 I llama_kv_cache:    Vulkan1 KV buffer size =   160.00 MiB
0.27.795.572 I llama_memory_recurrent:        CPU RS buffer size =    20.94 MiB
0.27.840.222 I llama_memory_recurrent:    Vulkan1 RS buffer size =    29.31 MiB
0.27.840.260 I llama_memory_recurrent: size =   50.25 MiB (     1 cells,  32 layers,  1 seqs  0 rs_seq), R (f32):    2.25 MiB, S (f32):   48.00 MiB
0.29.349.248 I sched_reserve:    Vulkan1 compute buffer size =   498.00 MiB
0.29.349.260 I sched_reserve: Vulkan_Host compute buffer size =   128.16 MiB
0.37.248.893 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 8192, kv_unified = 'false'
0.37.249.591 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.37.251.927 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.37.363.376 I srv  update_slots: all slots are idle
0.40.077.489 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
2.47.270.578 I srv  update_slots: all slots are idle
```
</details>
