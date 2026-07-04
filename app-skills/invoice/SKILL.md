---
id: invoice
title: Invoice Analysis
description: Use when the user wants to extract, check, or export the line items and totals of an invoice.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Rechnungsanalyse
    description: Verwenden, wenn die Positionen und Beträge einer Rechnung extrahiert, geprüft oder exportiert werden sollen.
kind: tool                     # Tier-2 (S11c): the app-orchestrated tools below are effective
compatibility:
  minAppVersion: 0.1.29
permissions:                   # DECLARED INTENT only — the app is authoritative (skills plan §6.7)
  documents: selected_only     # none | selected_only  (v1 max is selected_only)
  network: denied              # always denied in v1
  filesystem: skill_resources_only   # reads only this skill's own packaged files
allowedTools:                  # The app-owned tools this skill may run (declared ∩ registry ∩ grant);
  - extract_invoice            #   read-only tools run when the user asks; export asks first.
  - validate_invoice_totals
  - export_invoice_csv
  - export_invoice_json        # format-transformation exports (pure serializers; confirm-gated)
  - export_invoice_xml
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  autoFire: true               # U4/§2.4 D6 opt-in: eligible for auto-fire (still gated by the user opt-in
                               #   D4 default-OFF, app-only, §6.5 compatibility, and the score ≥ 3 bar — a
                               #   keyword corroborated by ≥1 EXPLICITLY-scoped doc signal, U4/§4.4). The
                               #   applies() gate is already single-doc + intent-shaped; W5's expanded
                               #   corpus holds the threshold-3 gate at 0-wrong / precision ≥ 0.95.
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. Word-boundary matched, so bare ambiguous tokens are route-only (no `bill`→"Bill" the name,
  # `tax`→"syntax", `sum`→"assume", `steuer`→"Steuerberatung"). Edit the vocabulary, not this list.
  keywords: [invoice, invoices, billing, net amount, gross amount, subtotal,
             line item, line items, invoice number, vendor,
             rechnung, rechnungen, faktura, rechnungsnummer, rechnungsbetrag, gesamtbetrag,
             gesamtwert, mehrwertsteuer, umsatzsteuer, netto, brutto, zwischensumme,
             lieferant, positionen]
  mimeTypes: [application/pdf, text/csv]
  filenamePatterns: ["*invoice*", "*rechnung*", "*faktura*", "*bill*"]
---

# Invoice Analysis
Honesty and safety rules — these lead and always apply, even if the rest of this skill is shortened
to fit the context:
- **Work from the extracted invoice, not from raw prose.** Once the invoice has been extracted, rely
  on that structured table of line items and totals; never add up figures by reading them out of
  sentences.
- **Quote the invoice's own printed figures** exactly as written, and say where they appear (for
  example, "gross total, page 1").
- **If the totals do not reconcile** — the line items don't sum to the net, or net plus tax doesn't
  match the gross — **say so plainly** rather than papering over the gap.
- **Show any uncertain or unreconciled figures before presenting a total**, so the user can check
  them first.
- **Do not invent a figure the invoice does not state.** Invoice layouts vary, so a field that could
  not be parsed is left blank on purpose — a number you would have to work out yourself is not a
  number the invoice reports. Be explicit about the difference.
- **You never run these tools yourself** — the app runs them. Read-only tools may run automatically
  to answer the user's question, or when the user starts them; anything that writes or exports a file
  always asks the user first.
- Answer in the user's language, and keep amounts, dates, and currency exactly as printed.

Use this skill when the user shares an invoice (PDF, CSV, or pasted text) or asks billing-style
questions about one. It comes with approved local tools the user can run on an invoice they choose:
extract the header, line items, and totals; check that the printed totals add up; and export the
line items to CSV.
