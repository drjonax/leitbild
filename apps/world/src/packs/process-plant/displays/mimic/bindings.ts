import type {
  AspectReading,
  AspectTravel,
  CompiledComponent,
  CompiledInsertion,
  CompiledPlantGraph,
  CompiledStateAspect,
  ProcessSignalBinding,
  StateAspect,
  VariablePath,
} from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../../runtime/index.ts'
import { equipmentItemLabel, type EquipmentItem } from '../../equipment/items.ts'
import { NO_FLOW_FRACTION } from '../../equipment/link-flow.ts'
import { resolveProcessPlantSignalBinding } from '../../signals.ts'
import { actionOf, icRuleKind, icThresholdsForSignal } from '../../ic/thresholds.ts'
import { limitOrderName, thresholdName } from '../display-text.ts'

// What each drawn item shows and from which signals, all read from the model's
// declared semantics: no variable path is named here. State comes from solved
// signals only; a command only annotates a disagreement; an item is framed by
// the alarm rules that watch its own signals alone.

export const mimicItemKey = (item: EquipmentItem): string =>
  item.kind === 'component' ? `c${item.component}` : `c${item.component}:${item.device}`

export interface MimicStateBinding {
  readonly aspect: StateAspect
  /** The solved signal; absent when the model computes none, so the state reads "not measured". */
  readonly state?: { readonly path: VariablePath; readonly reading: AspectReading; readonly noFlowBelow?: number | null }
  /**
   * The words its equipment declares for an on/off state signal, which the
   * symbol says in place of the aspect's own: a turbine-generator running
   * on its output breaker reads ON LINE and OFF LINE, not RUN and STOP.
   */
  readonly words?: { readonly on: string; readonly off: string }
  readonly command?: VariablePath
  /**
   * How long the equipment takes to follow its command, toward its on state
   * and its off state, as the model declares it: a disagreement is judged
   * "not followed" only after it and a margin (evaluate.ts). Absent where the
   * model declares none: the state is awaited, never judged not followed.
   */
  readonly travel?: AspectTravel
  /**
   * A valve that isolates or relieves, which stands open or shut: a command
   * at either end of its travel reads OPEN or SHUT, as its position does,
   * never "100 %" (HMI review of run 26: MOV-8000A read "100 %" in one
   * place and "OPEN" in another).
   */
  readonly twoState?: true
  /** What passes the item, judging it where its own state is not solved. */
  readonly throughput?: { readonly path: VariablePath; readonly noFlowBelow: number | null }
}

/**
 * A value an operator reads on an item: with its unit, the span its
 * instrument indicates over (a reading at an end of it says only that the
 * quantity is there or beyond), and the instrument the equipment declares
 * reads the same quantity over a wider span (a steam generator's wide-range
 * level beside its narrow range), with that one's span.
 */
export interface MimicValueBinding {
  readonly path: VariablePath
  readonly unit: string
  /**
   * The quantity's letters, where a share of a whole does not say what it
   * measures: a bus's voltage reads "V 100 %" (HMI review of run 23: "100 %").
   * A vessel's level, which its symbol draws, needs none.
   */
  readonly letters?: string
  readonly span?: { readonly min: number; readonly max: number }
  readonly wider?: { readonly path: VariablePath; readonly span: { readonly min: number; readonly max: number } }
  /** What its instrument declares it reads over: its span, else its hard range (a device sizes its row for it). */
  readonly range?: { readonly min: number; readonly max: number }
}

/**
 * An on/off reading of its own that says the equipment has stopped (a core's
 * rods on bottom), among the readings its kind declares say so, in the words
 * its equipment declares for it; and what its protection commands it to stop
 * with: each command of its own a trip writes, and the value the trip writes.
 * Such a flag says the equipment stopped while it reads true.
 */
export interface MimicShutdownBinding {
  readonly path: VariablePath
  readonly words: { readonly on: string; readonly off: string }
  readonly demands: ReadonlyArray<{ readonly path: VariablePath; readonly value: number | boolean }>
}

/**
 * One quantity its instruments read in turn, each where the next wider one
 * does not (a core's neutron flux: counted by its source range, read as a
 * current by its intermediate range while P-6 holds and in percent by its
 * power range while P-10 does), narrowest first, as its equipment declares
 * them (flag-switched wider ranges).
 */
export interface MimicRangeBinding {
  readonly steps: ReadonlyArray<{
    readonly path: VariablePath
    readonly unit: string
    /** What it measures, where its unit does not say (a share: PWR for percent of rated power). */
    readonly letters?: string
    readonly span?: { readonly min: number; readonly max: number }
    /** A flag its reading measures something only while it reads true (meaningfulWhile). */
    readonly meaningful?: VariablePath
    /** The flag while which the next, wider instrument reads the quantity instead; absent on the widest. */
    readonly widerWhile?: VariablePath
  }>
}

export interface MimicItemBinding {
  readonly item: EquipmentItem
  /** The operator's short name. */
  readonly label: string
  readonly state: MimicStateBinding | null
  /** The values an operator reads first on it. */
  readonly values: ReadonlyArray<MimicValueBinding>
  /** The quantities it reads on instruments in turn (MimicRangeBinding). */
  readonly ranges: ReadonlyArray<MimicRangeBinding>
  /** What says it has stopped, as its shutdown readings declare it (MimicShutdownBinding). */
  readonly shutdown: ReadonlyArray<MimicShutdownBinding>
  /** I&C alarm and trip limits on its level, marked on the vessel. */
  readonly limits: ReadonlyArray<{ readonly value: number; readonly kind: 'alarm' | 'trip'; readonly name: string }>
  /**
   * Rules that frame it, each with the flap text that says what it watches
   * and does ("LO-LO · AFW START"), its two parts (`watches`, and `action`
   * where it names one), and the declared modes it alone acts in: outside
   * them it frames nothing, as its limit is drawn not in force on a trend.
   */
  readonly frames: ReadonlyArray<MimicFrame>
  /**
   * What it inserts, part by part, as its kind declares it (a core's rod
   * banks): each part's reading and the range it moves over, in its groups,
   * fully in at that range's `insertedAt` end. Absent where it declares none.
   */
  readonly insertion?: CompiledInsertion
  /** The value the Plant's control holds its drawn state to, where it declares one (a pressurizer's level program). */
  readonly program?: VariablePath
}

/** A rule framing an item, and its flap text (MimicItemBinding.frames). */
export interface MimicFrame {
  readonly ruleId: string
  readonly flap: string
  /** What it watches: "LO-LO", "P LO & F LO", "NOT RUN". */
  readonly watches: string
  /** What the I&C does there, where the flap names it: "AFW START", "ALM". */
  readonly action?: string
  readonly modeIds?: ReadonlyArray<string>
}

const aspectOf = (aspects: ReadonlyArray<CompiledStateAspect>, aspect: StateAspect): CompiledStateAspect | undefined =>
  aspects.find(candidate => candidate.aspect === aspect)

/** Which item a signal belongs to: the device that bundles it, else the component that owns it. Pipes own no item. */
const ownerItem = (graph: CompiledPlantGraph, binding: ProcessSignalBinding): EquipmentItem | null => {
  if (binding.owner.type !== 'component') return null
  const component = graph.components[binding.owner.componentIndex]!
  const device = component.semantics.embedded.find(candidate => candidate.variables.includes(binding.path))
  return device === undefined ? { kind: 'component', component: component.index } : { kind: 'device', component: component.index, device: device.id }
}

const leaves = (condition: ProcessPlantIcCondition): ReadonlyArray<Extract<ProcessPlantIcCondition, { type: 'comparison' }>> =>
  condition.type === 'comparison' ? [condition]
    : condition.type === 'not' ? leaves(condition.condition)
      : condition.conditions.flatMap(leaves)

const effectKind = (rule: ProcessPlantIcRule): 'alarm' | 'trip' | null =>
  rule.effects.some(effect => effect.type === 'trip.enter') ? 'trip'
    : rule.effects.some(effect => effect.type === 'alarm.enter') ? 'alarm'
      : null

const quantityLetters: Readonly<Record<string, string>> = {
  pressure: 'P',
  pressureDelta: 'ΔP',
  flowRate: 'F',
  flowRateDelta: 'ΔF',
  massDelta: 'ΔINV',
  powerDelta: 'ΔPWR',
  energyPerMass: 'H',
  time: 'TIME',
  temperature: 'T',
  temperatureDelta: 'ΔT',
  temperatureRate: 'dT',
  rotationalSpeed: 'N',
  radiationDoseRate: 'RAD',
  power: 'PWR',
  mass: 'INV',
  voltage: 'V',
  concentration: 'CONC',
  countRate: 'NI',
  electricalCurrent: 'I',
  startupRate: 'SUR',
  head: 'HEAD',
  reactivity: 'RHO',
  frequency: 'HZ',
  energy: 'E',
  volume: 'VOL',
}

const measurandLetters: Readonly<Record<string, string>> = {
  level: 'L',
  position: 'POS',
  leak: 'LEAK',
  speed: 'N',
  load: 'LOAD',
  voltage: 'V',
  charge: 'CHG',
  quality: 'X',
  void: 'VOID',
  coverage: 'COV',
  availability: 'AVAIL',
  depletion: 'DEPL',
  humidity: 'HUM',
  contamination: 'CONTAM',
  insertion: 'INS',
  served: 'SERV',
  effectiveness: 'EFF',
}

const variableLetters = (binding: ProcessSignalBinding): string => {
  if (binding.quantity === 'ratio') return measurandLetters[binding.measurand!] ?? binding.measurand!.toUpperCase()
  return quantityLetters[binding.quantity] ?? binding.quantity.toUpperCase()
}

// Words for a discrete leaf, from the aspect the signal serves: a run command
// read false is "CMD STOP", a dead supply "DEAD".
const discreteWords = (graph: CompiledPlantGraph, binding: ProcessSignalBinding, value: boolean): string => {
  const owner = binding.owner.type === 'component' ? graph.components[binding.owner.componentIndex]! : undefined
  const aspects = owner?.semantics.aspects ?? []
  const servedAspect = aspects.find(aspect => aspect.command === binding.path || aspect.state?.path === binding.path)
  const served = servedAspect?.aspect
  // A flag that serves no aspect says itself: "degraded" true reads DEGRADED.
  const flag = String(binding.path).split('.').at(-1)!.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
  // "CMD" is kept for a command the equipment does not follow; a rule on the run command reads NOT RUN.
  return served === 'running' ? (value ? 'RUN' : 'NOT RUN')
    : served === 'position' && servedAspect?.state?.reading === 'closedWhileTrue' ? (value ? 'CLOSED' : 'OPEN')
    : served === 'position' ? (value ? 'OPEN' : 'SHUT')
      : served === 'energized' ? (value ? 'LIVE' : 'DEAD')
        : (value ? flag : `NOT ${flag}`)
}

/** Its single numeric limit among on/off gates (SI on low pressure unless blocked): the limit the trend draws for it. */
const gatedLeaf = (condition: ProcessPlantIcCondition): Extract<ProcessPlantIcCondition, { type: 'comparison' }> | null => {
  if (condition.type !== 'all') return null
  const leaves = condition.conditions.filter((child): child is Extract<ProcessPlantIcCondition, { type: 'comparison' }> => child.type === 'comparison')
  if (leaves.length !== condition.conditions.length) return null
  const numeric = leaves.filter(leaf => typeof leaf.value === 'number' && leaf.operator !== '==' && leaf.operator !== '!=')
  const gates = leaves.filter(leaf => typeof leaf.value === 'boolean' && (leaf.operator === '==' || leaf.operator === '!='))
  return numeric.length === 1 && gates.length === leaves.length - 1 && gates.length > 0 ? numeric[0]! : null
}

/**
 * What a framing rule watches and does, for its flap, in the words its
 * signals' trend chips use: "LO-LO · AFW START" on the level the symbol draws,
 * "P LO-3 · SI" on another of its signals, "CMD STOP" on a command. A limit
 * names what the I&C does at it (ALM, or the declared action), so an AFW
 * start never reads as a trip; an on/off state names itself.
 */
export const flapText = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, drawnState: VariablePath | undefined): Pick<MimicFrame, 'flap' | 'watches' | 'action'> => {
  const graph = plant.graph
  const gated = gatedLeaf(rule.condition)
  const watched = gated === null ? leaves(rule.condition) : [gated]
  let limited = false
  const names = [...new Set(watched.map(leaf => {
    const binding = resolveProcessPlantSignalBinding(graph, leaf.signal)
    if (typeof leaf.value === 'boolean') {
      const truth = leaf.operator === '!=' ? !leaf.value : leaf.value
      return discreteWords(graph, binding, truth)
    }
    limited = true
    const low = leaf.operator === '<' || leaf.operator === '<='
    // As its trend orders it: a limit with another closer to normal on its side reads LO-LO.
    const own = icThresholdsForSignal(plant, binding.path).thresholds.find(threshold => threshold.ruleId === rule.id)
    const beyond = icThresholdsForSignal(plant, binding.path).thresholds
      .some(other => other.kind !== 'control' && (other.direction === 'low') === low && (low ? other.value > (leaf.value as number) : other.value < (leaf.value as number)))
    const order = limitOrderName({ direction: low ? 'low' : 'high', order: own?.order ?? (beyond ? 2 : 1) })
    return binding.path === drawnState ? order : `${variableLetters(binding)} ${order}`
  }))]
  // Conditions that must all hold read "&", alternatives "or".
  const watches = names.join(rule.condition.type === 'any' ? ' or ' : ' & ')
  if (!limited && icRuleKind(rule) !== 'trip') return { flap: watches, watches }
  const action = actionOf(plant, rule)
  return { flap: `${watches} · ${action}`, watches, action }
}

/**
 * Rules that frame one drawn item: those whose every watched signal belongs
 * to it, and those with one limit on its signal that on/off states elsewhere
 * only gate (as its trend draws that limit); votes and rules across items
 * lead the banner.
 */
export const framingRules = (plant: CompiledProcessPlant): ReadonlyMap<string, ReadonlyArray<ProcessPlantIcRule>> => {
  const framed = new Map<string, ProcessPlantIcRule[]>()
  for (const rule of plant.automation.rules) {
    if (!rule.enabled || effectKind(rule) === null || rule.condition.type === 'vote') continue
    const gated = gatedLeaf(rule.condition)
    const owners = new Set((gated === null ? leaves(rule.condition) : [gated]).map(leaf => {
      const owner = ownerItem(plant.graph, resolveProcessPlantSignalBinding(plant.graph, leaf.signal))
      return owner === null ? '' : mimicItemKey(owner)
    }))
    if (owners.size !== 1 || owners.has('')) continue
    const key = [...owners][0]!
    framed.set(key, [...(framed.get(key) ?? []), rule])
  }
  return framed
}

/** The words the equipment owning an on/off signal declares for it (metadata.presentation.states), if it declares any. */
const declaredWords = (graph: CompiledPlantGraph, path: VariablePath): { readonly on: string; readonly off: string } | undefined => {
  const owner = graph.signalBindingByPath.get(path)?.owner
  if (owner?.type !== 'component') return undefined
  const component = graph.components[owner.componentIndex]!
  return component.metadata?.presentation?.states?.[String(path).slice(String(component.id).length + 1)]
}

/**
 * A valve's position is drawn only from a signal the Plant publishes: one it
 * does not (the steam generators' atmospheric relief valves, an accumulator's
 * check valve) is not measured, and the valve reads POS ? and what passes it
 * where that is published, never SHUT or OPEN from the model's own state
 * (HMI review of run 26c: the SG details drew ARV "SHUT" with no data).
 */
const published = (graph: CompiledPlantGraph, path: VariablePath): boolean => graph.signalBindingByPath.get(path)?.published === true

const stateBinding = (graph: CompiledPlantGraph, aspects: ReadonlyArray<CompiledStateAspect>, aspect: StateAspect | null, flow: (path: VariablePath) => number | null, twoState = false, valve = false): MimicStateBinding | null => {
  if (aspect === null) return null
  const declared = aspectOf(aspects, aspect)
  if (declared === undefined) return null
  const throughput = aspectOf(aspects, 'throughput')?.state
  const drawn = declared.state === undefined || (valve && !published(graph, declared.state.path)) ? undefined : declared.state
  // A flow read as a state (a turbine runs while steam drives it) has the same no-flow band as a pipe.
  const state = drawn === undefined ? undefined
    : drawn.reading === 'flow' ? { ...drawn, noFlowBelow: flow(drawn.path) } : drawn
  // An on/off state reads in the words its equipment declares for it, where it declares them.
  const words = state === undefined || (state.reading !== 'true' && state.reading !== 'closedWhileTrue') ? undefined : declaredWords(graph, state.path)
  return {
    aspect,
    ...(state === undefined ? {} : { state }),
    ...(words === undefined ? {} : { words }),
    ...(declared.command === undefined ? {} : { command: declared.command }),
    ...(declared.travel === undefined ? {} : { travel: declared.travel }),
    ...(twoState && aspect === 'position' ? { twoState: true as const } : {}),
    // A state the model does not solve, or a valve's position the Plant does not publish, is judged by what passes the item.
    ...(state !== undefined || throughput === undefined || (valve && !published(graph, throughput.path)) ? {} : { throughput: { path: throughput.path, noFlowBelow: flow(throughput.path) } }),
  }
}

const levelLimits = (plant: CompiledProcessPlant, state: MimicStateBinding | null): MimicItemBinding['limits'] =>
  state?.aspect !== 'level' || state.state === undefined ? []
    : icThresholdsForSignal(plant, state.state.path).thresholds
      .filter((threshold): threshold is typeof threshold & { kind: 'alarm' | 'trip' } => threshold.kind !== 'control')
      .map(threshold => ({ value: threshold.value, kind: threshold.kind, name: thresholdName(threshold, 'percent') }))

const valueBinding = (graph: CompiledPlantGraph, component: CompiledComponent, path: VariablePath, drawnState: VariablePath | undefined): MimicValueBinding => {
  const signal = graph.signalBindingByPath.get(path)!
  const share = signal.unit === 'fraction' || signal.unit === 'percent'
  const span = signal.limits?.instrumentSpan
  const range = span ?? signal.limits?.hardRange
  // The compiler holds both instruments of a declared wider range to their spans.
  const wider = component.semantics.widerRanges.find(range => range.reading === path && range.while === undefined)?.wider
  const widerSignal = wider === undefined ? undefined : graph.signalBindingByPath.get(wider)
  return {
    path,
    unit: signal.unit,
    ...(share && path !== drawnState ? { letters: variableLetters(signal) } : {}),
    ...(span === undefined ? {} : { span }),
    ...(range === undefined ? {} : { range }),
    ...(widerSignal === undefined || !widerSignal.published ? {} : { wider: { path: widerSignal.path, span: widerSignal.limits!.instrumentSpan! } }),
  }
}

/**
 * The on/off shutdown readings of a component that its equipment words,
 * other than the state its symbol draws, each with what its trips command
 * it: every command of its own a trip rule writes, once per value.
 */
const shutdownBindings = (plant: CompiledProcessPlant, component: CompiledComponent, drawnState: VariablePath | undefined): ReadonlyArray<MimicShutdownBinding> => {
  const graph = plant.graph
  const flags = component.semantics.shutdownReadings.filter(path => path !== drawnState && graph.signalBindingByPath.get(path)?.quantity === 'boolean')
  if (flags.length === 0) return []
  const demands = new Map<string, { readonly path: VariablePath; readonly value: number | boolean }>()
  for (const rule of plant.automation.rules) {
    if (!rule.enabled || effectKind(rule) !== 'trip') continue
    for (const effect of rule.effects) {
      if (effect.type !== 'writeSignal') continue
      const binding = resolveProcessPlantSignalBinding(graph, effect.signal)
      if (binding.owner.type !== 'component' || binding.owner.componentIndex !== component.index || binding.actuation !== 'command') continue
      demands.set(`${binding.path}=${effect.value}`, { path: binding.path, value: effect.value })
    }
  }
  return flags.flatMap(path => {
    const words = declaredWords(graph, path)
    return words === undefined ? [] : [{ path, words, demands: [...demands.values()] }]
  })
}

/**
 * The chains of a component's flag-switched wider ranges, each from the
 * instrument that is no other's wider one, out to the widest.
 */
const rangeBindings = (graph: CompiledPlantGraph, component: CompiledComponent): ReadonlyArray<MimicRangeBinding> => {
  const switched = component.semantics.widerRanges.filter(range => range.while !== undefined)
  const next = new Map(switched.map(range => [range.reading, range]))
  const widened = new Set(switched.map(range => range.wider))
  const meaningful = (path: VariablePath) => component.semantics.meaningfulWhile.find(entry => entry.variables.includes(path))?.flag
  const step = (path: VariablePath): MimicRangeBinding['steps'][number] => {
    const signal = graph.signalBindingByPath.get(path)!
    const span = signal.limits?.instrumentSpan
    const flag = meaningful(path)
    const widerWhile = next.get(path)?.while
    return {
      path,
      unit: signal.unit,
      ...(signal.unit === 'fraction' || signal.unit === 'percent' ? { letters: variableLetters(signal) } : {}),
      ...(span === undefined ? {} : { span }),
      ...(flag === undefined ? {} : { meaningful: flag }),
      ...(widerWhile === undefined ? {} : { widerWhile }),
    }
  }
  // The compiler holds each chain free of returns, so following it ends.
  return switched.filter(range => !widened.has(range.reading)).map(root => {
    const paths: VariablePath[] = [root.reading]
    for (let range = next.get(root.reading); range !== undefined; range = next.get(range.wider)) paths.push(range.wider)
    return { steps: paths.map(step) }
  })
}

export const itemBinding = (
  plant: CompiledProcessPlant,
  item: EquipmentItem,
  aspect: StateAspect | null,
  framed: ReadonlyMap<string, ReadonlyArray<ProcessPlantIcRule>>,
): MimicItemBinding => {
  const graph = plant.graph
  const component = graph.components[item.component]!
  const device = item.kind === 'device' ? component.semantics.embedded.find(candidate => candidate.id === item.device)! : undefined
  // A device's no-flow band is its host outlet's rating; a component's, its largest rated outflow.
  const ratings = component.semantics.ratedOutflow.filter(rating => device === undefined || rating.port === device.port).map(rating => rating.flowKgPerS)
  const rated = ratings.length === 0 ? null : Math.max(...ratings)
  const equipmentFunction = device?.function ?? component.semantics.function
  const twoState = equipmentFunction === 'isolating' || equipmentFunction === 'relieving'
  const state = stateBinding(graph, device?.aspects ?? component.semantics.aspects, aspect, () => rated === null ? null : rated * NO_FLOW_FRACTION, twoState, equipmentFunction !== undefined)
  const drawnState = state?.state?.path
  return {
    item,
    label: equipmentItemLabel(component, device),
    state,
    values: device === undefined ? component.semantics.keyValues.map(path => valueBinding(graph, component, path, drawnState)) : [],
    ranges: device === undefined ? rangeBindings(graph, component) : [],
    shutdown: device === undefined ? shutdownBindings(plant, component, drawnState) : [],
    limits: levelLimits(plant, state),
    frames: (framed.get(mimicItemKey(item)) ?? []).map(rule => ({ ruleId: rule.id, ...flapText(plant, rule, drawnState), ...(rule.modes === undefined ? {} : { modeIds: [...rule.modes] }) })),
    ...(device !== undefined || component.semantics.insertion === undefined ? {} : { insertion: component.semantics.insertion }),
    ...programOf(component, device === undefined ? drawnState : undefined),
  }
}

/** The program a component's control holds its drawn state to (MimicItemBinding.program). */
const programOf = (component: CompiledComponent, drawn: VariablePath | undefined): { readonly program?: VariablePath } => {
  const program = drawn === undefined ? undefined : component.semantics.programs.find(candidate => candidate.reading === drawn)
  return program === undefined ? {} : { program: program.program }
}

/**
 * What a power line's far end says under its name, about the equipment it
 * names and never about the line towards it (HMI review of run 26: a stub
 * read "to Bus A DEAD" through an open offsite breaker while the bus's
 * diesel held it at 6.60 kV).
 * - `equipment`: each named equipment's own energized state, where every
 *   one declares one: LIVE or DEAD as the equipment reads.
 * - `supply`: where a named equipment declares none (a pump's motor), the
 *   lines to or from it, worded as supply ("no supply"), never LIVE or DEAD.
 */
export type MimicStubWord =
  | { readonly kind: 'equipment'; readonly energized: ReadonlyArray<VariablePath> }
  | { readonly kind: 'supply'; readonly lines: ReadonlyArray<VariablePath> }

/** The word a power stub says of the far ends it names (MimicStubWord), from their declared energized aspects. */
export const stubWordBinding = (graph: CompiledPlantGraph, named: ReadonlyArray<number>, links: ReadonlyArray<number>): MimicStubWord => {
  const energized = [...new Set(named)].map(component => aspectOf(graph.components[component]!.semantics.aspects, 'energized')?.state?.path)
  return energized.every((path): path is VariablePath => path !== undefined)
    ? { kind: 'equipment', energized }
    : { kind: 'supply', lines: links.map(index => linkPowerBinding(graph, index).energizedPath) }
}

/** A power line is live while its own solved energized state reads true: what feeds it puts power out through closed contacts. */
export const linkPowerBinding = (graph: CompiledPlantGraph, linkIndex: number): { readonly energizedPath: VariablePath } => {
  const link = graph.links[linkIndex]!
  const energized = link.variables.find(variable => String(variable.path) === `${link.id}.energized`)
  if (energized === undefined) throw new Error(`power link ${link.id} has no energized state to draw`)
  return { energizedPath: energized.path }
}
