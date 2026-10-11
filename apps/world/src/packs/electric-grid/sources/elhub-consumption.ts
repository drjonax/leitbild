import { z } from 'zod'
import { fetchRegistryDocument, parseDocument, type FetchContext, type PriceArea, type RawDocument } from './registry-fetch.ts'

// Elhub energy-data API: metered hourly consumption per municipality (three consumption groups)
// and per price area (five groups). Elhub publishes its open datasets under CC BY 4.0. A municipality
// request may span at most one day; a price-area request may span a month.

export const elhubMunicipalitySourceId = 'elhub:consumption-per-group-municipality-hour'
export const elhubPriceAreaSourceId = 'elhub:consumption-per-group-mba-hour'
const elhubBaseUrl = 'https://api.elhub.no/energy-data/v0'
const attribution = 'Elhub AS'

export const elhubMunicipalityGroups = ['business', 'industry', 'private'] as const
export const elhubPriceAreaGroups = ['household', 'cabin', 'primary', 'secondary', 'tertiary'] as const
export type ElhubMunicipalityGroup = typeof elhubMunicipalityGroups[number]
export type ElhubPriceAreaGroup = typeof elhubPriceAreaGroups[number]

// The municipality groups are exact sums of the price-area groups; the snapshot tool verifies the
// national totals agree hour by hour.
export const municipalityGroupComposition: Readonly<Record<ElhubMunicipalityGroup, ReadonlyArray<ElhubPriceAreaGroup>>> = {
  private: ['household', 'cabin'],
  industry: ['primary', 'secondary'],
  business: ['tertiary'],
}

const offsetTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00[+-]\d{2}:\d{2}$/)

const municipalityHourSchema = z.strictObject({
  startTime: offsetTimeSchema,
  endTime: offsetTimeSchema,
  consumptionGroup: z.enum(elhubMunicipalityGroups),
  quantityKwh: z.number().nonnegative(),
  lastUpdatedTime: z.string(),
  meteringPointCount: z.number().int().nonnegative(),
})

const priceAreaHourSchema = z.strictObject({
  startTime: offsetTimeSchema,
  endTime: offsetTimeSchema,
  priceArea: z.enum(['NO1', 'NO2', 'NO3', 'NO4', 'NO5']),
  consumptionGroup: z.enum(elhubPriceAreaGroups),
  quantityKwh: z.number().nonnegative(),
  lastUpdatedTime: z.string(),
  meteringPointCount: z.number().int().nonnegative(),
})

const envelope = {
  meta: z.strictObject({ created: z.string(), lastUpdated: z.string() }),
  links: z.strictObject({ self: z.string() }),
}

export const elhubMunicipalityDocumentSchema = z.strictObject({
  ...envelope,
  data: z.array(z.strictObject({
    type: z.literal('municipality'),
    id: z.string(),
    attributes: z.strictObject({
      municipalityNumber: z.string().regex(/^(\d{4}|\*)$/),
      name: z.string(),
      nameNo: z.string(),
      consumptionPerGroupMunicipalityHour: z.array(municipalityHourSchema),
    }),
  })),
})

export const elhubPriceAreaDocumentSchema = z.strictObject({
  ...envelope,
  data: z.array(z.strictObject({
    type: z.literal('price-areas'),
    id: z.string(),
    attributes: z.strictObject({
      name: z.string(),
      eic: z.string(),
      country: z.literal('NO'),
      consumptionPerGroupMbaHour: z.array(priceAreaHourSchema),
    }),
  })),
})

// Energy in one hour, MWh; numerically the mean demand in MW over that hour.
export interface ElhubMunicipalityHour {
  readonly municipalityNumber: string
  readonly municipalityName: string
  readonly startTime: string
  readonly startUtc: string
  readonly group: ElhubMunicipalityGroup
  readonly energyMwh: number
  readonly meteringPoints: number
}

export interface ElhubPriceAreaHour {
  readonly priceArea: PriceArea
  readonly startTime: string
  readonly startUtc: string
  readonly group: ElhubPriceAreaGroup
  readonly energyMwh: number
  readonly meteringPoints: number
}

const toUtc = (offsetTime: string): string => new Date(offsetTime).toISOString()

const assertOneHour = (label: string, startTime: string, endTime: string): void => {
  if (new Date(endTime).getTime() - new Date(startTime).getTime() !== 3_600_000) {
    throw new Error(`${label}: interval ${startTime}–${endTime} is not one hour`)
  }
}

const assertUniqueKeys = <T>(label: string, records: ReadonlyArray<T>, key: (record: T) => string): ReadonlyArray<T> => {
  const seen = new Set<string>()
  for (const record of records) {
    const value = key(record)
    if (seen.has(value)) throw new Error(`${label}: duplicate hourly value for ${value}`)
    seen.add(value)
  }
  return records
}

export const parseElhubMunicipalityDocument = (body: string): ReadonlyArray<ElhubMunicipalityHour> => assertUniqueKeys(
  elhubMunicipalitySourceId,
  parseDocument(elhubMunicipalitySourceId, elhubMunicipalityDocumentSchema, body).data.flatMap(entry =>
    entry.attributes.consumptionPerGroupMunicipalityHour.map((hour): ElhubMunicipalityHour => {
      if (entry.attributes.municipalityNumber === '*') throw new Error(`${elhubMunicipalitySourceId}: aggregate entry "*" carries hourly values`)
      assertOneHour(elhubMunicipalitySourceId, hour.startTime, hour.endTime)
      return {
        municipalityNumber: entry.attributes.municipalityNumber,
        municipalityName: entry.attributes.name,
        startTime: hour.startTime,
        startUtc: toUtc(hour.startTime),
        group: hour.consumptionGroup,
        energyMwh: hour.quantityKwh / 1000,
        meteringPoints: hour.meteringPointCount,
      }
    })),
  record => `${record.municipalityNumber} ${record.startUtc} ${record.group}`,
)

export const parseElhubPriceAreaDocument = (body: string): ReadonlyArray<ElhubPriceAreaHour> => assertUniqueKeys(
  elhubPriceAreaSourceId,
  parseDocument(elhubPriceAreaSourceId, elhubPriceAreaDocumentSchema, body).data.flatMap(entry =>
    entry.attributes.consumptionPerGroupMbaHour.map((hour): ElhubPriceAreaHour => {
      assertOneHour(elhubPriceAreaSourceId, hour.startTime, hour.endTime)
      return {
        priceArea: hour.priceArea,
        startTime: hour.startTime,
        startUtc: toUtc(hour.startTime),
        group: hour.consumptionGroup,
        energyMwh: hour.quantityKwh / 1000,
        meteringPoints: hour.meteringPointCount,
      }
    })),
  record => `${record.priceArea} ${record.startUtc} ${record.group}`,
)

const osloParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
})

const osloLocalHour = (instant: Date): string => {
  const parts = Object.fromEntries(osloParts.formatToParts(instant).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`
}

// Midnight of a local Oslo date as an offset timestamp, e.g. 2026-01-15T00:00:00+01:00.
export const osloMidnight = (date: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`osloMidnight: expected YYYY-MM-DD, got ${date}`)
  for (const offsetHours of [1, 2]) {
    const instant = new Date(`${date}T00:00:00+0${offsetHours}:00`)
    if (osloLocalHour(instant) === `${date}T00`) return `${date}T00:00:00+0${offsetHours}:00`
  }
  throw new Error(`osloMidnight: ${date} has no local midnight in Europe/Oslo`)
}

export const nextDate = (date: string): string => {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

export const elhubUrl = (config: {
  readonly collection: 'municipalities' | 'price-areas'
  readonly dataset: string
  readonly startDate: string
  readonly endDate: string
}): string =>
  `${elhubBaseUrl}/${config.collection}?dataset=${config.dataset}`
  + `&startDate=${encodeURIComponent(config.startDate)}&endDate=${encodeURIComponent(config.endDate)}`

export const fetchElhubMunicipalityDay = async (context: FetchContext, date: string): Promise<{
  readonly records: ReadonlyArray<ElhubMunicipalityHour>
  readonly document: RawDocument
}> => {
  const document = await fetchRegistryDocument(context, {
    sourceId: elhubMunicipalitySourceId,
    url: elhubUrl({ collection: 'municipalities', dataset: 'CONSUMPTION_PER_GROUP_MUNICIPALITY_HOUR', startDate: osloMidnight(date), endDate: osloMidnight(nextDate(date)) }),
    accept: 'application/json',
    licence: 'cc-by-4.0',
    attribution,
  })
  return { records: parseElhubMunicipalityDocument(document.body), document }
}

// Local Oslo dates, end exclusive.
export const fetchElhubPriceAreaRange = async (context: FetchContext, range: { readonly startDate: string; readonly endDate: string }): Promise<{
  readonly records: ReadonlyArray<ElhubPriceAreaHour>
  readonly document: RawDocument
}> => {
  const document = await fetchRegistryDocument(context, {
    sourceId: elhubPriceAreaSourceId,
    url: elhubUrl({ collection: 'price-areas', dataset: 'CONSUMPTION_PER_GROUP_MBA_HOUR', startDate: osloMidnight(range.startDate), endDate: osloMidnight(range.endDate) }),
    accept: 'application/json',
    licence: 'cc-by-4.0',
    attribution,
  })
  return { records: parseElhubPriceAreaDocument(document.body), document }
}

export const nationalHourlyTotalsMw = (records: ReadonlyArray<{ readonly startUtc: string; readonly energyMwh: number }>): ReadonlyMap<string, number> => {
  const totals = new Map<string, number>()
  for (const record of records) totals.set(record.startUtc, (totals.get(record.startUtc) ?? 0) + record.energyMwh)
  return totals
}

const isWeekday = (startTime: string): boolean => {
  const day = new Date(`${startTime.slice(0, 10)}T12:00:00Z`).getUTCDay()
  return day >= 1 && day <= 5
}

export interface ReferenceHourChoice {
  readonly startUtc: string
  readonly startTime: string
  readonly nationalMw: number
  readonly rule: string
}

// Winter weekday peak: the highest national hour on a local weekday (Mon–Fri) of the given records.
// Summer low: the lowest national hour of the given records.
export const selectReferenceHour = (
  records: ReadonlyArray<ElhubPriceAreaHour>,
  rule: 'weekday-peak' | 'lowest',
): ReferenceHourChoice => {
  const startTimeByUtc = new Map(records.map(record => [record.startUtc, record.startTime]))
  const candidates = [...nationalHourlyTotalsMw(records)]
    .filter(([startUtc]) => rule === 'lowest' || isWeekday(startTimeByUtc.get(startUtc)!))
    .sort((a, b) => (rule === 'lowest' ? a[1] - b[1] : b[1] - a[1]) || a[0].localeCompare(b[0]))
  const chosen = candidates[0]
  if (!chosen) throw new Error(`selectReferenceHour: no ${rule} candidate hours`)
  return {
    startUtc: chosen[0],
    startTime: startTimeByUtc.get(chosen[0])!,
    nationalMw: chosen[1],
    rule: rule === 'lowest' ? 'lowest national hour of the week' : 'highest national hour on a local weekday of the week',
  }
}
