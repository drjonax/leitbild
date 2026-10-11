import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { ComposedDisplayThreshold } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { marginLimitName, marginTextForms, readingResolution, shownReading } from '../src/packs/process-plant/displays/display-text.ts'
import { icThresholdsForSignal } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { commandsForProcessPlantAction, compileProcessPlant, createProcessPlantProtectionRunner, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { activeThreshold, changeBesideState, limitStateText, projectedMinutes, rateChange, rateText, rateWindowMs, readingLookBackMs, readingStateText, travelOf, travelText, trendPoints, trendReading, type LimitState, type TrendPoint } from '../src/packs/process-plant/displays/trend-reading.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Pressurizer pressure limits as the reference PWR's I&C draws them.
const pressureLimits: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'pzr-trip-low', label: 'Pressurizer pressure low trip', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 13.8, order: 2, action: 'RX TRIP', reactorTrip: true, modeLabel: 'Mode 1', modeNames: 'Power operation', modeIds: ['powerOperation'] },
  { ruleId: 'pzr-low', label: 'Pressurizer pressure low', kind: 'alarm', severity: 'warning', operator: '<', direction: 'low', value: 14.8, order: 1, action: 'ALM' },
  { ruleId: 'pzr-spray', label: 'Spray', kind: 'control', operator: '>', direction: 'high', value: 15.65, order: 1, action: 'CTL' },
  { ruleId: 'pzr-high', label: 'Pressurizer pressure high', kind: 'alarm', severity: 'warning', operator: '>', direction: 'high', value: 16, order: 1, action: 'ALM' },
]
// Steam generator narrow-range level limits: the AFW start acts in every mode, the reactor trip only in modes 1 and 2.
const levelLimits: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'sg-b-afw', label: 'Steam generator B low-low level', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 20, order: 2, action: 'AFW START' },
  { ruleId: 'sg-b-rx-trip', label: 'Reactor trip on steam generator B low-low level', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 20, order: 2, action: 'RX TRIP', reactorTrip: true, modeLabel: 'Modes 1–2', modeNames: 'Power operation or Startup', modeIds: ['powerOperation', 'startup'] },
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

  test('a tendency without a basis for a time says why in the display\'s words', () => {
    // Bending over: falling fast, then slowing.
    const bending = seconds(120, second => 14.9 + 0.9 * Math.exp(-second / 40))
    const reading = read(bending, bending.at(-1)!.v)
    expect(reading.travel).toBe('falling')
    expect(reading.change).toBe('slowing')
    expect(reading.limit).toMatchObject({ kind: 'margin', eta: 'slowing', minutes: null })
    expect(limitStateText(reading.limit!, 'MPa')).toMatch(/^0\.[0-9]+ MPa above LO 14\.8 MPa · ALM · slowing$/)
    // The legend's rate does not say it twice beside its limit state; without one it does.
    expect(changeBesideState(reading)).toBeNull()
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
    expect(reading.limit).toMatchObject({ kind: 'margin', margin: { threshold: { value: 20 } }, eta: 'slowing', minutes: null })
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
    // Turned only just: no time back across it, and never "rising, reversing" (QA review of run 22's PT-455 after the RCP trip).
    const turned = seconds(120, second => second < 100 ? 14.6 - second * 0.008 : 13.8 + (second - 100) * 0.01)
    expect(readingStateText(read(turned, turned.at(-1)!.v), 'MPa')).toBe('past LO 14.8 MPa · ALM · rising, just reversed')
  })

  test('a margin names every action at the limit it names, the most severe first', () => {
    // QA review, loss of main feedwater at 50 s: "8.7 % above LO-LO 20 % · AFW START", though the reactor trips at the same 20 %.
    const falling = seconds(60, second => 50 - second * 0.36)
    const reading = readLevel(falling, falling.at(-1)!.v, { mode: powerOperation })
    expect(reading.limit).toMatchObject({ kind: 'margin', margin: { threshold: { ruleId: 'sg-b-rx-trip' }, alongside: [{ ruleId: 'sg-b-afw' }] } })
    const margin = (reading.limit as Extract<LimitState, { kind: 'margin' }>).margin
    expect(marginTextForms(margin, 'percent', 0.1)).toEqual([
      '8.4 percentage points above LO-LO 20 % · RX TRIP (Modes 1–2) + AFW START',
      '8.4 percentage points above LO-LO 20 % · RX TRIP + AFW START',
      '8.4 pp above LO-LO 20 · RX TRIP + AFW START',
      '8.4 pp above LO-LO · RX TRIP + AFW START',
    ])
    // As an answer cites it: order and value first.
    expect(marginLimitName(margin, 'percent')).toBe('LO-LO 20 % · RX TRIP + AFW START')
    // In hot standby the reactor trip does not act: the margin names the AFW start alone.
    expect(limitStateText(readLevel(falling, falling.at(-1)!.v, { mode: hotStandby }).limit!, 'percent', 0.1)).toStartWith('8.4 percentage points above LO-LO 20 % · AFW START')
    // Past it, both are named too.
    expect(readingStateText(readLevel(seconds(90, () => 0), 0, { mode: powerOperation }), 'percent', 0.1)).toBe('below range · past LO-LO 20 % · RX TRIP (Modes 1–2) + AFW START')
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
    // Of trips acting together, the reactor trip is named first.
    expect(activeThreshold(levelLimits, new Set(['sg-b-low', 'sg-b-afw', 'sg-b-rx-trip']), powerOperation, () => undefined)?.ruleId).toBe('sg-b-rx-trip')
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

// The QA review's cases on the four-loop reference plant, driven as its probe
// drove them: the fault at the Run's start, then 1 s ticks with protection.
const qaCase = (actionId: string, seconds: number, tags: ReadonlyArray<string>) => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:trend-reading-qa', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  const protection = createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation })
  const bindings = tags.map(tag => compiled.graph.signalBindingByTagId.get(tag as never)!)
  const trace = new Map(bindings.map(binding => [binding, [{ t: 0, v: runtime.readVariable(binding.path) as number }]]))
  for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: compiled.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  for (let second = 1; second <= seconds; second += 1) {
    runtime.tick(1000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-trend-reading-qa' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    for (const binding of bindings) trace.get(binding)!.push({ t: second * 1000, v: runtime.readVariable(binding.path) as number })
  }
  // A reading at a second, over a horizon's window, as every display reads it.
  return (tag: string, at: number, horizonMs: number, mode: { readonly id: string; readonly label: string }) => {
    const binding = bindings.find(candidate => candidate.tagId === tag)!
    const thresholds = icThresholdsForSignal(compiled, binding.path).thresholds
    const resolution = readingResolution(binding.limits, thresholds)
    const points = trace.get(binding)!.slice(0, at + 1).map(point => ({ t: point.t, v: shownReading(point.v, resolution) }))
    const reading = trendReading({ value: points.at(-1)!.v, points, windowMs: rateWindowMs(horizonMs), unit: binding.unit, thresholds, mode, gates: () => undefined, activeRuleIds: new Set(), resolution, ...(binding.limits?.instrumentSpan === undefined ? {} : { span: binding.limits.instrumentSpan }) })
    return { reading, text: readingStateText(reading, binding.unit, resolution), trace: trace.get(binding)! }
  }
}

describe('a time to a limit only from an established trend (QA review cases)', () => {
  test('a minute after every RCP tripped, subcooling and pressurizer level are turning: no time on any display', () => {
    // QA: the 2-minute trend said "≈4 min" and the overview "≈6 min" to LO 16.7 °C; subcooling bottoms near 32.8 °C.
    const read = qaCase('trip-reactor-coolant-pumps', 300, ['SUB-MARGIN', 'PZR-LVL'])
    for (const horizonMs of [120_000, 600_000]) {
      const subcooling = read('SUB-MARGIN', 60, horizonMs, hotStandby)
      expect(subcooling.reading.limit).toMatchObject({ kind: 'margin', margin: { threshold: { value: 16.7 } }, eta: 'reversing', minutes: null })
      expect(subcooling.text).toBe('21.6 °C above LO 16.7 °C · ALM · reversing')
      const level = read('PZR-LVL', 60, horizonMs, hotStandby)
      expect(level.reading.limit).toMatchObject({ kind: 'margin', margin: { threshold: { value: 75 } }, minutes: null })
    }
    // Never a time while it bends over toward its bottom, and the model never reaches the limit.
    for (const at of [90, 120, 180, 240]) expect(read('SUB-MARGIN', at, 120_000, hotStandby).reading.limit).toMatchObject({ minutes: null })
    expect(Math.min(...read('SUB-MARGIN', 300, 120_000, hotStandby).trace.filter(point => point.t >= 60_000).map(point => point.v))).toBeGreaterThan(32)
  })

  test('fifty seconds after main feedwater is lost, the steam generator level is projected to its low-low limit, which it reaches', () => {
    const read = qaCase('loss-main-feedwater', 80, ['SG-A-LVL-NR'])
    for (const horizonMs of [120_000, 600_000]) {
      const level = read('SG-A-LVL-NR', 50, horizonMs, powerOperation)
      expect(level.text).toBe('8.7 percentage points above LO-LO 20 % · RX TRIP (Modes 1–2) + AFW START · ≈15 s')
      expect((level.reading.limit as Extract<LimitState, { kind: 'margin' }>).minutes! * 60).toBeCloseTo(14.7, 0)
    }
    // It does, 15 s later.
    const crossed = read('SG-A-LVL-NR', 80, 120_000, powerOperation).trace.find(point => point.v < 20)!
    expect(crossed.t / 1000).toBe(65)
  })
})
