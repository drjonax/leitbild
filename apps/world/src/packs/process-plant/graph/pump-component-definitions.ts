import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

export const pumpComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'centrifugalPump' as ComponentKind,
    label: 'Centrifugal Pump',
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      outlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      speedDemand: { kind: 'controlSignal', direction: 'in' },
      power: { kind: 'electricalAc', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalFlowKgPerS: z.number().finite().positive(),
      nominalHeadPa: z.number().finite().positive(),
      primaryLoopId: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/).optional(),
      initialRunning: z.boolean().optional(),
      flowTimeConstantS: z.number().finite().positive().optional(),
      maxFlowRampKgPerS2: z.number().finite().positive().optional(),
      nominalSpeedRpm: z.number().finite().positive().optional(),
      loopInertiaTimeConstantS: z.number().finite().positive().optional(),
      coastdownTimeConstantS: z.number().finite().positive().optional(),
      loopResistanceCoefficient: z.number().finite().nonnegative().optional(),
      minimumNaturalCirculationFlowKgPerS: z.number().finite().nonnegative().optional(),
      hydraulicEfficiencyFraction: z.number().finite().positive().max(1).optional(),
      fluidDensityKgPerM3: z.number().finite().positive().optional(),
    }),
    // A pump runs while it is commanded to run and its motor has power.
    semantics: fixedSemantics({ aspects: [aspect('running', { variable: 'runningState', reading: 'true' }, 'running')], ratedOutflow: [{ port: 'outlet', parameter: 'nominalFlowKgPerS' }] }),
    variables: [
      variable({ path: 'running', label: 'Run command', kind: 'discrete', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'runningState', label: 'Running', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'speedFraction', label: 'Speed', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'speed', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'speedRpm', label: 'Rotational speed', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'rotationalSpeed', unit: 'rpm' }),
      variable({ path: 'flowKgPerS', label: 'Flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'developedHeadPa', label: 'Developed head', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'head', unit: 'Pa' }),
      variable({ path: 'demandMw', label: 'Pump electrical demand', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'loopFlowTargetKgPerS', label: 'Primary loop target flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'loopFlowKgPerS', label: 'Primary loop flow', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
]
