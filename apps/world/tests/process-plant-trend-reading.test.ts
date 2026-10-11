import { describe, expect, test } from 'bun:test'
import type { ComposedDisplayThreshold } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { activeThreshold, limitStateText, projectedMinutes, rateChange, rateText, rateWindowMs, readingLookBackMs, readingStateText, travelOf, travelText, trendPoints, trendReading, type TrendPoint } from '../src/packs/process-plant/displays/trend-reading.ts'

// Pressurizer pressure limits as the reference PWR's I&C draws them.
const pressureLimits: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'pzr-trip-low', label: 'Pressurizer pressure low trip', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 13.8, order: 2, action: 'RX TRIP', modeLabel: 'Mode 1', modeNames: 'Power operation', modeIds: ['powerOperation'] },
  { ruleId: 'pzr-low', label: 'Pressurizer pressure low', kind: 'alarm', severity: 'warning', operator: '<', direction: 'low', value: 14.8, order: 1, action: 'ALM' },
  { ruleId: 'pzr-spray', label: 'Spray', kind: 'control', operator: '>', direction: 'high', value: 15.65, order: 1, action: 'CTL' },
  { ruleId: 'pzr-high', label: 'Pressurizer pressure high', kind: 'alarm', severity: 'warning', operator: '>', direction: 'high', value: 16, order: 1, action: 'ALM' },
]
// Steam generator narrow-range level limits: the AFW start acts in every mode, the reactor trip only in modes 1 and 2.
const levelLimits: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'sg-b-afw', label: 'Steam generator B low-low level', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 20, order: 2, action: 'AFW START' },
  { ruleId: 'sg-b-rx-trip', label: 'Reactor trip on steam generator B low-low level', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 20, order: 2, action: 'RX TRIP', modeLabel: 'Modes 1–2', modeNames: 'Power operation or Startup', modeIds: ['powerOperation', 'startup'] },
  { ruleId: 'sg-b-low', label: 'Steam generator B level low', kind: 'alarm', severity: 'warning', operator: '<', direction: 'low', value: 30, order: 1, action: 'ALM' },
  { ruleId: 'sg-b-high', label: 'Steam generator B level high', kind: 'alarm', severity: 'warning', operator: '>', direction: 'high', value: 75, order: 1, action: 'ALM' },
]
const powerOperation = { id: 'powerOperation', label: 'Power operation' }
const hotStandby = { id: 'hotStandby', label: 'Hot standby' }
const seconds = (count: number, value: (second: number) => number): ReadonlyArray<TrendPoint> =>
  Array.from({ length: count + 1 }, (_, second) => ({ t: second * 1000, v: value(second) }))
const read = (points: ReadonlyArray<TrendPoint> | null, value: number, extra: Partial<Parameters<typeof trendReading>[0]> = {}) =>
  trendReading({ value, points, windowMs: rateWindowMs(600_000), unit: 'MPa', thresholds: pressureLimits, mode: powerOperation, gates: () => undefined, activeRuleIds: new Set(), ...extra })
const readLevel = (points: ReadonlyArray<TrendPoint> | null, value: number, extra: Partial<Parameters<typeof trendReading>[0]> = {}) =>
  read(points, value, { unit: 'percent', thresholds: levelLimits, resolution: 0.1, span: { min: 0, max: 100 }, ...extra })

describe('how a trend reads now', () => {
  test('a falling pressure names the low alarm ahead of it, not the nearer high one behind it', () => {
    // Production: 15.458 MPa falling, 0.542 MPa below HI ALM 16 but heading for LO ALM 14.8.
    const falling = seconds(120, second => 17.458 - second / 60)
    const reading = read(falling, falling.at(-1)!.v)
    expect(reading.travel).toBe('falling')
    expect(reading.rate).toBeCloseTo(-1, 6)
    expect(reading.limit).toMatchObject({ kind: 'margin', margin: { threshold: { ruleId: 'pzr-low' } } })
    expect(limitStateText(reading.limit!, 'MPa')).toBe('0.658 MPa above LO 14.8 MPa · ALM · ≈39 s')
    expect(reading.limit?.kind === 'margin' ? reading.limit.minutes : null).toBeCloseTo(0.658, 3)
    expect(travelText(reading.rate, falling.at(-1)!.v, 'MPa', reading.change)).toBe('falling 1.00 MPa/min')
    // Beside the display, the rate names the window the legend reads it over.
    expect(travelText(reading.rate, falling.at(-1)!.v, 'MPa', reading.change, null, rateWindowMs(600_000))).toBe('falling 1.00 MPa/min over 30 s')
    // A fall the display shows in one step per half minute (one decimal at 15 MPa) gives no basis for a time.
    const slow = seconds(120, second => 15.858 - second * (0.4 / 120))
    expect(limitStateText(read(slow, slow.at(-1)!.v).limit!, 'MPa')).toBe('0.658 MPa above LO 14.8 MPa · ALM · approaching, not projected')
  })

  test('a margin is stated at the resolution its reading is shown in', () => {
    const falling = seconds(120, second => 17.458 - second / 60)
    expect(limitStateText(read(falling, falling.at(-1)!.v, { resolution: 0.016 }).limit!, 'MPa', 0.016)).toBe('0.66 MPa above LO 14.8 MPa · ALM · ≈39 s')
  })

  test('a row shown live only has no rate and names the nearest limit', () => {
    const reading = read(null, 15.458)
    expect([reading.rate, reading.travel, reading.change]).toEqual([null, null, null])
    expect(limitStateText(reading.limit!, 'MPa')).toBe('0.542 MPa below HI 16 MPa · ALM')
  })

  test('without history enough for a rate, the nearest limit either way, and no direction', () => {
    // The operations Historian re-records an unchanged value once a minute: one point in the window.
    const reading = read([{ t: 0, v: 15.458 }, { t: 60_000, v: 15.458 }], 15.458)
    expect(reading.travel).toBeNull()
    expect(limitStateText(reading.limit!, 'MPa')).toBe('0.542 MPa below HI 16 MPa · ALM')
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

  test('a curve flat at its end is slowing, and no time is projected from its steeper half-minute rate', () => {
    // Evaluation run 22, turbine trip: SG level fell at −21 %/min for 20 s, then held at 21.7 % for the last 10 s.
    // Its 30 s rate still read a fast fall, projected as "≈5 s to LO TRIP".
    const flattened = seconds(60, second => second <= 50 ? 39.2 - second * 0.35 : 21.7)
    const reading = readLevel(flattened, 21.7, { mode: powerOperation })
    expect(reading.travel).toBe('falling')
    expect(reading.rate! < -10).toBe(true)
    expect(reading.change).toBe('slowing')
    expect(reading.limit).toMatchObject({ kind: 'margin', margin: { threshold: { value: 20 } }, eta: 'approaching, not projected', minutes: null })
    expect(rateText(reading.rate, 21.7, 'percent', { windowMs: rateWindowMs(600_000), change: reading.change, resolution: 0.1 })).toMatch(/^▼ −[0-9.]+ %\/min · 30 s · slowing$/)
    // The same fall still going on at its end is projected.
    const going = seconds(60, second => 42.7 - second * 0.35)
    expect(rateChange(going, rateWindowMs(600_000), going.at(-1)!.v)).toBeNull()
    expect(readLevel(going, going.at(-1)!.v).limit).toMatchObject({ kind: 'margin', eta: '≈5 s' })
  })

  test('past a limit and moving back across it, it rises toward it, never "recovers"', () => {
    const rising = seconds(120, second => 12 + second * 0.02)
    const reading = read(rising, rising.at(-1)!.v, { activeRuleIds: new Set(['pzr-low']) })
    expect(reading.inAlarm?.ruleId).toBe('pzr-low')
    expect(reading.travel).toBe('rising')
    expect(limitStateText(reading.limit!, 'MPa')).toBe('past LO 14.8 MPa · ALM · rising, back above it in ≈20 s')
    // Evaluation run 22, PORV open: pressurizer level rising past its low alarm while the PORV discharges.
    const pzrLevel: ComposedDisplayThreshold = { ruleId: 'pzr-level-low', label: 'Pressurizer level low', kind: 'alarm', severity: 'warning', operator: '<', direction: 'low', value: 35, order: 1, action: 'ALM' }
    const swelling = seconds(60, second => second < 30 ? 22 : 22 + (second - 30) * 0.166 + (second % 2) * 0.3)
    const level = read(swelling, swelling.at(-1)!.v, { unit: 'percent', thresholds: [pzrLevel], resolution: 0.075 })
    const text = readingStateText(level, 'percent', 0.075)
    expect(text).toStartWith('past LO 35 % · ALM · rising, ')
    expect(text).not.toContain('recover')
  })

  test('past every limit on its way, it names the outermost it is past', () => {
    // Below both low limits and still falling: none ahead (porv-open), past the low-pressure trip.
    const reading = read(seconds(120, second => 5 - second * 0.005), 4.4, { activeRuleIds: new Set(['pzr-low', 'pzr-trip-low']) })
    expect(limitStateText(reading.limit!, 'MPa')).toBe('past LO-LO 13.8 MPa · RX TRIP (Mode 1)')
  })

  test('with no limit in force the way it moves, it says so plainly; held far from every limit, it names none', () => {
    // Fission power after a trip, with only its high alarm (3,600 MW) and a 0 to 4,500 MW hard range: a 4.5 MW resolution.
    const power: ComposedDisplayThreshold = { ruleId: 'power-high', label: 'Reactor power high', kind: 'alarm', severity: 'critical', operator: '>', direction: 'high', value: 3600, order: 1, action: 'ALM' }
    const falling = seconds(60, second => 600 - second * 5)
    expect(limitStateText(read(falling, falling.at(-1)!.v, { unit: 'MW', thresholds: [power], resolution: 4.5 }).limit!, 'MW', 4.5)).toBe('no LO limit in force')
    // Decayed below its resolution it reads 0 and holds: no direction, and the high alarm is no limit it is near.
    // Evaluation run 22's overview led with "0 MW · 3600 MW below HI ALM".
    const held = seconds(60, () => 0)
    const reading = read(held, 0, { unit: 'MW', thresholds: [power], resolution: 4.5 })
    expect(reading.travel).toBe('steady')
    expect(reading.limit).toBeNull()
    // Held near a limit, the margin to it is still stated.
    expect(limitStateText(read(seconds(60, () => 3500), 3500, { unit: 'MW', thresholds: [power], resolution: 4.5 }).limit!, 'MW', 4.5)).toBe('100 MW below HI 3600 MW · ALM')
  })

  test('a steam generator level at 0 % in hot standby is past its low-low limit, never "75 % below HI ALM"', () => {
    // Evaluation run 22, loss of main feedwater: SG B narrow-range level held at 0 % for 1.5 min.
    const held = seconds(90, () => 0)
    const reading = readLevel(held, 0, { mode: hotStandby, activeRuleIds: new Set(['sg-b-afw', 'sg-b-rx-trip', 'sg-b-low']) })
    expect(reading.offScale).toBe('below')
    expect(reading.rate).toBeNull()
    expect(readingStateText(reading, 'percent', 0.1)).toBe('below range · past LO-LO 20 % · AFW START')
    // The reactor trip latched at power does not act in hot standby: the chip names the AFW start.
    expect(reading.inAlarm?.ruleId).toBe('sg-b-afw')
    // With no low limit in force at all, it says so rather than naming the high alarm.
    const highOnly = levelLimits.filter(threshold => threshold.direction === 'high' || threshold.modeIds !== undefined)
    expect(readingStateText(readLevel(held, 0, { mode: hotStandby, thresholds: highOnly }), 'percent', 0.1)).toBe('below range · no LO limit in force')
  })

  test('a reading of exactly 0 on a signal with no declared span is a value', () => {
    const reading = read(seconds(60, () => 0), 0, { unit: 'percent', thresholds: levelLimits.filter(threshold => threshold.modeIds === undefined) })
    expect(reading.offScale).toBeNull()
    expect(reading.travel).toBe('steady')
    expect(readingStateText(reading, 'percent')).toBe('past LO-LO 20 % · AFW START')
  })

  test('limits that do not act in the current mode are never read against, nor colour a chip', () => {
    const onlyQualified = pressureLimits.filter(threshold => threshold.modeIds !== undefined)
    const reading = read(null, 12, { thresholds: onlyQualified, mode: hotStandby, activeRuleIds: new Set(['pzr-trip-low']) })
    expect(limitStateText(reading.limit!, 'MPa')).toBe('no limit acts in Hot standby')
    expect(reading.inAlarm).toBeNull()
    expect(limitStateText(read(null, 12, { thresholds: [] }).limit!, 'MPa')).toBe('no I&C limit')
    // The most severe limit in force with its rule active: trips before alarms.
    expect(activeThreshold(levelLimits, new Set(['sg-b-low', 'sg-b-afw', 'sg-b-rx-trip']), powerOperation, () => undefined)?.ruleId).toMatch(/^sg-b-(afw|rx-trip)$/)
    expect(activeThreshold(levelLimits, new Set(['sg-b-low', 'sg-b-rx-trip']), hotStandby, () => undefined)?.ruleId).toBe('sg-b-low')
  })

  test('direction, projected times and recorded pages', () => {
    expect([travelOf(null, 10), travelOf(0.001, 10), travelOf(0.5, 10), travelOf(-0.5, 10)]).toEqual([null, 'steady', 'rising', 'falling'])
    // A change of less than one resolution step a minute is steady: solver noise around zero.
    expect([travelOf(-3e-12, 0, 6.3e-5), travelOf(-3e-12, 0)]).toEqual(['steady', 'falling'])
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
