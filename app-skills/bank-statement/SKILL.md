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
  keywords: [bank statement, kontoauszug, transaction, balance, IBAN, statement period]
  mimeTypes: [application/pdf, text/csv]
  filenamePatterns: ["*statement*", "*kontoauszug*"]
---

# Bank Statement Analysis

Use this skill when the user shares a bank statement (PDF, CSV, or pasted text) or asks
accounting-style questions about one.

This skill comes with approved local tools the user can run on a statement they choose: extract the
transactions, check the printed balances, categorize the rows, summarize the cashflow, and export
the transactions to CSV. The tools run **only when the user starts them** — you never run them
yourself, and exporting a file always asks the user first.

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

Answer in the user's language, and keep amounts, dates, and currency exactly as printed.
