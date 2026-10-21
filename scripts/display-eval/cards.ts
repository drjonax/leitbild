/** Cards shaped by the contracts display card, built by the eval harness
 * from P1's real observation reads on a frozen Run (lead ruling R9): each item
 * a key, its declared label, a reading, its unit and every number the reading
 * shows at its typed precision (World's unitDecimals). */
import { DISPLAY_CARD_MAX_TEXT, displayCardSchema, displayCardTextLength, type DisplayCard, type DisplayCardItem } from '../../packages/contracts/src/index.ts'
import { decimalsFor } from '../../apps/world/src/core/observation/model.ts'
import type { SearchRun } from '../../apps/world/src/features/displays/observation/search.ts'

export type Card = DisplayCard
export type CardItem = DisplayCardItem

const clockOf = (at: string): string => at.slice(11, 19)

/** Labels, units and states of every observable of the objects the refs name, from their declarations. */
const declared = async (run: SearchRun, refs: ReadonlyArray<string>) => {
  const objectIds = [...new Set(refs.map(ref => ref.slice(0, ref.indexOf('#'))))]
  const byRef = new Map<string, { label: string; unit: string; states?: ReadonlyArray<{ value: string; label: string }>; thresholds: ReadonlyArray<number> }>()
  const add = (declaration: Awaited<ReturnType<SearchRun['port']['declarations']>>[number]) => {
    if ('refused' in declaration) return
    const objectLabel = run.objects.find(object => object.id === declaration.objectId)?.label ?? declaration.objectId
    for (const observable of declaration.observables) byRef.set(observable.ref, { label: `${objectLabel} · ${observable.label}`.slice(0, 80), unit: observable.unit, thresholds: observable.thresholds.map(threshold => threshold.value), ...(observable.states === undefined ? {} : { states: observable.states }) })
  }
  const base = await run.port.declarations(objectIds as never)
  base.forEach(add)
  // A grid declares each element's observables only when that element is asked for: ask for the elements the
  // missing refs are on (the declared element whose id the ref carries), at most 256 per object.
  for (const declaration of base) {
    if ('refused' in declaration) continue
    const missing = refs.filter(ref => ref.startsWith(`${declaration.objectId}#`) && !byRef.has(ref))
    const elementIds = declaration.elements.filter(element => missing.some(ref => ref.includes(`#${element.id}.`))).map(element => element.id).slice(0, 256)
    if (elementIds.length > 0) (await run.port.declarations([declaration.objectId] as never, elementIds)).forEach(add)
  }
  return byRef
}

/** One card over the refs (in order), keys numbered from `firstKey`; refs the Run does not read are left out, and
 * items past the contracts' text cap (1,900 characters of lines, Q14) are counted in `more` and stated, as World's
 * composer does: never cut silently. */
export const buildCard = async (run: SearchRun, refs: ReadonlyArray<string>, firstKey = 1): Promise<Card> => {
  const labels = await declared(run, refs)
  const read = await run.port.read({ refs: [...refs].slice(0, 48) })
  const items: CardItem[] = []
  for (const ref of refs) {
    const observation = read.observations.find(entry => entry.ref === ref)
    const meta = labels.get(ref)
    if (observation === undefined || meta === undefined) continue
    const since = observation.since === undefined ? '' : ` · since ${clockOf(observation.since.at)}`
    const value = observation.value
    const key = `k${firstKey + items.length}`
    if (typeof value === 'number') {
      const decimals = decimalsFor(meta.unit, value)
      items.push({ key, label: meta.label, reading: `${value.toFixed(decimals)}${meta.unit === '' || meta.unit === '1' ? '' : ` ${meta.unit}`}${since}`.slice(0, 120), ...(meta.unit === '' ? {} : { unit: meta.unit }), numbers: [{ value: Number(value.toFixed(decimals)), decimals }], subject: { ref } })
    } else {
      const word = typeof value === 'boolean' ? (value ? 'yes' : 'no') : value === null ? 'no reading' : (meta.states?.find(state => state.value === String(value))?.label ?? String(value))
      items.push({ key, label: meta.label, reading: `${word}${since}`.slice(0, 120), numbers: [], subject: { ref } })
    }
  }
  const at = { at: read.observations[0]?.at ?? new Date().toISOString(), clock: 'simulation' as const }
  const fitted = [...items]
  const cardOf = (shown: ReadonlyArray<CardItem>) => {
    const cut = items.length - shown.length
    return { at, items: shown, more: Math.max(0, refs.length - shown.length), adjusted: cut === 0 ? [] : [{ kind: 'layout' as const, text: `${cut} of ${items.length} items not shown (card limit)` }] }
  }
  while (fitted.length > 0 && displayCardTextLength(cardOf(fitted)) > DISPLAY_CARD_MAX_TEXT) fitted.pop()
  return displayCardSchema.parse(cardOf(fitted))
}

/** A card as the model reads it in a tool result: one line per item. */
export const cardText = (card: Card): string => [
  `card at ${card.at.at} (${card.at.clock})`,
  ...card.items.map(item => `${item.key} · ${item.label} · ${item.reading}`),
  ...(card.more > 0 ? [`+${card.more} more`] : []),
  ...card.adjusted.map(adjustment => `adjusted (${adjustment.kind}): ${adjustment.text}`),
].join('\n')

/** Each card item's declared threshold values at the item's typed precision (guard v2, rule 5), by key. */
export const cardLimits = async (run: SearchRun, card: Card): Promise<ReadonlyMap<string, CardItem['numbers']>> => {
  const refs = card.items.flatMap(item => item.subject !== undefined && 'ref' in item.subject ? [item.subject.ref] : [])
  const labels = await declared(run, refs)
  return new Map(card.items.flatMap(item => {
    const meta = item.subject !== undefined && 'ref' in item.subject ? labels.get(item.subject.ref) : undefined
    return meta === undefined ? [] : [[item.key, meta.thresholds.map(value => ({ value, decimals: decimalsFor(meta.unit, value) }))] as const]
  }))
}
