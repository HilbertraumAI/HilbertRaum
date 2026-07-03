---
id: bank-statement
title: Bank Statement Analysis
description: Use when the user wants to extract, categorize, reconcile, or summarize transactions from a bank statement.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Kontoauszug-Analyse
    description: Verwenden, wenn Transaktionen aus einem Kontoauszug extrahiert, kategorisiert, abgeglichen oder zusammengefasst werden sollen.
kind: tool                     # Tier-2 (S11c): the app-orchestrated tools below are effective
compatibility:
  minAppVersion: 0.1.29
permissions:                   # DECLARED INTENT only — the app is authoritative (skills plan §6.7)
  documents: selected_only     # none | selected_only  (v1 max is selected_only)
  network: denied              # always denied in v1
  filesystem: skill_resources_only   # reads only this skill's own packaged files
allowedTools:                  # The app-owned tools this skill may run (declared ∩ registry ∩ grant);
  - extract_transactions       #   read-only tools run when the user asks; export asks first.
  - validate_statement_balances
  - categorize_transactions
  - summarize_cashflow
  - export_transactions_csv
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10)
  autoFire: true               # U4/§2.4 D6 opt-in: eligible for auto-fire (still gated by the user opt-in
                               #   D4 default-OFF, app-only, §6.5 compatibility, and the score ≥ 3 bar — a
                               #   keyword corroborated by ≥1 EXPLICITLY-scoped doc signal, U4/§4.4). The
                               #   applies() gate is already single-doc + intent-shaped; W5's expanded
                               #   corpus holds the threshold-3 gate at 0-wrong / precision ≥ 0.95.
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. Bilingual, word/phrase (never a bare ambiguous token: `balance`/`net`/`statement` are
  # route-only). Edit the vocabulary, not this list. The routing gate reads the same source, so drift ends.
  keywords: [bank statement, statement period, transaction, transactions, IBAN,
             cashflow, cash flow, kontoauszug, kontostand, saldo, buchung, buchungen,
             umsatz, umsätze, überweisung, geldfluss, transaktion, transaktionen]
  mimeTypes: [application/pdf, text/csv]
  filenamePatterns: ["*statement*", "*kontoauszug*"]
---

# Bank Statement Analysis

Honesty and safety rules — these lead and always apply, even if the rest of this skill is shortened
to fit the context:

- **Work from the extracted transaction table, not from raw prose.** Once transactions have been
  extracted, rely on that table; never add up figures by reading them out of sentences.
- **Quote the statement's own printed figures** exactly as written, and say where they appear
  (for example, "closing balance, page 2").
- **If the opening and closing balances do not reconcile with the transactions, say so plainly**
  rather than papering over the gap.
- **Show any uncertain or unreconciled rows before presenting a total**, so the user can check
  them first.
- **Do not invent a figure the statement does not state.** A number you would have to work out
  yourself is not a number the statement reports; be explicit about the difference.
- **The tools run only when the user starts them** — you never run them yourself, and exporting a
  file always asks the user first.
- Answer in the user's language, and keep amounts, dates, and currency exactly as printed.

Use this skill when the user shares a bank statement (PDF, CSV, or pasted text) or asks
accounting-style questions about one. It comes with approved local tools the user can run on a
statement they choose: extract the transactions, check the printed balances, categorize the rows,
summarize the cashflow, and export the transactions to CSV.
