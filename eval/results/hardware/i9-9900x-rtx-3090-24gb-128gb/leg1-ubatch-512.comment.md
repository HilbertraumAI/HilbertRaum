### Start: i9-9900x-rtx-3090-24gb-128gb · leg 1 · ubatch-512
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: RTX 3090 heap 0 device-local 24.00 GiB (budget 23,353 MiB idle), heap 1 host 94.11 GiB, heap 2 device-local **246 MiB BAR heap** (budget 221 MiB, 25 MiB in use idle)
3. **Argv:** `llama-server --host 127.0.0.1 --port 42651 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 512 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2` (source: identical to the leg-7 Q5 baseline (sidecar.ts:511-538, models.ts:176-183, sidecar.ts:90-98, llama.ts:49,460 + sidecar.ts:516-524, llama.ts:39,461, factory.ts:95 + factory.ts:754-761 rung 1a) except `--ubatch-size` 2048 → **512** (`--batch-size` stays 2048; the app itself always emits both equal to min(ctx, 2048), sidecar.ts:516-524))
4. **Memory at start:** device_info Vulkan0 23,548 / 24,822 MiB (probe read immediately before the spawn; while loaded a second `--list-devices` read 2,581 free) · nvidia-smi 771/24576 MiB used/total (23353 free) · desktop: **idle**: X desktop plus an idle ComfyUI server (256 MiB resident); `nvidia-smi` 771 MiB used before the spawn
5. **Fit outcome:** offloaded **65/66** layers to GPU (baseline: 62/66): still not a full offload. Fit pass: `projected to use 20619 MiB of device memory vs. 21728 MiB of free device memory`, `cannot meet free memory target of 1186 MiB, need to reduce device memory by 77 MiB` (target = 1,024 + the MTP estimate, which shrank from 552 to 162 MiB at ubatch 512), target 20,542 MiB, back-to-front fill: **65 layers = 20,358 MiB, 1,370 MiB free** (2.98 s) · buffers: Vulkan0 model 17,913.46 MiB + CPU_Mapped 931.63 MiB · KV: Vulkan0 512.00 MiB (`n_parallel` auto → 4, `kv_unified = true`) · RS: Vulkan0 1,758.09 + CPU 37.41 MiB · SWA: none · compute: **Vulkan0 174.45 MiB** (baseline 625.22) + Vulkan_Host 79.42 MiB · MTP draft context: KV 32.00 + compute 130.02 MiB · rung 1a + the varied ubatch
6. **Peak use:** 21433 MiB used (nvidia-smi, 1 s polling; +20662 MiB over the pre-spawn figure; 21321 MiB right after load, 771 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 38.89 tok/s (`predicted_per_second`, 512 tokens in 13.2 s) · prefill 774.3 tok/s (`prompt_per_second`, 2015 tokens in 2.6 s) · load to /health 10.4 s
8. **Varied:** `--ubatch-size` 2048 → 512 (one thing; `--batch-size` unchanged at 2048)
9. **App view:** pending: the app's Copy report follows as a separate comment after the six starts
**Predicted vs measured:** Question (d), ubatch leg: halving the micro-batch frees ~450 MiB of compute buffer plus ~390 MiB of MTP estimate, which buys three more layers (65/66) but NOT the full offload: the 77 MiB shortfall against the 1,186 MiB target still costs one layer. Decode 38.9 tok/s versus the baseline's 30.4 (one host layer instead of four; MTP acceptance fell to 0.675 from 0.779), prefill 774 versus 809 tok/s. Peak 21,433 MiB (+20,662 over pre-spawn), 2,691 MiB free at peak. The §6.6 Q5 verdict (not starred, does not fit) still holds under this variant. (e): BAR heap usage 24.9 → 233.6 (loaded) → 240.6 MiB (5.4 MiB of budget left).
<details><summary>Load-log excerpt (redacted, 70 lines)</summary>

```text
# leg1-ubatch-512 : argv: llama-server --host 127.0.0.1 --port 42651 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 512 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2
0.00.078.516 I cmn  common_param: device_info:
0.00.078.750 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.787.919 I srv    load_model: [spec] estimated memory usage of MTP context is 162.02 MiB
0.00.787.936 I cmn  common_init_: fitting params to device memory ...
0.00.787.937 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.787.941 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.496.916 I common_params_fit_impl: projected to use 20619 MiB of device memory vs. 21728 MiB of free device memory
0.01.496.921 I common_params_fit_impl: cannot meet free memory target of 1186 MiB, need to reduce device memory by 77 MiB
0.01.496.921 I common_params_fit_impl: context size set by user to 8192 -> no change
0.01.496.922 I common_params_fit_impl: id=0, target=20542 MiB
0.03.033.206 I common_params_fit_impl: memory for test allocation by device:
0.03.033.212 I common_params_fit_impl: id=0, n_layer= 0, n_part= 0, overflow_type=4, mem=   232 MiB
0.03.033.213 I common_params_fit_impl: filling dense layers back-to-front:
0.03.765.562 I common_params_fit_impl: memory for test allocation by device:
0.03.765.569 I common_params_fit_impl: id=0, n_layer=65, n_part= 0, overflow_type=4, mem= 20358 MiB
0.03.765.571 I common_params_fit_impl: set ngl_per_device[0].n_layer=65
0.03.765.572 I common_params_fit_impl:   - Vulkan0 (NVIDIA GeForce RTX 3090): 65 layers,  20358 MiB used,   1370 MiB free
0.03.765.574 I common_fit_params: successfully fit params to free device memory
0.03.765.577 I common_fit_params: fitting params to free memory took 2.98 seconds
0.03.888.523 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23525 MiB free
0.04.131.052 I load: special tokens cache size = 33
0.04.223.837 I print_info: n_ctx_train           = 262144
0.04.223.869 I print_info: n_swa                 = 0
0.04.223.870 I print_info: is_swa_any            = 0
0.04.223.886 I print_info: n_ctx_orig_yarn       = 262144
0.04.223.912 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.05.574.668 I load_tensors: offloading output layer to GPU
0.05.574.672 I load_tensors: offloading 64 repeating layers to GPU
0.05.574.672 I load_tensors: offloaded 65/66 layers to GPU
0.05.574.677 I load_tensors:   CPU_Mapped model buffer size =   931.63 MiB
0.05.574.678 I load_tensors:      Vulkan0 model buffer size = 17913.46 MiB
0.09.823.064 I llama_context: n_ctx         = 8192
0.09.823.065 I llama_context: n_ctx_seq     = 8192
0.09.823.069 I llama_context: kv_unified    = true
0.09.823.072 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.09.824.779 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.09.834.056 I llama_kv_cache:    Vulkan0 KV buffer size =   512.00 MiB
0.09.863.557 I llama_memory_recurrent:        CPU RS buffer size =    37.41 MiB
0.09.934.398 I llama_memory_recurrent:    Vulkan0 RS buffer size =  1758.09 MiB
0.09.934.429 I llama_memory_recurrent: size = 1795.50 MiB (     4 cells,  64 layers,  4 seqs  2 rs_seq), R (f32):   67.50 MiB, S (f32): 1728.00 MiB
0.09.961.639 W sched_reserve: layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan0 (usually due to missing support)
0.09.990.498 I sched_reserve:    Vulkan0 compute buffer size =   174.45 MiB
0.09.990.502 I sched_reserve: Vulkan_Host compute buffer size =    79.42 MiB
0.10.089.258 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q5km.gguf'
0.10.089.336 I llama_context: n_ctx         = 8192
0.10.089.337 I llama_context: n_ctx_seq     = 8192
0.10.089.354 I llama_context: kv_unified    = true
0.10.089.363 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.10.091.883 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.10.093.537 I llama_kv_cache:    Vulkan0 KV buffer size =    32.00 MiB
0.10.113.635 I sched_reserve:    Vulkan0 compute buffer size =   130.02 MiB
0.10.113.639 I sched_reserve: Vulkan_Host compute buffer size =    28.02 MiB
0.10.242.711 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.10.242.768 I spec common_specu: adding speculative implementation 'draft-mtp'
0.10.242.773 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.10.242.776 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.10.262.946 I sched_reserve:    Vulkan0 compute buffer size =   130.02 MiB
0.10.262.950 I sched_reserve: Vulkan_Host compute buffer size =    28.02 MiB
0.10.273.021 I srv    load_model: speculative decoding context initialized
0.10.273.030 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.10.273.042 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.10.273.044 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.10.273.045 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.10.273.163 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.10.316.826 I srv  update_slots: all slots are idle
0.12.993.392 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.28.760.136 I slot print_timing: id  3 | task 0 | draft acceptance = 0.67512 (  293 accepted /   434 generated), mean len =  2.35
0.28.760.161 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1    217    217, #gen drafts =    217, #acc drafts =   169, #gen tokens =    434, #acc tokens =   293, #mean acc len = 2.35, #acc rate/pos = (0.779, 0.571), dur(b,g,a) = 0.003, 1119.274, 0.543 ms
0.28.760.251 I srv  update_slots: all slots are idle
```
</details>
