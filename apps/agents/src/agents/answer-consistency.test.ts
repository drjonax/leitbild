import { describe, expect, test } from 'bun:test'
import type { EmbeddedViewContent } from '@leitbild/contracts'
import { answerContradictions } from './answer-consistency.ts'

// Answers and displays from evaluation runs 19-27 (GPT-6 Sol), as World now
// describes those displays. The softer findings these answers also carry
// (values not shown, watch items, spans, leads, directions, limits, times)
// are measured offline: scripts/display-eval/grounding.test.ts.
type Item = EmbeddedViewContent['items'][number]
const signal = (names: ReadonlyArray<string>, value: number, unit: string, limits: ReadonlyArray<number> = [], history = true): Item =>
  ({ names: [...names], values: [{ value, unit }], limits: limits.map(limit => ({ value: limit, unit })), history })
const drawn = (names: ReadonlyArray<string>, state: string): Item => ({ names: [...names], values: [], limits: [], history: false, state })
const alarms: Item = { names: ['Active alarms and trips of the displayed signals and equipment'], values: [], limits: [], history: false }
const view = (items: ReadonlyArray<Item>, extra: Partial<EmbeddedViewContent> = {}): EmbeddedViewContent =>
  ({ items: [...items], span: null, lead: null, ...extra })
const FENCE = '\n\n```leitbild-view\nview call_6_0/display\n```'

const sgLevels = (value: number) => ['A', 'B', 'C', 'D'].map(sg => signal([`SG-${sg}-LVL-NR`, `sg${sg}.levelPercent`, 'Steam generator level'], value, '%', [20, 30, 75]))
const afwFlows = ['A', 'B', 'C', 'D'].map(sg => signal([`Auxiliary feedwater to steam generator ${sg} flow`, `aux-feedwater-valve-${sg.toLowerCase()}-to-sg-${sg.toLowerCase()}.flowKgPerS`], 83.1, 'kg/s', [], false))

describe('answers that contradict their display', () => {
  test('a value stated as current that only an earlier point of the trend could be', () => {
    expect(answerContradictions('Steam generator level is currently 99 percent.' + FENCE, view([signal(['Steam generator level'], 55, '%')]))).toEqual([
      'It cites 99 percent as current, but the display reads Steam generator level 55 % now.',
    ])
    expect(answerContradictions('SG A level is now at 80 %.' + FENCE, view([sgLevels(55.2)[0]!]))).toEqual([
      'It cites 80 % as current, but the display reads SG-A-LVL-NR 55.2 % now.',
    ])
  })

  test('a value written with an item the display reads only now, and reads otherwise', () => {
    expect(answerContradictions('Auxiliary feedwater to steam generator B flow is 60 kg/s.' + FENCE, view(afwFlows))).toEqual([
      'It cites 60 kg/s for Auxiliary feedwater to steam generator B flow, but the display reads Auxiliary feedwater to steam generator B flow 83.1 kg/s.',
    ])
    // Each value against the item its own words name.
    expect(answerContradictions(
      'SG B receives 140 kg/s, while SG A receives 300 kg/s.' + FENCE,
      view([
        signal(['Feedwater inflow · Steam Generator B', 'sgB.feedwaterFlowKgPerS', 'Feedwater inflow'], 140, 'kg/s', [150], false),
        signal(['Feedwater inflow · Steam Generator A', 'sgA.feedwaterFlowKgPerS', 'Feedwater inflow'], 399, 'kg/s', [150], false),
      ]),
    )).toEqual(['It cites 300 kg/s for Feedwater inflow · Steam Generator A, but the display reads Feedwater inflow · Steam Generator A 399 kg/s.'])
  })
})

describe('answers the live check lets through', () => {
  test('values the display does not show, tied to no shown item: measured offline, never a correction turn', () => {
    // afw-reach: SG levels cited beside a display of branch flows.
    expect(answerContradictions(
      '**Yes—on Unit 2, auxiliary feedwater is currently reaching all four steam generators.** At 10:02:00 simulation time, each SG inlet shows 83.1 kg/s of auxiliary feedwater. All four SG levels remain low at 19.5%, with low-low trips active, so delivery is established but recovery is not yet demonstrated. Watch the levels for a sustained response; the panel below shows the four branch flows.' + FENCE,
      view(afwFlows),
    )).toEqual([])
    // loss-main-feedwater: AFW flows cited beside a display of SG levels.
    expect(answerContradictions(
      'At **sim 10:02:00**, Unit 2’s four steam-generator levels are each **19.5%**, below the **LO TRIP 20%** line; low-low trips are active. Auxiliary-feedwater header flow is currently **332 kg/s**, with about **83 kg/s** to each generator.' + FENCE,
      view([...sgLevels(19.5), alarms]),
    )).toEqual([])
    // sg-b-runback: a valve position cited in the unit of a trended level.
    expect(answerContradictions(
      'At sim 10:03:00, Unit 2’s SG B narrow-range level is **29.6%**, just below **LO ALM 30%**; SG A is 53.8%. The B control valve is demanded fully open but its position feedback is only 35%, with a position-failure indication active.' + FENCE,
      view([sgLevels(29.6)[1]!, signal(['SG-A-LVL-NR', 'sgA.levelPercent', 'Steam generator level'], 53.8, '%', [20, 30, 75])]),
    )).toEqual([])
    // A value of another item written beside a shown one: its own words name no shown item.
    expect(answerContradictions('SG B level reads 29.6 %, with the B valve position at 35 %.' + FENCE, view([{ ...sgLevels(29.6)[1]!, history: false }]))).toEqual([])
  })

  test('softer departures: a window, a first-out, the lead, precision, a direction, a limit, a time', () => {
    const pressure = signal(['PT-455', 'pressurizer.pressureMPa', 'Pressurizer pressure'], 15.458, 'MPa', [13.8, 14.8, 16])
    const falling: Item = { ...pressure, trend: { rate: -1, unit: 'MPa', direction: 'falling' }, limitAhead: { name: 'LO ALM 14.8 MPa', value: 14.8, unit: 'MPa' } }
    const display = view([falling, alarms], { span: { shownMs: 60_000, horizonMs: 600_000 }, lead: { item: 0, reason: 'PT-455: 15.5 MPa, falling' } })
    for (const answer of [
      'The 10-minute window shows pressurizer pressure holding.',
      'The first-out was Manual turbine trip.',
      'Steam generator levels look normal.',
      'PT-455 is 15.4580 MPa.',
      'At sim 10:02:00 pressurizer pressure is rising at 15.46 MPa.',
      'PT-455 is 15.46 MPa, 0.542 MPa below HI ALM 16 MPa.',
      'PT-455 will reach LO ALM 14.8 MPa in about 5 s.',
    ]) expect(answerContradictions(answer + FENCE, display)).toEqual([])
  })
})

describe('answers consistent with their display', () => {
  test('a value cited in another unit of the same quantity, converted exactly', () => {
    const shown = view([signal(['Pressurizer pressure', 'pressurizer.pressureKPa'], 15500, 'kPa', [14800], false)])
    expect(answerContradictions('Pressurizer pressure is 15.5 MPa, 0.7 MPa above LO ALM 14.8 MPa.' + FENCE, shown)).toEqual([])
    expect(answerContradictions('Feedwater flow is 504 t/h.' + FENCE, view([signal(['Feedwater flow'], 140, 'kg/s', [], false)]))).toEqual([])
  })

  test('an earlier value of a trend, a change, and a percentage derived from it', () => {
    expect(answerContradictions('SG B level is now 29.6 %, down from 55 % before the trip.' + FENCE, view([sgLevels(29.6)[1]!]))).toEqual([])
    expect(answerContradictions('Feedwater inflow to Steam Generator B fell by 20 kg/s.' + FENCE, view([signal(['Feedwater inflow · Steam Generator B'], 140, 'kg/s', [], false)]))).toEqual([])
    expect(answerContradictions(
      'Core fission power rose from 3400.6 to 3407.8 MW over the recorded minute, a 7.2 MW increase (about 0.2%). At sim 10:01:00 it is 192 MW below **HI ALM 3600 MW**.' + FENCE,
      view([signal(['Core fission power · Reactor Core', 'core.powerMw', 'Core fission power'], 3408, 'MW', [3600])], { span: { shownMs: 60_000, horizonMs: 600_000 } }),
    )).toEqual([])
  })

  test('values read now, limits, margins, drawn states and anything marked not shown', () => {
    expect(answerContradictions(
      'Unit 2’s four steam generator narrow-range levels each read **55.2%**, 25.2 percentage points above **LO ALM 30 %**.' + FENCE,
      view([...sgLevels(55.2), alarms]),
    )).toEqual([])
    expect(answerContradictions(
      'At sim 10:03:00 **FCV B is 35% open despite a 100% command**. SG B receives **140 kg/s**, below its **LO ALM 150 kg/s**, while SG A receives **399 kg/s**.' + FENCE,
      view([
        signal(['Feedwater inflow · Steam Generator B', 'sgB.feedwaterFlowKgPerS', 'Feedwater inflow'], 140, 'kg/s', [150], false),
        signal(['Feedwater inflow · Steam Generator A', 'sgA.feedwaterFlowKgPerS', 'Feedwater inflow'], 399, 'kg/s', [150], false),
        drawn(['FCV B', 'feedwaterControlValveB'], '35 % open; commanded 100 % disagrees'),
      ]),
    )).toEqual([])
    expect(answerContradictions(
      'Auxiliary feedwater to steam generator B flow (not shown) is 60 kg/s.' + FENCE,
      view(afwFlows),
    )).toEqual([])
  })

  test('a critical safety function status: its values count as shown', () => {
    expect(answerContradictions(
      'Core cooling is GREEN: core exit temperature 302 °C with 55 °C of subcooling.' + FENCE,
      view([alarms], { statuses: [{ names: ['Core Cooling', 'core-cooling'], status: 'GREEN', path: 'Core exit temperature below 649 °C and subcooling above 0 °C', values: [{ value: 302.4, unit: '°C' }, { value: 55.3, unit: '°C' }] }] }),
    )).toEqual([])
  })
})
