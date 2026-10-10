import { primaryLoopIdForPump } from '../../graph/index.ts'
import {
  componentVariablePath,
  type ComponentBehaviorDefinition,
  type ComponentInitialReconciliationDefinition,
} from '../behavior-contract.ts'
import { approach, clamp, optionalParameterNumber, parameterNumber, relaxToward } from '../component-helpers.ts'
import { pumpHeadResistanceFlowTarget } from '../physics.ts'
import { primaryLoopLinkResistanceCoefficient } from '../topology-cache.ts'
import { componentHasElectricalPower } from './electrical-behaviors.ts'

export const pumpBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'centrifugal-pump-flow',
    phase: 'solveFluidFlowComponents',
    componentKind: 'centrifugalPump',
    reads: ['running', 'speedFraction', 'incoming electrical energized?'],
    writes: ['runningState', 'flowKgPerS', 'speedRpm', 'demandMw'],
    update: ({ system, component, context }): void => {
      const running = context.readBoolean(componentVariablePath(component, 'running'))
        && componentHasElectricalPower(system, component, context)
      const speed = clamp(context.readNumber(componentVariablePath(component, 'speedFraction')), 0, 1.2)
      context.write(componentVariablePath(component, 'runningState'), running)
      context.write(componentVariablePath(component, 'speedRpm'), running ? speed * optionalParameterNumber(component, 'nominalSpeedRpm', 3600) : 0)
      const targetFlow = running ? parameterNumber(component, 'nominalFlowKgPerS') * speed : 0
      const currentFlow = context.readNumber(componentVariablePath(component, 'flowKgPerS'))
      const timeConstant = optionalParameterNumber(component, 'flowTimeConstantS', 0)
      const maxRamp = optionalParameterNumber(component, 'maxFlowRampKgPerS2', Number.POSITIVE_INFINITY)
      const relaxedFlow = timeConstant > 0
        ? relaxToward(currentFlow, targetFlow, context.dtSeconds, timeConstant)
        : targetFlow
      const flow = approach(currentFlow, relaxedFlow, maxRamp * context.dtSeconds)
      context.write(componentVariablePath(component, 'flowKgPerS'), flow)
      const head = running ? parameterNumber(component, 'nominalHeadPa') * speed * speed : 0
      const density = optionalParameterNumber(component, 'fluidDensityKgPerM3', 800)
      const efficiency = optionalParameterNumber(component, 'hydraulicEfficiencyFraction', 0.82)
      context.write(componentVariablePath(component, 'demandMw'), running ? Math.max(0, flow * head / density / efficiency / 1_000_000) : 0)
    },
  },
  {
    id: 'centrifugal-pump-primary-loop-inertia',
    phase: 'solveFluidFlowComponents',
    componentKind: 'centrifugalPump',
    reads: ['running', 'speedFraction', 'flowKgPerS', 'loopFlowKgPerS', 'incoming electrical energized?'],
    writes: ['developedHeadPa', 'loopFlowTargetKgPerS', 'loopFlowKgPerS'],
    update: ({ system, component, context }): void => {
      const running = context.readBoolean(componentVariablePath(component, 'running'))
        && componentHasElectricalPower(system, component, context)
      const speed = clamp(context.readNumber(componentVariablePath(component, 'speedFraction')), 0, 1.2)
      const nominalHead = parameterNumber(component, 'nominalHeadPa')
      const developedHead = running ? nominalHead * speed * speed : 0
      context.write(componentVariablePath(component, 'developedHeadPa'), developedHead)

      const primaryLoopId = primaryLoopIdForPump(component)
      if (primaryLoopId === null) {
        context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), 0)
        context.write(componentVariablePath(component, 'loopFlowKgPerS'), 0)
        return
      }

      const pumpFlow = context.readNumber(componentVariablePath(component, 'flowKgPerS'))
      const resistance = optionalParameterNumber(component, 'loopResistanceCoefficient', 0)
        + primaryLoopLinkResistanceCoefficient(component, system.graph)
      const naturalCirculationFlow = optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
      const nominalFlow = parameterNumber(component, 'nominalFlowKgPerS')
      const hydraulicTargetFlow = pumpHeadResistanceFlowTarget({
        developedHeadPa: developedHead,
        nominalHeadPa: nominalHead,
        nominalFlowKgPerS: nominalFlow,
        resistanceCoefficient: resistance,
        minimumFlowKgPerS: naturalCirculationFlow,
      })
      const targetFlow = running
        ? Math.min(hydraulicTargetFlow, pumpFlow)
        : naturalCirculationFlow
      const currentLoopFlow = context.readNumber(componentVariablePath(component, 'loopFlowKgPerS'))
      const timeConstant = running
        ? optionalParameterNumber(component, 'loopInertiaTimeConstantS', optionalParameterNumber(component, 'flowTimeConstantS', 4))
        : optionalParameterNumber(component, 'coastdownTimeConstantS', optionalParameterNumber(component, 'loopInertiaTimeConstantS', 10))
      context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), targetFlow)
      context.write(componentVariablePath(component, 'loopFlowKgPerS'), relaxToward(currentLoopFlow, targetFlow, context.dtSeconds, timeConstant))
    },
  },
]

export const pumpInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  {
    id: 'centrifugal-pump-initial-state',
    componentKind: 'centrifugalPump',
    reads: ['running', 'speedFraction'],
    writes: ['runningState', 'flowKgPerS', 'speedRpm', 'developedHeadPa', 'demandMw', 'loopFlowTargetKgPerS', 'loopFlowKgPerS'],
    reconcile: ({ system, component, context }): void => {
      const running = context.readBoolean(componentVariablePath(component, 'running')) && componentHasElectricalPower(system, component, context)
      context.write(componentVariablePath(component, 'runningState'), running)
      const speed = clamp(context.readNumber(componentVariablePath(component, 'speedFraction')), 0, 1.2)
      const nominalFlow = parameterNumber(component, 'nominalFlowKgPerS')
      const nominalHead = parameterNumber(component, 'nominalHeadPa')
      const developedHead = running ? nominalHead * speed * speed : 0
      const componentFlow = running ? nominalFlow * speed : 0
      context.write(componentVariablePath(component, 'flowKgPerS'), componentFlow)
      context.write(componentVariablePath(component, 'speedRpm'), running ? speed * optionalParameterNumber(component, 'nominalSpeedRpm', 3600) : 0)
      context.write(componentVariablePath(component, 'developedHeadPa'), developedHead)
      context.write(componentVariablePath(component, 'demandMw'), running
        ? componentFlow * developedHead / optionalParameterNumber(component, 'fluidDensityKgPerM3', 800) / optionalParameterNumber(component, 'hydraulicEfficiencyFraction', 0.82) / 1_000_000
        : 0)

      const primaryLoopId = primaryLoopIdForPump(component)
      if (primaryLoopId === null) {
        context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), 0)
        context.write(componentVariablePath(component, 'loopFlowKgPerS'), 0)
        return
      }

      const naturalCirculationFlow = optionalParameterNumber(component, 'minimumNaturalCirculationFlowKgPerS', 0)
      const loopTarget = running
        ? Math.min(
            pumpHeadResistanceFlowTarget({
              developedHeadPa: developedHead,
              nominalHeadPa: nominalHead,
              nominalFlowKgPerS: nominalFlow,
              resistanceCoefficient: optionalParameterNumber(component, 'loopResistanceCoefficient', 0)
                + primaryLoopLinkResistanceCoefficient(component, system.graph),
              minimumFlowKgPerS: naturalCirculationFlow,
            }),
            componentFlow,
          )
        : naturalCirculationFlow
      context.write(componentVariablePath(component, 'loopFlowTargetKgPerS'), loopTarget)
      context.write(componentVariablePath(component, 'loopFlowKgPerS'), loopTarget)
    },
  },
]
