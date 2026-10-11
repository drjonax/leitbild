import { z } from 'zod'
import { pointInPolygon } from '../../../reference-data/point-in-polygon.ts'
import type { GeoJsonGeometry } from '../../../reference-data/types.ts'
import { fetchArcGisPages, parseDocument, type FetchContext, type LonLat, type PriceArea, type RawDocument } from './registry-fetch.ts'

// NVE Nettomraader layer 0 "Budomraade": the five Norwegian bidding-zone (price-area) polygons.
// NLOD 2.0.

export const nveBiddingZonesSourceId = 'nve:nettomraader-budomraade'
export const nveBiddingZonesLayerUrl = 'https://kart.nve.no/enterprise/rest/services/Nettomraader/MapServer/0'

const positionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
const ringSchema = z.array(positionSchema).min(4)

const zoneFeatureSchema = z.strictObject({
  type: z.literal('Feature'),
  id: z.number().int(),
  geometry: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('Polygon'), coordinates: z.array(ringSchema).min(1) }),
    z.strictObject({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ringSchema).min(1)).min(1) }),
  ]),
  properties: z.strictObject({
    objectid: z.number().int(),
    budomr: z.enum(['NO 1', 'NO 2', 'NO 3', 'NO 4', 'NO 5']),
  }),
})

export const biddingZonePageSchema = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(zoneFeatureSchema),
  exceededTransferLimit: z.boolean().optional(),
  properties: z.strictObject({ exceededTransferLimit: z.boolean() }).optional(),
})

export interface BiddingZone {
  readonly priceArea: PriceArea
  readonly geometry: Extract<GeoJsonGeometry, { readonly type: 'Polygon' | 'MultiPolygon' }>
}

export const parseBiddingZonePage = (body: string): z.infer<typeof biddingZonePageSchema> =>
  parseDocument(nveBiddingZonesSourceId, biddingZonePageSchema, body)

export const biddingZonesFromPages = (pages: ReadonlyArray<z.infer<typeof biddingZonePageSchema>>): ReadonlyArray<BiddingZone> => {
  const zones = pages.flatMap(page => page.features).map((feature): BiddingZone => ({
    priceArea: feature.properties.budomr.replace(' ', '') as PriceArea,
    geometry: feature.geometry,
  }))
  const areas = zones.map(zone => zone.priceArea).sort()
  if (areas.join(',') !== 'NO1,NO2,NO3,NO4,NO5') {
    throw new Error(`${nveBiddingZonesSourceId}: expected exactly one polygon per price area NO1–NO5, got ${areas.join(',')}`)
  }
  return zones.sort((a, b) => a.priceArea.localeCompare(b.priceArea))
}

export const priceAreasContaining = (zones: ReadonlyArray<BiddingZone>, point: LonLat): ReadonlyArray<PriceArea> =>
  zones.filter(zone => pointInPolygon(point, zone.geometry)).map(zone => zone.priceArea)

export const fetchNveBiddingZones = async (context: FetchContext): Promise<{
  readonly zones: ReadonlyArray<BiddingZone>
  readonly documents: ReadonlyArray<RawDocument>
}> => {
  const documents = await fetchArcGisPages(context, {
    sourceId: nveBiddingZonesSourceId,
    layerUrl: nveBiddingZonesLayerUrl,
    outFields: ['objectid', 'budomr'],
    where: '1=1',
    pageSize: 100,
    maximumPages: 1,
    licence: 'nlod-2.0',
    attribution: 'Norges vassdrags- og energidirektorat (NVE)',
    hasMore: body => parseBiddingZonePage(body).exceededTransferLimit === true,
  })
  return { zones: biddingZonesFromPages(documents.map(document => parseBiddingZonePage(document.body))), documents }
}
