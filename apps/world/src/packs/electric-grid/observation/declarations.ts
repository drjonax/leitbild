// The Grid's observation declarations (plan v3.1 §2.2; architecture A1, N2). A Grid is one object with
// thousands of elements, so declarations are element-scoped: without element ids, the grid-wide and
// island observables and the element catalogue; with them, those elements' observables. A signal id is
// the Historian's where recorded (`grid.<name>`, `island.<id>.<name>`, `<asset id>.<name>`); an
// element is an asset, station or island id. Thresholds are the Automation's alarm bands, never copied.
import { createHash } from 'node:crypto'
import { recordingSeriesIdFor, type ScenarioRecordingSelection } from '../../../core/model/index.ts'
import { defineObservationCapability, observationShapes, type ObservationDeclaration } from '../../../core/observation/capabilities.ts'
import type { Observable, Observation, Quantity } from '../../../core/observation/model.ts'
import { rejectCapabilityTarget } from '../../../simulation/capability-rejection.ts'
import { gridFor, type GridRuntimes } from '../queries/common.ts'
import { electricGridRecordingProfiles, gridOperationsSignals } from '../recording.ts'
import type { GridAlarmPriority } from '../runtime/alarms.ts'
import type { GridBranchDefinition } from '../grid-model.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { solvedGridIslands } from '../runtime/island-lifecycle.ts'
import { generatorLifecycleCodes } from '../runtime/state/arrays.ts'

export type GridReading = Pick<Observation, 'value' | 'quality'>
export interface GridSignal {
  readonly key: string; readonly label: string; readonly quantity: Quantity; readonly unit: string; readonly states?: ReadonlyArray<string>
  readonly recorded?: 'operations' | 'engineering'; readonly bands?: 'frequency' | 'loading'
  /** The lead rank it declares, 1 first. */
  readonly lead?: number
  readonly read: (grid: GridRuntimeInstance, id: string) => GridReading
}
type ElementClass = 'station' | 'bus' | 'branch' | 'generator' | 'connection-point' | 'hvdc-link' | 'external-system' | 'island'
interface Element { readonly id: string; readonly class: ElementClass; readonly label: string; readonly shortLabel?: string; readonly group?: string }
/** The record's priority on the six-level scale (1 is the most urgent). */
export const gridPriority: Readonly<Record<GridAlarmPriority, 'alarm' | 'warning' | 'caution'>> = { 1: 'alarm', 2: 'warning', 3: 'caution' }
const reading = (value: number | boolean | string | null | undefined, uncertain = false): GridReading =>
  ({ value: value ?? null, quality: value === null || value === undefined ? 'not-applicable' : uncertain ? 'uncertain' : 'good' })
const flowOf = (grid: GridRuntimeInstance, id: string, key: 'flowMw' | 'loadingPercent'): GridReading => { const branch = grid.branches.get(id)!; return reading(branch[key], branch.flowModel === 'dc') }
const power = { quantity: 'electric-power', unit: 'MW' } as const
const islandOf = (grid: GridRuntimeInstance, id: string) => grid.projection.islands.find(island => island.id === id)
export const gridSignals: Readonly<Record<ElementClass, ReadonlyArray<GridSignal>>> = {
  station: [],
  'external-system': [],
  bus: [
    { key: 'energized', label: 'Energised', quantity: 'state', unit: '', recorded: 'engineering', read: (grid, id) => reading(grid.busStates.get(id)?.energized) },
    { key: 'frequency', label: 'Frequency', quantity: 'frequency', unit: 'Hz', recorded: 'engineering', bands: 'frequency', read: (grid, id) => reading(grid.busStates.get(id)?.frequencyHz) },
    { key: 'voltage', label: 'Voltage', quantity: 'voltage', unit: 'pu', read: (grid, id) => reading(grid.busStates.get(id)?.voltagePu) },
  ],
  branch: [
    { key: 'flow', label: 'Flow', ...power, recorded: 'engineering', read: (grid, id) => flowOf(grid, id, 'flowMw') },
    { key: 'loading', label: 'Loading', quantity: 'loading', unit: '%', recorded: 'engineering', bands: 'loading', read: (grid, id) => flowOf(grid, id, 'loadingPercent') },
    { key: 'state', label: 'State', quantity: 'state', unit: '', states: ['closed', 'open', 'tripped'], read: (grid, id) => reading(grid.branches.get(id)!.state) },
  ],
  generator: [
    { key: 'dispatch', label: 'Dispatch', ...power, recorded: 'engineering', read: (grid, id) => reading(grid.generators.get(id)!.dispatchMw) },
    { key: 'state', label: 'State', quantity: 'state', unit: '', states: generatorLifecycleCodes, read: (grid, id) => reading(grid.generators.get(id)!.state) },
  ],
  'connection-point': [{ key: 'exchange', label: 'Exchange into the grid', ...power, read: (grid, id) => reading(grid.externalConnections.get(id)?.systemActivePowerMw ?? 0) }],
  'hvdc-link': [
    { key: 'transfer', label: 'Transfer', ...power, read: (grid, id) => reading(grid.hvdcLinks.get(id)!.transferMw) },
    { key: 'state', label: 'State', quantity: 'state', unit: '', states: ['deblocked', 'blocked', 'tripped'], read: (grid, id) => reading(grid.hvdcLinks.get(id)!.state) },
  ],
  island: [
    { key: 'frequency', label: 'Frequency', quantity: 'frequency', unit: 'Hz', recorded: 'operations', bands: 'frequency', read: (grid, id) => reading(islandOf(grid, id)?.frequencyHz) },
    { key: 'energized', label: 'Energised', quantity: 'state', unit: '', recorded: 'operations', read: (grid, id) => reading(islandOf(grid, id)?.energized) },
  ],
}
const operationsQuantity = { frequency: 'frequency', 'active-power': 'electric-power', ratio: 'loading', voltage: 'voltage', count: 'count' } as const
/** The grid-wide signals, from the Historian's operations list. */
export const gridWideSignals: ReadonlyArray<GridSignal & { readonly signalId: string }> = gridOperationsSignals.map(item => ({
  signalId: item.signalId, key: item.signalId, label: item.title, quantity: operationsQuantity[item.quantity], unit: item.unit, recorded: 'operations', ...('lead' in item ? { lead: item.lead } : {}),
  ...(item.quantity === 'frequency' ? { bands: 'frequency' as const } : item.quantity === 'ratio' ? { bands: 'loading' as const } : {}),
  read: grid => reading(grid.projection[item.key]),
}))
export const gridSignalId = (elementClass: string, id: string, key: string): string => elementClass === 'island' ? `island.${id}.${key}` : `${id}.${key}`
const catalogues = new WeakMap<GridRuntimeInstance['definition'], { readonly elements: ReadonlyArray<Element>; readonly byId: ReadonlyMap<string, Element>; readonly names: ReadonlyMap<string, string> }>()
/** Elements of the Grid's model, with a name per element (≤ 52 characters, unique, in catalogue order) for observable labels. */
const catalogueOf = (grid: GridRuntimeInstance) => catalogues.get(grid.definition) ?? (() => {
  const { buses, branches, generators, connectionPoints, hvdcLinks, externalSystems } = grid.definition.model
  const stationName = (label: string): string => label.replace(/\s+\d+(?:[.,]\d+)?\s*kV$/i, '')
  const short = (label: string): { shortLabel?: string } => (label.length <= 24 ? { shortLabel: label } : {})
  const stations = new Map<string, string>()
  for (const bus of [...buses].sort((a, b) => b.nominalKv - a.nominalKv)) if (bus.sourceFeatureId !== undefined && !stations.has(bus.sourceFeatureId)) stations.set(bus.sourceFeatureId, stationName(bus.label))
  const station = (busId: string): { group?: string } => { const id = grid.definition.index.busById.get(busId)?.sourceFeatureId; return id === undefined ? {} : { group: `station:${id}` } }
  const elements: Element[] = [
    ...[...stations].map(([id, label]): Element => ({ id: `station:${id}`, class: 'station', label, ...short(label) })),
    ...buses.map((bus): Element => ({ id: bus.id, class: 'bus', label: bus.label, ...station(bus.id) })),
    ...branches.map((branch): Element => ({ id: branch.id, class: 'branch', label: branch.label })),
    ...generators.map((generator): Element => ({ id: generator.id, class: 'generator', label: generator.label, ...station(generator.busId) })),
    ...connectionPoints.map((point): Element => ({ id: point.id, class: 'connection-point', label: point.label, ...station(point.busId) })),
    ...hvdcLinks.map((link): Element => ({ id: link.id, class: 'hvdc-link', label: link.label })),
    ...externalSystems.map((system): Element => ({ id: system.id, class: 'external-system', label: system.label })),
  ]
  const cut = (label: string, room: number): string => (label.length <= room ? label : `${label.slice(0, room - 1)}…`)
  const [counts, seen] = [new Map<string, number>(), new Map<string, number>()]
  for (const element of elements) counts.set(cut(element.label, 52), (counts.get(cut(element.label, 52)) ?? 0) + 1)
  const names = new Map(elements.map(element => {
    const [name, n] = [cut(element.label, 52), (seen.get(cut(element.label, 52)) ?? 0) + 1]
    seen.set(name, n)
    return [element.id, counts.get(name) === 1 ? name : `${cut(element.label, 49 - `${n}`.length)} (${n})`]
  }))
  const catalogue = { elements, byId: new Map(elements.map(element => [element.id, element])), names }
  catalogues.set(grid.definition, catalogue)
  return catalogue
})()

/** The Grid's islands as elements, named by their current anchor bus as islands.list names them. */
const islandElements = (grid: GridRuntimeInstance): ReadonlyArray<Element> => solvedGridIslands(grid).islands
  .map(island => ({ id: island.id, class: 'island', label: `Island at ${catalogueOf(grid).names.get(island.anchorBusId)}` }))
/** A model or island element of the Grid by id, and its name for labels and alert messages (unique, at most 62 characters). */
export const gridElement = (grid: GridRuntimeInstance, id: string): Element | undefined => catalogueOf(grid).byId.get(id) ?? islandElements(grid).find(island => island.id === id)
export const gridElementName = (grid: GridRuntimeInstance, id: string): string | undefined => {
  const element = gridElement(grid, id)
  return element?.class === 'island' ? element.label : catalogueOf(grid).names.get(id)
}

const thresholds = (grid: GridRuntimeInstance, signal: GridSignal, branchId?: string): Observable['thresholds'] => {
  const { alarms, swing } = grid.definition.automation
  if (signal.bands === 'frequency') return alarms.islandFrequency.flatMap((band, order) => (['under', 'over'] as const).map(side => ({
    id: `${side}-frequency-${band.id}`, direction: side === 'under' ? 'low' as const : 'high' as const, order: order + 1, effect: 'alarm' as const, priority: gridPriority[band.priority],
    value: swing.nominalFrequencyHz + (side === 'under' ? -band.deviationHz : band.deviationHz),
  })))
  // `loading` is % of the continuous rating: an emergency-rating band acts at its equivalent there (one branch's ratings only).
  const branch = branchId === undefined ? undefined : grid.definition.index.assetById.get(branchId)!.definition as GridBranchDefinition
  if (signal.bands === 'loading') return alarms.branchLoading.filter(band => band.basis === 'continuous-rating' || branch !== undefined).map((band, order) => ({
    id: `loading-${band.id}`, direction: 'high' as const, order: order + 1, effect: 'alarm' as const, priority: gridPriority[band.priority],
    value: band.basis === 'continuous-rating' ? band.raisePercent : band.raisePercent * branch!.emergencyRatingMw / branch!.ratingMw,
  }))
  return []
}

const observable = (grid: GridRuntimeInstance, recording: ScenarioRecordingSelection | undefined, signalId: string, signal: GridSignal, label: string, element?: Element): Observable => {
  const recorded = signal.recorded === 'operations' || (signal.recorded === 'engineering' && recording?.profileId === 'engineering' && !grid.hvdcTerminals.has(element?.id ?? ''))
  const interval = recording?.intervalMs ?? electricGridRecordingProfiles.find(profile => profile.id === recording?.profileId)?.defaultIntervalMs
  return {
    ref: `${grid.definition.gridId}#${signalId}`, label, quantity: signal.quantity, unit: signal.unit,
    valueType: signal.states ? 'enum' : signal.quantity === 'state' ? 'boolean' : 'number', ...(signal.states ? { states: signal.states.map(value => ({ value, label: value })) } : {}),
    thresholds: thresholds(grid, signal, element?.class === 'branch' ? element.id : undefined), basis: 'model',
    series: recorded && recording !== undefined && interval !== undefined ? { seriesId: recordingSeriesIdFor(grid.definition.gridId, signalId), intervalMs: interval } : null,
    ...(element === undefined ? {} : { element: element.id }),
    ...(signal.lead === undefined ? {} : { lead: signal.lead }),
  }
}

export const declareGrid = (grid: GridRuntimeInstance, recording: ScenarioRecordingSelection | undefined, elementIds?: ReadonlyArray<string>): ObservationDeclaration => {
  const islands = islandElements(grid)
  const revision = `${grid.definition.definitionDigest.slice(0, 40)}:${createHash('sha256').update(islands.map(island => island.label + island.id).join('\n')).digest('hex').slice(0, 16)}`
  const elements = [...catalogueOf(grid).elements, ...islands]
  const unknown = (elementIds ?? []).filter(id => gridElement(grid, id) === undefined)
  if (unknown.length > 0) rejectCapabilityTarget(`Grid ${grid.definition.gridId} has no element ${unknown.join(', ')}; element ids come from its declaration's element catalogue.`)
  const ofElement = (element: Element) => gridSignals[element.class].map(signal => observable(grid, recording, gridSignalId(element.class, element.id, signal.key), signal, `${gridElementName(grid, element.id)} · ${signal.label}`, element))
  return elementIds === undefined
    ? { objectId: grid.definition.gridId as ObservationDeclaration['objectId'], revision, elements, observables: [...gridWideSignals.map(signal => observable(grid, recording, signal.signalId, signal, signal.label)), ...islands.flatMap(ofElement)] }
    : { objectId: grid.definition.gridId as ObservationDeclaration['objectId'], revision, elements: elementIds.map(id => gridElement(grid, id)!), observables: elementIds.flatMap(id => ofElement(gridElement(grid, id)!)) }
}

export const gridObservationDeclarationsQuery = {
  capability: defineObservationCapability('declarations', {
    id: 'world.electric-grid.observation.declarations', title: 'Declare Grid observations',
    description: 'World-internal: the Grid\'s element catalogue and grid-wide observables, or the observables of named elements.',
  }),
  answer: (rawInput: unknown, grids: GridRuntimes, recording?: ScenarioRecordingSelection) => {
    const input = observationShapes.declarations.input.parse(rawInput)
    return { declarations: input.objectIds.map(objectId => {
      const declaration = declareGrid(gridFor(grids, objectId), recording, input.elementIds)
      return input.known?.[objectId] === declaration.revision ? { objectId, revision: declaration.revision, unchanged: true as const } : declaration
    }) }
  },
}
