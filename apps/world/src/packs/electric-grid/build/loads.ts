import type { PriceArea } from '../schemas/grid-ids.ts'
import type { GridBusV2, GridLoadV2 } from '../schemas/grid-model.ts'
import type { GridMajorSite, GridMajorSiteTable } from '../schemas/grid-major-site.ts'
import { compareText } from '../topology/ids.ts'
import { haversineKm, roundTo } from './geo.ts'
import type { MunicipalitySnapshot, ReferenceHour } from './inputs.ts'
import type { BuildLedger } from './ledger.ts'
import { lowestLevel, type Station, type StationIndex } from './stations.ts'
import type { ModelSourceIds } from './sources.ts'

// Elhub metered demand at the reference hour → Grid Model v2 loads: curated major sites absorb
// part of their municipality's industry group at a station listed for them; each municipality
// group's remainder splits over the ≥132 kV substations of its price area inside the
// municipality's bounding box, or goes to the nearest one.

const municipalityGroups = ['private', 'business', 'industry'] as const
type MunicipalityGroup = typeof municipalityGroups[number]

// Elhub municipality entries without a mainland location (DS2 snapshot tool): unknown affiliation,
// and Svalbard / Jan Mayen, isolated systems outside the Nordic grid.
const unlocatedMunicipalities: Readonly<Record<string, string>> = {
  '0000': 'Elhub "Ukjent tilhørighet": metering points without a municipality',
  '2100': 'Svalbard: isolated system outside the Nordic grid',
  '2211': 'Jan Mayen: isolated system outside the Nordic grid',
}

export interface LoadKindRule {
  readonly powerFactor: number
  readonly source: string
}

/** Load power factor by kind: Elhub meters energy only, so reactive demand follows a typical cos φ. */
// Statnett charges reactive exchange at its connection points beyond a 10 MVAr (15 MVAr meshed)
// allowance (Tariffer for transmisjonsnettet 2026, reactive power 40 kr/kVAr), and DSOs bill their
// customers beyond cos φ 0.95 (Elvia tariff sheet 4.0), so networks and customers compensate to near
// zero reactive exchange at ≥132 kV: the model's loads, which sit at ≥132 kV buses, draw unity cos φ.
const tariffPowerFactor: LoadKindRule = { powerFactor: 1, source: 'unity cos φ at ≥132 kV: reactive exchange beyond 10–15 MVAr per point is charged (Statnett transmission tariff 2026; Elvia tariff sheet 4.0 bills customers below cos φ 0.95)' }
export const loadKindRules: Readonly<Record<GridLoadV2['kind'], LoadKindRule>> = {
  private: tariffPowerFactor,
  business: tariffPowerFactor,
  industry: tariffPowerFactor,
  'industry-site': tariffPowerFactor,
  'petroleum-site': tariffPowerFactor,
  'data-center': tariffPowerFactor,
}

/**
 * Municipal demand is split in shares of at most this, MW: below the 147 MVA rating of one 132 kV
 * circuit (overheadRules), so a share does not by itself overload the regional line feeding it.
 */
const municipalShareMw = 100

/** Maximum distance from a site to the station that serves it, km (golden list site attachment limit). */
const siteSearchKm = 15

/** Distributed loads farther than this from their station need a reviewed regional route, km (golden list distributed load limit). */
export const municipalAttachmentLimitKm = 60

/** A reviewed attach-load-via-regional-grid curation: the station a municipality's supply route reaches. */
export interface RegionalSupply {
  readonly curationId: string
  readonly substationOsmId: string
  readonly voltageKv: number
  readonly routeKm: number
}

const unknownControl = 'priority and interruptible MW unknown (no public evidence): normal, 0'

const listedStations = (site: GridMajorSite, stations: StationIndex): ReadonlyArray<{ readonly station: Station; readonly how: string; readonly kvs: ReadonlyArray<number> }> =>
  ([['serving', site.servingSubstation], ['upstream', site.upstreamSubstation]] as const).flatMap(([role, substation]) => {
    if (substation === null) return []
    const station = stations.byFeatureId(substation.osmId)
    if (station === undefined || haversineKm(site.location, station.location) > siteSearchKm) return []
    return [{ station, how: `${role} station ${substation.name} (${substation.osmId})`, kvs: [substation.kv] }]
  })

/**
 * The bus a site connects at: the first listed station level (serving, then upstream; the listed
 * voltage first, then the station's levels from the lowest) whose connected lines carry the site's
 * demand, else the listed level with the largest line capacity, else the nearest ≥132 kV substation.
 */
const siteBus = (site: GridMajorSite, demandMw: number, stations: StationIndex, lineCapacityMw: (busId: string) => number): { readonly bus: GridBusV2; readonly how: string } | undefined => {
  const candidates = listedStations(site, stations).flatMap(entry => [
    ...entry.station.buses.filter(bus => entry.kvs.includes(bus.nominalKv)),
    ...entry.station.buses.filter(bus => !entry.kvs.includes(bus.nominalKv)),
  ].map(bus => ({ bus, how: entry.how })))
  const carrying = candidates.find(candidate => lineCapacityMw(candidate.bus.id) >= demandMw)
  if (carrying !== undefined) return carrying
  const strongest = [...candidates].sort((left, right) => lineCapacityMw(right.bus.id) - lineCapacityMw(left.bus.id))[0]
  if (strongest !== undefined) return { bus: strongest.bus, how: `${strongest.how}; no listed level carries ${Math.round(demandMw)} MW, so its strongest level` }
  const nearest = stations.nearest(site.location, station => station.kind === 'substation' && station.priceArea === site.priceArea)
  if (nearest === undefined || nearest.km > siteSearchKm) return undefined
  return { bus: lowestLevel(nearest.station), how: `nearest ≥132 kV substation (${nearest.station.label}); the listed stations are not ≥132 kV model stations` }
}

export const buildLoads = (config: {
  readonly hour: ReferenceHour
  readonly municipalities: MunicipalitySnapshot
  readonly sites: GridMajorSiteTable
  readonly stations: StationIndex
  readonly sourceIds: ModelSourceIds
  readonly offshoreCurationOfSite: ReadonlyMap<string, string>
  readonly priceAreaOf: (location: readonly [number, number]) => PriceArea
  readonly lineCapacityMw: (busId: string) => number
  readonly regionalSupplies: ReadonlyMap<string, RegionalSupply>
  readonly ledger: BuildLedger
}): ReadonlyArray<GridLoadV2> => {
  const { hour, stations, sourceIds, ledger } = config
  const placeOf = new Map(config.municipalities.municipalities.map(entry => [entry.municipalityNumber, entry]))
  const areaOf = new Map(config.municipalities.pointPriceAreas.map(entry => {
    if (entry.priceAreas.length !== 1) throw new Error(`municipality ${entry.municipalityNumber}: its point lies in ${entry.priceAreas.length} price areas`)
    return [entry.municipalityNumber, entry.priceAreas[0]!] as const
  }))
  const sitesByMunicipality = new Map<string, GridMajorSite[]>()
  for (const site of config.sites.sites) {
    const nr = site.elhubAbsorption.municipalityNr
    sitesByMunicipality.set(nr, [...(sitesByMunicipality.get(nr) ?? []), site])
  }
  const loads: GridLoadV2[] = []
  const seenSites = new Set<string>()
  const seenSupplies = new Set<string>()
  for (const municipality of [...hour.municipalities.municipalities].sort((left, right) => compareText(left.municipalityNumber, right.municipalityNumber))) {
    const nr = municipality.municipalityNumber
    const place = placeOf.get(nr)
    const totalMw = municipality.byGroupMw.private + municipality.byGroupMw.business + municipality.byGroupMw.industry
    if (place === undefined) {
      const reason = unlocatedMunicipalities[nr]
      if (reason === undefined) throw new Error(`Elhub municipality ${nr} ${municipality.name} has no Kartverket point`)
      ledger.add({ reason: 'municipality-unlocated', elementIds: [`elhub-municipality:${nr}`], mw: totalMw, detail: `${municipality.name}: ${reason}` })
      continue
    }
    const priceArea = areaOf.get(nr)
    if (priceArea === undefined) throw new Error(`municipality ${nr} has no price area for its point`)
    // A listed site without a ≥132 kV station within reach stays in its municipality's industry group.
    const industryMw = municipality.byGroupMw.industry
    const listed = sitesByMunicipality.get(nr) ?? []
    const listedMw = listed.reduce((sum, site) => sum + site.demand.publishedMw, 0)
    const placed = new Map<string, { readonly bus: GridBusV2; readonly how: string }>()
    const sites = listed.filter(site => {
      seenSites.add(site.id)
      const found = siteBus(site, industryMw * site.demand.publishedMw / Math.max(listedMw, industryMw), stations, config.lineCapacityMw)
      if (found !== undefined) {
        placed.set(site.id, found)
        return true
      }
      ledger.add({ reason: 'site-without-station', elementIds: [site.id], mw: site.demand.publishedMw, detail: `${site.name}: neither listed station is a ≥132 kV model station and no ≥132 kV substation in ${site.priceArea} lies within ${siteSearchKm} km; its demand stays in the ${municipality.name} industry load` })
      return false
    })
    const publishedMw = sites.reduce((sum, site) => sum + site.demand.publishedMw, 0)
    // grid-major-site.ts: each site takes industry × publishedMw / max(Σ publishedMw, industry).
    const siteShare = (site: GridMajorSite): number => industryMw * site.demand.publishedMw / Math.max(publishedMw, industryMw)
    for (const site of sites) {
      // A site may lie in another price area than its municipality's point; it keeps its own.
      const siteArea = config.priceAreaOf(site.location)
      if (site.priceArea !== siteArea) throw new Error(`${site.id}: listed in ${site.priceArea}, but its location lies in ${siteArea}`)
      const found = placed.get(site.id)!
      const bus = found.bus
      const demandMw = siteShare(site)
      const km = haversineKm(site.location, bus.location)
      const curation = config.offshoreCurationOfSite.get(site.id)
      const slug = site.id.slice('site:'.length)
      ledger.add({ reason: 'site-load-attached', elementIds: [`load:site-${slug}`, bus.id], mw: demandMw, distanceKm: km, detail: `${site.name} → ${bus.label} via ${found.how}` })
      loads.push({
        id: `load:site-${slug}`,
        label: site.name,
        kind: site.kind,
        busId: bus.id,
        location: [site.location[0], site.location[1]],
        referenceDemandMw: roundTo(demandMw, 3),
        powerFactor: loadKindRules[site.kind].powerFactor,
        priority: 'normal',
        interruptibleMw: 0,
        municipalityNr: nr,
        priceArea: site.priceArea,
        attachmentKm: roundTo(km, 2),
        provenance: {
          sources: [sourceIds.elhub, sourceIds.majorSites, sourceIds.osm, ...(curation === undefined ? [] : [curation])],
          method: 'curated',
          confidence: 'medium',
          note: `Elhub ${municipality.name} industry ${roundTo(industryMw, 1)} MW × ${site.demand.publishedMw} MW published / max(${roundTo(publishedMw, 1)} MW listed sites, industry); at the ${found.how}${curation === undefined ? '' : `; offshore supply explained by ${curation}`}; ${unknownControl}`,
        },
      })
    }
    const remainder: Readonly<Record<MunicipalityGroup, number>> = {
      private: municipality.byGroupMw.private,
      business: municipality.byGroupMw.business,
      industry: industryMw - sites.reduce((sum, site) => sum + siteShare(site), 0),
    }
    const point: [number, number] = [roundTo(place.point[0], 6), roundTo(place.point[1], 6)]
    const [west, south, east, north] = place.bbox
    const eligible = (station: Station): boolean => station.kind === 'substation' && station.priceArea === priceArea
    const remainderMw = remainder.private + remainder.business + remainder.industry
    // One share per started shareMw, over the substations inside the municipality's bounding box
    // nearest its point; a municipality without one inside takes the nearest substation.
    const shares = Math.max(1, Math.ceil(remainderMw / municipalShareMw))
    const inside = stations.stations.filter(station => eligible(station)
      && station.location[0] >= west && station.location[0] <= east && station.location[1] >= south && station.location[1] <= north)
      .map(station => ({ station, km: haversineKm(place.point, station.location) }))
      .sort((left, right) => left.km - right.km || compareText(left.station.stationId, right.station.stationId))
    const nearest = stations.nearest(place.point, eligible)
    if (nearest === undefined) throw new Error(`municipality ${nr}: no ≥132 kV substation in ${priceArea}`)
    const supply = config.regionalSupplies.get(nr)
    if (supply !== undefined) {
      seenSupplies.add(nr)
      if (nearest.km <= municipalAttachmentLimitKm) throw new Error(`${supply.curationId}: ${municipality.name} lies ${roundTo(nearest.km, 1)} km from ${nearest.station.label}, within ${municipalAttachmentLimitKm} km; the regional-route curation is no longer needed`)
    }
    const routed = supply === undefined ? undefined : stations.byFeatureId(supply.substationOsmId)
    if (supply !== undefined && routed === undefined) throw new Error(`${supply.curationId}: ${supply.substationOsmId} is not a ≥132 kV station of the main island`)
    const routedBus = supply === undefined ? undefined : routed!.buses.find(candidate => candidate.nominalKv === supply.voltageKv)
    if (supply !== undefined && routedBus === undefined) throw new Error(`${supply.curationId}: ${routed!.label} has no ${supply.voltageKv} kV bus`)
    const served = routed !== undefined ? [routed] : inside.length > 0 && shares > 1 ? inside.slice(0, shares).map(entry => entry.station) : [nearest.station]
    const how = supply !== undefined
      ? `at ${routed!.label}, where its regional supply route (${supply.routeKm} km mapped) reaches the ≥132 kV grid, by ${supply.curationId}`
      : served.length > 1
        ? `split equally over the ${served.length} ≥132 kV substations in ${priceArea} inside the municipality's bounding box nearest its point`
        : `at the nearest ≥132 kV substation in ${priceArea} to the municipality point`
    for (const station of served) {
      const bus = routedBus ?? lowestLevel(station)
      const km = haversineKm(place.point, bus.location)
      for (const group of municipalityGroups) {
        const demandMw = remainder[group] / served.length
        if (demandMw <= 0) continue
        loads.push({
          id: `load:${nr}-${group}-${station.stationId}`,
          label: `${municipality.name} ${group}${served.length > 1 ? ` at ${station.label}` : ''}`,
          kind: group,
          busId: bus.id,
          location: point,
          referenceDemandMw: roundTo(demandMw, 3),
          powerFactor: loadKindRules[group].powerFactor,
          priority: 'normal',
          interruptibleMw: 0,
          municipalityNr: nr,
          priceArea,
          attachmentKm: roundTo(km, 2),
          provenance: {
            sources: [sourceIds.elhub, sourceIds.municipalities, sourceIds.biddingZones, sourceIds.osm, ...(supply === undefined ? [] : [supply.curationId])],
            method: supply === undefined ? 'measured' : 'curated',
            confidence: 'medium',
            note: `Elhub ${group} demand${group === 'industry' && sites.length > 0 ? ' less listed sites' : ''}, ${how}; ${unknownControl}`,
          },
        })
      }
    }
    ledger.add({ reason: 'municipality-load-attached', elementIds: [`elhub-municipality:${nr}`, ...served.map(station => station.stationId)], mw: totalMw, distanceKm: nearest.km, detail: `${municipality.name} → ${served.length} substation${served.length === 1 ? '' : 's'}` })
  }
  const unknownSupplies = [...config.regionalSupplies.keys()].filter(nr => !seenSupplies.has(nr))
  if (unknownSupplies.length > 0) throw new Error(`regional-supply curations name municipalities without located Elhub demand: ${unknownSupplies.join(', ')}`)
  const unused = config.sites.sites.filter(site => !seenSites.has(site.id))
  if (unused.length > 0) throw new Error(`major sites without Elhub municipality data: ${unused.map(site => site.id).join(', ')}`)
  return loads.sort((left, right) => compareText(left.id, right.id))
}
