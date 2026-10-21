import type { ObjectId, Priority } from '../../../core/model/index.ts'
import type { Observable, Observation } from '../../../core/observation/model.ts'
import { NO_FLOW_FRACTION } from '../equipment/link-flow.ts'
import type { CompiledStateAspect, VariablePath } from '../graph/index.ts'
import { challengePriority } from '../ic/alarm-philosophy.ts'
import { aspectStateWords, followAllowanceMs, plantControlsFor } from '../operations/controls.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { safetyFunctionText, type SafetyFunctionEvaluation } from '../safety-functions.ts'

// What a Plant declares beside its signals (plan v4 D1): each item a person
// operates, its state as one word, in the words its controls use ("RUN",
// "SHUT", "ON LINE"), with the command it does not follow where it does not;
// and each critical safety function's status, the procedure its colour sends
// operators to and what its tree's path ends in. Neither is a signal of its
// own: `<item>.state` and `csf.<function>` are read here from the signals
// they rest on.

interface OperatedState {
  readonly element: string
  /** Whether the item is its element itself, not a device the element bundles (the pressurizer's PORV). */
  readonly whole: boolean
  readonly label: string
  readonly aspect: CompiledStateAspect
  readonly words: { readonly on: string; readonly off: string }
  /** Whether its state signal is a number (a valve's position), which may stand between its two ends. */
  readonly numeric: boolean
  readonly noFlowBelow: number
}

/** A valve reads SHUT below 5 % of its travel and OPEN above 95 %, as its symbol draws it; between, part open. */
const SHUT_BELOW = 0.05
const OPEN_ABOVE = 0.95

const operated = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, OperatedState>>()

/** The items a person operates whose state the model solves, by the path their state observable reads at. */
const operatedStates = (plant: CompiledProcessPlant): ReadonlyMap<string, OperatedState> => operated.get(plant) ?? (() => {
  const graph = plant.graph
  const states = new Map(plantControlsFor(plant).items.flatMap(item => {
    const control = item.offered.find(entry => entry.aspect !== undefined && entry.state !== undefined)
    const component = graph.components[item.item.component]!
    const device = item.item.kind === 'device' ? component.semantics.embedded.find(candidate => item.item.kind === 'device' && candidate.id === item.item.device) : undefined
    const aspect = (device?.aspects ?? component.semantics.aspects).find(candidate => candidate.aspect === control?.aspect && candidate.state?.path === control.state)
    const words = aspect === undefined ? null : aspectStateWords(graph, aspect, device?.function ?? component.semantics.function)
    if (aspect === undefined || words === null) return []
    const path = `${item.id}.state`
    if (graph.signalBindingByPath.has(path as VariablePath)) throw new Error(`${path} is a signal of the Plant and the state of an item it operates`)
    const rated = Math.max(0, ...component.semantics.ratedOutflow.map(rating => rating.flowKgPerS))
    return [[path, { element: String(component.id), whole: device === undefined, label: `State · ${item.label}`, aspect, words, numeric: graph.signalBindingByPath.get(aspect.state!.path)?.quantity !== 'boolean', noFlowBelow: rated * NO_FLOW_FRACTION }] as const]
  }))
  operated.set(plant, states)
  return states
})()

/** Whether a state runs or conducts while on (a pump runs, contacts close, a supply is live); a valve's position is a value, not a switch. */
const switches = (state: OperatedState): boolean => state.aspect.aspect !== 'position' || !state.numeric

/** What each operated element's state says on a drawing, by element: it runs, or it conducts (contacts closed, a supply live); a valve's position is a value. */
export const operatedStateRoles = (plant: CompiledProcessPlant): ReadonlyMap<string, { readonly role: 'running' | 'conducting'; readonly path: string }> =>
  new Map([...operatedStates(plant)].flatMap(([path, state]) => !state.whole || !switches(state) ? []
    : [[state.element, { role: state.aspect.aspect === 'running' ? 'running' as const : 'conducting' as const, path }] as const]))

/** The path a critical safety function's status observable reads at. */
export const safetyFunctionRef = (id: string): string => `csf.${id}`
const csfWords = { green: 'GREEN', yellow: 'YELLOW', orange: 'ORANGE', red: 'RED', unknown: 'UNKNOWN', 'not-monitored': 'NOT JUDGED' } as const

/** The state and safety-function observables of a Plant. */
export const derivedObservables = (objectId: ObjectId, plant: CompiledProcessPlant): ReadonlyArray<Observable> => [
  ...[...operatedStates(plant)].map(([path, state]): Observable => ({
    ref: `${objectId}#${path}`, label: state.label, quantity: 'state', unit: '', valueType: 'enum', thresholds: [], series: null, element: state.element,
    // The on state is the one a running or conducting binding reads as on (Q8).
    states: [{ value: 'on', label: state.words.on, ...(switches(state) ? { active: true as const } : {}) }, { value: 'off', label: state.words.off }, ...(state.numeric ? [{ value: 'between', label: 'part open' }] : [])],
  })),
  ...plant.automation.safetyFunctions.map((safetyFunction): Observable => {
    if (plant.graph.signalBindingByPath.has(safetyFunctionRef(safetyFunction.id) as VariablePath)) throw new Error(`${safetyFunctionRef(safetyFunction.id)} is a signal of the Plant and a safety function`)
    return {
      ref: `${objectId}#${safetyFunctionRef(safetyFunction.id)}`, label: `${safetyFunction.label} (CSF)`, shortLabel: safetyFunction.shortLabel, quantity: 'state', unit: '', valueType: 'enum',
      states: Object.entries(csfWords).map(([value, label]) => ({ value, label })), thresholds: [], series: null,
    }
  }),
]

/** Where a state signal or a command to it stands: at its on or off end, or between. */
const endOf = (state: OperatedState, value: unknown, unit: string | undefined): 'on' | 'off' | 'between' | null => {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (state.aspect.aspect === 'position') {
    const travel = unit === 'percent' ? value / 100 : value
    return travel < SHUT_BELOW ? 'off' : travel > OPEN_ABOVE ? 'on' : 'between'
  }
  // A flow runs equipment only above its no-flow band (a turbine while steam drives it); a speed as it reads.
  return (state.aspect.state?.reading === 'flow' ? value !== 0 && Math.abs(value) >= state.noFlowBelow : value > 0) ? 'on' : 'off'
}

/**
 * The command an item does not follow: it demands the other end, and has
 * stood longer than the equipment's declared travel and its margin since a
 * person or an AI agent issued it (or since an unknown time, as the I&C or a
 * scenario moved it); never where the model declares no travel time.
 */
const unfollowed = (system: ProcessPlantRuntimeInstance, state: OperatedState, now: 'on' | 'off' | 'between'): string | undefined => {
  const { command, travel } = state.aspect
  if (command === undefined || travel === undefined) return undefined
  const read = system.runtime.readVariableSnapshot(command)
  const wanted = endOf(state, read.value, read.unit)
  if (wanted === null || wanted === now) return undefined
  const issued = system.operations?.log().filter(record => record.path === command && record.value === read.value).at(-1)
  const heldMs = issued === undefined ? undefined : system.runtime.elapsedMs() - issued.elapsedMs
  const allowance = followAllowanceMs(1_000 * (wanted === 'off' ? travel.offS : travel.onS))
  return heldMs !== undefined && heldMs <= allowance ? undefined : `commanded ${wanted === 'between' ? 'part open' : state.words[wanted]}`
}

/** A derived observable's reading now, by the path it is declared at (never a signal's). */
export const readDerived = (
  system: ProcessPlantRuntimeInstance,
  path: string,
  safetyFunctions: () => ReadonlyArray<SafetyFunctionEvaluation>,
): Pick<Observation, 'value' | 'quality' | 'priority' | 'why'> => {
  const state = operatedStates(system.plant).get(path)
  if (state !== undefined) {
    const read = system.runtime.readVariableSnapshot(state.aspect.state!.path)
    const now = endOf(state, read.value, read.unit)
    const why = now === null ? undefined : unfollowed(system, state, now)
    return { value: now, quality: now === null ? 'bad' : 'good', priority: 'none', ...(why === undefined ? {} : { why }) }
  }
  const evaluation = safetyFunctions().find(candidate => safetyFunctionRef(candidate.id) === path)
  if (evaluation === undefined) throw new Error(`${path} is neither an operated item's state nor a safety function of the Plant`)
  const priority: Priority = challengePriority[evaluation.status] ?? 'none'
  return { value: evaluation.status, quality: evaluation.status === 'unknown' ? 'uncertain' : 'good', priority, why: safetyFunctionText(evaluation) }
}
