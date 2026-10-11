import { primaryLoopPumpForLink } from '../../graph/index.ts'
import type { CompiledComponent, CompiledProcessLink } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { componentVariablePath } from '../behavior-contract.ts'
import type { LinkBehaviorReadContext } from './link-flow-helpers.ts'
import {
  distributeFlowFromComponent,
  downstreamServiceDemandFraction,
  passiveFlowFromIncomingService,
  sourceLimitedPumpFlow,
} from './link-flow-helpers.ts'
import { topologyAwareMainSteamDemandForSourceLink, topologyAwareMainSteamReleaseAvailabilityForSourceLink } from './main-steam-demand.ts'
import { processPlantServices, serviceUsesDownstreamDemand } from '../service-profiles.ts'
import { clamp, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import { steamGeneratorMinimumSteamMassKg } from '../behaviors/steam-generator-behaviors.ts'
import { primarySystemPressurizer, primarySystemReactorVessel } from '../system-topology.ts'

const atmosphericPressureMPa = 0.101325

const isReliefValve = (component: CompiledComponent | undefined): component is CompiledComponent =>
  component?.kind === 'steamValve' && (component.parameters as Readonly<Record<string, unknown>>).valveMode === 'relief'

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
    // A generator's atmospheric relief valve passes what its opening and the
    // generator's pressure drive through it. While the generator's dome holds
    // stored steam it can pass more than the generator boils, so the pressure
    // falls until the valve's controller closes it down to the boil-off; its
    // stored steam spent, it passes no more than the generator boils.
    const pressure = context.readNumber(componentVariablePath(fromComponent, 'pressureMPa'))
    const opening = clamp(context.readNumber(componentVariablePath(toComponent, 'effectivePositionFraction')), 0, 1)
    const valveFlow = parameterNumber(toComponent, 'cvKgPerSPerSqrtMPa') * opening * Math.sqrt(Math.max(0, pressure - atmosphericPressureMPa))
    const stored = context.readNumber(componentVariablePath(fromComponent, 'steamMassKg')) > steamGeneratorMinimumSteamMassKg(fromComponent)
    return {
      flowKgPerS: stored ? valveFlow : Math.min(valveFlow, context.readNumber(componentVariablePath(fromComponent, 'steamFlowKgPerS'))),
      alreadyIncludesPathAvailability: true,
      alreadyIncludesTargetValveDemand: true,
      bypassTargetPumpLimit: false,
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
