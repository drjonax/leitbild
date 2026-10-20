/**
 * Run-wide search over every Pack's observables, elements and objects
 * (architecture A4, ruling R23): read as the caller through the observation
 * port, so objects it may not inspect are absent. Ranking: an exact ref, tag
 * or id; then a qualified `objectId#tag-or-label`; then every word matched;
 * then some words. Ties keep the Run's object order. A match never selects
 * anything: when nothing matches fully, each Pack offers its nearest names.
 */
import { z } from 'zod'
import { refObjectId } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { editDistance, letters, matchedWordGroups, normalized, SUGGESTION_COUNT } from '../../../core/model/text-search.ts'
import type { ObservationDeclaration } from '../../../core/observation/capabilities.ts'
import { quantitySchema } from '../../../core/observation/model.ts'
import type { WorldPack } from '../../../core/packs/protocol.ts'
import { fold, indexWords, queryWords } from './fold.ts'
import type { ObservationPort } from './port.ts'

const name = z.string().min(1).max(200)
export const observablesSearchInputSchema = z.object({
  queries: z.array(z.object({ text: z.string().trim().min(1).max(120), pack: name.optional(), category: name.optional(), objectId: name.optional() }).strict()).min(1).max(8),
}).strict()
const matchSchema = z.object({
  kind: z.enum(['observable', 'element', 'object']), ref: z.string().optional(), objectId: z.string(), label: z.string(), pack: z.string(),
  category: z.string().optional(), element: z.object({ id: z.string(), class: z.string().optional() }).strict().optional(), tag: z.string().optional(),
  quantity: quantitySchema.optional(), unit: z.string().optional(), recorded: z.boolean().optional(), score: z.number(),
}).strict()
export const observablesSearchOutputSchema = z.object({
  results: z.array(z.object({
    query: z.number().int(), matches: z.array(matchSchema).max(8),
    didYouMean: z.array(z.object({ pack: z.string(), suggestions: z.array(z.string()).max(SUGGESTION_COUNT) }).strict()).optional(),
    refused: z.object({ code: z.enum(['pack_is_not_an_object', 'agent_access_restricted', 'unknown_object']), message: z.string(), categories: z.array(z.string()).optional() }).strict().optional(),
  }).strict()),
}).strict()
export type SearchMatch = z.output<typeof matchSchema>
type Query = z.output<typeof observablesSearchInputSchema>['queries'][number]
type Result = z.output<typeof observablesSearchOutputSchema>['results'][number]

export interface SearchRun {
  /** The Run's objects in Run order. */
  readonly objects: ReadonlyArray<OperationalObject>
  /** Objects the caller may not inspect: absent from every answer. */
  readonly denied: ReadonlySet<string>
  readonly packs: ReadonlyArray<WorldPack>
  readonly port: ObservationPort
}

interface Entry extends Omit<SearchMatch, 'score'> {
  readonly order: number
  readonly keys: ReadonlyArray<string>
  readonly words: ReadonlyArray<ReadonlyArray<string>>
  readonly names: ReadonlyArray<string>
}
const key = (text: string): string => normalized(fold(text))

/** Each object's words: its label, its presentation category and status word; never pack numbers (summary, fields). */
export const presentObjects = (packs: ReadonlyArray<WorldPack>, objects: ReadonlyArray<OperationalObject>) => {
  const packById = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  return new Map<string, { readonly pack: WorldPack | undefined; readonly category: WorldPack['presentation']['categories'][number] | undefined; readonly status: string | undefined }>(objects.map(object => {
    const pack = packById.get(object.packId)
    const presented = pack?.presentation.presentObject(object, { objects, objectsForPack: id => objects.filter(candidate => candidate.packId === id), tier: 'summary' })
    const category = pack?.presentation.categories.find(candidate => candidate.id === presented?.categoryId)
    return [object.id, { pack, category, status: presented?.status?.label }] as const
  }))
}

const declarationEntries = new WeakMap<ObservationDeclaration, { readonly owner: string; readonly entries: ReadonlyArray<Entry> }>()
const entriesOf = (declaration: ObservationDeclaration, object: OperationalObject, base: Pick<Entry, 'pack' | 'category'>, order: number): ReadonlyArray<Entry> => {
  const owner = JSON.stringify([object.label, base.category, order])
  const known = declarationEntries.get(declaration)
  if (known?.owner === owner) return known.entries
  const classes = new Map(declaration.elements.map(element => [element.id, element.class]))
  const entries: Entry[] = [
    ...declaration.observables.map((observable, index): Entry => ({
      ...base, kind: 'observable', ref: observable.ref, objectId: object.id, label: `${object.label} · ${observable.label}`, order: order + index,
      ...(observable.tag === undefined ? {} : { tag: observable.tag }),
      ...(observable.element === undefined ? {} : { element: { id: observable.element, ...(classes.has(observable.element) ? { class: classes.get(observable.element)! } : {}) } }),
      quantity: observable.quantity, unit: observable.unit, recorded: observable.series !== null,
      keys: [observable.ref, observable.ref.slice(observable.ref.indexOf('#') + 1), ...(observable.tag === undefined ? [] : [observable.tag])].map(key),
      words: indexWords(`${object.label} ${observable.label} ${observable.shortLabel ?? ''} ${observable.tag ?? ''} ${observable.ref.slice(observable.ref.indexOf('#') + 1)}`),
      names: [observable.label, ...(observable.tag === undefined ? [] : [observable.tag])],
    })),
    ...declaration.elements.map((element, index): Entry => ({
      ...base, kind: 'element', objectId: object.id, label: `${object.label} · ${element.label}`, element: { id: element.id, class: element.class },
      order: order + declaration.observables.length + index, keys: [key(element.id)],
      words: indexWords(`${object.label} ${element.label} ${element.shortLabel ?? ''} ${element.class}`), names: [element.label],
    })),
  ]
  declarationEntries.set(declaration, { owner, entries })
  return entries
}

const scored = (entry: Entry, text: string, words: ReadonlyArray<string>, objectWords: (objectId: string) => ReadonlyArray<ReadonlyArray<string>>): number => {
  if (entry.keys.includes(key(text))) return 4
  const hash = text.indexOf('#')
  if (hash > 0 && entry.kind !== 'object') {
    const [left, right] = [text.slice(0, hash), text.slice(hash + 1)]
    const objectNamed = key(left) === key(entry.objectId) || matchedWordGroups(queryWords(left), objectWords(entry.objectId)).length === queryWords(left).length
    const itemNamed = (entry.tag !== undefined && key(entry.tag) === key(right)) || matchedWordGroups(queryWords(right), indexWords(entry.label.slice(entry.label.indexOf(' · ') + 3))).length === queryWords(right).length
    if (objectNamed && itemNamed && queryWords(right).length > 0) return 3
  }
  const matched = matchedWordGroups(words, entry.words)
  if (matched.length === 0) return 0
  if (matched.length < words.length) return matched.length / words.length * 0.99
  return 2 + letters(matched) / Math.max(letters(matched), letters(entry.words.map(spellings => spellings[0]!)))
}

export const searchObservables = async (run: SearchRun, queries: ReadonlyArray<Query>): Promise<ReadonlyArray<Result>> => {
  const visible = run.objects.filter(object => !run.denied.has(object.id))
  const presented = presentObjects(run.packs, visible)
  const order = new Map<string, number>(run.objects.map((object, index) => [object.id, index * 100_000]))
  const objectWords = new Map<string, ReadonlyArray<ReadonlyArray<string>>>(visible.map(object => [object.id, indexWords(object.label)]))
  const results: Result[] = []
  for (const [index, query] of queries.entries()) {
    const refusal = (code: NonNullable<Result['refused']>['code'], message: string, categories?: ReadonlyArray<string>): Result =>
      ({ query: index, matches: [], refused: { code, message, ...(categories ? { categories: [...categories] } : {}) } })
    const pack = run.packs.find(candidate => candidate.descriptor.id === query.objectId)
    if (pack) { results.push(refusal('pack_is_not_an_object', `${query.objectId} is a Pack; name one of its objects, or a category with "category"`, pack.presentation.categories.map(category => category.id))); continue }
    if (query.objectId !== undefined && !run.objects.some(object => object.id === query.objectId)) { results.push(refusal('unknown_object', `No object ${query.objectId} in this Run`)); continue }
    if (query.objectId !== undefined && run.denied.has(query.objectId)) { results.push(refusal('agent_access_restricted', `AI inspection access is restricted for: ${query.objectId}`)); continue }
    const candidates = visible.filter(object => (query.objectId === undefined || object.id === query.objectId) && (query.pack === undefined || object.packId === query.pack)
      && (query.category === undefined || presented.get(object.id)?.category?.id === query.category))
    const declared = await run.port.declarations(candidates.map(object => object.id))
    const entries = candidates.flatMap((object, at): Entry[] => {
      const shown = presented.get(object.id)!
      const base = { pack: object.packId, ...(shown.category ? { category: shown.category.id } : {}) }
      const declaration = declared[at]!
      return [
        { ...base, kind: 'object', objectId: object.id, label: object.label, order: order.get(object.id)!, keys: [key(object.id)],
          words: indexWords(`${object.label} ${shown.category?.label ?? ''} ${shown.status ?? ''}`), names: [object.label] },
        ...('refused' in declaration ? [] : entriesOf(declaration, object, base, order.get(object.id)! + 1)),
      ]
    })
    const words = queryWords(query.text)
    const rank = (list: ReadonlyArray<Entry>) => list.map(entry => ({ entry, score: scored(entry, query.text, words, id => objectWords.get(id) ?? []) }))
      .filter(hit => hit.score > 0).sort((left, right) => right.score - left.score || left.entry.order - right.entry.order)
    // A matched element brings its own observables, read for it alone.
    const elements = rank(entries).filter(hit => hit.entry.kind === 'element').slice(0, 8)
    for (const objectId of new Set(elements.map(hit => hit.entry.objectId))) {
      const [declaration] = await run.port.declarations([objectId as ObjectId], elements.filter(hit => hit.entry.objectId === objectId).map(hit => hit.entry.element!.id))
      const object = candidates.find(candidate => candidate.id === objectId)!
      const base = { pack: object.packId, ...(presented.get(objectId)?.category ? { category: presented.get(objectId)!.category!.id } : {}) }
      if (declaration && !('refused' in declaration)) entries.push(...entriesOf(declaration, object, base, order.get(objectId)! + 50_000).filter(entry => entry.kind === 'observable' && !entries.some(known => known.ref === entry.ref)))
    }
    const hits = rank(entries)
    // A bare object id expands to its lead: the observables the Pack ranks first now.
    const named = candidates.find(object => key(object.id) === key(query.text))
    const lead = named === undefined ? [] : await resolveName(run, named.id)
    const leadHits = lead.flatMap((ref, at) => entries.filter(entry => entry.ref === ref).map(entry => ({ entry, score: 4 - (at + 1) / 100 })))
    const matches = [...new Map([...hits.filter(hit => hit.entry.kind === 'object' && hit.score === 4), ...leadHits, ...hits].map(hit => [hit.entry, hit])).values()]
      .slice(0, 8).map(({ entry: { order: _order, keys: _keys, words: _words, names: _names, ...match }, score }) => ({ ...match, score: Math.round(score * 1000) / 1000 }))
    const full = matches.some(match => match.score >= 2)
    results.push({ query: index, matches, ...(full ? {} : { didYouMean: suggestionsFor(entries, query.text) }) })
  }
  return results
}

const suggestionsFor = (entries: ReadonlyArray<Entry>, text: string) => {
  const wanted = key(text)
  const byPack = new Map<string, Map<string, number>>()
  for (const entry of entries) {
    for (const candidate of entry.names) {
      const distance = editDistance(wanted, key(candidate))
      if (distance > Math.max(2, Math.floor(wanted.length * 0.4))) continue
      const names = byPack.get(entry.pack) ?? new Map<string, number>()
      names.set(candidate, Math.min(distance, names.get(candidate) ?? distance))
      byPack.set(entry.pack, names)
    }
  }
  return [...byPack].map(([pack, names]) => ({ pack, suggestions: [...names].sort((left, right) => left[1] - right[1]).slice(0, SUGGESTION_COUNT).map(([candidate]) => candidate) }))
}

/**
 * A name as compose will resolve it (P2): a qualified `objectId#tag-or-label`
 * or a ref resolves to its ref; a bare object id to its observables in the
 * Pack's current lead order. Unknown or refused names resolve to none.
 */
export const resolveName = async (run: SearchRun, text: string, within?: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const object = run.objects.find(candidate => key(candidate.id) === key(text) && !run.denied.has(candidate.id) && (within === undefined || within.includes(candidate.id)))
  if (object) {
    const read = await run.port.read({ lead: { objectId: object.id, count: 16 } })
    return [...read.observations].sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity)).map(observation => observation.ref)
  }
  const objectId = text.includes('#') ? refObjectId(text) : undefined
  const [result] = await searchObservables(run, [{ text, ...(objectId !== undefined && run.objects.some(candidate => candidate.id === objectId) ? { objectId } : {}) }])
  const exact = result?.matches.filter(match => match.ref !== undefined && match.score >= 3 && (within === undefined || within.includes(match.objectId))) ?? []
  return exact.slice(0, 1).map(match => match.ref!)
}
