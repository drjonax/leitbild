import type { CompiledComponent } from '../graph/index.ts'
import { controlRodBanks, reactorNeutronics, rodTravelSteps } from '../graph/reactor-component-definitions.ts'
import { clamp, optionalParameterNumber, parameterNumber } from './component-helpers.ts'

// The rods' position indication in steps withdrawn (rodTravelSteps, all out),
// from the one average insertion the model moves (reactor-component-definitions.ts).

/** The insertion at which the core is critical at its initial power: where the rods stand at steady full power. */
export const criticalRodInsertionFraction = (core: CompiledComponent): number =>
  optionalParameterNumber(core, 'criticalRodInsertionFraction', clamp(1 - parameterNumber(core, 'initialPowerFraction'), 0, 1))

/** The average rod's steps withdrawn at an insertion fraction. */
export const rodStepsWithdrawn = (insertedFraction: number): number => (1 - insertedFraction) * rodTravelSteps

/**
 * Each control bank's steps withdrawn, A to D, where the overlap program puts
 * it for an average insertion: the program counts from 0 (every bank in) to
 * the last bank's start plus its travel (every bank out), the rod demand's
 * range spanning the last two banks, anchored at the last bank's position at
 * the critical insertion.
 */
export const controlBankStepsAt = (core: CompiledComponent, insertedFraction: number): ReadonlyArray<number> => {
  const { bankSpacingSteps, lastBankStepsAtCriticalInsertion } = reactorNeutronics(core).rodBanks
  const lastBankStart = (controlRodBanks.length - 1) * bankSpacingSteps
  const program = clamp(
    lastBankStart + lastBankStepsAtCriticalInsertion + (bankSpacingSteps + rodTravelSteps) * (criticalRodInsertionFraction(core) - insertedFraction),
    0,
    lastBankStart + rodTravelSteps,
  )
  return controlRodBanks.map((_, index) => clamp(program - index * bankSpacingSteps, 0, rodTravelSteps))
}
