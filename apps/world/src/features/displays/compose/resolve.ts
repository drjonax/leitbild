/**
 * Names to what they name, as the caller (architecture A2), by these rules in order, never by a guess: a Pack id is
 * refused with its categories; a Scenario connection id is a connection; an object id an object; `objectId#x` an exact
 * ref its Pack reads, else an element by id or label, else a qualified name; anything else a search match of class 3
 * or better, else refused with the nearest names. A collection names one category by id, label or "Label (pack)".
 */
import { observableRefSchema, refObjectId } from '../../../core/model/alerts.ts'
import type { ElectricalConnectionDefinition, ObjectId, SimulationClockState } from '../../../core/model/index.ts'
import type { Selector } from '../../../core/observation/spec.ts'
import { observationProviderFor } from '../observation/port.ts'
import { resolveName, searchObservables, type SearchRun } from '../observation/search.ts'
import { declarationOf, same, visibleObject } from './declared.ts'
import type { Collection, ComposeIssue } from './model.ts'

export interface ComposeRun extends SearchRun {
  readonly clock: SimulationClockState | undefined
  readonly connections: ReadonlyArray<ElectricalConnectionDefinition>
}

export type Subject =
  | { readonly kind: 'object'; readonly objectId: ObjectId; readonly observed: boolean }
  | { readonly kind: 'element'; readonly objectId: ObjectId; readonly elementId: string }
  | { readonly kind: 'observable'; readonly objectId: ObjectId; readonly ref: string }
  | { readonly kind: 'connection'; readonly connection: ElectricalConnectionDefinition }
  | { readonly kind: 'collection'; readonly of: Collection }

export const isIssue = (value: unknown): value is ComposeIssue => typeof value === 'object' && value !== null && 'code' in value && 'path' in value

const restricted = (path: string, objectId: string): ComposeIssue => ({ path, code: 'agent_access_restricted', message: `AI inspection access is restricted for: ${objectId}` })

const objectSubject = (run: ComposeRun, objectId: ObjectId): Subject => {
  const object = run.objects.find(candidate => candidate.id === objectId)!
  return { kind: 'object', objectId, observed: observationProviderFor(run.packs)(object) !== undefined }
}

/** A name by the rules above; `within`: objects a free name is searched in first (a view's subjects). */
export const resolveSubject = async (run: ComposeRun, name: string | { readonly of: Selector }, path: string, within: ReadonlyArray<ObjectId> = []): Promise<Subject | ComposeIssue> => {
  if (typeof name !== 'string') return resolveCollection(run, name.of, path)
  const pack = run.packs.find(candidate => candidate.descriptor.id === name)
  if (pack !== undefined) {
    return { path, code: 'pack_is_not_an_object', message: `${name} is a Pack; name one of its objects, or a category with {of: {category}}`,
      didYouMean: [{ pack: name, suggestions: pack.presentation.categories.map(category => category.id) }] }
  }
  const connection = run.connections.find(candidate => candidate.id === name)
  if (connection !== undefined) {
    const hidden = [connection.system.objectId, connection.network.objectId].find(objectId => run.denied.has(objectId))
    return hidden === undefined ? { kind: 'connection', connection } : restricted(path, hidden)
  }
  if (run.objects.some(object => object.id === name)) return run.denied.has(name) ? restricted(path, name) : objectSubject(run, name as ObjectId)
  const hash = name.indexOf('#')
  const objectId = hash > 0 ? name.slice(0, hash) : undefined
  if (objectId !== undefined && run.objects.some(object => object.id === objectId)) {
    if (run.denied.has(objectId)) return restricted(path, objectId)
    const id = objectId as ObjectId
    if (observableRefSchema.safeParse(name).success && (await run.port.read({ refs: [name] })).observations.some(observation => observation.ref === name)) return { kind: 'observable', objectId: id, ref: name }
    const part = name.slice(hash + 1)
    const element = (await declarationOf(run, id))?.elements.find(entry => entry.id === part || same(entry.label, part) || (entry.shortLabel !== undefined && same(entry.shortLabel, part)))
    if (element !== undefined) return { kind: 'element', objectId: id, elementId: element.id }
    const [ref] = await resolveName(run, name)
    if (ref !== undefined) return { kind: 'observable', objectId: id, ref }
  }
  // A free name: searched in the subjects' objects first, then the whole Run; class 3 (qualified) or better only.
  const visibleWithin = within.filter(id => visibleObject(run, id) !== undefined)
  const asked = [...visibleWithin.map(id => ({ text: name, objectId: id })), { text: name }]
  const results = await searchObservables(run, asked)
  for (const result of results) {
    const match = result.matches.find(candidate => candidate.score >= 3)
    if (match === undefined) continue
    const id = match.objectId as ObjectId
    if (match.kind === 'observable' && match.ref !== undefined) return { kind: 'observable', objectId: id, ref: match.ref }
    if (match.kind === 'element' && match.element !== undefined) return { kind: 'element', objectId: id, elementId: match.element.id }
    return objectSubject(run, id)
  }
  const didYouMean = results.at(-1)?.didYouMean
  return { path, code: 'unknown_name', message: `Nothing in this Run is named "${name}": use an exact ref, objectId#tag-or-label, an object id or {of: {category}}; observables.search finds names`,
    ...(didYouMean === undefined ? {} : { didYouMean }) }
}

const resolveCollection = async (run: ComposeRun, selector: Selector, path: string): Promise<Subject | ComposeIssue> => {
  const categories = run.packs.flatMap(pack => pack.presentation.categories.map(category => ({ pack: pack.descriptor.id, category, named: `${category.label} (${pack.descriptor.id})` })))
  const matched = categories.filter(entry => same(entry.category.id, selector.category) || same(entry.category.label, selector.category) || same(entry.named, selector.category))
  const exact = matched.length > 1 ? matched.filter(entry => same(entry.named, selector.category)) : matched
  if (exact.length !== 1) {
    const offered = exact.length > 1 ? exact : categories
    return { path: `${path}.of.category`, code: 'unknown_name',
      message: exact.length > 1 ? `"${selector.category}" names a category of several Packs; name it as "Label (pack)"` : `No presentation category is named "${selector.category}"`,
      didYouMean: [...new Set(offered.map(entry => entry.pack))].map(pack => ({ pack, suggestions: offered.filter(entry => entry.pack === pack).map(entry => entry.named).slice(0, 3) })) }
  }
  const near = selector.near === undefined ? undefined : await resolveSubject(run, selector.near, `${path}.of.near`)
  if (isIssue(near)) return near
  if (near !== undefined && near.kind !== 'object') return { path: `${path}.of.near`, code: 'unknown_name', message: `"${selector.near}" is not an object; "near" names one object` }
  const { pack, category } = exact[0]!
  return { kind: 'collection', of: {
    packId: pack, categoryId: category.id, closed: selector.closed,
    ...(selector.status === undefined ? {} : { status: selector.status }), ...(near === undefined ? {} : { near: near.objectId }), ...(selector.within === undefined ? {} : { within: selector.within }),
  } }
}

/** The objects a subject is about: what alerts, maps and searches within it cover. */
export const subjectObjects = (subject: Subject): ReadonlyArray<ObjectId> =>
  subject.kind === 'connection' ? [subject.connection.system.objectId, subject.connection.network.objectId]
    : subject.kind === 'collection' ? []
      : subject.kind === 'observable' ? [refObjectId(subject.ref)] : [subject.objectId]
