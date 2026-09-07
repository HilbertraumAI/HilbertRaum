### Start: ryzen-7-5800h-rtx-3060-laptop-6gb-14gb · leg 4 · partial-9b
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build, Clang 20.1.8) · Windows 11 Home 22H2 build 22621.4387 · AMD Ryzen 7 5800H, 8 cores / 16 logical, 13.86 GiB RAM · laptop (chassis type 10) · driver NVIDIA 591.74 (Vulkan device api 1.4.325, driverVersion 591.74.0.0); the AMD iGPU runs 2.0.233 (api 1.3.217); Vulkan instance 1.4.321 · heaps: RTX 3060 Laptop: ONE device-local heap of 5,994 MiB (budget 5,226 MiB) plus a 7,094 MiB host heap — **no separate BAR heap**, so protocol question (e) has no subject here. Radeon iGPU: device-local 1,792 MiB + 256 MiB (APU carve-out) plus a 6,838 MiB host heap
3. **Argv:** `llama-server --host 127.0.0.1 --port 51272 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 8 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: identical to the leg-4 baseline start and cited there in full: sidecar.ts:511 `buildArgs` (:526/:528/:530/:532/:534), ctx 8192 from the manifest via models.ts:176-183, threads 8 = ⌊16/2⌋ sidecar.ts:90-98, batch/ubatch 2048 from llama.ts:460 emitted at sidecar.ts:513-523, CHAT_SERVER_ARGS llama.ts:39, rung 1 adds nothing (factory.ts:764). `qwen3.5-9b-ud-q4kxl` carries no `speculative_decoding`, so rung 1a does not apply)
4. **Memory at start:** device_info Vulkan0 (iGPU) 8,441 / 8,886 MiB · **Vulkan1 (card) 5,226 / 5,994 MiB**; the fit's own reading at decision time was **5,022 MiB**, 204 MiB below the probe (the GTX 1070 Ti's gap was 606 MiB). A `--list-devices` taken while the model was loaded still returned `5226 MiB free` for Vulkan1 — **unchanged** — while nvidia-smi showed 4,159 MiB used · nvidia-smi 250/6144 MiB used/total (5745 free) · desktop: idle — the HilbertRaum app was fully closed for this start, no browser; nvidia-smi 250 MiB used before the spawn
5. **Fit outcome:** offloaded **18/33** layers to GPU — **PARTIAL**, which is what protocol question (f) asks for. Fit pass: `projected to use 6007 MiB of device memory vs. 5022 MiB of free device memory`, `cannot meet free memory target of 1024 MiB, need to reduce device memory by 2008 MiB`, then `filling dense layers back-to-front` → `start filling device 0, delta=33` → `Vulkan1 (NVIDIA GeForce RTX 3060 Laptop GPU): 18 layers, 3882 MiB used, 1140 MiB free`. Buffers — card: model 3,123.80 MiB, KV 160.00 MiB, recurrent-state 100.50 MiB, compute 498.00 MiB; host: CPU_Mapped model 2,555.45 MiB, CPU KV 96.00 MiB, CPU RS 100.50 MiB, Vulkan_Host compute 128.44 MiB, output 3.79 MiB. KV total 256.00 MiB (8,192 cells, 8 layers, 4/1 seqs), RS total 201.00 MiB (4 cells, 32 layers, 4 seqs). **Vulkan0 (the iGPU) again received nothing.** Same two partial-offload warnings the GTX 1070 Ti logged: `layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan1 (usually due to missing support)` and `fused Gated Delta Net (chunked) not supported, set to disabled`. **Rung 1** — the ladder saw a healthy start and never learned the offload was partial
6. **Peak use:** 4260 MiB used (nvidia-smi, 1 s polling; +4010 MiB over the pre-spawn figure; 4159 MiB right after load, 260 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 5.23 tok/s (`predicted_per_second`, 512 tokens in 97.9 s) · prefill 42.0 tok/s (`prompt_per_second`, 2015 tokens in 48.0 s) · load to /health 39.1 s
8. **Varied:** none (baseline for this model). Unlike the E2B start this one needed no `ignore_eos`: the 9B kept generating and produced the full 512 tokens on the runner's stock body, exactly as on the GTX 1070 Ti, so the decode figure is directly comparable with that machine's
9. **App view:** starred **`gemma4-e2b-it-qat-q4`**, NOT this model — 'Empfohlen für den nächsten Start: Gemma 4 E2B Instruct QAT Q4 (Arbeitsspeicher)'. The 9B is permitted by RAM (`recommended_min_ram_gb` 12 ≤ 14) but is not the RAM pick at 14 GB, so the app would never start it by itself here; it was started for question (f). Graphics memory tile: '5,9 GB VRAM (NVIDIA GeForce RTX 3060 Laptop GPU)', profile LITE, context 8.192. No 'Dein Modell' row for this model: the app never ran it, so there is no app-side estimate to compare the 18/33 split against
**Predicted vs measured:** **Holds — and question (f) now has a number: 5.23 tok/s.** §6.6 predicts the 9B does not fit this card (need **8,014 MiB** vs 5,226 MiB free) and the measurement agrees on the verdict: llama.cpp projected **6,007 MiB**, could not keep its 1,024 MiB target against a 5,022 MiB reading, and shed 15 of 33 layers. Decode came out at **5.23 tok/s** with a 42.0 tok/s prefill — against **20.2 tok/s** for the same model at 31/33 layers on the GTX 1070 Ti's 8 GB card, so the extra 2 GB of card is worth roughly **4×** the decode speed on this model, and a 6 GB laptop card is not a viable home for a 9B at 8k. The estimate is again conservative but by less than on the E2B: 8,014 predicted vs 6,007 projected = **33 %** high (the 0.4 GiB cache term is close — measured KV 256 + RS 201 = 457 MiB — while the 15 % working share assumes 837 MiB against a measured 498 MiB compute buffer on the card). The verdict would only flip on a card reading ≥ 7,031 MiB free, which this one cannot reach. Question (e) remains unanswerable here: no BAR heap on this card
<details><summary>Load-log excerpt (redacted, 61 lines)</summary>

```text
# leg4-partial-9b — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 51272 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 8 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.479.097 I cmn  common_param: device_info:
0.00.490.948 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.499.639 I cmn  common_init_: fitting params to device memory ...
0.00.499.641 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.499.649 I common_params_fit_impl: getting device memory data for initial parameters:
0.02.292.380 I common_params_fit_impl: projected to use 6007 MiB of device memory vs. 5022 MiB of free device memory
0.02.292.397 I common_params_fit_impl: cannot meet free memory target of 1024 MiB, need to reduce device memory by 2008 MiB
0.02.292.398 I common_params_fit_impl: context size set by user to 8192 -> no change
0.02.292.403 I common_params_fit_impl: id=0, target=3998 MiB
0.04.130.069 I common_params_fit_impl: memory for test allocation by device:
0.04.130.081 I common_params_fit_impl: id=0, n_layer= 0, n_part= 0, overflow_type=4, mem=   498 MiB
0.04.130.085 I common_params_fit_impl: filling dense layers back-to-front:
0.05.714.178 I common_params_fit_impl: memory for test allocation by device:
0.05.714.190 I common_params_fit_impl: id=0, n_layer=33, n_part= 0, overflow_type=4, mem=  6007 MiB
0.05.714.196 I common_params_fit_impl: start filling device 0, delta=33
0.07.517.969 I common_params_fit_impl: memory for test allocation by device:
0.07.517.983 I common_params_fit_impl: id=0, n_layer=20, n_part= 0, overflow_type=4, mem=  4168 MiB
0.07.517.993 I common_params_fit_impl: set ngl_per_device_high[0].n_layer=20
0.09.182.551 I common_params_fit_impl: memory for test allocation by device:
0.09.182.561 I common_params_fit_impl: id=0, n_layer=19, n_part= 0, overflow_type=4, mem=  4025 MiB
0.09.182.577 I common_params_fit_impl: set ngl_per_device_high[0].n_layer=19
0.10.425.362 I common_params_fit_impl: memory for test allocation by device:
0.10.425.373 I common_params_fit_impl: id=0, n_layer=18, n_part= 0, overflow_type=4, mem=  3882 MiB
0.10.425.384 I common_params_fit_impl: set ngl_per_device[0].n_layer=18
0.10.425.387 I common_params_fit_impl:   - Vulkan1 (NVIDIA GeForce RTX 3060 Laptop GPU): 18 layers,   3882 MiB used,   1140 MiB free
0.10.425.403 I common_fit_params: successfully fit params to free device memory
0.10.425.419 I common_fit_params: fitting params to free memory took 1.22 seconds
0.10.707.765 I llama_prepare_model_devices: using device Vulkan1 (NVIDIA GeForce RTX 3060 Laptop GPU) (0000:01:00.0) - 5223 MiB free
0.11.283.232 I print_info: n_ctx_train           = 262144
0.11.283.259 I print_info: n_swa                 = 0
0.11.283.262 I print_info: is_swa_any            = 0
0.11.283.289 I print_info: n_ctx_orig_yarn       = 262144
0.11.283.313 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.14.481.000 I load_tensors: offloading output layer to GPU
0.14.481.011 I load_tensors: offloading 17 repeating layers to GPU
0.14.481.012 I load_tensors: offloaded 18/33 layers to GPU
0.14.481.025 I load_tensors:   CPU_Mapped model buffer size =  2555.45 MiB
0.14.481.027 I load_tensors:      Vulkan1 model buffer size =  3123.80 MiB
0.27.562.056 I llama_context: n_ctx         = 8192
0.27.562.056 I llama_context: n_ctx_seq     = 8192
0.27.562.059 I llama_context: kv_unified    = true
0.27.562.105 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.27.563.975 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.27.564.795 I llama_kv_cache:        CPU KV buffer size =    96.00 MiB
0.27.598.308 I llama_kv_cache:    Vulkan1 KV buffer size =   160.00 MiB
0.28.355.311 I llama_memory_recurrent:        CPU RS buffer size =   100.50 MiB
0.28.525.996 I llama_memory_recurrent:    Vulkan1 RS buffer size =   100.50 MiB
0.28.526.041 I llama_memory_recurrent: size =  201.00 MiB (     4 cells,  32 layers,  4 seqs  0 rs_seq), R (f32):    9.00 MiB, S (f32):  192.00 MiB
0.28.651.455 W sched_reserve: layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan1 (usually due to missing support)
0.30.241.026 I sched_reserve:    Vulkan1 compute buffer size =   498.00 MiB
0.30.241.038 I sched_reserve: Vulkan_Host compute buffer size =   128.44 MiB
0.38.343.700 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.38.347.185 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.38.347.205 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.38.347.206 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.38.347.207 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.38.348.970 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.38.506.686 I srv  update_slots: all slots are idle
0.41.338.440 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
3.07.185.892 I srv  update_slots: all slots are idle
```
</details>
