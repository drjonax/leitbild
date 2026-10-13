import { readdir } from 'node:fs/promises'
import { simulationRunIdSchema, type SimulationRunId } from '../model/index.ts'

/**
 * The Simulation Runs stored under a Workspace's Run root: one directory each,
 * named by its Run id. Lists the directory only; it reads no Run file, so a Run
 * it names may still prove unreadable when loaded. A missing root holds none.
 */
export const listStoredSimulationRunIds = async (simulationRunRoot: string): Promise<ReadonlyArray<SimulationRunId>> => {
  let entries: ReadonlyArray<{ readonly isDirectory: () => boolean; readonly name: string }>
  try {
    entries = await readdir(simulationRunRoot, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => simulationRunIdSchema.safeParse(entry.name))
    .filter((result): result is { readonly success: true; readonly data: SimulationRunId } => result.success)
    .map(result => result.data)
    .sort()
}
