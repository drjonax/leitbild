import { z } from 'zod'
import type { NveHydroRegistryPlant } from './nve-vannkraft.ts'
import type { NveWindRegistryFarm, VindkraftLayer } from './nve-vindkraft.ts'
import {
  fetchRegistryDocument,
  parseDocument,
  type FetchContext,
  type LonLat,
  type PriceArea,
  type RawDocument,
} from './registry-fetch.ts'

// NVE's power-plant statistics API: every hydropower plant and wind farm in operation with its
// capacity, mean annual production and price area. Records are joined to the Vannkraft1 and
// Vindkraft2 registry points by NVE plant number only, never by name. NLOD 2.0.

export const nveHydroStatsSourceId = 'nve:api-hydro-plants-in-operation'
export const nveWindStatsSourceId = 'nve:api-wind-plants-in-operation'
export const nveHydroStatsUrl = 'https://api.nve.no/web/Powerplant/GetHydroPowerPlantsInOperation'
export const nveWindStatsUrl = 'https://api.nve.no/web/WindPowerplant/GetWindPowerPlantsInOperation'

const priceAreaNumberSchema = z.enum(['1', '2', '3', '4', '5'])
const priceAreaOf = (number: z.infer<typeof priceAreaNumberSchema>): PriceArea => `NO${number}`

const hydroOwnerSchema = z.strictObject({
  AdressatID: z.number().int(),
  Driftselskap: z.boolean(),
  Hovedeier: z.boolean(),
  Navn: z.string(),
  OrgNr: z.number().int().nullable(),
  ProsentAndel: z.number().nullable(),
  ProsentAndelDrift: z.number().nullable(),
})

const hydroStatsRecordSchema = z.strictObject({
  VannKraftverkID: z.number().int().positive(),
  Navn: z.string().min(1),
  VannKVType: z.string().min(1),
  VannKVTypeID: z.enum(['K', 'PK', 'P']),
  HovedEier: z.string(),
  HovedEier_OrgNr: z.string(),
  Fylke: z.string().min(1),
  FylkesNr: z.string().regex(/^\d{2}$/),
  Kommune: z.string().min(1),
  KommuneNr: z.string().regex(/^\d{2}$/),
  ForsteUtnyttelseAvFalletDato: z.number().int().nullable(),
  DatoForEldsteKraftproduserendeDel: z.number().int().nullable(),
  MaksYtelse: z.number(),
  MidProd_91_20: z.number(),
  BruttoFallhoyde_M: z.number().nullable(),
  Slukeevne: z.number().nullable(),
  EnEkv: z.number().nullable(),
  ElspotomraadeNummer: priceAreaNumberSchema,
  RegineNr: z.string(),
  ErIDrift: z.literal(true),
  IDriftDato: z.string().regex(/^\d{4}-\d{2}-\d{2}T/).nullable(),
  Eiere: z.array(hydroOwnerSchema),
  Konsesjoner: z.array(z.strictObject({ KdbID: z.number().int(), Tittel: z.string() })),
  Kraftverkstatus: z.literal('Idrift'),
  NVEOmraadeID: z.number().int().nullable(),
  NVEOmraadeNavn: z.string().nullable(),
  Nedborsfeltnavn: z.string().nullable(),
  SPPunkt: z.string().nullable(),
  SPSone: z.string().nullable(),
  UnderBygging: z.boolean(),
  UteAvDrift: z.string().nullable(),
  VassdragsOmraadeID: z.number().int().nullable(),
  VassdragsOmraadeNavn: z.string().nullable(),
}).refine(
  // Pumps (VannKVTypeID P) are published with their pumping demand as negative capacity.
  record => (record.VannKVTypeID === 'P') === (record.MaksYtelse < 0),
  { message: 'MaksYtelse must be negative exactly for pumps (VannKVTypeID P)' },
)

const windTurbineGroupSchema = z.strictObject({
  AnlKonsNr_Vind: z.number().int().nullable(),
  AntallTurbiner: z.number().int().nonnegative(),
  DatoIdriftsatt: z.string().nullable(),
  DatoUtavdrift: z.string().nullable(),
  ForventetProd_NormalAAr_GWh: z.number().nullable(),
  KR_Saksid: z.number().int().nullable(),
  TurbinID: z.number().int(),
  TurbinProdusent: z.string().nullable(),
  TurbinStorrelse_kW: z.number().nullable(),
  TurbinType: z.string().nullable(),
  TurbintypeID: z.number().int().nullable(),
})

const windStatsRecordSchema = z.strictObject({
  VindkraftAnleggId: z.number().int().positive(),
  Navn: z.string().min(1),
  IdriftsettelseForsteByggetrinn: z.string().regex(/^\d{4}-\d{2}-\d{2}T/).nullable(),
  AnleggsNr: z.number().int().positive(),
  InstallertEffekt_MW: z.number().positive(),
  HovedEierNavn: z.string(),
  HovedEierOrgNr: z.string(),
  ElspotomraadeNummer: priceAreaNumberSchema,
  Fylke: z.string(),
  Kommune: z.string(),
  NormalAArsproduksjon_GWh: z.number().nonnegative(),
  Turbiner: z.array(windTurbineGroupSchema),
  GjsnittGeneratorytelse: z.number().nullable(),
  GjsnittNavhoeyde: z.number().nullable(),
  GjsnittRotordiameter: z.number().nullable(),
  EnergiPerSveiptAreal: z.number().nullable(),
  AntallOperativeTurbiner: z.number().int().nonnegative(),
})

export const hydroStatsDocumentSchema = z.array(hydroStatsRecordSchema)
export const windStatsDocumentSchema = z.array(windStatsRecordSchema)

export type HydroUnitKind = 'generating' | 'pumped-storage' | 'pump'

const hydroKindOf: Readonly<Record<'K' | 'PK' | 'P', HydroUnitKind>> = { K: 'generating', PK: 'pumped-storage', P: 'pump' }

export interface NveHydroStats {
  readonly plantNumber: number
  readonly name: string
  readonly kind: HydroUnitKind
  // Signed as NVE publishes it: negative for pumps.
  readonly maxOutputMw: number
  readonly meanAnnualProductionGwh: number
  readonly priceArea: PriceArea
  readonly owner: string
  readonly municipalityNumber: string
  readonly municipalityName: string
  readonly inOperationSince: string | null
  readonly grossHeadM: number | null
}

export interface NveWindStats {
  readonly farmId: number
  readonly plantNumber: number
  readonly name: string
  readonly installedMw: number
  readonly normalAnnualProductionGwh: number
  readonly priceArea: PriceArea
  readonly owner: string
  readonly municipalityName: string
  readonly firstStageInOperation: string | null
  readonly operativeTurbines: number
  readonly meanTurbineRatingKw: number | null
  readonly meanHubHeightM: number | null
  readonly meanRotorDiameterM: number | null
}

export const parseHydroStats = (body: string): ReadonlyArray<NveHydroStats> =>
  parseDocument(nveHydroStatsSourceId, hydroStatsDocumentSchema, body).map(record => ({
    plantNumber: record.VannKraftverkID,
    name: record.Navn,
    kind: hydroKindOf[record.VannKVTypeID],
    maxOutputMw: record.MaksYtelse,
    meanAnnualProductionGwh: record.MidProd_91_20,
    priceArea: priceAreaOf(record.ElspotomraadeNummer),
    owner: record.HovedEier,
    // The API splits the 2024 municipality number into county and municipality parts.
    municipalityNumber: `${record.FylkesNr}${record.KommuneNr}`,
    municipalityName: record.Kommune,
    inOperationSince: record.IDriftDato === null ? null : record.IDriftDato.slice(0, 10),
    grossHeadM: record.BruttoFallhoyde_M,
  }))

export const parseWindStats = (body: string): ReadonlyArray<NveWindStats> =>
  parseDocument(nveWindStatsSourceId, windStatsDocumentSchema, body).map(record => ({
    farmId: record.VindkraftAnleggId,
    plantNumber: record.AnleggsNr,
    name: record.Navn,
    installedMw: record.InstallertEffekt_MW,
    normalAnnualProductionGwh: record.NormalAArsproduksjon_GWh,
    priceArea: priceAreaOf(record.ElspotomraadeNummer),
    owner: record.HovedEierNavn,
    municipalityName: record.Kommune,
    firstStageInOperation: record.IdriftsettelseForsteByggetrinn === null ? null : record.IdriftsettelseForsteByggetrinn.slice(0, 10),
    operativeTurbines: record.AntallOperativeTurbiner,
    meanTurbineRatingKw: record.GjsnittGeneratorytelse,
    meanHubHeightM: record.GjsnittNavhoeyde,
    meanRotorDiameterM: record.GjsnittRotordiameter,
  }))

export interface NveHydroPlant {
  readonly plantNumber: number
  readonly name: string
  readonly kind: HydroUnitKind
  // Magnitude in MW: generating capacity, or pumping demand for kind 'pump'.
  readonly capacityMw: number
  readonly meanAnnualProductionGwh: number
  readonly priceArea: PriceArea
  readonly owner: string
  readonly municipalityNumber: string
  readonly inOperationSince: string | null
  readonly location: LonLat
  readonly registryType: string
  readonly registryPointCount: number
  readonly registryMunicipalityNumbers: ReadonlyArray<string>
}

export interface NveWindFarm {
  readonly farmId: number
  readonly plantNumber: number
  readonly name: string
  readonly installedMw: number
  readonly normalAnnualProductionGwh: number
  readonly priceArea: PriceArea
  readonly owner: string
  readonly firstStageInOperation: string | null
  readonly operativeTurbines: number
  readonly location: LonLat
  readonly locationLayer: VindkraftLayer
  readonly registryName: string
  readonly registryStatus: string
  readonly registryInOperationMw: number | null
  readonly registryOutOfOperation: string | null
  readonly registryMunicipalityNumbers: ReadonlyArray<string>
  // Farm ids that share this NVE plant number (one Vindkraft2 point for several build-out stages).
  readonly sharedPlantNumberFarmIds: ReadonlyArray<number>
}

export interface RegistryJoinIssue {
  readonly plantNumber: number
  readonly issue: string
}

const assertUnique = (label: string, ids: ReadonlyArray<number>): void => {
  const seen = new Set<number>()
  const duplicates = ids.filter(id => (seen.has(id) ? true : (seen.add(id), false)))
  if (duplicates.length > 0) throw new Error(`${label}: duplicate ids ${[...new Set(duplicates)].join(', ')}`)
}

// Capacity agreement between the registry point and the statistics record, in MW.
const capacityToleranceMw = 0.01

export const joinHydroPlants = (
  stats: ReadonlyArray<NveHydroStats>,
  registry: ReadonlyArray<NveHydroRegistryPlant>,
): { readonly plants: ReadonlyArray<NveHydroPlant>; readonly issues: ReadonlyArray<RegistryJoinIssue> } => {
  assertUnique(nveHydroStatsSourceId, stats.map(record => record.plantNumber))
  const byNumber = new Map(registry.map(plant => [plant.plantNumber, plant]))
  const missing = stats.filter(record => !byNumber.has(record.plantNumber))
  if (missing.length > 0) {
    throw new Error(`hydro join: ${missing.length} plants in operation have no Vannkraft1 point: ${missing.slice(0, 20).map(record => `${record.plantNumber} ${record.name}`).join('; ')}`)
  }
  const issues: RegistryJoinIssue[] = []
  const plants = stats.map((record): NveHydroPlant => {
    const point = byNumber.get(record.plantNumber)!
    if (Math.abs(point.capacityMw - record.maxOutputMw) > capacityToleranceMw) {
      issues.push({ plantNumber: record.plantNumber, issue: `capacity ${record.maxOutputMw} MW in statistics, ${point.capacityMw} MW in Vannkraft1` })
    }
    if (point.name !== record.name) {
      issues.push({ plantNumber: record.plantNumber, issue: `name "${record.name}" in statistics, "${point.name}" in Vannkraft1` })
    }
    if (point.municipalityNumbers.length > 0 && !point.municipalityNumbers.includes(record.municipalityNumber)) {
      issues.push({ plantNumber: record.plantNumber, issue: `municipality ${record.municipalityNumber} in statistics, ${point.municipalityNumbers.join('/')} in Vannkraft1` })
    }
    return {
      plantNumber: record.plantNumber,
      name: record.name,
      kind: record.kind,
      capacityMw: Math.abs(record.maxOutputMw),
      meanAnnualProductionGwh: Math.abs(record.meanAnnualProductionGwh),
      priceArea: record.priceArea,
      owner: record.owner,
      municipalityNumber: record.municipalityNumber,
      inOperationSince: record.inOperationSince,
      location: point.location,
      registryType: point.registryType,
      registryPointCount: point.registryPoints.length,
      registryMunicipalityNumbers: point.municipalityNumbers,
    }
  })
  return { plants, issues }
}

export const joinWindFarms = (
  stats: ReadonlyArray<NveWindStats>,
  registry: ReadonlyArray<NveWindRegistryFarm>,
): { readonly farms: ReadonlyArray<NveWindFarm>; readonly issues: ReadonlyArray<RegistryJoinIssue> } => {
  assertUnique(nveWindStatsSourceId, stats.map(record => record.farmId))
  const byNumber = new Map(registry.map(farm => [farm.plantNumber, farm]))
  const missing = stats.filter(record => !byNumber.has(record.plantNumber))
  if (missing.length > 0) {
    throw new Error(`wind join: ${missing.length} farms in operation have no Vindkraft2 point: ${missing.map(record => `${record.plantNumber} ${record.name}`).join('; ')}`)
  }
  const farmIdsByNumber = new Map<number, number[]>()
  for (const record of stats) farmIdsByNumber.set(record.plantNumber, [...(farmIdsByNumber.get(record.plantNumber) ?? []), record.farmId])
  const issues: RegistryJoinIssue[] = []
  for (const [plantNumber, farmIds] of farmIdsByNumber) {
    const point = byNumber.get(plantNumber)!
    const statsMw = stats.filter(record => record.plantNumber === plantNumber).reduce((sum, record) => sum + record.installedMw, 0)
    if (point.status !== 'D') issues.push({ plantNumber, issue: `Vindkraft2 ${point.layer} status ${point.status}${point.outOfOperation === null ? '' : ` out of operation since ${point.outOfOperation}`}, statistics list it in operation` })
    if (point.inOperationMw !== null && Math.abs(point.inOperationMw - statsMw) > 0.5) {
      issues.push({ plantNumber, issue: `${statsMw} MW in statistics (farms ${farmIds.join(', ')}), ${point.inOperationMw} MW in operation in Vindkraft2` })
    }
  }
  const farms = stats.map((record): NveWindFarm => {
    const point = byNumber.get(record.plantNumber)!
    return {
      farmId: record.farmId,
      plantNumber: record.plantNumber,
      name: record.name,
      installedMw: record.installedMw,
      normalAnnualProductionGwh: record.normalAnnualProductionGwh,
      priceArea: record.priceArea,
      owner: record.owner,
      firstStageInOperation: record.firstStageInOperation,
      operativeTurbines: record.operativeTurbines,
      location: point.location,
      locationLayer: point.layer,
      registryName: point.name,
      registryStatus: point.status,
      registryInOperationMw: point.inOperationMw,
      registryOutOfOperation: point.outOfOperation,
      registryMunicipalityNumbers: point.municipalityNumbers,
      sharedPlantNumberFarmIds: farmIdsByNumber.get(record.plantNumber)!.filter(id => id !== record.farmId),
    }
  })
  return { farms, issues }
}

export const fetchNveProductionStats = async (context: FetchContext): Promise<{
  readonly hydro: ReadonlyArray<NveHydroStats>
  readonly wind: ReadonlyArray<NveWindStats>
  readonly documents: ReadonlyArray<RawDocument>
}> => {
  const attribution = 'Norges vassdrags- og energidirektorat (NVE)'
  const hydroDocument = await fetchRegistryDocument(context, { sourceId: nveHydroStatsSourceId, url: nveHydroStatsUrl, accept: 'application/json', licence: 'nlod-2.0', attribution })
  const windDocument = await fetchRegistryDocument(context, { sourceId: nveWindStatsSourceId, url: nveWindStatsUrl, accept: 'application/json', licence: 'nlod-2.0', attribution })
  return {
    hydro: parseHydroStats(hydroDocument.body),
    wind: parseWindStats(windDocument.body),
    documents: [hydroDocument, windDocument],
  }
}
