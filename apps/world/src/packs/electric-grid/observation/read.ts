// Reads the Grid's declared observables (plan v3.1 §2.2; architecture A1, N2) at the Grid's simulation
// time. A value's priority is its active alarm record's, so a value is coloured only with a matching
// active alert; DC flows read `uncertain`, values that do not exist now `not-applicable`.
import { defineObservationCapability, observationShapes } from '../../../core/observation/capabilities.ts'
import type { Observation } from '../../../core/observation/model.ts'
import { refObjectId } from '../../../core/model/alerts.ts'
import { gridFor, type GridRuntimes } from '../queries/common.ts'
import { gridAlarmShelved, type GridAlarmRecord } from '../runtime/alarms.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { gridElement, gridPriority, gridSignalId, gridSignals, gridWideSignals, type GridSignal } from './declarations.ts'

/** The signal an alarm record is about, if it has one: frequency, loading and trips by element, energisation by island. */
export const gridAlarmSignal = (record: Pick<GridAlarmRecord, 'scope' | 'assetId' | 'condition'>): string | undefined =>
  record.scope === 'island' && /^(under|over)-frequency-/.test(record.condition) ? gridSignalId('island', record.assetId, 'frequency')
    : record.scope === 'island' && record.condition === 'de-energised' ? gridSignalId('island', record.assetId, 'energized')
      : record.scope === 'branch' && record.condition.startsWith('loading-') ? gridSignalId('branch', record.assetId, 'loading')
        : record.condition === 'tripped' && record.scope !== 'island' && record.scope !== 'external' ? gridSignalId(record.scope, record.assetId, 'state')
          : undefined

/** Active, unshelved records by the signal they are about, most urgent first. */
const alarmed = (grid: GridRuntimeInstance): ReadonlyMap<string, ReadonlyArray<GridAlarmRecord>> => {
  const bySignal = new Map<string, GridAlarmRecord[]>()
  for (const record of grid.alarms.records.values()) {
    const signalId = record.active && !gridAlarmShelved(record) ? gridAlarmSignal(record) : undefined
    if (signalId !== undefined) bySignal.set(signalId, [...bySignal.get(signalId) ?? [], record].sort((a, b) => a.priority - b.priority || a.raisedAtElapsedMs - b.raisedAtElapsedMs))
  }
  return bySignal
}

const signalFor = (grid: GridRuntimeInstance, signalId: string): { readonly signal: GridSignal; readonly id: string } | undefined => {
  const wide = gridWideSignals.find(signal => signal.signalId === signalId)
  if (wide !== undefined) return { signal: wide, id: grid.definition.gridId }
  const island = /^island\.(.+)\.([a-z-]+)$/.exec(signalId)
  const cut = signalId.lastIndexOf('.')
  const [id, key] = island !== null ? [island[1]!, island[2]!] : [signalId.slice(0, cut), signalId.slice(cut + 1)]
  const element = gridElement(grid, id)
  const signal = element === undefined || (element.class === 'island') !== (island !== null) ? undefined : gridSignals[element.class].find(candidate => candidate.key === key)
  return signal === undefined ? undefined : { signal, id }
}

const observe = (grid: GridRuntimeInstance, bySignal: ReadonlyMap<string, ReadonlyArray<GridAlarmRecord>>, signalId: string, rank?: number): Observation | undefined => {
  const found = signalFor(grid, signalId)
  if (found === undefined) return undefined
  const record = bySignal.get(signalId)?.[0] ?? (signalId === 'grid.frequency' && grid.projection.frequencyIslandId !== null ? bySignal.get(gridSignalId('island', grid.projection.frequencyIslandId, 'frequency'))?.[0] : undefined)
  return {
    ref: `${grid.definition.gridId}#${signalId}`, ...found.signal.read(grid, found.id), priority: record === undefined ? 'none' : gridPriority[record.priority],
    at: grid.projection.updatedAt, clock: 'simulation', ...(rank === undefined ? {} : { rank }),
  }
}

const headline = ['grid.frequency', 'grid.maximum-branch-loading', 'grid.unserved-load', 'grid.reserve', 'grid.island-count', 'grid.active-alarms']
/** The lead: alarmed values (most urgent, then oldest); each energised island's frequency while the Grid is split; then the headline grid-wide values. */
const lead = (grid: GridRuntimeInstance, bySignal: ReadonlyMap<string, ReadonlyArray<GridAlarmRecord>>, count: number): ReadonlyArray<Observation> => {
  const ordered = [...bySignal].sort(([, a], [, b]) => a[0]!.priority - b[0]!.priority || a[0]!.raisedAtElapsedMs - b[0]!.raisedAtElapsedMs).map(([signalId]) => signalId)
  const islands = grid.projection.activeIslandCount > 1 ? grid.projection.islands.filter(island => island.energized).map(island => gridSignalId('island', island.id, 'frequency')) : []
  return [...new Set([...ordered, ...islands, ...headline, ...gridWideSignals.map(signal => signal.signalId)])].slice(0, count).flatMap((signalId, rank) => observe(grid, bySignal, signalId, rank + 1) ?? [])
}

export const gridObservationReadQuery = {
  capability: defineObservationCapability('read', {
    id: 'world.electric-grid.observation.read', title: 'Read Grid observations',
    description: 'World-internal: the values of declared Grid observables by ref, or the Grid\'s lead values.',
  }),
  answer: (rawInput: unknown, grids: GridRuntimes) => {
    const input = observationShapes.read.input.parse(rawInput)
    const alarmsOf = new Map<GridRuntimeInstance, ReadonlyMap<string, ReadonlyArray<GridAlarmRecord>>>()
    const of = (grid: GridRuntimeInstance) => alarmsOf.get(grid) ?? alarmsOf.set(grid, alarmed(grid)).get(grid)!
    if ('lead' in input) { const grid = gridFor(grids, input.lead.objectId); return { observations: lead(grid, of(grid), input.lead.count), unknown: [] } }
    const answers = input.refs.map(ref => { const grid = grids.get(refObjectId(ref)); return { ref, observation: grid === undefined ? undefined : observe(grid, of(grid), ref.slice(ref.indexOf('#') + 1)) } })
    return { observations: answers.flatMap(answer => answer.observation ?? []), unknown: answers.filter(answer => answer.observation === undefined).map(answer => answer.ref) }
  },
}
