import { z } from 'zod'
import { fetchArcGisPages, parseDocument, type FetchContext, type LonLat, type RawDocument } from './registry-fetch.ts'

// NVE Vindkraft2: licensed wind farms as points keyed by NVE's facility number (anleggsnr). Layer 0
// "Vindkraft_utbygd" holds built farms; layer 7 "Vindkraft_konsesjon_gitt" holds every farm with a
// granted licence, including decommissioned ones. A farm takes its point from layer 0 when present
// there and from layer 7 otherwise; the record names the layer. NLOD 2.0.

export const nveVindkraftSourceId = 'nve:vindkraft2'
export const nveVindkraftServiceUrl = 'https://kart.nve.no/enterprise/rest/services/Vindkraft2/MapServer'

export type VindkraftLayer = 'built' | 'licence-granted'

const layers: ReadonlyArray<{ readonly id: number; readonly layer: VindkraftLayer }> = [
  { id: 0, layer: 'built' },
  { id: 7, layer: 'licence-granted' },
]

const outFields = [
  'objectid',
  'anleggsnr',
  'anleggnavn',
  'status',
  'effekt_mw',
  'effekt_mw_idrift',
  'antallturbiner',
  'forsteidriftdato',
  'utavdriftdato',
  'kommune',
  'fylkenavn',
  'lokalisering',
  'eier',
] as const

const lonLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
const epochMillisSchema = z.number().int()

const vindkraftFeatureSchema = z.strictObject({
  type: z.literal('Feature'),
  id: z.number().int(),
  geometry: z.strictObject({ type: z.literal('Point'), coordinates: lonLatSchema }),
  properties: z.strictObject({
    objectid: z.number().int(),
    anleggsnr: z.number().int().positive(),
    anleggnavn: z.string().min(1),
    status: z.string().regex(/^[A-Z]$/),
    effekt_mw: z.number().nonnegative().nullable(),
    effekt_mw_idrift: z.number().nonnegative().nullable(),
    antallturbiner: z.number().int().nonnegative().nullable(),
    forsteidriftdato: epochMillisSchema.nullable(),
    utavdriftdato: epochMillisSchema.nullable(),
    kommune: z.string(),
    fylkenavn: z.string(),
    lokalisering: z.string().nullable(),
    eier: z.string(),
  }),
})

export const vindkraftPageSchema = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z.array(vindkraftFeatureSchema),
  exceededTransferLimit: z.boolean().optional(),
  properties: z.strictObject({ exceededTransferLimit: z.boolean() }).optional(),
})

export interface NveWindRegistryFarm {
  readonly plantNumber: number
  readonly name: string
  readonly layer: VindkraftLayer
  readonly status: string
  readonly licensedMw: number | null
  readonly inOperationMw: number | null
  readonly turbineCount: number | null
  readonly firstInOperation: string | null
  readonly outOfOperation: string | null
  readonly municipalityNumbers: ReadonlyArray<string>
  readonly municipalityName: string
  readonly county: string
  readonly owner: string
  readonly location: LonLat
}

export const parseVindkraftPage = (body: string): z.infer<typeof vindkraftPageSchema> =>
  parseDocument(nveVindkraftSourceId, vindkraftPageSchema, body)

const isoDate = (epochMillis: number | null): string | null =>
  epochMillis === null ? null : new Date(epochMillis).toISOString().slice(0, 10)

// `lokalisering` carries the municipality number, as a comma-separated list for farms that span
// a municipal border.
const municipalityNumbersOf = (lokalisering: string | null): ReadonlyArray<string> => {
  if (lokalisering === null) return []
  const numbers = lokalisering.split(',').map(part => part.trim())
  for (const number of numbers) {
    if (!/^\d{4}$/.test(number)) throw new Error(`${nveVindkraftSourceId}: unexpected lokalisering ${JSON.stringify(lokalisering)}`)
  }
  return numbers
}

const farmOf = (layer: VindkraftLayer, feature: z.infer<typeof vindkraftFeatureSchema>): NveWindRegistryFarm => {
  const props = feature.properties
  return {
    plantNumber: props.anleggsnr,
    name: props.anleggnavn,
    layer,
    status: props.status,
    licensedMw: props.effekt_mw,
    inOperationMw: props.effekt_mw_idrift,
    turbineCount: props.antallturbiner,
    firstInOperation: isoDate(props.forsteidriftdato),
    outOfOperation: isoDate(props.utavdriftdato),
    municipalityNumbers: municipalityNumbersOf(props.lokalisering),
    municipalityName: props.kommune,
    county: props.fylkenavn,
    owner: props.eier,
    location: feature.geometry.coordinates,
  }
}

export const mergeVindkraftLayers = (
  pagesByLayer: ReadonlyArray<{ readonly layer: VindkraftLayer; readonly pages: ReadonlyArray<z.infer<typeof vindkraftPageSchema>> }>,
): ReadonlyArray<NveWindRegistryFarm> => {
  const farms = new Map<number, NveWindRegistryFarm>()
  for (const layer of layers) {
    const entry = pagesByLayer.find(candidate => candidate.layer === layer.layer)
    if (!entry) throw new Error(`${nveVindkraftSourceId}: missing pages for layer ${layer.layer}`)
    const seenInLayer = new Set<number>()
    for (const feature of entry.pages.flatMap(page => page.features)) {
      const plantNumber = feature.properties.anleggsnr
      if (seenInLayer.has(plantNumber)) throw new Error(`${nveVindkraftSourceId}: plant ${plantNumber} appears twice in layer ${layer.layer}`)
      seenInLayer.add(plantNumber)
      if (!farms.has(plantNumber)) farms.set(plantNumber, farmOf(layer.layer, feature))
    }
  }
  return [...farms.values()].sort((a, b) => a.plantNumber - b.plantNumber)
}

export const fetchNveVindkraft = async (context: FetchContext): Promise<{
  readonly farms: ReadonlyArray<NveWindRegistryFarm>
  readonly documents: ReadonlyArray<RawDocument>
}> => {
  const fetched = []
  for (const layer of layers) {
    const documents = await fetchArcGisPages(context, {
      sourceId: `${nveVindkraftSourceId}-layer-${layer.id}`,
      layerUrl: `${nveVindkraftServiceUrl}/${layer.id}`,
      outFields,
      where: '1=1',
      pageSize: 2000,
      maximumPages: 5,
      licence: 'nlod-2.0',
      attribution: 'Norges vassdrags- og energidirektorat (NVE)',
      hasMore: body => parseVindkraftPage(body).exceededTransferLimit === true,
    })
    fetched.push({ layer: layer.layer, documents })
  }
  return {
    farms: mergeVindkraftLayers(fetched.map(entry => ({
      layer: entry.layer,
      pages: entry.documents.map(document => parseVindkraftPage(document.body)),
    }))),
    documents: fetched.flatMap(entry => entry.documents),
  }
}
