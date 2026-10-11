import { z } from 'zod'
import { hvdcInjectionAtBusesMw } from '../runtime/hvdc.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance } from '../runtime/instance.ts'
import { islandFixedInjectionMw, islandMembers } from '../runtime/island-input.ts'
import { gridIslandFrequencyHz, solvedGridIslands } from '../runtime/island-lifecycle.ts'
import { defineGridQuery, gridFor } from './common.ts'

const finite = z.number().finite()
const count = z.number().int().nonnegative()

const islandsPayloadSchema = z.object({
  gridId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(50),
}).strict()

export const gridIslandSchema = z.object({
  id: z.string().describe('Stable island id; it survives splits and merges of the island.'),
  referenceBus: z.object({ id: z.string(), label: z.string() }).strict(),
  busCount: count,
  branchCount: count,
  generatorCount: count,
  onlineGeneratorCount: count,
  loadCount: count,
  energized: z.boolean().describe('True while a synchronised synchronous generator or a synchronous external system forms the island voltage; storage, converters and Plant connections cannot energise an island.'),
  frequencyHz: finite.nullable().describe('Island frequency; null when the island is not energised.'),
  generationMw: finite.describe('Generator output in the island (MW).'),
  storageMw: finite.describe('Net storage output, positive when discharging (MW).'),
  externalExchangeMw: finite.describe('Net power into the island from external systems, HVDC links and Plant connections, positive into the island (MW); 0 while de-energised.'),
  hvdcImportMw: finite.describe('Net power the island\'s HVDC converters deliver into it (MW; part of externalExchangeMw), negative while they export; 0 while de-energised.'),
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

const islandView = (grid: GridRuntimeInstance, islands: GridIslandPlan, island: GridIsland): GridIslandView => {
  const structure = islands.plan.islands[island.planIndex]!
  const referenceBusId = structure.referenceBusId
  const generators = structure.generators.map(generator => grid.generators.get(generator.id)!)
  const loads = structure.loads.map(load => grid.loads.get(load.id)!)
  const loadMw = loads.reduce((sum, load) => sum + load.demandMw, 0)
  const servedLoadMw = loads.reduce((sum, load) => sum + load.servedMw, 0)
  const externalExchangeMw = island.energized
    ? islandMembers(grid, structure).externals.reduce((sum, system) => sum + grid.externalSystems.get(system.id)!.importMw, 0)
      + islandFixedInjectionMw(grid, structure)
    : 0
  return {
    id: island.id,
    referenceBus: { id: referenceBusId, label: grid.definition.index.busById.get(referenceBusId)!.label },
    busCount: structure.buses.length,
    branchCount: structure.branches.length,
    generatorCount: generators.length,
    onlineGeneratorCount: generators.filter(generator => generator.state === 'online').length,
    loadCount: loads.length,
    energized: island.energized,
    frequencyHz: gridIslandFrequencyHz(island),
    generationMw: generators.reduce((sum, generator) => sum + generator.dispatchMw, 0),
    storageMw: structure.storage.reduce((sum, item) => sum + grid.storage.get(item.id)!.dispatchMw, 0),
    externalExchangeMw,
    hvdcImportMw: island.energized ? hvdcInjectionAtBusesMw(grid, structure.busSet) : 0,
    loadMw,
    servedLoadMw,
    unservedLoadMw: loads.reduce((sum, load) => sum + load.unservedMw, 0),
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
    const plan = solvedGridIslands(grid)
    const islands = plan.islands
      .map(island => islandView(grid, plan, island))
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
