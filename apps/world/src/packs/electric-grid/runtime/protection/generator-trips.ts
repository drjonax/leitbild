import type { IsoTimestamp } from '../../../../core/model/index.ts'
import { queueGridSignal } from '../grid-signals.ts'
import type { GridFrequencyEvent, GridRuntimeInstance } from '../instance.ts'

/** The latest frequency-protection trip of a unit among the retained frequency events; undefined when it was tripped by command. */
export const latestGeneratorProtectionTrip = (grid: GridRuntimeInstance, generatorId: string): GridFrequencyEvent | undefined => {
  for (let index = grid.frequencyEvents.length - 1; index >= 0; index -= 1) {
    const event = grid.frequencyEvents[index]!
    if (event.trip?.unitId === generatorId) return event
  }
  return undefined
}

/**
 * Queues one protection event for every generator that has tripped since the previous solve at
 * `sinceElapsedMs`: by its frequency protection (element and sub-step time from the frequency
 * events) or by command. A unit whose trip was reset is forgotten, so its next trip is recorded again.
 */
export const recordGeneratorTrips = (grid: GridRuntimeInstance, at: IsoTimestamp, elapsedMs: number, sinceElapsedMs: number): void => {
  const recorded = grid.protection.recordedGeneratorTrips
  for (const definition of grid.definition.model.generators) {
    if (grid.generators.get(definition.id)!.state !== 'tripped') {
      recorded.delete(definition.id)
      continue
    }
    if (recorded.has(definition.id)) continue
    const event = latestGeneratorProtectionTrip(grid, definition.id)
    // This trip's protection operation lies after the previous solve; an older one belongs to an earlier, reset trip.
    const trip = event !== undefined && event.atElapsedSeconds * 1_000 >= sinceElapsedMs - 1e-6 ? event : undefined
    recorded.set(definition.id, trip?.trip === undefined ? { element: 'command', elementId: null } : { element: trip.trip.cause, elementId: trip.trip.elementId })
    queueGridSignal(grid, {
      type: 'electric-grid.protection.tripped',
      severity: 'warning',
      key: `trip|${definition.id}|${elapsedMs}`,
      payload: {
        gridId: grid.definition.gridId,
        assetId: definition.id,
        assetKind: 'generator',
        label: definition.label,
        element: trip?.trip === undefined ? 'command' : trip.trip.cause,
        ...(trip?.trip === undefined ? {} : { elementId: trip.trip.elementId, trippedAtElapsedSeconds: trip.atElapsedSeconds }),
        islandId: grid.busStates.get(definition.busId)!.islandId,
        simulationTime: at,
        elapsedSeconds: elapsedMs / 1_000,
      },
    })
  }
}
