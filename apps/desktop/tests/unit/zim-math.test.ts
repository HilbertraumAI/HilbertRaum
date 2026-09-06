import { describe, expect, it } from 'vitest'
import { MAX_DEPTH, MAX_INPUT_CHARS, normalizeMath } from '../../src/main/services/zim/math'

// LaTeX alttext → plain text normaliser for the ZIM converter (#340; rag-design §17 D-Z3).
// Every row below reproduces the design's verified table (design §1 survey table + §2 rule
// table), checked against a working prototype before this TS port was written.

type Row = readonly [latex: string, expected: string]

// The two fixtures also used by zim-html.test.ts (fixtures/zim/article.html and
// fixtures/zim/parsoid-datamw.html).
const FIXTURES: readonly Row[] = [
  ['{\\displaystyle \\mathrm {S+O_{2}\\rightarrow SO_{2}} }', 'S+O2→SO2'],
  ['\\mathrm{N_2 + 3H_2} \\rightarrow \\mathrm{2NH_3}', 'N2 + 3H2 → 2NH3']
]

// Extracted with zimdump from wikipedia_de_climate-change_mini_2026-07.zim, 2026-09-06
// (5 articles, 7 formulas: Omegalage, Öleinheit ×2, Revelle-Faktor, Δ18O ×2, Δ13C).
const REAL_ARCHIVE: readonly Row[] = [
  ['{\\displaystyle \\Omega }', 'Ω'],
  ['{\\displaystyle \\mathrm {1\\,{\\ddot {O}}E=41{,}868\\,MJ} }', '1 OE=41,868 MJ'],
  ['{\\displaystyle {\\mathsf {ML^{2}T^{-2}}}}', 'ML2T-2'],
  [
    '{\\displaystyle {\\frac {\\Delta [\\mathrm {CO} _{2}]/[\\mathrm {CO} _{2}]}{\\Delta [DIC]/[DIC]}}}',
    '(Δ[CO2]/[CO2])/(Δ[DIC]/[DIC])'
  ],
  ['{\\displaystyle W;\\,E}', 'W; E'],
  [
    '{\\displaystyle \\delta ^{18}\\mathrm {O} ={\\Biggl (}{\\frac {{\\bigl (}{\\frac {^{18}\\mathrm {O} }{^{16}\\mathrm {O} }}{\\bigr )}_{\\text{Probe}}}{{\\bigl (}{\\frac {^{18}\\mathrm {O} }{^{16}\\mathrm {O} }}{\\bigr )}_{\\text{Standard}}}}-1{\\Biggr )}\\cdot 1000\\ ^{o}\\!/\\!_{oo}}',
    'δ18O =(((18O/16O)Probe)/((18O/16O)Standard)-1)·1000o/oo'
  ],
  [
    '{\\displaystyle \\delta ^{13}\\mathrm {C} ={\\Biggl (}{\\frac {{\\bigl (}{\\frac {^{13}\\mathrm {C} }{^{12}\\mathrm {C} }}{\\bigr )}_{\\text{Probe}}}{{\\bigl (}{\\frac {^{13}\\mathrm {C} }{^{12}\\mathrm {C} }}{\\bigr )}_{\\text{Standard}}}}-1{\\Biggr )}\\cdot 1000\\ ^{o}\\!/\\!_{oo}}',
    'δ13C =(((13C/12C)Probe)/((13C/12C)Standard)-1)·1000o/oo'
  ]
]

// The UNWRAP family (text, mathrm, mathbb, overline, vec, operatorname, …): the command
// disappears, its one argument is kept and normalises like anything else.
const UNWRAP_ROWS: readonly Row[] = [
  ['\\text{CO}_2', 'CO2'],
  ['\\mathrm{Fe}^{3+}', 'Fe3+'],
  ['\\mathrm{SO_4^{2-}}', 'SO42-'],
  ['\\mathrm{Ca}^{2+} + 2\\mathrm{OH}^-', 'Ca2+ + 2OH-'],
  ['\\mathrm{H_2SO_4}', 'H2SO4'],
  ['^{14}\\mathrm{C}', '14C'],
  ['x \\in \\mathbb{R}', 'x ∈ R'],
  ['\\vec{v} \\cdot \\vec{w}', 'v · w'],
  ['\\overline{AB}', 'AB'],
  ['\\operatorname{d}\\!x', 'dx'],
  ['T = 300\\,\\mathrm{K}', 'T = 300 K'],
  ['\\text{Anteil in }\\%', 'Anteil in %'],
  ['a\\text{ und }b', 'a und b'],
  ['\\mathrm{CO_2\\text{-}Konzentration}', 'CO2-Konzentration']
]

// frac/sqrt (every row that exercises wrap()), arrows, operators, relations and Greek letters.
const OPERATOR_ROWS: readonly Row[] = [
  ['E=mc^{2}', 'E=mc2'],
  ['\\frac{1}{2}mv^{2}', '1/2mv2'],
  ['10^{-3}', '10-3'],
  ['H_2O', 'H2O'],
  ['\\alpha \\beta', 'αβ'],
  ['\\phi \\varphi \\Phi', 'φφΦ'],
  ['\\sqrt{2}', '√2'],
  ['\\sqrt[3]{8}', '3√8'],
  ['\\sqrt[n]{x}', 'n√x'],
  ['\\frac{a+b}{c}', '(a+b)/c'],
  ['\\frac{a}{b+c}', 'a/(b+c)'],
  ['\\frac{(a+b)}{c}', '(a+b)/c'],
  ['\\frac{a b}{c}', '(a b)/c'],
  ['\\frac{1}{2}', '1/2'],
  ['\\frac{\\frac{a}{b}}{c}', '(a/b)/c'],
  ['a \\le b \\ge c \\approx d \\ne e', 'a ≤ b ≥ c ≈ d ≠ e'],
  ['\\lambda = \\frac{c}{f}', 'λ = c/f'],
  ['\\lambda > 0', 'λ > 0'],
  ['\\Delta T \\approx 1{,}5\\,^\\circ\\mathrm{C}', 'ΔT ≈ 1,5°C'],
  ['25^\\circ \\mathrm{C}', '25°C'],
  ['f \\circ g', 'f ∘ g'],
  ['\\sum_{i=1}^{n} i^2', 'Σi=1n i2'],
  ['\\int_0^\\infty e^{-x}\\,dx', '∫0∞e-x dx'],
  ['\\left( \\frac{a}{b} \\right)', '( a/b )'],
  ['\\sin x + \\ln 2', 'sin x + ln 2'],
  ['100\\,\\%', '100 %'],
  ['\\frac{1}{2} \\text{ der } \\mathrm{CO_2}\\text{-Emissionen}', '1/2 der CO2-Emissionen']
]

// Malformed / over-limit input: returned byte-identical, never partially normalised.
const UNCHANGED_INPUTS: readonly string[] = [
  '\\frac{a}',
  'x=\\frac{a}',
  '{a',
  'a}b',
  'a } b',
  '\\unknowncmd{x}',
  '\\foo bar',
  '\\begin{aligned} x \\end{aligned}',
  ''
]

const ALL_MAPPED_ROWS: readonly Row[] = [...FIXTURES, ...REAL_ARCHIVE, ...UNWRAP_ROWS, ...OPERATOR_ROWS]

describe('normalizeMath', () => {
  it('normalises the two fixture formulas shared with zim-html.test.ts', () => {
    for (const [latex, expected] of FIXTURES) expect(normalizeMath(latex), latex).toBe(expected)
  })

  it('normalises the seven real formulas from the climate-change ZIM archive', () => {
    for (const [latex, expected] of REAL_ARCHIVE) expect(normalizeMath(latex), latex).toBe(expected)
  })

  it('renders sub/superscripts as plain characters, never ₂/² Unicode', () => {
    // `<sub>/<sup>` already render plain elsewhere in the converter, and the retrieval-arm
    // tokeniser treats a Unicode subscript/superscript digit as `\p{N}` — a typed "CO2" would
    // never match a literal "CO₂". Every mapped row in this suite must stay plain-character.
    const scriptGlyphs = /[₀-₉⁰-⁹²³¹]/u
    for (const [latex, expected] of ALL_MAPPED_ROWS) {
      const out = normalizeMath(latex)
      expect(out, latex).toBe(expected)
      expect(out, latex).not.toMatch(scriptGlyphs)
    }
    // The corpus prints a space before the script marker inside `\mathrm {…}`; the plain-
    // character rule still applies.
    expect(normalizeMath('\\mathrm {CO} _{2}')).toBe('CO2')
  })

  it('unwraps text/mathrm/mathbb/overline/vec/operatorname and keeps the argument', () => {
    for (const [latex, expected] of UNWRAP_ROWS) expect(normalizeMath(latex), latex).toBe(expected)
  })

  it('renders frac/sqrt (every wrap() row), arrows, operators, relations and Greek letters', () => {
    for (const [latex, expected] of OPERATOR_ROWS) expect(normalizeMath(latex), latex).toBe(expected)
  })

  it('keeps an unrecognised command raw while the rest of the string still normalises', () => {
    expect(normalizeMath('\\alpha+\\unknown{x}')).toBe('α+\\unknown{x}')
  })

  it('returns the input unchanged on malformed LaTeX or input past the length/depth caps', () => {
    for (const s of UNCHANGED_INPUTS) expect(normalizeMath(s), s).toBe(s)

    const tooDeep = '{'.repeat(MAX_DEPTH + 1) + '\\alpha' + '}'.repeat(MAX_DEPTH + 1)
    expect(normalizeMath(tooDeep)).toBe(tooDeep)

    const tooLong = 'a'.repeat(MAX_INPUT_CHARS + 1)
    expect(normalizeMath(tooLong)).toBe(tooLong)
  })

  it('takes already-decoded entities as plain characters (html.ts decodes before calling in)', () => {
    expect(normalizeMath('a < b')).toBe('a < b')
    expect(normalizeMath('a & b')).toBe('a & b')
    expect(normalizeMath('\\text{a > b}')).toBe('a > b')
  })

  it('stays within generous time bounds on adversarial input — the cap and depth guards are the real oracle, not the timing', () => {
    // Five inputs past MAX_INPUT_CHARS: normalizeMath returns immediately on the length
    // check, before any scan, so all five together should take microseconds, not milliseconds.
    const overCapBombs: readonly string[] = [
      '{'.repeat(50_000) + 'x' + '}'.repeat(50_000),
      '\\frac{'.repeat(20_000),
      '\\text{'.repeat(20_000),
      '^{'.repeat(50_000),
      'a'.repeat(100_000)
    ]
    const bombStart = process.hrtime.bigint()
    for (const bomb of overCapBombs) expect(normalizeMath(bomb)).toBe(bomb)
    const bombMs = Number(process.hrtime.bigint() - bombStart) / 1e6
    expect(bombMs).toBeLessThan(50)

    // Four inputs at or just under the char cap, each still fully scanned and rendered.
    // Measured ~25 ms for 100 passes; the 1000 ms ceiling is generous on purpose.
    const atCapPathologies: readonly string[] = [
      '\\frac{a+b}{c-d}'.repeat(260).slice(0, MAX_INPUT_CHARS),
      '{'.repeat(60) + 'a+b '.repeat(400) + '}'.repeat(60),
      '\\alpha ^{2}'.repeat(300),
      'x_{i}'.repeat(700)
    ]
    const capStart = process.hrtime.bigint()
    for (let pass = 0; pass < 100; pass++) {
      for (const s of atCapPathologies) normalizeMath(s)
    }
    const capMs = Number(process.hrtime.bigint() - capStart) / 1e6
    expect(capMs).toBeLessThan(1000)
  })
})
