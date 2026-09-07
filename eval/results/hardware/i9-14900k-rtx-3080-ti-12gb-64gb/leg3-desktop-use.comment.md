### Start: i9-14900k-rtx-3080-ti-12gb-64gb · leg 3 · desktop-use
1. **File:** `gemma4-12b-it-qat-q4` · `gemma4-12b-it-qat-q4.gguf` · 6,975,879,296 B (6.50 GiB) · sha256 `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Home 25H2 build 26200.9168 · driver NVIDIA 610.88 (Vulkan 1.4.341) · heaps: RTX 3080 Ti heap 0 device-local 11.80 GiB, budget 11.05 GiB, usage 0 — read AGAIN with the browser + video open: identical to the idle reading, the budget does not move
3. **Argv:** `llama-server --host 127.0.0.1 --port 61443 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: identical to the leg-3 baseline (sidecar.ts:525-535, models.ts:176-181, sidecar.ts:90-98, llama.ts:460 + sidecar.ts:513-524, llama.ts:39, factory.ts:763-764); nothing varied)
4. **Memory at start:** device_info Vulkan0 11,316 / 12,084 MiB — the SAME figure as when the card was idle, although nvidia-smi showed 5,453 MiB in use (+2.7 GB over the idle baseline) · nvidia-smi 5453/12288 MiB used/total (6632 free) · desktop: **~2.7 GB of ordinary use** (a browser with several tabs and a playing video, plus VS Code) — more than the ~1 GB the protocol asks for; the ~1 GB repeat (browser only, no video) follows as a separate start
5. **Fit outcome:** offloaded **49/49** layers to GPU — the fit saw NO difference from the idle start: `12084 = 11312 + (9226 = 6637 + 2048 + 541) + -8455`, "projected to use 9226 MiB vs. 11312 MiB free, will leave 2086 >= 1024 MiB, no changes needed" · identical buffers to the baseline (Vulkan0 model 6,637.63 MiB, CPU_Mapped 787.50 MiB, KV 128 + 1,920 MiB, compute 541.07 MiB, Vulkan_Host compute 116.08 MiB) · **rung 1** · but the card was oversubscribed: 5,453 MiB desktop + 9,226 MiB model > 12,288 MiB, so the driver paged part of it to host memory (WDDM) — load took 22.6 s instead of 16.0 s
6. **Peak use:** 10682 MiB used (nvidia-smi, 1 s polling; +5229 MiB over the pre-spawn figure; 9663 MiB right after load, 5730 MiB after stop) during 2042-token prefill / 512-token decode
7. **Speed:** decode 2.51 tok/s (`predicted_per_second`, 512 tokens in 204.4 s) · prefill 101.9 tok/s (`prompt_per_second`, 2042 tokens in 20.0 s) · load to /health 22.6 s
8. **Varied:** the desktop load only (idle → browser + video); every argument unchanged
9. **App view:** same app session as the baseline: starred `qwen3.5-9b-ud-q4kxl`, memory class discrete, budget device RTX 3080 Ti 11.8 GB — the app's probe would show the SAME 11,316 MiB free here, so its "Your model" row would still say the 12B fits
**Predicted vs measured:** **Does NOT hold — and the reason is upstream of the picker.** §6.6's free-memory basis assumes the probe's `freeMb` reflects what other processes hold; on this NVIDIA Windows driver `VK_EXT_memory_budget` returns a constant budget (total − 768 MiB = 11,316 MiB) with `usage 0`, whatever else is resident — `vulkaninfo`, `--list-devices` and the fit's own breakdown all read 11,312–11,316 free while nvidia-smi showed 5.4 GB used. So llama.cpp's `--fit` offloaded all 49 layers as if the card were empty, the allocation succeeded (WDDM overcommit), and decode fell from **27.7 to 2.5 tok/s** (prefill 131 → 102 tok/s; peak nvidia-smi 10,682 MiB): the issue-#42 class "healthy start, partial-offload speed" — except the log says 49/49, so the placement parser reports a full fit too. On this driver the picker's rule C is effectively on the TOTAL basis (its 2026-09-05 retracted form) despite reading `freeMb`, and no layer count in the load log can reveal the eviction; only a decode measurement can. Belongs with the free-basis decision (§6.6 point 2) and the #42 detection class; nvidia-smi (or the DXGI `GPU Process Memory` counters) would have shown the shortfall.
<details><summary>Load-log excerpt (redacted, 50 lines)</summary>

```text
# leg3-desktop-use — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 61443 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.148.279 I cmn  common_param: device_info:
0.00.152.332 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.161.217 I cmn  common_init_: fitting params to device memory ...
0.00.161.218 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.161.223 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.719.796 I common_params_fit_impl: projected to use 9226 MiB of device memory vs. 11312 MiB of free device memory
0.00.719.800 I common_params_fit_impl: will leave 2086 >= 1024 MiB of free device memory, no changes needed
0.00.719.807 I common_fit_params: successfully fit params to free device memory
0.00.719.811 I common_fit_params: fitting params to free memory took 0.55 seconds
0.00.785.009 I llama_model_loader: - kv  21:                  gemma4.rope.freq_base_swa f32              = 10000.000000
0.00.785.017 I llama_model_loader: - kv  30:            gemma4.attention.key_length_swa u32              = 256
0.00.785.018 I llama_model_loader: - kv  31:          gemma4.attention.value_length_swa u32              = 256
0.00.785.018 I llama_model_loader: - kv  33:            gemma4.rope.dimension_count_swa u32              = 256
0.00.944.665 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3080 Ti) (0000:01:00.0) - 11312 MiB free
0.01.153.535 I print_info: n_ctx_train           = 262144
0.01.153.555 I print_info: n_swa                 = 1024
0.01.153.555 I print_info: is_swa_any            = 1
0.01.153.593 I print_info: freq_base_swa         = 10000.0
0.01.153.594 I print_info: freq_scale_swa        = 1
0.01.153.594 I print_info: n_embd_head_k_swa     = 256
0.01.153.594 I print_info: n_embd_head_v_swa     = 256
0.01.153.594 I print_info: n_rot_swa             = 256
0.01.153.595 I print_info: n_ctx_orig_yarn       = 262144
0.01.153.602 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.16.439.382 I load_tensors: offloading output layer to GPU
0.16.439.387 I load_tensors: offloading 47 repeating layers to GPU
0.16.439.387 I load_tensors: offloaded 49/49 layers to GPU
0.16.439.389 I load_tensors:   CPU_Mapped model buffer size =   787.50 MiB
0.16.439.391 I load_tensors:      Vulkan0 model buffer size =  6637.63 MiB
0.19.914.512 I llama_context: n_ctx         = 8192
0.19.914.513 I llama_context: n_ctx_seq     = 8192
0.19.914.514 I llama_context: kv_unified    = true
0.19.914.518 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.19.914.966 I llama_context: Vulkan_Host  output buffer size =     4.00 MiB
0.19.914.972 I llama_kv_cache_iswa: creating non-SWA KV cache, size = 8192 cells
0.19.915.550 I llama_kv_cache:    Vulkan0 KV buffer size =   128.00 MiB
0.19.990.788 I llama_kv_cache_iswa: creating     SWA KV cache, size = 6144 cells
0.19.992.711 I llama_kv_cache:    Vulkan0 KV buffer size =  1920.00 MiB
0.21.067.052 I sched_reserve:    Vulkan0 compute buffer size =   541.07 MiB
0.21.067.059 I sched_reserve: Vulkan_Host compute buffer size =   116.08 MiB
0.22.496.223 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.22.496.721 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.22.497.155 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.22.497.158 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.22.497.158 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.22.498.573 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.22.509.708 I srv  update_slots: all slots are idle
0.24.302.077 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2042
4.08.721.258 I srv  update_slots: all slots are idle
```
</details>
