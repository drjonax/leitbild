import type { CompiledComponent } from '../../graph/index.ts'
import {
  componentVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
  type ProcessPlantBehaviorContext,
} from '../behavior-contract.ts'
import { clamp, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'

/** The power a component puts out, as its own solved state reads: a breaker only while its contacts are closed. */
export const sourcePowerForComponent = (
  source: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): { readonly energized: boolean; readonly availablePowerMw: number; readonly voltageFraction: number } => {
  if (source.kind === 'turbineLoadSink') {
    const electricPath = componentVariablePath(source, 'electricMw')
    const electricMw = context.has(electricPath) ? context.readNumber(electricPath) : 0
    return {
      energized: electricMw > 0,
      availablePowerMw: Math.max(0, electricMw),
      voltageFraction: electricMw > 0 ? 1 : 0,
    }
  }

  const energizedPath = componentVariablePath(source, 'energized')
  const availablePath = componentVariablePath(source, 'availablePowerMw')
  const voltagePath = componentVariablePath(source, 'voltageFraction')
  return {
    energized: context.has(energizedPath) ? context.readBoolean(energizedPath) : false,
    availablePowerMw: context.has(availablePath) ? context.readNumber(availablePath) : 0,
    voltageFraction: context.has(voltagePath) ? context.readNumber(voltagePath) : 0,
  }
}

/** The power reaching a component on its supply lines, or on those into the one port named. */
export const incomingElectricalPower = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
  port?: string,
): { readonly energized: boolean; readonly availablePowerMw: number; readonly voltageFraction: number } => {
  let availablePowerMw = 0
  let voltageFraction = 0
  for (const linkIndex of system.graph.incomingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'electricalPower') continue
    if (port !== undefined && String(link.toPortName) !== port) continue
    const source = system.graph.components[link.fromComponentIndex]
    if (!source) continue
    const sourcePower = sourcePowerForComponent(source, context)
    if (!sourcePower.energized) continue
    availablePowerMw += sourcePower.availablePowerMw
    voltageFraction = Math.max(voltageFraction, sourcePower.voltageFraction)
  }
  return {
    energized: availablePowerMw > 0 && voltageFraction > 0,
    availablePowerMw,
    voltageFraction,
  }
}

const hasIncomingElectricalPowerPort = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  port?: string,
): boolean =>
  (system.graph.incomingLinksByComponent[component.index] ?? [])
    .some(linkIndex => {
      const link = system.graph.links[linkIndex]
      return link?.kind === 'electricalPower' && (port === undefined || String(link.toPortName) === port)
    })

/**
 * Whether a component has usable power on its supply, or on the one supply
 * port named where it has several (a pressurizer's heaters and its PORV block
 * valve's motor are fed apart). A supply the Plant draws no line to is not
 * modelled, and counts as live.
 */
export const componentHasElectricalPower = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
  port?: string,
): boolean => {
  if (!hasIncomingElectricalPowerPort(system, component, port)) return true
  const incoming = incomingElectricalPower(system, component, context, port)
  return incoming.energized && incoming.voltageFraction >= 0.7
}

const outgoingLoadDemand = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
): number => {
  let demand = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'electricalPower') continue
    const target = system.graph.components[link.toComponentIndex]
    if (!target) continue
    if (target.kind === 'electricalLoad') {
      demand += parameterNumber(target, 'nominalLoadMw')
      continue
    }
    // A closed breaker passes on what is drawn beyond it, so a bus carries the loads it feeds through their own
    // breakers (a pressurizer's backup heaters); an open one carries none.
    if (target.kind === 'electricalBreaker') {
      if (context.readBoolean(componentVariablePath(target, 'closedState'))) demand += outgoingLoadDemand(system, target, context)
      continue
    }
    // What the target draws through the port this line feeds: a pressurizer's heater load is its heater bus's, not the
    // bus that feeds its block valve's motor.
    const drawn = target.ports[String(link.toPortName)]?.demand
    if (drawn !== undefined) demand += context.readNumber(componentVariablePath(target, drawn))
  }
  return demand
}

const passThroughAvailablePower = (
  system: CompiledProcessPlant,
  component: CompiledComponent,
  context: ProcessPlantBehaviorContext,
  capacityMw: number,
  efficiencyFraction = 1,
): { readonly energized: boolean; readonly availablePowerMw: number; readonly voltageFraction: number } => {
  const incoming = incomingElectricalPower(system, component, context)
  const availablePowerMw = incoming.energized ? Math.min(capacityMw, incoming.availablePowerMw * efficiencyFraction) : 0
  return {
    energized: availablePowerMw > 0 && incoming.voltageFraction > 0,
    availablePowerMw,
    voltageFraction: availablePowerMw > 0 ? incoming.voltageFraction : 0,
  }
}

const gridSourceBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-grid-source',
  phase: 'solveElectrical',
  componentKind: 'electricalGridSource',
  reads: ['available', 'voltageFraction', 'frequencyHz'],
  writes: ['energized', 'availablePowerMw', 'voltageFraction'],
  update: ({ component, context }): void => {
    const available = context.readBoolean(componentVariablePath(component, 'available'))
    const voltageFraction = clamp(context.readNumber(componentVariablePath(component, 'voltageFraction')), 0, 1.2)
    context.write(componentVariablePath(component, 'energized'), available && voltageFraction > 0)
    context.write(componentVariablePath(component, 'availablePowerMw'), available && voltageFraction > 0 ? parameterNumber(component, 'nominalPowerMw') : 0)
    context.write(componentVariablePath(component, 'voltageFraction'), available ? voltageFraction : 0)
  },
}

const busBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-bus-propagation',
  phase: 'solveElectrical',
  componentKind: 'electricalBus',
  reads: ['incoming electrical availablePowerMw', 'outgoing electrical demandMw'],
  writes: ['energized', 'availablePowerMw', 'voltageFraction', 'servedLoadMw', 'marginMw', 'degraded'],
  update: ({ system, component, context }): void => {
    const incoming = incomingElectricalPower(system, component, context)
    const capacity = parameterNumber(component, 'nominalPowerMw')
    const availablePower = incoming.energized ? Math.min(capacity, incoming.availablePowerMw) : 0
    const servedLoad = Math.min(availablePower, outgoingLoadDemand(system, component, context))
    const degradedThreshold = optionalParameterNumber(component, 'degradedVoltageFraction', 0.9)
    context.write(componentVariablePath(component, 'energized'), availablePower > 0 && incoming.voltageFraction >= 0.7)
    context.write(componentVariablePath(component, 'availablePowerMw'), availablePower)
    context.write(componentVariablePath(component, 'voltageFraction'), availablePower > 0 ? incoming.voltageFraction : 0)
    context.write(componentVariablePath(component, 'servedLoadMw'), servedLoad)
    context.write(componentVariablePath(component, 'marginMw'), availablePower - servedLoad)
    context.write(componentVariablePath(component, 'degraded'), availablePower > 0 && incoming.voltageFraction > 0 && incoming.voltageFraction < degradedThreshold)
  },
}

const breakerBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-breaker-propagation',
  phase: 'solveElectrical',
  componentKind: 'electricalBreaker',
  reads: ['closed', 'tripped', 'incoming electrical availablePowerMw'],
  writes: ['closedState', 'energized', 'availablePowerMw', 'voltageFraction', 'tripped'],
  update: ({ system, component, context }): void => {
    const incoming = incomingElectricalPower(system, component, context)
    const closed = context.readBoolean(componentVariablePath(component, 'closed'))
    const previousTripped = context.readBoolean(componentVariablePath(component, 'tripped'))
    const degradedTripFraction = optionalParameterNumber(component, 'degradedVoltageTripFraction', 0)
    const degradedTrip = incoming.energized && degradedTripFraction > 0 && incoming.voltageFraction > 0 && incoming.voltageFraction < degradedTripFraction
    const tripped = previousTripped || degradedTrip
    // A trip opens the contacts whatever the close command says.
    const closedState = closed && !tripped
    const conductive = incoming.energized && closedState
    context.write(componentVariablePath(component, 'tripped'), tripped)
    context.write(componentVariablePath(component, 'closedState'), closedState)
    context.write(componentVariablePath(component, 'energized'), conductive)
    context.write(componentVariablePath(component, 'availablePowerMw'), conductive ? Math.min(parameterNumber(component, 'nominalPowerMw'), incoming.availablePowerMw) : 0)
    context.write(componentVariablePath(component, 'voltageFraction'), conductive ? incoming.voltageFraction : 0)
  },
}

const transformerBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-transformer-propagation',
  phase: 'solveElectrical',
  componentKind: 'electricalTransformer',
  reads: ['incoming electrical availablePowerMw', 'outgoing electrical demandMw'],
  writes: ['energized', 'availablePowerMw', 'voltageFraction', 'loadMw'],
  update: ({ system, component, context }): void => {
    const result = passThroughAvailablePower(system, component, context, parameterNumber(component, 'nominalPowerMw'), optionalParameterNumber(component, 'efficiencyFraction', 0.99))
    context.write(componentVariablePath(component, 'energized'), result.energized)
    context.write(componentVariablePath(component, 'availablePowerMw'), result.availablePowerMw)
    context.write(componentVariablePath(component, 'voltageFraction'), result.voltageFraction)
    context.write(componentVariablePath(component, 'loadMw'), Math.min(result.availablePowerMw, outgoingLoadDemand(system, component, context)))
  },
}

const dieselGeneratorBehavior: ComponentBehaviorDefinition = {
  id: 'diesel-generator-start-and-power',
  phase: 'solveElectrical',
  componentKind: 'dieselGenerator',
  reads: ['startCommand', 'available', 'running', 'startElapsedS'],
  writes: ['running', 'startElapsedS', 'energized', 'availablePowerMw', 'voltageFraction'],
  update: ({ component, context }): void => {
    const startCommand = context.readBoolean(componentVariablePath(component, 'startCommand'))
    const available = context.readBoolean(componentVariablePath(component, 'available'))
    const startDelay = optionalParameterNumber(component, 'startDelayS', 10)
    const elapsed = startCommand && available
      ? Math.min(startDelay, context.readNumber(componentVariablePath(component, 'startElapsedS')) + context.dtSeconds)
      : 0
    const running = available && startCommand && elapsed >= startDelay
    context.write(componentVariablePath(component, 'startElapsedS'), elapsed)
    context.write(componentVariablePath(component, 'running'), running)
    context.write(componentVariablePath(component, 'energized'), running)
    context.write(componentVariablePath(component, 'availablePowerMw'), running ? parameterNumber(component, 'nominalPowerMw') : 0)
    context.write(componentVariablePath(component, 'voltageFraction'), running ? 1 : 0)
  },
}

const batteryBehavior: ComponentBehaviorDefinition = {
  id: 'battery-discharge',
  phase: 'solveElectrical',
  componentKind: 'battery',
  reads: ['stateOfChargeFraction'],
  writes: ['stateOfChargeFraction', 'energized', 'availablePowerMw', 'voltageFraction', 'voltageVdc'],
  update: ({ system, component, context }): void => {
    const demand = outgoingLoadDemand(system, component, context)
    const dischargeTime = parameterNumber(component, 'dischargeTimeS')
    const nominalPower = parameterNumber(component, 'nominalPowerMw')
    const currentCharge = clamp(context.readNumber(componentVariablePath(component, 'stateOfChargeFraction')), 0, 1)
    const usedFraction = demand > 0 && nominalPower > 0
      ? (Math.min(demand, nominalPower) / nominalPower) * (context.dtSeconds / dischargeTime)
      : 0
    const nextCharge = clamp(currentCharge - usedFraction, 0, 1)
    context.write(componentVariablePath(component, 'stateOfChargeFraction'), nextCharge)
    context.write(componentVariablePath(component, 'energized'), nextCharge > 0)
    context.write(componentVariablePath(component, 'availablePowerMw'), nextCharge > 0 ? nominalPower : 0)
    context.write(componentVariablePath(component, 'voltageFraction'), nextCharge > 0 ? 1 : 0)
    context.write(componentVariablePath(component, 'voltageVdc'), nextCharge > 0 ? optionalParameterNumber(component, 'nominalVoltageVdc', 125) : 0)
  },
}

const inverterBehavior: ComponentBehaviorDefinition = {
  id: 'inverter-propagation',
  phase: 'solveElectrical',
  componentKind: 'inverter',
  reads: ['incoming electrical availablePowerMw'],
  writes: ['energized', 'availablePowerMw', 'voltageFraction'],
  update: ({ system, component, context }): void => {
    const result = passThroughAvailablePower(system, component, context, parameterNumber(component, 'nominalPowerMw'), optionalParameterNumber(component, 'efficiencyFraction', 0.95))
    context.write(componentVariablePath(component, 'energized'), result.energized)
    context.write(componentVariablePath(component, 'availablePowerMw'), result.availablePowerMw)
    context.write(componentVariablePath(component, 'voltageFraction'), result.voltageFraction)
  },
}

const loadBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-load-service',
  phase: 'solveElectrical',
  componentKind: 'electricalLoad',
  reads: ['incoming electrical availablePowerMw'],
  writes: ['demandMw', 'servedMw', 'servedFraction', 'energized'],
  update: ({ system, component, context }): void => {
    const demand = parameterNumber(component, 'nominalLoadMw')
    const incoming = incomingElectricalPower(system, component, context)
    const usable = incoming.energized && incoming.voltageFraction >= 0.7
    const served = usable ? Math.min(demand, incoming.availablePowerMw) : 0
    context.write(componentVariablePath(component, 'demandMw'), demand)
    context.write(componentVariablePath(component, 'servedMw'), served)
    context.write(componentVariablePath(component, 'servedFraction'), demand <= 0 ? 1 : clamp(served / demand, 0, 1))
    context.write(componentVariablePath(component, 'energized'), served > 0 || demand <= 0)
  },
}

export const electricalBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  gridSourceBehavior,
  dieselGeneratorBehavior,
  batteryBehavior,
  breakerBehavior,
  transformerBehavior,
  inverterBehavior,
  busBehavior,
  loadBehavior,
]

export const electricalInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = electricalBehaviorDefinitions.map(behavior => ({
  id: `${behavior.id}-initial-state`, componentKind: behavior.componentKind,
  reads: behavior.reads, writes: behavior.writes, reconcile: behavior.update,
}))
