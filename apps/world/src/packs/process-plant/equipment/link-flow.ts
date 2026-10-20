import type { CompiledPlantGraph, VariablePath } from '../graph/index.ts'
import { ratedFlowForLink } from '../graph/index.ts'
import { processLinkFlowFidelityFor, type ProcessLinkFlowFidelity } from '../runtime/links/link-flow-fidelity.ts'

// What a pipe carries, as everything that reads its flow reads it: its flow
// variable, how faithfully the solver gives it, and below what it reads "no
// flow". Operations judge what a command stops or throttles by it; displays
// draw it.

/** Below this fraction of a link's rated flow it reads "no flow": numerical noise, a coasting pump's tail. */
export const NO_FLOW_FRACTION = 0.0025

export interface LinkFlowBinding {
  readonly flowPath: VariablePath
  readonly fidelity: ProcessLinkFlowFidelity
  /** Null when nothing upstream is rated: "no flow" cannot be judged. */
  readonly noFlowBelow: number | null
}

export const linkFlowBinding = (graph: CompiledPlantGraph, linkIndex: number): LinkFlowBinding => {
  const link = graph.links[linkIndex]!
  const flow = link.variables.find(variable => String(variable.path).endsWith('.flowKgPerS'))
  if (flow === undefined) throw new Error(`link ${link.id} has no flow variable to draw`)
  const rated = ratedFlowForLink(graph, link)
  return { flowPath: flow.path, fidelity: processLinkFlowFidelityFor(graph, link), noFlowBelow: rated === null ? null : rated * NO_FLOW_FRACTION }
}
