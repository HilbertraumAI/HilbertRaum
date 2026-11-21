import { describe, it, expect } from 'vitest'
import { t, UI_LANGUAGE_CODES } from '../../src/shared/i18n'
import { countKeywordHits } from '../../src/main/services/skills/selector'
import {
  APP_VOCAB_SKILL_IDS,
  SKILL_VOCABULARY,
  deriveMatch,
  entryMatches,
  isNeedleShaped,
  isReportShaped,
  isSmallTalk,
  isSmallTalkReply,
  routeEntries,
  routeMatch,
  suggestTerms,
  type SkillVocabId,
  type VocabEntry
} from '../../src/main/services/skills/vocabulary'

// W5 (audit §3.2/§4.1/§4.2/§8.3) — the ONE canonical trigger vocabulary is the single source both the
// SUGGESTION scorer and the ROUTING gates read. These tests pin its INTERNAL invariants (so the two
// consumers can never disagree) and its MATCHING semantics (word-boundary vs substring), and prove the
// handler-vocab DRIFT guard: every routing term actually routes.

describe('vocabulary — structural invariants', () => {
  it('every skill has terms; every entry is well-formed (whitespace ⟺ phrase, no dupes); every offer term is scorer-matchable and every route term routes', () => {
    // The hand-kept id list and the vocabulary's keys agree, so the loop below sees every skill.
    expect(Object.keys(SKILL_VOCABULARY).sort()).toEqual([...APP_VOCAB_SKILL_IDS].sort())
    for (const id of APP_VOCAB_SKILL_IDS) {
      expect(SKILL_VOCABULARY[id].length, `${id}: empty vocabulary`).toBeGreaterThan(0)
      const seen = new Set<string>()
      for (const e of SKILL_VOCABULARY[id]) {
        const term = e.term.trim().toLowerCase()
        expect(term.length, `${id}: empty term`).toBeGreaterThan(0)
        expect(e.term, `${id}: term not trimmed`).toBe(e.term.trim())
        // No duplicate term within a skill (case-insensitive).
        expect(seen.has(term), `${id}: duplicate term "${term}"`).toBe(false)
        seen.add(term)
        // The ONE structural rule: a multi-word term MUST be a phrase, and a single token must NOT be
        // (it is 'word' for boundary matching or 'stem' for German compound substring). `match` drives
        // ROUTE only — the suggestion scorer word/phrase-infers from the term shape itself, independently.
        const hasSpace = /\s/.test(e.term)
        expect(e.match === 'phrase', `${id}: "${term}" phrase⇔whitespace mismatch`).toBe(hasSpace)
        expect(deriveMatch(e.term), `${id}: deriveMatch sanity`).toBe(hasSpace ? 'phrase' : 'word')
        // A `suggest|both` term must be matchable by the SCORER when it appears as a standalone token —
        // otherwise it is a dead offer keyword. (`countKeywordHits` word/phrase-infers exactly as the
        // scorer does, so this is the offer-side liveness guard the parity/route tests don't cover.)
        if (e.use === 'suggest' || e.use === 'both') {
          expect(countKeywordHits([e.term], `bitte ${e.term} jetzt`), `${id}: "${term}" never offers`).toBe(1)
        }
        // Route-side liveness (no dead/typo'd route term; the word/phrase/stem type fires on the term). The
        // handler wiring is covered by `skills-analysis-{bank,invoice,routing}.test.ts` and the
        // `SkillVocabId` compile guard on `routeMatch`.
        if (e.use === 'route' || e.use === 'both') {
          expect(routeMatch(id, `bitte ${e.term} jetzt`), `${id}: route term "${term}" did not route`).toBe(true)
        }
      }
    }
  })
})

describe('entryMatches / routeMatch — word-boundary vs substring', () => {
  const wordEntry = (term: string): VocabEntry => ({ term, lang: 'en', match: 'word', use: 'route' })
  const phraseEntry = (term: string): VocabEntry => ({ term, lang: 'en', match: 'phrase', use: 'route' })
  const stemEntry = (term: string): VocabEntry => ({ term, lang: 'de', match: 'stem', use: 'route' })

  it('a WORD entry is boundary-matched (never a substring inside a longer word)', () => {
    expect(entryMatches(wordEntry('net'), 'what is my net income')).toBe(true)
    expect(entryMatches(wordEntry('net'), 'cancel my netflix abo')).toBe(false)
    expect(entryMatches(wordEntry('tax'), 'the tax is due')).toBe(true)
    expect(entryMatches(wordEntry('tax'), 'the syntax of this')).toBe(false)
  })

  it('a PHRASE entry is substring-matched', () => {
    expect(entryMatches(phraseEntry('safe to share'), 'is this safe to share?')).toBe(true)
    expect(entryMatches(phraseEntry('safe to share'), 'is this safe?')).toBe(false)
  })

  it('a STEM entry is substring-matched (German inflections/compounds)', () => {
    expect(entryMatches(stemEntry('transaktion'), 'zeig mir die transaktionen')).toBe(true)
    expect(entryMatches(stemEntry('zusammenfass'), 'bitte zusammenfassen')).toBe(true)
  })

  it('the known substring reproductions do NOT route (Netflix→net, syntax→tax)', () => {
    expect(routeMatch('bank-statement', 'Wie kündige ich mein Netflix-Abo?')).toBe(false)
    expect(routeMatch('invoice', 'Explain the syntax of this formula')).toBe(false)
    // …and the flagship under-fire now DOES route.
    expect(routeMatch('meeting-protocol', 'Summarize this meeting')).toBe(true)
    // off-topic stays off.
    expect(routeMatch('bank-statement', 'what is the weather today?')).toBe(false)
    expect(routeMatch('invoice', 'tell me a joke')).toBe(false)
  })
})

describe('suggest↔route derivation', () => {
  it('unknown skill ids yield empty term/entry lists (never throw)', () => {
    expect(suggestTerms('no-such-skill')).toEqual([])
    expect(routeEntries('no-such-skill')).toEqual([])
    // `routeMatch` is compile-guarded to `SkillVocabId`; the cast checks the runtime stays robust (false,
    // not a throw) if an out-of-union id ever reaches it defensively.
    expect(routeMatch('no-such-skill' as SkillVocabId, 'anything at all')).toBe(false)
  })
})

// A3 (audit §6.3/§8.2) — the SKILL-INDEPENDENT shape classifiers driving the inverted whole-doc gate.
describe('isSmallTalk — off-topic opt-out (A3)', () => {
  it('fires on pure chatter: greetings, thanks, closings, assistant-meta (EN + DE)', () => {
    for (const q of [
      'hi', 'Hello there!', 'hey', 'thanks', 'Thanks!', 'thank you', 'thank you :)', 'ok danke',
      'bye', 'cheers', 'how are you?', 'How are you doing?', "how's it going", 'who are you?',
      'what can you do?', 'tell me a joke', 'hallo', 'servus', 'danke', 'tschüss', 'wie gehts?',
      'wie geht es dir?', 'wer bist du?', 'was kannst du?'
    ]) {
      expect(isSmallTalk(q)).toBe(true)
    }
  })

  it('NEVER fires on a real document question (the inversion default → whole-doc)', () => {
    for (const q of [
      'summarize this contract', 'what colour is the sky?', 'what are the deadlines?',
      'how much did I spend?', 'write the meeting minutes', 'wann ist die frist?',
      'thank you, now summarize the contract', 'hi, can you list the obligations?',
      'what does the document say about termination?', 'is there a renewal clause?'
    ]) {
      expect(isSmallTalk(q)).toBe(false)
    }
  })

  it('empty / whitespace-only is not small talk (nothing to opt out of)', () => {
    expect(isSmallTalk('')).toBe(false)
    expect(isSmallTalk('   ')).toBe(false)
  })
})

describe('isNeedleShaped — needle-vs-deliverable classify (A3)', () => {
  it('fires on a targeted single-fact lookup (EN + DE)', () => {
    for (const q of [
      'how much did I spend on groceries?', 'how many transactions were there?',
      'when is the renewal date?', 'what is the invoice number?', "what's the total due?",
      'is there a termination clause?', 'find the payment date', 'where is the signature?',
      'wie viel kostet das?', 'wie viele positionen gibt es?', 'wann ist die frist?',
      'wo ist die unterschrift?', 'gibt es eine kündigungsklausel?'
    ]) {
      expect(isNeedleShaped(q)).toBe(true)
    }
  })

  it('a DELIVERABLE verb vetoes the needle (never downgraded to top-k)', () => {
    for (const q of [
      'summarize the contract', 'give me an overview', 'write the minutes',
      'list all the obligations', 'what changed between these?', 'review this document',
      'what is the main point?', 'zusammenfassung des vertrags', 'überblick über alle fristen',
      'was hat sich geändert?'
    ]) {
      expect(isNeedleShaped(q)).toBe(false)
    }
  })

  it('a "what is the <synthesis-noun>" ask is a DELIVERABLE, not a needle (whole-doc synthesis, EN+DE)', () => {
    // Guards against downgrading a whole-document synthesis question to ~5 top-k passages — the exact
    // incident A3's inversion exists to kill (a false needle is worse than a false deliverable).
    for (const q of [
      'what is the takeaway of this contract?', 'what is the bottom line?',
      'what is the conclusion of the report?', 'what is the upshot?', 'what is this about?',
      'was ist das Fazit?', 'was ist die Kernaussage?', 'was ist der Inhalt des Dokuments?'
    ]) {
      expect(isNeedleShaped(q)).toBe(false)
    }
  })

  it('a non-needle, non-deliverable question is NOT a needle (defaults to whole-doc)', () => {
    // No lookup interrogative → not a needle → the whole-doc engine stays the default.
    expect(isNeedleShaped('tell me about the parties')).toBe(false)
    expect(isNeedleShaped('explain the agreement')).toBe(false)
  })

  // #834: the every-mention example chip asks for every mention, a list. Pre-fix the German value was the one
  // lookup among the 30 chip values (its «finde» is a needle word), so on a long document a whole-document skill
  // sent it to the passage search while the English chip kept the whole read. Recognised by its frame in every
  // catalog, whatever word the user puts in its quotes (`isMentionChip`, the router's own recognition).
  const withOwnTerm = (chip: string): string => chip.replace(/(['„«“])[^'„«“”»]*(['“”»])/u, '$1force majeure$2')

  it.each(UI_LANGUAGE_CODES)('%s: the every-mention chip is no single-fact lookup, whatever word it quotes', (code) => {
    const chip = t(code, 'chat.example.indemnity')
    const ownTerm = withOwnTerm(chip)
    expect(ownTerm, 'the chip quotes its example word').not.toBe(chip)
    for (const question of [chip, ownTerm, `${chip}.`, `${ownTerm} ?`]) {
      expect(isNeedleShaped(question), question).toBe(false)
    }
  })
})

// W7 (audit §3.2/§3.3/§3.4) — answer-shape + classifier vocabulary tuning. Each probe from the findings
// gets an assertion on its INTENDED shape; teeth-check by reverting the W7 change → the probe flips.
describe('W7 — SKA-7 bank/invoice German money routing (route-only; §3.2/§8.2)', () => {
  it('bank: the German money phrasings that used to fall to raw top-k now ROUTE', () => {
    // Probe-verified misses from the finding — with the bank skill ACTIVE these must reach the handler.
    for (const q of [
      'Wie viel habe ich für Lebensmittel ausgegeben?',
      'Wer hat die höchste Zahlung bekommen?',
      'Wofür habe ich am meisten bezahlt?',
      'what was my biggest payment?',
      'Wie viele Buchungen gab es?' // 'wie viele' + 'buchung'
    ]) {
      expect(routeMatch('bank-statement', q), q).toBe(true)
    }
  })

  it('invoice: a due-date ask reaches the invoice handler (fällig / due)', () => {
    expect(routeMatch('invoice', 'Wann ist sie fällig?')).toBe(true)
    expect(routeMatch('invoice', 'Was ist die Fälligkeit?')).toBe(true)
    expect(routeMatch('invoice', 'when is this invoice due?')).toBe(true)
  })

  it('the bare separable imperatives reach BOTH tool handlers (the A4 rider)', () => {
    expect(routeMatch('bank-statement', 'Fasse das zusammen')).toBe(true)
    expect(routeMatch('bank-statement', 'Liste das auf')).toBe(true)
    expect(routeMatch('invoice', 'Fasse die Rechnung zusammen')).toBe(true)
    expect(routeMatch('invoice', 'Liste die Positionen auf')).toBe(true)
  })
})

describe('W7 — SKA-11 small-talk thanks/ack variants + the never-fires guard (§3.3)', () => {
  it('fires on the top-frequency thanks/ack variants the detector used to miss', () => {
    for (const q of [
      'thank you very much', 'thanks a lot!', 'danke dir!', 'danke schön', 'vielen lieben dank',
      'perfect, thanks', 'sounds good', 'all good, thanks!', 'perfekt danke', 'sehr gut, danke'
    ]) {
      expect(isSmallTalk(q), q).toBe(true)
    }
  })

  it('STILL never fires on a real document question (adversarial near-misses)', () => {
    // A real ask always carries a non-filler content word — the module's safety invariant. The new
    // fillers must not swallow one: "ist das gut?" (is that good?) is a real question, NOT small talk.
    for (const q of [
      'ist das gut?', 'is this a good summary?', 'how much did I spend?', 'sind alle Fristen aufgeführt?',
      'is the invoice all paid?', 'sounds like a penalty — is it?', 'was ist das Fazit?'
    ]) {
      expect(isSmallTalk(q), q).toBe(false)
    }
  })
})

// #809 (open-issues wave owner call G-11) — small talk in all ten interface languages. Pre-fix every row of the
// first table was a real question to the detector: its tokens kept only a–z, digits and äöüß («Дякую!» left no
// token at all, «Dziękuję!» became "dzi kuj") and no thanks of the eight new languages was listed. The guard
// table is the real questions the lists were checked against, across all ten languages.
describe('isSmallTalk — the ten interface languages (#809)', () => {
  const DOTTED_CAPITAL_I = String.fromCharCode(0x0130)
  // «Dziękuję!» written with separate marks (e + U+0328), as text pasted from some systems arrives.
  const OGONEK = String.fromCharCode(0x0328)

  it.each([
    // Per language: a greeting, a thanks with an intensifier, an acknowledgement with thanks.
    '¡Hola!', 'Muchísimas gracias', 'Vale, gracias.',
    'Bonjour !', 'Merci beaucoup !', "D'accord, merci.",
    'Buongiorno!', 'Grazie mille!', 'Perfetto, grazie!',
    'Hoi!', 'Hartelijk bedankt!', 'Oké, bedankt!',
    'Cześć!', 'Dziękuję bardzo!', 'Dobrze, dzięki!',
    'Merhaba!', 'Çok teşekkürler!', 'Tamam, teşekkürler.',
    'Привет!', 'Спасибо большое!', 'Хорошо, спасибо!',
    'Привіт!', 'Щиро дякую!', 'Добре, дякую!',
    // The issue's own examples, and thanks with a "to you".
    'Bedankt!', 'Dank je wel!', 'Dziękuję!', 'Teşekkürler!', 'Спасибо!', 'Дякую!', 'Дякую вам', 'Спасибо тебе',
    // Capitals: the capital dotted İ lowers to a plain "i" before the split.
    `${DOTTED_CAPITAL_I}Y${DOTTED_CAPITAL_I} GÜNLER`, 'TEŞEKKÜRLER',
    // … and the capital I lowers to a dotted "i": the dotless ı is folded on both sides, so Turkish typed in
    // capitals or without ı meets the lists, and so does Turkish typed with ı.
    'HOŞÇAKALIN', 'NASILSINIZ', 'nasil gidiyor', 'Hoşçakalın!', 'Nasılsınız?',
    `Dzie${OGONEK}kuje${OGONEK}!`,
    // The German "passt" forms (owner call, 2026-11-14) and the English "a lot" forms are whole-question forms.
    'Danke, passt', 'Vielen Dank, passt', 'Passt!', 'Thank you a lot.',
    // … with a closing or another acknowledgement (owner call, 2026-11-14)
    'Thanks a lot, bye!', 'Ok, thank you a lot', 'Alles klar, passt!', 'Passt, vielen Dank!'
  ])('%s → small talk', (q) => {
    expect(isSmallTalk(q)).toBe(true)
  })

  it.each([
    // es
    'Gracias, ¿y qué dice el contrato sobre la rescisión?', 'Vale, ¿cuándo vence la factura?', '¿Está bien?',
    '¿Cuál es la prima del seguro?',
    // fr
    'Merci, et que dit le contrat sur la résiliation ?', 'Très bien, quelles sont les échéances ?',
    'Le transport est compris ?', 'Merci beaucoup, maintenant résume le document', 'A Nice ?', 'Ça va ?',
    // it
    'Grazie, e cosa dice il contratto sulla disdetta?', 'Va bene?', 'Vale ancora la garanzia?',
    'Cosa devo fare prima della scadenza?', 'Vale molto?',
    // nl
    'Bedankt, en wat staat er in het contract over opzegging?', 'Hoe is het met de betalingstermijn?',
    'Is de prijs prima?', 'Wat is de premie per maand?', 'Graag!', 'Alles graag',
    // pl
    'Dzięki, a co mówi umowa o wypowiedzeniu?', 'Która część umowy dotyczy kar?', 'W porządku?',
    'Dobrze, jakie są terminy płatności?', 'A lot?',
    // tr
    'Teşekkürler, peki sözleşmede fesih süresi ne kadar?', 'Tamam, şimdi belgeyi özetle.',
    'Bu teklif iyi mi, yoksa çok mu pahalı?', 'Peki sure?',
    // ru
    'Спасибо, а что в договоре сказано о расторжении?', 'Хорошо, какие сроки оплаты?',
    'Какой класс энергоэффективности указан?', 'Всё хорошо в этом договоре?', 'Ага', 'Что вам должны по договору?',
    // uk
    'Дякую, а який строк дії договору?', 'Добре, тепер підсумуй документ.', 'Чи все добре з цим рахунком?',
    'Все гаразд?', 'Все добре?', 'Що вам потрібно від договору?',
    // de: «Passt alles?» / «Passt so?» ask whether it fits
    'Passt alles?', 'Passt so?',
    // Every letter now counts: pre-fix the Cyrillic word was dropped and "ok" alone was left.
    'Ok, почему?'
  ])('%s → a real question, not small talk', (q) => {
    expect(isSmallTalk(q)).toBe(false)
  })
})

// #963 (follow-ups wave 5 owner call G-1): which messages in a documents chat get the short small-talk reply instead of
// an answer from the documents. Stricter than `isSmallTalk`. Review round: a question mark anywhere, in any script, makes
// a question (G-1), except in a chit-chat question to the assistant; a thanks or acknowledgement formula follows that
// rule (G-2); and without a question mark the reply needs a social word: thanks, a greeting, a goodbye or praise (G-3).
describe('isSmallTalkReply — the short small-talk reply (#963)', () => {
  it.each([
    // Thanks, greetings and goodbyes in the ten languages.
    'Danke!', 'Thanks!', 'Merci !', 'Vielen Dank!', 'Thank you very much', 'Gracias', 'Grazie mille!', 'Bedankt!',
    'Dziękuję!', 'Teşekkürler', 'Спасибо!', 'Дякую!', 'Hi', 'Hallo', '¡Hola!', 'Bonjour !', 'Buongiorno', 'Hoi',
    'Cześć!', 'Merhaba', 'Привет!', 'Привіт!', 'Bye', 'Tschüss', 'Thanks a lot, bye!', 'Au revoir',
    // Praise, alone or with an acknowledgement (G-3: praise is social).
    'Great, thanks!', 'Super, danke!', 'Ok thanks', 'Perfect', 'Perfetto!', 'Génial', 'Geweldig', 'Świetnie!',
    'Harika', 'Отлично!', 'Чудово', 'Відмінно',
    // Thanks and acknowledgement formulas without a question mark (G-2).
    'Passt', 'Passt, danke!', 'Vale gracias', 'De acuerdo, gracias', 'Va bene grazie', 'Peki teşekkürler',
    // Chit-chat questions to the assistant, with their question mark (G-2).
    'How are you?', 'What can you do?', "Wie geht's?", 'Who are you?', 'Tell me a joke', '¿Qué tal?',
    'Comment ça va ?', 'Come va?', 'Hoe gaat het?', 'Co słychać?', 'Nasılsın?', 'Что ты умеешь?', 'Як справи?'
  ])('%s → the short reply', (q) => {
    expect(isSmallTalkReply(q)).toBe(true)
  })

  it.each([
    // G-1: a question mark anywhere, in any script.
    'Sure?', 'Alles?', 'All?', 'Alles gut?', 'All good?', 'So much?', 'Genau?', 'Bitte?', 'Klar?', 'Okay?', 'Merci ?',
    'Sure?!', 'Alles? 🙂', '¿Bien?', '¿Claro', 'Sure? Thanks', 'Gut? Danke!', 'So much? ok', 'All good? Great, thanks!',
    'Alles klar? Danke', 'Sure\uFF1F', 'Alles\uFF1F', 'Sure\u203D', 'Sure\u2047', 'Sure\u2048', 'Sure\u2049',
    'Sure\u061F',
    // … also with a thanks in the message, so only the question mark sends it to the documents
    'Danke\uFF1F', 'Thanks\u203D', 'Thanks\u2047', 'Thanks\u2048', 'Thanks\u2049', 'Danke\u061F',
    '\u00BFGracias', 'Alles klar\uFF1F Danke',
    // G-2: a thanks or acknowledgement formula with a question mark.
    'Passt?', 'Vale?', '¿Vale?', '¿De acuerdo?', 'Ok va bene?', 'Va bene grazie?', 'Все понятно?', 'Всё понятно?',
    'Peki?', 'Відмінно?', 'Tres bien ?', 'Thanks a lot?',
    // G-3: acceptance and filler words alone answer the assistant's own question or offer.
    'ok', 'Sure', 'All', 'All please', 'Alles', 'Alles bitte', 'Bitte', 'Klar', 'Genau', 'Alles klar', 'you sure',
    'Sounds good', 'Claro', 'Vale', 'Listo', 'De acuerdo', "D'accord", 'Entendu', 'Très bien', 'Certo', 'Prego',
    'Ok va bene', 'Goed', 'Proszę', 'Dobrze', 'Jasne', 'Tamam', 'Peki', 'Ладно', 'Хорошо', 'Пожалуйста', 'Гаразд',
    'Добре', 'Будь ласка',
    // Real questions, and the yes-words the lists leave out.
    'Ok, and the deposit?', 'Danke, was ist mit der Kaution?', 'Wer ist der Mieter?', 'Yes', 'Gerne', 'Weiter', '', '   '
  ])('%s → reads the documents', (q) => {
    expect(isSmallTalkReply(q)).toBe(false)
  })

  it('a filler question or answer stays small talk to the whole-document opt-outs', () => {
    for (const q of ['Sure?', 'Alles?', 'Bitte?', 'Alles gut?', 'Sure\uFF1F', 'Passt?', '¿Vale?', 'ok', 'Alles bitte', 'Vale', 'Ладно']) {
      expect(isSmallTalk(q), q).toBe(true)
    }
  })
})

// #983 (follow-ups wave 6, G-8): "Thanks for the summary" is a thank-you, not a request for the summary. One closed
// shape in ten languages, every token accounted for: THANKS + for + an optional determiner + ONE report or effort noun
// (+ a closing word), or PRAISE + noun (+ THANKS). Never noun-first; no other word. On master these all ran the whole
// report, or a map-reduce with the thank-you as its target ("Thanks for the help!", "Great job!", «Danke für die Hilfe»).
describe('isSmallTalkReply: "thanks for the <noun>" and "great <noun>" (#983)', () => {
  const THANKS_FOR = [
    // English (W §6 c)
    'Thanks for the summary', 'Great summary, thanks!', 'Thanks for the minutes', 'Thank you for the brief',
    'Thanks for the review', 'Nice overview', 'Thanks for the help!', 'Thanks for your help', 'Great job!',
    'Good job, thanks', 'Nice work', 'Thank you very much for the summary', 'Many thanks for the report',
    'Thanks so much for your help', 'Thanks for the summary, bye', 'THANKS FOR THE SUMMARY',
    // German
    'Danke für die Zusammenfassung', 'Vielen Dank für das Protokoll', 'Super Zusammenfassung, danke!',
    'Tolle Zusammenfassung', 'Danke für die Hilfe', 'Gute Arbeit, danke', 'Danke fürs Zusammenfassen',
    'Herzlichen Dank für Ihre Hilfe', 'Danke schön für die Antwort',
    // the eight newer languages: the same shape, each in its own words
    'Merci pour le résumé', "Merci pour l'aide", 'Merci beaucoup pour votre travail', 'Excellent travail, merci',
    'Gracias por el resumen', 'Muchas gracias por la ayuda', 'Buen trabajo, gracias',
    'Grazie per il riassunto', "Grazie per l'aiuto", 'Ottimo lavoro, grazie',
    'Спасибо за резюме', 'Большое спасибо за помощь', 'Отличная работа, спасибо',
    'Bedankt voor de samenvatting', 'Hartelijk bedankt voor de hulp', 'Goed werk, bedankt',
    'Dziękuję za podsumowanie', 'Dzięki za pomoc', 'Świetna robota, dzięki',
    'Özet için teşekkürler', 'Yardım için teşekkür ederim', 'ÖZET İÇİN TEŞEKKÜRLER', 'ozet icin tesekkurler',
    'Harika özet, teşekkürler',
    'Дякую за резюме', 'Щиро дякую за допомогу', 'Чудова робота, дякую'
  ]

  it.each(THANKS_FOR)('%s → the short reply, and small talk to the opt-outs', (q) => {
    expect(isSmallTalkReply(q)).toBe(true)
    expect(isSmallTalk(q)).toBe(true)
  })

  const STILL_REQUESTS = [
    // W §6 c: "Must stay requests"
    'Summarize the summary', 'Thanks, now write the minutes', 'Thanks — can you shorten the summary?',
    'Thanks for the summary. Now list every deadline', 'Thanks for the summary of the risks',
    'Thanks! Tell me about the parking rules', 'Thanks, list every deadline', 'Summary, thanks!', 'Minutes please',
    'The summary please, thanks',
    // more than one noun, a verb, a question mark or a noun before the thanks
    'Thanks for the summary and the minutes', 'Thanks for the summary?', 'Thanks for helping me write the summary',
    'Great, now the summary', 'Nice, summarize this', 'Danke für die Zusammenfassung, jetzt das Protokoll',
    'Danke, schreibe jetzt das Protokoll', 'Zusammenfassung, danke!', 'Danke für die Hilfe. Was steht im Vertrag?',
    // the eight newer languages: the thanks, then a request
    'Merci, maintenant écris le procès-verbal', 'Merci pour le résumé et le rapport', 'Résumé, merci',
    'Gracias, ahora redacta el acta', 'Gracias por el resumen del contrato', 'Resumen, gracias',
    'Grazie, ora scrivi il verbale', 'Grazie per il riassunto del contratto', 'Riassunto, grazie',
    'Спасибо, теперь составь протокол', 'Спасибо за резюме договора', 'Резюме, спасибо',
    'Bedankt, schrijf nu de notulen', 'Bedankt voor de samenvatting van het contract', 'Samenvatting, bedankt',
    'Dziękuję, teraz napisz protokół', 'Dziękuję za podsumowanie umowy', 'Podsumowanie, dziękuję',
    'Teşekkürler, şimdi tutanağı yaz', 'Özet için teşekkürler, şimdi riskleri listele', 'Özet, teşekkürler',
    'Дякую, тепер склади протокол', 'Дякую за резюме договору', 'Резюме, дякую',
    // a noun alone, a thanks alone, the wrong language's "for"
    'Thanks for', 'Thanks for the', 'for the summary', 'Danke for the summary', 'Dank u voor', 'The summary'
  ]

  it.each(STILL_REQUESTS)('%s → not the short reply (still a request)', (q) => {
    expect(isSmallTalkReply(q)).toBe(false)
  })

  it('the short reply stays a subset of small talk, so no message takes both the reply and a document skill', () => {
    for (const q of [...THANKS_FOR, ...STILL_REQUESTS]) {
      if (isSmallTalkReply(q)) expect(isSmallTalk(q), q).toBe(true)
    }
  })

  it('a question mark ends the shape for the opt-outs too: "Thanks for the summary?" asks something', () => {
    for (const q of ['Thanks for the summary?', 'Thanks — can you shorten the summary?', 'Danke für die Hilfe？']) {
      expect(isSmallTalk(q), q).toBe(false)
      expect(isSmallTalkReply(q), q).toBe(false)
    }
  })

  it('the existing replies and requests keep their verdict', () => {
    for (const q of ['Danke!', 'Thanks a lot!', 'Great, thanks!', 'Ok thanks', 'How are you?']) expect(isSmallTalkReply(q), q).toBe(true)
    for (const q of ['Ok, and the deposit?', 'Danke, was ist mit der Kaution?', 'Sure?', 'Alles bitte', 'ok']) {
      expect(isSmallTalkReply(q), q).toBe(false)
    }
  })
})

// Review round 1 (follow-ups wave 6): Form B is an attributive phrase, not an acceptance plus a request, and the
// thank-yous people really type (an article and a possessive, "all your help", an intensifier, the thanks last in Turkish)
// are inside the shape. The worst case of #983 is a request answered with a pleasantry, so every widening has its
// must-stay-request twin.
describe('isSmallTalkReply: Form B holds one phrase, and the common wordings are inside the shape (#983 review round 1)', () => {
  // The tokenizer drops the comma, so "Great, list" and "Great list" were one token list; the raw text decides.
  it.each([
    'Great, list', 'Good, summary', 'Perfect, minutes', 'Great, report', 'Great. Summary', 'Great; list', 'Great — list',
    'Great summary, now list the deadlines', 'Great, continue', 'Very good job, list the deadlines', 'Very, good job',
    'Gut, Liste', 'Super, Liste', 'Super, Fristen', 'Gut Liste', 'Gut zusammenfassen, danke', 'Perfekt, Analyse',
    'Prima, overzicht', 'Top, lijst', 'Goed, samenvatting', 'Dobra, lista', 'Dobra, listę', 'Świetnie, tabelę',
    'Idealnie, podsumowanie', 'Doskonale, raport', 'İyi, liste', 'Harika, rapor', 'Güzel, tablo',
    'Отлично, таблицу', 'Отлично таблицу',
    'Отлично, список', 'Добре, таблицю',
    'Добре таблиця', 'Чудово, таблицю',
    'Bon, résumé', 'Perfecto, resumen', 'Genial, lista', 'Perfetto, tabella', 'Ottimo, elenco'
  ])('%s → an acceptance and a request, not small talk', (q) => {
    expect(isSmallTalkReply(q), q).toBe(false)
    expect(isSmallTalk(q), q).toBe(false)
  })

  it.each([
    'Great summary', 'Great summary, thanks!', 'Tolle Zusammenfassung', 'Gute Arbeit, danke', 'Super Zusammenfassung, danke!',
    'Отличная работа, спасибо',
    'Świetna robota', 'Goed werk', 'Bon travail', 'Ottimo lavoro', 'Harika özet', 'Чудова робота'
  ])('%s → small talk', (q) => {
    expect(isSmallTalkReply(q), q).toBe(true)
    expect(isSmallTalk(q), q).toBe(true)
  })

  it.each([
    // a determiner and a possessive, "all", a praise adjective inside the thanks, an intensifier, the Turkish word order
    'Grazie per il tuo aiuto', "Grazie per l'aiuto", 'Thanks for the great summary', 'Thanks for all your help',
    'Thanks for all the help', 'Danke für all deine Hilfe', 'Danke für die tolle Hilfe',
    'Very good job', 'Really great summary', 'So nice work', 'Muy buen trabajo', 'Sehr gute Arbeit', 'Echt tolle Arbeit',
    'Très bon travail', 'Zeer goed werk', 'Bardzo dobra robota', 'Очень хорошая работа',
    'Çok güzel özet', 'Дуже гарна робота',
    'Teşekkürler, özet için', 'Teşekkür ederim, bu özet için',
    'Danke für die Info', 'Danke für die Tabelle', 'Danke fürs Zusammenfassen'
  ])('%s → small talk (a wording inside the shape)', (q) => {
    expect(isSmallTalkReply(q), q).toBe(true)
    expect(isSmallTalk(q), q).toBe(true)
  })

  // The twin of every widening: one more word, and it is a request again.
  it.each([
    'Thanks for the great summary of the risks', 'Thanks for all your help with the minutes', 'Thanks for some summary',
    'Thanks for my summary', 'Thanks for the your the help', 'Thanks for all all help', 'Thanks for the great',
    'Very good job, list the deadlines', 'Very good summary of the contract', 'Very, good job list',
    'Grazie per il tuo aiuto con il verbale', 'Grazie per il tuo il suo il nostro aiuto',
    'Danke für all deine Hilfe beim Protokoll', 'Danke für die Zusammenfassen', 'Danke für zusammenfassen',
    'Sehr gute Arbeit, schreibe jetzt das Protokoll', 'Muy buen trabajo, ahora el acta',
    'Teşekkürler, özet için şimdi riskleri listele', 'Özet için, teşekkürler ve liste'
  ])('%s → still a request', (q) => {
    expect(isSmallTalkReply(q), q).toBe(false)
  })

  // The accusative forms and the adverbs are no Form B words (they only stand as a request's object, or alone).
  it('an accusative noun or an adverb makes no Form B phrase, but still follows «за» / «za»', () => {
    expect(isSmallTalkReply('Спасибо за таблицу')).toBe(true)
    expect(isSmallTalkReply('Dziękuję za listę')).toBe(true)
    expect(isSmallTalkReply('Отличная таблицу')).toBe(false)
    expect(isSmallTalkReply('Dobra liste')).toBe(false)
  })
})

describe('W7 — SKA-19 synthesis asks veto the needle (§3.3)', () => {
  it('the extended deliverable synonyms keep a "what is the …" synthesis ask on the whole-doc engine', () => {
    for (const q of [
      'what is the most important point?', 'what is the key insight?', 'what is the verdict of the report?',
      'what is the overall picture?', 'was ist das Wichtigste?', 'was ist die Schlussfolgerung?',
      'was ist die zentrale Erkenntnis?', 'wie ist das Gesamtbild?'
    ]) {
      expect(isNeedleShaped(q), q).toBe(false)
    }
  })
})

describe('W7 — SKA-45 word-anchored needle/deliverable shapes (§3.4)', () => {
  it('the German imperative "finde" is a needle even at END of question (was dead as "finde ")', () => {
    expect(isNeedleShaped('wo ich das finde')).toBe(true) // 'finde' is the last token
    expect(isNeedleShaped('finde die Kündigungsfrist')).toBe(true)
    // …but the word boundary keeps it off inflections/compounds (over-fire control).
    expect(isNeedleShaped('was findest du am Vertrag gut?')).toBe(false) // 'findest', not 'finde'
  })

  it('the German "alle" vetoes a needle even at END of question (was dead as "alle ")', () => {
    // "wie viele" would classify this as a needle; the \balle\b deliverable veto keeps it whole-doc.
    expect(isNeedleShaped('wie viele sind das — alle')).toBe(false)
    expect(isNeedleShaped('sind das wirklich alle')).toBe(false)
    // …and does not fire inside 'alles' (word boundary before the 's').
    expect(isNeedleShaped('wie viele Positionen sind es')).toBe(true) // no 'alle' → stays a needle
  })
})

// #939 review S1: "find a" was a substring, so "Find all deadlines" and "Find any deadline", a list, read as a
// single-fact lookup and went to the passage search over a long document (now with only the skill's rules, #831).
describe('isNeedleShaped — "find a" is a word (#939 review)', () => {
  it.each([
    ['Find all deadlines', false],
    ['Find any deadline in this contract', false],
    ['find all action items', false],
    ['Find a deadline in this contract', true],
    ['find an invoice number', true],
    ['Can you find a clause about pets?', true]
  ] as const)('%s → %s', (question, expected) => {
    expect(isNeedleShaped(question)).toBe(expected)
  })
})

// #981 (follow-ups wave 6, G-9 = C2): "When must they give notice?" is a lookup, not a request for the report. The new
// forms are WORD-anchored and definite-singular; German verb-second («Wann endet …») routes like the English twin
// (#582); an each/every/jede/welche veto keeps a list a list. Rows are W §5 (c)'s table ("Should be" column).
// #981 follow-up: the list-all words are words, not pieces of other words, and "all" is the word (not only "all the").
describe('isNeedleShaped: "all" and «liste» are words, not substrings (#981)', () => {
  it.each([
    'When shall the tenant pay?', 'When is it ok to call the landlord before I give notice?',
    'When is the tenant going to install the heating?', 'When was the property listed?', 'Who was the listener?',
    'When is the small fee due?', 'When is it a call for the tenant?', 'When can I install the lock?',
    'When must I stop listening to the landlord?', 'When is the blister pack due?'
  ])('%s → a lookup', (question) => {
    expect(isNeedleShaped(question)).toBe(true)
  })

  it.each([
    'Show me all the deadlines', 'List all the action items', 'When is all the rent due?',
    // master's substring "all the" also caught these; a letter after "the" must not let them through (review O2)
    'How much are all these payments together?', 'What is the total of all their payments?',
    'What is the sum of all these invoices?', 'How much do all those fees add up to?',
    'When must all invoices be paid?', 'When should all of the payments be made?', 'When is all rent due?',
    'Wann ist die Fristenliste fällig?', 'Wann ist die Liste fällig?', 'Wann ist die Aufgabenliste fällig?'
  ])('%s → a list', (question) => {
    expect(isNeedleShaped(question)).toBe(false)
  })
})

// Review round 1 (follow-ups wave 6): the each/every/jede veto and "which" / «welche».
describe('isNeedleShaped: the veto reads quantifiers as words, and a frequency or a relative "which" is no list (#981)', () => {
  it.each([
    'When was the contract signed and which parties signed it?', 'Who is the contact for which department?',
    'When must which documents be submitted?', 'Wann müssen welche Pflichten erfüllt werden?',
    'Wann sind welche Zahlungen fällig?', 'When is each payment due?', 'Wann ist jede Zahlung fällig?'
  ])('%s → a list', (question) => {
    expect(isNeedleShaped(question)).toBe(false)
  })

  it.each([
    // a frequency: one fact, not a list (before the exclusion the veto turned these into the whole report)
    'How much is the rent each month?', 'When is rent due every month?', 'When is the rent due each month?',
    'How much is the service charge each year?', 'What is the late fee for each day of delay?',
    'When is the meeting held every other week?', 'How much do I pay each additional day?',
    'When must I pay each time the rent changes?',
    'Wann ist die Miete jeden Monat fällig?', 'Wie viel kostet die Miete jeden Monat?',
    'Wann muss ich jeden Monat zahlen?', 'Wie viel kostet jede weitere Stunde?', 'Wann ist die Miete jedes Quartal fällig?',
    // a relative or indirect "which" / «welche» after a comma
    'Wo steht, welche Kündigungsfrist gilt?', 'Gibt es eine Klausel, welche die Haftung begrenzt?',
    'Steht im Vertrag, welche Partei die Reparaturen zahlt?', 'Was ist die Strafe, welche bei Verzug fällig wird?',
    'Where does it say, which notice period applies?',
    // the veto's left anchor: "each" inside "breach", "reach", "teach" is no quantifier
    'When must the breach be cured?', 'When can I reach the landlord?', 'When does the teacher teach it?',
    // a letter before "all": "overall" is a report word, but "install", "shall", "call", "small" are none
    'When is the install date?'
  ])('%s → a lookup', (question) => {
    expect(isNeedleShaped(question)).toBe(true)
  })

  it('a frequency AND a list in one question is still a list', () => {
    expect(isNeedleShaped('When is each payment due each month?')).toBe(false)
    expect(isNeedleShaped('Wann ist jede Zahlung jeden Monat fällig?')).toBe(false)
  })
})

describe('isNeedleShaped: word-anchored lookups and the each/every veto (#981)', () => {
  it.each([
    // the issue's phrases, English
    'When must they give notice?', 'When should the rent be paid?', 'When was the contract signed?',
    'When can I terminate the lease?', 'When could they leave?', 'When shall payment be made?',
    'Who is the tenant?', 'Who was the landlord?',
    // German, finite verb right after «wann»
    'Wann müssen wir kündigen?', 'Wann sollen die Zahlungen erfolgen?', 'Wann soll gezahlt werden?',
    'Wann endet der Vertrag?', 'Wann kann ich kündigen?', 'Wann beginnt das Mietverhältnis?',
    'Wann wurde der Vertrag unterschrieben?', 'Wann war die Übergabe?', 'Wann läuft die Frist ab?',
    'Wann können wir ausziehen?', 'Wer ist der Mieter?', 'Wer war die Vermieterin?', 'Wer ist das Unternehmen?'
  ])('%s → a lookup', (question) => {
    expect(isNeedleShaped(question)).toBe(true)
  })

  it.each([
    // plural and open "who/when" forms stay out on purpose
    'Who was present?', 'Who are the parties?', 'Wer sind die Parteien?', 'When are the payments due?',
    'Who is responsible for the budget?', 'Who is mentioned in this document?',
    // lists and reports that a loose substring would catch (W §5 c, C1's collisions)
    'Who is responsible for what?', 'Who is responsible for each action item?', 'Wer ist wofür verantwortlich?',
    'Who are the attendees and what was decided?', 'Wer sind die Teilnehmer und was wurde beschlossen?',
    'When are the deadlines in this contract?', 'Who was assigned which action items?',
    'Who is the tenant? Summarize the lease', 'When must the tenant do what? List every deadline',
    'When are all the deadlines?', 'When is everything due?',
    // a relative clause or a longer word holds the letters but no question
    'Explain the penalty for a tenant who is late', 'Wie schwer ist der Verstoß?', 'wer istanbul',
    'Who issued the invoice?', 'Who isolated the issue?',
    'When arena tickets', 'Wer ist schuld', 'When mustard seeds are sown, I wait'
  ])('%s → not a lookup', (question) => {
    expect(isNeedleShaped(question)).toBe(false)
  })

  // C2's three residual collisions, all each/which: the veto reads them as lists.
  it.each([
    'When must each obligation be fulfilled?', 'When should I act on each obligation?',
    'Wann müssen welche Pflichten erfüllt werden?'
  ])('%s → a list (the veto)', (question) => {
    expect(isNeedleShaped(question)).toBe(false)
  })

  // Two false lookups on master: 'when is' and 'wann ist' matched, nothing vetoed the "each".
  it.each([
    'When is each payment due?', 'When is every payment due?', 'Wann ist jede Zahlung fällig?',
    'Wann ist jeder Betrag fällig?', 'Wann sind welche Zahlungen fällig?'
  ])('%s → a list, no longer a lookup', (question) => {
    expect(isNeedleShaped(question)).toBe(false)
  })

  it('the veto is a word, not a substring: "jedoch" and "everyone" do not veto a lookup', () => {
    expect(isNeedleShaped('Wann ist die Frist, jedoch ohne Verlängerung?')).toBe(true)
    expect(isNeedleShaped('When is the deadline for everyone?')).toBe(true)
  })
})

// #939 review B1: a request for the skill's report keeps the whole-document map prompt as it was, even with a list
// word in it; a plain list request and the every-mention chip are no report.
describe('isReportShaped — a report request, list word or not (#939 review)', () => {
  it.each([
    ['Erstelle das Protokoll mit allen Beschlüssen', true],
    ['Write the minutes including every action item', true],
    ['Give me the minutes of the meeting, listing every decision', true],
    ['Brief this contract. List all risks.', true],
    ['Summarize all the decisions', true],
    ['Review every clause for risks', true],
    ['List all action items', false],
    ['List every deadline in this contract', false],
    ['Liste alle Fristen auf', false],
    ['When is each payment due?', false]
  ] as const)('%s → %s', (question, expected) => {
    expect(isReportShaped(question)).toBe(expected)
  })

  it.each(UI_LANGUAGE_CODES)('%s: the summarize chip is a report, the every-mention chip is none', (code) => {
    expect(isReportShaped(t(code, 'chat.example.summarize'))).toBe(true)
    expect(isReportShaped(t(code, 'chat.example.indemnity'))).toBe(false)
  })
})
