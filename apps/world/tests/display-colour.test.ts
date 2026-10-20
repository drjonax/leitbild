import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getAlertBadgeComponent, getAlertColorTokens } from '@oicl/openbridge-webcomponents/dist/alert-severity.js'
import { AlertType } from '@oicl/openbridge-webcomponents/dist/types.js'
import { alertSeveritySchema, alertStateSchema, priorityLevels, type AlertSeverity, type AlertState, type Priority } from '../src/core/model/alerts.ts'
import type { ObjectId, PackId } from '../src/core/model/ids.ts'
import type { IsoTimestamp } from '../src/core/model/time.ts'
import type { PackObjectPresentation, PackObjectStatusTone } from '../src/core/packs/protocol.ts'
import { alertRows, type AlertObject, type AlertPresentation } from '../src/features/displays/alerts/rows.ts'
import { alertStrip } from '../src/features/displays/alerts/strip.ts'
import { severityStyle, severityTable } from '../src/ui/displays/severity.ts'
import {
  deltaE, openBridgeCssPath, paletteTokens, palettes, parseColour, readReservedSets, reservedColourNames, resolveToken, tokenName, type Palette,
} from '../scripts/displays/reserved-colour-distance.ts'

// T04a (plan v3.1 §2.7, Appendix F; gate G1): the colour rules a World-drawn
// display keeps. Each rule is checked against a planted violation that must
// fail. The strip's own drawing (ui/displays, S3) is held to the same rules
// by the World-drawn-colour lint below and lands with its own render checks.

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

describe('T04a: an alert\'s priority agrees with its severity (core/model/alerts.ts)', () => {
  // Written out here, not imported, so a change to the record's own table fails this test.
  const agrees: Readonly<Record<AlertSeverity, ReadonlyArray<Priority>>> = {
    critical: ['alarm', 'emergency'],
    warning: ['caution', 'warning'],
    info: ['none', 'notice'],
  }
  const record = { id: 'a1', kind: 'trip', message: 'Reactor trip', raisedAt: '2026-10-20T08:00:00.000Z', acknowledged: false }

  test('every severity and priority pair parses exactly when they agree', () => {
    for (const severity of alertSeveritySchema.options) {
      for (const priority of priorityLevels) {
        expect({ severity, priority, parses: alertStateSchema.safeParse({ ...record, severity, priority }).success })
          .toEqual({ severity, priority, parses: agrees[severity].includes(priority) })
      }
    }
  })

  test('without a priority every severity parses and none is derived', () => {
    for (const severity of alertSeveritySchema.options) expect(alertStateSchema.parse({ ...record, severity }).priority).toBeUndefined()
  })

  test('planted: a critical alert declared as a caution is refused on its priority', () => {
    const result = alertStateSchema.safeParse({ ...record, severity: 'critical', priority: 'caution' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(issue => issue.path.join('.'))).toEqual(['priority'])
  })
})

describe('T04a: the World severity table matches OpenBridge 2.0.0 in every palette (ui/displays/severity.ts)', () => {
  const css = readFileSync(openBridgeCssPath, 'utf8')
  // Plan v3.1 §2.7, channel A: emergency → level-critical magenta, alarm → alarm red, warning → warning orange,
  // caution → caution yellow, notice → no hue. Written out here, not read from the table.
  const openBridgeType: Readonly<Record<Exclude<Priority, 'none'>, AlertType | null>> = {
    emergency: AlertType.LevelCritical, alarm: AlertType.Alarm, warning: AlertType.Warning, caution: AlertType.Caution, notice: null,
  }
  const family: Readonly<Record<string, string>> = {
    [AlertType.LevelCritical]: 'critical', [AlertType.Alarm]: 'alarm', [AlertType.Warning]: 'warning', [AlertType.Caution]: 'caution',
  }
  /** The shape of OpenBridge's badge for a type, read from the badge's own SVG: a circle, or a path's straight edges. */
  const badgeShape = (type: AlertType): string => {
    const tag = getAlertBadgeComponent(type).replace(/^obi-/, '')
    const source = readFileSync(join(openBridgeCssPath, `../icons/icon-${tag}.js`), 'utf8')
    const icon = source.match(/this\.icon = svg`([\s\S]*?)`;/)![1]!
    if (/<circle\b/.test(icon)) return 'circle'
    const edges = [...icon.matchAll(/<path d="([^"]+)"/g)].reduce((sum, path) => sum + (path[1]!.match(/[LHV]/g) ?? []).length, 0)
    return ({ 3: 'triangle', 4: 'square', 6: 'hexagon' } as Readonly<Record<number, string>>)[edges] ?? `${edges} edges`
  }
  const openBridgeRgb = (type: AlertType, palette: Palette): string => resolveToken(paletteTokens(css, palette), tokenName(getAlertColorTokens(type).bg))

  test('each priority has OpenBridge\'s family, badge shape and colour per palette; notice has none of them', () => {
    expect(Object.keys(severityTable).sort()).toEqual(priorityLevels.filter(level => level !== 'none').sort())
    for (const [priority, type] of Object.entries(openBridgeType) as ReadonlyArray<[Exclude<Priority, 'none'>, AlertType | null]>) {
      const style = severityTable[priority]
      if (type === null) {
        expect({ priority, family: style.family, glyph: style.glyph, rgb: style.rgb }).toEqual({ priority, family: null, glyph: null, rgb: null })
        continue
      }
      expect({ priority, family: style.family as string | null, glyph: style.glyph as string | null }).toEqual({ priority, family: family[type] ?? null, glyph: badgeShape(type) })
      for (const palette of palettes) {
        expect({ priority, palette, rgb: parseColour(style.rgb![palette]) }).toEqual({ priority, palette, rgb: parseColour(openBridgeRgb(type, palette)) })
      }
    }
  })

  test('planted: a table one channel off OpenBridge in one palette is caught', () => {
    const planted = { ...severityTable.alarm.rgb!, dusk: 'rgb(220, 0, 7)' }
    expect(palettes.filter(palette => deltaE(planted[palette], openBridgeRgb(AlertType.Alarm, palette)) !== 0)).toEqual(['dusk'])
  })
})

describe('T04a: an alert without a priority is drawn neutrally, never as emergency (R1)', () => {
  /** The R1 rule: with no declared priority, no family, no glyph, no colour, and the words say so. */
  const neutralWithoutPriority = (style: typeof severityStyle): ReadonlyArray<string> => alertSeveritySchema.options.flatMap(severity => {
    const drawn = style(null, severity)
    return drawn !== null && drawn.family === null && drawn.glyph === null && drawn.rgb === null && drawn.word.includes('priority not declared') ? [] : [severity]
  })

  test('every severity without a priority is drawn without hue or glyph, as "priority not declared"', () => {
    expect(neutralWithoutPriority(severityStyle)).toEqual([])
  })

  test('a declared priority is drawn as itself, and `none` is not drawn', () => {
    expect(severityStyle('emergency', 'critical')).toEqual(severityTable.emergency)
    expect(severityStyle('alarm', 'critical')).toEqual(severityTable.alarm)
    expect(severityStyle('none', 'info')).toBeNull()
  })

  test('planted: a style that derives emergency, or alarm, from critical severity is caught', () => {
    const derivesEmergency: typeof severityStyle = (priority, severity) => severityStyle(priority ?? (severity === 'critical' ? 'emergency' : null), severity)
    const derivesAlarm: typeof severityStyle = (priority, severity) => severityStyle(priority ?? (severity === 'critical' ? 'alarm' : null), severity)
    expect(neutralWithoutPriority(derivesEmergency)).toEqual(['critical'])
    expect(neutralWithoutPriority(derivesAlarm)).toEqual(['critical'])
  })
})

describe('T04a: Pack colour and tone never reach the alert read model, and a group is neutral with its worst child\'s badge', () => {
  const at = '2026-07-12T04:00:00.000Z' as IsoTimestamp
  const severityOf: Readonly<Record<Priority, AlertSeverity>> = { none: 'info', notice: 'info', caution: 'warning', warning: 'warning', alarm: 'critical', emergency: 'critical' }
  const alert = (id: string, priority: Priority, facets: Partial<AlertState> = {}): AlertState =>
    alertStateSchema.parse({ id, kind: 'test', severity: severityOf[priority], message: `${id} message`, raisedAt: at, acknowledged: false, clock: 'simulation', priority, ...facets })
  const objects: ReadonlyArray<AlertObject> = [
    { id: 'plant:u2' as ObjectId, packId: 'plant' as PackId, lifecycle: 'active', alerts: [alert('trip', 'alarm', { firstOut: { group: 'rx-trip', rank: 1 } }), alert('sg-lo', 'caution')] },
    { id: 'grid:no' as ObjectId, packId: 'grid' as PackId, lifecycle: 'active', alerts: [alert('island', 'warning', { subject: { group: 'island-2' } })] },
  ]
  /** A Pack's whole presentation, as a host has it: the read model may take only its words. */
  const presentation = (color: string, tone: PackObjectStatusTone) => (subject: AlertObject): PackObjectPresentation & AlertPresentation => ({
    label: `Label of ${subject.id}`, categoryId: 'unit', icon: 'factory', color, summary: '', fields: [],
    status: { tone, label: 'Tripped', indicator: { shape: 'dot' } },
  })
  const drawn = (read: typeof alertRows, present: ReturnType<typeof presentation>) => {
    const rows = read(objects, present)
    return { rows, strip: alertStrip(rows, { maxRows: 4 }) }
  }
  /** Keys that would carry a colour, and values that are one. */
  const colourCarriers = (value: unknown, path = ''): ReadonlyArray<string> => {
    if (typeof value === 'string') return /^(#[0-9a-f]{3,8}|rgba?\()/i.test(value) ? [path] : []
    if (value === null || typeof value !== 'object') return []
    return Object.entries(value).flatMap(([key, inner]) =>
      /^(colou?r|tone|rgb|family|fill|stroke)$/i.test(key) ? [`${path}.${key}`] : colourCarriers(inner, `${path}.${key}`))
  }
  const ignoresPackColour = (read: typeof alertRows): boolean =>
    JSON.stringify(drawn(read, presentation('#dc2626', 'error'))) === JSON.stringify(drawn(read, presentation('#0f915f', 'ready')))
    && colourCarriers(drawn(read, presentation('#dc2626', 'error'))).length === 0

  test('rows and strip are the same whatever the presentation\'s colour and tone, and carry no colour', () => {
    expect(ignoresPackColour(alertRows)).toBe(true)
  })

  test('planted: a read model that copies the presentation\'s colour or tone onto its rows is caught', () => {
    const copiesColour: typeof alertRows = (subjects, present) => alertRows(subjects, present).map(row => ({ ...row, color: (present(subjects[0]!) as { color?: string }).color }) as never)
    const copiesTone: typeof alertRows = (subjects, present) => alertRows(subjects, present).map(row => ({ ...row, packTone: (present(subjects[0]!) as { status?: { tone: string } }).status?.tone }) as never)
    expect(ignoresPackColour(copiesColour)).toBe(false)
    expect(ignoresPackColour(copiesTone)).toBe(false)
  })

  test('a group has no colour of its own: its badge is its worst child\'s priority, through the severity table', () => {
    const { strip } = drawn(alertRows, presentation('#dc2626', 'error'))
    const plant = strip.groups.find(group => group.key === 'plant:u2')!
    expect(colourCarriers(plant)).toEqual([])
    expect(plant.worst).toBe('alarm')
    expect(severityStyle(plant.worst, 'critical')).toEqual(severityTable.alarm)
    expect(plant.label).toBe('Label of plant:u2')
  })

  test('planted: a group that carries a colour is caught', () => {
    expect(colourCarriers({ key: 'plant:u2', label: 'Unit 2', worst: 'alarm', fill: 'rgb(227, 0, 25)' })).toEqual(['.fill'])
    expect(colourCarriers({ key: 'plant:u2', label: 'Unit 2', worst: 'alarm', badge: { background: '#e30019' } })).toEqual(['.badge.background'])
  })
})
