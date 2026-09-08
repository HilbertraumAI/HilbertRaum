### Start: i9-9900x-rtx-3090-24gb-128gb · leg 7 · app-q5km
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · **spawned by the app**, not by the harness: dev build off `hw/391-i9-9900x-rtx-3090-24gb-128gb-20260908` (origin/master e07b9893, so #386 + #387 + #390 are all in), `HILBERTRAUM_DRIVE_ROOT` = the app config directory, `HILBERTRAUM_LLAMA_BIN` = a tee wrapper that logs the argv and execs the drive's own `runtime/llama.cpp/linux/llama-server` (`--version` reads `9849 (799fcc04a)`) unchanged · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: not sampled on this start (`vulkaninfo` returned no heap block in this session); the `nvidia-smi` figures below and the probe's own free reading carry the memory story
3. **Argv:** `llama-server --host 127.0.0.1 --port 42121 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 32768 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2` (source: **not reconstructed: read out of `/proc/<pid>/cmdline` of the process the app spawned.** `--ctx-size 32768` is the workspace's `contextTokensOverride` (`models.ts:176-183` `launchContextTokens`: override ?? manifest 8192), a pre-existing user setting on this drive, so this is what the app actually launches here; the companion start `leg7-app-q5km-ctx8192` clears the override to reach the manifest's 8,192. `-np 1` is present and comes from `CHAT_SERVER_ARGS` (#386), `--spec-type draft-mtp --spec-draft-n-max 2` from `factory.ts:95` rung 1a, and the app's own log says so: `Runtime backend selected … started via rung 1a (GPU auto-offload + MTP speculative decoding) (backend: gpu)`)
4. **Memory at start:** device_info Vulkan0 23,665 / 24,822 MiB (probe read immediately before the app started the model; a second `--list-devices` while loaded read 1,340 free) · nvidia-smi 696/24576 MiB used/total (23431 free) · desktop: **idle**: X11 desktop plus an idle ComfyUI server (256 MiB resident) and the Electron app itself; `nvidia-smi` 696 MiB used before the spawn
5. **Fit outcome:** offloaded **66/66** layers to GPU, the fit changed nothing. Fit pass: `projected to use 21324 MiB of device memory vs. 23158 MiB of free device memory`, `will leave 1834 >= 1672 MiB of free device memory, no changes needed` · buffers: Vulkan0 model 18,163.06 MiB + **CPU_Mapped 682.03 MiB** (the embedding table alone; this is a FULL offload, so the figure is clean) · KV at 32k: Vulkan0 2,048.00 MiB main + 128.00 MiB MTP draft (`n_slots = 1`, `n_ctx_slot = 32768`, `kv_unified = 'false'`) · RS (recurrent state): Vulkan0 **448.88 MiB (1 cells, 64 layers, 1 seqs 2 rs_seq)**, one sequence, and `2 rs_seq` confirms MTP is still on · compute: Vulkan0 664.18 + Vulkan_Host 208.07 MiB, MTP draft compute 520.06 MiB · **rung 1a**, chosen by the app
6. **Peak use:** 22965 MiB used (nvidia-smi, 1 s polling; +22269 MiB over the pre-spawn figure; 22749 MiB right after load, 679 MiB after stop) during 2509-token prefill / 916-token decode
7. **Speed:** decode 33.31 tok/s (`predicted_per_second`, 916 tokens in 27.5 s) · prefill 585.6 tok/s (`prompt_per_second`, 2509 tokens in 4.3 s) · load to /health 10.4 s
8. **Varied:** nothing varied: this is the app's own launch as the machine is configured (context override 32,768)
9. **App view:** ★ **`qwen3.8-27b-ud-q5km` (graphics memory)**. Performance screen > Copy report, taken on this build before the start: `Recommended for the next start: Qwen3.8 27B UD-Q5_K_M (graphics memory)`; the raw live pick behind it is `{"modelId":"qwen3.8-27b-ud-q5km","basis":"discrete"}`. The same line in the #318 session (master 740b0f27, pre-#386) read **Qwen3.8 27B UD-Q4_K_M**. Full text in `app-report-2026-09-08-performance-screen.txt`
**Predicted vs measured:** **Placement: PASS, and it is the app's own choice.** #391 predicted `offloaded 66/66`, `llama_memory_recurrent: size = 448.88 MiB (… 1 seqs 2 rs_seq)` and the star flipping to Q5; all three hold, and they hold at **32,768** context, four times the 8,192 the leg assumed, with 1,834 MiB still left over the fit's target. The four-slot #318 start of the same model at 8k managed 62/66. **Decode does NOT reproduce the ≈51 tok/s** the leg predicts: 33.31 tok/s over 916 tokens (the app's own speed line reads `33 tok/s · 4.5 s to first token · 916 tokens`), prefill 585.6 tok/s over 2,509. Two things separate that from leg 1's 51.0. This is a real chat turn, so MTP draft acceptance is 0.481 (449/934) against leg 1's 0.760; and, the larger part, **the card itself is slower today**: the #318 harness re-run unchanged on this machine now reads 38.0 tok/s at leg 1's own 0.760 acceptance (`leg7-harness-control-q5km`). Not an app or placement regression; the clock evidence is in that start's comment.
<details><summary>Load-log excerpt (redacted, 62 lines)</summary>

```text
ARGV: <drive>/runtime/llama.cpp/linux/llama-server --host 127.0.0.1 --port 42121 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 32768 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2
0.00.128.433 I cmn  common_param: device_info:
0.00.970.225 I srv    load_model: [spec] estimated memory usage of MTP context is 648.06 MiB
0.00.970.242 I cmn  common_init_: fitting params to device memory ...
0.00.970.242 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.970.246 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.694.796 I common_params_fit_impl: projected to use 21324 MiB of device memory vs. 23158 MiB of free device memory
0.01.694.801 I common_params_fit_impl: will leave 1834 >= 1672 MiB of free device memory, no changes needed
0.01.694.801 I common_fit_params: successfully fit params to free device memory
0.01.694.805 I common_fit_params: fitting params to free memory took 0.72 seconds
0.01.825.330 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23608 MiB free
0.02.093.365 I load: special tokens cache size = 33
0.02.185.545 I print_info: n_ctx_train           = 262144
0.02.185.559 I print_info: n_swa                 = 0
0.02.185.559 I print_info: is_swa_any            = 0
0.02.185.573 I print_info: n_ctx_orig_yarn       = 262144
0.02.185.587 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.03.524.650 I load_tensors: offloading output layer to GPU
0.03.524.654 I load_tensors: offloading 64 repeating layers to GPU
0.03.524.654 I load_tensors: offloaded 66/66 layers to GPU
0.03.524.659 I load_tensors:   CPU_Mapped model buffer size =   682.03 MiB
0.03.524.660 I load_tensors:      Vulkan0 model buffer size = 18163.06 MiB
0.08.246.756 I llama_context: n_ctx         = 32768
0.08.246.756 I llama_context: n_ctx_seq     = 32768
0.08.246.757 I llama_context: kv_unified    = false
0.08.246.761 I llama_context: n_ctx_seq (32768) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.08.248.514 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.08.294.587 I llama_kv_cache:    Vulkan0 KV buffer size =  2048.00 MiB
0.08.434.271 I llama_memory_recurrent:    Vulkan0 RS buffer size =   448.88 MiB
0.08.434.317 I llama_memory_recurrent: size =  448.88 MiB (     1 cells,  64 layers,  1 seqs  2 rs_seq), R (f32):   16.88 MiB, S (f32):  432.00 MiB
0.08.544.269 I sched_reserve:    Vulkan0 compute buffer size =   664.18 MiB
0.08.544.274 I sched_reserve: Vulkan_Host compute buffer size =   208.07 MiB
0.08.818.669 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q5km.gguf'
0.08.818.744 I llama_context: n_ctx         = 32768
0.08.818.745 I llama_context: n_ctx_seq     = 32768
0.08.818.751 I llama_context: kv_unified    = false
0.08.818.761 I llama_context: n_ctx_seq (32768) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.08.820.437 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.08.823.339 I llama_kv_cache:    Vulkan0 KV buffer size =   128.00 MiB
0.08.903.602 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.08.903.606 I sched_reserve: Vulkan_Host compute buffer size =   208.07 MiB
0.09.090.356 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 32768, kv_unified = 'false'
0.09.090.468 I spec common_specu: adding speculative implementation 'draft-mtp'
0.09.090.483 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.09.090.490 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.09.202.002 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.09.202.006 I sched_reserve: Vulkan_Host compute buffer size =   208.07 MiB
0.09.223.612 I srv    load_model: speculative decoding context initialized
0.09.223.620 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 32768
0.09.223.838 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.09.278.110 I srv  update_slots: all slots are idle
0.09.557.559 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 32768, n_keep = 0, task.n_tokens = 13
0.10.246.260 I slot print_timing: id  0 | task 0 | draft acceptance = 1.00000 (    4 accepted /     4 generated), mean len =  3.00
0.10.246.291 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1      2      2, #gen drafts =      2, #acc drafts =     2, #gen tokens =      4, #acc tokens =     4, #mean acc len = 3.00, #acc rate/pos = (1.000, 1.000), dur(b,g,a) = 0.003, 18.721, 0.007 ms
0.10.246.327 I srv  update_slots: all slots are idle
0.15.515.212 I srv   prompt_save:  - saving prompt with length 20, total state size = 150.955 MiB (draft: 0.079 MiB)
0.15.733.551 I slot   operator(): id  0 | task 6 | new prompt, n_ctx_slot = 32768, n_keep = 0, task.n_tokens = 2509
0.15.733.555 I slot   operator(): id  0 | task 6 | forcing full prompt re-processing due to lack of cache data (likely due to SWA or hybrid/recurrent memory, see https://github.com/ggml-org/llama.cpp/pull/13194#issuecomment-2868343055)
0.15.733.556 I slot   operator(): id  0 | task 6 | erased invalidated context checkpoint (pos_min = 8, pos_max = 8, n_tokens = 9, n_swa = 0, pos_next = 0, size = 149.661 MiB)
0.47.515.840 I slot print_timing: id  0 | task 6 | draft acceptance = 0.48073 (  449 accepted /   934 generated), mean len =  1.96
0.47.515.865 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    2    469    469, #gen drafts =    469, #acc drafts =   306, #gen tokens =    938, #acc tokens =   453, #mean acc len = 1.97, #acc rate/pos = (0.652, 0.313), dur(b,g,a) = 0.005, 2702.789, 1.099 ms
0.47.515.977 I srv  update_slots: all slots are idle
```
</details>
