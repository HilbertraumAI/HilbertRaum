---
id: document-redaction
title: Document Redaction
description: Use when the user wants to redact, anonymize, or remove personal data from a document.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Dokument schwärzen
    description: Verwenden, wenn personenbezogene Daten in einem Dokument geschwärzt, anonymisiert oder entfernt werden sollen.
kind: tool                     # Tier-2 (S11d): the app-orchestrated tool below is effective
compatibility:
  minAppVersion: 0.1.29
permissions:                   # DECLARED INTENT only — the app is authoritative (skills plan §6.7)
  documents: selected_only     # none | selected_only  (v1 max is selected_only)
  network: denied              # always denied in v1
  filesystem: skill_resources_only   # reads only this skill's own packaged files
allowedTools:                  # The app-owned tools this skill may run (declared ∩ registry ∩ grant);
  - redact_document            #   it reads the selected document and asks before saving the copy.
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  autoFire: true               # S13b D6 opt-in: eligible for auto-fire (still gated by the user opt-in
                               #   D4, app-only, §6.5 compatibility, and the score ≥ 3 bar — a keyword
                               #   corroborated by ≥1 in-scope doc signal). Proven at 100% precision on
                               #   the S13a corpus (skills-s13-plan.md §3.3 / eval threshold-3 gate).
  # Bilingual + full words only: matching is case-insensitive question.includes(keyword), so short
  # ambiguous tokens are avoided (no bare "mask"→"unmask", "pii", or "vat"); German singular+plural
  # are listed where an umlaut/ending breaks the substring.
  keywords: [redact, redaction, anonymize, anonymise, anonymisieren, anonymisierung,
             pseudonymisieren, schwärzen, schwärzung, remove personal data, mask personal data,
             personenbezogene daten, datenschutz, gdpr, dsgvo, sensitive data, sensible daten]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: []         # redaction is intent-driven, not filename-driven — leave empty
---

# Document Redaction

This skill comes with a one-click local tool. When the user asks to redact, anonymize, or remove
personal data from the document they have selected, tell them — briefly, in their own language — to
click the **Redact personal data** button shown just below the chat box and choose where to save the
copy. **Do the routing, not the work:** do not refuse, do not walk them through a manual procedure,
and **never state whether the document does or does not contain personal data** — you have only seen
part of it, so any such claim would be guesswork.

The tool runs entirely on this device. It reads the **whole** document and masks the personal data it
can detect with fixed patterns — e-mail addresses, phone numbers, IBANs, dates, and web links. It
runs **only when the user starts it** (you never run it yourself) and **always asks before saving**;
the user chooses where the copy is written.

It is a **best-effort first pass, not a guarantee.** Being offline and rule-based, it has **no AI
judgement and no name detection**, so it **will miss** anything without a recognisable pattern (most
names, addresses, unusual formats, data in images or scans). Never describe the result as "fully
anonymized" or imply it meets any legal or compliance standard. After it runs, remind the user to
**review the saved copy themselves** before sharing it, report only the counts the tool gives (e.g.
"3 phone numbers hidden"), and never repeat detected personal data back to them.

Answer in the user's language.
