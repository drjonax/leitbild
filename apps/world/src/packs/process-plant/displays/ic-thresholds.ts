import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcFirstOutGroup, ProcessPlantIcOperatingMode, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding, resolveProcessPlantSignalPath } from '../signals.ts'

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
   * 1 for the limit nearest normal on its side, 2 for one beyond another
   * that can act with it: an alarm at 30 % reads LO, the limits at 20 % below
   * it LO-LO, whichever of them alarms and whichever actuates.
   */
  readonly order: 1 | 2
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
   * The on/off states of other signals the rule also requires ("SI-BLOCKED
   * off"): it acts at this value only while they hold. Absent, the value alone
   * decides.
   */
  readonly gatedBy?: ReadonlyArray<string>
  /** The same states by signal path and the state each must read, to tell whether they hold now (trend-reading.ts gatesHold). */
  readonly gates?: ReadonlyArray<{ readonly path: VariablePath; readonly on: boolean }>
}

/** A rule that watches the signal inside a combined condition (vote, all,
 * any, not). Its action does not follow from one value, so it is listed, not
 * drawn. */
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

/**
 * A signal's limits order away from normal in each direction: one with
 * another limit closer to normal on its side that can act with it is the
 * second (LO-LO, HI-HI), whatever each does; otherwise the first (LO, HI).
 * Limits of different modes are alternatives, not steps.
 */
export const orderLimits = (thresholds: ReadonlyArray<Omit<ComposedDisplayThreshold, 'order'>>): ComposedDisplayThreshold[] =>
  thresholds.map(threshold => ({
    ...threshold,
    order: thresholds
      .filter(other => ordersWith(other.kind, threshold.kind) && other.direction === threshold.direction && actTogether(other, threshold))
      .some(other => threshold.direction === 'low' ? other.value > threshold.value : other.value < threshold.value) ? 2 : 1,
  }))

type NumericLimit = { readonly operator: '<' | '<=' | '>' | '>='; readonly value: number }

/**
 * One numeric limit on the path among conditions that are otherwise only
 * on/off states of other signals: the limit, and those states as operators
 * read them ("SI-BLOCKED off"). Null for anything else.
 */
const gatedLimit = (
  plant: CompiledProcessPlant,
  conditions: ReadonlyArray<ProcessPlantIcCondition>,
  path: VariablePath,
): { readonly limit: NumericLimit; readonly gates: ReadonlyArray<{ readonly name: string; readonly path: VariablePath; readonly on: boolean }> } | null => {
  const limits: NumericLimit[] = []
  const gates: Array<{ readonly name: string; readonly path: VariablePath; readonly on: boolean }> = []
  for (const child of conditions) {
    if (child.type !== 'comparison') return null
    const onPath = resolveProcessPlantSignalPath(plant.graph, child.signal) === path
    if (onPath && typeof child.value === 'number' && child.operator !== '==' && child.operator !== '!=') {
      limits.push({ operator: child.operator, value: child.value })
      continue
    }
    if (onPath || typeof child.value !== 'boolean' || (child.operator !== '==' && child.operator !== '!=')) return null
    const binding = resolveProcessPlantSignalBinding(plant.graph, child.signal)
    const on = child.operator === '==' ? child.value : !child.value
    gates.push({ name: `${binding.tagId ?? binding.label} ${on ? 'on' : 'off'}`, path: binding.path, on })
  }
  return limits.length === 1 && gates.length > 0 ? { limit: limits[0]!, gates } : null
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

const readIcThresholds = (
  plant: CompiledProcessPlant,
  path: VariablePath,
): ComposedDisplayIcThresholds => {
  const thresholds: Array<Omit<ComposedDisplayThreshold, 'order'>> = []
  const combinedRules: ComposedDisplayCombinedRule[] = []
  for (const rule of plant.automation.rules) {
    if (!rule.enabled) continue
    const condition = rule.condition
    if (condition.type === 'comparison') {
      if (resolveProcessPlantSignalPath(plant.graph, condition.signal) !== path) continue
      // Equality rules act on discrete states; they have no position on a value axis.
      if (typeof condition.value !== 'number' || condition.operator === '==' || condition.operator === '!=') continue
      const severity = severityFor(rule)
      thresholds.push({
        ruleId: rule.id,
        label: labelFor(rule),
        kind: icRuleKind(rule),
        ...(severity === undefined ? {} : { severity }),
        ...actionFields(plant, rule),
        operator: condition.operator,
        direction: condition.operator === '<' || condition.operator === '<=' ? 'low' : 'high',
        value: condition.value,
        ...modesOf(plant, rule),
      })
      continue
    }
    // A limit on this value that other signals' on/off states only gate (SI on
    // low pressure unless an operator blocked it) still has its place on the
    // axis: it is drawn, naming what gates it. Votes, alternatives and limits
    // shared with other values stay listed.
    const gated = condition.type === 'all' ? gatedLimit(plant, condition.conditions, path) : null
    if (gated !== null) {
      const severity = severityFor(rule)
      thresholds.push({
        ruleId: rule.id,
        label: labelFor(rule),
        kind: icRuleKind(rule),
        ...(severity === undefined ? {} : { severity }),
        ...actionFields(plant, rule),
        operator: gated.limit.operator,
        direction: gated.limit.operator === '<' || gated.limit.operator === '<=' ? 'low' : 'high',
        value: gated.limit.value,
        ...modesOf(plant, rule),
        gatedBy: gated.gates.map(gate => gate.name),
        gates: gated.gates.map(gate => ({ path: gate.path, on: gate.on })),
      })
      continue
    }
    if (conditionWatches(plant, condition, path)) {
      combinedRules.push({ ruleId: rule.id, label: labelFor(rule), kind: icRuleKind(rule) })
    }
  }
  return {
    thresholds: orderLimits(thresholds).sort((left, right) => left.value - right.value || left.ruleId.localeCompare(right.ruleId)),
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
