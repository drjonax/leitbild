import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

const positivePower = z.number().finite().positive()
const nonnegativePower = z.number().finite().nonnegative()

// A boundary source (the offsite grid) sets its own energized state and voltage: they are written from outside the Plant.
const energizedVariables = (
  labelPrefix: string,
  voltageConfig: { readonly kind?: 'state' | 'derived' | 'control'; readonly writable?: boolean } = {},
) => [
  variable({ path: 'energized', label: `${labelPrefix} energized`, kind: 'state', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
  variable({ path: 'availablePowerMw', label: `${labelPrefix} available power`, kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
  variable({
    path: 'voltageFraction',
    label: `${labelPrefix} voltage`,
    kind: voltageConfig.kind ?? 'derived',
    discipline: 'electrical',
    writable: voltageConfig.writable ?? false,
    publish: 'telemetry',
    ...(voltageConfig.writable === true ? { actuation: 'boundary' as const } : {}),
    measurand: 'voltage',
    quantity: 'ratio',
    unit: 'fraction',
    limits: { hardRange: { min: 0, max: 1.2 } },
  }),
]

export const electricalComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'electricalGridSource' as ComponentKind,
    label: 'Electrical Grid Source',
    ports: {
      outlet: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      initialAvailable: z.boolean().optional(),
      initialVoltageFraction: z.number().finite().min(0).max(1.2).optional(),
      initialFrequencyHz: z.number().finite().positive().optional(),
      externalPortId: z.string().min(1).optional(),
      nominalVoltageKv: z.number().finite().positive().optional(),
      maximumExportMw: z.number().finite().nonnegative().optional(),
      maximumImportMw: z.number().finite().nonnegative().optional(),
      generatorInertiaSeconds: z.number().finite().nonnegative().optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      variable({ path: 'available', label: 'Grid source available', kind: 'control', discipline: 'electrical', writable: true, publish: 'telemetry', actuation: 'boundary', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'frequencyHz', label: 'Grid frequency', kind: 'control', discipline: 'electrical', writable: true, publish: 'telemetry', actuation: 'boundary', quantity: 'frequency', unit: 'Hz', limits: { hardRange: { min: 0, max: 70 } } }),
      ...energizedVariables('Grid source', { kind: 'control', writable: true }),
    ],
  }),
  defineComponent({
    kind: 'electricalBus' as ComponentKind,
    label: 'Electrical Bus',
    ports: {
      inlet: { kind: 'electricalAc', direction: 'in', circuit: 'power' },
      outlet: { kind: 'electricalAc', direction: 'out', circuit: 'power' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      initialEnergized: z.boolean().optional(),
      degradedVoltageFraction: z.number().finite().min(0).max(1.2).optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      ...energizedVariables('Electrical bus'),
      variable({ path: 'servedLoadMw', label: 'Bus served load', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'marginMw', label: 'Bus power margin', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW' }),
      variable({ path: 'degraded', label: 'Bus degraded voltage', kind: 'derived', discipline: 'electrical', writable: false, publish: 'alarm', quantity: 'boolean', unit: 'boolean' }),
    ],
  }),
  defineComponent({
    kind: 'electricalBreaker' as ComponentKind,
    label: 'Electrical Breaker',
    ports: {
      inlet: { kind: 'electricalAc', direction: 'in', circuit: 'power' },
      outlet: { kind: 'electricalAc', direction: 'out', circuit: 'power' },
      tripSignal: { kind: 'logicSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      initialClosed: z.boolean().optional(),
      initialTripped: z.boolean().optional(),
      degradedVoltageTripFraction: z.number().finite().min(0).max(1.2).optional(),
    }).strict(),
    // Its contacts are closed while it is commanded closed and not tripped.
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' }), aspect('position', { variable: 'closedState', reading: 'closedWhileTrue' }, 'closed')] }),
    variables: [
      variable({ path: 'closed', label: 'Breaker close command', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'tripped', label: 'Breaker tripped', kind: 'discrete', discipline: 'control', writable: true, publish: 'alarm', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'closedState', label: 'Breaker closed', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      ...energizedVariables('Breaker outlet'),
    ],
  }),
  defineComponent({
    kind: 'electricalTransformer' as ComponentKind,
    label: 'Electrical Transformer',
    ports: {
      primary: { kind: 'electricalAc', direction: 'in', circuit: 'power' },
      secondary: { kind: 'electricalAc', direction: 'out', circuit: 'power' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      efficiencyFraction: normalized.optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      ...energizedVariables('Transformer secondary'),
      variable({ path: 'loadMw', label: 'Transformer load', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
    ],
  }),
  defineComponent({
    kind: 'dieselGenerator' as ComponentKind,
    label: 'Diesel Generator',
    ports: {
      outlet: { kind: 'electricalAc', direction: 'out' },
      startSignal: { kind: 'logicSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      startDelayS: z.number().finite().nonnegative().optional(),
      initialRunning: z.boolean().optional(),
      initialAvailable: z.boolean().optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('running', { variable: 'running', reading: 'true' }, 'startCommand'), aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      variable({ path: 'startCommand', label: 'Diesel start command', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'available', label: 'Diesel available', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'running', label: 'Diesel running', kind: 'state', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'startElapsedS', label: 'Diesel start elapsed time', kind: 'state', discipline: 'control', writable: false, publish: 'internal', quantity: 'time', unit: 's' }),
      ...energizedVariables('Diesel generator'),
    ],
  }),
  defineComponent({
    kind: 'battery' as ComponentKind,
    label: 'Battery',
    ports: {
      outlet: { kind: 'electricalAc', direction: 'out' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      nominalVoltageVdc: z.number().finite().positive().optional(),
      dischargeTimeS: z.number().finite().positive(),
      initialStateOfChargeFraction: normalized.optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      variable({ path: 'stateOfChargeFraction', label: 'Battery state of charge', kind: 'state', discipline: 'electrical', writable: false, publish: 'telemetry', measurand: 'charge', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'voltageVdc', label: 'Battery DC voltage', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'voltage', unit: 'volts_dc' }),
      ...energizedVariables('Battery'),
    ],
  }),
  defineComponent({
    kind: 'inverter' as ComponentKind,
    label: 'Inverter',
    ports: {
      dcInlet: { kind: 'electricalAc', direction: 'in', circuit: 'power' },
      acOutlet: { kind: 'electricalAc', direction: 'out', circuit: 'power' },
    },
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      efficiencyFraction: normalized.optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      ...energizedVariables('Inverter output'),
    ],
  }),
  defineComponent({
    kind: 'electricalLoad' as ComponentKind,
    label: 'Electrical Load',
    ports: {
      power: { kind: 'electricalAc', direction: 'in' },
    },
    parametersSchema: z.object({
      nominalLoadMw: nonnegativePower,
      essential: z.boolean().optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      variable({ path: 'demandMw', label: 'Load demand', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'servedMw', label: 'Load served', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'servedFraction', label: 'Load served fraction', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', measurand: 'served', quantity: 'ratio', unit: 'fraction' }),
      variable({ path: 'energized', label: 'Load energized', kind: 'state', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
    ],
  }),
]
