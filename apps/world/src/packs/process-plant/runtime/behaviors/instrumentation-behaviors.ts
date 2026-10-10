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
import { parameterNumber } from '../component-helpers.ts'
import { primarySystemPressurizer, primarySystemReactorCore } from '../system-topology.ts'

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
]

export const instrumentationInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'delta-t-protection-channel-initial-state',
    componentKind: 'deltaTProtectionChannel',
    reads: ['hot leg:temperatureC', 'cold leg:temperatureC', 'pressurizer.pressureMPa', 'reactorCore rated heat balance'],
    writes: deltaTChannelWrites,
    reconcile: ({ system, component, context }): void => writeDeltaTChannel(system, component, context),
  },
]
