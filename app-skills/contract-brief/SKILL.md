---
id: contract-brief
title: Contract Brief
description: Use when the user wants a plain-language brief of a contract or agreement — parties, dates, obligations, key terms, and questions to ask. Not legal advice.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Vertragsübersicht
    description: Verwenden, wenn eine verständliche Übersicht eines Vertrags entstehen soll – Parteien, Fristen, Pflichten, wichtige Klauseln und offene Fragen. Keine Rechtsberatung.
  es:                          #   Shown when the app runs in Spanish.
    title: Resumen de contrato
    description: "Sirve para obtener un resumen en lenguaje sencillo de un contrato o acuerdo: partes, fechas, obligaciones, cláusulas clave y preguntas que conviene hacer. No es asesoramiento legal."
  fr:                          #   Shown when the app runs in French.
    title: Synthèse de contrat
    description: "À utiliser pour obtenir une synthèse en langage clair d’un contrat ou d’un accord\u00A0: parties, dates, obligations, clauses essentielles et questions à poser. Ne constitue pas un conseil juridique."
  it:                          #   Shown when the app runs in Italian.
    title: Sintesi del contratto
    description: "Serve a ottenere una sintesi in linguaggio semplice di un contratto o di un accordo: parti, date, obblighi, clausole principali e domande da porre. Non è una consulenza legale."
  ru:                          #   Shown when the app runs in Russian.
    title: Обзор договора
    description: Подходит, когда нужен понятный обзор договора или соглашения — стороны, даты, обязательства, ключевые условия и вопросы, которые стоит задать. Не является юридической консультацией.
  nl:                          #   Shown when the app runs in Dutch.
    title: Contractsamenvatting
    description: "Gebruik deze skill als je van een contract of overeenkomst een samenvatting in begrijpelijke taal wilt: partijen, datums, verplichtingen, belangrijke bepalingen en vragen die je kunt stellen. Geen juridisch advies."
  tr:                          #   Shown when the app runs in Turkish.
    title: Sözleşme özeti
    description: "Bir sözleşmenin veya anlaşmanın sade bir dille özetini çıkarmak için kullanılır: taraflar, tarihler, yükümlülükler, önemli hükümler ve sorulmaya değer sorular. Hukuki tavsiye değildir."
kind: instruction
analysis: whole-doc            # A3/§8.2: the model briefs the WHOLE contract (not top-k passages). With this
                               #   skill active over a single fully-chunked doc the whole-doc engine is the
                               #   DEFAULT — keywords only opt out for chatter and send a NEEDLE lookup to top-k
                               #   when the read would truncate. An ENGINE choice, not a tool capability
                               #   (SEC-1 unchanged) — honored for a skill of any source.
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. Bilingual domain nouns + clause phrases; the bare review verbs (`review contract`,
  # `vertrag prüfen`) are route-only. Edit the vocabulary, not this list.
  keywords: [contract, agreement, lease, contract brief, contract summary, terms and conditions,
             key terms, termination clause, renewal clause, liability clause, indemnity,
             vertrag, vereinbarung, mietvertrag, dienstleistungsvertrag, agb,
             vertragsübersicht, vertragsanalyse, kündigung, haftung]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: ["*contract*", "*agreement*", "*terms*", "*lease*", "*vertrag*", "*vereinbarung*", "*agb*", "*mietvertrag*"]
---

# Contract Brief
Safety and honesty rules — these lead and always apply, even if the rest of this skill is shortened
to fit the context:
- **This is not legal advice.** Never say "safe to sign", and never give legal advice. For high-risk
  or unclear terms, write "consider asking a qualified professional."
- Always distinguish "the contract says…" from "a possible implication is…".
- When you answer from only a few retrieved passages, use cautious wording — "I found…", not
  "the contract contains all…". Cite the source for each grounded point.
- Keep dates, amounts, and currency exactly as printed, and answer in the user's language.

Use this skill when the user wants to understand a contract or agreement before signing or sharing
it. Work only from the selected document — it helps the user understand the structure and spot what
to ask about.

Produce the brief in this order; omit a section only if the source genuinely has nothing for it.

## 1. Plain-language summary
What the document appears to be and what it is for.

## 2. Parties and roles
| Party | Role | Source |
If unclear, write "Not clearly stated."

## 3. Key dates and term
| Item | Date / period / trigger | Notes | Source |
Effective/start/end date, renewal, notice periods, payment dates.

## 4. Scope and obligations
| Who | Must do what | Timing / standard | Source |
Separate explicit obligations from background description.

## 5. Payment and commercial terms
Amounts, currency, schedule, fees, taxes, invoicing, penalties, late fees. If absent, say so.

## 6. Termination, renewal, cancellation
Notice period, automatic renewal, termination for convenience/cause, penalties.

## 7. Risk clauses to review
List a category only when it is actually present: liability cap / exclusions; indemnity; warranties;
confidentiality; IP / ownership / licensing; data protection / privacy; assignment / subcontracting;
governing law / dispute resolution; insurance; exclusivity / non-compete / non-solicit.

## 8. Unusual or unclear points
Ambiguity, missing terms, one-sided language, undefined terms, contradictions.

## 9. Questions to ask before signing
An actionable checklist.

(The safety and honesty rules that govern this brief are stated at the top of this skill.)
