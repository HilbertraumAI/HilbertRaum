## Measured evidence from a third 6 GB laptop card — and what lowering the gate would actually change

Session 2026-09-07 on `ryzen-7-5800h-rtx-3060-laptop-6gb-14gb` (Ryzen 7 5800H, 13.86 GiB RAM,
hybrid: AMD Radeon iGPU enumerated first + RTX 3060 Laptop). Full preflight and both starts are on
#318 ([preflight](https://github.com/HilbertraumAI/HilbertRaum/issues/318#issuecomment-5573550005) ·
[E2B](https://github.com/HilbertraumAI/HilbertRaum/issues/318#issuecomment-5573738311) ·
[9B](https://github.com/HilbertraumAI/HilbertRaum/issues/318#issuecomment-5573738834)); evidence on
branch `hw/318-ryzen-7-5800h-rtx-3060-laptop-6gb-14gb-20260907`. This comment answers only what
this issue asks for: **evidence about what such a card can actually hold.**

### 1. Third data point for the reporting gap

| card | probe (Vulkan) | vendor tool | vs the 6,144 gate |
|---|---|---|---|
| RTX 4050 Laptop | 5,921 | 5,772 (CUDA) | −223 |
| GTX 1660 SUPER | 5,746 | — | −398 |
| **RTX 3060 Laptop** (this one) | **5,994** | **6,144** (`nvidia-smi`) | **−150** |
| RTX 2060 | 6,144 | — | 0 (clears) |

Mechanism, for the record: this card exposes **one** `DEVICE_LOCAL` heap of 5,994 MiB and no
separate BAR heap, and the probe reports exactly that heap. On the RTX 3090 and GTX 1070 Ti the
probe figure was the **sum** of the device-local heaps (24,576 + 246, 8,059 + 214). So the shortfall
is not a driver quirk to be corrected — it is the card's real device-local size, and `nvidia-smi`'s
round 6,144 is the marketing figure.

### 2. What the card actually holds (the question this issue poses)

Both starts used the app's reconstructed rung-1 argv on the pinned b9849 build, 8k context,
idle desktop, app closed.

| | `gemma4-e2b-it-qat-q4` | `qwen3.5-9b-ud-q4kxl` |
|---|---|---|
| picker `estimateGraphicsNeedMib` | 4,746 MiB | 8,014 MiB |
| **llama.cpp's own projection** | **1,997 MiB** | **6,007 MiB** |
| fit's free reading | 5,223 MiB | 5,022 MiB |
| outcome | **36/36 layers — full offload**, 3,225 MiB left over | **18/33 — partial** (`need to reduce device memory by 2008 MiB`) |
| decode | **86.4 tok/s** | **5.23 tok/s** |
| for comparison, 8 GB GTX 1070 Ti | — | 20.2 tok/s at 31/33 |

So: the card comfortably holds the 4B/E2B class with ~3.2 GiB to spare, and cannot hold a 9B at 8k
in any useful sense. That is the capability answer.

**The picker's estimate is conservative by 2.4× on the E2B** (4,746 vs 1,997 actual). The cause is
structural, not a rounding error: the 15 % working-share is applied to the *whole* weight file
(3,147 MiB) while only 1,342 MiB of weights land on the card — the rest stays `CPU_Mapped` — and a
1,024 MiB margin is added on top of a fit that had 3,225 MiB spare. On the 9B the gap is 33 %
(8,014 vs 6,007). Neither gap flips a verdict on this card, but the margin the grid assumes is not
the margin that exists.

### 3. The finding that matters most for the decision

**The gate costs nothing in placement.** `--fit` put layers on this card in both starts regardless
of the gate — the runtime never consults it. What the gate actually decides on this machine is only:

| consumer | today (gate kept) | if the card counted |
|---|---|---|
| **picker / ★** | RAM pick → `gemma4-e2b-it-qat-q4` | rule C: base = the RAM pick = E2B, and it fits the 5,226 MiB budget (need 4,746) → **still `gemma4-e2b-it-qat-q4`** |
| profile bump | LITE | **BALANCED** (one step toward PRO) |
| basis word | "Arbeitsspeicher" | "Grafikspeicher" |
| tile rating | "Klein" | "Nutzbar" |

**On this machine, lowering the gate would not change which model is recommended at all.** It would
change the profile label, the basis word and the rating. That decouples the decision from the
recommendation risk the issue worries about — at least at 14 GB RAM with this card; a machine with
more RAM, where the RAM pick is larger than the card can hold, is where rule C would actually bite,
and this session cannot speak to that.

### 4. One consumer would be decoupled by PR #375

The issue notes the constant is shared by three consumers and that a change hits all three. With
PR #375 (**open**, green CI — not merged at the time of writing) the graphics tile **names** the
card and its memory independently of the gate. The report below was taken from a source build
running that branch, so it shows the post-#375 behaviour, not today's master: the Performance
screen reads
`Grafikspeicher: 5,9 GB VRAM (NVIDIA GeForce RTX 3060 Laptop GPU)` while still recommending on the
`Arbeitsspeicher` basis. The gate would still supply the *rating* ("Klein" vs "Nutzbar"), but once
that PR lands, "my card is invisible" — the complaint that motivates much of the pressure to lower
the gate — stops being a reason to lower it, leaving the decision to rest on the picker and the
profile bump alone.

### 5. What this does not settle

- One card, one driver (591.74), one RAM size. The profile bump to BALANCED is **untested** — nothing
  here says a 6 GB laptop deserves that label, only that the bump is what would happen.
- **Where** a lowered gate should sit is still open. 5,700 admits all three measured laptop cards;
  5,900 admits the 3060 and 4050 but not the 1660 SUPER; the pinned boundary test (5,921 out /
  6,144 in) would need recomputing either way, along with the §6.6 grid.
- The interesting rule-C case — a machine whose RAM pick is *bigger* than a sub-gate card can hold —
  is not this machine and remains unmeasured.

### 6. Suggested §6.6 amendment if the gate is kept

The "6 GB row (N8)" note is right that such a card is a RAM machine for the picker. It is worth
adding the measured half: **the runtime offloads to it anyway**, so the row describes a
recommendation basis, not where the model runs — and on this card the RAM pick fully offloaded and
decoded at 86.4 tok/s.
