### Start: i9-9900x-rtx-3090-24gb-128gb · leg 1 · mtp-off
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: RTX 3090 heap 0 device-local 24.00 GiB (budget 23,350 MiB idle), heap 1 host 94.11 GiB, heap 2 device-local **246 MiB BAR heap** (budget 221 MiB, 25 MiB in use idle)
3. **Argv:** `llama-server --host 127.0.0.1 --port 39613 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: the leg-7 Q5 baseline WITHOUT the MTP flags = the app's plain **rung 1** (factory.ts:764, `extraArgs: []`): `--host/--port/--model/--ctx-size/--threads` sidecar.ts:511-538; ctx 8192 models.ts:176-183; threads sidecar.ts:90-98; batch/ubatch llama.ts:49,460 + sidecar.ts:516-524; `--jinja --reasoning-format deepseek -lv 4` llama.ts:39. This is exactly what the app spawns when rung 1a is refused or latched off (factory.ts:569-597, factory.ts:123-137), or for a manifest without `speculative_decoding`)
4. **Memory at start:** device_info Vulkan0 23,546 / 24,822 MiB (probe read immediately before the spawn; while loaded a second `--list-devices` read 3,672 free) · nvidia-smi 774/24576 MiB used/total (23351 free) · desktop: **idle**: X desktop plus an idle ComfyUI server (256 MiB resident); `nvidia-smi` 774 MiB used before the spawn
5. **Fit outcome:** offloaded **66/66** layers to GPU: FULL offload (MTP baseline: 62/66). Fit pass: `projected to use 19842 MiB of device memory vs. 22916 MiB of free device memory`, `will leave 3074 >= 1024 MiB of free device memory, no changes needed` (0.81 s) · buffers: Vulkan0 model 18,163.06 MiB + CPU_Mapped 682.03 MiB (embedding table only) · KV: Vulkan0 512.00 MiB (`n_parallel` auto → 4, `kv_unified = true`, 4 slots) · **RS: Vulkan0 598.50 MiB** (4 cells, 64 layers, 4 seqs, **0 rs_seq**: R 22.50 + S 576.00 MiB; with MTP the same 4 sequences carried `2 rs_seq` and 1,795.50 MiB, so the draft head TRIPLES the recurrent state) · SWA: none · compute: Vulkan0 568.53 + Vulkan_Host 112.07 MiB · no draft context · **rung 1**
6. **Peak use:** 20768 MiB used (nvidia-smi, 1 s polling; +19994 MiB over the pre-spawn figure; 20646 MiB right after load, 774 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 30.71 tok/s (`predicted_per_second`, 512 tokens in 16.7 s) · prefill 1007.6 tok/s (`prompt_per_second`, 2015 tokens in 2.0 s) · load to /health 7.4 s
8. **Varied:** MTP on → **off** (one thing: `--spec-type draft-mtp --spec-draft-n-max 2` removed = rung 1 instead of rung 1a)
9. **App view:** pending: the app's Copy report follows as a separate comment after the six starts
**Predicted vs measured:** **Q5 fully offloads on a 24 GB card at 8k under rung 1.** What breaks the fit in the app's rung-1a launch is MTP itself: the draft head costs the 552 MiB draft context PLUS 1,197 MiB of extra recurrent state (rs_seq 2 × 4 sequences), ≈ 1.75 GiB, and that is the 859 MiB shortfall the baseline could not meet. Speed: decode **30.7 tok/s without MTP at 66/66**, statistically the same as the MTP baseline's 30.4 at 62/66, so on this card the rung-1a start of Q5 buys nothing: the draft head's gain is eaten by the four host layers it forces. Prefill 1,008 tok/s (best of the session). Peak 20,768 MiB (+19,994 over pre-spawn), 3,356 MiB free at peak. For §6.6 this means the Q4-versus-Q5 boundary at 24 GB is a property of the rung-1a launch (`-np` auto + MTP), not of the weights: Q5's 23,866 MiB threshold is right for what the app actually spawns first, and conservative by ~2 GiB for rung 1. Findings for #319: `-np 1` (51.0 tok/s, full offload, MTP kept) beats both. (e): BAR heap usage 24.9 → 26.4 (loaded) → 94.9 MiB during the request; the fully offloaded, non-MTP start touches the BAR heap least.
<details><summary>Load-log excerpt (redacted, 43 lines)</summary>

```text
# leg1-mtp-off : argv: llama-server --host 127.0.0.1 --port 39613 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.081.031 I cmn  common_param: device_info:
0.00.081.251 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.082.849 I cmn  common_init_: fitting params to device memory ...
0.00.082.850 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.082.857 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.889.640 I common_params_fit_impl: projected to use 19842 MiB of device memory vs. 22916 MiB of free device memory
0.00.889.644 I common_params_fit_impl: will leave 3074 >= 1024 MiB of free device memory, no changes needed
0.00.889.644 I common_fit_params: successfully fit params to free device memory
0.00.889.648 I common_fit_params: fitting params to free memory took 0.81 seconds
0.01.011.724 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23523 MiB free
0.01.280.856 I load: special tokens cache size = 33
0.01.375.295 I print_info: n_ctx_train           = 262144
0.01.375.307 I print_info: n_swa                 = 0
0.01.375.308 I print_info: is_swa_any            = 0
0.01.375.322 I print_info: n_ctx_orig_yarn       = 262144
0.01.375.335 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.02.698.929 I load_tensors: offloading output layer to GPU
0.02.698.933 I load_tensors: offloading 64 repeating layers to GPU
0.02.698.934 I load_tensors: offloaded 66/66 layers to GPU
0.02.698.939 I load_tensors:   CPU_Mapped model buffer size =   682.03 MiB
0.02.698.940 I load_tensors:      Vulkan0 model buffer size = 18163.06 MiB
0.06.900.759 I llama_context: n_ctx         = 8192
0.06.900.759 I llama_context: n_ctx_seq     = 8192
0.06.900.761 I llama_context: kv_unified    = true
0.06.900.765 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.06.902.515 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.06.912.100 I llama_kv_cache:    Vulkan0 KV buffer size =   512.00 MiB
0.06.948.525 I llama_memory_recurrent:    Vulkan0 RS buffer size =   598.50 MiB
0.06.948.565 I llama_memory_recurrent: size =  598.50 MiB (     4 cells,  64 layers,  4 seqs  0 rs_seq), R (f32):   22.50 MiB, S (f32):  576.00 MiB
0.07.032.589 I sched_reserve:    Vulkan0 compute buffer size =   568.53 MiB
0.07.032.593 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.07.146.868 I srv    load_model: speculative decoding will use checkpoints
0.07.146.873 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.07.146.886 I spec common_specu: no implementations specified for speculative decoding
0.07.146.887 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.07.146.894 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.07.146.894 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.07.146.894 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.07.146.994 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.07.193.138 I srv  update_slots: all slots are idle
0.09.991.952 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.28.663.231 I srv  update_slots: all slots are idle
```
</details>
