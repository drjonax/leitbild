import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcFirstOutGroup, ProcessPlantIcOperatingMode, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding, resolveProcessPlantSignalPath } from '../signals.ts'
import { displayValue, unitLabel } from './display-text.ts'
import { operatingPointValue } from './operating-point.ts'

// Thresholds drawn on composed displays come only from the Plant's configured
// I&C rules. They are named I&C thresholds, not variable limits: they state
// where a rule acts, not a qualified operating envelope.
export type ComposedDisplayThresholdKind = 'trip' | 'alarm' | 'control'
/** Alarm priority of the rule's alarm or trip effect; it alone picks the alarm colour everywhere. */
export type ComposedDisplaySeverity = 'info' | 'notice' | 'warning' | 'critical'

export interface ComposedDisplayThreshold {
  readonly ruleId: string
  readonly label: string
  readonly kind: ComposedDisplayThresholdKind
  /** Present for alarm and trip rules. */
  readonly severity?: ComposedDisplaySeverity
  readonly operator: '<' | '<=' | '>' | '>='
  /** Low thresholds act when the value falls; high ones when it rises. */
  readonly direction: 'low' | 'high'
  readonly value: number
  /**
   * Its step away from normal on its side, counted over the distinct values
   * of the limits that can act with it (orderLimits): 1 for the nearest
   * (LO), 2 beyond it (LO-LO), 3 beyond that (LO-3). An alarm at 30 % reads
   * LO, the limits at 20 % below it LO-LO, whichever of them alarms and
   * whichever actuates.
   */
  readonly order: number
  /**
   * What the I&C does there, as every display names it (display-text.ts): ALM
   * for an alarm, CTL for a control set point, and for a trip the short label
   * of the first-out group its annunciator names ("RX TRIP", "SI"), never
   * guessed from its id or title; ACTUATION where it names none.
   */
  readonly action: string
  /** Present where its action is the reactor trip (its first-out group says so): of limits acting together, it is named first. */
  readonly reactorTrip?: true
  /** The declared operating modes the rule only acts in, as a display names them where room is short ("Modes 1–2"). */
  readonly modeLabel?: string
  /** The same modes as the Plant names them ("Power operation or Startup"). */
  readonly modeNames?: string
  /** The same modes by id, to tell whether the rule acts in the Plant's current mode. */
  readonly modeIds?: ReadonlyArray<string>
  /**
   * What else the rule requires besides this value, as operators read it,
   * one entry per condition ("SI-BLOCKED off", "TRIP-BKR-A-POS OPEN or
   * TRIP-BKR-B-POS OPEN", "NIS-PR-AVG > 50 %"): it acts at this value only
   * while they all hold. Absent, the value alone decides.
   */
  readonly gatedBy?: ReadonlyArray<string>
  /** The same conditions by signal path, to tell whether they hold now (trend-reading.ts gatesHold). */
  readonly gates?: ReadonlyArray<LimitGate>
  /**
   * Where the rule votes over channels (2 of 4 low-low levels), how many of
   * how many must be past their limits: this channel's limit is where it
   * votes, and its action is named with the vote ("AFW START 2/4").
   */
  readonly coincidence?: { readonly required: number; readonly of: number }
}

/**
 * A condition a rule combines a limit with: an on/off state of another
 * signal ("SI-BLOCKED off"), another value past its own limit ("NIS-PR-AVG >
 * 50 %"), or any or all of several such ("either reactor trip breaker
 * open").
 */
export type LimitGate =
  | { readonly path: VariablePath; readonly on: boolean }
  | { readonly path: VariablePath; readonly operator: '<' | '<=' | '>' | '>='; readonly value: number }
  | { readonly any: ReadonlyArray<LimitGate> }
  | { readonly all: ReadonlyArray<LimitGate> }

/** A rule that watches the signal in a condition no limit on it can be read
 * from: an equality, a value that only arms the rule (it holds at the
 * Plant's operating point), or one combined with conditions no gate states.
 * It is listed, not drawn. */
export interface ComposedDisplayCombinedRule {
  readonly ruleId: string
  readonly label: string
  readonly kind: ComposedDisplayThresholdKind
}

export interface ComposedDisplayIcThresholds {
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly combinedRules: ReadonlyArray<ComposedDisplayCombinedRule>
}

export const icRuleKind = (rule: ProcessPlantIcRule): ComposedDisplayThresholdKind => {
  if (rule.effects.some(effect => effect.type === 'trip.enter')) return 'trip'
  if (rule.effects.some(effect => effect.type === 'alarm.enter')) return 'alarm'
  return 'control'
}

// Same defaults as the alarm lifecycle, so a threshold and its alarm row agree.
const severityFor = (rule: ProcessPlantIcRule): ComposedDisplaySeverity | undefined => {
  for (const effect of rule.effects) {
    if (effect.type === 'trip.enter') return effect.severity ?? 'critical'
    if (effect.type === 'alarm.enter') return effect.severity ?? 'warning'
  }
  return undefined
}

const labelFor = (rule: ProcessPlantIcRule): string => {
  for (const effect of rule.effects) {
    if (effect.type === 'trip.enter' || effect.type === 'alarm.enter') return effect.title
  }
  return rule.label ?? rule.id
}

/**
 * The first-out group of what a rule does itself, as the I&C config declares
 * it: the group its first annunciated alarm or trip names, so safety
 * injection, which trips the reactor too, is named SI; undefined where it
 * names none.
 */
export const firstOutGroupOf = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): ProcessPlantIcFirstOutGroup | undefined => {
  for (const effect of rule.effects) {
    if (effect.type === 'writeSignal' || effect.annunciator?.firstOutGroup === undefined) continue
    return plant.automation.firstOutGroups.find(group => group.id === effect.annunciator!.firstOutGroup)
  }
  return undefined
}

/** A trip whose rule names no declared first-out group: it actuates something the I&C does not say. */
export const UNDECLARED_ACTION = 'ACTUATION'

/** What the I&C does where the rule acts, in the words every display uses (ComposedDisplayThreshold.action). */
export const actionOf = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): string => {
  const kind = icRuleKind(rule)
  if (kind === 'alarm') return 'ALM'
  if (kind === 'control') return 'CTL'
  return firstOutGroupOf(plant, rule)?.shortLabel ?? UNDECLARED_ACTION
}

// What a rule does, and whether that is the reactor trip.
const actionFields = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): Pick<ComposedDisplayThreshold, 'action' | 'reactorTrip'> =>
  icRuleKind(rule) === 'trip' && firstOutGroupOf(plant, rule)?.reactorTrip === true
    ? { action: actionOf(plant, rule), reactorTrip: true }
    : { action: actionOf(plant, rule) }

/**
 * Declared modes as a display names them where room is short: by their short
 * labels, a run of modes declared one after another as a range ("Modes 1–2",
 * "Mode 3", "Modes 1, 3"); by their labels where any has none.
 */
export const modesShortText = (modes: ReadonlyArray<ProcessPlantIcOperatingMode>, ids: ReadonlyArray<string>): string => {
  const named = ids.map(id => modes.find(mode => mode.id === id)!)
  if (named.some(mode => mode.shortLabel === undefined)) return named.map(mode => mode.label).join(' or ')
  const positions = named.map(mode => modes.indexOf(mode)).sort((left, right) => left - right)
  const runs: Array<[number, number]> = []
  for (const position of positions) {
    const last = runs.at(-1)
    if (last !== undefined && position === last[1] + 1) last[1] = position
    else runs.push([position, position])
  }
  const short = (position: number): string => modes[position]!.shortLabel!
  const parts = runs.map(([first, last]) => first === last ? short(first) : `${short(first)}–${short(last)}`)
  return `${positions.length === 1 ? 'Mode' : 'Modes'} ${parts.join(', ')}`
}

// The declared operating modes a rule acts in, as a display names them where room is short and as the Plant names them, and by id.
const modesOf = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): Pick<ComposedDisplayThreshold, 'modeLabel' | 'modeNames' | 'modeIds'> =>
  rule.modes === undefined ? {} : {
    modeLabel: modesShortText(plant.automation.operatingModes, rule.modes),
    modeNames: rule.modes.map(id => plant.automation.operatingModes.find(mode => mode.id === id)!.label).join(' or '),
    modeIds: [...rule.modes],
  }

const conditionWatches = (
  plant: CompiledProcessPlant,
  condition: ProcessPlantIcCondition,
  path: VariablePath,
): boolean => {
  if (condition.type === 'comparison') return resolveProcessPlantSignalPath(plant.graph, condition.signal) === path
  if (condition.type === 'not') return conditionWatches(plant, condition.condition, path)
  return condition.conditions.some(child => conditionWatches(plant, child, path))
}

// Two limits act together unless their rules act only in different modes.
const actTogether = ({ modeIds: left }: Pick<ComposedDisplayThreshold, 'modeIds'>, { modeIds: right }: Pick<ComposedDisplayThreshold, 'modeIds'>): boolean =>
  left === undefined || right === undefined || left.some(mode => right.includes(mode))

// Alarms and trips order together; control set points only among themselves.
const ordersWith = (left: ComposedDisplayThresholdKind, right: ComposedDisplayThresholdKind): boolean =>
  (left === 'control') === (right === 'control')

/** A limit that acts only while other conditions hold besides its value (gatedBy). */
const conditional = (threshold: Pick<ComposedDisplayThreshold, 'gates'>): boolean => (threshold.gates ?? []).length > 0

/**
 * A signal's limits order away from normal in each direction: each is the
 * step after the distinct values, nearer normal on its side, of the limits
 * that can act with it (LO, LO-LO, LO-3), whatever each does; limits at one
 * value share their step, so no two steps share a name. Limits of different
 * modes are alternatives, not steps. A limit that acts only with other
 * conditions is a step beyond those nearer normal, but never one before the
 * limits its value alone decides: the pressurizer's safety injection at
 * 12.7 MPa, gated by its block, reads LO-3 beyond the reactor trip's LO-LO
 * 13.8 MPa (HMI review of run 23: both read LO-LO), while a level alarm at
 * 40 % that needs low feed flow too leaves the 30 % alarm LO and the 20 %
 * trip LO-LO.
 */
export const orderLimits = (thresholds: ReadonlyArray<Omit<ComposedDisplayThreshold, 'order'>>): ComposedDisplayThreshold[] =>
  thresholds.map(threshold => ({
    ...threshold,
    order: 1 + new Set(thresholds
      .filter(other => ordersWith(other.kind, threshold.kind) && other.direction === threshold.direction && actTogether(other, threshold))
      .filter(other => conditional(threshold) || !conditional(other))
      .filter(other => threshold.direction === 'low' ? other.value > threshold.value : other.value < threshold.value)
      .map(other => other.value)).size,
  }))

type NumericOperator = '<' | '<=' | '>' | '>='
const negatedOperator: Readonly<Record<NumericOperator, NumericOperator>> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<' }

const holds = (value: number, operator: NumericOperator, limit: number): boolean =>
  operator === '<' ? value < limit : operator === '<=' ? value <= limit : operator === '>' ? value > limit : value >= limit

/**
 * A condition as a gate on a limit, negated where `negated` (a rule's
 * `not`); null where no gate can state it: an equality on a number, or a
 * vote among other values.
 */
const gateOf = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition, negated: boolean): LimitGate | null => {
  if (condition.type === 'not') return gateOf(plant, condition.condition, !negated)
  if (condition.type === 'comparison') {
    const path = resolveProcessPlantSignalPath(plant.graph, condition.signal)
    if (condition.operator === '==' || condition.operator === '!=') {
      if (typeof condition.value !== 'boolean') return null
      return { path, on: (condition.operator === '==' ? condition.value : !condition.value) !== negated }
    }
    if (typeof condition.value !== 'number') return null
    return { path, operator: negated ? negatedOperator[condition.operator] : condition.operator, value: condition.value }
  }
  if (condition.type === 'vote') return null
  const children = condition.conditions.map(child => gateOf(plant, child, negated))
  if (children.some(child => child === null)) return null
  const gates = children as ReadonlyArray<LimitGate>
  if (gates.length === 1) return gates[0]!
  // Negated, every condition becomes any one of their negations, and the other way round.
  return (condition.type === 'any') !== negated ? { any: gates } : { all: gates }
}

/**
 * A gate as operators read it: an on/off state by the words of the state
 * it serves ("TRIP-BKR-A-POS OPEN", "SI-BLOCKED off"), another value past
 * its limit in display units ("NIS-PR-AVG > 50 %"); alternatives joined
 * by "or", groups inside another in brackets.
 */
export const gateText = (plant: CompiledProcessPlant, gate: LimitGate): string => {
  const inner = (child: LimitGate): string => 'any' in child || 'all' in child ? `(${gateText(plant, child)})` : gateText(plant, child)
  if ('any' in gate) return gate.any.map(inner).join(' or ')
  if ('all' in gate) return gate.all.map(inner).join(' and ')
  const binding = plant.graph.signalBindingByPath.get(gate.path)!
  const name = binding.tagId ?? ownedName(plant, binding)
  if ('on' in gate) return `${name} ${stateWord(plant, binding, gate.on)}`
  const unit = unitLabel(binding.unit)
  return `${name} ${gate.operator} ${displayValue(gate.value, binding.unit)}${unit === '' ? '' : ` ${unit}`}`
}

/** An untagged signal named with the equipment it belongs to, as one gate among parallel loops' tells them apart: "SG A feedwater inflow". */
const ownedName = (plant: CompiledProcessPlant, binding: ProcessSignalBinding): string => {
  const owner = binding.owner.type === 'component' ? plant.graph.components[binding.owner.componentIndex]! : undefined
  const short = owner?.metadata?.presentation?.shortLabel
  return short === undefined ? binding.label : `${short} ${binding.label.charAt(0).toLowerCase()}${binding.label.slice(1)}`
}

/**
 * An on/off state in the words of the state aspect it reads or commands
 * (OPEN or CLOSED for a breaker's contacts, OPEN or SHUT for a valve, RUN
 * or STOP, LIVE or DEAD), else on or off.
 */
const stateWord = (plant: CompiledProcessPlant, binding: ProcessSignalBinding, on: boolean): string => {
  const owner = binding.owner.type === 'component' ? plant.graph.components[binding.owner.componentIndex]! : undefined
  const served = owner?.semantics.aspects.find(aspect => aspect.command === binding.path || aspect.state?.path === binding.path)
  if (served?.aspect === 'running') return on ? 'RUN' : 'STOP'
  if (served?.aspect === 'energized') return on ? 'LIVE' : 'DEAD'
  if (served?.aspect === 'position' && served.state?.reading === 'closedWhileTrue') return on ? 'CLOSED' : 'OPEN'
  if (served?.aspect === 'position') return on ? 'OPEN' : 'SHUT'
  return on ? 'on' : 'off'
}

/** A limit read from a rule's condition: where the value acts, what else must hold, and the vote it is part of. */
interface ReadLimit {
  readonly operator: NumericOperator
  readonly value: number
  readonly gates: ReadonlyArray<LimitGate>
  readonly coincidence?: { readonly required: number; readonly of: number }
}

/**
 * The limits on a value inside a rule's condition, with what else each
 * needs: a comparison of the value is a limit; inside "all", every other
 * condition gates it; each alternative of "any" is a limit of its own; each
 * channel of a vote votes at its limit. A negation turns each condition
 * into its opposite. "unstated" stands for a comparison of the value that
 * has no place on its axis (an equality), or whose gates nothing can state.
 */
const limitsOn = (
  plant: CompiledProcessPlant,
  condition: ProcessPlantIcCondition,
  path: VariablePath,
  negated: boolean,
  context: Pick<ReadLimit, 'gates' | 'coincidence'>,
): ReadonlyArray<ReadLimit | 'unstated'> => {
  if (condition.type === 'not') return limitsOn(plant, condition.condition, path, !negated, context)
  if (condition.type === 'comparison') {
    if (resolveProcessPlantSignalPath(plant.graph, condition.signal) !== path) return []
    if (typeof condition.value !== 'number' || condition.operator === '==' || condition.operator === '!=') return ['unstated']
    return [{ operator: negated ? negatedOperator[condition.operator] : condition.operator, value: condition.value, ...context }]
  }
  if (condition.type === 'vote') {
    if (negated) return conditionWatches(plant, condition, path) ? ['unstated'] : []
    const coincidence = { required: condition.required, of: condition.conditions.length }
    return condition.conditions.flatMap(child => limitsOn(plant, child, path, false, { ...context, coincidence }))
  }
  // Alternatives (any, or a negated all) each act alone.
  if ((condition.type === 'any') !== negated) return condition.conditions.flatMap(child => limitsOn(plant, child, path, negated, context))
  const low = (operator: string): boolean => (operator === '<' || operator === '<=') !== negated
  return condition.conditions.flatMap((child, index) => {
    if (!conditionWatches(plant, child, path)) return []
    const own = limitsOn(plant, child, path, negated, context)
    // A comparison of the same value beside it the other way is the other edge of a band (a control's normal
    // band), not a gate; one the same way makes the tighter of the two the limit, which no gate states.
    const sameValue = (other: ProcessPlantIcCondition): other is Extract<ProcessPlantIcCondition, { type: 'comparison' }> =>
      other.type === 'comparison' && resolveProcessPlantSignalPath(plant.graph, other.signal) === path
    const others = condition.conditions.filter((_, at) => at !== index)
    if (others.filter(sameValue).some(other => own.some(limit => limit === 'unstated' || low(other.operator) === (limit.operator === '<' || limit.operator === '<=')))) return own.map(() => 'unstated' as const)
    const gates = others.filter(other => !sameValue(other)).map(other => gateOf(plant, other, negated))
    if (gates.some(gate => gate === null)) return own.map(() => 'unstated' as const)
    return limitsOn(plant, child, path, negated, { ...context, gates: [...context.gates, ...(gates as ReadonlyArray<LimitGate>)] })
  })
}

// A Plant's rules never change once compiled, so each signal's thresholds are read once.
const thresholdsByPlant = new WeakMap<CompiledProcessPlant, Map<VariablePath, ComposedDisplayIcThresholds>>()

export const icThresholdsForSignal = (
  plant: CompiledProcessPlant,
  path: VariablePath,
): ComposedDisplayIcThresholds => {
  const known = thresholdsByPlant.get(plant) ?? new Map<VariablePath, ComposedDisplayIcThresholds>()
  thresholdsByPlant.set(plant, known)
  const cached = known.get(path)
  if (cached !== undefined) return cached
  const read = readIcThresholds(plant, path)
  known.set(path, read)
  return read
}

/**
 * The limits a rule sets on a value, as drawn: every comparison of it its
 * condition holds, alone or inside "all", "any", "not" or a vote (HMI
 * review of run 23: the feedwater isolation on low Tavg after a reactor
 * trip, `all([trip breaker open, TAVG < 295.6])`, was not drawn on Tavg).
 * Inside a combined condition, a comparison that holds at the Plant's
 * operating point only arms the rule (power above P-9 for a reactor trip on
 * turbine trip), so it is no limit on that value. Null where the rule sets
 * none it can draw.
 */
const ruleLimits = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, path: VariablePath): ReadonlyArray<ReadLimit> | null => {
  const found = limitsOn(plant, rule.condition, path, false, { gates: [] })
  if (found.includes('unstated')) return null
  const nominal = operatingPointValue(plant, path)
  const limits = (found as ReadonlyArray<ReadLimit>)
    .filter(limit => rule.condition.type === 'comparison' || nominal === undefined || !holds(nominal, limit.operator, limit.value))
  return limits.length === 0 ? null : limits
}

const readIcThresholds = (
  plant: CompiledProcessPlant,
  path: VariablePath,
): ComposedDisplayIcThresholds => {
  const thresholds: Array<Omit<ComposedDisplayThreshold, 'order'>> = []
  const combinedRules: ComposedDisplayCombinedRule[] = []
  for (const rule of plant.automation.rules) {
    if (!rule.enabled || !conditionWatches(plant, rule.condition, path)) continue
    const condition = rule.condition
    // Equality rules act on discrete states; they have no position on a value axis.
    if (condition.type === 'comparison' && (typeof condition.value !== 'number' || condition.operator === '==' || condition.operator === '!=')) continue
    const limits = ruleLimits(plant, rule, path)
    if (limits === null) {
      combinedRules.push({ ruleId: rule.id, label: labelFor(rule), kind: icRuleKind(rule) })
      continue
    }
    const severity = severityFor(rule)
    const action = actionFields(plant, rule)
    for (const limit of limits) {
      thresholds.push({
        ruleId: rule.id,
        label: labelFor(rule),
        kind: icRuleKind(rule),
        ...(severity === undefined ? {} : { severity }),
        ...action,
        ...(limit.coincidence === undefined ? {} : { action: `${action.action} ${limit.coincidence.required}/${limit.coincidence.of}`, coincidence: limit.coincidence }),
        operator: limit.operator,
        direction: limit.operator === '<' || limit.operator === '<=' ? 'low' : 'high',
        value: limit.value,
        ...modesOf(plant, rule),
        ...(limit.gates.length === 0 ? {} : { gatedBy: limit.gates.map(gate => gateText(plant, gate)), gates: limit.gates }),
      })
    }
  }
  // A channel's vote at a value where the same action already acts on this
  // value alone says nothing more: the turbine-driven AFW pump's 2-of-4 start
  // at the low-low level each generator's own AFW start already names there.
  const named = thresholds.filter(threshold => threshold.coincidence === undefined
    || !thresholds.some(other => other.coincidence === undefined && other.value === threshold.value && other.direction === threshold.direction
      && `${other.action} ${threshold.coincidence!.required}/${threshold.coincidence!.of}` === threshold.action))
  return {
    thresholds: orderLimits(named).sort((left, right) => left.value - right.value || left.ruleId.localeCompare(right.ruleId)),
    combinedRules: combinedRules.sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
  }
}

// A signal belongs to its bound equipment and to the node that owns its path
// (a relief flow modelled on the pressurizer node belongs to the pressurizer).
const equipmentKeys = (binding: ProcessSignalBinding): ReadonlyArray<string> => [
  String(binding.path).split('.')[0]!,
  ...(binding.equipmentId === undefined ? [] : [String(binding.equipmentId)]),
]

const conditionBindings = (
  plant: CompiledProcessPlant,
  condition: ProcessPlantIcCondition,
): ReadonlyArray<ProcessSignalBinding> => {
  if (condition.type === 'comparison') return [resolveProcessPlantSignalBinding(plant.graph, condition.signal)]
  if (condition.type === 'not') return conditionBindings(plant, condition.condition)
  return condition.conditions.flatMap(child => conditionBindings(plant, child))
}

/**
 * Alarm and trip rules acting on any signal of the displayed signals'
 * equipment: beside a pressurizer pressure trend an operator expects the
 * pressurizer's other alarms (relief flow, level), not only the pressure ones.
 */
export const icAlarmRuleIdsForEquipment = (
  plant: CompiledProcessPlant,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<string> => {
  const equipment = new Set(paths.flatMap(path => {
    const binding = plant.graph.signalBindingByPath.get(path)
    return binding === undefined ? [] : equipmentKeys(binding)
  }))
  return plant.automation.rules
    .filter(rule => rule.enabled && icRuleKind(rule) !== 'control')
    .filter(rule => conditionBindings(plant, rule.condition).some(binding => equipmentKeys(binding).some(key => equipment.has(key))))
    .map(rule => rule.id)
}

/**
 * Single-signal alarm and trip rules on one component's signals: they frame
 * its mimic symbol. Combined and voted rules are left out, because they judge
 * several items at once (2-of-4 RCP low flow would frame every pump).
 */
export const icAlarmRuleIdsForComponent = (
  plant: CompiledProcessPlant,
  componentId: string,
): ReadonlyArray<string> => plant.automation.rules
  .filter(rule => rule.enabled && icRuleKind(rule) !== 'control' && rule.condition.type === 'comparison')
  .filter(rule => conditionBindings(plant, rule.condition).some(binding => equipmentKeys(binding).includes(componentId)))
  .map(rule => rule.id)

/** Single-signal alarm and trip rules on exactly these signals, for a symbol that is one item of a larger component. */
export const icAlarmRuleIdsForPaths = (
  plant: CompiledProcessPlant,
  paths: ReadonlyArray<VariablePath>,
): ReadonlyArray<string> => {
  const watched = new Set(paths.map(String))
  return plant.automation.rules
    .filter(rule => rule.enabled && icRuleKind(rule) !== 'control' && rule.condition.type === 'comparison')
    .filter(rule => conditionBindings(plant, rule.condition).some(binding => watched.has(String(binding.path))))
    .map(rule => rule.id)
}
