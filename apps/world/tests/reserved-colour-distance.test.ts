import { describe, expect, test } from 'bun:test'
import { ciede2000, colourLiterals, deltaE, parseColour, readReservedSets, reservedDistances, toLab } from '../scripts/displays/reserved-colour-distance.ts'

// The colour-distance tool behind T04a and T04b: CIEDE2000 against the
// published test data, OpenBridge 2.0.0's reserved set as a page sees it, and
// the literal scan the inventory is built from.

describe('CIEDE2000', () => {
  // Sharma, Wu and Dalal (2005), "The CIEDE2000 color-difference formula", Table 1.
  const pairs: ReadonlyArray<readonly [readonly [number, number, number], readonly [number, number, number], number]> = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  ]
  test('matches the published test pairs to four decimals, in both orders', () => {
    for (const [left, right, expected] of pairs) {
      expect(ciede2000(left, right)).toBeCloseTo(expected, 4)
      expect(ciede2000(right, left)).toBeCloseTo(expected, 4)
    }
  })

  test('reads sRGB literals under D65', () => {
    expect(toLab(parseColour('#ffffff'))[0]).toBeCloseTo(100, 3)
    expect(toLab(parseColour('#000'))[0]).toBeCloseTo(0, 6)
    expect(parseColour('rgba(37, 99, 235, 0.55)')).toEqual([37, 99, 235])
    expect(parseColour('#64748b66')).toEqual([100, 116, 139])
    expect(deltaE('#dc2626', 'rgb(220, 38, 38)')).toBe(0)
  })
})

describe('OpenBridge 2.0.0 reserved set', () => {
  const sets = readReservedSets()
  test('is the alarm, warning, caution, level-critical and diagnostic background in each palette, later declarations winning', () => {
    expect(sets.day).toEqual({ alarm: 'rgb(227, 0, 25)', warning: 'rgb(254, 148, 19)', caution: 'rgb(255, 219, 66)', critical: 'rgb(196, 36, 183)', notification: 'rgb(45, 84, 139)' })
    // Dusk and night declare --alert-critical-color twice; the later block points it at --critical-enabled-background-color.
    expect(sets.dusk.critical).toBe('rgb(189, 40, 190)')
    expect(sets.night.critical).toBe('rgb(195, 48, 196)')
    expect(sets.night.notification).toBe('rgb(40, 101, 80)')
  })

  test('names the nearest reserved colour per palette', () => {
    const { perPalette, closest } = reservedDistances('#dc2626', sets)
    expect(perPalette.map(entry => entry.nearest)).toEqual(['alarm', 'alarm', 'alarm'])
    expect(closest.palette).toBe('day')
    expect(closest.deltaE).toBeLessThan(3)
  })
})

describe('colour literal scan', () => {
  test('finds hex and rgb literals with their line, and skips Svelte blocks and other words', () => {
    const text = "{#each rows as row}\nconst a = { warm: '#d97706', cool: '#2563eb' }\nborder: 1px solid rgba(148,163,184,.4); #region #abcde\n{/each}"
    expect(colourLiterals('x.svelte', text).map(literal => [literal.line, literal.literal])).toEqual([
      [2, '#d97706'], [2, '#2563eb'], [3, 'rgba(148,163,184,.4)'],
    ])
  })
})
