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
