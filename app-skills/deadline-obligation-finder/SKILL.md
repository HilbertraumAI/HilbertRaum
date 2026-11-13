---
id: deadline-obligation-finder
title: Deadline & Obligation Finder
description: Use when the user wants to find deadlines, notice periods, renewal and payment dates, and the obligations in a document — what to do, by when, and what happens if missed.
version: 1.1.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Fristen & Pflichten
    description: Verwenden, wenn Fristen, Kündigungsfristen, Verlängerungs- und Zahlungstermine sowie Pflichten in einem Dokument gefunden werden sollen – was bis wann zu tun ist und was bei Versäumnis passiert.
  es:                          #   Shown when the app runs in Spanish.
    title: Plazos y obligaciones
    description: "Sirve para encontrar en un documento los plazos, los periodos de preaviso, las fechas de renovación y de pago, y las obligaciones: qué hacer, para cuándo y qué pasa si no se cumple."
  fr:                          #   Shown when the app runs in French.
    title: Échéances et obligations
    description: "À utiliser pour repérer dans un document les échéances, les délais de préavis, les dates de renouvellement et de paiement, ainsi que les obligations\u00A0: ce qu’il faut faire, dans quel délai et ce qui se passe en cas de non-respect."
  it:                          #   Shown when the app runs in Italian.
    title: Scadenze e obblighi
    description: "Serve a trovare in un documento scadenze, termini di preavviso, date di rinnovo e di pagamento, oltre agli obblighi: cosa fare, entro quando e cosa succede in caso di mancato rispetto."
  ru:                          #   Shown when the app runs in Russian.
    title: Сроки и обязательства
    description: Подходит, когда в документе нужно найти крайние сроки, сроки уведомления, даты продления и оплаты, а также обязательства — что сделать, к какому сроку и что будет при пропуске срока.
  nl:                          #   Shown when the app runs in Dutch.
    title: Termijnen en verplichtingen
    description: "Gebruik deze skill als je in een document de termijnen, opzegtermijnen, verlengings- en betaaldatums en de verplichtingen wilt vinden: wat je moet doen, uiterlijk op welke datum en wat er gebeurt als een termijn wordt overschreden."
  tr:                          #   Shown when the app runs in Turkish.
    title: Son tarihler ve yükümlülükler
    description: "Bir belgedeki son tarihleri, ihbar sürelerini, yenileme ve ödeme tarihlerini ve yükümlülükleri bulmak için kullanılır: ne yapılması gerektiği, hangi tarihe kadar ve kaçırılırsa ne olacağı."
  pl:                          #   Shown when the app runs in Polish.
    title: Terminy i obowiązki
    description: "Służy do wyszukiwania w dokumencie terminów, okresów wypowiedzenia, dat przedłużenia i płatności oraz obowiązków: co trzeba zrobić, do kiedy i co się stanie po przekroczeniu terminu."
kind: instruction
analysis: whole-doc            # A3/§8.2: the finder scans the WHOLE document for deadlines/obligations (not
                               #   top-k passages). With this skill active over a single fully-chunked doc the
                               #   whole-doc engine is the DEFAULT — keywords only opt out for chatter and send a
                               #   NEEDLE lookup (e.g. "when is the renewal date?") to top-k when the read would
                               #   truncate. An ENGINE choice, not a tool capability (SEC-1 unchanged).
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. Bilingual deadline/obligation nouns (singular + plural listed for word-boundary matching);
  # the imperative phrases (`what do i have to do`, `bis wann`) are route-only. Edit the vocabulary.
  keywords: [deadline, deadlines, due date, due dates, notice period, renewal date,
             cancellation deadline, obligation, obligations, payment date, payment dates,
             frist, fristen, fälligkeit, fälligkeiten, stichtag, kündigungsfrist, zahlungsfrist,
             pflicht, pflichten, verpflichtung, verpflichtungen, wiedervorlage]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: ["*deadline*", "*frist*", "*vertrag*", "*contract*", "*agreement*", "*notice*", "*renewal*", "*kündigung*"]
---

# Deadlines & Obligations
Safety and honesty rules — these lead and always apply, even if the rest of this skill is shortened
to fit the context:
- This is **not** a complete compliance calendar. Say "I found these deadlines and obligations in the
  available material." If the user asks for "all deadlines", be especially cautious and mention any
  coverage limitation that is visible (e.g. only some passages were retrieved).
- Do not give legal, tax, or compliance advice. Cite the source for each item.
- Keep dates and wording exactly as printed, and answer in the user's language.

Use this skill when the user asks "what do I need to do, by when, and what happens if I miss it?"
in the selected document. Extract deadlines, notice periods, renewal and payment dates,
and obligations. Work only from the selected material. The app handles document scope — with
several documents in scope it narrows to the matching one or asks the user to pick; do not police
this yourself.

Produce the answer in this order; omit a section only if there is genuinely nothing for it.

## 1. Important deadlines
| Date / trigger | What happens | Who must act | Consequence | Source |
- Preserve the original wording.
- For a relative date ("within 30 days after delivery"), keep the trigger and do **not** compute a
  calendar date unless the anchor date is explicit.
- Mark an unclear deadline "Ambiguous".

## 2. Obligations
| Party / person | Obligation | Timing / standard | Consequence | Source |
- Extract only obligations expressed as must / shall / required / agrees to / ist verpflichtet /
  muss / soll. Do not turn background text into an obligation.

## 3. Notice periods and renewals
| Clause / topic | Period | Trigger | Source |

## 4. Missing information / unclear owners
Obligations or deadlines where the responsible person, the date, or the consequence is not clear.

## 5. Suggested next actions
A practical checklist, e.g. "confirm owner", "add to calendar", "ask counterparty".

(The safety and honesty rules that govern this answer are stated at the top of this skill.)
