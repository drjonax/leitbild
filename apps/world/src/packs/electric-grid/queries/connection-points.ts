import { z } from 'zod'
import { defineGridQuery, genericObjectSchema, gridFor, gridPayloadSchema } from './common.ts'

const connectionPointResultSchema = z.object({ gridId: z.string(), connectionPoints: z.array(genericObjectSchema) }).strict()

export const gridConnectionPointsQuery = defineGridQuery({
  id: 'world.electric-grid.connection-points.list',
  title: 'List connection points',
  description: 'Lists typed electrical connection points and their current exchange state.',
  input: gridPayloadSchema,
  output: connectionPointResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    return {
      gridId: payload.gridId,
      connectionPoints: grid.definition.model.connectionPoints.map(point => {
        const busState = grid.busStates.get(point.busId)
        const connection = grid.externalConnections.get(point.id)
        return {
          ...point,
          system: connection === undefined ? null : {
            objectId: connection.definition.system.objectId,
            portId: connection.definition.system.portId,
          },
          systemActivePowerMw: connection?.systemActivePowerMw ?? 0,
          connected: connection?.connected ?? false,
          energized: (busState?.voltagePu ?? 0) >= 0.8,
          voltagePu: busState?.voltagePu ?? 0,
          frequencyHz: busState?.frequencyHz ?? grid.definition.model.nominalFrequencyHz,
        }
      }),
    }
  },
})
