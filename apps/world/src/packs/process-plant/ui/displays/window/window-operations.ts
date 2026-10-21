import type { SimulationRunId } from '../../../../../core/model/index.ts'
import type { ProcessPlantProposal } from '../../../operations/proposals.ts'
import { operationClient } from '../operation/operation-client.ts'
import {
  operationNow,
  operationsLogRows,
  pendingProposals,
  type ListedItem,
  type OperationsLogRow,
  type ProposalListEntry,
} from '../operation/operation-presenter.ts'

// What the display window reads of operation, for the Plant it shows: the
// Plant's pending proposals for its toolbar's chip, and the operations log
// view (plan §4.3) while it is open. Read through the Run's capabilities as
// the window's own person: control.proposals for the proposals,
// controls.list for the words of what they move, signals.read for the Plant
// now and the commands and resets on the controls' paths.

/** The Plant a window's dialog acts on, fixed when it opens. */
export interface WindowPlant {
  readonly objectId: string
  readonly plantId: string
  readonly label: string
}

const controlPaths = (items: ReadonlyArray<ListedItem>): ReadonlyArray<string> =>
  [...new Set(items.flatMap(item => item.offered.flatMap(entry => [String(entry.control.path), ...(entry.control.state === undefined ? [] : [String(entry.control.state)])])))]

const plantRead = async (runId: SimulationRunId, plantId: string, items: ReadonlyArray<ListedItem>, proposals: ReadonlyArray<ProcessPlantProposal>) => {
  const read = await operationClient.read(runId, plantId, [...new Set([...controlPaths(items), ...proposals.flatMap(proposal => proposal.evidence.map(cited => String(cited.path)))])])
  return { read, now: operationNow(read.sample, read.units) }
}

/** The Plant's pending proposals as the window's chip lists them; none, and the chip is absent. */
export const readPendingProposals = async (runId: SimulationRunId, plantId: string): Promise<ReadonlyArray<ProposalListEntry>> => {
  const pending = (await operationClient.proposals(runId, plantId)).proposals.map(entry => entry.proposal).filter(proposal => proposal.status === 'pending')
  if (pending.length === 0) return []
  const listed = await operationClient.controls(runId, plantId, [...new Set(pending.map(proposal => proposal.item))])
  const { now } = await plantRead(runId, plantId, listed.items, pending)
  return pendingProposals(pending, listed.items, now)
}

/** The operations log view's rows, newest first. */
export const readOperationsLog = async (runId: SimulationRunId, plantId: string): Promise<ReadonlyArray<OperationsLogRow>> => {
  const [listed, held] = await Promise.all([operationClient.controls(runId, plantId, null), operationClient.proposals(runId, plantId)])
  const proposals = held.proposals.map(entry => entry.proposal)
  const { read, now } = await plantRead(runId, plantId, listed.items, proposals)
  return operationsLogRows(read.log, proposals, listed.items, now, read.resets)
}
