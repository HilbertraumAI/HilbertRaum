### Start: i9-9900x-rtx-3090-24gb-128gb · leg 7 · app-q5km-ctx8192
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · **spawned by the app**, same dev build and tee wrapper as `leg7-app-q5km`, with the workspace's `contextTokensOverride` cleared to null for the duration and restored to 32,768 afterwards (recorded in the JSON) · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: not sampled on this start; the `nvidia-smi` figures and the probe's free reading carry the memory story
3. **Argv:** `llama-server --host 127.0.0.1 --port 40935 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2` (source: read out of `/proc/<pid>/cmdline`. With the override cleared, `launchContextTokens` (`models.ts:176-183`) falls through to the manifest's `recommended_context_tokens: 8192`, so the argv is now **exactly the leg's reference line**: `--host 127.0.0.1 --port <n> --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2`. App log: `Runtime backend selected … started via rung 1a (GPU auto-offload + MTP speculative decoding) (backend: gpu)`)
4. **Memory at start:** device_info Vulkan0 23,745 / 24,822 MiB (probe read immediately before the start; while loaded a second `--list-devices` read 3,386 free) · nvidia-smi 616/24576 MiB used/total (23512 free) · desktop: **idle**: X11 desktop plus an idle ComfyUI server (256 MiB resident) and the Electron app itself; `nvidia-smi` 616 MiB used before the spawn
5. **Fit outcome:** offloaded **66/66** layers to GPU, the fit changed nothing. Fit pass: `projected to use 19692 MiB of device memory vs. 23283 MiB of free device memory`, **`will leave 3591 >= 1576 MiB of free device memory, no changes needed`**, the exact 1,576 MiB rung-1a target #391 names, cleared by 2,015 MiB · buffers: Vulkan0 model 18,163.06 MiB + **CPU_Mapped 682.03 MiB** (full offload, so this is the clean host-mapped-weights figure) · KV: Vulkan0 512.00 MiB main + 32.00 MiB MTP draft (`n_slots = 1`, `n_ctx_slot = 8192`, `kv_unified = 'false'`) · RS: Vulkan0 **448.88 MiB (1 cells, 64 layers, 1 seqs 2 rs_seq)**, byte for byte the figure #391 predicts, and `2 rs_seq` confirms MTP is on · compute: Vulkan0 568.18 + Vulkan_Host 112.07 MiB, MTP draft compute 520.06 MiB · **rung 1a**, chosen by the app
6. **Peak use:** 21072 MiB used (nvidia-smi, 1 s polling; +20456 MiB over the pre-spawn figure; 20895 MiB right after load, 603 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 37.43 tok/s (`predicted_per_second`, 512 tokens in 13.7 s) · prefill 664.7 tok/s (`prompt_per_second`, 2015 tokens in 3.0 s) · load to /health 10.3 s
8. **Varied:** `contextTokensOverride` cleared (32,768 to the manifest's 8,192) so the start is directly comparable with the #318 8k starts; restored afterwards. Nothing else varied
9. **App view:** ★ `qwen3.8-27b-ud-q5km` (graphics memory), same Copy report as `leg7-app-q5km`, in `app-report-2026-09-08-performance-screen.txt`
**Predicted vs measured:** **The leg's placement prediction is confirmed line by line.** 66/66 (against 62/66 at four slots), `will leave 3591 >= 1576 MiB`, `448.88 MiB (… 1 seqs 2 rs_seq)`, `n_slots = 1`, all as written, under the app's own rung-1a launch. Peak card use 21,072 MiB (+20,456 over the pre-spawn 616), 3,055 MiB still free at peak. **Decode is 37.43 tok/s, not ≈51**: 512 tokens in 13.68 s after a 2,015-token prefill at 664.7 tok/s, with the same synthetic request the #318 harness uses and essentially the same MTP acceptance (307/407 = 0.754 against leg 1's 308/405 = 0.760). The gap is the machine, not the app: the #318 harness re-run unchanged, app closed, reads 38.04 tok/s (`leg7-harness-control-q5km`), 1.6 % from this app start and 25 % below the 51.0 it produced on 2026-09-07. Prefill moved the same way (664.7 and 642.7 today against 903.1 then), i.e. a uniform throughput drop, not a placement effect. §6.6's Q5-on-24-GB row should take the 66/66 placement from here and treat today's tok/s as a same-day pair (app 37.4, harness 38.0), not as a revision of the 51.0 figure.
<details><summary>Load-log excerpt (redacted, 61 lines)</summary>

```text
ARGV: <drive>/runtime/llama.cpp/linux/llama-server --host 127.0.0.1 --port 40935 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2
0.00.122.316 I cmn  common_param: device_info:
0.00.958.443 I srv    load_model: [spec] estimated memory usage of MTP context is 552.06 MiB
0.00.958.462 I cmn  common_init_: fitting params to device memory ...
0.00.958.462 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.958.466 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.685.556 I common_params_fit_impl: projected to use 19692 MiB of device memory vs. 23283 MiB of free device memory
0.01.685.561 I common_params_fit_impl: will leave 3591 >= 1576 MiB of free device memory, no changes needed
0.01.685.561 I common_fit_params: successfully fit params to free device memory
0.01.685.565 I common_fit_params: fitting params to free memory took 0.73 seconds
0.01.819.829 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23733 MiB free
0.02.090.937 I load: special tokens cache size = 33
0.02.182.847 I print_info: n_ctx_train           = 262144
0.02.182.861 I print_info: n_swa                 = 0
0.02.182.862 I print_info: is_swa_any            = 0
0.02.182.876 I print_info: n_ctx_orig_yarn       = 262144
0.02.182.890 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.03.501.692 I load_tensors: offloading output layer to GPU
0.03.501.696 I load_tensors: offloading 64 repeating layers to GPU
0.03.501.697 I load_tensors: offloaded 66/66 layers to GPU
0.03.501.701 I load_tensors:   CPU_Mapped model buffer size =   682.03 MiB
0.03.501.702 I load_tensors:      Vulkan0 model buffer size = 18163.06 MiB
0.08.462.473 I llama_context: n_ctx         = 8192
0.08.462.474 I llama_context: n_ctx_seq     = 8192
0.08.462.475 I llama_context: kv_unified    = false
0.08.462.479 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.08.464.879 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.08.476.630 I llama_kv_cache:    Vulkan0 KV buffer size =   512.00 MiB
0.08.536.799 I llama_memory_recurrent:    Vulkan0 RS buffer size =   448.88 MiB
0.08.536.830 I llama_memory_recurrent: size =  448.88 MiB (     1 cells,  64 layers,  1 seqs  2 rs_seq), R (f32):   16.88 MiB, S (f32):  432.00 MiB
0.08.622.818 I sched_reserve:    Vulkan0 compute buffer size =   568.18 MiB
0.08.622.823 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.08.978.389 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q5km.gguf'
0.08.978.453 I llama_context: n_ctx         = 8192
0.08.978.454 I llama_context: n_ctx_seq     = 8192
0.08.978.459 I llama_context: kv_unified    = false
0.08.978.472 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.08.980.775 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.08.982.212 I llama_kv_cache:    Vulkan0 KV buffer size =    32.00 MiB
0.09.042.330 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.09.042.334 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.09.133.243 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 8192, kv_unified = 'false'
0.09.133.285 I spec common_specu: adding speculative implementation 'draft-mtp'
0.09.133.287 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.09.133.289 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.09.211.842 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.09.211.846 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.09.221.757 I srv    load_model: speculative decoding context initialized
0.09.221.765 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.09.221.889 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.09.265.588 I srv  update_slots: all slots are idle
0.09.518.806 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 13
0.10.206.986 I slot print_timing: id  0 | task 0 | draft acceptance = 1.00000 (    4 accepted /     4 generated), mean len =  3.00
0.10.207.010 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1      2      2, #gen drafts =      2, #acc drafts =     2, #gen tokens =      4, #acc tokens =     4, #mean acc len = 3.00, #acc rate/pos = (1.000, 1.000), dur(b,g,a) = 0.003, 18.757, 0.007 ms
0.10.207.045 I srv  update_slots: all slots are idle
0.12.485.906 I srv   prompt_save:  - saving prompt with length 20, total state size = 150.955 MiB (draft: 0.079 MiB)
0.12.682.811 I slot   operator(): id  0 | task 6 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.12.682.813 I slot   operator(): id  0 | task 6 | erased invalidated context checkpoint (pos_min = 8, pos_max = 8, n_tokens = 9, n_swa = 0, pos_next = 0, size = 149.661 MiB)
0.29.392.175 I slot print_timing: id  0 | task 6 | draft acceptance = 0.75430 (  307 accepted /   407 generated), mean len =  2.50
0.29.392.193 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    2    206    206, #gen drafts =    206, #acc drafts =   173, #gen tokens =    411, #acc tokens =   311, #mean acc len = 2.51, #acc rate/pos = (0.840, 0.670), dur(b,g,a) = 0.004, 1461.076, 0.505 ms
0.29.392.271 I srv  update_slots: all slots are idle
```
</details>
