import { z } from 'zod'
import { gridAlarmCounts, gridAlarmPhase, gridAlarmShelved, type GridAlarmRecord } from '../runtime/alarms.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { solvedGridIslands } from '../runtime/island-lifecycle.ts'
import { defineGridQuery, gridFor, requireGridIsland } from './common.ts'

const finite = z.number().finite()
const count = z.number().int().nonnegative()
const priority = z.union([z.literal(1), z.literal(2), z.literal(3)])

const alarmStateFilter = z.enum(['active', 'unacknowledged', 'cleared', 'shelved'])

const alarmsPayloadSchema = z.object({
  gridId: z.string().min(1),
  priorities: z.array(priority).min(1).max(3).optional().describe('Only alarms of these priorities; 1 is the most urgent.'),
  states: z.array(alarmStateFilter).min(1).max(4).optional()
    .describe('Match any: active, unacknowledged or cleared (each unshelved), or shelved. Absent: every record.'),
  islandId: z.string().min(1).optional().describe('Only alarms of assets in this island (world.electric-grid.islands.list).'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()

const alarmSchema = z.object({
  id: z.string().describe('Stable alarm id <scope>:<asset key>:<condition>, the asset key being the asset id without its own scope prefix (hvdc:nordlink:tripped); the same condition on the same asset always has this id.'),
  scope: z.enum(['island', 'branch', 'generator', 'hvdc']),
  assetId: z.string().describe('Island id or Grid Asset id.'),
  assetLabel: z.string().describe('The asset\'s label; for an island, Island at <its anchor bus\'s label>, the bus world.electric-grid.islands.list names it after.'),
  mapAssetId: z.string().nullable().describe('Grid Asset that locates the alarm on the map (world.electric-grid.asset.get): the asset itself, or an island\'s anchor bus; null for an island that no longer exists.'),
  condition: z.string(),
  priority,
  title: z.string(),
  message: z.string(),
  islandId: z.string().nullable(),
  value: finite.nullable().describe('Measured value at the latest evaluation (unit below).'),
  limit: finite.nullable().describe('Raise limit (unit below).'),
  unit: z.enum(['Hz', '%', 'MW']).nullable(),
  phase: z.enum(['active-unacknowledged', 'active-acknowledged', 'cleared-unacknowledged', 'cleared-acknowledged']),
  active: z.boolean(),
  acknowledged: z.boolean(),
  shelved: z.boolean(),
  raisedAt: z.string(),
  clearedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  shelvedUntil: z.string().nullable(),
  occurrences: z.number().int().positive(),
}).strict()

const alarmsResultSchema = z.object({
  gridId: z.string(),
  counts: z.object({
    active: count.describe('Active, unshelved alarms.'),
    unacknowledged: count.describe('Unshelved alarms not acknowledged, active or cleared.'),
    shelved: count,
    activeByPriority: z.object({ 1: count, 2: count, 3: count }).strict(),
  }).strict(),
  total: count.describe('Alarms matching the filters.'),
  offset: count,
  limit: z.number().int().positive(),
  alarms: z.array(alarmSchema),
}).strict()

const matchesState = (record: GridAlarmRecord, states: ReadonlySet<z.infer<typeof alarmStateFilter>>): boolean => {
  if (gridAlarmShelved(record)) return states.has('shelved')
  return (states.has('active') && record.active) || (states.has('unacknowledged') && !record.acknowledged) || (states.has('cleared') && !record.active)
}

/** What an alarm names and where the map shows it: an island by its current anchor bus, as islands.list names it. */
const alarmAsset = (grid: GridRuntimeInstance, record: GridAlarmRecord): { readonly assetLabel: string; readonly mapAssetId: string | null } => {
  const { index } = grid.definition
  if (record.scope === 'island') {
    const islands = solvedGridIslands(grid)
    const island = islands.islands.find(candidate => candidate.id === record.assetId)
    if (island === undefined) return { assetLabel: `Island ${record.assetId} (no longer present)`, mapAssetId: null }
    const busId = islands.plan.islands[island.planIndex]!.anchorBusId
    return { assetLabel: `Island at ${index.busById.get(busId)!.label}`, mapAssetId: busId }
  }
  const label = record.scope === 'hvdc'
    ? index.hvdcLinks.find(link => link.id === record.assetId)?.label
    : index.assetById.get(record.assetId)?.label
  if (label === undefined) throw new Error(`Grid alarm ${record.id} names unknown ${record.scope} ${record.assetId}`)
  return { assetLabel: label, mapAssetId: record.assetId }
}

const alarmView = (grid: GridRuntimeInstance, record: GridAlarmRecord): z.infer<typeof alarmSchema> => ({
  id: record.id,
  scope: record.scope,
  assetId: record.assetId,
  ...alarmAsset(grid, record),
  condition: record.condition,
  priority: record.priority,
  title: record.title,
  message: record.message,
  islandId: record.islandId,
  value: record.value,
  limit: record.limit,
  unit: record.unit,
  phase: gridAlarmPhase(record),
  active: record.active,
  acknowledged: record.acknowledged,
  shelved: gridAlarmShelved(record),
  raisedAt: record.raisedAt,
  clearedAt: record.clearedAt,
  acknowledgedAt: record.acknowledgedAt,
  shelvedUntil: record.shelvedUntil,
  occurrences: record.occurrences,
})

// Most urgent first: priority, active before cleared, unacknowledged first, newest raise, then id.
const byUrgency = (left: GridAlarmRecord, right: GridAlarmRecord): number =>
  left.priority - right.priority
  || Number(right.active) - Number(left.active)
  || Number(left.acknowledged) - Number(right.acknowledged)
  || right.raisedAtElapsedMs - left.raisedAtElapsedMs
  || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

export const gridAlarmsQuery = defineGridQuery({
  id: 'world.electric-grid.alarms.list',
  title: 'List Grid alarms',
  description: 'Lists persistent Grid alarm records, most urgent first: island frequency bands, de-energised and formed islands, reserve deficits per product, unserved load, LFDD stages, AC non-convergence, branch loading bands, branch, generator and HVDC link trips. An alarm stays active until its condition clears; acknowledgement never clears it. Filter by priority, state and island; acknowledge or shelve with world.electric-grid.alarm.lifecycle.',
  searchTerms: ['alarm', 'alarms', 'alarm list', 'annunciator', 'event list', 'trip', 'overload', 'frequency', 'unacknowledged', 'shelved', 'alarm flood', 'alarm', 'alarmliste', 'hendelser', 'utløst', 'overlast', 'frekvens', 'kvittering'],
  input: alarmsPayloadSchema,
  output: alarmsResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const islandId = payload.islandId === undefined ? undefined : requireGridIsland(grid, payload.islandId)
    const priorities = payload.priorities === undefined ? undefined : new Set<number>(payload.priorities)
    const states = payload.states === undefined ? undefined : new Set(payload.states)
    const records = [...grid.alarms.records.values()]
    const matched = records
      .filter(record => (priorities === undefined || priorities.has(record.priority))
        && (states === undefined || matchesState(record, states))
        && (islandId === undefined || record.islandId === islandId))
      .sort(byUrgency)
    const counts = gridAlarmCounts(grid)
    const activeByPriority = { 1: 0, 2: 0, 3: 0 }
    for (const record of records) if (record.active && !gridAlarmShelved(record)) activeByPriority[record.priority] += 1
    return {
      gridId: payload.gridId,
      counts: { active: counts.active, unacknowledged: counts.unacknowledged, shelved: counts.shelved, activeByPriority },
      total: matched.length,
      offset: payload.offset,
      limit: payload.limit,
      alarms: matched.slice(payload.offset, payload.offset + payload.limit).map(record => alarmView(grid, record)),
    }
  },
})

export type GridAlarmsListResult = z.infer<typeof alarmsResultSchema>
export type GridAlarmView = z.infer<typeof alarmSchema>
