### Start: i9-9900x-rtx-3090-24gb-128gb · leg 7 · baseline-q4km
1. **File:** `qwen3.8-27b-ud-q4km` · `qwen3.8-27b-ud-q4km.gguf` · 16,464,440,224 B (15.33 GiB) · sha256 `322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: RTX 3090 heap 0 device-local 24.00 GiB (budget 22.83 GiB = 23,380 MiB idle), heap 1 host 94.11 GiB, heap 2 device-local **246 MiB BAR heap** (budget 221 MiB, 25 MiB in use idle)
3. **Argv:** `llama-server --host 127.0.0.1 --port 40403 --model <drive>/models/chat/qwen3.8-27b-ud-q4km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2` (source: `--host/--port/--model/--ctx-size/--threads` sidecar.ts:511-538 `buildArgs`; ctx 8192 = manifest `recommended_context_tokens` via models.ts:176-183 `launchContextTokens`; threads 10 = ⌊20/2⌋ sidecar.ts:90-98; `--batch-size/--ubatch-size 2048` = min(ctx, CHAT_MAX_PHYSICAL_BATCH) llama.ts:49,460 emitted at sidecar.ts:516-524; `--jinja --reasoning-format deepseek -lv 4` = CHAT_SERVER_ARGS llama.ts:39 (before the rung's extra args, llama.ts:461); `--spec-type draft-mtp --spec-draft-n-max 2` = MTP_SERVER_ARGS factory.ts:95 added by **rung 1a** factory.ts:754-761, whose walk-time gate factory.ts:569-597 passes here (15,702 MiB weights + 3,584 MiB headroom factory.ts:111 ≤ 23,575 MiB probed free): no `-ngl`, no `--device`, no `--fit-target`/`--fit-ctx`/`-np` (binary defaults: fit on, 1024 MiB target, `-np` auto → 4))
4. **Memory at start:** device_info Vulkan0 23,575 / 24,822 MiB (probe read immediately before the spawn; while the model was loaded a second `--list-devices` read 4,956 free) · nvidia-smi 744/24576 MiB used/total (23380 free) · desktop: **idle**: X desktop plus an idle ComfyUI server (256 MiB resident); `nvidia-smi` 744 MiB used before the spawn
5. **Fit outcome:** offloaded **66/66** layers to GPU · buffers: Vulkan0 model 15,009.20 MiB + CPU_Mapped 682.03 MiB (the token-embedding table stays host-mapped) · KV: Vulkan0 512.00 MiB (`n_parallel` auto → 4, `kv_unified = true`, 4 slots × 8,192) · **RS (recurrent state) 1,795.50 MiB on Vulkan0** (`llama_memory_recurrent`: 4 cells, 64 layers, 4 seqs, 2 rs_seq; R 67.50 + S 1,728.00 MiB: the hybrid 27B's linear-attention state, sized per SEQUENCE, so it is the term that scales with `-np`) · SWA: none (`n_swa = 0`) · compute: Vulkan0 568.53 MiB + Vulkan_Host 112.07 MiB · MTP draft context: KV 32.00 MiB + compute 520.06 MiB (server estimate 552.06 MiB) · fit pass: `projected to use 17885 MiB of device memory vs. 21755 MiB of free device memory: will leave 3870 >= 1576 MiB, no changes needed` (the fit target is 1,024 + the 552 MiB MTP estimate = 1,576; note the fit's own free figure, 21,755, is 1.8 GiB below the probe's 23,575: it is read after the Vulkan context exists) · **rung 1a** (GPU auto-offload + MTP)
6. **Peak use:** 19420 MiB used (nvidia-smi, 1 s polling; +18676 MiB over the pre-spawn figure; 19213 MiB right after load, 744 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 53.78 tok/s (`predicted_per_second`, 512 tokens in 9.5 s) · prefill 969.9 tok/s (`prompt_per_second`, 2015 tokens in 2.1 s) · load to /health 7.6 s
8. **Varied:** none (leg 7 baseline; the first attempt of this start, kept as `leg7-baseline-q4km-attempt1.*`, hit an end-of-sequence token after 213 decoded tokens: 52.9 tok/s, same peak 19,420 MiB: so the run was repeated with `ignore_eos` to reach the full 512; all later starts use `ignore_eos` as well)
9. **App view:** pending: the app is not launched beside a measurement; its Performance-screen Copy report follows as a separate comment after the six starts, with the starred model and the "Your model" estimates for both 27B quants next to these figures
**Predicted vs measured:** §6.6's prediction for this card HOLDS for Q4: the 24 GB row stars `qwen3.8-27b-ud-q4km` and it starts fully offloaded with 4,704 MiB still free at peak. Measured card use +18,676 MiB over the pre-spawn figure (19,420 peak) against the picker's need estimate of 20,246 MiB: the estimate is 1,570 MiB conservative (the 1,024 fit margin plus ~550 MiB), i.e. right side of the line. **Finding for (e):** the 246 MiB BAR heap IS used: its `usage` rose from 24.9 MiB idle to 100.3 MiB after load and 237.3 MiB during the request (8.8 MiB of budget left), returning to 24.9 after stop; the main heap's budget fell from 23,380 to 4,911 (loaded) and 4,704 MiB (request).
<details><summary>Load-log excerpt (redacted, 59 lines)</summary>

```text
# leg7-baseline-q4km : argv: llama-server --host 127.0.0.1 --port 40403 --model <drive>/models/chat/qwen3.8-27b-ud-q4km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2
0.00.079.655 I cmn  common_param: device_info:
0.00.079.867 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.797.474 I srv    load_model: [spec] estimated memory usage of MTP context is 552.06 MiB
0.00.797.493 I cmn  common_init_: fitting params to device memory ...
0.00.797.493 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.797.497 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.484.893 I common_params_fit_impl: projected to use 17885 MiB of device memory vs. 21755 MiB of free device memory
0.01.484.897 I common_params_fit_impl: will leave 3870 >= 1576 MiB of free device memory, no changes needed
0.01.484.898 I common_fit_params: successfully fit params to free device memory
0.01.484.901 I common_fit_params: fitting params to free memory took 0.69 seconds
0.01.603.941 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23552 MiB free
0.01.831.756 I load: special tokens cache size = 33
0.01.922.218 I print_info: n_ctx_train           = 262144
0.01.922.230 I print_info: n_swa                 = 0
0.01.922.230 I print_info: is_swa_any            = 0
0.01.922.244 I print_info: n_ctx_orig_yarn       = 262144
0.01.922.258 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.03.028.806 I load_tensors: offloading output layer to GPU
0.03.028.810 I load_tensors: offloading 64 repeating layers to GPU
0.03.028.811 I load_tensors: offloaded 66/66 layers to GPU
0.03.028.816 I load_tensors:   CPU_Mapped model buffer size =   682.03 MiB
0.03.028.817 I load_tensors:      Vulkan0 model buffer size = 15009.20 MiB
0.06.588.132 I llama_context: n_ctx         = 8192
0.06.588.132 I llama_context: n_ctx_seq     = 8192
0.06.588.133 I llama_context: kv_unified    = true
0.06.588.138 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.06.589.823 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.06.599.084 I llama_kv_cache:    Vulkan0 KV buffer size =   512.00 MiB
0.06.683.016 I llama_memory_recurrent:    Vulkan0 RS buffer size =  1795.50 MiB
0.06.683.042 I llama_memory_recurrent: size = 1795.50 MiB (     4 cells,  64 layers,  4 seqs  2 rs_seq), R (f32):   67.50 MiB, S (f32): 1728.00 MiB
0.06.767.179 I sched_reserve:    Vulkan0 compute buffer size =   568.53 MiB
0.06.767.184 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.06.852.461 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q4km.gguf'
0.06.852.524 I llama_context: n_ctx         = 8192
0.06.852.525 I llama_context: n_ctx_seq     = 8192
0.06.852.530 I llama_context: kv_unified    = true
0.06.852.562 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.06.855.937 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.06.857.946 I llama_kv_cache:    Vulkan0 KV buffer size =    32.00 MiB
0.06.918.197 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.06.918.202 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.07.038.001 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.07.038.050 I spec common_specu: adding speculative implementation 'draft-mtp'
0.07.038.055 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.07.038.061 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.07.119.668 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.07.119.672 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.07.130.043 I srv    load_model: speculative decoding context initialized
0.07.130.047 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.07.130.054 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.07.130.055 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.07.130.055 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.07.130.126 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.07.174.093 I srv  update_slots: all slots are idle
0.10.247.357 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.21.844.936 I slot print_timing: id  3 | task 0 | draft acceptance = 0.87838 (  325 accepted /   370 generated), mean len =  2.76
0.21.844.998 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1    185    185, #gen drafts =    185, #acc drafts =   171, #gen tokens =    370, #acc tokens =   325, #mean acc len = 2.76, #acc rate/pos = (0.924, 0.832), dur(b,g,a) = 0.003, 920.623, 0.413 ms
0.21.845.200 I srv  update_slots: all slots are idle
```
</details>
