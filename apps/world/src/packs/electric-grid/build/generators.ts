import type { PriceArea } from '../schemas/grid-ids.ts'
import type { GridMajorSiteTable } from '../schemas/grid-major-site.ts'
import type { GridBusV2, GridGeneratorV2, GridLoadV2 } from '../schemas/grid-model.ts'
import { compareText } from '../topology/ids.ts'
import { haversineKm, roundTo, type LonLat } from './geo.ts'
import { aggregationThresholdMw, attachmentRadiusKm, generatorKindRules, runOfRiverTurbineOf, runOfRiverTurbineRule, runOfRiverUtilisationHours, smallHydroInertiaSeconds } from './generator-rules.ts'
import type { HydroPlantRecord, WindFarmRecord } from './inputs.ts'
import type { BuildLedger } from './ledger.ts'
import { levelForCapacity, type Station, type StationIndex } from './stations.ts'
import type { ModelSourceIds } from './sources.ts'

// NVE hydropower plants and wind farms → Grid Model v2 generators, joined by NVE plant number.

type UnitKind = 'hydro-reservoir' | 'hydro-run-of-river' | 'hydro-pumped' | 'wind'

interface RegisteredUnit {
  readonly registryKey: string                 // nve-hydro:<nr> | nve-wind:<nr>
  readonly plantNumber: number
  readonly name: string
  readonly kind: UnitKind
  readonly kindNote: string
  readonly capacityMw: number
  readonly annualProductionGwh: number
  readonly priceArea: PriceArea
  readonly location: LonLat
  readonly sourceId: string
  /** NVE gross head, m (hydro plants that publish one). */
  readonly grossHeadM: number | null
}

const hydroKind = (plant: HydroPlantRecord): { readonly kind: UnitKind; readonly note: string } => {
  if (plant.kind === 'pumped-storage') return { kind: 'hydro-pumped', note: 'NVE type PK (pumped storage)' }
  if (plant.registryType === 'KS' || plant.registryType === 'Mini' || plant.registryType === 'Mikro') {
    return { kind: 'hydro-run-of-river', note: `NVE type ${plant.registryType} (small hydro, predominantly unregulated): run-of-river inferred` }
  }
  const hours = plant.capacityMw === 0 ? 0 : plant.meanAnnualProductionGwh * 1000 / plant.capacityMw
  return hours >= runOfRiverUtilisationHours
    ? { kind: 'hydro-run-of-river', note: `utilisation ${Math.round(hours)} h ≥ ${runOfRiverUtilisationHours} h: run-of-river inferred` }
    : { kind: 'hydro-reservoir', note: `utilisation ${Math.round(hours)} h < ${runOfRiverUtilisationHours} h: storage plant inferred` }
}

export const registeredHydroUnits = (plants: ReadonlyArray<HydroPlantRecord>, sourceId: string, grossHeadOf: ReadonlyMap<number, number>, ledger: BuildLedger): ReadonlyArray<RegisteredUnit> =>
  plants.flatMap((plant): RegisteredUnit[] => {
    if (plant.kind === 'pump') {
      ledger.add({ reason: 'pump-not-a-generator', elementIds: [`nve-hydro:${plant.plantNumber}`], mw: plant.capacityMw, detail: `${plant.name}: NVE type P is a pump (demand), not generation` })
      return []
    }
    if (plant.capacityMw <= 0) throw new Error(`NVE hydro plant ${plant.plantNumber} ${plant.name} has no capacity`)
    const { kind, note } = hydroKind(plant)
    return [{
      registryKey: `nve-hydro:${plant.plantNumber}`,
      plantNumber: plant.plantNumber,
      name: plant.name,
      kind,
      kindNote: note,
      capacityMw: plant.capacityMw,
      annualProductionGwh: plant.meanAnnualProductionGwh,
      priceArea: plant.priceArea,
      location: plant.location,
      sourceId,
      grossHeadM: grossHeadOf.get(plant.plantNumber) ?? null,
    }]
  })

/** Farms sharing one NVE plant number (build-out stages at one Vindkraft2 point) form one unit. */
export const registeredWindUnits = (farms: ReadonlyArray<WindFarmRecord>, sourceId: string, ledger: BuildLedger): ReadonlyArray<RegisteredUnit> => {
  const byPlant = new Map<number, WindFarmRecord[]>()
  for (const farm of [...farms].sort((left, right) => left.farmId - right.farmId)) {
    if (farm.registryStatus !== 'D') {
      ledger.add({
        reason: 'wind-registry-out-of-operation',
        elementIds: [`nve-wind:${farm.plantNumber}`, `nve-wind-farm:${farm.farmId}`],
        mw: farm.installedMw,
        detail: `${farm.name}: Vindkraft2 status ${farm.registryStatus}${farm.registryOutOfOperation === null ? '' : ` (out of operation since ${farm.registryOutOfOperation})`} although the statistics list it in operation`,
      })
      continue
    }
    byPlant.set(farm.plantNumber, [...(byPlant.get(farm.plantNumber) ?? []), farm])
  }
  return [...byPlant].sort(([left], [right]) => left - right).map(([plantNumber, stages]): RegisteredUnit => {
    const areas = new Set(stages.map(stage => stage.priceArea))
    if (areas.size !== 1) throw new Error(`NVE wind plant ${plantNumber}: stages lie in several price areas`)
    return {
      registryKey: `nve-wind:${plantNumber}`,
      plantNumber,
      name: stages.map(stage => stage.name).join(' + '),
      kind: 'wind',
      kindNote: stages.length > 1 ? `one unit for farms ${stages.map(stage => stage.farmId).join(', ')} sharing NVE plant number ${plantNumber}` : 'NVE wind farm',
      capacityMw: stages.reduce((sum, stage) => sum + stage.installedMw, 0),
      annualProductionGwh: stages.reduce((sum, stage) => sum + stage.normalAnnualProductionGwh, 0),
      priceArea: stages[0]!.priceArea,
      location: stages[0]!.location,
      sourceId,
      grossHeadM: null,
    }
  })
}

/** A reviewed attach-via-regional-grid curation: the station the plant's regional route reaches. */
export interface RegionalRoute {
  readonly curationId: string
  readonly substationOsmId: string
  readonly voltageKv: number
  readonly networkKm: number
}

interface Attachment {
  readonly unit: RegisteredUnit
  readonly station: Station
  readonly bus: GridBusV2
  readonly km: number
  readonly method: 'containment' | 'nearest' | 'regional-route'
  readonly route?: RegionalRoute
}

const attachmentReasons = {
  containment: 'generator-attached-by-containment',
  nearest: 'generator-attached-nearest',
  'regional-route': 'generator-attached-by-regional-route',
} as const

const familyOf = (unit: RegisteredUnit): 'hydro' | 'wind' => unit.kind === 'wind' ? 'wind' : 'hydro'
export const registeredGeneratorId = (unit: Pick<RegisteredUnit, 'kind' | 'plantNumber'>): string =>
  `generator:nve-${unit.kind === 'wind' ? 'wind' : 'hydro'}-${unit.plantNumber}`

const attachByRoute = (unit: RegisteredUnit, route: RegionalRoute, stations: StationIndex): Attachment => {
  const radius = attachmentRadiusKm[familyOf(unit)]
  const nearest = stations.nearest(unit.location, () => true)
  if (stations.containing(unit.location) !== undefined || (nearest !== undefined && nearest.km <= radius)) {
    throw new Error(`${route.curationId}: ${unit.name} has a ≥132 kV station within ${radius} km; the regional-route curation is no longer needed`)
  }
  const station = stations.byFeatureId(route.substationOsmId)
  if (station === undefined) throw new Error(`${route.curationId}: ${route.substationOsmId} is not a ≥132 kV station of the main island`)
  const bus = station.buses.find(candidate => candidate.nominalKv === route.voltageKv)
  if (bus === undefined) throw new Error(`${route.curationId}: ${station.label} has no ${route.voltageKv} kV bus`)
  return { unit, station, bus, km: haversineKm(unit.location, bus.location), method: 'regional-route', route }
}

const attach = (unit: RegisteredUnit, stations: StationIndex, aggregated: boolean, ledger: BuildLedger): Attachment | undefined => {
  const contained = stations.containing(unit.location)
  // Aggregated small plants join a bus of their own price area, so each aggregate has one area.
  if (contained !== undefined && (!aggregated || contained.priceArea === unit.priceArea)) {
    const bus = levelForCapacity(contained, unit.capacityMw)
    return { unit, station: contained, bus, km: haversineKm(unit.location, bus.location), method: 'containment' }
  }
  const radius = attachmentRadiusKm[unit.kind === 'wind' ? 'wind' : 'hydro']
  const nearest = stations.nearest(unit.location, station => !aggregated || station.priceArea === unit.priceArea)
  if (nearest === undefined || nearest.km > radius) {
    ledger.add({
      reason: 'generator-beyond-radius',
      elementIds: [unit.registryKey],
      mw: unit.capacityMw,
      ...(nearest === undefined ? {} : { distanceKm: nearest.km }),
      detail: `${unit.name} (${unit.kind}): no ≥132 kV station${aggregated ? ` in ${unit.priceArea}` : ''} within ${radius} km${nearest === undefined ? '' : `; nearest ${nearest.station.label} at ${roundTo(nearest.km, 1)} km`}`,
    })
    return undefined
  }
  return { unit, station: nearest.station, bus: levelForCapacity(nearest.station, unit.capacityMw), km: nearest.km, method: 'nearest' }
}

/** A registered plant's minimum stable share and how it was found. */
const minimumStable = (unit: Pick<RegisteredUnit, 'kind' | 'grossHeadM' | 'registryKey'>): { readonly share: number; readonly note: string | null } => {
  const rule = generatorKindRules[unit.kind]
  if (rule.minimumStableShare !== 'turbine-by-head') return { share: rule.minimumStableShare, note: null }
  if (unit.grossHeadM === null) throw new Error(`${unit.registryKey}: NVE publishes no gross head, so its turbine (rule ${runOfRiverTurbineRule.id}) is unknown`)
  const turbine = runOfRiverTurbineOf(unit.grossHeadM)
  return { share: runOfRiverTurbineRule.minimumStableShare[turbine], note: `${turbine} turbine by its ${unit.grossHeadM} m gross head, minimum stable ${runOfRiverTurbineRule.minimumStableShare[turbine] * 100} % (rule ${runOfRiverTurbineRule.id})` }
}

const kindParameters = (kind: UnitKind, capacityMw: number, aggregated: boolean, minimumStableShare: number) => {
  const rule = generatorKindRules[kind]
  return {
    ratedMva: roundTo(capacityMw / rule.powerFactor, 3),
    powerFactor: rule.powerFactor,
    voltageSetpointPu: rule.voltageSetpointPu,
    inertiaSeconds: aggregated && rule.synchronous ? smallHydroInertiaSeconds : rule.inertiaSeconds,
    synchronous: rule.synchronous,
    // An aggregate of many small plants can run any one of them, so it has no minimum.
    minimumStableMw: aggregated ? 0 : roundTo(capacityMw * minimumStableShare, 3),
    rampMwPerMinute: roundTo(Math.max(capacityMw * rule.rampSharePerMinute, 0.001), 3),
    blackStartCapable: aggregated ? false : rule.blackStartCapable,
    ruleId: rule.id,
  }
}

export const buildGenerators = (config: {
  readonly units: ReadonlyArray<RegisteredUnit>
  readonly stations: StationIndex
  readonly regionalRoutes: ReadonlyMap<string, RegionalRoute>
  readonly sourceIds: ModelSourceIds
  readonly ledger: BuildLedger
}): ReadonlyArray<GridGeneratorV2> => {
  const { units, stations, sourceIds, ledger } = config
  const generators: GridGeneratorV2[] = []
  const aggregates = new Map<string, Attachment[]>()
  const routed = new Set<string>()
  for (const unit of [...units].sort((left, right) => compareText(left.registryKey, right.registryKey))) {
    const route = config.regionalRoutes.get(registeredGeneratorId(unit))
    if (route !== undefined) routed.add(registeredGeneratorId(unit))
    // A plant on a curated regional route stays its own unit.
    const aggregated = route === undefined && unit.capacityMw < aggregationThresholdMw
    const attachment = route === undefined ? attach(unit, stations, aggregated, ledger) : attachByRoute(unit, route, stations)
    if (attachment === undefined) continue
    if (aggregated) {
      const key = `${attachment.bus.id}|${unit.kind}`
      aggregates.set(key, [...(aggregates.get(key) ?? []), attachment])
      continue
    }
    const minimum = minimumStable(unit)
    const parameters = kindParameters(unit.kind, unit.capacityMw, false, minimum.share)
    const id = registeredGeneratorId(unit)
    const how = {
      containment: 'attached by the OSM station outline containing the NVE point',
      nearest: 'attached at the nearest ≥132 kV station',
      'regional-route': `attached where its mapped regional route (${attachment.route?.networkKm} km) reaches the ≥132 kV grid, by ${attachment.route?.curationId}`,
    }[attachment.method]
    ledger.add({
      reason: attachmentReasons[attachment.method],
      elementIds: [id, attachment.bus.id],
      mw: unit.capacityMw,
      distanceKm: attachment.km,
      detail: `${unit.name} → ${attachment.bus.label}`,
    })
    generators.push({
      id,
      label: unit.name,
      kind: unit.kind,
      busId: attachment.bus.id,
      location: [unit.location[0], unit.location[1]],
      capacityMw: unit.capacityMw,
      ratedMva: parameters.ratedMva,
      powerFactor: parameters.powerFactor,
      voltageSetpointPu: parameters.voltageSetpointPu,
      inertiaSeconds: parameters.inertiaSeconds,
      synchronous: parameters.synchronous,
      minimumStableMw: parameters.minimumStableMw,
      rampMwPerMinute: parameters.rampMwPerMinute,
      blackStartCapable: parameters.blackStartCapable,
      annualProductionGwh: roundTo(unit.annualProductionGwh, 3),
      priceArea: unit.priceArea,
      registryIds: [String(unit.plantNumber)],
      attachmentKm: roundTo(attachment.km, 2),
      provenance: {
        sources: [unit.sourceId, ...(minimum.note === null ? [] : [sourceIds.hydroHeads]), sourceIds.osm, ...(attachment.route === undefined ? [] : [attachment.route.curationId])],
        method: 'registry',
        confidence: 'medium',
        note: `${unit.kindNote}; ${how}; ${minimum.note === null ? '' : `${minimum.note}; `}rule ${parameters.ruleId}`,
      },
    })
  }
  for (const [key, members] of [...aggregates].sort(([left], [right]) => compareText(left, right))) {
    const [busId, kind] = key.split('|') as [string, UnitKind]
    const bus = members[0]!.bus
    const capacityMw = members.reduce((sum, member) => sum + member.unit.capacityMw, 0)
    const weight = (value: (member: Attachment) => number): number => members.reduce((sum, member) => sum + value(member) * member.unit.capacityMw, 0) / capacityMw
    const location: [number, number] = [roundTo(weight(member => member.unit.location[0]), 6), roundTo(weight(member => member.unit.location[1]), 6)]
    const parameters = kindParameters(kind, capacityMw, true, 0)
    const id = `generator:aggregate-${busId.slice('bus:'.length)}-${kind}`
    ledger.add({
      reason: 'generators-aggregated',
      elementIds: [id, ...members.map(member => member.unit.registryKey)],
      mw: capacityMw,
      distanceKm: Math.max(...members.map(member => member.km)),
      detail: `${members.length} registered ${kind} plants below ${aggregationThresholdMw} MW at ${bus.label}`,
    })
    generators.push({
      id,
      label: `${bus.label.replace(/ \d+ kV$/, '')} ${kind === 'wind' ? 'small wind' : 'small hydro'} (${members.length} plants)`,
      kind,
      busId,
      location,
      capacityMw: roundTo(capacityMw, 3),
      ratedMva: parameters.ratedMva,
      powerFactor: parameters.powerFactor,
      voltageSetpointPu: parameters.voltageSetpointPu,
      inertiaSeconds: parameters.inertiaSeconds,
      synchronous: parameters.synchronous,
      minimumStableMw: parameters.minimumStableMw,
      rampMwPerMinute: parameters.rampMwPerMinute,
      blackStartCapable: parameters.blackStartCapable,
      annualProductionGwh: roundTo(members.reduce((sum, member) => sum + member.unit.annualProductionGwh, 0), 3),
      priceArea: bus.priceArea!,
      registryIds: members.map(member => String(member.unit.plantNumber)).sort(compareText),
      // The farthest member plant, so the attachment check covers every aggregated plant.
      attachmentKm: roundTo(Math.max(...members.map(member => member.km)), 2),
      provenance: {
        sources: [...new Set(members.map(member => member.unit.sourceId)), sourceIds.osm].sort(compareText),
        method: 'inferred',
        confidence: 'medium',
        note: `${members.length} NVE plants below ${aggregationThresholdMw} MW at their nearest ≥132 kV station in the same price area; capacity-weighted location, farthest member's attachmentKm; rule ${parameters.ruleId}`,
      },
    })
  }
  const unknown = [...config.regionalRoutes.keys()].filter(id => !routed.has(id))
  if (unknown.length > 0) throw new Error(`regional-route curations name generators that are not registered plants: ${unknown.join(', ')}`)
  return generators.sort((left, right) => compareText(left.id, right.id))
}

/**
 * Power plants inside major sites (norway-major-sites.json onSiteGeneration): one thermal unit per
 * plant at the bus of its site's load, located at the mapped OSM plant.
 */
export const buildSiteGenerators = (config: {
  readonly sites: GridMajorSiteTable
  readonly loads: ReadonlyArray<GridLoadV2>
  readonly buses: ReadonlyArray<GridBusV2>
  readonly plantLocation: (osmPlantId: string) => LonLat | undefined
  readonly sourceIds: ModelSourceIds
  readonly ledger: BuildLedger
}): ReadonlyArray<GridGeneratorV2> => config.sites.sites.flatMap((site): GridGeneratorV2[] => {
  const plant = site.onSiteGeneration
  if (plant === null) return []
  const loadId = `load:site-${site.id.slice('site:'.length)}`
  const load = config.loads.find(candidate => candidate.id === loadId)
  if (load === undefined) throw new Error(`${site.id}: its on-site plant ${plant.name} needs the site load ${loadId} in the model`)
  const bus = config.buses.find(candidate => candidate.id === load.busId)!
  const location = config.plantLocation(plant.osmPlantId)
  if (location === undefined) throw new Error(`${site.id}: OSM plant ${plant.osmPlantId} is not a plant of the sidecar`)
  const rule = generatorKindRules[plant.kind]
  if (rule.minimumStableShare === 'turbine-by-head') throw new Error(`${site.id}: a ${plant.kind} site plant needs a fixed minimum stable share`)
  const minimumStableShare = rule.minimumStableShare
  const id = `generator:osm-${plant.osmPlantId.replace('/', '-')}`
  const km = haversineKm(location, bus.location)
  config.ledger.add({ reason: 'site-generator-attached', elementIds: [id, bus.id], mw: plant.capacityMw, distanceKm: km, detail: `${plant.name} (${plant.units} units) → ${bus.label}, the bus of ${site.name}` })
  return [{
    id,
    label: plant.name,
    kind: plant.kind,
    busId: bus.id,
    location: [roundTo(location[0], 6), roundTo(location[1], 6)],
    capacityMw: plant.capacityMw,
    ratedMva: roundTo(plant.capacityMw / rule.powerFactor, 3),
    powerFactor: rule.powerFactor,
    voltageSetpointPu: rule.voltageSetpointPu,
    inertiaSeconds: rule.inertiaSeconds,
    synchronous: rule.synchronous,
    minimumStableMw: roundTo(plant.capacityMw * minimumStableShare, 3),
    rampMwPerMinute: roundTo(plant.capacityMw * rule.rampSharePerMinute, 3),
    blackStartCapable: rule.blackStartCapable,
    priceArea: site.priceArea,
    registryIds: [],
    attachmentKm: roundTo(km, 2),
    provenance: {
      sources: [config.sourceIds.majorSites, config.sourceIds.osm],
      method: 'curated',
      confidence: 'medium',
      note: `${plant.units}-unit ${plant.fuel} power plant of ${site.name} (${plant.evidence.map(entry => entry.url).join(', ')}); at its site's bus; rule ${rule.id}`,
    },
  }]
})
