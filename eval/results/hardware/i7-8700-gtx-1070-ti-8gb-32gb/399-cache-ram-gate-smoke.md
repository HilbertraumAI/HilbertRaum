### #399 D5 smoke: does `--cache-ram 0` reach the right models, and does the affected one still start?

Machine `i7-8700-gtx-1070-ti-8gb-32gb` (this repo's `00-preflight.md`), 2026-09-09, on the lite
test drive `E:`. Runtime `E:\runtime\llama.cpp\win\llama-server.exe` → `version: 9849 (799fcc04a)`,
the app pin. Branch `fix/399-prompt-cache-restore`.

The question this leg answers is narrow and it is the one the unit tests cannot answer: **does the
flag our code composes actually arrive at the process, on the model it should and only on that
model** — and does the affected model still start with it. It is not a re-run of the #399
architecture sweep (that is PR #445, on `i9-9900x-rtx-3090-24gb-128gb`).

Both sides of the family gate exist on this drive with real weights:

| manifest id | `family:` | rule says |
|---|---|---|
| `qwen3.5-9b-ud-q4kxl` | `qwen3.5` | AFFECTED → `--cache-ram 0` |
| `qwen3-14b-instruct-q4` | `qwen3` | unaffected → argv unchanged |

---

#### Leg 1 — the flag is real on the pin, and it is what disables the cache

Raw `llama-server`, no app. The server states the outcome itself, which is the honest read:

```text
# qwen3-4b-instruct-q4, --ctx-size 512 -lv 4 -np 1, NO cache flag
srv    load_model: prompt cache is enabled, size limit: 8192 MiB
srv    load_model: use `--cache-ram 0` to disable the prompt cache
srv          init: idle slots will be saved to prompt cache upon starting a new task

# same model, same argv + --cache-ram 0
srv    load_model: prompt cache is disabled - use `--cache-ram N` to enable it
srv          init: --cache-idle-slots requires --cache-ram, disabling
```

The second `init:` line is expected and harmless: `--cache-idle-slots` defaults on and depends on
the cache, and at `-np 1` there is no idle slot to save anyway.

#### Leg 2 — the AFFECTED model starts with the flag, and it is the architecture the sweep named

Raw `llama-server`, the app's full chat argv shape (`--ctx-size 8192 --batch-size 2048
--ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 --cache-ram 0`):

```text
load_tensors: offloaded 33/33 layers to GPU
llama_memory_recurrent:    Vulkan0 RS buffer size =    50.25 MiB
srv    load_model: prompt cache is disabled - use `--cache-ram N` to enable it
```

Starts clean and fully offloaded on an 8 GB card. The `llama_memory_recurrent` line is the
independent confirmation that this really is the affected architecture — **50.25 MiB, the exact
figure the sweep recorded for the 9B** (leg A, `issue399-arch-sweep-qwen3.5-9b-ud-q4kxl`).

#### Leg 3 — IN-APP: the gate picks the right model, read from the OS, not from our code

Dev build against `E:` (`HILBERTRAUM_DRIVE_ROOT`, `HILBERTRAUM_MANIFESTS_DIR`,
`HILBERTRAUM_PERF_LOG=1`), workspace unlocked, each model started from the app. The argv below is
`Get-CimInstance Win32_Process` — the command line **Windows** reports for the spawned child, not
anything the app printed:

```text
# unaffected — family qwen3
…\llama-server.exe --host 127.0.0.1 --port 65225 --model E:\models\chat\qwen3-14b-instruct-q4.gguf
  --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048
  --jinja --reasoning-format deepseek -lv 4 -np 1

# affected — family qwen3.5
…\llama-server.exe --host 127.0.0.1 --port 51155 --model E:\models\chat\qwen3.5-9b-ud-q4kxl.gguf
  --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048
  --jinja --reasoning-format deepseek -lv 4 -np 1 --cache-ram 0
```

**The unaffected model's argv is byte-identical to before #399** — the flag is appended, nothing is
displaced, and the rung args would still follow it. Both starts reported `healthy: true`,
`backend: gpu` (GTX 1070 Ti); the perf log records `runtime_ready` for the affected model at
64.5 s (a 5.97 GB weight read over USB 3, not a figure about this change).

Session ended by closing the window: `vault_lock_done` in `E:\logs\perf.log`, the workspace back to
`hilbertraum.sqlite.enc` with no `-wal` sidecar, no stray `llama-server` left, and the drive's
in-place workspace and active model unchanged.

---

#### What this leg does NOT show

- **No token was generated in-app on the affected model.** Both starts passed the app's own health
  round-trip, and leg 2 is a full raw start of the same weight with the same flag, but no chat turn
  was sent (the workspace on this drive is the owner's).
- **Nothing here re-measures the eviction.** Whether an evicted prefix is restored was settled on
  `i9-9900x-rtx-3090-24gb-128gb` (PR #445) and is not re-derived from an 8 GB card.
- **Only two families were exercised.** `gemma4` and `qwen3.8` are not on this drive; they are
  covered by `prompt-cache-rules.test.ts` and `llama-runtime.test.ts`, not by hardware.
- **The D3(a) arbiter delay was not exercised on hardware at all** — it is behavioural and pinned
  by tests on an injected clock; a real run would take 90 s per park to observe.
