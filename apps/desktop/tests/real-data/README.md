# Real-data harnesses (LOCAL-ONLY, gitignored corpus)

Manual, **gated** harnesses that measure deterministic behaviour against **real user data**.
They never run in `npm test`, make **zero model/network calls**, and print **aggregate metrics
only**. The data they read is gitignored and **must never be committed** (CLAUDE.md "never commit
user data" / PDF-plan **D57**).

## `pdf-goldset.realdata.test.ts` — Stage-1 bank-statement gold set (Phase 31, plan §3.4/§6, gate D52)

Runs real German bank statements through the **actual Stage-1 path**
(`PdfParser.parse({ layout:true, maxPages })` → `bankStatementAnalysisHandler`) and reports the
metrics the **D52 Stage-2 decision** depends on:

- **transaction recall** (extracted rows ÷ true rows, micro + macro),
- **figure exact-match** (persisted opening/closing == printed),
- **completeness-gate pass rate** (how often `opening + Σ == closing` proved out),
- **hallucinated-figure count** — asserted **0**,
- **partial-total-presented count** — asserted **0** (the D56 cardinal property).

Recall + exact-match are *measured and logged* (the input to D52); the two D56 safety invariants and
"0 model calls" are *hard-asserted* (they must hold on any data).

### Corpus layout

The corpus dir is `$HILBERTRAUM_PDF_GOLDSET_DIR`, else the gitignored `./corpus` next to this file.
**Recommended: point it OFF-REPO** (e.g. `F:\paid-gpu-smoke-drive\pdf-goldset`) so real financial
data never sits inside the repo tree — defense-in-depth on top of the `.gitignore` entry.

Drop matched pairs into it:

```
corpus/
  hvb-giro-2024-01.pdf
  hvb-giro-2024-01.expected.json
  sparkasse-2024-q1.pdf
  sparkasse-2024-q1.expected.json
  ...
```

Each `<name>.expected.json` is the hand-counted ground truth for `<name>.pdf`:

```json
{
  "trueRowCount": 23,
  "currency": "EUR",
  "openingBalance": 1234.56,
  "closingBalance": 2345.67,
  "maxPages": 200,
  "notes": "HVB Giro, Jan 2024 — your own bookkeeping; never printed by the harness"
}
```

- `trueRowCount` — **required**: the number of transaction rows actually printed on the statement.
- `openingBalance` / `closingBalance` — the **printed** balances. Supply them to measure figure
  exact-match and to exercise the completeness gate (without them the gate downgrades by design).
- `currency`, `maxPages`, `notes` — optional. `notes` is never emitted in any output.

### Running

```bash
# bash
HILBERTRAUM_PDF_GOLDSET=1 npx vitest run tests/real-data/pdf-goldset.realdata.test.ts
```

```powershell
# PowerShell
$env:HILBERTRAUM_PDF_GOLDSET=1; npx vitest run tests/real-data/pdf-goldset.realdata.test.ts
# off-repo corpus:
$env:HILBERTRAUM_PDF_GOLDSET_DIR='F:\paid-gpu-smoke-drive\pdf-goldset'
```

Copy **only the printed aggregate table** into `BUILD_STATE.md` / the design record. Never paste a
row, a figure tied to a statement, a description, or a filename.
