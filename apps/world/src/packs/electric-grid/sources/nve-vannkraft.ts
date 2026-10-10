import { z } from 'zod'
import {
  fetchArcGisPages,
  haversineKm,
  parseDocument,
  type FetchContext,
  type LonLat,
  type RawDocument,
} from './registry-fetch.ts'

// NVE Vannkraft1 layer 0 "Vannkraftverk": one point per hydropower plant with NVE's plant number
// (vannkraftverknr), capacity, owner and municipality. NLOD 2.0.

export const nveVannkraftSourceId = 'nve:vannkraft1-vannkraftverk'
export const nveVannkraftLayerUrl = 'https://kart.nve.no/enterprise/rest/services/Vannkraft1/MapServer/0'

const outFields = [
  'objectid',
  'vannkraftverknr',
  'vannkraftverknavn',
  'vannkraftverktype',
  'status',
  'idriftsattaar',
  'maksytelse_mw',
  'vannkraftverkeier',
  'kommunenummer',
  'kommunenavn',
  'fylke',
] as const

// Plants that straddle a river border are registered once per bank; the points observed lie within
// 0.6 km of each other. A larger spread means two different plants share a number.
const maximumDuplicatePointSpreadKm = 2

const lonLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

const vannkraftFeatureSchema = z.strictObject({
  type: z.literal('Feature'),
  id: z.number().int(),
  geometry: z.strictObject({ type: z.literal('Point'), coordinates: lonLatSchema }),
  properties: z.strictObject({
    objectid: z.number().int(),
    vannkraftverknr: z.number().int().positive(),
    vannkraftverknavn: z.string().min(1),
    vannkraftverktype: z.string().min(1),
    status: z.string().regex(/^[A-Z]$/),
    idriftsattaar: z.number().int().nullable(),
    maksytelse_mw: z.number(),
    vannkraftverkeier: z.string().nullable(),
    // Empty for the plants NVE registers on the Swedish side of the border (Linvasselv, Sylsjø).
    kommunenummer: z.union([z.string().regex(/^\d{4}$/), z.literal('')]).nullable(),
    kommunenavn: z.string().nullable(),
    fylke: z.string().nullable(),
  }),
}).refine(
  // NVE registers pumps (type P) with their pumping demand as negative capacity.
  feature => (feature.properties.vannkraftverktype === 'P') === (feature.properties.maksytelse_mw < 0),
  { message: 'maksytelse_mw must be negative exactly for pumps (vannkraftverktype P)' },
)

export const vannkraftPageSchema = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(vannkraftFeatureSchema),
  exceededTransferLimit: z.boolean().optional(),
  properties: z.strictObject({ exceededTransferLimit: z.boolean() }).optional(),
})

type VannkraftFeature = z.infer<typeof vannkraftFeatureSchema>

export interface NveHydroRegistryPlant {
  readonly plantNumber: number
  readonly name: string
  readonly registryType: string
  readonly status: string
  readonly commissionedYear: number | null
  // Signed as NVE publishes it: negative for pumps (registryType 'P').
  readonly capacityMw: number
  readonly owner: string | null
  readonly municipalityNumbers: ReadonlyArray<string>
  readonly county: string | null
  readonly location: LonLat
  readonly registryPoints: ReadonlyArray<{ readonly objectId: number; readonly location: LonLat }>
}

export const parseVannkraftPage = (body: string): z.infer<typeof vannkraftPageSchema> =>
  parseDocument(nveVannkraftSourceId, vannkraftPageSchema, body)

const meanLocation = (points: ReadonlyArray<LonLat>): LonLat => [
  points.reduce((sum, point) => sum + point[0], 0) / points.length,
  points.reduce((sum, point) => sum + point[1], 0) / points.length,
]

const assertSameAttribute = (plantNumber: number, label: string, values: ReadonlyArray<unknown>): void => {
  if (new Set(values.map(value => JSON.stringify(value))).size > 1) {
    throw new Error(`${nveVannkraftSourceId}: plant ${plantNumber} has conflicting ${label} across its points: ${values.map(value => JSON.stringify(value)).join(', ')}`)
  }
}

const plantFromFeatures = (plantNumber: number, features: ReadonlyArray<VannkraftFeature>): NveHydroRegistryPlant => {
  const first = features[0]
  if (!first) throw new Error(`${nveVannkraftSourceId}: plant ${plantNumber} has no points`)
  assertSameAttribute(plantNumber, 'name', features.map(feature => feature.properties.vannkraftverknavn))
  assertSameAttribute(plantNumber, 'capacity', features.map(feature => feature.properties.maksytelse_mw))
  assertSameAttribute(plantNumber, 'type', features.map(feature => feature.properties.vannkraftverktype))
  assertSameAttribute(plantNumber, 'status', features.map(feature => feature.properties.status))
  const points = features.map(feature => feature.geometry.coordinates)
  const spreadKm = Math.max(...points.flatMap(a => points.map(b => haversineKm(a, b))))
  if (spreadKm > maximumDuplicatePointSpreadKm) {
    throw new Error(`${nveVannkraftSourceId}: plant ${plantNumber} has points ${spreadKm.toFixed(2)} km apart (limit ${maximumDuplicatePointSpreadKm} km)`)
  }
  const props = first.properties
  return {
    plantNumber,
    name: props.vannkraftverknavn,
    registryType: props.vannkraftverktype,
    status: props.status,
    commissionedYear: props.idriftsattaar,
    capacityMw: props.maksytelse_mw,
    owner: props.vannkraftverkeier,
    municipalityNumbers: [...new Set(features.flatMap(feature => {
      const number = feature.properties.kommunenummer
      return number === null || number === '' ? [] : [number]
    }))].sort(),
    county: props.fylke === '' ? null : props.fylke,
    location: meanLocation(points),
    registryPoints: features.map(feature => ({ objectId: feature.properties.objectid, location: feature.geometry.coordinates })),
  }
}

export const groupVannkraftPlants = (pages: ReadonlyArray<z.infer<typeof vannkraftPageSchema>>): ReadonlyArray<NveHydroRegistryPlant> => {
  const byPlant = new Map<number, VannkraftFeature[]>()
  for (const feature of pages.flatMap(page => page.features)) {
    const plantNumber = feature.properties.vannkraftverknr
    const existing = byPlant.get(plantNumber)
    if (existing) existing.push(feature)
    else byPlant.set(plantNumber, [feature])
  }
  return [...byPlant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([plantNumber, features]) => plantFromFeatures(plantNumber, features))
}

export const fetchNveVannkraft = async (context: FetchContext): Promise<{
  readonly plants: ReadonlyArray<NveHydroRegistryPlant>
  readonly documents: ReadonlyArray<RawDocument>
}> => {
  const documents = await fetchArcGisPages(context, {
    sourceId: nveVannkraftSourceId,
    layerUrl: nveVannkraftLayerUrl,
    outFields,
    where: '1=1',
    pageSize: 2000,
    maximumPages: 10,
    licence: 'nlod-2.0',
    attribution: 'Norges vassdrags- og energidirektorat (NVE)',
    hasMore: body => parseVannkraftPage(body).exceededTransferLimit === true,
  })
  return { plants: groupVannkraftPlants(documents.map(document => parseVannkraftPage(document.body))), documents }
}
