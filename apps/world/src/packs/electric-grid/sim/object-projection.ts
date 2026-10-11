import type { IsoTimestamp, ObjectId, OperationalObject, Provenance } from '../../../core/model/index.ts'
import type { PackRuntimeEvent, PackRuntimeEventHistory } from '../../../simulation/protocol.ts'
import { electricGridPackDataSchema, gridIdForObject } from '../model.ts'
import { gridAlarmCounts } from '../runtime/alarms.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { gridElectricalPortsAt } from '../electrical-ports.ts'

const projectionKey = (grid: GridRuntimeInstance): string => {
  const value = grid.projection
  return JSON.stringify({
    statusTone: value.statusTone,
    statusLabel: value.statusLabel,
    frequencyHz: value.frequencyHz === null ? null : Math.round(value.frequencyHz * 100) / 100,
    islands: value.islands.map(island => [island.id, island.energized, island.frequencyHz === null ? null : Math.round(island.frequencyHz * 100) / 100, island.alarmCount]),
    totalGenerationMw: Math.round(value.totalGenerationMw),
    totalLoadMw: Math.round(value.totalLoadMw),
    servedLoadMw: Math.round(value.servedLoadMw),
    unservedLoadMw: Math.round(value.unservedLoadMw),
    reserveMarginMw: Math.round(value.reserveMarginMw),
    highestBranchLoadingPercent: Math.round(value.highestBranchLoadingPercent),
    activeIslandCount: value.activeIslandCount,
    activeAlarmCount: value.activeAlarmCount,
    alarms: gridAlarmCounts(grid).activeUnacknowledged,
    externalConnections: [...grid.externalConnections].map(([id, connection]) => ({
      id,
      connected: connection.connected,
      activePowerMw: Math.round(connection.systemActivePowerMw),
    })),
  })
}

export const projectGridObject = (config: {
  readonly object: OperationalObject
  readonly grid: GridRuntimeInstance
  readonly at: IsoTimestamp
}): OperationalObject => {
  const data = electricGridPackDataSchema.parse(config.object.packData)
  const alarms = gridAlarmCounts(config.grid)
  const priority = alarms.active > 0 ? 'high' as const : 'normal' as const
  const status = alarms.active > 0 ? 'constrained' : 'normal'
  return {
    ...config.object,
    revision: config.object.revision + 1,
    operational: { ...config.object.operational, status, priority },
    // One health alert summarises the alarm records: its severity follows the most urgent active
    // alarm, it is acknowledged once every active alarm is, and it dates from the oldest active alarm.
    alerts: alarms.active === 0 ? [] : [{
      id: `${config.object.id}:grid-health`,
      kind: 'electric_grid_health',
      severity: alarms.highestPriority === 1 ? 'critical' : alarms.highestPriority === 2 ? 'warning' : 'info',
      message: config.grid.projection.statusLabel,
      raisedAt: alarms.oldestActiveRaisedAt!,
      acknowledged: alarms.activeUnacknowledged === 0,
    }],
    timestamps: { ...config.object.timestamps, updatedAt: config.at },
    packData: { ...data, electricalPorts: [...gridElectricalPortsAt({ grid: config.grid, at: config.at })], projection: config.grid.projection },
  }
}

export const projectedInitialGridObjects = (config: {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly grids: ReadonlyMap<string, GridRuntimeInstance>
  readonly at: IsoTimestamp
}): ReadonlyArray<OperationalObject> => config.objects.map(object => {
  const gridId = gridIdForObject(object)
  const grid = gridId === null ? undefined : config.grids.get(gridId)
  return grid ? projectGridObject({ object, grid, at: config.at }) : object
})

export const gridProjectionEvents = (config: {
  readonly objectsById: Map<ObjectId, OperationalObject>
  readonly grids: ReadonlyMap<string, GridRuntimeInstance>
  readonly previousKeys: Map<string, string>
  readonly at: IsoTimestamp
  readonly provenance: Provenance
  readonly history: PackRuntimeEventHistory
}): ReadonlyArray<PackRuntimeEvent> => {
  const events: PackRuntimeEvent[] = []
  for (const [gridId, grid] of config.grids) {
    const object = config.objectsById.get(gridId as ObjectId)
    if (!object) continue
    const nextKey = projectionKey(grid)
    if (config.history === 'snapshot-only' && config.previousKeys.get(gridId) === nextKey) continue
    config.previousKeys.set(gridId, nextKey)
    const next = projectGridObject({ object, grid, at: config.at })
    config.objectsById.set(next.id, next)
    events.push({ type: 'object.upserted', object: next, at: config.at, provenance: config.provenance, history: config.history })
  }
  return events
}
