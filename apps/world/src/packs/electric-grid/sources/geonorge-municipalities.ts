import { z } from 'zod'
import { fetchRegistryDocument, parseDocument, type FetchContext, type LonLat, type RawDocument } from './registry-fetch.ts'

// Kartverket kommuneinfo API (Geonorge): the current municipality list and, per municipality, a
// representative point guaranteed to lie inside it (punktIOmrade, ETRS89 / EPSG:4258, which agrees
// with WGS84 to well under a metre in Norway). Kartverket licenses its open data under CC BY 4.0.

export const kartverketMunicipalitiesSourceId = 'kartverket:kommuneinfo-kommuner'
export const kartverketMunicipalityDetailSourceId = 'kartverket:kommuneinfo-kommune'
const kommuneinfoBaseUrl = 'https://api.kartverket.no/kommuneinfo/v1'
const attribution = 'Kartverket'

// The API asks clients not to bulk-download; detail requests run with this many in flight.
const detailConcurrency = 3

const municipalityNumberSchema = z.string().regex(/^\d{4}$/)
const etrs89CrsSchema = z.strictObject({ properties: z.strictObject({ name: z.literal('EPSG:4258') }), type: z.literal('name') })

export const kommuneListSchema = z.array(z.strictObject({
  kommunenavn: z.string().min(1),
  kommunenavnNorsk: z.string().min(1),
  kommunenummer: municipalityNumberSchema,
}))

export const kommuneDetailSchema = z.strictObject({
  avgrensningsboks: z.strictObject({
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
    crs: etrs89CrsSchema,
    type: z.literal('Polygon'),
  }),
  fylkesnavn: z.string().min(1),
  fylkesnummer: z.string().regex(/^\d{2}$/),
  gyldigeNavn: z.array(z.strictObject({ navn: z.string().nullable(), prioritet: z.number().int(), sprak: z.string().nullable() })),
  kommunenavn: z.string().min(1),
  kommunenavnNorsk: z.string().min(1),
  kommunenummer: municipalityNumberSchema,
  punktIOmrade: z.strictObject({
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    crs: etrs89CrsSchema,
    type: z.literal('Point'),
  }),
  samiskForvaltningsomrade: z.boolean(),
})

export interface Municipality {
  readonly municipalityNumber: string
  readonly name: string
  readonly countyNumber: string
  readonly countyName: string
  readonly point: LonLat
  readonly bbox: readonly [west: number, south: number, east: number, north: number]
}

export const parseKommuneList = (body: string): ReadonlyArray<{ readonly municipalityNumber: string; readonly name: string }> =>
  parseDocument(kartverketMunicipalitiesSourceId, kommuneListSchema, body)
    .map(entry => ({ municipalityNumber: entry.kommunenummer, name: entry.kommunenavnNorsk }))
    .sort((a, b) => a.municipalityNumber.localeCompare(b.municipalityNumber))

export const parseKommuneDetail = (expectedNumber: string, body: string): Municipality => {
  const detail = parseDocument(`${kartverketMunicipalityDetailSourceId}/${expectedNumber}`, kommuneDetailSchema, body)
  if (detail.kommunenummer !== expectedNumber) {
    throw new Error(`${kartverketMunicipalityDetailSourceId}: requested ${expectedNumber}, received ${detail.kommunenummer}`)
  }
  const ring = detail.avgrensningsboks.coordinates.flat()
  return {
    municipalityNumber: detail.kommunenummer,
    name: detail.kommunenavnNorsk,
    countyNumber: detail.fylkesnummer,
    countyName: detail.fylkesnavn,
    point: detail.punktIOmrade.coordinates,
    bbox: [
      Math.min(...ring.map(position => position[0])),
      Math.min(...ring.map(position => position[1])),
      Math.max(...ring.map(position => position[0])),
      Math.max(...ring.map(position => position[1])),
    ],
  }
}

const mapWithConcurrency = async <T, R>(items: ReadonlyArray<T>, limit: number, task: (item: T) => Promise<R>): Promise<ReadonlyArray<R>> => {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export const fetchKartverketMunicipalities = async (context: FetchContext): Promise<{
  readonly municipalities: ReadonlyArray<Municipality>
  readonly documents: ReadonlyArray<RawDocument>
}> => {
  const listDocument = await fetchRegistryDocument(context, {
    sourceId: kartverketMunicipalitiesSourceId,
    url: `${kommuneinfoBaseUrl}/kommuner`,
    accept: 'application/json',
    licence: 'cc-by-4.0',
    attribution,
  })
  const list = parseKommuneList(listDocument.body)
  const details = await mapWithConcurrency(list, detailConcurrency, async entry => {
    const document = await fetchRegistryDocument(context, {
      sourceId: kartverketMunicipalityDetailSourceId,
      url: `${kommuneinfoBaseUrl}/kommuner/${entry.municipalityNumber}`,
      accept: 'application/json',
      licence: 'cc-by-4.0',
      attribution,
    })
    return { document, municipality: parseKommuneDetail(entry.municipalityNumber, document.body) }
  })
  return {
    municipalities: details.map(detail => detail.municipality),
    documents: [listDocument, ...details.map(detail => detail.document)],
  }
}
