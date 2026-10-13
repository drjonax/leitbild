import { primaryLoopPumpForLink } from '../../graph/index.ts'
import type { CompiledComponent, CompiledProcessLink } from '../../graph/index.ts'
import { pumpDriveSteamPorts } from '../../graph/pump-component-definitions.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath } from '../behavior-contract.ts'
import type { LinkBehaviorReadContext } from './link-flow-helpers.ts'
import {
  distributeFlowFromComponent,
  downstreamServiceDemandFraction,
  passiveFlowFromIncomingService,
  sourceLimitedPumpFlow,
  sumIncomingLinkValue,
} from './link-flow-helpers.ts'
import { topologyAwareMainSteamDemandForSourceLink, topologyAwareMainSteamReleaseAvailabilityForSourceLink } from './main-steam-demand.ts'
import { processPlantServices, serviceUsesDownstreamDemand } from '../service-profiles.ts'
import { clamp, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import { steamGeneratorMinimumSteamMassKg } from '../behaviors/steam-generator-behaviors.ts'
import { primarySystemPressurizer, primarySystemReactorVessel } from '../system-topology.ts'

const atmosphericPressureMPa = 0.101325

// A steam line's atmospheric relief valve or its bank of safety valves, which vent straight out of the Plant.
const isReliefValve = (component: CompiledComponent | undefined): component is CompiledComponent => {
  const mode = component?.kind === 'steamValve' ? (component.parameters as Readonly<Record<string, unknown>>).valveMode : undefined
  return mode === 'relief' || mode === 'safety'
}


/** The pump whose drive turbine a steam valve supplies, or null for any other valve. */
const drivenPumpOf = (system: CompiledProcessPlant, valve: CompiledComponent | undefined): CompiledComponent | null => {
  if (valve?.kind !== 'steamValve') return null
  for (const index of system.graph.outgoingLinksByComponent[valve.index] ?? []) {
    const onward = system.graph.links[index]
    if (onward?.kind === 'fluidFlow' && String(onward.toPortName) === pumpDriveSteamPorts.inlet) return system.graph.components[onward.toComponentIndex] ?? null
  }
  return null
}

/** Steam a generator's line passes through a valve's flow coefficient at its opening and the generator's pressure, as an atmospheric relief valve or a drive turbine's steam supply valve passes it. */
const generatorSteamThroughValve = (fromComponent: CompiledComponent, valve: CompiledComponent, context: LinkBehaviorReadContext): number => {
  const pressure = context.readNumber(componentVariablePath(fromComponent, 'pressureMPa'))
  const opening = clamp(context.readNumber(componentVariablePath(valve, 'effectivePositionFraction')), 0, 1)
  const valveFlow = parameterNumber(valve, 'cvKgPerSPerSqrtMPa') * opening * Math.sqrt(Math.max(0, pressure - atmosphericPressureMPa))
  // While the generator's dome holds stored steam the valve can pass more than it boils; its stored steam spent, no more.
  const stored = context.readNumber(componentVariablePath(fromComponent, 'steamMassKg')) > steamGeneratorMinimumSteamMassKg(fromComponent)
  return stored ? valveFlow : Math.min(valveFlow, context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS')))
}

export interface ProcessLinkFlowSource {
  readonly flowKgPerS: number
  readonly alreadyIncludesPathAvailability: boolean
  readonly alreadyIncludesTargetValveDemand: boolean
  readonly bypassTargetPumpLimit: boolean
}

export const processLinkFlowSourceFor = (config: {
  readonly system: CompiledProcessPlant
  readonly link: CompiledProcessLink
  readonly context: LinkBehaviorReadContext
}): ProcessLinkFlowSource => {
  const { system, link, context } = config
  const fromComponent = system.graph.components[link.fromComponentIndex]
  if (!fromComponent) throw new Error(`process link ${link.id} references missing source component`)
  const toComponent = system.graph.components[link.toComponentIndex]
  const vessel = toComponent?.kind === 'pressurizer' && link.service === 'primaryCoolant' ? primarySystemReactorVessel(system) : null
  if (vessel !== null) {
    // The surge line carries the loops' surge either way; the vessel's
    // signed surge flow says which.
    return {
      flowKgPerS: Math.abs(context.readNumber(componentVariablePath(vessel, 'surgeFlowKgPerS'))),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: true,
    }
  }
  const primaryLoopPump = primaryLoopPumpForLink(system.graph, link)
  if (primaryLoopPump !== null) {
    // A loop's legs carry its flow either way; the pump says which.
    return {
      flowKgPerS: context.readNumber(componentVariablePath(primaryLoopPump, 'loopFlowKgPerS')) + context.readNumber(componentVariablePath(primaryLoopPump, 'loopReverseFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: true,
    }
  }
  if (fromComponent.kind === 'centrifugalPump' && String(link.fromPortName) === pumpDriveSteamPorts.exhaust) {
    // The drive turbine exhausts all the steam it takes.
    return {
      flowKgPerS: sumIncomingLinkValue(system, fromComponent.index, 'flowKgPerS', context, candidate => candidate.kind === 'fluidFlow' && String(candidate.toPortName) === pumpDriveSteamPorts.inlet),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'centrifugalPump') {
    return {
      flowKgPerS: sourceLimitedPumpFlow(system, link, context, context.readNumber(componentVariablePath(fromComponent, 'flowKgPerS'))),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'processTank') {
    const sourceFlow = distributeFlowFromComponent(
      system,
      link,
      context,
      context.readNumber(componentVariablePath(fromComponent, 'availableOutletFlowKgPerS')),
    )
    const demandFraction = serviceUsesDownstreamDemand(link.service)
      ? downstreamServiceDemandFraction(system, link, context)
      : 1
    return {
      flowKgPerS: sourceFlow * demandFraction,
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'condenserSink' && link.service === processPlantServices.condensate) {
    return {
      flowKgPerS: distributeFlowFromComponent(
        system,
        link,
        context,
        context.readNumber(componentVariablePath(fromComponent, 'availableCondensateOutletFlowKgPerS')),
      ) * downstreamServiceDemandFraction(system, link, context),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'condenserSink' && link.service === 'coolingWater') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'coolingWaterFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'pressurizer' && link.service === 'primaryRelief') {
    const reliefFlowByPort: Readonly<Record<string, string>> = { reliefOutlet: 'reliefFlowKgPerS', safetyOutlet: 'safetyValveFlowKgPerS' }
    const flowVariable = reliefFlowByPort[String(link.fromPortName)]
    if (flowVariable === undefined) throw new Error(`pressurizer relief link ${link.id} leaves port ${link.fromPortName}, which relieves nothing`)
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, flowVariable)),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'reactorVessel' && link.service === 'letdown') {
    // The letdown line's backpressure valve holds the pressure behind the
    // orifices, so they pass their rated flow while the coolant pressure is
    // well above it, and less as the coolant pressure falls toward it, with
    // the square root of the remaining difference. The letdown valve sets the rest.
    const pressurizer = primarySystemPressurizer(system)
    const backpressure = parameterNumber(fromComponent, 'letdownBackpressureMPa')
    const pressureFraction = pressurizer === null
      ? 1
      : (context.readNumber(componentVariablePath(pressurizer, 'pressureMPa')) - backpressure) / backpressure
    return {
      flowKgPerS: optionalParameterNumber(fromComponent, 'normalLetdownFlowKgPerS', 0) * Math.sqrt(Math.max(0, Math.min(1, pressureFraction))),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'reactorVessel' && link.service === 'primaryRelease') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'primaryLeakFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'steamGenerator' && link.service === processPlantServices.mainSteam && isReliefValve(toComponent)) {
    // A generator's atmospheric relief valve, or its line's bank of safety
    // valves, passes what its opening and the generator's pressure drive
    // through it. While the generator's dome holds
    // stored steam it can pass more than the generator boils, so the pressure
    // falls until the valve's controller closes it down to the boil-off; its
    // stored steam spent, it passes no more than the generator boils.
    return {
      flowKgPerS: generatorSteamThroughValve(fromComponent, toComponent, context),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: false,
    }
  }
  const drivenPump = fromComponent.kind === 'steamGenerator' && link.service === processPlantServices.mainSteam ? drivenPumpOf(system, toComponent) : null
  if (drivenPump !== null && toComponent !== undefined) {
    // A steam supply valve to a pump's drive turbine passes what its opening
    // and the generator's pressure drive through it, while the turbine's trip
    // and throttle valve admits steam: while the pump is commanded to run.
    return {
      flowKgPerS: context.readBoolean(componentVariablePath(drivenPump, 'running')) ? generatorSteamThroughValve(fromComponent, toComponent, context) : 0,
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: false,
    }
  }
  if (toComponent?.kind === 'centrifugalPump' && String(link.toPortName) === pumpDriveSteamPorts.inlet) {
    // The drive turbine takes what its supply valve passes, whatever water the pump moves.
    return {
      flowKgPerS: sumIncomingLinkValue(system, link.fromComponentIndex, 'flowKgPerS', context, candidate => candidate.kind === 'fluidFlow' && candidate.service === link.service),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: true,
    }
  }
  if (fromComponent.kind === 'steamGenerator' && link.service === processPlantServices.mainSteam) {
    const availableSteamFlow = context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS'))
    return {
      flowKgPerS: Math.min(
        topologyAwareMainSteamDemandForSourceLink(system, link, context)
        + availableSteamFlow * topologyAwareMainSteamReleaseAvailabilityForSourceLink(system, link, context),
        availableSteamFlow,
      ),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'turbineLoadSink') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'sumpOut') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'sumpOutflowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'containmentVolume' && String(link.fromPortName) === 'ventOut') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'releaseFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  if (fromComponent.kind === 'accumulator' && String(link.fromPortName) === 'outlet') {
    return {
      flowKgPerS: context.readNumber(componentVariablePath(fromComponent, 'outletFlowKgPerS')),
      alreadyIncludesPathAvailability: false,
      alreadyIncludesTargetValveDemand: false,
      bypassTargetPumpLimit: false,
    }
  }
  return {
    flowKgPerS: passiveFlowFromIncomingService(system, link, context),
    alreadyIncludesPathAvailability: false,
    alreadyIncludesTargetValveDemand: true,
    bypassTargetPumpLimit: false,
  }
}
