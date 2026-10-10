import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  type PwrTransientDiagnostics,
  type VariablePath,
} from '../../src/packs/process-plant/index.ts'
import {
  createProcessPlantMultiPlantTestbed,
  type ProcessPlantMultiPlantConfig,
  type ProcessPlantMultiPlantSnapshot,
  type ProcessPlantScheduledAction,
  type ProcessPlantTelemetrySeries,
} from '../../src/packs/process-plant/engineering/index.ts'

const durationMs = 240_000
const stepMs = 1_000
const sampleIntervalMs = 1_000
const artifactRoot = process.env.PROCESS_PLANT_ACCEPTANCE_ARTIFACT_ROOT ?? 'docs/assets'
const traceSvgPath = `${artifactRoot}/process-plant-acceptance-traces.svg`
const traceCsvPath = `${artifactRoot}/process-plant-acceptance-traces.csv`
const summaryJsonPath = `${artifactRoot}/process-plant-acceptance-summary.json`
const minRealtimeFactor = Number(process.env.PROCESS_PLANT_ACCEPTANCE_MIN_REALTIME_FACTOR ?? 20)
const writeCsvTrace = process.env.PROCESS_PLANT_ACCEPTANCE_WRITE_CSV === '1'

if (!Number.isFinite(minRealtimeFactor) || minRealtimeFactor <= 0) {
  throw new Error('PROCESS_PLANT_ACCEPTANCE_MIN_REALTIME_FACTOR must be a positive number when provided')
}

const variablePath = (value: string): VariablePath => value as VariablePath

const telemetryVariables = [
  'core.powerMw',
  'core.fissionPowerMw',
  'core.totalThermalPowerMw',
  'core.temperatureFeedbackPcm',
  'core.effectiveReactivityPcm',
  'core.fuelLowerTemperatureC',
  'core.fuelMidTemperatureC',
  'core.fuelUpperTemperatureC',
  'core.fuelStoredEnergyMj',
  'core.decayHeatMw',
  'vessel.primaryPressureBiasMPa',
  'vessel.compressibilityPressureBiasMPa',
  'vessel.thermalExpansionPressureBiasMPa',
  'vessel.meanPrimaryCoolantTemperatureC',
  'vessel.primaryCoolantInventoryKg',
  'vessel.safetyInjectionFlowKgPerS',
  'vessel.primaryLeakFlowKgPerS',
  'vessel.primaryReleaseRadiationMSvPerH',
  'vessel-release-to-containment.flowKgPerS',
  'containment.pressureMPa',
  'containment.temperatureC',
  'containment.sumpInventoryKg',
  'containment.incomingMassKgPerS',
  'containment.radiationSourceTermMSvPerH',
  'safetyAccumulatorA.liquidInventoryKg',
  'safetyAccumulatorA.outletFlowKgPerS',
  'safetyAccumulatorA.gasPressureMPa',
  'pressurizer.pressureMPa',
  'pressurizer.steamPressureMPa',
  'pressurizer.pressureTargetMPa',
  'pressurizer.steamMassKg',
  'pressurizer.steamVolumeM3',
  'pressurizer.waterInventoryBalanceResidualKg',
  'pressurizer.steamMassBalanceResidualKg',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.pressureTargetMPa',
  'sgA.steamMassKg',
  'sgA.steamOutflowKgPerS',
  'sgA.feedwaterFlowKgPerS',
  'sgA.secondaryInventoryBalanceResidualKg',
  'sgA.steamMassBalanceResidualKg',
  'sgA.boilingEnergyResidualMw',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'turbine.electricMw',
  'turbine.steamDemandKgPerS',
  'turbine.steamAvailabilityFraction',
  'turbine.exhaustTemperatureC',
  'feedwaterHeader.flowBalanceResidualKgPerS',
  'auxFeedwaterHeader.flowBalanceResidualKgPerS',
  'main-feedwater-pump-a-to-header.flowKgPerS',
  'main-feedwater-pump-b-to-header.flowKgPerS',
  'motor-afw-pump-to-header.flowKgPerS',
  'aux-feedwater-valve-a-to-sg-a.flowKgPerS',
  'mainSteamSafetyValve.effectivePositionFraction',
  'main-steam-header-to-safety-valve.flowKgPerS',
  'main-steam-safety-valve-to-containment.flowKgPerS',
  'condenser.heatRejectedMw',
  'condenser.backPressurePa',
  'condenser.condensateInventoryKg',
  'condenser.coolingWaterFlowKgPerS',
  'condenser.coolingWaterInletTemperatureC',
  'condenser.coolingWaterOutletTemperatureC',
  'condenser.coolingWaterHeatCapacityMw',
  'condenser.coolingWaterAvailabilityFraction',
  'safetyBusA.voltageFraction',
  'safetyBusB.voltageFraction',
  'plantControlsLoadA.servedFraction',
  'plantControlsLoadB.servedFraction',
] as const satisfies ReadonlyArray<string>

type CaseId =
  | 'baseline'
  | 'sgtr'
  | 'loss-feedwater'
  | 'loca-safety-injection'
  | 'aux-feedwater-recovery'
  | 'loss-offsite-power'
  | 'rcp-trip'
  | 'relief-open'
  | 'main-steam-safety-release'
  | 'load-reduction'
  | 'condenser-backpressure'
  | 'mixed-transient'

interface AcceptanceCase {
  readonly id: CaseId
  readonly title: string
  readonly description: string
  readonly parameters?: Record<string, Record<string, unknown>>
  readonly initialState?: Record<string, unknown>
  readonly actions: ReadonlyArray<ProcessPlantScheduledAction>
}

interface Point {
  readonly x: number
  readonly y: number
}

interface PlotSeries {
  readonly label: string
  readonly color: string
  readonly points: ReadonlyArray<Point>
}

interface AcceptanceCheck {
  readonly caseId: CaseId
  readonly description: string
  readonly passed: boolean
  readonly details: string
}

const cases: ReadonlyArray<AcceptanceCase> = [
  {
    id: 'baseline',
    title: 'Baseline',
    description: 'No scheduled fault. Published variables should remain bounded and near steady state.',
    actions: [],
  },
  {
    id: 'sgtr',
    title: 'SGTR',
    description: 'Steam generator tube leak creates primary-to-secondary leak flow and secondary radiation.',
    actions: [{
      id: 'sgtr-open-tube-leak',
      atMs: 60_000,
      type: 'setVariable',
      path: variablePath('sgA.tubeLeakFraction'),
      value: 0.35,
    }],
  },
  {
    id: 'loss-feedwater',
    title: 'Loss of Feedwater',
    description: 'Both main feedwater pumps trip and steam generator level should fall.',
    actions: [
      {
        id: 'trip-main-feedwater-a',
        atMs: 60_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpA' as never,
      },
      {
        id: 'trip-main-feedwater-b',
        atMs: 60_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpB' as never,
      },
    ],
  },
  {
    id: 'loca-safety-injection',
    title: 'LOCA / Safety Injection',
    description: 'A primary boundary leak releases mass to containment and depressurization starts accumulator injection.',
    actions: [{
      id: 'open-primary-boundary-leak',
      atMs: 60_000,
      type: 'setVariable',
      path: variablePath('rcs-hot-leg-a.leak.areaFraction'),
      value: 0.65,
    }],
  },
  {
    id: 'aux-feedwater-recovery',
    title: 'Aux Feed Recovery',
    description: 'Main feedwater trips, one auxiliary branch is opened, and header balance should remain coherent.',
    actions: [
      {
        id: 'trip-main-feedwater-a',
        atMs: 45_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpA' as never,
      },
      {
        id: 'trip-main-feedwater-b',
        atMs: 45_000,
        type: 'tripComponent',
        componentId: 'mainFeedwaterPumpB' as never,
      },
      {
        id: 'start-motor-aux-feed',
        atMs: 75_000,
        type: 'setVariable',
        path: variablePath('auxFeedwaterPumpMotor.running'),
        value: true,
      },
      {
        id: 'start-turbine-aux-feed',
        atMs: 75_000,
        type: 'setVariable',
        path: variablePath('auxFeedwaterPumpTurbine.running'),
        value: true,
      },
      {
        id: 'open-aux-feed-a',
        atMs: 75_000,
        type: 'setVariable',
        path: variablePath('auxFeedwaterValveA.positionFraction'),
        value: 1,
      },
    ],
  },
  {
    id: 'loss-offsite-power',
    title: 'Loss of Offsite Power',
    description: 'Offsite breakers open, emergency diesels recover safety buses, and essential loads are served.',
    actions: [
      {
        id: 'loop',
        atMs: 60_000,
        type: 'lossOfOffsitePower',
      },
      {
        id: 'start-diesel-a',
        atMs: 75_000,
        type: 'setVariable',
        path: variablePath('dieselGeneratorA.startCommand'),
        value: true,
      },
      {
        id: 'start-diesel-b',
        atMs: 75_000,
        type: 'setVariable',
        path: variablePath('dieselGeneratorB.startCommand'),
        value: true,
      },
      // These traces run without the I&C, so no sequencer ties the diesels to
      // their dead buses: close each output breaker once its diesel is up to speed.
      {
        id: 'close-diesel-breaker-a',
        atMs: 90_000,
        type: 'setVariable',
        path: variablePath('dieselBreakerA.closed'),
        value: true,
      },
      {
        id: 'close-diesel-breaker-b',
        atMs: 90_000,
        type: 'setVariable',
        path: variablePath('dieselBreakerB.closed'),
        value: true,
      },
    ],
  },
  {
    id: 'rcp-trip',
    title: 'RCP A Trip',
    description: 'One reactor coolant pump coasts down and loop flow should decline without instantly collapsing.',
    actions: [{
      id: 'trip-rcp-a',
      atMs: 60_000,
      type: 'tripComponent',
      componentId: 'rcpA' as never,
    }],
  },
  {
    id: 'relief-open',
    title: 'Pressurizer Relief',
    description: 'Opening pressurizer relief creates relief flow and lowers steam mass/pressure tendency.',
    actions: [{
      id: 'open-pressurizer-relief',
      atMs: 60_000,
      type: 'setVariable',
      path: variablePath('pressurizer.reliefValvePositionFraction'),
      value: 1,
    }],
  },
  {
    id: 'main-steam-safety-release',
    title: 'Main Steam Safety Release',
    description: 'An isolated high-pressure main steam path routes steam through a safety valve to containment.',
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
    id: 'load-reduction',
    title: 'Load Reduction',
    description: 'Turbine load demand reduces electric output and steam demand.',
    actions: [{
      id: 'reduce-turbine-load',
      atMs: 60_000,
      type: 'setVariable',
      path: variablePath('turbine.loadFraction'),
      value: 0.3,
    }],
  },
  {
    id: 'condenser-backpressure',
    title: 'Condenser Backpressure',
    description: 'Hot cooling water raises condenser backpressure and derates turbine demand/output.',
    parameters: {
      ultimateHeatSink: { initialTemperatureC: 95 },
      condenser: { coolingWaterTemperatureC: 95 },
    },
    actions: [],
  },
  {
    id: 'mixed-transient',
    title: 'Mixed Transient',
    description: 'A combined SGTR, RCP trip, and load reduction checks multi-unit scenario behavior.',
    actions: [
      {
        id: 'mixed-open-tube-leak',
        atMs: 45_000,
        type: 'setVariable',
        path: variablePath('sgA.tubeLeakFraction'),
        value: 0.25,
      },
      {
        id: 'mixed-trip-rcp-a',
        atMs: 75_000,
        type: 'tripComponent',
        componentId: 'rcpA' as never,
      },
      {
        id: 'mixed-reduce-turbine-load',
        atMs: 120_000,
        type: 'setVariable',
        path: variablePath('turbine.loadFraction'),
        value: 0.5,
      },
    ],
  },
]

const compiledSystem = (
  id: string,
  parameters?: Record<string, Record<string, unknown>>,
  initialState?: Record<string, unknown>,
) => compileProcessPlant(createPwrReferencePlantDefinition({
  id,
  title: `Acceptance ${id}`,
  ...(parameters === undefined ? {} : { parameterOverrides: parameters }),
  ...(initialState === undefined ? {} : { valueOverrides: initialState }),
}))

const configs = (): ReadonlyArray<ProcessPlantMultiPlantConfig> =>
  cases.map(testCase => ({
    plant: compiledSystem(testCase.id, testCase.parameters, testCase.initialState),
    schedule: { actions: testCase.actions },
    telemetry: {
      sampleIntervalMs,
      variables: telemetryVariables.map(variablePath),
    },
  }))

const seriesFor = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): ProcessPlantTelemetrySeries => {
  const series = telemetry.find(candidate => candidate.path === path)
  if (!series) throw new Error(`missing process plant acceptance telemetry series: ${path}`)
  return series
}

const valueAtOrAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => {
  const point = seriesFor(telemetry, path).points.find(candidate => candidate.elapsedMs >= elapsedMs)
  if (!point) throw new Error(`missing process plant acceptance point for ${path} at ${elapsedMs}ms`)
  if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
  return point.value
}

const maxAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => {
  const values = seriesFor(telemetry, path).points
    .filter(point => point.elapsedMs >= elapsedMs)
    .map(point => {
      if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
      return point.value
    })
  if (values.length === 0) throw new Error(`no process plant acceptance samples after ${elapsedMs}ms for ${path}`)
  return Math.max(...values)
}

const minAfter = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  elapsedMs: number,
): number => {
  const values = seriesFor(telemetry, path).points
    .filter(point => point.elapsedMs >= elapsedMs)
    .map(point => {
      if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
      return point.value
    })
  if (values.length === 0) throw new Error(`no process plant acceptance samples after ${elapsedMs}ms for ${path}`)
  return Math.min(...values)
}

const numericPoints = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
  scale: number,
): ReadonlyArray<Point> =>
  seriesFor(telemetry, path).points.map(point => {
    if (typeof point.value !== 'number') throw new Error(`process plant acceptance variable is not numeric: ${path}`)
    return { x: point.elapsedMs / 1_000, y: point.value * scale }
  })

const maxAbsoluteSeriesDelta = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  leftPath: string,
  rightPath: string,
): number => {
  const left = seriesFor(telemetry, leftPath).points
  const right = seriesFor(telemetry, rightPath).points
  if (left.length !== right.length) throw new Error(`acceptance series length mismatch: ${leftPath} vs ${rightPath}`)
  let maxDelta = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftPoint = left[index]
    const rightPoint = right[index]
    if (!leftPoint || !rightPoint) throw new Error(`acceptance series point mismatch: ${leftPath} vs ${rightPath}`)
    if (leftPoint.elapsedMs !== rightPoint.elapsedMs) throw new Error(`acceptance series timestamp mismatch: ${leftPath} vs ${rightPath}`)
    if (typeof leftPoint.value !== 'number' || typeof rightPoint.value !== 'number') throw new Error(`acceptance series is not numeric: ${leftPath} vs ${rightPath}`)
    maxDelta = Math.max(maxDelta, Math.abs(leftPoint.value - rightPoint.value))
  }
  return maxDelta
}

const maxAbsoluteValue = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  path: string,
): number => {
  let maxValue = 0
  for (const point of seriesFor(telemetry, path).points) {
    if (typeof point.value !== 'number') throw new Error(`acceptance series is not numeric: ${path}`)
    maxValue = Math.max(maxValue, Math.abs(point.value))
  }
  return maxValue
}

const maxAbsoluteComputedDelta = (
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  observedPath: string,
  addendPaths: ReadonlyArray<string>,
): number => {
  const observed = seriesFor(telemetry, observedPath).points
  const addendSeries = addendPaths.map(path => seriesFor(telemetry, path).points)
  let maxDelta = 0
  for (let index = 0; index < observed.length; index += 1) {
    const observedPoint = observed[index]
    if (!observedPoint || typeof observedPoint.value !== 'number') throw new Error(`acceptance observed series is not numeric: ${observedPath}`)
    let expected = 0
    for (let seriesIndex = 0; seriesIndex < addendSeries.length; seriesIndex += 1) {
      const addendPoint = addendSeries[seriesIndex]?.[index]
      const addendPath = addendPaths[seriesIndex]
      if (!addendPoint || addendPoint.elapsedMs !== observedPoint.elapsedMs) throw new Error(`acceptance computed series timestamp mismatch: ${observedPath} vs ${String(addendPath)}`)
      if (typeof addendPoint.value !== 'number') throw new Error(`acceptance computed series is not numeric: ${String(addendPath)}`)
      expected += addendPoint.value
    }
    maxDelta = Math.max(maxDelta, Math.abs(observedPoint.value - expected))
  }
  return maxDelta
}

const check = (
  caseId: CaseId,
  description: string,
  passed: boolean,
  details: string,
): AcceptanceCheck => ({ caseId, description, passed, details })

const nonnegativeTelemetryPaths: ReadonlySet<string> = new Set([
  'core.powerMw',
  'core.fissionPowerMw',
  'core.totalThermalPowerMw',
  'core.fuelStoredEnergyMj',
  'vessel.primaryCoolantInventoryKg',
  'vessel.safetyInjectionFlowKgPerS',
  'vessel.primaryLeakFlowKgPerS',
  'vessel-release-to-containment.flowKgPerS',
  'containment.pressureMPa',
  'containment.temperatureC',
  'containment.sumpInventoryKg',
  'containment.incomingMassKgPerS',
  'containment.radiationSourceTermMSvPerH',
  'safetyAccumulatorA.liquidInventoryKg',
  'safetyAccumulatorA.outletFlowKgPerS',
  'safetyAccumulatorA.gasPressureMPa',
  'pressurizer.pressureMPa',
  'pressurizer.steamPressureMPa',
  'pressurizer.pressureTargetMPa',
  'pressurizer.steamMassKg',
  'pressurizer.steamVolumeM3',
  'pressurizer.reliefFlowKgPerS',
  'sgA.levelPercent',
  'sgA.pressureMPa',
  'sgA.pressureTargetMPa',
  'sgA.steamMassKg',
  'sgA.feedwaterFlowKgPerS',
  'sgA.primaryToSecondaryLeakKgPerS',
  'sgA.secondaryRadiationMSvPerH',
  'rcpA.loopFlowKgPerS',
  'turbine.electricMw',
  'turbine.steamDemandKgPerS',
  'turbine.steamAvailabilityFraction',
  'turbine.exhaustTemperatureC',
  'main-feedwater-pump-a-to-header.flowKgPerS',
  'main-feedwater-pump-b-to-header.flowKgPerS',
  'motor-afw-pump-to-header.flowKgPerS',
  'aux-feedwater-valve-a-to-sg-a.flowKgPerS',
  'mainSteamSafetyValve.effectivePositionFraction',
  'main-steam-header-to-safety-valve.flowKgPerS',
  'main-steam-safety-valve-to-containment.flowKgPerS',
  'condenser.heatRejectedMw',
  'condenser.backPressurePa',
  'condenser.condensateInventoryKg',
  'condenser.coolingWaterFlowKgPerS',
  'condenser.coolingWaterInletTemperatureC',
  'condenser.coolingWaterOutletTemperatureC',
  'condenser.coolingWaterHeatCapacityMw',
  'condenser.coolingWaterAvailabilityFraction',
  'safetyBusA.voltageFraction',
  'safetyBusB.voltageFraction',
  'plantControlsLoadA.servedFraction',
  'plantControlsLoadB.servedFraction',
])

const evaluateTelemetryIntegrity = (
  caseId: CaseId,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
): ReadonlyArray<AcceptanceCheck> => {
  const numericValues = telemetry.flatMap(series => series.points.map(point => ({
    path: series.path,
    value: point.value,
  })))
  const invalidFinite = numericValues.find(point => typeof point.value !== 'number' || !Number.isFinite(point.value))
  const invalidNegative = numericValues.find(point =>
    typeof point.value === 'number'
    && nonnegativeTelemetryPaths.has(point.path)
    && point.value < -1e-9,
  )
  const maxFissionMismatch = maxAbsoluteSeriesDelta(telemetry, 'core.powerMw', 'core.fissionPowerMw')
  const maxThermalPowerMismatch = maxAbsoluteComputedDelta(
    telemetry,
    'core.totalThermalPowerMw',
    ['core.fissionPowerMw', 'core.decayHeatMw'],
  )
  const maxPressureBiasMismatch = maxAbsoluteComputedDelta(
    telemetry,
    'vessel.primaryPressureBiasMPa',
    ['vessel.compressibilityPressureBiasMPa', 'vessel.thermalExpansionPressureBiasMPa'],
  )
  const maxSgInventoryResidual = maxAbsoluteValue(telemetry, 'sgA.secondaryInventoryBalanceResidualKg')
  const maxSgSteamResidual = maxAbsoluteValue(telemetry, 'sgA.steamMassBalanceResidualKg')
  const maxSgSteamMass = maxAbsoluteValue(telemetry, 'sgA.steamMassKg')
  const maxSgBoilingEnergyResidual = maxAbsoluteValue(telemetry, 'sgA.boilingEnergyResidualMw')
  const maxPressurizerWaterResidual = maxAbsoluteValue(telemetry, 'pressurizer.waterInventoryBalanceResidualKg')
  const maxPressurizerSteamResidual = maxAbsoluteValue(telemetry, 'pressurizer.steamMassBalanceResidualKg')
  const maxPressurizerSteamMass = maxAbsoluteValue(telemetry, 'pressurizer.steamMassKg')
  const maxFeedwaterHeaderResidual = maxAbsoluteValue(telemetry, 'feedwaterHeader.flowBalanceResidualKgPerS')
  const maxAuxFeedwaterHeaderResidual = maxAbsoluteValue(telemetry, 'auxFeedwaterHeader.flowBalanceResidualKgPerS')
  return [
    check(
      caseId,
      'all acceptance telemetry samples are finite numbers',
      invalidFinite === undefined,
      invalidFinite === undefined ? 'all finite' : `${invalidFinite.path}=${String(invalidFinite.value)}`,
    ),
    check(
      caseId,
      'nonnegative physical telemetry remains nonnegative',
      invalidNegative === undefined,
      invalidNegative === undefined ? 'all nonnegative' : `${invalidNegative.path}=${String(invalidNegative.value)}`,
    ),
    check(
      caseId,
      'reactor fission power alias remains exact',
      maxFissionMismatch < 1e-6,
      `maxMismatch=${maxFissionMismatch.toExponential(2)}MW`,
    ),
    check(
      caseId,
      'reactor thermal power equals fission plus decay heat',
      maxThermalPowerMismatch < 1e-6,
      `maxMismatch=${maxThermalPowerMismatch.toExponential(2)}MW`,
    ),
    check(
      caseId,
      'reactor vessel pressure bias equals compressibility plus thermal expansion',
      maxPressureBiasMismatch < 1e-6,
      `maxMismatch=${maxPressureBiasMismatch.toExponential(2)}MPa`,
    ),
    check(
      caseId,
      'steam generator liquid and steam balances remain conservative',
      maxSgInventoryResidual < 75 && maxSgSteamResidual < Math.max(25, maxSgSteamMass * 0.0025) && maxSgBoilingEnergyResidual < 1e-6,
      `inventory=${maxSgInventoryResidual.toExponential(2)}kg steam=${maxSgSteamResidual.toExponential(2)}kg steamMass=${maxSgSteamMass.toExponential(2)}kg energy=${maxSgBoilingEnergyResidual.toExponential(2)}MW`,
    ),
    check(
      caseId,
      'pressurizer water and steam balances remain conservative',
      maxPressurizerWaterResidual < 5 && maxPressurizerSteamResidual < Math.max(10, maxPressurizerSteamMass * 0.005),
      `water=${maxPressurizerWaterResidual.toExponential(2)}kg steam=${maxPressurizerSteamResidual.toExponential(2)}kg steamMass=${maxPressurizerSteamMass.toExponential(2)}kg`,
    ),
    check(
      caseId,
      'feedwater and aux feedwater headers conserve reachable flow',
      maxFeedwaterHeaderResidual < 1e-6 && maxAuxFeedwaterHeaderResidual < 1e-6,
      `feed=${maxFeedwaterHeaderResidual.toExponential(2)}kg/s aux=${maxAuxFeedwaterHeaderResidual.toExponential(2)}kg/s`,
    ),
  ]
}

const evaluateCase = (
  caseId: CaseId,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
): ReadonlyArray<AcceptanceCheck> => {
  if (caseId === 'baseline') {
    const startPower = valueAtOrAfter(telemetry, 'core.powerMw', 10_000)
    const endPower = valueAtOrAfter(telemetry, 'core.powerMw', durationMs)
    const endPressure = valueAtOrAfter(telemetry, 'pressurizer.pressureMPa', durationMs)
    return [
      check(caseId, 'baseline power stays bounded', endPower > 2_000 && endPower < 4_500, `endPower=${endPower.toFixed(1)}MW`),
      check(caseId, 'baseline pressure stays plausible', endPressure > 13 && endPressure < 18, `endPressure=${endPressure.toFixed(2)}MPa`),
      check(caseId, 'baseline does not drift violently', Math.abs(endPower - startPower) < 500, `start=${startPower.toFixed(1)} end=${endPower.toFixed(1)}MW`),
    ]
  }
  if (caseId === 'sgtr') {
    const leak = maxAfter(telemetry, 'sgA.primaryToSecondaryLeakKgPerS', 70_000)
    const radiation = maxAfter(telemetry, 'sgA.secondaryRadiationMSvPerH', 70_000)
    return [
      check(caseId, 'SGTR creates primary-to-secondary leak flow', leak > 0.1, `maxLeak=${leak.toFixed(2)}kg/s`),
      check(caseId, 'SGTR raises secondary radiation indication', radiation > 0.01, `maxRadiation=${radiation.toFixed(3)}mSv/h`),
    ]
  }
  if (caseId === 'loss-feedwater') {
    const beforeLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', 55_000)
    const afterLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', durationMs)
    const feed = maxAfter(telemetry, 'sgA.feedwaterFlowKgPerS', 120_000)
    return [
      check(caseId, 'loss of feedwater lowers SG level', afterLevel < beforeLevel - 3, `before=${beforeLevel.toFixed(1)} after=${afterLevel.toFixed(1)}%`),
      check(caseId, 'loss of feedwater removes main feed contribution', feed < 150, `maxFeedAfter120s=${feed.toFixed(1)}kg/s`),
    ]
  }
  if (caseId === 'loca-safety-injection') {
    const initialInventory = valueAtOrAfter(telemetry, 'vessel.primaryCoolantInventoryKg', 55_000)
    const endInventory = valueAtOrAfter(telemetry, 'vessel.primaryCoolantInventoryKg', durationMs)
    const release = maxAfter(telemetry, 'vessel-release-to-containment.flowKgPerS', 70_000)
    const containmentSump = valueAtOrAfter(telemetry, 'containment.sumpInventoryKg', durationMs)
    const initialContainmentPressure = valueAtOrAfter(telemetry, 'containment.pressureMPa', 55_000)
    const peakContainmentPressure = maxAfter(telemetry, 'containment.pressureMPa', 70_000)
    const injection = maxAfter(telemetry, 'safetyAccumulatorA.outletFlowKgPerS', 70_000)
    const accumulatorStart = valueAtOrAfter(telemetry, 'safetyAccumulatorA.liquidInventoryKg', 55_000)
    const accumulatorEnd = valueAtOrAfter(telemetry, 'safetyAccumulatorA.liquidInventoryKg', durationMs)
    const radiation = maxAfter(telemetry, 'containment.radiationSourceTermMSvPerH', 70_000)
    return [
      check(caseId, 'primary boundary leak releases mass to containment', release > 10, `maxRelease=${release.toFixed(1)}kg/s`),
      check(caseId, 'LOCA lowers primary inventory despite injection', endInventory < initialInventory - 20_000, `start=${initialInventory.toFixed(0)} end=${endInventory.toFixed(0)}kg`),
      check(caseId, 'containment receives released primary mass', maxAfter(telemetry, 'containment.incomingMassKgPerS', 70_000) > 10, `incomingMass=${maxAfter(telemetry, 'containment.incomingMassKgPerS', 70_000).toFixed(1)}kg/s sump=${containmentSump.toFixed(0)}kg`),
      check(caseId, 'containment pressure rises after release', peakContainmentPressure > initialContainmentPressure, `initial=${initialContainmentPressure.toFixed(3)} peak=${peakContainmentPressure.toFixed(3)}MPa`),
      check(caseId, 'accumulator injects after depressurization', injection > 1, `maxInjection=${injection.toFixed(1)}kg/s`),
      check(caseId, 'accumulator inventory depletes during injection', accumulatorEnd < accumulatorStart, `start=${accumulatorStart.toFixed(0)} end=${accumulatorEnd.toFixed(0)}kg`),
      check(caseId, 'containment radiation source term rises after primary release', radiation > 0.02, `maxRadiation=${radiation.toFixed(3)}mSv/h`),
    ]
  }
  if (caseId === 'aux-feedwater-recovery') {
    const mainFeedAfter = maxAfter(telemetry, 'main-feedwater-pump-a-to-header.flowKgPerS', 90_000)
      + maxAfter(telemetry, 'main-feedwater-pump-b-to-header.flowKgPerS', 90_000)
    const auxFeedAfter = maxAfter(telemetry, 'aux-feedwater-valve-a-to-sg-a.flowKgPerS', 120_000)
    const afterLevel = valueAtOrAfter(telemetry, 'sgA.levelPercent', durationMs)
    return [
      check(caseId, 'main feedwater remains isolated after trip', mainFeedAfter < 50, `maxMainFeedAfter90s=${mainFeedAfter.toFixed(1)}kg/s`),
      check(caseId, 'auxiliary feedwater reaches the open SG branch', auxFeedAfter > 20, `maxAuxFeedA=${auxFeedAfter.toFixed(1)}kg/s`),
      check(caseId, 'auxiliary feedwater keeps SG level bounded above dryout', afterLevel > 12, `endLevel=${afterLevel.toFixed(1)}%`),
    ]
  }
  if (caseId === 'loss-offsite-power') {
    const minSafetyBusA = minAfter(telemetry, 'safetyBusA.voltageFraction', 120_000)
    const minSafetyBusB = minAfter(telemetry, 'safetyBusB.voltageFraction', 120_000)
    const minLoadA = minAfter(telemetry, 'plantControlsLoadA.servedFraction', 120_000)
    const minLoadB = minAfter(telemetry, 'plantControlsLoadB.servedFraction', 120_000)
    return [
      check(caseId, 'LOOP recovers safety bus A voltage after diesel start', minSafetyBusA > 0.9, `minBusAAfter120s=${minSafetyBusA.toFixed(2)}`),
      check(caseId, 'LOOP recovers safety bus B voltage after diesel start', minSafetyBusB > 0.9, `minBusBAfter120s=${minSafetyBusB.toFixed(2)}`),
      check(caseId, 'LOOP keeps essential controls loads served after recovery', minLoadA > 0.99 && minLoadB > 0.99, `loadA=${minLoadA.toFixed(2)} loadB=${minLoadB.toFixed(2)}`),
    ]
  }
  if (caseId === 'rcp-trip') {
    const beforeFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 55_000)
    const shortAfterFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 65_000)
    const afterFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', durationMs)
    return [
      check(caseId, 'RCP trip begins a coastdown, not an instant zero', shortAfterFlow > beforeFlow * 0.35, `before=${beforeFlow.toFixed(0)} shortAfter=${shortAfterFlow.toFixed(0)}kg/s`),
      check(caseId, 'RCP trip materially lowers loop flow', afterFlow < beforeFlow * 0.75, `before=${beforeFlow.toFixed(0)} end=${afterFlow.toFixed(0)}kg/s`),
    ]
  }
  if (caseId === 'relief-open') {
    const relief = maxAfter(telemetry, 'pressurizer.reliefFlowKgPerS', 70_000)
    const beforeSteam = valueAtOrAfter(telemetry, 'pressurizer.steamMassKg', 55_000)
    const afterSteam = valueAtOrAfter(telemetry, 'pressurizer.steamMassKg', durationMs)
    return [
      check(caseId, 'relief valve produces relief flow', relief > 0.1, `maxRelief=${relief.toFixed(2)}kg/s`),
      check(caseId, 'relief valve reduces pressurizer steam mass tendency', afterSteam < beforeSteam, `before=${beforeSteam.toFixed(1)} end=${afterSteam.toFixed(1)}kg`),
    ]
  }
  if (caseId === 'main-steam-safety-release') {
    const safetyPosition = maxAfter(telemetry, 'mainSteamSafetyValve.effectivePositionFraction', 0)
    const headerFlow = maxAfter(telemetry, 'main-steam-header-to-safety-valve.flowKgPerS', 0)
    const containmentFlow = maxAfter(telemetry, 'main-steam-safety-valve-to-containment.flowKgPerS', 0)
    const initialContainmentPressure = valueAtOrAfter(telemetry, 'containment.pressureMPa', 0)
    const peakContainmentPressure = maxAfter(telemetry, 'containment.pressureMPa', 0)
    const initialContainmentSump = valueAtOrAfter(telemetry, 'containment.sumpInventoryKg', 0)
    const endContainmentSump = valueAtOrAfter(telemetry, 'containment.sumpInventoryKg', durationMs)
    return [
      check(caseId, 'main steam safety valve opens on isolated turbine path pressure', safetyPosition > 0.9, `maxPosition=${safetyPosition.toFixed(2)}`),
      check(caseId, 'main steam safety path carries header flow', headerFlow > 100, `maxHeaderFlow=${headerFlow.toFixed(1)}kg/s`),
      check(caseId, 'main steam safety valve routes steam to containment', containmentFlow > 100, `maxContainmentFlow=${containmentFlow.toFixed(1)}kg/s`),
      check(caseId, 'containment pressure rises from steam release', peakContainmentPressure > initialContainmentPressure, `initial=${initialContainmentPressure.toFixed(3)} peak=${peakContainmentPressure.toFixed(3)}MPa`),
      check(caseId, 'containment inventory increases from steam release', endContainmentSump > initialContainmentSump, `initial=${initialContainmentSump.toFixed(0)} end=${endContainmentSump.toFixed(0)}kg`),
    ]
  }
  if (caseId === 'load-reduction') {
    const beforeElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', 55_000)
    const afterElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
    const minElectric = minAfter(telemetry, 'turbine.electricMw', 120_000)
    const beforeDemand = valueAtOrAfter(telemetry, 'turbine.steamDemandKgPerS', 55_000)
    const afterDemand = valueAtOrAfter(telemetry, 'turbine.steamDemandKgPerS', durationMs)
    const beforeHeatRejected = valueAtOrAfter(telemetry, 'condenser.heatRejectedMw', 55_000)
    const afterHeatRejected = valueAtOrAfter(telemetry, 'condenser.heatRejectedMw', durationMs)
    const minAvailability = minAfter(telemetry, 'turbine.steamAvailabilityFraction', 120_000)
    const maxAvailability = maxAfter(telemetry, 'turbine.steamAvailabilityFraction', 120_000)
    return [
      check(caseId, 'load reduction lowers turbine output', afterElectric < beforeElectric * 0.7, `before=${beforeElectric.toFixed(1)} end=${afterElectric.toFixed(1)}MW`),
      check(caseId, 'load reduction keeps output nonnegative', minElectric >= 0, `min=${minElectric.toFixed(1)}MW`),
      check(caseId, 'load reduction lowers turbine steam demand', afterDemand < beforeDemand * 0.6, `before=${beforeDemand.toFixed(1)} end=${afterDemand.toFixed(1)}kg/s`),
      check(caseId, 'load reduction lowers condenser heat rejection', afterHeatRejected < beforeHeatRejected * 0.75, `before=${beforeHeatRejected.toFixed(1)} end=${afterHeatRejected.toFixed(1)}MW`),
      check(caseId, 'turbine steam availability remains a bounded ratio', minAvailability >= 0 && maxAvailability <= 1, `min=${minAvailability.toFixed(2)} max=${maxAvailability.toFixed(2)}`),
    ]
  }
  if (caseId === 'condenser-backpressure') {
    const backPressure = valueAtOrAfter(telemetry, 'condenser.backPressurePa', durationMs)
    const electric = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
    const steamDemand = valueAtOrAfter(telemetry, 'turbine.steamDemandKgPerS', durationMs)
    const coolingWaterTemperature = valueAtOrAfter(telemetry, 'condenser.coolingWaterInletTemperatureC', durationMs)
    return [
      check(caseId, 'hot condenser raises backpressure', backPressure > 20_000, `backPressure=${backPressure.toFixed(0)}Pa`),
      check(caseId, 'condenser backpressure derates turbine output', electric < 900, `electric=${electric.toFixed(1)}MW`),
      check(caseId, 'condenser backpressure derates turbine steam demand', steamDemand < 1_350, `steamDemand=${steamDemand.toFixed(1)}kg/s`),
      check(caseId, 'condenser reads hot cooling water from the heat-sink path', coolingWaterTemperature > 60, `coolingWaterInlet=${coolingWaterTemperature.toFixed(1)}C`),
    ]
  }
  const leak = maxAfter(telemetry, 'sgA.primaryToSecondaryLeakKgPerS', 55_000)
  const beforeFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', 70_000)
  const afterFlow = valueAtOrAfter(telemetry, 'rcpA.loopFlowKgPerS', durationMs)
  const beforeElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', 110_000)
  const afterElectric = valueAtOrAfter(telemetry, 'turbine.electricMw', durationMs)
  return [
    check(caseId, 'mixed transient creates tube leak flow', leak > 0.1, `maxLeak=${leak.toFixed(2)}kg/s`),
    check(caseId, 'mixed transient lowers the tripped loop flow', afterFlow < beforeFlow * 0.8, `before=${beforeFlow.toFixed(0)} end=${afterFlow.toFixed(0)}kg/s`),
    check(caseId, 'mixed transient lowers turbine output after load reduction', afterElectric < beforeElectric * 0.75, `before=${beforeElectric.toFixed(1)} end=${afterElectric.toFixed(1)}MW`),
  ]
}

const positiveOrZero = (value: number | null): number =>
  value ?? 0

const evaluateKernelDiagnostics = (
  caseId: CaseId,
  diagnostics: PwrTransientDiagnostics,
): ReadonlyArray<AcceptanceCheck> => {
  const common = [
    check(caseId, 'PWR transient diagnostics kernel is active', diagnostics.active, `active=${String(diagnostics.active)}`),
    check(caseId, 'kernel sees the four-loop PWR component family', diagnostics.componentCounts.steamGenerators === 4 && diagnostics.componentCounts.safetyBuses === 2, `sg=${diagnostics.componentCounts.steamGenerators} safetyBus=${diagnostics.componentCounts.safetyBuses}`),
    check(caseId, 'kernel reports finite balance residuals', Number.isFinite(diagnostics.conservation.maxSteamGeneratorLiquidResidualKg) && Number.isFinite(diagnostics.conservation.maxSteamGeneratorSteamResidualKg), `sgLiquid=${diagnostics.conservation.maxSteamGeneratorLiquidResidualKg.toExponential(2)} sgSteam=${diagnostics.conservation.maxSteamGeneratorSteamResidualKg.toExponential(2)}`),
  ]
  if (caseId === 'baseline') {
    return [
      ...common,
      check(caseId, 'baseline kernel reports all reactor coolant pumps running', diagnostics.primary.runningReactorCoolantPumpCount === 4, `runningRcp=${diagnostics.primary.runningReactorCoolantPumpCount}`),
      check(caseId, 'baseline kernel reports served electrical loads after solve', diagnostics.electrical.unservedLoadCount === 0, `unserved=${diagnostics.electrical.unservedLoadCount}`),
    ]
  }
  if (caseId === 'sgtr') {
    return [
      ...common,
      check(caseId, 'kernel reports durable SGTR inventory consequence', positiveOrZero(diagnostics.primary.inventoryFraction) < 0.95 || positiveOrZero(diagnostics.primary.tubeLeakFlowKgPerS) > 0.1, `inventoryFraction=${positiveOrZero(diagnostics.primary.inventoryFraction).toFixed(3)} tubeLeak=${positiveOrZero(diagnostics.primary.tubeLeakFlowKgPerS).toFixed(2)}kg/s`),
    ]
  }
  if (caseId === 'loss-feedwater') {
    return [
      ...common,
      check(caseId, 'kernel reports reduced total feedwater flow', diagnostics.secondary.feedwaterFlowKgPerS < 500, `feedwater=${diagnostics.secondary.feedwaterFlowKgPerS.toFixed(1)}kg/s`),
      check(caseId, 'kernel reports declining SG level family', positiveOrZero(diagnostics.secondary.minLevelPercent) < 55, `minLevel=${positiveOrZero(diagnostics.secondary.minLevelPercent).toFixed(1)}%`),
    ]
  }
  if (caseId === 'loca-safety-injection') {
    return [
      ...common,
      check(caseId, 'kernel reports primary leak response', positiveOrZero(diagnostics.primary.leakFlowKgPerS) > 10 && positiveOrZero(diagnostics.primary.inventoryFraction) < 1, `leak=${positiveOrZero(diagnostics.primary.leakFlowKgPerS).toFixed(1)} inventoryFraction=${positiveOrZero(diagnostics.primary.inventoryFraction).toFixed(3)}`),
      check(caseId, 'kernel reports containment inlet/radiation response', positiveOrZero(diagnostics.containment.incomingMassKgPerS) > 10 && positiveOrZero(diagnostics.containment.radiationSourceTermMSvPerH) > 0.02, `incomingMass=${positiveOrZero(diagnostics.containment.incomingMassKgPerS).toFixed(1)}kg/s radiation=${positiveOrZero(diagnostics.containment.radiationSourceTermMSvPerH).toFixed(3)}`),
    ]
  }
  if (caseId === 'aux-feedwater-recovery') {
    return [
      ...common,
      check(caseId, 'kernel reports auxiliary feedwater flow and reserve', diagnostics.secondary.auxFeedwaterFlowKgPerS > 20 && positiveOrZero(diagnostics.secondary.auxFeedwaterTankInventoryKg) > 0, `auxFlow=${diagnostics.secondary.auxFeedwaterFlowKgPerS.toFixed(1)} auxTank=${positiveOrZero(diagnostics.secondary.auxFeedwaterTankInventoryKg).toFixed(0)}kg`),
    ]
  }
  if (caseId === 'loss-offsite-power') {
    return [
      ...common,
      check(caseId, 'kernel reports diesel-backed safety bus recovery', diagnostics.safetySystems.runningDieselCount === 2 && diagnostics.safetySystems.deenergizedSafetyBusCount === 0, `diesels=${diagnostics.safetySystems.runningDieselCount} deenergizedSafetyBuses=${diagnostics.safetySystems.deenergizedSafetyBusCount}`),
      check(caseId, 'kernel reports essential loads served after LOOP recovery', diagnostics.electrical.unservedLoadCount === 0 && positiveOrZero(diagnostics.electrical.minSafetyBusVoltageFraction) > 0, `unserved=${diagnostics.electrical.unservedLoadCount} minSafetyVoltage=${positiveOrZero(diagnostics.electrical.minSafetyBusVoltageFraction).toFixed(2)}`),
    ]
  }
  if (caseId === 'rcp-trip') {
    return [
      ...common,
      check(caseId, 'kernel reports one reactor coolant pump tripped', diagnostics.primary.runningReactorCoolantPumpCount === 3, `runningRcp=${diagnostics.primary.runningReactorCoolantPumpCount}`),
      check(caseId, 'kernel reports remaining primary loop circulation', diagnostics.primary.reactorCoolantFlowKgPerS > 0, `rcpFlow=${diagnostics.primary.reactorCoolantFlowKgPerS.toFixed(0)}kg/s`),
    ]
  }
  if (caseId === 'condenser-backpressure') {
    return [
      ...common,
      check(caseId, 'kernel reports condenser backpressure and turbine derate', positiveOrZero(diagnostics.balanceOfPlant.condenserBackPressurePa) > 20_000 && positiveOrZero(diagnostics.balanceOfPlant.turbineElectricMw) < 900, `backPressure=${positiveOrZero(diagnostics.balanceOfPlant.condenserBackPressurePa).toFixed(0)}Pa turbine=${positiveOrZero(diagnostics.balanceOfPlant.turbineElectricMw).toFixed(1)}MW`),
    ]
  }
  return common
}

const svgEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const scaledPath = (
  points: ReadonlyArray<Point>,
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  yMin: number,
  yMax: number,
): string => {
  const span = yMax - yMin
  if (span <= 0) throw new Error('acceptance plot y-axis span must be positive')
  return points.map((point, index) => {
    const x = bounds.x + (point.x / (durationMs / 1_000)) * bounds.width
    const y = bounds.y + bounds.height - ((point.y - yMin) / span) * bounds.height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

const renderPanel = (
  testCase: AcceptanceCase,
  telemetry: ReadonlyArray<ProcessPlantTelemetrySeries>,
  x: number,
  y: number,
): string => {
  const width = 350
  const height = 225
  const bounds = { x: x + 50, y: y + 60, width: width - 78, height: height - 106 }
  const series: ReadonlyArray<PlotSeries> = [
    {
      label: 'Core MW / 10',
      color: '#2563eb',
      points: numericPoints(telemetry, 'core.powerMw', 1 / 10),
    },
    {
      label: 'SG level %',
      color: '#0f766e',
      points: numericPoints(telemetry, 'sgA.levelPercent', 1),
    },
    {
      label: 'PZR MPa x 10',
      color: '#dc2626',
      points: numericPoints(telemetry, 'pressurizer.pressureMPa', 10),
    },
    {
      label: 'Turbine MW / 10',
      color: '#f59e0b',
      points: numericPoints(telemetry, 'turbine.electricMw', 1 / 10),
    },
  ]
  const lines = series.map(item => `
    <path d="${scaledPath(item.points, bounds, 0, 420)}" fill="none" stroke="${item.color}" stroke-width="2.1"/>`).join('')
  const legend = series.map((item, index) => {
    const lx = x + 56 + (index % 2) * 146
    const ly = y + height - 34 + Math.floor(index / 2) * 17
    return `
      <g transform="translate(${lx}, ${ly})">
        <line x1="0" y1="0" x2="18" y2="0" stroke="${item.color}" stroke-width="3"/>
        <text x="24" y="4" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#374151">${svgEscape(item.label)}</text>
      </g>`
  }).join('')
  return `
    <g>
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="#ffffff" stroke="#d1d5db"/>
      <text x="${x + 22}" y="${y + 28}" font-family="Inter, system-ui, sans-serif" font-size="17" font-weight="700" fill="#111827">${svgEscape(testCase.title)}</text>
      <text x="${x + 22}" y="${y + 47}" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#6b7280">${svgEscape(testCase.description)}</text>
      <line x1="${bounds.x}" y1="${bounds.y + bounds.height}" x2="${bounds.x + bounds.width}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
      <line x1="${bounds.x}" y1="${bounds.y}" x2="${bounds.x}" y2="${bounds.y + bounds.height}" stroke="#9ca3af"/>
      <text x="${bounds.x - 8}" y="${bounds.y + 4}" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#6b7280">420</text>
      <text x="${bounds.x - 8}" y="${bounds.y + bounds.height + 4}" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#6b7280">0</text>
      ${lines}
      ${legend}
    </g>`
}

const renderSvg = (
  traces: ReadonlyArray<ProcessPlantMultiPlantSnapshot>,
  checks: ReadonlyArray<AcceptanceCheck>,
): string => {
  const columns = 3
  const panelRows = Math.ceil(cases.length / columns)
  const svgHeight = 92 + panelRows * 268 + 72
  const panels = cases.map((testCase, index) => {
    const trace = traces.find(candidate => candidate.plantId === testCase.id)
    if (!trace?.telemetry) throw new Error(`acceptance trace missing telemetry for ${testCase.id}`)
    return renderPanel(testCase, trace.telemetry, 50 + (index % columns) * 380, 92 + Math.floor(index / columns) * 268)
  }).join('')
  const failed = checks.filter(candidate => !candidate.passed)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${svgHeight}" viewBox="0 0 1200 ${svgHeight}">
  <rect width="1200" height="${svgHeight}" fill="#f8fafc"/>
  <text x="50" y="42" font-family="Inter, system-ui, sans-serif" font-size="26" font-weight="800" fill="#111827">Process Plant Acceptance Traces</text>
  <text x="50" y="66" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#64748b">${cases.length} representative transients from the modular PWR assembly/runtime. Checks: ${checks.length - failed.length}/${checks.length} passed.</text>
  ${panels}
</svg>`
}

const csvRowsFor = (
  traces: ReadonlyArray<ProcessPlantMultiPlantSnapshot>,
): ReadonlyArray<string> => {
  const rows = ['case,path,elapsedMs,value,canonicalValue,unit']
  for (const trace of traces) {
    if (!trace.telemetry) throw new Error(`acceptance trace missing telemetry for ${trace.plantId}`)
    for (const series of trace.telemetry) {
      for (const point of series.points) {
        rows.push(`${trace.plantId},${series.path},${point.elapsedMs},${point.value},${point.canonicalValue},${point.unit}`)
      }
    }
  }
  return rows
}

const main = async (): Promise<void> => {
  const runConfigs = configs()
  const started = performance.now()
  const traces = createProcessPlantMultiPlantTestbed(runConfigs).runFor(durationMs, stepMs)
  const wallMs = performance.now() - started
  const checks = traces.flatMap(trace => {
    if (!trace.telemetry) throw new Error(`acceptance trace missing telemetry for ${trace.plantId}`)
    return [
      ...evaluateCase(trace.plantId as CaseId, trace.telemetry),
      ...evaluateKernelDiagnostics(trace.plantId as CaseId, trace.pwrTransientDiagnostics),
      ...evaluateTelemetryIntegrity(trace.plantId as CaseId, trace.telemetry),
    ]
  })
  const failed = checks.filter(candidate => !candidate.passed)
  const realtimeFactor = durationMs / wallMs
  const firstGraph = runConfigs[0]?.plant.graph
  if (!firstGraph) throw new Error('process plant acceptance requires at least one compiled Plant')
  const performanceChecks = [
    check('baseline', 'multi-case acceptance run remains comfortably faster than realtime', realtimeFactor >= minRealtimeFactor, `realtimeFactor=${realtimeFactor.toFixed(1)}x min=${minRealtimeFactor.toFixed(1)}x`),
  ] satisfies ReadonlyArray<AcceptanceCheck>
  const failedPerformanceChecks = performanceChecks.filter(candidate => !candidate.passed)
  await mkdir(dirname(traceSvgPath), { recursive: true })
  await writeFile(traceSvgPath, renderSvg(traces, checks))
  if (writeCsvTrace) await writeFile(traceCsvPath, `${csvRowsFor(traces).join('\n')}\n`)
  await writeFile(summaryJsonPath, `${JSON.stringify({
    schemaVersion: 1,
    durationMs,
    stepMs,
    sampleIntervalMs,
    caseCount: cases.length,
    plantCount: cases.length,
    componentCount: firstGraph.components.length * cases.length,
    linkCount: firstGraph.links.length * cases.length,
    variableCount: firstGraph.variables.length * cases.length,
    checkCount: checks.length,
    failedCheckCount: failed.length,
    wallMs,
    realtimeFactor,
    minRealtimeFactor,
    checks,
    performanceChecks,
    artifacts: {
      traceSvgPath,
      ...(writeCsvTrace ? { traceCsvPath } : {}),
      summaryJsonPath,
    },
  }, null, 2)}\n`)
  if (failed.length > 0) {
    const details = failed.map(item => `${item.caseId}: ${item.description} (${item.details})`).join('; ')
    throw new Error(`process plant acceptance failed: ${details}`)
  }
  if (failedPerformanceChecks.length > 0) {
    const details = failedPerformanceChecks.map(item => `${item.description} (${item.details})`).join('; ')
    throw new Error(`process plant acceptance performance failed: ${details}`)
  }
  console.log(`process plant acceptance passed ${checks.length}/${checks.length} checks`)
  console.log(`trace: ${traceSvgPath}`)
  if (writeCsvTrace) console.log(`csv: ${traceCsvPath}`)
  console.log(`summary: ${summaryJsonPath}`)
  console.log(`realtime factor: ${realtimeFactor.toFixed(1)}x`)
}

await main()
