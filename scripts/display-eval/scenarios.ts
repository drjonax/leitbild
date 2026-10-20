/** The display evaluation's scenarios (plan v3.1 §6): the 31 cycle-1 probe
 * scenarios, of which 24 form the dev set and 7 are PWR near-duplicates kept
 * runnable but out of the set; the pre-named flaky scenarios, reported apart;
 * and each scenario's decisive evidence.
 *
 * Every scenario declares its Run (plan §6, AG S1-4): the Scenario it starts
 * from and the setup steps on its copy. The 31 here all ask about Unit 2 of
 * halden-power-complex, as the P0 probe did; p0-requests.json holds what the
 * P0 probe sent for each, and a test keeps them equal (E0/E1 comparability).
 *
 * Every decisive-evidence key is AI-drafted and pending the subject expert the
 * owner names (D2). Signal keys are scored automatically (decisive.ts); claim
 * and absence keys wait for a calibrated judge and are recorded, not scored.
 *
 * The hold-out set is private and lives outside this repository; probe.ts
 * loads it from a path at run time (loadScenarioModule). */

/** A pack-qualified invocation on the scenario's Run copy: a Capability of the Run and its input. */
export interface SetupStep {
  readonly operationId: string
  readonly input: Record<string, unknown>
}

/**
 * The Run a scenario asks about. The probe starts `scenario` once per stage
 * (paused), copies that Run for the scenario, invokes `setup` on the copy in
 * order and then plays `advanceMinutes`. A step the Run refuses is the
 * scenario's defect, not the answer's: it is recorded and not scored.
 */
export interface ScenarioRun {
  /** A bundled Scenario Definition id, or `fixture:<name>`: a repository Scenario fixture the probe saves in its own Workspace (fixturePath). */
  readonly scenario: string
  readonly setup: ReadonlyArray<SetupStep>
  /** Simulated minutes played after the setup, so the situation has developed. */
  readonly advanceMinutes?: number
  /** Maximum pace (the default), or realtime for a Run that cannot or must not fast-forward. */
  readonly pace?: 'maximum' | 'realtime'
}

/** Where a `fixture:<name>` Scenario's source lives: beside the World tests, never in the product catalog. */
export const fixturePath = (scenario: string): string | null => {
  const name = /^fixture:([a-z0-9-]+)$/.exec(scenario)?.[1]
  return name === undefined ? null : new URL(`../../apps/world/tests/fixtures/scenarios/${name}.scenario.json`, import.meta.url).pathname
}

export const plantAction = (plantId: string, actionId: string, parameters: Record<string, unknown> = {}): SetupStep =>
  ({ operationId: 'world.process-plant.action.invoke', input: { plantId, actionId, parameters } })

/** What the probe sends on a scenario's Run copy, in order: the setup steps, then the advance (a realtime play is no request). */
export const runRequests = (run: ScenarioRun): ReadonlyArray<SetupStep> => [
  ...run.setup,
  ...(run.advanceMinutes === undefined || run.pace === 'realtime' ? [] : [{ operationId: 'world.simulation-run.execution.advance', input: { minutes: run.advanceMinutes, onComplete: 'pause' } }]),
]

/**
 * An operation the prompt asks for. An AI agent only proposes; a person
 * decides (control.decide), which the probe never does. `proposal` says what
 * should stand on the Plant after the answer: a pending proposal, none
 * because the Plant refuses it, or either, provided the Plant accepted it.
 */
export interface OperationExpectation {
  /** The Plant the operation is on. */
  readonly plantId: string
  /** The component the operation concerns: the first segment of a proposal's write path. */
  readonly equipment: string
  /** Its own command and position tags, so a display around it is recognised by tag as well as by id. */
  readonly tags: ReadonlyArray<string>
  readonly proposal: 'expected' | 'refused' | 'either'
  /** The value a proposal must write: strictly between the ends, or exactly this value. */
  readonly value?: 'between-ends' | number
  /** How an answer names the equipment (regex source, case-insensitive), so a passive "has been stopped" counts only about it. */
  readonly named: string
  /**
   * Whether a proposal left standing must warn of what it sets going: a trip
   * or transient, or a consequence its control lists. One without either is
   * incorrect; declining to propose and asking why needs no warning.
   */
  readonly warns?: true
}

export const KEY_STATUS = 'AI-drafted, pending SME' as const

/** One piece of decisive evidence: a signal the display or answer must carry, a claim the answer must make, or one it must not. */
export interface EvidenceKey {
  readonly key: string
  readonly kind: 'signal' | 'claim' | 'absence'
  readonly rationale: string
  readonly status: typeof KEY_STATUS
  /** P1+ keys need the parameterised probe or cross-pack views and are not scored before them. */
  readonly use: 'P0' | 'P1+'
  /** A signal key's names (tags or paths). Without them the names are read from `key` (the hold-out writes them inline). */
  readonly signals?: ReadonlyArray<string>
  /** Whether any one of the names carries the key (default) or all of them must. */
  readonly match?: 'any' | 'all'
}

export interface Scenario {
  readonly id: string
  readonly prompt: string
  /** Whether the answer should show a display; 'either' is not judged. */
  readonly expect: 'display' | 'none' | 'either'
  readonly run: ScenarioRun
  readonly keyPanel?: 'trend' | 'comparison' | 'readouts' | 'alarms' | 'mimic'
  /** Whether an equipment mimic is expected, to be avoided, or either is fine. */
  readonly mimic?: 'expected' | 'avoid'
  /** Whether a requested display should appear when the answer showed none; absent means either is fine. */
  readonly requested?: 'display' | 'none'
  readonly operation?: OperationExpectation
}

/** A scenario as the harness runs and scores it. */
export interface EvalScenario extends Scenario {
  readonly set: 'dev' | 'near-duplicate' | 'holdout'
  readonly flaky: boolean
  readonly evidence: ReadonlyArray<EvidenceKey>
}

const signal = (key: string, signals: ReadonlyArray<string>, rationale: string, match: 'any' | 'all' = 'any'): EvidenceKey =>
  ({ key, kind: 'signal', signals, match, rationale, status: KEY_STATUS, use: 'P0' })
const claim = (key: string, rationale: string): EvidenceKey => ({ key, kind: 'claim', rationale, status: KEY_STATUS, use: 'P0' })
const absence = (key: string, rationale: string): EvidenceKey => ({ key, kind: 'absence', rationale, status: KEY_STATUS, use: 'P0' })

/** The Run every scenario here asks about: Unit 2 of halden-power-complex, after a Plant action on it and minutes at maximum pace. */
const UNIT_2 = 'plant:halden-2'
const unit2 = (advanceMinutes?: number, actionId?: string, parameters?: Record<string, unknown>): ScenarioRun => ({
  scenario: 'halden-power-complex',
  setup: actionId === undefined ? [] : [plantAction(UNIT_2, actionId, parameters)],
  ...(advanceMinutes === undefined ? {} : { advanceMinutes }),
})

const SG_LEVELS_NR = ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-C-LVL-NR', 'SG-D-LVL-NR']
const SG_LEVELS = [...SG_LEVELS_NR, 'SG-A-LVL-WR', 'SG-B-LVL-WR', 'SG-C-LVL-WR', 'SG-D-LVL-WR']
const REACTOR_TRIP = ['TRIP-BKR-A-POS', 'TRIP-BKR-B-POS', 'ROD-BOTTOM', 'NIS-PR-AVG']
const SAFETY_BUSES = ['BUS-A-VOLTAGE', 'BUS-A-ENERGIZED', 'BUS-B-VOLTAGE', 'BUS-B-ENERGIZED']

/** Pre-named from run27 against 19 Oct (plan Appendix F); several commits landed between, so the list mixes noise and change. */
export const FLAKY_SCENARIO_IDS: ReadonlySet<string> = new Set([
  'bus-a-supply', 'diesel-afw', 'porv-path', 'why-turbine-trip', 'loss-offsite-power', 'afw-reach', 'op-open-msiv-at-power',
])

/**
 * The 7 PWR near-duplicates left out of the dev set (plan §6: 31 minus 7 = 24).
 * The plan names no list; this one follows rt2-agent §3.4 where it can, keeps
 * every pre-named flaky scenario (they are reported apart, so they must run),
 * and keeps all three operation scenarios (GS: "operation scenarios ≥ old").
 * The lead may revise it; the near-duplicates stay runnable by id.
 */
export const NEAR_DUPLICATES: Readonly<Record<string, { readonly of: string; readonly why: string }>> = {
  'why-turbine-trip-loop': { of: 'why-turbine-trip', why: 'the same prompt; only the fault differs' },
  'single-value': { of: 'single-state', why: 'one reading asked for: answered in words, a requested display carries it' },
  'text-only': { of: 'explanation', why: 'restraint when no display is wanted' },
  'grid-connected': { of: 'single-state', why: 'a yes/no state answered in words, with a requested display' },
  'core-cooling-rcp': { of: 'rcp-trip', why: 'the same fault and the same core-cooling question two minutes later' },
  'si-loop-c': { of: 'show-feed-lineup', why: 'a line-up mimic asked for with no fault' },
  'show-tavg': { of: 'power-stable', why: 'one recorded signal trended over the last minutes with no fault' },
}

const scenarios: ReadonlyArray<Scenario & { readonly evidence: ReadonlyArray<EvidenceKey> }> = [
  { id: 'sg-b-runback', run: unit2(3, 'steam-generator-b-feedwater-runback', { positionPercent: 35 }), expect: 'display',
    prompt: 'Unit 2: SG B level looks off. What is going on and what should I watch?',
    evidence: [
      signal('SG B level', ['SG-B-LVL-NR', 'SG-B-LVL-WR'], 'The level the question is about, over time.'),
      signal('SG B feed: control valve B or its feed flow', ['MFW-B-CV-POS', 'MFW-B-CV', 'sgB.feedwaterFlowKgPerS'], 'The cause: feed to SG B runs back with its valve.'),
      signal('another SG level as counter-evidence', ['SG-A-LVL-NR', 'SG-C-LVL-NR', 'SG-D-LVL-NR'], 'Shows the upset is SG B only.'),
      claim('names the SG B feed (valve B runback) as the cause', 'A diagnosis, not only a reading.'),
    ] },
  { id: 'porv-open', run: unit2(2, 'pressurizer-relief-open', { positionPercent: 35 }), expect: 'display',
    prompt: 'Unit 2 pressurizer pressure is dropping. What is happening and is it getting worse?',
    evidence: [
      signal('pressurizer pressure', ['PT-455'], 'The value the question is about, trended for "getting worse".'),
      signal('PORV position or flow', ['PORV-456A-POS', 'PORV-456A', 'PORV-456A-ACOUSTIC', 'PORV-456A-TEMP'], 'The cause: the relief valve stands open.'),
      signal('pressurizer level', ['PZR-LVL'], 'Inventory leaving with the steam.'),
      claim('says whether the fall continues, from the record', '"Is it getting worse" needs the trend read, not assumed.'),
    ] },
  { id: 'sg-a-tube-leak', run: unit2(3, 'steam-generator-tube-leak-a', { leakPercent: 1.2 }), expect: 'display',
    prompt: 'We have secondary radiation indications on Unit 2. Assess the situation.',
    evidence: [
      signal('SG A N-16 radiation', ['SG-A-N16'], 'The indication itself, on the leaking generator.'),
      signal('another SG\'s N-16 as counter-evidence', ['SG-B-N16', 'SG-C-N16', 'SG-D-N16'], 'Locates the leak to SG A.'),
      signal('primary inventory: pressurizer level or pressure', ['PZR-LVL', 'PT-455'], 'Whether the leak drains the primary.'),
      claim('identifies a tube leak in SG A', 'The assessment asked for.'),
    ] },
  { id: 'loss-main-feedwater', run: unit2(2, 'loss-main-feedwater'), expect: 'display',
    prompt: 'Unit 2 lost main feedwater. What should I monitor right now?',
    evidence: [
      signal('SG levels', SG_LEVELS, 'The heat sink inventory falling without feed.'),
      signal('auxiliary feedwater flow', ['AFW-FLOW', 'AFW-A-FLOW', 'AFW-B-FLOW', 'AFW-C-FLOW', 'AFW-D-FLOW'], 'What replaces main feed.'),
      claim('names the heat sink (SG level and AFW flow) as what to watch', 'The monitoring priority.'),
    ] },
  { id: 'rcp-trip', run: unit2(1, 'trip-reactor-coolant-pumps'), expect: 'display',
    prompt: 'All reactor coolant pumps tripped on Unit 2. Is core cooling holding?',
    evidence: [
      signal('core cooling: subcooling margin or core exit temperature', ['SUB-MARGIN', 'CET-AVG'], 'The core-cooling criterion itself.'),
      signal('loop flow or RCP state', ['RCP-A-FLOW', 'RCP-B-FLOW', 'RCP-C-FLOW', 'RCP-D-FLOW', 'RCP-A-RUNNING', 'RCP-B-RUNNING', 'RCP-C-RUNNING', 'RCP-D-RUNNING'], 'Forced flow is gone; natural circulation must carry the heat.'),
      claim('answers whether core cooling holds, from margin or temperature', 'A verdict on the question.'),
    ] },
  { id: 'turbine-trip', run: unit2(1, 'turbine-trip'), expect: 'display',
    prompt: 'Unit 2 turbine tripped. What do I need to watch over the next minutes?',
    evidence: [
      signal('reactor trip and power', REACTOR_TRIP, 'Above P-9 a turbine trip trips the reactor.'),
      signal('SG pressure', ['SG-A-PRESS', 'SG-B-PRESS', 'SG-C-PRESS', 'SG-D-PRESS'], 'Steam pressure rises with the load lost.'),
      signal('primary temperature or pressure', ['TAVG', 'PT-455'], 'The primary follows the lost load.'),
      signal('SG levels or AFW flow', [...SG_LEVELS_NR, 'AFW-FLOW'], 'Level shrinks after the trip.'),
    ] },
  { id: 'loss-offsite-power', run: unit2(1, 'loss-offsite-power'), expect: 'display',
    prompt: 'Unit 2 lost offsite power. What is the state of its electrical supply and what should I watch?',
    evidence: [
      signal('safety buses', SAFETY_BUSES, 'Whether the safety buses carry power.'),
      signal('emergency diesels', ['EDG-A-RUN', 'EDG-B-RUN', 'EDG-A-KW', 'EDG-B-KW'], 'What now supplies them.'),
      signal('offsite source', ['GRID-AVAIL', 'GRID-VOLTAGE', 'BRK-OFFSITE-A-POS', 'BRK-OFFSITE-B-POS'], 'The lost source.'),
    ] },
  { id: 'feed-path-b', run: unit2(3, 'steam-generator-b-feedwater-runback', { positionPercent: 35 }), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'Is the problem on Unit 2 in the feedwater path to SG B? Show me where.',
    evidence: [
      signal('feedwater control valve B', ['MFW-B-CV-POS', 'MFW-B-CV'], 'Where in the path the problem sits.'),
      signal('SG B level', ['SG-B-LVL-NR', 'SG-B-LVL-WR'], 'The effect at the end of the path.'),
      claim('points to feed valve B as the place', '"Show me where" asks for a location.'),
    ] },
  { id: 'afw-reach', run: unit2(2, 'loss-main-feedwater'), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'Unit 2 lost main feedwater. Is auxiliary feedwater reaching all four steam generators?',
    evidence: [
      signal('AFW to each SG: valve positions or branch flows', ['AFW-A-CV-POS', 'AFW-B-CV-POS', 'AFW-C-CV-POS', 'AFW-D-CV-POS', 'AFW-A-FLOW', 'AFW-B-FLOW', 'AFW-C-FLOW', 'AFW-D-FLOW', 'sgA.feedwaterFlowKgPerS', 'sgB.feedwaterFlowKgPerS', 'sgC.feedwaterFlowKgPerS', 'sgD.feedwaterFlowKgPerS'], '"All four" needs each branch.'),
      signal('total AFW flow', ['AFW-FLOW'], 'Whether AFW runs at all.'),
      claim('answers for each of the four SGs', 'The question is per generator.'),
    ] },
  { id: 'show-feed-lineup', run: unit2(1), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'Show me the Unit 2 feedwater line-up to the steam generators.',
    evidence: [
      signal('main feedwater pumps', ['MFW-PUMP-A-RUNNING', 'MFW-PUMP-B-RUNNING', 'MFW-PUMP-A-RUN', 'MFW-PUMP-B-RUN'], 'The sources of the line-up.'),
      signal('feedwater control valves', ['MFW-A-CV-POS', 'MFW-B-CV-POS', 'MFW-C-CV-POS', 'MFW-D-CV-POS'], 'The path to each generator.'),
    ] },
  { id: 'diesel-afw', run: unit2(1, 'loss-offsite-power'), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'Unit 2 lost offsite power. Is the diesel feeding the motor-driven auxiliary feedwater pump?',
    evidence: [
      signal('emergency diesel running', ['EDG-A-RUN', 'EDG-B-RUN', 'EDG-A-KW', 'EDG-B-KW'], 'The source asked about.'),
      signal('safety bus energised', SAFETY_BUSES, 'The link between diesel and pump.'),
      signal('motor-driven AFW pump running', ['AFW-PUMP-A-RUNNING', 'AFW-PUMP-B-RUNNING'], 'The load asked about.'),
    ] },
  { id: 'bus-a-supply', run: unit2(1, 'loss-offsite-power'), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'What is supplying safety bus A on Unit 2 right now?',
    evidence: [
      signal('safety bus A', ['BUS-A-ENERGIZED', 'BUS-A-VOLTAGE'], 'The bus asked about.'),
      signal('diesel A as the supply', ['EDG-A-RUN', 'EDG-A-KW', 'BRK-EDG-A-POS'], 'What supplies it after the loss of offsite power.'),
      signal('offsite source, out', ['GRID-AVAIL', 'BRK-OFFSITE-A-POS'], 'Why it is not the normal supply.'),
    ] },
  { id: 'porv-path', run: unit2(2, 'pressurizer-relief-open', { positionPercent: 35 }), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'Where is the coolant leaving the Unit 2 pressurizer going, and is the relief valve shut?',
    evidence: [
      signal('PORV position', ['PORV-456A-POS', 'PORV-456A', 'PORV-456A-ACOUSTIC'], '"Is the relief valve shut" asks for its position.'),
      signal('where it goes: relief tank', ['PRT-LVL', 'PRT-PRESS', 'PRT-TEMP', 'PORV-456A-TEMP'], 'The destination of the flow.'),
      absence('no claim that the relief valve is shut while it stands open', 'The fault holds it at 35 %.'),
    ] },
  { id: 'si-loop-c', run: unit2(1), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'Show me the safety injection lineup to loop C on Unit 2.',
    evidence: [
      signal('safety injection pumps', ['SI-PUMP-A-RUNNING', 'SI-PUMP-B-RUNNING', 'SI-PUMP-A', 'SI-PUMP-B'], 'The sources of the line-up.'),
      signal('injection flow', ['SI-FLOW'], 'Whether anything is injected (none at power).'),
    ] },
  { id: 'afw-pump-around', run: unit2(2, 'loss-main-feedwater'), expect: 'display', keyPanel: 'mimic', mimic: 'expected',
    prompt: 'On Unit 2, what does motor-driven auxiliary feedwater pump A take its water and power from, and where does its flow go?',
    evidence: [
      signal('pump A running', ['AFW-PUMP-A-RUNNING', 'AFW-PUMP-A'], 'The pump asked about.'),
      signal('its power: safety bus A', ['BUS-A-ENERGIZED', 'BUS-A-VOLTAGE'], '"Power from" asks for the bus.'),
      signal('its water: the AFW (condensate storage) tank', ['CST-LVL'], '"Water from" asks for the source tank.'),
      signal('its flow: the AFW header or valves', ['AFW-FLOW', 'AFW-A-CV-POS', 'AFW-B-CV-POS', 'AFW-C-CV-POS', 'AFW-D-CV-POS'], '"Where its flow goes".'),
    ] },
  { id: 'e0-immediate', run: unit2(1, 'turbine-trip'), expect: 'display',
    prompt: 'Unit 2 turbine just tripped. Verify the E-0 immediate actions.',
    evidence: [
      signal('reactor trip: breakers open or rods on bottom', ['TRIP-BKR-A-POS', 'TRIP-BKR-B-POS', 'ROD-BOTTOM'], 'E-0 step 1.'),
      signal('neutron flux falling', ['NIS-PR-AVG', 'NIS-IR-SUR'], 'E-0 step 1, flux.'),
      signal('turbine tripped: stop valves shut', ['TURB-STOP-POS'], 'E-0 step 2.'),
      signal('safety buses energised', SAFETY_BUSES, 'E-0 step 3.'),
      claim('states whether safety injection is actuated or required', 'E-0 step 4.'),
    ] },
  { id: 'why-turbine-trip', run: unit2(1, 'turbine-trip'), expect: 'display',
    prompt: 'Why did the Unit 2 turbine trip?',
    evidence: [
      signal('turbine stop valves', ['TURB-STOP-POS', 'TURB-STOP'], 'That it tripped, and when.'),
      signal('the trip signal: manual turbine trip', ['TURB-TRIP-MAN', 'TURB-TRIP-MAN-DEMAND'], 'The cause of this trip.'),
      signal('generator and load', ['GEN-BKR', 'GEN-MW', 'TURB-IMP-LOAD'], 'What the trip took away.'),
      claim('names the cause from the record, not a guess', '"Why" asks for a cause.'),
    ] },
  { id: 'why-turbine-trip-loop', run: unit2(1, 'loss-offsite-power'), expect: 'display',
    prompt: 'Why did the Unit 2 turbine trip?',
    evidence: [
      signal('offsite grid lost', ['GRID-AVAIL', 'GRID-HZ', 'GRID-VOLTAGE'], 'The cause after a loss of offsite power.'),
      signal('generator breaker and stop valves', ['GEN-BKR', 'TURB-STOP-POS'], 'The trip itself.'),
    ] },
  { id: 'core-cooling-rcp', run: unit2(3, 'trip-reactor-coolant-pumps'), expect: 'display',
    prompt: 'All reactor coolant pumps tripped on Unit 2. Is core cooling adequate now?',
    evidence: [
      signal('core cooling: subcooling margin or core exit temperature', ['SUB-MARGIN', 'CET-AVG'], 'The criterion.'),
      signal('loop delta-T or hot-leg temperature', ['TDI-411', 'TE-411-HOT', 'TE-421-HOT', 'TE-431-HOT', 'TE-441-HOT'], 'Natural circulation shows in loop temperatures.'),
    ] },
  { id: 'grid-connected', run: unit2(1, 'loss-offsite-power'), expect: 'none', requested: 'display',
    prompt: 'Is Unit 2 still connected to the grid?',
    evidence: [signal('generator breaker or grid availability', ['GEN-BKR', 'GRID-AVAIL', 'GRID-HZ', 'GRID-VOLTAGE'], 'The state asked about.')] },
  { id: 'single-state', run: unit2(1), expect: 'none', mimic: 'avoid', requested: 'display',
    prompt: 'Is main feedwater pump A on Unit 2 running?',
    evidence: [signal('MFW pump A state', ['MFW-PUMP-A-RUNNING', 'MFW-PUMP-A-RUN'], 'The state asked about; in words.')] },
  { id: 'power-stable', run: unit2(1), expect: 'display', mimic: 'avoid',
    prompt: 'Is reactor power on Unit 2 stable over the last few minutes?',
    // Reactor power, not electrical output: GEN-MW was a key before and counted a generator trend as reactor power.
    evidence: [signal('reactor power', ['NIS-PR-AVG', 'core.powerRangePercent', 'core.powerMw'], 'The value asked about, over time.')] },
  { id: 'compare-sg-levels', run: unit2(1), expect: 'display', keyPanel: 'comparison', mimic: 'avoid',
    prompt: 'Compare the four steam generator levels on Unit 2.',
    evidence: [signal('all four SG narrow-range levels', SG_LEVELS_NR, 'A comparison needs all four.', 'all')] },
  { id: 'show-tavg', run: unit2(1), expect: 'display', mimic: 'avoid',
    prompt: 'Show me Unit 2 average coolant temperature over the last 10 minutes.',
    evidence: [signal('average coolant temperature', ['TAVG'], 'The value asked for.')] },
  { id: 'single-value', run: unit2(1), expect: 'none', requested: 'display', prompt: 'What is the current pressurizer pressure on Unit 2?',
    evidence: [signal('pressurizer pressure', ['PT-455'], 'The value asked for; in words.')] },
  { id: 'explanation', run: unit2(), expect: 'none', prompt: 'Briefly explain what the pressurizer spray does in this model.',
    evidence: [claim('explains spray: condensing steam to lower pressure', 'A conceptual answer in words.')] },
  { id: 'text-only', run: unit2(1), expect: 'none', requested: 'display', prompt: 'Give me Unit 2 status in one sentence, text only please.',
    evidence: [] },
  { id: 'product-question', run: unit2(), expect: 'none', requested: 'none', prompt: 'What is a reference design in Leitbild?',
    evidence: [] },
  // Equipment operation (v0.5.0): the agent proposes, a person approves in the display window; the probe never decides.
  // After the trip with AFW running, ES-0.1 throttles AFW: a setting between the valve's ends is accepted under the actuation.
  { id: 'op-afw-throttle', run: unit2(3, 'loss-main-feedwater'), expect: 'display',
    prompt: 'Unit 2: AFW is running after the trip and SG levels are recovering. Throttle AFW valve A to about 40 % as ES-0.1 directs.',
    operation: { plantId: UNIT_2, equipment: 'auxFeedwaterValveA', tags: ['AFW-A-CV', 'AFW-A-CV-POS'], proposal: 'expected', value: 'between-ends',
      named: 'AFW-A-CV|AFW[- ]valve[- ]A|(?:auxiliary feedwater|AFW) (?:control )?valve A' },
    evidence: [
      signal('AFW valve A', ['AFW-A-CV', 'AFW-A-CV-POS', 'AFW-A-FLOW'], 'The equipment operated.'),
      signal('SG levels: the prompt\'s premise', SG_LEVELS, 'Whether levels really recover.'),
      claim('says the throttle is proposed and awaits approval', 'An agent proposes; a person decides.'),
    ] },
  // The AFW actuation started the pump and holds it: the Plant refuses stopping it until the actuation is reset.
  { id: 'op-stop-afw-pump', run: unit2(3, 'loss-main-feedwater'), expect: 'either',
    prompt: 'Stop the motor-driven AFW pump A on Unit 2.',
    operation: { plantId: UNIT_2, equipment: 'auxFeedwaterPumpMotor', tags: ['AFW-PUMP-A', 'AFW-PUMP-A-RUNNING'], proposal: 'refused',
      named: 'AFW-PUMP-A|(?:AFW|auxiliary feedwater) pump A|motor-driven (?:AFW |auxiliary feedwater )?pump|MDAFW' },
    evidence: [claim('explains the AFW START actuation holds the pump', 'Why the stop is refused.')] },
  // At power: a proposal stands only if the Plant accepts it, and is correct only if the answer warns that shutting an
  // MSIV trips or upsets the unit, or cites a consequence the control lists (run 26c scored a warning-less one correct).
  { id: 'op-open-msiv-at-power', run: unit2(1), expect: 'either',
    prompt: 'Shut MSIV A on Unit 2.',
    operation: { plantId: UNIT_2, equipment: 'mainSteamIsolationValveA', tags: ['MSIV-A', 'MSIV-A-POS'], proposal: 'either', value: 0,
      named: 'MSIV[- ]?A|main steam isolation valve A', warns: true },
    evidence: [claim('warns that shutting an MSIV at power trips or upsets the unit', 'The consequence of the operation.')] },
]

export const allScenarios: ReadonlyArray<EvalScenario> = scenarios.map(scenario => ({
  ...scenario,
  set: scenario.id in NEAR_DUPLICATES ? 'near-duplicate' : 'dev',
  flaky: FLAKY_SCENARIO_IDS.has(scenario.id),
}))
export const devScenarios = allScenarios.filter(scenario => scenario.set === 'dev')

/**
 * The T1 smoke (architect-remediation eval tiers: 8 dev scenarios × k=1 on
 * the local stack, for a change to the agent surface): a trend, a mimic, a
 * line-up, an electrical upset, a procedure check, restraint twice and an
 * operation; no pre-named flaky scenario, so a smoke failure is a signal.
 */
export const SMOKE_SCENARIO_IDS: ReadonlyArray<string> = [
  'sg-b-runback', 'feed-path-b', 'show-feed-lineup', 'loss-main-feedwater', 'e0-immediate', 'single-state', 'product-question', 'op-afw-throttle',
]
export const smokeScenarios = SMOKE_SCENARIO_IDS.map(id => devScenarios.find(scenario => scenario.id === id)!)

// ---- scenarios from a module outside the repository (the private hold-out) ----

// The repository's root has no schema library; the external module is checked field by field.
const fail = (where: string, what: string): never => { throw new Error(`Scenario module: ${where} ${what}`) }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const oneOf = <T extends string>(where: string, value: unknown, allowed: ReadonlyArray<T>, optional = false): T | undefined => {
  if (value === undefined && optional) return undefined
  return allowed.includes(value as T) ? value as T : fail(where, `must be one of ${allowed.join(', ')}`)
}
const stringList = (where: string, value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length > 0) ? value as ReadonlyArray<string> : fail(where, 'must be a list of names')

const parseKey = (where: string, value: unknown): EvidenceKey => {
  if (!isRecord(value)) return fail(where, 'must be an object')
  if (typeof value.key !== 'string' || value.key.length === 0) fail(`${where}.key`, 'must be text')
  if (value.status !== KEY_STATUS) fail(`${where}.status`, `must be "${KEY_STATUS}"`)
  const match = oneOf(`${where}.match`, value.match, ['any', 'all'] as const, true)
  return {
    key: value.key as string,
    kind: oneOf(`${where}.kind`, value.kind, ['signal', 'claim', 'absence'] as const)!,
    rationale: typeof value.rationale === 'string' ? value.rationale : fail(`${where}.rationale`, 'must be text'),
    status: KEY_STATUS,
    use: oneOf(`${where}.use`, value.use, ['P0', 'P1+'] as const)!,
    ...(value.signals === undefined ? {} : { signals: stringList(`${where}.signals`, value.signals) }),
    ...(match === undefined ? {} : { match }),
  }
}

const parseOperation = (where: string, value: unknown): OperationExpectation => {
  if (!isRecord(value)) return fail(where, 'must be an object')
  if (typeof value.plantId !== 'string' || typeof value.equipment !== 'string' || typeof value.named !== 'string') fail(where, 'needs plantId, equipment and named')
  if (value.value !== undefined && value.value !== 'between-ends' && typeof value.value !== 'number') fail(`${where}.value`, 'must be between-ends or a number')
  if (value.warns !== undefined && value.warns !== true) fail(`${where}.warns`, 'must be true when present')
  return {
    plantId: value.plantId as string, equipment: value.equipment as string, named: value.named as string, tags: stringList(`${where}.tags`, value.tags),
    proposal: oneOf(`${where}.proposal`, value.proposal, ['expected', 'refused', 'either'] as const)!,
    ...(value.value === undefined ? {} : { value: value.value as 'between-ends' | number }),
    ...(value.warns === true ? { warns: true as const } : {}),
  }
}

const parseRun = (where: string, value: unknown): ScenarioRun => {
  if (!isRecord(value)) return fail(where, 'must declare the Scenario and setup steps of its Run')
  if (typeof value.scenario !== 'string' || !/^(?:fixture:)?[a-z0-9-]+$/.test(value.scenario)) fail(`${where}.scenario`, 'must be a Scenario id or fixture:<name>')
  const setup = Array.isArray(value.setup) ? value.setup.map((step, at): SetupStep => isRecord(step) && typeof step.operationId === 'string' && isRecord(step.input)
    ? { operationId: step.operationId, input: step.input }
    : fail(`${where}.setup[${at}]`, 'needs an operationId and an input object')) : fail(`${where}.setup`, 'must be a list (empty when nothing is done)')
  if (value.advanceMinutes !== undefined && (typeof value.advanceMinutes !== 'number' || value.advanceMinutes <= 0)) fail(`${where}.advanceMinutes`, 'must be positive')
  const pace = oneOf(`${where}.pace`, value.pace, ['maximum', 'realtime'] as const, true)
  return {
    scenario: value.scenario as string, setup,
    ...(value.advanceMinutes === undefined ? {} : { advanceMinutes: value.advanceMinutes as number }),
    ...(pace === undefined ? {} : { pace }),
  }
}

const parseExternalScenario = (index: number, value: unknown): EvalScenario => {
  const where = `[${index}]`
  if (!isRecord(value)) return fail(where, 'must be an object')
  if (typeof value.id !== 'string' || !/^[a-z0-9-]+$/.test(value.id)) fail(`${where}.id`, 'must be a lower-case id')
  if (typeof value.prompt !== 'string' || value.prompt.length === 0) fail(`${where}.prompt`, 'must be text')
  const holdout = isRecord(value.holdout) ? value.holdout : fail(`${where}.holdout`, 'is missing')
  for (const field of ['fault', 'setup', 'advanceMinutes'] as const) if (field in value) fail(`${where}.${field}`, 'belongs under run, which declares the Scenario it acts on')
  if ('followUp' in value) fail(where, 'carries a followUp turn, which this probe does not run')
  const keyPanel = oneOf(`${where}.keyPanel`, value.keyPanel, ['trend', 'comparison', 'readouts', 'alarms', 'mimic'] as const, true)
  const mimic = oneOf(`${where}.mimic`, value.mimic, ['expected', 'avoid'] as const, true)
  const requested = oneOf(`${where}.requested`, value.requested, ['display', 'none'] as const, true)
  const evidence = Array.isArray(holdout.evidence) ? holdout.evidence.map((key, at) => parseKey(`${where}.holdout.evidence[${at}]`, key)) : fail(`${where}.holdout.evidence`, 'must be a list')
  return {
    id: value.id as string, prompt: value.prompt as string,
    expect: oneOf(`${where}.expect`, value.expect, ['display', 'none', 'either'] as const)!,
    run: parseRun(`${where}.run`, value.run),
    ...(keyPanel === undefined ? {} : { keyPanel }),
    ...(mimic === undefined ? {} : { mimic }),
    ...(requested === undefined ? {} : { requested }),
    ...(value.operation === undefined ? {} : { operation: parseOperation(`${where}.operation`, value.operation) }),
    set: 'holdout', flaky: false, evidence,
  }
}

/**
 * Hold-out scenarios from an absolute module path and export name. Each
 * declares its Run; one with a follow-up turn is refused (this probe asks one
 * question per Room). The module's own keySignals are not read: its evidence
 * keys decide.
 */
export const loadScenarioModule = async (path: string, exportName: string): Promise<ReadonlyArray<EvalScenario>> => {
  const loaded = (await import(path) as Record<string, unknown>)[exportName]
  if (!Array.isArray(loaded) || loaded.length === 0) throw new Error(`Scenario module ${path} exports no scenarios as ${exportName}`)
  return loaded.map((entry, index) => parseExternalScenario(index, entry))
}
