/**
 * Reserved-colour distance (plan v3.1 §2.7, tests T04a and T04b): how far
 * each colour a Pack or a World-drawn view supplies sits from the five
 * colours OpenBridge 2.0.0 reserves for alerts — alarm, warning, caution,
 * critical magenta and notification blue — in the day, dusk and night
 * palettes, as CIEDE2000 ΔE. T04b's bar is ΔE ≥ 15 from all five.
 *
 * The reserved set is OpenBridge's own: the background token
 * `getAlertColorTokens` names for alarm, warning, caution, level-critical and
 * level-diagnostic, resolved in each palette as a page loading
 * `openbridge.css` sees it (later declarations win). The library half is
 * imported by the colour tests; the command half scans source files for
 * colour literals and prints each one's nearest reserved colour.
 *
 *   bun scripts/displays/reserved-colour-distance.ts [--below <ΔE>] [--json] [path …]
 *
 * Paths are relative to apps/world; without them the scan covers every Pack,
 * the Scenarios and the World-drawn map and display code.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'
import { getAlertColorTokens } from '@oicl/openbridge-webcomponents/dist/alert-severity.js'
import { AlertType } from '@oicl/openbridge-webcomponents/dist/types.js'

export type Palette = 'day' | 'dusk' | 'night'
export const palettes: ReadonlyArray<Palette> = ['day', 'dusk', 'night']

export type ReservedColour = 'alarm' | 'warning' | 'caution' | 'critical' | 'notification'
export const reservedColourNames: ReadonlyArray<ReservedColour> = ['alarm', 'warning', 'caution', 'critical', 'notification']

/** OpenBridge's alert type behind each reserved colour; notification blue is its diagnostic level. */
export const reservedAlertTypes: Readonly<Record<ReservedColour, AlertType>> = {
  alarm: AlertType.Alarm,
  warning: AlertType.Warning,
  caution: AlertType.Caution,
  critical: AlertType.LevelCritical,
  notification: AlertType.LevelDiagnostic,
}

/** T04b's bar: every Pack-reachable colour at least this far from all five reserved colours. */
export const reservedDistanceFloor = 15

const worldRoot = join(import.meta.dir, '../..')
export const openBridgeCssPath = join(worldRoot, 'node_modules/@oicl/openbridge-webcomponents/dist/openbridge.css')

/** Custom properties set on `:root` and `:root[data-obc-theme="<palette>"]`, in source order, so later declarations win. */
export const paletteTokens = (css: string, palette: Palette): ReadonlyMap<string, string> => {
  const declared = new Map<string, string>()
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1]!.split(',').map(selector => selector.trim())
    if (!selectors.some(selector => selector === ':root' || selector === `:root[data-obc-theme="${palette}"]`)) continue
    for (const declaration of block[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) declared.set(declaration[1]!, declaration[2]!.trim())
  }
  return declared
}

/** A token's value with `var(--x)` references followed; a cycle or an unset token throws. */
export const resolveToken = (tokens: ReadonlyMap<string, string>, name: string, seen: ReadonlyArray<string> = []): string => {
  if (seen.includes(name)) throw new Error(`token cycle: ${[...seen, name].join(' → ')}`)
  const value = tokens.get(name)
  if (value === undefined) throw new Error(`token ${name} is not set`)
  const reference = value.match(/^var\((--[\w-]+)\)$/)
  return reference === null ? value : resolveToken(tokens, reference[1]!, [...seen, name])
}

/** `var(--x)` → `--x`; OpenBridge's colour helpers return tokens in that form. */
export const tokenName = (reference: string): string => {
  const match = reference.match(/^var\((--[\w-]+)\)$/)
  if (match === null) throw new Error(`not a token reference: ${reference}`)
  return match[1]!
}

export type Rgb = readonly [number, number, number]

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`; alpha is dropped, so a colour is measured as drawn opaque. */
export const parseColour = (text: string): Rgb => {
  const value = text.trim()
  const hex = value.match(/^#([0-9a-f]{3,8})$/i)
  if (hex !== null) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) return [0, 1, 2].map(at => parseInt(digits[at]!.repeat(2), 16)) as unknown as Rgb
    if (digits.length === 6 || digits.length === 8) return [0, 2, 4].map(at => parseInt(digits.slice(at, at + 2), 16)) as unknown as Rgb
  }
  const functional = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*[\d.]+\s*)?\)$/)
  if (functional !== null) return [Number(functional[1]), Number(functional[2]), Number(functional[3])]
  throw new Error(`not a colour: ${text}`)
}

export type Lab = readonly [number, number, number]

/** sRGB (0–255) → CIELAB under D65. */
export const toLab = ([red, green, blue]: Rgb): Lab => {
  const linear = [red, green, blue].map(channel => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const [r, g, b] = linear
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const degrees = (radians: number) => radians * 180 / Math.PI
const radians = (degreesValue: number) => degreesValue * Math.PI / 180

/** CIEDE2000 colour difference (Sharma, Wu and Dalal 2005), kL = kC = kH = 1. */
export const ciede2000 = ([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number => {
  const chromaMean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const g = 0.5 * (1 - Math.sqrt(chromaMean ** 7 / (chromaMean ** 7 + 25 ** 7)))
  const a1p = (1 + g) * a1, a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2)
  const hue = (b: number, ap: number) => b === 0 && ap === 0 ? 0 : (degrees(Math.atan2(b, ap)) + 360) % 360
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p)
  const deltaL = l2 - l1
  const deltaC = c2p - c1p
  const chromaProduct = c1p * c2p
  const rawHue = h2p - h1p
  const deltaHue = chromaProduct === 0 ? 0 : rawHue > 180 ? rawHue - 360 : rawHue < -180 ? rawHue + 360 : rawHue
  const deltaH = 2 * Math.sqrt(chromaProduct) * Math.sin(radians(deltaHue / 2))
  const lightnessMean = (l1 + l2) / 2
  const chromaMeanP = (c1p + c2p) / 2
  const hueMean = chromaProduct === 0
    ? h1p + h2p
    : Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
  const t = 1 - 0.17 * Math.cos(radians(hueMean - 30)) + 0.24 * Math.cos(radians(2 * hueMean))
    + 0.32 * Math.cos(radians(3 * hueMean + 6)) - 0.2 * Math.cos(radians(4 * hueMean - 63))
  const deltaTheta = 30 * Math.exp(-(((hueMean - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(chromaMeanP ** 7 / (chromaMeanP ** 7 + 25 ** 7))
  const sl = 1 + 0.015 * (lightnessMean - 50) ** 2 / Math.sqrt(20 + (lightnessMean - 50) ** 2)
  const sc = 1 + 0.045 * chromaMeanP
  const sh = 1 + 0.015 * chromaMeanP * t
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc
  return Math.sqrt((deltaL / sl) ** 2 + (deltaC / sc) ** 2 + (deltaH / sh) ** 2 + rt * (deltaC / sc) * (deltaH / sh))
}

export const deltaE = (left: string, right: string): number => ciede2000(toLab(parseColour(left)), toLab(parseColour(right)))

/** The five reserved colours of one palette as OpenBridge resolves them. */
export const reservedColours = (css: string, palette: Palette): Readonly<Record<ReservedColour, string>> => {
  const tokens = paletteTokens(css, palette)
  return Object.fromEntries(reservedColourNames.map(name =>
    [name, resolveToken(tokens, tokenName(getAlertColorTokens(reservedAlertTypes[name]).bg))])) as Record<ReservedColour, string>
}

export interface ReservedDistance {
  readonly palette: Palette
  readonly nearest: ReservedColour
  readonly deltaE: number
}

export type ReservedSets = Readonly<Record<Palette, Readonly<Record<ReservedColour, string>>>>

export const readReservedSets = (css: string = readFileSync(openBridgeCssPath, 'utf8')): ReservedSets =>
  Object.fromEntries(palettes.map(palette => [palette, reservedColours(css, palette)])) as unknown as ReservedSets

/** The nearest reserved colour in each palette, and the closest of those. */
export const reservedDistances = (colour: string, sets: ReservedSets): { readonly perPalette: ReadonlyArray<ReservedDistance>; readonly closest: ReservedDistance } => {
  const perPalette = palettes.map(palette => {
    const measured = reservedColourNames.map(name => ({ palette, nearest: name, deltaE: deltaE(colour, sets[palette][name]) }))
    return measured.reduce((best, entry) => entry.deltaE < best.deltaE ? entry : best)
  })
  return { perPalette, closest: perPalette.reduce((best, entry) => entry.deltaE < best.deltaE ? entry : best) }
}

export interface ColourLiteral {
  readonly path: string
  readonly line: number
  readonly literal: string
  readonly context: string
}

const literalPattern = /#[0-9a-fA-F]{3,8}(?![0-9A-Za-z_])|rgba?\(\s*\d[\d.\s,]*\)/g
const hexLengths = new Set([4, 5, 7, 9])

/** Every colour literal in a text, with its line and a short context. */
export const colourLiterals = (path: string, text: string): ReadonlyArray<ColourLiteral> =>
  text.split('\n').flatMap((line, index) => [...line.matchAll(literalPattern)].flatMap(match => {
    const literal = match[0]
    if (literal.startsWith('#') && !hexLengths.has(literal.length)) return []
    const start = Math.max(0, match.index! - 50)
    const context = line.slice(start, match.index! + literal.length + 30).replace(/\s+/g, ' ').trim()
    return [{ path, line: index + 1, literal, context }]
  }))

/** Where a scanned path belongs, for the report. */
export const areaOf = (path: string): string => {
  const pack = path.match(/^src\/packs\/([^/]+)\//)
  if (pack !== null) return `pack ${pack[1]}`
  if (path.startsWith('src/scenarios/')) return 'scenarios'
  if (path.startsWith('src/ui/map-runtime/')) return 'World map'
  if (path.startsWith('src/ui/grid/')) return 'grid work surface'
  return 'World displays'
}

export const defaultScan: ReadonlyArray<string> = [
  'src/packs/**/*.{ts,svelte,css,json}',
  'src/scenarios/**/*.json',
  'src/ui/map-runtime/**/*.ts',
  'src/ui/grid/**/*.{ts,svelte,css}',
  'src/ui/embed/**/*.{ts,svelte,css}',
  'src/ui/displays/**/*.{ts,svelte,css}',
  'src/ui/process-display/**/*.{ts,svelte,css}',
  'src/features/displays/**/*.ts',
]

export const scanColourLiterals = (patterns: ReadonlyArray<string>, root: string = worldRoot): ReadonlyArray<ColourLiteral> => {
  const paths = new Set<string>()
  for (const pattern of patterns) for (const path of new Glob(pattern).scanSync({ cwd: root })) if (!path.includes('.test.')) paths.add(path)
  return [...paths].sort().flatMap(path => colourLiterals(path, readFileSync(join(root, path), 'utf8')))
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2)
  const belowAt = argv.indexOf('--below')
  const below = belowAt === -1 ? Infinity : Number(argv[belowAt + 1])
  if (Number.isNaN(below)) throw new Error('--below needs a number')
  const json = argv.includes('--json')
  const patterns = argv.filter((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--below')
  const sets = readReservedSets()
  const rows = scanColourLiterals(patterns.length > 0 ? patterns : defaultScan).map(literal => ({ ...literal, area: areaOf(literal.path), ...reservedDistances(literal.literal, sets) }))
  const shown = rows.filter(row => row.closest.deltaE < below)
  if (json) {
    console.log(JSON.stringify({ reserved: sets, rows: shown }, null, 2))
  } else {
    for (const palette of palettes) console.log(`${palette.padEnd(6)} ${reservedColourNames.map(name => `${name} ${sets[palette][name]}`).join(' · ')}`)
    console.log('\nmin ΔE  nearest            day   dusk  night  colour                 where')
    for (const row of shown) {
      const [day, dusk, night] = row.perPalette.map(entry => entry.deltaE.toFixed(1).padStart(5))
      console.log(`${row.closest.deltaE.toFixed(1).padStart(6)}  ${`${row.closest.nearest} (${row.closest.palette})`.padEnd(18)} ${day}  ${dusk}  ${night}  ${row.literal.padEnd(22)} ${row.path}:${row.line}  ${row.context}`)
    }
    const areas = [...new Set(rows.map(row => row.area))].sort()
    console.log('\narea                     literals  < 15  < 10')
    for (const area of areas) {
      const inArea = rows.filter(row => row.area === area)
      console.log(`${area.padEnd(24)} ${String(inArea.length).padStart(8)}  ${String(inArea.filter(row => row.closest.deltaE < reservedDistanceFloor).length).padStart(4)}  ${String(inArea.filter(row => row.closest.deltaE < 10).length).padStart(4)}`)
    }
  }
}
