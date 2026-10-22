import type { ObjectId, Priority } from '../../../core/model/index.ts'
import type { Observable, Observation } from '../../../core/observation/model.ts'
import { NO_FLOW_FRACTION } from '../equipment/link-flow.ts'
import type { CompiledStateAspect, VariablePath } from '../graph/index.ts'
import { challengePriority } from '../ic/alarm-philosophy.ts'
import { aspectStateWords, followAllowanceMs, plantControlsFor } from '../operations/controls.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { processPlantOperatingMode } from '../runtime/index.ts'
import { safetyFunctionStatusWords, safetyFunctionText, type SafetyFunctionEvaluation } from '../safety-functions.ts'

// What a Plant declares beside its signals (plan v4 D1): each item of its
// equipment that runs, is live, or opens and shuts, its state as one word, in
// the words its controls use ("RUN", "SHUT", "ON LINE", "LIVE"), with the
// command it does not follow where it does not; each critical safety
// function's status, the procedure its colour sends operators to and what its
// tree's path ends in; and the unit's operating mode, the first declared mode
// that holds. None is a signal of its own: `<item>.state`, `csf.<function>`
// and `mode` are read here from the signals they rest on.

interface ItemState {
  /** The item: its component, or the device it bundles, an element of its own. */
  readonly element: string
  readonly label: string
  readonly aspect: CompiledStateAspect
  readonly words: { readonly on: string; readonly off: string }
  /** Whether it is a valve whose position is a number, which may stand between its two ends. */
  readonly numeric: boolean
  /** Whether the model solves its state; where it does not (an accumulator's discharge isolation valve follows its command at once), it reads "position not measured". */
  readonly measured: boolean
  readonly noFlowBelow: number
}

/** A valve reads SHUT below 5 % of its travel and OPEN above 95 %, as its symbol draws it; between, part open. */
const SHUT_BELOW = 0.05
const OPEN_ABOVE = 0.95

const itemStatesByPlant = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, ItemState>>()

/** The aspects whose state is one word: it runs, it is live, it is open or shut. */
const SWITCHING: ReadonlySet<string> = new Set(['running', 'energized', 'position'])

/**
 * Each item's state, by the path its state observable reads at: the aspect a control of its own commands; else, for
 * an item no control of its own commands (the turbine, offered only its trip; a code safety valve; a bus), its first
 * switching aspect the model solves, else one it is commanded on.
 */
const itemStates = (plant: CompiledProcessPlant): ReadonlyMap<string, ItemState> => itemStatesByPlant.get(plant) ?? (() => {
  const graph = plant.graph
  const states = new Map(plantControlsFor(plant).items.flatMap(item => {
    const control = item.offered.find(entry => entry.aspect !== undefined && entry.state !== undefined) ?? item.offered.find(entry => entry.aspect !== undefined)
    const component = graph.components[item.item.component]!
    const device = item.item.kind === 'device' ? component.semantics.embedded.find(candidate => item.item.kind === 'device' && candidate.id === item.item.device) : undefined
    const own = device?.aspects ?? component.semantics.aspects
    const aspect = control === undefined
      ? own.find(candidate => SWITCHING.has(candidate.aspect) && candidate.state !== undefined) ?? own.find(candidate => SWITCHING.has(candidate.aspect) && candidate.command !== undefined)
      : own.find(candidate => candidate.aspect === control.aspect && candidate.state?.path === control.state)
    const words = aspect === undefined ? null : aspectStateWords(graph, aspect, device?.function ?? component.semantics.function)
    if (aspect === undefined || words === null) return []
    const path = `${item.id}.state`
    if (graph.signalBindingByPath.has(path as VariablePath)) throw new Error(`${path} is a signal of the Plant and the state of an item of its equipment`)
    const rated = Math.max(0, ...component.semantics.ratedOutflow.map(rating => rating.flowKgPerS))
    const measured = aspect.state !== undefined
    const numeric = measured && aspect.aspect === 'position' && graph.signalBindingByPath.get(aspect.state!.path)?.quantity !== 'boolean'
    return [[path, { element: item.id, label: `State · ${item.label}`, aspect, words, numeric, measured, noFlowBelow: rated * NO_FLOW_FRACTION }] as const]
  }))
  itemStatesByPlant.set(plant, states)
  return states
})()

/**
 * What each item's state drives on a drawing, by element: it runs, or it conducts (contacts closed, a supply live, a
 * valve not shut). The state observable is the binding, so a drawing writes its word and the command it does not follow.
 */
export const itemStateRoles = (plant: CompiledProcessPlant): ReadonlyMap<string, { readonly role: 'running' | 'conducting'; readonly path: string }> =>
  new Map([...itemStates(plant)].map(([path, state]) => [state.element, { role: state.aspect.aspect === 'running' ? 'running' as const : 'conducting' as const, path }] as const))

/**
 * How far a part is in: its reading over its declared range, from the end it is out at to the end its insertion
 * declares it fully in at (`insertedAt`; rods are in at zero steps withdrawn), 0 out to 1 fully in; null where it
 * reads nothing.
 */
export const insertedShare = (value: unknown, range: { readonly min: number; readonly max: number }, insertedAt: 'min' | 'max'): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const share = insertedAt === 'min' ? (range.max - value) / (range.max - range.min) : (value - range.min) / (range.max - range.min)
  return Math.min(1, Math.max(0, share))
}

/**
 * Each part an item inserts (a rod bank), as the share of its declared range it stands inserted (insertedShare): what a
 * drawing's `position` binding draws a part at, as the binding role declares it (a part's insertion, 1 fully in).
 */
const insertionParts = (plant: CompiledProcessPlant): ReadonlyMap<string, { readonly element: string; readonly source: VariablePath; readonly range: { readonly min: number; readonly max: number }; readonly insertedAt: 'min' | 'max'; readonly label: string }> =>
  new Map(plant.graph.components.flatMap(component => (component.semantics.insertion?.groups.flat() ?? []).map(part => {
    const path = `${part.path}.inserted`
    if (plant.graph.signalBindingByPath.has(path as VariablePath)) throw new Error(`${path} is a signal of the Plant and the inserted share of a part it inserts`)
    return [path, { element: String(component.id), source: part.path, range: part.range, insertedAt: component.semantics.insertion!.insertedAt, label: `${plant.graph.signalBindingByPath.get(part.path)!.label} · share inserted` }] as const
  })))

/** The positions a drawing draws an element's parts at, by element: its parts' inserted shares. */
export const insertionPositions = (plant: CompiledProcessPlant): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byElement = new Map<string, string[]>()
  for (const [path, part] of insertionParts(plant)) byElement.set(part.element, [...byElement.get(part.element) ?? [], path])
  return byElement
}

/** The path a critical safety function's status observable reads at. */
export const safetyFunctionRef = (id: string): string => `csf.${id}`
const statuses = ['green', 'yellow', 'orange', 'red', 'unknown', 'not-monitored'] as const
/** The path the unit's operating mode reads at, and its value while no declared mode holds. */
const MODE = 'mode'
const NO_MODE = 'none'

/** The state and safety-function observables of a Plant. */
export const derivedObservables = (objectId: ObjectId, plant: CompiledProcessPlant): ReadonlyArray<Observable> => [
  ...[...itemStates(plant)].map(([path, state]): Observable => ({
    ref: `${objectId}#${path}`, label: state.label, quantity: 'state', unit: '', valueType: 'enum', thresholds: [], series: null, element: state.element,
    // The states a running or conducting binding reads as on (Q8): on, and a valve part open, which passes flow.
    states: [{ value: 'on', label: state.words.on, active: true }, { value: 'off', label: state.words.off }, ...(state.numeric ? [{ value: 'between', label: 'part open', active: true as const }] : [])],
  })),
  ...plant.automation.safetyFunctions.map((safetyFunction): Observable => {
    if (plant.graph.signalBindingByPath.has(safetyFunctionRef(safetyFunction.id) as VariablePath)) throw new Error(`${safetyFunctionRef(safetyFunction.id)} is a signal of the Plant and a safety function`)
    return {
      ref: `${objectId}#${safetyFunctionRef(safetyFunction.id)}`, label: `${safetyFunction.label} (CSF)`, shortLabel: safetyFunction.shortLabel, quantity: 'state', unit: '', valueType: 'enum',
      states: statuses.map(value => ({ value, label: safetyFunctionStatusWords(value) })), thresholds: [], series: null,
    }
  }),
  ...[...insertionParts(plant)].map(([path, part]): Observable => ({
    ref: `${objectId}#${path}`, label: part.label, quantity: 'fraction', unit: '1', valueType: 'number', thresholds: [], series: null, element: part.element,
  })),
  ...(plant.automation.operatingModes.length === 0 ? [] : [((): Observable => {
    if (plant.automation.operatingModes.some(mode => mode.id === NO_MODE)) throw new Error(`a Plant mode is named ${NO_MODE}, the value that says no declared mode holds`)
    return {
      ref: `${objectId}#${MODE}`, label: 'Operating mode', quantity: 'state', unit: '', valueType: 'enum', thresholds: [], series: null,
      states: [...plant.automation.operatingModes.map(mode => ({ value: mode.id, label: mode.label })), { value: NO_MODE, label: 'No declared mode holds' }],
    }
  })()]),
]

/** Where a state signal or a command to it stands: at its on or off end, or between. */
const endOf = (state: ItemState, value: unknown, unit: string | undefined): 'on' | 'off' | 'between' | null => {
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (state.aspect.aspect === 'position') {
    const travel = unit === 'percent' ? value / 100 : value
    return travel < SHUT_BELOW ? 'off' : travel > OPEN_ABOVE ? 'on' : 'between'
  }
  // A flow runs equipment only above its no-flow band (a turbine while steam drives it); a speed as it reads.
  return (state.aspect.state?.reading === 'flow' ? value !== 0 && Math.abs(value) >= state.noFlowBelow : value > 0) ? 'on' : 'off'
}

/** How a command an item does not follow is written: "CMD RUN", as the Plant's control panel writes a demand ("CMD 40 %"), in the room a drawing keeps for the state word it stands in for. */
export const commandNotFollowed = (word: string): string => `CMD ${word}`

/**
 * The command an item does not follow: it demands the other end, and has
 * stood longer than the equipment's declared travel and its margin since a
 * person or an AI agent issued it (or since an unknown time, as the I&C or a
 * scenario moved it); never where the model declares no travel time.
 */
const unfollowed = (system: ProcessPlantRuntimeInstance, state: ItemState, now: 'on' | 'off' | 'between'): string | undefined => {
  const { command, travel } = state.aspect
  if (command === undefined || travel === undefined) return undefined
  const read = system.runtime.readVariableSnapshot(command)
  const wanted = endOf(state, read.value, read.unit)
  if (wanted === null || wanted === now) return undefined
  const issued = system.operations?.log().filter(record => record.path === command && record.value === read.value).at(-1)
  const heldMs = issued === undefined ? undefined : system.runtime.elapsedMs() - issued.elapsedMs
  const allowance = followAllowanceMs(1_000 * (wanted === 'off' ? travel.offS : travel.onS))
  return heldMs !== undefined && heldMs <= allowance ? undefined : commandNotFollowed(wanted === 'between' ? 'part open' : state.words[wanted])
}

/** A derived observable's reading now, by the path it is declared at (never a signal's). */
export const readDerived = (
  system: ProcessPlantRuntimeInstance,
  path: string,
  safetyFunctions: () => ReadonlyArray<SafetyFunctionEvaluation>,
): Pick<Observation, 'value' | 'quality' | 'priority' | 'why'> => {
  const state = itemStates(system.plant).get(path)
  if (state !== undefined && !state.measured) return { value: null, quality: 'not-applicable', priority: 'none', why: 'position not measured' }
  if (state !== undefined) {
    const read = system.runtime.readVariableSnapshot(state.aspect.state!.path)
    const now = endOf(state, read.value, read.unit)
    const why = now === null ? undefined : unfollowed(system, state, now)
    return { value: now, quality: now === null ? 'bad' : 'good', priority: 'none', ...(why === undefined ? {} : { why }) }
  }
  const part = insertionParts(system.plant).get(path)
  if (part !== undefined) {
    const value = insertedShare(system.runtime.readVariableSnapshot(part.source).value, part.range, part.insertedAt)
    return { value, quality: value === null ? 'bad' : 'good', priority: 'none' }
  }
  if (path === MODE) {
    const mode = processPlantOperatingMode({ system: system.plant, runtime: system.runtime, modes: system.plant.automation.operatingModes })
    return { value: mode?.id ?? NO_MODE, quality: 'good', priority: 'none' }
  }
  const evaluation = safetyFunctions().find(candidate => safetyFunctionRef(candidate.id) === path)
  if (evaluation === undefined) throw new Error(`${path} is neither an item's state, a safety function nor the mode of the Plant`)
  const priority: Priority = challengePriority[evaluation.status] ?? 'none'
  return { value: evaluation.status, quality: evaluation.status === 'unknown' ? 'uncertain' : 'good', priority, why: safetyFunctionText(evaluation) }
}
