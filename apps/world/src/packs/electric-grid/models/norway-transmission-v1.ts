import type { GridModelCatalogEntry } from '../definition-refs.ts'
import type { GridBranchKind, GridModelDefinition } from '../grid-model.ts'
import { generatorDefaults, inferBranchElectricalParameters } from './electrical-parameters.ts'
import { norwayGridSourceData } from './norway-source-data.generated.ts'

// The v1 Norway model as the runtime reads it today. Grid Model v2 (schemas/grid-model.ts)
// replaces this compilation with a generated, fully resolved data file.

const objectIdToken = (value: string): string => value
  .replace(/[æÆ]/g, 'ae')
  .replace(/[øØ]/g, 'oe')
  .replace(/[åÅ]/g, 'aa')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)

const busIdFor = (name: string, nominalKv: number, externalId: string): string =>
  `NO-${objectIdToken(name).toUpperCase()}-${Math.round(nominalKv)}-${objectIdToken(externalId).toUpperCase()}`

const branchKindFor = (category: 'line' | 'cable', name: string): GridBranchKind => {
  const normalized = name.toLowerCase()
  if (normalized.includes('nordlink') || normalized.includes('north sea link') || normalized.includes('skagerrak')) return 'hvdc_link'
  return category === 'cable' ? 'cable' : 'ac_line'
}

const haversineKm = (a: readonly [number, number], b: readonly [number, number]): number => {
  const radiusKm = 6371
  const toRad = (value: number): number => value * Math.PI / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Compiles the v1 Norway transmission model from the generated source data. */
export const buildNorwayTransmissionModelV1 = (entry: GridModelCatalogEntry): GridModelDefinition => {
  const busByExternalId = new Map(norwayGridSourceData.substations.map(substation => [
    substation.externalId,
    busIdFor(substation.name, substation.maxVoltageKv, substation.externalId),
  ]))
  const substationByExternalId = new Map(norwayGridSourceData.substations.map(substation => [substation.externalId, substation]))
  const sourceBuses = norwayGridSourceData.substations.map(substation => ({
    id: busByExternalId.get(substation.externalId)!,
    label: substation.name,
    nominalKv: substation.maxVoltageKv,
    location: [substation.lon, substation.lat] as const,
    sourceId: substation.sourceId,
    sourceFeatureId: substation.externalId,
  }))
  const branchIds = new Set<string>()
  const branches = norwayGridSourceData.branches.flatMap(branch => {
    const from = substationByExternalId.get(branch.fromExternalId)
    const to = substationByExternalId.get(branch.toExternalId)
    const fromBusId = busByExternalId.get(branch.fromExternalId)
    const toBusId = busByExternalId.get(branch.toExternalId)
    if (!from || !to || !fromBusId || !toBusId) return []
    const id = `branch:${objectIdToken(`${from.name}-${to.name}-${branch.nominalKv}-${branch.externalId}`)}`
    if (branchIds.has(id)) return []
    branchIds.add(id)
    const electrical = inferBranchElectricalParameters(branch)
    return [{
      id,
      label: branch.name,
      kind: branchKindFor(branch.category, branch.name),
      fromBusId,
      toBusId,
      nominalKv: branch.nominalKv,
      ...electrical,
      sourceId: branch.sourceId,
      sourceFeatureId: branch.externalId,
    }]
  })
  const connectedBusIds = new Set(branches.flatMap(branch => [branch.fromBusId, branch.toBusId]))
  const buses = sourceBuses.filter(bus => connectedBusIds.has(bus.id))
  const nearestBusId = (location: readonly [number, number]): string => {
    let nearest = buses[0]
    let distance = Number.POSITIVE_INFINITY
    for (const bus of buses) {
      const nextDistance = haversineKm(location, bus.location)
      if (nextDistance < distance) {
        nearest = bus
        distance = nextDistance
      }
    }
    if (!nearest) throw new Error('Norway Grid Model has no buses')
    return nearest.id
  }
  const generators = norwayGridSourceData.generators.map(generator => {
    const defaults = generatorDefaults(generator.generationKind, generator.capacityMw)
    return {
      id: `generator:${objectIdToken(generator.name)}-${objectIdToken(generator.externalId)}`,
      label: generator.name,
      kind: generator.generationKind,
      busId: nearestBusId([generator.lon, generator.lat]),
      location: [generator.lon, generator.lat] as const,
      capacityMw: generator.capacityMw,
      availableMw: defaults.availableMw,
      reserveMw: defaults.reserveMw,
      rampRateMwPerMinute: defaults.rampRateMwPerMinute,
      inertiaSeconds: defaults.inertiaSeconds,
      ...(generator.annualProductionGwh === null ? {} : { annualProductionGwh: generator.annualProductionGwh }),
      ...(generator.operator === null ? {} : { operator: generator.operator }),
      ...(generator.priceArea === null ? {} : { priceArea: `NO${generator.priceArea}` }),
      sourceId: generator.augmentationSourceId ?? generator.sourceId,
      sourceFeatureId: generator.externalId,
    }
  })
  const loads = norwayGridSourceData.loads.map(load => {
    const preferredBusId = busByExternalId.get(load.busExternalId)
    return {
      id: `load:${objectIdToken(load.id)}`,
      label: load.label,
      kind: load.loadKind,
      busId: preferredBusId !== undefined && connectedBusIds.has(preferredBusId) ? preferredBusId : nearestBusId([load.lon, load.lat]),
      location: [load.lon, load.lat] as const,
      demandMw: load.demandMw,
      criticalMw: load.criticalMw,
      reactiveDemandMvar: load.reactiveDemandMvar,
      priority: load.priority,
      controllable: load.controllable ?? false,
      sourceId: 'leitbild:inferred-consumer-supply-zones',
      sourceFeatureId: load.id,
    }
  })
  const osloBusId = loads.find(load => load.id === 'load:oslo-north-urban')?.busId ?? buses[0]!.id
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    nominalFrequencyHz: entry.nominalFrequencyHz,
    fidelity: entry.fidelity,
    sourceBuild: {
      id: norwayGridSourceData.sourceBuild.id,
      generatedAt: norwayGridSourceData.sourceBuild.generatedAt,
    },
    sourceIds: norwayGridSourceData.sourceBuild.sourceIds,
    buses,
    branches,
    generators,
    loads,
    storage: [{
      id: 'storage:oslo-battery',
      label: 'Oslo flexibility battery',
      busId: osloBusId,
      location: [10.82, 59.92],
      capacityMwh: 650,
      maxChargeMw: 180,
      maxDischargeMw: 220,
      sourceId: 'leitbild:grid-flexibility-model',
      sourceFeatureId: 'oslo-battery',
    }],
    connectionPoints: [],
  }
}
