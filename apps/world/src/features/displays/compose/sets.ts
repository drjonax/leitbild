/**
 * Views of a set of units (multiunit plan §3.1): a collection's members, re-resolved each sample, or at most twelve
 * named units of one category. A fleet lists each member from its Pack's member columns; a comparison and a trend match
 * each quantity on every member under one local ref (a comparable role, a tag or a label), and a member that does not
 * measure it is named, never guessed. Rows are allotted by the frame; every member at caution or above keeps a row or a
 * named pen, else compose refuses. Bands are computed here, so a sample carries the rows it shows and a band, not every
 * member's values.
 */
import type { DisplayCardAdjustment, DisplayCardItem } from '@leitbild/contracts'
import type { Priority } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { Observation } from '../../../core/observation/model.ts'
import type { Selector } from '../../../core/observation/spec.ts'
import { priorityRank } from '../alerts/rows.ts'
import { bandItem, compareHeaderItem, compareRowItem, fleetRowItem, setHeaderItem, valueItem } from './card.ts'
import { declaredRefs, same, visibleObject, type Declared } from './declared.ts'
import type {
  BandPoint, CompareRow, ComposeIssue, FleetRow, FleetTally, MemberAlert, ResolvedView, SetBand, SetColumn, SetSample, SetSignal, SetStrip, UnitSet,
  VignetteSection, VignetteState,
} from './model.ts'
import { categoryOf, membersDeclared, presentedOf } from './present.ts'
import { isIssue, resolveSubject, type ComposeRun, type Subject } from './resolve.ts'
import { membersOf, worstAlert, type SeriesPort } from './view.ts'

/** Where a vignette is shown: a chat answer stacks its views in 40 rows; a window may stand a tall drawing beside them (Q20). */
export type Frame = 'chat' | 'window'
/** The data rows a table of members gets in each frame. */
export const SET_ROWS: Readonly<Record<Frame, number>> = { chat: 12, window: 24 }
/** A trend of a set draws a pen per unit up to this many; beyond, a band and at most BAND_PENS named units. */
export const SET_PENS = 4
export const BAND_PENS = 3
/** Points a band's history is sampled at across its horizon. */
const BAND_HISTORY_POINTS = 120

export type SetView = Extract<ResolvedView, { kind: 'fleet' | 'compare' | 'set-trend' }>
type DraftSet = SetView extends infer View ? View extends unknown ? Omit<View, 'rows'> : never : never
type SetAlerts = Extract<ResolvedView, { kind: 'alerts' }> & { readonly objectIds: 'set' }
type Item = Omit<DisplayCardItem, 'key'>

const unknown = (path: string, message: string, didYouMean?: ComposeIssue['didYouMean']): ComposeIssue => ({ path, code: 'unknown_name', message, ...(didYouMean === undefined ? {} : { didYouMean }) })
const notObserved = (path: string, message: string): ComposeIssue => ({ path, code: 'not_observed', message })
const unfit = (path: string, message: string): ComposeIssue => ({ path, code: 'not_fitted', message })
const atCaution = (priority: Priority | null | undefined): boolean => priority != null && priorityRank(priority) >= priorityRank('caution')
const worse = (left: Priority | null, right: Priority | null): Priority | null => priorityRank(right) > priorityRank(left) ? right : left

/** A set's members now, as the caller sees them: a collection's in its order (worst first), named units in theirs. */
export const unitsOf = (run: ComposeRun, of: UnitSet): ReadonlyArray<OperationalObject> =>
  'objectIds' in of ? of.objectIds.flatMap(id => visibleObject(run, id) ?? []) : membersOf(run, of)

export const memberAlert = (object: OperationalObject): MemberAlert | undefined => {
  const row = worstAlert(object)
  return row === undefined ? undefined : { priority: row.priority, message: row.alert.message.slice(0, 200) }
}
const cautionCount = (members: ReadonlyArray<OperationalObject>): number => members.filter(member => atCaution(memberAlert(member)?.priority)).length

const categoryOfSet = (run: ComposeRun, of: UnitSet): { readonly packId: string; readonly categoryId: string } | undefined => {
  if (!('objectIds' in of)) return { packId: of.packId, categoryId: of.categoryId }
  const first = of.objectIds.map(id => visibleObject(run, id)).find(object => object !== undefined)
  const categoryId = first === undefined ? undefined : presentedOf(run, first)?.categoryId
  return first === undefined || categoryId === undefined ? undefined : { packId: first.packId, categoryId }
}

/** A set's words: its category's label, and the group it keeps. */
export const setLabel = (run: ComposeRun, of: UnitSet): string => {
  const category = categoryOfSet(run, of)
  const label = category === undefined ? 'Units' : categoryOf(run, category.packId, category.categoryId)?.label ?? category.categoryId
  return ('objectIds' in of || of.group === undefined ? label : `${label} · ${of.group}`).slice(0, 80)
}

/** A set as a spec names it, resolved: a selector as a collection; named units each to a visible object of one category. */
export const resolveUnitSet = async (run: ComposeRun, of: Selector | ReadonlyArray<string>, path: string): Promise<UnitSet | ComposeIssue> => {
  if (!Array.isArray(of)) {
    const collection = await resolveSubject(run, { of: of as Selector }, path)
    return isIssue(collection) ? collection : (collection as Extract<Subject, { kind: 'collection' }>).of
  }
  const ids: ObjectId[] = []
  for (const [index, name] of of.entries()) {
    const subject = await resolveSubject(run, name, `${path}.of.${index}`)
    if (isIssue(subject)) return subject
    if (subject.kind !== 'object') return unknown(`${path}.of.${index}`, `"${name}" is not a unit; name each unit by its object id or label`)
    ids.push(subject.objectId)
  }
  const kinds = new Set(ids.map(id => { const object = visibleObject(run, id)!; return `${object.packId} ${presentedOf(run, object)?.categoryId ?? ''}` }))
  return kinds.size > 1 ? unknown(`${path}.of`, 'the named units are of different categories; a set holds units of one category') : { objectIds: [...new Set(ids)] }
}

/** A fleet of a category its Pack lists members of. */
export const resolveFleet = (run: ComposeRun, of: UnitSet, path: string): ComposeIssue | undefined => {
  const category = categoryOfSet(run, of)
  if (category === undefined || membersDeclared(run, category.packId, category.categoryId) === undefined) {
    return notObserved(`${path}.of`, `${setLabel(run, of)} declares no member columns, so no fleet view; show it as a values view with of`)
  }
  return undefined
}

/**
 * Each quantity named for a set, as a local ref every member of its model measures: a comparable role by id or label,
 * else what the name resolves to on the set's first member (an exact ref, objectId#tag-or-label or a qualified label).
 * One no member measures is refused; a trend's must be recorded.
 */
export const resolveSetSignals = async (run: ComposeRun, of: UnitSet, names: ReadonlyArray<string>, path: string, recorded: boolean): Promise<ReadonlyArray<SetSignal> | ComposeIssue> => {
  const members = unitsOf(run, of)
  const category = categoryOfSet(run, of)
  if (members.length === 0 || category === undefined) return notObserved(`${path}.of`, 'the set has no members now')
  const roles = run.packs.find(pack => pack.descriptor.id === category.packId)?.observation?.comparable?.filter(role => role.category === category.categoryId) ?? []
  const offered = roles.length === 0 ? undefined : [{ pack: category.packId, suggestions: roles.slice(0, 3).map(role => role.label) }]
  const signals: SetSignal[] = []
  for (const [index, name] of names.entries()) {
    const at = `${path}.signals.${index}`
    const role = roles.find(entry => same(entry.id, name) || same(entry.label, name))
    let local = role?.ref
    if (local === undefined) {
      const subject = await resolveSubject(run, name, at, [members[0]!.id])
      if (isIssue(subject)) return { ...subject, ...(offered === undefined ? {} : { didYouMean: offered }) }
      if (subject.kind !== 'observable' || !members.some(member => member.id === subject.objectId)) {
        return unknown(at, `"${name}" is not a quantity the set's units measure: name a comparable role, objectId#tag or a label`, offered)
      }
      local = subject.ref.slice(subject.objectId.length + 1)
    }
    const declared = [...(await declaredRefs(run, members.map(member => `${member.id}#${local}`))).values()]
    if (declared.length === 0) return notObserved(at, `no unit in the set measures "${name}"`)
    if (recorded && declared[0]!.observable.series == null) return notObserved(at, `${declared[0]!.observable.label} is not recorded, so no trend is promised; compare it instead`)
    if (!signals.some(signal => signal.ref === local)) signals.push({ ref: local, label: (role?.label ?? declared[0]!.observable.label).slice(0, 80) })
  }
  return signals
}

/**
 * A set view's rows in this frame, or why it cannot keep every member at caution or above in sight. A fleet: its column
 * and aggregate headers, a row per member up to the frame's, and "+M more". A comparison: its header, a row per member
 * up to the frame's, and a band row. A set trend: a strip per quantity, four pens high once banded.
 */
export const fitSet = (run: ComposeRun, view: DraftSet, frame: Frame, path: string): number | ComposeIssue => {
  const members = unitsOf(run, view.of)
  const room = SET_ROWS[frame]
  const caution = cautionCount(members)
  if (view.kind === 'set-trend') {
    const banded = !('objectIds' in view.of) || members.length > SET_PENS
    if (banded && caution > BAND_PENS) return unfit(path, `${caution} units are at caution or above; a trend of a set names at most ${BAND_PENS} beside its band: compare them, or narrow the set`)
    return view.signals.length * (banded ? SET_PENS : Math.max(3, members.length)) + 1
  }
  if (caution > room) return unfit(path, `${caution} units are at caution or above and a ${view.kind} view here shows ${room} rows: narrow the set (status or group)`)
  return (view.kind === 'fleet' ? 2 : 1) + Math.max(1, Math.min(members.length, room)) + (members.length > room ? 1 : 0)
}

/** What a state's comparisons and set trends read now: each quantity on each member. */
export const setRefs = (run: ComposeRun, state: VignetteState): ReadonlyArray<string> => state.views.flatMap(view =>
  view.kind === 'compare' || view.kind === 'set-trend' ? unitsOf(run, view.of).flatMap(member => view.signals.map(signal => `${member.id}#${signal.ref}`)) : [])

const declaredOn = async (run: ComposeRun, members: ReadonlyArray<OperationalObject>, signals: ReadonlyArray<SetSignal>): Promise<ReadonlyMap<string, Declared>> =>
  declaredRefs(run, members.flatMap(member => signals.map(signal => `${member.id}#${signal.ref}`)))

const columnsOf = (members: ReadonlyArray<OperationalObject>, signals: ReadonlyArray<SetSignal>, declared: ReadonlyMap<string, Declared>): ReadonlyArray<SetColumn> => signals.map(signal => {
  const first = members.map(member => declared.get(`${member.id}#${signal.ref}`)).find(entry => entry !== undefined)?.observable
  return { label: signal.label, unit: first?.unit ?? '', ...(first === undefined ? {} : { quantity: first.quantity }), ...(first?.decades === true ? { decades: true as const } : {}) }
})

export const setSection = async (run: ComposeRun, view: SetView): Promise<VignetteSection> => {
  const label = setLabel(run, view.of)
  if (view.kind === 'fleet') {
    const declared = membersDeclared(run, view.of.packId, view.of.categoryId)
    return {
      kind: 'fleet', rows: view.rows, label: setLabel(run, { ...view.of, group: undefined } as UnitSet),
      ...(view.of.group === undefined || declared?.group === undefined ? {} : { group: { label: declared.group.label, value: view.of.group } }),
      columns: (declared?.columns ?? []).map(({ key, label: words, unit, tally }) => ({ key, label: words, unit, ...(tally === undefined ? {} : { tally: true as const }) })),
    }
  }
  const members = unitsOf(run, view.of)
  const columns = columnsOf(members, view.signals, await declaredOn(run, members, view.signals))
  return view.kind === 'compare' ? { kind: 'compare', rows: view.rows, label, columns }
    : { kind: 'set-trend', rows: view.rows, label, horizonMs: ({ '2m': 120_000, '10m': 600_000, '30m': 1_800_000 } as const)[view.horizon], strips: columns }
}

const median = (sorted: ReadonlyArray<number>): number => sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
const bandOf = (values: ReadonlyArray<{ readonly label: string; readonly value: number }>): SetBand | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left.value - right.value)
  return { min: sorted[0]!.value, median: median(sorted.map(entry => entry.value)), max: sorted.at(-1)!.value, count: sorted.length, minAt: sorted[0]!.label, maxAt: sorted.at(-1)!.label }
}
/** How far a value stands from its band's median, in band widths. */
const deviation = (band: SetBand | null, value: number | undefined): number => band === null || value === undefined || band.max === band.min ? 0 : Math.abs(value - band.median) / (band.max - band.min)
const numberOf = (observation: Observation | undefined): number | undefined =>
  typeof observation?.value === 'number' && Number.isFinite(observation.value) && observation.quality !== 'not-applicable' ? observation.value : undefined

/** A recorded series' value held at `t`: its last point at or before it. */
const heldAt = (points: ReadonlyArray<{ readonly t: number; readonly v: number }>, t: number): number | undefined => {
  let found: number | undefined
  for (const point of points) { if (point.t > t) break; found = point.v }
  return found
}

type Value = (ref: string) => Observation | undefined
type History = { readonly fromMs: number; readonly at: string; readonly series: SeriesPort }

const fleetSample = (run: ComposeRun, view: Extract<SetView, { kind: 'fleet' }>): Extract<SetSample, { kind: 'fleet' }> => {
  const members = membersOf(run, view.of)
  const declared = membersDeclared(run, view.of.packId, view.of.categoryId)
  const data = view.rows - 2
  const shown = members.length > data ? Math.max(0, data - 1) : members.length
  const rows = members.map((object): FleetRow => {
    const alert = memberAlert(object)
    return { objectId: object.id, label: object.label, values: declared?.row(object) ?? {}, priority: alert?.priority ?? null, ...(alert === undefined ? {} : { alert }) }
  })
  const tallies = (declared?.columns ?? []).flatMap(column => {
    if (column.tally === undefined) return []
    const words = new Map<string, string[]>()
    for (const row of rows) {
      const word = row.values[column.key]
      if (typeof word !== 'string' || column.tally.except.includes(word)) continue
      words.set(word, [...words.get(word) ?? [], row.label])
    }
    return [...words].map(([word, labels]): FleetTally => ({ column: column.key, word, count: labels.length, labels: labels.slice(0, 3) }))
  })
  return { kind: 'fleet', members: members.length, rows: rows.slice(0, shown), more: members.length - shown, moreAtCaution: rows.slice(shown).filter(row => atCaution(row.priority)).length, tallies }
}

const compareSample = async (run: ComposeRun, view: Extract<SetView, { kind: 'compare' }>, value: Value): Promise<Extract<SetSample, { kind: 'compare' }>> => {
  const members = unitsOf(run, view.of)
  const declared = await declaredOn(run, members, view.signals)
  const refOf = (member: OperationalObject, signal: SetSignal): string | null => declared.has(`${member.id}#${signal.ref}`) ? `${member.id}#${signal.ref}` : null
  const bands = view.signals.map(signal => bandOf(members.flatMap(member => {
    const reading = numberOf(value(`${member.id}#${signal.ref}`))
    return reading === undefined || refOf(member, signal) === null ? [] : [{ label: member.label, value: reading }]
  })))
  const rows = members.map((member): CompareRow & { readonly deviation: number } => {
    const refs = view.signals.map(signal => refOf(member, signal))
    const priority = refs.reduce<Priority | null>((worst, ref) => ref === null ? worst : worse(worst, value(ref)?.priority ?? null), memberAlert(member)?.priority ?? null)
    return { objectId: member.id, label: member.label, priority, refs, deviation: Math.max(0, ...refs.map((ref, at) => ref === null ? 0 : deviation(bands[at]!, numberOf(value(ref))))) }
  })
  const data = view.rows - 1
  const banded = members.length > data
  const shown = banded ? Math.max(0, data - 1) : members.length
  // Beyond its rows: those at caution or above first, then the furthest from the median, then the set's own order.
  const order = banded ? rows.map((row, at) => ({ row, at })).sort((left, right) =>
    Number(atCaution(right.row.priority)) - Number(atCaution(left.row.priority)) || right.row.deviation - left.row.deviation || left.at - right.at).map(entry => entry.row) : rows
  return {
    kind: 'compare', members: members.length, rows: order.slice(0, shown).map(({ deviation: _, ...row }) => row), more: members.length - shown,
    band: banded ? bands : null, missing: view.signals.map(signal => members.filter(member => refOf(member, signal) === null).map(member => member.label)),
  }
}

const trendSample = async (run: ComposeRun, view: Extract<SetView, { kind: 'set-trend' }>, value: Value, history?: History): Promise<Extract<SetSample, { kind: 'set-trend' }>> => {
  const members = unitsOf(run, view.of)
  const declared = await declaredOn(run, members, view.signals)
  const bandHistory: Record<number, ReadonlyArray<BandPoint>> = {}
  const strips = view.signals.map((signal, index): SetStrip => {
    const recorded = members.flatMap(member => {
      const entry = declared.get(`${member.id}#${signal.ref}`)
      return entry?.observable.series == null ? [] : [{ member, ref: entry.observable.ref, seriesId: entry.observable.series.seriesId, now: value(entry.observable.ref) }]
    })
    const missing = members.filter(member => !recorded.some(entry => entry.member === member)).map(member => member.label)
    const pen = (entry: (typeof recorded)[number]) => ({ ref: entry.ref, label: entry.member.label.slice(0, 80), seriesId: entry.seriesId })
    if (recorded.length <= SET_PENS) return { pens: recorded.map(pen), band: null, missing }
    const band = bandOf(recorded.flatMap(entry => { const reading = numberOf(entry.now); return reading === undefined ? [] : [{ label: entry.member.label, value: reading }] }))
    const urgent = (entry: (typeof recorded)[number]): boolean => atCaution(memberAlert(entry.member)?.priority) || atCaution(entry.now?.priority)
    const named = recorded.map((entry, at) => ({ entry, at })).sort((left, right) => Number(urgent(right.entry)) - Number(urgent(left.entry))
      || deviation(band, numberOf(right.entry.now)) - deviation(band, numberOf(left.entry.now)) || left.at - right.at).slice(0, BAND_PENS).map(({ entry }) => entry)
    if (history !== undefined) {
      const records = recorded.map(entry => history.series(entry.seriesId, new Date(history.fromMs).toISOString(), history.at).points)
      const toMs = Date.parse(history.at)
      const step = Math.max(1, (toMs - history.fromMs) / BAND_HISTORY_POINTS)
      bandHistory[index] = Array.from({ length: BAND_HISTORY_POINTS + 1 }, (_, at) => history.fromMs + at * step).flatMap(t => {
        const held = records.flatMap(points => heldAt(points, t) ?? [])
        if (held.length === 0) return []
        const sorted = [...held].sort((left, right) => left - right)
        return [{ t, min: sorted[0]!, median: median(sorted), max: sorted.at(-1)! }]
      })
    }
    return { pens: named.map(pen), band, missing }
  })
  return { kind: 'set-trend', members: members.length, strips, ...(history === undefined ? {} : { history: bandHistory }) }
}

/** A set view as it is now; `history` (a set trend's bands from `fromMs` to `at`) only when asked. */
export const sampleSet = async (run: ComposeRun, view: SetView | SetAlerts, value: Value, history?: History): Promise<SetSample> =>
  view.kind === 'alerts' ? { kind: 'alerts', members: membersOf(run, view.of!).map(member => member.id) }
    : view.kind === 'fleet' ? fleetSample(run, view)
      : view.kind === 'compare' ? compareSample(run, view, value)
        : trendSample(run, view, value, history)

export const isSetView = (view: ResolvedView): view is SetView => view.kind === 'fleet' || view.kind === 'compare' || view.kind === 'set-trend'
export const isSetAlerts = (view: ResolvedView): view is SetAlerts => view.kind === 'alerts' && view.objectIds === 'set'

/**
 * A set view's card items: its aggregate header, the rows it shows and, beyond them, each quantity's band; a set trend
 * its named pens now and its bands. Members it does not show are counted, and quantities a member does not measure said.
 */
export const setCardItems = async (run: ComposeRun, view: SetView, value: Value): Promise<{ readonly items: ReadonlyArray<Item>; readonly hidden: number; readonly adjusted: ReadonlyArray<DisplayCardAdjustment> }> => {
  const label = setLabel(run, view.of)
  const sample = await sampleSet(run, view, value)
  const adjusted: DisplayCardAdjustment[] = []
  const missing = (columns: ReadonlyArray<SetColumn>, lists: ReadonlyArray<ReadonlyArray<string>>): void => lists.forEach((list, at) => {
    if (list.length > 0) adjusted.push({ kind: 'scope', text: `${columns[at]!.label} not measured on ${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`.slice(0, 200) })
  })
  if (sample.kind === 'fleet' && view.kind === 'fleet') {
    const columns = membersDeclared(run, view.of.packId, view.of.categoryId)?.columns ?? []
    if (sample.more > 0) adjusted.push({ kind: 'layout', text: `${sample.more} of ${sample.members} units not listed${sample.moreAtCaution > 0 ? `, ${sample.moreAtCaution} at caution or above` : ''}` })
    return { items: [setHeaderItem(label, sample.members, sample.tallies), ...sample.rows.map(row => fleetRowItem(row, columns))], hidden: sample.more, adjusted }
  }
  const members = unitsOf(run, view.of)
  const declared = await declaredOn(run, members, view.kind === 'fleet' ? [] : view.signals)
  const columns = columnsOf(members, view.kind === 'fleet' ? [] : view.signals, declared)
  if (sample.kind === 'compare') {
    missing(columns, sample.missing)
    if (sample.more > 0) adjusted.push({ kind: 'layout', text: `${sample.more} of ${sample.members} units not listed; each column's band spans them all` })
    const bands = (sample.band ?? []).flatMap((band, at) => band === null ? [] : [bandItem(columns[at]!, band, { min: band.minAt, max: band.maxAt })])
    return { items: [compareHeaderItem(label, sample.members, columns), ...sample.rows.map(row => compareRowItem(row, columns, value)), ...bands], hidden: sample.more, adjusted }
  }
  if (sample.kind !== 'set-trend') return { items: [], hidden: 0, adjusted }
  missing(columns, sample.strips.map(strip => strip.missing))
  const pens = await declaredRefs(run, sample.strips.flatMap(strip => strip.pens.map(pen => pen.ref)))
  const items = sample.strips.flatMap((strip, at) => [
    ...strip.band === null ? [] : [bandItem(columns[at]!, strip.band, { min: strip.band.minAt, max: strip.band.maxAt })],
    ...strip.pens.flatMap(pen => pens.has(pen.ref) ? [valueItem(pens.get(pen.ref)!, value(pen.ref))] : []),
  ])
  return { items, hidden: 0, adjusted }
}
