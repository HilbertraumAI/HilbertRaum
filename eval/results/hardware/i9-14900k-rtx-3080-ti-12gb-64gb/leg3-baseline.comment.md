### Start: i9-14900k-rtx-3080-ti-12gb-64gb · leg 3 · baseline
1. **File:** `gemma4-12b-it-qat-q4` · `gemma4-12b-it-qat-q4.gguf` · 6,975,879,296 B (6.50 GiB) · sha256 `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Home 25H2 build 26200.9168 · driver NVIDIA 610.88 (Vulkan 1.4.341) · heaps: RTX 3080 Ti heap 0 device-local 11.80 GiB (budget 11.05 GiB), heap 1 host 31.84 GiB; no separate BAR heap
3. **Argv:** `llama-server --host 127.0.0.1 --port 57916 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: `--host/--port/--model/--ctx-size/--threads` sidecar.ts:525-535 `buildArgs`; ctx 8192 = manifest `recommended_context_tokens` via models.ts:176-181; threads 16 = ⌊32/2⌋ sidecar.ts:90-98; `--batch-size/--ubatch-size 2048` = min(ctx, CHAT_MAX_PHYSICAL_BATCH) llama.ts:460 emitted at sidecar.ts:513-524; `--jinja --reasoning-format deepseek -lv 4` = CHAT_SERVER_ARGS llama.ts:39; rung 1 adds nothing, factory.ts:763-764 — no `-ngl`, no `--device`, no `--fit-target`/`--fit-ctx`/`-np` (binary defaults: fit on, 1024 MiB target, `-np` auto → 4))
4. **Memory at start:** device_info Vulkan0 11,316 / 12,084 MiB (Vulkan1 Intel UHD 770 48,060 / 32,606) · nvidia-smi 2749/12288 MiB used/total (9336 free) · desktop: idle as far as this machine gets — browser and other GPU apps closed, VS Code (driving the session) open; nvidia-smi still reports ~2.7 GB in use by the desktop
5. **Fit outcome:** offloaded **49/49** layers to GPU (Vulkan0) · fit pass: `12084 = 11312 + (9226 = 6637 + 2048 + 541) + -8455`, "projected to use 9226 MiB of device memory vs. 11312 MiB of free device memory, will leave 2086 >= 1024 MiB, no changes needed" · buffers: Vulkan0 model 6,637.63 MiB, CPU_Mapped model 787.50 MiB (token embeddings), Vulkan0 KV non-SWA 128.00 MiB (8,192 cells) + SWA 1,920.00 MiB (6,144 cells; n_swa 1024), Vulkan0 compute 541.07 MiB, Vulkan_Host compute 116.08 MiB, Vulkan_Host output 4.00 MiB · no recurrent state (Gemma 4 is attention-only) · n_parallel auto → 4, kv_unified true, n_slots 4, n_ctx_slot 8192 · **rung 1** (default args, GPU auto-offload)
6. **Peak use:** 9492 MiB used (nvidia-smi, 1 s polling; +6743 MiB over the pre-spawn figure; 9347 MiB right after load, 2587 MiB after stop) during 2042-token prefill / 512-token decode
7. **Speed:** decode 27.70 tok/s (`predicted_per_second`, 512 tokens in 18.5 s) · prefill 131.5 tok/s (`prompt_per_second`, 2042 tokens in 15.5 s) · load to /health 16.0 s
8. **Varied:** none (baseline)
9. **App view:** starred **`qwen3.5-9b-ud-q4kxl`** ("Empfohlen für den nächsten Start: Qwen3.5 9B (UD-Q4_K_XL) (Grafikspeicher)") · memory class **discrete**, basis graphics memory · budget device **NVIDIA GeForce RTX 3080 Ti, 11.8 GB VRAM** (probe total 12,084 MiB) · profile PRO, 63.7 GB RAM, context 8,192 · the app then started the 12B itself ("Dieses Modell verwenden" → log: `started via rung 1 (default args, GPU auto-offload) (backend: gpu)`, 24 s to ready) and its check measured **36.2 tok/s over 64 tokens** (short prompt; my 27.7 tok/s is 512 tokens after a 2,042-token prefill) · "Your model" estimate: the picker formula (§6.6 point 3) puts the 12B at 11,159 MiB against 11,316 free = "should fit"; after the app's own start the row reads from the same 49/49 load log as this measurement (the on-screen sentence was not transcribed). NOTE: the drive's packaged app (v0.1.57, 2026-08-18) predates the graphics-memory picker and its report shows no memory basis; this app view is the current source build (0.1.59, `npm run dev` with `HILBERTRAUM_DRIVE_ROOT` at the drive). All pasted reports are saved beside the JSON.
**Predicted vs measured:** **Holds.** §6.6 predicts Gemma 12B fits from 11,159 MiB free; the probe reported 11,316 and the fit projected only 9,226 MiB (2,086 MiB to spare), so the model offloaded fully at full card speed. The picker's estimate is conservative by ≈1.9 GiB here: measured KV 2,048 MiB vs the manifest's 2.4 GiB term, measured compute 541 MiB vs the 15 % working share (≈1,020 MiB on 6,800 MiB of weights). nvidia-smi's process-level delta (+6,743 MiB at peak) is ≈2.5 GiB below the Vulkan allocations (9,226 MiB): the Vulkan budget figure, not nvidia-smi, is what the fit reasons about.
<details><summary>Load-log excerpt (redacted, 50 lines)</summary>

```text
# leg3-baseline — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 57916 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.144.795 I cmn  common_param: device_info:
0.00.148.073 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.156.384 I cmn  common_init_: fitting params to device memory ...
0.00.156.385 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.156.388 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.759.581 I common_params_fit_impl: projected to use 9226 MiB of device memory vs. 11312 MiB of free device memory
0.00.759.587 I common_params_fit_impl: will leave 2086 >= 1024 MiB of free device memory, no changes needed
0.00.759.591 I common_fit_params: successfully fit params to free device memory
0.00.759.596 I common_fit_params: fitting params to free memory took 0.59 seconds
0.00.823.244 I llama_model_loader: - kv  21:                  gemma4.rope.freq_base_swa f32              = 10000.000000
0.00.823.265 I llama_model_loader: - kv  30:            gemma4.attention.key_length_swa u32              = 256
0.00.823.265 I llama_model_loader: - kv  31:          gemma4.attention.value_length_swa u32              = 256
0.00.823.265 I llama_model_loader: - kv  33:            gemma4.rope.dimension_count_swa u32              = 256
0.00.981.989 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3080 Ti) (0000:01:00.0) - 11312 MiB free
0.01.170.425 I print_info: n_ctx_train           = 262144
0.01.170.450 I print_info: n_swa                 = 1024
0.01.170.450 I print_info: is_swa_any            = 1
0.01.170.490 I print_info: freq_base_swa         = 10000.0
0.01.170.491 I print_info: freq_scale_swa        = 1
0.01.170.491 I print_info: n_embd_head_k_swa     = 256
0.01.170.491 I print_info: n_embd_head_v_swa     = 256
0.01.170.491 I print_info: n_rot_swa             = 256
0.01.170.492 I print_info: n_ctx_orig_yarn       = 262144
0.01.170.499 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.11.769.293 I load_tensors: offloading output layer to GPU
0.11.769.298 I load_tensors: offloading 47 repeating layers to GPU
0.11.769.299 I load_tensors: offloaded 49/49 layers to GPU
0.11.769.301 I load_tensors:   CPU_Mapped model buffer size =   787.50 MiB
0.11.769.302 I load_tensors:      Vulkan0 model buffer size =  6637.63 MiB
0.14.623.311 I llama_context: n_ctx         = 8192
0.14.623.311 I llama_context: n_ctx_seq     = 8192
0.14.623.313 I llama_context: kv_unified    = true
0.14.623.316 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.14.623.960 I llama_context: Vulkan_Host  output buffer size =     4.00 MiB
0.14.623.967 I llama_kv_cache_iswa: creating non-SWA KV cache, size = 8192 cells
0.14.624.431 I llama_kv_cache:    Vulkan0 KV buffer size =   128.00 MiB
0.14.669.690 I llama_kv_cache_iswa: creating     SWA KV cache, size = 6144 cells
0.14.671.460 I llama_kv_cache:    Vulkan0 KV buffer size =  1920.00 MiB
0.15.347.151 I sched_reserve:    Vulkan0 compute buffer size =   541.07 MiB
0.15.347.158 I sched_reserve: Vulkan_Host compute buffer size =   116.08 MiB
0.15.671.757 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.15.671.784 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.15.671.788 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.15.671.788 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.15.671.788 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.15.671.867 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.15.680.632 I srv  update_slots: all slots are idle
0.17.669.595 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2042
0.51.677.679 I srv  update_slots: all slots are idle
```
</details>
