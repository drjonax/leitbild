import type { CompiledComponent, VariablePath } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import {
  componentVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
  type ProcessPlantBehaviorContext,
} from '../behavior-contract.ts'
import { approach, clamp, optionalParameterNumber, parameterNumber, relaxToward, type ComponentNumericReadContext } from '../component-helpers.ts'
import { primaryCircuitHydraulics, primaryLoopPumpHeadPa, primaryLoopSignedFlowKgPerS, solvePrimaryLoopFlows, type PrimaryCircuitHydraulics } from '../primary-loop-hydraulics.ts'
import { primarySystemPressurizer } from '../system-topology.ts'
import { componentHasElectricalPower } from './electrical-behaviors.ts'
import { headerPressureBalance, pressureBalancedHeaderFedBy } from './junction/header-pressure-balance.ts'

type PumpBehaviorInput = Parameters<ComponentBehaviorDefinition['update']>[0]

// A pump that injects into the reactor coolant system pumps against its
// pressure, read at the pressurizer: Q = Qrunout * n * sqrt(1 - P / (P0 * n^2)),
// with the shutoff pressure P0 scaled by the square of the speed n.
const reactorCoolantDeliveryFraction = ({ system, component, context }: PumpBehaviorInput, speed: number): number => {
  const shutoffPressure = (component.parameters as Readonly<Record<string, unknown>>).reactorCoolantShutoffPressureMPa
  if (typeof shutoffPressure !== 'number') return 1
  const pressurizer = primarySystemPressurizer(system)
  if (pressurizer === null) throw new Error(`pump ${component.id} injects into the reactor coolant system, which has no pressurizer to read its pressure from`)
  const pressure = context.readNumber(componentVariablePath(pressurizer, 'pressureMPa'))
  return Math.sqrt(clamp(1 - pressure / Math.max(1e-6, shutoffPressure * speed * speed), 0, 1))
}

const maxSpeedFraction = 1.2

// A running pump discharging into a pressure-balanced header delivers what
// its curve gives at the pressure the header settles at: it comes up to that
// flow as it starts, and runs back to it at once as branches shut. Null for
// any other pump.
const balancedHeaderFlow = ({ system, component, context }: Pick<PumpBehaviorInput, 'system' | 'component' | 'context'>, running: boolean): number | null => {
  const header = running ? pressureBalancedHeaderFedBy(system, component) : null
  return header === null ? null : headerPressureBalance(system, header, context).pumpFlowKgPerS.get(component.index) ?? 0
}

// A pump whose flow a controller sets runs at the speed that delivers it,
// and shows that speed as its own; any other runs at its commanded speed.
const pumpSpeedFraction = (component: CompiledComponent, context: Pick<ProcessPlantBehaviorContext, 'readNumber' | 'write'>): number => {
  const flowDemandPath = (component.parameters as Readonly<Record<string, unknown>>).flowDemandPath
  if (typeof flowDemandPath !== 'string') return clamp(context.readNumber(componentVariablePath(component, 'speedFraction')), 0, maxSpeedFraction)
  const speed = clamp(context.readNumber(flowDemandPath as VariablePath) / parameterNumber(component, 'nominalFlowKgPerS'), 0, maxSpeedFraction)
  context.write(componentVariablePath(component, 'speedFraction'), speed)
  return speed
}

const nominalSpeedRpm = (component: CompiledComponent): number => optionalParameterNumber(component, 'nominalSpeedRpm', 3600)

// A turbine-driven pump comes up to its commanded speed over its run-up
// time once started, and the flow it can deliver rises with its speed. A pump
// with a flywheel coasts when its motor stops. The water's drag on the
// impeller grows as the square of its speed, so the speed n falls as
// n' = -n^2 / tau, n0 / (1 + n0 t / tau): it halves in the coastdown time
// constant tau, and the flow it drives falls with it. Any other pump stops.
const pumpRotorSpeedRpm = (component: CompiledComponent, context: Pick<ProcessPlantBehaviorContext, 'readNumber' | 'dtSeconds'>, running: boolean, speed: number): number => {
  const runUpTime = (component.parameters as Readonly<Record<string, unknown>>).runUpTimeS
  if (running && typeof runUpTime === 'number') {
    return approach(context.readNumber(componentVariablePath(component, 'speedRpm')), speed * nominalSpeedRpm(component), nominalSpeedRpm(component) * context.dtSeconds / runUpTime)
  }
  if (running) return speed * nominalSpeedRpm(component)
  const coastdownTimeConstant = (component.parameters as Readonly<Record<string, unknown>>).coastdownTimeConstantS
  if (typeof coastdownTimeConstant !== 'number') return 0
  const rotorSpeed = context.readNumber(componentVariablePath(component, 'speedRpm')) / nominalSpeedRpm(component)
  return nominalSpeedRpm(component) * rotorSpeed / (1 + rotorSpeed * context.dtSeconds / coastdownTimeConstant)
}

// A loop's flow is held as two flows that are never both above zero: forward,
// hot leg through steam generator and pump to cold leg, which the loop's flow
// transmitter reads; and reverse, as the other loops drive an idle one
// backwards, which reads on that transmitter as no flow.
const writeLoopFlow = (component: CompiledComponent, context: Pick<ProcessPlantBehaviorContext, 'write'>, signedFlowKgPerS: number): void => {
  context.write(componentVariablePath(component, 'loopFlowKgPerS'), Math.max(0, signedFlowKgPerS))
  context.write(componentVariablePath(component, 'loopReverseFlowKgPerS'), Math.max(0, -signedFlowKgPerS))
}

const rotorSpeedFraction = (component: CompiledComponent, context: ComponentNumericReadContext): number =>
  context.readNumber(componentVariablePath(component, 'speedRpm')) / nominalSpeedRpm(component)

/** The loop a reactor coolant pump drives, and the circuit it shares with the others; null for any other pump. */
const primaryLoopOf = (system: CompiledProcessPlant, component: CompiledComponent): { readonly circuit: PrimaryCircuitHydraulics; readonly index: number } | null => {
  const circuit = primaryCircuitHydraulics(system)
  const index = circuit === null ? -1 : circuit.loops.findIndex(loop => loop.pump === component)
  return circuit === null || index < 0 ? null : { circuit, index }
}

/** The flow every loop's pumps and buoyancy now drive, this pump's loop's among them. */
const primaryLoopFlowTarget = (system: CompiledProcessPlant, loop: { readonly circuit: PrimaryCircuitHydraulics; readonly index: number }, context: ComponentNumericReadContext): number =>
  solvePrimaryLoopFlows(system, loop.circuit, loop.circuit.loops.map(other => rotorSpeedFraction(other.pump, context)), context)[loop.index]!

export const pumpBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'centrifugal-pump-flow',
    phase: 'solveFluidFlowComponents',
    componentKind: 'centrifugalPump',
    reads: ['running', 'speedFraction', 'speedRpm', 'flow demand?', 'incoming electrical energized?', 'pressurizer.pressureMPa?', 'pressure-balanced header branches?'],
    writes: ['runningState', 'flowKgPerS', 'speedRpm', 'demandMw', 'speedFraction'],
    update: (input): void => {
      const { system, component, context } = input
      const running = context.readBoolean(componentVariablePath(component, 'running'))
        && componentHasElectricalPower(system, component, context)
      const speed = pumpSpeedFraction(component, context)
      context.write(componentVariablePath(component, 'runningState'), running)
      context.write(componentVariablePath(component, 'speedRpm'), pumpRotorSpeedRpm(component, context, running, speed))
      const balancedFlow = balancedHeaderFlow(input, running)
      const targetFlow = running ? balancedFlow ?? parameterNumber(component, 'nominalFlowKgPerS') * speed * reactorCoolantDeliveryFraction(input, speed) : 0
      const currentFlow = context.readNumber(componentVariablePath(component, 'flowKgPerS'))
      const timeConstant = optionalParameterNumber(component, 'flowTimeConstantS', 0)
      const maxRamp = optionalParameterNumber(component, 'maxFlowRampKgPerS2', Number.POSITIVE_INFINITY)
      const relaxedFlow = timeConstant > 0
        ? relaxToward(currentFlow, targetFlow, context.dtSeconds, timeConstant)
        : targetFlow
      const flow = Math.min(approach(currentFlow, relaxedFlow, maxRamp * context.dtSeconds), balancedFlow ?? Number.POSITIVE_INFINITY)
      context.write(componentVariablePath(component, 'flowKgPerS'), flow)
      const head = running ? parameterNumber(component, 'nominalHeadPa') * speed * speed : 0
      const density = optionalParameterNumber(component, 'fluidDensityKgPerM3', 800)
      const efficiency = optionalParameterNumber(component, 'hydraulicEfficiencyFraction', 0.82)
      context.write(componentVariablePath(component, 'demandMw'), running ? Math.max(0, flow * head / density / efficiency / 1_000_000) : 0)
    },
  },
  {
    id: 'centrifugal-pump-primary-loop-flow',
    phase: 'solveFluidFlowComponents',
    componentKind: 'centrifugalPump',
    reads: ['running', 'speedFraction', 'speedRpm', 'loopFlowKgPerS', 'loopReverseFlowKgPerS', 'incoming electrical energized?', 'every primary loop pump speedRpm', 'every primary loop leg temperatureC', 'pressurizer.pressureMPa?'],
    writes: ['developedHeadPa', 'loopFlowTargetKgPerS', 'loopFlowKgPerS', 'loopReverseFlowKgPerS'],
    update: ({ system, component, context }): void => {
      const loop = primaryLoopOf(system, component)
      if (loop === null) {
        const running = context.readBoolean(componentVariablePath(component, 'running'))
          && componentHasElectricalPower(system, component, context)
        const speed = clamp(context.readNumber(componentVariablePath(component, 'speedFraction')), 0, maxSpeedFraction)
        context.write(componentVariablePath(component, 'developedHeadPa'), running ? parameterNumber(component, 'nominalHeadPa') * speed * speed : 0)
        context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), 0)
        writeLoopFlow(component, context, 0)
        return
      }
      // The loop's water follows the head that drives it with the loop's inertia.
      const targetFlow = primaryLoopFlowTarget(system, loop, context)
      const flow = relaxToward(primaryLoopSignedFlowKgPerS(component, context), targetFlow, context.dtSeconds, parameterNumber(component, 'loopInertiaTimeConstantS'))
      context.write(componentVariablePath(component, 'developedHeadPa'), primaryLoopPumpHeadPa(loop.circuit.loops[loop.index]!, rotorSpeedFraction(component, context), flow))
      context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), Math.max(0, targetFlow))
      writeLoopFlow(component, context, flow)
    },
  },
]

export const pumpInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'centrifugal-pump-initial-state',
    componentKind: 'centrifugalPump',
    reads: ['running', 'speedFraction', 'flow demand?', 'every primary loop pump speedRpm', 'every primary loop leg temperatureC', 'pressurizer.pressureMPa?'],
    writes: ['runningState', 'speedFraction', 'flowKgPerS', 'speedRpm', 'developedHeadPa', 'demandMw', 'loopFlowTargetKgPerS', 'loopFlowKgPerS', 'loopReverseFlowKgPerS'],
    reconcile: ({ system, component, context }): void => {
      const running = context.readBoolean(componentVariablePath(component, 'running')) && componentHasElectricalPower(system, component, context)
      context.write(componentVariablePath(component, 'runningState'), running)
      const speed = pumpSpeedFraction(component, context)
      const nominalFlow = parameterNumber(component, 'nominalFlowKgPerS')
      const nominalHead = parameterNumber(component, 'nominalHeadPa')
      const developedHead = running ? nominalHead * speed * speed : 0
      const componentFlow = running ? balancedHeaderFlow({ system, component, context }, running) ?? nominalFlow * speed : 0
      context.write(componentVariablePath(component, 'flowKgPerS'), componentFlow)
      context.write(componentVariablePath(component, 'speedRpm'), running ? speed * nominalSpeedRpm(component) : 0)
      context.write(componentVariablePath(component, 'demandMw'), running
        ? componentFlow * developedHead / optionalParameterNumber(component, 'fluidDensityKgPerM3', 800) / optionalParameterNumber(component, 'hydraulicEfficiencyFraction', 0.82) / 1_000_000
        : 0)

      const loop = primaryLoopOf(system, component)
      if (loop === null) {
        context.write(componentVariablePath(component, 'developedHeadPa'), developedHead)
        context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), 0)
        writeLoopFlow(component, context, 0)
        return
      }
      const loopFlow = primaryLoopFlowTarget(system, loop, context)
      context.write(componentVariablePath(component, 'developedHeadPa'), primaryLoopPumpHeadPa(loop.circuit.loops[loop.index]!, rotorSpeedFraction(component, context), loopFlow))
      context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), Math.max(0, loopFlow))
      writeLoopFlow(component, context, loopFlow)
    },
  },
]
