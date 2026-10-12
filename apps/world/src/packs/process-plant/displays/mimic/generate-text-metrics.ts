import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as hb from 'harfbuzzjs'
import type { OpenBridgeTextStyle } from './text-metrics.ts'

// Generates openbridge-text-metrics.json, the widths text-metrics.ts reserves
// for OpenBridge's text. Nothing here is a typed number. Each mimic text part
// names the OpenBridge component rules that style it; its typography is read
// from the installed package (the components' own styles and the custom
// properties of openbridge.css), and HarfBuzz, the shaper Chrome uses, shapes
// the package's Noto Sans with it. The JSON is checked in so the server needs
// neither the package nor HarfBuzz (both are build-time dependencies);
// tests/mimic-text-metrics.test.ts regenerates it and fails on any difference.
//
//   bun src/packs/process-plant/displays/mimic/generate-text-metrics.ts

const PACKAGE = '@oicl/openbridge-webcomponents'
const STACK = 'dist/components/automation-button-readout-stack/automation-button-readout-stack.css.js'
const TEXTBOX = 'dist/components/textbox/textbox.css.js'
const READOUT_BLOCK = 'dist/building-blocks/readout-block/readout-block.css.js'
const ALERT_FRAME = 'dist/components/alert-frame/alert-frame.css.js'
const GLOBAL_STYLES = 'dist/openbridge.css'
const FONT = 'dist/NotoSans.ttf'
export const TEXT_METRICS_FILE = fileURLToPath(new URL('./openbridge-text-metrics.json', import.meta.url))

/** One element between a component's shadow root and the text: the stylesheet, and those of its rules that match the element. */
interface StyledElement {
  readonly sheet: string
  readonly rules: ReadonlyArray<string>
}
type TextPart = ReadonlyArray<StyledElement>

const stackRow = (state: 'state-on' | 'state-off'): StyledElement => ({ sheet: STACK, rules: ['.readout-stack .readout-item', `.readout-stack .readout-item.${state}`] })
/** The regular stack's value number: an obc-readout-block whose obc-textbox has size `s`, regular weight and tabular numerals. */
const valueNumber: TextPart = [
  { sheet: STACK, rules: ['.readout-stack .readout-item'] },
  { sheet: TEXTBOX, rules: ['.wrapper', '.wrapper.size-s', '.wrapper.font-weight-regular'] },
  { sheet: TEXTBOX, rules: ['.content', '.wrapper.tabular-nums .content'] },
]

/** Which OpenBridge text each mimic text part is, outermost element first. A device's readout stack has the `regular` size. */
export const openBridgeTextParts: Readonly<Record<OpenBridgeTextStyle, TextPart>> = {
  /** The readout stack's tag line. */
  tag: [{ sheet: STACK, rules: ['.readout-stack .tag'] }],
  value: valueNumber,
  /** The unit after a value. */
  unit: [{ sheet: STACK, rules: ['.readout-stack .readout-item'] }, { sheet: STACK, rules: ['.readout-stack .unit'] }],
  /** A text row of the stack (STOP, POS ?, CMD 100 %). */
  stateRow: [stackRow('state-on'), { sheet: STACK, rules: ['.readout-stack .value-text'] }],
  /** The label in the alert frame's bottom flap. */
  alertLabel: [{ sheet: ALERT_FRAME, rules: ['.flap.bottom'] }],
}

/** Text a part's table also measures, which therefore has to shape exactly like it. */
const sameShapeAs: ReadonlyArray<{ readonly style: OpenBridgeTextStyle; readonly text: string; readonly part: TextPart }> = [
  { style: 'stateRow', text: 'a state-off row', part: [stackRow('state-off'), { sheet: STACK, rules: ['.readout-stack .value-text', ':is(.readout-stack .readout-item.state-off) .value-text'] }] },
  { style: 'value', text: 'hinted zeros', part: [...valueNumber, { sheet: READOUT_BLOCK, rules: ['.hinted-zero'] }] },
]

/**
 * The characters a mimic label may use: printable ASCII, the symbols and
 * Norwegian letters of plant labels, and the superscript digits and minus of
 * a reading over decades written in powers of ten ("6.9×10⁻⁷ A").
 */
export const MIMIC_TEXT_CHARACTERS: ReadonlyArray<string> = [...Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCharCode(0x20 + index)), ...'°³²·‒–—−µ±…Δ×øæåØÆÅ', ...'⁰¹⁴⁵⁶⁷⁸⁹⁻']

// ---------------------------------------------------------------- CSS reading

interface Declaration {
  readonly property: string
  readonly value: string
  readonly important: boolean
}
interface StyleRule {
  readonly selectors: ReadonlyArray<string>
  readonly declarations: ReadonlyArray<Declaration>
  /** Enclosing conditional at-rules (@media, @supports, ...). */
  readonly conditions: ReadonlyArray<string>
  readonly order: number
}
interface Stylesheet {
  readonly rules: ReadonlyArray<StyleRule>
  /** Custom properties registered with @property (not inherited as plain custom properties are). */
  readonly registered: ReadonlySet<string>
}

const CONDITIONAL_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'document'])
const IGNORED_AT_RULES = new Set(['property', 'keyframes', 'font-face', 'page', 'counter-style', 'font-feature-values'])

const normalizeSelector = (selector: string): string => selector.trim().replace(/\s+/g, ' ')

/** Splits at top-level occurrences of `separator`, outside brackets and strings. */
const splitTopLevel = (text: string, separator: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quote !== '') {
      if (character === '\\') index++
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') depth--
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** A flat parse of a stylesheet: style rules with their declarations, inside any conditional at-rules. Nested style rules are refused. */
const parseStylesheet = (source: string): Stylesheet => {
  const rules: StyleRule[] = []
  const registered = new Set<string>()
  let position = 0
  const readUntilStop = (): string => {
    let text = ''
    let depth = 0
    while (position < source.length) {
      const character = source[position]!
      if (character === '/' && source[position + 1] === '*') {
        const end = source.indexOf('*/', position + 2)
        if (end < 0) throw new Error('unterminated comment in stylesheet')
        position = end + 2
        text += ' '
        continue
      }
      if (character === '"' || character === "'") {
        const start = position++
        while (position < source.length && source[position] !== character) position += source[position] === '\\' ? 2 : 1
        if (position >= source.length) throw new Error('unterminated string in stylesheet')
        position++
        text += source.slice(start, position)
        continue
      }
      if (depth === 0 && (character === '{' || character === '}' || character === ';')) return text
      if (character === '(' || character === '[') depth++
      if (character === ')' || character === ']') depth--
      text += character
      position++
    }
    return text
  }
  const declarationOf = (text: string): Declaration => {
    const colon = text.indexOf(':')
    if (colon < 0) throw new Error(`malformed declaration "${text.trim()}"`)
    const property = text.slice(0, colon).trim()
    const raw = text.slice(colon + 1).trim()
    const important = /!\s*important$/i.test(raw)
    return { property: property.startsWith('--') ? property : property.toLowerCase(), value: important ? raw.replace(/!\s*important$/i, '').trim() : raw, important }
  }
  // Reads items until the closing brace of the current block (or the end of the sheet).
  const readBlock = (conditions: ReadonlyArray<string>, declarations: Declaration[] | null, keep: boolean): void => {
    while (position < source.length) {
      const text = readUntilStop()
      const stop = source[position]
      position++
      if (stop === '{') {
        const prelude = text.trim()
        if (prelude.startsWith('@')) {
          const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? ''
          if (CONDITIONAL_AT_RULES.has(name)) readBlock([...conditions, prelude], null, keep)
          else if (IGNORED_AT_RULES.has(name)) {
            if (name === 'property') registered.add(prelude.slice('@property'.length).trim())
            readBlock(conditions, null, false)
          } else throw new Error(`unsupported at-rule ${prelude}`)
        } else {
          if (declarations !== null) throw new Error(`nested style rule "${prelude}" is not supported`)
          const own: Declaration[] = []
          readBlock(conditions, own, keep)
          if (keep) rules.push({ selectors: splitTopLevel(prelude, ',').map(normalizeSelector), declarations: own, conditions, order: rules.length })
        }
      } else if (stop === ';' || stop === '}' || stop === undefined) {
        if (text.trim() !== '') {
          if (declarations !== null) declarations.push(declarationOf(text))
          else if (keep && !/^@(charset|import|namespace|layer)\b/i.test(text.trim())) throw new Error(`stray text "${text.trim()}" in stylesheet`)
        }
        if (stop === '}') return
      }
    }
  }
  readBlock([], null, true)
  return { rules, registered }
}

/** The CSS of a Lit `css` tagged template in a compiled component module. */
const litCss = (module: string, path: string): string => {
  const start = module.indexOf('css`')
  if (start < 0 || module.indexOf('css`', start + 4) >= 0) throw new Error(`${path}: expected exactly one css template`)
  let end = start + 4
  while (end < module.length && module[end] !== '`') end += module[end] === '\\' ? 2 : 1
  const body = module.slice(start + 4, end)
  if (body.includes('${')) throw new Error(`${path}: css template interpolates values`)
  return body.replace(/\\([\\`$])/g, '$1')
}

// ------------------------------------------------------- selector matching

/** The page an embedded mimic is drawn in: an OpenBridge palette on <html>, the regular component size on <body>. */
interface PageElement {
  readonly tag: string
  readonly root: boolean
  readonly classes: ReadonlyArray<string>
  readonly attributes: Readonly<Record<string, string>>
}
const pageOf = (palette: string): ReadonlyArray<PageElement> => [
  { tag: 'html', root: true, classes: [], attributes: { 'data-obc-theme': palette } },
  { tag: 'body', root: false, classes: ['obc-component-size-regular'], attributes: {} },
]

type Match = 'yes' | 'no' | 'unknown'
const and = (results: ReadonlyArray<Match>): Match => (results.includes('no') ? 'no' : results.includes('unknown') ? 'unknown' : 'yes')
const or = (results: ReadonlyArray<Match>): Match => (results.includes('yes') ? 'yes' : results.includes('unknown') ? 'unknown' : 'no')
const not = (result: Match): Match => (result === 'yes' ? 'no' : result === 'no' ? 'yes' : 'unknown')

/** The simple selectors of a compound selector (`a.b[c="d"]:e(f)`). */
const simpleSelectors = (compound: string): string[] => {
  const parts: string[] = []
  let index = 0
  while (index < compound.length) {
    let end = index + 1
    if (compound[index] === '[') {
      end = compound.indexOf(']', index) + 1
      if (end === 0) throw new Error(`unterminated attribute selector in "${compound}"`)
    } else {
      if (compound[index] === ':' && compound[end] === ':') end++
      let depth = 0
      while (end < compound.length && (depth > 0 || !'.#[:'.includes(compound[end]!))) {
        if (compound[end] === '(') depth++
        if (compound[end] === ')') depth--
        end++
      }
    }
    parts.push(compound.slice(index, end))
    index = end
  }
  return parts
}

/** A selector's compounds and the combinators between them, rightmost last. */
const compoundsOf = (selector: string): { readonly compounds: string[]; readonly combinators: string[] } => {
  const compounds: string[] = []
  const combinators: string[] = []
  let current = ''
  let depth = 0
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index]!
    if (character === '(' || character === '[') depth++
    if (character === ')' || character === ']') depth--
    if (depth === 0 && (character === ' ' || character === '>' || character === '+' || character === '~')) {
      let combinator = character === ' ' ? ' ' : character
      while (selector[index + 1] === ' ' || '>+~'.includes(selector[index + 1] ?? 'x')) {
        index++
        if (selector[index] !== ' ') combinator = selector[index]!
      }
      if (current !== '') {
        compounds.push(current)
        combinators.push(combinator)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current !== '') compounds.push(current)
  return { compounds, combinators }
}

const ATTRIBUTE = /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]$/
/** Pseudo-classes that never hold for <html> or <body> of a page at rest. */
const RESTING = new Set([':hover', ':active', ':focus', ':focus-visible', ':focus-within', ':checked', ':disabled', ':target', ':visited', ':link', ':any-link', ':indeterminate', ':invalid', ':user-invalid', ':placeholder-shown', ':popover-open', ':open', ':modal', ':fullscreen', ':defined'])

/** Whether a selector matches page element `index` (its ancestors precede it). */
const matchesPage = (selector: string, page: ReadonlyArray<PageElement>, index: number): Match => {
  const { compounds, combinators } = compoundsOf(selector)
  const matchFrom = (compound: number, element: number): Match => {
    const own = matchesCompound(compounds[compound]!, page, element)
    if (own === 'no' || compound === 0) return own
    const combinator = combinators[compound - 1]!
    if (combinator === '+' || combinator === '~') return and([own, 'no'])
    const ancestors = combinator === '>' ? [element - 1] : Array.from({ length: element }, (_, ancestor) => element - 1 - ancestor)
    return and([own, or(ancestors.filter(ancestor => ancestor >= 0).map(ancestor => matchFrom(compound - 1, ancestor)))])
  }
  return matchFrom(compounds.length - 1, index)
}

const matchesCompound = (compound: string, page: ReadonlyArray<PageElement>, index: number): Match => {
  const element = page[index]!
  return and(simpleSelectors(compound).map((simple): Match => {
    if (simple === '*') return 'yes'
    if (simple.startsWith('.')) return element.classes.includes(simple.slice(1)) ? 'yes' : 'no'
    if (simple.startsWith('#')) return 'no'
    if (simple.startsWith('::')) return 'no'
    if (simple.startsWith('[')) {
      const parsed = ATTRIBUTE.exec(simple)
      if (parsed === null) return 'unknown'
      const value = element.attributes[parsed[1]!]
      if (parsed[2] === undefined) return value === undefined ? 'no' : 'yes'
      if (parsed[2] !== '=') return 'unknown'
      return value === (parsed[3] ?? parsed[4] ?? parsed[5]) ? 'yes' : 'no'
    }
    if (simple.startsWith(':')) {
      const functional = /^(:[\w-]+)\((.*)\)$/.exec(simple)
      if (functional !== null) {
        const inner = splitTopLevel(functional[2]!, ',').map(normalizeSelector)
        if (functional[1] === ':is' || functional[1] === ':where') return or(inner.map(item => matchesPage(item, page, index)))
        if (functional[1] === ':not') return not(or(inner.map(item => matchesPage(item, page, index))))
        return 'unknown'
      }
      if (simple === ':root') return element.root ? 'yes' : 'no'
      if (simple === ':host') return 'no'
      if (RESTING.has(simple)) return 'no'
      return 'unknown'
    }
    return /^[a-z][\w-]*$/i.test(simple) ? (simple.toLowerCase() === element.tag ? 'yes' : 'no') : 'unknown'
  }))
}

/** Specificity as one comparable number (ids, classes, types; each below 1000). */
const specificity = (selector: string): number => {
  const { compounds } = compoundsOf(selector)
  let total = 0
  for (const simple of compounds.flatMap(simpleSelectors)) {
    if (simple === '*') continue
    const functional = /^(:[\w-]+)\((.*)\)$/.exec(simple)
    if (functional !== null) {
      if (functional[1] === ':where') continue
      if (functional[1] === ':is' || functional[1] === ':not' || functional[1] === ':has') total += Math.max(...splitTopLevel(functional[2]!, ',').map(item => specificity(normalizeSelector(item))))
      else total += 1_000
      continue
    }
    if (simple.startsWith('#')) total += 1_000_000
    else if (simple.startsWith('.') || simple.startsWith('[') || (simple.startsWith(':') && !simple.startsWith('::'))) total += 1_000
    else total += 1
  }
  return total
}

// ------------------------------------------------------------ the cascade

/** Inherited properties that change how text is shaped, with their CSS initial values. */
const SHAPING_INITIAL: Readonly<Record<string, string | null>> = {
  'font-family': null,
  'font-size': null,
  'font-weight': 'normal',
  'font-feature-settings': 'normal',
  'font-variant-numeric': 'normal',
  'letter-spacing': 'normal',
  'font-size-adjust': 'none',
}
/** Properties that would also change shaping; any value but their initial one is refused rather than ignored. */
const MUST_STAY_INITIAL: Readonly<Record<string, ReadonlyArray<string>>> = {
  'font-kerning': ['auto', 'normal'],
  'font-variant-ligatures': ['normal'],
  'font-variant-caps': ['normal'],
  'font-variant-position': ['normal'],
  'font-variant-alternates': ['normal'],
  'font-variant-east-asian': ['normal'],
  'font-stretch': ['normal', '100%'],
  'font-style': ['normal'],
  'font-synthesis': ['weight style small-caps', 'auto'],
  'font-variation-settings': ['normal'],
  'font-optical-sizing': ['auto'],
  'text-transform': ['none'],
  'word-spacing': ['normal', '0', '0px'],
  'text-rendering': ['auto', 'optimizeLegibility', 'geometricPrecision'],
}
const SHORTHANDS = new Set(['font', 'font-variant', 'font-synthesis-weight'])

const substitute = (value: string, lookup: (name: string) => string | undefined, context: string): string => {
  let result = ''
  let index = 0
  while (index < value.length) {
    const start = value.indexOf('var(', index)
    if (start < 0) return result + value.slice(index)
    result += value.slice(index, start)
    let depth = 0
    let end = start + 3
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++
      if (value[end] === ')' && --depth === 0) break
    }
    const [name, ...fallback] = splitTopLevel(value.slice(start + 4, end), ',')
    const token = name!.trim()
    const resolved = lookup(token)
    if (resolved !== undefined) result += resolved
    else if (fallback.length > 0) result += substitute(fallback.join(',').trim(), lookup, context)
    else throw new Error(`${context}: ${token} is not defined`)
    index = end + 1
  }
  return result
}

/** Custom properties and shaping properties of an element, computed from its own declarations and its parent's values. */
interface Computed {
  readonly custom: (name: string) => string | undefined
  readonly shaping: Readonly<Record<string, string | null>>
}

const computeElement = (declarations: ReadonlyArray<Declaration>, parent: Computed | null, registered: ReadonlySet<string>, context: string): Computed => {
  // Later declarations win over earlier ones, !important over normal ones.
  const winning = new Map<string, Declaration>()
  for (const declaration of declarations) {
    const current = winning.get(declaration.property)
    if (current === undefined || declaration.important || !current.important) winning.set(declaration.property, declaration)
  }
  const resolved = new Map<string, string>()
  const resolving = new Set<string>()
  const custom = (name: string): string | undefined => {
    const own = winning.get(name)
    if (own === undefined) {
      if (registered.has(name)) throw new Error(`${context}: ${name} is a registered property; its inheritance is not modelled`)
      return parent?.custom(name)
    }
    const known = resolved.get(name)
    if (known !== undefined) return known
    if (resolving.has(name)) throw new Error(`${context}: ${name} refers to itself`)
    resolving.add(name)
    const value = substitute(own.value, custom, `${context} ${name}`)
    resolving.delete(name)
    resolved.set(name, value)
    return value
  }
  const shaping: Record<string, string | null> = {}
  for (const [property, initial] of Object.entries(SHAPING_INITIAL)) {
    const own = winning.get(property)
    const inherited = parent === null ? initial : parent.shaping[property]!
    if (own === undefined) {
      shaping[property] = inherited
      continue
    }
    const value = substitute(own.value, custom, `${context} ${property}`).trim()
    shaping[property] = value === 'inherit' || value === 'unset' ? inherited : value === 'initial' ? initial : value
  }
  for (const [property, allowed] of Object.entries(MUST_STAY_INITIAL)) {
    const own = winning.get(property)
    if (own === undefined) continue
    const value = substitute(own.value, custom, `${context} ${property}`).trim()
    if (!allowed.includes(value) && !['inherit', 'initial', 'unset'].includes(value)) throw new Error(`${context}: ${property}: ${value} changes shaping and is not modelled`)
  }
  for (const property of SHORTHANDS) if (winning.has(property)) throw new Error(`${context}: the ${property} shorthand is not modelled`)
  return { custom, shaping }
}

/** Declarations of the rules in `sheet` that match page element `index`, in cascade order. */
const pageDeclarations = (sheet: Stylesheet, page: ReadonlyArray<PageElement>, index: number): Declaration[] => {
  const matched: Array<{ readonly specificity: number; readonly order: number; readonly declarations: ReadonlyArray<Declaration> }> = []
  for (const rule of sheet.rules) {
    const relevant = rule.declarations.filter(declaration => declaration.property.startsWith('--') || declaration.property in SHAPING_INITIAL || declaration.property in MUST_STAY_INITIAL || SHORTHANDS.has(declaration.property))
    if (relevant.length === 0) continue
    const matching = rule.selectors.map(selector => ({ selector, match: matchesPage(selector, page, index) }))
    if (matching.every(item => item.match === 'no')) continue
    const unknown = matching.find(item => item.match === 'unknown')
    if (unknown !== undefined) throw new Error(`cannot tell whether "${unknown.selector}" matches <${page[index]!.tag}>`)
    if (rule.conditions.length > 0) throw new Error(`"${rule.selectors.join(', ')}" styles <${page[index]!.tag}> only ${rule.conditions.join(' ')}`)
    const best = Math.max(...matching.filter(item => item.match === 'yes').map(item => specificity(item.selector)))
    matched.push({ specificity: best, order: rule.order, declarations: relevant })
  }
  return matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order).flatMap(item => item.declarations)
}

/** Declarations of the named component rules, in cascade order (specificity, then source order). */
const componentDeclarations = (sheet: Stylesheet, path: string, selectors: ReadonlyArray<string>): Declaration[] =>
  selectors
    .map(selector => {
      const rules = sheet.rules.filter(rule => rule.conditions.length === 0 && rule.selectors.includes(selector))
      if (rules.length === 0) throw new Error(`${path} no longer has a rule for "${selector}"`)
      return rules.map(rule => ({ specificity: specificity(selector), order: rule.order, declarations: rule.declarations }))
    })
    .flat()
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order)
    .flatMap(item => item.declarations)

// ------------------------------------------------------------- typography

/** The CSS a text part resolves to, and how it is shaped. */
export interface ResolvedTypography {
  readonly fontFamily: string
  readonly fontSize: number
  readonly fontSizeAdjust: string
  readonly fontWeight: number
  readonly fontFeatureSettings: string
  readonly fontVariantNumeric: string
  readonly letterSpacing: number
}

/** Evaluates a length that is px, a number of px, or calc() over them. */
const pixels = (value: string, context: string): number => {
  const tokens = value.replace(/calc\(/g, '(').match(/-?\d*\.?\d+(?:e[+-]?\d+)?[a-z%]*|[()+\-*/]/gi)
  if (tokens === null || tokens.join('').replace(/\s/g, '') !== value.replace(/calc\(/g, '(').replace(/\s/g, '')) throw new Error(`${context}: cannot read "${value}"`)
  let index = 0
  type Quantity = { readonly amount: number; readonly px: boolean }
  const primary = (): Quantity => {
    const token = tokens[index++]
    if (token === '(') {
      const inner = sum()
      if (tokens[index++] !== ')') throw new Error(`${context}: unbalanced "${value}"`)
      return inner
    }
    const parsed = token === undefined ? null : /^(-?\d*\.?\d+(?:e[+-]?\d+)?)(px)?$/i.exec(token)
    if (parsed === null) throw new Error(`${context}: "${token}" in "${value}" is not px`)
    return { amount: Number(parsed[1]), px: parsed[2] !== undefined }
  }
  const product = (): Quantity => {
    let left = primary()
    while (tokens[index] === '*' || tokens[index] === '/') {
      const operator = tokens[index++]
      const right = primary()
      if (operator === '*' && left.px && right.px) throw new Error(`${context}: px * px in "${value}"`)
      if (operator === '/' && right.px) throw new Error(`${context}: division by px in "${value}"`)
      left = { amount: operator === '*' ? left.amount * right.amount : left.amount / right.amount, px: left.px || right.px }
    }
    return left
  }
  const sum = (): Quantity => {
    let left = product()
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operator = tokens[index++]
      const right = product()
      if (left.px !== right.px && !(left.amount === 0 || right.amount === 0)) throw new Error(`${context}: mixed units in "${value}"`)
      left = { amount: operator === '+' ? left.amount + right.amount : left.amount - right.amount, px: left.px || right.px }
    }
    return left
  }
  const result = sum()
  if (index !== tokens.length) throw new Error(`${context}: cannot read "${value}"`)
  if (!result.px && result.amount !== 0) throw new Error(`${context}: "${value}" is not a length in px`)
  return result.amount
}

const WEIGHT_KEYWORDS: Readonly<Record<string, number>> = { normal: 400, bold: 700 }
const VARIANT_NUMERIC_FEATURES: Readonly<Record<string, string>> = {
  'lining-nums': 'lnum',
  'oldstyle-nums': 'onum',
  'proportional-nums': 'pnum',
  'tabular-nums': 'tnum',
  'diagonal-fractions': 'frac',
  'stacked-fractions': 'afrc',
  ordinal: 'ordn',
  'slashed-zero': 'zero',
}

const typographyOf = (computed: Computed, context: string): ResolvedTypography => {
  const read = (property: string): string => {
    const value = computed.shaping[property]
    if (value === null || value === undefined) throw new Error(`${context}: OpenBridge does not set ${property}`)
    return value
  }
  const weight = read('font-weight')
  const fontWeight = WEIGHT_KEYWORDS[weight] ?? Number(weight)
  if (!Number.isFinite(fontWeight)) throw new Error(`${context}: font-weight "${weight}" is not modelled`)
  const letterSpacing = read('letter-spacing')
  const family = splitTopLevel(read('font-family'), ',')[0]!.trim().replace(/^(["'])(.*)\1$/, '$2')
  return {
    fontFamily: family,
    fontSize: pixels(read('font-size'), `${context} font-size`),
    fontSizeAdjust: read('font-size-adjust').replace(/\s+/g, ' '),
    fontWeight,
    fontFeatureSettings: read('font-feature-settings').replace(/\s+/g, ' '),
    fontVariantNumeric: read('font-variant-numeric').replace(/\s+/g, ' '),
    letterSpacing: letterSpacing === 'normal' ? 0 : pixels(letterSpacing, `${context} letter-spacing`),
  }
}

/** OpenType features in the order CSS applies them: font-variant-numeric, then font-feature-settings on top. */
const featuresOf = (typography: ResolvedTypography, context: string): Readonly<Record<string, number>> => {
  const features: Record<string, number> = {}
  if (typography.fontVariantNumeric !== 'normal')
    for (const keyword of typography.fontVariantNumeric.split(' ')) {
      const tag = VARIANT_NUMERIC_FEATURES[keyword]
      if (tag === undefined) throw new Error(`${context}: font-variant-numeric ${keyword} is not modelled`)
      features[tag] = 1
    }
  if (typography.fontFeatureSettings !== 'normal')
    for (const setting of splitTopLevel(typography.fontFeatureSettings, ',')) {
      const parsed = /^\s*(["'])([\x20-\x7e]{4})\1(?:\s+(on|off|\d+))?\s*$/.exec(setting)
      if (parsed === null) throw new Error(`${context}: cannot read font-feature-settings "${setting}"`)
      features[parsed[2]!] = parsed[3] === undefined || parsed[3] === 'on' ? 1 : parsed[3] === 'off' ? 0 : Number(parsed[3])
    }
  return Object.fromEntries(Object.entries(features).sort(([a], [b]) => a.localeCompare(b)))
}

// ---------------------------------------------------------------- shaping

const SCRIPTS = ['Latin', 'Greek', 'Cyrillic'] as const
const scriptPatterns = SCRIPTS.map(script => new RegExp(`^\\p{Script=${script}}$`, 'u'))
const NEUTRAL = /^[\p{Script=Common}\p{Script=Inherited}]$/u

/** Splits text into script runs; neutral characters (digits, punctuation, symbols) join the run before them, or the one after at the start. */
const scriptRuns = (text: string): string[] => {
  const characters = [...text]
  const scripts = characters.map(character => {
    if (NEUTRAL.test(character)) return null
    const index = scriptPatterns.findIndex(pattern => pattern.test(character))
    if (index < 0) throw new Error(`no script run model for "${character}"`)
    return SCRIPTS[index]!
  })
  const first = scripts.find(script => script !== null) ?? null
  const runs: Array<{ script: string | null; text: string }> = []
  let current = first
  for (const [index, character] of characters.entries()) {
    current = scripts[index] ?? current
    const last = runs.at(-1)
    if (last !== undefined && last.script === current) last.text += character
    else runs.push({ script: current, text: character })
  }
  return runs.map(run => run.text)
}

interface Shaping {
  /** px per em: the font size after font-size-adjust. */
  readonly em: number
  readonly wght: number
  readonly features: Readonly<Record<string, number>>
}

export interface GeneratedStyle {
  /** The OpenBridge rules the typography was read from, outermost element first. */
  readonly rules: ReadonlyArray<string>
  readonly css: ResolvedTypography
  readonly em: number
  readonly wght: number
  readonly features: Readonly<Record<string, number>>
  /** Advance of each character, in font units (letter-spacing is added per character in px). */
  readonly advance: Readonly<Record<string, number>>
  /** Adjustment of each character pair whose shaped width differs from its two advances, in font units. */
  readonly kern: Readonly<Record<string, number>>
}

export interface GeneratedTextMetrics {
  readonly generated: string
  readonly openbridge: string
  readonly font: { readonly file: string; readonly family: string; readonly unitsPerEm: number; readonly wght: { readonly min: number; readonly default: number; readonly max: number } }
  readonly styles: Readonly<Record<OpenBridgeTextStyle, GeneratedStyle>>
}

const packageFile = (path: string): string => fileURLToPath(import.meta.resolve(`${PACKAGE}/${path}`))

/** Reads OpenBridge's typography for every text part and shapes its Noto Sans with it. */
export const createOpenBridgeTextShaper = async () => {
  const version = (JSON.parse(await readFile(packageFile('package.json'), 'utf8')) as { version: string }).version
  const globalSheet = parseStylesheet(await readFile(packageFile(GLOBAL_STYLES), 'utf8'))
  const componentSheets = new Map<string, Stylesheet>()
  const componentSheet = async (path: string): Promise<Stylesheet> => {
    const known = componentSheets.get(path)
    if (known !== undefined) return known
    const sheet = parseStylesheet(litCss(await readFile(packageFile(path), 'utf8'), path))
    componentSheets.set(path, sheet)
    return sheet
  }

  const face = new hb.Face(new hb.Blob(new Uint8Array(await readFile(packageFile(FONT)))))
  const axes = face.getAxisInfos()
  const weightAxis = axes.wght
  if (weightAxis === undefined || Object.keys(axes).length !== 1) throw new Error(`${FONT}: expected a single wght axis, found ${Object.keys(axes).join(', ') || 'none'}`)
  const family = face.getName(16, 'en') || face.getName(1, 'en')
  const unitsPerEm = face.upem
  const fonts = new Map<number, hb.Font>()
  const fontAt = (wght: number): hb.Font => {
    const known = fonts.get(wght)
    if (known !== undefined) return known
    const font = new hb.Font(face)
    font.setVariations([new hb.Variation('wght', wght)])
    fonts.set(wght, font)
    return font
  }

  // Every palette must resolve to the same typography; the mimic follows the viewer's.
  const palettes = [...new Set(globalSheet.rules.flatMap(rule => rule.selectors.flatMap(selector => [...selector.matchAll(/\[data-obc-theme="([^"]+)"\]/g)].map(match => match[1]!))))].sort()
  if (palettes.length === 0) throw new Error(`${GLOBAL_STYLES}: no palettes found`)
  const pages = new Map(palettes.map(palette => {
    const page = pageOf(palette)
    let computed: Computed | null = null
    for (const [index, element] of page.entries()) computed = computeElement(pageDeclarations(globalSheet, page, index), computed, globalSheet.registered, `${GLOBAL_STYLES} <${element.tag}> (${palette})`)
    return [palette, computed!]
  }))

  const resolve = async (part: TextPart, palette: string, context: string): Promise<ResolvedTypography> => {
    let computed: Computed = pages.get(palette)!
    for (const element of part) {
      const sheet = await componentSheet(element.sheet)
      computed = computeElement(componentDeclarations(sheet, element.sheet, element.rules), computed, sheet.registered, `${context} ${element.rules.join(' + ')}`)
    }
    return typographyOf(computed, context)
  }
  const resolveEverywhere = async (part: TextPart, context: string): Promise<ResolvedTypography> => {
    const resolved = await Promise.all(palettes.map(palette => resolve(part, palette, `${context} (${palette})`)))
    for (const [index, other] of resolved.entries())
      if (JSON.stringify(other) !== JSON.stringify(resolved[0])) throw new Error(`${context}: typography differs between palettes ${palettes[0]} and ${palettes[index]}`)
    return resolved[0]!
  }

  const shapingOf = (typography: ResolvedTypography, context: string): Shaping => {
    if (typography.fontFamily !== family) throw new Error(`${context}: set in "${typography.fontFamily}", but OpenBridge ships "${family}"`)
    const adjust = /^(?:(cap-height|ex-height) )?(\d*\.?\d+)$/.exec(typography.fontSizeAdjust)
    if (typography.fontSizeAdjust !== 'none' && adjust === null) throw new Error(`${context}: font-size-adjust ${typography.fontSizeAdjust} is not modelled`)
    // A variable font takes the CSS weight on its wght axis, clamped to the axis.
    const wght = Math.min(weightAxis.max, Math.max(weightAxis.min, typography.fontWeight))
    if (adjust === null) return { em: typography.fontSize, wght, features: featuresOf(typography, context) }
    // font-size-adjust: the used size makes the font's metric (OS/2, at this weight) `value` times the specified size.
    const metricName = adjust[1] ?? 'ex-height'
    const metric = fontAt(wght).getMetricPosition(metricName === 'cap-height' ? hb.MetricsTag.CAP_HEIGHT : hb.MetricsTag.X_HEIGHT)
    if (metric === undefined || metric <= 0) throw new Error(`${context}: the font has no ${metricName} for font-size-adjust`)
    return { em: (typography.fontSize * Number(adjust[2])) / (metric / unitsPerEm), wght, features: featuresOf(typography, context) }
  }

  const buffer = new hb.Buffer()
  /** The shaped width of `text` in font units: each script run shaped on its own, as a browser segments text. */
  const shapeUnits = (shaping: Shaping, text: string): number =>
    scriptRuns(text).reduce((sum, run) => {
      buffer.reset()
      buffer.addText(run)
      buffer.guessSegmentProperties()
      hb.shape(fontAt(shaping.wght), buffer, Object.entries(shaping.features).map(([tag, value]) => new hb.Feature(tag, value)))
      return buffer.getGlyphPositions().reduce((width, position) => width + position.xAdvance, sum)
    }, 0)

  for (const character of MIMIC_TEXT_CHARACTERS)
    if (fontAt(weightAxis.default).nominalGlyph(character.codePointAt(0)!) === undefined) throw new Error(`${FONT} has no glyph for "${character}" (U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`)

  const parts = Object.entries(openBridgeTextParts) as Array<[OpenBridgeTextStyle, TextPart]>
  const typography = new Map<OpenBridgeTextStyle, { readonly css: ResolvedTypography; readonly shaping: Shaping }>()
  for (const [style, part] of parts) {
    const css = await resolveEverywhere(part, style)
    typography.set(style, { css, shaping: shapingOf(css, style) })
  }
  for (const variant of sameShapeAs) {
    const css = await resolveEverywhere(variant.part, `${variant.style}: ${variant.text}`)
    const own = typography.get(variant.style)!
    const shaping = shapingOf(css, variant.text)
    if (JSON.stringify(shaping) !== JSON.stringify(own.shaping) || css.letterSpacing !== own.css.letterSpacing)
      throw new Error(`${variant.style}: ${variant.text} shapes differently (${JSON.stringify(shaping)}) and needs its own table`)
  }

  const tables = new Map<string, { readonly advance: Record<string, number>; readonly kern: Record<string, number> }>()
  const tableOf = (shaping: Shaping) => {
    const key = JSON.stringify([shaping.wght, shaping.features])
    const known = tables.get(key)
    if (known !== undefined) return known
    const advance = Object.fromEntries(MIMIC_TEXT_CHARACTERS.map(character => [character, shapeUnits(shaping, character)]))
    const kern: Record<string, number> = {}
    for (const first of MIMIC_TEXT_CHARACTERS)
      for (const second of MIMIC_TEXT_CHARACTERS) {
        const adjustment = shapeUnits(shaping, first + second) - advance[first]! - advance[second]!
        if (adjustment !== 0) kern[first + second] = adjustment
      }
    const table = { advance, kern }
    tables.set(key, table)
    return table
  }

  const metrics = (): GeneratedTextMetrics => ({
    generated: `By generate-text-metrics.ts from ${PACKAGE} ${version}: typography from its component styles and ${GLOBAL_STYLES}, widths shaped with HarfBuzz from ${FONT}. Do not edit; regenerate.`,
    openbridge: version,
    font: { file: FONT, family, unitsPerEm, wght: { min: weightAxis.min, default: weightAxis.default, max: weightAxis.max } },
    styles: Object.fromEntries(parts.map(([style, part]) => {
      const { css, shaping } = typography.get(style)!
      const generated: GeneratedStyle = {
        rules: part.flatMap(element => element.rules.map(rule => `${element.sheet.replace(/^dist\//, '').replace(/\.js$/, '')} ${rule}`)),
        css,
        em: shaping.em,
        wght: shaping.wght,
        features: shaping.features,
        ...tableOf(shaping),
      }
      return [style, generated]
    })) as Record<OpenBridgeTextStyle, GeneratedStyle>,
  })

  return {
    metrics,
    /** Width of `text` as one shaped run (not pairwise), in px before rounding. */
    width: (style: OpenBridgeTextStyle, text: string): number => {
      const { css, shaping } = typography.get(style)!
      return (shapeUnits(shaping, text) * shaping.em) / unitsPerEm + [...text].length * css.letterSpacing
    },
  }
}

export const generateOpenBridgeTextMetrics = async (): Promise<GeneratedTextMetrics> => (await createOpenBridgeTextShaper()).metrics()

export const serializeTextMetrics = (metrics: GeneratedTextMetrics): string => `${JSON.stringify(metrics, null, 1)}\n`

if (import.meta.main) {
  await writeFile(TEXT_METRICS_FILE, serializeTextMetrics(await generateOpenBridgeTextMetrics()))
  console.log(`wrote ${TEXT_METRICS_FILE}`)
}
