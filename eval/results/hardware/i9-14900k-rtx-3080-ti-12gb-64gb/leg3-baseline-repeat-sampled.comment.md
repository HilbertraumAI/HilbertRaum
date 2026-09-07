### Start: i9-14900k-rtx-3080-ti-12gb-64gb · leg 3 · baseline-repeat-sampled
1. **File:** `gemma4-12b-it-qat-q4` · `gemma4-12b-it-qat-q4.gguf` · 6,975,879,296 B (6.50 GiB) · sha256 `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Home 25H2 build 26200.9168 · driver NVIDIA 610.88 (Vulkan 1.4.341) · heaps: RTX 3080 Ti heap 0 device-local 11.80 GiB, budget 11.05 GiB, usage 0 (constant on this driver)
3. **Argv:** `llama-server --host 127.0.0.1 --port 50751 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: identical to the leg-3 baseline (sidecar.ts:525-535, models.ts:176-181, sidecar.ts:90-98, llama.ts:460 + sidecar.ts:513-524, llama.ts:39, factory.ts:763-764); nothing varied — this is the baseline condition repeated with the `GPU Adapter Memory` counters sampled beside it)
4. **Memory at start:** device_info Vulkan0 11,316 / 12,084 MiB (unchanged) · nvidia-smi 2609/12288 MiB used/total (9476 free) · desktop: idle as this machine gets — browser closed, no app, VS Code open; nvidia-smi 2,609 MiB used before the spawn (the lowest of the session)
5. **Fit outcome:** offloaded **49/49** layers to GPU, identical fit pass and buffers to the baseline (`12084 = 11312 + (9226 = 6637 + 2048 + 541) + -8455`, "will leave 2086 >= 1024 MiB, no changes needed") · **rung 1** · load 5.2 s (cached file) · **residency, sampled** (`leg3-baseline-repeat-sampled.adapter-memory.csv`): dedicated usage 2,566 → 8,950 MiB (+6,384), shared (system-memory) usage 165 → **3,316 MiB (+3,151)** from the moment the model loaded, steady through the request — with **3.3 GB of dedicated memory still unused** (8,950 of 12,288). The driver placed ≈ 3.1 GiB of the 12B's allocations in host memory although the card had room; the same +3.1–3.2 GiB shared step appears in every 12B start that was sampled, and never for the 9B (+0.1 GiB)
6. **Peak use:** 8938 MiB used (nvidia-smi, 1 s polling; +6329 MiB over the pre-spawn figure; 8823 MiB right after load, 2559 MiB after stop) during 2042-token prefill / 512-token decode
7. **Speed:** decode 10.02 tok/s (`predicted_per_second`, 512 tokens in 51.1 s) · prefill 131.4 tok/s (`prompt_per_second`, 2042 tokens in 15.5 s) · load to /health 5.2 s
8. **Varied:** nothing (baseline repeated under sampling). One further diagnostic start sits beside it, **`leg3-diag-fit-target-4096`** (`--fit-target 4096` added, otherwise the app argv): the fit then offloaded **36/49** layers (Vulkan0 model 5,054.80 MiB + KV 96 + 1,392 MiB; CPU_Mapped 2,370 MiB + CPU KV 32 + 528 MiB; fit projected 7,092 MiB), decode **13.8 tok/s**, prefill 137 tok/s, peak nvidia-smi 9,275 MiB — a deliberate partial offload runs faster than this spilled "full" offload (10.0) but slower than the first baseline (27.7)
9. **App view:** same app session as the baseline: starred `qwen3.5-9b-ud-q4kxl`, memory class discrete, budget device RTX 3080 Ti 11.8 GB; the app's own 12B start ("Dieses Modell verwenden") measured 36.2 tok/s over 64 tokens on a short prompt in the same session — inside the 10–28 tok/s band seen here once the 64-token window and short prefill are allowed for
**Predicted vs measured:** **The baseline's 27.7 tok/s was not a clean full-offload figure either.** Same argv, same idle desktop, same 49/49 log line: decode **10.0 tok/s** (prefill 131, as in the baseline), and the counters show ≈ 3.1 GiB of the model in host memory from the first second. Across the session the 12B decoded at 27.7 / 10.0 / 5.0 / 4.6 / 2.5 tok/s under a log that always said 49/49 — the speed tracks how much the driver kept resident, which nothing in the load log reveals. Net for §6.6 on a 12 GB card under Windows/Vulkan with this driver: (1) the 9B star is right and runs at 82–98 tok/s with ≈ 0.1 GiB spilled; (2) the 12B's "fits with 157 MiB to spare" estimate is wrong in practice, and it is not the desktop's fault alone — even at 2.6 GB resident use and 3.3 GB of dedicated memory free the driver still spilled ≈ 3.1 GiB (open question for a follow-up: WDDM per-process budget vs the Vulkan backend's memory-type choice under resizable BAR); (3) the layer count is not a placement signal here — only decode speed or the DXGI shared-usage counter is; (4) the Vulkan `freeMb` the probe reads never changes, so rule C's free basis cannot see any of this. The 12 GB band should be marked "12B: partial in effect (Windows/Vulkan, NVIDIA 610.88), 9B verified" rather than "predicted fit".
<details><summary>Load-log excerpt (redacted, 50 lines)</summary>

```text
# leg3-baseline-repeat-sampled — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 50751 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.141.018 I cmn  common_param: device_info:
0.00.143.867 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.159.910 I cmn  common_init_: fitting params to device memory ...
0.00.159.911 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.159.914 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.667.556 I common_params_fit_impl: projected to use 9226 MiB of device memory vs. 11312 MiB of free device memory
0.00.667.560 I common_params_fit_impl: will leave 2086 >= 1024 MiB of free device memory, no changes needed
0.00.667.567 I common_fit_params: successfully fit params to free device memory
0.00.667.571 I common_fit_params: fitting params to free memory took 0.49 seconds
0.00.735.747 I llama_model_loader: - kv  21:                  gemma4.rope.freq_base_swa f32              = 10000.000000
0.00.735.757 I llama_model_loader: - kv  30:            gemma4.attention.key_length_swa u32              = 256
0.00.735.757 I llama_model_loader: - kv  31:          gemma4.attention.value_length_swa u32              = 256
0.00.735.757 I llama_model_loader: - kv  33:            gemma4.rope.dimension_count_swa u32              = 256
0.00.886.275 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3080 Ti) (0000:01:00.0) - 11312 MiB free
0.01.075.630 I print_info: n_ctx_train           = 262144
0.01.075.648 I print_info: n_swa                 = 1024
0.01.075.649 I print_info: is_swa_any            = 1
0.01.075.687 I print_info: freq_base_swa         = 10000.0
0.01.075.687 I print_info: freq_scale_swa        = 1
0.01.075.687 I print_info: n_embd_head_k_swa     = 256
0.01.075.688 I print_info: n_embd_head_v_swa     = 256
0.01.075.688 I print_info: n_rot_swa             = 256
0.01.075.688 I print_info: n_ctx_orig_yarn       = 262144
0.01.075.694 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.01.493.646 I load_tensors: offloading output layer to GPU
0.01.493.659 I load_tensors: offloading 47 repeating layers to GPU
0.01.493.659 I load_tensors: offloaded 49/49 layers to GPU
0.01.493.663 I load_tensors:   CPU_Mapped model buffer size =   787.50 MiB
0.01.493.666 I load_tensors:      Vulkan0 model buffer size =  6637.63 MiB
0.04.050.997 I llama_context: n_ctx         = 8192
0.04.050.997 I llama_context: n_ctx_seq     = 8192
0.04.050.998 I llama_context: kv_unified    = true
0.04.051.002 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.04.051.617 I llama_context: Vulkan_Host  output buffer size =     4.00 MiB
0.04.051.623 I llama_kv_cache_iswa: creating non-SWA KV cache, size = 8192 cells
0.04.052.134 I llama_kv_cache:    Vulkan0 KV buffer size =   128.00 MiB
0.04.082.623 I llama_kv_cache_iswa: creating     SWA KV cache, size = 6144 cells
0.04.138.890 I llama_kv_cache:    Vulkan0 KV buffer size =  1920.00 MiB
0.04.386.021 I sched_reserve:    Vulkan0 compute buffer size =   541.07 MiB
0.04.386.026 I sched_reserve: Vulkan_Host compute buffer size =   116.08 MiB
0.04.945.924 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.04.945.956 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.04.945.959 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.04.945.959 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.04.945.960 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.04.946.040 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.04.954.792 I srv  update_slots: all slots are idle
0.06.828.671 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2042
1.13.484.736 I srv  update_slots: all slots are idle
```
</details>
