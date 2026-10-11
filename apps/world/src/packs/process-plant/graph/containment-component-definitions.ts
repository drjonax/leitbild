import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

export const containmentComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'containmentVolume' as ComponentKind,
    label: 'Containment Volume',
    ports: {
      massEnergyIn: { kind: 'hydraulicThermal', direction: 'in', circuit: 'volume' },
      steamIn: { kind: 'steam', direction: 'in', circuit: 'volume' },
      sprayIn: { kind: 'hydraulicThermal', direction: 'in', circuit: 'volume' },
      sumpOut: { kind: 'hydraulicThermal', direction: 'out', circuit: 'volume' },
      ventOut: { kind: 'steam', direction: 'out', circuit: 'volume' },
    },
    parametersSchema: z.object({
      freeVolumeM3: z.number().finite().positive(),
      initialPressureMPa: z.number().finite().positive().optional(),
      initialTemperatureC: z.number().finite().optional(),
      initialHumidityFraction: z.number().finite().min(0).max(1).optional(),
      initialSumpInventoryKg: z.number().finite().nonnegative().optional(),
      heatLossMwPerC: z.number().finite().nonnegative().optional(),
      designPressureMPa: z.number().finite().positive().optional(),
      sumpLevelReferenceInventoryKg: z.number().finite().positive().optional(),
      maxSumpOutflowKgPerS: z.number().finite().nonnegative().optional(),
      ventSetpointMPa: z.number().finite().positive().optional(),
      ventCapacityKgPerS: z.number().finite().nonnegative().optional(),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['pressureMPa', 'sumpLevelPercent'], aspects: [aspect('level', { variable: 'sumpLevelPercent', reading: 'value' })], ratedOutflow: [{ port: 'sumpOut', parameter: 'maxSumpOutflowKgPerS' }, { port: 'ventOut', parameter: 'ventCapacityKgPerS' }] }),
    variables: [
      variable({ path: 'atmosphereMassKg', label: 'Containment atmosphere mass', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'airMassKg', label: 'Containment air mass', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'steamMassKg', label: 'Containment steam mass', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'sumpInventoryKg', label: 'Containment sump inventory', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg', simulatorOnly: true }),
      variable({ path: 'sumpLevelPercent', label: 'Containment sump level', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', measurand: 'level', quantity: 'ratio', unit: 'percent' }),
      // A dry containment stands about atmospheric (0.101 MPa) in operation: from 4 kPa below it to 6 kPa above.
      variable({ path: 'pressureMPa', label: 'Containment pressure', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa', limits: { normalRange: { min: 0.097, max: 0.107 } } }),
      variable({ path: 'temperatureC', label: 'Containment temperature', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'temperature', unit: 'degC' }),
      variable({ path: 'humidityFraction', label: 'Containment humidity', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', measurand: 'humidity', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'incomingMassKgPerS', label: 'Containment incoming mass', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s', simulatorOnly: true }),
      variable({ path: 'sprayFlowKgPerS', label: 'Containment spray flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'releaseFlowKgPerS', label: 'Containment vent release flow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'sumpOutflowKgPerS', label: 'Containment sump outflow', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'heatRemovalMw', label: 'Containment heat removal', kind: 'derived', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW', simulatorOnly: true }),
      // What the containment's high-range radiation monitors read (CTMT-RAD), which its alarm and the containment
      // safety function judge.
      variable({ path: 'radiationSourceTermMSvPerH', label: 'Containment radiation source term', kind: 'state', discipline: 'radiological', writable: false, publish: 'telemetry', quantity: 'radiationDoseRate', unit: 'mSv/h' }),
      variable({ path: 'contaminationInventory', label: 'Containment contamination inventory', kind: 'state', discipline: 'radiological', writable: false, publish: 'telemetry', measurand: 'contamination', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
    ],
  }),
]
