/**
 * Run-wide search over every Pack's observables, elements and objects
 * (architecture A4, ruling R23): read as the caller through the observation
 * port, so objects it may not inspect are absent. Ranking: an exact ref, tag
 * or id; then a qualified `objectId#tag-or-label`; then every word matched;
 * then some words. Ties keep the Run's object order. A match never selects
 * anything: when nothing matches fully, each Pack offers its nearest names.
 */
import { z } from 'zod'
import { observableRefSchema, refObjectId } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import { assignWords, editDistance, normalized, SUGGESTION_COUNT, type IndexedWord } from '../../../core/model/text-search.ts'
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

/**
 * An indexed word: the entry's own, or its object's label that every entry of
 * that object shares; a name (its labels and its element's, counted in how
 * much of the entry a query covers) or an alias (ids, categories, status
 * words, quantities, tags, joined short labels: matched, never counted).
 */
interface EntryWord extends IndexedWord { readonly own: boolean; readonly name: boolean }
interface Entry extends Omit<SearchMatch, 'score'> {
  readonly order: number
  readonly keys: ReadonlyArray<string>
  readonly words: ReadonlyArray<EntryWord>
  readonly names: ReadonlyArray<string>
}
const key = (text: string): string => normalized(fold(text))
const wordsOf = (text: string, kind: 'name' | 'alias' | 'tag' | 'shared'): ReadonlyArray<EntryWord> =>
  indexWords(text).map(spellings => ({ spellings, own: kind !== 'shared', name: kind === 'name', abbreviates: kind === 'tag' }))
/** A short label or tag also as one word, so "TDAFW" finds "TD AFW". */
const joined = (...texts: ReadonlyArray<string | undefined>): ReadonlyArray<EntryWord> => texts.flatMap(text => text === undefined || indexWords(text).length < 2 ? []
  : [{ spellings: [...new Set(indexWords(text).reduce((all, word) => all.flatMap(prefix => word.map(spelling => prefix + spelling)), ['']))], own: true, name: false, abbreviates: false }])

/** Each object's Pack, presentation category and status word: words only, never its summary or fields (one number, one source). */
export const presentObjects = (packs: ReadonlyArray<WorldPack>, objects: ReadonlyArray<OperationalObject>) => {
  const packById = new Map(packs.map(pack => [pack.descriptor.id, pack]))
  return new Map<string, { readonly pack: WorldPack | undefined; readonly category: WorldPack['presentation']['categories'][number] | undefined; readonly status: string | undefined }>(objects.map(object => {
    // A Pack without categories keeps records, not operational objects, and presents none.
    const pack = packById.get(object.packId)
    const presented = pack === undefined || pack.presentation.categories.length === 0 ? undefined : pack.presentation.presentObject(object, { objects, objectsForPack: id => objects.filter(candidate => candidate.packId === id), tier: 'summary' })
    const category = pack?.presentation.categories.find(candidate => candidate.id === presented?.categoryId)
    return [object.id, { pack, category, status: presented?.status?.label }] as const
  }))
}

const declarationEntries = new WeakMap<ObservationDeclaration, { readonly owner: string; readonly entries: ReadonlyArray<Entry> }>()
const entriesOf = (declaration: ObservationDeclaration, object: OperationalObject, base: Pick<Entry, 'pack' | 'category'>, order: number): ReadonlyArray<Entry> => {
  const owner = JSON.stringify([object.label, base.category, order])
  const known = declarationEntries.get(declaration)
  if (known?.owner === owner) return known.entries
  const elements = new Map(declaration.elements.map(element => [element.id, element]))
  const shared = wordsOf(object.label, 'shared')
  const entries: Entry[] = [
    ...declaration.observables.map((observable, index): Entry => ({
      ...base, kind: 'observable', ref: observable.ref, objectId: object.id, label: `${object.label} · ${observable.label}`, order: order + index,
      ...(observable.tag === undefined ? {} : { tag: observable.tag }),
      ...(observable.element === undefined ? {} : { element: { id: observable.element, ...(elements.has(observable.element) ? { class: elements.get(observable.element)!.class } : {}) } }),
      quantity: observable.quantity, unit: observable.unit, recorded: observable.series !== null,
      keys: [observable.ref, observable.ref.slice(observable.ref.indexOf('#') + 1), ...(observable.tag === undefined ? [] : [observable.tag])].map(key),
      // Its words: its own labels and its element's, its quantity and its tag (whose words may abbreviate a query word), then
      // its object's, which equal matches claim last. Signal ids are keys only: their words are a Pack's naming, not names.
      words: [...wordsOf(`${observable.label} ${observable.shortLabel ?? ''}`, 'name'),
        ...wordsOf(`${elements.get(observable.element ?? '')?.label ?? ''} ${elements.get(observable.element ?? '')?.shortLabel ?? ''}`, 'name'),
        ...wordsOf(observable.quantity, 'alias'), ...wordsOf(observable.tag ?? '', 'tag'),
        ...joined(observable.shortLabel, elements.get(observable.element ?? '')?.shortLabel, observable.tag), ...shared],
      names: [observable.label, ...(observable.tag === undefined ? [] : [observable.tag])],
    })),
    ...declaration.elements.map((element, index): Entry => ({
      ...base, kind: 'element', objectId: object.id, label: `${object.label} · ${element.label}`, element: { id: element.id, class: element.class },
      order: order + declaration.observables.length + index, keys: [key(element.id)],
      words: [...wordsOf(`${element.label} ${element.shortLabel ?? ''}`, 'name'), ...wordsOf(element.class, 'alias'), ...joined(element.shortLabel), ...shared], names: [element.label],
    })),
  ]
  declarationEntries.set(declaration, { owner, entries })
  return entries
}

const nameLetters = (words: ReadonlyArray<EntryWord>): number => words.reduce((sum, word) => sum + (word.name ? word.spellings[0]!.length : 0), 0)
type Claims = ReturnType<typeof assignWords>

const entryInitials = new WeakMap<Entry, ReadonlySet<string>>()
/** A query word's claims on an entry; none where no word of the entry shares a first letter with a query word. */
const claimsOf = (entry: Entry, words: ReadonlyArray<string>, initials: ReadonlySet<string>): Claims | null => {
  let own = entryInitials.get(entry)
  if (own === undefined) entryInitials.set(entry, own = new Set(entry.words.flatMap(word => word.spellings.map(spelling => spelling[0]!))))
  for (const initial of initials) if (own.has(initial)) return assignWords(words, entry.words)
  return null
}

/**
 * Match class first: 4 an exact ref, signal id, tag or id; 3 (3.5 by its exact
 * tag or signal id) a qualified objectId#tag-or-label; 2 to 3 every known
 * query word matched; under 1 some. A query word no entry knows is left out.
 * Within every-word matches: exact before prefix before abbreviation, query
 * words that hit the entry's own words before its object's shared label, the
 * share of the entry's names they cover, then an instrument (a tagged value)
 * before a model value.
 */
const scored = (entry: Entry, text: string, words: ReadonlyArray<string>, claims: Claims | null, weights: ReadonlyArray<number>, objectWords: (objectId: string) => ReadonlyArray<EntryWord>): number => {
  if (entry.keys.includes(key(text))) return 4
  const allOf = (query: ReadonlyArray<string>, against: ReadonlyArray<EntryWord>): boolean => query.length > 0 && assignWords(query, against).every(claim => claim !== null)
  const hash = text.indexOf('#')
  if (hash > 0 && entry.kind !== 'object') {
    const [left, right] = [text.slice(0, hash), text.slice(hash + 1)]
    const objectNamed = key(left) === key(entry.objectId) || allOf(queryWords(left), objectWords(entry.objectId))
    const exactly = (entry.tag !== undefined && key(entry.tag) === key(right)) || (entry.ref !== undefined && key(entry.ref.slice(entry.ref.indexOf('#') + 1)) === key(right))
    if (objectNamed && (exactly || allOf(queryWords(right), entry.words.filter(word => word.own)))) return exactly ? 3.5 : 3
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const matched = claims?.flatMap((claim, at) => claim === null || weights[at] === 0 ? [] : [{ ...claim, weight: weights[at]! }]) ?? []
  if (matched.length === 0 || total === 0) return 0
  // Each known query word weighs by how rare it is among the entries, so a rare word that matches counts for more.
  const share = (pick: (claim: (typeof matched)[number]) => number): number => matched.reduce((sum, claim) => sum + claim.weight * pick(claim), 0) / total
  const quality = share(claim => claim.quality / 3)
  const own = share(claim => entry.words[claim.word]!.own ? 1 : 0)
  const coverage = Math.min(1, nameLetters(matched.map(claim => entry.words[claim.word]!)) / Math.max(1, nameLetters(entry.words.filter(word => word.own))))
  if (matched.length < weights.filter(weight => weight > 0).length) return 0.99 * share(() => 1) * (0.55 + 0.25 * quality + 0.15 * coverage + (entry.tag === undefined ? 0 : 0.05))
  return 2 + 0.99 * (0.45 * quality + 0.25 * own + 0.25 * coverage + (entry.tag === undefined ? 0 : 0.05))
}

export const searchObservables = async (run: SearchRun, queries: ReadonlyArray<Query>): Promise<ReadonlyArray<Result>> => {
  const visible = run.objects.filter(object => !run.denied.has(object.id))
  const presented = presentObjects(run.packs, visible)
  const order = new Map<string, number>(run.objects.map((object, index) => [object.id, index * 100_000]))
  const objectWords = new Map<string, ReadonlyArray<EntryWord>>(visible.map(object => [object.id, wordsOf(object.label, 'name')]))
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
          words: [...wordsOf(object.label, 'name'), ...wordsOf(`${object.id} ${shown.category?.label ?? ''} ${shown.status ?? ''}`, 'alias')], names: [object.label] },
        ...('refused' in declaration ? [] : entriesOf(declaration, object, base, order.get(object.id)! + 1)),
      ]
    })
    const rank = (list: ReadonlyArray<Entry>) => {
      const claim = (words: ReadonlyArray<string>) => {
        const initials = new Set(words.map(word => word[0]!))
        const claimed = list.map(entry => claimsOf(entry, words, initials))
        return { words, claimed, counts: words.map((_, at) => claimed.filter(claims => (claims?.[at] ?? null) !== null).length) }
      }
      // A word that matches nothing alone is tried joined to its neighbour ("N-16" → "n16").
      let pass = claim(queryWords(query.text))
      for (let at = 0; at < pass.words.length; at += 1) {
        if (pass.counts[at] !== 0) continue
        for (const start of [at - 1, at].filter(start => start >= 0 && start + 1 < pass.words.length)) {
          const joinedPass = claim([...pass.words.slice(0, start), pass.words[start]! + pass.words[start + 1]!, ...pass.words.slice(start + 2)])
          if (joinedPass.counts[start]! > 0) { pass = joinedPass; break }
        }
      }
      const weights = pass.counts.map(count => count === 0 ? 0 : Math.log(1 + list.length / count))
      return { known: weights.filter(weight => weight > 0).length, length: pass.words.length,
        hits: list.map((entry, at) => ({ entry, score: scored(entry, query.text, pass.words, pass.claimed[at]!, weights, id => objectWords.get(id) ?? []) }))
          .filter(hit => hit.score > 0).sort((left, right) => right.score - left.score || left.entry.order - right.entry.order) }
    }
    // A matched element brings its own observables, read for it alone.
    const first = rank(entries)
    const elements = first.hits.filter(hit => hit.entry.kind === 'element').slice(0, 8)
    const before = entries.length
    for (const objectId of new Set(elements.map(hit => hit.entry.objectId))) {
      const [declaration] = await run.port.declarations([objectId as ObjectId], elements.filter(hit => hit.entry.objectId === objectId).map(hit => hit.entry.element!.id))
      const object = candidates.find(candidate => candidate.id === objectId)!
      const base = { pack: object.packId, ...(presented.get(objectId)?.category ? { category: presented.get(objectId)!.category!.id } : {}) }
      if (declaration && !('refused' in declaration)) entries.push(...entriesOf(declaration, object, base, order.get(objectId)! + 50_000).filter(entry => entry.kind === 'observable' && !entries.some(known => known.ref === entry.ref)))
    }
    const { known, length, hits } = entries.length === before ? first : rank(entries)
    // A bare object id expands to its lead: the observables the Pack ranks first now.
    const named = candidates.find(object => key(object.id) === key(query.text))
    const lead = named === undefined ? [] : await resolveName(run, named.id)
    const leadHits = lead.flatMap((ref, at) => entries.filter(entry => entry.ref === ref).map(entry => ({ entry, score: 4 - (at + 1) / 100 })))
    const matches = [...new Map([...hits.filter(hit => hit.entry.kind === 'object' && hit.score === 4), ...leadHits, ...hits].map(hit => [hit.entry, hit])).values()]
      .slice(0, 8).map(({ entry: { order: _order, keys: _keys, words: _words, names: _names, ...match }, score }) => ({ ...match, score: Math.round(score * 1000) / 1000 }))
    // Suggestions when nothing matched fully, or when a query word matched nothing at all.
    const suggestions = matches.some(match => match.score >= 2) && known === length ? [] : suggestionsFor(entries, query.text)
    results.push({ query: index, matches, ...(suggestions.length === 0 ? {} : { didYouMean: suggestions }) })
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
 * A name as compose will resolve it (P2): an exact ref its Pack reads, or a
 * qualified `objectId#tag-or-label`, resolves to its ref; a bare object id to
 * its observables in the Pack's current lead order. Unknown or refused names
 * resolve to none.
 */
export const resolveName = async (run: SearchRun, text: string, within?: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const object = run.objects.find(candidate => key(candidate.id) === key(text) && !run.denied.has(candidate.id) && (within === undefined || within.includes(candidate.id)))
  if (object) {
    const read = await run.port.read({ lead: { objectId: object.id, count: 16 } })
    return [...read.observations].sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity)).map(observation => observation.ref)
  }
  const objectId = text.includes('#') ? refObjectId(text) : undefined
  const reachable = objectId !== undefined && run.objects.some(candidate => candidate.id === objectId) && !run.denied.has(objectId) && (within === undefined || within.includes(objectId))
  // An exact ref resolves to itself wherever its Pack reads it, values declared only on request (a grid element's) included.
  if (reachable && observableRefSchema.safeParse(text).success && (await run.port.read({ refs: [text] })).observations.some(observation => observation.ref === text)) return [text]
  const [result] = await searchObservables(run, [{ text, ...(reachable ? { objectId } : {}) }])
  const exact = result?.matches.filter(match => match.ref !== undefined && match.score >= 3 && (within === undefined || within.includes(match.objectId))) ?? []
  return exact.slice(0, 1).map(match => match.ref!)
}
