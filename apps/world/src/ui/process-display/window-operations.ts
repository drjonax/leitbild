import type { SimulationRunId } from '../../core/model/index.ts'
import type { VariablePath } from '../../packs/process-plant/graph/index.ts'
import { composedDisplayClient } from '../embed/composed-display/composed-display-client.ts'
import { operationClient } from '../embed/composed-display/operation/operation-client.ts'
import {
  operationNow,
  operationsLogRows,
  pendingProposals,
  type ListedItem,
  type OperationsLogRow,
  type ProposalListEntry,
} from '../embed/composed-display/operation/operation-presenter.ts'

// What the display window itself shows of operation, for the Plant of the
// display it shows: the toolbar's pending proposals (QA-10) and the
// operations log view (plan §4.3). Read through the Run's capabilities as
// the window's own person: controls.list for the words and the components
// each item's detail draws, display.sample for the Plant now and the log and
// proposals on the controls' paths, signals.resolve for their units.

const controlPaths = (items: ReadonlyArray<ListedItem>): ReadonlyArray<VariablePath> =>
  [...new Set(items.flatMap(item => item.offered.flatMap(entry => [entry.control.path, ...(entry.control.state === undefined ? [] : [entry.control.state])])))]

const plantNow = async (runId: SimulationRunId, plantId: string, items: ReadonlyArray<ListedItem>, cited: ReadonlyArray<VariablePath>) => {
  const paths = [...new Set([...controlPaths(items), ...cited])]
  const [units, sample] = await Promise.all([
    operationClient.units(runId, plantId, paths),
    composedDisplayClient.sample(runId, plantId, paths, false, true),
  ])
  return { sample, now: operationNow(sample, units) }
}

/** The Plant's pending proposals as the window's chip lists them; none, and the chip is absent. */
export const readPendingProposals = async (runId: SimulationRunId, plantId: string): Promise<ReadonlyArray<ProposalListEntry>> => {
  const held = await operationClient.proposals(runId, plantId)
  const pending = held.proposals.map(entry => entry.proposal).filter(proposal => proposal.status === 'pending')
  if (pending.length === 0) return []
  const listed = await operationClient.controls(runId, plantId, [...new Set(pending.map(proposal => proposal.item))])
  const { now } = await plantNow(runId, plantId, listed.items, pending.flatMap(proposal => proposal.evidence.map(entry => entry.path)))
  // The window draws no cited reading with its limits, so it ranks none: the oldest first (pendingProposals).
  return pendingProposals(pending, listed.items, () => [], now)
}

/** The operations log view's rows, newest first. */
export const readOperationsLog = async (runId: SimulationRunId, plantId: string): Promise<ReadonlyArray<OperationsLogRow>> => {
  const listed = await operationClient.controls(runId, plantId, null)
  const { sample, now } = await plantNow(runId, plantId, listed.items, [])
  const operations = sample.operations
  if (operations === undefined) throw new Error('display.sample served no operations')
  return operationsLogRows(operations.log, operations.proposals, listed.items, now)
}
