import type { GridGenerationKind, GridGeneratorDefinition } from '../grid-model.ts'
import type { GridGeneratorState, GridRuntimeInstance } from './instance.ts'

// Grid Model v2 carries each unit's minimum stable output but no start-up time, so start-up
// applies per generation kind. Start-up sources quote time to full output; the values below
// subtract the loading time at typical ramp rates to give time to synchronisation.
const startupSecondsByKind = {
  // EIA, "About 25% of U.S. power plants can start up within an hour" (2020-11-19): most hydro units reach
  // full output from cold in < 10 min; 300 s to synchronise plus ≈4.5 min loading at 22 %/min stays inside it.
  hydro: 300,
  // VGB PowerTech after VDE (2012): usual CCGT hot start 1.5 h to full load; less ≈12.5 min loading at 8 %/min.
  thermal: 4_500,
  // EIA (2020, as hydro): almost all nuclear plants need more than 12 h from cold to full operation (lower bound).
  nuclear: 43_200,
  // EIA (2020): start-up time is not relevant for wind and solar; converter output is curtailable to zero.
  wind: 0,
  solar: 0,
} as const satisfies Record<GridGenerationKind, number>

/** Minimum stable generation while online, from the Model. */
export const generatorMinimumStableMw = (definition: GridGeneratorDefinition): number => definition.minimumStableMw

/** Seconds from a start order to synchronisation. */
export const generatorStartupSeconds = (definition: GridGeneratorDefinition): number => startupSecondsByKind[definition.kind]

/** Synchronised units, including a stopping unit until its breaker opens at 0 MW. */
export const generatorIsSynchronised = (state: GridGeneratorState): boolean =>
  state.state === 'online' || state.state === 'stopping'

/**
 * Advances generator lifecycles at the Grid's current elapsed time: a starting unit synchronises
 * when its start-up time has elapsed and loads to minimum stable generation, unless `maySynchronise`
 * refuses it (restoration.ts: a dead bus without black start), which aborts its start; a stopping unit's
 * breaker opens once its set-point has ramped down to 0 MW. Returns whether any unit changed state.
 */
export const advanceGridUnitCommitment = (grid: GridRuntimeInstance, maySynchronise: (definition: GridGeneratorDefinition) => boolean): boolean => {
  let changed = false
  for (const definition of grid.definition.model.generators) {
    const state = grid.generators.get(definition.id)!
    if (state.state === 'starting') {
      if (state.synchronisesAtElapsedMs === null) throw new Error(`starting generator ${definition.id} has no synchronisation time`)
      if (grid.elapsedMs < state.synchronisesAtElapsedMs) continue
      if (!maySynchronise(definition)) {
        state.state = 'offline'
        state.synchronisesAtElapsedMs = null
        state.targetMw = 0
        changed = true
        continue
      }
      state.state = 'online'
      state.synchronisesAtElapsedMs = null
      state.targetMw = generatorMinimumStableMw(definition)
      changed = true
    } else if (state.state === 'stopping' && state.scheduledMw <= 0) {
      state.state = 'offline'
      state.targetMw = 0
      changed = true
    }
  }
  return changed
}

/** Earliest elapsed time at which a starting unit synchronises; null when none is starting. */
export const nextSynchronisationElapsedMs = (grid: GridRuntimeInstance): number | null => {
  let earliest: number | null = null
  for (const state of grid.generators.values()) {
    if (state.state !== 'starting' || state.synchronisesAtElapsedMs === null) continue
    if (earliest === null || state.synchronisesAtElapsedMs < earliest) earliest = state.synchronisesAtElapsedMs
  }
  return earliest
}
