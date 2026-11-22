import { describe, it, expect } from 'vitest'

// #996 B (follow-ups wave 7): `endsMidSentence` decides whether an answer whose cut pass was continued, and whose
// continuation then ended with a clean 'stop', still stops mid-sentence (then `continueUntilComplete` stamps it as
// cut). A false "mid" stamps a complete answer "Reply cut off". The rule judges the last line against the answer's
// own style (review round 3): a last line that ends in a word is mid only after at least 4 earlier long lines, most
// of them terminated. So most rows put their last line after `PROSE`, four terminated sentences, where only the
// shape under test can keep it complete; the review's inputs run as they were found. The integration rows (the
// stamp itself) are in rag-whole-doc-mapreduce.test.ts and rag.test.ts.

import { endsMidSentence } from '../../src/main/services/rag/answer-end'

/** A list item of 15 words, ended by `end` ('.' or ''). */
const longItem = (i: number, end: string): string =>
  `- Clause ${i}: the tenant keeps the premises in good repair and returns them clean${end}`
/** `n` long items in the answer's style (each ended by `end`), then `last`. */
const listThen = (n: number, end: string, last: string): string =>
  [...Array.from({ length: n }, (_, i) => longItem(i + 1, end)), last].join('\n')

/** Four terminated sentences of 8 words or more: an answer written in full sentences. */
const PROSE_LINES = [
  'The lease runs for five years from the first of July 2026.',
  'The tenant pays the rent on the first working day of each month.',
  'The deposit equals three monthly rents and is held in a separate account.',
  'Either party may end the lease with three months notice to the quarter end.'
]
const PROSE = PROSE_LINES.join('\n')
const afterProse = (last: string): string => `${PROSE}\n${last}`

// The real cut answer (wave 6, 4B Contract Brief, `4b-r1-979-CB-p1`): 22 long items ending with a full stop, then
// the continuation's clean 'stop' in the middle of the last one.
const CUT_ITEM =
  '- Costs: the costs incurred by a party in connection with these provisions are borne by that party unless ' +
  'the lease provides otherwise or'
/** Long table rows, which never take a terminator: the real answer interleaves its items with tables like these. */
const TABLE = [
  '| Item | Date / period / trigger | Notes | Source |',
  '|-----|------------------------|-------|--------|',
  '| Effective/start date | 1 July 2026 | The lease term begins on this date | Notes |',
  '| End date | 30 June 2031 | The lease runs for a fixed period of five years | Notes |',
  '| Notice | 31 December 2030 | Written notice to the other party by registered letter | Notes |',
  '| Renewal option | 1 July 2031 | The tenant may extend the lease once for five years | Notes |'
].join('\n')
/** A code block of long lines without terminators. */
const CODE = [
  '```',
  'const total = items.reduce((sum, item) => sum + item.amount, 0)',
  'const rate = total / months / tenants / buildings * factor',
  'const a = b + c + d + e + f + g + h',
  'const x = y + z + w + v + u + t + s',
  '```'
].join('\n')

describe('endsMidSentence: endings a complete answer can have read as complete', () => {
  it.each<[string, string]>([
    // Structure.
    ['table row', afterProse('| Notice to quit by 31 December 2030 | 34.1 |')],
    ['table row without a closing pipe', afterProse('| Notice to quit | 31 December 2030')],
    ['markdown heading', afterProse('## Next steps for the tenant and the landlord')],
    ['bold-only heading line', afterProse('**Open questions about the deposit and the keys**')],
    ['rule', afterProse('---')],
    ['inside an open code block', afterProse('```ts\nconst total = items.reduce((sum, item) => sum + item.amount')],
    // Brackets, quotes and code.
    ['closing bracket', afterProse('The notice period is six months (Article 34.1)')],
    ['closing bracket, then a citation marker', afterProse('The notice period is six months (Article 34.1) [S2]')],
    ['closing guillemet', afterProse('Der Vertrag nennt das Dokument «Übergabeprotokoll»')],
    ['German guillemets »…«', afterProse('Das regelt der Abschnitt »Kündigung« im Vertrag »Laufzeit«')],
    ['German single guillemets ›…‹', afterProse('Das regelt der Abschnitt ›Kündigung‹ im Vertrag ›Laufzeit‹')],
    ['French guillemets with spaces', afterProse('Le bail précise « durée de trois ans »')],
    ['German closing quote', afterProse('Der Vertrag sagt dazu „Die Frist beträgt sechs Monate“')],
    ['English closing quote', afterProse('The clause reads “the tenant shall pay all utilities”')],
    ['inline code span', afterProse('Run the command `npm ci`')],
    ['bold inline code span', afterProse('Then run the build with **`npm run build`**')],
    // Citation markers, set aside first.
    ['citation marker after the full stop', afterProse('The rent is due on the first working day of each month. [S3]')],
    ['two citation markers before the full stop', afterProse('The deposit equals three monthly rents [S1, S2].')],
    ['markers joined by a comma', afterProse('The deposit is due within one month. [S1], [S2]')],
    ['markers joined by a semicolon', afterProse('The deposit is due within one month. [S1]; [S2]')],
    ['markers joined by "and"', afterProse('The deposit is due within one month. [S1] and [S2]')],
    ['markers joined by «und»', afterProse('Die Kaution ist innerhalb eines Monats fällig. [S1] und [S2]')],
    ['a marker range', afterProse('The deposit is due within one month. [S1-S3]')],
    ['a label whose value is the markers', afterProse('Sources: [S1], [S2]')],
    // Symbols and emoji.
    ['a percent sign', afterProse('The rent rises each year by 3 %')],
    ['a euro sign', afterProse('Die Kaution beträgt insgesamt 1.500 €')],
    ['emoji', afterProse('All three deadlines are in the calendar now 🎉')],
    ['emoji with a variation selector', afterProse('All three deadlines are in the calendar now ✅\uFE0F')],
    ['emoji with a skin tone', afterProse('All three deadlines are in the calendar now 👍🏽')],
    ['keycap emoji', afterProse('That was step one of the move 1\uFE0F\u20E3')],
    ['emoji joined by a zero-width joiner', afterProse('The whole household signed it 👨\u200D👩\u200D👧')],
    // Terminators.
    ['English sentence', afterProse('The notice period is six months.')],
    ['German sentence', afterProse('Die Kündigungsfrist beträgt sechs Monate zum Quartalsende.')],
    ['Polish sentence', afterProse('Okres wypowiedzenia wynosi sześć miesięcy.')],
    ['French question', afterProse('Voulez-vous que je vérifie autre chose ?')],
    ['Russian sentence', afterProse('Срок уведомления составляет шесть месяцев.')],
    ['Turkish sentence', afterProse('Fesih bildirim süresi altı aydır.')],
    ['Chinese sentence', afterProse('租金每月支付。')],
    ['Hindi sentence (danda)', afterProse('किराया हर महीने की पहली तारीख को देना होता है।')],
    ['Greek question with a semicolon', afterProse('Θέλετε να δείτε και τις προθεσμίες;')],
    ['Greek question mark', afterProse('Θέλετε να δείτε και τις προθεσμίες\u037E')],
    ['ellipsis', afterProse('The list goes on in the same way…')],
    ['emphasis after the full stop', afterProse('The rent is **EUR 1,250 per month.**')],
    // Too short, or not in the answer's own terminated style.
    ['a short last line', afterProse('See Article 2')],
    ['a short last list item', afterProse('- Tenant: Okonkwo Design Studio GmbH')],
    ['a cut line after only three terminated long lines', `${PROSE_LINES.slice(0, 3).join('\n')}\nand then the tenant must pay the`],
    ['a long item in a list written without full stops', listThen(6, '', CUT_ITEM)],
    ['a long item with too few earlier long items to show a style', listThen(3, '.', CUT_ITEM)],
    ['a long item after a mixed-style list (under 70 % ended)', `${listThen(3, '.', '')}\n${listThen(2, '', CUT_ITEM)}`],
    // The accepted miss: a list-style answer is never judged, even when its last item was cut.
    ['a list-style answer whose last item ends "the tenant must pay the"', listThen(6, '', '- The deposit is held in trust and the tenant must pay the')],
    // The review's inputs (round 3), as found: list shapes the rule does not know, and plain last lines.
    ['review: markers joined by a comma', 'The deposit is due within one month. [S1], [S2]'],
    ['review: a sources footer', 'Answer text.\n\nSources: [S1], [S2]'],
    ['review: markers joined by "and"', 'The deposit is due within one month. [S1] and [S2]'],
    ['review: a lettered list', 'The duties are:\na) Der Mieter zahlt die Kaution\nb) Der Vermieter übergibt die Schlüssel'],
    ['review: a list lettered in brackets', '(a) the tenant pays the deposit\n(b) the landlord hands over the keys'],
    ['review: an en-dash list', '– Miete 500 EUR pro Monat\n– Kaution drei Monatsmieten in bar'],
    ['review: an emoji list', '✅ The lease runs until 2027\n✅ The tenant may sublet with consent'],
    ['review: bold terms with a dash', '**Term** – 12 months from signing\n**Notice** – three months to quarter end'],
    ['review: French guillemets', 'Le bail précise « durée de trois ans »'],
    ['review: a signature', 'Mit freundlichen Grüßen\n\nDr. Max Mustermann, Leiter Recht'],
    ['review: a URL', 'More details are available at https://example.com/docs'],
    ['review: a unit', 'Die Wohnfläche beträgt insgesamt 85 m²'],
    ['review: a date', 'The lease ends on 31 December 2027'],
    // Round 4 (code review of the stacked W2 branch): a dash or a slash at the end is not always open.
    ['review round 4: a dash as the not-stated value', listThen(22, '.', '- **Renewal option:** —')],
    ['review round 4: a URL ending in a slash', 'More information is on the landlord website at https://example.com/'],
    ['a bold term whose value is a dash', afterProse('**Option to renew the lease for five more years** —')],
    ['a long label whose value is n/a', afterProse('Option to renew the lease once for another five years: n/a')],
    ['a line ending in a dash outside a terminated style', 'The deposit is returned within six months –'],
    ['empty text', '']
  ])('complete: %s', (_name, text) => {
    expect(endsMidSentence(text)).toBe(false)
  })
})

describe('endsMidSentence: an answer cut mid-sentence reads as mid', () => {
  it.each<[string, string]>([
    ['the real cut Contract Brief item', listThen(22, '.', CUT_ITEM)],
    ['the real cut item, then a citation marker', listThen(22, '.', `${CUT_ITEM} [S1]`)],
    ['the real cut item, then markers joined by "and"', listThen(22, '.', `${CUT_ITEM} [S1] and [S2]`)],
    ['a long item after four terminated long items', listThen(4, '.', CUT_ITEM)],
    ['a cut last line after terminated lines and a table', `${PROSE}\n${TABLE}\n${CUT_ITEM}`],
    ['a cut last line after terminated lines and a code block', `${PROSE}\n${CODE}\nThe command runs every suite in the`],
    ['a prose answer whose last line ends "the tenant must pay the"', afterProse('If the deposit is not paid on time, the tenant must pay the')],
    ['a cut sentence, then a citation marker', afterProse('The costs are borne by that party unless the lease provides otherwise or [S1]')],
    ['a cut sentence, then two citation markers', afterProse('The costs are borne by that party unless the lease provides otherwise or [S1, S2]')],
    ['a cut sentence, then markers joined by a comma', afterProse('The costs are borne by that party unless the lease provides otherwise or [S1], [S2]')],
    // A terminator counts toward the style wherever it comes from: these earlier items end with one.
    [
      'a cut item after items ending with a danda',
      [
        ...Array.from({ length: 4 }, (_, i) => `- अनुच्छेद ${i + 1}: किरायेदार परिसर को अच्छी हालत में रखता है और अंत में उसे साफ लौटाता है।`),
        '- लागत: इन प्रावधानों के संबंध में किसी पक्ष द्वारा किया गया खर्च वही पक्ष वहन करता है जब तक'
      ].join('\n')
    ],
    ['a cut item after items ending with an emoji with a skin tone', [...Array.from({ length: 4 }, (_, i) => `${longItem(i + 1, '')} 👍🏽`), CUT_ITEM].join('\n')],
    [
      'a cut item after items ending with the Greek question mark',
      [
        ...Array.from({ length: 4 }, (_, i) => `- Ερώτηση ${i + 1}: ο μισθωτής διατηρεί το ακίνητο σε καλή κατάσταση και το επιστρέφει καθαρό\u037E`),
        '- Κόστος: τα έξοδα που προκύπτουν για ένα μέρος σε σχέση με αυτές τις διατάξεις βαρύνουν το μέρος αυτό εκτός αν'
      ].join('\n')
    ],
    // A last character that leaves the sentence open is mid whatever the answer's style.
    ['a trailing comma', 'The tenant pays the rent,'],
    ['a trailing colon', 'The parties agree on the following:'],
    ['a trailing semicolon on a line that is not Greek', 'The tenant pays the rent;'],
    // A dash or a slash at the end is judged like a word (round 4): open in a sentence of a terminated answer.
    ['a trailing dash in a terminated answer', afterProse('If the deposit is not paid on time, the tenant must pay the –')],
    ['a trailing slash in a terminated answer', afterProse('The deposit is returned to the tenant unless the landlord /')],
    ['an open bracket', 'The notice period is six months ('],
    ['a trailing ampersand', 'Signed by Hafen Immobilien &'],
    // Prose ending in a word, in the answer's terminated style.
    ['English prose', afterProse('The first half of the answer and the second half ends with the')],
    ['prose ending in a number', afterProse('The monthly rent amounts to EUR 18')],
    ['prose after a closed inline code span', afterProse('Run the command `npm ci` before you')],
    ['German prose', afterProse('Die Kosten trägt jede Partei selbst, sofern der Vertrag nichts anderes')],
    ['Polish prose', afterProse('Najemca płaci czynsz do dziesiątego dnia każdego')],
    ['French prose', afterProse('Le locataire doit payer le loyer avant le')],
    ['Russian prose', afterProse('Арендатор оплачивает аренду до десятого числа каждого')],
    ['Turkish prose', afterProse('Kiracı kirayı her ayın onuncu gününe kadar')],
    ['Hindi prose ending in a vowel sign', afterProse('किराया हर महीने की पहली तारीख को देना')],
    ['prose after a quote marker', afterProse('> The landlord may enter the premises after giving')]
  ])('mid: %s', (_name, text) => {
    expect(endsMidSentence(text)).toBe(true)
  })
})
