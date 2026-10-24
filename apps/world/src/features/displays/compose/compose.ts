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
import { defaultViews, elementRefs, LEAD_ROWS, leadNow, leadRefs, ownStates, recordedOf, type DraftView } from './defaults.ts'
import { FRAME_ROWS, VIGNETTE_MAX_ROWS, vignetteStateSchema, type Collection, type ComposeIssue, type ResolvedView, type VignetteState } from './model.ts'
import { isIssue, resolveSubject, subjectObjects, type ComposeRun, type Subject } from './resolve.ts'
import { TOPOLOGY_REACH } from '../topology/scope.ts'
import { drawingOf, scopeWithin, topologyOf } from './topology.ts'
import { alertRowsFor, alertsOf, entityRows, groupValues, readNow, readsOf, slotsOf, stripsOf } from './view.ts'
import { fitSet, isSetAlerts, isSetView, resolveFleet, resolveSetSignals, resolveUnitSet, SET_PENS, SET_ROWS, setCardItems, unitsOf, type Frame } from './sets.ts'

export type ComposeOutcome =
  | { readonly ok: true; readonly state: VignetteState; readonly card: DisplayCard; readonly rows: number }
  | { readonly ok: false; readonly issues: ReadonlyArray<ComposeIssue> }

const MAX_STATE = 4_096
const MAX_ADJUSTMENTS = 8
/** The most objects a state names in one view: an explicit list's cap; a collection's members are fitted by rows. */
const MAX_OBJECTS = 48
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

/**
 * The nodes a name stands for in a request: a node by id, element or label; else what it resolves to, a node's element
 * or a value a node binds; else a line (an edge by its element or a value it binds), which a route from starts where
 * it begins, one to ends where it ends, and around takes both ends of.
 */
const nodesFor = async (run: ComposeRun, graph: NonNullable<Awaited<ReturnType<typeof topologyOf>>>, name: string, path: string, role: 'from' | 'to' | 'around'): Promise<ReadonlyArray<string> | ComposeIssue> => {
  const local = name.startsWith(`${graph.objectId}#`) ? name.slice(graph.objectId.length + 1) : name
  const node = graph.nodes.find(entry => entry.id === local || entry.element === local || same(entry.label, local) || (entry.shortLabel !== undefined && same(entry.shortLabel, local)))
  if (node !== undefined) return [node.id]
  const subject = await resolveSubject(run, name, path, [graph.objectId])
  if (isIssue(subject)) return subject
  const ref = subject.kind === 'observable' ? subject.ref : undefined
  const element = subject.kind === 'element' ? subject.elementId : ref !== undefined ? (await declaredRefs(run, [ref])).get(ref)?.element?.id : undefined
  const binds = (bindings: ReadonlyArray<{ readonly ref: string }>): boolean => ref !== undefined && bindings.some(binding => binding.ref === ref)
  const found = graph.nodes.find(entry => (entry.element ?? entry.id) === element) ?? graph.nodes.find(entry => binds(entry.bindings))
  if (found !== undefined) return [found.id]
  const line = graph.edges.find(entry => entry.id === element) ?? graph.edges.find(entry => binds(entry.bindings))
  if (line !== undefined) return role === 'from' ? [line.from.node] : role === 'to' ? [line.to.node] : [line.from.node, line.to.node]
  return { path, code: 'unknown_name', message: `"${name}" is not drawn in ${graph.objectId}'s topology` }
}

const topologyView = async (run: ComposeRun, view: Extract<View, { kind: 'topology' }>, path: string, subjects: ReadonlyArray<Subject>): Promise<DraftView | ComposeIssue> => {
  for (const subject of subjects) {
    if (subject.kind === 'connection' || subject.kind === 'collection') continue
    const graph = await topologyOf(run, subject.objectId)
    if (graph === null) continue
    const nodes = async (names: ReadonlyArray<string> | undefined, key: 'from' | 'to' | 'around'): Promise<ReadonlyArray<string> | undefined | ComposeIssue> => {
      if (names === undefined) return undefined
      const ids: string[] = []
      for (const [index, name] of names.entries()) {
        const found = await nodesFor(run, graph, name, `${path}.${key}.${index}`, key)
        if (isIssue(found)) return found
        ids.push(...found)
      }
      return [...new Set(ids)]
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
  if (view.kind === 'fleet' || view.kind === 'compare' || ((view.kind === 'trend' || view.kind === 'alerts') && view.of !== undefined)) {
    const of = await resolveUnitSet(run, view.of!, path)
    if (isIssue(of)) return of
    if (view.kind === 'fleet') return resolveFleet(run, of, path) ?? { kind: 'fleet', of: of as Collection }
    if (view.kind === 'alerts') return { kind: 'alerts', objectIds: 'set', of: of as Collection }
    if (view.kind === 'trend' && view.signals.length > SET_PENS) return unfit(`${path}.signals`, `a trend of a set holds at most ${SET_PENS} quantities, a strip each`)
    const signals = await resolveSetSignals(run, of, view.signals, path, view.kind === 'trend')
    if (isIssue(signals)) return signals
    return view.kind === 'compare' ? { kind: 'compare', of, signals: [...signals] } : { kind: 'set-trend', of, signals: [...signals], horizon: view.horizon ?? '10m' }
  }
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
    const members = collection === undefined ? [] : (await defaultViews(run, collection)).flatMap(entry => entry.kind === 'alerts' && Array.isArray(entry.objectIds) ? entry.objectIds : [])
    const objectIds = [...new Set([...within, ...members])].filter(id => visibleObject(run, id) !== undefined)
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
  return placed.length === 0 ? notObserved(path, 'none of the subjects has a position') : { kind: 'map', objectIds: [...new Set(placed)], ...(view.within === undefined ? {} : { within: view.within }) }
}

/**
 * A default as an answer shows it: each lead request as the values it leads with now, so the card an answer cites and
 * the rows its vignette draws stay the same values (a window's default reads its requests again each sample).
 */
const answered = async (run: ComposeRun, drafts: ReadonlyArray<DraftView>): Promise<ReadonlyArray<DraftView>> => Promise.all(drafts.map(async view => {
  if (view.kind !== 'values' || view.lead === undefined) return view
  const rows = view.rows ?? LEAD_ROWS
  const refs = [...new Set([...view.refs ?? [], ...(await leadNow(run, view.lead, rows)).refs])].slice(0, rows)
  return { kind: 'values', refs } as DraftView
}))

/** Defaults of several subjects as one vignette: views of a kind merge; at most four, values first. */
const mergeDefaults = (lists: ReadonlyArray<ReadonlyArray<DraftView>>, quiet: (view: DraftView) => boolean): ReadonlyArray<DraftView> => {
  const merged: DraftView[] = []
  for (const view of lists.flat()) {
    const known = merged.find(entry => entry.kind === view.kind)
    if (known?.kind === 'values' && view.kind === 'values') merged[merged.indexOf(known)] = { kind: 'values', refs: [...new Set([...known.refs ?? [], ...view.refs ?? []])] }
    else if (known?.kind === 'trend' && view.kind === 'trend') known.refs.splice(0, Infinity, ...new Set([...known.refs, ...view.refs]))
    else if (known?.kind === 'alerts' && view.kind === 'alerts' && Array.isArray(known.objectIds) && Array.isArray(view.objectIds)) {
      merged[merged.indexOf(known)] = { kind: 'alerts', objectIds: [...new Set([...known.objectIds, ...view.objectIds])] }
    } else if (known?.kind === 'map' && view.kind === 'map' && known.objectIds !== undefined && view.objectIds !== undefined) known.objectIds.splice(0, Infinity, ...new Set([...known.objectIds, ...view.objectIds]))
    else if (known === undefined || view.kind === 'slots') merged.push(structuredClone(view) as DraftView)
  }
  const order = ['values', 'trend', 'slots', 'alerts', 'entity', 'collection', 'topology', 'map']
  const sorted = merged.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind))
  // Every default holds its alerts view (plan §2 rule 3); where they hold more views than four, one with nothing to
  // list gives way first, so an answer on two entities keeps their map.
  const giving = new Set(sorted.filter(quiet).slice(0, Math.max(0, sorted.length - 4)))
  return sorted.filter(view => !giving.has(view)).slice(0, 4)
}

const covers = (run: ComposeRun, views: ReadonlyArray<ResolvedView>, subject: Subject): boolean => views.some(view => {
  // The Run's alerts are every subject's alerts too.
  if (view.kind === 'alerts' && view.objectIds === 'run') return true
  // A set covers itself and each unit in it now.
  if (isSetView(view) || isSetAlerts(view)) {
    return subject.kind === 'collection' ? JSON.stringify(view.of) === JSON.stringify(subject.of) : unitsOf(run, view.of!).some(member => subjectObjects(subject).includes(member.id as ObjectId))
  }
  if (subject.kind === 'collection') return (view.kind === 'collection' || view.kind === 'map') && JSON.stringify(view.of) === JSON.stringify(subject.of)
  if (subject.kind === 'observable' && (view.kind === 'values' || view.kind === 'trend')) return view.refs?.includes(subject.ref) === true
  const objects: ReadonlyArray<string> = view.kind === 'values' ? [...(view.refs ?? []).map(refObjectId), ...view.lead === undefined ? [] : [view.lead.objectId]]
    : view.kind === 'trend' ? view.refs.map(refObjectId) : view.kind === 'slots' || view.kind === 'topology' ? [view.objectId]
    : view.kind === 'entity' ? view.objectIds : view.kind === 'alerts' && Array.isArray(view.objectIds) ? view.objectIds : view.kind === 'map' ? view.objectIds ?? [] : []
  return subjectObjects(subject).some(objectId => objects.includes(objectId))
})

const atLeastCaution = (priority: string | undefined): boolean => priority !== undefined && priorityLevels.indexOf(priority as never) >= priorityLevels.indexOf('caution')
const countAdjustment = (adjusted: DisplayCardAdjustment[], adjustment: DisplayCardAdjustment): void => { if (adjusted.length < MAX_ADJUSTMENTS) adjusted.push(adjustment) }

/** Completion, fit, card and state: the shared second half of a composed vignette and a World default. */
/** The alert lines a World default's own alerts view keeps though none are raised yet, so an upset's first alerts show as they come. */
const WATCHED_ALERT_LINES = 4

const finish = async (run: ComposeRun, title: string, by: 'assistant' | undefined, subjects: ReadonlyArray<Subject>, drafts: ReadonlyArray<DraftView>, kept: Kept, frame: Frame, chipped: ReadonlyArray<string> = []): Promise<ComposeOutcome> => {
  const adjusted: DisplayCardAdjustment[] = []
  /** What the fit leaves out, counted on the card (Q15: never silent). */
  let dropped = 0
  const views = drafts.map(view => structuredClone(view) as DraftView)
  // Completion: the subjects' alerts at caution or above.
  const subjectIds = [...new Set(subjects.flatMap(subjectObjects))].filter(id => visibleObject(run, id) !== undefined)
  const pressing = subjectIds.flatMap(id => visibleObject(run, id)!.alerts.filter(alert => atLeastCaution(alert.priority)))
  if (pressing.length > 0 && !views.some(view => view.kind === 'alerts')) {
    if (views.length < 4) views.push({ kind: 'alerts', objectIds: subjectIds.filter(id => visibleObject(run, id)!.alerts.length > 0) })
    else { dropped += pressing.length; countAdjustment(adjusted, { kind: 'layout', text: `${pressing.length} alerts at caution or above not shown` }) }
  }
  // Completion: the lead, the shortest time to act among the subjects' lead values, in the first values or trend view;
  // a lead request leads as its Pack ranks each sample, so a vignette holding one is not completed.
  const requested = views.some(view => view.kind === 'values' && view.lead !== undefined)
  const leads = requested ? [] : (await Promise.all(subjects.flatMap(subject => subject.kind === 'object' && subject.observed ? [leadRefs(run, subject.objectId)] : []))).flat()
  const shown = views.flatMap(view => view.kind === 'values' || view.kind === 'trend' ? view.refs ?? [] : [])
  const acting = leads.length === 0 ? [] : (await run.port.read({ refs: [...new Set([...leads, ...shown])] })).observations.filter(observation => observation.timeToAct !== undefined)
  const lead = [...acting].sort((left, right) => left.timeToAct!.seconds - right.timeToAct!.seconds)[0]
  const first = views.findIndex(view => view.kind === 'values' || view.kind === 'trend')
  const into = views[first]
  if (lead !== undefined && (into?.kind === 'values' || into?.kind === 'trend') && !shown.includes(lead.ref)) views[first] = { ...into, refs: [lead.ref, ...into.refs ?? []] } as DraftView

  // Fit: each view within its caps, rows allotted; what it cannot keep is named, never silently dropped.
  const issues: ComposeIssue[] = []
  const fitted: ResolvedView[] = []
  /** The fitted views that draw a flow topology. */
  const flows = new Set<ResolvedView>()
  const declared = await declaredRefs(run, views.flatMap(view => view.kind === 'values' || view.kind === 'trend' ? view.refs ?? [] : []))
  const trim = (path: string, refs: ReadonlyArray<string>, cap: number, what: string): ReadonlyArray<string> => {
    const readable = refs.filter(ref => declared.has(ref))
    const hidden = refs.length - readable.length
    if (hidden > 0) countAdjustment(adjusted, { kind: 'access', text: `${hidden} values this caller may not read are not shown` })
    const named = readable.filter(ref => kept.refs.has(ref))
    if (named.length > cap) { issues.push(unfit(path, `${named.length} named ${what} exceed the ${cap} one view shows`)); return [] }
    const keep = [...named, ...readable.filter(ref => !kept.refs.has(ref))].slice(0, cap)
    if (readable.length > keep.length) { dropped += readable.length - keep.length; countAdjustment(adjusted, { kind: 'layout', text: `${readable.length - keep.length} ${what} not shown` }) }
    return readable.filter(ref => keep.includes(ref))
  }
  for (const [index, view] of views.entries()) {
    const path = `views.${index}`
    if (view.kind === 'values' && view.lead !== undefined) {
      // A lead request reserves its rows now for whatever it leads with later: its named values, then as many as it
      // may lead with (stopped or not), at most its own cap or the column's eight.
      const refs = trim(path, view.refs ?? [], 16, 'values')
      const pool = (await leadNow(run, view.lead)).pool.filter(ref => !refs.includes(ref))
      const rows = Math.min(view.rows ?? refs.length + LEAD_ROWS, refs.length + pool.length)
      if (rows > 0) fitted.push({ kind: 'values', ...(refs.length === 0 ? {} : { refs: [...refs] }), lead: view.lead, rows })
    } else if (view.kind === 'values') {
      const refs = trim(path, view.refs ?? [], 16, 'values')
      const values = refs.map(ref => declared.get(ref)!)
      if (refs.length > 0) fitted.push({ kind: 'values', refs: [...refs], rows: groupValues(values.map(valueOf))?.rows ?? refs.length })
    } else if (view.kind === 'trend') {
      const recorded = view.refs.filter(ref => declared.get(ref)?.observable.series != null)
      const refs = trim(path, recorded, 12, 'pens')
      const strips = stripsOf(refs.map(ref => valueOf(declared.get(ref)!)))
      const inStrips = strips.slice(0, 4).flat().map(value => value.ref)
      if (refs.some(ref => kept.refs.has(ref) && !inStrips.includes(ref))) issues.push(unfit(path, 'the named pens need more than four strips of four'))
      else if (inStrips.length > 0) {
        if (inStrips.length < refs.length) { dropped += refs.length - inStrips.length; countAdjustment(adjusted, { kind: 'layout', text: `${refs.length - inStrips.length} pens not shown` }) }
        fitted.push({ ...view, refs: inStrips, rows: strips.slice(0, 4).reduce((sum, strip) => sum + Math.max(3, strip.length), 0) + 1 })
      }
    } else if (view.kind === 'fleet' || view.kind === 'compare' || view.kind === 'set-trend') {
      const rows = fitSet(run, view, frame, path)
      if (isIssue(rows)) issues.push(rows)
      else fitted.push({ ...view, rows } as ResolvedView)
    } else if (view.kind === 'alerts') {
      // A state names at most 48 objects: those whose alerts lead in the context's order stay, the rest are counted.
      let objectIds = view.objectIds
      if (Array.isArray(objectIds) && objectIds.length > MAX_OBJECTS) {
        const leading = [...new Set(alertsOf(run, { ...view, objectIds, rows: 1 }).map(row => row.objectId))]
        const keep = [...leading, ...objectIds.filter(id => !leading.includes(id))].slice(0, MAX_OBJECTS)
        const cut = objectIds.filter(id => !keep.includes(id))
        const lost = alertsOf(run, { ...view, objectIds: cut, rows: 1 }).length
        dropped += lost
        countAdjustment(adjusted, { kind: 'layout', text: `${lost} alerts of ${cut.length} more objects not shown` })
        objectIds = objectIds.filter(id => keep.includes(id))
      }
      const needed = alertRowsFor(run, { ...view, objectIds, rows: 1 })
      // A World default is watched: its alerts keep room for the first of those still to come (an element's, an observable's too).
      fitted.push({ ...view, objectIds, rows: frame === 'window' ? Math.max(1 + WATCHED_ALERT_LINES, needed) : needed })
    } else if (view.kind === 'slots') {
      const object = visibleObject(run, view.objectId)
      if (object !== undefined) fitted.push({ ...view, rows: Math.max(1, slotsOf(run, object).length) })
    } else if (view.kind === 'entity' || view.kind === 'collection') {
      if (view.kind === 'entity' && view.objectIds.length > MAX_OBJECTS) {
        dropped += view.objectIds.length - MAX_OBJECTS
        countAdjustment(adjusted, { kind: 'layout', text: `${view.objectIds.length - MAX_OBJECTS} of ${view.objectIds.length} related objects not listed` })
        view.objectIds.splice(MAX_OBJECTS)
      }
      const count = entityRows(run, { ...view, rows: VIGNETTE_MAX_ROWS } as Extract<ResolvedView, { kind: 'entity' | 'collection' }>).rows.length
      fitted.push({ ...view, rows: 1 + Math.max(1, Math.min(SET_ROWS[frame], count)) + (count > SET_ROWS[frame] ? 1 : 0) } as ResolvedView)
    } else if (view.kind === 'topology') {
      const graph = await topologyOf(run, view.objectId)
      let request = view.request
      let scoped = graph === null ? null : scopeWithin(graph, request)
      let drawing = scoped?.ok === true ? await drawingOf(scoped.scoped) : null
      // A one-ended or around request whose drawing does not verify draws nearer, a link less at a time, as named otherwise.
      if (graph !== null && drawing === null && scoped?.ok === true && request.overview !== true && !(request.from !== undefined && request.to !== undefined)) {
        for (let reach = (scoped.reach ?? request.reach ?? TOPOLOGY_REACH) - 1; reach >= 1; reach -= 1) {
          const asked = { ...request, reach }
          const narrowed = scopeWithin(graph, asked)
          const drawn = narrowed.ok ? await drawingOf(narrowed.scoped) : null
          if (!narrowed.ok || drawn === null) continue
          countAdjustment(adjusted, { kind: 'scope', text: `drawn ${reach} ${reach === 1 ? 'link' : 'links'} out to fit` })
          ;[request, scoped, drawing] = [asked, { ok: true, scoped: narrowed.scoped }, drawn]
          break
        }
      }
      // Around one item, with no medium named: as today's detail does, every service the item carries out to the
      // furthest reach that fits the ceilings (a default tries this first); else one service at a time, in the order
      // of the item's own ports, the others stopped at it, and the card names them.
      const item = request.around?.length === 1 && request.media === undefined ? graph?.nodes.find(node => node.id === request.around![0]) : undefined
      if (graph !== null && item !== undefined && (drawing === null || !kept.explicit.has(index))) {
        const services = [...new Set(item.ports.flatMap(port => port.media))].filter(medium => graph.edges.some(edge => edge.medium === medium && (edge.from.node === item.id || edge.to.node === item.id)))
        const name = (id: string): string => graph.media.find(entry => entry.id === id)?.label ?? id
        const reaches = Array.from({ length: TOPOLOGY_REACH }, (_, step) => TOPOLOGY_REACH - step)
        const ladder = [...reaches.map(reach => ({ media: services, reach })), ...services.flatMap(medium => reaches.map(reach => ({ media: [medium], reach })))]
        for (const step of ladder) {
          const asked = { ...request, media: [...step.media], reach: step.reach }
          const narrowed = scopeWithin(graph, asked)
          const drawn = narrowed.ok ? await drawingOf(narrowed.scoped) : null
          if (!narrowed.ok || drawn === null) continue
          if (step.media.length < services.length) countAdjustment(adjusted, { kind: 'scope', text: `drawn for ${name(step.media[0]!)} only; also: ${services.filter(other => other !== step.media[0]).map(name).join(', ')}`.slice(0, 200) })
          const reach = narrowed.reach ?? step.reach
          if (reach < TOPOLOGY_REACH) countAdjustment(adjusted, { kind: 'scope', text: `drawn ${reach} ${reach === 1 ? 'link' : 'links'} out to fit` })
          ;[request, scoped, drawing] = [{ ...asked, reach }, { ok: true, scoped: narrowed.scoped }, drawn]
          break
        }
      }
      // A layout may end on a half grid unit: its rows are the whole units it reaches into (scaled below if the frame is short).
      const rows = drawing === null ? 0 : Math.ceil(drawing.layout.height) + 1
      if (scoped?.ok !== true || drawing === null) {
        const why = scoped === null ? 'no topology' : !scoped.ok ? scoped.reason : 'no drawing verifies'
        if (kept.explicit.has(index)) issues.push(unfit(path, `the topology cannot be drawn in one vignette (${why})`))
        else countAdjustment(adjusted, { kind: 'layout', text: `topology not shown (${why})` })
        continue
      }
      if (scoped.reach !== undefined) countAdjustment(adjusted, { kind: 'scope', text: `reach narrowed to ${scoped.reach} links to draw at most 60 nodes` })
      const drawn: ResolvedView = { ...view, request: { ...request, ...(scoped.reach === undefined ? {} : { reach: scoped.reach }) }, rows }
      if (graph!.family === 'flow') flows.add(drawn)
      fitted.push(drawn)
    } else {
      // A map's objects beyond 48 are not framed: said, not counted as card items (a map shows none).
      if (view.objectIds !== undefined && view.objectIds.length > MAX_OBJECTS) {
        countAdjustment(adjusted, { kind: 'layout', text: `${view.objectIds.length - MAX_OBJECTS} objects beyond ${MAX_OBJECTS} not framed on the map` })
        view.objectIds.splice(MAX_OBJECTS)
      }
      fitted.push({ ...view, rows: 2 })
    }
  }
  if (issues.length > 0) return refuse(issues)
  // Rows: alerts and tables give way first, then the frame does not fit and compose refuses.
  // The chips: the object's own states the caller can read, in declared order, one row under the title.
  const readableChips = await declaredRefs(run, chipped)
  const chips = chipped.filter(ref => readableChips.has(ref))
  const stacked = (): number => fitted.reduce((sum, view) => sum + view.rows, 0)
  // In a window, a flow drawing taller than the stack leaves stands beside a column of every other view (Q20).
  const left = fitted.find(view => view.kind === 'topology' && flows.has(view))
  const sideBySide = (): number => Math.max(left?.rows ?? 0, fitted.reduce((sum, view) => sum + (view === left ? 0 : view.rows), 0))
  const beside = frame === 'window' && left !== undefined && FRAME_ROWS + (chips.length > 0 ? 1 : 0) + stacked() > VIGNETTE_MAX_ROWS
  const total = (): number => FRAME_ROWS + (chips.length > 0 ? 1 : 0) + (beside ? sideBySide() : stacked())
  for (const view of fitted) if (total() > VIGNETTE_MAX_ROWS && (view.kind === 'alerts' || view.kind === 'entity' || view.kind === 'collection')) (view as { rows: number }).rows = Math.min(view.rows, view.kind === 'alerts' ? 3 : 5)
  // Then a drawing is scaled to the rows left, never below a third of its height or eight rows, and the card says so.
  for (const view of fitted) {
    if (total() <= VIGNETTE_MAX_ROWS || view.kind !== 'topology') continue
    const natural = view.rows
    const rows = Math.max(8, Math.ceil((natural - 1) / 3) + 1, natural - (total() - VIGNETTE_MAX_ROWS))
    if (beside && view === left && fitted.reduce((sum, other) => sum + (other === left ? 0 : other.rows), 0) + FRAME_ROWS + (chips.length > 0 ? 1 : 0) > VIGNETTE_MAX_ROWS) continue
    if (rows >= natural) continue
    ;(view as { rows: number }).rows = rows
    countAdjustment(adjusted, { kind: 'layout', text: `drawing scaled to ${Math.round(100 * (rows - 1) / (natural - 1))} % to fit` })
  }
  if (total() > VIGNETTE_MAX_ROWS) return refuse([unfit('views', `the views need ${total()} rows; one vignette holds ${VIGNETTE_MAX_ROWS}`)])
  const uncovered = subjects.findIndex(subject => !covers(run, fitted, subject))
  if (fitted.length === 0 || uncovered >= 0) return refuse([unfit(uncovered >= 0 ? `subjects.${uncovered}` : 'views', 'nothing this vignette can show is about this subject')])

  const at = run.clock === undefined ? { at: new Date().toISOString(), clock: 'wall' as const } : { at: run.clock.currentTime, clock: 'simulation' as const }
  const state = vignetteStateSchema.parse({ title: title.slice(0, 80), ...(by === undefined ? {} : { by }), at, ...(chips.length === 0 ? {} : { chips }), ...(beside ? { beside: true } : {}), views: fitted })
  if (JSON.stringify(state).length > MAX_STATE) return refuse([unfit('views', `the vignette names more than its ${MAX_STATE}-character state holds`)])
  return { ok: true, state, card: await cardOf(run, state, kept, adjusted, dropped), rows: total() }
}

/** The card of a fitted state: every value it reads, the alerts and table rows its rows hold; each one a section leaves out is counted and said. */
const cardOf = async (run: ComposeRun, state: VignetteState, kept: Kept, fitted: ReadonlyArray<DisplayCardAdjustment>, dropped: number): Promise<DisplayCard> => {
  // Named values first, then the chips' and the views' own values; what a drawing binds comes after the alerts and tables.
  const { leads, refs: read, observations, sets } = await readNow(run, state)
  const own = readsOf(state, leads).refs
  const refs = [...new Set([...read.filter(ref => kept.refs.has(ref)), ...own])].filter(ref => read.includes(ref))
  const bound = read.filter(ref => !refs.includes(ref))
  const declared = await declaredRefs(run, read)
  const valueItems = (list: ReadonlyArray<string>) => list.flatMap(ref => declared.has(ref) ? [valueItem(declared.get(ref)!, observations.find(observation => observation.ref === ref))] : [])
  const adjusted = [...fitted]
  let hidden = dropped
  const left = (count: number, total: number, what: string): void => {
    if (count <= 0) return
    hidden += count
    countAdjustment(adjusted, { kind: 'layout', text: `${count} of ${total} ${what} not shown` })
  }
  const setItems = []
  for (const view of state.views) {
    if (!isSetView(view)) continue
    const set = await setCardItems(run, view, ref => sets.get(ref))
    setItems.push(...set.items)
    hidden += set.hidden
    for (const adjustment of set.adjusted) countAdjustment(adjusted, adjustment)
  }
  const items = [
    ...valueItems(refs),
    ...setItems,
    ...state.views.flatMap(view => {
      if (view.kind !== 'alerts') return []
      const rows = alertsOf(run, view)
      left(rows.length - (view.rows - 1), rows.length, 'alerts')
      return rows.slice(0, view.rows - 1).map(alertItem)
    }),
    ...state.views.flatMap(view => {
      if (view.kind === 'entity' || view.kind === 'collection') {
        const { rows, more } = entityRows(run, view)
        const category = view.kind === 'collection' ? run.packs.find(pack => pack.descriptor.id === view.of.packId)?.presentation.categories.find(entry => entry.id === view.of.categoryId)?.label : undefined
        left(more, rows.length + more, category ?? 'objects')
        return rows.map(entityItem)
      }
      const object = view.kind === 'slots' ? visibleObject(run, view.objectId) : undefined
      if (object === undefined) return []
      const slots = slotsOf(run, object)
      const signals = Object.keys(object.telemetry?.signals ?? {}).length
      left(signals - slots.filter(slot => slot.key.startsWith('telemetry:')).length, signals, 'telemetry signals')
      return slotItems(object.id, object.label, slots, Object.fromEntries(slots.map(({ key, value, since }) => [key, { value, ...(since === undefined ? {} : { since }) }])))
    }),
    ...valueItems(bound),
  ]
  return assembleCard(state.at, items, adjusted, hidden)
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
  if (spec.views.length === 0) {
    const defaults = await Promise.all(subjects.map(async subject => answered(run, await defaultViews(run, subject))))
    const quiet = (view: DraftView): boolean => view.kind === 'alerts' && view.objectIds !== 'run' && alertsOf(run, { ...view, rows: 1 }).length === 0
    return finish(run, spec.title, 'assistant', subjects, mergeDefaults(defaults, quiet), kept, 'chat', await chipsOf(run, subjects))
  }
  const views: DraftView[] = []
  for (const [index, view] of spec.views.entries()) {
    const resolved = await resolveView(run, view, `views.${index}`, subjects, kept)
    if (isIssue(resolved)) issues.push(resolved)
    else { if (view.kind === 'topology' && (view.from ?? view.to ?? view.around ?? view.media) !== undefined) kept.explicit.add(views.length); views.push(resolved) }
  }
  return issues.length > 0 ? refuse(issues) : finish(run, spec.title, 'assistant', subjects, views, kept, 'chat')
}

/** A subject's World default: what a person opens from the map, a procedure tag or the display window. */
export const composeDefault = async (run: ComposeRun, name: string | Extract<DisplaySpec['subjects'][number], { of: unknown }>): Promise<ComposeOutcome> => {
  const subject = await resolveSubject(run, name, 'subject')
  if (isIssue(subject)) return refuse([subject])
  const kept: Kept = { refs: new Set(subject.kind === 'observable' ? [subject.ref] : []), explicit: new Set() }
  return finish(run, await titleOf(run, subject), undefined, [subject], await defaultViews(run, subject), kept, 'window', await chipsOf(run, [subject]))
}

/** A whole-object default's chips: each declared object's own states, at most eight. */
const chipsOf = async (run: ComposeRun, subjects: ReadonlyArray<Subject>): Promise<ReadonlyArray<string>> =>
  (await Promise.all(subjects.flatMap(subject => subject.kind === 'object' && subject.observed ? [ownStates(run, subject.objectId)] : []))).flat().slice(0, 8)

/** A default's title from what is declared or presented: never a word World adds. */
const titleOf = async (run: ComposeRun, subject: Subject): Promise<string> => {
  if (subject.kind === 'collection') {
    const label = run.packs.find(pack => pack.descriptor.id === subject.of.packId)!.presentation.categories.find(category => category.id === subject.of.categoryId)!.label
    return subject.of.group === undefined ? label : `${label} · ${subject.of.group}`
  }
  if (subject.kind === 'connection') return [subject.connection.system.objectId, subject.connection.network.objectId].map(id => visibleObject(run, id)?.label ?? id).join(' – ')
  const object = visibleObject(run, subject.objectId)!
  if (subject.kind === 'observable') return (await declaredRefs(run, [subject.ref])).get(subject.ref)?.observable.label ?? object.label
  if (subject.kind === 'element') {
    // A declared element by its label; a device that is only a topology node by the node's.
    const label = (await declarationOf(run, subject.objectId))?.elements.find(entry => entry.id === subject.elementId)?.label
      ?? (await topologyOf(run, subject.objectId))?.nodes.find(node => node.id === subject.elementId)?.label
    return label === undefined ? object.label : `${object.label} · ${label}`
  }
  return object.label
}
