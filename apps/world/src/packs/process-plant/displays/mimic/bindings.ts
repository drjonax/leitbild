import type {
  AspectReading,
  CompiledComponent,
  CompiledEmbeddedDevice,
  CompiledPlantGraph,
  CompiledStateAspect,
  ProcessSignalBinding,
  StateAspect,
  VariablePath,
} from '../../graph/index.ts'
import { ratedFlowForLink } from '../../graph/index.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../../runtime/index.ts'
import { processLinkFlowFidelityFor, type ProcessLinkFlowFidelity } from '../../runtime/links/link-flow-fidelity.ts'
import { resolveProcessPlantSignalBinding } from '../../signals.ts'
import { icThresholdsForSignal } from '../ic-thresholds.ts'
import { thresholdName } from '../display-text.ts'

// What each drawn item shows and from which signals, all read from the model's
// declared semantics: no variable path is named here. State comes from solved
// signals only; a command only annotates a disagreement; an item is framed by
// the alarm rules that watch its own signals alone.

/** A drawn item: a component, or a device the model bundles inside one (the PORV). */
export type MimicItem =
  | { readonly kind: 'component'; readonly component: number }
  | { readonly kind: 'device'; readonly component: number; readonly device: string }

/** The id an agent names an item by: its component, or its component and the bundled device ("pressurizer.reliefValve"). */
export const mimicItemId = (graph: CompiledPlantGraph, item: MimicItem): string =>
  item.kind === 'component' ? String(graph.components[item.component]!.id) : `${graph.components[item.component]!.id}.${item.device}`

export const mimicItemKey = (item: MimicItem): string =>
  item.kind === 'component' ? `c${item.component}` : `c${item.component}:${item.device}`

/** Below this fraction of a link's rated flow it reads "no flow": numerical noise, a coasting pump's tail. */
export const NO_FLOW_FRACTION = 0.0025

export interface MimicStateBinding {
  readonly aspect: StateAspect
  /** The solved signal; absent when the model computes none, so the state reads "not measured". */
  readonly state?: { readonly path: VariablePath; readonly reading: AspectReading; readonly noFlowBelow?: number | null }
  readonly command?: VariablePath
  /** What passes the item, judging it where its own state is not solved. */
  readonly throughput?: { readonly path: VariablePath; readonly noFlowBelow: number | null }
}

export interface MimicItemBinding {
  readonly item: MimicItem
  /** The operator's short name. */
  readonly label: string
  readonly state: MimicStateBinding | null
  /** The values an operator reads first on it. */
  readonly values: ReadonlyArray<{ readonly path: VariablePath; readonly unit: string }>
  /** I&C alarm and trip limits on its level, marked on the vessel. */
  readonly limits: ReadonlyArray<{ readonly value: number; readonly kind: 'alarm' | 'trip'; readonly name: string }>
  /** Rules that frame it, each with the flap text that says what it watches. */
  readonly frames: ReadonlyArray<{ readonly ruleId: string; readonly flap: string }>
}

export interface MimicFlowBinding {
  readonly flowPath: VariablePath
  readonly fidelity: ProcessLinkFlowFidelity
  /** Null when nothing upstream is rated: "no flow" cannot be judged. */
  readonly noFlowBelow: number | null
}

const aspectOf = (aspects: ReadonlyArray<CompiledStateAspect>, aspect: StateAspect): CompiledStateAspect | undefined =>
  aspects.find(candidate => candidate.aspect === aspect)

const labelOf = (component: CompiledComponent): string => component.metadata?.presentation?.shortLabel ?? component.label

export const deviceLabel = (component: CompiledComponent, device: CompiledEmbeddedDevice): string =>
  component.metadata?.presentation?.embedded?.[device.id] ?? `${labelOf(component)} ${device.label}`

/** Which item a signal belongs to: the device that bundles it, else the component that owns it. Pipes own no item. */
const ownerItem = (graph: CompiledPlantGraph, binding: ProcessSignalBinding): MimicItem | null => {
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

/**
 * What a framing rule watches, for its flap: "LO-LO" on the level the symbol
 * draws, "P HI" on another of its signals, "CMD STOP" on a command. Never
 * "TRIP": a vessel does not trip, and the trip itself leads the banner.
 */
export const flapText = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, drawnState: VariablePath | undefined): string => {
  const graph = plant.graph
  const names = [...new Set(leaves(rule.condition).map(leaf => {
    const binding = resolveProcessPlantSignalBinding(graph, leaf.signal)
    if (typeof leaf.value === 'boolean') {
      const truth = leaf.operator === '!=' ? !leaf.value : leaf.value
      return discreteWords(graph, binding, truth)
    }
    const low = leaf.operator === '<' || leaf.operator === '<='
    // Rank orders this signal's limits away from normal: the first low limit reads LO, the next LO-LO.
    const sameSide = plant.automation.rules
      .filter(other => other.enabled && effectKind(other) !== null && other.condition.type === 'comparison')
      .map(other => other.condition as Extract<ProcessPlantIcCondition, { type: 'comparison' }>)
      .filter(other => typeof other.value === 'number' && resolveProcessPlantSignalBinding(graph, other.signal).path === binding.path
        && (other.operator === '<' || other.operator === '<=') === low)
      .map(other => other.value as number)
    const rank = low ? sameSide.filter(value => value > (leaf.value as number)).length : sameSide.filter(value => value < (leaf.value as number)).length
    const limit = low ? (rank === 0 ? 'LO' : 'LO-LO') : (rank === 0 ? 'HI' : 'HI-HI')
    return binding.path === drawnState ? limit : `${variableLetters(binding)} ${limit}`
  }))]
  // Conditions that must all hold read "&", alternatives "or".
  return names.join(rule.condition.type === 'any' ? ' or ' : ' & ')
}

/** Rules whose every watched signal belongs to one drawn item frame that item; votes and rules across items lead the banner. */
export const framingRules = (plant: CompiledProcessPlant): ReadonlyMap<string, ReadonlyArray<ProcessPlantIcRule>> => {
  const framed = new Map<string, ProcessPlantIcRule[]>()
  for (const rule of plant.automation.rules) {
    if (!rule.enabled || effectKind(rule) === null || rule.condition.type === 'vote') continue
    const owners = new Set(leaves(rule.condition).map(leaf => {
      const owner = ownerItem(plant.graph, resolveProcessPlantSignalBinding(plant.graph, leaf.signal))
      return owner === null ? '' : mimicItemKey(owner)
    }))
    if (owners.size !== 1 || owners.has('')) continue
    const key = [...owners][0]!
    framed.set(key, [...(framed.get(key) ?? []), rule])
  }
  return framed
}

const stateBinding = (aspects: ReadonlyArray<CompiledStateAspect>, aspect: StateAspect | null, flow: (path: VariablePath) => number | null): MimicStateBinding | null => {
  if (aspect === null) return null
  const declared = aspectOf(aspects, aspect)
  if (declared === undefined) return null
  const throughput = aspectOf(aspects, 'throughput')?.state
  // A flow read as a state (a turbine runs while steam drives it) has the same no-flow band as a pipe.
  const state = declared.state === undefined ? undefined
    : declared.state.reading === 'flow' ? { ...declared.state, noFlowBelow: flow(declared.state.path) } : declared.state
  return {
    aspect,
    ...(state === undefined ? {} : { state }),
    ...(declared.command === undefined ? {} : { command: declared.command }),
    // A state the model does not solve is judged by what passes the item.
    ...(declared.state !== undefined || throughput === undefined ? {} : { throughput: { path: throughput.path, noFlowBelow: flow(throughput.path) } }),
  }
}

const levelLimits = (plant: CompiledProcessPlant, state: MimicStateBinding | null): MimicItemBinding['limits'] =>
  state?.aspect !== 'level' || state.state === undefined ? []
    : icThresholdsForSignal(plant, state.state.path).thresholds
      .filter((threshold): threshold is typeof threshold & { kind: 'alarm' | 'trip' } => threshold.kind !== 'control')
      .map(threshold => ({ value: threshold.value, kind: threshold.kind, name: thresholdName(threshold, 'percent') }))

export const itemBinding = (
  plant: CompiledProcessPlant,
  item: MimicItem,
  aspect: StateAspect | null,
  framed: ReadonlyMap<string, ReadonlyArray<ProcessPlantIcRule>>,
): MimicItemBinding => {
  const graph = plant.graph
  const component = graph.components[item.component]!
  const device = item.kind === 'device' ? component.semantics.embedded.find(candidate => candidate.id === item.device)! : undefined
  // A device's no-flow band is its host outlet's rating; a component's, its largest rated outflow.
  const ratings = component.semantics.ratedOutflow.filter(rating => device === undefined || rating.port === device.port).map(rating => rating.flowKgPerS)
  const rated = ratings.length === 0 ? null : Math.max(...ratings)
  const state = stateBinding(device?.aspects ?? component.semantics.aspects, aspect, () => rated === null ? null : rated * NO_FLOW_FRACTION)
  const drawnState = state?.state?.path
  return {
    item,
    label: device === undefined ? labelOf(component) : deviceLabel(component, device),
    state,
    values: device === undefined ? component.semantics.keyValues.map(path => ({ path, unit: graph.signalBindingByPath.get(path)!.unit })) : [],
    limits: levelLimits(plant, state),
    frames: (framed.get(mimicItemKey(item)) ?? []).map(rule => ({ ruleId: rule.id, flap: flapText(plant, rule, drawnState) })),
  }
}

/** A power line is live while the equipment feeding it is energized. */
export const linkPowerBinding = (graph: CompiledPlantGraph, linkIndex: number): { readonly energizedPath: VariablePath | null } => {
  const source = graph.components[graph.links[linkIndex]!.fromComponentIndex]!
  return { energizedPath: aspectOf(source.semantics.aspects, 'energized')?.state?.path ?? null }
}

export const linkFlowBinding = (graph: CompiledPlantGraph, linkIndex: number): MimicFlowBinding => {
  const link = graph.links[linkIndex]!
  const flow = link.variables.find(variable => String(variable.path).endsWith('.flowKgPerS'))
  if (flow === undefined) throw new Error(`link ${link.id} has no flow variable to draw`)
  const rated = ratedFlowForLink(graph, link)
  return { flowPath: flow.path, fidelity: processLinkFlowFidelityFor(graph, link), noFlowBelow: rated === null ? null : rated * NO_FLOW_FRACTION }
}
