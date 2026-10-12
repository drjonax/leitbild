import type { SimulationRunId } from '../../core/model/index.ts'
import type { VariablePath } from '../../packs/process-plant/graph/index.ts'
import { composedDisplayClient } from '../embed/composed-display/composed-display-client.ts'
import { operationClient } from '../embed/composed-display/operation/operation-client.ts'
import {
  operationNow,
  operationsLogRows,
  type ListedItem,
  type OperationsLogRow,
} from '../embed/composed-display/operation/operation-presenter.ts'

// What the display window itself reads of operation, for the Plant of the
// display it shows: the operations log view (plan §4.3), read while it is
// open. The toolbar's pending proposals come from the display itself
// (OperatedMimic), so the window installs no poller. Read through the Run's capabilities as
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

/** The operations log view's rows, newest first. */
export const readOperationsLog = async (runId: SimulationRunId, plantId: string): Promise<ReadonlyArray<OperationsLogRow>> => {
  const listed = await operationClient.controls(runId, plantId, null)
  const { sample, now } = await plantNow(runId, plantId, listed.items, [])
  const operations = sample.operations
  if (operations === undefined) throw new Error('display.sample served no operations')
  return operationsLogRows(operations.log, operations.proposals, listed.items, now)
}
