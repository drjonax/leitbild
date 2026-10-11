import { sharedScreeningRecords, type ContingencySnapshot, type ScreeningRecords } from './contingency-snapshot.ts'
import { screenContingencyRange } from './contingency.ts'
import type { ContingencyChunk, ContingencyPool } from './contingency-pool.ts'
import type { ContingencyRecordScreen } from './contingency-screen.ts'

// Where a screening runs. Size rule: a screening whose estimated kernel work is below
// `inlineScreeningWorkUnits` runs inline on the calling thread, as does every screening when the
// pool has no workers (a single-core host or LEITBILD_GRID_N1_MAX_WORKERS=0); any other runs in
// chunks on the worker pool. Both write the same records with the same kernel.

/**
 * Estimated kernel work of a screening, in entry visits: per contingency, the forward and back
 * substitution over its island's factor, one pass over the island's branches, and the loading scan
 * over every branch.
 */
export const screeningWorkUnits = (snapshot: ContingencySnapshot): number => {
  const { islands, factors, contingencies, network } = snapshot
  let units = 0
  for (let position = 0; position < contingencies.count; position += 1) {
    const branch = contingencies.branch[position]!
    const island = islands.islandOfBus[branch >= 0 ? network.branchFrom[branch]! : contingencies.bus[position]!]!
    units += 2 * (factors.entryStart[island + 1]! - factors.entryStart[island]!) + islands.branchStart[island + 1]! - islands.branchStart[island]! + network.branchCount
  }
  return units
}

/**
 * Below this many entry visits a screening runs inline: 2–8 ms of kernel work on one core
 * (measured 2–7.7 ns per entry visit on the v2 Norway model and a 10k-bus synthetic grid,
 * 2026-10-11). Above it the pool's dispatch, about 0.5 ms per screening, is small beside the work
 * it spreads; below it the pool would save at most a few ms for 1.5–4× the CPU time.
 */
export const inlineScreeningWorkUnits = 1_000_000

/** Chunks per worker: several, so faster cores take more of the work. */
const chunksPerWorker = 4

/** Contiguous, near-equal ranges of the snapshot's positions: at most `chunksPerWorker` per worker. */
export const screeningChunks = (count: number, workers: number): ReadonlyArray<ContingencyChunk> => {
  const chunkCount = Math.min(count, workers * chunksPerWorker)
  return Array.from({ length: chunkCount }, (_, index) => ({
    start: Math.floor(index * count / chunkCount),
    end: Math.floor((index + 1) * count / chunkCount),
  }))
}

export const screenRecordsInline = (snapshot: ContingencySnapshot): ScreeningRecords => {
  const records = sharedScreeningRecords(snapshot.contingencies.count)
  screenContingencyRange(snapshot, records, 0, records.count)
  return records
}

export const screenRecordsOnPool = async (snapshot: ContingencySnapshot, pool: ContingencyPool): Promise<ScreeningRecords> => {
  const records = sharedScreeningRecords(snapshot.contingencies.count)
  await pool.screen(snapshot, records, screeningChunks(records.count, pool.size))
  return records
}

export type ContingencyExecution = 'inline' | 'pool'

/** The size rule. */
export const contingencyExecution = (snapshot: ContingencySnapshot, poolSize: number): ContingencyExecution =>
  poolSize === 0 || screeningWorkUnits(snapshot) < inlineScreeningWorkUnits ? 'inline' : 'pool'

/** Screens by the size rule on the pool `pool()` returns; asking for the pool starts no worker. */
export const sizedContingencyScreen = (pool: () => ContingencyPool): ContingencyRecordScreen => async snapshot => {
  const workers = pool()
  return contingencyExecution(snapshot, workers.size) === 'inline' ? screenRecordsInline(snapshot) : await screenRecordsOnPool(snapshot, workers)
}
