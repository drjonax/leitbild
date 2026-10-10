import type { CompiledComponent } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { componentVariablePath } from './behavior-contract.ts'
import type { ProcessPlantVariableHandle, ProcessPlantVariableTable } from './variable-table.ts'

type NumberHandle = ProcessPlantVariableHandle
type BooleanHandle = ProcessPlantVariableHandle

export interface PwrTransientKernel {
  readonly active: boolean
  readonly componentCounts: {
    readonly steamGenerators: number
    readonly accumulators: number
    readonly safetyBuses: number
    readonly diesels: number
    readonly electricalBuses: number
  }
  readonly nominalPrimaryInventoryKg: number | null
  readonly handles: {
    readonly primaryInventoryKg: NumberHandle | null
    readonly primaryPressureMPa: NumberHandle | null
    readonly primaryPressureBiasMPa: NumberHandle | null
    readonly primaryLeakFlowKgPerS: NumberHandle | null
    readonly safetyInjectionFlowKgPerS: NumberHandle | null
    readonly tubeLeakFlowKgPerS: NumberHandle | null
    readonly reactorCoolantPumpLoopFlowKgPerS: ReadonlyArray<NumberHandle>
    readonly reactorCoolantPumpRunning: ReadonlyArray<BooleanHandle>
    readonly reactorCoolantPumpSpeedFraction: ReadonlyArray<NumberHandle>
    readonly steamGeneratorSecondaryInventoryKg: ReadonlyArray<NumberHandle>
    readonly steamGeneratorSteamMassKg: ReadonlyArray<NumberHandle>
    readonly steamGeneratorLevelPercent: ReadonlyArray<NumberHandle>
    readonly steamGeneratorTubeCoverageFraction: ReadonlyArray<NumberHandle>
    readonly steamGeneratorTubeUncoveredFraction: ReadonlyArray<NumberHandle>
    readonly steamGeneratorVoidFraction: ReadonlyArray<NumberHandle>
    readonly steamGeneratorHeatTransferMw: ReadonlyArray<NumberHandle>
    readonly steamGeneratorSteamOutflowKgPerS: ReadonlyArray<NumberHandle>
    readonly steamGeneratorFeedwaterFlowKgPerS: ReadonlyArray<NumberHandle>
    readonly feedwaterTankInventoryKg: NumberHandle | null
    readonly feedwaterTankLevelPercent: NumberHandle | null
    readonly feedwaterTankAvailableFlowKgPerS: NumberHandle | null
    readonly auxFeedwaterPumpFlowKgPerS: ReadonlyArray<NumberHandle>
    readonly auxFeedwaterTankInventoryKg: NumberHandle | null
    readonly auxFeedwaterTankLevelPercent: NumberHandle | null
    readonly auxFeedwaterTankAvailableFlowKgPerS: NumberHandle | null
    readonly turbineElectricMw: NumberHandle | null
    readonly turbineSteamFlowKgPerS: NumberHandle | null
    readonly turbineSteamAvailabilityFraction: NumberHandle | null
    readonly condenserBackPressurePa: NumberHandle | null
    readonly condenserHeatRejectedMw: NumberHandle | null
    readonly condenserCondensateInventoryKg: NumberHandle | null
    readonly condenserCondensateLevelPercent: NumberHandle | null
    readonly condenserCoolingWaterAvailabilityFraction: NumberHandle | null
    readonly containmentPressureMPa: NumberHandle | null
    readonly containmentSumpInventoryKg: NumberHandle | null
    readonly containmentIncomingMassKgPerS: NumberHandle | null
    readonly containmentRadiationSourceTermMSvPerH: NumberHandle | null
    readonly coreFissionPowerMw: NumberHandle | null
    readonly coreDecayHeatMw: NumberHandle | null
    readonly coreTotalThermalPowerMw: NumberHandle | null
    readonly coreHeatRemovalDeficitMw: NumberHandle | null
    readonly coreCoolingAvailabilityFraction: NumberHandle | null
    readonly fuelHeatupRateCPerS: NumberHandle | null
    readonly accumulatorInventoryKg: ReadonlyArray<NumberHandle>
    readonly accumulatorOutflowKgPerS: ReadonlyArray<NumberHandle>
    readonly safetyBusEnergized: ReadonlyArray<BooleanHandle>
    readonly dieselRunning: ReadonlyArray<BooleanHandle>
    readonly electricalBusEnergized: ReadonlyArray<BooleanHandle>
    readonly electricalBusDegraded: ReadonlyArray<BooleanHandle>
    readonly electricalBusVoltageFraction: ReadonlyArray<NumberHandle>
    readonly safetyBusVoltageFraction: ReadonlyArray<NumberHandle>
    readonly electricalLoadServedMw: ReadonlyArray<NumberHandle>
    readonly electricalLoadDemandMw: ReadonlyArray<NumberHandle>
    readonly electricalLoadServedFraction: ReadonlyArray<NumberHandle>
    readonly steamGeneratorLiquidResidualKg: ReadonlyArray<NumberHandle>
    readonly steamGeneratorSteamResidualKg: ReadonlyArray<NumberHandle>
    readonly steamGeneratorBoilingResidualMw: ReadonlyArray<NumberHandle>
    readonly primaryInventoryResidualKg: NumberHandle | null
    readonly pressurizerWaterResidualKg: NumberHandle | null
    readonly pressurizerSteamResidualKg: NumberHandle | null
  }
}

export interface PwrTransientDiagnostics {
  readonly schemaVersion: 1
  readonly active: boolean
  readonly componentCounts: {
    readonly steamGenerators: number
    readonly accumulators: number
    readonly safetyBuses: number
    readonly diesels: number
  }
  readonly primary: {
    readonly inventoryKg: number | null
    readonly inventoryFraction: number | null
    readonly pressureMPa: number | null
    readonly pressureBiasMPa: number | null
    readonly leakFlowKgPerS: number | null
    readonly safetyInjectionFlowKgPerS: number | null
    readonly tubeLeakFlowKgPerS: number | null
    readonly reactorCoolantFlowKgPerS: number
    readonly runningReactorCoolantPumpCount: number
    readonly minReactorCoolantPumpSpeedFraction: number | null
  }
  readonly secondary: {
    readonly liquidInventoryKg: number
    readonly steamMassKg: number
    readonly minLevelPercent: number | null
    readonly minTubeCoverageFraction: number | null
    readonly maxTubeUncoveredFraction: number | null
    readonly maxVoidFraction: number | null
    readonly drySteamGeneratorCount: number
    readonly tubeBundleUncoveredSteamGeneratorCount: number
    readonly heatTransferMw: number
    readonly steamOutflowKgPerS: number
    readonly feedwaterFlowKgPerS: number
    readonly feedwaterTankInventoryKg: number | null
    readonly feedwaterTankLevelPercent: number | null
    readonly feedwaterTankAvailableFlowKgPerS: number | null
    readonly auxFeedwaterFlowKgPerS: number
    readonly auxFeedwaterTankInventoryKg: number | null
    readonly auxFeedwaterTankLevelPercent: number | null
    readonly auxFeedwaterTankAvailableFlowKgPerS: number | null
  }
  readonly balanceOfPlant: {
    readonly turbineElectricMw: number | null
    readonly turbineSteamFlowKgPerS: number | null
    readonly turbineSteamAvailabilityFraction: number | null
    readonly condenserBackPressurePa: number | null
    readonly condenserHeatRejectedMw: number | null
    readonly condenserCondensateInventoryKg: number | null
    readonly condenserCondensateLevelPercent: number | null
    readonly condenserCoolingWaterAvailabilityFraction: number | null
  }
  readonly containment: {
    readonly pressureMPa: number | null
    readonly sumpInventoryKg: number | null
    readonly incomingMassKgPerS: number | null
    readonly radiationSourceTermMSvPerH: number | null
  }
  readonly core: {
    readonly fissionPowerMw: number | null
    readonly decayHeatMw: number | null
    readonly totalThermalPowerMw: number | null
    readonly heatRemovalDeficitMw: number | null
    readonly coolingAvailabilityFraction: number | null
    readonly fuelHeatupRateCPerS: number | null
  }
  readonly safetySystems: {
    readonly accumulatorInventoryKg: number
    readonly accumulatorOutflowKgPerS: number
    readonly deenergizedSafetyBusCount: number
    readonly runningDieselCount: number
  }
  readonly electrical: {
    readonly busCount: number
    readonly energizedBusCount: number
    readonly deenergizedBusCount: number
    readonly degradedBusCount: number
    readonly minBusVoltageFraction: number | null
    readonly minSafetyBusVoltageFraction: number | null
    readonly totalServedLoadMw: number
    readonly totalDemandLoadMw: number
    readonly minLoadServedFraction: number | null
    readonly unservedLoadCount: number
  }
  readonly conservation: {
    readonly maxSteamGeneratorLiquidResidualKg: number
    readonly maxSteamGeneratorSteamResidualKg: number
    readonly maxSteamGeneratorBoilingResidualMw: number
    readonly primaryInventoryResidualKg: number | null
    readonly pressurizerWaterResidualKg: number | null
    readonly pressurizerSteamResidualKg: number | null
  }
}

const componentOfKind = (
  system: CompiledProcessPlant,
  kind: string,
): CompiledComponent | null =>
  system.graph.components.find(component => String(component.kind) === kind) ?? null

const componentById = (
  system: CompiledProcessPlant,
  id: string,
): CompiledComponent | null =>
  system.graph.components.find(component => String(component.id) === id) ?? null

const componentsOfKind = (
  system: CompiledProcessPlant,
  kind: string,
): ReadonlyArray<CompiledComponent> =>
  system.graph.components.filter(component => String(component.kind) === kind)

const nominalPrimaryInventoryFor = (vessel: CompiledComponent | null): number | null =>
  vessel !== null
  && typeof vessel.parameters === 'object'
  && vessel.parameters !== null
  && 'nominalPrimaryCoolantInventoryKg' in vessel.parameters
  && typeof (vessel.parameters as { nominalPrimaryCoolantInventoryKg?: unknown }).nominalPrimaryCoolantInventoryKg === 'number'
    ? (vessel.parameters as { nominalPrimaryCoolantInventoryKg: number }).nominalPrimaryCoolantInventoryKg
    : null

const handleFor = (
  table: ProcessPlantVariableTable,
  component: CompiledComponent | null,
  localPath: string,
): ProcessPlantVariableHandle | null => {
  if (component === null) return null
  const path = componentVariablePath(component, localPath)
  return table.has(path) ? table.resolve(path) : null
}

const handlesFor = (
  table: ProcessPlantVariableTable,
  components: ReadonlyArray<CompiledComponent>,
  localPath: string,
): ReadonlyArray<ProcessPlantVariableHandle> =>
  components.flatMap(component => {
    const handle = handleFor(table, component, localPath)
    return handle === null ? [] : [handle]
  })

const readOptionalNumber = (
  table: ProcessPlantVariableTable,
  handle: NumberHandle | null,
): number | null => handle === null ? null : table.readNumberHandle(handle)

const sumNumbers = (
  table: ProcessPlantVariableTable,
  handles: ReadonlyArray<NumberHandle>,
): number => {
  let sum = 0
  for (const handle of handles) sum += table.readNumberHandle(handle)
  return sum
}

const minimum = (
  table: ProcessPlantVariableTable,
  handles: ReadonlyArray<NumberHandle>,
): number | null => {
  let min = Number.POSITIVE_INFINITY
  for (const handle of handles) min = Math.min(min, table.readNumberHandle(handle))
  return min === Number.POSITIVE_INFINITY ? null : min
}

const maximum = (
  table: ProcessPlantVariableTable,
  handles: ReadonlyArray<NumberHandle>,
): number | null => {
  let max = Number.NEGATIVE_INFINITY
  for (const handle of handles) max = Math.max(max, table.readNumberHandle(handle))
  return max === Number.NEGATIVE_INFINITY ? null : max
}

const countNumbers = (
  table: ProcessPlantVariableTable,
  handles: ReadonlyArray<NumberHandle>,
  matches: (value: number) => boolean,
): number => {
  let count = 0
  for (const handle of handles) {
    if (matches(table.readNumberHandle(handle))) count += 1
  }
  return count
}

const countBooleans = (
  table: ProcessPlantVariableTable,
  handles: ReadonlyArray<BooleanHandle>,
  expected: boolean,
): number => {
  let count = 0
  for (const handle of handles) {
    if (table.readBooleanHandle(handle) === expected) count += 1
  }
  return count
}

const maxAbs = (
  table: ProcessPlantVariableTable,
  handles: ReadonlyArray<NumberHandle>,
): number => {
  let max = 0
  for (const handle of handles) max = Math.max(max, Math.abs(table.readNumberHandle(handle)))
  return max
}

export const compilePwrTransientKernel = (
  system: CompiledProcessPlant,
  table: ProcessPlantVariableTable,
): PwrTransientKernel => {
  const steamGenerators = componentsOfKind(system, 'steamGenerator')
  const core = componentOfKind(system, 'reactorCore')
  const reactorVessel = componentOfKind(system, 'reactorVessel')
  const pressurizer = componentOfKind(system, 'pressurizer')
  const containment = componentOfKind(system, 'containmentVolume')
  const accumulators = componentsOfKind(system, 'accumulator')
  const reactorCoolantPumps = componentsOfKind(system, 'centrifugalPump')
    .filter(component => String(component.id).toLowerCase().startsWith('rcp'))
  const auxFeedwaterPumps = componentsOfKind(system, 'centrifugalPump')
    .filter(component => String(component.id).toLowerCase().startsWith('auxfeedwaterpump'))
  const turbine = componentOfKind(system, 'turbineLoadSink')
  const condenser = componentOfKind(system, 'condenserSink')
  const feedwaterTank = componentById(system, 'feedwaterTank')
  const auxFeedwaterTank = componentById(system, 'auxFeedwaterTank')
  const electricalBuses = componentsOfKind(system, 'electricalBus')
  const safetyBuses = electricalBuses.filter(component => String(component.id).toLowerCase().includes('safety'))
  const electricalLoads = componentsOfKind(system, 'electricalLoad')
  const diesels = componentsOfKind(system, 'dieselGenerator')

  return {
    active: core !== null && reactorVessel !== null && pressurizer !== null && steamGenerators.length > 0,
    componentCounts: {
      steamGenerators: steamGenerators.length,
      accumulators: accumulators.length,
      safetyBuses: safetyBuses.length,
      diesels: diesels.length,
      electricalBuses: electricalBuses.length,
    },
    nominalPrimaryInventoryKg: nominalPrimaryInventoryFor(reactorVessel),
    handles: {
      primaryInventoryKg: handleFor(table, reactorVessel, 'primaryCoolantInventoryKg'),
      primaryPressureMPa: handleFor(table, pressurizer, 'pressureMPa'),
      primaryPressureBiasMPa: handleFor(table, reactorVessel, 'primaryPressureBiasMPa'),
      primaryLeakFlowKgPerS: handleFor(table, reactorVessel, 'primaryLeakFlowKgPerS'),
      safetyInjectionFlowKgPerS: handleFor(table, reactorVessel, 'safetyInjectionFlowKgPerS'),
      tubeLeakFlowKgPerS: handleFor(table, reactorVessel, 'tubeLeakFlowKgPerS'),
      reactorCoolantPumpLoopFlowKgPerS: handlesFor(table, reactorCoolantPumps, 'loopFlowKgPerS'),
      reactorCoolantPumpRunning: handlesFor(table, reactorCoolantPumps, 'runningState'),
      reactorCoolantPumpSpeedFraction: handlesFor(table, reactorCoolantPumps, 'speedFraction'),
      steamGeneratorSecondaryInventoryKg: handlesFor(table, steamGenerators, 'secondaryInventoryKg'),
      steamGeneratorSteamMassKg: handlesFor(table, steamGenerators, 'steamMassKg'),
      steamGeneratorLevelPercent: handlesFor(table, steamGenerators, 'levelPercent'),
      steamGeneratorTubeCoverageFraction: handlesFor(table, steamGenerators, 'tubeCoverageFraction'),
      steamGeneratorTubeUncoveredFraction: handlesFor(table, steamGenerators, 'tubeUncoveredFraction'),
      steamGeneratorVoidFraction: handlesFor(table, steamGenerators, 'voidFraction'),
      steamGeneratorHeatTransferMw: handlesFor(table, steamGenerators, 'heatTransferMw'),
      steamGeneratorSteamOutflowKgPerS: handlesFor(table, steamGenerators, 'steamOutflowKgPerS'),
      steamGeneratorFeedwaterFlowKgPerS: handlesFor(table, steamGenerators, 'feedwaterFlowKgPerS'),
      feedwaterTankInventoryKg: handleFor(table, feedwaterTank, 'inventoryKg'),
      feedwaterTankLevelPercent: handleFor(table, feedwaterTank, 'levelPercent'),
      feedwaterTankAvailableFlowKgPerS: handleFor(table, feedwaterTank, 'availableOutletFlowKgPerS'),
      auxFeedwaterPumpFlowKgPerS: handlesFor(table, auxFeedwaterPumps, 'flowKgPerS'),
      auxFeedwaterTankInventoryKg: handleFor(table, auxFeedwaterTank, 'inventoryKg'),
      auxFeedwaterTankLevelPercent: handleFor(table, auxFeedwaterTank, 'levelPercent'),
      auxFeedwaterTankAvailableFlowKgPerS: handleFor(table, auxFeedwaterTank, 'availableOutletFlowKgPerS'),
      turbineElectricMw: handleFor(table, turbine, 'electricMw'),
      turbineSteamFlowKgPerS: handleFor(table, turbine, 'steamFlowKgPerS'),
      turbineSteamAvailabilityFraction: handleFor(table, turbine, 'steamAvailabilityFraction'),
      condenserBackPressurePa: handleFor(table, condenser, 'backPressurePa'),
      condenserHeatRejectedMw: handleFor(table, condenser, 'heatRejectedMw'),
      condenserCondensateInventoryKg: handleFor(table, condenser, 'condensateInventoryKg'),
      condenserCondensateLevelPercent: handleFor(table, condenser, 'condensateLevelPercent'),
      condenserCoolingWaterAvailabilityFraction: handleFor(table, condenser, 'coolingWaterAvailabilityFraction'),
      containmentPressureMPa: handleFor(table, containment, 'pressureMPa'),
      containmentSumpInventoryKg: handleFor(table, containment, 'sumpInventoryKg'),
      containmentIncomingMassKgPerS: handleFor(table, containment, 'incomingMassKgPerS'),
      containmentRadiationSourceTermMSvPerH: handleFor(table, containment, 'radiationSourceTermMSvPerH'),
      coreFissionPowerMw: handleFor(table, core, 'fissionPowerMw'),
      coreDecayHeatMw: handleFor(table, core, 'decayHeatMw'),
      coreTotalThermalPowerMw: handleFor(table, core, 'totalThermalPowerMw'),
      coreHeatRemovalDeficitMw: handleFor(table, core, 'coreHeatRemovalDeficitMw'),
      coreCoolingAvailabilityFraction: handleFor(table, core, 'coreCoolingAvailabilityFraction'),
      fuelHeatupRateCPerS: handleFor(table, core, 'fuelHeatupRateCPerS'),
      accumulatorInventoryKg: handlesFor(table, accumulators, 'liquidInventoryKg'),
      accumulatorOutflowKgPerS: handlesFor(table, accumulators, 'outletFlowKgPerS'),
      safetyBusEnergized: handlesFor(table, safetyBuses, 'energized'),
      dieselRunning: handlesFor(table, diesels, 'running'),
      electricalBusEnergized: handlesFor(table, electricalBuses, 'energized'),
      electricalBusDegraded: handlesFor(table, electricalBuses, 'degraded'),
      electricalBusVoltageFraction: handlesFor(table, electricalBuses, 'voltageFraction'),
      safetyBusVoltageFraction: handlesFor(table, safetyBuses, 'voltageFraction'),
      electricalLoadServedMw: handlesFor(table, electricalLoads, 'servedMw'),
      electricalLoadDemandMw: handlesFor(table, electricalLoads, 'demandMw'),
      electricalLoadServedFraction: handlesFor(table, electricalLoads, 'servedFraction'),
      steamGeneratorLiquidResidualKg: handlesFor(table, steamGenerators, 'secondaryInventoryBalanceResidualKg'),
      steamGeneratorSteamResidualKg: handlesFor(table, steamGenerators, 'steamMassBalanceResidualKg'),
      steamGeneratorBoilingResidualMw: handlesFor(table, steamGenerators, 'boilingEnergyResidualMw'),
      primaryInventoryResidualKg: handleFor(table, reactorVessel, 'primaryInventoryBalanceResidualKg'),
      pressurizerWaterResidualKg: handleFor(table, pressurizer, 'waterInventoryBalanceResidualKg'),
      pressurizerSteamResidualKg: handleFor(table, pressurizer, 'steamMassBalanceResidualKg'),
    },
  }
}

export const evaluatePwrTransientKernel = (
  kernel: PwrTransientKernel,
  table: ProcessPlantVariableTable,
): PwrTransientDiagnostics => {
  const handles = kernel.handles
  const primaryInventory = readOptionalNumber(table, handles.primaryInventoryKg)
  const heatTransfer = sumNumbers(table, handles.steamGeneratorHeatTransferMw)
  const totalThermalPower = readOptionalNumber(table, handles.coreTotalThermalPowerMw)
  const explicitHeatRemovalDeficit = readOptionalNumber(table, handles.coreHeatRemovalDeficitMw)
  return {
    schemaVersion: 1,
    active: kernel.active,
    componentCounts: {
      steamGenerators: kernel.componentCounts.steamGenerators,
      accumulators: kernel.componentCounts.accumulators,
      safetyBuses: kernel.componentCounts.safetyBuses,
      diesels: kernel.componentCounts.diesels,
    },
    primary: {
      inventoryKg: primaryInventory,
      inventoryFraction: primaryInventory === null || kernel.nominalPrimaryInventoryKg === null ? null : primaryInventory / kernel.nominalPrimaryInventoryKg,
      pressureMPa: readOptionalNumber(table, handles.primaryPressureMPa),
      pressureBiasMPa: readOptionalNumber(table, handles.primaryPressureBiasMPa),
      leakFlowKgPerS: readOptionalNumber(table, handles.primaryLeakFlowKgPerS),
      safetyInjectionFlowKgPerS: readOptionalNumber(table, handles.safetyInjectionFlowKgPerS),
      tubeLeakFlowKgPerS: readOptionalNumber(table, handles.tubeLeakFlowKgPerS),
      reactorCoolantFlowKgPerS: sumNumbers(table, handles.reactorCoolantPumpLoopFlowKgPerS),
      runningReactorCoolantPumpCount: countBooleans(table, handles.reactorCoolantPumpRunning, true),
      minReactorCoolantPumpSpeedFraction: minimum(table, handles.reactorCoolantPumpSpeedFraction),
    },
    secondary: {
      liquidInventoryKg: sumNumbers(table, handles.steamGeneratorSecondaryInventoryKg),
      steamMassKg: sumNumbers(table, handles.steamGeneratorSteamMassKg),
      minLevelPercent: minimum(table, handles.steamGeneratorLevelPercent),
      minTubeCoverageFraction: minimum(table, handles.steamGeneratorTubeCoverageFraction),
      maxTubeUncoveredFraction: maximum(table, handles.steamGeneratorTubeUncoveredFraction),
      maxVoidFraction: maximum(table, handles.steamGeneratorVoidFraction),
      drySteamGeneratorCount: countNumbers(table, handles.steamGeneratorLevelPercent, level => level <= 5),
      tubeBundleUncoveredSteamGeneratorCount: countNumbers(table, handles.steamGeneratorTubeUncoveredFraction, uncovered => uncovered > 0.05),
      heatTransferMw: heatTransfer,
      steamOutflowKgPerS: sumNumbers(table, handles.steamGeneratorSteamOutflowKgPerS),
      feedwaterFlowKgPerS: sumNumbers(table, handles.steamGeneratorFeedwaterFlowKgPerS),
      feedwaterTankInventoryKg: readOptionalNumber(table, handles.feedwaterTankInventoryKg),
      feedwaterTankLevelPercent: readOptionalNumber(table, handles.feedwaterTankLevelPercent),
      feedwaterTankAvailableFlowKgPerS: readOptionalNumber(table, handles.feedwaterTankAvailableFlowKgPerS),
      auxFeedwaterFlowKgPerS: sumNumbers(table, handles.auxFeedwaterPumpFlowKgPerS),
      auxFeedwaterTankInventoryKg: readOptionalNumber(table, handles.auxFeedwaterTankInventoryKg),
      auxFeedwaterTankLevelPercent: readOptionalNumber(table, handles.auxFeedwaterTankLevelPercent),
      auxFeedwaterTankAvailableFlowKgPerS: readOptionalNumber(table, handles.auxFeedwaterTankAvailableFlowKgPerS),
    },
    balanceOfPlant: {
      turbineElectricMw: readOptionalNumber(table, handles.turbineElectricMw),
      turbineSteamFlowKgPerS: readOptionalNumber(table, handles.turbineSteamFlowKgPerS),
      turbineSteamAvailabilityFraction: readOptionalNumber(table, handles.turbineSteamAvailabilityFraction),
      condenserBackPressurePa: readOptionalNumber(table, handles.condenserBackPressurePa),
      condenserHeatRejectedMw: readOptionalNumber(table, handles.condenserHeatRejectedMw),
      condenserCondensateInventoryKg: readOptionalNumber(table, handles.condenserCondensateInventoryKg),
      condenserCondensateLevelPercent: readOptionalNumber(table, handles.condenserCondensateLevelPercent),
      condenserCoolingWaterAvailabilityFraction: readOptionalNumber(table, handles.condenserCoolingWaterAvailabilityFraction),
    },
    containment: {
      pressureMPa: readOptionalNumber(table, handles.containmentPressureMPa),
      sumpInventoryKg: readOptionalNumber(table, handles.containmentSumpInventoryKg),
      incomingMassKgPerS: readOptionalNumber(table, handles.containmentIncomingMassKgPerS),
      radiationSourceTermMSvPerH: readOptionalNumber(table, handles.containmentRadiationSourceTermMSvPerH),
    },
    core: {
      fissionPowerMw: readOptionalNumber(table, handles.coreFissionPowerMw),
      decayHeatMw: readOptionalNumber(table, handles.coreDecayHeatMw),
      totalThermalPowerMw: totalThermalPower,
      heatRemovalDeficitMw: explicitHeatRemovalDeficit
        ?? (totalThermalPower === null ? null : Math.max(0, totalThermalPower - heatTransfer)),
      coolingAvailabilityFraction: readOptionalNumber(table, handles.coreCoolingAvailabilityFraction),
      fuelHeatupRateCPerS: readOptionalNumber(table, handles.fuelHeatupRateCPerS),
    },
    safetySystems: {
      accumulatorInventoryKg: sumNumbers(table, handles.accumulatorInventoryKg),
      accumulatorOutflowKgPerS: sumNumbers(table, handles.accumulatorOutflowKgPerS),
      deenergizedSafetyBusCount: countBooleans(table, handles.safetyBusEnergized, false),
      runningDieselCount: countBooleans(table, handles.dieselRunning, true),
    },
    electrical: {
      busCount: kernel.componentCounts.electricalBuses,
      energizedBusCount: countBooleans(table, handles.electricalBusEnergized, true),
      deenergizedBusCount: countBooleans(table, handles.electricalBusEnergized, false),
      degradedBusCount: countBooleans(table, handles.electricalBusDegraded, true),
      minBusVoltageFraction: minimum(table, handles.electricalBusVoltageFraction),
      minSafetyBusVoltageFraction: minimum(table, handles.safetyBusVoltageFraction),
      totalServedLoadMw: sumNumbers(table, handles.electricalLoadServedMw),
      totalDemandLoadMw: sumNumbers(table, handles.electricalLoadDemandMw),
      minLoadServedFraction: minimum(table, handles.electricalLoadServedFraction),
      unservedLoadCount: countNumbers(table, handles.electricalLoadServedFraction, fraction => fraction < 0.99),
    },
    conservation: {
      maxSteamGeneratorLiquidResidualKg: maxAbs(table, handles.steamGeneratorLiquidResidualKg),
      maxSteamGeneratorSteamResidualKg: maxAbs(table, handles.steamGeneratorSteamResidualKg),
      maxSteamGeneratorBoilingResidualMw: maxAbs(table, handles.steamGeneratorBoilingResidualMw),
      primaryInventoryResidualKg: readOptionalNumber(table, handles.primaryInventoryResidualKg),
      pressurizerWaterResidualKg: readOptionalNumber(table, handles.pressurizerWaterResidualKg),
      pressurizerSteamResidualKg: readOptionalNumber(table, handles.pressurizerSteamResidualKg),
    },
  }
}
