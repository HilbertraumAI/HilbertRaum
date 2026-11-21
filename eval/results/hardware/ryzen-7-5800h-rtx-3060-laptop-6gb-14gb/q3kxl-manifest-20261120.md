# Qwen3.5 9B UD-Q3_K_XL: start, speed and memory on the 6 GB laptop (2026-11-20)

Evidence for the new manifest `model-manifests/chat/qwen3.5-9b-ud-q3kxl.yaml`. The start-and-answer
runs below load the model through the app, so they double as the manifest's in-app smoke test.

## Setup

| | |
|---|---|
| Machine | `ryzen-7-5800h-rtx-3060-laptop-6gb-14gb` (see `00-preflight.md`): Ryzen 7 5800H, 16 GB installed, the app reads 14; RTX 3060 Laptop 6 GB (probe 5,994 MiB, 5,226 MiB free) plus the AMD iGPU |
| OS / power | Windows 11, mains power, Legion Performance Mode, machine idle |
| App | dev build of branch `feat/qwen35-9b-ud-q3kxl-manifest` (on `master` 5dc4e058), dev workspace, llama.cpp **b12110** Vulkan build |
| File | `Qwen3.5-9B-UD-Q3_K_XL.gguf`, 5,053,834,464 bytes, SHA-256 `aae0879e…062f`, equal to the Hugging Face LFS metadata; the app's own checksum pass verified it (36.2 s) |

Method, per model: start through the app's renderer API, one warm-up plus three Diagnostics
benchmarks (64 tokens, decode-only `predicted_per_second`), then one chat answer in Fast mode to a
long prompt (about 6,000 characters of `docs/product-vision.md`, "summarise in one sentence"). Host memory is the llama-server process's peak working set and peak private bytes.
Card memory is the peak of `nvidia-smi` memory.used (sampled every 500 ms, idle reading 0 MiB) and
the process's `GPU Process Memory` dedicated / shared usage. Layers are the app's own parse of the
load log (`settings.modelPlacements`).

## CPU only ("Use GPU acceleration" off, every start `backend=cpu`)

| Model | tok/s (3 runs) | First token, long prompt | Decode, long prompt | Start | Peak working set | Peak private |
|---|---|---|---|---|---|---|
| Qwen3.5 9B UD-Q3_K_XL | 6.0 / 5.6 / 5.5 | 31.8 s | 5.9 | 6.2 s | 6.67 GiB | 4.44 GiB |
| Qwen3.5 9B UD-Q4_K_XL | 5.1 / 5.1 / 5.1 | 32.4 s | 5.0 | 15.5 s | 6.06 GiB | 4.96 GiB |

## Card on (rung 1, GPU auto-offload)

Second pass, with the Vulkan shaders already compiled. On the first pass the very first long prompt
of a new model type paid the shader compile: 45.6 s to the first token for the Q3 (2.0 s on the
second pass), 9.4 s for the Q4 (2.6 s).

| Model | Layers on the card | tok/s (3 runs) | First token, long prompt | Decode, long prompt | Start | Card peak | Dedicated / shared | Host peak working set |
|---|---|---|---|---|---|---|---|---|
| Qwen3.5 9B UD-Q3_K_XL | 25 / 33 | 13.8 / 15.7 / 17.0 | 2.0 s | 17.5 | 10.9 s | 4,252 MiB | 4.16 / 0.07 GiB | 5.38 GiB |
| Qwen3.5 9B UD-Q4_K_XL | 20 / 33 | 8.8 / 8.6 / 8.6 | 2.6 s | 10.2 | 11.8 s | 4,193 MiB | 4.10 / 0.06 GiB | 6.26 GiB |

First pass, same models: Q3 15.5 / 15.3 / 15.1 tok/s, Q4 8.8 / 8.8 / 9.0.

Reading:

- The Q3 does not fully fit this card under the app's launch. The fit keeps its 1 GiB margin off
  the 5,226 MiB free figure and stops at 25 of 33 layers (3,409 MiB of weights on the card,
  1,400 MiB in host memory); the process peaked at 4,252 MiB on the card.
- Because it is a partial offload, the `CPU_Mapped model buffer size` line (1,399.82 MiB) includes
  the layers that stayed in host memory and is not the manifest's `host_mapped_weights_mib`. The
  field stays absent until a full-offload start measures it.
- No spill into shared GPU memory on either 9B (0.06 to 0.07 GiB shared, the same order as the
  small models that fit fully).
- The app's automatic pick on this machine stayed `gemma4-e2b-it-qat-q4` for every run.

## Prompt-cache smoke (`tests/manual/prompt-cache-smoke.test.ts`, #512)

Run on the same machine and runtime, model `qwen3.5-9b-ud-q3kxl.gguf`, the app's chat argv
(rung 1, 25/33 layers):

```
[prompt-cache] A: prompt_n 1851 of 1851 prompt tokens
[prompt-cache] A returned after B: prompt_n 52 of 1899 (cache_n 1847) → RESTORED (2.7 % re-prefilled)
[prompt-cache] reference (cache_prompt: false): prompt_n 1899
[prompt-cache] restored answer == reference (50 chars)
[prompt-cache] ADVICE: leave disable_prompt_cache unset
```

`disable_prompt_cache` stays unset.

Side note: the smoke needs memory headroom beside the desktop. A first attempt with about 9 GB of
other applications open drove free physical memory to 403 MiB before it was stopped; it passed with
6.1 GB free.
