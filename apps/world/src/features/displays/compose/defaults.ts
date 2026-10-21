/**
 * The World default of each subject kind (architecture A3), from what Packs
 * declare and objects carry: at most four views, each only where its data
 * exists. A declared object leads with its Pack's lead values; an
 * entity-floor object with its core slots; an element, observable or
 * connection with what is measured on it; a collection with its table.
 */
import { priorityLevels, type AlertState } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { Quantity } from '../../../core/observation/model.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { declarationOf, declaredRefs, visibleObject } from './declared.ts'
import { overviewOf } from './topology.ts'
import type { ResolvedView } from './model.ts'
import { presentedOf } from './present.ts'
import type { ComposeRun, Subject } from './resolve.ts'

type Distributive<T> = T extends unknown ? Omit<T, 'rows'> : never
/** A view before fit allots its rows. */
export type DraftView = Distributive<ResolvedView>

const byRank = async (run: ComposeRun, refs: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  if (refs.length === 0) return []
  const [read, declared] = await Promise.all([run.port.read({ refs }), declaredRefs(run, refs)])
  const rank = new Map(read.observations.map(observation => [observation.ref, observation.rank]))
  const key = (ref: string): number => rank.get(ref) ?? declared.get(ref)?.observable.lead ?? Infinity
  return refs.filter(ref => declared.has(ref)).map((ref, order) => ({ ref, order })).sort((left, right) => key(left.ref) - key(right.ref) || left.order - right.order).map(entry => entry.ref)
}

/** An object's lead values now: its Pack's mode-aware rank first, then the declared lead rank. */
export const leadRefs = async (run: ComposeRun, objectId: ObjectId, count = 8): Promise<ReadonlyArray<string>> => {
  if (visibleObject(run, objectId) === undefined) return []
  const read = await run.port.read({ lead: { objectId, count: 16 } })
  return (await byRank(run, read.observations.map(observation => observation.ref))).slice(0, count)
}

/** The observables declared on an element, by rank. */
export const elementRefs = async (run: ComposeRun, objectId: ObjectId, elementId: string, count = 8): Promise<ReadonlyArray<string>> => {
  const declaration = await declarationOf(run, objectId, [elementId])
  return (await byRank(run, declaration?.observables.filter(observable => observable.element === elementId).map(observable => observable.ref) ?? [])).slice(0, count)
}

/** An object's own states: declared on it, not on an element (an operating mode, safety-function statuses); a whole-object default heads with them. */
export const ownStates = async (run: ComposeRun, objectId: ObjectId): Promise<ReadonlyArray<string>> =>
  (await declarationOf(run, objectId))?.observables.filter(observable => observable.quantity === 'state' && observable.element === undefined).map(observable => observable.ref).slice(0, 8) ?? []

export const recordedOf = async (run: ComposeRun, refs: ReadonlyArray<string>, count: number): Promise<ReadonlyArray<string>> => {
  const declared = await declaredRefs(run, refs)
  return refs.filter(ref => declared.get(ref)?.observable.series != null).slice(0, count)
}

const rankOf = (alert: AlertState): number => alert.priority === undefined ? -1 : priorityLevels.indexOf(alert.priority)
const worst = (alerts: ReadonlyArray<AlertState>): AlertState | undefined => [...alerts].sort((left, right) => rankOf(right) - rankOf(left))[0]
const hasAlerts = (run: ComposeRun, objectIds: ReadonlyArray<string>, pass: (alert: AlertState) => boolean = () => true): boolean =>
  objectIds.some(objectId => visibleObject(run, objectId)?.alerts.some(pass) === true)
const alertsView = (objectIds: ReadonlyArray<ObjectId>, filter: { readonly elements?: ReadonlyArray<string>; readonly refs?: ReadonlyArray<string> } = {}): DraftView =>
  ({ kind: 'alerts', objectIds: [...objectIds], ...(filter.elements === undefined ? {} : { elements: [...filter.elements] }), ...(filter.refs === undefined ? {} : { refs: [...filter.refs] }) })

const nodeOf = (graph: TopologyGraph, elementId: string | undefined): string | undefined =>
  elementId === undefined ? undefined : graph.nodes.find(node => (node.element ?? node.id) === elementId)?.id
const topologyOf = async (run: ComposeRun, objectId: ObjectId): Promise<TopologyGraph | null> => {
  const graph = await run.port.topology(objectId)
  return 'refused' in graph ? null : graph
}
const aroundView = (objectId: ObjectId, node: string | undefined): DraftView[] => node === undefined ? [] : [{ kind: 'topology', objectId, request: { around: [node], reach: 1 } }]

/** A declared object's topology: a flow graph's overview; else around its worst alarm's element, else its first lead element. */
const objectTopology = async (run: ComposeRun, object: OperationalObject, lead: ReadonlyArray<string>): Promise<DraftView[]> => {
  const graph = await topologyOf(run, object.id)
  if (graph === null) return []
  // A flow object draws its overview (declared, or its whole graph where small).
  if (graph.family === 'flow' && overviewOf(graph) !== null) return [{ kind: 'topology', objectId: object.id, request: { overview: true } }]
  const alarmed = worst(object.alerts.filter(alert => alert.subject !== undefined && 'element' in alert.subject))
  const declared = await declaredRefs(run, lead)
  const element = alarmed?.subject !== undefined && 'element' in alarmed.subject ? alarmed.subject.element : lead.map(ref => declared.get(ref)?.element?.id).find(id => id !== undefined)
  return aroundView(object.id, nodeOf(graph, element))
}

const electricQuantities: ReadonlySet<Quantity> = new Set(['electric-power', 'frequency', 'voltage'])

export const defaultViews = async (run: ComposeRun, subject: Subject): Promise<ReadonlyArray<DraftView>> => {
  if (subject.kind === 'object' && subject.observed) {
    const object = visibleObject(run, subject.objectId)!
    const own = new Set(await ownStates(run, subject.objectId))
    const lead = (await leadRefs(run, subject.objectId)).filter(ref => !own.has(ref))
    const trend = await recordedOf(run, lead, 4)
    return [
      ...(lead.length > 0 ? [{ kind: 'values', refs: [...lead] } as DraftView] : []),
      ...(trend.length > 0 ? [{ kind: 'trend', refs: [...trend], horizon: '10m' } as DraftView] : []),
      ...(object.alerts.length > 0 ? [alertsView([object.id])] : []),
      ...await objectTopology(run, object, lead),
    ]
  }
  if (subject.kind === 'object') {
    const object = visibleObject(run, subject.objectId)!
    const related = (presentedOf(run, object)?.related ?? []).map(entry => entry.objectId).filter(id => visibleObject(run, id) !== undefined)
    return [
      { kind: 'slots', objectId: object.id },
      ...(object.alerts.length > 0 ? [alertsView([object.id])] : []),
      ...(related.length > 0 ? [{ kind: 'entity', objectIds: related } as DraftView] : []),
      ...(object.spatial.position !== undefined ? [{ kind: 'map', objectIds: [object.id] } as DraftView] : []),
    ]
  }
  if (subject.kind === 'element') {
    const refs = await elementRefs(run, subject.objectId, subject.elementId)
    const trend = await recordedOf(run, refs, 4)
    const graph = await topologyOf(run, subject.objectId)
    return [
      ...(refs.length > 0 ? [{ kind: 'values', refs: [...refs] } as DraftView] : []),
      ...(trend.length > 0 ? [{ kind: 'trend', refs: [...trend], horizon: '10m' } as DraftView] : []),
      ...(hasAlerts(run, [subject.objectId], alert => alert.subject !== undefined && 'element' in alert.subject && alert.subject.element === subject.elementId)
        ? [alertsView([subject.objectId], { elements: [subject.elementId] })] : []),
      ...(graph === null ? [] : aroundView(subject.objectId, nodeOf(graph, subject.elementId))),
    ]
  }
  if (subject.kind === 'observable') {
    const declared = (await declaredRefs(run, [subject.ref])).get(subject.ref)
    const element = declared?.element?.id
    const recorded = declared?.observable.series != null
    const beside = element === undefined || recorded ? [] : (await elementRefs(run, subject.objectId, element)).filter(ref => ref !== subject.ref).slice(0, 3)
    const graph = element === undefined ? null : await topologyOf(run, subject.objectId)
    return [
      recorded ? { kind: 'trend', refs: [subject.ref], horizon: '10m' } : { kind: 'values', refs: [subject.ref, ...beside] },
      ...(hasAlerts(run, [subject.objectId], alert => alert.observable === subject.ref) ? [alertsView([subject.objectId], { refs: [subject.ref] })] : []),
      ...(graph === null ? [] : aroundView(subject.objectId, nodeOf(graph, element))),
    ]
  }
  if (subject.kind === 'connection') {
    const ends = [subject.connection.system, subject.connection.network]
    const refs: string[] = []
    for (const end of ends) {
      const graph = await topologyOf(run, end.objectId)
      const boundary = graph?.boundaries.find(entry => entry.externalPortId === end.portId)
      refs.push(...(graph?.nodes.find(node => node.id === boundary?.node)?.bindings.map(binding => binding.ref) ?? []))
      const lead = await leadRefs(run, end.objectId, 16)
      const declared = await declaredRefs(run, lead)
      refs.push(...lead.filter(ref => electricQuantities.has(declared.get(ref)!.observable.quantity)))
    }
    const unique = [...new Set(refs)]
    return [
      ...(unique.length > 0 ? [{ kind: 'values', refs: unique } as DraftView] : []),
      ...(hasAlerts(run, ends.map(end => end.objectId)) ? [alertsView(ends.map(end => end.objectId).filter(id => visibleObject(run, id) !== undefined))] : []),
    ]
  }
  const members = run.objects.filter(object => !run.denied.has(object.id) && object.packId === subject.of.packId && presentedOf(run, object)?.categoryId === subject.of.categoryId
    && (subject.of.closed || (object.lifecycle !== 'resolved' && object.lifecycle !== 'removed'))).map(object => object.id)
  return [
    { kind: 'collection', of: subject.of },
    ...(hasAlerts(run, members) ? [alertsView(members.filter(id => visibleObject(run, id)!.alerts.length > 0))] : []),
    { kind: 'map', of: subject.of },
  ]
}

