---
id: share-safe-review
title: Share-Safe Review
description: Use when the user wants to review a document before sharing it — spotting visible sensitive information and practical sharing risks. Advisory only; not anonymization.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Sicher teilen prüfen
    description: Verwenden, wenn ein Dokument vor dem Teilen geprüft werden soll – sichtbare sensible Informationen und praktische Risiken. Nur beratend; keine Anonymisierung.
kind: instruction
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. The pure redaction VERBS (anonymize/schwärzen/redact) stay with the document-redaction
  # tool skill; the bare `personal data`/`weitergeben` phrasings are route-only. Edit the vocabulary.
  keywords: [safe to share, share-safe, review before sharing, privacy review, disclosure review,
             sensitive information, confidential information, metadata,
             sicher teilen, vor dem teilen prüfen, sensible daten, personenbezogene daten,
             vertrauliche informationen, datenschutz prüfen, metadaten]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: ["*share*", "*confidential*", "*personal*", "*sensitive*", "*teilen*", "*vertraulich*", "*datenschutz*"]
---

# Share-Safe Review

Safety and wording rules — these lead and always apply, even if the rest of this skill is shortened
to fit the context:

- This skill is **advisory** — it must never claim to anonymize, legally de-identify, sanitize
  metadata, or guarantee safe publication. It complements the separate **Document Redaction** tool.
- Never say "fully anonymized." Never say "GDPR-compliant", "DSGVO-compliant", "HIPAA-compliant", or
  "legally safe."
- Do not invent hidden metadata — warn that it *may* exist.
- Be especially cautious with scans/images: text extraction can miss visible content. If the document
  is a scan or image-derived OCR, say OCR may be incomplete.
- Only issue the **"Likely low risk after review"** verdict when you have reviewed the **whole**
  document. If you were shown only its beginning (a partial-document notice), do not use that verdict —
  use "Review carefully before sharing" or a stronger one.
- An automated, offline pattern pre-scan of the **whole** document (counts of e-mails, phone numbers,
  IBANs, payment-card numbers, dates, links) may be provided above the excerpts. Use its counts to
  inform your findings; it is a floor, not a ceiling (it cannot see names, addresses, or confidential
  wording), so never treat "0 found" as "nothing sensitive".
- Work only from the selected/extracted text, and answer in the user's language.

Use this skill when the user wants to review a document **before sharing it**. Identify visible
sensitive information and practical sharing risks.

Produce the review in this order.

## 1. Quick verdict
Exactly one of: "Likely low risk after review"; "Review carefully before sharing"; "Do not share yet
— sensitive information appears present". Base the verdict only on visible/extracted text.

## 2. Sensitive information found
| Category | Examples / description | Suggested action | Source |
Categories to consider: names / personal identifiers; email addresses; phone numbers; postal
addresses; account numbers / IBAN / bank details; tax IDs / social-security / national IDs; dates of
birth; signatures; medical / legal / HR / financial content; confidential business terms;
client/customer names; passwords / secrets / tokens if visible; URLs or access links.

## 3. Hidden-data warning
Always include: "HilbertRaum can review extracted/visible text, but electronic files may contain
hidden metadata, comments, tracked changes, embedded objects, hidden spreadsheet rows, or source
data. Use a dedicated metadata/sanitization tool before publishing externally."

## 4. Redaction recommendation
If structured patterns (emails, phone numbers, IBANs, links) are present, tell the user: "Run the
Document Redaction skill to create a first-pass redacted copy, then manually review it." Also say:
"Redaction is best-effort and not a guarantee." Do not create files yourself, and never report that
redaction has been done.

## 5. Share checklist
- remove or redact sensitive text
- inspect metadata / tracked changes / comments
- check attachments and embedded objects
- check images/scans separately
- export to a clean format if needed
- have a human review before sending

(The safety and wording rules that govern this review are stated at the top of this skill.)
