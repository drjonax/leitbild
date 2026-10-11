import { captureContingencySnapshot, type ContingencyRatingBasis } from './contingency-capture.ts'
import { caseGeneratorOutputMw, type ContingencyCase } from './contingency-case.ts'
import {
  balancingByCode,
  maximumListedOverloads,
  recordInteger,
  recordIntegerWidth,
  recordValue,
  recordValueWidth,
  type ContingencySnapshot,
  type GridContingency,
  type ScreeningRecords,
} from './contingency-snapshot.ts'
import { branchLoadingBasis, branchLoadingPercent, scanBranchLoading, type ContingencyPart, type LoadingBasis } from './contingency.ts'
import { gridGeneratorIsSynchronised } from './island-input.ts'

export type { ContingencyRatingBasis } from './contingency-capture.ts'

/**
 * What a branch outage takes out. `circuit`: one circuit (or transformer unit) of a branch the Model
 * holds as n identical parallel circuits — the loss of one element, N-1 — leaving the branch in
 * service with (n − 1)/n of its admittance and of its continuous and emergency ratings; a
 * single-circuit branch is lost whole. `branch`: every circuit of the branch at once, for a
 * multi-circuit branch an exceptional N-k loss (a double-circuit line on common towers, a busbar
 * fault taking all parallel transformer units).
 */
export type BranchOutageScope = 'circuit' | 'branch'

/** ordinary: the loss of one element, a branch circuit or a unit; exceptional: several circuits of one branch at once (SO GL Art. 3). */
export type ContingencyCategory = 'ordinary' | 'exceptional'

/** Which outages to screen: every branch in service, the largest units by output, or named assets. */
export type ContingencySelection =
  | { readonly kind: 'all-branches' }
  | { readonly kind: 'largest-generators'; readonly count: number }
  | { readonly kind: 'assets'; readonly assetIds: ReadonlyArray<string> }

export interface ScreenedBranch {
  readonly assetId: string
  readonly label: string
  readonly flowMw: number
  readonly loadingPercent: number
  readonly preContingencyLoadingPercent: number
  /** mva: the larger end apparent power (a converged AC island); mw: |active power|. */
  readonly loadingBasis: LoadingBasis
}

/** What an outage took out: `circuitsLost` of a branch's `circuits`, or a unit. */
export type ScreenedContingency =
  | {
    readonly assetId: string
    readonly kind: 'branch'
    readonly label: string
    readonly lostMw: number
    readonly circuits: number
    readonly circuitsLost: number
    readonly category: ContingencyCategory
  }
  | { readonly assetId: string; readonly kind: 'generator'; readonly label: string; readonly lostMw: number; readonly category: 'ordinary' }

export interface ContingencyResult {
  readonly contingency: ScreenedContingency
  readonly islanding: boolean
  readonly affectedIslands: ReadonlyArray<ContingencyPart>
  readonly unservedLoadMw: number
  readonly worstBranch: ScreenedBranch | null
  /** Branches loaded above 100 % of the rating basis after the outage, most loaded first (at most `maximumListedOverloads`). */
  readonly overloadedBranches: ReadonlyArray<ScreenedBranch>
  /** All branches above 100 % of the rating basis after the outage. */
  readonly violationCount: number
}

export interface ScreeningSummary {
  readonly screenedCount: number
  readonly violatingCount: number
  readonly islandingCount: number
  readonly totalViolations: number
  readonly baseCase: { readonly overloadedCount: number; readonly worstBranch: ScreenedBranch | null }
  /** Most severe first. */
  readonly results: ReadonlyArray<ContingencyResult>
}

/** Produces the records of every contingency of a snapshot, inline or on worker threads (contingency-pool.ts). */
export type ContingencyRecordScreen = (snapshot: ContingencySnapshot) => Promise<ScreeningRecords>

/**
 * The selected outages, each checked in service; a branch or unit that is not fails the screening
 * explicitly. Each branch outage takes out what `branchOutage` names.
 */
export const selectContingencies = (screeningCase: ContingencyCase, selection: ContingencySelection, branchOutage: BranchOutageScope): ReadonlyArray<GridContingency> => {
  const { network, grid } = screeningCase
  const branchContingency = (index: number): GridContingency =>
    ({ kind: 'branch', branchIndex: index, circuitsLost: branchOutage === 'circuit' ? 1 : grid.definition.model.branches[index]!.circuits })
  const branchInService = (index: number): boolean =>
    screeningCase.closed[index] === 1 && screeningCase.islands[screeningCase.islandOfBus[network.branchFrom[index]!]!]!.energised
  const generatorInService = (generatorId: string): boolean => {
    const definition = grid.definition.index.assetById.get(generatorId)
    if (definition?.kind !== 'generator') return false
    const bus = network.busIndexById.get(definition.definition.busId)!
    return gridGeneratorIsSynchronised(grid.generators.get(generatorId)!) && screeningCase.islands[screeningCase.islandOfBus[bus]!]!.energised
  }
  if (selection.kind === 'all-branches') {
    const contingencies: GridContingency[] = []
    for (let index = 0; index < network.branchCount; index += 1) if (branchInService(index)) contingencies.push(branchContingency(index))
    return contingencies
  }
  if (selection.kind === 'largest-generators') {
    return grid.definition.model.generators
      .filter(definition => generatorInService(definition.id) && caseGeneratorOutputMw(screeningCase, definition.id) > 0)
      .map(definition => ({ id: definition.id, outputMw: caseGeneratorOutputMw(screeningCase, definition.id) }))
      .sort((a, b) => b.outputMw - a.outputMw || (a.id < b.id ? -1 : 1))
      .slice(0, selection.count)
      .map(unit => ({ kind: 'generator', generatorId: unit.id }))
  }
  if (new Set(selection.assetIds).size !== selection.assetIds.length) throw new Error('contingency asset ids must be unique')
  return selection.assetIds.map((assetId): GridContingency => {
    const entry = grid.definition.index.assetById.get(assetId)
    if (entry?.kind === 'branch') {
      const index = network.branchIds.indexOf(assetId)
      if (!branchInService(index)) throw new Error(`contingency branch ${assetId} is not in service (open, tripped or in a de-energised island)`)
      return branchContingency(index)
    }
    if (entry?.kind === 'generator') {
      if (!generatorInService(assetId)) throw new Error(`contingency generator ${assetId} is not synchronised to an energised island`)
      return { kind: 'generator', generatorId: assetId }
    }
    throw new Error(`contingency ${assetId} is not a branch or generator of this Grid; discover ids with world.electric-grid.assets.search`)
  })
}

// Results are rounded to metering resolution (0.1 MW, 0.1 %).
const tenths = (value: number): number => Math.round(value * 10) / 10

const bySeverity = (left: ContingencyResult, right: ContingencyResult): number =>
  right.violationCount - left.violationCount
  || (right.worstBranch?.loadingPercent ?? 0) - (left.worstBranch?.loadingPercent ?? 0)
  || right.unservedLoadMw - left.unservedLoadMw
  || (left.contingency.assetId < right.contingency.assetId ? -1 : left.contingency.assetId > right.contingency.assetId ? 1 : 0)

type ScreenedAsset = DistributiveOmit<ScreenedContingency, 'lostMw'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Results from the kernel's records: the same records give the same summary, whichever thread wrote them. */
const summaryOf = (config: {
  readonly snapshot: ContingencySnapshot
  readonly records: ScreeningRecords
  readonly assets: ReadonlyArray<ScreenedAsset>
  readonly branchIds: ReadonlyArray<string>
  readonly branchLabels: ReadonlyArray<string>
}): ScreeningSummary => {
  const { snapshot, records, assets, branchIds, branchLabels } = config
  const base = snapshot.flowsMw
  const screened = (branch: number, flowMw: number, loadingPercent: number): ScreenedBranch => ({
    assetId: branchIds[branch]!,
    label: branchLabels[branch]!,
    flowMw: tenths(flowMw),
    loadingPercent: tenths(loadingPercent),
    preContingencyLoadingPercent: tenths(branchLoadingPercent(snapshot, branch, base[branch]!)),
    loadingBasis: branchLoadingBasis(snapshot, branch),
  })
  const baseScan = scanBranchLoading({
    snapshot, flowsMw: base, outOfService: null, deratedBranch: -1, remainingShare: 1, listed: new Int32Array(maximumListedOverloads), listedLoadingPercent: new Float64Array(maximumListedOverloads),
  })
  let totalViolations = 0
  let islandingCount = 0
  const results = assets.map((asset, position): ContingencyResult => {
    const integers = position * recordIntegerWidth
    const values = position * recordValueWidth
    const islanding = records.integers[integers + recordInteger.islanding] === 1
    const violationCount = records.integers[integers + recordInteger.violationCount]!
    const worst = records.integers[integers + recordInteger.worstBranch]!
    totalViolations += violationCount
    if (islanding) islandingCount += 1
    const parts = Array.from({ length: records.integers[integers + recordInteger.partCount]! }, (_, index): ContingencyPart => ({
      balancing: balancingByCode[records.integers[integers + recordInteger.firstPart + 2 * index + 1]!]!,
      imbalanceMw: records.values[values + recordValue.firstPart + 3 * index]!,
      reserveShortfallMw: records.values[values + recordValue.firstPart + 3 * index + 1]!,
      unservedLoadMw: records.values[values + recordValue.firstPart + 3 * index + 2]!,
      busCount: records.integers[integers + recordInteger.firstPart + 2 * index]!,
    }))
    const slots = position * maximumListedOverloads
    return {
      contingency: { ...asset, lostMw: tenths(records.values[values + recordValue.lostMw]!) },
      islanding,
      affectedIslands: parts.map(part => ({
        ...part,
        imbalanceMw: tenths(part.imbalanceMw),
        reserveShortfallMw: tenths(part.reserveShortfallMw),
        unservedLoadMw: tenths(part.unservedLoadMw),
      })),
      unservedLoadMw: tenths(parts.reduce((sum, part) => sum + part.unservedLoadMw, 0)),
      worstBranch: worst < 0 ? null : screened(worst, records.values[values + recordValue.worstFlowMw]!, records.values[values + recordValue.worstLoadingPercent]!),
      overloadedBranches: Array.from({ length: records.integers[integers + recordInteger.listedCount]! }, (_, index) =>
        screened(records.listedBranches[slots + index]!, records.listedFlowsMw[slots + index]!, records.listedLoadingPercent[slots + index]!)),
      violationCount,
    }
  }).sort(bySeverity)
  return {
    screenedCount: results.length,
    violatingCount: results.filter(result => result.violationCount > 0).length,
    islandingCount,
    totalViolations,
    baseCase: { overloadedCount: baseScan.overloadedCount, worstBranch: baseScan.worst < 0 ? null : screened(baseScan.worst, base[baseScan.worst]!, baseScan.worstLoadingPercent) },
    results,
  }
}

/**
 * Screens the outages on the case: post-outage loading of every branch against the rating basis.
 * Everything the screening reads from the Grid is captured before the first await, so the result
 * describes the case as it was at the call, however the Grid advances meanwhile.
 */
export const screenContingencies = async (config: {
  readonly screeningCase: ContingencyCase
  readonly contingencies: ReadonlyArray<GridContingency>
  readonly ratingBasis: ContingencyRatingBasis
  readonly screen: ContingencyRecordScreen
}): Promise<ScreeningSummary> => {
  const { screeningCase, contingencies } = config
  const { network, grid } = screeningCase
  const snapshot = captureContingencySnapshot(screeningCase, contingencies, config.ratingBasis)
  const assets = contingencies.map((contingency): ScreenedAsset => {
    if (contingency.kind === 'generator') {
      const assetId = contingency.generatorId
      return { assetId, kind: 'generator', label: grid.definition.index.assetById.get(assetId)!.label, category: 'ordinary' }
    }
    const branch = grid.definition.model.branches[contingency.branchIndex]!
    return {
      assetId: branch.id,
      kind: 'branch',
      label: branch.label,
      circuits: branch.circuits,
      circuitsLost: contingency.circuitsLost,
      category: contingency.circuitsLost > 1 ? 'exceptional' : 'ordinary',
    }
  })
  const branchLabels = grid.definition.model.branches.map(branch => branch.label)
  const records = await config.screen(snapshot)
  return summaryOf({ snapshot, records, assets, branchIds: network.branchIds, branchLabels })
}
