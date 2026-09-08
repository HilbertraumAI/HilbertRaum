### Start: i7-8700-gtx-1070-ti-8gb-32gb · leg 2 · np1-verify-heaps
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build, Clang 20.1.8; `--version` probed before planning anything: `version: 9849 (799fcc04a)`, the pinned build) · Windows 11 Pro 25H2 build 26200.9168 · Intel Core i7-8700, 6 cores / 12 logical, 31.9 GiB RAM · desktop, single discrete card (machine detected from the probe: GTX 1070 Ti → leg 2 of #391) · driver NVIDIA 582.66 (Vulkan device api 1.4.312, driverVersion 582.66.0.0; instance 1.4.341) — the same driver as the 2026-09-07 #318 session · heaps: unchanged from `00-preflight.md`: heap 0 device-local 7.87 GiB (budget 7.12 GiB = 7,291 MiB), heap 1 host 15.97 GiB, heap 2 device-local **214.00 MiB BAR heap** (budget 213.88 MiB); the probe’s 8,273 / 7,504 is heap 0 + heap 2
3. **Argv:** `llama-server --host 127.0.0.1 --port 56522 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1` (source: the harness builds the app’s POST-#386 rung-1 argv — `--host/--port/--model/--ctx-size/--threads` sidecar.ts:526-535 `buildArgs`; ctx 8192 = manifest `recommended_context_tokens` via `launchContextTokens` models.ts:176; threads 6 = ⌊12/2⌋ `defaultThreadCount` sidecar.ts:90; `--batch-size/--ubatch-size 2048` = min(ctx, `CHAT_MAX_PHYSICAL_BATCH`) llama.ts:86, emitted at sidecar.ts:519-521; `--jinja --reasoning-format deepseek -lv 4 -np 1` = `CHAT_SERVER_ARGS` llama.ts:76 — `-np 1` is part of the constant since #319 / PR #386, so the harness emits it and NO `--extra` was passed (that would duplicate it); rung 1 adds nothing (factory.ts, no `-ngl`, no `--device`, no `--fit-target`/`--fit-ctx`). The log confirms the flag arrived: `n_seq_max = 1`, `n_slots = 1`, `kv_unified = ’false’`. The manifest carries no `speculative_decoding`, so rung 1a does not apply)
4. **Memory at start:** device_info Vulkan0 7,504 / 8,273 MiB (idle probe — the same figure as on 2026-09-07 at 883 MiB of nvidia-smi use, and today at 1,223); while the model was loaded a second `--list-devices` read 6,893 free (2026-09-07: 6,831) — the budget figure moved 611 MiB while nvidia-smi showed +5,843 · nvidia-smi 1218/8192 MiB used/total (6842 free) · desktop: same desktop as `leg2-np1-verify` (HilbertRaum app closed; Chrome, Discord, Slack, VS Code open), nvidia-smi 1,218 MiB used before the spawn, PLUS `sample-heaps.ps1` (the #318 vulkaninfo heap sampler) polling every 2 s from 6 s before the spawn until after the stop — the condition the 2026-09-07 baseline was measured under
5. **Fit outcome:** offloaded **33/33** layers to GPU (Vulkan0) — **FULL**. Fit pass, one step and no filling: breakdown `8273 = 7350 + (5856 = 5133 + 306 + 416) + -4933`, host `641 = 545 + 0 + 96`, "projected to use 5856 MiB of device memory vs. 7350 MiB of free device memory", "**will leave 1494 >= 1024 MiB of free device memory, no changes needed**". Buffers: Vulkan0 model 5,133.63 MiB, **CPU_Mapped model 545.62 MiB** (= the manifest’s `host_mapped_weights_mib`, measured on the 3080 Ti at 33/33 — identical on this card, so the figure is now measured on two cards; at 31/33 this line read 824.31), Vulkan0 KV 256.00 MiB (8,192 cells, 8 layers, 1/1 seqs — unchanged, as #319 said it would be), **recurrent state Vulkan0 RS 50.25 MiB = `size = 50.25 MiB (1 cells, 32 layers, 1 seqs 0 rs_seq)`, R 2.25 + S 48.00** (was 201.00 = 184.25 Vulkan0 + 16.75 CPU at 4 seqs), Vulkan0 compute 416.16 MiB (447.38 at 31/33), Vulkan_Host compute 96.07 MiB (128.44), Vulkan_Host output 0.95 MiB (3.79 at 4 slots) · `n_seq_max = 1`, `kv_unified = false`, `n_slots = 1`, `n_ctx_slot = 8192`, flash_attn auto → enabled · **both fused Gated Delta Net paths enabled** (autoregressive AND chunked) — at 31/33 the chunked one was "not supported, set to disabled" and the "layer 0 is assigned to device CPU" warning fired; no W lines at all in this log · **rung 1**, the fit landed a full offload · **byte-identical to `leg2-np1-verify`**: the two redacted logs differ only in timestamps, the port, the CPU device line’s free-RAM figure (21,262 → 19,951 MiB, the page cache now holding the file), "fitting params to free memory took" (1.04 → 0.62 s), "reserve took" and the per-request timing lines. Load to /health 5.2 s (page-cached). **BAR heap (question e), from `leg2-np1-verify-heaps.heaps.csv`:** heap 2 budget 213.88 → 141.44 MiB at the first in-load sample → 90.88 → **64.38 MiB while loaded and through the request** (usage 156,893,184 B = 149.63 MiB), back to 213.88 after the stop; heap 0 budget 7,291 → 6,884–6,923 MiB while loaded (2026-09-07 at 31/33: 6,987–7,011 idle, 6,680–6,706 with desktop use), back to 7,291. So the 214 MiB BAR heap is still used under `-np 1` — ≈ 150 MiB of it, with 64 MiB left, where the four-slot start drove it to 2.25 MiB left during the request (its 184.25 MiB RS buffer landed there; today’s RS is 50.25, so what else sits in it is not identifiable from a 2 s sampler)
6. **Peak use:** 7100 MiB used (nvidia-smi, 1 s polling; +5882 MiB over the pre-spawn figure; 7069 MiB right after load, 1203 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 28.87 tok/s (`predicted_per_second`, 512 tokens in 17.7 s) · prefill 240.9 tok/s (`prompt_per_second`, 2015 tokens in 8.4 s) · load to /health 5.2 s
8. **Varied:** one thing: the #318 heap sampler running, exactly as the 2026-09-07 `leg2-baseline` had it. Purpose (a): rule out that the sampler’s own Vulkan instances had lowered the baseline’s free reading (6,898) — they had not: the fit read **7,350 with and without it**; purpose (b): question (e) under `-np 1`. Same argv, no `--extra`, nothing in the app changed
9. **App view:** n/a for this start — see `leg2-np1-verify` (computed from the app’s picker code on this probe line: ★ = `qwen3.5-9b-ud-q4kxl`, not read off the screen this session)
**Predicted vs measured:** **PASS — 33/33, the second time; and the sampler is exonerated.** Identical fit (`8273 = 7350 + (5856 = 5133 + 306 + 416) + -4933`, "will leave 1494 >= 1024"), identical buffers, decode 28.9 tok/s (29.0 on the first start), prefill 240.9. This settles the one alternative reading of the 2026-09-07 gap: the baseline’s 6,898 was NOT the sampler polling beside the fit, so the 452 MiB rise to 7,350 is the slot-count effect recorded on the first start (151 of it the recurrent-state drop, seen on every card; the further 301 only on this card, where the whole gap scales ≈ 3× RS). Question (e): **yes, the BAR heap is used under `-np 1`** — 149.6 MiB of its 214 while the model is resident, 64 MiB left, against 2.25 MiB left at four slots. nvidia-smi peaked at 7,100 MiB of 8,192 (+5,882 over the pre-spawn figure), i.e. 1,092 MiB of the card unallocated at peak by the driver’s count while the fit’s own accounting reserved 1,494
<details><summary>Load-log excerpt (redacted, 36 lines)</summary>

```text
# leg2-np1-verify-heaps — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 56522 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1
0.00.164.217 I cmn  common_param: device_info:
0.00.182.663 I cmn  common_init_: fitting params to device memory ...
0.00.182.663 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.182.667 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.824.159 I common_params_fit_impl: projected to use 5856 MiB of device memory vs. 7350 MiB of free device memory
0.00.824.167 I common_params_fit_impl: will leave 1494 >= 1024 MiB of free device memory, no changes needed
0.00.824.173 I common_fit_params: successfully fit params to free device memory
0.00.824.181 I common_fit_params: fitting params to free memory took 0.62 seconds
0.01.041.993 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce GTX 1070 Ti) (0000:01:00.0) - 7501 MiB free
0.01.332.259 I print_info: n_ctx_train           = 262144
0.01.332.274 I print_info: n_swa                 = 0
0.01.332.274 I print_info: is_swa_any            = 0
0.01.332.293 I print_info: n_ctx_orig_yarn       = 262144
0.01.332.308 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.01.828.224 I load_tensors: offloading output layer to GPU
0.01.828.231 I load_tensors: offloading 31 repeating layers to GPU
0.01.828.231 I load_tensors: offloaded 33/33 layers to GPU
0.01.828.235 I load_tensors:   CPU_Mapped model buffer size =   545.62 MiB
0.01.828.236 I load_tensors:      Vulkan0 model buffer size =  5133.63 MiB
0.04.663.924 I llama_context: n_ctx         = 8192
0.04.663.924 I llama_context: n_ctx_seq     = 8192
0.04.663.926 I llama_context: kv_unified    = false
0.04.663.932 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.04.664.208 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.04.665.559 I llama_kv_cache:    Vulkan0 KV buffer size =   256.00 MiB
0.04.700.139 I llama_memory_recurrent:    Vulkan0 RS buffer size =    50.25 MiB
0.04.700.152 I llama_memory_recurrent: size =   50.25 MiB (     1 cells,  32 layers,  1 seqs  0 rs_seq), R (f32):    2.25 MiB, S (f32):   48.00 MiB
0.04.726.192 I sched_reserve:    Vulkan0 compute buffer size =   416.16 MiB
0.04.726.200 I sched_reserve: Vulkan_Host compute buffer size =    96.07 MiB
0.04.849.539 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 8192, kv_unified = 'false'
0.04.849.554 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.04.849.680 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.04.902.345 I srv  update_slots: all slots are idle
0.07.023.310 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.33.120.650 I srv  update_slots: all slots are idle
```
</details>
