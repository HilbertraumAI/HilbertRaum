### Start: i9-14900k-rtx-3080-ti-12gb-64gb · leg 3 · desktop-use-1gb
1. **File:** `gemma4-12b-it-qat-q4` · `gemma4-12b-it-qat-q4.gguf` · 6,975,879,296 B (6.50 GiB) · sha256 `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Home 25H2 build 26200.9168 · driver NVIDIA 610.88 (Vulkan 1.4.341) · heaps: RTX 3080 Ti heap 0 device-local 11.80 GiB, budget 11.05 GiB, usage 0 (constant on this driver, see the previous start)
3. **Argv:** `llama-server --host 127.0.0.1 --port 58097 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: identical to the leg-3 baseline (sidecar.ts:525-535, models.ts:176-181, sidecar.ts:90-98, llama.ts:460 + sidecar.ts:513-524, llama.ts:39, factory.ts:763-764); nothing varied)
4. **Memory at start:** device_info Vulkan0 11,316 / 12,084 MiB (unchanged, as always on this driver) · nvidia-smi 2876/12288 MiB used/total (9209 free) · desktop: **~1 GB-class ordinary use** — a browser with several tabs (video stopped) plus VS Code; nvidia-smi read 2,876 MiB used, i.e. the SAME resident figure as the "idle" baseline (the Windows desktop + VS Code + browser tabs hold ≈ 2.8 GB of dedicated memory on this card whether or not a video plays)
5. **Fit outcome:** offloaded **49/49** layers to GPU — the fit again saw no difference (`12084 = 11312 + (9226 = 6637 + 2048 + 541) + -8455`, "will leave 2086 >= 1024 MiB, no changes needed"), identical buffers to the baseline (Vulkan0 model 6,637.63 MiB, KV 128 + 1,920 MiB, compute 541.07 MiB) · **rung 1** · load 6.7 s (file now in the OS cache) · **but only part of it was resident:** the `GPU Adapter Memory` counters sampled beside the repeat start (`leg3-desktop-use-1gb-repeat.adapter-memory.csv`) show the card's DEDICATED usage rising 2,836 → 9,269 MiB (+6,433 MiB) and its SHARED (system-memory) usage rising 115 → **3,197 MiB (+3,082 MiB)** the moment the model loaded, and both stayed there through the request: ≈ 3.0 GiB of the 9.2 GiB of Vulkan allocations were placed in host memory over PCIe. nvidia-smi's "+6.3–6.7 GB" deltas in every 12B start on this card are that resident share; the missing ≈ 2.5–3 GiB was never on the card, not even in the "idle" baseline
6. **Peak use:** 9284 MiB used (nvidia-smi, 1 s polling; +6408 MiB over the pre-spawn figure; 9173 MiB right after load, 2811 MiB after stop) during 2042-token prefill / 512-token decode
7. **Speed:** decode 4.57 tok/s (`predicted_per_second`, 512 tokens in 112.2 s) · prefill 907.7 tok/s (`prompt_per_second`, 2042 tokens in 2.2 s) · load to /health 6.7 s
8. **Varied:** the desktop load only (browser open, no video); every argument unchanged. Two diagnostic starts accompany this one (JSON + logs + counter samples in the results directory): **`leg3-desktop-use-1gb-repeat`** (same load, same argv: decode 5.0 tok/s, prefill 735 tok/s, peak 9,239 MiB — reproduces this start) and **`leg5-control-browser-open`** (the 9B under the identical browser load: 33/33 layers, decode **98.3 tok/s**, prefill 2,459 tok/s, shared usage stayed 112–238 MiB — so the browser costs nothing when the model actually fits; the collapse is memory placement, not compute contention)
9. **App view:** same app session as the baseline: starred `qwen3.5-9b-ud-q4kxl` (correct — the 9B is what runs well here), memory class discrete, budget device RTX 3080 Ti 11.8 GB; a "Your model" row for the 12B would still say it fits, on the same 11,316 MiB figure
**Predicted vs measured:** **Does not hold for the 12B on this 12 GB card, in the protocol's ~1 GB-use condition — and the "idle" baseline was already marginal.** Decode 4.6 tok/s here and 5.0 in the repeat versus 27.7 in the baseline; prefill 908 / 735 tok/s (both faster than the baseline's 131, which was measured on a cold file). The mechanism is now measured rather than inferred: the desktop keeps ≈ 2.8 GB of the 12,288 MiB resident, the 12B's 9,226 MiB of Vulkan allocations do not fit beside it, the driver satisfies them from host memory (shared usage +3.0 GiB) instead of failing, and llama.cpp's fit — reading the constant 11,312 MiB Vulkan budget — never notices, so the load log says 49/49 and the placement parser would report a full fit. Speed-wise the 12B on this machine is a partially-offloaded model whose log claims full offload. Consequences for §6.6: (1) on this driver the free-memory basis is the total basis in disguise, and the 12B's predicted 157 MiB margin is fiction — its real need (≈ 9.3 GiB resident) must be judged against total − the desktop's resident use (≈ 9.4 GiB here), which is what the retracted `total − 1024` heuristic approximated; (2) the star itself (the 9B) is right, and the control shows it runs at full speed under the same load; (3) the layer count is not a fit signal on Windows/Vulkan — only a decode measurement (or the DXGI shared-usage counter) detects the spill, which is the issue-#42 class again. The remaining variable is whether the baseline's 27.7 tok/s was itself spilled: an idle re-run with the counter sampler follows.
<details><summary>Load-log excerpt (redacted, 50 lines)</summary>

```text
# leg3-desktop-use-1gb — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 58097 --model <drive>\models\chat\gemma4-12b-it-qat-q4.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.150.724 I cmn  common_param: device_info:
0.00.153.956 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.157.740 I cmn  common_init_: fitting params to device memory ...
0.00.157.740 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.157.744 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.716.155 I common_params_fit_impl: projected to use 9226 MiB of device memory vs. 11312 MiB of free device memory
0.00.716.160 I common_params_fit_impl: will leave 2086 >= 1024 MiB of free device memory, no changes needed
0.00.716.166 I common_fit_params: successfully fit params to free device memory
0.00.716.171 I common_fit_params: fitting params to free memory took 0.55 seconds
0.00.781.316 I llama_model_loader: - kv  21:                  gemma4.rope.freq_base_swa f32              = 10000.000000
0.00.781.324 I llama_model_loader: - kv  30:            gemma4.attention.key_length_swa u32              = 256
0.00.781.324 I llama_model_loader: - kv  31:          gemma4.attention.value_length_swa u32              = 256
0.00.781.325 I llama_model_loader: - kv  33:            gemma4.rope.dimension_count_swa u32              = 256
0.00.938.367 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3080 Ti) (0000:01:00.0) - 11312 MiB free
0.01.132.967 I print_info: n_ctx_train           = 262144
0.01.132.987 I print_info: n_swa                 = 1024
0.01.132.988 I print_info: is_swa_any            = 1
0.01.133.027 I print_info: freq_base_swa         = 10000.0
0.01.133.027 I print_info: freq_scale_swa        = 1
0.01.133.027 I print_info: n_embd_head_k_swa     = 256
0.01.133.028 I print_info: n_embd_head_v_swa     = 256
0.01.133.028 I print_info: n_rot_swa             = 256
0.01.133.028 I print_info: n_ctx_orig_yarn       = 262144
0.01.133.036 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.02.879.394 I load_tensors: offloading output layer to GPU
0.02.879.399 I load_tensors: offloading 47 repeating layers to GPU
0.02.879.400 I load_tensors: offloaded 49/49 layers to GPU
0.02.879.402 I load_tensors:   CPU_Mapped model buffer size =   787.50 MiB
0.02.879.403 I load_tensors:      Vulkan0 model buffer size =  6637.63 MiB
0.05.441.651 I llama_context: n_ctx         = 8192
0.05.441.652 I llama_context: n_ctx_seq     = 8192
0.05.441.654 I llama_context: kv_unified    = true
0.05.441.657 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.05.442.093 I llama_context: Vulkan_Host  output buffer size =     4.00 MiB
0.05.442.099 I llama_kv_cache_iswa: creating non-SWA KV cache, size = 8192 cells
0.05.442.575 I llama_kv_cache:    Vulkan0 KV buffer size =   128.00 MiB
0.05.471.085 I llama_kv_cache_iswa: creating     SWA KV cache, size = 6144 cells
0.05.472.586 I llama_kv_cache:    Vulkan0 KV buffer size =  1920.00 MiB
0.05.713.505 I sched_reserve:    Vulkan0 compute buffer size =   541.07 MiB
0.05.713.510 I sched_reserve: Vulkan_Host compute buffer size =   116.08 MiB
0.06.466.752 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.06.466.773 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.06.466.776 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.06.466.776 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.06.466.776 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.06.466.862 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.06.478.065 I srv  update_slots: all slots are idle
0.08.396.768 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2042
2.02.796.962 I srv  update_slots: all slots are idle
```
</details>
