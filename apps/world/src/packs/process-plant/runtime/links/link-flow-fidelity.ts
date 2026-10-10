import { primaryLoopPumpForLink } from '../../graph/index.ts'
import type { CompiledPlantGraph, CompiledProcessLink } from '../../graph/index.ts'
import { processPlantServices } from '../service-profiles.ts'

/**
 * How far a link's solved flow can be trusted, read from where the runtime
 * takes it (`processLinkFlowSourceFor`; keep the two in step):
 * - `solved`: the flow follows from the equipment that drives it, sign included;
 * - `magnitudeOnly`: the size is solved but not the direction (a primary loop
 *   carries its pump's loop flow, which never reverses: an idle loop driven
 *   backwards by the others still reads forward; the surge line carries the
 *   size of a surge that runs either way);
 * - `unverified`: the number is a modelling placeholder, not this link's flow
 *   (a share of a hub's outflow, or a passive flow with nothing feeding it).
 */
export type ProcessLinkFlowFidelity = 'solved' | 'magnitudeOnly' | 'unverified'

const drivenSources: ReadonlyArray<(source: { readonly kind: string }, link: CompiledProcessLink) => boolean> = [
  source => source.kind === 'centrifugalPump',
  source => source.kind === 'processTank',
  (source, link) => source.kind === 'condenserSink' && (link.service === processPlantServices.condensate || link.service === 'coolingWater'),
  (source, link) => source.kind === 'pressurizer' && link.service === 'primaryRelief',
  (source, link) => source.kind === 'reactorVessel' && (link.service === 'primaryRelease' || link.service === 'letdown'),
  (source, link) => source.kind === 'steamGenerator' && link.service === processPlantServices.mainSteam,
  source => source.kind === 'turbineLoadSink',
  (source, link) => source.kind === 'containmentVolume' && (String(link.fromPortName) === 'sumpOut' || String(link.fromPortName) === 'ventOut'),
  (source, link) => source.kind === 'accumulator' && String(link.fromPortName) === 'outlet',
]

export const processLinkFlowFidelityFor = (graph: CompiledPlantGraph, link: CompiledProcessLink): ProcessLinkFlowFidelity => {
  if (link.kind !== 'fluidFlow') throw new Error(`link ${link.id} is not a fluid link and has no flow`)
  if (primaryLoopPumpForLink(graph, link) !== null) return 'magnitudeOnly'
  // The surge line carries the size of the loops' surge, which runs either way.
  if (graph.components[link.toComponentIndex]?.kind === 'pressurizer' && link.service === 'primaryCoolant') return 'magnitudeOnly'
  const source = graph.components[link.fromComponentIndex]
  if (source === undefined) throw new Error(`link ${link.id} references a missing source component`)
  if (drivenSources.some(driven => driven(source, link))) return 'solved'
  // Otherwise the runtime passes on what flows into the source, split over its outlets.
  const sameService = (index: number): boolean => {
    const other = graph.links[index]
    return other !== undefined && other.kind === 'fluidFlow' && other.service === link.service
  }
  const fed = (graph.incomingLinksByComponent[source.index] ?? []).some(sameService)
  if (!fed) return 'unverified'
  // A hub whose other outlets carry pump-driven loop flow does not split by demand; the share is not this link's flow.
  const siblingLoopDriven = (graph.outgoingLinksByComponent[source.index] ?? [])
    .some(index => index !== link.index && sameService(index) && primaryLoopPumpForLink(graph, graph.links[index]!) !== null)
  return siblingLoopDriven ? 'unverified' : 'solved'
}
