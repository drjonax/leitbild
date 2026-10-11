import { createHash } from 'node:crypto'
import type { SignalId, SimulationRunId } from '../../../core/model/index.ts'
import { nowIso } from '../../../core/model/index.ts'
import type { PackRuntimeEvent } from '../../../simulation/protocol.ts'
import { drainGridSignals } from '../runtime/grid-signals.ts'
import type { GridRuntimeInstance } from '../runtime/instance.ts'
import { electricGridAdapterId, electricGridRuntimeId } from './constants.ts'

/** Signal ids are bounded identifiers; Grid asset ids are not, so the id is a digest of the Grid and the signal key. */
const signalIdFor = (gridId: string, key: string): SignalId =>
  `electric-grid:${createHash('sha256').update(`${gridId}\u0000${key}`).digest('hex').slice(0, 40)}` as SignalId

/** Drains the Grids' queued alarm transitions and protection trips as journalled interaction signals. */
export const gridSignalEvents = (grids: Iterable<GridRuntimeInstance>, simulationRunId: SimulationRunId): ReadonlyArray<PackRuntimeEvent> => {
  const events: PackRuntimeEvent[] = []
  for (const grid of grids) {
    for (const signal of drainGridSignals(grid)) {
      const at = nowIso()
      events.push({
        type: 'interaction.signal',
        at,
        provenance: { source: 'simulator', adapterId: electricGridAdapterId },
        signal: {
          id: signalIdFor(grid.definition.gridId, signal.key),
          simulationRunId,
          at,
          source: { kind: 'simulation', id: electricGridRuntimeId },
          targets: [{ kind: 'broadcast' }],
          type: signal.type,
          severity: signal.severity,
          payload: signal.payload,
        },
      })
    }
  }
  return events
}
