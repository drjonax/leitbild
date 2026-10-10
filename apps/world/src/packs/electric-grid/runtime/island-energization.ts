import type { GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { generatorIsSynchronised, generatorIsSynchronous } from './unit-commitment.ts'

/**
 * An island is energised when something forms its voltage and frequency: a synchronised synchronous
 * generator, or a connected system (such as a Plant) supplying power into it. Converter-connected
 * plants and storage follow an existing grid voltage, so they do not energise an island on their own.
 */
export const gridIslandIsEnergized = (grid: GridRuntimeInstance, island: GridTopologyIsland): boolean =>
  island.generators.some(generator => generatorIsSynchronous(generator) && generatorIsSynchronised(grid.generators.get(generator.id)!))
  || [...grid.externalConnections.values()].some(connection =>
    connection.connected && connection.systemActivePowerMw > 0 && island.busSet.has(connection.busId))
