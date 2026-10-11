import { z } from 'zod'
import { rejectCapabilityInput } from '../../../simulation/capability-rejection.ts'
import { liveContingencyCase, switchedContingencyCase, type ContingencyCase } from '../runtime/contingency-case.ts'
import { sizedContingencyScreen } from '../runtime/contingency-execution.ts'
import { processContingencyPool } from '../runtime/contingency-pool.ts'
import { screenContingencies, selectContingencies, type ContingencyRecordScreen, type ContingencySelection, type ScreeningSummary } from '../runtime/contingency-screen.ts'
import type { GridContingency } from '../runtime/contingency-snapshot.ts'
import { remedialCaseChanges } from '../runtime/remedial-actions.ts'
import { defineGridQuery, gridFor } from './common.ts'

const finite = z.number().finite()
const count = z.number().int().nonnegative()

const screeningInput = {
  gridId: z.string().min(1),
  contingencies: z.union([
    z.literal('all-branches'),
    z.literal('largest-generators'),
    z.array(z.string().min(1)).min(1).max(5_000),
  ]).describe('all-branches: every closed branch of an energised island; largest-generators: the largestGeneratorCount units with the highest output; or branch and generator asset ids.'),
  largestGeneratorCount: z.number().int().min(1).max(100).optional().describe('How many units largest-generators screens; required with it and only with it.'),
  ratingBasis: z.enum(['normal', 'emergency']).default('normal').describe('Loading against the continuous (normal) or emergency rating, both times the branch availability.'),
  limit: z.number().int().min(1).max(500).default(20).describe('Results returned, most severe first.'),
}

const screenPayloadSchema = z.object(screeningInput).strict()

const screenedBranchSchema = z.object({
  assetId: z.string(),
  label: z.string(),
  flowMw: finite.describe('Post-contingency flow, positive from fromBusId to toBusId (0.1 MW).'),
  loadingPercent: finite.describe('Post-contingency |flow| over the rating basis × availability (0.1 %).'),
  preContingencyLoadingPercent: finite,
}).strict()

const partSchema = z.object({
  busCount: count,
  balancing: z.enum(['reserves', 'inertia', 'de-energised']).describe('reserves: the part\'s FCR providers pick up its imbalance in proportion to their FCR-N + FCR-D; inertia: it holds no reserve in that direction and shares by kinetic energy; de-energised: no voltage-forming source remains.'),
  imbalanceMw: finite.describe('Injection sum the part had to absorb (positive: surplus).'),
  reserveShortfallMw: finite.describe('Imbalance beyond the part\'s reserve in that direction.'),
  unservedLoadMw: finite,
}).strict()

const resultSchema = z.object({
  contingency: z.object({ assetId: z.string(), kind: z.enum(['branch', 'generator']), label: z.string(), lostMw: finite.describe('Pre-contingency flow or unit output (0.1 MW).') }).strict(),
  islanding: z.boolean().describe('The outage splits its island.'),
  affectedIslands: z.array(partSchema).describe('Parts that had to rebalance: both sides of an islanding outage, or the island of a lost unit.'),
  unservedLoadMw: finite,
  worstBranch: screenedBranchSchema.nullable(),
  overloadedBranches: z.array(screenedBranchSchema).describe('Above 100 % of the rating basis, most loaded first, at most 20.'),
  violationCount: count.describe('All branches above 100 % of the rating basis after the outage.'),
}).strict()

const summarySchema = z.object({
  screenedCount: count,
  violatingCount: count.describe('Contingencies with at least one overloaded branch.'),
  islandingCount: count,
  totalViolations: count,
  baseCase: z.object({ overloadedCount: count, worstBranch: screenedBranchSchema.nullable() }).strict(),
}).strict()

const screenResultSchema = z.object({
  gridId: z.string(),
  revision: count.describe('Grid tick of the solved state that was screened.'),
  ratingBasis: z.enum(['normal', 'emergency']),
  ...summarySchema.shape,
  results: z.array(resultSchema),
}).strict()

const selectionFor = (payload: z.infer<typeof screenPayloadSchema>): ContingencySelection => {
  const largest = payload.contingencies === 'largest-generators'
  if (largest !== (payload.largestGeneratorCount !== undefined)) {
    return rejectCapabilityInput('largestGeneratorCount is required with contingencies largest-generators and not allowed otherwise.')
  }
  if (payload.contingencies === 'all-branches') return { kind: 'all-branches' }
  if (payload.contingencies === 'largest-generators') return { kind: 'largest-generators', count: payload.largestGeneratorCount! }
  return { kind: 'assets', assetIds: payload.contingencies }
}

/** Runs a validation step; its failure is the caller's input, rejected with its reason. */
const validated = <T>(step: () => T): T => {
  try {
    return step()
  } catch (error) {
    return rejectCapabilityInput(error instanceof Error ? error.message : String(error))
  }
}

/** Large screenings run on the process's N-1 worker pool, small ones inline (contingency-execution.ts). */
const recordScreen: ContingencyRecordScreen = sizedContingencyScreen(processContingencyPool)

/** The selected outages of a case; a selection the case cannot screen is the caller's input, rejected. */
const selected = (screeningCase: ContingencyCase, selection: ContingencySelection): ReadonlyArray<GridContingency> =>
  validated(() => selectContingencies(screeningCase, selection))

/** Captures the case and its outages before it returns; the screening itself may finish on worker threads. */
const screen = (screeningCase: ContingencyCase, contingencies: ReadonlyArray<GridContingency>, ratingBasis: 'normal' | 'emergency'): Promise<ScreeningSummary> =>
  screenContingencies({ screeningCase, contingencies, ratingBasis, screen: recordScreen })

const summaryOf = (summary: ScreeningSummary): z.infer<typeof summarySchema> => ({
  screenedCount: summary.screenedCount,
  violatingCount: summary.violatingCount,
  islandingCount: summary.islandingCount,
  totalViolations: summary.totalViolations,
  baseCase: summary.baseCase,
})

export const gridContingencyScreenQuery = defineGridQuery({
  id: 'world.electric-grid.contingency.screen',
  title: 'Screen N-1 contingencies',
  description: 'Read-only DC N-1 screening of the solved Grid: for each branch or generator outage, the post-contingency worst branch and its loading, overloaded branches, whether the outage islands part of the network with each part\'s imbalance (rebalanced by FCR reserve participation; a part without a voltage-forming source loses supply), and the violation count. Branch outages use line outage distribution factors on the cached factorisation; nothing in the Grid changes.',
  searchTerms: ['N-1', 'contingency', 'contingency analysis', 'security assessment', 'outage', 'LODF', 'PTDF', 'overload', 'islanding', 'what if', 'n-1', 'utfall', 'sikkerhetsvurdering', 'driftssikkerhet', 'overlast', 'øydrift'],
  input: screenPayloadSchema,
  output: screenResultSchema,
  answer: async (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const revision = grid.tick
    const live = liveContingencyCase(grid)
    const summary = await screen(live, selected(live, selectionFor(payload)), payload.ratingBasis)
    return {
      gridId: payload.gridId,
      revision,
      ratingBasis: payload.ratingBasis,
      ...summaryOf(summary),
      results: summary.results.slice(0, payload.limit),
    }
  },
})

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redispatch'), assetId: z.string().min(1), targetMw: finite.nonnegative() }).strict(),
  z.object({ kind: z.literal('shed-load'), assetId: z.string().min(1), targetDemandMw: finite.nonnegative(), emergency: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('open-branch'), assetId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('close-branch'), assetId: z.string().min(1) }).strict(),
])

const remedialPayloadSchema = z.object({
  ...screeningInput,
  actions: z.array(actionSchema).min(1).max(20).describe('Candidate actions in order, each on a different asset, with the rules of dispatch-generator, shed-load, open-branch and close-branch. A redispatched unit holds its set-point; the island\'s other FCR providers balance the difference.'),
}).strict()

const remedialResultSchema = z.object({
  gridId: z.string(),
  revision: count,
  ratingBasis: z.enum(['normal', 'emergency']),
  actionBalances: z.array(partSchema).describe('Islands of the post-action case that had to rebalance or lost supply.'),
  before: summarySchema,
  after: summarySchema,
  results: z.array(resultSchema).describe('Post-action contingency results, most severe first.'),
}).strict()

export const gridRemedialActionsEvaluateQuery = defineGridQuery({
  id: 'world.electric-grid.remedial-actions.evaluate',
  title: 'Evaluate remedial actions',
  description: 'Read-only: applies candidate redispatch, load-shedding and branch open/close actions to a private copy of the solved Grid and returns its base case and N-1 screening before and after them. Nothing is applied; issue the matching commands to act.',
  searchTerms: ['remedial action', 'corrective action', 'redispatch', 'countertrade', 'N-1', 'what if', 'switching plan', 'congestion relief', 'avhjelpende tiltak', 'omfordeling', 'spesialregulering', 'koblingsplan', 'n-1'],
  input: remedialPayloadSchema,
  output: remedialResultSchema,
  answer: async (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const revision = grid.tick
    const selection = selectionFor(payload)
    const live = liveContingencyCase(grid)
    const beforeContingencies = selected(live, selection)
    const remedial = switchedContingencyCase(live, validated(() => remedialCaseChanges(live, payload.actions)))
    const afterContingencies = selected(remedial.case, selection)
    // Both screenings capture their case before the first await, then share the worker pool.
    const [before, after] = await Promise.all([
      screen(live, beforeContingencies, payload.ratingBasis),
      screen(remedial.case, afterContingencies, payload.ratingBasis),
    ])
    const tenths = (value: number): number => Math.round(value * 10) / 10
    return {
      gridId: payload.gridId,
      revision,
      ratingBasis: payload.ratingBasis,
      actionBalances: remedial.balances.map(part => ({
        busCount: part.busCount,
        balancing: part.balancing,
        imbalanceMw: tenths(part.imbalanceMw),
        reserveShortfallMw: tenths(part.reserveShortfallMw),
        unservedLoadMw: tenths(part.unservedLoadMw),
      })),
      before: summaryOf(before),
      after: summaryOf(after),
      results: after.results.slice(0, payload.limit),
    }
  },
})
