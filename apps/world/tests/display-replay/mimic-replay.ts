/**
 * T0 replay corpus (plan v3.1 Appendix F, T02): every unique mimic intent an
 * agent wrote across the display evaluation runs (runs 15–27, 19 Oct audit),
 * replayed through today's compile on the 4-loop reference Plant at the chat
 * budgets (800 × 624 beside other panels, 800 × 744 alone). The record keeps
 * each intent's outcome and drawing hash at bacf7a115, so the engine
 * relocation can show hash parity and no lane can make a drawable intent fail
 * unnoticed.
 */
import { compileProcessPlant, createPwrReferencePlantDefinition, type CompiledProcessPlant } from '../../src/packs/process-plant/index.ts'
import { compileMimic } from '../../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { chatMimicProfile } from '../../src/packs/process-plant/displays/mimic/profiles.ts'

export const BUDGETS = [{ maxWidth: 800, maxHeight: 624 }, { maxWidth: 800, maxHeight: 744 }] as const

export interface CorpusIntent {
  readonly intent: Record<string, unknown>
  /** Where agents wrote it: evidence run directory / scenario. */
  readonly seenIn: ReadonlyArray<string>
}

export type ReplayOutcome = { readonly draws: true; readonly hash: string } | { readonly draws: false; readonly issues: ReadonlyArray<string> }

let plant: CompiledProcessPlant | undefined
const referencePlant = (): CompiledProcessPlant => plant ??= compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:replay', loopCount: 4 }))

export const replayIntent = (intent: Record<string, unknown>): ReadonlyArray<ReplayOutcome> => BUDGETS.map(budget => {
  const result = compileMimic(referencePlant(), intent as never, { profile: chatMimicProfile, ...budget })
  return result.ok ? { draws: true, hash: result.mimic.hash } : { draws: false, issues: result.issues.map(issue => issue.message) }
})
