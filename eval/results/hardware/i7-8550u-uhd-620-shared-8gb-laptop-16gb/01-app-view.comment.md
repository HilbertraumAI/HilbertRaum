### App view: `i7-8550u-uhd-620-shared-8gb-laptop-16gb` · no leg · integrated-only picker check

Follow-up to the preflight above, same machine, same day. No leg and no `llama-server` start of
my own — this is the app's own Performance report, run twice to isolate the one thing the
preflight could only predict: **does `looksIntegrated` actually keep an 8,119 MiB integrated
device out of the budget-device slot on real hardware?** The pinned Kit was removed from this
machine between the preflight and this check, so both runs are `npm run dev` off `origin/master`
at `740b0f27`; the runtime under test is therefore the dev root's own llama.cpp, not the Kit's
b9849. Nothing here depends on the runtime build — the picker reasons from the probe and the
settings flags.

**Why two runs.** The first report could not answer the question: the GPU was switched off in
Settings, which short-circuits §6.6 rule 1 *before* budget-device selection. Both paths end at
memory class `cpu`, and the report cannot tell them apart, so the name gate was never exercised.
The second run is the same check with the GPU switched back on.

| | run 1 | run 2 |
|---|---|---|
| `gpuMode` | `"off"` (set 2026-09-04) | **`"auto"`** |
| `gpuAutoDisabled` / `gpuLastError` | `false` / `null` | `false` / `null` |
| `gpuProbe` device | `Intel(R) UHD Graphics 620`, 8119 / 7457 MiB | same, re-probed 11:45:51Z |
| `speedIdentity.memoryClass` | `cpu` | **`cpu`** |
| `speedIdentity.deviceName` | `null` | **`null`** |
| `gpu` / `gpuVramMb` | `null` / `null` | **`null` / `null`** |
| Graphics tile | "Grafikbeschleunigung ist aus" (`kind:'off'`) | **"Keine"** (`kind:'none'`) |
| Basis of the ★ | Arbeitsspeicher (RAM) | **Arbeitsspeicher (RAM)** |
| ★ | `gemma4-e2b-it-qat-q4` | `gemma4-e2b-it-qat-q4` |
| Profile | LITE | TINY |
| decode | 3 tok/s | 2.9 tok/s |

**Predicted vs measured: the §6.6 prediction for this class HOLDS, and the mechanism is now
verified rather than assumed.** In run 2 the GPU is on (`gpuMode: "auto"`, no auto-disable, no
error) and the device is freshly probed at **8,119 MiB — which clears `USABLE_VRAM_MB` (6,144)**.
The picker still resolves `memoryClass: "cpu"` with `deviceName: null` and no budget device. With
the size gate passed, the only thing that can produce that verdict is the name gate:
`looksIntegrated("Intel(R) UHD Graphics 620")` matching `/uhd/i`, so `isUsefulDevice` is false
(`shared/gpu-rules.ts:37`, `:68`). The recommendation basis stays **Arbeitsspeicher**, never
Grafikspeicher. The #308 audit's finding-R6 bias note ("a false positive only costs a too-small
recommendation") does the intended work here on a 2017-era part, not just on the
current-generation Intel names R6 was written for.

**One prediction of mine was wrong, and it was about wording, not behaviour.** In the preflight
follow-up I said the tile would name the device as "Integriert, gemeinsamer Speicher · 7,9 GB
gemeinsam". It says **"Keine"**. That is correct by design and NOT a defect: `currentGpu` is
`nextStartMemoryFor(...).device`, i.e. the budget device, which is null with no usable card
(`registerBenchmarkIpc.ts:957`, `:984`), so `graphicsFigure` never reaches its `kind:'device'`
branch and the `perf.tile.graphics.integrated` wording is unreachable on a machine whose ONLY
device is integrated. I record the correction so the earlier comment is not read as a miss.

**The ★ is `gemma4-e2b-it-qat-q4`, not the 9B the RAM path alone would give** — the §6.5 speed
step-down fired, as the preflight's "unless a stored §6.5 speed step-down applies" caveat
allowed. Both warnings are in the record and name the measured model, so the lowered pick is not
silent (issues #52 / #95 working as intended).

**CPU-only figures worth having** (this machine cannot contribute a card leg, but it is a clean
CPU-path datapoint at the small end of the RAM range):

- `qwen3.5-9b-ud-q4kxl`, 8,192 ctx, backend `cpu`, i7-8550U (4c/8t): **3 tok/s → 2.9 tok/s decode**,
  `speedBasis {"basis":"timings","tokens":64}` — real `timings`, not the chunk fallback.
- Placement: `backend:"cpu"`, `cpuModelMb: 7384.75`, `cpuKvMb: 256`, `gpuModelMb: null`.
- Effective read from a real model load: **491.3 MB/s** (5,966,095,584 B in 12,144 ms,
  `source: "model_load"`), against a synthetic `driveReadMbps` of 1,880.4 / 1,468.9 in the same
  records — the report surfaces the effective figure, which is the honest one.

**Cross-check for the preflight:** the app's stored `gpuProbe` reads
`Intel(R) UHD Graphics 620, totalMb 8119, freeMb 7457` — byte-identical to what
`llama-server --list-devices` reported in the preflight above. The app's probe and the CLI probe
agree exactly on this device.

**Two observations, neither a defect, both checked against the source before writing:**

1. The **copy report** renders `kind:'none'` as bare "Keine" (`perf.rating.none`), while the tile
   itself carries the fuller "Keine nutzbare Grafikkarte. Modelle laufen auf dem Prozessor."
   (`perf.tile.graphics.none`). A reader of a pasted report from an integrated-only machine
   therefore cannot tell that a probed 8,119 MiB device was present and deliberately excluded —
   the information exists in `gpuProbe`. Worth knowing when reading hardware-session reports.
2. The profile flipped LITE → TINY between two runs that differ only by 3.0 vs 2.9 tok/s.
   That is a threshold crossing, not a ratchet: `classifyProfile` recomputes from
   `(ramGb, gpuUseful, tps)` each run and `VERY_LOW_TOKENS_PER_SECOND` is exactly 3
   (`shared/performance-rules.ts:19`, `benchmark.ts:137-145`), so `3 < 3` is false and
   `2.9 < 3` is true. Repeated checks cannot compound it. The ★ was `gemma4-e2b-it-qat-q4`
   either way, so the flip changed only the profile label and the "smallest, quickest model"
   warning. Noted because two runs minutes apart on one machine straddled it.

The GPU was switched back on only for run 2 and is the operator's setting either side; `gpuMode`
was `"off"` before this check and is theirs to restore.

<details><summary>Copy report, run 2 (verbatim, German UI)</summary>

```text
Dieser Computer
Geschwindigkeit: 2,9 Token / Sek. (Gemessen mit Qwen3.5 9B (UD-Q4_K_XL) am 7.9.2026, über 64 Token)
Arbeitsspeicher: 15,9 GB RAM
CPU: Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz (8 Kerne)
Grafikspeicher: Keine
Laufwerk: 491,3 MB/s lesen
Zugewiesenes Profil: TINY
Empfohlen für den nächsten Start: Gemma 4 E2B Instruct QAT Q4 (Arbeitsspeicher)
Empfohlen zum Zeitpunkt der Prüfung: Gemma 4 E2B Instruct QAT Q4
Kontextgröße: 8.192 Token
Letzter Lauf: 7.9.2026, 13:46:14
- Dieses Gerät eignet sich am besten für das kleinste, schnellste Modell. Größere Modelle laufen möglicherweise langsam.
- Die Textgenerierung war mit dem geladenen Modell (qwen3.5-9b-ud-q4kxl) sehr langsam, daher wurde das zugewiesene Profil eine Stufe herabgesetzt. Wenn dieses Modell größer ist als das empfohlene, starte das empfohlene Modell und führe den Benchmark erneut aus.
- Die Textgenerierung lag mit dem geladenen Modell (qwen3.5-9b-ud-q4kxl) bei etwa 2.9 Tokens pro Sekunde, daher wurde die Modell-Empfehlung eine Größenstufe herabgesetzt, damit Antworten auf diesem Computer schnell bleiben.
```
</details>
