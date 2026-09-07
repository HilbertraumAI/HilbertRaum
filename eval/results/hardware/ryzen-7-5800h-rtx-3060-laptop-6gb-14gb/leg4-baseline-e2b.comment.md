### Start: ryzen-7-5800h-rtx-3060-laptop-6gb-14gb · leg 4 · baseline-e2b
1. **File:** `gemma4-e2b-it-qat-q4` · `gemma4-e2b-it-qat-q4.gguf` · 3,349,516,256 B (3.12 GiB) · sha256 `fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build, Clang 20.1.8) · Windows 11 Home 22H2 build 22621.4387 · AMD Ryzen 7 5800H, 8 cores / 16 logical, 13.86 GiB RAM · laptop (chassis type 10) · driver NVIDIA 591.74 (Vulkan device api 1.4.325, driverVersion 591.74.0.0); the AMD iGPU runs 2.0.233 (api 1.3.217); Vulkan instance 1.4.321 · heaps: RTX 3060 Laptop exposes exactly ONE device-local heap — 5,994 MiB, budget 5,226 MiB — plus a 7,094 MiB host heap. **There is no separate small BAR heap**, so protocol question (e) has no subject on this card (the RTX 3090 exposes a 246 MiB one, the GTX 1070 Ti a 214 MiB one). The Radeon iGPU has device-local heaps of 1,792 MiB and 256 MiB (an APU carve-out, a different thing) plus a 6,838 MiB host heap. Worth recording: the probe's 5,994 / 5,226 for the card is EXACTLY heap 0's size / budget, whereas on the two cards with a BAR heap the probe figure was the SUM of the device-local heaps
3. **Argv:** `llama-server --host 127.0.0.1 --port 54544 --model <drive>\models\chat\gemma4-e2b-it-qat-q4.gguf --ctx-size 8192 --threads 8 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: `--host/--port/--model/--ctx-size/--threads` sidecar.ts:511 `buildArgs`, emitted at :526/:528/:530/:532/:534; ctx 8192 = manifest `recommended_context_tokens` via `launchContextTokens` models.ts:176-183; threads **8** = ⌊16/2⌋ sidecar.ts:90-98; `--batch-size/--ubatch-size 2048` = min(ctx, CHAT_MAX_PHYSICAL_BATCH=2048) llama.ts:460 (constant llama.ts:49), emitted at sidecar.ts:513-523; `--jinja --reasoning-format deepseek -lv 4` = CHAT_SERVER_ARGS llama.ts:39 appended at llama.ts:461; rung 1 adds nothing, factory.ts:764 — no `-ngl`, no `--device`, no `--fit-target`/`--fit-ctx`/`-np` (binary defaults: fit on, 1024 MiB target, `-np` auto → 4). Rung 1a never applies on this machine: none of the three models carries `speculative_decoding: mtp`)
4. **Memory at start:** device_info Vulkan0 (iGPU) 8,441 / 8,886 MiB · **Vulkan1 (card) 5,226 / 5,994 MiB**, and the fit's own reading was 5,223 MiB — within 3 MiB of the probe, unlike the GTX 1070 Ti where the fit read 606 MiB below it. A second `--list-devices` taken WHILE the model was loaded still returned `5226 MiB free` for Vulkan1 — **unchanged**, while nvidia-smi showed 2,259 MiB used on the card · nvidia-smi 256/6144 MiB used/total (5739 free) · desktop: idle — the HilbertRaum app was fully closed for this start (no Electron, no app-owned llama-server), no browser; nvidia-smi 256 MiB used before the spawn
5. **Fit outcome:** offloaded **36/36** layers to GPU — **FULL** offload onto a card the picker classes away. Fit pass: `projected to use 1997 MiB of device memory vs. 5223 MiB of free device memory`, `will leave 3225 >= 1024 MiB of free device memory, no changes needed` — one pass, no layer shedding. **Every GPU buffer is on Vulkan1**: model 1,341.76 MiB, KV 48.00 + 48.00 MiB, compute 560.07 MiB; host side CPU_Mapped model 2,152.50 MiB, Vulkan_Host compute 142.09 MiB, Vulkan_Host output 4.00 MiB. **Vulkan0 (the iGPU) received nothing at all** although it is enumerated FIRST and the app passes no `--device`. n_parallel auto → 4, kv_unified true, n_slots 4, n_ctx_slot 8192, flash_attn auto. **Rung 1.** Note that '36/36 layers' does not mean all weights are on the card: 2,152.50 MiB stayed CPU_Mapped (Gemma's embedding/output weights), so the card holds 1,341.76 MiB of weights + 96 MiB KV + 560.07 MiB compute ≈ 1,998 MiB — matching llama.cpp's own 1,997 MiB projection and the +2,079 MiB nvidia-smi delta at peak. This start reproduces, buffer for buffer, the placement the app itself persisted at 11:11 UTC before the session (`gpuModelMb 1341.76`, `cpuModelMb 2152.5`, `gpuKvMb 96`, `gpuComputeMb 560.07`)
6. **Peak use:** 2335 MiB used (nvidia-smi, 1 s polling; +2079 MiB over the pre-spawn figure; 2259 MiB right after load, 250 MiB after stop) during 2042-token prefill / 512-token decode
7. **Speed:** decode 86.39 tok/s (`predicted_per_second`, 512 tokens in 5.9 s) · prefill 2133.7 tok/s (`prompt_per_second`, 2042 tokens in 1.0 s) · load to /health 10.8 s
8. **Varied:** none (baseline). **Attempt 1** (kept as `leg4-baseline-e2b-attempt1`) used the runner's stock request body and decoded exactly ONE token — Gemma 4 E2B ends its turn immediately on the neutral continuation prompt, giving `predicted_n: 1` and a meaningless `predicted_per_second: 1000000`. Attempt 2 therefore sends `ignore_eos: true` (recorded as `ignore_eos` in the JSON and added to this machine's copy of the runner) to force the full 512 tokens. Placement, buffers and memory are identical between the two attempts; only the decode figure differs. Separately worth recording: attempt 1's prefill took **43.7 s** for the same 2,042 tokens attempt 2 did in **0.96 s**, with identical placement — a one-off Vulkan pipeline/shader compilation cost on the first start of this model on this card, which any first-run measurement on a cold shader cache will pay
9. **App view:** starred **`gemma4-e2b-it-qat-q4`** — 'Empfohlen für den nächsten Start: Gemma 4 E2B Instruct QAT Q4 (**Arbeitsspeicher**)', i.e. the RAM basis, confirming `memoryClass: cpu` and no budget device. Profile **LITE**, 13,9 GB RAM, context 8.192, drive 227,7 MB/s. Graphics memory tile: **'5,9 GB VRAM (NVIDIA GeForce RTX 3060 Laptop GPU)'** — the app names the card and its memory while still recommending on the RAM basis. That is the PR #375 behaviour: the app under test is the source build 0.1.59 running from the repo checkout on branch `fix/graphics-tile-names-small-card`, so this report doubles as the in-situ check of that fix on the exact hardware that motivated it; before it the tile read 'Keine nutzbare Grafikkarte' on this machine. The app's own benchmark measured **100 tok/s** over 64 tokens on this model (vs the 86.4 tok/s measured here over 512 tokens after a 2,042-token prefill — a shorter, cache-warm sample reads higher). No 'Dein Modell' placement row: no model was running when the report was taken
**Predicted vs measured:** **Holds on the verdict, but the estimate is 2.4× too large.** §6.6's 6 GB row (N8) predicts this machine is a RAM machine — the card reports 5,994 MiB, 150 MiB below the 6,144 MiB gate, so `nextStartMemory` → `cpu`, no budget device, RAM pick — and the app indeed stars the E2B on the Arbeitsspeicher basis. What the start adds is that the RAM pick **fully offloads onto that same card anyway**: `--fit` put 36/36 layers on Vulkan1 and decoded at 86.4 tok/s. So on this class of machine the gate costs nothing in placement (llama.cpp uses the card regardless) — it only changes which model the picker recommends and what the tile/basis say. The size of the gap matters for #321: the picker's `estimateGraphicsNeedMib` puts the E2B at **4,746 MiB** while llama.cpp projected **1,997 MiB** and actually used ≈1,998 MiB — the estimate is **2.4×** the truth here, because it applies the 15 % working share to the FULL weight file (3,147 MiB) while only 1,342 MiB of weights land on the card, and adds a 1,024 MiB margin the fit had 3,225 MiB of room for. Question (e) is not answerable on this card: it has no BAR heap
<details><summary>Load-log excerpt (redacted, 50 lines)</summary>

```text
# leg4-baseline-e2b — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 54544 --model <drive>\models\chat\gemma4-e2b-it-qat-q4.gguf --ctx-size 8192 --threads 8 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.375.155 I cmn  common_param: device_info:
0.00.383.137 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.394.751 I cmn  common_init_: fitting params to device memory ...
0.00.394.752 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.394.761 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.845.958 I common_params_fit_impl: projected to use 1997 MiB of device memory vs. 5223 MiB of free device memory
0.01.845.967 I common_params_fit_impl: will leave 3225 >= 1024 MiB of free device memory, no changes needed
0.01.845.975 I common_fit_params: successfully fit params to free device memory
0.01.845.986 I common_fit_params: fitting params to free memory took 1.43 seconds
0.02.024.362 I llama_model_loader: - kv  21:                  gemma4.rope.freq_base_swa f32              = 10000.000000
0.02.024.389 I llama_model_loader: - kv  30:            gemma4.attention.key_length_swa u32              = 256
0.02.024.390 I llama_model_loader: - kv  31:          gemma4.attention.value_length_swa u32              = 256
0.02.024.393 I llama_model_loader: - kv  33:            gemma4.rope.dimension_count_swa u32              = 256
0.02.585.891 I llama_prepare_model_devices: using device Vulkan1 (NVIDIA GeForce RTX 3060 Laptop GPU) (0000:01:00.0) - 5223 MiB free
0.03.203.415 I print_info: n_ctx_train           = 131072
0.03.203.446 I print_info: n_swa                 = 512
0.03.203.447 I print_info: is_swa_any            = 1
0.03.203.566 I print_info: freq_base_swa         = 10000.0
0.03.203.567 I print_info: freq_scale_swa        = 1
0.03.203.568 I print_info: n_embd_head_k_swa     = 256
0.03.203.569 I print_info: n_embd_head_v_swa     = 256
0.03.203.570 I print_info: n_rot_swa             = 256
0.03.203.571 I print_info: n_ctx_orig_yarn       = 131072
0.03.203.593 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.03.585.025 I load_tensors: offloading output layer to GPU
0.03.585.034 I load_tensors: offloading 34 repeating layers to GPU
0.03.585.034 I load_tensors: offloaded 36/36 layers to GPU
0.03.585.041 I load_tensors:   CPU_Mapped model buffer size =  2152.50 MiB
0.03.585.043 I load_tensors:      Vulkan1 model buffer size =  1341.76 MiB
0.08.770.185 I llama_context: n_ctx         = 8192
0.08.770.186 I llama_context: n_ctx_seq     = 8192
0.08.770.191 I llama_context: kv_unified    = true
0.08.770.210 I llama_context: n_ctx_seq (8192) < n_ctx_train (131072) -- the full capacity of the model will not be utilized
0.08.773.930 I llama_context: Vulkan_Host  output buffer size =     4.00 MiB
0.08.773.947 I llama_kv_cache_iswa: creating non-SWA KV cache, size = 8192 cells
0.08.775.296 I llama_kv_cache:    Vulkan1 KV buffer size =    48.00 MiB
0.08.817.753 I llama_kv_cache_iswa: creating     SWA KV cache, size = 4096 cells
0.08.819.204 I llama_kv_cache:    Vulkan1 KV buffer size =    48.00 MiB
0.10.447.660 I sched_reserve:    Vulkan1 compute buffer size =   560.07 MiB
0.10.447.678 I sched_reserve: Vulkan_Host compute buffer size =   142.09 MiB
0.10.687.474 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.10.687.542 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.10.687.556 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.10.687.558 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.10.687.559 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.10.689.189 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.10.743.579 I srv  update_slots: all slots are idle
0.13.305.225 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2042
0.20.192.008 I srv  update_slots: all slots are idle
```
</details>
