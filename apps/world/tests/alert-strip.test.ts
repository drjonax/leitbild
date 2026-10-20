import { describe, expect, test } from 'bun:test'
import { alertStateSchema, type AlertState, type Priority } from '../src/core/model/alerts.ts'
import type { ObjectId, PackId } from '../src/core/model/ids.ts'
import type { IsoTimestamp } from '../src/core/model/time.ts'
import { annunciatorTiles } from '../src/features/displays/alerts/annunciator.ts'
import { alertRows, groupKey, raisedWords, stateWords, type AlertObject } from '../src/features/displays/alerts/rows.ts'
import { alertStrip, type AlertStrip } from '../src/features/displays/alerts/strip.ts'

// The alert read model and the strip's rules (plan v3.1 §2.7, architecture
// A6, lead rulings R1, R11, R12, R21), on synthetic alert records with the
// facets C1 gives the core alert slot.

const severityOf: Readonly<Record<Priority, AlertState['severity']>> = {
  none: 'info', notice: 'info', caution: 'warning', warning: 'warning', alarm: 'critical', emergency: 'critical',
}
const at = (seconds: number) => new Date(Date.UTC(2026, 6, 12, 4, 0, seconds)).toISOString() as IsoTimestamp

/** A record as the core schema accepts it: priority agreeing with severity, acknowledgedBy only once acknowledged. */
const alert = (id: string, priority: Priority | null, facets: Partial<AlertState> = {}): AlertState => alertStateSchema.parse({
  id, kind: 'test', severity: priority === null ? 'critical' : severityOf[priority], message: `${id} message`,
  raisedAt: at(0), acknowledged: false, clock: 'simulation', ...(priority === null ? {} : { priority }), ...facets,
})
const object = (id: string, alerts: ReadonlyArray<AlertState>, lifecycle: AlertObject['lifecycle'] = 'active'): AlertObject =>
  ({ id: id as ObjectId, packId: id.split(':')[0]! as PackId, lifecycle, alerts })
const present = (subject: AlertObject) => ({ label: `Label of ${subject.id}`, categoryId: 'unit' })
const stripOf = (objects: ReadonlyArray<AlertObject>, maxRows: number): AlertStrip => alertStrip(alertRows(objects, present), { maxRows })

describe('alert rows', () => {
  test('rows keep Run object order and each object\'s own order; closed objects and acknowledged returns are not alerts', () => {
    const rows = alertRows([
      object('plant:b', [alert('b1', 'alarm'), alert('b2', 'caution', { returned: true, acknowledged: true })]),
      object('plant:a', [alert('a1', 'warning'), alert('a2', 'notice', { returned: true })]),
      object('grid:x', [alert('x1', 'alarm')], 'resolved'),
      object('drone:y', [alert('y1', 'alarm')], 'removed'),
    ], present)
    expect(rows.map(row => [row.key, row.state])).toEqual([
      ['plant:b|b1', 'active-unack'], ['plant:a|a1', 'active-unack'], ['plant:a|a2', 'returned-unack'],
    ])
    expect(rows[0]).toMatchObject({ objectLabel: 'Label of plant:b', groupLabel: 'Label of plant:b', packId: 'plant', categoryId: 'unit' })
  })

  test('an alert without a priority keeps priority null ("priority not declared"); a critical one never protects a group', () => {
    const rows = alertRows([object('einsatz:call', [alert('c1', null)]), object('plant:a', [alert('a1', 'caution')]), object('plant:b', [alert('b1', 'caution')])], present)
    expect(rows[0]!.priority).toBeNull()
    expect(rows[0]!.alert.severity).toBe('critical')
    const strip = alertStrip(rows, { maxRows: 2 })
    expect(strip.groups.find(group => group.key === 'einsatz:call')).toMatchObject({ worst: null, collapsed: true })
  })

  test('a wall or absent clock reads "time unknown"; simulation time is the caller\'s to word', () => {
    const rows = alertRows([object('plant:a', [alert('sim', 'alarm'), alert('wall', 'alarm', { clock: 'wall' }), alert('none', 'alarm', { clock: undefined })])], present)
    const word = (time: IsoTimestamp) => time.slice(11, 19)
    expect(rows.map(row => raisedWords(row, word))).toEqual(['04:00:00', 'time unknown', 'time unknown'])
    expect(rows.map(row => row.raised?.clock ?? null)).toEqual(['simulation', 'wall', null])
  })

  test('"acknowledged by Assistant" only where acknowledgedBy says ai (R11)', () => {
    const rows = alertRows([object('plant:a', [
      alert('ai', 'alarm', { acknowledged: true, acknowledgedBy: 'ai' }),
      alert('person', 'alarm', { acknowledged: true, acknowledgedBy: 'person' }),
      alert('unknown', 'alarm', { acknowledged: true }),
      alert('system', 'alarm', { acknowledged: true, acknowledgedBy: 'system' }),
      alert('open', 'alarm'),
      alert('back', 'alarm', { returned: true }),
    ])], present)
    expect(rows.map(stateWords)).toEqual([
      'acknowledged by Assistant', 'acknowledged', 'acknowledged', 'acknowledged by system', 'unacknowledged', 'returned · unacknowledged',
    ])
  })

  test('a subject group splits its object\'s alarms; it is headed by the label the Pack gives it, else the object\'s, never its id (R21)', () => {
    const objects = [object('grid:g', [alert('n', 'alarm', { subject: { group: 'island-north' } }), alert('s', 'alarm', { subject: { group: 'island-south' } }), alert('e', 'alarm', { subject: { element: 'bus-7' } })])]
    const rows = alertRows(objects, () => ({ label: 'Grid', categoryId: 'grid', groupLabels: { 'island-north': 'North island' } }))
    expect(rows.map(row => [groupKey(row), row.groupLabel])).toEqual([['grid:g|island-north', 'North island'], ['grid:g|island-south', 'Grid'], ['grid:g', 'Grid']])
    expect(alertStrip(rows, { maxRows: 6 }).groups.map(group => group.key)).toEqual(['grid:g', 'grid:g|island-north', 'grid:g|island-south'])
  })
})

describe('the strip', () => {
  test('one row per group: the first-out pinned, else worst by priority, then the latest raised (R12)', () => {
    const strip = stripOf([
      object('plant:a', [alert('old', 'alarm', { raisedAt: at(1) }), alert('new', 'alarm', { raisedAt: at(5) }), alert('worse', 'emergency', { raisedAt: at(0) }), alert('caution', 'caution', { raisedAt: at(9) })]),
      object('plant:b', [alert('alarm', 'alarm', { raisedAt: at(9) }), alert('first', 'warning', { raisedAt: at(1), firstOut: { group: 'rx', rank: 1 } }), alert('second', 'warning', { raisedAt: at(2), firstOut: { group: 'rx', rank: 2 } })]),
    ], 6)
    expect(strip.groups.map(group => group.rows.map(row => row.alert.id))).toEqual([['worse', 'new', 'old', 'caution'], ['first', 'alarm', 'second']])
    expect(strip.groups[1]!.firstOut!.alert.id).toBe('first')
    expect(strip.groups[1]!.worst).toBe('alarm')
    expect(strip.hiddenRows).toBe(5)
  })

  test('caution-only groups collapse into "+N groups · worst · n unack"; alarm, emergency and first-out groups never merge; warning keeps a row before caution', () => {
    const strip = stripOf([
      object('a:1', [alert('c', 'caution')]),
      object('a:2', [alert('alarm', 'alarm')]),
      object('a:3', [alert('c', 'caution', { acknowledged: true })]),
      object('a:4', [alert('w', 'warning')]),
      object('a:5', [alert('fo', 'caution', { firstOut: { group: 'g', rank: 1 } })]),
      object('a:6', [alert('e', 'emergency')]),
      object('a:7', [alert('c', 'caution')]),
    ], 5)
    expect(strip.groups.map(group => [group.key, group.collapsed])).toEqual([
      ['a:1', true], ['a:2', false], ['a:3', true], ['a:4', false], ['a:5', false], ['a:6', false], ['a:7', true],
    ])
    expect(strip.collapsed).toEqual({ groups: 3, worst: 'caution', unack: 2 })
    // With no room left, the protected groups still keep theirs.
    expect(stripOf([object('a:1', [alert('x', 'alarm')]), object('a:2', [alert('y', 'emergency')]), object('a:3', [alert('z', 'warning')])], 1).groups.map(group => group.collapsed)).toEqual([false, false, true])
    // Everything that fits is shown, with no summary row.
    expect(stripOf([object('a:1', [alert('x', 'caution')]), object('a:2', [alert('y', 'caution')])], 2).collapsed).toBeNull()
  })

  test('standing alarms stay quiet: no unacknowledged count, never the row while another alarm is in, and a standing-only group collapses first', () => {
    const strip = stripOf([
      object('a:1', [alert('standing', 'alarm', { standing: true, raisedAt: at(9) }), alert('caution', 'caution')]),
      object('a:2', [alert('quiet', 'alarm', { standing: true })]),
      object('a:3', [alert('caution', 'caution')]),
      object('a:4', [alert('caution', 'caution')]),
    ], 3)
    const [mixed, quiet] = strip.groups
    expect(mixed).toMatchObject({ worst: 'caution', counts: { active: 2, unack: 1, standing: 1 }, quiet: false })
    expect(mixed!.rows[0]!.alert.id).toBe('caution')
    expect(quiet).toMatchObject({ worst: 'alarm', counts: { active: 1, unack: 0, standing: 1 }, quiet: true, collapsed: true })
    expect(strip.groups.map(group => group.collapsed)).toEqual([false, true, false, true])
    expect(strip.collapsed).toEqual({ groups: 2, worst: 'caution', unack: 1 })
    // A summary of standing groups only still says what stands.
    expect(stripOf([object('a:1', [alert('x', 'alarm')]), object('a:2', [alert('q', 'warning', { standing: true })]), object('a:3', [alert('r', 'caution', { standing: true })])], 2).collapsed)
      .toEqual({ groups: 2, worst: 'warning', unack: 0 })
  })

  test('priority none asks for no attention and is not in the strip', () => {
    expect(stripOf([object('a:1', [alert('n', 'none')])], 3).groups).toEqual([])
  })

  test('a strip needs at least one row', () => {
    expect(() => stripOf([], 0)).toThrow('at least one row')
  })
})

describe('the strip over 200 random transitions', () => {
  // A seeded generator (mulberry32), so a failure replays.
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const objectIds = ['plant:halden-1', 'plant:halden-2', 'plant:halden-3', 'plant:halden-4', 'grid:halden', 'einsatz:call-7', 'drone:d1'] as const
  const priorities: ReadonlyArray<Priority | null> = [null, 'notice', 'caution', 'warning', 'alarm', 'emergency']

  for (const [seed, maxRows] of [[1, 6], [2, 4], [3, 8], [4, 3]] as const) {
    test(`seed ${seed}, ${maxRows} rows: groups never reorder, every first-out keeps its row and its tile, protected groups never merge, the cap holds`, () => {
      const next = random(seed)
      const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(next() * items.length)]!
      const alerts = new Map<string, AlertState[]>(objectIds.map(id => [id, []]))
      const fixedOrder = (key: string): string => `${objectIds.indexOf(key.split('|')[0]! as (typeof objectIds)[number])}|${key.split('|')[1] ?? ''}`
      let serial = 0
      let firstOuts = 0
      for (let step = 1; step <= 200; step += 1) {
        const id = pick(objectIds)
        const list = alerts.get(id)!
        const action = list.length === 0 ? 'raise' : pick(['raise', 'raise', 'acknowledge', 'return', 'clear', 'stand'] as const)
        const target = list.length === 0 ? undefined : pick(list)
        const replace = (changed: AlertState) => list.splice(list.indexOf(target!), 1, alertStateSchema.parse(changed))
        if (action === 'raise') {
          serial += 1
          const group = id.startsWith('grid') && next() < 0.5 ? { subject: { group: pick(['island-a', 'island-b']) } } : {}
          const firstOut = id.startsWith('plant') && next() < 0.3 ? { firstOut: { group: pick(['rx-trip', 'afw']), rank: list.filter(entry => entry.firstOut !== undefined).length + 1 } } : {}
          list.push(alert(`a${serial}`, pick(priorities), { raisedAt: at(step), clock: next() < 0.9 ? 'simulation' : 'wall', ...group, ...firstOut }))
        } else if (action === 'acknowledge') replace({ ...target!, acknowledged: true, acknowledgedBy: pick(['person', 'ai'] as const) })
        else if (action === 'return') replace({ ...target!, returned: true })
        else if (action === 'stand') replace({ ...target!, standing: true })
        else list.splice(list.indexOf(target!), 1)

        const rows = alertRows(objectIds.map(objectId => object(objectId, alerts.get(objectId)!)), present)
        const strip = alertStrip(rows, { maxRows })
        // Groups keep one order, fixed by the Run's objects and the subject group, whatever the values.
        const keys = strip.groups.map(group => group.key)
        expect(keys).toEqual([...keys].sort((left, right) => fixedOrder(left).localeCompare(fixedOrder(right))))
        const protectedGroups = strip.groups.filter(group => group.firstOut !== null || (!group.quiet && (group.worst === 'alarm' || group.worst === 'emergency')))
        for (const group of protectedGroups) expect(group.collapsed).toBe(false)
        for (const group of strip.groups.filter(candidate => candidate.firstOut !== null)) {
          firstOuts += 1
          expect(group.rows[0]).toBe(group.firstOut!)
          const ranked = group.rows.filter(row => row.alert.firstOut?.rank === 1).map(row => row.key).sort()
          expect(annunciatorTiles(rows, group.key).filter(tile => tile.rank === 1).map(tile => tile.rowKey).sort()).toEqual(ranked)
        }
        const shownRows = strip.groups.filter(group => !group.collapsed).length + (strip.collapsed === null ? 0 : 1)
        if (protectedGroups.length < maxRows) expect(shownRows).toBeLessThanOrEqual(maxRows)
        const drawn = rows.filter(row => row.priority !== 'none').length
        expect(strip.groups.filter(group => !group.collapsed).length + strip.hiddenRows).toBe(drawn)
        expect(strip.collapsed?.groups ?? 0).toBe(strip.groups.filter(group => group.collapsed).length)
      }
      expect(firstOuts).toBeGreaterThan(0)
    })
  }
})
