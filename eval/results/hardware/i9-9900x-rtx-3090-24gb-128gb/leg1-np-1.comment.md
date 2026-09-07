### Start: i9-9900x-rtx-3090-24gb-128gb · leg 1 · np-1
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: RTX 3090 heap 0 device-local 24.00 GiB (budget 23,353 MiB idle), heap 1 host 94.11 GiB, heap 2 device-local **246 MiB BAR heap** (budget 221 MiB, 25 MiB in use idle)
3. **Argv:** `llama-server --host 127.0.0.1 --port 46249 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2 -np 1` (source: identical to the leg-7 Q5 baseline (sidecar.ts:511-538, models.ts:176-183, sidecar.ts:90-98, llama.ts:49,460 + sidecar.ts:516-524, llama.ts:39,461, factory.ts:95 + factory.ts:754-761 rung 1a) plus **`-np 1`** appended (the app never passes `-np`; the binary's default is auto → 4 slots with a unified KV))
4. **Memory at start:** device_info Vulkan0 23,548 / 24,822 MiB (probe read immediately before the spawn; while loaded a second `--list-devices` read 3,206 free) · nvidia-smi 771/24576 MiB used/total (23353 free) · desktop: **idle**: X desktop plus an idle ComfyUI server (256 MiB resident); `nvidia-smi` 771 MiB used before the spawn
5. **Fit outcome:** offloaded **66/66** layers to GPU: FULL offload (baseline: 62/66). Fit pass: `projected to use 19692 MiB of device memory vs. 23075 MiB of free device memory`, `will leave 3383 >= 1576 MiB of free device memory, no changes needed` (0.64 s) · buffers: Vulkan0 model 18,163.06 MiB + CPU_Mapped 682.03 MiB (embedding table only) · KV: Vulkan0 512.00 MiB (`n_slots = 1`, `kv_unified = false`, `n_seq_max = 1`) · **RS: Vulkan0 448.88 MiB** (1 cell, 64 layers, 1 seq, 2 rs_seq: R 16.88 + S 432.00 MiB; the baseline's 4-sequence state was 1,795.50 MiB, so `-np 1` gives back 1,347 MiB of recurrent state) · SWA: none · compute: Vulkan0 568.18 + Vulkan_Host 112.07 MiB · MTP draft context: KV 32.00 + compute 520.06 MiB (estimate 552.06) · rung 1a + `-np 1`
6. **Peak use:** 21248 MiB used (nvidia-smi, 1 s polling; +20477 MiB over the pre-spawn figure; 21046 MiB right after load, 773 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 51.00 tok/s (`predicted_per_second`, 512 tokens in 10.0 s) · prefill 903.1 tok/s (`prompt_per_second`, 2015 tokens in 2.2 s) · load to /health 8.0 s
8. **Varied:** `-np` auto (→ 4) → **1** (one thing)
9. **App view:** pending: the app's Copy report follows as a separate comment after the six starts
**Predicted vs measured:** **The one variant that makes Q5 fit a 24 GB card.** With one slot the hybrid model's per-sequence recurrent state drops from 1,795.50 to 448.88 MiB, the fit needs no reduction, all 66 layers land on the card, and decode is 51.0 tok/s (baseline 30.4; the fully offloaded Q4 baseline did 53.8), prefill 903 tok/s (baseline 809). Peak 21,248 MiB (+20,477 over pre-spawn), 2,876 MiB free at peak. So §6.6's "Q5 does not fit 24 GB" holds only under the app's `-np` auto launch; this is the leg the #319 decision (`-np` auto versus 1) was waiting for. Note the fit's own free reading was 23,075 MiB here against 21,755 in the three `-np` auto starts: the fit reads free memory after its own initial test allocation, which is 1.3 GiB smaller at one sequence. (e): BAR heap usage 24.9 → 59.1 (loaded) → 196.1 MiB during the request (49.9 MiB of budget left), i.e. this fully offloaded start leaned on the BAR heap less than the partial ones.
<details><summary>Load-log excerpt (redacted, 55 lines)</summary>

```text
# leg1-np-1 : argv: llama-server --host 127.0.0.1 --port 46249 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2 -np 1
0.00.078.586 I cmn  common_param: device_info:
0.00.814.428 I srv    load_model: [spec] estimated memory usage of MTP context is 552.06 MiB
0.00.814.450 I cmn  common_init_: fitting params to device memory ...
0.00.814.451 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.814.456 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.452.292 I common_params_fit_impl: projected to use 19692 MiB of device memory vs. 23075 MiB of free device memory
0.01.452.296 I common_params_fit_impl: will leave 3383 >= 1576 MiB of free device memory, no changes needed
0.01.452.298 I common_fit_params: successfully fit params to free device memory
0.01.452.303 I common_fit_params: fitting params to free memory took 0.64 seconds
0.01.573.916 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23525 MiB free
0.01.825.350 I load: special tokens cache size = 33
0.01.915.695 I print_info: n_ctx_train           = 262144
0.01.915.715 I print_info: n_swa                 = 0
0.01.915.716 I print_info: is_swa_any            = 0
0.01.915.753 I print_info: n_ctx_orig_yarn       = 262144
0.01.915.784 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.03.241.714 I load_tensors: offloading output layer to GPU
0.03.241.719 I load_tensors: offloading 64 repeating layers to GPU
0.03.241.719 I load_tensors: offloaded 66/66 layers to GPU
0.03.241.724 I load_tensors:   CPU_Mapped model buffer size =   682.03 MiB
0.03.241.725 I load_tensors:      Vulkan0 model buffer size = 18163.06 MiB
0.07.460.821 I llama_context: n_ctx         = 8192
0.07.460.821 I llama_context: n_ctx_seq     = 8192
0.07.460.823 I llama_context: kv_unified    = false
0.07.460.827 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.07.461.948 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.07.471.054 I llama_kv_cache:    Vulkan0 KV buffer size =   512.00 MiB
0.07.503.185 I llama_memory_recurrent:    Vulkan0 RS buffer size =   448.88 MiB
0.07.503.198 I llama_memory_recurrent: size =  448.88 MiB (     1 cells,  64 layers,  1 seqs  2 rs_seq), R (f32):   16.88 MiB, S (f32):  432.00 MiB
0.07.587.011 I sched_reserve:    Vulkan0 compute buffer size =   568.18 MiB
0.07.587.016 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.07.640.687 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q5km.gguf'
0.07.640.764 I llama_context: n_ctx         = 8192
0.07.640.764 I llama_context: n_ctx_seq     = 8192
0.07.640.769 I llama_context: kv_unified    = false
0.07.640.781 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.07.641.867 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.07.642.624 I llama_kv_cache:    Vulkan0 KV buffer size =    32.00 MiB
0.07.702.806 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.07.702.810 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.07.759.962 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 8192, kv_unified = 'false'
0.07.759.993 I spec common_specu: adding speculative implementation 'draft-mtp'
0.07.759.996 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.07.759.998 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.07.838.528 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.07.838.534 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.07.845.042 I srv    load_model: speculative decoding context initialized
0.07.845.045 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.07.845.120 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.07.889.607 I srv  update_slots: all slots are idle
0.10.585.566 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.22.856.327 I slot print_timing: id  0 | task 0 | draft acceptance = 0.76049 (  308 accepted /   405 generated), mean len =  2.52
0.22.856.349 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1    203    203, #gen drafts =    203, #acc drafts =   172, #gen tokens =    405, #acc tokens =   308, #mean acc len = 2.52, #acc rate/pos = (0.847, 0.670), dur(b,g,a) = 0.004, 1014.965, 0.448 ms
0.22.856.439 I srv  update_slots: all slots are idle
```
</details>
