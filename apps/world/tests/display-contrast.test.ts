import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Every text/background pair the embedded displays draw with, read from the
// OpenBridge palettes and the display tokens in embed.css, at 4.5:1 or more
// (WCAG AA) in day, dusk and night (hmi audit: caution text read 1.27:1 and
// orange chips 2.07:1 in day).

const root = join(import.meta.dir, '..')
const openBridgeCss = readFileSync(join(root, 'node_modules/@oicl/openbridge-webcomponents/dist/openbridge.css'), 'utf8')
const embedCss = readFileSync(join(root, 'src/ui/embed/embed.css'), 'utf8')

type Palette = 'day' | 'dusk' | 'night'
const PALETTES: ReadonlyArray<Palette> = ['day', 'dusk', 'night']

/** Custom properties a stylesheet sets on `:root` and on `:root[data-obc-theme="<palette>"]`, in source order. */
const rootDeclarations = (css: string, palette: Palette): ReadonlyMap<string, string> => {
  const declared = new Map<string, string>()
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1]!.split(',').map(selector => selector.trim())
    if (!selectors.some(selector => selector === ':root' || selector === `:root[data-obc-theme="${palette}"]`)) continue
    for (const declaration of block[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) declared.set(declaration[1]!, declaration[2]!.trim())
  }
  return declared
}

/** The palette as a page with both stylesheets sees it: embed.css loads after OpenBridge's. */
const paletteOf = (palette: Palette): ReadonlyMap<string, string> =>
  new Map([...rootDeclarations(openBridgeCss, palette), ...rootDeclarations(embedCss, palette)])

const resolve = (tokens: ReadonlyMap<string, string>, name: string, seen: ReadonlyArray<string> = []): string => {
  if (seen.includes(name)) throw new Error(`token cycle: ${[...seen, name].join(' → ')}`)
  const value = tokens.get(name)
  if (value === undefined) throw new Error(`token ${name} is not set`)
  const reference = value.match(/^var\((--[\w-]+)\)$/)
  return reference === null ? value : resolve(tokens, reference[1]!, [...seen, name])
}

const channels = (colour: string): readonly [number, number, number] => {
  const rgb = colour.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*1(?:\.0+)?)?\s*\)$/)
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = colour.match(/^#([0-9a-f]{6})$/i)
  if (hex !== null) return [0, 2, 4].map(at => parseInt(hex[1]!.slice(at, at + 2), 16)) as unknown as readonly [number, number, number]
  throw new Error(`not an opaque colour: ${colour}`)
}

const luminance = (colour: string): number => {
  const [r, g, b] = channels(colour).map(channel => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (left: string, right: string): number => {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

const PANEL_BACKGROUNDS = ['--container-background-color', '--container-section-color'] as const

/** Text token → the backgrounds it is drawn on. */
const TEXT_PAIRS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['--element-active-color', PANEL_BACKGROUNDS],
  ['--element-neutral-color', PANEL_BACKGROUNDS],
  // Words saying a value is past a limit, and expected-after chips (outlined, no fill).
  ['--display-alert-text', PANEL_BACKGROUNDS],
  // Chips, CSF chips and popover chips on their alert fill.
  ['--display-on-alarm', ['--display-alarm-fill']],
  ['--display-on-warning', ['--display-warning-fill']],
  ['--display-on-caution', ['--display-caution-fill']],
  ['--display-on-critical', ['--display-critical-fill']],
  // A vignette's filled state word: the panel's background on the active text colour.
  ['--container-background-color', ['--element-active-color']],
]

describe('display text contrast', () => {
  for (const palette of PALETTES) {
    test(`every text/background pair reads 4.5:1 or more in ${palette}`, () => {
      const tokens = paletteOf(palette)
      const failing = TEXT_PAIRS.flatMap(([text, backgrounds]) => backgrounds.flatMap(background => {
        const ratio = contrast(resolve(tokens, text), resolve(tokens, background))
        return ratio >= 4.5 ? [] : [`${text} on ${background}: ${ratio.toFixed(2)}:1`]
      }))
      expect(failing).toEqual([])
    })
  }

  test('the measurement reproduces the audit: caution yellow as text on the day background is 1.27:1', () => {
    const day = paletteOf('day')
    expect(contrast(resolve(day, '--alert-caution-color'), resolve(day, '--container-background-color'))).toBeCloseTo(1.27, 2)
    expect(contrast(resolve(day, '--container-background-color'), resolve(day, '--alert-warning-color'))).toBeCloseTo(2.07, 2)
  })
})

// Files the lead has frozen until Codex's Synopticon merge (plan D3); each still writes text in a raw alert colour
// and moves to the display tokens once D3 is settled (p0-client notes).
const FROZEN_UNTIL_D3 = new Set([
  'ComposedDisplayView.svelte',
  'ReadoutsPanel.svelte',
  'TrendPanel.svelte',
  'mimic/MimicPanel.svelte',
])

const svelteFiles = (directory: string): ReadonlyArray<string> => readdirSync(directory).flatMap(name => {
  const path = join(directory, name)
  return statSync(path).isDirectory() ? svelteFiles(path) : name.endsWith('.svelte') ? [path] : []
})

test('display text is never written in a raw alert colour or plain white: it goes through the display tokens', () => {
  const directory = join(root, 'src/ui/embed/composed-display')
  const offending = svelteFiles(directory).flatMap(path => {
    const file = relative(directory, path)
    if (FROZEN_UNTIL_D3.has(file)) return []
    const style = readFileSync(path, 'utf8').match(/<style>([\s\S]*)<\/style>/)?.[1] ?? ''
    return [...style.matchAll(/(?:^|[;{\s])color:\s*(var\(--alert-[\w-]+\)|#fff\b|#ffffff\b|white\b)/g)].map(match => `${file}: color: ${match[1]}`)
  })
  expect(offending).toEqual([])
})
