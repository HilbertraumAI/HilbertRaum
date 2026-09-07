### Start: i9-9900x-rtx-3090-24gb-128gb · leg 1 · fit-target-512
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: RTX 3090 heap 0 device-local 24.00 GiB (budget 23,351 MiB idle), heap 1 host 94.11 GiB, heap 2 device-local **246 MiB BAR heap** (budget 221 MiB, 25 MiB in use idle)
3. **Argv:** `llama-server --host 127.0.0.1 --port 45271 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2 --fit-target 512` (source: identical to the leg-7 Q5 baseline (sidecar.ts:511-538, models.ts:176-183, sidecar.ts:90-98, llama.ts:49,460 + sidecar.ts:516-524, llama.ts:39,461, factory.ts:95 + factory.ts:754-761 rung 1a) plus **`--fit-target 512`** appended (the app never passes it; the binary's default is 1024 MiB))
4. **Memory at start:** device_info Vulkan0 23,546 / 24,822 MiB (probe read immediately before the spawn; while loaded a second `--list-devices` read 2,364 free) · nvidia-smi 773/24576 MiB used/total (23351 free) · desktop: **idle**: X desktop plus an idle ComfyUI server (256 MiB resident); `nvidia-smi` 773 MiB used before the spawn
5. **Fit outcome:** offloaded **64/66** layers to GPU (baseline: 62/66): still not full. Fit pass: `projected to use 21039 MiB of device memory vs. 21726 MiB of free device memory`, `cannot meet free memory target of 1064 MiB, need to reduce device memory by 376 MiB` (target = 512 + the 552 MiB MTP estimate), target 20,662 MiB, back-to-front fill: 65 layers = 20,775 (over), **64 layers = 20,531 MiB, 1,194 MiB free** (3.78 s) · buffers: Vulkan0 model 17,680.46 MiB + CPU_Mapped 1,164.63 MiB · KV: Vulkan0 512.00 MiB (`n_parallel` auto → 4, `kv_unified = true`) · RS: Vulkan0 1,720.69 + CPU 74.81 MiB · SWA: none · compute: Vulkan0 618.44 + Vulkan_Host 313.47 MiB · MTP draft context: KV 32.00 + compute 520.06 MiB · rung 1a + the varied fit target
6. **Peak use:** 22079 MiB used (nvidia-smi, 1 s polling; +21306 MiB over the pre-spawn figure; 21887 MiB right after load, 774 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 34.68 tok/s (`predicted_per_second`, 512 tokens in 14.8 s) · prefill 825.5 tok/s (`prompt_per_second`, 2015 tokens in 2.4 s) · load to /health 11.6 s
8. **Varied:** `--fit-target` 1024 → **512** (one thing)
9. **App view:** pending: the app's Copy report follows as a separate comment after the six starts
**Predicted vs measured:** Halving the fit margin buys two layers (64/66), not the full offload: the projection (21,039) still overshoots the 21,726 MiB the fit sees by 376 MiB against the reduced 1,064 target. Decode 34.7 tok/s (baseline 30.4, `-np 1` 51.0), prefill 825 tok/s. Peak 22,079 MiB (+21,306 over pre-spawn), the highest of the session, with 2,045 MiB free at peak: the margin the fit gives up is spent, not kept. §6.6's verdict for Q5 (not starred, does not fit under the app's launch) holds under this variant. (e): BAR heap usage 24.9 → 59.1 → 196.1 MiB (49.9 MiB of budget left).
<details><summary>Load-log excerpt (redacted, 73 lines)</summary>

```text
# leg1-fit-target-512 : argv: llama-server --host 127.0.0.1 --port 45271 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2 --fit-target 512
0.00.079.703 I cmn  common_param: device_info:
0.00.079.933 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.821.044 I srv    load_model: [spec] estimated memory usage of MTP context is 552.06 MiB
0.00.821.062 I cmn  common_init_: fitting params to device memory ...
0.00.821.063 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.821.066 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.539.710 I common_params_fit_impl: projected to use 21039 MiB of device memory vs. 21726 MiB of free device memory
0.01.539.714 I common_params_fit_impl: cannot meet free memory target of 1064 MiB, need to reduce device memory by 376 MiB
0.01.539.715 I common_params_fit_impl: context size set by user to 8192 -> no change
0.01.539.716 I common_params_fit_impl: id=0, target=20662 MiB
0.03.060.614 I common_params_fit_impl: memory for test allocation by device:
0.03.060.620 I common_params_fit_impl: id=0, n_layer= 0, n_part= 0, overflow_type=4, mem=   625 MiB
0.03.060.621 I common_params_fit_impl: filling dense layers back-to-front:
0.03.815.240 I common_params_fit_impl: memory for test allocation by device:
0.03.815.245 I common_params_fit_impl: id=0, n_layer=65, n_part= 0, overflow_type=4, mem= 20775 MiB
0.03.815.247 I common_params_fit_impl: start filling device 0, delta=65
0.04.603.125 I common_params_fit_impl: memory for test allocation by device:
0.04.603.132 I common_params_fit_impl: id=0, n_layer=64, n_part= 0, overflow_type=4, mem= 20531 MiB
0.04.603.135 I common_params_fit_impl: set ngl_per_device[0].n_layer=64
0.04.603.137 I common_params_fit_impl:   - Vulkan0 (NVIDIA GeForce RTX 3090): 64 layers,  20531 MiB used,   1194 MiB free
0.04.603.141 I common_fit_params: successfully fit params to free device memory
0.04.603.146 I common_fit_params: fitting params to free memory took 3.78 seconds
0.04.728.844 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23523 MiB free
0.04.974.628 I load: special tokens cache size = 33
0.05.070.519 I print_info: n_ctx_train           = 262144
0.05.070.533 I print_info: n_swa                 = 0
0.05.070.533 I print_info: is_swa_any            = 0
0.05.070.547 I print_info: n_ctx_orig_yarn       = 262144
0.05.070.560 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.06.391.838 I load_tensors: offloading output layer to GPU
0.06.391.843 I load_tensors: offloading 63 repeating layers to GPU
0.06.391.843 I load_tensors: offloaded 64/66 layers to GPU
0.06.391.848 I load_tensors:   CPU_Mapped model buffer size =  1164.63 MiB
0.06.391.849 I load_tensors:      Vulkan0 model buffer size = 17680.46 MiB
0.10.583.854 I llama_context: n_ctx         = 8192
0.10.583.854 I llama_context: n_ctx_seq     = 8192
0.10.583.856 I llama_context: kv_unified    = true
0.10.583.859 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.10.585.715 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.10.595.035 I llama_kv_cache:    Vulkan0 KV buffer size =   512.00 MiB
0.10.652.579 I llama_memory_recurrent:        CPU RS buffer size =    74.81 MiB
0.10.722.349 I llama_memory_recurrent:    Vulkan0 RS buffer size =  1720.69 MiB
0.10.722.378 I llama_memory_recurrent: size = 1795.50 MiB (     4 cells,  64 layers,  4 seqs  2 rs_seq), R (f32):   67.50 MiB, S (f32): 1728.00 MiB
0.10.768.471 W sched_reserve: layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan0 (usually due to missing support)
0.10.838.848 I sched_reserve:    Vulkan0 compute buffer size =   618.44 MiB
0.10.838.852 I sched_reserve: Vulkan_Host compute buffer size =   313.47 MiB
0.10.946.605 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q5km.gguf'
0.10.946.675 I llama_context: n_ctx         = 8192
0.10.946.676 I llama_context: n_ctx_seq     = 8192
0.10.946.681 I llama_context: kv_unified    = true
0.10.946.691 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.10.950.193 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.10.952.145 I llama_kv_cache:    Vulkan0 KV buffer size =    32.00 MiB
0.11.015.106 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.11.015.110 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.11.149.576 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.11.149.629 I spec common_specu: adding speculative implementation 'draft-mtp'
0.11.149.634 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.11.149.637 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.11.231.135 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.11.231.139 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.11.241.224 I srv    load_model: speculative decoding context initialized
0.11.241.227 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.11.241.235 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.11.241.236 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.11.241.237 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.11.241.311 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.11.285.033 I srv  update_slots: all slots are idle
0.14.250.651 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.31.456.700 I slot print_timing: id  3 | task 0 | draft acceptance = 0.69718 (  297 accepted /   426 generated), mean len =  2.39
0.31.456.725 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1    213    213, #gen drafts =    213, #acc drafts =   170, #gen tokens =    426, #acc tokens =   297, #mean acc len = 2.39, #acc rate/pos = (0.798, 0.596), dur(b,g,a) = 0.005, 1122.769, 0.517 ms
0.31.456.822 I srv  update_slots: all slots are idle
```
</details>
