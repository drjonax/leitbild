#!/usr/bin/env bun
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  elhubMunicipalityGroups,
  elhubPriceAreaGroups,
  fetchElhubMunicipalityDay,
  fetchElhubPriceAreaRange,
  municipalityGroupComposition,
  selectReferenceHour,
  type ElhubMunicipalityHour,
  type ElhubPriceAreaHour,
  type ReferenceHourChoice,
} from '../../src/packs/electric-grid/sources/elhub-consumption.ts'
import { fetchKartverketMunicipalities, type Municipality } from '../../src/packs/electric-grid/sources/geonorge-municipalities.ts'
import { fetchNveBiddingZones, priceAreasContaining, type BiddingZone } from '../../src/packs/electric-grid/sources/nve-bidding-zones.ts'
import {
  fetchNveProductionStats,
  joinHydroPlants,
  joinWindFarms,
  type NveHydroPlant,
  type NveWindFarm,
} from '../../src/packs/electric-grid/sources/nve-production-stats.ts'
import { fetchNveVannkraft } from '../../src/packs/electric-grid/sources/nve-vannkraft.ts'
import { fetchNveVindkraft } from '../../src/packs/electric-grid/sources/nve-vindkraft.ts'
import {
  defaultFetchContext,
  priceAreas,
  type PriceArea,
  type RawDocument,
  type SourceSnapshot,
} from '../../src/packs/electric-grid/sources/registry-fetch.ts'

// Fetches every registry and measurement source once, validates it, and writes raw responses to
// <data-dir>/downloads/<source>/<YYYYMMDD>/ and validated JSON to <data-dir>/snapshots/<source>/<YYYYMMDD>/.
// Refuses to overwrite an existing snapshot date. Prints totals and coverage.

// Representative weeks (local Oslo dates, Monday to Monday, end exclusive): mid-January and early
// July 2026, both clear of DST changes and public holidays.
export const winterWeek = { startDate: '2026-01-12', endDate: '2026-01-19' } as const
export const summerWeek = { startDate: '2026-07-06', endDate: '2026-07-13' } as const

// Elhub municipality entries that are not Kartverket mainland municipalities: unknown affiliation,
// and the isolated systems of Svalbard and Jan Mayen, which are not connected to the Nordic grid.
export const unlocatedElhubMunicipalities: Readonly<Record<string, string>> = {
  '0000': 'Elhub "Ukjent tilhørighet" (metering points without municipality)',
  '2100': 'Svalbard (isolated system, not a Kartverket municipality)',
  '2211': 'Jan Mayen (isolated system, not a Kartverket municipality)',
}

// Per-download ceiling agreed for this lane, bytes.
const maximumDocumentBytes = 200 * 1024 * 1024

const round = (value: number, digits = 1): number => Number(value.toFixed(digits))

const sumBy = <T>(items: ReadonlyArray<T>, value: (item: T) => number): number =>
  items.reduce((sum, item) => sum + value(item), 0)

const groupSum = <T, K extends string>(items: ReadonlyArray<T>, key: (item: T) => K, value: (item: T) => number): Record<K, number> => {
  const sums = new Map<K, number>()
  for (const item of items) sums.set(key(item), (sums.get(key(item)) ?? 0) + value(item))
  return Object.fromEntries([...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, sum]) => [group, round(sum)])) as Record<K, number>
}

export const hydroTotals = (plants: ReadonlyArray<NveHydroPlant>) => {
  const generating = plants.filter(plant => plant.kind !== 'pump')
  const pumps = plants.filter(plant => plant.kind === 'pump')
  const netByArea = Object.fromEntries(priceAreas.map(area => [area, round(
    sumBy(generating.filter(plant => plant.priceArea === area), plant => plant.capacityMw)
    - sumBy(pumps.filter(plant => plant.priceArea === area), plant => plant.capacityMw),
  )]))
  return {
    plantCount: plants.length,
    countByKind: groupSum(plants, plant => plant.kind, () => 1),
    generatingCapacityMw: round(sumBy(generating, plant => plant.capacityMw)),
    pumpDemandMw: round(sumBy(pumps, plant => plant.capacityMw)),
    // NVE's published total nets pump demand against generating capacity.
    netPublishedConventionMw: round(sumBy(generating, plant => plant.capacityMw) - sumBy(pumps, plant => plant.capacityMw)),
    generatingCapacityByAreaMw: groupSum(generating, plant => plant.priceArea, plant => plant.capacityMw),
    netPublishedConventionByAreaMw: netByArea,
    meanAnnualProductionGwh: round(sumBy(generating, plant => plant.meanAnnualProductionGwh)),
    withoutCoordinates: plants.filter(plant => !Number.isFinite(plant.location[0]) || !Number.isFinite(plant.location[1])).length,
  }
}

export const windTotals = (farms: ReadonlyArray<NveWindFarm>) => ({
  farmCount: farms.length,
  installedMw: round(sumBy(farms, farm => farm.installedMw)),
  installedByAreaMw: groupSum(farms, farm => farm.priceArea, farm => farm.installedMw),
  normalAnnualProductionGwh: round(sumBy(farms, farm => farm.normalAnnualProductionGwh)),
  locationLayers: groupSum(farms, farm => farm.locationLayer, () => 1),
  registryNotInOperation: farms.filter(farm => farm.registryStatus !== 'D').map(farm => ({ farmId: farm.farmId, plantNumber: farm.plantNumber, name: farm.name, installedMw: farm.installedMw, registryStatus: farm.registryStatus, registryOutOfOperation: farm.registryOutOfOperation })),
  sharedPlantNumbers: farms.filter(farm => farm.sharedPlantNumberFarmIds.length > 0).map(farm => ({ farmId: farm.farmId, plantNumber: farm.plantNumber, name: farm.name })),
})

export const priceAreaHourSummary = (records: ReadonlyArray<ElhubPriceAreaHour>, choice: ReferenceHourChoice) => {
  const hour = records.filter(record => record.startUtc === choice.startUtc)
  return {
    ...choice,
    nationalMw: round(choice.nationalMw),
    byAreaMw: groupSum(hour, record => record.priceArea, record => record.energyMwh),
    byGroupMw: groupSum(hour, record => record.group, record => record.energyMwh),
    byAreaAndGroupMw: Object.fromEntries(priceAreas.map(area => [area, groupSum(hour.filter(record => record.priceArea === area), record => record.group, record => record.energyMwh)])),
  }
}

// National totals per municipality group against the composed price-area groups, per hour.
export const groupCompositionCheck = (municipalityHours: ReadonlyArray<ElhubMunicipalityHour>, areaHours: ReadonlyArray<ElhubPriceAreaHour>) => {
  const located = municipalityHours.filter(record => !(record.municipalityNumber in unlocatedElhubMunicipalities))
  const hours = [...new Set(located.map(record => record.startUtc))].sort()
  const rows = hours.flatMap(startUtc => elhubMunicipalityGroups.map(group => {
    const municipalityMw = sumBy(located.filter(record => record.startUtc === startUtc && record.group === group), record => record.energyMwh)
    const areaMw = sumBy(areaHours.filter(record => record.startUtc === startUtc && municipalityGroupComposition[group].includes(record.group)), record => record.energyMwh)
    return { startUtc, group, municipalityMw: round(municipalityMw), priceAreaMw: round(areaMw), relativeDifference: areaMw === 0 ? null : (municipalityMw - areaMw) / areaMw }
  }))
  const compared = rows.filter(row => row.relativeDifference !== null)
  if (compared.length === 0) throw new Error('group composition check: no overlapping hours between municipality and price-area data')
  return {
    hoursCompared: new Set(compared.map(row => row.startUtc)).size,
    maximumAbsoluteRelativeDifference: Math.max(...compared.map(row => Math.abs(row.relativeDifference!))),
    rows: compared,
  }
}

export const municipalityCoverage = (
  municipalityHours: ReadonlyArray<ElhubMunicipalityHour>,
  municipalities: ReadonlyArray<Municipality>,
  zones: ReadonlyArray<BiddingZone>,
) => {
  const known = new Map(municipalities.map(municipality => [municipality.municipalityNumber, municipality]))
  const elhubNumbers = [...new Set(municipalityHours.map(record => record.municipalityNumber))].sort()
  const unexpected = elhubNumbers.filter(number => !known.has(number) && !(number in unlocatedElhubMunicipalities))
  if (unexpected.length > 0) throw new Error(`municipality coverage: Elhub municipalities without a Kartverket point: ${unexpected.join(', ')}`)
  const located = elhubNumbers.filter(number => known.has(number))
  const zoneAssignments = located.map(number => {
    const municipality = known.get(number)!
    return { municipalityNumber: number, name: municipality.name, point: municipality.point, priceAreas: priceAreasContaining(zones, municipality.point) }
  })
  return {
    elhubMunicipalities: elhubNumbers.length,
    located: located.length,
    locatedShare: located.length / (elhubNumbers.length - Object.keys(unlocatedElhubMunicipalities).filter(number => elhubNumbers.includes(number)).length),
    unlocated: elhubNumbers.filter(number => number in unlocatedElhubMunicipalities).map(number => ({ municipalityNumber: number, reason: unlocatedElhubMunicipalities[number] })),
    kartverketWithoutElhubData: municipalities.filter(municipality => !elhubNumbers.includes(municipality.municipalityNumber)).map(municipality => municipality.municipalityNumber),
    pointPriceArea: zoneAssignments,
    pointsOutsideAllZones: zoneAssignments.filter(entry => entry.priceAreas.length === 0).map(entry => entry.municipalityNumber),
    pointsInSeveralZones: zoneAssignments.filter(entry => entry.priceAreas.length > 1).map(entry => entry.municipalityNumber),
  }
}

export const municipalityHourTotals = (records: ReadonlyArray<ElhubMunicipalityHour>, startUtc: string) => {
  const hour = records.filter(record => record.startUtc === startUtc)
  const numbers = [...new Set(hour.map(record => record.municipalityNumber))].sort()
  return {
    startUtc,
    nationalMw: round(sumBy(hour, record => record.energyMwh)),
    byGroupMw: groupSum(hour, record => record.group, record => record.energyMwh),
    unlocatedMw: round(sumBy(hour.filter(record => record.municipalityNumber in unlocatedElhubMunicipalities), record => record.energyMwh)),
    municipalities: numbers.map(municipalityNumber => {
      const records = hour.filter(record => record.municipalityNumber === municipalityNumber)
      return {
        municipalityNumber,
        name: records[0]!.municipalityName,
        byGroupMw: Object.fromEntries(records.map(record => [record.group, round(record.energyMwh, 3)])),
        totalMw: round(sumBy(records, record => record.energyMwh), 3),
      }
    }),
  }
}

export const weekProfiles = (records: ReadonlyArray<ElhubPriceAreaHour>, week: { readonly startDate: string; readonly endDate: string }) => {
  const hoursUtc = [...new Set(records.map(record => record.startUtc))].sort()
  const series = priceAreas.flatMap(area => elhubPriceAreaGroups.map(group => {
    const byHour = new Map(records.filter(record => record.priceArea === area && record.group === group).map(record => [record.startUtc, record.energyMwh]))
    const mw = hoursUtc.map(hour => {
      const value = byHour.get(hour)
      if (value === undefined) throw new Error(`week profile ${week.startDate}: ${area} ${group} has no value at ${hour}`)
      return round(value, 3)
    })
    return { priceArea: area, group, mw }
  }))
  return { week, unit: 'MW (MWh per hour)', hoursUtc, series }
}

// File name of an ArcGIS page: layer name from the source id plus the page's result offset.
const arcGisPageName = (document: RawDocument): string => {
  const offset = new URL(document.snapshot.url).searchParams.get('resultOffset')
  if (offset === null) throw new Error(`${document.snapshot.sourceId}: page URL has no resultOffset: ${document.snapshot.url}`)
  return `${document.snapshot.sourceId.split(':')[1]}-offset-${offset}.geojson`
}

const compactDate = (instant: Date): string => instant.toISOString().slice(0, 10).replaceAll('-', '')

const assertDocumentSizes = (documents: ReadonlyArray<RawDocument>): void => {
  for (const document of documents) {
    if (document.snapshot.bytes > maximumDocumentBytes) {
      throw new Error(`${document.snapshot.sourceId}: ${document.snapshot.bytes} bytes exceeds ${maximumDocumentBytes} at ${document.snapshot.url}`)
    }
  }
}

const createWriter = (dataDir: string, date: string) => {
  const written: string[] = []
  const ensureFresh = async (directory: string): Promise<void> => {
    const exists = await stat(directory).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (exists) throw new Error(`snapshot directory already exists: ${directory}`)
  }
  const prepared = new Set<string>()
  const directoryFor = async (kind: 'downloads' | 'snapshots', source: string): Promise<string> => {
    const directory = join(dataDir, kind, source, date)
    if (!prepared.has(directory)) {
      await ensureFresh(directory)
      await mkdir(directory, { recursive: true })
      prepared.add(directory)
    }
    return directory
  }
  return {
    written,
    raw: async (source: string, documents: ReadonlyArray<{ readonly name: string; readonly document: RawDocument }>): Promise<ReadonlyArray<SourceSnapshot & { readonly file: string }>> => {
      const directory = await directoryFor('downloads', source)
      const descriptors = []
      for (const entry of documents) {
        const file = join(directory, entry.name)
        await writeFile(file, entry.document.body)
        written.push(file)
        descriptors.push({ ...entry.document.snapshot, file })
      }
      await writeFile(join(directory, 'snapshots.json'), `${JSON.stringify(descriptors, null, 2)}\n`)
      return descriptors
    },
    json: async (source: string, name: string, value: unknown): Promise<string> => {
      const file = join(await directoryFor('snapshots', source), name)
      await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
      written.push(file)
      return file
    },
  }
}

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } }, strict: true })
  const dataDir = values['data-dir']
  if (dataDir === undefined) throw new Error('usage: snapshot-registries.ts --data-dir <Leitbild-grid-data directory>')
  const context = defaultFetchContext()
  const date = compactDate(context.now())
  const write = createWriter(dataDir, date)
  const log = (line: string): void => console.log(line)

  log(`snapshot ${date} → ${dataDir}`)
  const vannkraft = await fetchNveVannkraft(context)
  const vindkraft = await fetchNveVindkraft(context)
  const stats = await fetchNveProductionStats(context)
  const zones = await fetchNveBiddingZones(context)
  const kommuner = await fetchKartverketMunicipalities(context)
  const winterProfile = await fetchElhubPriceAreaRange(context, winterWeek)
  const summerProfile = await fetchElhubPriceAreaRange(context, summerWeek)
  const winterChoice = selectReferenceHour(winterProfile.records, 'weekday-peak')
  const summerChoice = selectReferenceHour(summerProfile.records, 'lowest')
  const winterDay = await fetchElhubMunicipalityDay(context, winterChoice.startTime.slice(0, 10))
  const summerDay = await fetchElhubMunicipalityDay(context, summerChoice.startTime.slice(0, 10))

  const allDocuments = [
    ...vannkraft.documents, ...vindkraft.documents, ...stats.documents, ...zones.documents, ...kommuner.documents,
    winterProfile.document, summerProfile.document, winterDay.document, summerDay.document,
  ]
  assertDocumentSizes(allDocuments)

  const hydro = joinHydroPlants(stats.hydro, vannkraft.plants)
  const wind = joinWindFarms(stats.wind, vindkraft.farms)

  const rawSnapshots = {
    'nve-vannkraft1': await write.raw('nve-vannkraft1', vannkraft.documents.map(document => ({ name: arcGisPageName(document), document }))),
    'nve-vindkraft2': await write.raw('nve-vindkraft2', vindkraft.documents.map(document => ({ name: arcGisPageName(document), document }))),
    'nve-powerplant-api': await write.raw('nve-powerplant-api', [
      { name: 'GetHydroPowerPlantsInOperation.json', document: stats.documents[0]! },
      { name: 'GetWindPowerPlantsInOperation.json', document: stats.documents[1]! },
    ]),
    'nve-nettomraader': await write.raw('nve-nettomraader', zones.documents.map(document => ({ name: arcGisPageName(document), document }))),
    'kartverket-kommuneinfo': await write.raw('kartverket-kommuneinfo', kommuner.documents.map((document, index) => ({
      name: index === 0 ? 'kommuner.json' : `kommune-${kommuner.municipalities[index - 1]!.municipalityNumber}.json`,
      document,
    }))),
    elhub: await write.raw('elhub', [
      { name: `price-areas-${winterWeek.startDate}-week.json`, document: winterProfile.document },
      { name: `price-areas-${summerWeek.startDate}-week.json`, document: summerProfile.document },
      { name: `municipalities-${winterChoice.startTime.slice(0, 10)}.json`, document: winterDay.document },
      { name: `municipalities-${summerChoice.startTime.slice(0, 10)}.json`, document: summerDay.document },
    ]),
  }

  const coverage = municipalityCoverage(winterDay.records, kommuner.municipalities, zones.zones)
  const composition = {
    winter: groupCompositionCheck(winterDay.records, winterProfile.records),
    summer: groupCompositionCheck(summerDay.records, summerProfile.records),
  }
  const plantZoneMismatches = (entries: ReadonlyArray<{ readonly id: number; readonly name: string; readonly priceArea: PriceArea; readonly location: readonly [number, number] }>) =>
    entries.flatMap(entry => {
      const containing = priceAreasContaining(zones.zones, entry.location)
      return containing.length === 1 && containing[0] === entry.priceArea ? [] : [{ id: entry.id, name: entry.name, nvePriceArea: entry.priceArea, polygonPriceAreas: containing }]
    })
  const referenceHours = {
    winterPeak: {
      priceAreas: priceAreaHourSummary(winterProfile.records, winterChoice),
      municipalities: municipalityHourTotals(winterDay.records, winterChoice.startUtc),
    },
    summerLow: {
      priceAreas: priceAreaHourSummary(summerProfile.records, summerChoice),
      municipalities: municipalityHourTotals(summerDay.records, summerChoice.startUtc),
    },
  }
  const summary = {
    snapshotDate: date,
    hydro: { ...hydroTotals(hydro.plants), joinIssues: hydro.issues, priceAreaPolygonMismatches: plantZoneMismatches(hydro.plants.map(plant => ({ id: plant.plantNumber, name: plant.name, priceArea: plant.priceArea, location: plant.location }))) },
    wind: { ...windTotals(wind.farms), joinIssues: wind.issues, priceAreaPolygonMismatches: plantZoneMismatches(wind.farms.map(farm => ({ id: farm.farmId, name: farm.name, priceArea: farm.priceArea, location: farm.location }))) },
    referenceHours: {
      winterPeak: { ...referenceHours.winterPeak.priceAreas, municipalityNationalMw: referenceHours.winterPeak.municipalities.nationalMw, unlocatedMw: referenceHours.winterPeak.municipalities.unlocatedMw },
      summerLow: { ...referenceHours.summerLow.priceAreas, municipalityNationalMw: referenceHours.summerLow.municipalities.nationalMw, unlocatedMw: referenceHours.summerLow.municipalities.unlocatedMw },
    },
    municipalityCoverage: { ...coverage, pointPriceArea: undefined },
    groupComposition: {
      winterMaximumAbsoluteRelativeDifference: composition.winter.maximumAbsoluteRelativeDifference,
      summerMaximumAbsoluteRelativeDifference: composition.summer.maximumAbsoluteRelativeDifference,
    },
    biddingZones: zones.zones.map(zone => ({ priceArea: zone.priceArea, geometryType: zone.geometry.type })),
    rawSnapshots,
  }

  await write.json('nve-generation', 'hydro-plants.json', { sources: [...vannkraft.documents, stats.documents[0]!].map(document => document.snapshot), joinIssues: hydro.issues, plants: hydro.plants })
  await write.json('nve-generation', 'wind-farms.json', { sources: [...vindkraft.documents, stats.documents[1]!].map(document => document.snapshot), joinIssues: wind.issues, farms: wind.farms })
  await write.json('nve-vannkraft1', 'registry-plants.json', { sources: vannkraft.documents.map(document => document.snapshot), plants: vannkraft.plants })
  await write.json('nve-vindkraft2', 'registry-farms.json', { sources: vindkraft.documents.map(document => document.snapshot), farms: vindkraft.farms })
  await write.json('nve-powerplant-api', 'production-stats.json', { sources: stats.documents.map(document => document.snapshot), hydro: stats.hydro, wind: stats.wind })
  await write.json('nve-nettomraader', 'bidding-zones.json', { sources: zones.documents.map(document => document.snapshot), zones: zones.zones })
  await write.json('kartverket-kommuneinfo', 'municipalities.json', { sources: kommuner.documents.map(document => document.snapshot), municipalities: kommuner.municipalities, pointPriceAreas: coverage.pointPriceArea })
  await write.json('elhub', 'reference-hours.json', { sources: [winterProfile.document, summerProfile.document, winterDay.document, summerDay.document].map(document => document.snapshot), referenceHours })
  await write.json('elhub', 'profile-winter-week.json', { source: winterProfile.document.snapshot, ...weekProfiles(winterProfile.records, winterWeek) })
  await write.json('elhub', 'profile-summer-week.json', { source: summerProfile.document.snapshot, ...weekProfiles(summerProfile.records, summerWeek) })
  await write.json('elhub', 'municipality-reference-days.json', { sources: [winterDay.document.snapshot, summerDay.document.snapshot], winter: winterDay.records, summer: summerDay.records })
  await write.json('elhub', 'group-composition-check.json', composition)
  await write.json('registry-summary', 'summary.json', summary)

  log(JSON.stringify({ ...summary, rawSnapshots: undefined, hydro: { ...summary.hydro, joinIssues: summary.hydro.joinIssues.length }, wind: { ...summary.wind } }, null, 2))
  log(`wrote ${write.written.length} files`)
}

if (import.meta.main) await main()
