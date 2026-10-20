import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { deltaE, parseColour, readReservedSets, reservedColourNames } from '../scripts/displays/reserved-colour-distance.ts'

// T04a (plan v3.1 §2.7, Appendix F; gate G1): the colour rules a World-drawn
// display keeps. Each rule is checked against a planted violation that must
// fail. The parts that read the severity table (ui/displays/severity.ts), the
// alert read model (features/displays/alerts/) and the alert record's
// priority (core/model/alerts.ts) land with those files.

const src = join(import.meta.dir, '../src')

const filesUnder = (dir: string): ReadonlyArray<string> => !existsSync(dir) ? [] : readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? filesUnder(path) : [path]
})

/** World's own display code: the new composer and renderer. The old embed renderer (ui/embed) is frozen until the swap (D3) and leaves with it. */
const worldDisplayRoots = ['features/displays', 'ui/displays'] as const
/** The one place a World display's alert colours are written down, as OpenBridge's values per palette. */
const severityTablePath = 'ui/displays/severity.ts'

const colourLiteral = /#[0-9a-fA-F]{3,8}(?![0-9A-Za-z_])|\b(?:rgba?|hsla?)\([^)]*\)/g
const alertToken = /--(?:alert-[\w-]+|(?:alarm|warning|caution|critical|notification)-[\w-]+)/g
const hexLengths = new Set([4, 5, 7, 9])

/** Achromatic colours (black, white and greys, as in a shadow) carry no channel and are allowed. */
const isAchromatic = (literal: string): boolean => {
  if (literal.startsWith('hsl')) return false
  const [r, g, b] = parseColour(literal)
  return r === g && g === b
}

/**
 * A colour a World display writes down for itself instead of taking it from
 * the severity table: a chromatic colour literal, or an OpenBridge alert token
 * (the main app loads no OpenBridge, and the table is the one source in both
 * bundles). Comments count too: a colour in a comment is how one creeps back.
 */
const ownColours = (path: string, source: string): ReadonlyArray<string> => source.split('\n').flatMap((line, index) => [
  ...[...line.matchAll(colourLiteral)].map(match => match[0])
    .filter(literal => !literal.startsWith('#') || hexLengths.has(literal.length))
    .filter(literal => !isAchromatic(literal)),
  ...[...line.matchAll(alertToken)].map(match => match[0]),
].map(found => `${path}:${index + 1} ${found}`))

describe('T04a: World-drawn colours come from the severity table only', () => {
  test('World display code writes no colour of its own outside the severity table', () => {
    const offenders = worldDisplayRoots.flatMap(root => filesUnder(join(src, root)))
      .filter(file => /\.(ts|svelte|css)$/.test(file) && !file.includes('.test.'))
      .map(file => relative(src, file))
      .filter(path => path !== severityTablePath)
      .flatMap(path => ownColours(path, readFileSync(join(src, path), 'utf8')))
    expect(offenders).toEqual([])
  })

  test('planted: a pack hex, an rgb() hue, an hsl() and an OpenBridge alert token are each caught; a black shadow is not', () => {
    const planted = [
      "const hazard = '#dc2626'",
      '.row.warn { border-color: rgb(217, 119, 6); }',
      '.badge { background: hsl(300 70% 45%); }',
      '.chip.alarm { background: var(--alert-alarm-color); }',
      '.popover { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); color: #fff; }',
      '{#each groups as group}<span>{group.label}</span>{/each}',
    ].join('\n')
    expect(ownColours('planted.svelte', planted)).toEqual([
      'planted.svelte:1 #dc2626',
      'planted.svelte:2 rgb(217, 119, 6)',
      'planted.svelte:3 hsl(300 70% 45%)',
      'planted.svelte:4 --alert-alarm-color',
    ])
  })
})

describe('T04a: OpenBridge 2.0.0 keeps the alert families apart in every palette', () => {
  // The severity table copies these per palette; an OpenBridge upgrade that
  // moved two families together would make one alert read as another.
  const sets = readReservedSets()
  test('emergency (critical magenta) is at least ΔE 30 from alarm red, so critical severity drawn otherwise never reads as emergency', () => {
    for (const palette of ['day', 'dusk', 'night'] as const) expect(deltaE(sets[palette].critical, sets[palette].alarm)).toBeGreaterThan(30)
  })

  test('the five reserved colours are distinct in day and dusk (ΔE ≥ 20); night, a dark-adaptation palette, keeps them ≥ 14', () => {
    for (const palette of ['day', 'dusk', 'night'] as const) {
      const floor = palette === 'night' ? 14 : 20
      for (const [index, left] of reservedColourNames.entries()) for (const right of reservedColourNames.slice(index + 1)) {
        expect({ palette, left, right, apart: deltaE(sets[palette][left], sets[palette][right]) >= floor }).toEqual({ palette, left, right, apart: true })
      }
    }
  })
})
