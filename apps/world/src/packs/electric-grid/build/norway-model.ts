import { priceAreaSchema, type PriceArea } from '../schemas/grid-ids.ts'
import { validateGridModel, type GridBranchV2, type GridModelV2 } from '../schemas/grid-model.ts'
import { validateGridGeometryArtifact } from '../schemas/grid-geometry.ts'
import { validateGridLoadProfiles, type GridLoadProfiles } from '../schemas/grid-load-profile.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint, type GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'
import { priceAreasContaining } from '../sources/nve-bidding-zones.ts'
import { compileGridTopology } from '../topology/compile.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyLedgerEntry } from '../topology/ledger.ts'
import { adaptNodeSidecar } from '../topology/node-sidecar.ts'
import type { TopologyBranch, TopologyBus, TopologyHvdcLink, TopologySummary } from '../topology/result.ts'
import { curatedNetwork } from './curated-branches.ts'
import { curationSourceId, topologyCurationSet, withoutCuratedExclusions } from './curations.ts'
import { curatedTransformerRatings, withCuratedLineRatings } from './curated-ratings.ts'
import { electricalRules } from './electrical.ts'
import { buildGenerators, buildSiteGenerators, registeredHydroUnits, registeredWindUnits } from './generators.ts'
import { aggregationThresholdMw, attachmentRadiusKm, generatorKindRules, runOfRiverUtilisationHours } from './generator-rules.ts'
import { buildGeometry, type GridGeometry } from './geometry.ts'
import { buildHaldenAddition, haldenAdditionId } from './halden-addition.ts'
import type { GridModelAdditionV2 } from '../schemas/grid-model-addition.ts'
import type { NorwayModelBuildInputs } from './inputs.ts'
import { buildExternalSystems, buildHvdcLinks, excludedInterconnectors, topologyInterconnectors } from './interconnectors.ts'
import { createBuildLedger, type BuildLedgerEntry } from './ledger.ts'
import { buildLoads, loadKindRules, minimumShareMw, municipalAttachmentLimitKm } from './loads.ts'
import { allocateByPopulation } from './population-weights.ts'
import { inferShunts, mainNetwork, toGridBus, toGridLine, toGridTransformer } from './network.ts'
import { buildOperatingPoints, dispatchRule } from './operating-points.ts'
import { buildLoadProfiles } from './profiles.ts'
import { readSidecarFeatures } from './sidecar-features.ts'
import { modelSources, sha256Hex, sourceBuildId } from './sources.ts'
import { createStationIndex } from './stations.ts'

// The Norway Grid Model v2 build as a pure function of its explicit inputs (inputs.ts).

export const norwayModelId = 'electric-grid.norway.transmission'

export const buildRules = {
  electrical: electricalRules,
  generatorKinds: generatorKindRules,
  loadKinds: loadKindRules,
  aggregationThresholdMw,
  attachmentRadiusKm,
  runOfRiverUtilisationHours,
  loadAllocation: { minimumShareMw, municipalAttachmentLimitKm },
  dispatch: dispatchRule,
}

/** Topology ledger reasons that only filter the source (wrong voltage, inside one station): ids only. */
const filteringReasons = new Set<string>(['below-minimum-voltage', 'station-internal-way'])

export interface GridModelLedger {
  readonly schemaVersion: 1
  readonly modelId: string
  readonly sourceBuildId: string
  readonly rules: typeof buildRules
  readonly excludedInterconnectors: ReadonlyArray<{ readonly id: string; readonly reason: string }>
  /** Per station bus of several OSM features or absorbed tee vertices: what its audit footprint covers. */
  readonly stationTerminals: Readonly<Record<string, { readonly featureIds: ReadonlyArray<string>; readonly junctionPoints: ReadonlyArray<readonly [number, number]> }>>
  readonly summary: { readonly topology: TopologySummary; readonly build: Readonly<Record<string, number>>; readonly geometryUnresolved: ReadonlyArray<string> }
  readonly build: ReadonlyArray<BuildLedgerEntry>
  /** Element ids of the filtering reasons, per reason. */
  readonly topologyFiltered: Readonly<Record<string, ReadonlyArray<string>>>
  readonly topology: ReadonlyArray<TopologyLedgerEntry>
}

export interface NorwayModelBuild {
  readonly model: GridModelV2
  readonly ledger: GridModelLedger
  readonly geometry: GridGeometry
  readonly profiles: GridLoadProfiles
  readonly operatingPoints: { readonly winter: GridOperatingPointV2; readonly summer: GridOperatingPointV2 }
  readonly haldenAddition: GridModelAdditionV2
}

const failOnCurationLedger = (entries: ReadonlyArray<TopologyLedgerEntry>): void => {
  const stale = entries.filter(entry => entry.reason === 'curation-target-missing' || entry.reason === 'curation-unneeded')
  if (stale.length > 0) throw new Error(`curation records need review:\n${stale.map(entry => `  ${entry.reason}: ${entry.detail}`).join('\n')}`)
}

/** Station buses that unify several OSM station features or absorbed tee vertices (audit footprints). */
const stationTerminalsOf = (buses: ReadonlyArray<TopologyBus>): GridModelLedger['stationTerminals'] =>
  Object.fromEntries(buses
    .filter(bus => bus.stationId !== null && (bus.stationFeatureIds.length > 1 || bus.mergedJunctionLocations.length > 0))
    .sort((left, right) => compareText(left.id, right.id))
    .map(bus => [bus.id, { featureIds: [...bus.stationFeatureIds].sort(compareText), junctionPoints: bus.mergedJunctionLocations.map(point => [point[0], point[1]] as const) }]))

export const buildNorwayGridModel = (inputs: NorwayModelBuildInputs): NorwayModelBuild => {
  const sources = modelSources(inputs)
  const ids = sources.ids
  const ledger = createBuildLedger()
  const curations = inputs.curations.data

  const adapted = adaptNodeSidecar(inputs.sidecar.data, ids.osm)
  const topologyInput = withoutCuratedExclusions(adapted.input, curations, ledger)
  const topology = compileGridTopology(
    topologyInput,
    topologyInterconnectors(inputs.interconnectors.data, ids.interconnectors),
    topologyCurationSet(curations, `curated:norway-grid-curations@${inputs.curations.sha256.slice(0, 12)}`),
  )
  failOnCurationLedger(topology.ledger)
  const main = mainNetwork(topology, ledger)
  const sidecar = readSidecarFeatures(inputs.sidecar.data)

  const zones = inputs.biddingZones.data.zones
  const priceAreaOf = (location: readonly [number, number]): PriceArea => {
    const areas = priceAreasContaining(zones, location)
    if (areas.length !== 1) throw new Error(`location ${location.join(', ')} lies in ${areas.length} price areas`)
    return priceAreaSchema.parse(areas[0])
  }

  const inService = curations.features.filter(feature => feature.properties.kind === 'assert-in-service')
  const curationsOfIds = (osmIds: ReadonlyArray<string>): ReadonlyArray<string> => {
    const set = new Set(osmIds)
    return inService.filter(feature => feature.properties.targetOsmIds.some(target => set.has(target))).map(curationSourceId).sort(compareText)
  }
  const curationsOfBranch = (branch: TopologyBranch) => curationsOfIds([...branch.sourceFeatureIds, ...branch.osmWayIds])
  const curationsOfLink = (link: TopologyHvdcLink) => [...new Set([
    ...curationsOfIds([...link.sourceFeatureIds, ...link.osmWayIds]),
    ...curations.features.filter(feature => feature.properties.kind === 'add-interconnector-ways' && feature.properties.interconnectorId === link.id).map(curationSourceId),
  ])].sort(compareText)
  const offshoreCurationOfSite = new Map(curations.features.flatMap(feature => feature.properties.kind === 'offshore-load' ? [[feature.properties.siteId, curationSourceId(feature)] as const] : []))
  for (const siteId of offshoreCurationOfSite.keys()) {
    if (!inputs.majorSites.data.sites.some(site => site.id === siteId)) throw new Error(`offshore-load curation names unknown major site ${siteId}`)
  }

  const topologyBuses = main.buses.map(bus => toGridBus(bus, priceAreaOf))
  const stationOfFeature = new Map(main.buses.flatMap(bus => bus.stationId === null ? [] : bus.stationFeatureIds.map(featureId => [featureId, bus.stationId!] as const)))
  const curated = curatedNetwork({
    curations,
    buses: topologyBuses,
    stationOfFeature: featureId => stationOfFeature.get(featureId),
    topologyLedger: topology.ledger,
    sidecar,
    priceAreaOf,
    osmSourceId: ids.osm,
    ledger,
  })
  const buses = [...topologyBuses, ...curated.buses].sort((left, right) => compareText(left.id, right.id))
  const ratedLines = withCuratedLineRatings([
    ...main.branches.filter(branch => branch.kind !== 'transformer').map(branch => toGridLine(branch, { ofBranch: curationsOfBranch })),
    ...curated.lines,
  ], curations, ledger)
  const lines = ratedLines.map(line => line.branch)
  const mainBusIds = new Set([...main.mainBusIds, ...curated.buses.map(bus => bus.id)])
  const stations = createStationIndex(buses, main.buses, mainBusIds, sidecar.outline)
  const registeredGenerators = buildGenerators({
    units: [
      ...registeredHydroUnits(inputs.hydro.data.plants, ids.hydro, ledger),
      ...registeredWindUnits(inputs.wind.data.farms, ids.wind, ledger),
    ],
    stations,
    regionalRoutes: new Map(curations.features.flatMap(feature => feature.properties.kind === 'attach-via-regional-grid'
      ? [[feature.properties.generatorId, {
          curationId: curationSourceId(feature),
          substationOsmId: feature.properties.substationOsmId,
          voltageKv: feature.properties.voltageKv,
          networkKm: feature.properties.networkKm,
        }] as const]
      : [])),
    sourceIds: ids,
    ledger,
  })
  const winterHour = inputs.referenceHours.data.referenceHours.winterPeak
  const lineCapacity = new Map<string, number>()
  for (const line of ratedLines) for (const busId of [line.branch.fromBusId, line.branch.toBusId]) lineCapacity.set(busId, (lineCapacity.get(busId) ?? 0) + line.ratings.designMw)
  const population = allocateByPopulation({
    squares: inputs.population.data.cells,
    municipalities: inputs.municipalities.data.municipalities.flatMap(place => {
      const areas = inputs.municipalities.data.pointPriceAreas.find(entry => entry.municipalityNumber === place.municipalityNumber)?.priceAreas
      if (areas === undefined || areas.length !== 1) throw new Error(`municipality ${place.municipalityNumber}: its point lies in ${areas?.length ?? 0} price areas`)
      return [{ municipalityNumber: place.municipalityNumber, point: place.point, bbox: place.bbox, priceArea: priceAreaSchema.parse(areas[0]) }]
    }),
    stations,
  })
  const loads = buildLoads({
    hour: winterHour,
    municipalities: inputs.municipalities.data,
    sites: inputs.majorSites.data,
    stations,
    sourceIds: ids,
    offshoreCurationOfSite,
    priceAreaOf,
    lineCapacityMw: busId => lineCapacity.get(busId) ?? 0,
    regionalSupplies: new Map(curations.features.flatMap(feature => feature.properties.kind === 'attach-load-via-regional-grid'
      ? [[feature.properties.municipalityNr, {
          curationId: curationSourceId(feature),
          substationOsmId: feature.properties.substationOsmId,
          voltageKv: feature.properties.voltageKv,
          routeKm: feature.properties.routeKm,
        }] as const]
      : [])),
    population,
    ledger,
  })
  const generators = [...registeredGenerators, ...buildSiteGenerators({
    sites: inputs.majorSites.data,
    loads,
    buses,
    plantLocation: osmPlantId => {
      const anchor = sidecar.anchor(osmPlantId)
      return anchor?.category === 'plant' ? anchor.location : undefined
    },
    sourceIds: ids,
    ledger,
  })].sort((left, right) => compareText(left.id, right.id))
  const sumByBus = (items: ReadonlyArray<{ readonly busId: string; readonly mw: number }>): ((busId: string) => number) => {
    const sums = new Map<string, number>()
    for (const item of items) sums.set(item.busId, (sums.get(item.busId) ?? 0) + item.mw)
    return busId => sums.get(busId) ?? 0
  }
  const injections = {
    generationMw: sumByBus(generators.map(generator => ({ busId: generator.busId, mw: generator.capacityMw }))),
    loadMw: sumByBus(loads.map(load => ({ busId: load.busId, mw: load.referenceDemandMw }))),
  }
  const transformerRatings = curatedTransformerRatings(curations, featureId => stationOfFeature.get(featureId))
  const transformers = main.branches.filter(branch => branch.kind === 'transformer').map(branch => toGridTransformer(branch, ratedLines, injections, transformerRatings.of(branch)))
  transformerRatings.assertAllApplied()
  const branches: GridBranchV2[] = [...lines, ...transformers].sort((left, right) => compareText(left.id, right.id))

  const rulesDigest = sha256Hex(JSON.stringify(buildRules))
  const buildId = sourceBuildId(sources.inputs, rulesDigest)
  const draft = {
    schemaVersion: 2 as const,
    id: norwayModelId,
    title: 'Norway transmission grid',
    description: `Source-derived ≥132 kV Norwegian transmission network: OpenStreetMap topology (${ids.osm}), NVE hydropower and wind registries, Elhub metered demand at ${winterHour.priceAreas.startTime} Europe/Oslo, curated interconnectors and major sites. Electrical values are inferred by documented rules (see the ledger).`,
    nominalFrequencyHz: 50 as const,
    sBaseMva: electricalRules.sBaseMva,
    fidelity: { powerFlow: 'dc' as const, frequency: 'island-swing' as const, voltage: 'not-modelled' as const },
    referenceHour: winterHour.priceAreas.startTime,
    sourceBuild: { id: buildId, inputs: sources.inputs },
    buses,
    branches,
    hvdcLinks: buildHvdcLinks({ links: topology.hvdcLinks, table: inputs.interconnectors.data, curationsOfLink, sourceIds: ids }),
    externalSystems: buildExternalSystems({ boundaries: topology.boundaries, table: inputs.interconnectors.data, sourceIds: ids, synchronousCase: 'winterPeak' }),
    generators,
    loads,
    shunts: inferShunts(buses, lines, ids.osm, curations.features.flatMap(feature => {
      const properties = feature.properties
      if (properties.kind !== 'add-shunt-device') return []
      const station = stations.byFeatureId(properties.substationOsmId)
      if (station === undefined) throw new Error(`${curationSourceId(feature)}: ${properties.substationOsmId} is not a station of the model`)
      const bus = station.buses.find(candidate => candidate.nominalKv === properties.voltageKv)
      if (bus === undefined) throw new Error(`${curationSourceId(feature)}: ${station.label} has no ${properties.voltageKv} kV bus`)
      return [{ curationId: curationSourceId(feature), busId: bus.id, device: properties.device, mvarAtNominalVoltage: properties.mvarAtNominalVoltage, switchable: properties.switchable, reason: properties.reason }]
    })),
    storage: [] as [],
    connectionPoints: [],
  }
  const model = validateGridModel(draft, `${norwayModelId} (build)`)

  const summerHour = inputs.referenceHours.data.referenceHours.summerLow
  const operatingPoints = buildOperatingPoints({
    model,
    compatibleModelRefs: [norwayModelId, haldenAdditionId],
    summerAreaMw: summerHour.priceAreas.byAreaMw as Record<PriceArea, number>,
    summerHour: summerHour.priceAreas.startTime,
    summerStartUtc: summerHour.priceAreas.startUtc,
    winterStartUtc: winterHour.priceAreas.startUtc,
    dispatch: inputs.referenceDispatch.data.hours,
    summerLineRatingMw: new Map(ratedLines.map(line => [line.branch.id, line.ratings.summerMw])),
  })
  const halden = buildHaldenAddition(model, priceAreaOf)
  for (const target of [gridOperatingPointTargetsForModel(model), gridOperatingPointTargetsForModel(halden.composed)]) {
    validateGridOperatingPoint(operatingPoints.winter, `${operatingPoints.winter.id} (build)`, target)
    validateGridOperatingPoint(operatingPoints.summer, `${operatingPoints.summer.id} (build)`, target)
  }

  const profiles = validateGridLoadProfiles(buildLoadProfiles({
    modelId: model.id,
    winter: inputs.winterWeek.data,
    summer: inputs.summerWeek.data,
    referenceStartUtc: winterHour.priceAreas.startUtc,
    referenceHour: winterHour.priceAreas.startTime,
  }), 'norway load profiles (build)')

  const geometry = buildGeometry({ model, branches: main.branches, hvdcLinks: topology.hvdcLinks, curatedPaths: curated.paths, sidecar })
  validateGridGeometryArtifact(geometry.geometry, 'norway geometry (build)')
  const buildEntries = ledger.entries()
  const counts: Record<string, number> = {}
  for (const entry of buildEntries) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1
  return {
    model,
    ledger: {
      schemaVersion: 1,
      modelId: model.id,
      sourceBuildId: buildId,
      rules: buildRules,
      excludedInterconnectors: excludedInterconnectors(inputs.interconnectors.data),
      stationTerminals: stationTerminalsOf(main.buses),
      summary: { topology: topology.summary, build: counts, geometryUnresolved: geometry.unresolved },
      build: buildEntries,
      topologyFiltered: Object.fromEntries([...filteringReasons].sort().map(reason => [reason,
        [...new Set(topology.ledger.filter(entry => entry.reason === reason).flatMap(entry => entry.elementIds))].sort(compareText)])),
      topology: topology.ledger.filter(entry => !filteringReasons.has(entry.reason)),
    },
    geometry: geometry.geometry,
    profiles,
    operatingPoints,
    haldenAddition: halden.addition,
  }
}
