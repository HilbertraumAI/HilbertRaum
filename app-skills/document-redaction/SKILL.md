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
  autoFire: true               # U4/§2.4 D6 opt-in: eligible for auto-fire (still gated by the user opt-in
                               #   D4 default-OFF, app-only, §6.5 compatibility, and the score ≥ 3 bar — a
                               #   keyword corroborated by ≥1 EXPLICITLY-scoped doc signal, U4/§4.4). W5's
                               #   expanded corpus holds the threshold-3 gate at 0-wrong / precision ≥ 0.95.
                               #   (Comment refreshed from the stale S13a-era wording — SKA-45, U7.)
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` + `suggest`-only terms)
  # and pinned by a parity test. The action verbs (redact/anonymize/schwärzen…) both OFFER and ROUTE; the
  # PII-content topics (sensitive data / sensible daten) are `suggest`-only but the informational dry-run
  # DOES act on them (per-category counts). U4/§4.4: the pure legal words datenschutz/dsgvo/gdpr were
  # DROPPED — the handler acts on none of them, so keeping them let redaction auto-fire a wrong-flavoured
  # fence on "Was regelt die DSGVO?". Edit the vocabulary, not this list.
  keywords: [redact, redaction, anonymize, anonymise, anonymized, anonymised,
             remove personal data, mask personal data,
             anonymisieren, anonymisierung, anonymisiere, pseudonymisieren,
             schwärzen, schwärzung, schwärze, geschwärzt,
             personenbezogene daten, personenbezogene daten entfernen,
             sensitive data, sensible daten]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: []         # redaction is intent-driven, not filename-driven — leave empty
---

# Document Redaction
Safety rules — these lead and always apply, even if the rest of this skill is shortened to fit:
- **Do the routing, not the work.** When the user asks to redact, anonymize, or remove personal data
  from the document they have selected, tell them — briefly, in their own language — to click the
  **Redact personal data** / **Personenbezogene Daten schwärzen** button just below the chat box
  (its label follows the app language) and choose where to save the copy. Do not
  refuse, do not walk them through a manual procedure, and never run the tool yourself; it runs only
  when the user starts it and **always asks before saving**.
- **Never state whether the document does or does not contain personal data** — you have seen only
  part of it, so any such claim would be guesswork.
- **It is an AI-assisted best-effort first pass, not a guarantee.** A deterministic rule-based floor
  always masks the clearly-shaped data (e-mail addresses, phone numbers, IBANs, payment-card numbers,
  dates, links); on top of that, when a model is running, it **locates** names, addresses, and
  organisation names for the app to mask — the model only points at spans, it never rewrites the
  document, so it cannot invent text. It **still misses** things (unusual formats, data in images or
  scans, anything the model doesn't spot), so **never** describe the result as "fully anonymized" or
  imply it meets any legal or compliance standard. If no model is running, only the rule-based floor
  applies and the result says so.
- After it runs, remind the user to **review the saved copy themselves** before sharing it, report
  only the counts the tool gives (e.g. "3 phone numbers hidden"), and never repeat detected personal
  data back to them. Answer in the user's language.

The tool runs entirely on this device. It reads the **whole** document, masks the clearly-shaped
personal data with fixed rules — e-mail addresses, phone numbers, IBANs, payment-card numbers, dates,
and web links — and, when a model is running, also masks the names, addresses, and organisation names
the model locates. It runs only when the user starts it, always asking before the copy is written
where the user chooses.
