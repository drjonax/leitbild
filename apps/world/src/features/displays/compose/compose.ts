/**
 * One composer for vignettes of any object, element, observable, connection or collection (architecture A2–A5). Names
 * resolve as the caller; no views asks for each subject's World default. Completion only adds (the subjects' alerts at
 * caution or above, the lead with the shortest time to act); the fit caps what one vignette holds and never drops a
 * subject, a named signal, an anchor or a named medium, else it refuses. Numbers come only from reads, into the card.
 */
import type { DisplayCard, DisplayCardAdjustment } from '@leitbild/contracts'
import { priorityLevels, refObjectId } from '../../../core/model/alerts.ts'
import type { ObjectId } from '../../../core/model/index.ts'
import type { DisplaySpec, View } from '../../../core/observation/spec.ts'
import { alertItem, assembleCard, entityItem, slotItems, valueItem } from './card.ts'
import { declarationOf, declaredRefs, same, valueOf, visibleObject } from './declared.ts'
import { defaultViews, elementRefs, leadRefs, recordedOf, type DraftView } from './defaults.ts'
import { FRAME_ROWS, VIGNETTE_MAX_ROWS, vignetteStateSchema, type ComposeIssue, type ResolvedView, type VignetteState } from './model.ts'
import { isIssue, resolveSubject, subjectObjects, type ComposeRun, type Subject } from './resolve.ts'
import { drawingOf, scopeWithin, topologyOf } from './topology.ts'
import { alertsOf, entityRows, groupValues, refsRead, slotsOf, stripsOf } from './view.ts'

export type ComposeOutcome =
  | { readonly ok: true; readonly state: VignetteState; readonly card: DisplayCard; readonly rows: number }
  | { readonly ok: false; readonly issues: ReadonlyArray<ComposeIssue> }

const MAX_STATE = 4_096
const MAX_ADJUSTMENTS = 8
const ENTITY_ROWS = 12
const refuse = (issues: ReadonlyArray<ComposeIssue>): ComposeOutcome => ({ ok: false, issues })
const unfit = (path: string, message: string): ComposeIssue => ({ path, code: 'not_fitted', message })
const notObserved = (path: string, message: string): ComposeIssue => ({ path, code: 'not_observed', message })

/** What a fit must keep: refs named, and topology anchors and media named, by view. */
interface Kept { readonly refs: Set<string>; readonly explicit: Set<number> }

/** Signal names to refs: an observable is itself (and named); an element its observables by rank; a declared object its lead. */
const signalRefs = async (run: ComposeRun, names: ReadonlyArray<string>, path: string, within: ReadonlyArray<ObjectId>, kept: Kept, recorded: boolean): Promise<ReadonlyArray<string> | ComposeIssue> => {
  const refs: string[] = []
  for (const [index, name] of names.entries()) {
    const subject = await resolveSubject(run, name, `${path}.${index}`, within)
    if (isIssue(subject)) return subject
    if (subject.kind === 'observable') { refs.push(subject.ref); kept.refs.add(subject.ref); continue }
    const found = subject.kind === 'element' ? await elementRefs(run, subject.objectId, subject.elementId)
      : subject.kind === 'object' && subject.observed ? await leadRefs(run, subject.objectId) : null
    if (found === null) return notObserved(`${path}.${index}`, `"${name}" names no measured values; name it as a subject for its default`)
    refs.push(...(recorded ? await recordedOf(run, found, 4) : found))
  }
  if (recorded) {
    const declared = await declaredRefs(run, refs)
    const unrecorded = refs.find(ref => kept.refs.has(ref) && declared.get(ref)?.observable.series == null)
    if (unrecorded !== undefined) return notObserved(path, `${unrecorded} is not recorded, so no trend is promised; show it in a values view`)
  }
  return [...new Set(refs)]
}

const nodeFor = async (run: ComposeRun, graph: NonNullable<Awaited<ReturnType<typeof topologyOf>>>, name: string, path: string): Promise<string | ComposeIssue> => {
  const local = name.startsWith(`${graph.objectId}#`) ? name.slice(graph.objectId.length + 1) : name
  const node = graph.nodes.find(entry => entry.id === local || entry.element === local || same(entry.label, local) || (entry.shortLabel !== undefined && same(entry.shortLabel, local)))
  if (node !== undefined) return node.id
  const subject = await resolveSubject(run, name, path, [graph.objectId])
  if (isIssue(subject)) return subject
  const element = subject.kind === 'element' ? subject.elementId : subject.kind === 'observable' ? (await declaredRefs(run, [subject.ref])).get(subject.ref)?.element?.id : undefined
  const found = graph.nodes.find(entry => (entry.element ?? entry.id) === element)
  return found?.id ?? { path, code: 'unknown_name', message: `"${name}" is not drawn in ${graph.objectId}'s topology` }
}

const topologyView = async (run: ComposeRun, view: Extract<View, { kind: 'topology' }>, path: string, subjects: ReadonlyArray<Subject>): Promise<DraftView | ComposeIssue> => {
  for (const subject of subjects) {
    if (subject.kind === 'connection' || subject.kind === 'collection') continue
    const graph = await topologyOf(run, subject.objectId)
    if (graph === null) continue
    const nodes = async (names: ReadonlyArray<string> | undefined, key: string): Promise<ReadonlyArray<string> | undefined | ComposeIssue> => {
      if (names === undefined) return undefined
      const ids: string[] = []
      for (const [index, name] of names.entries()) {
        const id = await nodeFor(run, graph, name, `${path}.${key}.${index}`)
        if (isIssue(id)) return id
        ids.push(id)
      }
      return ids
    }
    const pick = (names: ReadonlyArray<string> | undefined, key: 'media' | 'groups'): ReadonlyArray<string> | undefined | ComposeIssue => {
      if (names === undefined) return undefined
      const pool = key === 'media' ? graph.media.map(entry => ({ id: entry.id, names: [entry.label] })) : graph.groups.map(entry => ({ id: entry.id, names: [entry.label, entry.shortLabel ?? entry.label] }))
      const ids = names.map(name => pool.find(entry => entry.id === name || entry.names.some(label => same(label, name)))?.id)
      const missing = names.find((_, index) => ids[index] === undefined)
      return missing === undefined ? ids as string[] : { path: `${path}.${key}`, code: 'unknown_name', message: `"${missing}" is not one of ${graph.objectId}'s ${key}`,
        didYouMean: [{ pack: run.objects.find(object => object.id === graph.objectId)!.packId, suggestions: pool.slice(0, 3).map(entry => entry.names[0]!) }] }
    }
    const parts = [await nodes(view.from, 'from'), await nodes(view.to, 'to'), await nodes(view.around, 'around'), pick(view.media, 'media'), pick(view.groups, 'groups')]
    const issue = parts.find(isIssue)
    if (issue !== undefined) return issue
    const [from, to, around, media, groups] = (parts as ReadonlyArray<ReadonlyArray<string> | undefined>).map(ids => ids === undefined ? undefined : [...ids])
    const named = from !== undefined || to !== undefined || around !== undefined
    const fallback = named ? undefined : (await defaultViews(run, subject)).find((entry): entry is Extract<DraftView, { kind: 'topology' }> => entry.kind === 'topology')
    if (!named && fallback === undefined) continue
    const request = { ...fallback?.request, ...(named ? { from, to, around } : {}), ...(media === undefined ? {} : { media }), ...(groups === undefined ? {} : { groups }), ...(view.reach === undefined ? {} : { reach: view.reach }) }
    return { kind: 'topology', objectId: graph.objectId, request }
  }
  return notObserved(path, 'none of the subjects declares a topology')
}

const resolveView = async (run: ComposeRun, view: View, path: string, subjects: ReadonlyArray<Subject>, kept: Kept): Promise<DraftView | ComposeIssue> => {
  const within = subjects.flatMap(subjectObjects)
  if (view.kind === 'trend') {
    const refs = await signalRefs(run, view.signals, `${path}.signals`, within, kept, true)
    return isIssue(refs) ? refs : refs.length === 0 ? notObserved(`${path}.signals`, 'none of these is recorded') : { kind: 'trend', refs: [...refs], horizon: view.horizon ?? '10m' }
  }
  if (view.kind === 'values') {
    if (view.of !== undefined) {
      const collection = await resolveSubject(run, { of: view.of }, path)
      return isIssue(collection) ? collection : { kind: 'collection', of: (collection as Extract<Subject, { kind: 'collection' }>).of }
    }
    const names = view.signals ?? subjects.flatMap(subject => subject.kind === 'observable' ? [subject.ref] : subject.kind === 'object' && subject.observed ? [subject.objectId]
      : subject.kind === 'element' ? [`${subject.objectId}#${subject.elementId}`] : [])
    if (names.length === 0) {
      const entity = subjects.find((subject): subject is Extract<Subject, { kind: 'object' }> => subject.kind === 'object' && !subject.observed)
      return entity === undefined ? notObserved(path, 'the subjects declare no values; name signals') : { kind: 'slots', objectId: entity.objectId }
    }
    const refs = await signalRefs(run, names, `${path}.signals`, within, kept, false)
    return isIssue(refs) ? refs : { kind: 'values', refs: [...refs] }
  }
  if (view.kind === 'alerts') {
    if (view.scope === 'run') return { kind: 'alerts', objectIds: 'run' }
    const collection = subjects.find((subject): subject is Extract<Subject, { kind: 'collection' }> => subject.kind === 'collection')
    const members = collection === undefined ? [] : (await defaultViews(run, collection)).flatMap(entry => entry.kind === 'alerts' && entry.objectIds !== 'run' ? entry.objectIds : [])
    const objectIds = [...new Set([...within, ...members])].filter(id => visibleObject(run, id) !== undefined).slice(0, 48)
    return objectIds.length === 0 ? notObserved(path, 'the subjects have no objects to show alerts of') : { kind: 'alerts', objectIds }
  }
  if (view.kind === 'topology') return topologyView(run, view, path, subjects)
  if (view.of !== undefined) {
    const collection = await resolveSubject(run, { of: view.of }, path)
    return isIssue(collection) ? collection : { kind: 'map', of: (collection as Extract<Subject, { kind: 'collection' }>).of, ...(view.within === undefined ? {} : { within: view.within }) }
  }
  if (view.around !== undefined) {
    const around: ObjectId[] = []
    for (const [index, name] of view.around.entries()) {
      const subject = await resolveSubject(run, name, `${path}.around.${index}`, within)
      if (isIssue(subject)) return subject
      if (subject.kind === 'collection') return { path: `${path}.around.${index}`, code: 'unknown_name', message: `"${name}" is a collection; use "of"` }
      around.push(...subjectObjects(subject))
    }
    return view.within === undefined ? { kind: 'map', objectIds: [...new Set(around)] } : { kind: 'map', around: around[0]!, within: view.within }
  }
  const collection = subjects.find((subject): subject is Extract<Subject, { kind: 'collection' }> => subject.kind === 'collection')
  if (collection !== undefined) return { kind: 'map', of: collection.of, ...(view.within === undefined ? {} : { within: view.within }) }
  const placed = within.filter(id => visibleObject(run, id)?.spatial.position !== undefined)
  return placed.length === 0 ? notObserved(path, 'none of the subjects has a position') : { kind: 'map', objectIds: [...new Set(placed)].slice(0, 48), ...(view.within === undefined ? {} : { within: view.within }) }
}

/** Defaults of several subjects as one vignette: views of a kind merge; at most four, values first. */
const mergeDefaults = (lists: ReadonlyArray<ReadonlyArray<DraftView>>): ReadonlyArray<DraftView> => {
  const merged: DraftView[] = []
  for (const view of lists.flat()) {
    const known = merged.find(entry => entry.kind === view.kind)
    if (known?.kind === 'values' && view.kind === 'values') known.refs.splice(0, Infinity, ...new Set([...known.refs, ...view.refs]))
    else if (known?.kind === 'trend' && view.kind === 'trend') known.refs.splice(0, Infinity, ...new Set([...known.refs, ...view.refs]))
    else if (known?.kind === 'alerts' && view.kind === 'alerts' && known.objectIds !== 'run' && view.objectIds !== 'run') {
      merged[merged.indexOf(known)] = { kind: 'alerts', objectIds: [...new Set([...known.objectIds, ...view.objectIds])] }
    } else if (known?.kind === 'map' && view.kind === 'map' && known.objectIds !== undefined && view.objectIds !== undefined) known.objectIds.splice(0, Infinity, ...new Set([...known.objectIds, ...view.objectIds]))
    else if (known === undefined || view.kind === 'slots') merged.push(structuredClone(view) as DraftView)
  }
  const order = ['values', 'trend', 'slots', 'alerts', 'entity', 'collection', 'topology', 'map']
  return merged.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind)).slice(0, 4)
}

const covers = (views: ReadonlyArray<ResolvedView>, subject: Subject): boolean => views.some(view => {
  if (subject.kind === 'collection') return (view.kind === 'collection' || view.kind === 'map') && JSON.stringify(view.of) === JSON.stringify(subject.of)
  if (subject.kind === 'observable' && (view.kind === 'values' || view.kind === 'trend')) return view.refs.includes(subject.ref)
  const objects: ReadonlyArray<string> = view.kind === 'values' || view.kind === 'trend' ? view.refs.map(refObjectId) : view.kind === 'slots' || view.kind === 'topology' ? [view.objectId]
    : view.kind === 'entity' ? view.objectIds : view.kind === 'alerts' && view.objectIds !== 'run' ? view.objectIds : view.kind === 'map' ? view.objectIds ?? [] : []
  return subjectObjects(subject).some(objectId => objects.includes(objectId))
})

const atLeastCaution = (priority: string | undefined): boolean => priority !== undefined && priorityLevels.indexOf(priority as never) >= priorityLevels.indexOf('caution')
const countAdjustment = (adjusted: DisplayCardAdjustment[], adjustment: DisplayCardAdjustment): void => { if (adjusted.length < MAX_ADJUSTMENTS) adjusted.push(adjustment) }

/** Completion, fit, card and state: the shared second half of a composed vignette and a World default. */
const finish = async (run: ComposeRun, title: string, by: 'assistant' | undefined, subjects: ReadonlyArray<Subject>, drafts: ReadonlyArray<DraftView>, kept: Kept): Promise<ComposeOutcome> => {
  const adjusted: DisplayCardAdjustment[] = []
  const views = drafts.map(view => structuredClone(view) as DraftView)
  // Completion: the subjects' alerts at caution or above.
  const subjectIds = [...new Set(subjects.flatMap(subjectObjects))].filter(id => visibleObject(run, id) !== undefined)
  const pressing = subjectIds.flatMap(id => visibleObject(run, id)!.alerts.filter(alert => atLeastCaution(alert.priority)))
  if (pressing.length > 0 && !views.some(view => view.kind === 'alerts')) {
    if (views.length < 4) views.push({ kind: 'alerts', objectIds: subjectIds.filter(id => visibleObject(run, id)!.alerts.length > 0).slice(0, 48) })
    else countAdjustment(adjusted, { kind: 'layout', text: `${pressing.length} alerts at caution or above not shown` })
  }
  // Completion: the lead, the shortest time to act among the subjects' lead values, in the first values or trend view.
  const leads = (await Promise.all(subjects.flatMap(subject => subject.kind === 'object' && subject.observed ? [leadRefs(run, subject.objectId)] : []))).flat()
  const shown = views.flatMap(view => view.kind === 'values' || view.kind === 'trend' ? view.refs : [])
  const acting = leads.length === 0 ? [] : (await run.port.read({ refs: [...new Set([...leads, ...shown])] })).observations.filter(observation => observation.timeToAct !== undefined)
  const lead = [...acting].sort((left, right) => left.timeToAct!.seconds - right.timeToAct!.seconds)[0]
  const first = views.find((view): view is Extract<DraftView, { kind: 'values' | 'trend' }> => view.kind === 'values' || view.kind === 'trend')
  if (lead !== undefined && first !== undefined && !shown.includes(lead.ref)) first.refs.unshift(lead.ref)

  // Fit: each view within its caps, rows allotted; what it cannot keep is named, never silently dropped.
  const issues: ComposeIssue[] = []
  const fitted: ResolvedView[] = []
  const declared = await declaredRefs(run, views.flatMap(view => view.kind === 'values' || view.kind === 'trend' ? view.refs : []))
  const trim = (path: string, refs: ReadonlyArray<string>, cap: number, what: string): ReadonlyArray<string> => {
    const readable = refs.filter(ref => declared.has(ref))
    const hidden = refs.length - readable.length
    if (hidden > 0) countAdjustment(adjusted, { kind: 'access', text: `${hidden} values this caller may not read are not shown` })
    const named = readable.filter(ref => kept.refs.has(ref))
    if (named.length > cap) { issues.push(unfit(path, `${named.length} named ${what} exceed the ${cap} one view shows`)); return [] }
    const keep = [...named, ...readable.filter(ref => !kept.refs.has(ref))].slice(0, cap)
    if (readable.length > keep.length) countAdjustment(adjusted, { kind: 'layout', text: `${readable.length - keep.length} ${what} not shown` })
    return readable.filter(ref => keep.includes(ref))
  }
  for (const [index, view] of views.entries()) {
    const path = `views.${index}`
    if (view.kind === 'values') {
      const refs = trim(path, view.refs, 16, 'values')
      const values = refs.map(ref => declared.get(ref)!)
      if (refs.length > 0) fitted.push({ ...view, refs: [...refs], rows: groupValues(values.map(valueOf))?.rows ?? refs.length })
    } else if (view.kind === 'trend') {
      const recorded = view.refs.filter(ref => declared.get(ref)?.observable.series != null)
      const refs = trim(path, recorded, 12, 'pens')
      const strips = stripsOf(refs.map(ref => valueOf(declared.get(ref)!)))
      const inStrips = strips.slice(0, 4).flat().map(value => value.ref)
      if (refs.some(ref => kept.refs.has(ref) && !inStrips.includes(ref))) issues.push(unfit(path, 'the named pens need more than four strips of four'))
      else if (inStrips.length > 0) {
        if (inStrips.length < refs.length) countAdjustment(adjusted, { kind: 'layout', text: `${refs.length - inStrips.length} pens not shown` })
        fitted.push({ ...view, refs: inStrips, rows: strips.slice(0, 4).reduce((sum, strip) => sum + Math.max(3, strip.length), 0) + 1 })
      }
    } else if (view.kind === 'alerts') {
      fitted.push({ ...view, rows: 1 + Math.min(6, Math.max(1, alertsOf(run, { ...view, rows: 1 }).length)) })
    } else if (view.kind === 'slots') {
      const object = visibleObject(run, view.objectId)
      if (object !== undefined) fitted.push({ ...view, rows: Math.max(1, slotsOf(run, object).length) })
    } else if (view.kind === 'entity' || view.kind === 'collection') {
      const count = entityRows(run, { ...view, rows: VIGNETTE_MAX_ROWS } as Extract<ResolvedView, { kind: 'entity' | 'collection' }>).rows.length
      fitted.push({ ...view, rows: 1 + Math.max(1, Math.min(ENTITY_ROWS, count)) + (count > ENTITY_ROWS ? 1 : 0) } as ResolvedView)
    } else if (view.kind === 'topology') {
      const graph = await topologyOf(run, view.objectId)
      const scoped = graph === null ? null : scopeWithin(graph, view.request)
      const drawing = scoped?.ok === true ? await drawingOf(scoped.scoped) : null
      const room = VIGNETTE_MAX_ROWS - FRAME_ROWS - 1
      // A layout may end on a half grid unit: its rows are the whole units it reaches into.
      const rows = drawing === null ? 0 : Math.ceil(drawing.layout.height) + 1
      if (scoped?.ok !== true || drawing === null || rows > room) {
        const why = scoped === null ? 'no topology' : !scoped.ok ? scoped.reason : drawing === null ? 'no drawing verifies' : `${rows} rows`
        if (kept.explicit.has(index)) issues.push(unfit(path, `the topology cannot be drawn in one vignette (${why})`))
        else countAdjustment(adjusted, { kind: 'layout', text: `topology not shown (${why})` })
        continue
      }
      if (scoped.reach !== undefined) countAdjustment(adjusted, { kind: 'scope', text: `reach narrowed to ${scoped.reach} links to draw at most 60 nodes` })
      fitted.push({ ...view, request: { ...view.request, ...(scoped.reach === undefined ? {} : { reach: scoped.reach }) }, rows })
    } else fitted.push({ ...view, rows: 2 })
  }
  if (issues.length > 0) return refuse(issues)
  // Rows: alerts and tables give way first, then the frame does not fit and compose refuses.
  const total = (): number => FRAME_ROWS + fitted.reduce((sum, view) => sum + view.rows, 0)
  for (const view of fitted) if (total() > VIGNETTE_MAX_ROWS && (view.kind === 'alerts' || view.kind === 'entity' || view.kind === 'collection')) (view as { rows: number }).rows = Math.min(view.rows, view.kind === 'alerts' ? 3 : 5)
  if (total() > VIGNETTE_MAX_ROWS) return refuse([unfit('views', `the views need ${total()} rows; one vignette holds ${VIGNETTE_MAX_ROWS}`)])
  const uncovered = subjects.findIndex(subject => !covers(fitted, subject))
  if (fitted.length === 0 || uncovered >= 0) return refuse([unfit(uncovered >= 0 ? `subjects.${uncovered}` : 'views', 'nothing this vignette can show is about this subject')])

  const at = run.clock === undefined ? { at: new Date().toISOString(), clock: 'wall' as const } : { at: run.clock.currentTime, clock: 'simulation' as const }
  const state = vignetteStateSchema.parse({ title: title.slice(0, 80), ...(by === undefined ? {} : { by }), at, views: fitted })
  if (JSON.stringify(state).length > MAX_STATE) return refuse([unfit('views', `the vignette names more than its ${MAX_STATE}-character state holds`)])
  return { ok: true, state, card: await cardOf(run, state, kept, adjusted), rows: total() }
}

const cardOf = async (run: ComposeRun, state: VignetteState, kept: Kept, adjusted: ReadonlyArray<DisplayCardAdjustment>): Promise<DisplayCard> => {
  const read = await refsRead(run, state)
  const refs = [...new Set([...read.filter(ref => kept.refs.has(ref)), ...read])]
  const [declared, values] = await Promise.all([declaredRefs(run, refs), refs.length === 0 ? null : run.port.read({ refs })])
  const items = [
    ...refs.flatMap(ref => declared.has(ref) ? [valueItem(declared.get(ref)!, values?.observations.find(observation => observation.ref === ref))] : []),
    ...state.views.flatMap(view => view.kind === 'alerts' ? alertsOf(run, view).slice(0, view.rows - 1).map(alertItem) : []),
    ...state.views.flatMap(view => {
      if (view.kind === 'entity' || view.kind === 'collection') return entityRows(run, view).rows.map(entityItem)
      const object = view.kind === 'slots' ? visibleObject(run, view.objectId) : undefined
      if (object === undefined) return []
      const slots = slotsOf(run, object)
      return slotItems(object.id, object.label, slots, Object.fromEntries(slots.map(({ key, value, since }) => [key, { value, ...(since === undefined ? {} : { since }) }])))
    }),
  ]
  return assembleCard(state.at, items, adjusted)
}

export const composeVignette = async (run: ComposeRun, spec: DisplaySpec): Promise<ComposeOutcome> => {
  const subjects: Subject[] = []
  const issues: ComposeIssue[] = []
  for (const [index, name] of spec.subjects.entries()) {
    const subject = await resolveSubject(run, name, `subjects.${index}`)
    if (isIssue(subject)) issues.push(subject)
    else subjects.push(subject)
  }
  if (issues.length > 0) return refuse(issues)
  const kept: Kept = { refs: new Set(subjects.flatMap(subject => subject.kind === 'observable' ? [subject.ref] : [])), explicit: new Set() }
  if (spec.views.length === 0) return finish(run, spec.title, 'assistant', subjects, mergeDefaults(await Promise.all(subjects.map(subject => defaultViews(run, subject)))), kept)
  const views: DraftView[] = []
  for (const [index, view] of spec.views.entries()) {
    const resolved = await resolveView(run, view, `views.${index}`, subjects, kept)
    if (isIssue(resolved)) issues.push(resolved)
    else { if (view.kind === 'topology' && (view.from ?? view.to ?? view.around ?? view.media) !== undefined) kept.explicit.add(views.length); views.push(resolved) }
  }
  return issues.length > 0 ? refuse(issues) : finish(run, spec.title, 'assistant', subjects, views, kept)
}

/** A subject's World default: what a person opens from the map, a procedure tag or the display window. */
export const composeDefault = async (run: ComposeRun, name: string | Extract<DisplaySpec['subjects'][number], { of: unknown }>): Promise<ComposeOutcome> => {
  const subject = await resolveSubject(run, name, 'subject')
  if (isIssue(subject)) return refuse([subject])
  const kept: Kept = { refs: new Set(subject.kind === 'observable' ? [subject.ref] : []), explicit: new Set() }
  return finish(run, await titleOf(run, subject), undefined, [subject], await defaultViews(run, subject), kept)
}

/** A default's title from what is declared or presented: never a word World adds. */
const titleOf = async (run: ComposeRun, subject: Subject): Promise<string> => {
  if (subject.kind === 'collection') return run.packs.find(pack => pack.descriptor.id === subject.of.packId)!.presentation.categories.find(category => category.id === subject.of.categoryId)!.label
  if (subject.kind === 'connection') return [subject.connection.system.objectId, subject.connection.network.objectId].map(id => visibleObject(run, id)?.label ?? id).join(' – ')
  const object = visibleObject(run, subject.objectId)!
  if (subject.kind === 'observable') return (await declaredRefs(run, [subject.ref])).get(subject.ref)?.observable.label ?? object.label
  if (subject.kind === 'element') {
    const element = (await declarationOf(run, subject.objectId))?.elements.find(entry => entry.id === subject.elementId)
    return element === undefined ? object.label : `${object.label} · ${element.label}`
  }
  return object.label
}
