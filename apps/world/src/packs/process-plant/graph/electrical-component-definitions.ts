import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import type { CompiledComponent, ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, normalized, variable } from './component-definition-helpers.ts'
import { aspect, fixedSemantics } from './semantics.ts'

const positivePower = z.number().finite().positive()
const nonnegativePower = z.number().finite().nonnegative()
const positive = z.number().finite().positive()
const nonnegative = z.number().finite().nonnegative()

/**
 * How a diesel answers a block of load picked up at once: its frequency and
 * voltage dip by these fractions of rated per its rated load in the block,
 * and its governor and voltage regulator restore them with the time constant.
 */
const dieselLoadResponseSchema = z.object({
  frequencyDipPerRatedLoad: nonnegative,
  voltageDipPerRatedLoad: nonnegative,
  recoveryTimeConstantS: positive,
}).strict()

export type DieselLoadResponse = z.infer<typeof dieselLoadResponseSchema>

const loadResponseByComponent = new WeakMap<CompiledComponent, DieselLoadResponse>()

/** A diesel generator's load response, as its parameters declare it. */
export const dieselLoadResponse = (component: CompiledComponent): DieselLoadResponse => {
  const cached = loadResponseByComponent.get(component)
  if (cached !== undefined) return cached
  const parsed = dieselLoadResponseSchema.parse((component.parameters as Readonly<Record<string, unknown>>).loadResponse)
  loadResponseByComponent.set(component, parsed)
  return parsed
}

// A boundary source (the offsite grid) sets its own energized state and voltage: they are written from outside the Plant.
const energizedVariables = (
  labelPrefix: string,
  voltageConfig: { readonly kind?: 'state' | 'derived' | 'control'; readonly writable?: boolean } = {},
) => [
  variable({ path: 'energized', label: `${labelPrefix} energized`, kind: 'state', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
  variable({ path: 'availablePowerMw', label: `${labelPrefix} available power`, kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW', simulatorOnly: true }),
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
    semantics: fixedSemantics({
      aspects: [aspect('energized', { variable: 'energized', reading: 'true' })],
      // The grid's own voltage and frequency are measured on the live grid: with the grid lost or the Plant
      // isolated from it there is none to measure, whatever numbers the boundary last held. The supply voltage
      // the relays read is the Plant's side, and reads none then.
      meaningfulWhile: [{ flag: 'energized', variables: ['frequencyHz', 'voltageFraction'] }],
    }),
    variables: [
      variable({ path: 'available', label: 'Grid source available', kind: 'control', discipline: 'electrical', writable: true, publish: 'telemetry', actuation: 'boundary', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'frequencyHz', label: 'Grid frequency', kind: 'control', discipline: 'electrical', writable: true, publish: 'telemetry', actuation: 'boundary', quantity: 'frequency', unit: 'Hz', limits: { hardRange: { min: 0, max: 70 } } }),
      ...energizedVariables('Grid source', { kind: 'control', writable: true }),
      // What the Plant's undervoltage relays read on the offsite supply: the grid's voltage while it is available,
      // none while it is lost. Declared last, so the variables before it keep their places.
      variable({ path: 'supplyVoltageFraction', label: 'Offsite supply voltage', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', measurand: 'voltage', quantity: 'ratio', unit: 'fraction', limits: { hardRange: { min: 0, max: 1.2 } } }),
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
      /** The voltage its voltmeter reads where its voltage fraction is 1. */
      nominalVoltageKv: positive,
      initialEnergized: z.boolean().optional(),
      degradedVoltageFraction: z.number().finite().min(0).max(1.2).optional(),
    }).strict(),
    // Its voltage, in kilovolts as its voltmeter reads it, is what an
    // operator reads on it first; its undervoltage relays read the same
    // voltage as a fraction of nominal. Its frequency is its supply's: the
    // grid's, or its diesel's (the diesel generator's frequency).
    semantics: fixedSemantics({ keyValues: ['voltageKv'], aspects: [aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      ...energizedVariables('Electrical bus'),
      variable({ path: 'voltageKv', label: 'Bus voltage', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'voltage', unit: 'kV' }),
      variable({ path: 'servedLoadMw', label: 'Bus served load', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'marginMw', label: 'Bus power margin', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'powerDelta', unit: 'MW', simulatorOnly: true }),
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
    // A standby diesel comes up to rated speed and voltage in its start time,
    // its frequency and voltage building with its speed: the standard
    // technical specifications ask for rated voltage and frequency within
    // 10 s of a start signal (NUREG-1431, SR 3.8.1.7). Each block of load
    // its load sequencer closes onto it dips its frequency and voltage, which
    // its governor and voltage regulator restore: Regulatory Guide 1.9
    // (Rev. 4) holds the dips above 95 % of rated frequency and 75 % of rated
    // voltage and asks for recovery to within 2 % and 10 % of rated in 60 %
    // of the load-sequence interval. Its load is what the bus its closed
    // breaker feeds serves, shared with any other live supply of that bus.
    parametersSchema: z.object({
      nominalPowerMw: positivePower,
      /** Rated terminal voltage, which its voltage regulator holds. */
      nominalVoltageKv: positive,
      /** Rated frequency, which its governor holds. */
      nominalFrequencyHz: positive,
      startDelayS: z.number().finite().nonnegative().optional(),
      initialRunning: z.boolean().optional(),
      initialAvailable: z.boolean().optional(),
      loadResponse: dieselLoadResponseSchema,
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['outputKw'], aspects: [aspect('running', { variable: 'running', reading: 'true' }, 'startCommand'), aspect('energized', { variable: 'energized', reading: 'true' })] }),
    variables: [
      variable({ path: 'startCommand', label: 'Diesel start command', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'available', label: 'Diesel available', kind: 'control', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'faultInjection', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'running', label: 'Diesel running', kind: 'state', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'startElapsedS', label: 'Diesel start elapsed time', kind: 'state', discipline: 'control', writable: false, publish: 'internal', quantity: 'time', unit: 's' }),
      ...energizedVariables('Diesel generator'),
      variable({ path: 'outputKw', label: 'Diesel generator load', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'kW' }),
      variable({ path: 'terminalVoltageKv', label: 'Diesel generator voltage', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'voltage', unit: 'kV' }),
      variable({ path: 'frequencyHz', label: 'Diesel generator frequency', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'frequency', unit: 'Hz' }),
      // The dips a block of load leaves in its frequency and voltage, in percent of rated, until they are restored.
      variable({ path: 'frequencyDeviationPercent', label: 'Diesel generator frequency deviation', kind: 'state', discipline: 'control', writable: false, publish: 'internal', measurand: 'speed', quantity: 'ratio', unit: 'percent', limits: { hardRange: { min: -50, max: 50 } } }),
      variable({ path: 'voltageDeviationPercent', label: 'Diesel generator voltage deviation', kind: 'state', discipline: 'control', writable: false, publish: 'internal', measurand: 'voltage', quantity: 'ratio', unit: 'percent', limits: { hardRange: { min: -50, max: 50 } } }),
    ],
  }),
  defineComponent({
    kind: 'loadSequencer' as ComponentKind,
    label: 'Load Sequencer',
    // A safety bus's load sequencer. Once its bus comes back after a loss of
    // power it steps through its load blocks, one each step interval: step 1
    // as the bus is re-energized, step 2 an interval later, on to its last
    // step, where it stays until the bus is lost again. Step 0 is a bus not
    // lost since the Run began, or lost and still dead. The I&C closes each
    // block's loads at its step; the sequencer only counts.
    ports: {},
    parametersSchema: z.object({
      /** The bus it sequences. */
      bus: idSchema,
      stepIntervalS: positive,
      stepCount: z.number().int().positive(),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['step'] }),
    variables: [
      variable({ path: 'step', label: 'Load sequencer step', kind: 'state', discipline: 'control', writable: false, publish: 'telemetry', quantity: 'count', unit: 'count' }),
      variable({ path: 'armed', label: 'Load sequencer armed by a loss of bus power', kind: 'state', discipline: 'control', writable: false, publish: 'internal', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'elapsedS', label: 'Time since the sequenced bus came back', kind: 'state', discipline: 'control', writable: false, publish: 'internal', quantity: 'time', unit: 's' }),
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
    // A load on its own feeder breaker: it draws its load only while the
    // breaker is closed, as a load sequencer sheds and recloses it.
    parametersSchema: z.object({
      nominalLoadMw: nonnegativePower,
      essential: z.boolean().optional(),
      initialConnected: z.boolean().optional(),
    }).strict(),
    semantics: fixedSemantics({ aspects: [aspect('energized', { variable: 'energized', reading: 'true' }, 'connected')] }),
    variables: [
      variable({ path: 'connected', label: 'Load feeder breaker close command', kind: 'discrete', discipline: 'control', writable: true, publish: 'telemetry', actuation: 'command', quantity: 'boolean', unit: 'boolean' }),
      variable({ path: 'demandMw', label: 'Load demand', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'servedMw', label: 'Load served', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'power', unit: 'MW' }),
      variable({ path: 'servedFraction', label: 'Load served fraction', kind: 'derived', discipline: 'electrical', writable: false, publish: 'telemetry', measurand: 'served', quantity: 'ratio', unit: 'fraction', simulatorOnly: true }),
      variable({ path: 'energized', label: 'Load energized', kind: 'state', discipline: 'electrical', writable: false, publish: 'telemetry', quantity: 'boolean', unit: 'boolean' }),
    ],
  }),
]
