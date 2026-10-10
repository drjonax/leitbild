import { primaryLoopPumps } from '../../graph/index.ts'
import type { ComponentBehaviorDefinition, ComponentInitialReconciliationDefinition } from '../behavior-contract.ts'
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
  sumOutgoingComponentLinkValue,
  sumProcessLinkValueByService as sumLinkValueByService,
} from '../component-link-helpers.ts'
import { flowWeightedIncomingLinkValue, sumIncomingLinkValue } from '../links/link-flow-helpers.ts'
import { reactorKineticsPowerStep } from '../physics.ts'
import { primarySystemPressurizer, primarySystemReactorCore, primarySystemReactorVessel } from '../system-topology.ts'
import { saturationTemperatureCFromPressureMPa } from '../thermophysics.ts'
import {
  compressedWaterState,
  liquidEnthalpyKjPerKg,
  liquidTemperatureCFromEnthalpy,
  saturatedWaterSteam,
  saturationPressureMPaFromTemperatureC,
} from '../water-properties.ts'
import { pressurizerSprayFlowKgPerS } from './pressurizer-behaviors.ts'
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

/** Reactor coolant pressure: the pressurizer's, or the core's nominal pressure in a Plant without one. */
const coolantPressureMPa = (
  system: ReactorBehaviorSystem,
  core: ReactorBehaviorSystem['graph']['components'][number],
  context: ReactorBehaviorContext,
): number => {
  const pressurizer = primarySystemPressurizer(system)
  return pressurizer === null
    ? parameterNumber(core, 'nominalCoolantPressureMPa')
    : context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
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

type ReactorBehaviorComponent = ReactorBehaviorSystem['graph']['components'][number]

/** What crosses the reactor coolant system's boundary: charging and injection
 * in, letdown, leaks and tube leakage out of the loops, relief out of the pressurizer. */
const pressurizerReliefFlow = (system: ReactorBehaviorSystem, context: ReactorBehaviorContext): number => {
  const pressurizer = primarySystemPressurizer(system)
  return pressurizer === null ? 0 : sumOutgoingComponentLinkValue(system, pressurizer, 'flowKgPerS', context, link => link.service === 'primaryRelief')
}

const primaryBoundaryFlows = (system: ReactorBehaviorSystem, vessel: ReactorBehaviorComponent, context: ReactorBehaviorContext) => {
  const primaryBoundaryLink = (link: { readonly toComponentIndex: number }): boolean => {
    const toComponent = system.graph.components[link.toComponentIndex]
    return toComponent?.kind === 'reactorCore' || toComponent?.kind === 'reactorVessel' || toComponent?.kind === 'pressurizer'
  }
  return {
    chargingInflow: boundaryInflowByService(system, context, 'charging', primaryBoundaryLink),
    injectionInflow: combineBoundaryInflows([
      boundaryInflowByService(system, context, 'primaryInjection', primaryBoundaryLink),
      boundaryInflowByService(system, context, 'safetyInjection', primaryBoundaryLink),
    ]),
    // Letdown is what leaves the vessel on its letdown line, and the same
    // flow reaches the volume control tank.
    letdownFlow: sumOutgoingComponentLinkValue(system, vessel, 'flowKgPerS', context, link => link.service === 'letdown'),
    // Relief leaves the coolant where it leaves the pressurizer; the relief header it joins downstream carries it again.
    reliefFlow: pressurizerReliefFlow(system, context),
    primaryLeakFlow: sumLinkValueByService(system, 'leakFlowKgPerS', context, 'primaryCoolant'),
    tubeLeakFlow: sumComponentValueByKind(system, 'steamGenerator', 'primaryToSecondaryLeakKgPerS', context),
  }
}

const writePrimaryBoundaryFlows = (
  vessel: ReactorBehaviorComponent,
  context: ReactorBehaviorContext,
  flows: ReturnType<typeof primaryBoundaryFlows>,
): void => {
  context.write(componentVariablePath(vessel, 'chargingFlowKgPerS'), flows.chargingInflow.flowKgPerS)
  context.write(componentVariablePath(vessel, 'safetyInjectionFlowKgPerS'), flows.injectionInflow.flowKgPerS)
  context.write(componentVariablePath(vessel, 'letdownFlowKgPerS'), flows.letdownFlow)
  context.write(componentVariablePath(vessel, 'reliefOutflowKgPerS'), flows.reliefFlow)
  context.write(componentVariablePath(vessel, 'primaryLeakFlowKgPerS'), flows.primaryLeakFlow)
  context.write(componentVariablePath(vessel, 'tubeLeakFlowKgPerS'), flows.tubeLeakFlow)
  context.write(
    componentVariablePath(vessel, 'netInventoryFlowKgPerS'),
    flows.chargingInflow.flowKgPerS + flows.injectionInflow.flowKgPerS - flows.letdownFlow - flows.reliefFlow - flows.primaryLeakFlow - flows.tubeLeakFlow,
  )
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
    reads: ['totalThermalPowerMw', 'reactor coolant pump demandMw'],
    writes: ['pumpHeatMw', 'heatToCoolantMw'],
    update: ({ system, component, context }): void => {
      // The reactor coolant pumps' shaft power, about 4.5 MW a pump, ends up
      // in the coolant as heat, on top of the core's own thermal power.
      let pumpHeat = 0
      for (const pump of primaryLoopPumps(system.graph)) pumpHeat += Math.max(0, context.readNumber(componentVariablePath(pump, 'demandMw')))
      const coreHeat = Math.max(0, context.readNumber(componentVariablePath(component, 'totalThermalPowerMw')))
      context.write(componentVariablePath(component, 'pumpHeatMw'), pumpHeat)
      context.write(componentVariablePath(component, 'heatToCoolantMw'), coreHeat + pumpHeat)
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

      // Core thermal power is the prompt share of fission power plus the decay
      // heat of earlier fissions. At equilibrium the decay heat is that same
      // share of fission power, so thermal and fission power agree at steady
      // power and part after a trip, when the decay heat lingers.
      const decayFraction = optionalParameterNumber(component, 'decayHeatFractionAtPower', 0.06)
      const decayTarget = Math.max(currentPower, nextPower) * decayFraction
      const decayHeat = context.readNumber(componentVariablePath(component, 'decayHeatMw'))
      const nextDecayHeat = relaxToward(decayHeat, decayTarget, context.dtSeconds, optionalParameterNumber(component, 'decayHeatTimeConstantS', 900))
      const totalThermalPower = nextPower * (1 - decayFraction) + nextDecayHeat
      context.write(componentVariablePath(component, 'decayHeatMw'), nextDecayHeat)
      context.write(componentVariablePath(component, 'totalThermalPowerMw'), totalThermalPower)

      const primaryFlow = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => link.service === 'primaryCoolant')
      const nominalPrimaryFlow = optionalParameterNumber(component, 'nominalPrimaryFlowKgPerS', Math.max(1, primaryFlow))
      const minimumCooling = optionalParameterNumber(component, 'minimumNaturalCirculationCoolingFraction', 0.08)
      context.write(componentVariablePath(component, 'averageHotLegFlowKgPerS'), primaryFlow)
      const coolingMargin = clamp(primaryFlow / Math.max(1, nominalPrimaryFlow), minimumCooling, 1.2)
      const creditedCooling = clamp(coolingMargin, 0, 1)
      const heatRemovalDeficit = Math.max(0, totalThermalPower * (1 - creditedCooling))
      const thermalFraction = clamp(totalThermalPower / ratedPower, 0, 1.25)
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
    reads: ['coolantInletTemperatureC', 'coolantOutletTemperatureC', 'coreExitTemperatureC', 'totalThermalPowerMw', 'pumpHeatMw', 'incoming:temperatureC', 'incoming:flowKgPerS', 'pressurizer.pressureMPa', 'pressurizer.steamMassKg', 'pressurizer.steamVolumeM3', 'reactorVessel.primaryCoolantInventoryKg', 'reactorVessel.loopSteamMassKg', 'reactorVessel.loopSteamVolumeM3'],
    writes: ['coolantInletTemperatureC', 'coolantOutletTemperatureC', 'coreExitTemperatureC', 'vapourGenerationKgPerS'],
    update: ({ system, component, context }): void => {
      const dt = context.dtSeconds
      const primaryInletLink = (link: { readonly service?: unknown }): boolean =>
        link.service === 'primaryCoolant'
        || link.service === 'charging'
        || link.service === 'primaryInjection'
        || link.service === 'safetyInjection'
      const mixedInletTemperature = flowWeightedIncomingLinkValue(system, component.index, 'temperatureC', context, primaryInletLink)
        ?? averageIncomingLinkValue(system, component, 'temperatureC', context, link => link.service === 'primaryCoolant')
        ?? context.readNumber(componentVariablePath(component, 'coolantInletTemperatureC'))
      const flow = Math.max(1, sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, link => link.service === 'primaryCoolant'))
      const pressure = coolantPressureMPa(system, component, context)
      const saturation = saturatedWaterSteam(pressure)
      const latentHeat = saturation.vapourEnthalpyKjPerKg - saturation.liquidEnthalpyKjPerKg
      // An energy balance on enthalpy at coolant pressure: the pumps heat the
      // cold legs, the core heats the flow through it. The core-exit
      // thermocouples read the fuelled channels, hotter than the mixed vessel
      // outlet by the bypass flow that carries no core heat. Water leaving
      // the core cannot be hotter than saturation: the surplus boils.
      const coreHeat = Math.max(0, context.readNumber(componentVariablePath(component, 'totalThermalPowerMw')))
      const pumpHeat = context.readNumber(componentVariablePath(component, 'pumpHeatMw'))
      const bypassFraction = optionalParameterNumber(component, 'coreBypassFlowFraction', 0)
      const inletEnthalpy = liquidEnthalpyKjPerKg(mixedInletTemperature, pressure) + pumpHeat * 1_000 / flow
      const outletEnthalpy = inletEnthalpy + coreHeat * 1_000 / flow
      const coreExitEnthalpy = outletEnthalpy + coreHeat * 1_000 * bypassFraction / ((1 - bypassFraction) * flow)
      const boiling = flow * Math.max(0, outletEnthalpy - saturation.liquidEnthalpyKjPerKg) / latentHeat
      const timeConstantSeconds = optionalParameterNumber(component, 'coolantThermalTimeConstantS', 8)
      const relaxed = (localPath: string, enthalpy: number): number => relaxToward(
        context.readNumber(componentVariablePath(component, localPath)),
        liquidTemperatureCFromEnthalpy(pressure, Math.min(enthalpy, saturation.liquidEnthalpyKjPerKg)),
        dt,
        timeConstantSeconds,
      )
      const inlet = relaxed('coolantInletTemperatureC', inletEnthalpy)
      let outlet = relaxed('coolantOutletTemperatureC', outletEnthalpy)
      let coreExit = relaxed('coreExitTemperatureC', coreExitEnthalpy)

      // The hot side of the loops (upper plenum, hot legs, steam generator
      // inlets: about half their water) flashes when the pressure falls
      // below its saturation pressure, cooling to it, and takes steam back
      // into the water when the pressure rises above it; each no further
      // than brings the system's steam to the hot water's saturation pressure.
      let vapourGeneration = boiling
      const vessel = primarySystemReactorVessel(system)
      const pressurizer = primarySystemPressurizer(system)
      const loopSteam = vessel === null ? 0 : context.readNumber(componentVariablePath(vessel, 'loopSteamMassKg'))
      if (vessel !== null && pressurizer !== null && (outlet > saturation.temperatureC || loopSteam > 0)) {
        const hotLiquid = 0.5 * Math.max(0, context.readNumber(componentVariablePath(vessel, 'primaryCoolantInventoryKg')) - loopSteam)
        const hotEnthalpy = liquidEnthalpyKjPerKg(outlet, pressure)
        const surplus = hotEnthalpy - saturation.liquidEnthalpyKjPerKg
        const steamRoom = context.readNumber(componentVariablePath(vessel, 'loopSteamVolumeM3')) + context.readNumber(componentVariablePath(pressurizer, 'steamVolumeM3'))
        const steamToHotSaturation = saturatedWaterSteam(saturationPressureMPaFromTemperatureC(outlet)).vapourDensityKgPerM3 * steamRoom
          - loopSteam - context.readNumber(componentVariablePath(pressurizer, 'steamMassKg'))
        const phaseChange = surplus > 0
          ? Math.min(hotLiquid * surplus / latentHeat * Math.min(1, dt / parameterNumber(vessel, 'flashingTimeConstantS')), Math.max(0, steamToHotSaturation))
          : -Math.min(loopSteam + boiling * dt, hotLiquid * -surplus / latentHeat * Math.min(1, dt / parameterNumber(vessel, 'condensationTimeConstantS')), Math.max(0, -steamToHotSaturation))
        if (hotLiquid > 0 && phaseChange !== 0) {
          outlet = liquidTemperatureCFromEnthalpy(pressure, hotEnthalpy - phaseChange * latentHeat / hotLiquid)
          vapourGeneration += phaseChange / dt
        }
        // The core exit flashes as the hot leg does.
        if (coreExit > saturation.temperatureC) coreExit = Math.max(outlet, saturation.temperatureC)
      }
      context.write(componentVariablePath(component, 'coolantInletTemperatureC'), inlet)
      context.write(componentVariablePath(component, 'coolantOutletTemperatureC'), outlet)
      context.write(componentVariablePath(component, 'coreExitTemperatureC'), coreExit)
      context.write(componentVariablePath(component, 'vapourGenerationKgPerS'), vapourGeneration)
    },
  },
  {
    id: 'reactor-vessel-primary-inventory-state',
    phase: 'updateComponentState',
    componentKind: 'reactorVessel',
    reads: ['primaryCoolantInventoryKg', 'loopSteamMassKg', 'surgeFlowKgPerS', 'boronConcentrationPpm', 'charging:flowKgPerS', 'charging:soluteConcentrationPpm', 'primaryInjection:flowKgPerS', 'primaryInjection:soluteConcentrationPpm', 'safetyInjection:flowKgPerS', 'safetyInjection:soluteConcentrationPpm', 'letdown:flowKgPerS', 'primaryRelief:flowKgPerS', 'primaryCoolant:leakFlowKgPerS', 'steamGenerator.primaryToSecondaryLeakKgPerS', 'pressurizer.pressureMPa', 'pressurizer.sprayFlowKgPerS', 'pressurizer.waterInventoryKg', 'pressurizer.steamMassKg', 'reactorCore.vapourGenerationKgPerS'],
    writes: [
      'primaryCoolantInventoryKg',
      'primaryCoolantInventoryDeviationKg',
      'loopSteamMassKg',
      'loopSteamVolumeM3',
      'loopVoidFraction',
      'surgeFlowKgPerS',
      'collapsedLiquidLevelPercent',
      'meanPrimaryCoolantTemperatureC',
      'subcoolingMarginC',
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
      const dt = context.dtSeconds
      const nominalInventory = parameterNumber(component, 'nominalPrimaryCoolantInventoryKg')
      const loopVolume = parameterNumber(component, 'primaryCoolantVolumeM3')
      const currentInventory = context.readNumber(componentVariablePath(component, 'primaryCoolantInventoryKg'))
      const currentSteam = context.readNumber(componentVariablePath(component, 'loopSteamMassKg'))
      const boundary = primaryBoundaryFlows(system, component, context)
      const { chargingInflow, injectionInflow, letdownFlow, reliefFlow, primaryLeakFlow, tubeLeakFlow } = boundary
      const chargingFlow = chargingInflow.flowKgPerS
      const primaryInjectionFlow = injectionInflow.flowKgPerS
      const totalInflow = chargingFlow + primaryInjectionFlow
      // Relief leaves from the pressurizer; everything else from the loops.
      const loopOutflow = letdownFlow + primaryLeakFlow + tubeLeakFlow

      const core = primarySystemReactorCore(system)
      const pressurizer = primarySystemPressurizer(system)
      if (pressurizer === null) throw new Error(`reactor vessel ${component.id} needs a pressurizer to set its pressure`)
      const pressureMPa = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
      const sprayFlow = pressurizerSprayFlowKgPerS(pressurizer, context)
      const saturation = saturatedWaterSteam(pressureMPa)
      const meanPrimaryCoolantTemperature = core === null
        ? parameterNumber(component, 'referencePrimaryCoolantTemperatureC')
        : (
          context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC'))
          + context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC'))
        ) / 2
      const liquidDensity = compressedWaterState(meanPrimaryCoolantTemperature, pressureMPa).densityKgPerM3

      // Steam the core and hot legs raise (or the loops' water condenses)
      // stays in the loops, up in the vessel head and the steam generator
      // tubes; liquid fills the rest of their fixed volume. The liquid the
      // loops cannot hold surges into the pressurizer, and the pressurizer
      // returns water when the loops shrink, as far as it holds any. The
      // surge line's water takes about a second to follow.
      const vapourGeneration = core === null ? 0 : context.readNumber(componentVariablePath(core, 'vapourGenerationKgPerS'))
      let steam = Math.max(0, currentSteam + vapourGeneration * dt)
      let liquid = currentInventory - currentSteam + (totalInflow - loopOutflow - sprayFlow) * dt - (steam - currentSteam)
      const steamVolume = Math.min(loopVolume, steam / saturation.vapourDensityKgPerM3)
      const liquidCapacity = liquidDensity * (loopVolume - steamVolume)
      const pressurizerWater = context.readNumber(componentVariablePath(pressurizer, 'waterInventoryKg'))
      const surgeFlow = Math.max(-pressurizerWater / dt, relaxToward(
        context.readNumber(componentVariablePath(component, 'surgeFlowKgPerS')),
        (liquid - liquidCapacity) / dt,
        dt,
        parameterNumber(component, 'surgeLineTimeConstantS'),
      ))
      liquid -= surgeFlow * dt
      // Loops drained of water discharge their steam instead.
      if (liquid < 0) {
        steam = Math.max(0, steam + liquid)
        liquid = 0
      }
      // The room the loops' liquid leaves holds their steam, compressed when
      // the surge lags the liquid's growth and thin until it flashes when the
      // surge lags its shrinking.
      const loopSteamVolume = loopVolume - liquid / liquidDensity
      const nextInventory = liquid + steam

      // Boron mixes through the loops and the pressurizer alike.
      const currentBoron = context.readNumber(componentVariablePath(component, 'boronConcentrationPpm'))
      const chargingBoron = chargingInflow.soluteConcentrationPpm ?? currentBoron
      const injectionBoron = injectionInflow.soluteConcentrationPpm
        ?? averageIncomingLinkValue(system, component, 'soluteConcentrationPpm', context, link => link.service === 'primaryInjection' || link.service === 'safetyInjection')
        ?? currentBoron
      const systemMass = nextInventory
        + context.readNumber(componentVariablePath(pressurizer, 'waterInventoryKg'))
        + context.readNumber(componentVariablePath(pressurizer, 'steamMassKg'))
        + (surgeFlow - reliefFlow + sprayFlow) * dt
      const nextBoron = systemMass <= 0
        ? 0
        : clamp(currentBoron + (chargingFlow * (chargingBoron - currentBoron) + primaryInjectionFlow * (injectionBoron - currentBoron)) * dt / systemMass, 0, 20_000)

      const primaryReleaseRadiation = primaryLeakFlow <= 0
        ? 0.02
        : optionalParameterNumber(component, 'primaryReleaseRadiationMSvPerH', 4)
      // A subcooling monitor takes the hottest reading: the core exit, or the
      // hot leg should it ever read hotter.
      const hottestCoolantTemperature = core === null
        ? meanPrimaryCoolantTemperature
        : Math.max(
          context.readNumber(componentVariablePath(core, 'coreExitTemperatureC')),
          context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC')),
        )
      const subcoolingMargin = saturationTemperatureCFromPressureMPa(pressureMPa) - hottestCoolantTemperature
      writePrimaryBoundaryFlows(component, context, boundary)
      context.write(componentVariablePath(component, 'primaryInventoryBalanceResidualKg'), nextInventory - currentInventory - (totalInflow - loopOutflow - sprayFlow - surgeFlow) * dt)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryKg'), nextInventory)
      context.write(componentVariablePath(component, 'loopSteamMassKg'), steam)
      context.write(componentVariablePath(component, 'loopSteamVolumeM3'), loopSteamVolume)
      context.write(componentVariablePath(component, 'loopVoidFraction'), clamp(loopSteamVolume / loopVolume, 0, 1))
      context.write(componentVariablePath(component, 'surgeFlowKgPerS'), surgeFlow)
      context.write(componentVariablePath(component, 'boronConcentrationPpm'), nextBoron)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryDeviationKg'), nextInventory - nominalInventory)
      context.write(componentVariablePath(component, 'collapsedLiquidLevelPercent'), clamp((1 - loopSteamVolume / loopVolume) * 100, 0, 100))
      context.write(componentVariablePath(component, 'meanPrimaryCoolantTemperatureC'), meanPrimaryCoolantTemperature)
      context.write(componentVariablePath(component, 'subcoolingMarginC'), subcoolingMargin)
      context.write(componentVariablePath(component, 'primaryReleaseRadiationMSvPerH'), primaryReleaseRadiation)
    },
  },
]

export const reactorInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'reactor-vessel-filled-initial-state',
    componentKind: 'reactorVessel',
    reads: ['pressurizer.pressureMPa', 'reactorCore.coolantInletTemperatureC', 'reactorCore.coolantOutletTemperatureC'],
    writes: ['primaryCoolantInventoryKg', 'primaryCoolantInventoryDeviationKg', 'loopSteamMassKg', 'loopSteamVolumeM3', 'loopVoidFraction', 'collapsedLiquidLevelPercent', 'meanPrimaryCoolantTemperatureC', 'subcoolingMarginC'],
    // The loops start full of water at their initial temperatures and
    // pressure, short only by the initial inventory fraction, which is steam.
    reconcile: ({ system, component, context }): void => {
      const core = primarySystemReactorCore(system)
      const pressurizer = primarySystemPressurizer(system)
      if (pressurizer === null) throw new Error(`reactor vessel ${component.id} needs a pressurizer to set its pressure`)
      const pressureMPa = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
      const meanTemperature = core === null
        ? parameterNumber(component, 'referencePrimaryCoolantTemperatureC')
        : (context.readNumber(componentVariablePath(core, 'coolantInletTemperatureC')) + context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC'))) / 2
      const loopVolume = parameterNumber(component, 'primaryCoolantVolumeM3')
      const filledFraction = parameterNumber(component, 'initialPrimaryCoolantInventoryFraction')
      const steamVolume = loopVolume * (1 - filledFraction)
      const steam = saturatedWaterSteam(pressureMPa).vapourDensityKgPerM3 * steamVolume
      const inventory = compressedWaterState(meanTemperature, pressureMPa).densityKgPerM3 * (loopVolume - steamVolume) + steam
      context.write(componentVariablePath(component, 'primaryCoolantInventoryKg'), inventory)
      context.write(componentVariablePath(component, 'primaryCoolantInventoryDeviationKg'), inventory - parameterNumber(component, 'nominalPrimaryCoolantInventoryKg'))
      context.write(componentVariablePath(component, 'loopSteamMassKg'), steam)
      context.write(componentVariablePath(component, 'loopSteamVolumeM3'), steamVolume)
      context.write(componentVariablePath(component, 'loopVoidFraction'), steamVolume / loopVolume)
      context.write(componentVariablePath(component, 'collapsedLiquidLevelPercent'), filledFraction * 100)
      context.write(componentVariablePath(component, 'meanPrimaryCoolantTemperatureC'), meanTemperature)
      context.write(componentVariablePath(component, 'subcoolingMarginC'), core === null
        ? saturationTemperatureCFromPressureMPa(pressureMPa) - meanTemperature
        : saturationTemperatureCFromPressureMPa(pressureMPa) - Math.max(
          context.readNumber(componentVariablePath(core, 'coreExitTemperatureC')),
          context.readNumber(componentVariablePath(core, 'coolantOutletTemperatureC')),
        ))
    },
  },
  {
    id: 'reactor-vessel-initial-boundary-flows',
    componentKind: 'reactorVessel',
    afterLinks: true,
    reads: ['charging:flowKgPerS', 'primaryInjection:flowKgPerS', 'safetyInjection:flowKgPerS', 'letdown:flowKgPerS', 'primaryRelief:flowKgPerS', 'primaryCoolant:leakFlowKgPerS', 'steamGenerator.primaryToSecondaryLeakKgPerS'],
    writes: ['chargingFlowKgPerS', 'safetyInjectionFlowKgPerS', 'letdownFlowKgPerS', 'reliefOutflowKgPerS', 'primaryLeakFlowKgPerS', 'tubeLeakFlowKgPerS', 'netInventoryFlowKgPerS'],
    reconcile: ({ system, component, context }): void => {
      writePrimaryBoundaryFlows(component, context, primaryBoundaryFlows(system, component, context))
    },
  },
]
