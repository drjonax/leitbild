import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  groupCompositionCheck,
  hydroTotals,
  municipalityCoverage,
  windTotals,
} from '../scripts/electric-grid/snapshot-registries.ts'
import {
  elhubUrl,
  fetchElhubMunicipalityDay,
  fetchElhubPriceAreaRange,
  osloMidnight,
  parseElhubMunicipalityDocument,
  parseElhubPriceAreaDocument,
  selectReferenceHour,
  type ElhubPriceAreaHour,
} from '../src/packs/electric-grid/sources/elhub-consumption.ts'
import { fetchKartverketMunicipalities, parseKommuneDetail } from '../src/packs/electric-grid/sources/geonorge-municipalities.ts'
import { biddingZonesFromPages, parseBiddingZonePage, priceAreasContaining } from '../src/packs/electric-grid/sources/nve-bidding-zones.ts'
import {
  fetchNveProductionStats,
  joinHydroPlants,
  joinWindFarms,
  parseHydroStats,
  parseWindStats,
} from '../src/packs/electric-grid/sources/nve-production-stats.ts'
import { fetchNveVannkraft, groupVannkraftPlants, parseVannkraftPage } from '../src/packs/electric-grid/sources/nve-vannkraft.ts'
import { fetchNveVindkraft, mergeVindkraftLayers, parseVindkraftPage } from '../src/packs/electric-grid/sources/nve-vindkraft.ts'
import { registryUserAgent, sha256Hex, type FetchContext } from '../src/packs/electric-grid/sources/registry-fetch.ts'

// Recorded subsets of the 2026-10-10 responses (tests/fixtures/electric-grid); no network.
const fixture = (name: string): Promise<string> => readFile(join(import.meta.dir, 'fixtures', 'electric-grid', name), 'utf8')

const retrievedAt = new Date('2026-10-10T18:00:00Z')

const fixtureContext = (route: (url: URL) => string | null, seen: string[] = []): FetchContext => ({
  now: () => retrievedAt,
  fetchFn: async (url, init) => {
    expect(init.headers['user-agent']).toBe(registryUserAgent)
    seen.push(url)
    const name = route(new URL(url))
    if (name === null) return new Response('not found', { status: 404 })
    return new Response(await fixture(name), { status: 200 })
  },
})

const vannkraftPages = async () => [
  parseVannkraftPage(await fixture('nve-vannkraft1-page-0.geojson')),
  parseVannkraftPage(await fixture('nve-vannkraft1-page-1.geojson')),
]

const vindkraftFarms = async () => mergeVindkraftLayers([
  { layer: 'built', pages: [parseVindkraftPage(await fixture('nve-vindkraft2-layer-0.geojson'))] },
  { layer: 'licence-granted', pages: [parseVindkraftPage(await fixture('nve-vindkraft2-layer-7.geojson'))] },
])

describe('NVE Vannkraft1 registry', () => {
  test('pages on exceededTransferLimit and records a snapshot descriptor per page', async () => {
    const seen: string[] = []
    const result = await fetchNveVannkraft(fixtureContext(url => {
      expect(url.searchParams.get('outSR')).toBe('4326')
      return url.searchParams.get('resultOffset') === '0' ? 'nve-vannkraft1-page-0.geojson' : 'nve-vannkraft1-page-1.geojson'
    }, seen))
    expect(seen.map(url => new URL(url).searchParams.get('resultOffset'))).toEqual(['0', '2000'])
    const first = result.documents[0]!
    expect(first.snapshot.sha256).toBe(sha256Hex(first.body))
    expect(first.snapshot).toMatchObject({ sourceId: 'nve:vannkraft1-vannkraftverk', licence: 'nlod-2.0', retrievedAt: retrievedAt.toISOString() })
    expect(result.plants.map(plant => plant.plantNumber)).toEqual([146, 222, 245, 362, 488, 1225, 1389])
  })

  test('merges the points of a plant registered on both river banks', async () => {
    const vamma = groupVannkraftPlants(await vannkraftPages()).find(plant => plant.plantNumber === 488)!
    expect(vamma.registryPoints).toHaveLength(3)
    expect(vamma.municipalityNumbers).toEqual(['3116', '3118'])
    expect(vamma.capacityMw).toBe(344)
    expect(vamma.location[0]).toBeCloseTo((11.175109672580671 + 11.169892814342127 + 11.170712558795525) / 3, 9)
  })

  test('keeps pumps negative and plants outside Norway without a municipality', async () => {
    const plants = groupVannkraftPlants(await vannkraftPages())
    expect(plants.find(plant => plant.plantNumber === 1225)).toMatchObject({ registryType: 'P', capacityMw: -0.1 })
    expect(plants.find(plant => plant.plantNumber === 245)).toMatchObject({ name: 'Linvasselv', municipalityNumbers: [], county: null })
  })

  test('rejects unexpected fields, a positive pump and conflicting duplicate points', async () => {
    const page = JSON.parse(await fixture('nve-vannkraft1-page-1.geojson'))
    const withExtraField = structuredClone(page)
    withExtraField.features[0].properties.medium = 'T'
    expect(() => parseVannkraftPage(JSON.stringify(withExtraField))).toThrow(/medium/)
    const positivePump = structuredClone(page)
    positivePump.features[0].properties.vannkraftverktype = 'P'
    expect(() => parseVannkraftPage(JSON.stringify(positivePump))).toThrow(/negative exactly for pumps/)
    const farApart = structuredClone(page)
    const vammaPoint = farApart.features.find((feature: { properties: { vannkraftverknr: number } }) => feature.properties.vannkraftverknr === 488)
    vammaPoint.geometry.coordinates = [12.5, 60.5]
    expect(() => groupVannkraftPlants([parseVannkraftPage(JSON.stringify(farApart))])).toThrow(/km apart/)
  })
})

describe('NVE Vindkraft2 registry', () => {
  test('takes built points first and licence-granted points for farms not built', async () => {
    const farms = await vindkraftFarms()
    expect(farms.map(farm => [farm.plantNumber, farm.layer, farm.status])).toEqual([
      [9875, 'licence-granted', 'N'],
      [9894, 'built', 'D'],
      [10413, 'built', 'D'],
    ])
    expect(farms.find(farm => farm.plantNumber === 9875)?.outOfOperation).toBe('2019-02-27')
  })

  test('fetches layers 0 and 7 and rejects a plant listed twice in one layer', async () => {
    const result = await fetchNveVindkraft(fixtureContext(url => (url.pathname.endsWith('/0/query') ? 'nve-vindkraft2-layer-0.geojson' : 'nve-vindkraft2-layer-7.geojson')))
    expect(result.farms).toHaveLength(3)
    expect(result.documents.map(document => document.snapshot.sourceId)).toEqual(['nve:vindkraft2-layer-0', 'nve:vindkraft2-layer-7'])
    const layer0 = parseVindkraftPage(await fixture('nve-vindkraft2-layer-0.geojson'))
    expect(() => mergeVindkraftLayers([
      { layer: 'built', pages: [layer0, layer0] },
      { layer: 'licence-granted', pages: [] },
    ])).toThrow(/appears twice/)
  })
})

describe('NVE production statistics joined by plant number', () => {
  test('joins hydro by id even where two plants share a name', async () => {
    const stats = parseHydroStats(await fixture('nve-hydro-stats.json'))
    const { plants, issues } = joinHydroPlants(stats, groupVannkraftPlants(await vannkraftPages()))
    expect(issues).toEqual([])
    const hetland = plants.filter(plant => plant.name === 'Hetland')
    expect(hetland.map(plant => [plant.plantNumber, plant.capacityMw, plant.municipalityNumber])).toEqual([[146, 1.48, '1119'], [1389, 0.275, '1160']])
    expect(plants.find(plant => plant.plantNumber === 1225)).toMatchObject({ kind: 'pump', capacityMw: 0.1, priceArea: 'NO4' })
    expect(plants.find(plant => plant.plantNumber === 362)).toMatchObject({ kind: 'pumped-storage', capacityMw: 640, priceArea: 'NO2' })
    const totals = hydroTotals(plants)
    expect(totals.generatingCapacityMw).toBeCloseTo(1.48 + 0.275 + 1240 + 25 + 640 + 344, 1)
    expect(totals.netPublishedConventionMw).toBeCloseTo(totals.generatingCapacityMw - 0.1, 1)
    expect(totals.withoutCoordinates).toBe(0)
  })

  test('fails when a plant in operation has no registry point and reports capacity disagreement', async () => {
    const stats = parseHydroStats(await fixture('nve-hydro-stats.json'))
    const registry = groupVannkraftPlants(await vannkraftPages())
    expect(() => joinHydroPlants(stats, registry.filter(plant => plant.plantNumber !== 222))).toThrow(/222 Kvilldal/)
    const altered = registry.map(plant => (plant.plantNumber === 222 ? { ...plant, capacityMw: 1000 } : plant))
    expect(joinHydroPlants(stats, altered).issues).toEqual([{ plantNumber: 222, issue: 'capacity 1240 MW in statistics, 1000 MW in Vannkraft1' }])
  })

  test('joins wind by plant number and reports decommissioned and shared registry points', async () => {
    const stats = parseWindStats(await fixture('nve-wind-stats.json'))
    const { farms, issues } = joinWindFarms(stats, await vindkraftFarms())
    expect(farms.map(farm => [farm.farmId, farm.locationLayer, farm.sharedPlantNumberFarmIds])).toEqual([
      [20, 'built', []],
      [66, 'licence-granted', []],
      [46, 'built', [1090]],
      [1090, 'built', [46]],
    ])
    expect(issues.map(issue => issue.plantNumber).sort()).toEqual([9875, 9894])
    const totals = windTotals(farms)
    expect(totals.installedMw).toBeCloseTo(57.5 + 7.2 + 45 + 51.6, 6)
    expect(totals.registryNotInOperation.map(farm => farm.name)).toEqual(['Lindesnes'])
  })

  test('fetches both statistics endpoints', async () => {
    const result = await fetchNveProductionStats(fixtureContext(url => (url.pathname.includes('Hydro') ? 'nve-hydro-stats.json' : url.pathname.includes('Wind') ? 'nve-wind-stats.json' : null)))
    expect(result.hydro).toHaveLength(7)
    expect(result.wind).toHaveLength(4)
    expect(result.documents.map(document => document.snapshot.url)).toEqual([
      'https://api.nve.no/web/Powerplant/GetHydroPowerPlantsInOperation',
      'https://api.nve.no/web/WindPowerplant/GetWindPowerPlantsInOperation',
    ])
  })

  test('fails loudly on HTTP errors', async () => {
    await expect(fetchNveProductionStats(fixtureContext(() => null))).rejects.toThrow(/HTTP 404/)
  })
})

describe('Elhub consumption', () => {
  test('builds Oslo-local day windows with the right UTC offset', () => {
    expect(osloMidnight('2026-01-15')).toBe('2026-01-15T00:00:00+01:00')
    expect(osloMidnight('2026-07-08')).toBe('2026-07-08T00:00:00+02:00')
    expect(osloMidnight('2026-03-29')).toBe('2026-03-29T00:00:00+01:00')
    expect(elhubUrl({ collection: 'price-areas', dataset: 'CONSUMPTION_PER_GROUP_MBA_HOUR', startDate: '2026-01-12T00:00:00+01:00', endDate: '2026-01-19T00:00:00+01:00' }))
      .toBe('https://api.elhub.no/energy-data/v0/price-areas?dataset=CONSUMPTION_PER_GROUP_MBA_HOUR&startDate=2026-01-12T00%3A00%3A00%2B01%3A00&endDate=2026-01-19T00%3A00%3A00%2B01%3A00')
  })

  test('parses municipality and price-area hours in MW', async () => {
    const municipality = parseElhubMunicipalityDocument(await fixture('elhub-municipalities-2026-01-12.json'))
    const sunndal = municipality.filter(record => record.municipalityNumber === '1563' && record.startUtc === '2026-01-12T07:00:00.000Z')
    expect(sunndal.find(record => record.group === 'industry')?.energyMwh).toBeCloseTo(692.3991, 4)
    const areas = parseElhubPriceAreaDocument(await fixture('elhub-price-areas-2026-01-12.json'))
    expect(new Set(areas.map(record => record.group))).toEqual(new Set(['household', 'cabin', 'primary', 'secondary', 'tertiary']))
    expect(areas.filter(record => record.startUtc === '2026-01-12T07:00:00.000Z').reduce((sum, record) => sum + record.energyMwh, 0)).toBeCloseTo(22882.957, 2)
  })

  test('rejects an unknown consumption group', async () => {
    const document = JSON.parse(await fixture('elhub-municipalities-2026-01-12.json'))
    document.data[2].attributes.consumptionPerGroupMunicipalityHour[0].consumptionGroup = 'cabin'
    expect(() => parseElhubMunicipalityDocument(JSON.stringify(document))).toThrow(/consumptionGroup/)
  })

  test('chooses the weekday peak and the lowest hour', () => {
    const hour = (startTime: string, energyMwh: number): ElhubPriceAreaHour => ({ priceArea: 'NO1', startTime, startUtc: new Date(startTime).toISOString(), group: 'household', energyMwh, meteringPoints: 1 })
    const records = [
      hour('2026-01-16T08:00:00+01:00', 100),
      hour('2026-01-17T08:00:00+01:00', 120),
      hour('2026-01-18T04:00:00+01:00', 40),
      hour('2026-01-12T03:00:00+01:00', 60),
    ]
    expect(selectReferenceHour(records, 'weekday-peak')).toMatchObject({ startTime: '2026-01-16T08:00:00+01:00', nationalMw: 100 })
    expect(selectReferenceHour(records, 'lowest')).toMatchObject({ startTime: '2026-01-18T04:00:00+01:00', nationalMw: 40 })
  })

  test('the group composition check reports the gap for partial municipality data', async () => {
    const municipality = parseElhubMunicipalityDocument(await fixture('elhub-municipalities-2026-01-12.json'))
    const areas = parseElhubPriceAreaDocument(await fixture('elhub-price-areas-2026-01-12.json'))
    // The fixture holds only Oslo and Sunndal against national price-area totals.
    const partial = groupCompositionCheck(municipality, areas)
    expect(partial.hoursCompared).toBe(2)
    expect(partial.maximumAbsoluteRelativeDifference).toBeGreaterThan(0.5)
  })

  test('fetches one municipality day and a price-area range', async () => {
    const seen: string[] = []
    const context = fixtureContext(url => (url.pathname.endsWith('/municipalities') ? 'elhub-municipalities-2026-01-12.json' : 'elhub-price-areas-2026-01-12.json'), seen)
    const day = await fetchElhubMunicipalityDay(context, '2026-01-12')
    const range = await fetchElhubPriceAreaRange(context, { startDate: '2026-01-12', endDate: '2026-01-19' })
    expect(day.document.snapshot.licence).toBe('cc-by-4.0')
    expect(range.records.length).toBe(50)
    expect(seen.map(url => [new URL(url).searchParams.get('startDate'), new URL(url).searchParams.get('endDate')])).toEqual([
      ['2026-01-12T00:00:00+01:00', '2026-01-13T00:00:00+01:00'],
      ['2026-01-12T00:00:00+01:00', '2026-01-19T00:00:00+01:00'],
    ])
  })
})

describe('Kartverket municipalities and NVE bidding zones', () => {
  const zones = async () => biddingZonesFromPages([parseBiddingZonePage(await fixture('nve-budomraade-decimated.geojson'))])

  test('fetches the list and one detail per municipality', async () => {
    const result = await fetchKartverketMunicipalities(fixtureContext(url => {
      const number = url.pathname.split('/').at(-1)
      return number === 'kommuner' ? 'kartverket-kommuner.json' : `kartverket-kommune-${number}.json`
    }))
    expect(result.municipalities.map(municipality => [municipality.municipalityNumber, municipality.name])).toEqual([['0301', 'Oslo'], ['1563', 'Sunndal']])
    expect(result.municipalities[1]?.point).toEqual([8.652670242239, 62.647028857602])
    expect(result.documents).toHaveLength(3)
  })

  test('rejects a detail for a different municipality', async () => {
    expect(() => parseKommuneDetail('0301', '{}')).toThrow(/validation/)
    const sunndal = await fixture('kartverket-kommune-1563.json')
    expect(() => parseKommuneDetail('0301', sunndal)).toThrow(/requested 0301, received 1563/)
  })

  test('assigns price areas by polygon containment', async () => {
    const loaded = await zones()
    expect(loaded.map(zone => zone.priceArea)).toEqual(['NO1', 'NO2', 'NO3', 'NO4', 'NO5'])
    expect(priceAreasContaining(loaded, [10.75, 59.91])).toEqual(['NO1'])
    expect(priceAreasContaining(loaded, [6.42, 60.63])).toEqual(['NO5'])
    expect(priceAreasContaining(loaded, [8.0, 58.15])).toEqual(['NO2'])
    expect(priceAreasContaining(loaded, [10.40, 63.43])).toEqual(['NO3'])
    expect(priceAreasContaining(loaded, [18.96, 69.65])).toEqual(['NO4'])
  })

  test('requires exactly one polygon per price area', async () => {
    const page = parseBiddingZonePage(await fixture('nve-budomraade-decimated.geojson'))
    expect(() => biddingZonesFromPages([{ ...page, features: page.features.slice(1) }])).toThrow(/NO1–NO5/)
  })

  test('covers every located Elhub municipality and names the unlocated ones', async () => {
    const municipality = parseElhubMunicipalityDocument(await fixture('elhub-municipalities-2026-01-12.json'))
    const kommuner = [
      parseKommuneDetail('0301', await fixture('kartverket-kommune-0301.json')),
      parseKommuneDetail('1563', await fixture('kartverket-kommune-1563.json')),
    ]
    const coverage = municipalityCoverage(municipality, kommuner, await zones())
    expect(coverage).toMatchObject({ elhubMunicipalities: 3, located: 2, locatedShare: 1, pointsOutsideAllZones: [], pointsInSeveralZones: [] })
    expect(coverage.unlocated.map(entry => entry.municipalityNumber)).toEqual(['0000'])
    expect(coverage.pointPriceArea.map(entry => [entry.municipalityNumber, entry.priceAreas])).toEqual([['0301', ['NO1']], ['1563', ['NO3']]])
    expect(() => municipalityCoverage(municipality, kommuner.slice(0, 1), [])).toThrow(/1563/)
  })
})
