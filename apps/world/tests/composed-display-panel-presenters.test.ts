import { describe, expect, test } from 'bun:test'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'
import { fitName } from '../src/ui/embed/composed-display/pen-style.ts'
import { distinguishingNames, idleText, joinedName, limitLabelParts, limitLabelRanks, limitLines, limitLook, limitSeverity, mergedText, stackLabels, TREND_GUTTER, trendGutter } from '../src/ui/embed/composed-display/limit-labels.ts'
import { actuatedNames, agoText, alarmAge, bannerTrip, firstOutFlag, fitLimitStateText, limitStateForms, median, visibleAlarms, annunciatorStates, tileActions } from '../src/ui/embed/composed-display/panel-presenters.ts'
import { activeThreshold, gatesHold, limitAhead, limitInForce, limitsInForce, projectionBasis, minutesToThreshold, rateChange, ratePerMinute, rateText, rateWindowMs, timeToThresholdText, type LimitState } from '../src/packs/process-plant/displays/trend-reading.ts'
import { coincidentMargin, limitKindName, marginLimitName, marginText, marginTextForms, marginTo, nearestThresholdMargin, simulationClock, thresholdFullName, thresholdName } from '../src/packs/process-plant/displays/display-text.ts'
import { formatQuantity, formatValue, readingResolution, readingText, shownReading, unitLabel } from '../src/packs/process-plant/quantity-text.ts'
import { modesShortText, orderLimits, type ComposedDisplayThreshold } from '../src/packs/process-plant/ic/thresholds.ts'
import type { ComposedDisplayAlarm } from '../src/ui/embed/composed-display/composed-display-client.ts'

/** No on/off state read yet: every gated limit is kept. */
const noGates = () => undefined

const thresholds: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'trip-low', label: 'Low-low', kind: 'trip', operator: '<', direction: 'low', value: 20, order: 2, action: 'RX TRIP' },
  { ruleId: 'alarm-low', label: 'Low', kind: 'alarm', operator: '<', direction: 'low', value: 30, order: 1, action: 'ALM' },
  { ruleId: 'control', label: 'Demand', kind: 'control', operator: '<', direction: 'low', value: 50, order: 1, action: 'CTL' },
  { ruleId: 'alarm-high', label: 'High', kind: 'alarm', operator: '>', direction: 'high', value: 75, order: 1, action: 'ALM', modeLabel: 'Mode 1', modeNames: 'Power operation', modeIds: ['powerOperation'] },
]

describe('composed display panel presenters', () => {
  test('margin to the nearest acting alarm or trip threshold, ignoring control set points', () => {
    const near = nearestThresholdMargin(34.5, thresholds)!
    expect([near.threshold.ruleId, near.margin]).toEqual(['alarm-low', 4.5])
    expect(marginText(near, '%')).toBe('4.50 percentage points above LO 30 % · ALM')
    const beyond = nearestThresholdMargin(26.9, thresholds)!
    expect(marginText(beyond, '%')).toBe('past LO 30 % · ALM')
    // Past both, the trip is what it says.
    expect(marginText(nearestThresholdMargin(19.5, thresholds)!, '%')).toBe('past LO-LO 20 % · RX TRIP')
    expect(marginText(nearestThresholdMargin(70, thresholds)!, '%')).toBe('5.00 percentage points below HI 75 % · ALM (Mode 1)')
    expect(thresholdName(thresholds[0]!, 'MPa')).toBe('LO-LO 20 MPa · RX TRIP')
    expect(thresholdName(thresholds[0]!, 'MPa', { withUnit: false })).toBe('LO-LO 20 · RX TRIP')
    expect(thresholdFullName(thresholds[3]!, '%')).toBe('HI 75 % · ALM (Mode 1)')
    expect(nearestThresholdMargin(10, [thresholds[2]!])).toBeNull()
  })

  test('limits order away from normal whatever each does, never by signal', () => {
    const limit = (ruleId: string, kind: 'alarm' | 'trip', direction: 'low' | 'high', value: number, action: string, modeIds?: ReadonlyArray<string>) =>
      ({ ruleId, label: ruleId, kind, action, operator: direction === 'low' ? '<' : '>', direction, value, ...(modeIds === undefined ? {} : { modeLabel: modeIds.join(' or '), modeIds }) }) as const
    const names = (limits: Parameters<typeof orderLimits>[0]) => orderLimits(limits).map(threshold => thresholdName(threshold, 'degC'))
    // Subcooling: a warning at 16.7 °C and a critical alarm at 0 °C, both alarms below normal.
    expect(names([limit('lost', 'alarm', 'low', 0, 'ALM'), limit('low', 'alarm', 'low', 16.7, 'ALM')])).toEqual(['LO-LO 0 °C · ALM', 'LO 16.7 °C · ALM'])
    // Steam generator level: the alarm at 30 is LO, and both actuations at 20 beyond it are LO-LO, each named by what it does.
    expect(names([limit('afw', 'trip', 'low', 20, 'AFW START'), limit('rx', 'trip', 'low', 20, 'RX TRIP', ['powerOperation', 'startup']), limit('alarm', 'alarm', 'low', 30, 'ALM'), limit('high', 'alarm', 'high', 75, 'ALM'), limit('higher', 'trip', 'high', 82, 'FWI')]))
      .toEqual(['LO-LO 20 °C · AFW START', 'LO-LO 20 °C · RX TRIP', 'LO 30 °C · ALM', 'HI 75 °C · ALM', 'HI-HI 82 °C · FWI'])
    // A limit in every mode and one only in power operation act together; limits of two different modes are alternatives.
    expect(names([limit('relief', 'trip', 'high', 16.18, 'PORV'), limit('reactor', 'trip', 'high', 16.35, 'RX TRIP', ['powerOperation'])])).toEqual(['HI 16.18 °C · PORV', 'HI-HI 16.35 °C · RX TRIP'])
    expect(names([limit('startup', 'alarm', 'low', 20, 'ALM', ['startup']), limit('power', 'alarm', 'low', 30, 'ALM', ['powerOperation'])])).toEqual(['LO 20 °C · ALM', 'LO 30 °C · ALM'])
    // Two rules at one value are one step; each value beyond is the next step, written with its count past the second (HMI review of run 23: two different limits both read LO-LO).
    expect(names([limit('a', 'alarm', 'low', 10, 'ALM'), limit('b', 'alarm', 'low', 10, 'ALM'), limit('c', 'alarm', 'low', 5, 'ALM'), limit('d', 'trip', 'low', 2, 'SI'), limit('e', 'trip', 'low', 1, 'CS')]))
      .toEqual(['LO 10 °C · ALM', 'LO 10 °C · ALM', 'LO-LO 5 °C · ALM', 'LO-3 2 °C · SI', 'LO-4 1 °C · CS'])
    // A limit gated by other conditions is a step beyond the limits nearer normal (the pressurizer's blocked SI beyond the trip),
    // but never one before the limits its value alone decides (a level alarm that needs low feed flow too).
    const gated = <T extends ReturnType<typeof limit>>(threshold: T) => ({ ...threshold, gatedBy: ['FLOW < 150 kg/s'], gates: [{ path: 'sg.flow' as never, operator: '<' as const, value: 150 }] })
    expect(names([limit('alarm', 'alarm', 'low', 14.8, 'ALM'), limit('trip', 'trip', 'low', 13.8, 'RX TRIP', ['powerOperation']), gated(limit('si', 'trip', 'low', 12.7, 'SI', ['powerOperation', 'hotStandby']))]))
      .toEqual(['LO 14.8 °C · ALM', 'LO-LO 13.8 °C · RX TRIP', 'LO-3 12.7 °C · SI'])
    expect(names([gated(limit('feed', 'alarm', 'low', 40, 'ALM')), limit('alarm', 'alarm', 'low', 30, 'ALM'), limit('trip', 'trip', 'low', 20, 'RX TRIP')]))
      .toEqual(['LO 40 °C · ALM', 'LO 30 °C · ALM', 'LO-LO 20 °C · RX TRIP'])
    expect(limitKindName({ direction: 'high', order: 2, action: 'FWI' })).toBe('HI-HI · FWI')
    expect(limitKindName({ direction: 'low', order: 1, action: 'ALM' })).toBe('LO · ALM')
  })

  test('the modes a limit acts in are named by their short labels, a run of them as a range', () => {
    const condition = { type: 'comparison', signal: { path: 'core.powerMw' }, operator: '>', value: 1 } as never
    const modes = ['Power operation', 'Startup', 'Hot standby', 'Hot shutdown', 'Cold shutdown'].map((label, index) => ({ id: `m${index + 1}`, label, shortLabel: String(index + 1), condition }))
    expect(modesShortText(modes, ['m1', 'm2'])).toBe('Modes 1–2')
    expect(modesShortText(modes, ['m1', 'm2', 'm3'])).toBe('Modes 1–3')
    expect(modesShortText(modes, ['m3'])).toBe('Mode 3')
    expect(modesShortText(modes, ['m3', 'm1'])).toBe('Modes 1, 3')
    // A mode without a short label is named by its label.
    expect(modesShortText([{ id: 'run', label: 'Running', condition }, ...modes], ['run', 'm1'])).toBe('Running or Power operation')
  })

  test('a margin fitted to its room drops whole parts, the time and mode qualifier first, never cutting a word', () => {
    // Primary inventory net flow on the overview: 0 kg/s against the power-operation-only LO-LO -250 kg/s trip.
    const netFlowTrip = { ruleId: 'net-flow', label: 'Primary inventory loss trip', kind: 'trip', operator: '<', direction: 'low', value: -250, order: 1, action: 'RX TRIP', modeLabel: 'Mode 1', modeNames: 'Power operation', modeIds: ['powerOperation'] } as const
    const margin = { threshold: netFlowTrip, margin: 250 }
    expect(marginTextForms(margin, 'kg/s')).toEqual([
      '250 kg/s above LO -250 kg/s · RX TRIP (Mode 1)',
      '250 kg/s above LO -250 kg/s · RX TRIP',
      '250 kg/s above LO -250 · RX TRIP',
      '250 kg/s above LO · RX TRIP',
    ])
    expect(marginText(margin, 'kg/s')).toBe('250 kg/s above LO -250 kg/s · RX TRIP (Mode 1)')
    const within = (length: number) => (text: string) => text.length <= length
    const state: LimitState = { kind: 'margin', margin, eta: '≈4 min', minutes: 4 }
    expect(limitStateForms(state, 'kg/s', null)[0]).toBe('250 kg/s above LO -250 kg/s · RX TRIP (Mode 1) · ≈4 min')
    expect(fitLimitStateText(state, 'kg/s', null, within(48))).toBe('250 kg/s above LO -250 kg/s · RX TRIP (Mode 1)')
    expect(fitLimitStateText(state, 'kg/s', null, within(38))).toBe('250 kg/s above LO -250 kg/s · RX TRIP')
    // Too narrow for any: the shortest, which still says how far and from which limit.
    expect(fitLimitStateText(state, 'kg/s', null, within(10))).toBe('250 kg/s above LO · RX TRIP')
    expect(marginTextForms({ threshold: netFlowTrip, margin: -5 }, 'kg/s')).toEqual(['past LO -250 kg/s · RX TRIP (Mode 1)', 'past LO -250 kg/s · RX TRIP', 'past LO -250 · RX TRIP', 'past LO · RX TRIP'])
    // A unitless limit without modes has fewer forms, none repeated.
    expect(marginTextForms({ threshold: { ...thresholds[1]!, value: 0.5 }, margin: 0.25 }, 'boolean')).toEqual(['0.250 above LO 0.5 · ALM', '0.250 above LO · ALM'])
    // With nothing in force the way it moves, a single form.
    expect(limitStateForms({ kind: 'clear', direction: 'low' }, '%', null)).toEqual(['no LO limit in force'])
    // Two alarms at one limit name it once (HMI review of run 25, sg-a-tube-leak: "past HI 0.063 kg/s · ALM + ALM");
    // an action one of them does in every mode names no mode, one only some do keeps its own.
    const leak = { ruleId: 'leak-high', label: 'RCS leak rate high', kind: 'alarm', operator: '>', direction: 'high', value: 0.063, order: 1, action: 'ALM' } as const
    const together = coincidentMargin(marginTo(0.07, leak), [leak, { ...leak, ruleId: 'tube-leak', modeLabel: 'Mode 1' }])
    expect(marginText(together, 'kg/s')).toBe('past HI 0.063 kg/s · ALM')
    expect(marginLimitName(together, 'kg/s')).toBe('HI 0.063 kg/s · ALM')
    const tripAndAfw = coincidentMargin(marginTo(25, thresholds[0]!), [thresholds[0]!, { ...thresholds[0]!, ruleId: 'afw', kind: 'trip', action: 'AFW START', modeLabel: 'Modes 1–3' }, { ...thresholds[0]!, ruleId: 'trip-b', modeLabel: 'Mode 1' }])
    expect(marginText(tripAndAfw, '%')).toBe('5.00 percentage points above LO-LO 20 % · RX TRIP + AFW START (Modes 1–3)')
  })

  test('a value on a limit that acts at equality is past it', () => {
    // Subcooling at exactly 0 °C: LO-LO ALM acts at "<= 0", so it leads, not the 16.7 °C alarm.
    const subcooling = [
      { ruleId: 'margin-low', label: 'RCS subcooling margin low', kind: 'alarm', operator: '<', direction: 'low', value: 16.7, order: 1, action: 'ALM' },
      { ruleId: 'margin-lost', label: 'RCS subcooling lost', kind: 'alarm', operator: '<=', direction: 'low', value: 0, order: 2, action: 'ALM' },
    ] as const
    const margin = nearestThresholdMargin(0, subcooling)!
    expect(margin.threshold.ruleId).toBe('margin-lost')
    expect(marginText(margin, 'degC')).toBe('past LO-LO 0 °C · ALM')
    // On a limit that acts only beyond it, the value is not past it yet.
    expect(nearestThresholdMargin(16.7, subcooling)!.threshold.ruleId).toBe('margin-low')
    expect(marginText(nearestThresholdMargin(16.7, subcooling)!, 'degC')).not.toMatch(/^past/)
  })

  test('fractions read as percent wherever the display or the answer names them', () => {
    const busLow = { ruleId: 'bus-low', label: 'Bus voltage low', kind: 'alarm', operator: '<', direction: 'low', value: 0.9, order: 1, action: 'ALM' } as const
    expect(formatQuantity(1, 'fraction')).toBe('100 %')
    expect(formatQuantity(0.955, 'fraction')).toBe('95.5 %')
    expect(formatQuantity(0, 'kg/s')).toBe('0 kg/s')
    expect(formatQuantity(125, 'volts_dc')).toBe('125 V DC')
    expect(unitLabel('degC/s')).toBe('°C/s')
    expect(thresholdName(busLow, 'fraction')).toBe('LO 90 % · ALM')
    expect(marginText(nearestThresholdMargin(0.955, [busLow])!, 'fraction')).toBe('5.50 percentage points above LO 90 % · ALM')
    expect(rateText(-0.012, 0.955, 'fraction')).toBe('▼ −1.20 %/min')
    expect(unitLabel('fraction')).toBe('%')
  })

  test('the limit ahead follows the direction of travel, also while in alarm', () => {
    // SG B in LO ALM 30, falling: the next limit is LO-LO 20, not the alarm it has passed.
    expect(limitAhead(28, 'falling', thresholds)?.threshold.ruleId).toBe('trip-low')
    // Rising: past LO ALM 30, it is the limit it moves back across first.
    expect(limitAhead(28, 'rising', thresholds)?.threshold.ruleId).toBe('alarm-low')
    // Rising away from the low limits toward HI ALM 75.
    expect(limitAhead(60, 'rising', thresholds)?.threshold.ruleId).toBe('alarm-high')
    // Rising with no high limit configured: none ahead.
    const lowOnly = thresholds.filter(threshold => threshold.direction === 'low')
    expect(limitAhead(72, 'rising', lowOnly)).toBeNull()
  })

  test('a value in alarm that is moving back is timed back across the limit, never said to recover', () => {
    // SG A N-16 in HI ALM 5 mSv/h and drifting down.
    const highRadiation = { ruleId: 'n16-high', label: 'Secondary radiation high', kind: 'alarm', operator: '>', direction: 'high', value: 5, order: 1, action: 'ALM' } as const
    expect(timeToThresholdText(5.4, -0.2, highRadiation, true, true)).toBe('≈2 min')
    expect(timeToThresholdText(5.4, 0.2, highRadiation, true, true)).toBe('')
    expect(timeToThresholdText(5.4, -0.01, highRadiation, true, true)).toBe('')
    expect(minutesToThreshold(5.4, -0.2, highRadiation, true)).toBeCloseTo(2, 6)
    // Not past it, there is nothing to come back across.
    expect(minutesToThreshold(4.6, 0.2, highRadiation, true)).toBeNull()
  })

  test('a time to a limit is projected only from half a minute of change one way that is not slowing', () => {
    const window = rateWindowMs(120_000)
    const series = (seconds: number, value: (second: number) => number) => Array.from({ length: seconds + 1 }, (_, second) => ({ t: second * 1000, v: value(second) }))
    // Pressure recovering steadily at 0.3 MPa/min for two minutes.
    expect(projectionBasis(series(120, second => 4 + second * 0.005), window, 'MPa')).toBe(true)
    // Subcooling with the PORV stuck open: rising fast, then bending over (porv-open).
    const bending = series(120, second => -45.6 - 30 * Math.exp(-second / 25))
    expect(rateChange(bending, window, bending.at(-1)!.v)).toBe('slowing')
    expect(projectionBasis(bending, window, 'degC')).toBe(false)
    // A drift the display hardly shows: 5.40 to 5.38 mSv/h in half a minute (sg-a-tube-leak).
    expect(projectionBasis(series(120, second => 5.45 - second * 0.00065), window, 'mSv/h')).toBe(false)
    // Twenty seconds of history are not half a minute.
    expect(projectionBasis(series(20, second => 4 + second * 0.005), window, 'MPa')).toBe(false)
    // A step back inside the half minute: the rate has not kept its sign.
    expect(projectionBasis(series(120, second => 4 + second * 0.005 - (second === 110 ? 0.03 : 0)), window, 'MPa')).toBe(false)
    // Steady: nothing to project.
    expect(projectionBasis(series(120, () => 4), window, 'MPa')).toBe(false)
    expect(projectionBasis([], window, 'MPa')).toBe(false)
  })

  test('long names drop whole words, never cutting through one', () => {
    // Whole words only: the equipment's leading words go first, keeping what tells parallel equipment apart, then the quantity's middle words.
    const within = (length: number) => (text: string) => text.length <= length
    expect(fitName('Process valve position · Feedwater Control Valve B', within(60))).toBe('Process valve position · Feedwater Control Valve B')
    expect(fitName('Process valve position · Feedwater Control Valve B', within(40))).toBe('Process valve position · …Valve B')
    expect(fitName('Core heat removal deficit · Reactor Core', within(26))).toBe('Core … deficit · …Core')
    expect(fitName('Auxiliary feedwater to steam generator A temperature', within(40))).toBe('Auxiliary … generator A temperature')
    expect(fitName('PT-455', within(3))).toBe('PT-455')
    // A name without equipment that fits stays whole.
    expect(fitName('Pressurizer relief flow', within(40))).toBe('Pressurizer relief flow')
    expect(fitName('Pressurizer relief flow', within(20))).toBe('Pressurizer … flow')
    // The forms World derives come first: the equipment by its short name, the words its signals share dropped.
    const header = ['Process header outlet flow · SI header', 'Outlet flow · SI header']
    expect(fitName('Process header outlet flow · Safety Injection Header', within(40), header)).toBe('Process header outlet flow · SI header')
    expect(fitName('Process header outlet flow · Safety Injection Header', within(30), header)).toBe('Outlet flow · SI header')
  })

  test('median of parallel signals', () => {
    expect(median([4250, 4250, 3100, 4250])).toBe(4250)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  test('alarms read first-out first, then trips, then by severity, then active before cleared, then by onset', () => {
    const alarms: ReadonlyArray<ComposedDisplayAlarm> = [
      { id: 'a', ruleId: 'sg-b-level-low', kind: 'alarm', title: 'SG B level low', severity: 'warning', active: true, acknowledged: true, latched: false, conditionActive: true, firstOut: false, firstActiveElapsedMs: 100_000 },
      { id: 'b', ruleId: 'sg-b-level-low-low', kind: 'trip', title: 'SG B low-low', severity: 'critical', active: true, acknowledged: false, latched: false, conditionActive: true, firstOut: true, firstActiveElapsedMs: 200_000 },
      { id: 'c', ruleId: 'other', kind: 'alarm', title: 'Other', severity: 'critical', active: true, acknowledged: false, latched: false, conditionActive: true, firstOut: false },
      { id: 'd', ruleId: 'sg-b-feedwater-low', kind: 'alarm', title: 'SG B feed low', severity: 'warning', active: true, acknowledged: false, latched: false, conditionActive: true, firstOut: false, firstActiveElapsedMs: 50_000 },
    ]
    // First-out groups name what an alarm row annunciates, by its id.
    const groups = { firstOutGroups: { b: 'RX TRIP', 'sg-c-level-low-low': 'RX TRIP' } }
    expect(visibleAlarms(alarms, 'related', ['sg-b-level-low', 'sg-b-level-low-low', 'sg-b-feedwater-low'], groups).map(alarm => alarm.id)).toEqual(['b', 'd', 'a'])
    const plant: ReadonlyArray<ComposedDisplayAlarm> = [
      { id: 'cleared', ruleId: 'r1', kind: 'alarm', title: 'Cleared', severity: 'critical', active: false, acknowledged: false, latched: false, conditionActive: true, firstOut: false, firstActiveElapsedMs: 1_000 },
      { id: 'critical', ruleId: 'r2', kind: 'alarm', title: 'Critical', severity: 'critical', active: true, acknowledged: true, latched: false, conditionActive: true, firstOut: false, firstActiveElapsedMs: 2_000 },
      { id: 'trip', ruleId: 'r3', kind: 'trip', title: 'Trip', severity: 'warning', active: true, acknowledged: true, latched: false, conditionActive: true, firstOut: false, firstActiveElapsedMs: 3_000 },
    ]
    expect(visibleAlarms(plant, 'plant', [], groups).map(alarm => alarm.id)).toEqual(['trip', 'critical', 'cleared'])
    expect(visibleAlarms(alarms, 'plant', [], groups).map(alarm => alarm.id)).toEqual(['b', 'c', 'd', 'a'])
    // First out of a group of one says nothing: it is not read first.
    const flagged = alarms.map(alarm => alarm.id === 'a' ? { ...alarm, firstOut: true } : alarm)
    expect(visibleAlarms(flagged, 'plant', [], { firstOutGroups: {} }).map(alarm => alarm.id)).toEqual(['b', 'c', 'd', 'a'])
    expect(visibleAlarms(flagged, 'plant', [], { firstOutGroups: { a: 'SG LO' } }).map(alarm => alarm.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('the banner leads with the reactor trip\'s first-out, and lists the other actuations apart from it', () => {
    // Evaluation run 22, loss of main feedwater: the AFW start came in first; the reactor tripped on SG B low-low level.
    // An alarm row's id is the trip it annunciates, of its rule.
    const trip = (title: string, ruleId: string, effectId: string, at: number, firstOut: boolean): ComposedDisplayAlarm =>
      ({ id: `trip:${ruleId}:${effectId}`, ruleId, kind: 'trip', title, severity: 'critical', active: true, acknowledged: false, latched: false, conditionActive: true, firstOut, firstActiveElapsedMs: at })
    const alarms = [
      trip('Steam generator B low-low level', 'sg-b-afw', 'afw', 60_000, false),
      trip('Auxiliary feedwater start on main feedwater pump trip', 'mfw-afw', 'afw', 3_000, false),
      trip('Reactor trip on steam generator B low-low level', 'sg-b-rx-trip', 'reactor-trip', 61_000, true),
      trip('Feedwater isolation on reactor trip, low Tavg', 'fwi', 'fwi', 75_000, false),
      { ...trip('Safety injection actuated', 'si', 'safety-injection', 90_000, true), active: false },
      { ...trip('Reactor trip on safety injection, low pressurizer pressure', 'si', 'reactor-trip', 90_000, false), active: false },
    ]
    // Safety injection annunciates its own trip in SI's group and the reactor trip it causes in the reactor trip's.
    const annunciation = {
      reactorTrip: { name: 'RX TRIP', ids: ['trip:sg-a-rx-trip:reactor-trip', 'trip:sg-b-rx-trip:reactor-trip', 'trip:otdt:reactor-trip', 'trip:si:reactor-trip'] },
      actuations: [
        { name: 'AFW START', ids: ['trip:sg-a-afw:afw', 'trip:sg-b-afw:afw', 'trip:mfw-afw:afw'] },
        { name: 'SI', ids: ['trip:si:safety-injection'] },
        { name: 'FWI', ids: ['trip:fwi:fwi'] },
      ],
      firstOutGroups: { 'trip:sg-a-rx-trip:reactor-trip': 'RX TRIP', 'trip:sg-b-rx-trip:reactor-trip': 'RX TRIP', 'trip:otdt:reactor-trip': 'RX TRIP', 'trip:si:reactor-trip': 'RX TRIP' },
    }
    expect(bannerTrip(alarms, annunciation)?.title).toBe('Reactor trip on steam generator B low-low level')
    expect(actuatedNames(alarms, annunciation)).toEqual(['AFW START', 'FWI'])
    // Without a reactor trip, nothing leads the banner; the actuations still show.
    expect(bannerTrip(alarms.filter(alarm => alarm.ruleId !== 'sg-b-rx-trip'), annunciation)).toBeUndefined()
    // First out names its group, and only where the group has more than one member.
    expect(firstOutFlag(alarms[2]!, annunciation)).toBe('1st RX TRIP')
    expect(firstOutFlag({ id: 'trip:si:safety-injection', firstOut: true }, annunciation)).toBeNull()
    // A pressurizer that falls to its SI set point first: the reactor trip safety injection causes leads the banner
    // as the reactor trip's first-out, and SI is listed as actuated beside it.
    const depressurized = [
      trip('Safety injection actuated', 'si', 'safety-injection', 40_000, true),
      trip('Reactor trip on safety injection, low pressurizer pressure', 'si', 'reactor-trip', 40_000, true),
      trip('Reactor trip on overtemperature delta-T', 'otdt', 'reactor-trip', 41_000, false),
    ]
    const banner = bannerTrip(depressurized, annunciation)!
    expect(banner.title).toBe('Reactor trip on safety injection, low pressurizer pressure')
    expect(firstOutFlag(banner, annunciation)).toBe('1st RX TRIP')
    expect(actuatedNames(depressurized, annunciation)).toEqual(['SI'])
  })

  test('alarm age in Plant time', () => {
    expect(alarmAge(130_000, 100_000)).toBe('0:30')
    expect(alarmAge(700_000, 100_000)).toBe('10:00')
    expect(alarmAge(4_000_000, 100_000)).toBe('1 h 05')
    expect(alarmAge(700_000, undefined)).toBe('')
    expect(agoText(23_400)).toBe('23 s ago')
    expect(agoText(250_000)).toBe('4 min ago')
  })

  test('rate, direction and time to threshold at the current rate', () => {
    const falling = Array.from({ length: 61 }, (_, index) => ({ t: index * 1000, v: 40 - index * 0.03 }))
    const rate = ratePerMinute(falling, 60_000)!
    expect(rate).toBeCloseTo(-1.8, 6)
    expect(rateText(rate, 38.2, '%')).toBe('▼ −1.80 %/min')
    expect(rateText(rate, 38.2, '%', { windowMs: 15_000, change: 'slowing' })).toBe('▼ −1.80 %/min · 15 s · slowing')
    expect(rateText(0.0001, 38.2, '%')).toBe('► steady')
    expect(rateText(0.0001, 38.2, '%', { windowMs: 15_000 })).toBe('► steady · 15 s')
    expect(ratePerMinute([{ t: 0, v: 1 }, { t: 5_000, v: 2 }], 60_000)).toBeNull()
    // A window the data covers only partly gives no rate rather than a short-span guess.
    expect(ratePerMinute(falling.slice(0, 31), 60_000)).toBeNull()
    expect(minutesToThreshold(38.2, rate, thresholds[1]!)).toBeCloseTo(4.56, 2)
    expect(minutesToThreshold(38.2, 1.8, thresholds[1]!)).toBeNull()
  })

  test('rates follow the curve on screen and say when it is slowing', () => {
    expect([120_000, 600_000, 1_800_000].map(rateWindowMs)).toEqual([10_000, 30_000, 30_000])
    // Falling fast for a minute and a half, then nearly flat for the last 30 s.
    const flattening = Array.from({ length: 121 }, (_, index) => ({ t: index * 1000, v: index <= 90 ? 15 - index * 0.05 : 10.5 - (index - 90) * 0.002 }))
    const window = rateWindowMs(120_000)
    expect(Math.abs(ratePerMinute(flattening, window)!)).toBeLessThan(0.3)
    expect(rateChange(flattening, window, 12)).toBe('slowing')
    const steadyFall = Array.from({ length: 76 }, (_, index) => ({ t: index * 1000, v: 15 - index * 0.05 }))
    expect(rateChange(steadyFall, window, 12)).toBeNull()
    // Samples held for 10 s at a time (rcp-trip): steps, not a tendency.
    const stepped = Array.from({ length: 76 }, (_, index) => ({ t: index * 1000, v: 15 - Math.floor(index / 10) * (index < 50 ? 0.2 : 0.6) }))
    expect(rateChange(stepped, window, 12)).toBeNull()
    expect(simulationClock(Date.parse('2026-01-01T10:01:00.049Z'))).toBe('10:01:00 UTC')
    expect(simulationClock(Date.parse('2026-10-25T02:30:00+02:00'))).toBe('00:30:00 UTC')
    expect(simulationClock(Date.parse('2026-10-25T01:30:00+01:00'))).toBe('00:30:00 UTC')
    expect(simulationClock(Number.NaN)).toBe('--:--:-- UTC')
    expect(simulationClock(Number.MAX_VALUE)).toBe('--:--:-- UTC')
    // Rising 0.31 MPa/min with 0.285 MPa left to HI ALM 16 (turbine trip, run 6).
    const highAlarm = { ruleId: 'pzr-high', label: 'Pressurizer pressure high', kind: 'alarm', operator: '>', direction: 'high', value: 16, order: 1, action: 'ALM' } as const
    expect(timeToThresholdText(15.715, 0.31, highAlarm, true)).toBe('≈55 s')
    expect(timeToThresholdText(15.715, -0.31, highAlarm, true)).toBe('')
    expect(timeToThresholdText(10, 0.1, highAlarm, true)).toBe('')
    // Where a time would be shown but the tendency gives no basis for one.
    expect(timeToThresholdText(15.715, 0.31, highAlarm, false)).toBe('approaching, not projected')
    expect(timeToThresholdText(10, 0.1, highAlarm, false)).toBe('')
    expect(unitLabel('degC')).toBe('°C')
  })

  test('the most severe active threshold acting in the current mode marks the value', () => {
    expect(activeThreshold(thresholds, new Set(['alarm-low', 'trip-low']), undefined, noGates)?.ruleId).toBe('trip-low')
    expect(activeThreshold(thresholds, new Set(['control']), undefined, noGates)).toBeNull()
    // A high alarm of power operation does not mark a value in hot standby, latched or not.
    expect(activeThreshold(thresholds, new Set(['alarm-high']), { id: 'hotStandby', label: 'Hot standby' }, noGates)).toBeNull()
  })

  test('a reading is shown to a resolution of a thousandth of what the model declares it reads over', () => {
    // An instrument span first, then a hard range, then the reach from zero of its I&C limits and its operating point.
    expect(readingResolution({ instrumentSpan: { min: 0, max: 100 }, hardRange: { min: -10, max: 200 } }, [])).toBeCloseTo(0.1, 12)
    expect(readingResolution({ hardRange: { min: 0, max: 4500 } }, [])).toBeCloseTo(4.5, 12)
    // GEN-MW, with its 450 MW low alarm.
    expect(readingResolution(undefined, [{ value: 450 }])).toBeCloseTo(0.45, 12)
    expect(readingResolution(undefined, [])).toBeNull()
    // Without a span, never finer than a tenth of the step its limits are set in: RCS-LEAK-RATE's 0.063 kg/s high
    // alarm gives 0.0001 kg/s; TAVG-TREF's ±1.7 °C alarms 0.01 °C, where the QA review of run 22 read "0.004 °C".
    expect(readingResolution(undefined, [{ value: 0.063 }])).toBeCloseTo(0.0001, 12)
    const deviation = readingResolution(undefined, [{ value: -1.7 }, { value: 1.7 }])!
    expect(deviation).toBeCloseTo(0.01, 12)
    expect(formatQuantity(shownReading(0.004, deviation), 'degC', deviation)).toBe('0 °C')
    // A steam flow with no limit and no span reads over what it carries at the operating point: its tail after a trip reads 0.
    const steam = readingResolution(undefined, [], 378.1)!
    expect(steam).toBeCloseTo(0.3781, 12)
    expect(formatQuantity(shownReading(0.001, steam), 'kg/s', steam)).toBe('0 kg/s')
    // A declared span is never coarsened: a level read over 0–100 % keeps its 0.1 % with limits at whole percent.
    expect(readingResolution({ instrumentSpan: { min: 0, max: 100 } }, [{ value: 20 }, { value: 75 }], 55)).toBeCloseTo(0.1, 12)
    // Evaluation run 22: a tripped generator read 0.0000098 MW, and no leak −0.000000000003 kg/s.
    expect(formatQuantity(shownReading(0.0000098, 0.45), 'MW', 0.45)).toBe('0 MW')
    expect(formatQuantity(shownReading(-3e-12, 0.000063), 'kg/s', 0.000063)).toBe('0 kg/s')
    // Values above the resolution keep their digits, never more than it supports.
    expect(formatQuantity(1162.07, 'MW', 0.45)).toBe('1162 MW')
    expect(formatQuantity(7.672, 'kg/s', 0.000063)).toBe('7.67 kg/s')
    expect(formatQuantity(0.6, 'MW', 0.45)).toBe('0.6 MW')
    expect(formatQuantity(15.52, 'MPa', 0.016)).toBe('15.5 MPa')
    expect(formatValue(-0.04, 0.1)).toBe('0.0')
    // Without a declared basis, a reading is shown as it is.
    expect(formatQuantity(0.0000098, 'MW')).toBe('0.0000098 MW')
    // At an end of its instrument's span, a reading says it is there or beyond.
    expect(readingText(0, 'percent', 0.1, { min: 0, max: 100 })).toBe('<0 %')
    expect(readingText(100, 'percent', 0.1, { min: 0, max: 100 })).toBe('>100 %')
    expect(readingText(0, 'percent', 0.1, undefined)).toBe('0 %')
    // QA review of run 22: a startup rate pegged at its span's end read "<-0.500 DPM"; the end is written as declared.
    expect(readingText(-0.5, 'DPM', 0.0055, { min: -0.5, max: 5 })).toBe('< −0.5 DPM')
    // A reading over decades in powers of ten, never "0.0000022 A".
    const decades = { min: 1e-11, max: 1e-3 }
    expect(readingText(2.2e-6, 'amps', readingResolution({ instrumentSpan: decades }, []), decades)).toBe('2.2×10⁻⁶ A')
    expect(readingText(1e-11, 'amps', null, decades)).toBe('<1.0×10⁻¹¹ A')
  })
})

describe('annunciator tiles', () => {
  const alarm = (ruleId: string, severity: ComposedDisplayAlarm['severity'], extra: Partial<ComposedDisplayAlarm> = {}): ComposedDisplayAlarm => ({
    id: `${ruleId}:a`, ruleId, kind: 'alarm', title: ruleId, severity, active: true, acknowledged: true, latched: false, conditionActive: true, firstOut: false, ...extra,
  })

  test('each declared system counts its own active alarms, says how severe the worst is, and whether any is unacknowledged', () => {
    const systems = [{ id: 'steamGenerators', name: 'Steam generators', ruleIds: ['sg-a-low', 'sg-b-low'] }, { id: 'electrical', name: 'Electrical', ruleIds: ['bus-a-dead'] }, { id: 'containment', name: 'Containment', ruleIds: ['ctmt-high'] }]
    const states = annunciatorStates(systems, [
      alarm('sg-a-low', 'warning'),
      alarm('sg-b-low', 'critical', { acknowledged: false, latched: false, conditionActive: true, firstOut: true }),
      alarm('bus-a-dead', 'notice', { kind: 'trip', firstOut: true }),
      alarm('not-annunciated', 'critical'),
      // Cleared but unacknowledged: listed, not counted as active.
      alarm('ctmt-high', 'critical', { active: false, acknowledged: false }),
    ], { firstOutGroups: { 'bus-a-dead:a': 'BUS DEAD', 'bus-b-dead:a': 'BUS DEAD' }, groups: { 'bus-a-dead:a': 'BUS DEAD', 'bus-b-dead:a': 'BUS DEAD' }, groupOrder: ['RX TRIP', 'BUS DEAD'] })
    expect(states).toEqual([
      { id: 'steamGenerators', name: 'Steam generators', active: 2, unacknowledged: 1, severity: 'critical', actions: [], firstOut: false },
      { id: 'electrical', name: 'Electrical', active: 1, unacknowledged: 0, severity: 'notice', actions: [{ name: 'BUS DEAD', firstOut: true }], firstOut: true },
      // A quiet system keeps its place.
      { id: 'containment', name: 'Containment', active: 0, unacknowledged: 0, severity: null, actions: [], firstOut: false },
    ])
  })

  test('a tile names what its alarms do as chips and the banner do, never TRIP for an actuation', () => {
    // QA review of run 22, PORV open at 3 min: the Safety injection, Steam generators and Feedwater tiles read "TRIP 1st".
    const trip = (ruleId: string, effect: string, firstOut: boolean): ComposedDisplayAlarm =>
      ({ id: `trip:${ruleId}:${effect}`, ruleId, kind: 'trip', title: ruleId, severity: 'critical', active: true, acknowledged: false, latched: false, conditionActive: true, firstOut })
    const annunciation = {
      firstOutGroups: { 'trip:otdt:reactor-trip': 'RX TRIP', 'trip:si:reactor-trip': 'RX TRIP', 'trip:si:safety-injection': 'SI', 'trip:si-ctmt:safety-injection': 'SI', 'trip:sg-a-afw:afw': 'AFW START', 'trip:sg-b-afw:afw': 'AFW START' },
      groups: { 'trip:otdt:reactor-trip': 'RX TRIP', 'trip:si:reactor-trip': 'RX TRIP', 'trip:si:safety-injection': 'SI', 'trip:si-ctmt:safety-injection': 'SI', 'trip:sg-a-afw:afw': 'AFW START', 'trip:sg-b-afw:afw': 'AFW START', 'trip:fwi:fwi': 'FWI' },
      groupOrder: ['RX TRIP', 'SI', 'AFW START', 'FWI'],
    }
    const systems = [
      { id: 'reactorProtection', name: 'Reactor protection', ruleIds: ['otdt'] },
      { id: 'safetyInjection', name: 'Safety injection', ruleIds: ['si', 'si-ctmt'] },
      { id: 'steamGenerators', name: 'Steam generators', ruleIds: ['sg-a-afw', 'sg-b-afw', 'fwi'] },
    ]
    const states = annunciatorStates(systems, [
      trip('otdt', 'reactor-trip', true),
      trip('si', 'safety-injection', true),
      trip('si', 'reactor-trip', false),
      trip('sg-a-afw', 'afw', true),
      trip('sg-b-afw', 'afw', false),
      trip('fwi', 'fwi', true),
    ], annunciation)
    expect(states.map(state => state.actions)).toEqual([
      [{ name: 'RX TRIP', firstOut: true }],
      // Safety injection trips the reactor too: its own first-out leads, then the reactor trip, whose first-out lies elsewhere.
      [{ name: 'SI', firstOut: true }, { name: 'RX TRIP', firstOut: false }],
      // FWI is a group of one: being first among one says nothing.
      [{ name: 'AFW START', firstOut: true }, { name: 'FWI', firstOut: false }],
    ])
    // As many whole as the tile's width holds, the rest counted, a first-out kept; never cut.
    const room = (characters: number) => (text: string) => text.length <= characters
    expect(tileActions(states[1]!.actions, room(20))).toBe('SI 1st · RX TRIP')
    expect(tileActions(states[1]!.actions, room(12))).toBe('SI 1st +1')
    expect(tileActions(states[2]!.actions, room(6))).toBe('1st')
    // Where the first does not fit with the rest counted, a shorter one does (the loss-of-feedwater overview's Feedwater tile).
    expect(tileActions([{ name: 'AFW START', firstOut: true }, { name: 'FWI', firstOut: true }], room(12))).toBe('FWI 1st +1')
    expect(tileActions([], room(20))).toBe('')
  })
})

describe('limit labels', () => {
  const slot = (key: string, want: number, rank: number, group = 'high', size = 12) => ({ key, want, size, group, rank })

  test('stack at their lines, pushed clear of each other with every limit named, inside the room', () => {
    // HI TRIP 82 and HI ALM 75 eight pixels apart (turbine-trip): both named, the lower one pushed down.
    expect(stackLabels([slot('trip', 20, 1), slot('alarm', 28, 0)], { start: 0, end: 120 })).toEqual([
      { key: 'trip', start: 20, folded: [] },
      { key: 'alarm', start: 32, folded: [] },
    ])
    // Three labels at the bottom edge are pulled back up so the last ends inside the room.
    expect(stackLabels([slot('a', 100, 0, 'low'), slot('b', 104, 1, 'low'), slot('c', 108, 2, 'low')], { start: 0, end: 120 }).map(label => label.start)).toEqual([84, 96, 108])
    // Side by side along a scale, of different widths: "HI ALM 75" and "HI TRIP 82" never overlap.
    const [alarm, trip] = stackLabels([slot('alarm', 300, 0, 'high', 60), slot('trip', 330, 1, 'high', 66)], { start: 0, end: 520 })
    expect(trip!.start).toBeGreaterThanOrEqual(alarm!.start + 60)
  })

  test('fold only where the room is short, the least important into a neighbour of their own direction', () => {
    // Room for three of four: the least important high limit folds into the other high one.
    const placed = stackLabels([slot('hi-trip', 10, 3), slot('hi-alarm', 14, 1), slot('lo-alarm', 30, 0, 'low'), slot('lo-trip', 34, 2, 'low')], { start: 0, end: 36 })
    expect(placed).toEqual([
      { key: 'hi-alarm', start: 0, folded: ['hi-trip'] },
      { key: 'lo-alarm', start: 12, folded: [] },
      { key: 'lo-trip', start: 24, folded: [] },
    ])
    // Never into a low limit's label, though one sits nearer.
    expect(stackLabels([slot('a', 0, 0, 'low'), slot('b', 12, 1), slot('c', 14, 3), slot('d', 15, 2, 'low')], { start: 0, end: 36 }).find(label => label.key === 'b')!.folded).toEqual(['c'])
    // A room shorter than one label still names the most important limit.
    expect(stackLabels([slot('a', 0, 1), slot('b', 0, 0)], { start: 0, end: 8 })).toEqual([{ key: 'b', start: -4, folded: ['a'] }])
  })

  test('keep active limits first, then the limit a value is heading for, then the nearest', () => {
    const ranks = limitLabelRanks([
      { key: 'hi-trip', value: 82, active: null, ahead: false, inForce: true },
      { key: 'idle', value: 74, active: null, ahead: false, inForce: false },
      { key: 'hi-alarm', value: 75, active: null, ahead: true, inForce: true },
      { key: 'lo-alarm', value: 30, active: 'warning', ahead: false, inForce: true },
      { key: 'lo-trip', value: 20, active: 'critical', ahead: false, inForce: true },
      { key: 'far', value: 95, active: null, ahead: false, inForce: true },
    ], 73)
    // A limit that does not act in the current mode gives way first, however near.
    expect([...ranks.entries()].sort((left, right) => left[1] - right[1]).map(([key]) => key)).toEqual(['lo-trip', 'lo-alarm', 'hi-alarm', 'hi-trip', 'far', 'idle'])
  })

  test('a mode-qualified limit acts only in its modes, even with its rule latched from one of them', () => {
    // RCP A loop flow low acts in power operation only (rcp-trip, in hot standby).
    const flowLow = { ruleId: 'rcp-a-loop-flow-low', label: 'RCP A loop flow low', kind: 'alarm', operator: '<', direction: 'low', value: 2500, order: 1, action: 'ALM', modeLabel: 'Mode 1', modeNames: 'Power operation', modeIds: ['powerOperation'] } as const
    const hotStandby = { id: 'hotStandby', label: 'Hot standby' }
    expect(limitInForce(flowLow, hotStandby)).toBe(false)
    expect(limitInForce(flowLow, { id: 'powerOperation' })).toBe(true)
    expect(limitInForce(flowLow, null)).toBe(false)
    expect(limitInForce(thresholds[0]!, hotStandby)).toBe(true)
    // No margin or limit ahead is read against a limit that does not act: 401 kg/s is past nothing in hot standby.
    expect(limitsInForce([flowLow], hotStandby, noGates)).toEqual([])
    expect(limitAhead(401, 'falling', limitsInForce([flowLow], hotStandby, noGates))).toBeNull()
    // Before the first sample the mode is unknown; nothing is compared yet.
    expect(limitsInForce([flowLow], undefined, noGates)).toEqual([flowLow])
  })

  test('limits at one value are one line, each keeping its own label, look and colour', () => {
    // Evaluation run 22, loss of main feedwater in hot standby: two identical "LO TRIP 20" lines, both red.
    const line = (ruleId: string, action: string, modeIds?: ReadonlyArray<string>) => ({
      ruleId, label: ruleId, kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 20, order: 2, action,
      ruleIds: [ruleId], signals: ['SG-B-LVL-NR'], ...(modeIds === undefined ? {} : { modeLabel: 'Modes 1–2', modeNames: 'Power operation or Startup', modeIds }),
    }) as const
    const afw = line('sg-b-afw', 'AFW START')
    const reactorTrip = line('sg-b-rx-trip', 'RX TRIP', ['powerOperation', 'startup'])
    const alarm = { ...line('sg-b-low', 'ALM'), kind: 'alarm', severity: 'warning', value: 30, order: 1 } as const
    const hotStandby = { id: 'hotStandby', label: 'Hot standby' }
    const lines = limitLines([reactorTrip, alarm, afw], hotStandby, noGates)
    expect(lines.map(entry => [entry.value, entry.look, entry.members.map(member => member.ruleId)])).toEqual([
      [30, 'acting', ['sg-b-low']],
      // The AFW start acts now, so the line is drawn in force and its label comes first.
      [20, 'acting', ['sg-b-afw', 'sg-b-rx-trip']],
    ])
    expect(lines[1]!.members.map(member => thresholdName(member, 'percent', { withUnit: false }))).toEqual(['LO-LO 20 · AFW START', 'LO-LO 20 · RX TRIP'])
    // Both rules active and the value past both: only the limit in force takes the alarm colour; the reactor trip of modes 1-2 stays idle.
    const active = new Set(['sg-b-afw', 'sg-b-rx-trip'])
    expect([limitSeverity(afw, active, hotStandby, noGates), limitSeverity(reactorTrip, active, hotStandby, noGates)]).toEqual(['critical', null])
    expect([limitLook(afw, hotStandby, noGates), limitLook(reactorTrip, hotStandby, noGates), limitLook(reactorTrip, undefined, noGates), limitLook(reactorTrip, { id: 'powerOperation', label: 'Power operation' }, noGates)]).toEqual(['acting', 'idle', 'qualified', 'acting'])
    expect(limitLines([reactorTrip], hotStandby, noGates)[0]!.look).toBe('idle')
    expect(idleText(reactorTrip, hotStandby)).toBe('Modes 1–2')
  })

  test('a limit whose gates do not hold is idle, as one of another mode is, and says what it waits for', () => {
    // Safety injection on low pressurizer pressure acts only while SI-BLOCKED reads off.
    const si = {
      ruleId: 'si', label: 'Safety injection on low pressurizer pressure', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 12.7, order: 2, action: 'SI',
      ruleIds: ['si'], signals: ['PT-455'], gatedBy: ['SI-BLOCKED off'], gates: [{ path: 'safetyInjectionBlockLogic.blocked', on: false }],
    } as unknown as Parameters<typeof limitLook>[0] & Parameters<typeof limitSeverity>[0]
    const blocked = (path: string) => path === 'safetyInjectionBlockLogic.blocked' ? true : undefined
    const unblocked = (path: string) => path === 'safetyInjectionBlockLogic.blocked' ? false : undefined
    const hotStandby = { id: 'hotStandby', label: 'Hot standby' }
    expect([gatesHold(si, blocked), gatesHold(si, unblocked), gatesHold(si, noGates)]).toEqual([false, true, true])
    expect([limitLook(si, hotStandby, blocked), limitLook(si, hotStandby, unblocked)]).toEqual(['idle', 'acting'])
    // Active or not, it takes no alarm colour while blocked, and its second line names the state it waits for.
    expect(limitSeverity(si, new Set(['si']), hotStandby, blocked)).toBeNull()
    expect(idleText(si, hotStandby)).toBe('SI-BLOCKED off')
    expect(limitsInForce([si as unknown as ComposedDisplayThreshold], hotStandby, blocked)).toEqual([])
  })

  test('a gate inside a combined condition holds as the condition does: any one of its states, or another value past its limit', () => {
    // The feedwater isolation on low Tavg acts after a reactor trip: either trip breaker open (HMI review of run 23).
    const fwi = { gates: [{ any: [{ path: 'reactorTripBreakerA.closedState', on: false }, { path: 'reactorTripBreakerB.closedState', on: false }] }] } as never
    const breakers = (a: boolean, b: boolean) => (path: string) => path === 'reactorTripBreakerA.closedState' ? a : path === 'reactorTripBreakerB.closedState' ? b : undefined
    expect([gatesHold(fwi, breakers(true, true)), gatesHold(fwi, breakers(false, true)), gatesHold(fwi, breakers(true, false)), gatesHold(fwi, noGates)]).toEqual([false, true, true, true])
    // The reactor trip on turbine trip above P-9: power above 50 % gates the stop valve's limit.
    const p9 = { gates: [{ path: 'core.powerRangePercent', operator: '>', value: 50 }] } as never
    expect([gatesHold(p9, path => (path === 'core.powerRangePercent' ? 100 : undefined)), gatesHold(p9, path => (path === 'core.powerRangePercent' ? 30 : undefined))]).toEqual([true, false])
  })

  test('a line names each action once, its signals only where they differ, and limits beyond an edge in value order', () => {
    // Loss of offsite power: both buses' margin alarms at 0 MW read "LO 0 · ALM", not "ALM + ALM" (HMI review of run 23).
    const margin = (signal: string, train: string) => ({
      ruleId: `overload-${train}`, label: `EDG ${train} overload`, kind: 'alarm', severity: 'warning', operator: '<=', direction: 'low', value: 0, order: 1, action: 'ALM',
      ruleIds: [`overload-${train}`], signals: [signal], gatedBy: [`BRK-EDG-${train}-POS CLOSED, BRK-OFFSITE-${train}-POS OPEN`],
      gates: [{ path: `dieselBreaker${train}.closedState` as VariablePath, on: true }, { path: `offsiteBreaker${train}.closedState` as VariablePath, on: false }],
    }) as const
    const both = [margin('BUS-A-MARGIN', 'A'), margin('BUS-B-MARGIN', 'B')]
    const onDiesels = (path: string) => path.startsWith('dieselBreaker')
    const texts = (gates: (path: string) => boolean | undefined) => {
      const lines = limitLines(both, { id: 'hotStandby', label: 'Hot standby' }, gates)
      return limitLabelParts(lines[0]!, lines, { id: 'hotStandby', label: 'Hot standby' }, gates).map(part => `${part.text}${part.waits === '' ? '' : ` (${part.waits})`}`)
    }
    expect(texts(onDiesels)).toEqual(['ALM'])
    // A rule that waits minutes names its wait with its action, and limits doing the same without it stay apart.
    const instant = { ruleId: 'instant', label: 'Grid frequency low', kind: 'trip', severity: 'critical', operator: '<', direction: 'low', value: 49, order: 1, action: 'TURB TRIP', ruleIds: ['instant'], signals: ['GRID-HZ'] } as const
    const sustained = { ...instant, ruleId: 'sustained', ruleIds: ['sustained'], delayMs: 1_800_000 }
    const tripLines = limitLines([sustained, instant], { id: 'powerOperation', label: 'Power operation' }, noGates)
    expect(limitLabelParts(tripLines[0]!, tripLines, { id: 'powerOperation', label: 'Power operation' }, noGates).map(part => part.text)).toEqual(['TURB TRIP after 30 min', '+ TURB TRIP'])
    // Bus A on its diesel, bus B still on offsite power: the two differ, so each names its bus.
    expect(texts(path => path === 'dieselBreakerA.closedState' || path === 'offsiteBreakerB.closedState')).toEqual(['ALM (A)', '+ ALM (B) (BRK-EDG-B-POS CLOSED, BRK-OFFSITE-B-POS OPEN)'])
    // Names: what tells parallel signals apart, alike ones as one.
    expect(distinguishingNames(['SG-A-LVL-NR', 'SG-B-LVL-NR'])).toEqual(['A', 'B'])
    expect(joinedName(['BRK-EDG-A-POS', 'BRK-EDG-B-POS'])).toBe('BRK-EDG-A/B-POS')
    expect(mergedText(['SG A feedwater inflow < 150 kg/s', 'SG B feedwater inflow < 150 kg/s'])).toBe('SG A/B feedwater inflow < 150 kg/s')
    expect(mergedText(['BRK-EDG-A-POS CLOSED, BRK-OFFSITE-A-POS OPEN', 'BRK-EDG-B-POS CLOSED, BRK-OFFSITE-B-POS OPEN'])).toBeNull()
    // compare-sg-levels: LO 30 and LO-LO 20 both lie below the scale; given highest first and wanting one edge, they read down in value order.
    expect(stackLabels([slot('lo-30', 120, 1, 'low', 12), slot('lo-lo-20', 120, 0, 'low', 24)], { start: 0, end: 120 }).map(label => [label.key, label.start])).toEqual([['lo-30', 84], ['lo-lo-20', 96]])
  })

  test('the strips of one trend share one gutter, as wide as the widest label any of them writes, so their times line up', () => {
    // HMI review of run 25 (porv-open, power-stable, sg-b-runback): each strip's gutter was as wide as its own labels,
    // so the "now" of a strip without limits stood right of the one above it. A measure of 6 px a character.
    const measure = (text: string): number => text.length * 6
    const strip = (unit: 'degC' | 'MPa', ...limits: ReadonlyArray<ComposedDisplayThreshold>) => ({ unit, thresholds: limits.map(limit => ({ ...limit, ruleIds: [limit.ruleId], signals: ['X'] })) })
    const subcooling = strip('degC', thresholds[0]!, { ...thresholds[0]!, ruleId: 'trip-low-2', value: 16.7, action: 'RX TRIP + AFW START' })
    const pressure = strip('MPa')
    const controlOnly = strip('MPa', thresholds[2]!)
    // "▲ LO-LO 16.7 · RX TRIP + AFW START (+9)" is 39 characters: 234 px and the inset, within the bound.
    expect(trendGutter([subcooling], measure)).toBe(TREND_GUTTER.max)
    expect(trendGutter([subcooling, pressure], measure)).toBe(trendGutter([subcooling], measure))
    expect(trendGutter([strip('degC', thresholds[1]!), pressure], measure)).toBe('▲ LO 30 · ALM (+9)'.length * 6 + 14)
    // A strip without limits, or with control set points only (marked on the axis, not named), takes the least width.
    expect(trendGutter([pressure, controlOnly], measure)).toBe(TREND_GUTTER.min)
  })
})
