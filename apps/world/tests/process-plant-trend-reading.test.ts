import { describe, expect, test } from 'bun:test'
import type { ComposedDisplayThreshold } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { limitStateText, projectedMinutes, rateWindowMs, readingLookBackMs, travelOf, travelText, trendPoints, trendReading, type TrendPoint } from '../src/packs/process-plant/displays/trend-reading.ts'

// Pressurizer pressure limits as the reference PWR's I&C draws them.
const pressureLimits: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'pzr-trip-low', label: 'Pressurizer pressure low trip', kind: 'trip', operator: '<', direction: 'low', value: 13.8, escalation: 1, modeLabel: 'Power operation', modeIds: ['powerOperation'] },
  { ruleId: 'pzr-low', label: 'Pressurizer pressure low', kind: 'alarm', operator: '<', direction: 'low', value: 14.8, escalation: 1 },
  { ruleId: 'pzr-spray', label: 'Spray', kind: 'control', operator: '>', direction: 'high', value: 15.65, escalation: 1 },
  { ruleId: 'pzr-high', label: 'Pressurizer pressure high', kind: 'alarm', operator: '>', direction: 'high', value: 16, escalation: 1 },
]
const powerOperation = { id: 'powerOperation', label: 'Power operation' }
const seconds = (count: number, value: (second: number) => number): ReadonlyArray<TrendPoint> =>
  Array.from({ length: count + 1 }, (_, second) => ({ t: second * 1000, v: value(second) }))
const read = (points: ReadonlyArray<TrendPoint> | null, value: number, extra: Partial<Parameters<typeof trendReading>[0]> = {}) =>
  trendReading({ value, points, windowMs: rateWindowMs(600_000), unit: 'MPa', thresholds: pressureLimits, mode: powerOperation, activeRuleIds: new Set(), ...extra })

describe('how a trend reads now', () => {
  test('a falling pressure names the low alarm ahead of it, not the nearer high one behind it', () => {
    // Production: 15.458 MPa falling, 0.542 MPa below HI ALM 16 but heading for LO ALM 14.8.
    const falling = seconds(120, second => 17.458 - second / 60)
    const reading = read(falling, falling.at(-1)!.v)
    expect(reading.travel).toBe('falling')
    expect(reading.rate).toBeCloseTo(-1, 6)
    expect(reading.limit).toMatchObject({ kind: 'margin', margin: { threshold: { ruleId: 'pzr-low' } } })
    expect(limitStateText(reading.limit!, 'MPa')).toBe('0.658 MPa above LO ALM 14.8 MPa · ≈39 s')
    expect(reading.limit?.kind === 'margin' ? reading.limit.minutes : null).toBeCloseTo(0.658, 3)
    expect(travelText(reading.rate, falling.at(-1)!.v, 'MPa', reading.change)).toBe('falling 1.00 MPa/min')
    // A fall the display shows in one step per half minute (one decimal at 15 MPa) gives no basis for a time.
    const slow = seconds(120, second => 15.858 - second * (0.4 / 120))
    expect(limitStateText(read(slow, slow.at(-1)!.v).limit!, 'MPa')).toBe('0.658 MPa above LO ALM 14.8 MPa · approaching, not projected')
  })

  test('a row shown live only has no rate and names the nearest limit', () => {
    const reading = read(null, 15.458)
    expect([reading.rate, reading.travel, reading.change]).toEqual([null, null, null])
    expect(limitStateText(reading.limit!, 'MPa')).toBe('0.542 MPa below HI ALM 16 MPa')
  })

  test('without history enough for a rate, the nearest limit either way, and no direction', () => {
    // The operations Historian re-records an unchanged value once a minute: one point in the window.
    const reading = read([{ t: 0, v: 15.458 }, { t: 60_000, v: 15.458 }], 15.458)
    expect(reading.travel).toBeNull()
    expect(limitStateText(reading.limit!, 'MPa')).toBe('0.542 MPa below HI ALM 16 MPa')
  })

  test('a tendency without a basis for a time says so in the display\'s words', () => {
    // Bending over: falling fast, then slowing.
    const bending = seconds(120, second => 14.9 + 0.9 * Math.exp(-second / 40))
    const reading = read(bending, bending.at(-1)!.v)
    expect(reading.travel).toBe('falling')
    expect(reading.change).toBe('slowing')
    expect(reading.limit).toMatchObject({ kind: 'margin', eta: 'approaching, not projected', minutes: null })
    expect(travelText(reading.rate, bending.at(-1)!.v, 'MPa', reading.change)).toMatch(/^falling [0-9.]+ MPa\/min, slowing$/)
  })

  test('past an active limit and coming back, it says when it will be inside again', () => {
    const recovering = seconds(120, second => 12 + second * 0.02)
    const reading = read(recovering, recovering.at(-1)!.v, { activeRuleIds: new Set(['pzr-low']) })
    expect(reading.inAlarm?.ruleId).toBe('pzr-low')
    expect(reading.travel).toBe('rising')
    expect(limitStateText(reading.limit!, 'MPa')).toBe('back above LO ALM 14.8 MPa in ≈20 s')
  })

  test('past every limit on its way, it is moving away from them', () => {
    // Below both low limits and still falling: none ahead (porv-open).
    const reading = read(seconds(120, second => 5 - second * 0.005), 4.4, { activeRuleIds: new Set(['pzr-low', 'pzr-trip-low']) })
    expect(limitStateText(reading.limit!, 'MPa')).toBe('no LO limit ahead')
  })

  test('limits that do not act in the current mode are never read against', () => {
    const hotStandby = { id: 'hotStandby', label: 'Hot standby' }
    const onlyQualified = pressureLimits.filter(threshold => threshold.modeIds !== undefined)
    const reading = read(null, 12, { thresholds: onlyQualified, mode: hotStandby })
    expect(limitStateText(reading.limit!, 'MPa')).toBe('no limit acts in Hot standby')
    expect(limitStateText(read(null, 12, { thresholds: [] }).limit!, 'MPa')).toBe('no I&C limit')
  })

  test('direction, projected times and recorded pages', () => {
    expect([travelOf(null, 10), travelOf(0.001, 10), travelOf(0.5, 10), travelOf(-0.5, 10)]).toEqual([null, 'steady', 'rising', 'falling'])
    expect(travelText(0.001, 10, 'MPa', null)).toBe('steady')
    expect(travelText(null, 10, 'MPa', null)).toBe('')
    expect(travelText(-0.012, 0.955, 'fraction', null)).toBe('falling 1.20 %/min')
    const highAlarm = pressureLimits[3]!
    expect(projectedMinutes(15.715, 0.31, highAlarm, true)).toBeCloseTo(0.919, 3)
    // Not projectable, moving away, or beyond half an hour: no time.
    expect(projectedMinutes(15.715, 0.31, highAlarm, false)).toBeNull()
    expect(projectedMinutes(15.715, -0.31, highAlarm, true)).toBeNull()
    expect(projectedMinutes(10, 0.1, highAlarm, true)).toBeNull()
    expect(trendPoints([
      { simulationTime: '2026-01-01T10:00:02.000Z', value: 2 },
      { simulationTime: '2026-01-01T10:00:01.000Z', value: 1 },
      { simulationTime: '2026-01-01T10:00:03.000Z', value: true },
      { value: 4 },
    ])).toEqual([{ t: Date.parse('2026-01-01T10:00:01.000Z'), v: 1 }, { t: Date.parse('2026-01-01T10:00:02.000Z'), v: 2 }])
  })

  test('the points within the look-back and the newest before them read as the whole history', () => {
    // As compose reads the Run's history: two small reads instead of the trend's whole window.
    const bounded = (points: ReadonlyArray<TrendPoint>, windowMs: number) => {
      const from = points.at(-1)!.t - readingLookBackMs(windowMs)
      return [...points.filter(point => point.t < from).slice(-1), ...points.filter(point => point.t >= from)]
    }
    const fixtures: ReadonlyArray<ReadonlyArray<TrendPoint>> = [
      seconds(600, second => 17 - second / 300),
      seconds(600, second => 14.9 + 0.9 * Math.exp(-second / 40)),
      // Held values re-recorded once a minute, then a fall in the last 40 s.
      [...seconds(560, () => 15.5).filter(point => point.t % 60_000 === 0), ...seconds(40, second => 15.5 - second * 0.02).map(point => ({ t: point.t + 560_000, v: point.v }))],
      // A gap: nothing between 100 s and 20 s before now.
      [...seconds(500, second => 16 - second / 600), ...seconds(20, second => 15 - second * 0.01).map(point => ({ t: point.t + 580_000, v: point.v }))],
      seconds(20, second => 15 + second * 0.01),
    ]
    for (const windowMs of [rateWindowMs(120_000), rateWindowMs(600_000)]) {
      for (const points of fixtures) {
        const value = points.at(-1)!.v
        expect(read(bounded(points, windowMs), value, { windowMs })).toEqual(read(points, value, { windowMs }))
      }
    }
  })
})
