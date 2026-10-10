import { z } from 'zod'
import type { LocalVariablePath, PortName, ProcessQuantity, ProcessUnit, VariablePath } from './model.ts'

// Model semantics: what equipment is and does, declared once per component
// kind beside its behaviour and never repeated per Plant instance. They are
// model truth for every reader (command validation, explanations, generated
// displays) and are not part of a Plant's identity: a Plant's digest covers its
// graph spec, not the declarations of its kinds.

/**
 * What writing a writable variable does:
 * - `command`: an operator or controller demand the equipment may not follow
 *   (a pump commanded to run that has lost power);
 * - `faultInjection`: a scenario knob that makes the model fail;
 * - `boundary`: a condition outside the Plant (the offsite grid, a makeup supply).
 */
export const variableActuationSchema = z.enum(['command', 'faultInjection', 'boundary'])
export type VariableActuation = z.infer<typeof variableActuationSchema>

/** What a ratio measures, so a reader can name it ("L LO" for a level). */
export const ratioMeasurandSchema = z.enum([
  'availability',
  'charge',
  'contamination',
  'coverage',
  'depletion',
  'effectiveness',
  'humidity',
  'insertion',
  'leak',
  'level',
  'load',
  'position',
  'quality',
  'served',
  'speed',
  'void',
  'voltage',
])
export type RatioMeasurand = z.infer<typeof ratioMeasurandSchema>

/** The aspects of equipment state an operator reads at a glance. */
export const stateAspectSchema = z.enum(['running', 'position', 'level', 'throughput', 'energized'])
export type StateAspect = z.infer<typeof stateAspectSchema>

/**
 * How a state variable reads as its aspect: running while a speed is above
 * zero, energized or running while true, a position or level as its value,
 * throughput while a flow is above the no-flow band of its rated flow, and a
 * switching position (a breaker's contacts) closed while true.
 */
export const aspectReadingSchema = z.enum(['aboveZero', 'true', 'value', 'flow', 'closedWhileTrue'])
export type AspectReading = z.infer<typeof aspectReadingSchema>

/** What equipment does where its kind alone does not say: a valve modulates, isolates, stops reverse flow or relieves. */
export const equipmentFunctionSchema = z.enum(['modulating', 'isolating', 'nonReturn', 'relieving'])
export type EquipmentFunction = z.infer<typeof equipmentFunctionSchema>

export interface StateAspectDeclaration {
  readonly aspect: StateAspect
  /**
   * The solved variable that is the equipment's state for this aspect. Absent
   * when the model computes none (an accumulator's discharge isolation valve
   * follows its command at once), so the aspect reads "not measured" and is
   * judged by what the model does solve.
   */
  readonly state?: { readonly variable: LocalVariablePath; readonly reading: AspectReading }
  /**
   * The writable variable that demands this aspect. It only annotates a
   * disagreement, never the state. A boolean command of a position read
   * `closedWhileTrue` commands closed while true, as its state reads.
   */
  readonly command?: LocalVariablePath
}

/** Equipment the model bundles inside a component; it sits on the link that leaves one of the component's ports. */
export interface EmbeddedDeviceDeclaration {
  readonly id: string
  /** Generic name of the device ("relief valve"); a Plant may give it a short operator label. */
  readonly label: string
  readonly function: EquipmentFunction
  readonly port: string
  readonly aspects: ReadonlyArray<StateAspectDeclaration>
  /** The host's variables that belong to the device: their alarms concern the device, not the host. */
  readonly variables: ReadonlyArray<string>
}

/**
 * Where equipment puts energy into, moves it between, or takes it out of the
 * fluid of its port circuits: a reactor core heats its coolant (`source`), a
 * steam generator moves heat from its primary circuit to its secondary
 * (`transfer`), a turbine takes work out of its steam (`sink`). Readers
 * follow the energy from source to sink without knowing any kind.
 */
export type EnergyRole =
  /** `rate`: the variable that measures the energy it puts in (a core's thermal power). */
  | { readonly role: 'source'; readonly circuit: string; readonly rate: string }
  | { readonly role: 'transfer'; readonly from: string; readonly to: string }
  /** `rate`: the variable that measures the energy it takes out (a generator's electrical output). */
  | { readonly role: 'sink'; readonly circuit: string; readonly rate: string }

export interface ComponentSemantics {
  readonly function?: EquipmentFunction
  readonly aspects: ReadonlyArray<StateAspectDeclaration>
  readonly embedded: ReadonlyArray<EmbeddedDeviceDeclaration>
  /** Rated flow out of a port, named by the parameter that holds it: the reference for "no flow" on the links it feeds. */
  readonly ratedOutflow: ReadonlyArray<{ readonly port: string; readonly parameter: string }>
  /** The values an operator reads first on this equipment (a pressurizer's pressure and level), most important first. */
  readonly keyValues: ReadonlyArray<string>
  /** What the equipment does with energy, by port circuit. */
  readonly energy: ReadonlyArray<EnergyRole>
}

/** Declares semantics that do not depend on a component's parameters. */
export const fixedSemantics = (semantics: Partial<ComponentSemantics>): ((parameters: unknown) => ComponentSemantics) => {
  const resolved: ComponentSemantics = { aspects: [], embedded: [], ratedOutflow: [], keyValues: [], energy: [], ...semantics }
  return () => resolved
}

/** A state aspect read from a solved variable, with the command that demands it. */
export const aspect = (
  name: StateAspect,
  state: { readonly variable: string; readonly reading: AspectReading } | undefined,
  command?: string,
): StateAspectDeclaration => ({
  aspect: name,
  ...(state === undefined ? {} : { state: { variable: state.variable as LocalVariablePath, reading: state.reading } }),
  ...(command === undefined ? {} : { command: command as LocalVariablePath }),
})

export interface CompiledStateAspect {
  readonly aspect: StateAspect
  readonly state?: { readonly path: VariablePath; readonly reading: AspectReading }
  readonly command?: VariablePath
}

export interface CompiledEmbeddedDevice {
  readonly id: string
  readonly label: string
  readonly function: EquipmentFunction
  readonly port: PortName
  readonly aspects: ReadonlyArray<CompiledStateAspect>
  readonly variables: ReadonlyArray<VariablePath>
}

export interface CompiledComponentSemantics {
  readonly function?: EquipmentFunction
  readonly aspects: ReadonlyArray<CompiledStateAspect>
  readonly embedded: ReadonlyArray<CompiledEmbeddedDevice>
  readonly ratedOutflow: ReadonlyArray<{ readonly port: PortName; readonly flowKgPerS: number }>
  readonly keyValues: ReadonlyArray<VariablePath>
  readonly energy: ReadonlyArray<CompiledEnergyRole>
}

/** An energy role with its rate as the full variable path. */
export type CompiledEnergyRole =
  | { readonly role: 'source'; readonly circuit: string; readonly rate: VariablePath }
  | { readonly role: 'transfer'; readonly from: string; readonly to: string }
  | { readonly role: 'sink'; readonly circuit: string; readonly rate: VariablePath }

/** Which quantities and units each reading accepts. */
export const readingAccepts = (reading: AspectReading, descriptor: { readonly quantity: ProcessQuantity; readonly unit: ProcessUnit }): boolean => {
  if (reading === 'true' || reading === 'closedWhileTrue') return descriptor.quantity === 'boolean'
  if (reading === 'flow') return descriptor.quantity === 'flowRate'
  if (reading === 'aboveZero') return descriptor.quantity === 'rotationalSpeed' || descriptor.quantity === 'flowRate' || descriptor.quantity === 'power'
  return descriptor.quantity === 'ratio'
}
