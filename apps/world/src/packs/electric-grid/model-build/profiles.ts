import { municipalityLoadGroups, priceAreas, type PriceArea } from '../schemas/grid-ids.ts'
import type { GridLoadProfiles } from '../schemas/grid-load-profile.ts'
import { roundTo } from './geo.ts'
import type { WeekProfileSnapshot } from './inputs.ts'

// Elhub's five price-area groups compose the three municipality groups exactly
// (sources/elhub-consumption.ts municipalityGroupComposition).
const composition = {
  private: ['household', 'cabin'],
  business: ['tertiary'],
  industry: ['primary', 'secondary'],
} as const satisfies Record<typeof municipalityLoadGroups[number], ReadonlyArray<string>>

const osloParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', weekday: 'short', hourCycle: 'h23' })

const localHour = (utc: string): { readonly hour: number; readonly weekend: boolean } => {
  const parts = osloParts.formatToParts(new Date(utc))
  const hour = Number(parts.find(part => part.type === 'hour')!.value)
  const weekday = parts.find(part => part.type === 'weekday')!.value
  return { hour, weekend: weekday === 'Sat' || weekday === 'Sun' }
}

type Group = typeof municipalityLoadGroups[number]
type GroupSeries = Readonly<Record<PriceArea, Readonly<Record<Group, ReadonlyArray<number>>>>>

const recordOf = <K extends string, V>(keys: ReadonlyArray<K>, value: (key: K) => V): Record<K, V> =>
  Object.fromEntries(keys.map(key => [key, value(key)])) as Record<K, V>

const composedSeries = (week: WeekProfileSnapshot): GroupSeries => {
  const series = (area: PriceArea, group: string): ReadonlyArray<number> => {
    const entry = week.series.find(candidate => candidate.priceArea === area && candidate.group === group)
    if (entry === undefined || entry.mw.length !== week.hoursUtc.length) throw new Error(`Elhub week ${week.week.startDate}: no complete ${area} ${group} series`)
    return entry.mw
  }
  return recordOf(priceAreas, area => recordOf(municipalityLoadGroups, group =>
    week.hoursUtc.map((_, index) => composition[group].reduce<number>((sum, part) => sum + series(area, part)[index]!, 0))))
}

/** Elhub's metered demand of each price area and group in one hour of the week, MW. */
export type PriceAreaGroupMw = Readonly<Record<PriceArea, Readonly<Record<Group, number>>>>

/**
 * The metered demand of each price area and group in the week's hour starting `hour.startUtc`.
 * The hour's price-area totals, from the reference-hour snapshot, must be the groups' sums.
 */
export const priceAreaGroupMwAt = (week: WeekProfileSnapshot, hour: { readonly startUtc: string; readonly byAreaMw: Readonly<Record<PriceArea, number>> }): PriceAreaGroupMw => {
  const index = week.hoursUtc.findIndex(utc => Date.parse(utc) === Date.parse(hour.startUtc))
  if (index < 0) throw new Error(`Elhub week ${week.week.startDate}: no hour starting ${hour.startUtc}`)
  const series = composedSeries(week)
  return recordOf(priceAreas, area => {
    const groups = recordOf(municipalityLoadGroups, group => roundTo(series[area][group][index]!, 3))
    const totalMw = municipalityLoadGroups.reduce((sum, group) => sum + groups[group], 0)
    const areaMw = hour.byAreaMw[area]
    // The reference-hour snapshot gives area totals to 0.1 MW.
    if (Math.abs(totalMw - areaMw) > 0.05 + 1e-9) throw new Error(`Elhub ${area} at ${hour.startUtc}: its groups sum to ${roundTo(totalMw, 3)} MW, its area total is ${areaMw} MW`)
    return groups
  })
}

/** The Elhub dataset both weeks come from. */
export const meteredDemandSourceId = (winter: WeekProfileSnapshot, summer: WeekProfileSnapshot): string => {
  if (winter.source.sourceId !== summer.source.sourceId) throw new Error(`the Elhub winter week is ${winter.source.sourceId}, the summer week ${summer.source.sourceId}`)
  return winter.source.sourceId
}

const dayProfile = (week: WeekProfileSnapshot, values: ReadonlyArray<number>, weekend: boolean, reference: number): ReadonlyArray<number> => {
  const sums = new Array<number>(24).fill(0)
  const counts = new Array<number>(24).fill(0)
  week.hoursUtc.forEach((utc, index) => {
    const local = localHour(utc)
    if (local.weekend !== weekend) return
    sums[local.hour]! += values[index]!
    counts[local.hour]! += 1
  })
  return sums.map((sum, hour) => {
    if (counts[hour] === 0) throw new Error(`Elhub week ${week.week.startDate}: no ${weekend ? 'weekend' : 'weekday'} value at local hour ${hour}`)
    return roundTo(sum / counts[hour]! / reference, 4)
  })
}

export const buildLoadProfiles = (config: {
  readonly modelId: string
  readonly winter: WeekProfileSnapshot
  readonly summer: WeekProfileSnapshot
  /** UTC start of the model's reference hour, inside the winter week. */
  readonly referenceStartUtc: string
  readonly referenceHour: string
}): GridLoadProfiles => {
  const winterSeries = composedSeries(config.winter)
  const referenceIndex = config.winter.hoursUtc.findIndex(hour => Date.parse(hour) === Date.parse(config.referenceStartUtc))
  if (referenceIndex < 0) throw new Error(`the reference hour ${config.referenceStartUtc} is not in the Elhub winter week`)
  const referenceOf = (area: PriceArea, group: Group): number => {
    const value = winterSeries[area][group][referenceIndex]!
    if (value <= 0) throw new Error(`Elhub ${area} ${group} has no demand at the reference hour`)
    return value
  }
  const season = (week: WeekProfileSnapshot) => {
    const series = composedSeries(week)
    const dayType = (weekend: boolean) => recordOf(priceAreas, area => recordOf(municipalityLoadGroups, group =>
      [...dayProfile(week, series[area][group], weekend, referenceOf(area, group))]))
    return { week: { startDate: week.week.startDate, endDate: week.week.endDate }, weekday: dayType(false), weekend: dayType(true) }
  }
  const source = (week: WeekProfileSnapshot) => ({ sourceId: week.source.sourceId, url: week.source.url, retrievedAt: week.source.retrievedAt, sha256: week.source.sha256, licence: 'cc-by-4.0' })
  return {
    schemaVersion: 1,
    id: 'electric-grid.norway.load-profiles',
    modelId: config.modelId,
    timeZone: 'Europe/Oslo',
    referenceHour: config.referenceHour,
    normalisation: 'mean MW of the price area and municipality group at each Europe/Oslo local hour over the week\'s weekdays (Mon–Fri) or weekend days, divided by the MW of the same area and group at the reference hour',
    groupComposition: { private: [...composition.private], business: [...composition.business], industry: [...composition.industry] },
    siteLoads: 'major-site loads (industry-site, petroleum-site, data-center) follow the industry profile of their price area: Elhub meters them in the municipality industry group',
    sources: [source(config.winter), source(config.summer)],
    seasons: { winter: season(config.winter), summer: season(config.summer) },
  }
}
