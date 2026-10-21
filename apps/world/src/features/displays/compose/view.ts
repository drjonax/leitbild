/**
 * A vignette state drawn and sampled (architecture A5, A6). Both read only what the state names, as the caller: refs it
 * may not read have no declaration, objects it may not inspect are absent, so a forged state shows no more than the
 * caller may see. The view comes from declarations, layouts and presentation words; the sample from observation reads,
 * the alert slot, object state and recorded series.
 */
import { refObjectId } from '../../../core/model/alerts.ts'
import type { OperationalObject } from '../../../core/model/index.ts'
import { routeDistanceMeters } from '../../../core/model/route.ts'
import type { Observation } from '../../../core/observation/model.ts'
import { alertRows, priorityRank, worstFirst, type AlertRow } from '../alerts/rows.ts'
import { declaredRefs, valueOf, visibleObject } from './declared.ts'
import {
  ENTITY_COLUMNS, horizonMs, type Collection, type EntityRow, type ResolvedView, type SeriesPoint, type SlotDeclaration, type VignetteSample,
  type VignetteSection, type VignetteState, type VignetteValue, type VignetteView,
} from './model.ts'
import { presentedOf } from './present.ts'
import type { ComposeRun } from './resolve.ts'
import { bindingRefs, drawingOf, scopeWithin, topologyOf, topologySection } from './topology.ts'

/** A Run's recorded points of one series, Run time ascending, between two instants. */
export type SeriesPort = (seriesId: string, from: string, to: string) => ReadonlyArray<SeriesPoint>
export interface ViewRun extends ComposeRun { readonly series: SeriesPort }

const distanceBands = { '1km': 1_000, '5km': 5_000, '20km': 20_000, '50km': 50_000, '150km': 150_000 } as const
type SlotValue = VignetteSample['slots'][string][string]

/** What a state reads: refs of its values and trends, the objects of its other views (topology adds its binding refs once scoped). */
export const readsOf = (state: VignetteState): { readonly refs: ReadonlyArray<string>; readonly objectIds: ReadonlyArray<string> } => ({
  refs: [...new Set([...state.chips ?? [], ...state.views.flatMap(view => view.kind === 'values' || view.kind === 'trend' ? view.refs : [])])],
  objectIds: [...new Set(state.views.flatMap(view => view.kind === 'slots' || view.kind === 'topology' ? [view.objectId]
    : view.kind === 'entity' ? view.objectIds : view.kind === 'alerts' && view.objectIds !== 'run' ? view.objectIds
      : view.kind === 'map' ? [...view.objectIds ?? [], ...view.around === undefined ? [] : [view.around]] : []))],
})

/** Parallel values (one element class, each element in its own group, one value per quantity): a table, one line per element; else null. */
export const groupValues = (values: ReadonlyArray<VignetteValue>): Extract<VignetteSection, { kind: 'grouped' }> | null => {
  const elements = [...new Map(values.flatMap(value => value.element === undefined ? [] : [[value.element.id, value.element] as const])).values()]
  const columns = [...new Set(values.map(value => `${value.quantity}|${value.unit}`))]
  const cell = (element: string, column: string) => values.filter(value => value.element?.id === element && `${value.quantity}|${value.unit}` === column)
  if (elements.length < 2 || values.some(value => value.element?.group === undefined) || new Set(elements.map(element => element.class)).size !== 1
    || new Set(elements.map(element => element.group)).size !== elements.length || columns.length > 4 || elements.some(element => columns.some(column => cell(element.id, column).length > 1))) return null
  return {
    kind: 'grouped', rows: 1 + elements.length,
    quantities: columns.map(column => ({ label: column.split('|')[0]!.replaceAll('-', ' '), unit: column.split('|')[1]! })),
    lines: elements.map(element => ({ element, values: columns.map(column => cell(element.id, column)[0] ?? null) })),
  }
}

/** Pens by unit, at most four to a strip. */
export const stripsOf = (values: ReadonlyArray<VignetteValue>): ReadonlyArray<ReadonlyArray<VignetteValue>> =>
  [...new Set(values.map(value => value.unit))].flatMap(unit => {
    const pens = values.filter(value => value.unit === unit)
    return Array.from({ length: Math.ceil(pens.length / 4) }, (_, at) => pens.slice(at * 4, at * 4 + 4))
  })

const worstAlert = (object: OperationalObject): AlertRow | undefined => contextOrder({ objects: [object] }, alertRows([object], () => ({ label: object.label, categoryId: '' }))).rows[0]
const positionAge = (run: ComposeRun, object: OperationalObject): number | undefined =>
  object.spatial.position === undefined || run.clock === undefined ? undefined : Math.max(0, (Date.parse(run.clock.currentTime) - Date.parse(object.spatial.position.observedAt)) / 1_000)

/** An entity table's row: presentation words, the worst alert, ETA, distance to `near` and the fix's age. */
export const entityRow = (run: ComposeRun, object: OperationalObject, near?: OperationalObject): EntityRow => {
  const presented = presentedOf(run, object)
  const alert = worstAlert(object)
  const [here, there] = [object.spatial.position?.point, near?.id === object.id ? undefined : near?.spatial.position?.point]
  const ageS = positionAge(run, object)
  return {
    objectId: object.id, label: object.label, ...(object.lifecycle === 'resolved' || object.lifecycle === 'removed' ? { closed: true as const } : {}),
    ...(presented?.status === undefined ? {} : { status: { word: presented.status.label, ...(presented.since === undefined ? {} : { since: presented.since }) } }),
    ...(presented?.urgency === undefined ? {} : { urgency: presented.urgency.word }),
    ...(alert === undefined ? {} : { alert: { priority: alert.priority, severity: alert.alert.severity, message: alert.alert.message } }),
    ...(object.spatial.route?.etaSeconds === undefined ? {} : { etaS: object.spatial.route.etaSeconds }),
    ...(here === undefined || there === undefined ? {} : { distanceM: routeDistanceMeters(there, here) }),
    ...(ageS === undefined ? {} : { ageS }),
  }
}

/** An entity-floor object's core slots and declared telemetry (at most eight signals), each with its value now. */
export const slotsOf = (run: ComposeRun, object: OperationalObject): ReadonlyArray<SlotDeclaration & SlotValue> => {
  const presented = presentedOf(run, object)
  const slot = (key: string, label: string, unit: string, value: SlotValue['value'] | undefined, since?: SlotValue['since']) =>
    value === undefined ? [] : [{ key, label, unit, value, ...(since === undefined ? {} : { since }) }]
  return [
    ...slot('status', 'Status', '', presented?.status?.label, presented?.since),
    ...slot('priority', 'Priority', '', object.operational.priority),
    ...slot('lifecycle', 'Lifecycle', '', object.lifecycle),
    ...slot('eta', 'ETA', 's', object.spatial.route?.etaSeconds),
    ...slot('remaining', 'Remaining distance', 'm', object.spatial.route?.progress?.remainingDistanceM),
    ...slot('speed', 'Speed', 'm/s', object.spatial.position?.speedMps),
    ...slot('communication', 'Communication', '', object.communication?.state),
    ...slot('age', 'Position age', 's', positionAge(run, object)),
    ...Object.values(object.telemetry?.signals ?? {}).slice(0, 8).flatMap(signal => slot(`telemetry:${signal.signalId}`, signal.label.slice(0, 80), signal.unit.slice(0, 16), signal.latest)),
  ]
}

/** A live collection's members, as the caller sees them: by urgency, then worst alert, then Run order. */
export const membersOf = (run: ComposeRun, of: Collection): ReadonlyArray<OperationalObject> => {
  const near = of.near === undefined ? undefined : visibleObject(run, of.near)?.spatial.position?.point
  const words = of.status?.map(word => word.toLowerCase())
  const order = new Map(run.objects.map((object, at) => [object.id, at]))
  const urgency = (object: OperationalObject): number => presentedOf(run, object)?.urgency?.order ?? Infinity
  const byAlert = (left: OperationalObject, right: OperationalObject): number => {
    const [a, b] = [worstAlert(left), worstAlert(right)]
    return a === undefined || b === undefined ? Number(a === undefined) - Number(b === undefined) : worstFirst(a, b)
  }
  return run.objects.filter(object => {
    const presented = run.denied.has(object.id) || object.packId !== of.packId ? null : presentedOf(run, object)
    if (presented?.categoryId !== of.categoryId) return false
    if (!of.closed && (object.lifecycle === 'resolved' || object.lifecycle === 'removed')) return false
    if (words !== undefined && !words.includes((presented.status?.label ?? object.operational.status).toLowerCase())) return false
    return of.within === undefined || (near !== undefined && object.spatial.position !== undefined && routeDistanceMeters(near, object.spatial.position.point) <= distanceBands[of.within])
  }).sort((left, right) => urgency(left) - urgency(right) || byAlert(left, right) || order.get(left.id)! - order.get(right.id)!)
}

const entityObjects = (run: ComposeRun, view: Extract<ResolvedView, { kind: 'entity' | 'collection' }>): ReadonlyArray<OperationalObject> =>
  view.kind === 'collection' ? membersOf(run, view.of) : view.objectIds.flatMap(id => visibleObject(run, id) ?? [])
const nearOf = (run: ComposeRun, view: ResolvedView): OperationalObject | undefined => view.kind === 'collection' && view.of.near !== undefined ? visibleObject(run, view.of.near) : undefined
/** An entity view's rows now: as many as its rows hold, the header and a "+N" line aside. */
export const entityRows = (run: ComposeRun, view: Extract<ResolvedView, { kind: 'entity' | 'collection' }>): { readonly rows: ReadonlyArray<EntityRow>; readonly more: number } => {
  const members = entityObjects(run, view)
  const shown = members.length > view.rows - 1 ? Math.max(0, view.rows - 2) : members.length
  return { rows: members.slice(0, shown).map(object => entityRow(run, object, nearOf(run, view))), more: members.length - shown }
}
/** What a map view frames: these objects, a collection's members, or everything within `within` of `around`. */
export const framedBy = (run: ComposeRun, view: Extract<ResolvedView, { kind: 'map' }>): ReadonlyArray<OperationalObject> => {
  if (view.of !== undefined) return membersOf(run, view.of)
  if (view.objectIds !== undefined) return view.objectIds.flatMap(id => visibleObject(run, id) ?? [])
  const around = view.around === undefined ? undefined : visibleObject(run, view.around)?.spatial.position?.point
  return around === undefined ? [] : run.objects.filter(object => !run.denied.has(object.id) && object.spatial.position !== undefined
    && routeDistanceMeters(around, object.spatial.position.point) <= distanceBands[view.within ?? '5km'])
}

export const compileVignette = async (run: ComposeRun, state: VignetteState): Promise<VignetteView> => {
  const declared = await declaredRefs(run, readsOf(state).refs)
  const values = (refs: ReadonlyArray<string>): ReadonlyArray<VignetteValue> => refs.flatMap(ref => declared.has(ref) ? [valueOf(declared.get(ref)!)] : [])
  const sections: VignetteSection[] = []
  for (const view of state.views) {
    if (view.kind === 'values') sections.push(groupValues(values(view.refs)) ?? { kind: 'values', rows: view.rows, values: values(view.refs) })
    else if (view.kind === 'trend') sections.push({ kind: 'trend', rows: view.rows, horizonMs: horizonMs(view.horizon), strips: stripsOf(values(view.refs).filter(value => value.series !== null)).slice(0, 4) })
    else if (view.kind === 'alerts') {
      const objectIds = view.objectIds === 'run' ? 'run' : view.objectIds.filter(id => visibleObject(run, id) !== undefined)
      if (objectIds.length > 0) sections.push({ kind: 'alerts', rows: view.rows, objectIds, ...(view.elements === undefined ? {} : { elements: view.elements }), ...(view.refs === undefined ? {} : { refs: view.refs }) })
    }
    else if (view.kind === 'slots') {
      const object = visibleObject(run, view.objectId)
      if (object !== undefined) sections.push({ kind: 'slots', rows: view.rows, objectId: object.id, slots: slotsOf(run, object).map(({ key, label, unit }) => ({ key, label, unit })) })
    } else if (view.kind === 'entity' || view.kind === 'collection') {
      const { rows } = entityRows(run, view)
      const near = nearOf(run, view)
      sections.push({ kind: 'entity', rows: view.rows, columns: ENTITY_COLUMNS.filter(column => rows.some(row => row[({ status: 'status', urgency: 'urgency', alert: 'alert', eta: 'etaS', distance: 'distanceM', age: 'ageS' } as const)[column]] !== undefined)),
        ...(near === undefined ? {} : { near: { label: near.label } }) })
    } else if (view.kind === 'topology') {
      const graph = await topologyOf(run, view.objectId)
      const scoped = graph === null ? null : scopeWithin(graph, view.request)
      const drawing = scoped?.ok === true ? await drawingOf(scoped.scoped) : null
      if (scoped?.ok === true && drawing !== null) {
        const units = await declaredRefs(run, bindingRefs(scoped.scoped))
        sections.push(topologySection(view.objectId, visibleObject(run, view.objectId)!.packId, scoped.scoped, drawing, view.rows, ref => units.get(ref)?.observable))
      }
    } else sections.push({ kind: 'map', rows: view.rows })
  }
  const chips = values(state.chips ?? [])
  return { title: state.title, ...(state.by === undefined ? {} : { by: state.by }), ...(chips.length === 0 ? {} : { chips }), ...(state.beside === undefined ? {} : { beside: true }), sections }
}

/**
 * Alert rows as the Run context ranks and names them: first each object's worst (its highest priority, the first of
 * those in the Pack's own order, as its context line names it; advisories and acknowledged alarms count), objects by
 * that priority then Run order; then each object's first-out where that is another alert; then every other alert by
 * priority, Run order and the Pack's order. So no object's lead alert sorts behind another's second.
 */
export const contextOrder = (run: Pick<ComposeRun, 'objects'>, rows: ReadonlyArray<AlertRow>): { readonly rows: ReadonlyArray<AlertRow>; readonly leading: number } => {
  const order = new Map(run.objects.map((object, at) => [object.id, at]))
  const own = new Map(rows.map((row, at) => [row, at]))
  const sorted = [...rows].sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority) || order.get(left.objectId)! - order.get(right.objectId)! || own.get(left)! - own.get(right)!)
  const heads = [...new Set(rows.map(row => row.objectId))].map(objectId => sorted.find(row => row.objectId === objectId)!)
    .sort((left, right) => sorted.indexOf(left) - sorted.indexOf(right))
  const firstOuts = heads.flatMap(head => {
    const firstOut = rows.filter(row => row.objectId === head.objectId && row.alert.firstOut !== undefined)
      .sort((left, right) => left.alert.firstOut!.rank - right.alert.firstOut!.rank || own.get(left)! - own.get(right)!)[0]
    return firstOut === undefined || firstOut === head ? [] : [firstOut]
  })
  const lead = new Set([...heads, ...firstOuts])
  return { rows: [...heads, ...firstOuts, ...sorted.filter(row => !lead.has(row))], leading: lead.size }
}

/** The alert rows an alerts view shows, in the context's order: the Run's (every object the caller may see) or these objects'. */
export const alertsOf = (run: ComposeRun, view: Extract<ResolvedView, { kind: 'alerts' }>): ReadonlyArray<AlertRow> => {
  const objects = view.objectIds === 'run' ? run.objects.filter(object => !run.denied.has(object.id)) : view.objectIds.flatMap(id => visibleObject(run, id) ?? [])
  return contextOrder(run, alertRows(objects, object => ({ label: object.label, categoryId: presentedOf(run, object)?.categoryId ?? '' }))
    .filter(row => (view.elements === undefined && view.refs === undefined)
      || (row.alert.subject !== undefined && 'element' in row.alert.subject && view.elements?.includes(row.alert.subject.element) === true)
      || (row.alert.observable !== undefined && view.refs?.includes(row.alert.observable) === true))).rows
}
/** The rows an alerts view needs: a header, then every object's worst and first-out, and at least six alerts where there are. */
export const alertRowsFor = (run: ComposeRun, view: Extract<ResolvedView, { kind: 'alerts' }>): number => {
  const rows = alertsOf(run, view)
  return 1 + Math.max(1, Math.min(rows.length, Math.max(6, contextOrder(run, rows).leading)))
}

/** The refs a state's views read now: its values and trends, and what its drawings bind. */
export const refsRead = async (run: ComposeRun, state: VignetteState): Promise<ReadonlyArray<string>> => {
  const binding: string[] = []
  for (const view of state.views) {
    if (view.kind !== 'topology') continue
    const graph = await topologyOf(run, view.objectId)
    const scoped = graph === null ? null : scopeWithin(graph, view.request)
    if (scoped?.ok === true) binding.push(...bindingRefs(scoped.scoped))
  }
  return [...new Set([...readsOf(state).refs, ...binding])].filter(ref => visibleObject(run, refObjectId(ref)) !== undefined)
}

/** Everything a state's views read now; history (from `fromMs`, Run time) only when asked, on open and after a gap. */
export const sampleVignette = async (run: ViewRun, state: VignetteState, history?: { readonly fromMs: number }): Promise<VignetteSample> => {
  const refs = await refsRead(run, state)
  const observations: ReadonlyArray<Observation> = refs.length === 0 ? [] : (await run.port.read({ refs })).observations
  const alerts = new Map<string, AlertRow>()
  const entities: Record<number, { rows: ReadonlyArray<EntityRow>; more: number }> = {}
  const slots: Record<string, Record<string, SlotValue>> = {}
  const maps: Record<number, VignetteSample['maps'][number]> = {}
  state.views.forEach((view, index) => {
    if (view.kind === 'alerts') for (const row of alertsOf(run, view)) alerts.set(row.key, row)
    const object = view.kind === 'slots' ? visibleObject(run, view.objectId) : undefined
    if (object !== undefined) slots[object.id] = Object.fromEntries(slotsOf(run, object).map(({ key, value, since }) => [key, { value, ...(since === undefined ? {} : { since }) }]))
    if (view.kind === 'entity' || view.kind === 'collection') entities[index] = entityRows(run, view)
    if (view.kind === 'map') {
      const framed = framedBy(run, view)
      const points = framed.flatMap(entry => entry.spatial.position === undefined ? [] : [entry.spatial.position.point])
      const [lons, lats] = [points.map(point => point.coordinates[0]), points.map(point => point.coordinates[1])]
      const around = view.around ?? view.of?.near
      const within = view.within ?? view.of?.within
      maps[index] = {
        positioned: points.length, missing: framed.length - points.length, ...(within === undefined ? {} : { within }),
        ...(around === undefined || visibleObject(run, around) === undefined ? {} : { around: visibleObject(run, around)!.label }),
        bounds: points.length === 0 ? null : [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        extentM: points.length < 2 ? null : Math.max(...points.flatMap(a => points.map(b => routeDistanceMeters(a, b)))),
      }
    }
  })
  const at = run.clock === undefined ? { at: new Date().toISOString(), clock: 'wall' as const, paused: false } : { at: run.clock.currentTime, clock: 'simulation' as const, paused: run.clock.paused }
  const series = history === undefined ? undefined : await (async () => {
    const declared = await declaredRefs(run, state.views.flatMap(view => view.kind === 'trend' ? view.refs : []))
    return Object.fromEntries([...declared.values()].flatMap(entry => entry.observable.series === null ? []
      : [[entry.observable.series.seriesId, run.series(entry.observable.series.seriesId, new Date(history.fromMs).toISOString(), at.at)] as const]))
  })()
  return { at, observations, alerts: contextOrder(run, [...alerts.values()]).rows, entities, slots, maps, ...(series === undefined ? {} : { series }) }
}
