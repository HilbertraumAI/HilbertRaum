import { describe, it, expect } from 'vitest'
import { createRepetitionGuard, dropRepeatedTail } from '../../src/main/services/rag/repetition-guard'

// #994 (follow-ups wave 7, owner calls G-3, G-5; rag-design.md §14.10, measured in §14.10.2): the whole-document engine
// watches the text a model streams and stops a pass whose line repeats six times in a row. Two heading rules for the
// Meeting Minutes recursion were evaluated and left out: an independent review kept finding answers about several
// entities that each rule stopped (reused sub-headings per lease, bold meetings, numbered lease lines). These rows pin
// the trips, every such answer as a control, the escapes the guard accepts, and the cut.

/** Feed `text` in chunks of `size` characters (a stream splits lines anywhere) and return the guard. */
function feed(text: string, size = 7) {
  const guard = createRepetitionGuard()
  for (let i = 0; i < text.length; i += size) {
    if (guard.push(text.slice(i, i + size))) break
  }
  return guard
}
const lines = (...ls: string[]): string => ls.map((l) => `${l}\n`).join('')
const times = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
const L4 = ['A', 'B', 'C', 'D']
const L5 = ['A', 'B', 'C', 'D', 'E']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const ROW = '| 14 days of the request | Party requesting consent must be told about reasonable conditions |'
const HEADER = ['## 1. Important deadlines', '', '| Deadline | What happens |', '|---|---|']
const FIRST_ROW = '| 31 December 2030 | Notice of termination must reach the landlord in writing |'
const CODE = '    return computeTheMonthlyInstalmentAmount(principal)'

/** Meeting minutes with the skill's sections; the last one restates them by design. */
const MINUTES = [
  '## 1. Meeting details',
  'Date: Monday, 20 April 2026, 10:00 in the harbour office',
  '## 2. Attendees',
  '- Jonas Weber (chair), Omar Haddad, Lena Fischer and the two works council members',
  '## 3. Decisions',
  '- The board approves the new parking rules for the delivery yard from 1 June',
  '## 8. Formal minutes version'
]
const SECTIONS = (v: string): string =>
  `## Summary\nThe board met on 3 May and approved the budget.\n## Decisions\n- Budget approved for the year ${v}\n## Action items\n- Anna: send the report to the auditors\n`

describe('repetition guard: the trips (#994)', () => {
  it('run(6): the same table row a sixth time in a row trips', () => {
    const text = lines(...HEADER, FIRST_ROW, ...times(8, () => ROW))
    const guard = feed(text)
    expect(guard.trip?.kind).toBe('run')
    const sixth = text.indexOf(FIRST_ROW) + FIRST_ROW.length + 1 + 5 * (ROW.length + 1)
    expect(guard.trip).toMatchObject({ start: sixth, end: sixth + ROW.length + 1 })
  })

  it('works in any language: a Ukrainian row loop trips like an English one', () => {
    const row = '| 14 днів після запиту | Сторона, що просить згоди, має отримати розумні умови |'
    expect(feed(lines(...times(6, () => row))).trip?.kind).toBe('run')
  })

  it('judges only complete lines: the sixth copy trips when its line ends, not before', () => {
    const guard = createRepetitionGuard()
    for (let i = 0; i < 5; i++) expect(guard.push(`${ROW}\n`)).toBeNull()
    expect(guard.push(ROW)).toBeNull()
    expect(guard.push('\n| next')?.kind).toBe('run')
    // Once tripped it keeps its trip and reads nothing more.
    expect(guard.push(`\n${ROW}\n`)?.end).toBe(guard.trip?.end)
  })
})

// Every input of the wave's two review rounds, and the near misses of the stored answers: none of them is a loop.
describe('repetition guard: answers that are not loops never trip (#994)', () => {
  it.each([
    { name: 'portfolio: ### sub-headings per lease', text: `# Portfolio brief\n\n${L4.map((n) => `## Lease ${n}\n\n### Parties\n- Landlord: Hausverwaltung ${n} GmbH\n- Tenant: Mieter ${n} AG\n\n### Key dates\n- Start: 1 January 202${n.charCodeAt(0) - 64}\n\n`).join('')}` },
    { name: 'portfolio: ### labels with a filler line', text: L5.map((n) => `## Lease ${n}\n\n### Parties\n- Landlord: Hausverwaltung ${n} GmbH\n\n### Termination\nNot stated in the provided text.\n\n`).join('') },
    { name: 'portfolio: bold labels per lease', text: L4.map((n) => `**Lease ${n}**\n\n**Parties**\nLandlord ${n} GmbH and Tenant ${n} AG\n\n**Termination**\nSix months, first possible on 30 June 203${n.charCodeAt(0) - 64}\n\n`).join('') },
    { name: 'portfolio: bold lease, bold label, same first line', text: L5.map((n) => `**Lease ${n} – Firma ${n} GmbH**\n\n**Rent**\nEUR 1,${n.charCodeAt(0)}00 per month, payable in advance\n\n**Termination**\nNot stated in the provided text.\n\n`).join('') },
    { name: 'portfolio: bold label with the same table header', text: L5.map((n) => `**Lease ${n}**\n\n**Key dates**\n| Deadline | What happens |\n|---|---|\n| 1 May 203${n.charCodeAt(0) - 64} | Lease ${n} ends |\n\n`).join('') },
    { name: 'portfolio: numbered lease lines with ### labels', text: `## Portfolio\n${L5.map((n, i) => `${i + 1}. Lease ${n}\n\n### Notice\nThree months to the end of a calendar quarter.\n\n`).join('')}` },
    { name: 'portfolio: plain lease lines with ### labels', text: L5.map((n) => `Lease ${n}:\n### Break option\nNone stated in the document.\n`).join('') },
    // Ten leases or six meetings: a filler line repeats once per entity, with short lines between, which break the run.
    { name: 'portfolio: ten plain lease lines with the same filler', text: times(10, (i) => `Lease ${i + 1}:
### Break option
None stated in the document.
`).join('') },
    { name: 'portfolio: six leases with the same ### filler', text: times(6, (i) => `## Lease ${i + 1}
### Termination
Not specified in the provided text.
`).join('') },
    { name: 'meetings: six bold meetings with the same labels', text: times(6, (i) => `**Meeting of ${i + 3} May**

**Attendees**
Anna, Ben, Carla

**Decisions**
No decisions were recorded.

`).join('') },
    { name: 'portfolio: a short first line under a sub-heading', text: L5.map((n) => `### Tenant\nFirma ${n}\n### Notice\nThree months to the end of a quarter\n`).join('') },
    { name: 'portfolio: a table with the same header per lease', text: L4.map((n) => `## Lease ${n}\n### Rent\n| Item | Amount |\n|---|---|\n| Base rent for unit ${n} | EUR ${1000 + n.charCodeAt(0)} |\n\n`).join('') },
    { name: 'portfolio: a bold "Not stated" per lease', text: L4.slice(0, 3).map((n) => `## Lease ${n}\n**Not stated**\n- Tenant: Firma ${n} GmbH\n`).join('') },
    { name: 'portfolio: bold-only, the same filler per lease', text: ['A', 'B', 'C'].map((n) => `**Lease ${n}**\n**Termination**\nNot specified in the provided text.\n**Rent**\n- EUR ${1000 + n.charCodeAt(0)} per month\n`).join('') },
    { name: 'portfolio: two bold spans per lease', text: times(5, (i) => `- Lease ${i + 1}, tenant Firma ${i + 1} GmbH, rent EUR ${1050 + i * 50}\n**Notice period:** **3 months**\n`).join('') },
    { name: 'portfolio: every lease "Not specified in the provided text."', text: lines(...times(10, (i) => [`*   **Lease ${i + 1}: ${['Rossi & Partner Tax Advisers', 'Haugland Fitness Club', 'Harbor Lane Properties GmbH'][i % 3]}**`, '    *   **Rent:** Not specified in the provided text.', '    *   **Notice Deadline:** Not specified in the provided text.']).flat()) },
    { name: 'meetings: bold meetings with the same labels', text: ['3 May', '10 May', '17 May', '24 May'].map((d) => `**Meeting of ${d}**\n\n**Attendees**\nAnna, Ben, Carla (${d})\n\n**Decisions**\nNo decisions were recorded.\n\n`).join('') },
    { name: 'meetings: "None stated." under the same label', text: [1, 2, 3].map((n) => `**Steering meeting ${n}**\n**Open questions:**\nNone stated.\n**Decisions made:**\n- Decision ${n}: the launch date moves by ${n} weeks\n`).join('') },
    { name: 'minutes: sections that come back with new content', text: lines('## Decisions', '- The board approves the budget for the next financial year', '## Action items', '- Anna: send report', '## Decisions', '- The board appoints a new auditor for the coming year', '## Action items', '- Ben: call the bank', '| Owner | Due |', '|---|---|', '| Carla | 3 May |', '| Dmitri | 9 June |', '## Decisions', '- more') },
    { name: 'minutes: one designed restatement', text: SECTIONS('2026') + '## Formal minutes version\n' + SECTIONS('2026') },
    { name: 'table: a year table', text: lines('| Year | Obligation |', '|---|---|', ...times(8, (i) => `| ${2024 + i} | Pay the annual service charge adjustment |`), '', '## Other terms', '- Deposit: three months of net rent held by the landlord') },
    { name: 'table: ten leases that differ only in their number', text: lines('| Lease | Tenant | Notice |', '|---|---|---|', ...times(10, (i) => `| ${i + 1} | Not stated | Written notice three months before the end of term |`)) },
    { name: 'table: ten leases named in their rows', text: lines('| Lease | Tenant | Notice |', '|---|---|---|', ...times(10, (i) => `| Lease ${i + 1} | Firma ${i + 1} | Written notice three months before the end of term |`)) },
    { name: 'table: the same row in three sections', text: lines(...['## Important deadlines', '## Obligations', '## Termination'].flatMap((h) => [h, '| Date | What happens |', '|---|---|', FIRST_ROW, ''])) },
    { name: 'list: numbered items with the same text', text: lines(...times(8, (i) => `${i + 1}. The tenant must give written notice three months ahead`)) },
    { name: 'list: a 36-row instalment schedule', text: lines(...times(36, (i) => `- Instalment ${i + 1} of EUR 1,200 is due on 1 ${MONTHS[i % 12]} ${2026 + Math.floor(i / 12)}.`)) },
    { name: 'list: thirty per-article rows of one clause', text: lines(...times(30, (i) => `- within fourteen days of the request (Article ${i + 3}.3)`), FIRST_ROW) },
    { name: 'near miss: five identical rows in a row, six not', text: lines(...times(5, () => ROW), FIRST_ROW, ROW) },
    { name: 'near miss: rows and lines of short filler', text: lines('| Item | Value | Source |', '|---|---|---|', ...times(8, () => '| Not stated | Not stated | Not stated |'), ...times(8, () => '- Not stated.'), ...times(8, () => '**Notice:** None'), ...times(8, () => '- **Consequence for the tenant:** Not stated')) },
    { name: 'language: a German answer', text: lines('## Wichtige Fristen', '| Datum | Was passiert | Wer handelt |', '|---|---|---|', '| 31. Dezember 2030 | Die Kündigung muss dem Vermieter schriftlich vorliegen | Mieter |', '| 14 Tage nach Anfrage | Der Vermieter muss über angemessene Bedingungen informieren | Vermieter |', '## Pflichten', '- Der Mieter hält die Räume in gutem Zustand und gibt sie sauber zurück.') },
    { name: 'language: a Ukrainian answer', text: lines('## Важливі строки', '- 31 грудня 2030 року: повідомлення про розірвання має надійти орендодавцю письмово.', '- Протягом 14 днів після запиту: орендодавець повідомляє розумні умови.', '## Обовʼязки', '- Орендар утримує приміщення в належному стані та повертає їх чистими.') }
  ])('$name', ({ text }) => {
    expect(feed(text).trip).toBeNull()
  })

  // Accepted escapes (known-limitations.md, rag-design.md §14.10.2): the guard compares whole lines one after another,
  // so a report that restarts itself is not stopped (it ends at the output cap and the two continuations, as before).
  it.each([
    { name: 'the minutes recursion, three copies', text: lines(...MINUTES, ...MINUTES, ...MINUTES) },
    { name: 'a recursion with the same opening lines', text: `${SECTIONS('2026')}## Formal minutes version\n${SECTIONS('2026')}## Formal minutes version\n${SECTIONS('2026')}` },
    { name: 'a recursion whose first line changes', text: [1, 2, 3, 4].map((i) => `## Summary\nVersion ${i}: the board met on 3 May and approved it.\n## Decisions\n- Budget approved, take ${i} of the list\n`).join('') },
    { name: 'a recursion nested one level deeper each time', text: '# Minutes\n## Summary\nThe board met on 3 May and approved the budget.\n## Formal minutes version\n### Summary\nThe board met on 3 May and approved the budget.\n#### Formal minutes version\n##### Summary\nThe board met on 3 May and approved the budget.\n' },
    { name: 'two sections that repeat as a block', text: '## Aaaa one\nFirst content line of section a\n## Bbbb two\nFirst content line of section b\n'.repeat(4) },
    { name: 'two lines that alternate', text: lines(...times(40, (i) => (i % 2 ? '- The landlord shall maintain the roof and the facade' : '- The tenant shall pay the rent on the first of the month'))) },
    { name: 'a row whose counter cell changes', text: lines(...times(40, (i) => `| Art. ${i} | The tenant shall pay the rent on the first of the month |`)) },
    { name: 'a numbered row loop', text: `| # | Clause |\n|---|---|\n${times(60, (i) => `| ${i + 1} | The tenant shall pay the rent on the first of the month |\n`).join('')}` },
    { name: 'a loop with no newline', text: 'The tenant shall pay, '.repeat(500) }
  ])('escape, not caught: $name', ({ text }) => {
    expect(feed(text).trip).toBeNull()
  })
})

describe('dropRepeatedTail and cutAtTrip: keep the first copy and every new line (#994)', () => {
  it('drops the repeated rows and the empty and separator lines after them, keeping one copy', () => {
    expect(dropRepeatedTail(lines(...HEADER, FIRST_ROW, ...times(5, () => ROW), '', '|---|---|'))).toBe(lines(...HEADER, FIRST_ROW, ROW))
  })

  it('keeps everything when nothing at the end repeats, and returns a prefix of the text', () => {
    const text = lines(...HEADER, FIRST_ROW, ROW)
    expect(dropRepeatedTail(text)).toBe(text)
    expect(dropRepeatedTail('')).toBe('')
  })

  it('finds the first copy of a row however it is numbered', () => {
    expect(dropRepeatedTail(lines(FIRST_ROW, `| 2 ${ROW}`, `| 3 ${ROW}`, `| 4 ${ROW}`))).toBe(lines(FIRST_ROW, `| 2 ${ROW}`))
  })

  it('keeps new rows and short lines right before the loop', () => {
    const line = '- The landlord shall maintain the roof and the facade'
    const before = lines('| # | Tenant | Notice |', '|---|---|---|', '| 1 | Not stated | Three months |', '| 2 | Not stated | Three months |', '- Ben: call the bank')
    const guard = feed(before + lines(...times(7, () => line)))
    expect(guard.trip?.kind).toBe('run')
    guard.cutAtTrip()
    expect(guard.text).toBe(before + lines(line))
    // The line was written once before the new lines: every copy of the loop goes, and the new short lines stay.
    const again = feed(lines(line) + before + lines(...times(7, () => line)))
    again.cutAtTrip()
    expect(again.text).toBe(lines(line) + before)
  })

  // Code review round 5: a looping wholly bold line is content, not an empty heading. The heading strip used to take
  // its first copy and the heading above it, so the cut kept nothing and the turn stored nothing.
  it('keeps the first copy of a looping bold line and the heading above it', () => {
    const bold = '**Clause 4.2: Tenant must give notice within fourteen days**'
    const guard = feed(lines('## Deadlines', '', ...times(6, () => bold)))
    expect(guard.trip?.kind).toBe('run')
    guard.cutAtTrip()
    expect(guard.text).toBe(lines('## Deadlines', '', bold))
  })

  // Code review round 5: the cut compares lines the way the run does, so a row written once without spaces and then
  // with them is one row, and only its first copy stays.
  it('treats a row with and without spaces around its pipes as one row', () => {
    const tight = '|Lease C|Not stated anywhere in the document|'
    const guard = feed(lines('| Lease | Notice |', '|---|---|', tight, ...times(6, () => '| Lease C | Not stated anywhere in the document |')))
    expect(guard.trip?.kind).toBe('run')
    guard.cutAtTrip()
    expect(guard.text).toBe(lines('| Lease | Notice |', '|---|---|', tight))
  })

  it('never leaves a heading with nothing under it after the kept text', () => {
    const line = '- The landlord shall maintain the roof and the facade'
    const guard = feed(lines(line, '- Ben: call the bank', '## Further obligations', ...times(6, () => line)))
    expect(guard.trip?.kind).toBe('run')
    guard.cutAtTrip()
    expect(guard.text).toBe(lines(line, '- Ben: call the bank'))
  })

  it('a heading line that loops keeps its first copy: the cut never strips the looping line itself', () => {
    const guard = feed(lines('The minutes of the planning meeting follow below.', ...times(6, () => '## Formal minutes version')))
    expect(guard.trip?.kind).toBe('run')
    guard.cutAtTrip()
    expect(guard.text).toBe(lines('The minutes of the planning meeting follow below.', '## Formal minutes version'))
  })

  it('cutAtTrip cuts the text back to the first copy, says what it removed, and the guard reads on', () => {
    const before = lines(...HEADER, FIRST_ROW)
    const guard = feed(before + lines(...times(9, () => ROW)), 11)
    const fed = guard.text.length
    expect(guard.trip?.kind).toBe('run')
    const cut = guard.cutAtTrip()
    expect(guard.text).toBe(before + lines(ROW))
    expect(cut).toEqual({ removed: fed - guard.text.length, append: '' })
    expect(guard.trip).toBeNull()
    // The guard restarted on the kept text: one copy is already there, so five more trip it again.
    for (let i = 1; i < 5; i++) expect(guard.push(`${ROW}\n`)).toBeNull()
    expect(guard.push(`${ROW}\n`)?.kind).toBe('run')
  })

  it.each([
    { name: 'a ``` block', open: '```ts', close: '```', code: CODE },
    { name: 'a ~~~ block', open: '~~~', close: '~~~', code: CODE },
    { name: 'a block indented in a list item', open: '  ```js', close: '  ```', code: '  return computeTheMonthlyInstalmentAmount(principal)' }
  ])('a cut inside $name closes it with its own fence', ({ open, close, code }) => {
    const guard = feed(lines('- Here is the function:', open, ...times(7, () => code)))
    expect(guard.trip?.kind).toBe('run')
    expect(guard.cutAtTrip().append).toBe(`${close}\n`)
    expect(guard.text).toBe(lines('- Here is the function:', open, code, close))
  })

  it('a cut after a closed code block adds no fence', () => {
    const guard = feed(lines('```', CODE, '```', ...times(6, () => ROW)))
    guard.cutAtTrip()
    expect(guard.text).toBe(lines('```', CODE, '```', ROW))
  })
})
