import { z } from 'zod'
import { fetchRegistryDocument, parseDocument, type FetchContext, type LonLat, type RawDocument } from './registry-fetch.ts'

// Statistics Norway (SSB) residents on the 1 km × 1 km national grid ("Befolkning på rutenett",
// OGC API Features at kart.ssb.no), one year's dataset: every populated square with its total
// residents. Requested in CRS84 so each square is a lon/lat polygon; its centre is the mean of its
// four corners. SSB publishes its statistics under CC BY 4.0 (ssb.no/diverse/lisens).

export const ssbPopulationGridSourceId = 'ssb:befolkning-paa-rutenett-1km'
const apiBase = 'https://kart.ssb.no/api/ogc/v1/befolkning_paa_rutenett_ogc_api/collections'
const crs84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
const attribution = 'Statistisk sentralbyrå (SSB)'

/** The API's largest page, features. */
const pageSize = 1000
/** More pages than this is a runaway query (the 1 km grid holds about 55,000 populated squares). */
const maximumPages = 100

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

const pageSchema = z.object({
  numberMatched: z.number().int().nonnegative(),
  numberReturned: z.number().int().nonnegative(),
  features: z.array(z.object({
    geometry: z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(position).length(5)).length(1) }),
    properties: z.object({
      pop_tot: z.number().int().positive(),
      ssbid1000m: z.number().int().positive(),
    }),
  })),
})

export interface PopulationCell {
  /** SSB 1 km square id (lower-left UTM 33 easting + 2,000,000, then northing). */
  readonly id: string
  readonly centre: LonLat
  readonly population: number
}

export const pageUrl = (year: number, offset: number): string =>
  `${apiBase}/befolkning_1km_${year}/items?limit=${pageSize}&offset=${offset}&crs=${encodeURIComponent(crs84)}`

export const parsePopulationPage = (label: string, body: string): { readonly matched: number; readonly cells: ReadonlyArray<PopulationCell> } => {
  const page = parseDocument(label, pageSchema, body)
  if (page.numberReturned !== page.features.length) throw new Error(`${label}: numberReturned ${page.numberReturned} but ${page.features.length} features`)
  return {
    matched: page.numberMatched,
    cells: page.features.map(feature => {
      const corners = feature.geometry.coordinates[0]!.slice(0, 4)
      return {
        id: String(feature.properties.ssbid1000m),
        centre: [corners.reduce((sum, corner) => sum + corner[0], 0) / 4, corners.reduce((sum, corner) => sum + corner[1], 0) / 4] as const,
        population: feature.properties.pop_tot,
      }
    }),
  }
}

export const fetchSsbPopulationGrid = async (context: FetchContext, year: number): Promise<{
  readonly cells: ReadonlyArray<PopulationCell>
  readonly documents: ReadonlyArray<RawDocument>
}> => {
  const documents: RawDocument[] = []
  const cells: PopulationCell[] = []
  for (let page = 0; ; page += 1) {
    if (page >= maximumPages) throw new Error(`${ssbPopulationGridSourceId}: more than ${maximumPages} pages`)
    const document = await fetchRegistryDocument(context, {
      sourceId: ssbPopulationGridSourceId,
      url: pageUrl(year, page * pageSize),
      accept: 'application/geo+json',
      licence: 'cc-by-4.0',
      attribution,
    })
    const parsed = parsePopulationPage(`${ssbPopulationGridSourceId} page ${page}`, document.body)
    documents.push(document)
    cells.push(...parsed.cells)
    if (cells.length > parsed.matched) throw new Error(`${ssbPopulationGridSourceId}: ${cells.length} squares exceed the ${parsed.matched} matched`)
    if (parsed.cells.length < pageSize || cells.length === parsed.matched) {
      if (cells.length !== parsed.matched) throw new Error(`${ssbPopulationGridSourceId}: ${cells.length} squares read, ${parsed.matched} matched`)
      break
    }
  }
  const ids = new Set(cells.map(cell => cell.id))
  if (ids.size !== cells.length) throw new Error(`${ssbPopulationGridSourceId}: duplicate square ids`)
  return { cells: [...cells].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0), documents }
}
