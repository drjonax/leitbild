import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  createProcessPlantRuntime,
  type ProcessPlantRuntime,
  type ProcessPlantVariableSnapshot,
  type VariablePath,
} from '../../src/packs/process-plant/index.ts'
import {
  createProcessPlantScheduleRunner,
  createProcessPlantTelemetryRecorder,
  type ProcessPlantScheduledAction,
  type ProcessPlantTelemetrySeries,
} from '../../src/packs/process-plant/engineering/index.ts'

const durationMs = 600_000
const stepMs = 1_000
const sampleIntervalMs = 2_000
const artifactRoot = process.env.PROCESS_PLANT_EXTENDED_VALIDATION_ARTIFACT_ROOT ?? 'docs/assets'
const summaryJsonPath = `${artifactRoot}/process-plant-extended-validation-summary.json`
const traceSvgPath = `${artifactRoot}/process-plant-extended-validation-traces.svg`
const minRealtimeFactor = Number(process.env.PROCESS_PLANT_EXTENDED_VALIDATION_MIN_REALTIME_FACTOR ?? 12)

if (!Number.isFinite(minRealtimeFactor) || minRealtimeFactor <= 0) {
  throw new Error('PROCESS_PLANT_EXTENDED_VALIDATION_MIN_REALTIME_FACTOR must be a positive number when provided')
}

const variablePath = (value: string): VariablePath => value as VariablePath

const telemetryVariables = [
  'core.powerMw',
  'core.totalThermalPowerMw',
  'core.effectiveReactivityPcm',
  'core.boronFeedbackPcm',
  'vessel.primaryCoolantInventoryKg',
  'vessel.primaryPressureBiasMPa',
  'vessel.boronConcentrationPpm',
  'vessel.primaryLeakFlowKgPerS',
  'vessel.safetyInjectionFlowKgPerS',
  'vessel.tubeLeakFlowKgPerS',
  'containment.pressureMPa',
  'containment.incomingMassKgPerS',
  'containment.sumpInventoryKg',
  'containment.radiationSourceTermMSvPerH',
  'pressurizer.pressureMPa',
  'pressurizer.levelPercent',
  'pressurizer.steamMassKg',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.feedwaterFlowKgPerS',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'sgB.levelPercent',
  'sgA.collapsedLevelPercent',
  'sgB.collapsedLevelPercent',
  'sgB.pressureMPa',
  'sgB.primaryToSecondaryLeakKgPerS',
  'sgC.primaryToSecondaryLeakKgPerS',
  'rcpA.loopFlowKgPerS',
  'rcpB.loopFlowKgPerS',
  'feedwaterHeader.flowBalanceResidualKgPerS',
  'auxFeedwaterHeader.flowBalanceResidualKgPerS',
  'main-feedwater-pump-a-to-header.flowKgPerS',
  'main-feedwater-pump-b-to-header.flowKgPerS',
  'aux-feedwater-valve-a-to-sg-a.flowKgPerS',
  'mainSteamSafetyValve.effectivePositionFraction',
  'main-steam-safety-valve-to-atmosphere.flowKgPerS',
  'atmosphere.releasedMassKg',
  'turbine.electricMw',
  'turbine.steamDemandKgPerS',
  'turbine.steamAvailabilityFraction',
  'condenser.backPressurePa',
  'condenser.coolingWaterFlowKgPerS',
  'condenser.coolingWaterAvailabilityFraction',
  'offsiteGrid.voltageFraction',
  'safetyBusA.energized',
  'safetyBusA.voltageFraction',
  'safetyBusA.degraded',
  'safetyBusB.energized',
  'safetyBusB.voltageFraction',
  'dieselGeneratorA.running',
  'dieselGeneratorB.running',
  'chargingPump.flowKgPerS',
  'chargingPump.loopFlowKgPerS',
  'letdownValve.outletFlowKgPerS',
  'volumeControlTank.soluteConcentrationPpm',
  'safetyAccumulatorA.liquidInventoryKg',
  'safetyAccumulatorA.outletFlowKgPerS',
] as const satisfies ReadonlyArray<string>

type ValidationCaseId =
  | 'long-steady-state'
  | 'load-follow-cycle'
  | 'moderate-sgtr'
  | 'multi-sg-leak'
  | 'loss-feedwater-no-recovery'
  | 'loss-feedwater-afw-recovery'
  | 'rcp-pair-coastdown'
  | 'station-blackout-diesel-recovery'
  | 'degraded-voltage'
  | 'cooling-water-loss'
  | 'pressurizer-control-challenge'
  | 'main-steam-isolation-release'
  | 'boration-and-letdown'
  | 'large-break-loca'
  | 'combined-stress'

interface ValidationCase {
  readonly id: ValidationCaseId
  readonly title: string
  readonly description: string
  readonly parameters?: Record<string, Record<string, unknown>>
  readonly initialState?: Record<string, unknown>
  readonly actions: ReadonlyArray<ProcessPlantScheduledAction>
}

interface ValidationCheck {
  readonly caseId: ValidationCaseId
  readonly description: string
  readonly passed: boolean
  readonly details: string
}

interface Point {
  readonly x: number
  readonly y: number
}

interface ValidationTrace {
  readonly caseId: ValidationCaseId
  readonly title: string
  readonly telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>
}

const set = (id: string, atMs: number, path: string, value: number | boolean): ProcessPlantScheduledAction => ({
  id,
  atMs,
  type: 'setVariable',
  path: variablePath(path),
  value,
})

const trip = (id: string, atMs: number, componentId: string): ProcessPlantScheduledAction => ({
  id,
  atMs,
  type: 'tripComponent',
  componentId: componentId as never,
})

const cases: ReadonlyArray<ValidationCase> = [
  {
    id: 'long-steady-state',
    title: 'Long steady state',
    description: 'Ten-minute no-fault run checks slow drift and balance residuals.',
    actions: [],
  },
  {
    id: 'load-follow-cycle',
    title: 'Load follow cycle',
    description: 'Turbine load steps down and back up without destabilizing the primary plant.',
    actions: [
      set('load-down', 90_000, 'turbine.loadFraction', 0.45),
      set('load-up', 300_000, 'turbine.loadFraction', 0.92),
    ],
  },
  {
    id: 'moderate-sgtr',
    title: 'Moderate SGTR',
    description: 'Single steam generator tube leak should contaminate secondary side and drain primary inventory.',
    actions: [
      set('open-sg-a-leak', 90_000, 'sgA.tubeLeakFraction', 0.24),
    ],
  },
  {
    id: 'multi-sg-leak',
    title: 'Multiple SG leaks',
    description: 'Two smaller tube leaks check that parallel secondary contamination paths remain independent.',
    actions: [
      set('open-sg-b-leak', 90_000, 'sgB.tubeLeakFraction', 0.12),
      set('open-sg-c-leak', 180_000, 'sgC.tubeLeakFraction', 0.18),
    ],
  },
  {
    id: 'loss-feedwater-no-recovery',
    title: 'Loss of feedwater',
    description: 'Both main feedwater pumps trip with no operator recovery.',
    actions: [
      trip('trip-main-feed-a', 90_000, 'mainFeedwaterPumpA'),
      trip('trip-main-feed-b', 90_000, 'mainFeedwaterPumpB'),
    ],
  },
  {
    id: 'loss-feedwater-afw-recovery',
    title: 'Loss of feedwater with AFW',
    description: 'Main feedwater trips, then both auxiliary feed pumps and one branch are aligned.',
    actions: [
      trip('trip-main-feed-a', 90_000, 'mainFeedwaterPumpA'),
      trip('trip-main-feed-b', 90_000, 'mainFeedwaterPumpB'),
      set('start-motor-afw', 150_000, 'auxFeedwaterPumpMotor.running', true),
      set('start-turbine-afw', 150_000, 'auxFeedwaterPumpTurbine.running', true),
      set('open-afw-a', 150_000, 'auxFeedwaterValveA.positionFraction', 1),
    ],
  },
  {
    id: 'rcp-pair-coastdown',
    title: 'Two RCP coastdown',
    description: 'Two reactor coolant pumps trip at different times and flow should coast down smoothly.',
    actions: [
      trip('trip-rcp-a', 90_000, 'rcpA'),
      trip('trip-rcp-b', 180_000, 'rcpB'),
    ],
  },
  {
    id: 'station-blackout-diesel-recovery',
    title: 'Station blackout and diesel recovery',
    description: 'Offsite power is lost, then emergency diesels are started and tied to the safety buses.',
    actions: [
      set('turbine-runback', 90_000, 'turbine.loadFraction', 0),
      set('loss-offsite', 90_000, 'offsiteGrid.available', false),
      set('open-offsite-a-on-loss', 90_000, 'offsiteBreakerA.closed', false),
      set('open-offsite-b-on-loss', 90_000, 'offsiteBreakerB.closed', false),
      set('open-unit-a-on-loss', 90_000, 'unitBusBreakerA.closed', false),
      set('open-unit-b-on-loss', 90_000, 'unitBusBreakerB.closed', false),
      set('start-diesel-a', 150_000, 'dieselGeneratorA.startCommand', true),
      set('start-diesel-b', 150_000, 'dieselGeneratorB.startCommand', true),
      set('close-diesel-a', 210_000, 'dieselBreakerA.closed', true),
      set('close-diesel-b', 210_000, 'dieselBreakerB.closed', true),
    ],
  },
  {
    id: 'degraded-voltage',
    title: 'Degraded voltage',
    description: 'Offsite voltage sags below degraded threshold but remains above complete loss.',
    actions: [
      set('reduce-local-generator', 60_000, 'turbine.loadFraction', 0),
      set('voltage-sag', 90_000, 'offsiteGrid.voltageFraction', 0.74),
      set('voltage-recover', 360_000, 'offsiteGrid.voltageFraction', 1),
    ],
  },
  {
    id: 'cooling-water-loss',
    title: 'Cooling water loss',
    description: 'Circulating water pump trips and condenser backpressure should rise.',
    actions: [
      trip('trip-cw-pump', 90_000, 'circulatingWaterPump'),
    ],
  },
  {
    id: 'pressurizer-control-challenge',
    title: 'Pressurizer challenge',
    description: 'Heaters, spray, and relief are exercised through a pressure-control transient.',
    actions: [
      set('increase-heater', 90_000, 'pressurizer.heaterPowerMw', 30),
      set('spray-on', 180_000, 'pressurizer.sprayFlowKgPerS', 12),
      set('relief-open', 300_000, 'pressurizer.reliefValvePositionFraction', 0.15),
      set('relief-close', 360_000, 'pressurizer.reliefValvePositionFraction', 0),
    ],
  },
  {
    id: 'main-steam-isolation-release',
    title: 'Steam isolation and safety release',
    description: 'Turbine stop valve closes under high SG pressure to exercise main steam safety release to atmosphere.',
    initialState: {
      'sgA.pressureMPa': 9.85,
      'sgB.pressureMPa': 9.85,
      'sgC.pressureMPa': 9.85,
      'sgD.pressureMPa': 9.85,
      'mainSteamHeader.mixedPressureMPa': 9.85,
      'main-steam-header-to-safety-valve.pressureMPa': 9.85,
      'turbineStopValve.positionFraction': 0,
      'turbineBypassValve.positionFailureActive': true,
      'turbineBypassValve.failedPositionFraction': 0,
    },
    actions: [],
  },
  {
    id: 'boration-and-letdown',
    title: 'Boration and letdown',
    description: 'High-boron volume-control-tank makeup and charging should raise vessel boron feedback.',
    parameters: {
      volumeControlTank: {
        initialSoluteConcentrationPpm: 2_500,
        makeupFlowKgPerS: 20,
        makeupSoluteConcentrationPpm: 2_500,
      },
    },
    actions: [
      set('vct-makeup', 60_000, 'volumeControlTank.makeupFlowKgPerS', 18),
      set('charging-up', 90_000, 'chargingPump.speedFraction', 1),
      set('letdown-reduce', 90_000, 'letdownValve.positionFraction', 0.15),
      set('rod-trim', 300_000, 'core.rodInsertionFraction', 0.08),
    ],
  },
  {
    id: 'large-break-loca',
    title: 'Large-break LOCA',
    description: 'Primary boundary leak should lower inventory, raise containment response, and start accumulator injection.',
    actions: [
      set('open-hot-leg-leak', 90_000, 'rcs-hot-leg-a.leak.areaFraction', 0.85),
    ],
  },
  {
    id: 'combined-stress',
    title: 'Combined stress',
    description: 'SGTR, feedwater degradation, load reduction, and one RCP trip occur in one long run.',
    actions: [
      set('combined-sgtr', 90_000, 'sgA.tubeLeakFraction', 0.18),
      trip('combined-feed-a', 150_000, 'mainFeedwaterPumpA'),
      trip('combined-rcp-a', 210_000, 'rcpA'),
      set('combined-load-down', 300_000, 'turbine.loadFraction', 0.3),
    ],
  },
]

const compiledSystem = (testCase: ValidationCase) => compileProcessPlant(createPwrReferencePlantDefinition({
  id: testCase.id,
  title: `Extended Validation ${testCase.title}`,
  ...(testCase.parameters === undefined ? {} : { parameterOverrides: testCase.parameters }),
  ...(testCase.initialState === undefined ? {} : { valueOverrides: testCase.initialState }),
}))

const seriesFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ProcessPlantTelemetrySeries => {
  const series = telemetry.find(candidate => candidate.path === path)
  if (!series) throw new Error(`extended validation telemetry missing series: ${path}`)
  return series
}

const numericValues = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ReadonlyArray<number> => seriesFor(telemetry, path).points.map(point => {
  if (typeof point.value !== 'number') throw new Error(`extended validation series is not numeric: ${path}`)
  return point.value
})

const booleanValues = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ReadonlyArray<boolean> => seriesFor(telemetry, path).points.map(point => {
  if (typeof point.value !== 'boolean') throw new Error(`extended validation series is not boolean: ${path}`)
  return point.value
})

const valueAtOrAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => {
  const point = seriesFor(telemetry, path).points.find(candidate => candidate.elapsedMs >= elapsedMs)
  if (!point) throw new Error(`extended validation missing ${path} at ${elapsedMs}ms`)
  if (typeof point.value !== 'number') throw new Error(`extended validation series is not numeric: ${path}`)
  return point.value
}

const boolAtOrAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): boolean => {
  const point = seriesFor(telemetry, path).points.find(candidate => candidate.elapsedMs >= elapsedMs)
  if (!point) throw new Error(`extended validation missing ${path} at ${elapsedMs}ms`)
  if (typeof point.value !== 'boolean') throw new Error(`extended validation series is not boolean: ${path}`)
  return point.value
}

const maxAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => Math.max(...seriesFor(telemetry, path).points
  .filter(point => point.elapsedMs >= elapsedMs)
  .map(point => {
    if (typeof point.value !== 'number') throw new Error(`extended validation series is not numeric: ${path}`)
    return point.value
  }))

const minAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => Math.min(...seriesFor(telemetry, path).points
  .filter(point => point.elapsedMs >= elapsedMs)
  .map(point => {
    if (typeof point.value !== 'number') throw new Error(`extended validation series is not numeric: ${path}`)
    return point.value
  }))

const check = (
  caseId: ValidationCaseId,
  description: string,
  passed: boolean,
  details: string,
): ValidationCheck => ({ caseId, description, passed, details })

const nonnegativePaths: ReadonlySet<string> = new Set([
  'core.powerMw',
  'core.totalThermalPowerMw',
  'vessel.primaryCoolantInventoryKg',
  'vessel.boronConcentrationPpm',
  'vessel.primaryLeakFlowKgPerS',
  'vessel.safetyInjectionFlowKgPerS',
  'vessel.tubeLeakFlowKgPerS',
  'containment.pressureMPa',
  'containment.sumpInventoryKg',
  'containment.radiationSourceTermMSvPerH',
  'pressurizer.pressureMPa',
  'pressurizer.levelPercent',
  'pressurizer.steamMassKg',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.feedwaterFlowKgPerS',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'sgB.levelPercent',
  'sgB.pressureMPa',
  'sgB.primaryToSecondaryLeakKgPerS',
  'sgC.primaryToSecondaryLeakKgPerS',
  'rcpA.loopFlowKgPerS',
  'rcpB.loopFlowKgPerS',
  'turbine.electricMw',
  'turbine.steamDemandKgPerS',
  'turbine.steamAvailabilityFraction',
  'condenser.backPressurePa',
  'condenser.coolingWaterFlowKgPerS',
  'condenser.coolingWaterAvailabilityFraction',
  'offsiteGrid.voltageFraction',
  'safetyBusA.voltageFraction',
  'safetyBusB.voltageFraction',
  'chargingPump.loopFlowKgPerS',
  'safetyAccumulatorA.liquidInventoryKg',
  'safetyAccumulatorA.outletFlowKgPerS',
])

const evaluateIntegrity = (
  caseId: ValidationCaseId,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
): ReadonlyArray<ValidationCheck> => {
  const badFinite = telemetry.flatMap(series => series.points.map(point => ({ path: series.path, value: point.value })))
    .find(point => typeof point.value === 'number' && !Number.isFinite(point.value))
  const badNegative = telemetry.flatMap(series => series.points.map(point => ({ path: series.path, value: point.value })))
    .find(point => typeof point.value === 'number' && nonnegativePaths.has(point.path) && point.value < -1e-7)
  const maxFeedHeaderResidual = Math.max(...numericValues(telemetry, 'feedwaterHeader.flowBalanceResidualKgPerS').map(Math.abs))
  const maxAuxHeaderResidual = Math.max(...numericValues(telemetry, 'auxFeedwaterHeader.flowBalanceResidualKgPerS').map(Math.abs))
  const minLevel = Math.min(...[
    ...numericValues(telemetry, 'sgA.levelPercent'),
    ...numericValues(telemetry, 'sgB.levelPercent'),
  ])
  const maxLevel = Math.max(...[
    ...numericValues(telemetry, 'sgA.levelPercent'),
    ...numericValues(telemetry, 'sgB.levelPercent'),
  ])
  const minVoltage = Math.min(...[
    ...numericValues(telemetry, 'safetyBusA.voltageFraction'),
    ...numericValues(telemetry, 'safetyBusB.voltageFraction'),
  ])
  const maxVoltage = Math.max(...[
    ...numericValues(telemetry, 'safetyBusA.voltageFraction'),
    ...numericValues(telemetry, 'safetyBusB.voltageFraction'),
  ])
  return [
    check(caseId, 'all numeric telemetry remains finite', badFinite === undefined, badFinite === undefined ? 'all finite' : `${badFinite.path}=${String(badFinite.value)}`),
    check(caseId, 'nonnegative telemetry remains nonnegative', badNegative === undefined, badNegative === undefined ? 'all nonnegative' : `${badNegative.path}=${String(badNegative.value)}`),
    check(caseId, 'feedwater headers preserve flow balance', maxFeedHeaderResidual < 1e-6 && maxAuxHeaderResidual < 1e-6, `main=${maxFeedHeaderResidual.toExponential(2)} aux=${maxAuxHeaderResidual.toExponential(2)}kg/s`),
    check(caseId, 'steam generator levels stay bounded', minLevel >= 0 && maxLevel <= 100, `min=${minLevel.toFixed(1)} max=${maxLevel.toFixed(1)}%`),
    check(caseId, 'electrical bus voltage ratios stay bounded', minVoltage >= 0 && maxVoltage <= 1.05, `min=${minVoltage.toFixed(2)} max=${maxVoltage.toFixed(2)}`),
  ]
}

const evaluateCase = (
  caseId: ValidationCaseId,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
): ReadonlyArray<ValidationCheck> => {
  if (caseId === 'long-steady-state') {
    const startPower = valueAtOrAfter(telemetry, 'core.powerMw', 30_000)
    const endPower = valueAtOrAfter(telemetry, 'core.powerMw', durationMs)
    const endPressure = valueAtOrAfter(telemetry, 'pressurizer.pressureMPa', durationMs)
    return [
      check(caseId, 'long-run power remains plausible', endPower > 2_000 && endPower < 4_500, `end=${endPower.toFixed(1)}MW`),
      check(caseId, 'long-run pressure remains plausible', endPressure > 13 && endPressure < 18, `end=${endPressure.toFixed(2)}MPa`),
      check(caseId, 'long-run drift remains limited', Math.abs(endPower - startPower) < 700, `start=${startPower.toFixed(1)} end=${endPower.toFixed(1)}MW`),
    ]
  }
  if (caseId === 'load-follow-cycle') {
    const before = valueAtOrAfter(telemetry, 'turbine.electricMw', 80_000)
    const reduced = minAfter(telemetry, 'turbine.electricMw', 150_000)
    const recovered = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
    return [
      check(caseId, 'load step down lowers turbine output', reduced < before * 0.75, `before=${before.toFixed(1)} min=${reduced.toFixed(1)}MW`),
      check(caseId, 'load step up recovers turbine output', recovered > reduced * 1.35, `recovered=${recovered.toFixed(1)}MW`),
    ]
  }
  if (caseId === 'moderate-sgtr') {
    const leak = maxAfter(telemetry, 'sgA.primaryToSecondaryLeakKgPerS', 120_000)
    const radiation = maxAfter(telemetry, 'sgA.secondaryRadiationMSvPerH', 120_000)
    const beforeInventory = valueAtOrAfter(telemetry, 'vessel.primaryCoolantInventoryKg', 80_000)
    const endInventory = valueAtOrAfter(telemetry, 'vessel.primaryCoolantInventoryKg', durationMs)
    return [
      check(caseId, 'SGTR produces leak flow', leak > 0.1, `leak=${leak.toFixed(2)}kg/s`),
      check(caseId, 'SGTR raises secondary radiation', radiation > 0.01, `radiation=${radiation.toFixed(3)}mSv/h`),
      check(caseId, 'SGTR drains primary inventory', endInventory < beforeInventory - 100, `before=${beforeInventory.toFixed(0)} end=${endInventory.toFixed(0)}kg`),
    ]
  }
  if (caseId === 'multi-sg-leak') {
    const leakB = maxAfter(telemetry, 'sgB.primaryToSecondaryLeakKgPerS', 120_000)
    const leakC = maxAfter(telemetry, 'sgC.primaryToSecondaryLeakKgPerS', 210_000)
    return [
      check(caseId, 'first secondary leak path becomes active', leakB > 0.05, `sgB=${leakB.toFixed(2)}kg/s`),
      check(caseId, 'second secondary leak path becomes active independently', leakC > 0.05, `sgC=${leakC.toFixed(2)}kg/s`),
    ]
  }
  if (caseId === 'loss-feedwater-no-recovery') {
    const beforeLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', 80_000)
    const endLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', durationMs)
    const feedAfter = maxAfter(telemetry, 'sgA.feedwaterFlowKgPerS', 180_000)
    return [
      check(caseId, 'loss of feedwater materially lowers SG level', endLevel < beforeLevel - 8, `before=${beforeLevel.toFixed(1)} end=${endLevel.toFixed(1)}%`),
      check(caseId, 'main feedwater contribution remains low after trip', feedAfter < 80, `maxFeed=${feedAfter.toFixed(1)}kg/s`),
    ]
  }
  if (caseId === 'loss-feedwater-afw-recovery') {
    const mainFeedAfter = maxAfter(telemetry, 'main-feedwater-pump-a-to-header.flowKgPerS', 180_000)
      + maxAfter(telemetry, 'main-feedwater-pump-b-to-header.flowKgPerS', 180_000)
    const auxFeed = maxAfter(telemetry, 'aux-feedwater-valve-a-to-sg-a.flowKgPerS', 210_000)
    // This trace runs without protection, so the reactor stays at power: AFW,
    // sized for decay heat, cannot hold a generator steaming at full power. It
    // slows the inventory loss of the generator it feeds against the others.
    // Compared 50 s after AFW starts, before the generators have boiled dry.
    const alignedInventory = valueAtOrAfter(telemetry, 'sgA.collapsedLevelPercent', 200_000)
    const unalignedInventory = valueAtOrAfter(telemetry, 'sgB.collapsedLevelPercent', 200_000)
    return [
      check(caseId, 'main feedwater remains isolated after trip', mainFeedAfter < 80, `maxMain=${mainFeedAfter.toFixed(1)}kg/s`),
      check(caseId, 'auxiliary feedwater reaches aligned branch', auxFeed > 20, `maxAux=${auxFeed.toFixed(1)}kg/s`),
      check(caseId, 'auxiliary feedwater slows the inventory loss of the aligned SG', alignedInventory > unalignedInventory + 3, `alignedSgA=${alignedInventory.toFixed(1)}% unalignedSgB=${unalignedInventory.toFixed(1)}% of full height at T+200s`),
    ]
  }
  if (caseId === 'rcp-pair-coastdown') {
    const aBefore = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 80_000)
    const aAfter = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', durationMs)
    const bBefore = valueAtOrAfter(telemetry, 'rcpB.loopFlowKgPerS', 170_000)
    const bShortAfter = valueAtOrAfter(telemetry, 'rcpB.loopFlowKgPerS', 190_000)
    const bAfter = valueAtOrAfter(telemetry, 'rcpB.loopFlowKgPerS', durationMs)
    return [
      check(caseId, 'first tripped RCP flow coasts down', aAfter < aBefore * 0.75, `before=${aBefore.toFixed(0)} end=${aAfter.toFixed(0)}kg/s`),
      check(caseId, 'second tripped RCP does not instantly collapse', bShortAfter > bBefore * 0.35, `before=${bBefore.toFixed(0)} short=${bShortAfter.toFixed(0)}kg/s`),
      check(caseId, 'second tripped RCP materially lowers flow', bAfter < bBefore * 0.8, `before=${bBefore.toFixed(0)} end=${bAfter.toFixed(0)}kg/s`),
    ]
  }
  if (caseId === 'station-blackout-diesel-recovery') {
    const busALost = boolAtOrAfter(telemetry, 'safetyBusA.energized', 120_000) === false
    const dieselA = booleanValues(telemetry, 'dieselGeneratorA.running').some(Boolean)
    const dieselB = booleanValues(telemetry, 'dieselGeneratorB.running').some(Boolean)
    const busARecovered = boolAtOrAfter(telemetry, 'safetyBusA.energized', 300_000)
    const busBRecovered = boolAtOrAfter(telemetry, 'safetyBusB.energized', 300_000)
    return [
      check(caseId, 'offsite loss de-energizes safety train before recovery', busALost, `busAAt120s=${String(!busALost)}`),
      check(caseId, 'diesel generators start after command', dieselA && dieselB, `dieselA=${String(dieselA)} dieselB=${String(dieselB)}`),
      check(caseId, 'diesels restore safety buses after tie-in', busARecovered && busBRecovered, `busA=${String(busARecovered)} busB=${String(busBRecovered)}`),
    ]
  }
  if (caseId === 'degraded-voltage') {
    const sourceSag = minAfter(telemetry, 'offsiteGrid.voltageFraction', 120_000)
    const endVoltage = valueAtOrAfter(telemetry, 'offsiteGrid.voltageFraction', durationMs)
    return [
      check(caseId, 'degraded offsite voltage source is observed', sourceSag < 0.8, `sourceSag=${sourceSag.toFixed(2)}`),
      check(caseId, 'offsite source voltage recovers after source recovery', endVoltage > 0.95, `endVoltage=${endVoltage.toFixed(2)}`),
    ]
  }
  if (caseId === 'cooling-water-loss') {
    const beforeFlow = valueAtOrAfter(telemetry, 'condenser.coolingWaterFlowKgPerS', 80_000)
    const endFlow = valueAtOrAfter(telemetry, 'condenser.coolingWaterFlowKgPerS', durationMs)
    const beforeBackPressure = valueAtOrAfter(telemetry, 'condenser.backPressurePa', 80_000)
    const peakBackPressure = maxAfter(telemetry, 'condenser.backPressurePa', 180_000)
    return [
      check(caseId, 'cooling-water pump trip lowers cooling flow', endFlow < beforeFlow * 0.35, `before=${beforeFlow.toFixed(0)} end=${endFlow.toFixed(0)}kg/s`),
      check(caseId, 'cooling-water loss raises condenser backpressure', peakBackPressure > beforeBackPressure, `before=${beforeBackPressure.toFixed(0)} peak=${peakBackPressure.toFixed(0)}Pa`),
    ]
  }
  if (caseId === 'pressurizer-control-challenge') {
    const relief = maxAfter(telemetry, 'pressurizer.reliefFlowKgPerS', 330_000)
    const minPressure = minAfter(telemetry, 'pressurizer.pressureMPa', 180_000)
    const maxPressure = maxAfter(telemetry, 'pressurizer.pressureMPa', 90_000)
    return [
      check(caseId, 'relief path carries steam when opened', relief > 0.1, `relief=${relief.toFixed(2)}kg/s`),
      check(caseId, 'pressurizer pressure remains bounded through challenge', minPressure > 10 && maxPressure < 19.5, `min=${minPressure.toFixed(2)} max=${maxPressure.toFixed(2)}MPa`),
    ]
  }
  if (caseId === 'main-steam-isolation-release') {
    const valve = maxAfter(telemetry, 'mainSteamSafetyValve.effectivePositionFraction', 0)
    const release = maxAfter(telemetry, 'main-steam-safety-valve-to-atmosphere.flowKgPerS', 0)
    const released = valueAtOrAfter(telemetry, 'atmosphere.releasedMassKg', durationMs)
    const containmentInflow = maxAfter(telemetry, 'containment.incomingMassKgPerS', 0)
    return [
      check(caseId, 'main steam safety valve opens on isolated high pressure path', valve > 0.9, `valve=${valve.toFixed(2)}`),
      check(caseId, 'main steam safety path relieves steam to atmosphere', release > 100 && released > 1_000, `release=${release.toFixed(1)}kg/s released=${released.toFixed(0)}kg`),
      check(caseId, 'the steam release does not enter containment', containmentInflow === 0, `maxContainmentInflow=${containmentInflow.toFixed(3)}kg/s`),
    ]
  }
  if (caseId === 'boration-and-letdown') {
    const vesselBefore = valueAtOrAfter(telemetry, 'vessel.boronConcentrationPpm', 80_000)
    const vesselEnd = valueAtOrAfter(telemetry, 'vessel.boronConcentrationPpm', durationMs)
    const boronFeedback = minAfter(telemetry, 'core.boronFeedbackPcm', 180_000)
    const charging = maxAfter(telemetry, 'chargingPump.flowKgPerS', 120_000)
    return [
      check(caseId, 'charging path carries CVCS flow', charging > 1, `charging=${charging.toFixed(2)}kg/s`),
      check(caseId, 'vessel boron concentration rises after borated makeup', vesselEnd > vesselBefore + 1, `before=${vesselBefore.toFixed(1)} end=${vesselEnd.toFixed(1)}ppm`),
      check(caseId, 'boron increase produces negative reactivity feedback', boronFeedback < 0, `minBoronFeedback=${boronFeedback.toFixed(1)}pcm`),
    ]
  }
  if (caseId === 'large-break-loca') {
    const release = maxAfter(telemetry, 'vessel.primaryLeakFlowKgPerS', 120_000)
    const containmentSump = valueAtOrAfter(telemetry, 'containment.sumpInventoryKg', durationMs)
    const containmentInlet = maxAfter(telemetry, 'containment.incomingMassKgPerS', 120_000)
    const injection = maxAfter(telemetry, 'safetyAccumulatorA.outletFlowKgPerS', 150_000)
    const accumulatorStart = valueAtOrAfter(telemetry, 'safetyAccumulatorA.liquidInventoryKg', 80_000)
    const accumulatorEnd = valueAtOrAfter(telemetry, 'safetyAccumulatorA.liquidInventoryKg', durationMs)
    return [
      check(caseId, 'large break produces primary leak flow', release > 10, `release=${release.toFixed(1)}kg/s`),
      check(caseId, 'containment receives released primary mass', containmentInlet > 10, `incomingMass=${containmentInlet.toFixed(1)}kg/s sump=${containmentSump.toFixed(0)}kg`),
      check(caseId, 'accumulator injects during depressurization', injection > 1, `injection=${injection.toFixed(1)}kg/s`),
      check(caseId, 'accumulator inventory falls during injection', accumulatorEnd < accumulatorStart, `start=${accumulatorStart.toFixed(0)} end=${accumulatorEnd.toFixed(0)}kg`),
    ]
  }
  const sgtr = maxAfter(telemetry, 'sgA.primaryToSecondaryLeakKgPerS', 120_000)
  const feed = maxAfter(telemetry, 'main-feedwater-pump-a-to-header.flowKgPerS', 210_000)
  const flowBefore = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 200_000)
  const flowEnd = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', durationMs)
  const electricBefore = valueAtOrAfter(telemetry, 'turbine.electricMw', 280_000)
  const electricEnd = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
  return [
    check(caseId, 'combined stress includes SGTR leak', sgtr > 0.1, `sgtr=${sgtr.toFixed(2)}kg/s`),
    check(caseId, 'combined stress includes feedwater degradation', feed < 80, `feed=${feed.toFixed(1)}kg/s`),
    check(caseId, 'combined stress lowers tripped loop flow', flowEnd < flowBefore * 0.8, `before=${flowBefore.toFixed(0)} end=${flowEnd.toFixed(0)}kg/s`),
    check(caseId, 'combined stress lowers turbine output after load cut', electricEnd < electricBefore * 0.8, `before=${electricBefore.toFixed(1)} end=${electricEnd.toFixed(1)}MW`),
  ]
}

const runCase = (testCase: ValidationCase): ValidationTrace => {
  const system = compiledSystem(testCase)
  const runtime = createProcessPlantRuntime({ system, assertInvariants: true })
  const schedule = createProcessPlantScheduleRunner({ system, schedule: { actions: testCase.actions } })
  const telemetry = createProcessPlantTelemetryRecorder({
    plantId: testCase.id,
    telemetry: {
      sampleIntervalMs,
      variables: telemetryVariables.map(variablePath),
    },
  })
  telemetry.recordDueSamples(runtime)
  let simulatedMs = 0
  while (simulatedMs < durationMs) {
    const tickMs = Math.min(stepMs, durationMs - simulatedMs)
    const nextElapsedMs = simulatedMs + tickMs
    schedule.applyDueActions(runtime, nextElapsedMs)
    runtime.tick(tickMs)
    telemetry.recordDueSamples(runtime)
    simulatedMs = nextElapsedMs
  }
  return {
    caseId: testCase.id,
    title: testCase.title,
    telemetry: telemetry.series(),
  }
}

const snapshotByPath = (
  runtime: ProcessPlantRuntime,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<ProcessPlantVariableSnapshot> => paths.map(path => runtime.readVariableSnapshot(path))

const svgEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const pointsFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  scale: number,
): ReadonlyArray<Point> => seriesFor(telemetry, path).points.map(point => {
  if (typeof point.value !== 'number') throw new Error(`extended validation plot series is not numeric: ${path}`)
  return { x: point.elapsedMs / 1_000, y: point.value * scale }
})

const scaledPath = (
  points: ReadonlyArray<Point>,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  yMin: number,
  yMax: number,
): string => {
  const span = yMax - yMin
  if (span <= 0) throw new Error('extended validation plot y span must be positive')
  return points.map((point, index) => {
    const x = bounds.x + (point.x / (durationMs / 1_000)) * bounds.width
    const y = bounds.y + bounds.height - ((point.y - yMin) / span) * bounds.height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

const renderPanel = (
  trace: ValidationTrace,
  x: number,
  y: number,
): string => {
  const width = 350
  const height = 210
  const bounds = { x: x + 48, y: y + 56, width: width - 76, height: height - 96 }
  const series = [
    { label: 'Core MW / 10', color: '#2563eb', points: pointsFor(trace.telemetry, 'core.powerMw', 0.1) },
    { label: 'SG A level %', color: '#0f766e', points: pointsFor(trace.telemetry, 'sgA.levelPercent', 1) },
    { label: 'PZR MPa x 10', color: '#dc2626', points: pointsFor(trace.telemetry, 'pressurizer.pressureMPa', 10) },
    { label: 'Turbine MW / 10', color: '#f59e0b', points: pointsFor(trace.telemetry, 'turbine.electricMw', 0.1) },
  ] as const
  const paths = series.map(item => `<path d="${scaledPath(item.points, bounds, 0, 420)}" fill="none" stroke="${item.color}" stroke-width="2"/>`).join('\n')
  const legend = series.map((item, index) => `
    <g transform="translate(${x + 54 + (index % 2) * 142}, ${y + height - 30 + Math.floor(index / 2) * 15})">
      <line x1="0" y1="0" x2="16" y2="0" stroke="${item.color}" stroke-width="3"/>
      <text x="22" y="4" font-family="Inter, system-ui, sans-serif" font-size="10.5" fill="#374151">${svgEscape(item.label)}</text>
    </g>`).join('')
  return `
    <g>
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="#d1d5db"/>
      <text x="${x + 20}" y="${y + 27}" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="700" fill="#111827">${svgEscape(trace.title)}</text>
      <line x1="${bounds.x}" y1="${bounds.y + bounds.height}" x2="${bounds.x + bounds.width}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
      <line x1="${bounds.x}" y1="${bounds.y}" x2="${bounds.x}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
      ${paths}
      ${legend}
    </g>`
}

const renderSvg = (
  traces: ReadonlyArray<ValidationTrace>,
  checks: ReadonlyArray<ValidationCheck>,
  realtimeFactor: number,
): string => {
  const columns = 3
  const panelRows = Math.ceil(traces.length / columns)
  const svgHeight = 92 + panelRows * 246 + 64
  const failed = checks.filter(candidate => !candidate.passed)
  const panels = traces.map((trace, index) => renderPanel(trace, 48 + (index % columns) * 374, 92 + Math.floor(index / columns) * 246)).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${svgHeight}" viewBox="0 0 1200 ${svgHeight}">
  <rect width="1200" height="${svgHeight}" fill="#f8fafc"/>
  <text x="48" y="42" font-family="Inter, system-ui, sans-serif" font-size="25" font-weight="800" fill="#111827">Process Plant Extended Validation</text>
  <text x="48" y="66" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#64748b">${traces.length} ten-minute validation runs. Checks: ${checks.length - failed.length}/${checks.length} passed. Realtime factor: ${realtimeFactor.toFixed(1)}x.</text>
  ${panels}
</svg>`
}

const main = async (): Promise<void> => {
  const firstCase = cases[0]
  if (!firstCase) throw new Error('extended validation has no cases')
  const probeRuntime = createProcessPlantRuntime({ system: compiledSystem(firstCase) })
  snapshotByPath(probeRuntime, telemetryVariables.map(variablePath))
  const started = performance.now()
  const traces = cases.map(runCase)
  const wallMs = performance.now() - started
  const checks = traces.flatMap(trace => [
    ...evaluateIntegrity(trace.caseId, trace.telemetry),
    ...evaluateCase(trace.caseId, trace.telemetry),
  ])
  const realtimeFactor = (durationMs * cases.length) / wallMs
  const performanceCheck = check(
    'long-steady-state',
    'extended validation remains faster than realtime',
    realtimeFactor >= minRealtimeFactor,
    `realtimeFactor=${realtimeFactor.toFixed(1)}x min=${minRealtimeFactor.toFixed(1)}x`,
  )
  const allChecks = [...checks, performanceCheck]
  const failed = allChecks.filter(candidate => !candidate.passed)

  await mkdir(dirname(summaryJsonPath), { recursive: true })
  await writeFile(traceSvgPath, renderSvg(traces, allChecks, realtimeFactor), 'utf8')
  await writeFile(summaryJsonPath, `${JSON.stringify({
    schemaVersion: 1,
    durationMs,
    stepMs,
    sampleIntervalMs,
    caseCount: cases.length,
    checkCount: allChecks.length,
    failedCheckCount: failed.length,
    wallMs,
    realtimeFactor,
    minRealtimeFactor,
    checks: allChecks,
    artifacts: {
      summaryJsonPath,
      traceSvgPath,
    },
  }, null, 2)}\n`, 'utf8')

  if (failed.length > 0) {
    const details = failed.map(item => `${item.caseId}: ${item.description} (${item.details})`).join('; ')
    throw new Error(`process plant extended validation failed: ${details}`)
  }
  console.log(`process plant extended validation passed ${allChecks.length}/${allChecks.length} checks`)
  console.log(`trace: ${traceSvgPath}`)
  console.log(`summary: ${summaryJsonPath}`)
  console.log(`realtime factor: ${realtimeFactor.toFixed(1)}x`)
}

await main()
