import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

export const pressurizerComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'pressurizer' as ComponentKind,
    label: 'Pressurizer',
    ports: {
      surgeLine: { kind: 'hydraulicThermal', direction: 'bidirectional', circuit: 'coolant' },
      sprayInlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'coolant' },
      reliefOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      safetyOutlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'coolant' },
      heaterPower: { kind: 'electricalAc', direction: 'in', demand: 'demandMw' },
      // The PORV block valve's motor has its own supply, apart from the heaters': the valve must close on a stuck-open
      // PORV after a loss of offsite power, when the heaters' bus is dead and only the diesel-backed buses are live.
      blockValvePower: { kind: 'electricalAc', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPressureMPa: z.number().finite().positive(),
      nominalLevelPercent: normalized,
      volumeM3: z.number().finite().positive(),
      reliefSetpointMPa: z.number().finite().positive(),
      reliefCapacityKgPerS: z.number().finite().nonnegative(),
      /** How fast water above saturation flashes to steam. */
      flashingTimeConstantS: z.number().finite().positive(),
      /** How fast steam condenses on water below saturation; slow, as the water stratifies under the interface. */
      condensationTimeConstantS: z.number().finite().positive(),
      /** Full stroke time of the motor-operated PORV block valve. */
      blockValveStrokeTimeS: z.number().finite().positive(),
      /** Set pressure of the spring-loaded code safety valves, where they pop open. */
      safetyValveSetpointMPa: z.number().finite().positive(),
      /** Rated discharge of all the code safety valves together, at full lift. */
      safetyValvesCapacityKgPerS: z.number().finite().positive(),
      /** Pressure rise above the set pressure at which the safety valves reach full lift, a fraction of it. */
      safetyValveAccumulationFraction: z.number().finite().positive().max(0.1),
      /** Pressure fall below the set pressure at which the safety valves reseat, a fraction of it. */
      safetyValveBlowdownFraction: z.number().finite().positive().max(0.2),
    }),
    semantics: fixedSemantics({ keyValues: ['pressureMPa', 'levelPercent'],
      aspects: [aspect('level', { variable: 'levelPercent', reading: 'value' })],
      // The PORV and its block valve are modelled inside the pressurizer, on its relief outlet, in the order they sit on
      // the relief line: the motor-operated block valve next to the pressurizer, then the PORV. The pressurizer solves
      // the relief flow itself, so both valves that throttle it belong to it; the line passes what the less open allows.
      // The PORV's position is its own opening: the demand, the automatic opening above the relief setpoint, or a failed
      // position. The block valve's is where its motor has driven it.
      embedded: [{
        id: 'blockValve',
        label: 'block valve',
        function: 'isolating',
        port: 'reliefOutlet',
        aspects: [aspect('position', { variable: 'blockValveEffectivePositionFraction', reading: 'value' }, 'blockValvePositionFraction')],
        variables: ['blockValvePositionFraction', 'blockValveEffectivePositionFraction'],
      }, {
        id: 'reliefValve',
        label: 'relief valve',
        function: 'relieving',
        port: 'reliefOutlet',
        aspects: [
          aspect('position', { variable: 'reliefValveEffectivePositionFraction', reading: 'value' }, 'reliefValvePositionFraction'),
          aspect('throughput', { variable: 'reliefFlowKgPerS', reading: 'flow' }),
        ],
        variables: ['reliefFlowKgPerS', 'reliefValvePositionFraction', 'reliefValveEffectivePositionFraction', 'reliefValveFailureActive', 'reliefValveFailedPositionFraction'],
      }, {
        // The spring-loaded code safety valves, on their own lines to the relief tank, which no block valve isolates.
        // The model holds them as one bank: they share a set pressure, so they lift together.
        id: 'safetyValves',
        label: 'code safety valves',
        function: 'relieving',
        port: 'safetyOutlet',
        aspects: [
          aspect('position', { variable: 'safetyValvesLiftFraction', reading: 'value' }),
          aspect('throughput', { variable: 'safetyValveFlowKgPerS', reading: 'flow' }),
        ],
        variables: ['safetyValvesLiftFraction', 'safetyValvesOpen', 'safetyValveFlowKgPerS'],
      }],
      ratedOutflow: [{ port: 'reliefOutlet', parameter: 'reliefCapacityKgPerS' }, { port: 'safetyOutlet', parameter: 'safetyValvesCapacityKgPerS' }],
    }),
    variables: [
      variable({ path: 'pressureMPa', label: 'Pressurizer pressure', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'levelPercent', label: 'Pressurizer level', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      variable({ path: 'waterInventoryKg', label: 'Pressurizer water inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'steamMassKg', label: 'Pressurizer steam mass', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'steamMassFlowKgPerS', label: 'Pressurizer steam net mass flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
      variable({ path: 'steamVolumeM3', label: 'Pressurizer steam volume', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'volume', unit: 'm3' }),
      variable({ path: 'flashingRateKgPerS', label: 'Pressurizer flashing rate', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'flowRateDelta', unit: 'kg/s' }),
      variable({ path: 'compressedWaterVolumeM3', label: 'Reactor coolant compressed beyond its room', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'volume', unit: 'm3' }),
      variable({ path: 'waterInventoryBalanceResidualKg', label: 'Pressurizer water inventory balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg' }),
      variable({ path: 'steamMassBalanceResidualKg', label: 'Pressurizer steam mass balance residual', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'massDelta', unit: 'kg' }),
      variable({ path: 'waterTemperatureC', label: 'Pressurizer water temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'steamTemperatureC', label: 'Pressurizer steam temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'heaterPowerMw', label: 'Pressurizer heater power', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'power', unit: 'MW', limits: { hardRange: { min: 0, max: 30 } } }),
      variable({ path: 'demandMw', label: 'Pressurizer electrical demand', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'sprayFlowKgPerS', label: 'Pressurizer spray flow', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'flowRate', unit: 'kg/s', limits: { hardRange: { min: 0, max: 250 } } }),
      variable({ path: 'reliefValvePositionFraction', label: 'Pressurizer relief valve position demand', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'reliefValveFailureActive', label: 'Pressurizer relief valve failure active', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'reliefValveFailedPositionFraction', label: 'Pressurizer relief valve failed position', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'reliefValveEffectivePositionFraction', label: 'Pressurizer relief valve effective position', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'reliefFlowKgPerS', label: 'Pressurizer relief flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'blockValvePositionFraction', label: 'Pressurizer PORV block valve position command', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', measurand: 'position', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1 } } }),
      variable({ path: 'blockValveEffectivePositionFraction', label: 'Pressurizer PORV block valve position', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'safetyValvesOpen', label: 'Pressurizer code safety valves open', kind: 'state', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'safetyValvesLiftFraction', label: 'Pressurizer code safety valve lift', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'safetyValveFlowKgPerS', label: 'Pressurizer code safety valve flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
    ],
  }),
]
