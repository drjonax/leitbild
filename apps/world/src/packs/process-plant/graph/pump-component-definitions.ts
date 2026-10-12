import { z } from 'zod'
import { type ComponentDefinition, type ComponentKind, variablePathSchema } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

/** The ports by which a pump its own steam turbine drives takes the turbine's steam and exhausts it. */
export const pumpDriveSteamPorts = { inlet: 'driveSteamInlet', exhaust: 'driveSteamExhaust' } as const

export const pumpComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'centrifugalPump' as ComponentKind,
    label: 'Centrifugal Pump',
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      outlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      speedDemand: { kind: 'controlSignal', direction: 'in' },
      power: { kind: 'electricalAc', direction: 'in', demand: 'demandMw' },
      // A pump its own steam turbine drives takes the turbine's steam here and
      // exhausts it by its exhaust, to the atmosphere.
      [pumpDriveSteamPorts.inlet]: { kind: 'steam', direction: 'in', circuit: 'drive' },
      [pumpDriveSteamPorts.exhaust]: { kind: 'steam', direction: 'out', circuit: 'drive' },
    },
    parametersSchema: z.object({
      nominalFlowKgPerS: z.number().finite().positive(),
      nominalHeadPa: z.number().finite().positive(),
      primaryLoopId: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/).optional(),
      initialRunning: z.boolean().optional(),
      flowTimeConstantS: z.number().finite().positive().optional(),
      maxFlowRampKgPerS2: z.number().finite().positive().optional(),
      nominalSpeedRpm: z.number().finite().positive().optional(),
      /** For a reactor coolant pump: the time constant with which its loop's flow follows the head that drives it. */
      loopInertiaTimeConstantS: z.number().finite().positive().optional(),
      /**
       * For a pump with a flywheel: the time in which its speed halves once its
       * motor stops, the water's drag on the impeller slowing it as the square
       * of its speed.
       */
      coastdownTimeConstantS: z.number().finite().positive().optional(),
      /**
       * For a pump its own turbine drives: the time from its start signal to
       * its commanded speed, as its steam admission valve opens and the
       * turbine accelerates the pump. Its speed rises evenly over it; any
       * other pump is at its speed as it starts.
       */
      runUpTimeS: z.number().finite().positive().optional(),
      /**
       * For a pump its own turbine drives with steam brought to its drive
       * steam inlet: the least steam flow on which the turbine holds the
       * pump's speed. Below it the pump does not run, whatever its command:
       * no steam, no pump.
       */
      minimumDriveSteamFlowKgPerS: z.number().finite().positive().optional(),
      loopResistanceCoefficient: z.number().finite().nonnegative().optional(),
      /**
       * The head it develops at rated speed with no flow. Its head falls along
       * a parabola from it through its nominal head at its nominal flow, which
       * speed scales by the affinity laws. A reactor coolant pump standing
       * still, held by its anti-reverse device, resists flow by their
       * difference at rated flow; on a pressure-balanced header, the header's
       * pressure sets where on the curve a pump runs.
       */
      shutoffHeadPa: z.number().finite().positive().optional(),
      /**
       * For a reactor coolant pump: the height of its loop's steam generator
       * thermal centre above the core's, over which the cold leg's denser
       * water drives the loop by natural circulation.
       */
      naturalCirculationHeightM: z.number().finite().nonnegative().optional(),
      hydraulicEfficiencyFraction: z.number().finite().positive().max(1).optional(),
      fluidDensityKgPerM3: z.number().finite().positive().optional(),
      /**
       * For a pump that injects into the reactor coolant system: the reactor
       * coolant pressure at which it delivers nothing, its shutoff head over
       * its suction. Its nominal flow is then its runout flow, and it delivers
       * less as that pressure rises, along a parabolic pump curve.
       */
      reactorCoolantShutoffPressureMPa: z.number().finite().positive().optional(),
      /**
       * For a pump whose flow a controller sets, as pressurizer level control
       * sets the charging pump's: the variable holding the flow it is to
       * deliver. It runs at the speed that delivers it, within its speed range.
       */
      flowDemandPath: variablePathSchema.optional(),
    }),
    // A pump runs while it is commanded to run and its motor has power, from the step it is commanded.
    semantics: fixedSemantics({ aspects: [aspect('running', { variable: 'runningState', reading: 'true' }, 'running', undefined, { onS: 0, offS: 0 })], ratedOutflow: [{ port: 'outlet', parameter: 'nominalFlowKgPerS' }] }),
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
      // An idle loop the other loops drive backwards reads no forward flow.
      variable({ path: 'loopReverseFlowKgPerS', label: 'Primary loop reverse flow', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
]
