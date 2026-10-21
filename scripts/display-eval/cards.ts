/** Cards shaped by apps/world/src/core/observation/card.ts, built by the eval
 * harness from P1's real observation reads on a frozen Run (lead ruling R9):
 * each item a key, its declared label, a reading, its unit and every number
 * the reading shows at its typed precision. The production card ships in P2;
 * until then the precision is this harness's table, by unit. */
import { displayCardSchema } from '../../apps/world/src/core/observation/card.ts'
import type { SearchRun } from '../../apps/world/src/features/displays/observation/search.ts'

export type Card = ReturnType<typeof displayCardSchema.parse>
export type CardItem = Card['items'][number]

/** Decimals a reading shows, by unit; a unit not listed shows three significant digits. */
const DECIMALS: Readonly<Record<string, number>> = {
  MPa: 2, kPa: 1, Pa: 0, bar: 2, '%': 1, '°C': 1, degC: 1, K: 1, 'kg/s': 0, 't/h': 0, MW: 0, kW: 0, Mvar: 0, MVA: 0, Hz: 2, mHz: 0,
  kV: 1, V: 0, A: 0, 'm/s': 1, 'mm/h': 1, m: 0, km: 1, rpm: 0, ppm: 0, 'mSv/h': 3, cps: 0, '1': 2, deg: 0, s: 0, min: 0,
}
export const decimalsFor = (unit: string, value: number): number => DECIMALS[unit] ?? (Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2)

const clockOf = (at: string): string => at.slice(11, 19)

/** Labels, units and states of every observable of the objects the refs name, from their declarations. */
const declared = async (run: SearchRun, refs: ReadonlyArray<string>) => {
  const objectIds = [...new Set(refs.map(ref => ref.slice(0, ref.indexOf('#'))))]
  const byRef = new Map<string, { label: string; unit: string; states?: ReadonlyArray<{ value: string; label: string }> }>()
  const add = (declaration: Awaited<ReturnType<SearchRun['port']['declarations']>>[number]) => {
    if ('refused' in declaration) return
    const objectLabel = run.objects.find(object => object.id === declaration.objectId)?.label ?? declaration.objectId
    for (const observable of declaration.observables) byRef.set(observable.ref, { label: `${objectLabel} · ${observable.label}`.slice(0, 80), unit: observable.unit, ...(observable.states === undefined ? {} : { states: observable.states }) })
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

/** One card over the refs (in order), keys numbered from `firstKey`; refs the Run does not read are left out. */
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
  return displayCardSchema.parse({ at: { at: read.observations[0]?.at ?? new Date().toISOString(), clock: 'simulation' }, items, more: Math.max(0, refs.length - items.length), adjusted: [] })
}

/** A card as the model reads it in a tool result: one line per item. */
export const cardText = (card: Card): string => [
  `card at ${card.at.at} (${card.at.clock})`,
  ...card.items.map(item => `${item.key} · ${item.label} · ${item.reading}`),
  ...(card.more > 0 ? [`+${card.more} more`] : []),
  ...card.adjusted.map(adjustment => `adjusted (${adjustment.kind}): ${adjustment.text}`),
].join('\n')
