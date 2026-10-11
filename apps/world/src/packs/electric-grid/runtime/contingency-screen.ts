import { caseGeneratorOutputMw, type ContingencyCase } from './contingency-case.ts'
import { createContingencyEngine, type ContingencyPart, type GridContingency } from './contingency.ts'
import { gridGeneratorIsSynchronised } from './island-input.ts'

export type ContingencyRatingBasis = 'normal' | 'emergency'

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
}

export interface ContingencyResult {
  readonly contingency: { readonly assetId: string; readonly kind: 'branch' | 'generator'; readonly label: string; readonly lostMw: number }
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

const maximumListedOverloads = 20

/** The selected outages, each checked in service; a branch or unit that is not fails the screening explicitly. */
export const selectContingencies = (screeningCase: ContingencyCase, selection: ContingencySelection): ReadonlyArray<GridContingency> => {
  const { network, grid } = screeningCase
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
    for (let index = 0; index < network.branchCount; index += 1) if (branchInService(index)) contingencies.push({ kind: 'branch', branchIndex: index })
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
      return { kind: 'branch', branchIndex: index }
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

/** Screens the outages on the case: post-outage loading of every branch against the rating basis. */
export const screenContingencies = (screeningCase: ContingencyCase, contingencies: ReadonlyArray<GridContingency>, ratingBasis: ContingencyRatingBasis): ScreeningSummary => {
  const { network, grid } = screeningCase
  const model = grid.definition.model
  const engine = createContingencyEngine(screeningCase)
  const capacityMw = Float64Array.from(model.branches, branch =>
    (ratingBasis === 'normal' ? branch.ratingMw : branch.emergencyRatingMw) * grid.branches.get(branch.id)!.availability)
  const loading = (flowMw: number, branch: number): number => Math.abs(flowMw) / capacityMw[branch]! * 100
  const base = screeningCase.flowsMw
  const screened = (branch: number, flowMw: number): ScreenedBranch => ({
    assetId: network.branchIds[branch]!,
    label: model.branches[branch]!.label,
    flowMw: tenths(flowMw),
    loadingPercent: tenths(loading(flowMw, branch)),
    preContingencyLoadingPercent: tenths(loading(base[branch]!, branch)),
  })
  const worstOf = (flows: Float64Array): { readonly worst: number; readonly overloaded: number[] } => {
    let worst = -1
    let worstLoading = -1
    const overloaded: number[] = []
    for (let branch = 0; branch < network.branchCount; branch += 1) {
      const value = loading(flows[branch]!, branch)
      if (value > worstLoading) {
        worstLoading = value
        worst = branch
      }
      if (value > 100) overloaded.push(branch)
    }
    return { worst, overloaded }
  }
  const baseWorst = worstOf(base)
  const flows = new Float64Array(network.branchCount)
  let totalViolations = 0
  let islandingCount = 0
  const results = contingencies.map((contingency): ContingencyResult => {
    const outcome = engine.evaluate(contingency, flows)
    const { worst, overloaded } = worstOf(flows)
    totalViolations += overloaded.length
    if (outcome.islanding) islandingCount += 1
    const assetId = contingency.kind === 'branch' ? network.branchIds[contingency.branchIndex]! : contingency.generatorId
    return {
      contingency: { assetId, kind: contingency.kind, label: grid.definition.index.assetById.get(assetId)!.label, lostMw: tenths(outcome.lostMw) },
      islanding: outcome.islanding,
      affectedIslands: outcome.parts.map(part => ({
        ...part,
        imbalanceMw: tenths(part.imbalanceMw),
        reserveShortfallMw: tenths(part.reserveShortfallMw),
        unservedLoadMw: tenths(part.unservedLoadMw),
      })),
      unservedLoadMw: tenths(outcome.parts.reduce((sum, part) => sum + part.unservedLoadMw, 0)),
      worstBranch: worst < 0 ? null : screened(worst, flows[worst]!),
      overloadedBranches: overloaded
        .sort((a, b) => loading(flows[b]!, b) - loading(flows[a]!, a))
        .slice(0, maximumListedOverloads)
        .map(branch => screened(branch, flows[branch]!)),
      violationCount: overloaded.length,
    }
  }).sort(bySeverity)
  return {
    screenedCount: results.length,
    violatingCount: results.filter(result => result.violationCount > 0).length,
    islandingCount,
    totalViolations,
    baseCase: { overloadedCount: baseWorst.overloaded.length, worstBranch: baseWorst.worst < 0 ? null : screened(baseWorst.worst, base[baseWorst.worst]!) },
    results,
  }
}
