import { z } from 'zod'
import { rejectCapabilityInput } from '../../../simulation/capability-rejection.ts'
import { liveContingencyCase, switchedContingencyCase, type ContingencyCase } from '../runtime/contingency-case.ts'
import { sizedContingencyScreen } from '../runtime/contingency-execution.ts'
import { processContingencyPool } from '../runtime/contingency-pool.ts'
import {
  screenContingencies,
  selectContingencies,
  type BranchOutageScope,
  type ContingencyRecordScreen,
  type ContingencySelection,
  type ScreeningSummary,
} from '../runtime/contingency-screen.ts'
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
  branchOutage: z.enum(['circuit', 'branch']).default('circuit').describe('What each branch outage takes out. circuit: one circuit, or one transformer unit, of a branch the model holds as n parallel circuits (the loss of one element, N-1); the branch stays in service with (n − 1)/n of its admittance and of its continuous and emergency ratings, its identical circuits sharing the flow. A single-circuit branch is lost whole either way. branch: every circuit of the branch at once, for a multi-circuit branch an exceptional N-k contingency (a double-circuit line lost on common towers, a busbar fault taking all parallel transformer units).'),
  largestGeneratorCount: z.number().int().min(1).max(100).optional().describe('How many units largest-generators screens; required with it and only with it.'),
  ratingBasis: z.enum(['normal', 'emergency']).default('normal').describe('Loading against the continuous (normal) or emergency rating, both times the branch availability.'),
  limit: z.number().int().min(1).max(500).default(20).describe('Results returned, most severe first.'),
}

const screenPayloadSchema = z.object(screeningInput).strict()

const screenedBranchSchema = z.object({
  assetId: z.string(),
  label: z.string(),
  flowMw: finite.describe('Post-contingency active power flow at the from end, positive from fromBusId to toBusId: the base flow plus the DC outage increment (0.1 MW).'),
  loadingPercent: finite.describe('Post-contingency loading on loadingBasis over the rating basis × availability (0.1 %), as the runtime\'s branch loading and alarms judge it.'),
  preContingencyLoadingPercent: finite.describe('The same branch\'s loading on the same basis before the outage (0.1 %); on the mva basis it equals the runtime\'s loadingPercent.'),
  loadingBasis: z.enum(['mva', 'mw']).describe('mva: on an island whose AC load flow converged, the larger end apparent power, with each end\'s reactive power held at its base value and the active power moved by the DC increment; mw: |active power| on a DC island.'),
}).strict()

const partSchema = z.object({
  busCount: count,
  balancing: z.enum(['reserves', 'inertia', 'de-energised']).describe('reserves: the part\'s FCR providers pick up its imbalance in proportion to their FCR-N + FCR-D; inertia: it holds no reserve in that direction and shares by kinetic energy; de-energised: no voltage-forming source remains.'),
  imbalanceMw: finite.describe('Injection sum the part had to absorb (positive: surplus).'),
  reserveShortfallMw: finite.describe('Imbalance beyond the part\'s reserve in that direction.'),
  unservedLoadMw: finite,
}).strict()

const categorySchema = z.enum(['ordinary', 'exceptional'])
  .describe('ordinary: the loss of one element, a single circuit, transformer unit or generating unit (N-1); exceptional: several circuits of one branch at once (N-k, SO GL Art. 3).')

const contingencySchema = z.discriminatedUnion('kind', [
  z.object({
    assetId: z.string(),
    kind: z.literal('branch'),
    label: z.string(),
    circuits: z.number().int().positive().describe('Parallel circuits or transformer units the model holds in the branch.'),
    circuitsLost: z.number().int().positive().describe('Circuits the outage took out; with fewer than circuits the branch stays in service on the rest.'),
    category: categorySchema,
    lostMw: finite.describe('Pre-contingency flow of the circuits lost: the branch\'s flow times circuitsLost / circuits (0.1 MW).'),
  }).strict(),
  z.object({ assetId: z.string(), kind: z.literal('generator'), label: z.string(), category: z.literal('ordinary'), lostMw: finite.describe('Pre-contingency unit output (0.1 MW).') }).strict(),
])

const resultSchema = z.object({
  contingency: contingencySchema,
  islanding: z.boolean().describe('The outage splits its island. Separating a boundary bus of an external system (its last tie lost) is no split: the system holds it in no island, and the rest rebalances.'),
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

const flowModelsShape = {
  baseFlowModels: z.array(z.object({ islandId: z.string(), flowModel: z.enum(['ac', 'dc']) }).strict())
    .describe('Per energised island (ids as in world.electric-grid.islands.list), where its base flows come from: ac, its converged AC load flow (active power at the from end); dc, the DC solution where it did not converge.'),
  incrementModel: z.literal('dc').describe('Outage increments are DC: line outage distribution factors and compensating solves on the island\'s DC factorisation, added to the base flows.'),
}

const branchOutageSchema = z.enum(['circuit', 'branch'])

const screenResultSchema = z.object({
  gridId: z.string(),
  revision: count.describe('Grid tick of the solved state that was screened.'),
  ratingBasis: z.enum(['normal', 'emergency']),
  branchOutage: branchOutageSchema,
  ...flowModelsShape,
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
const selected = (screeningCase: ContingencyCase, selection: ContingencySelection, branchOutage: BranchOutageScope): ReadonlyArray<GridContingency> =>
  validated(() => selectContingencies(screeningCase, selection, branchOutage))

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
  description: 'Read-only N-1 screening of the solved Grid: for each branch or generator outage, the post-contingency worst branch and its loading, overloaded branches, whether the outage islands part of the network with each part\'s imbalance (rebalanced by FCR reserve participation; a part without a voltage-forming source loses supply), and the violation count. A branch outage takes out one circuit of a multi-circuit branch by default, the rest staying in service (N-1); branchOutage branch screens the loss of all its circuits, an exceptional N-k contingency. Post-contingency flows are the solved base flows (AC where the island\'s load flow converged, else DC) plus DC outage increments: line outage distribution factors on the cached factorisation for branches and circuits, compensating solves for islanding and unit outages. Nothing in the Grid changes.',
  searchTerms: ['N-1', 'contingency', 'contingency analysis', 'security assessment', 'outage', 'LODF', 'PTDF', 'overload', 'islanding', 'what if', 'n-1', 'utfall', 'sikkerhetsvurdering', 'driftssikkerhet', 'overlast', 'øydrift'],
  input: screenPayloadSchema,
  output: screenResultSchema,
  answer: async (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const revision = grid.tick
    const live = liveContingencyCase(grid)
    const summary = await screen(live, selected(live, selectionFor(payload), payload.branchOutage), payload.ratingBasis)
    return {
      gridId: payload.gridId,
      revision,
      ratingBasis: payload.ratingBasis,
      branchOutage: payload.branchOutage,
      baseFlowModels: live.baseFlowModels,
      incrementModel: 'dc' as const,
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
  actions: z.array(actionSchema).min(1).max(20).describe('Candidate actions in order, each on a different asset, with the rules of dispatch-generator, shed-load, open-branch and close-branch. A redispatched unit holds its set-point; the island\'s other FCR providers balance the difference. A close-branch passes close-branch\'s synchro-check, measured after the earlier actions, or the evaluation is rejected with the measured Δf or Δθ. Δθ comes from the island\'s AC load flow where it converged, from its DC solution where it did not, and from the DC solution of the case once earlier actions changed it; the reason names the basis.'),
}).strict()

const remedialResultSchema = z.object({
  gridId: z.string(),
  revision: count,
  ratingBasis: z.enum(['normal', 'emergency']),
  branchOutage: branchOutageSchema,
  ...flowModelsShape,
  actionBalances: z.array(partSchema).describe('Islands of the post-action case that had to rebalance or lost supply.'),
  before: summarySchema,
  after: summarySchema,
  results: z.array(resultSchema).describe('Post-action contingency results, most severe first.'),
}).strict()

export const gridRemedialActionsEvaluateQuery = defineGridQuery({
  id: 'world.electric-grid.remedial-actions.evaluate',
  title: 'Evaluate remedial actions',
  description: 'Read-only: applies candidate redispatch, load-shedding and branch open/close actions to a private copy of the solved Grid and returns its base case and N-1 screening before and after them, with the same outages as contingency.screen (one circuit of a multi-circuit branch unless branchOutage is branch). The post-action base flows are the solved base flows plus the DC change the actions make, screened like the live ones. An action its command would reject rejects the evaluation with that reason; a close-branch the synchro-check would refuse reports the measured frequency (Δf) or voltage-angle (Δθ) difference. Nothing is applied; issue the matching commands to act.',
  searchTerms: ['remedial action', 'corrective action', 'redispatch', 'countertrade', 'N-1', 'what if', 'switching plan', 'congestion relief', 'avhjelpende tiltak', 'omfordeling', 'spesialregulering', 'koblingsplan', 'n-1'],
  input: remedialPayloadSchema,
  output: remedialResultSchema,
  answer: async (payload, grids) => {
    const grid = gridFor(grids, payload.gridId)
    const revision = grid.tick
    const selection = selectionFor(payload)
    const live = liveContingencyCase(grid)
    const beforeContingencies = selected(live, selection, payload.branchOutage)
    const remedial = switchedContingencyCase(live, validated(() => remedialCaseChanges(live, payload.actions)))
    const afterContingencies = selected(remedial.case, selection, payload.branchOutage)
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
      branchOutage: payload.branchOutage,
      baseFlowModels: live.baseFlowModels,
      incrementModel: 'dc' as const,
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

export type GridContingencyScreenResult = z.infer<typeof screenResultSchema>
export type GridRemedialEvaluationResult = z.infer<typeof remedialResultSchema>
export type GridRemedialActionInput = z.input<typeof actionSchema>
