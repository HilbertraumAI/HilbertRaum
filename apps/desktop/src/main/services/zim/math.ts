// LaTeX alttext → plain text, for ZIM `<math alttext>` (#340; rag-design §17 D-Z3).
//
// `html.ts` emits a formula's alttext once, entity-decoded (`normalizeMath(decodeEntities(alt))`)
// and drops the MathML rendering subtree. This module turns that decoded LaTeX source into
// plain text: `\frac{1}{2}mv^{2}` → `1/2mv2`, `\alpha \le \beta` → `α ≤ β`. Sub/superscripts
// become PLAIN characters, never ₂/² — `<sub>/<sup>` already render plain elsewhere in the
// converter, and the retrieval-arm tokeniser (`arm.ts` `queryTerms` = `/[\p{L}\p{N}]{3,}/gu`,
// `overlapScore` = `includes`) treats `₂` as `\p{N}`, so a typed "CO2" would never match a
// literal `CO₂` — that's the mechanical reason, not just cosmetics.
//
// A single-cursor tokenizer over an explicit stack, NOT regexes: nested braces (real in the
// corpus — nested `\frac`) need either a nested quantifier or a fixpoint loop, both
// super-linear. Each input index is consumed once; only `\frac`/`\sqrt` arguments materialise
// into a new string, so the worst case is O(n · fracDepth) char copies — bounded by
// MAX_INPUT_CHARS and MAX_DEPTH below, never by the size of an untrusted document.
//
// Returns the input UNCHANGED (never throws, never partially normalises) iff: over the char
// cap, unbalanced braces, nesting past MAX_DEPTH, or an argument-taking command missing its
// argument. An unrecognised `\command` is emitted raw with its backslash, and the brace group
// immediately after it keeps its braces — the rest of the string still normalises around it.

export const MAX_INPUT_CHARS = 4_000
export const MAX_DEPTH = 64

/** Zero-argument commands that render as one plain string. */
const SYMBOLS: Readonly<Record<string, string>> = {
  // Greek — lower case
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', varkappa: 'ϰ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // Greek — upper case (the eleven LaTeX defines)
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Arrows
  rightarrow: '→', to: '→', longrightarrow: '→', xrightarrow: '→',
  leftarrow: '←', gets: '←', longleftarrow: '←',
  leftrightarrow: '↔', longleftrightarrow: '↔',
  Rightarrow: '⇒', implies: '⇒', Longrightarrow: '⇒',
  Leftarrow: '⇐', Longleftarrow: '⇐',
  Leftrightarrow: '⇔', iff: '⇔', Longleftrightarrow: '⇔',
  rightleftharpoons: '⇌', leftrightharpoons: '⇋',
  uparrow: '↑', downarrow: '↓', mapsto: '↦', nearrow: '↗', searrow: '↘',
  // Binary operators
  times: '×', cdot: '·', cdotp: '·', div: '÷', pm: '±', mp: '∓',
  ast: '*', star: '*', bullet: '•', setminus: '\\', oplus: '⊕', otimes: '⊗',
  // Relations
  le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥',
  ne: '≠', neq: '≠', ll: '≪', gg: '≫', lt: '<', gt: '>',
  approx: '≈', sim: '~', simeq: '≃', cong: '≅', equiv: '≡', propto: '∝',
  // Analysis / sets / logic
  infty: '∞', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π',
  int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', perp: '⊥', parallel: '∥', angle: '∠',
  // Miscellany
  degree: '°', prime: '′', dots: '…', ldots: '…', cdots: '…', vdots: '⋮', ddots: '⋱',
  aleph: 'ℵ', ell: 'ℓ', hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ', imath: 'i', jmath: 'j',
  langle: '⟨', rangle: '⟩', lbrace: '{', rbrace: '}', vert: '|', mid: '|', backslash: '\\',
  // Function names render as their own word
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', coth: 'coth',
  log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', lim: 'lim', limsup: 'limsup', liminf: 'liminf',
  max: 'max', min: 'min', sup: 'sup', inf: 'inf', det: 'det', dim: 'dim', ker: 'ker',
  deg: 'deg', arg: 'arg', gcd: 'gcd', bmod: 'mod',
  // Escaped literals (single-character command names)
  '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#', _: '_'
}

/** Zero-argument commands that render as one space. */
const SPACES = new Set([',', ';', ':', ' ', '\\', 'quad', 'qquad', 'enspace', 'thinspace', 'medspace', 'thickspace'])

/** Zero-argument commands that render as nothing. */
const DROPPED = new Set([
  '!', 'negthinspace', 'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle',
  'limits', 'nolimits', 'mathstrut', 'nonumber'
])

/** Delimiter-size commands: render as nothing and swallow a following `.` (null delimiter). */
const DELIMS = new Set([
  'left', 'right', 'middle',
  'big', 'Big', 'bigg', 'Bigg',
  'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
  'bigm', 'Bigm', 'biggm', 'Biggm'
])

/** One-argument commands whose argument is kept and whose own markup disappears. */
const UNWRAP = new Set([
  'text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'textnormal',
  'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathnormal',
  'mathbb', 'mathcal', 'mathfrak', 'mathscr', 'boldsymbol', 'bm',
  'mbox', 'hbox', 'operatorname', 'ce',
  'overline', 'underline', 'bar', 'vec', 'hat', 'widehat', 'tilde', 'widetilde',
  'dot', 'ddot', 'dddot', 'acute', 'grave', 'check', 'breve', 'mathring',
  'overrightarrow', 'overleftarrow', 'overbrace', 'underbrace'
])

const isSpace = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
const isAlnum = (c: string): boolean => isLetter(c) || (c >= '0' && c <= '9')

/** Balance + depth pre-pass. */
function scanOk(src: string): boolean {
  let depth = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') {
      depth++
      if (depth > MAX_DEPTH) return false
    } else if (c === '}') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

const COMPOUND = /[ +\-*/=±∓×·÷]/

function wrapped(s: string): boolean {
  if (s.length < 2 || s[0] !== '(' || s[s.length - 1] !== ')') return false
  let d = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') {
      d--
      if (d === 0) return i === s.length - 1
    }
  }
  return false
}

const wrap = (s: string): string => (s.length > 0 && COMPOUND.test(s) && !wrapped(s) ? `(${s})` : s)

interface FracOp {
  kind: 'frac'
  args: string[]
  need: 2
  opt: null
}

interface SqrtOp {
  kind: 'sqrt'
  args: string[]
  need: 1
  opt: string | null
}

type Op = FracOp | SqrtOp

interface Frame {
  start: number
  op: Op | null
  keepBraces: boolean
}

function render(src: string): string | null {
  const out: string[] = []
  const stack: Frame[] = [{ start: 0, op: null, keepBraces: false }]
  let afterScript = false
  let keepNext = false
  let i = 0
  const n = src.length

  const top = (): Frame => stack[stack.length - 1]

  /** Trim emitted trailing spaces, never below the open frame's start. */
  const trimTail = (): void => {
    while (out.length > top().start && out[out.length - 1] === ' ') out.pop()
  }

  const applyOp = (op: Op): void => {
    if (op.kind === 'frac') out.push(`${wrap(op.args[0])}/${wrap(op.args[1])}`)
    else out.push(`${op.opt ?? ''}√${wrap(op.args[0])}`)
  }

  /** Ask for the next argument of `op` (or of an unwrap when `op` is null). false = malformed. */
  const requestArg = (op: Op | null): boolean => {
    while (i < n && isSpace(src[i])) i++
    if (i >= n) return false
    if (src[i] === '{') {
      i++
      stack.push({ start: out.length, op, keepBraces: false })
      return true
    }
    if (src[i] === '\\' || isAlnum(src[i])) {
      // A single-token argument. A command token is rendered by the main loop; for an
      // op we take only the simple alphanumeric form and refuse the rest.
      if (isAlnum(src[i])) {
        const ch = src[i++]
        if (op === null) out.push(ch)
        else {
          op.args.push(ch)
          if (op.args.length === op.need) applyOp(op)
          else return requestArg(op)
        }
        return true
      }
      if (op === null) return true // `\mathrm\alpha` — let the main loop render the command
      return false
    }
    return false
  }

  while (i < n) {
    const c = src[i]

    if (c === '{') {
      i++
      stack.push({ start: out.length, op: null, keepBraces: keepNext })
      if (keepNext) out.push('{')
      keepNext = false
      afterScript = false
      continue
    }

    if (c === '}') {
      const f = stack.pop()
      if (f === undefined || stack.length === 0) return null // guarded by scanOk
      i++
      keepNext = false
      afterScript = false
      if (f.op === null) {
        if (f.keepBraces) out.push('}')
        continue
      }
      const text = out.splice(f.start).join('').trim()
      f.op.args.push(text)
      if (f.op.args.length === f.op.need) applyOp(f.op)
      else if (!requestArg(f.op)) return null
      continue
    }

    if (c === '_' || c === '^') {
      // Sub- and superscripts become PLAIN characters: drop the marker, drop the space the
      // TeX printer leaves before it, and let the operand render normally.
      i++
      trimTail()
      while (i < n && isSpace(src[i])) i++
      afterScript = true
      keepNext = false
      continue
    }

    if (c === '\\') {
      const start = i
      i++
      if (i >= n) {
        out.push('\\')
        break
      }
      let name: string
      let word = false
      if (isLetter(src[i])) {
        const from = i
        while (i < n && isLetter(src[i])) i++
        name = src.slice(from, i)
        word = true
        if (i < n && src[i] === '*') i++ // \operatorname*
      } else {
        name = src[i]
        i++
      }
      const spacedBefore = out.length > top().start && out[out.length - 1] === ' '
      /** TeX absorbs the space that terminates a control word; one is kept when the symbol
       *  had a space on its left, or when the replacement ends in a letter (\sin x). */
      const swallow = (emitted: string): void => {
        if (!word) return
        let j = i
        while (j < n && isSpace(src[j])) j++
        if (j === i) return
        i = j
        const last = emitted.slice(-1)
        const nextIsRelation = j < n && (src[j] === '=' || src[j] === '<' || src[j] === '>' || src[j] === '+')
        if (emitted.length > 0 && (spacedBefore || isLetter(last) || nextIsRelation)) out.push(' ')
      }

      if (name === 'circ') {
        out.push(afterScript ? '°' : '∘')
        swallow('°')
        afterScript = false
        keepNext = false
        continue
      }
      if (DROPPED.has(name)) {
        swallow('')
        afterScript = false
        keepNext = false
        continue
      }
      if (SPACES.has(name)) {
        out.push(' ')
        afterScript = false
        keepNext = false
        continue
      }
      if (DELIMS.has(name)) {
        let j = i
        while (j < n && isSpace(src[j])) j++
        if (j < n && src[j] === '.') i = j + 1
        else swallow('')
        afterScript = false
        keepNext = false
        continue
      }
      if (Object.hasOwn(SYMBOLS, name)) {
        out.push(SYMBOLS[name])
        swallow(SYMBOLS[name])
        afterScript = false
        keepNext = false
        continue
      }
      if (UNWRAP.has(name)) {
        afterScript = false
        keepNext = false
        if (!requestArg(null)) return null
        continue
      }
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
        afterScript = false
        keepNext = false
        if (!requestArg({ kind: 'frac', args: [], need: 2, opt: null })) return null
        continue
      }
      if (name === 'sqrt') {
        afterScript = false
        keepNext = false
        let opt: string | null = null
        let j = i
        while (j < n && isSpace(src[j])) j++
        if (j < n && src[j] === '[') {
          const close = src.indexOf(']', j + 1)
          if (close < 0) return null
          opt = normalizeMath(src.slice(j + 1, close))
          i = close + 1
        }
        if (!requestArg({ kind: 'sqrt', args: [], need: 1, opt })) return null
        continue
      }
      // Unknown: the command stays raw, and the brace group it introduces keeps its braces.
      out.push(src.slice(start, i))
      afterScript = false
      keepNext = true
      continue
    }

    if (isSpace(c)) {
      let j = i
      while (j < n && isSpace(src[j])) j++
      i = j
      if (out.length > top().start || stack.length > 1) out.push(' ')
      afterScript = false
      continue
    }

    if (c === '~') {
      i++
      out.push(' ')
      afterScript = false
      keepNext = false
      continue
    }

    out.push(c)
    i++
    afterScript = false
    keepNext = false
  }

  if (stack.length !== 1 || stack[0].op !== null) return null
  return out.join('').replace(/\s+/g, ' ').trim()
}

/** Normalise a LaTeX source string (already entity-decoded) to plain text. Never throws;
 *  returns the input unchanged when it exceeds the char cap or fails to parse cleanly
 *  (unbalanced braces, nesting past MAX_DEPTH, an argument-taking command missing its
 *  argument) — callers always get back displayable text. */
export function normalizeMath(latex: string): string {
  if (latex.length === 0 || latex.length > MAX_INPUT_CHARS) return latex
  if (!scanOk(latex)) return latex
  const rendered = render(latex)
  return rendered === null ? latex : rendered
}
