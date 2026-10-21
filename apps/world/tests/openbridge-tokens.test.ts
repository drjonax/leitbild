import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { internals, type Internal } from './openbridge-register.ts'

// The OpenBridge policy's token rules (§1, §5; apps/world/AGENTS.md): every
// token the embed reads resolves, in each palette the embed sets, to one of
// its own definitions or to OpenBridge's; the embed writes no colour literal;
// and each OpenBridge internal the register lists still exists in the
// installed package. An upgrade that renames a token or an internal fails
// here instead of silently drawing a default. Each rule is checked against a
// planted violation.

const src = join(import.meta.dir, '../src')
const openBridge = join(import.meta.dir, '../node_modules/@oicl/openbridge-webcomponents')

const filesUnder = (dir: string): ReadonlyArray<string> => !existsSync(dir) ? [] : readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? filesUnder(path) : [path]
})

const withoutComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ''))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

type Sources = ReadonlyMap<string, string>

/** The embed's sources (relative to src, as written), and the ui/displays files it imports, which it draws too. */
const embedSources = (): Sources => {
  const embed = filesUnder(join(src, 'ui/embed')).filter(file => /\.(svelte|ts|css)$/.test(file) && !file.endsWith('.test.ts'))
  const reached = new Set(embed)
  const pending = [...embed]
  while (pending.length > 0) {
    const file = pending.pop()!
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1]!)
      if (target.startsWith(join(src, 'ui/displays/')) && existsSync(target) && !reached.has(target)) { reached.add(target); pending.push(target) }
    }
  }
  return new Map([...reached].map(file => [relative(src, file), readFileSync(file, 'utf8')] as const))
}

/** The palettes the embed page sets (ui/embed/main.ts: day for a light theme, dusk for a dark one). */
const embedPalettes = ['day', 'dusk'] as const

/**
 * OpenBridge's tokens as an element of the embed sees them in a palette: those
 * set on every element, on `:root`, on the body's `obc-component-size-regular`
 * (ui/embed.html) and on `:root[data-obc-theme="<palette>"]`.
 */
const openBridgeTokens = (css: string, palette: string): ReadonlyMap<string, string> => {
  const seen = new Set(['*', ':root', '.obc-component-size-regular', `:root[data-obc-theme="${palette}"]`])
  const tokens = new Map<string, string>()
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!block[1]!.split(',').some(selector => seen.has(selector.trim()))) continue
    for (const declaration of block[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(declaration[1]!, declaration[2]!.trim())
  }
  return tokens
}

const reads = (code: string): ReadonlyArray<string> => [...code.matchAll(/var\(\s*(--[\w-]+)|getPropertyValue\(\s*['"`](--[\w-]+)/g)].map(match => match[1] ?? match[2]!)
const definitions = (code: string): ReadonlyArray<string> => [
  ...[...code.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]!),
  ...[...code.matchAll(/style:(--[\w-]+)/g)].map(match => match[1]!),
  ...[...code.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)].map(match => match[1]!),
]

/** Why a token does not resolve in a palette's tokens, following its `var()` references; null where it does. */
const unresolvedIn = (tokens: ReadonlyMap<string, string>, name: string, seen: ReadonlyArray<string> = []): string | null => {
  if (seen.includes(name)) return `${[...seen, name].join(' → ')} is a cycle`
  const value = tokens.get(name)
  if (value === undefined) return `${[...seen, name].join(' → ')} is not set`
  for (const reference of reads(value)) {
    const problem = unresolvedIn(tokens, reference, [...seen, name])
    if (problem !== null) return problem
  }
  return null
}

/** Each token the sources read that neither they nor OpenBridge define, per palette. */
const unresolvedTokens = (sources: Sources, palettes: ReadonlyMap<string, ReadonlyMap<string, string>>): ReadonlyArray<string> => {
  const codes = [...sources].map(([file, source]) => [file, withoutComments(source)] as const)
  const own = new Set(codes.flatMap(([, code]) => definitions(code)))
  return codes.flatMap(([file, code]) => [...new Set(reads(code))].filter(name => !own.has(name)).flatMap(name =>
    [...palettes].flatMap(([palette, tokens]) => {
      const problem = unresolvedIn(tokens, name)
      return problem === null ? [] : [`${file}: ${problem} in ${palette}`]
    })))
}

// CSS Color 4 named and system colours; `transparent` and `currentColor` name no colour of their own.
const namedColours = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood
  cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey
  darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
  lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
  lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
  peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver
  skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
  yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext
  selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext`.split(/\s+/))

/** Properties that take a colour, and custom properties, whose value may hide one. */
const colourProperty = /^(?:--[\w-]+|color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|(?:box|text)-shadow|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?|stop-color|flood-color|lighting-color|scrollbar-color|text-emphasis(?:-color)?|-webkit-text-fill-color|-webkit-tap-highlight-color)$/
const colourFunction = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)|\bcolor\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz)[^)]*\)/g
const hexColour = /#[0-9a-fA-F]{3,8}(?![0-9A-Za-z_])/g
const hexLengths = new Set([4, 5, 7, 9])

/** Every colour a source writes for itself: a hex or colour function anywhere (comments too), a colour name in a colour declaration or an SVG paint attribute. */
const colourLiterals = (file: string, source: string): ReadonlyArray<string> => {
  const at = (index: number) => `${file}:${source.slice(0, index).split('\n').length}`
  const literals = [
    ...[...source.matchAll(hexColour)].filter(match => hexLengths.has(match[0].length)),
    ...source.matchAll(colourFunction),
  ].map(match => `${at(match.index!)} ${match[0]}`)
  const code = withoutComments(source)
  const styles = file.endsWith('.css') ? [{ text: code, from: 0 }] : [...code.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => ({ text: match[1]!, from: match.index! + match[0].indexOf(match[1]!) }))
  const names = styles.flatMap(style => [...style.text.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)]
    .filter(declaration => colourProperty.test(declaration[1]!))
    .flatMap(declaration => [...declaration[2]!.replace(/var\([^)]*\)|"[^"]*"|'[^']*'/g, '').matchAll(/[A-Za-z]+/g)]
      .filter(word => namedColours.has(word[0].toLowerCase()))
      .map(word => `${at(style.from + declaration.index! + declaration[0].indexOf(declaration[2]!) + word.index!)} ${declaration[1]}: ${word[0]}`)))
  const paints = [...code.matchAll(/\b(?:fill|stroke|color|stop-color|flood-color)\s*=\s*["']([A-Za-z]+)["']/g)]
    .filter(match => namedColours.has(match[1]!.toLowerCase()))
    .map(match => `${at(match.index!)} ${match[0]}`)
  return [...literals, ...names, ...paints]
}

/** Listed internals the installed package no longer has where the register says. */
const missingInternals = (listed: ReadonlyArray<Internal>, root: string): ReadonlyArray<string> => listed.flatMap(internal => {
  const path = join(root, internal.defined.file)
  if (!existsSync(path)) return [`${internal.kind} ${internal.name} (${internal.element}): ${internal.defined.file} is not in the installed package`]
  return readFileSync(path, 'utf8').includes(internal.defined.mark) ? [] : [`${internal.kind} ${internal.name} (${internal.element}): ${internal.defined.file} no longer holds "${internal.defined.mark}"`]
})

const sources = embedSources()
const css = readFileSync(join(openBridge, 'dist/openbridge.css'), 'utf8')
const palettes = new Map(embedPalettes.map(palette => [palette, openBridgeTokens(css, palette)] as const))

describe('OpenBridge tokens in the embed', () => {
  test('every token the embed reads resolves, in day and dusk, to its own definition or to OpenBridge\'s', () => {
    expect([...sources.keys()]).toContain('ui/displays/AlertList.svelte')
    expect(palettes.get('dusk')!.has('--alert-alarm-color')).toBe(true)
    expect(unresolvedTokens(sources, palettes)).toEqual([])
  })

  test('the embed writes no colour literal', () => {
    expect([...sources].filter(([file]) => file.startsWith('ui/embed/')).flatMap(([file, source]) => colourLiterals(file, source))).toEqual([])
  })

  test('every OpenBridge internal the register lists still exists in the installed package', () => {
    expect(internals.length).toBeGreaterThan(10)
    expect(missingInternals(internals, openBridge)).toEqual([])
  })

  test('planted: an unset token, a broken chain, colour literals of each kind and a vanished internal are each caught', () => {
    const planted: Sources = new Map([['ui/embed/vignette/Planted.svelte', '<div style:--gap="4px"></div>\n<style>\n  .a { color: var(--element-active-color); padding: var(--gap); margin: var(--no-such-token); }\n</style>']])
    expect(unresolvedTokens(planted, palettes)).toEqual(['ui/embed/vignette/Planted.svelte: --no-such-token is not set in day', 'ui/embed/vignette/Planted.svelte: --no-such-token is not set in dusk'])
    expect(unresolvedIn(new Map([['--a', 'var(--b) var(--c)'], ['--b', '1px']]), '--a')).toBe('--a → --c is not set')
    const literals = [
      "const ink = '#fff'",
      '<svg><path fill="red" /></svg>',
      '<style>',
      '  .popover { box-shadow: 0 4px 16px 0 rgba(0, 0, 0, 0.3); border: 1px solid White; }',
      '  .row { border-left-color: transparent; color: var(--element-active-color); --mine: navy; }',
      '  .green-text { animation: highlight 1s; }',
      '</style>',
      '{#each rows as row}{/each}',
    ].join('\n')
    expect(colourLiterals('planted.svelte', literals)).toEqual([
      'planted.svelte:1 #fff',
      'planted.svelte:4 rgba(0, 0, 0, 0.3)',
      'planted.svelte:4 border: White',
      'planted.svelte:5 --mine: navy',
      'planted.svelte:2 fill="red"',
    ])
    const vanished: Internal = { ...internals[0]!, defined: { file: 'dist/components/button/button.js', mark: 'part="no-such-part"' } }
    expect(missingInternals([vanished], openBridge)).toEqual(['part wrapper (obc-button): dist/components/button/button.js no longer holds "part="no-such-part""'])
  })
})
