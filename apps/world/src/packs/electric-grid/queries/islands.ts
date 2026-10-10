import { z } from 'zod'
import { gridIslandIsEnergized } from '../runtime/island-energization.ts'
import type { GridRuntimeInstance, GridTopologyIsland } from '../runtime/instance.ts'
import { defineGridQuery, gridFor, solvedTopologyFor } from './common.ts'

const finite = z.number().finite()
const count = z.number().int().nonnegative()

const islandsPayloadSchema = z.object({
  gridId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(50),
}).strict()

export const gridIslandSchema = z.object({
  id: z.string(),
  referenceBus: z.object({ id: z.string(), label: z.string() }).strict(),
  busCount: count,
  branchCount: count,
  generatorCount: count,
  onlineGeneratorCount: count,
  loadCount: count,
  energized: z.boolean().describe('True when a synchronised synchronous unit or a supplying connected system forms the island voltage.'),
  frequencyHz: finite.nullable().describe('Island frequency; null when the island is not energised.'),
  generationMw: finite.describe('Generator output in the island (MW).'),
  storageMw: finite.describe('Net storage output, positive when discharging (MW).'),
  externalExchangeMw: finite.describe('Net power from connected systems into the island, positive into the Grid (MW).'),
  loadMw: finite.describe('Demand of the island loads (MW).'),
  servedLoadMw: finite,
  unservedLoadMw: finite,
  reserveMw: finite.describe('Upward reserve of online units, limited by their headroom (MW).'),
}).strict()
export type GridIslandView = z.infer<typeof gridIslandSchema>

const islandsResultSchema = z.object({
  gridId: z.string(),
  total: count,
  offset: count,
  limit: z.number().int().positive(),
  islands: z.array(gridIslandSchema),
}).strict()

const islandView = (grid: GridRuntimeInstance, island: GridTopologyIsland): GridIslandView => {
  const referenceBusId = island.buses[0]!
  const generators = island.generators.map(generator => grid.generators.get(generator.id)!)
  const loads = island.loads.map(load => grid.loads.get(load.id)!)
  const energized = gridIslandIsEnergized(grid, island)
  const loadMw = loads.reduce((sum, load) => sum + load.demandMw, 0)
  const servedLoadMw = loads.reduce((sum, load) => sum + load.servedMw, 0)
  return {
    id: island.id,
    referenceBus: { id: referenceBusId, label: grid.definition.index.busById.get(referenceBusId)!.label },
    busCount: island.buses.length,
    branchCount: island.branches.length,
    generatorCount: generators.length,
    onlineGeneratorCount: generators.filter(generator => generator.state === 'online').length,
    loadCount: loads.length,
    energized,
    frequencyHz: energized ? grid.frequencyByIsland.get(island.id)! : null,
    generationMw: generators.reduce((sum, generator) => sum + generator.dispatchMw, 0),
    storageMw: island.storage.reduce((sum, item) => sum + grid.storage.get(item.id)!.dispatchMw, 0),
    externalExchangeMw: [...grid.externalConnections.values()]
      .filter(connection => connection.connected && island.busSet.has(connection.busId))
      .reduce((sum, connection) => sum + connection.systemActivePowerMw, 0),
    loadMw,
    servedLoadMw,
    unservedLoadMw: loadMw - servedLoadMw,
    reserveMw: generators.reduce((sum, generator) => sum + (generator.state === 'online'
      ? Math.min(generator.reserveMw, Math.max(0, generator.availableMw - generator.dispatchMw))
      : 0), 0),
  }
}

export const gridIslandsQuery = defineGridQuery({
  id: 'world.electric-grid.islands.list',
  title: 'List Grid islands',
  description: 'Lists the electrically separate islands of one Grid, largest demand first: buses, units, energisation, island frequency, generation, demand, served and unserved load, and reserve. Use an island id to filter assets.search and power-flow.snapshot.',
  searchTerms: ['island', 'islanding', 'separation', 'system split', 'blackout', 'energised', 'dead island', 'frequency', 'øydrift', 'nettdeling', 'separasjon', 'mørklegging', 'spenningsløs', 'frekvens'],
  input: islandsPayloadSchema,
  output: islandsResultSchema,
  answer: (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const islands = solvedTopologyFor(grid).islands
      .map(island => islandView(grid, island))
      .sort((left, right) => right.loadMw - left.loadMw || right.busCount - left.busCount || left.id.localeCompare(right.id))
    return {
      gridId: payload.gridId,
      total: islands.length,
      offset: payload.offset,
      limit: payload.limit,
      islands: islands.slice(payload.offset, payload.offset + payload.limit),
    }
  },
})
