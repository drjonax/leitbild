/**
 * The World default of each subject kind (architecture A3), from what Packs
 * declare and objects carry: at most four views, each only where its data
 * exists. A declared object leads with its Pack's lead values; an
 * entity-floor object with its core slots; an element, observable or
 * connection with what is measured on it; a collection with its table. An
 * object's or an element's lead values are a lead request, read again each
 * sample (H1/H2: a display opened before an upset leads with what its Pack
 * leads with after it).
 */
import { priorityLevels, refObjectId, type AlertState } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { StoppedLead } from '../../../core/observation/capabilities.ts'
import type { Observable, Observation, Quantity } from '../../../core/observation/model.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import { declarationOf, declaredRefs, visibleObject } from './declared.ts'
import { overviewOf } from './topology.ts'
import type { LeadRequest, ResolvedView } from './model.ts'
import { presentedOf } from './present.ts'
import type { ComposeRun, Subject } from './resolve.ts'

/** A view before fit allots its rows; a values view holding a lead request may say the most it reserves. */
type Distributive<T> = T extends unknown ? T extends { readonly kind: 'values' } ? Omit<T, 'rows'> & { readonly rows?: number } : Omit<T, 'rows'> : never
export type DraftView = Distributive<ResolvedView>

/** The most rows a lead request reserves: what a column holds of an object's or an element's lead values. */
export const LEAD_ROWS = 8

/** The most values one lead read gives: what a lead request may lead with, its own states aside. */
const PACK_LEAD = 16

/** A read's answer as lead requests take it: each value by ref, and what each object's lead read leads with. */
export interface LeadReading {
  readonly value: (ref: string) => Observation | undefined
  readonly led: (objectId: ObjectId) => ReadonlyArray<string>
}
/** What a lead request leads with now, ranked, and every value it may lead with (`pool`, what its rows are reserved for). */
export interface Led { readonly refs: ReadonlyArray<string>; readonly pool: ReadonlyArray<string> }
/**
 * A lead request planned from what its Pack declares: the refs it reads (an element's values it may lead with in its
 * rows, and its stop's commands), the object whose lead it reads, and what it leads with once that read answers (`now`).
 */
export interface LeadPlan {
  readonly refs: ReadonlyArray<string>
  readonly lead?: ObjectId
  readonly now: (reading: LeadReading) => Promise<Led>
}

/**
 * These refs and every plan's in one read, each object asked once with its lead (R1 perf: one Pack read a sample), and
 * what each plan leads with now from that one answer.
 */
export const readLeads = async (run: ComposeRun, plans: ReadonlyArray<LeadPlan>, refs: ReadonlyArray<string> = []): Promise<{ readonly observations: ReadonlyArray<Observation>; readonly led: ReadonlyArray<Led> }> => {
  const objects = [...new Set(plans.flatMap(plan => plan.lead ?? []))]
  const asked = [...new Set([...refs, ...plans.flatMap(plan => plan.refs)])].filter(ref => visibleObject(run, refObjectId(ref)) !== undefined)
  const read = await run.port.read({ refs: asked, leads: objects.map(objectId => ({ objectId, count: PACK_LEAD })) })
  const values = new Map(read.observations.map(observation => [observation.ref, observation] as const))
  const reading: LeadReading = { value: ref => values.get(ref), led: objectId => read.leads[objects.indexOf(objectId)] ?? [] }
  return { observations: read.observations, led: await Promise.all(plans.map(plan => plan.now(reading))) }
}

/** A lead read's values the caller may read (declared), in its Pack's order. */
const declaredOf = async (run: ComposeRun, refs: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const declared = await declaredRefs(run, refs)
  return refs.filter(ref => declared.has(ref))
}

/** An object's lead values now: its Pack's mode-aware lead read, in its order, as many as it gives (at most 16). */
export const leadRefs = async (run: ComposeRun, objectId: ObjectId, count = LEAD_ROWS): Promise<ReadonlyArray<string>> => {
  if (visibleObject(run, objectId) === undefined) return []
  const read = await run.port.read({ leads: [{ objectId, count: PACK_LEAD }] })
  return (await declaredOf(run, read.leads[0] ?? [])).slice(0, count)
}

/**
 * Shown unless named: a demand (what is commanded) is no reading, nor, in an object that declares what its instruments
 * measure, a value only its simulator computes. Where an object declares no instruments (a grid's flows), its computed
 * values are what is known of it.
 */
const readable = (measured: boolean) => (observable: Observable): boolean => observable.basis !== 'command' && !(measured && observable.basis === 'model')

/** Whether an element has been stopped now: every reading of one of its stop's `when` sets reads as declared. */
const stoppedNow = (stopped: StoppedLead, reading: LeadReading): boolean =>
  stopped.when.some(set => set.every(entry => reading.value(entry.ref)?.value === entry.value))

/**
 * An element's values (Q22), each sample: once it has been stopped (D-E), what verifies the stop as its Pack declares
 * (`stopped`: what says an energy source has stopped making energy); then what its detail leads with, as
 * its Pack declares (`lead`, other elements' values among them); then its own instrument readings and states by its
 * Pack's declared rank; then its other own values by that rank. Never a demand or a simulator-only value (readable),
 * which a request names to show. A device only its topology node stands for: what its node binds. All of it is
 * declared, so it is planned before the read: the read brings the values its first `rows` may show, stopped or not,
 * and its stop's commands, which say whether it has been stopped now.
 */
const elementPlan = async (run: ComposeRun, objectId: ObjectId, elementId: string, rows: number): Promise<LeadPlan> => {
  const declaration = await declarationOf(run, objectId, [elementId])
  const element = declaration?.elements.find(entry => entry.id === elementId)
  const own = declaration?.observables.filter(observable => observable.element === elementId).map(observable => observable.ref) ?? []
  const refs = own.length > 0 ? own : (await topologyOf(run, objectId))?.nodes.find(node => node.id === elementId)?.bindings.map(binding => binding.ref) ?? []
  const stop = element?.stopped
  const declared = await declaredRefs(run, [...stop?.lead ?? [], ...element?.lead ?? [], ...refs])
  const measured = (await declarationOf(run, objectId))?.observables.some(observable => observable.basis === 'instrument') === true
  const shown = (ref: string): boolean => declared.has(ref) && readable(measured)(declared.get(ref)!.observable)
  const rank = (ref: string): number => declared.get(ref)!.observable.lead ?? Infinity
  const ranked = refs.filter(shown).map((ref, order) => ({ ref, order })).sort((left, right) => rank(left.ref) - rank(right.ref) || left.order - right.order).map(entry => entry.ref)
  const reading = (ref: string): boolean => declared.get(ref)!.observable.basis === 'instrument' || declared.get(ref)!.observable.quantity === 'state'
  const stopping = (stop?.lead ?? []).filter(shown)
  const rest = [...new Set([...(element?.lead ?? []).filter(shown), ...ranked.filter(reading), ...ranked.filter(ref => !reading(ref))])]
  const pool = [...new Set([...stopping, ...rest])]
  return {
    refs: [...new Set([...pool.slice(0, rows), ...rest.slice(0, rows), ...stop?.when.flat().map(entry => entry.ref) ?? []])],
    now: async values => ({ refs: stop !== undefined && stoppedNow(stop, values) ? pool : rest, pool }),
  }
}

export const elementRefs = async (run: ComposeRun, objectId: ObjectId, elementId: string, count = LEAD_ROWS): Promise<ReadonlyArray<string>> =>
  (await readLeads(run, [await elementPlan(run, objectId, elementId, count)])).led[0]!.refs.slice(0, count)

/**
 * A lead request planned (LeadPlan) for the `rows` it shows. An object: its Pack's lead (leadRefs) but its own states,
 * which a whole-object default shows as chips. An element: its values (elementPlan); where it is part of another
 * element (a valve inside a vessel), its first four, then that element's not already listed (the vessel's pressure and
 * level), then its own others.
 */
export const planLead = async (run: ComposeRun, lead: LeadRequest, rows = LEAD_ROWS): Promise<LeadPlan> => {
  if (visibleObject(run, lead.objectId) === undefined) return { refs: [], now: async () => ({ refs: [], pool: [] }) }
  if (lead.element === undefined) {
    const own = new Set(await ownStates(run, lead.objectId))
    return { refs: [], lead: lead.objectId, now: async reading => {
      const refs = (await declaredOf(run, reading.led(lead.objectId))).filter(ref => !own.has(ref))
      return { refs, pool: refs }
    } }
  }
  const own = await elementPlan(run, lead.objectId, lead.element, rows)
  const parent = (await declarationOf(run, lead.objectId, [lead.element]))?.elements.find(element => element.id === lead.element)?.parent
  const hosted = parent === undefined ? undefined : await elementPlan(run, lead.objectId, parent, rows)
  const hosting = (list: ReadonlyArray<string>, host: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set([...list.slice(0, 4), ...host, ...list.slice(4)])]
  return {
    refs: [...new Set([...own.refs, ...hosted?.refs ?? []])],
    now: async reading => {
      const [mine, host] = await Promise.all([own.now(reading), hosted?.now(reading) ?? { refs: [], pool: [] }])
      return { refs: hosting(mine.refs, host.refs), pool: hosting(mine.pool, host.pool) }
    },
  }
}

/** What a lead request leads with now, ranked, and every value it may lead with: its plan for `rows`, read. */
export const leadNow = async (run: ComposeRun, lead: LeadRequest, rows = LEAD_ROWS): Promise<Led> => (await readLeads(run, [await planLead(run, lead, rows)])).led[0]!

// Each declaration's own states, found once: a declaration is kept by revision, and a lead request asks every sample.
const ownStatesOf = new WeakMap<object, ReadonlyArray<string>>()

/** An object's own states: declared on it, not on an element (an operating mode, safety-function statuses); a whole-object default heads with them. */
export const ownStates = async (run: ComposeRun, objectId: ObjectId): Promise<ReadonlyArray<string>> => {
  const declaration = await declarationOf(run, objectId)
  if (declaration === null) return []
  const known = ownStatesOf.get(declaration) ?? declaration.observables.filter(observable => observable.quantity === 'state' && observable.element === undefined).map(observable => observable.ref).slice(0, 8)
  ownStatesOf.set(declaration, known)
  return known
}

export const recordedOf = async (run: ComposeRun, refs: ReadonlyArray<string>, count: number): Promise<ReadonlyArray<string>> => {
  const declared = await declaredRefs(run, refs)
  return refs.filter(ref => declared.get(ref)?.observable.series != null).slice(0, count)
}

const rankOf = (alert: AlertState): number => alert.priority === undefined ? -1 : priorityLevels.indexOf(alert.priority)
const worst = (alerts: ReadonlyArray<AlertState>): AlertState | undefined => [...alerts].sort((left, right) => rankOf(right) - rankOf(left))[0]
const alertsView = (objectIds: ReadonlyArray<ObjectId>, filter: { readonly elements?: ReadonlyArray<string>; readonly refs?: ReadonlyArray<string>; readonly lead?: true } = {}): DraftView =>
  ({ kind: 'alerts', objectIds: [...objectIds], ...(filter.elements === undefined ? {} : { elements: [...filter.elements] }), ...(filter.refs === undefined ? {} : { refs: [...filter.refs] }), ...(filter.lead === true ? { lead: true } : {}) })

const nodeOf = (graph: TopologyGraph, elementId: string | undefined): string | undefined =>
  elementId === undefined ? undefined : graph.nodes.find(node => (node.element ?? node.id) === elementId)?.id
const topologyOf = async (run: ComposeRun, objectId: ObjectId): Promise<TopologyGraph | null> => {
  const graph = await run.port.topology(objectId)
  return 'refused' in graph ? null : graph
}
/** Around one item, narrowed in a flow graph to its declared group as today's detail is; compose's fit then draws as far as fits. */
const aroundView = (graph: TopologyGraph, node: string | undefined): DraftView[] => {
  const group = graph.family === 'flow' ? graph.nodes.find(entry => entry.id === node)?.group : undefined
  return node === undefined ? [] : [{ kind: 'topology', objectId: graph.objectId, request: { around: [node], ...(group === undefined ? {} : { groups: [group] }), reach: 1 } }]
}

/** A declared object's topology: a flow graph's overview; else around its worst alarm's element, else its first lead element. */
const objectTopology = async (run: ComposeRun, object: OperationalObject, lead: ReadonlyArray<string>): Promise<DraftView[]> => {
  const graph = await topologyOf(run, object.id)
  if (graph === null) return []
  // A flow object draws its overview (declared, or its whole graph where small).
  if (graph.family === 'flow' && overviewOf(graph) !== null) return [{ kind: 'topology', objectId: object.id, request: { overview: true } }]
  const alarmed = worst(object.alerts.filter(alert => alert.subject !== undefined && 'element' in alert.subject))
  const declared = await declaredRefs(run, lead)
  const element = alarmed?.subject !== undefined && 'element' in alarmed.subject ? alarmed.subject.element : lead.map(ref => declared.get(ref)?.element?.id).find(id => id !== undefined)
  return aroundView(graph, nodeOf(graph, element))
}

const electricQuantities: ReadonlySet<Quantity> = new Set(['electric-power', 'frequency', 'voltage'])

export const defaultViews = async (run: ComposeRun, subject: Subject): Promise<ReadonlyArray<DraftView>> => {
  if (subject.kind === 'object' && subject.observed) {
    const object = visibleObject(run, subject.objectId)!
    // Its lead values as its Pack judges them each sample (a lead request, never refs fixed now); its trend and the
    // element its drawing centres on are chosen from those it leads with as it opens.
    const lead = (await leadNow(run, { objectId: object.id })).refs.slice(0, LEAD_ROWS)
    const trend = await recordedOf(run, lead, 4)
    return [
      { kind: 'values', lead: { objectId: object.id } },
      ...(trend.length > 0 ? [{ kind: 'trend', refs: [...trend], horizon: '10m' } as DraftView] : []),
      // Always its alerts, "none" while it has none: a default opened before an upset shows the upset's alerts as they come.
      alertsView([object.id]),
      ...await objectTopology(run, object, lead),
    ]
  }
  if (subject.kind === 'object') {
    const object = visibleObject(run, subject.objectId)!
    const related = (presentedOf(run, object)?.related ?? []).map(entry => entry.objectId).filter(id => visibleObject(run, id) !== undefined)
    return [
      { kind: 'slots', objectId: object.id },
      // Always its alerts, "none" while it has none, filled each sample (plan §2 rule 3).
      alertsView([object.id]),
      ...(related.length > 0 ? [{ kind: 'entity', objectIds: related } as DraftView] : []),
      ...(object.spatial.position !== undefined ? [{ kind: 'map', objectIds: [object.id] } as DraftView] : []),
    ]
  }
  if (subject.kind === 'element') {
    // Its values as a lead request (leadNow), read each sample: once stopped, it leads with what verifies the stop.
    const lead = { objectId: subject.objectId, element: subject.elementId }
    const graph = await topologyOf(run, subject.objectId)
    const trend = await recordedOf(run, (await leadNow(run, lead)).refs.slice(0, LEAD_ROWS), 4)
    return [
      { kind: 'values', lead },
      ...(trend.length > 0 ? [{ kind: 'trend', refs: [...trend], horizon: '10m' } as DraftView] : []),
      // Its own alerts, then its object's lead alerts, which say why it is where it is (a trip's first-out).
      // Always, "none" while there are none: a pop-over opened at power shows the trip's alerts within one sample.
      alertsView([subject.objectId], { elements: [subject.elementId], lead: true }),
      ...(graph === null ? [] : aroundView(graph, nodeOf(graph, subject.elementId))),
    ]
  }
  if (subject.kind === 'observable') {
    const declared = (await declaredRefs(run, [subject.ref])).get(subject.ref)
    const element = declared?.element?.id
    const recorded = declared?.observable.series != null
    const graph = element === undefined ? null : await topologyOf(run, subject.objectId)
    // Unrecorded, it reads beside three of its element's lead values, as they lead each sample.
    return [
      recorded ? { kind: 'trend', refs: [subject.ref], horizon: '10m' }
        : { kind: 'values', refs: [subject.ref], ...(element === undefined ? {} : { lead: { objectId: subject.objectId, element }, rows: 4 }) },
      alertsView([subject.objectId], { refs: [subject.ref] }),
      ...(graph === null ? [] : aroundView(graph, nodeOf(graph, element))),
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
    const seen = ends.map(end => end.objectId).filter(id => visibleObject(run, id) !== undefined)
    return [
      ...(unique.length > 0 ? [{ kind: 'values', refs: unique } as DraftView] : []),
      // Both ends' alerts, "none" while there are none.
      ...(seen.length > 0 ? [alertsView(seen)] : []),
    ]
  }
  // A Pack-declared group is a set of like units: its default is the fleet, every member worst first under its counts.
  if (subject.of.group !== undefined) return [{ kind: 'fleet', of: subject.of }]
  const members = run.objects.filter(object => !run.denied.has(object.id) && object.packId === subject.of.packId && presentedOf(run, object)?.categoryId === subject.of.categoryId
    && (subject.of.closed || (object.lifecycle !== 'resolved' && object.lifecycle !== 'removed'))).map(object => object.id)
  return [
    { kind: 'collection', of: subject.of },
    // Its members' alerts, "none" while they have none (an object that joins it later is in its table, not here).
    ...(members.length > 0 ? [alertsView(members)] : []),
    { kind: 'map', of: subject.of },
  ]
}

