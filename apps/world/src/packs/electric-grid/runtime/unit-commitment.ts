import type { GridGenerationKind, GridGeneratorDefinition } from '../grid-model.ts'
import type { GridGeneratorState, GridRuntimeInstance } from './instance.ts'

interface GeneratorKindCommitment {
  /** Seconds from a start order to synchronisation; null where the kind is not a committable unit. */
  readonly startupSeconds: number | null
  /** Minimum stable generation while online, as a fraction of installed capacity. */
  readonly minimumStableFraction: number
  /** Synchronous machines hold island voltage and frequency; converter-connected plants follow them. */
  readonly synchronous: boolean
}

// Model v1 carries no per-unit start-up or minimum-load data, so these apply per generation kind.
// Start-up sources quote time to full output; the values below subtract the loading time at the
// Model's default ramp rates (models/electrical-parameters.ts) to give time to synchronisation.
const commitmentByKind = {
  hydro: {
    // EIA, "About 25% of U.S. power plants can start up within an hour" (2020-11-19): most hydro units reach
    // full output from cold in < 10 min; 300 s to synchronise plus ≈4.5 min loading at 22 %/min stays inside it.
    startupSeconds: 300,
    // Technical minimum flow ≈10 % for Pelton (Penche 2004, ESHA small-hydro guide) and ≈40 % for Francis (IAHR);
    // NVE plants aggregate several units, so one unit at its minimum is ≈10 % of plant capacity (inferred).
    minimumStableFraction: 0.1,
    synchronous: true,
  },
  thermal: {
    // VGB PowerTech after VDE (2012): usual CCGT hot start 1.5 h to full load; less ≈12.5 min loading at 8 %/min.
    startupSeconds: 4_500,
    // Same source: CCGT minimum load 50 % usual, 40 % state of the art (Norwegian CCGT/CHP units are post-2007).
    minimumStableFraction: 0.4,
    synchronous: true,
  },
  nuclear: {
    // EIA (2020, as hydro): almost all nuclear plants need more than 12 h from cold to full operation (lower bound).
    startupSeconds: 43_200,
    // European Utility Requirements load-following range 50–100 % of rated power (NEA, "Technical and Economic
    // Aspects of Load Following with Nuclear Power Plants", 2011).
    minimumStableFraction: 0.5,
    synchronous: true,
  },
  // EIA (2020): start-up time is not relevant for wind and solar; converter output is curtailable to zero.
  wind: { startupSeconds: 0, minimumStableFraction: 0, synchronous: false },
  solar: { startupSeconds: 0, minimumStableFraction: 0, synchronous: false },
  // Battery inverters meet Nordic FFR full activation within 0.7–1.3 s (Fingrid FFR technical requirements).
  battery: { startupSeconds: 0, minimumStableFraction: 0, synchronous: false },
  // A boundary import equivalent stands for an external synchronous system, not a committable unit.
  import: { startupSeconds: null, minimumStableFraction: 0, synchronous: true },
} as const satisfies Record<GridGenerationKind, GeneratorKindCommitment>

export const generatorMinimumStableMw = (definition: GridGeneratorDefinition): number =>
  definition.capacityMw * commitmentByKind[definition.kind].minimumStableFraction

export const generatorStartupSeconds = (definition: GridGeneratorDefinition): number | null =>
  commitmentByKind[definition.kind].startupSeconds

export const generatorIsSynchronous = (definition: GridGeneratorDefinition): boolean =>
  commitmentByKind[definition.kind].synchronous

/** Synchronised units, including a stopping unit until its breaker opens at 0 MW. */
export const generatorIsSynchronised = (state: GridGeneratorState): boolean =>
  state.state === 'online' || state.state === 'stopping'

/**
 * Advances generator lifecycles once per Grid tick, after the clock moved: a starting unit synchronises
 * when its start-up time has elapsed and loads to minimum stable generation; a stopping unit goes
 * offline once it has unloaded to 0 MW.
 */
export const advanceGridUnitCommitment = (grid: GridRuntimeInstance): void => {
  for (const definition of grid.definition.model.generators) {
    const state = grid.generators.get(definition.id)!
    if (state.state === 'starting') {
      if (state.synchronisesAtElapsedMs === null) throw new Error(`starting generator ${definition.id} has no synchronisation time`)
      if (grid.elapsedMs < state.synchronisesAtElapsedMs) continue
      state.state = 'online'
      state.synchronisesAtElapsedMs = null
      state.targetMw = generatorMinimumStableMw(definition)
    } else if (state.state === 'stopping' && state.dispatchMw <= 0) {
      state.state = 'offline'
      state.targetMw = 0
    }
  }
}
