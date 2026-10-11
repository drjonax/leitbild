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
import { actionOf, icRuleKind, icThresholdsForSignal } from '../ic-thresholds.ts'
import { limitOrderName, thresholdName } from '../display-text.ts'

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
  /**
   * What passes the item, judging it where its own state is not solved.
   * `heldBack`: a non-return device on the same line can hold the flow back
   * (an accumulator's check valve), so no flow does not say the item is shut.
   */
  readonly throughput?: { readonly path: VariablePath; readonly noFlowBelow: number | null; readonly heldBack?: true }
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
}

export interface MimicItemBinding {
  readonly item: MimicItem
  /** The operator's short name. */
  readonly label: string
  readonly state: MimicStateBinding | null
  /** The values an operator reads first on it. */
  readonly values: ReadonlyArray<MimicValueBinding>
  /** I&C alarm and trip limits on its level, marked on the vessel. */
  readonly limits: ReadonlyArray<{ readonly value: number; readonly kind: 'alarm' | 'trip'; readonly name: string }>
  /**
   * Rules that frame it, each with the flap text that says what it watches
   * and does ("LO-LO · AFW START"), its two parts (`watches`, and `action`
   * where it names one), and the declared modes it alone acts in: outside
   * them it frames nothing, as its limit is drawn not in force on a trend.
   */
  readonly frames: ReadonlyArray<MimicFrame>
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

const stateBinding = (aspects: ReadonlyArray<CompiledStateAspect>, aspect: StateAspect | null, flow: (path: VariablePath) => number | null, heldBack = false): MimicStateBinding | null => {
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
    ...(declared.state !== undefined || throughput === undefined ? {} : { throughput: { path: throughput.path, noFlowBelow: flow(throughput.path), ...(heldBack ? { heldBack: true as const } : {}) } }),
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
  // The compiler holds both instruments of a declared wider range to their spans.
  const wider = component.semantics.widerRanges.find(range => range.reading === path)?.wider
  const widerSignal = wider === undefined ? undefined : graph.signalBindingByPath.get(wider)
  return {
    path,
    unit: signal.unit,
    ...(share && path !== drawnState ? { letters: variableLetters(signal) } : {}),
    ...(span === undefined ? {} : { span }),
    ...(widerSignal === undefined || !widerSignal.published ? {} : { wider: { path: widerSignal.path, span: widerSignal.limits!.instrumentSpan! } }),
  }
}

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
  const heldBack = device !== undefined && component.semantics.embedded.some(other => other.id !== device.id && other.port === device.port && other.function === 'nonReturn')
  const state = stateBinding(device?.aspects ?? component.semantics.aspects, aspect, () => rated === null ? null : rated * NO_FLOW_FRACTION, heldBack)
  const drawnState = state?.state?.path
  return {
    item,
    label: device === undefined ? labelOf(component) : deviceLabel(component, device),
    state,
    values: device === undefined ? component.semantics.keyValues.map(path => valueBinding(graph, component, path, drawnState)) : [],
    limits: levelLimits(plant, state),
    frames: (framed.get(mimicItemKey(item)) ?? []).map(rule => ({ ruleId: rule.id, ...flapText(plant, rule, drawnState), ...(rule.modes === undefined ? {} : { modeIds: [...rule.modes] }) })),
  }
}

/** A power line is live while its own solved energized state reads true: what feeds it puts power out through closed contacts. */
export const linkPowerBinding = (graph: CompiledPlantGraph, linkIndex: number): { readonly energizedPath: VariablePath } => {
  const link = graph.links[linkIndex]!
  const energized = link.variables.find(variable => String(variable.path) === `${link.id}.energized`)
  if (energized === undefined) throw new Error(`power link ${link.id} has no energized state to draw`)
  return { energizedPath: energized.path }
}

export const linkFlowBinding = (graph: CompiledPlantGraph, linkIndex: number): MimicFlowBinding => {
  const link = graph.links[linkIndex]!
  const flow = link.variables.find(variable => String(variable.path).endsWith('.flowKgPerS'))
  if (flow === undefined) throw new Error(`link ${link.id} has no flow variable to draw`)
  const rated = ratedFlowForLink(graph, link)
  return { flowPath: flow.path, fidelity: processLinkFlowFidelityFor(graph, link), noFlowBelow: rated === null ? null : rated * NO_FLOW_FRACTION }
}
