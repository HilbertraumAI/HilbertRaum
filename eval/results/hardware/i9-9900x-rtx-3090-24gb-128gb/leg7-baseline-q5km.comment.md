### Start: i9-9900x-rtx-3090-24gb-128gb · leg 7 · baseline-q5km
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: RTX 3090 heap 0 device-local 24.00 GiB (budget 23,380 MiB idle), heap 1 host 94.11 GiB, heap 2 device-local **246 MiB BAR heap** (budget 221 MiB, 25 MiB in use idle)
3. **Argv:** `llama-server --host 127.0.0.1 --port 39365 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2` (source: identical to the leg-7 Q4 baseline (sidecar.ts:511-538, models.ts:176-183, sidecar.ts:90-98, llama.ts:49,460 + sidecar.ts:516-524, llama.ts:39,461, factory.ts:95 + factory.ts:754-761 rung 1a); the rung-1a gate factory.ts:569-597 passes for this file too (18,856 MiB weights + 3,584 headroom = 22,440 ≤ 23,575 probed free), so the app's first attempt is rung 1a with MTP on; nothing varied. **This start is also the leg-1 baseline** the four varied-one-thing starts below are compared with)
4. **Memory at start:** device_info Vulkan0 23,575 / 24,822 MiB (probe read immediately before the spawn; while the model was loaded a second `--list-devices` read 2,779 free) · nvidia-smi 744/24576 MiB used/total (23380 free) · desktop: **idle**: X desktop plus an idle ComfyUI server (256 MiB resident); `nvidia-smi` 744 MiB used before the spawn
5. **Fit outcome:** offloaded **62/66** layers to GPU: the fit REDUCED the offload. Fit pass: `projected to use 21039 MiB of device memory vs. 21755 MiB of free device memory`, `cannot meet free memory target of 1576 MiB, need to reduce device memory by 859 MiB`, `context size set by user to 8192 -> no change`, target 20,179 MiB, dense layers filled back-to-front: 63 layers = 20,200 MiB (over), **62 layers = 19,922 MiB, 1,832 MiB free** → `ngl_per_device[0].n_layer=62` (4.47 s) · buffers: Vulkan0 model 17,134.26 MiB + CPU_Mapped 1,710.83 MiB (the embedding table plus the four host layers) · KV: Vulkan0 480.00 + CPU 32.00 MiB (`n_parallel` auto → 4, `kv_unified = true`, 4 slots × 8,192) · RS (recurrent state): Vulkan0 1,683.28 + CPU 112.22 MiB (1,795.50 total: 4 cells, 64 layers, 4 seqs, 2 rs_seq) · SWA: none (`n_swa = 0`) · compute: Vulkan0 625.22 MiB (the teardown warning says the real one was 679.12) + Vulkan_Host 313.47 MiB · MTP draft context: KV 32.00 MiB + compute 520.06 MiB (estimate 552.06) · **rung 1a** (GPU auto-offload + MTP). This is protocol question (d), the rig's "UD-Q5 62/66 start", reproduced under the app's exact argv
6. **Peak use:** 21578 MiB used (nvidia-smi, 1 s polling; +20834 MiB over the pre-spawn figure; 21250 MiB right after load, 811 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 30.38 tok/s (`predicted_per_second`, 512 tokens in 16.9 s) · prefill 809.2 tok/s (`prompt_per_second`, 2015 tokens in 2.5 s) · load to /health 12.2 s
8. **Varied:** none (leg 7 baseline for Q5 = leg 1 baseline)
9. **App view:** pending: the app's Performance-screen Copy report follows as a separate comment after the six starts
**Predicted vs measured:** §6.6's prediction for this card HOLDS for Q5 as well: the picker does NOT star `qwen3.8-27b-ud-q5km` on this probe (need 23,866 > 23,575 free) and indeed Q5 does not fully offload at 8k under the app's launch: 62/66 layers, and the four host layers cost decode 30.4 tok/s against Q4's 53.8 (prefill 809 vs 970). Peak card use 21,578 MiB (+20,834 over pre-spawn), 2,547 MiB still free at peak, i.e. the fit kept its 1,832 MiB reserve. What decides the boundary is the fit's OWN free reading, 21,755 MiB, which is 1,820 MiB below the probe's 23,575 (read after the Vulkan context is up): projected 21,039 + the 1,576 target would have fit the probe's figure. Without MTP the target drops to 1,024 and the projection by ~552 MiB, so the MTP-off variant (below) is the one that tells whether Q5 fully offloads on a 24 GB card at all. **(e) again:** BAR heap usage 24.9 → 169.9 (loaded) → 238.9 MiB during the request (7.1 MiB of budget left); main-heap budget 23,380 → 2,873 → 2,545 MiB. After stop `nvidia-smi` read 811 MiB (67 MiB above the pre-spawn 744; the idle ComfyUI process, not a leak of the server, which exited 0).
<details><summary>Load-log excerpt (redacted, 78 lines)</summary>

```text
# leg7-baseline-q5km : argv: llama-server --host 127.0.0.1 --port 39365 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2
0.00.077.197 I cmn  common_param: device_info:
0.00.077.482 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.798.499 I srv    load_model: [spec] estimated memory usage of MTP context is 552.06 MiB
0.00.798.516 I cmn  common_init_: fitting params to device memory ...
0.00.798.517 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.798.521 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.501.918 I common_params_fit_impl: projected to use 21039 MiB of device memory vs. 21755 MiB of free device memory
0.01.501.922 I common_params_fit_impl: cannot meet free memory target of 1576 MiB, need to reduce device memory by 859 MiB
0.01.501.922 I common_params_fit_impl: context size set by user to 8192 -> no change
0.01.501.923 I common_params_fit_impl: id=0, target=20179 MiB
0.03.042.840 I common_params_fit_impl: memory for test allocation by device:
0.03.042.846 I common_params_fit_impl: id=0, n_layer= 0, n_part= 0, overflow_type=4, mem=   625 MiB
0.03.042.848 I common_params_fit_impl: filling dense layers back-to-front:
0.03.759.490 I common_params_fit_impl: memory for test allocation by device:
0.03.759.496 I common_params_fit_impl: id=0, n_layer=65, n_part= 0, overflow_type=4, mem= 20775 MiB
0.03.759.498 I common_params_fit_impl: start filling device 0, delta=65
0.04.501.470 I common_params_fit_impl: memory for test allocation by device:
0.04.501.476 I common_params_fit_impl: id=0, n_layer=63, n_part= 0, overflow_type=4, mem= 20200 MiB
0.04.501.478 I common_params_fit_impl: set ngl_per_device_high[0].n_layer=63
0.05.264.359 I common_params_fit_impl: memory for test allocation by device:
0.05.264.365 I common_params_fit_impl: id=0, n_layer=62, n_part= 0, overflow_type=4, mem= 19922 MiB
0.05.264.367 I common_params_fit_impl: set ngl_per_device[0].n_layer=62
0.05.264.368 I common_params_fit_impl:   - Vulkan0 (NVIDIA GeForce RTX 3090): 62 layers,  19922 MiB used,   1832 MiB free
0.05.264.370 I common_fit_params: successfully fit params to free device memory
0.05.264.373 I common_fit_params: fitting params to free memory took 4.47 seconds
0.05.393.248 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23552 MiB free
0.05.612.707 I load: special tokens cache size = 33
0.05.703.009 I print_info: n_ctx_train           = 262144
0.05.703.023 I print_info: n_swa                 = 0
0.05.703.023 I print_info: is_swa_any            = 0
0.05.703.037 I print_info: n_ctx_orig_yarn       = 262144
0.05.703.052 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.07.074.372 I load_tensors: offloading output layer to GPU
0.07.074.376 I load_tensors: offloading 61 repeating layers to GPU
0.07.074.376 I load_tensors: offloaded 62/66 layers to GPU
0.07.074.381 I load_tensors:   CPU_Mapped model buffer size =  1710.83 MiB
0.07.074.382 I load_tensors:      Vulkan0 model buffer size = 17134.26 MiB
0.11.141.938 I llama_context: n_ctx         = 8192
0.11.141.938 I llama_context: n_ctx_seq     = 8192
0.11.141.939 I llama_context: kv_unified    = true
0.11.141.943 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.11.143.593 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.11.143.702 I llama_kv_cache:        CPU KV buffer size =    32.00 MiB
0.11.167.570 I llama_kv_cache:    Vulkan0 KV buffer size =   480.00 MiB
0.11.237.076 I llama_memory_recurrent:        CPU RS buffer size =   112.22 MiB
0.11.304.669 I llama_memory_recurrent:    Vulkan0 RS buffer size =  1683.28 MiB
0.11.304.698 I llama_memory_recurrent: size = 1795.50 MiB (     4 cells,  64 layers,  4 seqs  2 rs_seq), R (f32):   67.50 MiB, S (f32): 1728.00 MiB
0.11.351.501 W sched_reserve: layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan0 (usually due to missing support)
0.11.421.745 I sched_reserve:    Vulkan0 compute buffer size =   625.22 MiB
0.11.421.749 I sched_reserve: Vulkan_Host compute buffer size =   313.47 MiB
0.11.548.585 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q5km.gguf'
0.11.548.650 I llama_context: n_ctx         = 8192
0.11.548.651 I llama_context: n_ctx_seq     = 8192
0.11.548.656 I llama_context: kv_unified    = true
0.11.548.674 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.11.552.128 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.11.554.118 I llama_kv_cache:    Vulkan0 KV buffer size =    32.00 MiB
0.11.614.730 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.11.614.734 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.11.771.206 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.11.771.239 I spec common_specu: adding speculative implementation 'draft-mtp'
0.11.771.242 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.11.771.243 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.11.850.342 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.11.850.346 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.11.860.743 I srv    load_model: speculative decoding context initialized
0.11.860.747 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.11.860.757 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.11.860.757 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.11.860.758 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.11.860.849 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.11.917.147 I srv  update_slots: all slots are idle
0.14.746.300 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.34.089.489 I slot print_timing: id  3 | task 0 | draft acceptance = 0.77945 (  311 accepted /   399 generated), mean len =  2.55
0.34.089.513 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1    200    200, #gen drafts =    200, #acc drafts =   170, #gen tokens =    399, #acc tokens =   311, #mean acc len = 2.55, #acc rate/pos = (0.850, 0.705), dur(b,g,a) = 0.004, 1011.730, 0.465 ms
0.34.089.605 I srv  update_slots: all slots are idle
0.35.029.294 W ~llama_context:    Vulkan0 compute buffer size of 679.1215 MiB, does not match expectation of 625.2188 MiB
```
</details>
