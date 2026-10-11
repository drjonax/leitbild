import { z } from 'zod'
import { defineGridQuery, gridFor, gridPayloadSchema } from './common.ts'

const finite = z.number().finite()

const connectionPointResultSchema = z.object({
  gridId: z.string(),
  connectionPoints: z.array(z.object({
    id: z.string(),
    label: z.string(),
    busId: z.string(),
    nominalKv: finite,
    maximumExportMw: finite.describe('Largest power leaving the Grid through this point (MW).'),
    maximumImportMw: finite.describe('Largest power entering the Grid through this point (MW).'),
    system: z.object({ objectId: z.string(), portId: z.string() }).strict().nullable().describe('The connected system port; null when nothing is connected.'),
    systemActivePowerMw: finite.describe('Power from the connected system into the Grid, positive into the Grid (MW).'),
    connected: z.boolean(),
    energized: z.boolean(),
    voltagePu: finite.nullable().describe('AC load-flow voltage of the bus (pu); null while its island has not converged; 0 when de-energised.'),
    voltageModel: z.enum(['ac-fdlf', 'not-converged', 'de-energised']),
    frequencyHz: finite.nullable().describe('Island frequency; null when the bus is de-energised (Hz).'),
  }).strict()),
}).strict()

export const gridConnectionPointsQuery = defineGridQuery({
  id: 'world.electric-grid.connection-points.list',
  title: 'List connection points',
  description: 'Lists the typed electrical connection points where other systems such as Plants connect, with their limits, connected port and current exchange (positive into the Grid), bus voltage and frequency.',
  searchTerms: ['connection point', 'plant connection', 'offsite power', 'grid connection', 'exchange', 'tilknytning', 'tilknytningspunkt', 'nettilknytning', 'utveksling'],
  input: gridPayloadSchema,
  output: connectionPointResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    return {
      gridId: payload.gridId,
      connectionPoints: grid.definition.model.connectionPoints.map(point => {
        const busState = grid.busStates.get(point.busId)!
        const connection = grid.externalConnections.get(point.id)
        return {
          ...point,
          system: connection === undefined ? null : {
            objectId: connection.definition.system.objectId,
            portId: connection.definition.system.portId,
          },
          // A point with nothing connected exchanges no power.
          systemActivePowerMw: connection === undefined ? 0 : connection.systemActivePowerMw,
          connected: connection !== undefined && connection.connected,
          energized: busState.energized,
          voltagePu: busState.voltagePu,
          voltageModel: busState.voltageModel,
          frequencyHz: busState.frequencyHz,
        }
      }),
    }
  },
})
