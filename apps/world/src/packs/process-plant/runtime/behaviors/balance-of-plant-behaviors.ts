import type { CompiledComponent } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath, type ComponentBehaviorDefinition, type ProcessPlantBehaviorContext } from '../behavior-contract.ts'
import { approach, clamp, optionalParameterNumber, parameterNumber, relaxToward } from '../component-helpers.ts'
import {
  averageIncomingComponentLinkValue as averageIncomingLinkValue,
  sumIncomingComponentLinkValue as sumIncomingLinkValue,
  sumOutgoingComponentLinkValue as sumOutgoingLinkValue,
  flowWeightedIncomingComponentLinkValue,
} from '../component-link-helpers.ts'
import { inventoryBalanceStep } from '../physics.ts'
import { heatMwFromWaterFlowAndDeltaT, latentHeatSteamMjPerKg } from '../thermophysics.ts'
import { condenserThermalBalance } from '../condenser-thermodynamics.ts'

const downstreamCondenserBackPressurePa = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): number | null => {
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'fluidFlow') continue
    const toComponent = system.graph.components[link.toComponentIndex]
    if (toComponent?.kind !== 'condenserSink') continue
    return context.readNumber(componentVariablePath(toComponent, 'backPressurePa'))
  }
  return null
}

const condenserBackPressureAvailability = (backPressurePa: number | null, nominalBackPressurePa: number): number => {
  if (backPressurePa === null) return 1
  return clamp(1 - Math.max(0, backPressurePa - nominalBackPressurePa) / 55_000, 0.25, 1)
}

interface InletLevelControl {
  readonly setpointPercent: number
  readonly proportionalBandPercent: number
  readonly timeConstantS: number
}

/** A tank's inlet level controller, or null where it takes in whatever comes. */
export const inletLevelControlOf = (component: CompiledComponent): InletLevelControl | null =>
  ((component.parameters as Readonly<Record<string, unknown>>).inletLevelControl as InletLevelControl | undefined) ?? null

/** Where the inlet valve goes at a level: open to the set point, shut a proportional band above it. */
export const inletControlTarget = (control: InletLevelControl, levelPercent: number): number =>
  clamp((control.setpointPercent + control.proportionalBandPercent - levelPercent) / control.proportionalBandPercent, 0, 1)

export const balanceOfPlantBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'turbine-electrical-output',
    phase: 'solveElectrical',
    componentKind: 'turbineLoadSink',
    reads: ['loadFraction', 'steamFlowKgPerS', 'incoming:flowKgPerS', 'incoming:pressureMPa'],
    writes: ['electricMw', 'outputBreakerClosed', 'steamFlowKgPerS', 'steamDemandKgPerS', 'steamAvailabilityFraction', 'exhaustTemperatureC'],
    update: ({ system, component, context }): void => {
      const inletSteamFlow = averageIncomingLinkValue(system, component, 'flowKgPerS', context) ?? 0
      const averageSteamPressure = averageIncomingLinkValue(system, component, 'pressureMPa', context)
      const nominalSteamFlow = parameterNumber(component, 'nominalSteamFlowKgPerS')
      const load = clamp(context.readNumber(componentVariablePath(component, 'loadFraction')), 0, 1)
      const backPressurePa = downstreamCondenserBackPressurePa(system, component, context)
      const backPressureAvailability = condenserBackPressureAvailability(backPressurePa, optionalParameterNumber(component, 'nominalBackPressurePa', 12_000))
      const steamDemand = nominalSteamFlow * load * backPressureAvailability
      const steamAvailability = clamp(inletSteamFlow / Math.max(1, steamDemand), 0, 1.2)
      const nominalSteamPressure = optionalParameterNumber(component, 'nominalSteamPressureMPa', 6.9)
      const pressureAvailability = clamp((averageSteamPressure ?? nominalSteamPressure) / nominalSteamPressure, 0, 1.2)
      const target = parameterNumber(component, 'nominalElectricMw') * load * Math.min(steamAvailability, pressureAvailability, backPressureAvailability)
      const current = context.readNumber(componentVariablePath(component, 'electricMw'))
      const noLoadExhaust = optionalParameterNumber(component, 'exhaustTemperatureAtNoLoadC', 105)
      const fullLoadExhaust = optionalParameterNumber(component, 'exhaustTemperatureAtFullLoadC', 145)
      const exhaustTarget = noLoadExhaust + (fullLoadExhaust - noLoadExhaust) * clamp(Math.min(steamAvailability, load), 0, 1)
      context.write(componentVariablePath(component, 'steamDemandKgPerS'), steamDemand)
      context.write(componentVariablePath(component, 'steamAvailabilityFraction'), clamp(inletSteamFlow / Math.max(1, steamDemand), 0, 1))
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), inletSteamFlow)
      context.write(componentVariablePath(component, 'exhaustTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'exhaustTemperatureC')), exhaustTarget, context.dtSeconds, optionalParameterNumber(component, 'electricalTimeConstantS', 5)))
      // With its load rejected the generator's output breaker is open: it carries nothing at once.
      context.write(componentVariablePath(component, 'outputBreakerClosed'), load > 0)
      context.write(
        componentVariablePath(component, 'electricMw'),
        load === 0 ? 0 : relaxToward(current, target, context.dtSeconds, optionalParameterNumber(component, 'electricalTimeConstantS', 5)),
      )
    },
  },
  {
    id: 'process-tank-inventory-state',
    phase: 'updateComponentState',
    componentKind: 'processTank',
    reads: [
      'inventoryKg',
      'levelPercent',
      'temperatureC',
      'soluteConcentrationPpm',
      'makeupFlowKgPerS',
      'incoming:flowKgPerS',
      'incoming:temperatureC',
      'incoming:soluteConcentrationPpm',
      'outgoing:flowKgPerS',
    ],
    writes: ['inventoryKg', 'levelPercent', 'temperatureC', 'soluteConcentrationPpm', 'availableOutletFlowKgPerS', 'inletControlFraction'],
    update: ({ system, component, context }): void => {
      const nominalInventory = parameterNumber(component, 'nominalInventoryKg')
      const currentInventory = context.readNumber(componentVariablePath(component, 'inventoryKg'))
      const incomingFlow = sumIncomingLinkValue(system, component, 'flowKgPerS', context)
      const outgoingFlow = sumOutgoingLinkValue(system, component, 'flowKgPerS', context)
      const makeupFlow = clamp(context.readNumber(componentVariablePath(component, 'makeupFlowKgPerS')), 0, parameterNumber(component, 'maxOutletFlowKgPerS'))
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: incomingFlow + makeupFlow,
        outflowKgPerS: outgoingFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory,
      })
      const nextLevel = clamp((nextInventory / nominalInventory) * 100, 0, 100)
      const maxOutletFlow = parameterNumber(component, 'maxOutletFlowKgPerS')
      const inventoryLimitedOutlet = context.dtSeconds > 0 ? nextInventory / context.dtSeconds : maxOutletFlow
      const nextAvailableOutletFlow = Math.min(maxOutletFlow, inventoryLimitedOutlet)
      const incomingTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context)
      const targetTemperature = incomingTemperature ?? parameterNumber(component, 'initialTemperatureC')
      const currentSolute = context.readNumber(componentVariablePath(component, 'soluteConcentrationPpm'))
      const incomingSolute = averageIncomingLinkValue(system, component, 'soluteConcentrationPpm', context) ?? currentSolute
      const makeupSolute = optionalParameterNumber(component, 'makeupSoluteConcentrationPpm', currentSolute)
      const inflow = incomingFlow + makeupFlow
      const inflowSolute = inflow > 0
        ? ((incomingSolute * incomingFlow) + (makeupSolute * makeupFlow)) / inflow
        : currentSolute
      const nextSolute = nextInventory <= 0
        ? 0
        : clamp(
            (
              currentSolute * currentInventory
              + inflowSolute * inflow * context.dtSeconds
              - currentSolute * outgoingFlow * context.dtSeconds
            ) / nextInventory,
            0,
            20_000,
          )
      context.write(componentVariablePath(component, 'inventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'levelPercent'), nextLevel)
      context.write(componentVariablePath(component, 'availableOutletFlowKgPerS'), nextAvailableOutletFlow)
      const inletControl = inletLevelControlOf(component)
      if (inletControl !== null) {
        context.write(componentVariablePath(component, 'inletControlFraction'), relaxToward(
          context.readNumber(componentVariablePath(component, 'inletControlFraction')),
          inletControlTarget(inletControl, nextLevel),
          context.dtSeconds,
          inletControl.timeConstantS,
        ))
      }
      context.write(componentVariablePath(component, 'soluteConcentrationPpm'), nextSolute)
      context.write(
        componentVariablePath(component, 'temperatureC'),
        relaxToward(
          context.readNumber(componentVariablePath(component, 'temperatureC')),
          targetTemperature,
          context.dtSeconds,
          optionalParameterNumber(component, 'thermalTimeConstantS', 30),
        ),
      )
    },
  },
  {
    id: 'condenser-steam-sink-state',
    phase: 'updateComponentState',
    componentKind: 'condenserSink',
    reads: ['steamFlowKgPerS', 'condensateTemperatureC', 'backPressurePa', 'incoming:flowKgPerS', 'incoming:temperatureC'],
    writes: [
      'steamFlowKgPerS',
      'condensateProductionKgPerS',
      'heatRejectedMw',
      'condensateInventoryKg',
      'condensateLevelPercent',
      'availableCondensateOutletFlowKgPerS',
      'condensateTemperatureC',
      'backPressurePa',
      'coolingWaterFlowKgPerS',
      'coolingWaterInletTemperatureC',
      'coolingWaterOutletTemperatureC',
      'coolingWaterHeatCapacityMw',
      'coolingWaterAvailabilityFraction',
    ],
    update: ({ system, component, context }): void => {
      const steamFlow = sumIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'exhaustSteam' || link.service === 'mainSteam')
      const steamTemperature = flowWeightedIncomingComponentLinkValue(system, component, 'temperatureC', context, link => link.service === 'exhaustSteam' || link.service === 'mainSteam')
        ?? optionalParameterNumber(component, 'exhaustCondensationTemperatureC', 120)
      const nominalSteamFlow = parameterNumber(component, 'nominalSteamFlowKgPerS')
      const coolingWaterFlow = sumIncomingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'coolingWater')
      const coolingWaterInletTemperature = averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'coolingWater')
        ?? parameterNumber(component, 'coolingWaterTemperatureC')
      const coolingWaterDesignDeltaT = parameterNumber(component, 'coolingWaterDesignDeltaTK')
      const { coolingWaterHeatCapacity, condensingAvailability, condensateProduction, targetCondensateTemperature, heatRejected, coolingWaterOutletTemperature, targetBackPressure } = condenserThermalBalance({ steamFlow, steamTemperature, nominalSteamFlow, coolingWaterFlow, coolingWaterInletTemperature, coolingWaterDesignDeltaT, condensateApproach: parameterNumber(component, 'condensateApproachTemperatureK') })
      // The hotwell holds what the condenser condenses, less what the
      // condensate pumps and the reject line take out.
      const outgoingCondensateFlow = sumOutgoingLinkValue(system, component, 'flowKgPerS', context, link => link.service === 'condensate')
      const nominalInventory = parameterNumber(component, 'nominalCondensateInventoryKg')
      const currentInventory = context.readNumber(componentVariablePath(component, 'condensateInventoryKg'))
      const nextInventory = inventoryBalanceStep({
        currentInventory,
        inflowKgPerS: condensateProduction,
        outflowKgPerS: outgoingCondensateFlow,
        dtSeconds: context.dtSeconds,
        minInventory: 0,
        maxInventory: nominalInventory,
      })
      const maxOutletFlow = parameterNumber(component, 'maxCondensateOutletFlowKgPerS')
      const inventoryLimitedOutlet = context.dtSeconds > 0 ? nextInventory / context.dtSeconds : maxOutletFlow
      context.write(componentVariablePath(component, 'steamFlowKgPerS'), steamFlow)
      context.write(componentVariablePath(component, 'condensateProductionKgPerS'), condensateProduction)
      context.write(componentVariablePath(component, 'heatRejectedMw'), heatRejected)
      context.write(componentVariablePath(component, 'condensateInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'condensateLevelPercent'), clamp((nextInventory / nominalInventory) * 100, 0, 100))
      context.write(componentVariablePath(component, 'availableCondensateOutletFlowKgPerS'), Math.min(maxOutletFlow, inventoryLimitedOutlet))
      context.write(componentVariablePath(component, 'condensateTemperatureC'), relaxToward(context.readNumber(componentVariablePath(component, 'condensateTemperatureC')), targetCondensateTemperature, context.dtSeconds, optionalParameterNumber(component, 'condenserThermalTimeConstantS', 12)))
      context.write(componentVariablePath(component, 'backPressurePa'), approach(context.readNumber(componentVariablePath(component, 'backPressurePa')), targetBackPressure, 500 * context.dtSeconds))
      context.write(componentVariablePath(component, 'coolingWaterFlowKgPerS'), coolingWaterFlow)
      context.write(componentVariablePath(component, 'coolingWaterInletTemperatureC'), coolingWaterInletTemperature)
      context.write(componentVariablePath(component, 'coolingWaterOutletTemperatureC'), coolingWaterOutletTemperature)
      context.write(componentVariablePath(component, 'coolingWaterHeatCapacityMw'), coolingWaterHeatCapacity)
      context.write(componentVariablePath(component, 'coolingWaterAvailabilityFraction'), condensingAvailability)
    },
  },
]
