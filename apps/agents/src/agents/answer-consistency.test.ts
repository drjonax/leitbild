import { describe, expect, test } from 'bun:test'
import type { EmbeddedViewContent } from '@leitbild/contracts'
import { answerViewIssues } from './answer-consistency.ts'

// Answers and displays from evaluation runs 19-21 (GPT-6 Sol), as World now
// describes those displays.
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

describe('answers that cite what their display does not show', () => {
  test('a value stated as current that only an earlier point of the trend could be', () => {
    expect(answerViewIssues('Steam generator level is currently 99 percent.' + FENCE, view([signal(['Steam generator level'], 55, '%')]))).toEqual([
      'It cites 99 percent as current, but the display reads Steam generator level 55 % now.',
    ])
    expect(answerViewIssues('SG A level is now at 80 %.' + FENCE, view([sgLevels(55.2)[0]!]))).toEqual([
      'It cites 80 % as current, but the display reads SG-A-LVL-NR 55.2 % now.',
    ])
  })

  test('afw-reach: SG levels cited and watched beside a display of branch flows', () => {
    const issues = answerViewIssues(
      '**Yes—on Unit 2, auxiliary feedwater is currently reaching all four steam generators.** At 10:02:00 simulation time, each SG inlet shows 83.1 kg/s of auxiliary feedwater. All four SG levels remain low at 19.5%, with low-low trips active, so delivery is established but recovery is not yet demonstrated. Watch the levels for a sustained response; the panel below shows the four branch flows.' + FENCE,
      view(afwFlows),
    )
    expect(issues).toEqual([
      'It cites 19.5%, but the display shows no value in %.',
      'It says to watch "the levels", which the display does not show.',
    ])
  })

  test('loss-main-feedwater: AFW flows cited beside a display of SG levels', () => {
    const issues = answerViewIssues(
      'At **sim 10:02:00**, Unit 2’s four steam-generator levels are each **19.5%**, below the **LO TRIP 20%** line; low-low trips are active. Monitor their trends first for a sustained recovery, not just auxiliary-feedwater pump status. Auxiliary-feedwater header flow is currently **332 kg/s**, with about **83 kg/s** to each generator; keep checking delivery to each generator and the auxiliary-feedwater tank inventory (**93.9%**). Use the applicable unit procedure for the response.' + FENCE,
      view([...sgLevels(19.5), alarms], { lead: { item: 0, reason: 'SG-A-LVL-NR: 19.5 %, past LO TRIP 20 %' } }),
    )
    expect(issues).toEqual([
      'It cites 332 kg/s, but the display shows no value in kg/s.',
      'It cites 83 kg/s, but the display shows no value in kg/s.',
      'It says to watch "delivery", which the display does not show.',
    ])
  })

  test('rcp-trip: loop flow cited beside a display of core temperatures', () => {
    const issues = answerViewIssues(
      '**Unit 2: core cooling is not confirmed as holding.** At sim 10:01:00, all four RCP loops were at about 401 kg/s and the low-flow reactor trip was active. CET-AVG was 302.4 °C and SUB-MARGIN 55.3 °C; modeled fuel temperature was falling, but the model also reported a 175 MW core heat-removal deficit. Watch the trends below and assess cooling under the applicable plant procedure.' + FENCE,
      view([
        signal(['CET-AVG', 'core.coolantOutletTemperatureC', 'Core coolant outlet temperature'], 302.4, '°C'),
        signal(['SUB-MARGIN', 'vessel.subcoolingMarginC', 'RCS subcooling margin'], 55.3, '°C'),
        signal(['Core fuel temperature · Reactor Core', 'core.fuelTemperatureC', 'Core fuel temperature'], 640, '°C'),
        signal(['Core heat removal deficit · Reactor Core', 'core.coreHeatRemovalDeficitMw', 'Core heat removal deficit'], 175, 'MW', [], false),
      ], { span: { shownMs: 90_000, horizonMs: 120_000 } }),
    )
    expect(issues).toEqual(['It cites 401 kg/s, but the display shows no value in kg/s.'])
  })

  test('sg-b-runback: a valve position cited in the unit of a trended level', () => {
    const issues = answerViewIssues(
      'At sim 10:03:00, Unit 2’s SG B narrow-range level is **29.6%**, just below **LO ALM 30%**; SG A is 53.8%. The B control valve is demanded fully open but its position feedback is only 35%, with a position-failure indication active.' + FENCE,
      view([sgLevels(29.6)[1]!, signal(['SG-A-LVL-NR', 'sgA.levelPercent', 'Steam generator level'], 53.8, '%', [20, 30, 75])]),
    )
    expect(issues).toEqual(['It cites 35%, which the display does not show (it trends % only for SG-B-LVL-NR, SG-A-LVL-NR).'])
  })

  test('show-tavg: a 10-minute window over an axis that reaches back 1 min', () => {
    const issues = answerViewIssues(
      'Unit 2’s **TAVG** (average reactor coolant temperature) trend is shown below with a 10-minute window, current at **10:01:00 sim time**.' + FENCE,
      view([signal(['TAVG', 'vessel.meanPrimaryCoolantTemperatureC', 'Mean primary coolant temperature'], 301.2, '°C')], { span: { shownMs: 60_000, horizonMs: 600_000 } }),
    )
    expect(issues).toEqual(['It says "10-minute window", but the display\'s time axis spans the last 1 min now; it widens to 10 min as the Run continues.'])
  })

  test('porv-path: the display leads with pressure past its alarm, and the answer never names it', () => {
    const issues = answerViewIssues(
      'At sim 10:02:00, coolant leaving Unit 2’s pressurizer is going to the **pressurizer relief tank**. The relief path is passing about **7.7 kg/s**, so the PORV is **not confirmed shut**: it is commanded shut, but its position is not measured.' + FENCE,
      view([
        signal(['PT-455', 'pressurizer.pressureMPa', 'Pressurizer pressure'], 4.01, 'MPa', [13.8, 14.8, 16]),
        drawn(['PORV', 'pressurizer.reliefValve'], 'position not measured; passing 7.7 kg/s; commanded shut'),
      ], { lead: { item: 0, reason: 'PT-455: 4.01 MPa, past LO TRIP 13.8 MPa' } }),
    )
    expect(issues).toEqual(['It leaves out what the display leads with: PT-455: 4.01 MPa, past LO TRIP 13.8 MPa.'])
  })
})

describe('answers consistent with their display', () => {
  test('a value cited in another unit of the same quantity, converted exactly', () => {
    // Evaluation boundary case: a display reading 15500 kPa beside an answer in MPa.
    const shown = view([signal(['Pressurizer pressure', 'pressurizer.pressureKPa'], 15500, 'kPa', [14800])])
    expect(answerViewIssues('Pressurizer pressure is 15.5 MPa, 0.7 MPa above LO ALM 14.8 MPa.' + FENCE, shown)).toEqual([])
    expect(answerViewIssues('Feedwater flow is 504 t/h.' + FENCE, view([signal(['Feedwater flow'], 140, 'kg/s', [], false)]))).toEqual([])
    // Another quantity is never converted: 15.5 MW is not a pressure.
    expect(answerViewIssues('Pressurizer pressure is 15.5 MW.' + FENCE, shown)).toEqual(['It cites 15.5 MW, but the display shows no value in MW.'])
  })

  test('an earlier value of a trend, beside the current one', () => {
    expect(answerViewIssues('SG B level is now 29.6 %, down from 55 % before the trip.' + FENCE, view([sgLevels(29.6)[1]!]))).toEqual([])
  })

  test('values read now, limits, margins and percentage points as the display shows them', () => {
    expect(answerViewIssues(
      'At sim 10:01:00, Unit 2’s four steam generator narrow-range levels are equal: A, B, C and D each read **55.2%**. Each is 25.2 percentage points above its **LO ALM 30 %** threshold. Watch the trend below for any generator departing from the others.' + FENCE,
      view([...sgLevels(55.2), alarms], { lead: { item: 0, reason: 'SG-A-LVL-NR: 55.2 %, 19.8 % below HI ALM 75 %' } }),
    )).toEqual([])
  })

  test('earlier values of a trended signal, and a recorded window as long as the axis', () => {
    expect(answerViewIssues(
      'Unit 2 has undergone a severe depressurization: PT-455 fell from 15.49 to a low of 3.97 MPa over the recorded two minutes. At the current **sim 10:02:00**, it has edged up to **4.01 MPa**, but pressure remains far below the **LO TRIP 13.8 MPa** threshold. Relief flow is still **7.69 kg/s**. Watch whether pressure recovery continues and relief flow falls.' + FENCE,
      view([
        signal(['PT-455', 'pressurizer.pressureMPa', 'Pressurizer pressure'], 4.01, 'MPa', [13.8, 14.8]),
        signal(['Pressurizer relief flow', 'pressurizer.reliefFlowKgPerS'], 7.69, 'kg/s', [1], false),
      ], { span: { shownMs: 120_000, horizonMs: 120_000 }, lead: { item: 1, reason: 'Pressurizer relief flow: 7.69 kg/s, past HI ALM 1 kg/s' } }),
    )).toEqual([])
  })

  test('a percentage derived from a cited change is not a reading', () => {
    expect(answerViewIssues(
      'Core fission power rose from 3400.6 to 3407.8 MW over the recorded minute, a 7.2 MW increase (about 0.2%). At sim 10:01:00 it is 192 MW below **HI ALM 3600 MW**; watch the trend for continued drift.' + FENCE,
      view([signal(['Core fission power · Reactor Core', 'core.powerMw', 'Core fission power'], 3408, 'MW', [3600])], { span: { shownMs: 60_000, horizonMs: 600_000 } }),
    )).toEqual([])
  })

  test('drawn states and the values written in them', () => {
    expect(answerViewIssues(
      'Yes. On Unit 2, the restriction is at **Feedwater Control Valve B (FCV B)**. At sim 10:03:00 it is **35% open despite a 100% command**. SG B receives **140 kg/s**, below its **LO ALM 150 kg/s**, while SG A receives **399 kg/s**. See the feedwater-path mimic; watch SG B flow and level for a response.' + FENCE,
      view([
        signal(['Feedwater inflow · Steam Generator B', 'sgB.feedwaterFlowKgPerS', 'Feedwater inflow'], 140, 'kg/s', [150], false),
        signal(['Feedwater inflow · Steam Generator A', 'sgA.feedwaterFlowKgPerS', 'Feedwater inflow'], 399, 'kg/s', [150], false),
        drawn(['SG B', 'sgB', 'Steam generator level'], 'level 29.6 %'),
        drawn(['FCV B', 'feedwaterControlValveB'], '35 % open; commanded 100 % disagrees'),
      ], { lead: { item: 0, reason: 'Feedwater inflow · Steam Generator B: 140 kg/s, past LO ALM 150 kg/s' } }),
    )).toEqual([])
  })

  test('anything the answer marks as not shown', () => {
    expect(answerViewIssues(
      'Unit 2’s four steam-generator levels are each **19.5%**, below **LO TRIP 20%**. Auxiliary-feedwater header flow (not shown) is **332 kg/s**.' + FENCE,
      view(sgLevels(19.5), { lead: { item: 0, reason: 'SG-A-LVL-NR: 19.5 %, past LO TRIP 20 %' } }),
    )).toEqual([])
  })

  test('the check stays silent where the display shows what is cited, though a reviewer saw more (run 19 turbine-trip)', () => {
    // Subcooling margin fell fastest on the display, but it has no limit, so
    // no margin leads; that takes the trend's rates, which a compose result
    // does not have.
    expect(answerViewIssues(
      'Over the next minutes, watch steam-generator level and pressure for loss of heat removal, and pressurizer pressure and RCS subcooling margin for a worsening primary-side response. Pressurizer pressure is **15.7 MPa**, only **0.285 MPa below HI ALM 16 MPa**.' + FENCE,
      view([
        signal(['SG-A-LVL-NR', 'sgA.levelPercent', 'Steam generator level'], 72.6, '%', [20, 30]),
        signal(['SG-A-PRESS', 'sgA.pressureMPa', 'Steam generator pressure'], 8.19, 'MPa', [9.3]),
        signal(['PT-455', 'pressurizer.pressureMPa', 'Pressurizer pressure'], 15.715, 'MPa', [13.8, 14.8, 16]),
        signal(['SUB-MARGIN', 'vessel.subcoolingMarginC', 'RCS subcooling margin'], 31, '°C'),
      ], { span: { shownMs: 90_000, horizonMs: 600_000 }, lead: { item: 2, reason: 'PT-455: 15.7 MPa, 0.285 MPa below HI ALM 16 MPa' } }),
    )).toEqual([])
  })
})

// Trends as World now states them from the Run's history (evaluation run 21,
// reconstructed): rate per minute, direction, and the limit the legend names ahead.
const moving = (item: Item, rate: number, direction: 'rising' | 'falling' | 'steady', ahead?: { readonly name: string; readonly value: number; readonly timeToLimitMs?: number }): Item => ({
  ...item,
  trend: { rate, unit: item.values[0]!.unit, direction },
  ...(ahead === undefined ? {} : { limitAhead: { name: ahead.name, value: ahead.value, unit: item.values[0]!.unit }, ...(ahead.timeToLimitMs === undefined ? {} : { timeToLimitMs: ahead.timeToLimitMs }) }),
})
const pressure = (value: number) => signal(['PT-455', 'pressurizer.pressureMPa', 'Pressurizer pressure'], value, 'MPa', [13.8, 14.8, 16])
const siPressure = (value: number) => signal(['PT-455', 'pressurizer.pressureMPa', 'Pressurizer pressure'], value, 'MPa', [12.7, 13.8, 14.8, 16])

describe('answers that state a direction or limit the display shows otherwise', () => {
  test('production: the nearest limit named for a pressure falling toward the other one', () => {
    const view_ = view([moving(pressure(15.458), -1, 'falling', { name: 'LO ALM 14.8 MPa', value: 14.8, timeToLimitMs: 39_000 })], { lead: { item: 0, reason: 'PT-455: 15.5 MPa, falling 1.00 MPa/min, 0.658 MPa above LO ALM 14.8 MPa · ≈39 s' } })
    expect(answerViewIssues('Unit 2 pressurizer pressure (PT-455) is **15.46 MPa**, **0.542 MPa below HI ALM 16 MPa**.' + FENCE, view_)).toEqual([
      'It names HI ALM 16 MPa for PT-455, but the display names LO ALM 14.8 MPa as the limit ahead as it is falling: name LO ALM 14.8 MPa as the display does.',
    ])
    // Naming the limit ahead as the display does, the higher one may be mentioned too.
    expect(answerViewIssues('PT-455 is 15.46 MPa and falling, 0.658 MPa above LO ALM 14.8 MPa (about 39 s at this rate); HI ALM 16 MPa is behind it.' + FENCE, view_)).toEqual([])
  })

  test('a direction the trend shows the other way, or as moving where it is said to be stable', () => {
    expect(answerViewIssues('At sim 10:02:00 Unit 2 pressurizer pressure is rising at 15.46 MPa.' + FENCE, view([moving(pressure(15.458), -1, 'falling')]))).toEqual([
      'It says PT-455 is rising, but the display shows it falling 1 MPa/min.',
    ])
    // A denial after the direction does not deny it (sg-b-runback, turned around).
    expect(answerViewIssues('Unit 2 SG B is genuinely low and still trending up, not just reading oddly.' + FENCE, view([moving(sgLevels(29.6)[1]!, -2.25, 'falling', { name: 'LO TRIP 20 %', value: 20 })]))).toEqual([
      'It says SG-B-LVL-NR is rising, but the display shows it falling 2.25 %/min.',
    ])
    // turbine-trip: the four levels rise 25.2 %/min toward HI ALM 75 %.
    expect(answerViewIssues('Unit 2’s steam-generator levels are stable at about **73%**.' + FENCE, view(sgLevels(73).map(level => moving(level, 25.2, 'rising', { name: 'HI ALM 75 %', value: 75, timeToLimitMs: 5_000 }))))).toEqual([
      'It says SG-A-LVL-NR, SG-B-LVL-NR, SG-C-LVL-NR, SG-D-LVL-NR are steady, but the display shows them rising 25.2 %/min.',
    ])
  })
})

describe('answers whose directions and limits agree with the display', () => {
  test('porv-open: history in the past tense, and a direction the answer declines to state', () => {
    expect(answerViewIssues(
      'By sim 10:02:00, pressure had fallen from 15.49 to **4.01 MPa** over the recorded two minutes; the low-pressure reactor trip is active. The latest pressure is slightly above the sampled minimum of 3.97 MPa, so the evidence does not establish that it is *still* falling at this instant.' + FENCE,
      view([moving(pressure(4.01), 0.202, 'rising')], { span: { shownMs: 120_000, horizonMs: 120_000 } }),
    )).toEqual([])
  })

  test('sg-b-runback: past the low alarm, with the low trip named as the next limit', () => {
    expect(answerViewIssues(
      'At sim 10:03:00, Unit 2’s SG B narrow-range level is **29.6%**, just below **LO ALM 30%** and falling; SG A is 53.8%. **LO TRIP 20%** is the next level threshold shown.' + FENCE,
      view([moving(sgLevels(29.6)[1]!, -2.25, 'falling', { name: 'LO TRIP 20 %', value: 20, timeToLimitMs: 255_000 }), moving(signal(['SG-A-LVL-NR', 'sgA.levelPercent', 'Steam generator level'], 53.8, '%', [20, 30, 75]), -1.28, 'falling', { name: 'LO ALM 30 %', value: 30 })]),
    )).toEqual([])
  })

  test('a limit named by its order and value, as limits relabelled by function read, is the limit ahead', () => {
    expect(answerViewIssues('PT-455 is 13.2 MPa and falling, 0.5 MPa above LO-LO 12.7 · SI; HI ALM 16 MPa lies behind it.' + FENCE, view([moving(siPressure(13.2), -1, 'falling', { name: 'LO-LO 12.7 MPa · SI', value: 12.7 })]))).toEqual([])
  })

  test('loss-main-feedwater at 50 s: the limit ahead named with every action at it, by its order and value', () => {
    // World names coincident limits together, most severe first (QA review of run 22).
    const ahead = { name: 'LO-LO 20 % · RX TRIP + AFW START', value: 20, timeToLimitMs: 14_700 }
    const levels = view(sgLevels(28.7).map(level => moving(level, -35.6, 'falling', ahead)))
    expect(answerViewIssues('All four SG levels are 28.7 % and falling 35.6 %/min, 8.7 % above LO-LO 20 % · RX TRIP + AFW START (≈15 s).' + FENCE, levels)).toEqual([])
    expect(answerViewIssues('SG A level is 28.7 % and falling, 46.3 % below HI ALM 75 %.' + FENCE, view([moving(sgLevels(28.7)[0]!, -35.6, 'falling', ahead)]))).toEqual([
      'It names HI ALM 75 % for SG-A-LVL-NR, but the display names LO-LO 20 % · RX TRIP + AFW START as the limit ahead as it is falling: name LO-LO 20 % · RX TRIP + AFW START as the display does.',
    ])
  })

  test('turbine-trip: the limit ahead, and watching for either direction', () => {
    expect(answerViewIssues(
      'Over the next minutes, watch all four steam-generator levels for a fall or divergence. The levels are about **73%**, only **2 percentage points below HI ALM 75%**, so watch for a rise as well as a fall.' + FENCE,
      view(sgLevels(73).map(level => moving(level, 25.2, 'rising', { name: 'HI ALM 75 %', value: 75, timeToLimitMs: 5_000 })), { lead: { item: 0, reason: 'SG-A-LVL-NR: 73.0 %, rising 25.2 %/min, 2.02 % below HI ALM 75 % · ≈5 s' } }),
    )).toEqual([])
  })

  test('each item its own direction, and a slight change the display reads as steady', () => {
    const levels = [moving(sgLevels(55)[0]!, 1.2, 'rising'), moving(sgLevels(48)[1]!, -2.1, 'falling'), moving(sgLevels(55.1)[2]!, 0.02, 'steady')]
    expect(answerViewIssues('SG A level is rising at 55%, while SG B level is falling at 48%. SG C level is slightly rising.' + FENCE, view(levels))).toEqual([])
  })
})

// Evaluation run 22 (GPT-6 Sol) as World served it: the display projected
// ≈5 s for the SG levels and ≈48 s for subcooling. Without those times the
// legend projects none, as where its short and long rates disagree.
const sgLevelFalling = (sg: string, timeToLimitMs?: number) => moving(
  signal([`SG-${sg}-LVL-NR`, `sg${sg}.levelPercent`, 'Steam generator narrow-range level', `Steam generator narrow-range level · Steam Generator ${sg}`], 21.6946, '%', [20, 20, 30, 75, 82]),
  -21.2904, 'falling', { name: 'LO TRIP 20 %', value: 20, ...(timeToLimitMs === undefined ? {} : { timeToLimitMs }) },
)
const subcooling = (timeToLimitMs?: number) => moving(
  signal(['SUB-MARGIN', 'vessel.subcoolingMarginC', 'RCS subcooling margin', 'RCS subcooling margin · Reactor Vessel'], 33.2133, '°C', [0, 16.7]),
  -20.8267, 'falling', { name: 'LO ALM 16.7 °C', value: 16.7, ...(timeToLimitMs === undefined ? {} : { timeToLimitMs }) },
)
const TURBINE_TRIP = 'At current sim 10:01:00, **SG-A level leads the display**: 21.7% and falling 21.3%/min, just 1.69 percentage points above **LO TRIP 20%** (≈5 s at the sampled rate); SG-B shows the same trend.' + FENCE
const RCP_TRIP = 'At current sim 10:01:00, SUB-MARGIN is 33.2 °C but falling 20.8 °C/min, about 48 s from LO ALM 16.7 °C if that rate persists.' + FENCE

describe('answers that give a time to a limit', () => {
  test('turbine-trip and rcp-trip: a time the display does not project', () => {
    expect(answerViewIssues(TURBINE_TRIP, view([sgLevelFalling('A'), sgLevelFalling('B')]))).toEqual([
      'It gives ≈5 s to LO TRIP 20% for SG-A-LVL-NR, but the display projects no time to it: give the rate and margin it shows, without a time.',
    ])
    expect(answerViewIssues(RCP_TRIP, view([subcooling()]))).toEqual([
      'It gives about 48 s to LO ALM 16.7 °C for SUB-MARGIN, but the display projects no time to it: give the rate and margin it shows, without a time.',
    ])
  })

  test('a time worked out from the rate, or far from the one the display projects', () => {
    expect(answerViewIssues('SG A level is 21.7% and falling 21.3%/min; at this rate it will reach LO TRIP 20% in about 5 seconds.' + FENCE, view([sgLevelFalling('A')]))).toEqual([
      'It gives about 5 seconds to LO TRIP 20% for SG-A-LVL-NR, but the display projects no time to it: give the rate and margin it shows, without a time.',
    ])
    expect(answerViewIssues('SUB-MARGIN is 33.2 °C, about 3 min from LO ALM 16.7 °C.' + FENCE, view([subcooling(47_573)]))).toEqual([
      'It gives about 3 min to LO ALM 16.7 °C for SUB-MARGIN, but the display projects ≈48 s: give that time or none.',
    ])
  })

  test('a limit named by its order and value, as relabelled limits read', () => {
    expect(answerViewIssues('PT-455 is 13.2 MPa and falling, ≈30 s from LO-LO 12.7 · SI.' + FENCE, view([moving(siPressure(13.2), -1, 'falling', { name: 'LO-LO 12.7 MPa · SI', value: 12.7 })]))).toEqual([
      'It gives ≈30 s to LO-LO 12.7 for PT-455, but the display projects no time to it: give the rate and margin it shows, without a time.',
    ])
  })
})

describe('answers whose times agree with the display', () => {
  test('turbine-trip and rcp-trip: the time the display projects, rounded', () => {
    expect(answerViewIssues(TURBINE_TRIP, view([sgLevelFalling('A', 4_776), sgLevelFalling('B', 4_776)]))).toEqual([])
    expect(answerViewIssues(RCP_TRIP, view([subcooling(47_573)]))).toEqual([])
    expect(answerViewIssues('SUB-MARGIN is falling, about a minute from LO ALM 16.7 °C (≈1 min at this rate).' + FENCE, view([subcooling(47_573)]))).toEqual([])
  })

  test('time gone by, a window, a return inside a passed limit and a time with no limit', () => {
    const levels = view([sgLevelFalling('A'), moving(pressure(14.39), 1.04, 'rising')], { span: { shownMs: 60_000, horizonMs: 600_000 } })
    for (const answer of [
      'The OTΔT trip came 14 s before the SI actuation on LO-LO TRIP 12.7 MPa.',
      'SG A level fell below LO TRIP 20% in 45 s, so auxiliary feedwater will start.',
      'Over the last 1 min, SG A level fell toward LO TRIP 20%.',
      'Pressurizer pressure is back above LO ALM 14.8 MPa in ≈23 s at this rate.',
      'Natural circulation takes 5–15 min to establish; verify that subcooling stays above LO ALM 16.7 °C and core-exit temperature (not shown) stops rising.',
      'The trend reaches back ≈1 min of history; SG A is 1.69 percentage points above LO TRIP 20%.',
      'If SG A level reaches LO TRIP 20% within 1 min, verify auxiliary feedwater (not shown) has started.',
    ]) expect(answerViewIssues(answer + FENCE, levels).filter(issue => issue.startsWith('It gives'))).toEqual([])
  })
})

describe('answers that cite more finely than their display writes, or name another lead', () => {
  // A value as World now publishes it: with the decimals the display writes it with.
  const written = (names: ReadonlyArray<string>, value: number, unit: string, decimals: number, limits: ReadonlyArray<number> = []): Item =>
    ({ names: [...names], values: [{ value, unit, decimals }], limits: limits.map(limit => ({ value: limit, unit, decimals: String(limit).split('.')[1]?.length ?? 0 })), history: true })
  const afwHeader = written(['AFW-FLOW', 'auxFeedwaterHeader.outletFlowKgPerS', 'Process header outlet flow'], 107.33, 'kg/s', 0)

  test('run 23: flows quoted to more digits than the display shows them', () => {
    // turbine-trip: the display writes 107 kg/s.
    expect(answerViewIssues('AFW actuation and reactor trip have annunciated; AFW-FLOW reads 107.33 kg/s, but level recovery is not yet confirmed.' + FENCE, view([afwHeader]))).toEqual([
      'It cites 107.33 kg/s, more precisely than the display shows it (107 kg/s): cite it as the display does.',
    ])
    // show-feed-lineup: a drawn header's flow, written in whole kg/s.
    const header: Item = { names: ['Main Feedwater Header', 'mainFeedwaterHeader', 'Process header outlet flow'], values: [{ value: 1512.45, unit: 'kg/s', decimals: 0 }], limits: [], history: false, state: 'flowing' }
    expect(answerViewIssues('At sim 10:01:00, the displayed header outlet flow is 1512.45 kg/s.' + FENCE, view([header]))).toEqual([
      'It cites 1512.45 kg/s, more precisely than the display shows it (1512 kg/s): cite it as the display does.',
    ])
  })

  test('a value as written, a coarser one, one in another unit and a margin worked out between two all pass', () => {
    const level = written(['SG-A-LVL-NR', 'sgA.levelPercent', 'Steam generator narrow-range level'], 17.9348, '%', 1, [20])
    expect(answerViewIssues('SG-A-LVL-NR reads 17.9 %, 2.1 percentage points below LO-LO 20 %; AFW-FLOW is about 107 kg/s.' + FENCE, view([level, afwHeader]))).toEqual([])
    const pressure = written(['PT-455', 'pressurizer.pressureKPa', 'Pressurizer pressure'], 15_455.7, 'kPa', 0)
    expect(answerViewIssues('Pressurizer pressure is 15.46 MPa.' + FENCE, view([pressure]))).toEqual([])
    expect(answerViewIssues('Pressurizer pressure is 15.4557 MPa.' + FENCE, view([pressure]))).toEqual([
      'It cites 15.4557 MPa, more precisely than the display shows it (15456 kPa): cite it as the display does.',
    ])
  })

  test('rcp-trip: a lead the answer names that is not the one the display leads with', () => {
    const answer = '**Core cooling is not yet confirmed to be holding.** On the paused Unit 2 Run at sim 10:01:00, the display leads with pressurizer pressure at 13.8 MPa, past **LO 14.8 MPa · ALM**. Core-exit temperature is 297 °C and rising, while RCS subcooling margin is 38.3 °C and falling.' + FENCE
    const items = [
      written(['CET-AVG', 'core.coreExitTemperatureC', 'Core-exit temperature'], 297.092, '°C', 0),
      written(['SUB-MARGIN', 'vessel.subcoolingMarginC', 'RCS subcooling margin'], 38.2522, '°C', 1, [0, 16.7]),
      written(['PT-455', 'pressurizer.pressureMPa', 'Pressurizer pressure'], 13.7652, 'MPa', 1, [14.8]),
    ]
    expect(answerViewIssues(answer, view(items, { lead: { item: 0, reason: 'CET-AVG: 297 °C, rising 5.74 °C/min' } }))).toEqual([
      'It says the display leads with pressurizer pressure at 13.8 MPa, but it leads with CET-AVG: 297 °C, rising 5.74 °C/min: name that.',
    ])
    // As served in run 23 the display led with PT-455, as the answer said.
    expect(answerViewIssues(answer, view(items, { lead: { item: 2, reason: 'PT-455: 13.8 MPa, past LO 14.8 MPa · ALM' } }))).toEqual([])
    // A claim that names no item is left alone (the lead is still missing).
    expect(answerViewIssues('The display leads with that trend; SG B leads the display too.' + FENCE, view(items, { lead: { item: 0, reason: 'CET-AVG: 297 °C' } }))).toEqual([
      'It leaves out what the display leads with: CET-AVG: 297 °C.',
    ])
    expect(answerViewIssues('Core-exit temperature leads the display at 297 °C.' + FENCE, view(items, { lead: { item: 1, reason: 'SUB-MARGIN: 38.3 °C' } }))).toEqual([
      'It says the display leads with Core-exit temperature, but it leads with SUB-MARGIN: 38.3 °C: name that.',
    ])
  })
})
