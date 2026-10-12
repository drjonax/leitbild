import type { GridContingencyScreenResult, GridRemedialActionInput, GridRemedialEvaluationResult } from '../queries/contingency.ts'

// Operator presentation of world.electric-grid.contingency.screen and remedial-actions.evaluate:
// the worst outages with what each took out (one circuit of a multi-circuit branch, or all of
// them), their violations, where the base flows come from, the basis each loading is judged on,
// and a before/after comparison of candidate remedial actions.

type ScreenedBranch = NonNullable<GridContingencyScreenResult['results'][number]['worstBranch']>
type ScreenedContingency = GridContingencyScreenResult['results'][number]['contingency']
type Summary = GridRemedialEvaluationResult['before']
export type GridBranchOutage = GridContingencyScreenResult['branchOutage']

/** The panel's screening: one circuit of every closed branch (N-1), judged against the emergency rating, the worst first. */
export const gridDefaultScreening = { contingencies: 'all-branches', branchOutage: 'circuit', ratingBasis: 'emergency', limit: 15 } as const

export const gridBranchOutageOptions: ReadonlyArray<{ readonly value: GridBranchOutage; readonly label: string }> = [
  { value: 'circuit', label: 'One circuit (N-1)' },
  { value: 'branch', label: 'All circuits of a branch (N-k)' },
]

export interface GridScreenedBranchRow {
  readonly assetId: string
  readonly label: string
  readonly loadingText: string
  readonly preContingencyText: string
  readonly basis: string
  readonly overloaded: boolean
}

export interface GridContingencyRow {
  readonly assetId: string
  readonly label: string
  readonly kind: 'branch' | 'generator'
  /** What the outage took out: a unit, a branch, one of its circuits, or all of them (exceptional). */
  readonly outageText: string
  readonly lostText: string
  readonly severity: 'violation' | 'unserved' | 'islanding' | 'secure'
  readonly outcome: string
  readonly worst: GridScreenedBranchRow | null
  readonly overloaded: ReadonlyArray<GridScreenedBranchRow>
}

const mw = (value: number): string => `${Math.round(value).toLocaleString('en-GB')} MW`
const percent = (value: number): string => `${value.toFixed(1)} %`

/** The rating a screening judges loading against, named as the rating selector and the branch loading alarms name it. */
export const gridRatingBasisLabel = (basis: GridContingencyScreenResult['ratingBasis']): string => basis === 'emergency' ? 'emergency rating' : 'continuous rating'

/** What a loading is judged on: apparent power on an AC island, active power on a DC one. */
export const gridLoadingBasisLabel = (basis: ScreenedBranch['loadingBasis']): string => basis === 'mva' ? 'MVA (AC base)' : 'MW (DC base)'

const branchRow = (branch: ScreenedBranch): GridScreenedBranchRow => ({
  assetId: branch.assetId,
  label: branch.label,
  loadingText: percent(branch.loadingPercent),
  preContingencyText: percent(branch.preContingencyLoadingPercent),
  basis: gridLoadingBasisLabel(branch.loadingBasis),
  overloaded: branch.loadingPercent > 100,
})

const outcomeOf = (result: GridContingencyScreenResult['results'][number]): string => {
  const parts = [
    ...(result.violationCount > 0 ? [`${result.violationCount} overloaded branch${result.violationCount === 1 ? '' : 'es'}`] : []),
    ...(result.islanding ? [`islands ${result.affectedIslands.length} part${result.affectedIslands.length === 1 ? '' : 's'}`] : []),
    ...(result.unservedLoadMw > 0 ? [`${mw(result.unservedLoadMw)} unserved`] : []),
  ]
  return parts.length === 0 ? 'Secure' : parts.join(' · ')
}

export const gridOutageText = (contingency: ScreenedContingency): string => {
  if (contingency.kind === 'generator') return 'unit outage'
  if (contingency.circuits === 1) return 'branch outage'
  if (contingency.circuitsLost < contingency.circuits) return `${contingency.circuitsLost} of ${contingency.circuits} circuits`
  return `all ${contingency.circuits} circuits · exceptional (N-${contingency.circuitsLost})`
}

export const gridContingencyRows = (result: Pick<GridContingencyScreenResult, 'results'>): ReadonlyArray<GridContingencyRow> => result.results.map(entry => ({
  assetId: entry.contingency.assetId,
  label: entry.contingency.label,
  kind: entry.contingency.kind,
  outageText: gridOutageText(entry.contingency),
  lostText: `${entry.contingency.kind === 'branch' ? 'carried' : 'produced'} ${mw(Math.abs(entry.contingency.lostMw))}`,
  severity: entry.violationCount > 0 ? 'violation' : entry.unservedLoadMw > 0 ? 'unserved' : entry.islanding ? 'islanding' : 'secure',
  outcome: outcomeOf(entry),
  worst: entry.worstBranch === null ? null : branchRow(entry.worstBranch),
  overloaded: entry.overloadedBranches.map(branchRow),
}))

/** Where the screened base flows come from, per island, and that the outage increments are DC. */
export const gridFlowModelSummary = (result: Pick<GridContingencyScreenResult, 'baseFlowModels' | 'incrementModel'>): string => {
  const ac = result.baseFlowModels.filter(entry => entry.flowModel === 'ac').length
  const dc = result.baseFlowModels.length - ac
  const islands = (count: number): string => `${count} island${count === 1 ? '' : 's'}`
  const base = [...(ac > 0 ? [`AC load flow in ${islands(ac)}`] : []), ...(dc > 0 ? [`DC solution in ${islands(dc)} whose AC load flow did not converge`] : [])]
  return `Base flows: ${base.length === 0 ? 'no energised island' : base.join(', ')}; outage increments ${result.incrementModel.toUpperCase()}.`
}

export interface GridComparisonRow {
  readonly label: string
  readonly before: string
  readonly after: string
  /** True when the actions improve it, false when they worsen it, null when unchanged. */
  readonly improved: boolean | null
}

const compared = (label: string, before: number, after: number, text: (value: number) => string): GridComparisonRow => ({
  label,
  before: text(before),
  after: text(after),
  improved: after === before ? null : after < before,
})

const worstLoading = (summary: Summary): number => summary.baseCase.worstBranch?.loadingPercent ?? 0

/** The evaluation's base case and N-1 screening before and after the candidate actions; lower is better throughout. */
export const gridRemedialComparison = (evaluation: Pick<GridRemedialEvaluationResult, 'before' | 'after'>): ReadonlyArray<GridComparisonRow> => {
  const { before, after } = evaluation
  const count = (value: number): string => value.toLocaleString('en-GB')
  return [
    compared('Base-case overloads', before.baseCase.overloadedCount, after.baseCase.overloadedCount, count),
    compared('Base-case worst loading', worstLoading(before), worstLoading(after), percent),
    compared('Contingencies with overloads', before.violatingCount, after.violatingCount, count),
    compared('Overloads over all contingencies', before.totalViolations, after.totalViolations, count),
    compared('Islanding contingencies', before.islandingCount, after.islandingCount, count),
  ]
}

export type GridCandidateAction = GridRemedialActionInput
export type GridCandidateKind = GridCandidateAction['kind']

export const gridCandidateKinds: ReadonlyArray<{ readonly kind: GridCandidateKind; readonly label: string; readonly assetKind: 'generator' | 'load' | 'branch'; readonly valueLabel: string | null }> = [
  { kind: 'open-branch', label: 'Open branch', assetKind: 'branch', valueLabel: null },
  { kind: 'close-branch', label: 'Close branch', assetKind: 'branch', valueLabel: null },
  { kind: 'redispatch', label: 'Redispatch unit', assetKind: 'generator', valueLabel: 'Target (MW)' },
  { kind: 'shed-load', label: 'Shed load', assetKind: 'load', valueLabel: 'Limit demand to (MW)' },
]

/**
 * A candidate action from the panel's form, or the reason it is incomplete. The evaluation itself
 * checks every action against the rules of its command.
 */
export const gridCandidateAction = (form: {
  readonly kind: GridCandidateKind
  readonly assetId: string
  readonly assetKind: string | null
  readonly value: string
  readonly emergency: boolean
}): { readonly action: GridCandidateAction } | { readonly error: string } => {
  const spec = gridCandidateKinds.find(candidate => candidate.kind === form.kind)!
  if (form.assetId === '') return { error: `Select a ${spec.assetKind} on the map or in Assets first.` }
  if (form.assetKind !== spec.assetKind) return { error: `${spec.label} needs a ${spec.assetKind}; the selection is ${form.assetKind ?? 'not a Grid Asset'}.` }
  if (form.kind === 'open-branch' || form.kind === 'close-branch') return { action: { kind: form.kind, assetId: form.assetId } }
  const value = Number(form.value)
  if (form.value.trim() === '' || !Number.isFinite(value) || value < 0) return { error: `${spec.valueLabel} must be a number of at least 0.` }
  return form.kind === 'redispatch'
    ? { action: { kind: 'redispatch', assetId: form.assetId, targetMw: value } }
    : { action: { kind: 'shed-load', assetId: form.assetId, targetDemandMw: value, emergency: form.emergency } }
}

export const gridCandidateActionText = (action: GridCandidateAction, label: string): string => {
  if (action.kind === 'open-branch') return `Open ${label}`
  if (action.kind === 'close-branch') return `Close ${label}`
  if (action.kind === 'redispatch') return `Redispatch ${label} to ${mw(action.targetMw)}`
  return `${action.emergency ? 'Emergency-shed' : 'Curtail'} ${label} to ${mw(action.targetDemandMw)}`
}
