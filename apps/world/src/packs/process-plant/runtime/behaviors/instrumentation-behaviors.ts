import type { CompiledComponent, CompiledProcessLink } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import { reactorInitialThermalState } from '../../reactor-initial-conditions.ts'
import {
  componentVariablePath,
  processLinkVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
  type ProcessPlantBehaviorContext,
} from '../behavior-contract.ts'
import { parameterNumber, relaxToward } from '../component-helpers.ts'
import { primarySystemPressurizer, primarySystemReactorCore, primarySystemReactorVessel } from '../system-topology.ts'

interface LoopLegs {
  readonly hotLeg: CompiledProcessLink
  readonly coldLeg: CompiledProcessLink
}

const loopLegsCache = new WeakMap<CompiledComponent, LoopLegs>()

const required = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

// A channel's RTDs sit on its loop's legs: the hot leg runs from the core's
// hotLeg<loop> port to the loop's steam generator (the surge line leaves the
// same port for the pressurizer), and the cold leg is the primary coolant
// leaving that steam generator: the links the loop's TE hot and cold tags read.
const loopLegsFor = (system: CompiledProcessPlant, channel: CompiledComponent): LoopLegs => {
  const cached = loopLegsCache.get(channel)
  if (cached !== undefined) return cached
  const loopId = required(channel.metadata?.loopId, `delta-T channel ${channel.id} names no loop`)
  const core = required(primarySystemReactorCore(system), `delta-T channel ${channel.id} needs a reactor core`)
  const outgoing = (component: CompiledComponent) => (system.graph.outgoingLinksByComponent[component.index] ?? []).map(index => system.graph.links[index]!)
  const hotLeg = required(
    outgoing(core).find(link => link.service === 'primaryCoolant'
      && String(link.fromPortName) === `hotLeg${loopId}`
      && system.graph.components[link.toComponentIndex]?.kind === 'steamGenerator'),
    `delta-T channel ${channel.id} finds no hot leg ${loopId} from the core to a steam generator`,
  )
  const steamGenerator = system.graph.components[hotLeg.toComponentIndex]!
  const coldLeg = required(
    outgoing(steamGenerator).find(link => link.service === 'primaryCoolant'),
    `delta-T channel ${channel.id} finds no cold leg leaving ${steamGenerator.id}`,
  )
  const legs = { hotLeg, coldLeg }
  loopLegsCache.set(channel, legs)
  return legs
}

const deltaTChannelReadings = (system: CompiledProcessPlant, channel: CompiledComponent, context: ProcessPlantBehaviorContext) => {
  const { hotLeg, coldLeg } = loopLegsFor(system, channel)
  const core = primarySystemReactorCore(system)!
  const pressurizer = required(primarySystemPressurizer(system), `delta-T channel ${channel.id} needs a pressurizer pressure channel`)
  const hot = context.readNumber(processLinkVariablePath(hotLeg, 'temperatureC'))
  const cold = context.readNumber(processLinkVariablePath(coldLeg, 'temperatureC'))
  const deltaT = hot - cold
  const averageTemperature = (hot + cold) / 2
  // dT0 and T' are the loop delta-T and Tavg the core's own heat balance gives at rated power.
  const rated = reactorInitialThermalState({ ...core.parameters as Record<string, unknown>, initialPowerFraction: 1 })
  const ratedDeltaT = rated.outlet - rated.inlet
  const ratedAverageTemperature = (rated.outlet + rated.inlet) / 2
  const pressureDeviation = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa')) - parameterNumber(pressurizer, 'nominalPressureMPa')
  const temperatureDeviation = averageTemperature - ratedAverageTemperature
  // A setpoint is a delta-T, so the channel's output stops at zero.
  const overtemperatureSetpoint = Math.max(0, ratedDeltaT * (
    parameterNumber(channel, 'overtemperatureK1')
    - parameterNumber(channel, 'overtemperatureK2PerC') * temperatureDeviation
    + parameterNumber(channel, 'overtemperatureK3PerMPa') * pressureDeviation
  ))
  const overpowerSetpoint = Math.max(0, ratedDeltaT * (
    parameterNumber(channel, 'overpowerK4')
    - parameterNumber(channel, 'overpowerK6PerC') * Math.max(0, temperatureDeviation)
  ))
  return { deltaT, averageTemperature, overtemperatureSetpoint, overpowerSetpoint }
}

const deltaTChannelWrites = ['deltaTC', 'averageTemperatureC', 'overtemperatureSetpointC', 'overpowerSetpointC', 'overtemperatureMarginC', 'overpowerMarginC']

const writeDeltaTChannel = (system: CompiledProcessPlant, channel: CompiledComponent, context: ProcessPlantBehaviorContext): void => {
  const reading = deltaTChannelReadings(system, channel, context)
  context.write(componentVariablePath(channel, 'deltaTC'), reading.deltaT)
  context.write(componentVariablePath(channel, 'averageTemperatureC'), reading.averageTemperature)
  context.write(componentVariablePath(channel, 'overtemperatureSetpointC'), reading.overtemperatureSetpoint)
  context.write(componentVariablePath(channel, 'overpowerSetpointC'), reading.overpowerSetpoint)
  context.write(componentVariablePath(channel, 'overtemperatureMarginC'), reading.overtemperatureSetpoint - reading.deltaT)
  context.write(componentVariablePath(channel, 'overpowerMarginC'), reading.overpowerSetpoint - reading.deltaT)
}

const balanceVessel = (system: CompiledProcessPlant, balance: CompiledComponent): CompiledComponent =>
  required(primarySystemReactorVessel(system), `RCS inventory balance ${balance.id} needs a reactor vessel`)

// The reactor coolant system's water is the loops' and the pressurizer's: the
// surge between them, and the steam the pressurizer holds over its water,
// moves coolant inside the system and is no leak.
const rcsInventoryKg = (system: CompiledProcessPlant, balance: CompiledComponent, context: Pick<ProcessPlantBehaviorContext, 'readNumber'>): number => {
  const pressurizer = required(primarySystemPressurizer(system), `RCS inventory balance ${balance.id} needs a pressurizer`)
  return context.readNumber(componentVariablePath(balanceVessel(system, balance), 'primaryCoolantInventoryKg'))
    + context.readNumber(componentVariablePath(pressurizer, 'waterInventoryKg'))
    + context.readNumber(componentVariablePath(pressurizer, 'steamMassKg'))
}

const rcsInventoryReads = ['vessel.chargingFlowKgPerS', 'vessel.safetyInjectionFlowKgPerS', 'vessel.letdownFlowKgPerS', 'pressurizer.reliefFlowKgPerS', 'pressurizer.safetyValveFlowKgPerS', 'vessel.primaryCoolantInventoryKg', 'pressurizer.waterInventoryKg', 'pressurizer.steamMassKg', 'leakRateKgPerS', 'balancedInventoryKg']

const siBlockWrites = ['blockPushbutton', 'blocked', 'belowP11']

// P-11, P-4 and the block memory, from this step's pressure and breaker contacts; the pushbutton springs back.
const writeSafetyInjectionBlock = (system: CompiledProcessPlant, logic: CompiledComponent, context: ProcessPlantBehaviorContext, held: boolean): void => {
  const pressurizer = required(primarySystemPressurizer(system), `SI block logic ${logic.id} needs a pressurizer pressure channel`)
  const breakers = (logic.parameters as { readonly reactorTripBreakers: ReadonlyArray<string> }).reactorTripBreakers.map(id =>
    required(system.graph.componentIndexById.get(id as never), `SI block logic ${logic.id} names reactor trip breaker ${id}, which is not a component of the Plant`))
  const belowP11 = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa')) < parameterNumber(logic, 'p11PressureMPa')
  const reactorTripped = breakers.some(index => !context.readBoolean(componentVariablePath(system.graph.components[index]!, 'closedState')))
  const blocked = belowP11 && reactorTripped && (held || context.readBoolean(componentVariablePath(logic, 'blockPushbutton')))
  context.write(componentVariablePath(logic, 'belowP11'), belowP11)
  context.write(componentVariablePath(logic, 'blocked'), blocked)
  context.write(componentVariablePath(logic, 'blockPushbutton'), false)
}

export const instrumentationBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'delta-t-protection-channel',
    // Last in the step, so it reads the loop temperatures the step before
    // solved: a one-second RTD lag, shorter than a real RTD's few seconds.
    phase: 'updateComponentState',
    componentKind: 'deltaTProtectionChannel',
    reads: ['hot leg:temperatureC', 'cold leg:temperatureC', 'pressurizer.pressureMPa', 'reactorCore rated heat balance'],
    writes: deltaTChannelWrites,
    update: ({ system, component, context }): void => writeDeltaTChannel(system, component, context),
  },
  {
    id: 'rcs-inventory-balance',
    // After the vessel's own update, so the flows and the inventory are this step's.
    phase: 'updateComponentState',
    componentKind: 'rcsInventoryBalance',
    reads: rcsInventoryReads,
    writes: ['leakRateKgPerS', 'balancedInventoryKg'],
    update: ({ system, component, context }): void => {
      const vessel = balanceVessel(system, component)
      const flow = (localPath: string) => context.readNumber(componentVariablePath(vessel, localPath))
      const inventory = rcsInventoryKg(system, component, context)
      const inventoryChange = (inventory - context.readNumber(componentVariablePath(component, 'balancedInventoryKg'))) / Math.max(context.dtSeconds, 1e-9)
      // Relief is the pressurizer's own this step, as its inventory is: the
      // relief line's flow trails it by a step, which a sudden change in
      // relief, as the pressurizer goes solid, would read as a leak.
      const pressurizer = required(primarySystemPressurizer(system), `RCS inventory balance ${component.id} needs a pressurizer`)
      const relief = context.readNumber(componentVariablePath(pressurizer, 'reliefFlowKgPerS'))
        + context.readNumber(componentVariablePath(pressurizer, 'safetyValveFlowKgPerS'))
      const unaccounted = flow('chargingFlowKgPerS') + flow('safetyInjectionFlowKgPerS') - flow('letdownFlowKgPerS') - relief - inventoryChange
      const leakRate = context.readNumber(componentVariablePath(component, 'leakRateKgPerS'))
      context.write(componentVariablePath(component, 'leakRateKgPerS'), relaxToward(leakRate, unaccounted, context.dtSeconds, parameterNumber(component, 'averagingTimeConstantS')))
      context.write(componentVariablePath(component, 'balancedInventoryKg'), inventory)
    },
  },
  {
    id: 'safety-injection-block-logic',
    phase: 'updateComponentState',
    componentKind: 'safetyInjectionBlockLogic',
    reads: ['blockPushbutton', 'blocked', 'pressurizer.pressureMPa', 'reactor trip breakers closedState'],
    writes: siBlockWrites,
    update: ({ system, component, context }): void =>
      writeSafetyInjectionBlock(system, component, context, context.readBoolean(componentVariablePath(component, 'blocked'))),
  },
]

export const instrumentationInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'delta-t-protection-channel-initial-state',
    componentKind: 'deltaTProtectionChannel',
    // Its RTDs read the loop legs, so it starts from their temperatures once the links are solved.
    afterLinks: true,
    reads: ['hot leg:temperatureC', 'cold leg:temperatureC', 'pressurizer.pressureMPa', 'reactorCore rated heat balance'],
    writes: deltaTChannelWrites,
    reconcile: ({ system, component, context }): void => writeDeltaTChannel(system, component, context),
  },
  {
    id: 'rcs-inventory-balance-initial-state',
    componentKind: 'rcsInventoryBalance',
    reads: ['vessel.primaryCoolantInventoryKg', 'pressurizer.waterInventoryKg', 'pressurizer.steamMassKg'],
    writes: ['leakRateKgPerS', 'balancedInventoryKg'],
    // After the pressurizer and the loops have taken their initial inventories.
    afterLinks: true,
    reconcile: ({ system, component, context }): void => {
      context.write(componentVariablePath(component, 'leakRateKgPerS'), 0)
      context.write(componentVariablePath(component, 'balancedInventoryKg'), rcsInventoryKg(system, component, context))
    },
  },
  {
    id: 'safety-injection-block-logic-initial-state',
    componentKind: 'safetyInjectionBlockLogic',
    reads: ['pressurizer.pressureMPa', 'reactor trip breakers closedState'],
    writes: siBlockWrites,
    // A Plant starts with no block set.
    reconcile: ({ system, component, context }): void => writeSafetyInjectionBlock(system, component, context, false),
  },
]
