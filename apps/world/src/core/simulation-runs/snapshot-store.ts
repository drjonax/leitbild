import { writeAtomic } from '../storage/atomic-write.ts'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { simulationRunIdSchema, nowIso, type SimulationRunId, type IsoTimestamp } from '../model/index.ts'
import { simulationRunStateSnapshotSchema, type SimulationRunStateSnapshot } from './state-store.ts'

const persistedSimulationRunSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  simulationRunId: simulationRunIdSchema,
  savedAt: z.string().datetime(),
  snapshot: simulationRunStateSnapshotSchema,
})

export interface PersistedSimulationRunSnapshot {
  readonly schemaVersion: 1
  readonly simulationRunId: SimulationRunId
  readonly savedAt: IsoTimestamp
  readonly snapshot: SimulationRunStateSnapshot
}

export interface SimulationRunSnapshotStore {
  readonly load: () => Promise<SimulationRunStateSnapshot | null>
  readonly save: (snapshot: SimulationRunStateSnapshot) => Promise<void>
  /** Permanent quarantine after an uncertain commit; ordinary saves never clear it. */
  readonly quarantine: (reason: string) => Promise<void>
}

export const assertSimulationRunRecoveryNotRequired = async (path: string): Promise<void> => {
  // An unreadable marker also refuses restore. Ordinary loading and reset must
  // not turn an uncertain boundary into an apparently healthy Run.
  try {
    const reason = await readFile(`${path}.failed`, 'utf8')
    throw Object.assign(new Error(`Simulation Run requires recovery: ${reason}`), { code: 'simulation_run_recovery_required' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'simulation_run_recovery_required') throw error
    if (code !== 'ENOENT') throw Object.assign(new Error('Simulation Run requires recovery: failure marker is unreadable', { cause: error }), { code: 'simulation_run_recovery_required' })
  }
}

export const createSimulationRunSnapshotStore = (config: {
  readonly simulationRunId: SimulationRunId
  readonly path: string
}): SimulationRunSnapshotStore => {
  const load = async (): Promise<SimulationRunStateSnapshot | null> => {
    // Check before adapters can load possibly newer private mechanics.
    await assertSimulationRunRecoveryNotRequired(config.path)
    let raw: string
    try {
      raw = await readFile(config.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = persistedSimulationRunSnapshotSchema.parse(JSON.parse(raw) as unknown)
    if (parsed.simulationRunId !== config.simulationRunId) {
      throw new Error(`snapshot simulation run mismatch: expected ${config.simulationRunId}, got ${parsed.simulationRunId}`)
    }
    return parsed.snapshot as SimulationRunStateSnapshot
  }

  const save = async (snapshot: SimulationRunStateSnapshot): Promise<void> => {
    await mkdir(dirname(config.path), { recursive: true })
    const payload: PersistedSimulationRunSnapshot = {
      schemaVersion: 1,
      simulationRunId: config.simulationRunId,
      savedAt: nowIso(),
      snapshot,
    }
    await writeAtomic(config.path, `${JSON.stringify(payload)}\n`)
  }

  const quarantine = async (reason: string): Promise<void> => {
    await mkdir(dirname(config.path), { recursive: true })
    await writeAtomic(`${config.path}.failed`, reason)
  }

  return { load, save, quarantine }
}
