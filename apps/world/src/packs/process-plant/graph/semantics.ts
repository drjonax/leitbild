import { z } from 'zod'
import type { CompiledComponent, CompiledPlantGraph, LocalVariablePath, PortName, ProcessQuantity, ProcessUnit, VariablePath } from './model.ts'

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
  'flow',
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
   *
   * Read through a port (`via`), it is the variable of the component at the
   * far end of that port's one link: a core's level is the coolant level the
   * vessel it heats computes. A port the Plant leaves unconnected reaches
   * none, so the aspect is not the Plant's. Such a state is another
   * component's, so the aspect has no command or isolation input.
   */
  readonly state?: { readonly variable: LocalVariablePath; readonly reading: AspectReading; readonly via?: string }
  /**
   * The writable variable that demands this aspect. It only annotates a
   * disagreement, never the state. A boolean command of a position read
   * `closedWhileTrue` commands closed while true, as its state reads.
   */
  readonly command?: LocalVariablePath
  /**
   * A boolean engineered safety features input that drives a position shut
   * while it stands, whatever its command demands (feedwater isolation on a
   * feed regulating valve). An automatic action that sets it moves the
   * equipment as one that writes its command does.
   */
  readonly isolation?: LocalVariablePath
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
  /**
   * Solved flows that are the whole flow through one of its ports, every link
   * on that port together: a steam generator's feedwater inflow is what its
   * main and auxiliary feed lines bring in through its feedwater inlet. A link
   * alone on such a port carries the same flow; one of several carries part of
   * it. (A bundled device's throughput is the flow through its port too.)
   */
  readonly portFlows: ReadonlyArray<{ readonly port: string; readonly variable: string }>
  /** The values an operator reads first on this equipment (a pressurizer's pressure and level), most important first. */
  readonly keyValues: ReadonlyArray<string>
  /**
   * Readings that measure something only while a solved flag of the same
   * equipment reads true: a source-range detector counts only while its high
   * voltage is on, and reads a zero that measures nothing while it is off.
   */
  readonly meaningfulWhile: ReadonlyArray<{ readonly flag: string; readonly variables: ReadonlyArray<string> }>
  /**
   * Permissives the equipment derives from what it measures (a power range
   * above P-10, a pressurizer pressure below P-11): solved flags that let
   * protection be blocked or enable it, read by the logic that uses them,
   * not values a display leads with.
   */
  readonly permissives: ReadonlyArray<string>
  /**
   * One quantity read by two instruments, the second over a wider span (a
   * steam generator's narrow-range level and its wide-range level from the
   * tube sheet): where the first stands at an end of its span, or while a
   * flag says so (`while`), the second says where the quantity is.
   */
  readonly widerRanges: ReadonlyArray<WiderRangeDeclaration>
  /**
   * A reading's program: the value the Plant's control holds it to (`program`),
   * and how far it stands from it (`deviation`), both the equipment's own. The
   * reading is the equipment's own (a pressurizer's level, held to its level
   * program), or that of the component at the far end of one of its ports
   * (`via`): a core programs the average coolant temperature its vessel reads.
   */
  readonly programs: ReadonlyArray<ProgramDeclaration>
  /**
   * Readings that say the equipment has stopped, verified after a reactor
   * trip: a core's power-range flux, its startup rate and its rod bottom
   * indication. A permissive it derives (P-6) says what protection may do,
   * not that it stopped.
   */
  readonly shutdownReadings: ReadonlyArray<string>
  /** What the equipment does with energy, by port circuit. */
  readonly energy: ReadonlyArray<EnergyRole>
}

export interface ProgramDeclaration {
  readonly reading: string
  /** The port whose one link reaches the component that reads it; absent where the equipment reads it itself. */
  readonly via?: string
  readonly program: string
  readonly deviation?: string
}

/**
 * A reading and the instrument that reads its quantity over a wider span.
 * Each reading has at most one, and the ranges chain without coming back to
 * a reading, so a reader can follow them from the narrowest instrument out.
 */
export interface WiderRangeDeclaration {
  readonly reading: string
  readonly wider: string
  /**
   * A solved flag of the same equipment that says when the wider instrument
   * reads the quantity: while it reads true, the wider one says where the
   * quantity is, whatever the first reads. Such a pair may measure the
   * quantity in different units: a core's neutron flux, counted by its source
   * range, is read as a current by its intermediate range while P-6 holds,
   * and as percent of rated power by its power range while P-10 does.
   * Absent, the wider instrument reads where the first stands at an end of
   * its span, in the same unit.
   */
  readonly while?: string
}

/** Declares semantics that do not depend on a component's parameters. */
export const fixedSemantics = (semantics: Partial<ComponentSemantics>): ((parameters: unknown) => ComponentSemantics) => {
  const resolved: ComponentSemantics = { aspects: [], embedded: [], ratedOutflow: [], portFlows: [], keyValues: [], meaningfulWhile: [], permissives: [], widerRanges: [], programs: [], shutdownReadings: [], energy: [], ...semantics }
  return () => resolved
}

/**
 * A state aspect read from a solved variable (of the component on a port's
 * one link, `via` that port), with the command that demands it and the
 * isolation input that overrides it.
 */
export const aspect = (
  name: StateAspect,
  state: { readonly variable: string; readonly reading: AspectReading; readonly via?: string } | undefined,
  command?: string,
  isolation?: string,
): StateAspectDeclaration => ({
  aspect: name,
  ...(state === undefined ? {} : { state: { variable: state.variable as LocalVariablePath, reading: state.reading, ...(state.via === undefined ? {} : { via: state.via }) } }),
  ...(command === undefined ? {} : { command: command as LocalVariablePath }),
  ...(isolation === undefined ? {} : { isolation: isolation as LocalVariablePath }),
})

export interface CompiledStateAspect {
  readonly aspect: StateAspect
  readonly state?: { readonly path: VariablePath; readonly reading: AspectReading }
  readonly command?: VariablePath
  readonly isolation?: VariablePath
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
  readonly portFlows: ReadonlyArray<{ readonly port: PortName; readonly path: VariablePath }>
  readonly keyValues: ReadonlyArray<VariablePath>
  readonly meaningfulWhile: ReadonlyArray<{ readonly flag: VariablePath; readonly variables: ReadonlyArray<VariablePath> }>
  readonly permissives: ReadonlyArray<VariablePath>
  readonly widerRanges: ReadonlyArray<{ readonly reading: VariablePath; readonly wider: VariablePath; readonly while?: VariablePath }>
  readonly programs: ReadonlyArray<{ readonly reading: VariablePath; readonly program: VariablePath; readonly deviation?: VariablePath }>
  readonly shutdownReadings: ReadonlyArray<VariablePath>
  readonly energy: ReadonlyArray<CompiledEnergyRole>
}

/** An energy role with its rate as the full variable path. */
export type CompiledEnergyRole =
  | { readonly role: 'source'; readonly circuit: string; readonly rate: VariablePath }
  | { readonly role: 'transfer'; readonly from: string; readonly to: string }
  | { readonly role: 'sink'; readonly circuit: string; readonly rate: VariablePath }

/** Equipment at one end of a Plant's energy path, with the circuit it heats or works and the variable that measures the rate. */
export interface EnergyEnd {
  readonly component: CompiledComponent
  readonly role: 'source' | 'sink'
  readonly circuit: string
  readonly rate: VariablePath
}

/**
 * The equipment a Plant's energy starts at and ends in, as their kinds
 * declare it: its sources first (a reactor core heating its coolant), then
 * its sinks (a turbine taking work out of its steam), each in component
 * order. Readers that treat the ends apart (a faceplate for each) find them
 * here without naming a kind.
 */
export const energyEnds = (graph: Pick<CompiledPlantGraph, 'components'>): ReadonlyArray<EnergyEnd> => {
  const ends = graph.components.flatMap(component => component.semantics.energy.flatMap((role): ReadonlyArray<EnergyEnd> =>
    role.role === 'transfer' ? [] : [{ component, role: role.role, circuit: role.circuit, rate: role.rate }]))
  return [...ends.filter(end => end.role === 'source'), ...ends.filter(end => end.role === 'sink')]
}

/** Which quantities and units each reading accepts. */
export const readingAccepts = (reading: AspectReading, descriptor: { readonly quantity: ProcessQuantity; readonly unit: ProcessUnit }): boolean => {
  if (reading === 'true' || reading === 'closedWhileTrue') return descriptor.quantity === 'boolean'
  if (reading === 'flow') return descriptor.quantity === 'flowRate'
  if (reading === 'aboveZero') return descriptor.quantity === 'rotationalSpeed' || descriptor.quantity === 'flowRate' || descriptor.quantity === 'power'
  return descriptor.quantity === 'ratio'
}
