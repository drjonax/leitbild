import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gridVoltageClasses } from '../src/packs/electric-grid/ui/grid-map-palette.ts'
import { colourLiterals, palettes, readReservedSets, reservedDistanceFloor, reservedDistances, type Palette } from '../scripts/displays/reserved-colour-distance.ts'

// T04b's bar (plan v3.1 §2.7; gated at G3a), held now for the colours P1
// moved: every colour these files supply is ΔE ≥ 15 (CIEDE2000) from
// OpenBridge 2.0.0's alarm, warning, caution, critical and notification
// colours. A colour is measured in the palettes it is drawn in (lead ruling
// R3): an unthemed colour in day, dusk and night, a light-theme colour in day,
// a dark-theme colour in dusk and night. A known violation would be listed by
// name and must still fail, so fixing one removes it here.

const src = join(import.meta.dir, '../src')
const sets = readReservedSets()
const distance = (colour: string, drawnIn: ReadonlyArray<Palette>): number =>
  Math.min(...reservedDistances(colour, sets).perPalette.filter(entry => drawnIn.includes(entry.palette)).map(entry => entry.deltaE))

/** Files whose every colour literal is unthemed and Pack-reachable: the six static edits and R18. */
const editedFiles = [
  'packs/weather/projection.ts',
  'packs/weather/pack.ts',
  'packs/situation-monitor/map.ts',
  'packs/ambulance/ui-pack.ts',
  'packs/drone/model.ts',
  'packs/drone/query.ts',
  'packs/drone/ui-pack.ts',
  'packs/einsatz/colors.ts',
  'packs/einsatz/chain-path.ts',
  'packs/electric-grid/ui-pack.ts',
  'packs/process-plant/presentation.ts',
  'ui/status-presentation.ts',
] as const

/** `path literal` → why it still fails. */
const knownViolations: Readonly<Record<string, string>> = {}

const belowFloor = (path: string, text: string): ReadonlyArray<string> => colourLiterals(path, text)
  .filter(literal => distance(literal.literal, palettes) < reservedDistanceFloor)
  .map(literal => `${path} ${literal.literal}`)

describe('T04b now: the colours P1 moved clear the reserved set', () => {
  test('every colour in the edited files is ΔE ≥ 15 from the five reserved colours in day, dusk and night', () => {
    const failing = [...new Set(editedFiles.flatMap(path => belowFloor(path, readFileSync(join(src, path), 'utf8'))))]
    expect(failing.filter(key => !(key in knownViolations))).toEqual([])
    expect(Object.keys(knownViolations).filter(key => !failing.includes(key))).toEqual([])
  })

  test('grid voltage classes clear the bar in the palettes their theme draws in', () => {
    const drawnIn: Readonly<Record<'light' | 'dark', ReadonlyArray<Palette>>> = { light: ['day'], dark: ['dusk', 'night'] }
    const failing = gridVoltageClasses.flatMap(entry => (['light', 'dark'] as const)
      .filter(theme => distance(entry.color[theme], drawnIn[theme]) < reservedDistanceFloor)
      .map(theme => `${entry.id} ${theme}`))
    // P1 moved 220 kV off magenta (D9) and 300 and 132 kV off critical magenta and notification blue (R24).
    expect(failing).toEqual([])
  })

  test('planted: an alarm-red and a notification-navy literal are caught, a cleared colour is not', () => {
    expect(belowFloor('planted.ts', "const a = '#dc2626', b = 'rgb(45, 84, 139)', c = '#0f915f'")).toEqual(['planted.ts #dc2626', 'planted.ts rgb(45, 84, 139)'])
  })
})
