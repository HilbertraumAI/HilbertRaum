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

Use this skill when the user wants to share, publish, or hand on a document with personal data
removed — for example "anonymize this", "schwärze die personenbezogenen Daten", or any privacy- or
GDPR/DSGVO-framed request about a document they have selected.

This skill comes with one approved local tool the user can run on a document they choose: it reads
the whole document, masks the personal data it can detect, and saves a redacted copy. The tool runs
**only when the user starts it** — you never run it yourself — and it **always asks before saving
the file**; the user chooses where the copy is written.

- **The redaction is a best-effort, deterministic aid — not a guarantee.** It masks common,
  clearly-shaped personal data with fixed patterns: e-mail addresses, phone numbers, IBANs, dates,
  and web links. It is **offline and rule-based — there is no AI judgement and no name detection**,
  so it **will miss** anything without a recognisable pattern (most names, addresses, unusual
  formats, data in images or scans). Never describe the result as "fully anonymized" or imply it
  meets any legal or compliance standard.
- **Tell the user to review the copy themselves.** The redacted copy is a starting point that still
  needs a human check before it is shared; say so plainly rather than implying the document is safe.
- **Report only what the tool reports** — the count of items hidden per category — and do not repeat
  the detected personal data back to the user.

Answer in the user's language.
