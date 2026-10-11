import { z } from 'zod'
import { fetchRegistryDocument, parseDocument, type FetchContext, type RawDocument } from './registry-fetch.ts'

// Gross head of each hydropower plant in operation from NVE's hydropower API
// (BruttoFallhoyde_M, metres), joined to the hydro snapshot by NVE plant number. NVE licenses the
// data on api.nve.no under NLOD (nve.no/om-nve/apne-data-og-api-fra-nve).

export const nveHydroHeadsSourceId = 'nve:api-hydro-plants-in-operation'
const url = 'https://api.nve.no/web/Powerplant/GetHydroPowerPlantsInOperation'

const plantsSchema = z.array(z.looseObject({
  VannKraftverkID: z.number().int().positive(),
  BruttoFallhoyde_M: z.number().finite().nullable(),
})).min(1)

export interface HydroHead {
  readonly plantNumber: number
  readonly grossHeadM: number
}

/** Plants with a published positive gross head, by plant number. */
export const parseHydroHeads = (label: string, body: string): ReadonlyArray<HydroHead> => {
  const plants = parseDocument(label, plantsSchema, body)
  const numbers = new Set(plants.map(plant => plant.VannKraftverkID))
  if (numbers.size !== plants.length) throw new Error(`${label}: duplicate VannKraftverkID`)
  return plants
    .flatMap(plant => plant.BruttoFallhoyde_M === null || plant.BruttoFallhoyde_M <= 0 ? [] : [{ plantNumber: plant.VannKraftverkID, grossHeadM: plant.BruttoFallhoyde_M }])
    .sort((left, right) => left.plantNumber - right.plantNumber)
}

export const fetchNveHydroHeads = async (context: FetchContext): Promise<{ readonly heads: ReadonlyArray<HydroHead>; readonly document: RawDocument }> => {
  const document = await fetchRegistryDocument(context, {
    sourceId: nveHydroHeadsSourceId,
    url,
    accept: 'application/json',
    licence: 'nlod-2.0',
    attribution: 'Norges vassdrags- og energidirektorat (NVE)',
  })
  return { heads: parseHydroHeads(nveHydroHeadsSourceId, document.body), document }
}
