### Start: i9-9900x-rtx-3090-24gb-128gb · leg 7 · harness-control-q5km
1. **File:** `qwen3.8-27b-ud-q5km` · `qwen3.8-27b-ud-q5km.gguf` · 19,771,509,664 B (18.41 GiB) · sha256 `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · `run-start.mjs` in this directory, app closed, `--bin` = the drive's own `runtime/llama.cpp/linux/llama-server` (`--version` reads `9849 (799fcc04a)`) · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: `vulkaninfo` returned no heap block in this session, so `heaps.csv` is empty for this start
3. **Argv:** `llama-server --host 127.0.0.1 --port 46689 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2` (source: the post-#386 harness argv, unchanged and with **no** `--extra` (the harness has carried `-np 1` itself since #388), i.e. byte-identical to the app-spawned line in `leg7-app-q5km-ctx8192` apart from the port. This start exists as a **control**: it re-runs the #318 `leg1-np-1` measurement exactly, so today's app figures can be read against a same-harness, same-day number instead of against a figure from another day)
4. **Memory at start:** device_info Vulkan0 23,808 / 24,822 MiB (probe immediately before the spawn; 3,465 free while loaded) · nvidia-smi 552/24576 MiB used/total (23575 free) · desktop: **idle**: X11 desktop plus an idle ComfyUI server (256 MiB resident), app closed; `nvidia-smi` 552 MiB used before the spawn
5. **Fit outcome:** offloaded **66/66** layers to GPU. Fit pass: `projected to use 19692 MiB of device memory vs. 23335 MiB of free device memory`, `will leave 3643 >= 1576 MiB of free device memory, no changes needed` · buffers: Vulkan0 model 18,163.06 MiB + CPU_Mapped 682.03 MiB · KV: Vulkan0 512.00 + 32.00 MiB (draft), `n_slots = 1`, `kv_unified = 'false'` · RS: Vulkan0 448.88 MiB (1 cells, 64 layers, 1 seqs 2 rs_seq) · compute 568.18 + 112.07 host, draft 520.06 · rung 1a. Identical to the app start in every load-time figure
6. **Peak use:** 21019 MiB used (nvidia-smi, 1 s polling; +20467 MiB over the pre-spawn figure; 20828 MiB right after load, 552 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 38.04 tok/s (`predicted_per_second`, 512 tokens in 13.5 s) · prefill 642.7 tok/s (`prompt_per_second`, 2015 tokens in 3.1 s) · load to /health 9.1 s
8. **Varied:** nothing: the #318 `leg1-np-1` run repeated on 2026-09-08
9. **App view:** n/a, the app was closed for this control
**Predicted vs measured:** **The control answers why decode misses the leg's ≈51 tok/s, and the answer is not the app.** Same binary, same argv, same 2,015-token prompt, same `n_predict 512 / ignore_eos / temp 0 / cache_prompt false`, same MTP draft acceptance to three digits (**308/405**, exactly what `leg1-np-1` recorded on 2026-09-07), and decode comes out at **38.04 tok/s against that run's 50.99**, prefill at **642.7 against 903.1**. A second repeat 90 s later read 38.76 / 648.8. Placement is unchanged (66/66, peak 21,019 MiB against 21,248 then), so the ~25 % is throughput, not layers. `nvidia-smi` sampled every 2 s across that repeat (`leg7-clock-state-2026-09-08.csv`) shows the card never reaching its P0 state: of the ten in-load samples the **memory clock reads 5001 MHz in eight and 9501 MHz in two** (9501 is this 3090's P0 figure), the SM clock spans 780 to 1440 MHz, and board power peaks at 244 W of a 350 W limit with no throttle reason active (`HW Slowdown`, `SW Power Cap`, `SW/HW Thermal Slowdown` all Not Active, 41 to 51 °C). Decode on a 27B is memory-bandwidth-bound, so a memory clock stuck near half fits the observed drop. **Open, and outside this leg:** why the card sits in that state today. Anyone re-measuring tok/s on this rig should check the memory clock first; the 51.0 figure in §6.6 was taken with the card at P0 and this session cannot reproduce it.
<details><summary>Load-log excerpt (redacted, 55 lines)</summary>

```text
# leg7-harness-control-q5km : argv: llama-server --host 127.0.0.1 --port 46689 --model <drive>/models/chat/qwen3.8-27b-ud-q5km.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --spec-type draft-mtp --spec-draft-n-max 2
0.00.114.420 I cmn  common_param: device_info:
0.00.872.802 I srv    load_model: [spec] estimated memory usage of MTP context is 552.06 MiB
0.00.872.819 I cmn  common_init_: fitting params to device memory ...
0.00.872.819 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.872.824 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.529.277 I common_params_fit_impl: projected to use 19692 MiB of device memory vs. 23335 MiB of free device memory
0.01.529.281 I common_params_fit_impl: will leave 3643 >= 1576 MiB of free device memory, no changes needed
0.01.529.282 I common_fit_params: successfully fit params to free device memory
0.01.529.286 I common_fit_params: fitting params to free memory took 0.66 seconds
0.01.658.955 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23785 MiB free
0.01.875.363 I load: special tokens cache size = 33
0.01.963.707 I print_info: n_ctx_train           = 262144
0.01.963.721 I print_info: n_swa                 = 0
0.01.963.721 I print_info: is_swa_any            = 0
0.01.963.735 I print_info: n_ctx_orig_yarn       = 262144
0.01.963.751 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.03.296.601 I load_tensors: offloading output layer to GPU
0.03.296.604 I load_tensors: offloading 64 repeating layers to GPU
0.03.296.605 I load_tensors: offloaded 66/66 layers to GPU
0.03.296.611 I load_tensors:   CPU_Mapped model buffer size =   682.03 MiB
0.03.296.612 I load_tensors:      Vulkan0 model buffer size = 18163.06 MiB
0.08.021.436 I llama_context: n_ctx         = 8192
0.08.021.436 I llama_context: n_ctx_seq     = 8192
0.08.021.438 I llama_context: kv_unified    = false
0.08.021.443 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.08.022.889 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.08.032.922 I llama_kv_cache:    Vulkan0 KV buffer size =   512.00 MiB
0.08.078.411 I llama_memory_recurrent:    Vulkan0 RS buffer size =   448.88 MiB
0.08.078.425 I llama_memory_recurrent: size =  448.88 MiB (     1 cells,  64 layers,  1 seqs  2 rs_seq), R (f32):   16.88 MiB, S (f32):  432.00 MiB
0.08.162.110 I sched_reserve:    Vulkan0 compute buffer size =   568.18 MiB
0.08.162.115 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.08.242.340 I srv    load_model: creating MTP draft context against the target model '<drive>/models/chat/qwen3.8-27b-ud-q5km.gguf'
0.08.242.368 I llama_context: n_ctx         = 8192
0.08.242.368 I llama_context: n_ctx_seq     = 8192
0.08.242.370 I llama_context: kv_unified    = false
0.08.242.374 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.08.244.872 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.08.245.919 I llama_kv_cache:    Vulkan0 KV buffer size =    32.00 MiB
0.08.306.824 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.08.306.828 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.08.407.215 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 8192, kv_unified = 'false'
0.08.407.258 I spec common_specu: adding speculative implementation 'draft-mtp'
0.08.407.261 I spec common_specu: - n_max=2, n_min=0, p_min=0.00, n_embd=5120, backend_sampling=1
0.08.407.263 I spec common_specu: - gpu_layers=-1, cache_k=f16, cache_v=f16, ctx_tgt=yes, ctx_dft=yes, devices=[default]
0.08.485.313 I sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB
0.08.485.317 I sched_reserve: Vulkan_Host compute buffer size =   112.07 MiB
0.08.495.089 I srv    load_model: speculative decoding context initialized
0.08.495.093 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.08.495.189 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.08.538.506 I srv  update_slots: all slots are idle
0.10.806.283 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.27.402.328 I slot print_timing: id  0 | task 0 | draft acceptance = 0.76049 (  308 accepted /   405 generated), mean len =  2.52
0.27.402.358 I spec common_specu: statistics        draft-mtp: #calls(b,g,a) =    1    203    203, #gen drafts =    203, #acc drafts =   172, #gen tokens =    405, #acc tokens =   308, #mean acc len = 2.52, #acc rate/pos = (0.847, 0.670), dur(b,g,a) = 0.003, 1396.591, 0.467 ms
0.27.402.481 I srv  update_slots: all slots are idle
```
</details>
