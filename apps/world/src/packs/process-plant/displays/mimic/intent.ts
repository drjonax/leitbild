import type { ObjectId } from '../../../../core/model/index.ts'
import { SUGGESTION_COUNT } from '../../../../core/model/text-search.ts'
import { scopeTopology, mediaAt, type ScopedTopology, type ScopeRefusal } from '../../../../features/displays/topology/scope.ts'
import { plantCarriers, plantLoops } from '../../equipment/circuits.ts'
import { resolveName, serviceResembles, unconnectedReason } from '../../equipment/names.ts'
import { plantTopology } from '../../observation/topology.ts'
import type { CompiledProcessPlant } from '../../plant-compiler.ts'
import type { MimicIntent } from './mimic-model.ts'

// The old path's intent as a request to World's topology scope (the P1
// bridge): the Plant resolves its names and words every refusal as it always
// has; the scope itself is World's (features/displays/topology/scope.ts).

export interface MimicIssue {
  readonly field: string
  readonly message: string
  readonly didYouMean?: ReadonlyArray<string>
}

/** How each name resolved, for the compose result: the node it named and by what. */
export type ResolvedName = { readonly name: string; readonly node: string; readonly via: 'id' | 'tag' | 'label' | 'group' }

export type ResolvedIntent =
  | { readonly ok: true; readonly scoped: ScopedTopology; readonly names: ReadonlyArray<ResolvedName> }
  | { readonly ok: false; readonly issues: ReadonlyArray<MimicIssue> }

/** An intent on a Plant (its id, graph and model digest name its topology) as World's scope, or the refusal in the Plant's words. */
export const resolveMimicIntent = (plant: Pick<CompiledProcessPlant, 'id' | 'graph' | 'modelDigest'>, intent: MimicIntent): ResolvedIntent => {
  const graph = plant.graph
  const topology = plantTopology(plant.id as ObjectId, graph, plant.modelDigest)
  const issues: MimicIssue[] = []
  const names: ResolvedName[] = []
  /** What the drawing is about: each end or item named, with the nodes it names. */
  const anchors: Array<{ readonly name: string; readonly nodes: ReadonlyArray<string> }> = []
  const known = plantCarriers(graph)
  const resolveAll = (field: 'from' | 'to' | 'around' | 'exclude', list: ReadonlyArray<string> | undefined): ReadonlyArray<string> => (list ?? []).flatMap((name, index) => {
    const resolved = resolveName(graph, name, field)
    if ('error' in resolved) {
      issues.push({ field: `${field}.${index}`, message: resolved.error, ...(resolved.didYouMean.length === 0 ? {} : { didYouMean: resolved.didYouMean }) })
      return []
    }
    const unconnected = field === 'exclude' ? [] : resolved.components.flatMap(component => unconnectedReason(graph, component, known) ?? [])
    if (unconnected.length > 0) {
      issues.push({ field: `${field}.${index}`, message: unconnected.join('; ') })
      return []
    }
    const nodes = resolved.components.map(component => String(graph.components[component]!.id))
    for (const node of nodes) names.push({ name, node, via: resolved.via })
    if (field !== 'exclude') anchors.push({ name, nodes })
    return nodes
  })
  const from = resolveAll('from', intent.from)
  const to = resolveAll('to', intent.to)
  const around = resolveAll('around', intent.around)
  const exclude = resolveAll('exclude', intent.exclude)
  if (around.length > 0 && (from.length > 0 || to.length > 0)) {
    issues.push({ field: 'around', message: 'around draws what feeds items and where their outflow goes; give it without from or to' })
  }
  if (intent.reach !== undefined && from.length > 0 && to.length > 0) {
    issues.push({ field: 'reach', message: 'a route draws every link between its ends; reach applies to one end (from or to alone) or around' })
  }
  for (const [index, service] of (intent.services ?? []).entries()) {
    if (known.includes(service)) continue
    const close = known.filter(candidate => serviceResembles(service, candidate))
    issues.push({ field: `services.${index}`, message: `${graph.specId} has no service ${service}; its services are ${known.join(', ')}`, ...(close.length === 0 ? {} : { didYouMean: close.slice(0, SUGGESTION_COUNT) }) })
  }
  const loops = plantLoops(graph)
  const unknownLoops = (intent.loops ?? []).filter(loop => !loops.includes(loop))
  if (unknownLoops.length > 0) issues.push({ field: 'loops', message: `loops ${unknownLoops.join(', ')} do not exist; this Plant has loops ${loops.join(', ')}` })
  if (from.length === 0 && to.length === 0 && around.length === 0 && intent.services === undefined && issues.length === 0) {
    issues.push({ field: '(mimic)', message: 'say what to draw: from and/or to (equipment), around (equipment), or services (with loops)' })
  }
  for (const anchor of [...from, ...to, ...around]) {
    if (exclude.includes(anchor)) issues.push({ field: 'exclude', message: `${anchor} is an end of the drawing and cannot be excluded` })
  }
  if (issues.length > 0) return { ok: false, issues }

  const scope = scopeTopology(topology, {
    from, to, around, exclude, anchors: anchors.map(anchor => anchor.nodes),
    ...(intent.services === undefined ? {} : { media: intent.services }),
    ...(intent.loops === undefined ? {} : { groups: intent.loops }),
    ...(intent.reach === undefined ? {} : { reach: intent.reach }),
  })
  if (scope.ok) return { ok: true, scoped: scope.scoped, names }
  return { ok: false, issues: refusalIssues(scope.refusal, { from, to, around, loops: intent.loops ?? [], anchors, delivered: node => mediaAt(topology, node, 'out'), received: node => mediaAt(topology, node, 'in') }) }
}

/** A refusal in the words the old path has always given (mimic-scope and mimic-agent-path hold them). */
const refusalIssues = (
  refusal: ScopeRefusal,
  context: {
    readonly from: ReadonlyArray<string>; readonly to: ReadonlyArray<string>; readonly around: ReadonlyArray<string>; readonly loops: ReadonlyArray<string>
    readonly anchors: ReadonlyArray<{ readonly name: string; readonly nodes: ReadonlyArray<string> }>
    readonly delivered: (node: string) => ReadonlyArray<string>
    readonly received: (node: string) => ReadonlyArray<string>
  },
): ReadonlyArray<MimicIssue> => {
  const { from, to, around, loops } = context
  const ends = (list: ReadonlyArray<string>) => list.join(', ')
  const listed = (media: Iterable<string>) => [...new Set(media)].sort().join(', ') || 'nothing'
  const delivered = (list: ReadonlyArray<string>) => list.flatMap(context.delivered)
  const received = (list: ReadonlyArray<string>) => list.flatMap(context.received)
  const sides = `${ends(from)} delivers ${listed(delivered(from))} and ${ends(to)} receives ${listed(received(to))}`
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)
  switch (refusal.code) {
    case 'media-ambiguous':
      return [{ field: 'services', message: `${ends(refusal.nodes)} ${refusal.side === 'from' ? 'delivers' : 'receives'} ${refusal.media.join(', ')}; add services to say which` }]
    case 'no-shared-media': return [{ field: '(mimic)', message: `${sides}: no service connects them` }]
    case 'reversed': return [{ field: '(mimic)', message: `${ends(to)} feeds ${ends(from)}, not the other way: swap from and to` }]
    case 'no-route': return [{ field: '(mimic)', message: `no ${refusal.media.join(' or ')} route from ${ends(from)} to ${ends(to)} in the Plant model; ${sides}` }]
    case 'unreached': {
      const all = [...from, ...to, ...around]
      return [{ field: '(mimic)', message: `nothing ${refusal.media.join(' or ')} connects to ${ends(all)} in the Plant model; ${all.map(node => `${node} carries ${listed([...delivered([node]), ...received([node])])}`).join('; ')}` }]
    }
    case 'groups-empty': {
      const service = [...refusal.media].sort().join(' and ')
      const subject = from.length > 0 && to.length > 0 ? `the ${service} route from ${ends(from)} to ${ends(to)}`
        : from.length > 0 ? `the ${service} downstream of ${ends(from)}` : to.length > 0 ? `the ${service} upstream of ${ends(to)}` : service
      const reached = refusal.reached
      return [{
        field: 'loops',
        message: `${subject} has no equipment in ${plural(loops.length, 'loop', 'loops')} ${loops.join(', ')} and no route into or out of ${plural(loops.length, 'it', 'them')}; ${reached.length > 0
          ? `it reaches ${plural(reached.length, 'loop', 'loops')} ${reached.join(', ')}: name ${plural(reached.length, 'that loop', 'those')}, or drop "loops"`
          : 'it draws only shared equipment, so drop "loops"'}`,
      }]
    }
    case 'groups-drop-anchors':
      return refusal.lost.map(({ anchor: index, groups: at }) => {
        const anchor = context.anchors[index]!
        const what = anchor.nodes.length === 1 ? ends(anchor.nodes) : `every one of "${anchor.name}" (${ends(anchor.nodes)})`
        return {
          field: 'loops',
          message: `${loops.length === 1 ? `loop ${loops[0]} leaves` : `loops ${loops.join(', ')} leave`} out ${what}, which the drawing is about; ${at.length > 0
            ? `${plural(anchor.nodes.length, 'it lies', 'they lie')} on ${plural(at.length, 'loop', 'loops')} ${at.join(', ')}: name ${plural(at.length, 'that loop', 'one of those')} too, or drop "loops"`
            : 'drop "loops"'}`,
        }
      })
  }
}
