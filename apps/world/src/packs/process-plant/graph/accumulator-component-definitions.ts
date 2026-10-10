import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

export const accumulatorComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'accumulator' as ComponentKind,
    label: 'Accumulator',
    ports: {
      outlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'injection' },
      fill: { kind: 'hydraulicThermal', direction: 'in', circuit: 'injection' },
      gasCharge: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      totalVolumeM3: z.number().finite().positive(),
      initialLiquidInventoryKg: z.number().finite().nonnegative(),
      liquidDensityKgPerM3: z.number().finite().positive().optional(),
      initialGasPressureMPa: z.number().finite().positive(),
      gasPolytropicExponent: z.number().finite().min(1).max(2).optional(),
      injectionSetpointMPa: z.number().finite().positive(),
      outletCvKgPerSPerSqrtMPa: z.number().finite().nonnegative(),
      minimumUsableInventoryKg: z.number().finite().nonnegative().optional(),
      checkValveEnabled: z.boolean().optional(),
      initialDischargeIsolationOpen: z.boolean().optional(),
      initialTemperatureC: z.number().finite().optional(),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['gasPressureMPa'],
      aspects: [aspect('throughput', { variable: 'outletFlowKgPerS', reading: 'flow' })],
      // The discharge isolation valve and the check valve are modelled inside the accumulator, on its outlet.
      embedded: [
        // Its position is not solved: what leaves the accumulator judges it.
        { id: 'dischargeIsolationValve', label: 'discharge isolation valve', function: 'isolating', port: 'outlet', aspects: [aspect('position', undefined, 'dischargeIsolationOpen'), aspect('throughput', { variable: 'outletFlowKgPerS', reading: 'flow' })], variables: ['dischargeIsolationOpen'] },
        { id: 'checkValve', label: 'check valve', function: 'nonReturn', port: 'outlet', aspects: [aspect('position', { variable: 'checkValveOpenFraction', reading: 'value' })], variables: ['checkValveOpenFraction'] },
      ],
    }),
    variables: [
      variable({ path: 'dischargeIsolationOpen', label: 'Accumulator discharge isolation open command', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'liquidInventoryKg', label: 'Accumulator liquid inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
      variable({ path: 'gasVolumeM3', label: 'Accumulator gas volume', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'volume', unit: 'm3' }),
      variable({ path: 'gasPressureMPa', label: 'Accumulator gas pressure', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'outletFlowKgPerS', label: 'Accumulator outlet flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'fillFlowKgPerS', label: 'Accumulator fill flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'availableInjectionHeadMPa', label: 'Accumulator available injection head', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressureDelta', unit: 'MPa' }),
      variable({ path: 'depletedFraction', label: 'Accumulator depleted fraction', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'depletion', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'checkValveOpenFraction', label: 'Accumulator check valve open fraction', kind: 'derived', discipline: 'control', writable: false, publish: 'telemetry', measurand: 'position', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'temperatureC', label: 'Accumulator liquid temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
    ],
  }),
]
