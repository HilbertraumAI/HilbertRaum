// The keyword-search rows of #818 (open-issues wave owner call G-8: the query side composes, lowers
// and adds the stored spellings of ı; the index is unchanged), shared by the suites of the app's two
// FTS tables: `conversation-search.test.ts` (messages_fts through `searchMessages`) and
// `hybrid-search.test.ts` (chunks_fts through `keywordSearchChunks`). Both tables use fts5's default
// unicode61 tokenizer and both callers build their MATCH with `buildFtsMatchQuery`, so one table of
// stored texts and typed queries holds for each. What unicode61 stores (measured, SQLite 3.50.4):
// I, İ and I/i + U+0307 as "i"; ı as ı; a Latin accent, composed or as a separate mark, dropped; a
// Cyrillic й (U+0439) kept, but и + U+0306 as a bare и; a mark with no one-code-point form (the
// Russian stress mark, е + U+0301) dropped. Every Turkish letter and every composed or decomposed
// letter is built from code points, so no editor can compose it or swap it for an ASCII look-alike.

const cp = (...points: number[]): string => String.fromCharCode(...points)
const DOTLESS_I = cp(0x0131)
const CAPITAL_DOTTED_I = cp(0x0130)
const ISI = `${DOTLESS_I}s${DOTLESS_I}` // ısı (heat)
const INSULATION = `yal${DOTLESS_I}t${DOTLESS_I}m${DOTLESS_I}` // yalıtımı
const E_ACUTE = cp(0x00e9) // é, one code point
const E_SEPARATE_ACUTE = 'e' + cp(0x0301) // e + U+0301 (combining acute)
const CYRILLIC_MI = cp(0x043c, 0x0456) // мі
const CYRILLIC_SHORT_I = cp(0x0439) // й, one code point
const CYRILLIC_SEPARATE_BREVE = cp(0x0438, 0x0306) // и + U+0306 (combining breve)
const PRIVET = cp(0x043f, 0x0440, 0x0438, 0x0432, 0x0435, 0x0442) // привет (hello)
const PRIVET_STRESSED = cp(0x043f, 0x0440, 0x0438, 0x0432, 0x0435, 0x0301, 0x0442) // привет, U+0301 on the е

/** The stored texts, by a readable label (a failing row prints labels, not invisible marks). */
export const SEARCH_FOLD_STORED = {
  'ısı yalıtımı': `${ISI} ${INSULATION}`,
  'Isı yalıtımı raporu': `Is${DOTLESS_I} ${INSULATION} raporu`,
  'ISI raporu': 'ISI raporu',
  'İSTANBUL gezisi': `${CAPITAL_DOTTED_I}STANBUL gezisi`,
  'İstanbul gezisi': `${CAPITAL_DOTTED_I}stanbul gezisi`,
  istanbul: 'istanbul',
  'I think this is fine': 'I think this is fine',
  'résumé, composed': `r${E_ACUTE}sum${E_ACUTE} attached`,
  'résumé, separate marks': `r${E_SEPARATE_ACUTE}sum${E_SEPARATE_ACUTE} attached`,
  'Re: the offer': 'Re: the offer',
  'мій, composed': `${CYRILLIC_MI}${CYRILLIC_SHORT_I} file`,
  'мій, separate mark': `${CYRILLIC_MI}${CYRILLIC_SEPARATE_BREVE} file`,
  привет: `${PRIVET} again`,
  'привет, stress mark': `${PRIVET_STRESSED} again`
} as const

export type SearchFoldLabel = keyof typeof SEARCH_FOLD_STORED

export interface SearchFoldCase {
  /** How the query is typed, for the row title. */
  typed: string
  query: string
  /** Exactly the stored texts the query finds (no more: a stray "I…" or "Re…" hit fails the row). */
  finds: SearchFoldLabel[]
}

export const SEARCH_FOLD_CASES: SearchFoldCase[] = [
  // The index stores «Isı» as `isı` and «ISI» as `isi`: only the ı/i spellings reach them.
  { typed: '«ısı»', query: ISI, finds: ['ısı yalıtımı', 'Isı yalıtımı raporu', 'ISI raporu'] },
  // A capital I lowers to "i": «Isı» becomes `isı`, spelled `isi` too, so it finds «Isı» and «ISI»;
  // no spelling adds an ı, so it misses «ısı yalıtımı» (the same residual as «isi» below).
  { typed: '«Isı»', query: `Is${DOTLESS_I}`, finds: ['Isı yalıtımı raporu', 'ISI raporu'] },
  // toLowerCase() leaves "i" + U+0307, and the mark used to split the word into "i" OR "stanbul".
  { typed: '«İstanbul»', query: `${CAPITAL_DOTTED_I}stanbul`, finds: ['İSTANBUL gezisi', 'İstanbul gezisi', 'istanbul'] },
  // Without NFC each separate mark cut the word: "re" OR "sume" found only "Re: the offer".
  {
    typed: '«résumé» with separate marks',
    query: `r${E_SEPARATE_ACUTE}sum${E_SEPARATE_ACUTE}`,
    finds: ['résumé, composed', 'résumé, separate marks']
  },
  { typed: '«résumé» composed', query: `r${E_ACUTE}sum${E_ACUTE}`, finds: ['résumé, composed', 'résumé, separate marks'] },
  // unicode61 keeps a composed й but stores и + U+0306 as a bare и, so text stored with the separate
  // mark is found by neither spelling: the query is composed first, so a й typed with the separate
  // mark now finds the composed text (it found only the separate-mark text before #818).
  { typed: '«мій» composed', query: `${CYRILLIC_MI}${CYRILLIC_SHORT_I}`, finds: ['мій, composed'] },
  { typed: '«мій» with a separate mark', query: `${CYRILLIC_MI}${CYRILLIC_SEPARATE_BREVE}`, finds: ['мій, composed'] },
  // The stress mark has no one-code-point form, so NFC keeps it; it used to cut the word into
  // "приве" OR "т", which found nothing. Kept inside the phrase, unicode61 drops it as it does in
  // the stored text, so both stored forms are found.
  { typed: '«привет» with a stress mark', query: PRIVET_STRESSED, finds: ['привет', 'привет, stress mark'] },
  // The residual G-8 accepted: no spelling adds an ı, so a typed «isi» misses «ısı» and «Isı».
  { typed: '«isi»', query: 'isi', finds: ['ISI raporu'] }
]
