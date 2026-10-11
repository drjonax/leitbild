import {
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  type CompiledComponent,
  type CompiledProcessPlant,
  type VariablePath,
} from '../../src/packs/process-plant/index.ts'
import {
  createProcessPlantMultiPlantTestbed,
  type ProcessPlantMultiPlantConfig,
  type ProcessPlantScheduledAction,
} from '../../src/packs/process-plant/engineering/index.ts'
import {
  evaluateProcessPlantCredibilityTarget,
  processPlantCredibilityCaseResultSummaries,
  processPlantCredibilityTraceForCase,
  renderProcessPlantCredibilityReportSvg,
  writeProcessPlantCredibilityArtifacts,
  type ProcessPlantCredibilityTarget,
} from './credibility-harness.ts'

const durationMs = 600_000
const stepMs = 1_000
const sampleIntervalMs = 2_000
const artifactRoot = process.env.PROCESS_PLANT_CREDIBILITY_ARTIFACT_ROOT ?? 'docs/assets'
const summaryJsonPath = `${artifactRoot}/process-plant-pwr-credibility-summary.json`
const reportSvgPath = `${artifactRoot}/process-plant-pwr-credibility-report.svg`

const variablePath = (value: string): VariablePath => value as VariablePath

type SourceRefId =
  | 'nrc-srp-ch15'
  | 'nrc-srp-15-2-7'
  | 'nrc-srp-15-6-3'
  | 'leitbild-pwr-heat-balance'
  | 'iaea-ssg-2'
  | 'nrc-trace'
  | 'oecd-nea-mslb'
  | 'leitbild-pwr-scope'
  | 'leitbild-pwr-loop-hydraulics'

interface SourceRef {
  readonly id: SourceRefId
  readonly title: string
  readonly url: string
  readonly note: string
}

const sourceRefs: Readonly<Record<SourceRefId, SourceRef>> = {
  'nrc-srp-ch15': {
    id: 'nrc-srp-ch15',
    title: 'NRC NUREG-0800 Chapter 15',
    url: 'https://www.nrc.gov/reading-rm/doc-collections/nuregs/staff/sr0800/ch15/index.html',
    note: 'Event-family taxonomy for LWR transient and accident analysis.',
  },
  'nrc-srp-15-2-7': {
    id: 'nrc-srp-15-2-7',
    title: 'NRC NUREG-0800 Section 15.2.7, Loss of Normal Feedwater Flow (Rev. 2, March 2007)',
    url: 'https://www.nrc.gov/reading-rm/doc-collections/nuregs/staff/sr0800/ch15/index.html',
    note: 'A moderate-frequency event: reactor coolant and main steam pressure stay below 110 % of design, fuel cladding stays intact, and the event does not grow into an accident. Plant analyses meet it by tripping the reactor on low-low steam generator level and removing decay heat with auxiliary feedwater, without the pressurizer filling.',
  },
  'nrc-srp-15-6-3': {
    id: 'nrc-srp-15-6-3',
    title: 'NRC NUREG-0800 Section 15.6.3, Radiological Consequences of Steam Generator Tube Failure (PWR)',
    url: 'https://www.nrc.gov/reading-rm/doc-collections/nuregs/staff/sr0800/ch15/index.html',
    note: 'The design-basis tube failure is a double-ended rupture of one tube. In the Westinghouse analyses it rests on (WCAP-10698, the margin-to-overfill methodology) the break drains the pressurizer within minutes, the reactor trips and safety injection actuates on low pressurizer pressure, and safety injection then makes up the break flow until the operators equalize primary and secondary pressure. The loops stay full: the lasting loss is about the pressurizer\'s water, while most of the leaked mass is replaced.',
  },
  'leitbild-pwr-heat-balance': {
    id: 'leitbild-pwr-heat-balance',
    title: 'Leitbild reference PWR heat balance',
    url: 'apps/world/tests/process-plant-primary-thermal-hydraulics.test.ts',
    note: 'The reference core\'s 3,400 MWt and about 18 MWt of reactor coolant pump heat reach the steam generators; a saturated-steam turbine cycle at about 6.9 MPa converts 33 to 35 % of that, so gross output is about 1,130 to 1,200 MWe, as four-loop plants of that rating deliver.',
  },
  'iaea-ssg-2': {
    id: 'iaea-ssg-2',
    title: 'IAEA SSG-2 Rev. 1 deterministic safety analysis guide',
    url: 'https://nucleus.iaea.org/sites/committees/Set%20of%20valid%20safety%20standards%20202409/safety%20standards_%20valid%20set/SSG-2%20Rev%201%20Deterministic%20Safety%20Analysis%20for%20Nuclear%20Power%20Plants.pdf',
    note: 'Verification, validation, input qualification, assumptions, and documentation discipline.',
  },
  'nrc-trace': {
    id: 'nrc-trace',
    title: 'NRC thermal-hydraulic computer codes',
    url: 'https://www.nrc.gov/about-nrc/regulatory/research/safetycodes.html',
    note: 'Boundary marker for phenomena handled by licensing-grade system codes, not by Leitbild.',
  },
  'oecd-nea-mslb': {
    id: 'oecd-nea-mslb',
    title: 'OECD/NEA PWR Main Steam-Line Break benchmark',
    url: 'https://harbor.oecd-nea.org/jcms/pl_32205/pressurised-water-reactor-main-steam-line-break-mslb-benchmark',
    note: 'Benchmark pattern for event sequence, setpoints, plant conditions, and trace comparisons.',
  },
  'leitbild-pwr-loop-hydraulics': {
    id: 'leitbild-pwr-loop-hydraulics',
    title: 'Leitbild reference PWR reactor coolant flow after pump trips',
    url: 'apps/world/tests/process-plant-reactor-coolant-flow.test.ts',
    note: 'With every pump lost a four-loop plant keeps about 15 % of its flow at 60 s on its flywheels, the flow falling about as 1 / (1 + t / 11 s) (FSAR 15.3.2), and its loops settle into natural circulation of a few percent within minutes, the core exit flat or falling once forced flow has gone, the core rise 10 to 25 °C on decay heat. With one pump lost the other three keep 70 to 75 % of rated core flow and drive the idle loop backwards.',
  },
  'leitbild-pwr-scope': {
    id: 'leitbild-pwr-scope',
    title: 'Leitbild PWR operational-simulator scope',
    url: 'docs/wiki/pwr-ops.md',
    note: 'Local scope boundary: deterministic lumped operational simulator, not a licensing-basis safety-analysis code.',
  },
}

type CaseId =
  | 'steady-power'
  | 'loss-feedwater-afw'
  | 'loss-feedwater-auto-afw'
  | 'loss-heat-sink-dryout'
  | 'turbine-trip-bypass'
  | 'pressurizer-relief-challenge'
  | 'sgtr'
  | 'small-loca'
  | 'all-rcp-trip'
  | 'loss-offsite-power'

interface CredibilityCase {
  readonly id: CaseId
  readonly title: string
  readonly eventFamily: string
  readonly description: string
  readonly sourceRefs: ReadonlyArray<SourceRefId>
  readonly parameters?: Record<string, Record<string, unknown>>
  readonly initialState?: Record<string, unknown>
  readonly actions: (plant: CompiledProcessPlant) => ReadonlyArray<ProcessPlantScheduledAction>
  /** How long the case runs, where the event takes longer than the common window to play out. */
  readonly durationMs?: number
}

type CredibilityTarget = ProcessPlantCredibilityTarget<CaseId, SourceRefId>

const scheduledComponentTrip = (
  id: string,
  atMs: number,
  componentId: string,
): ProcessPlantScheduledAction => ({
  id,
  atMs,
  type: 'tripComponent',
  componentId: componentId as never,
})

const setVariable = (
  id: string,
  atMs: number,
  path: string,
  value: number | boolean,
): ProcessPlantScheduledAction => ({
  id,
  atMs,
  type: 'setVariable',
  path: variablePath(path),
  value,
})

const componentsMatching = (
  plant: CompiledProcessPlant,
  predicate: (component: CompiledComponent) => boolean,
): ReadonlyArray<CompiledComponent> =>
  plant.graph.components.filter(predicate)

const tripComponentsMatching = (
  plant: CompiledProcessPlant,
  atMs: number,
  idPrefix: string,
  predicate: (component: CompiledComponent) => boolean,
): ReadonlyArray<ProcessPlantScheduledAction> =>
  componentsMatching(plant, predicate).map(component =>
    scheduledComponentTrip(`${idPrefix}-${component.id}`, atMs, String(component.id)),
  )

const setValvePositionsMatching = (
  plant: CompiledProcessPlant,
  atMs: number,
  idPrefix: string,
  positionFraction: number,
  predicate: (component: CompiledComponent) => boolean,
): ReadonlyArray<ProcessPlantScheduledAction> =>
  componentsMatching(plant, predicate).map(component =>
    setVariable(`${idPrefix}-${component.id}`, atMs, `${component.id}.positionFraction`, positionFraction),
  )

const isMainFeedwaterPump = (component: CompiledComponent): boolean =>
  component.kind === 'centrifugalPump' && String(component.id).startsWith('mainFeedwaterPump')

const isAuxFeedwaterPump = (component: CompiledComponent): boolean =>
  component.kind === 'centrifugalPump' && String(component.id).startsWith('auxFeedwaterPump')

const isAuxFeedwaterValve = (component: CompiledComponent): boolean =>
  component.kind === 'processValve' && String(component.id).startsWith('auxFeedwaterValve')

const isReactorCoolantPump = (component: CompiledComponent): boolean =>
  component.kind === 'centrifugalPump' && String(component.id).startsWith('rcp')

const cases: ReadonlyArray<CredibilityCase> = [
  {
    id: 'steady-power',
    title: 'Steady Power Operation',
    eventFamily: 'Normal full-power operation',
    description: 'Six hundred seconds without a fault should stay close to the reference operating band.',
    sourceRefs: ['iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [],
  },
  {
    id: 'loss-feedwater-afw',
    title: 'Loss Of Feedwater With AFW',
    eventFamily: 'NRC SRP 15.2.7 loss of normal feedwater flow',
    description: 'Main feedwater trips; the reactor trips on low-low steam generator level, and auxiliary feedwater (also aligned by schedule at T+180s) should preserve a secondary heat sink.',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: system => [
      ...tripComponentsMatching(system, 60_000, 'trip-main-feedwater', isMainFeedwaterPump),
      ...componentsMatching(system, isAuxFeedwaterPump).map(component =>
        setVariable(`start-${component.id}`, 180_000, `${component.id}.running`, true),
      ),
      ...setValvePositionsMatching(system, 180_000, 'open-aux-feedwater-valve', 1, isAuxFeedwaterValve),
    ],
  },
  {
    id: 'loss-feedwater-auto-afw',
    title: 'Loss Of Feedwater With Automatic AFW',
    eventFamily: 'NRC SRP 15.2.7 loss of normal feedwater flow',
    description: 'Main feedwater trips; the reference protection should trip the reactor, on overtemperature delta-T or low-low SG level, whichever comes first, and the graph-aware reference I&C actuate AFW without manual schedule help; AFW should then remove decay heat.',
    sourceRefs: ['nrc-srp-15-2-7', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: system => [
      ...tripComponentsMatching(system, 60_000, 'trip-main-feedwater-auto-afw', isMainFeedwaterPump),
    ],
  },
  {
    id: 'loss-heat-sink-dryout',
    title: 'Loss Of Secondary Heat Sink Without AFW Inventory',
    eventFamily: 'NRC SRP Chapter 15 heat-sink degradation envelope',
    description: 'Normal feedwater is lost while AFW inventory is unavailable; after the low-low level reactor trip, decay heat boils the SGs down, uncovering tubes and degrading heat transfer in the compact model.',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    initialState: {
      'auxFeedwaterTank.inventoryKg': 0,
      'auxFeedwaterTank.levelPercent': 0,
      'auxFeedwaterTank.availableOutletFlowKgPerS': 0,
    },
    actions: system => [
      ...tripComponentsMatching(system, 60_000, 'trip-main-feedwater-no-afw-inventory', isMainFeedwaterPump),
    ],
    // On ANS-5.1 decay heat the generators boil down to their tubes some 14
    // minutes after the feedwater is lost; they boil dry within the hour.
    durationMs: 1_200_000,
  },
  {
    id: 'turbine-trip-bypass',
    title: 'Turbine Trip With Steam Bypass',
    eventFamily: 'NRC SRP 15.2 turbine trip and loss of load family',
    description: 'The turbine path is isolated; electrical load should collapse and main steam bypass/pressure relief behavior should become visible.',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [
      setVariable('close-turbine-stop-valve', 90_000, 'turbineStopValve.positionFraction', 0),
      setVariable('reject-turbine-load', 90_000, 'turbine.loadFraction', 0),
    ],
  },
  {
    id: 'pressurizer-relief-challenge',
    title: 'Pressurizer Overpressure Relief Challenge',
    eventFamily: 'NRC SRP 15 reactor coolant system pressure-control challenge',
    description: 'An initial high-pressure condition should actuate relief and drive pressure back toward the operating envelope.',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    initialState: {
      'pressurizer.pressureMPa': 16.45,
    },
    actions: () => [],
  },
  {
    id: 'sgtr',
    title: 'Steam Generator Tube Leak',
    eventFamily: 'NRC SRP 15.6.3 steam generator tube failure indication',
    description: 'Primary-to-secondary leakage should drain RCS inventory and produce affected-secondary radiation.',
    sourceRefs: ['nrc-srp-15-6-3', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [
      setVariable('open-sg-a-tube-leak', 90_000, 'sgA.tubeLeakFraction', 0.18),
    ],
  },
  {
    id: 'small-loca',
    title: 'Small LOCA With Accumulator Response',
    eventFamily: 'NRC SRP 15.6.5 loss-of-coolant accident spectrum',
    description: 'A primary boundary leak should depressurize, send mass to containment, and actuate passive inventory support.',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [
      setVariable('open-hot-leg-a-boundary-leak', 90_000, 'rcs-hot-leg-a.leak.areaFraction', 0.45),
    ],
  },
  {
    id: 'all-rcp-trip',
    title: 'Loss Of Forced Primary Flow',
    eventFamily: 'NRC SRP 15.3.1 loss of forced reactor coolant flow',
    description: 'All reactor coolant pumps trip; loop flow should coast down, reference protection should trip the reactor, and core cooling indicators should respond.',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: system => tripComponentsMatching(system, 90_000, 'trip-rcp', isReactorCoolantPump),
  },
  {
    id: 'loss-offsite-power',
    title: 'Loss Of Offsite Power',
    eventFamily: 'NRC SRP 15.2.6 loss of nonemergency AC power',
    description: 'Offsite power is lost; emergency diesels should restore safety buses and essential loads.',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
    actions: () => [
      { id: 'loss-of-offsite-power', atMs: 90_000, type: 'lossOfOffsitePower' },
      setVariable('start-diesel-a', 110_000, 'dieselGeneratorA.startCommand', true),
      setVariable('start-diesel-b', 110_000, 'dieselGeneratorB.startCommand', true),
    ],
  },
]

const telemetryVariables = [
  'core.powerMw',
  'core.totalThermalPowerMw',
  'core.decayHeatMw',
  'core.coreCoolingAvailabilityFraction',
  'core.coreHeatRemovalDeficitMw',
  'core.fuelHeatupRateCPerS',
  'core.rodInsertionFraction',
  'vessel.primaryCoolantInventoryKg',
  'rcsInventoryBalance.balancedInventoryKg',
  'vessel.meanPrimaryCoolantTemperatureC',
  'vessel.primaryLeakFlowKgPerS',
  'vessel.safetyInjectionFlowKgPerS',
  'vessel.tubeLeakFlowKgPerS',
  'vessel.reliefOutflowKgPerS',
  'vessel-release-to-containment.flowKgPerS',
  'pressurizer.pressureMPa',
  'pressurizer.levelPercent',
  'pressurizer.reliefFlowKgPerS',
  'pressurizer.reliefValvePositionFraction',
  'sgA.levelPercent',
  'sgA.collapsedLevelPercent',
  'sgA.tubeCoverageFraction',
  'sgA.tubeUncoveredFraction',
  'sgA.availableHeatTransferFraction',
  'sgA.heatTransferMw',
  'sgA.feedwaterFlowKgPerS',
  'sgA.steamOutflowKgPerS',
  'sgA.pressureMPa',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'core.averageHotLegFlowKgPerS',
  'core.coreExitTemperatureC',
  'vessel.subcoolingMarginC',
  'turbine.electricMw',
  'turbine.loadFraction',
  'turbine.steamAvailabilityFraction',
  'turbineStopValve.effectivePositionFraction',
  'turbineBypassValve.effectivePositionFraction',
  'turbine-bypass-valve-to-condenser.flowKgPerS',
  'main-steam-header-to-turbine-bypass-valve.pressureMPa',
  'mainSteamSafetyValve.effectivePositionFraction',
  'main-steam-header-to-safety-valve.flowKgPerS',
  'main-steam-safety-valve-to-atmosphere.flowKgPerS',
  'condenser.backPressurePa',
  'containment.pressureMPa',
  'containment.incomingMassKgPerS',
  'containment.sumpInventoryKg',
  'containment.radiationSourceTermMSvPerH',
  'safetyAccumulatorA.outletFlowKgPerS',
  'safetyAccumulatorA.liquidInventoryKg',
  'motor-afw-pump-to-header.flowKgPerS',
  'aux-feedwater-valve-a-to-sg-a.flowKgPerS',
  'safetyBusA.voltageFraction',
  'safetyBusB.voltageFraction',
  'plantControlsLoadA.servedFraction',
  'plantControlsLoadB.servedFraction',
] as const satisfies ReadonlyArray<string>

const targets: ReadonlyArray<CredibilityTarget> = [
  {
    id: 'steady-pzr-pressure-band',
    caseId: 'steady-power',
    label: 'Pressurizer pressure remains in the reference operating band',
    signal: 'pressurizer.pressureMPa final value',
    expectation: 'Stable PWR operation should remain close to nominal RCS pressure.',
    measure: { kind: 'point', path: variablePath('pressurizer.pressureMPa'), atMs: durationMs },
    acceptable: { min: 14.8, max: 15.8 },
    severity: 'gate',
    sourceRefs: ['iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'steady-sg-level-band',
    caseId: 'steady-power',
    label: 'Steam-generator level remains controllable',
    signal: 'sgA.levelPercent final value',
    expectation: 'Normal operation should not drift toward dryout or high-level challenge.',
    measure: { kind: 'point', path: variablePath('sgA.levelPercent'), atMs: durationMs },
    acceptable: { min: 45, max: 70 },
    severity: 'gate',
    sourceRefs: ['iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'steady-turbine-output-band',
    caseId: 'steady-power',
    label: 'Electric output remains in the reference plant range',
    signal: 'turbine.electricMw final value',
    expectation: 'The reference plant should produce the gross electrical output its heat balance gives: 3,400 MWt of core and about 18 MWt of pump heat at a 33 to 35 % gross cycle efficiency.',
    measure: { kind: 'point', path: variablePath('turbine.electricMw'), atMs: durationMs },
    acceptable: { min: 1_120, max: 1_200 },
    severity: 'watch',
    sourceRefs: ['leitbild-pwr-heat-balance', 'leitbild-pwr-scope'],
  },
  {
    id: 'lofw-level-decline',
    caseId: 'loss-feedwater-afw',
    label: 'Loss of feedwater visibly lowers SG level before recovery',
    signal: 'sgA.levelPercent delta from T+80s to T+170s',
    expectation: 'Normal feedwater loss should deplete secondary inventory before AFW recovery.',
    measure: { kind: 'delta', path: variablePath('sgA.levelPercent'), fromMs: 80_000, toMs: 170_000 },
    acceptable: { max: -8 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2'],
  },
  {
    id: 'lofw-afw-flow',
    caseId: 'loss-feedwater-afw',
    label: 'Auxiliary feedwater reaches the affected SG branch',
    signal: 'aux-feedwater-valve-a-to-sg-a.flowKgPerS max after T+190s',
    expectation: 'AFW should provide a visible secondary heat-sink recovery path.',
    measure: { kind: 'maxAfter', path: variablePath('aux-feedwater-valve-a-to-sg-a.flowKgPerS'), afterMs: 190_000 },
    acceptable: { min: 20 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'lofw-no-dryout',
    caseId: 'loss-feedwater-afw',
    label: 'AFW keeps the SG tube bundle covered',
    signal: 'sgA.tubeCoverageFraction min after T+60s',
    expectation: 'The narrow-range level may go off scale low as the voids collapse after the trip, but AFW should keep the tube bundle covered: that, not the narrow range, is dryout.',
    measure: { kind: 'minAfter', path: variablePath('sgA.tubeCoverageFraction'), afterMs: 60_000 },
    acceptable: { min: 0.99 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7', 'iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-level-challenge',
    caseId: 'loss-feedwater-auto-afw',
    label: 'SG level falls through the low-low trip set point',
    signal: 'sgA.levelPercent min after T+60s',
    expectation: 'Auxiliary feedwater starting with the main feedwater pump trip should not mask the loss of feedwater: SG level still falls to the 20 % low-low set point that trips the reactor.',
    measure: { kind: 'minAfter', path: variablePath('sgA.levelPercent'), afterMs: 60_000 },
    acceptable: { max: 20 },
    severity: 'watch',
    sourceRefs: ['nrc-srp-15-2-7', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-reactor-trip',
    caseId: 'loss-feedwater-auto-afw',
    label: 'Low-low SG level trips the reactor',
    signal: 'core.powerMw max after T+200s',
    expectation: 'Steam generator low-low level should trip the reactor, so that only decay heat is left for auxiliary feedwater to remove.',
    measure: { kind: 'maxAfter', path: variablePath('core.powerMw'), afterMs: 200_000 },
    acceptable: { max: 100 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-reactor-trip-rods-inserted',
    caseId: 'loss-feedwater-auto-afw',
    label: 'The low-low level trip inserts the rods',
    signal: 'core.rodInsertionFraction final value',
    expectation: 'The reactor trip should be visible as rod insertion as well as reduced power.',
    measure: { kind: 'point', path: variablePath('core.rodInsertionFraction'), atMs: durationMs },
    acceptable: { min: 0.95 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-flow',
    caseId: 'loss-feedwater-auto-afw',
    label: 'Reference I&C actuates AFW after low-low SG level',
    signal: 'aux-feedwater-valve-a-to-sg-a.flowKgPerS max after T+120s',
    expectation: 'Graph-aware steam-generator I&C should open the affected AFW branch without a hand-coded manual schedule.',
    measure: { kind: 'maxAfter', path: variablePath('aux-feedwater-valve-a-to-sg-a.flowKgPerS'), afterMs: 120_000 },
    acceptable: { min: 20 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-heat-sink-preserved',
    caseId: 'loss-feedwater-auto-afw',
    label: 'Automatic AFW outpaces decay-heat boil-off and refills the SG',
    signal: 'sgA.collapsedLevelPercent delta from T+260s to final',
    expectation: 'Once the reactor has tripped, AFW flow should exceed what decay heat boils off, so the water inventory of the affected SG, read over its full height, turns and recovers.',
    measure: { kind: 'delta', path: variablePath('sgA.collapsedLevelPercent'), fromMs: 260_000, toMs: durationMs },
    acceptable: { min: 2 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7', 'iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-tubes-covered',
    caseId: 'loss-feedwater-auto-afw',
    label: 'The SG tube bundle stays covered',
    signal: 'sgA.tubeCoverageFraction min after T+60s',
    expectation: 'The low-low trip and AFW should keep the tube bundle covered, so the steam generator remains a heat sink.',
    measure: { kind: 'minAfter', path: variablePath('sgA.tubeCoverageFraction'), afterMs: 60_000 },
    acceptable: { min: 0.99 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-rcs-heat-removed',
    caseId: 'loss-feedwater-auto-afw',
    label: 'AFW and the steam dumps hold the RCS near no-load temperature',
    signal: 'vessel.meanPrimaryCoolantTemperatureC max after T+300s',
    expectation: 'With AFW established the steam generators should remove decay heat at no-load steam pressure, holding average coolant temperature near 291.7 °C (557 °F) instead of letting it rise.',
    measure: { kind: 'maxAfter', path: variablePath('vessel.meanPrimaryCoolantTemperatureC'), afterMs: 300_000 },
    acceptable: { max: 300 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7', 'leitbild-pwr-scope'],
  },
  {
    id: 'auto-afw-rcs-pressure-bounded',
    caseId: 'loss-feedwater-auto-afw',
    label: 'RCS pressure stays below 110 % of design',
    signal: 'pressurizer.pressureMPa max after T+60s',
    expectation: 'Reactor coolant pressure should stay below 110 % of the 17.24 MPa (2,485 psig) design pressure.',
    measure: { kind: 'maxAfter', path: variablePath('pressurizer.pressureMPa'), afterMs: 60_000 },
    acceptable: { max: 18.96 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7'],
  },
  {
    id: 'auto-afw-steam-pressure-bounded',
    caseId: 'loss-feedwater-auto-afw',
    label: 'Main steam pressure stays below 110 % of design',
    signal: 'sgA.pressureMPa max after T+60s',
    expectation: 'Steam generator pressure should stay below 110 % of its 8.27 MPa (1,185 psig) design pressure, where the lowest safety valve is set.',
    measure: { kind: 'maxAfter', path: variablePath('sgA.pressureMPa'), afterMs: 60_000 },
    acceptable: { max: 9.1 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7'],
  },
  {
    id: 'auto-afw-pressurizer-not-solid',
    caseId: 'loss-feedwater-auto-afw',
    label: 'The pressurizer does not fill',
    signal: 'pressurizer.levelPercent max after T+60s',
    expectation: 'The coolant heat-up before the trip should not fill the pressurizer and relieve water through its valves.',
    measure: { kind: 'maxAfter', path: variablePath('pressurizer.levelPercent'), afterMs: 60_000 },
    acceptable: { max: 95 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-2-7', 'leitbild-pwr-scope'],
  },
  {
    id: 'dryout-tube-uncovering',
    caseId: 'loss-heat-sink-dryout',
    label: 'Loss of secondary heat sink begins to uncover SG tubes',
    signal: 'sgA.tubeCoverageFraction min after T+180s',
    expectation: 'Without AFW inventory, decay heat after the trip should boil the SG down until its tube bundle begins to uncover, rather than leaving heat transfer artificially intact.',
    measure: { kind: 'minAfter', path: variablePath('sgA.tubeCoverageFraction'), afterMs: 180_000 },
    acceptable: { max: 0.9 },
    severity: 'gate',
    sourceRefs: ['nrc-trace', 'leitbild-pwr-scope'],
  },
  {
    id: 'dryout-heat-transfer-degrades',
    caseId: 'loss-heat-sink-dryout',
    label: 'Tube uncovering degrades steam-generator heat transfer',
    signal: 'sgA.availableHeatTransferFraction min after T+180s',
    expectation: 'The compact SG model should reduce available heat transfer as tubes uncover.',
    measure: { kind: 'minAfter', path: variablePath('sgA.availableHeatTransferFraction'), afterMs: 180_000 },
    acceptable: { max: 0.9 },
    severity: 'gate',
    sourceRefs: ['nrc-trace', 'leitbild-pwr-scope'],
  },
  {
    id: 'dryout-core-heat-removal-deficit',
    caseId: 'loss-heat-sink-dryout',
    label: 'Loss of heat sink creates a visible core heat-removal deficit',
    signal: 'core.coreHeatRemovalDeficitMw max after T+240s',
    expectation: 'Heat-sink degradation should be visible in core diagnostic terms even in a lumped model.',
    measure: { kind: 'maxAfter', path: variablePath('core.coreHeatRemovalDeficitMw'), afterMs: 240_000 },
    acceptable: { min: 100 },
    severity: 'watch',
    sourceRefs: ['nrc-trace', 'leitbild-pwr-scope'],
  },
  {
    id: 'turbine-trip-load-rejection',
    caseId: 'turbine-trip-bypass',
    label: 'Turbine trip rejects generator load',
    signal: 'turbine.electricMw final value',
    expectation: 'A turbine trip or load rejection should collapse electrical output.',
    measure: { kind: 'point', path: variablePath('turbine.electricMw'), atMs: durationMs },
    acceptable: { max: 25 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'turbine-trip-stop-valve-closes',
    caseId: 'turbine-trip-bypass',
    label: 'Turbine stop valve closes',
    signal: 'turbineStopValve.effectivePositionFraction final value',
    expectation: 'The isolated turbine path should be explicit in the component graph variables.',
    measure: { kind: 'point', path: variablePath('turbineStopValve.effectivePositionFraction'), atMs: durationMs },
    acceptable: { max: 0.05 },
    severity: 'gate',
    sourceRefs: ['leitbild-pwr-scope'],
  },
  {
    id: 'turbine-trip-bypass-flow',
    caseId: 'turbine-trip-bypass',
    label: 'Steam bypass opens to absorb the load rejection',
    signal: 'turbine-bypass-valve-to-condenser.flowKgPerS max after T+100s',
    expectation: 'A turbine trip should route main steam to the condenser bypass before relying on safety-valve discharge.',
    measure: { kind: 'maxAfter', path: variablePath('turbine-bypass-valve-to-condenser.flowKgPerS'), afterMs: 100_000 },
    acceptable: { min: 100 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'turbine-trip-pressure-challenge',
    caseId: 'turbine-trip-bypass',
    label: 'Main steam pressure rises to the steam dumps and stays below the safety valves',
    signal: 'main-steam-header-to-turbine-bypass-valve.pressureMPa max after T+100s',
    expectation: 'The load rejection should drive steam pressure above the dumps\' 7.6 MPa (1,092 psig) no-load set pressure, and the dumps should hold it below the 8.27 MPa safety valve set pressure.',
    measure: { kind: 'maxAfter', path: variablePath('main-steam-header-to-turbine-bypass-valve.pressureMPa'), afterMs: 100_000 },
    acceptable: { min: 7.6, max: 8.27 },
    severity: 'watch',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'turbine-trip-safety-valves-shut',
    caseId: 'turbine-trip-bypass',
    label: 'The main steam safety valves stay shut',
    signal: 'mainSteamSafetyValve.effectivePositionFraction max after T+90s',
    expectation: 'With the condenser steam dumps available, a turbine trip should not lift the safety valves.',
    measure: { kind: 'maxAfter', path: variablePath('mainSteamSafetyValve.effectivePositionFraction'), afterMs: 90_000 },
    acceptable: { max: 0.05 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'turbine-trip-sg-level-no-swell',
    caseId: 'turbine-trip-bypass',
    label: 'SG level does not swell after the trip',
    signal: 'sgA.levelPercent max after T+90s',
    expectation: 'As steaming falls after the trip and feedwater is isolated (P-4 with low Tavg), the voids collapse: the level must not rise above its 55 % program.',
    measure: { kind: 'maxAfter', path: variablePath('sgA.levelPercent'), afterMs: 90_000 },
    acceptable: { max: 56 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'turbine-trip-sg-level-shrinks',
    caseId: 'turbine-trip-bypass',
    label: 'SG level shrinks after the trip',
    signal: 'sgA.levelPercent min after T+90s',
    expectation: 'Void collapse after a trip from full power should shrink the narrow-range level by tens of percent, often toward the low-low set point.',
    measure: { kind: 'minAfter', path: variablePath('sgA.levelPercent'), afterMs: 90_000 },
    acceptable: { max: 35 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'pzr-relief-flow',
    caseId: 'pressurizer-relief-challenge',
    label: 'Pressurizer relief flow occurs during overpressure challenge',
    signal: 'pressurizer.reliefFlowKgPerS max after T+0s',
    expectation: 'A high RCS-pressure condition should create a visible relief path.',
    measure: { kind: 'maxAfter', path: variablePath('pressurizer.reliefFlowKgPerS'), afterMs: 0 },
    acceptable: { min: 10 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'pzr-pressure-recovers',
    caseId: 'pressurizer-relief-challenge',
    label: 'Pressurizer pressure returns below high-trip challenge band',
    signal: 'pressurizer.pressureMPa final value',
    expectation: 'Relief and normal pressure control should reduce pressure after the overpressure challenge.',
    measure: { kind: 'point', path: variablePath('pressurizer.pressureMPa'), atMs: durationMs },
    acceptable: { min: 14.8, max: 16.25 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2', 'leitbild-pwr-scope'],
  },
  {
    id: 'pzr-relief-path-drains-primary-inventory',
    caseId: 'pressurizer-relief-challenge',
    label: 'Relief path is visible in primary inventory accounting',
    signal: 'vessel.reliefOutflowKgPerS max after T+0s',
    expectation: 'Pressurizer relief should be coupled to vessel inventory diagnostics, not only a local pressurizer display variable.',
    measure: { kind: 'maxAfter', path: variablePath('vessel.reliefOutflowKgPerS'), afterMs: 0 },
    acceptable: { min: 5 },
    severity: 'watch',
    sourceRefs: ['leitbild-pwr-scope'],
  },
  {
    id: 'sgtr-leak-flow',
    caseId: 'sgtr',
    label: 'SGTR produces measurable primary-to-secondary leakage',
    signal: 'sgA.primaryToSecondaryLeakKgPerS max after T+100s',
    expectation: 'A tube leak should create an affected-SG leak path without contaminating unrelated SGs.',
    measure: { kind: 'maxAfter', path: variablePath('sgA.primaryToSecondaryLeakKgPerS'), afterMs: 100_000 },
    acceptable: { min: 40, max: 220 },
    severity: 'watch',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'sgtr-primary-inventory-loss',
    caseId: 'sgtr',
    label: 'SGTR drains reactor coolant inventory until safety injection makes it up',
    signal: 'rcsInventoryBalance.balancedInventoryKg delta from T+80s to final',
    // The loops stay full in a tube rupture: the pressurizer gives up its water to the break, so the measure is the
    // whole reactor coolant system, loops and pressurizer. Safety injection replaces most of what leaks, so the
    // lasting loss is about a full-power pressurizer's water (some 16 t), not the leaked mass.
    expectation: 'Primary-to-secondary leakage should drain the reactor coolant system, loops and pressurizer together, until safety injection makes up the break flow, leaving a lasting loss of about the pressurizer\'s water.',
    measure: { kind: 'delta', path: variablePath('rcsInventoryBalance.balancedInventoryKg'), fromMs: 80_000, toMs: durationMs },
    acceptable: { min: -25_000, max: -3_000 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-15-6-3', 'iaea-ssg-2'],
  },
  {
    id: 'sgtr-radiation-indication',
    caseId: 'sgtr',
    label: 'Affected secondary radiation rises',
    signal: 'sgA.secondaryRadiationMSvPerH max after T+100s',
    expectation: 'SGTR diagnosis should be visible through affected secondary radiation.',
    measure: { kind: 'maxAfter', path: variablePath('sgA.secondaryRadiationMSvPerH'), afterMs: 100_000 },
    acceptable: { min: 20 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'loca-primary-release',
    caseId: 'small-loca',
    label: 'Primary boundary leak creates containment release flow',
    signal: 'vessel-release-to-containment.flowKgPerS max after T+100s',
    expectation: 'A primary-boundary break should move mass from RCS to containment.',
    measure: { kind: 'maxAfter', path: variablePath('vessel-release-to-containment.flowKgPerS'), afterMs: 100_000 },
    acceptable: { min: 50 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'nrc-trace'],
  },
  {
    id: 'loca-containment-pressure-rise',
    caseId: 'small-loca',
    label: 'Containment pressure rises after release',
    signal: 'containment.pressureMPa delta from T+80s to final',
    expectation: 'Containment should respond thermodynamically to primary mass-energy release.',
    measure: { kind: 'delta', path: variablePath('containment.pressureMPa'), fromMs: 80_000, toMs: durationMs },
    acceptable: { min: 0.01 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'iaea-ssg-2'],
  },
  {
    id: 'loca-accumulator-flow',
    caseId: 'small-loca',
    label: 'Accumulator injects after depressurization',
    signal: 'safetyAccumulatorA.outletFlowKgPerS max after T+100s',
    expectation: 'Passive safety injection should become visible as RCS pressure falls below the accumulator head.',
    measure: { kind: 'maxAfter', path: variablePath('safetyAccumulatorA.outletFlowKgPerS'), afterMs: 100_000 },
    acceptable: { min: 1 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-coastdown',
    caseId: 'all-rcp-trip',
    label: 'Forced primary flow coasts down rather than teleporting to zero',
    signal: 'rcpA.loopFlowKgPerS delta from T+88s to T+110s',
    expectation: 'RCP trip should show inertia/coastdown, not an instant hydraulic collapse.',
    measure: { kind: 'delta', path: variablePath('rcpA.loopFlowKgPerS'), fromMs: 88_000, toMs: 110_000 },
    acceptable: { min: -5_000, max: -500 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-flywheel-flow-at-one-minute',
    caseId: 'all-rcp-trip',
    label: 'The pumps\' flywheels still carry about a sixth of the flow a minute after the trip',
    signal: 'core.averageHotLegFlowKgPerS at T+150s',
    expectation: 'A minute into the coastdown a four-loop plant keeps about 15 % of its rated core flow, 10 to 20 % of 17,000 kg/s.',
    measure: { kind: 'point', path: variablePath('core.averageHotLegFlowKgPerS'), atMs: 150_000 },
    acceptable: { min: 1_700, max: 3_400 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-loop-hydraulics'],
  },
  {
    id: 'rcp-natural-circulation-flow',
    caseId: 'all-rcp-trip',
    label: 'Natural circulation carries a few percent of rated flow once the pumps have coasted down',
    signal: 'core.averageHotLegFlowKgPerS final value',
    expectation: 'Buoyancy alone drives the loops at 2 to 6.5 % of rated core flow on decay heat, not a fixed flow and not none.',
    measure: { kind: 'point', path: variablePath('core.averageHotLegFlowKgPerS'), atMs: durationMs },
    acceptable: { min: 340, max: 1_105 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-loop-hydraulics'],
  },
  {
    id: 'rcp-core-cooling-holds',
    caseId: 'all-rcp-trip',
    label: 'Coastdown and natural circulation carry the decay heat within the core\'s rated rise',
    signal: 'core.coreCoolingAvailabilityFraction min after T+120s',
    expectation: 'Once the reactor has tripped the flow needed falls with the power; the coasting and naturally circulating flow cools the core in full.',
    measure: { kind: 'minAfter', path: variablePath('core.coreCoolingAvailabilityFraction'), afterMs: 120_000 },
    acceptable: { min: 0.99 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-loop-hydraulics'],
  },
  {
    id: 'rcp-core-exit-bounded',
    caseId: 'all-rcp-trip',
    label: 'The core exit stays below the full-power hot leg on natural circulation',
    signal: 'core.coreExitTemperatureC max after T+100s',
    expectation: 'On decay heat the natural-circulation core rise of 10 to 25 °C keeps the core exit below its full-power reading.',
    measure: { kind: 'maxAfter', path: variablePath('core.coreExitTemperatureC'), afterMs: 100_000 },
    acceptable: { max: 320 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-loop-hydraulics'],
  },
  {
    id: 'rcp-core-exit-not-rising',
    caseId: 'all-rcp-trip',
    label: 'The core exit is flat or falling once forced flow has gone',
    signal: 'core.coreExitTemperatureC delta from T+390s to T+600s',
    expectation: 'From five minutes after the trip natural circulation carries the falling decay heat at a falling core rise.',
    measure: { kind: 'delta', path: variablePath('core.coreExitTemperatureC'), fromMs: 390_000, toMs: durationMs },
    acceptable: { min: -20, max: 1 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-loop-hydraulics'],
  },
  {
    id: 'rcp-subcooling-held',
    caseId: 'all-rcp-trip',
    label: 'Subcooling stays above 30 °C while the steam generators remove the heat',
    signal: 'vessel.subcoolingMarginC min after T+120s',
    expectation: 'With the steam generators a heat sink, a natural-circulation core rise on decay heat keeps the coolant at least 30 °C subcooled; the margin falls with the decay heat the core makes.',
    measure: { kind: 'minAfter', path: variablePath('vessel.subcoolingMarginC'), afterMs: 120_000 },
    acceptable: { min: 30 },
    severity: 'watch',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-loop-hydraulics'],
  },
  {
    id: 'rcp-reactor-trip-power-suppression',
    caseId: 'all-rcp-trip',
    label: 'Reference protection suppresses fission power after the RCP breaker trip',
    signal: 'core.powerMw final value',
    expectation: 'Loss of forced primary flow should actuate reactor protection and reduce fission power to a shutdown-range value.',
    measure: { kind: 'point', path: variablePath('core.powerMw'), atMs: durationMs },
    acceptable: { max: 100 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-reactor-trip-rods-inserted',
    caseId: 'all-rcp-trip',
    label: 'Reference protection inserts rods after the RCP breaker trip',
    signal: 'core.rodInsertionFraction final value',
    expectation: 'The reactor trip on the stopped pumps should be procedure-visible through rod insertion as well as reduced power.',
    measure: { kind: 'point', path: variablePath('core.rodInsertionFraction'), atMs: durationMs },
    acceptable: { min: 0.95 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-reactor-trip-turbine-isolated',
    caseId: 'all-rcp-trip',
    label: 'Reactor trip isolates turbine load path',
    signal: 'turbineStopValve.effectivePositionFraction final value',
    expectation: 'The protection response should couple reactor trip, turbine trip, and feedwater isolation behavior.',
    measure: { kind: 'point', path: variablePath('turbineStopValve.effectivePositionFraction'), atMs: durationMs },
    acceptable: { max: 0.05 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'rcp-fuel-heatup-bounded',
    caseId: 'all-rcp-trip',
    label: 'Fuel heatup remains bounded in the demo window',
    signal: 'core.fuelHeatupRateCPerS max after T+90s',
    expectation: 'The compact model should show bounded thermal consequence during pump coastdown and protection response without claiming severe-accident fidelity.',
    measure: { kind: 'maxAfter', path: variablePath('core.fuelHeatupRateCPerS'), afterMs: 90_000 },
    acceptable: { min: 0.01, max: 2.0 },
    severity: 'watch',
    sourceRefs: ['nrc-trace', 'leitbild-pwr-scope'],
  },
  {
    id: 'loop-safety-bus-a-recovery',
    caseId: 'loss-offsite-power',
    label: 'Safety bus A recovers after diesel start',
    signal: 'safetyBusA.voltageFraction min after T+150s',
    expectation: 'LOOP should be visible but recover essential safety bus voltage after EDG start.',
    measure: { kind: 'minAfter', path: variablePath('safetyBusA.voltageFraction'), afterMs: 150_000 },
    acceptable: { min: 0.9 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'loop-safety-bus-b-recovery',
    caseId: 'loss-offsite-power',
    label: 'Safety bus B recovers after diesel start',
    signal: 'safetyBusB.voltageFraction min after T+150s',
    expectation: 'LOOP should be visible but recover redundant safety bus voltage after EDG start.',
    measure: { kind: 'minAfter', path: variablePath('safetyBusB.voltageFraction'), afterMs: 150_000 },
    acceptable: { min: 0.9 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
  {
    id: 'loop-natural-circulation-flow',
    caseId: 'loss-offsite-power',
    label: 'With the pumps\' buses dead, natural circulation carries the decay heat',
    signal: 'core.averageHotLegFlowKgPerS final value',
    expectation: 'Loss of offsite power stops every reactor coolant pump; buoyancy drives the loops at 2 to 6.5 % of rated core flow.',
    measure: { kind: 'point', path: variablePath('core.averageHotLegFlowKgPerS'), atMs: durationMs },
    acceptable: { min: 340, max: 1_105 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-loop-hydraulics'],
  },
  {
    id: 'loop-essential-loads-served',
    caseId: 'loss-offsite-power',
    label: 'Essential plant-control loads remain served after recovery',
    signal: 'plantControlsLoadA.servedFraction min after T+150s',
    expectation: 'Emergency power recovery should preserve essential control loads.',
    measure: { kind: 'minAfter', path: variablePath('plantControlsLoadA.servedFraction'), afterMs: 150_000 },
    acceptable: { min: 0.99 },
    severity: 'gate',
    sourceRefs: ['nrc-srp-ch15', 'leitbild-pwr-scope'],
  },
]

const compiledSystem = (testCase: CredibilityCase): CompiledProcessPlant =>
  compileProcessPlant(createPwrReferencePlantDefinition({
    id: testCase.id,
    title: `Credibility ${testCase.title}`,
    ...(testCase.parameters === undefined ? {} : { parameterOverrides: testCase.parameters }),
    ...(testCase.initialState === undefined ? {} : { valueOverrides: testCase.initialState }),
  }))

const configs = (): ReadonlyArray<ProcessPlantMultiPlantConfig> =>
  cases.map(testCase => {
    const plant = compiledSystem(testCase)
    return {
      plant,
      schedule: { actions: testCase.actions(plant) },
      protection: plant.automation,
      telemetry: {
        sampleIntervalMs,
        variables: telemetryVariables.map(variablePath),
      },
    }
  })

const main = async (): Promise<void> => {
  const caseDurationMs = (testCase: CredibilityCase): number => testCase.durationMs ?? durationMs
  const durations = [...new Set(cases.map(caseDurationMs))]
  const runConfigs = configs()
  const started = performance.now()
  const traces = durations.flatMap(duration => createProcessPlantMultiPlantTestbed(runConfigs.filter((_, index) => caseDurationMs(cases[index]!) === duration)).runFor(duration, stepMs))
  const wallMs = performance.now() - started
  const results = targets.map(target => evaluateProcessPlantCredibilityTarget(processPlantCredibilityTraceForCase(traces, target.caseId), target))
  const caseResults = processPlantCredibilityCaseResultSummaries(cases, results)
  const failedGateTargets = results.filter(result => !result.passed && result.severity === 'gate')
  const failedWatchTargets = results.filter(result => !result.passed && result.severity === 'watch')
  const firstGraph = runConfigs[0]?.plant.graph

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs,
    stepMs,
    sampleIntervalMs,
    modelRef: runConfigs[0]?.plant.modelRef,
    modelParameters: { loopCount: 4 },
    caseCount: cases.length,
    targetCount: targets.length,
    failedGateTargetCount: failedGateTargets.length,
    failedWatchTargetCount: failedWatchTargets.length,
    wallMs,
    realtimeFactor: cases.reduce((total, testCase) => total + caseDurationMs(testCase), 0) / wallMs,
    graph: firstGraph === undefined
      ? null
      : {
          componentCount: firstGraph.components.length,
          linkCount: firstGraph.links.length,
          variableCount: firstGraph.variables.length,
        },
    sourceRefs,
    cases,
    caseResults,
    results,
    automationRef: runConfigs[0]?.plant.automationRef,
    artifacts: {
      summaryJsonPath,
      reportSvgPath,
    },
  }

  await writeProcessPlantCredibilityArtifacts({
    summaryJsonPath,
    reportSvgPath,
    summary,
    reportSvg: renderProcessPlantCredibilityReportSvg({
      title: 'PWR Credibility Target Report',
      subtitle: `Source-backed target envelopes against the modular PWR assembly. Gate failures: ${failedGateTargets.length}; watch misses: ${failedWatchTargets.length}; wall ${wallMs.toFixed(0)}ms.`,
      scope: 'Scope: operational/training credibility, not licensing-basis safety analysis.',
      cases,
      results,
    }),
  })

  console.log(JSON.stringify({
    caseCount: summary.caseCount,
    targetCount: summary.targetCount,
    failedGateTargetCount: summary.failedGateTargetCount,
    failedWatchTargetCount: summary.failedWatchTargetCount,
    realtimeFactor: summary.realtimeFactor,
    summaryJsonPath,
    reportSvgPath,
  }, null, 2))
}

await main()
