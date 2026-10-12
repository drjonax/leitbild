import type { CompiledComponent } from '../../graph/index.ts'
import { dieselLoadResponse } from '../../graph/electrical-component-definitions.ts'
import {
  componentVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
  type ProcessPlantBehaviorContext,
} from '../behavior-contract.ts'
import { clamp, optionalParameterNumber, parameterNumber } from '../component-helpers.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'

/** What reading a supply's state takes: link behaviors read it as component behaviors do. */
export type ElectricalReadContext = Pick<ProcessPlantBehaviorContext, 'has' | 'readNumber' | 'readBoolean'>

/** The power a component puts out, as its own solved state reads: a breaker only while its contacts are closed. */
export const sourcePowerForComponent = (
  source: CompiledComponent,
  context: ElectricalReadContext,
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
  context: ElectricalReadContext,
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
  context: ElectricalReadContext,
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
      if (context.readBoolean(componentVariablePath(target, 'connected'))) demand += parameterNumber(target, 'nominalLoadMw')
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

// The grid source's voltage and frequency are its boundary's, never its own to
// write: an unavailable source keeps the voltage the boundary holds, energizing
// nothing, so it stands at that voltage again the moment it is available. The
// Plant's side of the supply, which its undervoltage relays read, has the
// grid's voltage only while the grid is available.
const gridSourceBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-grid-source',
  phase: 'solveElectrical',
  componentKind: 'electricalGridSource',
  reads: ['available', 'voltageFraction', 'frequencyHz'],
  writes: ['energized', 'availablePowerMw', 'supplyVoltageFraction'],
  update: ({ component, context }): void => {
    const available = context.readBoolean(componentVariablePath(component, 'available'))
    const voltageFraction = context.readNumber(componentVariablePath(component, 'voltageFraction'))
    context.write(componentVariablePath(component, 'energized'), available && voltageFraction > 0)
    context.write(componentVariablePath(component, 'availablePowerMw'), available && voltageFraction > 0 ? parameterNumber(component, 'nominalPowerMw') : 0)
    context.write(componentVariablePath(component, 'supplyVoltageFraction'), available ? voltageFraction : 0)
  },
}

const busBehavior: ComponentBehaviorDefinition = {
  id: 'electrical-bus-propagation',
  phase: 'solveElectrical',
  componentKind: 'electricalBus',
  reads: ['incoming electrical availablePowerMw', 'outgoing electrical demandMw'],
  writes: ['energized', 'availablePowerMw', 'voltageFraction', 'voltageKv', 'servedLoadMw', 'marginMw', 'degraded'],
  update: ({ system, component, context }): void => {
    const incoming = incomingElectricalPower(system, component, context)
    const capacity = parameterNumber(component, 'nominalPowerMw')
    const availablePower = incoming.energized ? Math.min(capacity, incoming.availablePowerMw) : 0
    const servedLoad = Math.min(availablePower, outgoingLoadDemand(system, component, context))
    const degradedThreshold = optionalParameterNumber(component, 'degradedVoltageFraction', 0.9)
    context.write(componentVariablePath(component, 'energized'), availablePower > 0 && incoming.voltageFraction >= 0.7)
    context.write(componentVariablePath(component, 'availablePowerMw'), availablePower)
    context.write(componentVariablePath(component, 'voltageFraction'), availablePower > 0 ? incoming.voltageFraction : 0)
    context.write(componentVariablePath(component, 'voltageKv'), availablePower > 0 ? incoming.voltageFraction * parameterNumber(component, 'nominalVoltageKv') : 0)
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

// While a diesel starts, its frequency and voltage build with its speed, which
// reaches rated in its start time; running, they stand at rated less what a
// block of load has dipped them by and its governor and regulator have not
// yet restored. It puts power out only once running.
const dieselGeneratorBehavior: ComponentBehaviorDefinition = {
  id: 'diesel-generator-start-and-power',
  phase: 'solveElectrical',
  componentKind: 'dieselGenerator',
  reads: ['startCommand', 'available', 'running', 'startElapsedS', 'frequencyDeviationPercent', 'voltageDeviationPercent'],
  writes: ['running', 'startElapsedS', 'energized', 'availablePowerMw', 'voltageFraction', 'terminalVoltageKv', 'frequencyHz'],
  update: ({ component, context }): void => {
    const startCommand = context.readBoolean(componentVariablePath(component, 'startCommand'))
    const available = context.readBoolean(componentVariablePath(component, 'available'))
    const startDelay = optionalParameterNumber(component, 'startDelayS', 10)
    const elapsed = startCommand && available
      ? Math.min(startDelay, context.readNumber(componentVariablePath(component, 'startElapsedS')) + context.dtSeconds)
      : 0
    const running = available && startCommand && elapsed >= startDelay
    const speedFraction = running ? 1 : startCommand && available ? elapsed / startDelay : 0
    const frequencyFraction = running ? 1 + context.readNumber(componentVariablePath(component, 'frequencyDeviationPercent')) / 100 : speedFraction
    const voltageFraction = running ? 1 + context.readNumber(componentVariablePath(component, 'voltageDeviationPercent')) / 100 : speedFraction
    context.write(componentVariablePath(component, 'startElapsedS'), elapsed)
    context.write(componentVariablePath(component, 'running'), running)
    context.write(componentVariablePath(component, 'energized'), running)
    context.write(componentVariablePath(component, 'availablePowerMw'), running ? parameterNumber(component, 'nominalPowerMw') : 0)
    context.write(componentVariablePath(component, 'voltageFraction'), voltageFraction)
    context.write(componentVariablePath(component, 'terminalVoltageKv'), voltageFraction * parameterNumber(component, 'nominalVoltageKv'))
    context.write(componentVariablePath(component, 'frequencyHz'), frequencyFraction * parameterNumber(component, 'nominalFrequencyHz'))
  },
}

/**
 * The load a supply carries: what each bus its closed breakers feed serves,
 * shared among the live supplies feeding that bus, so a diesel run in
 * parallel with offsite power for a test splits the bus with the grid.
 */
const carriedLoadMw = (system: CompiledProcessPlant, component: CompiledComponent, context: ProcessPlantBehaviorContext): number => {
  let load = 0
  for (const linkIndex of system.graph.outgoingLinksByComponent[component.index] ?? []) {
    const link = system.graph.links[linkIndex]
    if (!link || link.kind !== 'electricalPower') continue
    const target = system.graph.components[link.toComponentIndex]
    if (!target) continue
    if (target.kind === 'electricalBreaker') {
      if (context.readBoolean(componentVariablePath(target, 'closedState'))) load += carriedLoadMw(system, target, context)
      continue
    }
    if (target.kind !== 'electricalBus') continue
    const liveSupplies = (system.graph.incomingLinksByComponent[target.index] ?? []).filter(index => {
      const supply = system.graph.links[index]
      const source = supply === undefined ? undefined : system.graph.components[supply.fromComponentIndex]
      return supply?.kind === 'electricalPower' && source !== undefined && sourcePowerForComponent(source, context).energized
    }).length
    load += context.readNumber(componentVariablePath(target, 'servedLoadMw')) / Math.max(1, liveSupplies)
  }
  return load
}

// A block of load picked up at once dips the diesel's frequency and voltage
// in proportion to the block's share of its rating; its governor and voltage
// regulator then restore both. Solved once the buses have been, so it reads
// the load the tick's breakers put on it; the dip shows from the next tick.
const dieselLoadResponseBehavior: ComponentBehaviorDefinition = {
  id: 'diesel-generator-load-response',
  phase: 'updateComponentState',
  componentKind: 'dieselGenerator',
  reads: ['running', 'outputKw', 'frequencyDeviationPercent', 'voltageDeviationPercent', 'fed breakers closedState', 'fed buses servedLoadMw'],
  writes: ['outputKw', 'frequencyDeviationPercent', 'voltageDeviationPercent'],
  update: ({ system, component, context }): void => {
    const running = context.readBoolean(componentVariablePath(component, 'running'))
    const loadMw = running ? carriedLoadMw(system, component, context) : 0
    const response = dieselLoadResponse(component)
    const blockFraction = (loadMw - context.readNumber(componentVariablePath(component, 'outputKw')) / 1_000) / parameterNumber(component, 'nominalPowerMw')
    const restored = Math.exp(-context.dtSeconds / response.recoveryTimeConstantS)
    const deviation = (path: string, dipPerRatedLoad: number): number => running
      ? clamp(context.readNumber(componentVariablePath(component, path)) * restored - 100 * dipPerRatedLoad * blockFraction, -50, 50)
      : 0
    context.write(componentVariablePath(component, 'frequencyDeviationPercent'), deviation('frequencyDeviationPercent', response.frequencyDipPerRatedLoad))
    context.write(componentVariablePath(component, 'voltageDeviationPercent'), deviation('voltageDeviationPercent', response.voltageDipPerRatedLoad))
    context.write(componentVariablePath(component, 'outputKw'), loadMw * 1_000)
  },
}

const sequencedBusByComponent = new WeakMap<CompiledComponent, CompiledComponent>()

const sequencedBus = (system: CompiledProcessPlant, sequencer: CompiledComponent): CompiledComponent => {
  const cached = sequencedBusByComponent.get(sequencer)
  if (cached !== undefined) return cached
  const busId = (sequencer.parameters as Readonly<Record<string, unknown>>).bus
  const index = system.graph.componentIndexById.get(busId as never)
  const bus = index === undefined ? undefined : system.graph.components[index]
  if (bus?.kind !== 'electricalBus') throw new Error(`load sequencer ${sequencer.id} sequences ${String(busId)}, which is no electrical bus of the Plant`)
  sequencedBusByComponent.set(sequencer, bus)
  return bus
}

// A load sequencer arms as its bus dies and, once the bus is live again,
// steps through its blocks: step 1 at once, one more each step interval, up
// to its last step, where it stays until the bus is lost again. Solved once
// the buses have been, so it reads the tick's bus.
const loadSequencerBehavior: ComponentBehaviorDefinition = {
  id: 'load-sequencer-steps',
  phase: 'updateComponentState',
  componentKind: 'loadSequencer',
  reads: ['sequenced bus energized', 'armed', 'elapsedS'],
  writes: ['armed', 'elapsedS', 'step'],
  update: ({ system, component, context }): void => {
    const live = context.readBoolean(componentVariablePath(sequencedBus(system, component), 'energized'))
    if (!live) {
      context.write(componentVariablePath(component, 'armed'), true)
      context.write(componentVariablePath(component, 'elapsedS'), 0)
      context.write(componentVariablePath(component, 'step'), 0)
      return
    }
    if (!context.readBoolean(componentVariablePath(component, 'armed'))) return
    const elapsed = context.readNumber(componentVariablePath(component, 'elapsedS'))
    const step = Math.min(parameterNumber(component, 'stepCount'), 1 + Math.floor(elapsed / parameterNumber(component, 'stepIntervalS')))
    context.write(componentVariablePath(component, 'step'), step)
    context.write(componentVariablePath(component, 'elapsedS'), elapsed + context.dtSeconds)
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
  reads: ['connected', 'incoming electrical availablePowerMw'],
  writes: ['demandMw', 'servedMw', 'servedFraction', 'energized'],
  update: ({ system, component, context }): void => {
    // A load whose feeder breaker is open draws nothing and is dead.
    const connected = context.readBoolean(componentVariablePath(component, 'connected'))
    const demand = connected ? parameterNumber(component, 'nominalLoadMw') : 0
    const incoming = incomingElectricalPower(system, component, context)
    const usable = connected && incoming.energized && incoming.voltageFraction >= 0.7
    const served = usable ? Math.min(demand, incoming.availablePowerMw) : 0
    context.write(componentVariablePath(component, 'demandMw'), demand)
    context.write(componentVariablePath(component, 'servedMw'), served)
    context.write(componentVariablePath(component, 'servedFraction'), demand <= 0 ? 1 : clamp(served / demand, 0, 1))
    context.write(componentVariablePath(component, 'energized'), connected && (served > 0 || demand <= 0))
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

/**
 * A generator's speed. While its output breaker is closed it turns in step
 * with the grid its parameters name, at 120·f / poles rpm (1,500 rpm for a
 * four-pole machine on a 50 Hz grid). The model solves no rotor, so with the
 * breaker open there is no speed to read (no coastdown, no overspeed): it
 * reads a zero that measures nothing, as its kind declares.
 */
export const generatorSpeedRpm = (
  system: CompiledProcessPlant,
  generator: CompiledComponent,
  breakerClosed: boolean,
  context: ElectricalReadContext,
): number => {
  if (!breakerClosed) return 0
  const gridId = (generator.parameters as { readonly gridSource: string }).gridSource
  const gridIndex = system.graph.componentIndexById.get(gridId as never)
  const grid = gridIndex === undefined ? undefined : system.graph.components[gridIndex]
  if (grid?.kind !== 'electricalGridSource') throw new Error(`generator ${generator.id} turns with grid ${gridId}, which is not a grid source of the Plant`)
  return 120 * context.readNumber(componentVariablePath(grid, 'frequencyHz')) / parameterNumber(generator, 'generatorPoleCount')
}

// A generator on line at the start turns with its grid from the first instant.
const generatorSpeedInitialReconciliation: ComponentInitialReconciliationDefinition = {
  id: 'generator-synchronous-speed-initial-state',
  componentKind: 'turbineLoadSink',
  reads: ['outputBreakerClosed', 'gridSource frequencyHz'],
  writes: ['speedRpm'],
  reconcile: ({ system, component, context }): void => {
    const breakerClosed = context.readBoolean(componentVariablePath(component, 'outputBreakerClosed'))
    context.write(componentVariablePath(component, 'speedRpm'), generatorSpeedRpm(system, component, breakerClosed, context))
  },
}

export const electricalInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  ...electricalBehaviorDefinitions.map(behavior => ({
    id: `${behavior.id}-initial-state`, componentKind: behavior.componentKind,
    reads: behavior.reads, writes: behavior.writes, reconcile: behavior.update,
  })),
  generatorSpeedInitialReconciliation,
]

// Solved after the electrical phase and not at the initial reconciliation: a
// sequencer read before its bus is solved would arm on a bus that is live.
export const electricalStateBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  dieselLoadResponseBehavior,
  loadSequencerBehavior,
]
