import type { SimulationRunId } from '../../../../../core/model/index.ts'
import type { ProcessPlantProposal, ProposalReview } from '../../../operations/proposals.ts'
import type { OperationClient, PlantRead } from './operation-client.ts'
import type { ListedItem, ListedReset } from './operation-presenter.ts'

// What an element's pop-over shows of operation (ElementActions reads it
// every second): the item of equipment the element is, the RESETs of the
// actuations holding it, its proposals with World's review of each, and the
// Plant on the paths its controls write and its proposals cite. Read through
// the operation client, so the operation flow test reads it as the pop-over
// does.

export interface ElementOperation {
  readonly item: ListedItem
  readonly resets: ReadonlyArray<ListedReset>
  readonly proposals: ReadonlyArray<ProcessPlantProposal>
  readonly reviews: ReadonlyMap<string, ProposalReview>
  readonly read: PlantRead | null
}

/** The items the Plant operates, by id: an element that is none has no actions. */
export const operatedItems = async (client: OperationClient, runId: SimulationRunId, objectId: string): Promise<ReadonlySet<string>> =>
  new Set((await client.controls(runId, objectId, null)).items.map(entry => entry.id))

// What its controls write and read, what it withholds, what holds it and what its proposals cite: the read names its time.
const pathsOf = (entry: ListedItem, holding: ReadonlyArray<ListedReset>, cited: ReadonlyArray<ProcessPlantProposal>): ReadonlyArray<string> => [...new Set([
  ...entry.offered.flatMap(control => [String(control.control.path), ...(control.control.state === undefined ? [] : [String(control.control.state)])]),
  ...entry.withheld.map(control => String(control.path)),
  ...holding.flatMap(reset => reset.holds.map(String)),
  ...cited.flatMap(proposal => proposal.evidence.map(evidence => String(evidence.path))),
])]

/** One read of an operated element: controls.list for it, the Plant's proposals, and signals.read with its operations (and observations where it has proposals). */
export const readElementOperation = async (client: OperationClient, runId: SimulationRunId, objectId: string, elementId: string): Promise<ElementOperation> => {
  const [listed, held] = await Promise.all([client.controls(runId, objectId, [elementId]), client.proposals(runId, objectId)])
  const item = listed.items[0]!
  const resets = listed.resets.filter(reset => reset.items.includes(elementId))
  const proposals = held.proposals.map(entry => entry.proposal).filter(proposal => proposal.item === elementId)
  const paths = pathsOf(item, resets, proposals)
  return {
    item,
    resets,
    proposals,
    reviews: new Map(held.proposals.flatMap(entry => entry.review === undefined ? [] : [[entry.proposal.id, entry.review] as const])),
    read: paths.length === 0 ? null : await client.read(runId, objectId, paths, proposals.length > 0),
  }
}
