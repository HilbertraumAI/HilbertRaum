---
id: bank-statement
title: Bank Statement Analysis
description: Use when the user shares a bank statement and wants help reading the figures it already prints — balances, totals, and individual transactions.
version: 1.0.0
author: HilbertRaum
language: en
kind: instruction              # 'tool' reserved for Tier 2; this v1 build is instruction-only (DS17)
compatibility:
  minAppVersion: 0.1.29
permissions:                   # DECLARED INTENT only — the app is authoritative (skills plan §6.7)
  documents: selected_only     # none | selected_only  (v1 max is selected_only)
  network: denied              # always denied in v1
  filesystem: skill_resources_only   # reads only this skill's own packaged files
allowedTools:                  # Tier-2 reserved — IGNORED in v1 (no tools execute); names the tools
  - extract_transactions       # that arrive with the tool registry (skills plan §13), so the Skills
  - validate_statement_balances #   detail view can honestly say "tools arrive with Tier-2".
  - categorize_transactions
  - summarize_cashflow
  - export_transactions_csv
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10)
  keywords: [bank statement, kontoauszug, transaction, balance, IBAN, statement period]
  mimeTypes: [application/pdf, text/csv]
  filenamePatterns: ["*statement*", "*kontoauszug*"]
---

# Bank Statement Analysis

Use this skill when the user shares a bank statement (PDF, CSV, or pasted text) or asks about
the figures in one.

This version adds **guidance only** — it does not extract, total, or check the numbers for the
user. Automated transaction extraction and balance checking arrive in a later version. Until
then, work only from what the statement itself prints:

- **Quote the statement's own printed figures.** When the user asks for a balance, a total, or
  a transaction, repeat the number the statement already shows, exactly as written, and say
  where it appears (for example, "closing balance, page 2").
- **Do not produce a figure the statement does not state.** If the number the user wants is not
  printed on the statement, say so plainly and decline to derive it — do not add up rows or
  infer a total from prose.
- **Flag anything you cannot confirm.** If a line is unclear, cut off, or possibly misread,
  point to that specific row and tell the user it needs checking before they rely on it.
- **Never present an unstated figure as if the statement reported it.** A number you would have
  to work out yourself is not a number the statement reports; be explicit about the difference.

Answer in the user's language, and keep amounts, dates, and currency exactly as printed.
