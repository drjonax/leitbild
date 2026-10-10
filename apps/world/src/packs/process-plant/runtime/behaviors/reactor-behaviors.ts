import type { ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { componentVariablePath, processLinkVariablePath } from '../behavior-contract.ts'
import {
  approach,
  clamp,
  hasComponentVariable,
  optionalParameterNumber,
  parameterNumber,
  relaxToward,
  sumComponentValueByKind,
} from '../component-helpers.ts'
import {
  averageIncomingComponentLinkValue as averageIncomingLinkValue,
  sumProcessLinkValueByService as sumLinkValueByService,
} from '../component-link-helpers.ts'
import { flowWeightedIncomingLinkValue, sumIncomingLinkValue } from '../links/link-flow-helpers.ts'
import {
  inventoryBalanceStep,
  primaryCoolantCompressibilityPressureBiasMPa,
  primaryCoolantThermalExpansionPressureBiasMPa,
  reactorKineticsPowerStep,
} from '../physics.ts'
import { primarySystemPressurizer, primarySystemReactorCore, primarySystemReactorVessel } from '../system-topology.ts'
import { saturationTemperatureCFromPressureMPa, waterDeltaTFromHeatMw } from '../thermophysics.ts'
import { nuclearInstrumentationReading } from '../nuclear-instrumentation.ts'

type ReactorBehaviorSystem = Parameters<ComponentBehaviorDefinition['update']>[0]['system']
type ReactorBehaviorContext = Parameters<ComponentBehaviorDefinition['update']>[0]['context']
type ReactorBehaviorLink = ReactorBehaviorSystem['graph']['links'][number]

interface BoundaryInflow {
  readonly flowKgPerS: number
  readonly soluteConcentrationPpm: number | null
}

interface SourceBoundaryFlowGroup {
  branchFlowKgPerS: number
  soluteWeightedTotal: number
  soluteWeightKgPerS: number
}

const sourceFlowCapKgPerS = (
  system: ReactorBehaviorSystem,
  sourceComponentIndex: number,
  context: ReactorBehaviorContext,
): number | null => {
  const component = system.graph.components[sourceComponentIndex]
  if (!component) return null
  for (const localPath of ['flowKgPerS', 'outletFlowKgPerS']) {
    const path = componentVariablePath(component, localPath)
    if (context.has(path)) return Math.max(0, context.readNumber(path))
  }
  return null
}

const boundaryInflowByService = (
  system: ReactorBehaviorSystem,
  context: ReactorBehaviorContext,
  service: string,
  linkMatches: (link: ReactorBehaviorLink) => boolean,
): BoundaryInflow => {
  const groups = new Map<number, SourceBoundaryFlowGroup>()
  for (const link of system.graph.links) {
    if (link.service !== service || !linkMatches(link)) continue
    const flowPath = processLinkVariablePath(link, 'flowKgPerS')
    if (!context.has(flowPath)) continue
    const branchFlow = Math.max(0, context.readNumber(flowPath))
    const group = groups.get(link.fromComponentIndex) ?? {
      branchFlowKgPerS: 0,
      soluteWeightedTotal: 0,
      soluteWeightKgPerS: 0,
    }
    group.branchFlowKgPerS += branchFlow
    const solutePath = processLinkVariablePath(link, 'soluteConcentrationPpm')
    if (branchFlow > 0 && context.has(solutePath)) {
      group.soluteWeightedTotal += context.readNumber(solutePath) * branchFlow
      group.soluteWeightKgPerS += branchFlow
    }
    groups.set(link.fromComponentIndex, group)
  }

  let flowKgPerS = 0
  let soluteWeightedTotal = 0
  let soluteWeightKgPerS = 0
  for (const [sourceComponentIndex, group] of groups) {
    const cap = sourceFlowCapKgPerS(system, sourceComponentIndex, context)
    const creditedFlow = cap === null ? group.branchFlowKgPerS : Math.min(group.branchFlowKgPerS, cap)
    flowKgPerS += creditedFlow
    if (creditedFlow > 0 && group.soluteWeightKgPerS > 0) {
      soluteWeightedTotal += (group.soluteWeightedTotal / group.soluteWeightKgPerS) * creditedFlow
      soluteWeightKgPerS += creditedFlow
    }
  }

  return {
    flowKgPerS,
    soluteConcentrationPpm: soluteWeightKgPerS <= 0 ? null : soluteWeightedTotal / soluteWeightKgPerS,
  }
}

const combineBoundaryInflows = (inflows: ReadonlyArray<BoundaryInflow>): BoundaryInflow => {
  const flowKgPerS = inflows.reduce((total, inflow) => total + inflow.flowKgPerS, 0)
  const soluteWeightedTotal = inflows.reduce(
    (total, inflow) => total + (inflow.soluteConcentrationPpm === null ? 0 : inflow.soluteConcentrationPpm * inflow.flowKgPerS),
    0,
  )
  const soluteWeightKgPerS = inflows.reduce(
    (total, inflow) => total + (inflow.soluteConcentrationPpm === null ? 0 : inflow.flowKgPerS),
    0,
  )
  return {
    flowKgPerS,
    soluteConcentrationPpm: soluteWeightKgPerS <= 0 ? null : soluteWeightedTotal / soluteWeightKgPerS,
  }
}

export const reactorBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'reactor-core-reactivity-control',
    phase: 'updateControlLogic',
    componentKind: 'reactorCore',
    reads: ['rodInsertionFraction', 'reactivityPcm'],
    writes: ['promptReactivityPcm', 'reactivityPcm'],
    update: ({ component, context }): void => {
      if (!hasComponentVariable(component, 'rodInsertionFraction') || !hasComponentVariable(component, 'reactivityPcm')) return
      const rodInsertion = clamp(context.readNumber(componentVariablePath(component, 'rodInsertionFraction')), 0, 1)
      const criticalRodInsertion = optionalParameterNumber(component, 'criticalRodInsertionFraction', clamp(1 - parameterNumber(component, 'initialPowerFraction'), 0, 1))
      const targetReactivity = (criticalRodInsertion - rodInsertion) * optionalParameterNumber(component, 'rodWorthPcm', 1_200)
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      context.write(componentVariablePath(component, 'promptReactivityPcm'), targetReactivity)
      context.write(componentVariablePath(component, 'reactivityPcm'), approach(reactivity, targetReactivity, 500 * context.dtSeconds))
    },
  },
  {
    id: 'reactor-core-heat-to-coolant',
    phase: 'solveThermalTransfer',
    componentKind: 'reactorCore',
    reads: ['totalThermalPowerMw'],
    writes: ['heatToCoolantMw'],
    update: ({ component, context }): void => {
      context.write(componentVariablePath(component, 'heatToCoolantMw'), Math.max(0, context.readNumber(componentVariablePath(component, 'totalThermalPowerMw'))))
    },
  },
  {
    id: 'reactor-core-power-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: [
      'reactivityPcm',
      'powerMw',
      'coolantOutletTemperatureC',
      'fuelTemperatureC',
      'fuelLowerTemperatureC',
      'fuelMidTemperatureC',
      'fuelUpperTemperatureC',
      'decayHeatMw',
      'incoming:flowKgPerS',
      'reactorVessel.boronConcentrationPpm',
    ],
    writes: [
      'powerMw',
      'fissionPowerMw',
      'totalThermalPowerMw',
      'temperatureFeedbackPcm',
      'boronFeedbackPcm',
      'effectiveReactivityPcm',
      'fuelTemperatureC',
      'fuelLowerTemperatureC',
      'fuelMidTemperatureC',
      'fuelUpperTemperatureC',
      'fuelStoredEnergyMj',
      'coreCoolingAvailabilityFraction',
      'coreHeatRemovalDeficitMw',
      'fuelHeatupRateCPerS',
      'decayHeatMw',
      'averageHotLegFlowKgPerS',
      'sourceRangeEnergized',
      'sourceRangeCountRateCps',
      'intermediateRangeCurrentAmps',
    ],
    update: ({ system, component, context }): void => {
      const ratedPower = parameterNumber(component, 'ratedPowerMw')
      const reactivity = context.readNumber(componentVariablePath(component, 'reactivityPcm'))
      const coolantOutlet = context.readNumber(componentVariablePath(component, 'coolantOutletTemperatureC'))
      const currentFuelTemperature = context.readNumber(componentVariablePath(component, 'fuelTemperatureC'))
      const referenceCoolantOutlet = optionalParameterNumber(component, 'referenceCoolantOutletTemperatureC', optionalParameterNumber(component, 'initialCoolantInletTemperatureC', 290) + 32)
      const referenceFuelTemperature = optionalParameterNumber(component, 'referenceFuelTemperatureC', referenceCoolantOutlet + optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140) * parameterNumber(component, 'initialPowerFraction'))
      const temperatureFeedbackPcm =
        (coolantOutlet - referenceCoolantOutlet) * optionalParameterNumber(component, 'coolantTemperatureFeedbackPcmPerC', 0)
        + (currentFuelTemperature - referenceFuelTemperature) * optionalParameterNumber(component, 'fuelTemperatureFeedbackPcmPerC', 0)
      const vessel = primarySystemReactorVessel(system)
      const boronConcentration = vessel === null
        ? optionalParameterNumber(component, 'referenceBoronConcentrationPpm', 0)
        : context.readNumber(componentVariablePath(vessel, 'boronConcentrationPpm'))
      const boronFeedbackPcm =
        (boronConcentration - optionalParameterNumber(component, 'referenceBoronConcentrationPpm', boronConcentration))
        * optionalParameterNumber(component, 'boronFeedbackPcmPerPpm', 0)
      const effectiveReactivity = reactivity + temperatureFeedbackPcm + boronFeedbackPcm
      const currentPower = context.readNumber(componentVariablePath(component, 'powerMw'))
      const nextPower = reactorKineticsPowerStep({
        currentPowerMw: currentPower,
        ratedPowerMw: ratedPower,
        nominalCriticalPowerMw: ratedPower * parameterNumber(component, 'initialPowerFraction'),
        effectiveReactivityPcm: effectiveReactivity,
        dtSeconds: context.dtSeconds,
        pcmPerEfoldPerSecond: optionalParameterNumber(component, 'kineticsPcmPerEfoldPerSecond', 600),
        maxPowerRampFractionPerS: optionalParameterNumber(component, 'maxPowerRampFractionPerS', 0.18),
        maxPowerFraction: 1.2,
      })
      context.write(componentVariablePath(component, 'powerMw'), nextPower)
      context.write(componentVariablePath(component, 'fissionPowerMw'), nextPower)
      context.write(componentVariablePath(component, 'temperatureFeedbackPcm'), temperatureFeedbackPcm)
      context.write(componentVariablePath(component, 'boronFeedbackPcm'), boronFeedbackPcm)
      context.write(componentVariablePath(component, 'effectiveReactivityPcm'), effectiveReactivity)

      const decayTarget = Math.max(currentPower, nextPower) * optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
      const decayHeat = context.readNumber(componentVariablePath(component, 'decayHeatMw'))
      const nextDecayHeat = relaxToward(decayHeat, decayTarget, context.dtSeconds, optionalParameterNumber(component, 'decayHeatTimeConstantS', 900))
      context.write(componentVariablePath(component, 'decayHeatMw'), nextDecayHeat)
      context.write(componentVariablePath(component, 'totalThermalPowerMw'), nextPower + nextDecayHeat)

      const primaryFlow = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => link.service === 'primaryCoolant')
      const nominalPrimaryFlow = optionalParameterNumber(component, 'nominalPrimaryFlowKgPerS', Math.max(1, primaryFlow))
      const minimumCooling = optionalParameterNumber(component, 'minimumNaturalCirculationCoolingFraction', 0.08)
      context.write(componentVariablePath(component, 'averageHotLegFlowKgPerS'), primaryFlow)
      const coolingMargin = clamp(primaryFlow / Math.max(1, nominalPrimaryFlow), minimumCooling, 1.2)
      const creditedCooling = clamp(coolingMargin, 0, 1)
      const totalThermalPower = nextPower + nextDecayHeat
      const heatRemovalDeficit = Math.max(0, totalThermalPower * (1 - creditedCooling))
      const thermalFraction = clamp((nextPower + nextDecayHeat) / ratedPower, 0, 1.25)
      const fuelRise = optionalParameterNumber(component, 'fuelTemperatureRiseAtRatedPowerC', 140)
        * thermalFraction
        / Math.sqrt(Math.max(0.05, coolingMargin))
      const fuelTimeConstant = optionalParameterNumber(component, 'fuelThermalTimeConstantS', 20)
      const nextLower = relaxToward(context.readNumber(componentVariablePath(component, 'fuelLowerTemperatureC')), coolantOutlet + fuelRise * 0.88, context.dtSeconds, fuelTimeConstant)
      const nextMid = relaxToward(context.readNumber(componentVariablePath(component, 'fuelMidTemperatureC')), coolantOutlet + fuelRise * 1.08, context.dtSeconds, fuelTimeConstant)
      const nextUpper = relaxToward(context.readNumber(componentVariablePath(component, 'fuelUpperTemperatureC')), coolantOutlet + fuelRise * 1.00, context.dtSeconds, fuelTimeConstant)
      const nextAverageFuelTemperature = (nextLower + nextMid + nextUpper) / 3
      context.write(componentVariablePath(component, 'fuelLowerTemperatureC'), nextLower)
      context.write(componentVariablePath(component, 'fuelMidTemperatureC'), nextMid)
      context.write(componentVariablePath(component, 'fuelUpperTemperatureC'), nextUpper)
      context.write(componentVariablePath(component, 'fuelTemperatureC'), nextAverageFuelTemperature)
      context.write(componentVariablePath(component, 'fuelStoredEnergyMj'), Math.max(0, nextAverageFuelTemperature - coolantOutlet) * parameterNumber(component, 'fuelThermalCapacityMjPerC'))
      context.write(componentVariablePath(component, 'coreCoolingAvailabilityFraction'), creditedCooling)
      context.write(componentVariablePath(component, 'coreHeatRemovalDeficitMw'), heatRemovalDeficit)
      context.write(componentVariablePath(component, 'fuelHeatupRateCPerS'), (nextAverageFuelTemperature - currentFuelTemperature) / Math.max(context.dtSeconds, 1e-9))
      const instruments = nuclearInstrumentationReading(component, nextPower)
      context.write(componentVariablePath(component, 'sourceRangeEnergized'), instruments.sourceRangeEnergized)
      context.write(componentVariablePath(component, 'sourceRangeCountRateCps'), instruments.sourceRangeCountRateCps)
      context.write(componentVariablePath(component, 'intermediateRangeCurrentAmps'), instruments.intermediateRangeCurrentAmps)
    },
  },
  {
    id: 'reactor-core-coolant-temperature-state',
    phase: 'updateComponentState',
    componentKind: 'reactorCore',
    reads: ['coolantInletTemperatureC', 'coolantOutletTemperatureC', 'heatToCoolantMw', 'incoming:temperatureC', 'incoming:flowKgPerS'],
    writes: ['coolantInletTemperatureC', 'coolantOutletTemperatureC'],
    update: ({ system, component, context }): void => {
      const primaryInletLink = (link: { readonly service?: unknown }): boolean =>
        link.service === 'primaryCoolant'
        || link.service === 'charging'
        || link.service === 'primaryInjection'
        || link.service === 'safetyInjection'
      const inletTemperature = flowWeightedIncomingLinkValue(system, component.index, 'temperatureC', context, primaryInletLink)
        ?? averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'coolantInletTemperatureC'))
      const flow = Math.max(1, sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => link.service === 'primaryCoolant'))
      const heatToCoolant = context.readNumber(componentVariablePath(component, 'heatToCoolantMw'))
      const outletTarget = clamp(inletTemperature + waterDeltaTFromHeatMw(heatToCoolant, flow), 220, 360)
      const currentOutlet = context.readNumber(componentVariablePath(component, 'coolantOutletTemperatureC'))
      const timeConstantSeconds = optionalParameterNumber(component, 'coolantThermalTimeConstantS', 8)
      context.write(componentVariablePath(component, 'coolantInletTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'coolantInletTemperatureC')), inletTemperature, context.dtSeconds, timeConstantSeconds))
      context.write(componentVariablePath(component, 'coolantOutletTemperatureC'), relaxToward(currentOutlet, outletTarget, context.dtSeconds, timeConstantSeconds))
    },
  },
  {
    id: 'reactor-vessel-primary-inventory-state',
    phase: 'updateComponentState',
    componentKind: 'reactorVessel',
    reads: ['primaryCoolantInventoryKg', 'boronConcentrationPpm', 'charging:flowKgPerS', 'charging:soluteConcentrationPpm', 'primaryInjection:flowKgPerS', 'primaryInjection:soluteConcentrationPpm', 'safetyInjection:flowKgPerS', 'safetyInjection:soluteConcentrationPpm', 'letdown:flowKgPerS', 'primaryRelief:flowKgPerS', 'primaryCoolant:leakFlowKgPerS', 'steamGenerator.primaryToSecondaryLeakKgPerS', 'pressurizer.pressureMPa'],
    writes: [
      'primaryCoolantInventoryKg',
      'primaryCoolantInventoryDeviationKg',
      'collapsedLiquidLevelPercent',
      'meanPrimaryCoolantTemperatureC',
      'subcoolingMarginC',
      'compressibilityPressureBiasMPa',
      'thermalExpansionPressureBiasMPa',
      'primaryPressureBiasMPa',
      'chargingFlowKgPerS',
      'safetyInjectionFlowKgPerS',
      'letdownFlowKgPerS',
      'reliefOutflowKgPerS',
      'primaryLeakFlowKgPerS',
      'tubeLeakFlowKgPerS',
      'netInventoryFlowKgPerS',
      'primaryInventoryBalanceResidualKg',
      'boronConcentrationPpm',
      'primaryReleaseRadiationMSvPerH',
    ],
    update: ({ system, component, context }): void => {
      const nominalInventory = parameterNumber(component, 'nominalPrimaryCoolantInventoryKg')
      const currentInventory = context.readNumber(componentVariablePath(component, 'primaryCoolantInventoryKg'))
      const primaryBoundaryLink = (link: { readonly toComponentIndex: number }): boolean => {
        const toComponent = system.graph.components[link.toComponentIndex]
        return toComponent?.kind === 'reactorCore' || toComponent?.kind === 'reactorVessel' || toComponent?.kind === 'pressurizer'
      }
      const chargingInflow = boundaryInflowByService(system, context, 'charging', primaryBoundaryLink)
      const injectionInflow = combineBoundaryInflows([
        boundaryInflowByService(system, context, 'primaryInjection', primaryBoundaryLink),
        boundaryInflowByService(system, context, 'safetyInjection', primaryBoundaryLink),
      ])
      const chargingFlow = chargingInflow.flowKgPerS
      const primaryInjectionFlow = injectionInflow.flowKgPerS
      const letdownFlow = Math.max(
        sumLinkValueByService(system, 'flowKgPerS', context, 'letdown'),
        optionalParameterNumber(component, 'normalLetdownFlowKgPerS', 0),
      )
      const reliefFlow = sumLinkValueByService(system, 'flowKgPerS', context, 'primaryRelief')
      const primaryLeakFlow = sumLinkValueByService(system, 'leakFlowKgPerS', context, 'primaryCoolant')
      const tubeLeakFlow = sumComponentValueByKind(system, 'steamGenerator', 'primaryToSecondaryLeakKgPerS', context)
      const totalInflow = chargingFlow + primaryInjectionFlow
      const netInventoryFlow = totalInflow - letdownFlow - reliefFlow - primaryLeakFlow - tubeLeakFlow
      const currentBoron = context.readNumber(componentVariablePath(component, 'boronConcentrationPpm'))
      const chargingBoron = chargingInflow.soluteConcentrationPpm ?? currentBoron
      const injectionBoron = injectionInflow.soluteConcentrationPpm
        ?? averageIncomingLinkValue(system, component, 'soluteConcentrationPpm', context, link => link.service === 'primaryInjection' || link.service === 'safetyInjection')
        ?? currentBoron
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: totalInflow,
        outflowKgPerS: letdownFlow + reliefFlow + primaryLeakFlow + tubeLeakFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory * 1.15,
      })
      const outgoingFlow = letdownFlow + reliefFlow + primaryLeakFlow + tubeLeakFlow
      const nextBoron = nextInventory <= 0
        ? 0
        : clamp(
            (
              currentBoron * currentInventory
              + (chargingBoron * chargingFlow + injectionBoron * primaryInjectionFlow) * context.dtSeconds
              - currentBoron * outgoingFlow * context.dtSeconds
            ) / nextInventory,
            0,
            20_000,
          )
      const deviation = nextInventory - nominalInventory
      const collapsedLevelReference = nominalInventory * optionalParameterNumber(component, 'collapsedLevelReferenceInventoryFraction', 1)
      const collapsedLiquidLevelPercent = clamp(nextInventory / Math.max(1, collapsedLevelReference) * 100, 0, 100)
      const core = primarySystemReactorCore(system)
      const meanPrimaryCoolantTemperature = core === null
        ? parameterNumber(component, 'referencePrimaryCoolantTemperatureC')
        : (
          context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC'))
          + context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC'))
        ) / 2
      const compressibilityPressureBias = primaryCoolantCompressibilityPressureBiasMPa({
        inventoryKg: nextInventory,
        referenceVolumeM3: parameterNumber(component, 'primaryCoolantVolumeM3'),
        densityKgPerM3: parameterNumber(component, 'nominalPrimaryCoolantDensityKgPerM3'),
        effectiveBulkModulusMPa: parameterNumber(component, 'effectiveBulkModulusMPa'),
      })
      const thermalExpansionPressureBias = primaryCoolantThermalExpansionPressureBiasMPa({
        meanTemperatureC: meanPrimaryCoolantTemperature,
        referenceTemperatureC: parameterNumber(component, 'referencePrimaryCoolantTemperatureC'),
        thermalExpansionCoefficientPerC: parameterNumber(component, 'thermalExpansionCoefficientPerC'),
        effectiveBulkModulusMPa: parameterNumber(component, 'effectiveBulkModulusMPa'),
      })
      const primaryReleaseRadiation = primaryLeakFlow <= 0
        ? 0.02
        : optionalParameterNumber(component, 'primaryReleaseRadiationMSvPerH', 4)
      const pressurizer = primarySystemPressurizer(system)
      const pressureMPa = pressurizer === null
        ? 15.5
        : context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
      const subcoolingMargin = saturationTemperatureCFromPressureMPa(pressureMPa) - meanPrimaryCoolantTemperature
      context.write(componentVariablePath(component, 'chargingFlowKgPerS'), chargingFlow)
      context.write(componentVariablePath(component, 'safetyInjectionFlowKgPerS'), primaryInjectionFlow)
      context.write(componentVariablePath(component, 'letdownFlowKgPerS'), letdownFlow)
      context.write(componentVariablePath(component, 'reliefOutflowKgPerS'), reliefFlow)
      context.write(componentVariablePath(component, 'primaryLeakFlowKgPerS'), primaryLeakFlow)
      context.write(componentVariablePath(component, 'tubeLeakFlowKgPerS'), tubeLeakFlow)
      context.write(componentVariablePath(component, 'netInventoryFlowKgPerS'), netInventoryFlow)
      context.write(componentVariablePath(component, 'primaryInventoryBalanceResidualKg'), nextInventory - currentInventory - netInventoryFlow * context.dtSeconds)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'boronConcentrationPpm'), nextBoron)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryDeviationKg'), deviation)
      context.write(componentVariablePath(component, 'collapsedLiquidLevelPercent'), collapsedLiquidLevelPercent)
      context.write(componentVariablePath(component, 'meanPrimaryCoolantTemperatureC'), meanPrimaryCoolantTemperature)
      context.write(componentVariablePath(component, 'subcoolingMarginC'), subcoolingMargin)
      context.write(componentVariablePath(component, 'compressibilityPressureBiasMPa'), compressibilityPressureBias)
      context.write(componentVariablePath(component, 'thermalExpansionPressureBiasMPa'), thermalExpansionPressureBias)
      context.write(componentVariablePath(component, 'primaryPressureBiasMPa'), compressibilityPressureBias + thermalExpansionPressureBias)
      context.write(componentVariablePath(component, 'primaryReleaseRadiationMSvPerH'), primaryReleaseRadiation)
    },
  },
]
