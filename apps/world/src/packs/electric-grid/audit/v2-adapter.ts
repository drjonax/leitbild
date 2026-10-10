import {
  type AuditFootprint,
  type AuditBranch,
  type AuditBus,
  type AuditBusKind,
  type AuditBranchKind,
  type AuditGeneratorFamily,
  type AuditGraph,
  type AuditLoadFamily,
  type LonLat,
} from './audit-graph.ts'
import { distanceToFootprintKm, haversineKm } from './geodesy.ts'
import { distanceToLocation, pairBranchEnds, type ReferenceGeometry, type TerminalDistance } from './reference-geometry.ts'
import { splitTerminals } from './way-segments.ts'

// Grid Model v2 → audit graph. Typed structurally against the fields the audit reads, so the
// Pack's v2 schema type is assignable to it. The v2 schema writes stations as `osm-way-<n>` and
// way ids as bare numbers; the audit, golden list and curations use OSM's `way/<n>` notation, so
// both are converted here (strictly). Curated assets name their curation in provenance.sources
// as `curation:<id>`.

interface ProvenanceInput { readonly sources: ReadonlyArray<string> }

export interface GridModelV2AuditInput {
  readonly id: string
  readonly referenceHour: string
  readonly buses: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: AuditBusKind
    readonly substationId?: string | undefined
    readonly nominalKv: number
    readonly location: LonLat
    readonly priceArea?: string | undefined
    readonly externalArea?: string | undefined
    readonly provenance: ProvenanceInput
  }>
  readonly branches: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: AuditBranchKind
    readonly fromBusId: string
    readonly toBusId: string
    readonly nominalKv: number
    readonly lengthKm?: number | undefined
    readonly circuits: number
    readonly osmWayIds: ReadonlyArray<string>
    readonly provenance: ProvenanceInput
  }>
  readonly hvdcLinks: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly fromBusId: string
    readonly toBusId: string
    readonly ratingMw: number
    readonly osmWayIds: ReadonlyArray<string>
    readonly provenance: ProvenanceInput
  }>
  readonly generators: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: 'hydro-reservoir' | 'hydro-run-of-river' | 'hydro-pumped' | 'wind' | 'solar' | 'thermal' | 'nuclear'
    readonly busId: string
    readonly capacityMw: number
    readonly priceArea: string
    readonly attachmentKm: number
    readonly provenance: ProvenanceInput
  }>
  readonly loads: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: 'private' | 'business' | 'industry' | 'industry-site' | 'petroleum-site' | 'data-center'
    readonly busId: string
    readonly referenceDemandMw: number
    readonly priceArea: string
    readonly attachmentKm: number
    readonly provenance: ProvenanceInput
  }>
}

const generatorFamilies: Readonly<Record<GridModelV2AuditInput['generators'][number]['kind'], AuditGeneratorFamily>> = {
  'hydro-reservoir': 'hydro',
  'hydro-run-of-river': 'hydro',
  'hydro-pumped': 'hydro',
  wind: 'wind',
  solar: 'solar',
  thermal: 'thermal',
  nuclear: 'nuclear',
}

const loadFamilies: Readonly<Record<GridModelV2AuditInput['loads'][number]['kind'], AuditLoadFamily>> = {
  private: 'distributed',
  business: 'distributed',
  industry: 'distributed',
  'industry-site': 'site',
  'petroleum-site': 'site',
  'data-center': 'site',
}

const curationSourcePattern = /^curation:([a-z0-9]+(?:-[a-z0-9]+)*)$/
const v2SubstationPattern = /^osm-(node|way|relation)-([1-9][0-9]*)$/
const v2WayPattern = /^[1-9][0-9]*$/

const curationIdsOf = (provenance: ProvenanceInput): ReadonlyArray<string> =>
  provenance.sources.flatMap(source => {
    const match = curationSourcePattern.exec(source)
    return match ? [match[1]!] : []
  })

/**
 * What the topology unified into each station bus, keyed by bus id: the OSM station features
 * (co-located stations, site relation members, zero-impedance merges), whose footprints form the
 * station's footprint, and the tee vertices merged into it. Buses of one feature and no merged tee
 * may be absent.
 */
export type StationTerminals = Readonly<Record<string, { readonly featureIds: ReadonlyArray<string>; readonly junctionPoints: ReadonlyArray<LonLat> }>>

export const auditGraphFromGridModelV2 = (model: GridModelV2AuditInput, reference?: ReferenceGeometry, stationTerminals: StationTerminals = {}): AuditGraph => {
  const fail = (message: string): never => {
    throw new Error(`Grid Model v2 ${model.id}: ${message}`)
  }
  const osmStation = (busId: string, substationId: string): string => {
    const match = v2SubstationPattern.exec(substationId) ?? fail(`bus ${busId} substationId ${substationId} is not of the form osm-<node|way|relation>-<number>`)
    return `${match[1]!}/${match[2]!}`
  }
  const osmWays = (assetId: string, wayIds: ReadonlyArray<string>): ReadonlyArray<string> =>
    wayIds.map(wayId => v2WayPattern.test(wayId) ? `way/${wayId}` : fail(`${assetId} osmWayId ${wayId} is not a positive OSM way number`))
  const stationFootprint = (busId: string, substationId: string): AuditFootprint | undefined => {
    if (reference === undefined) return undefined
    const members = [substationId, ...(stationTerminals[busId]?.featureIds ?? []).filter(id => id !== substationId)]
    const footprints = members.flatMap(id => reference.footprint(id) ?? [])
    const polygons = footprints.flatMap(footprint => footprint.kind === 'polygon' ? footprint.polygons : [])
    return polygons.length > 0 ? { kind: 'polygon', polygons } : footprints[0]
  }
  const buses = model.buses.map((bus): AuditBus => {
    const substationId = bus.substationId === undefined ? undefined : osmStation(bus.id, bus.substationId)
    const footprint = bus.kind === 'junction'
      ? { kind: 'point' as const, location: bus.location }
      : substationId === undefined ? undefined : stationFootprint(bus.id, substationId)
    const capturePoints = stationTerminals[bus.id]?.junctionPoints ?? []
    return {
      id: bus.id,
      label: bus.label,
      kind: bus.kind,
      nominalKv: bus.nominalKv,
      location: bus.location,
      ...(substationId === undefined ? {} : { substationId }),
      ...(bus.priceArea === undefined ? {} : { priceArea: bus.priceArea }),
      ...(bus.externalArea === undefined ? {} : { externalArea: bus.externalArea }),
      curationIds: curationIdsOf(bus.provenance),
      ...(footprint === undefined ? {} : { footprint }),
      ...(capturePoints.length === 0 ? {} : { capturePoints }),
    }
  })
  const terminalDistance = (bus: AuditBus): TerminalDistance => {
    if (bus.footprint === undefined) return distanceToLocation(bus.location)
    const footprint = bus.footprint
    return point => Math.min(distanceToFootprintKm(point, footprint), ...(bus.capturePoints ?? []).map(capture => haversineKm(point, capture)))
  }
  const busById = new Map(buses.map(bus => [bus.id, bus]))
  const bare = model.branches.map((branch): AuditBranch => {
    if (!busById.has(branch.fromBusId)) fail(`branch ${branch.id} references unknown bus ${branch.fromBusId}`)
    if (!busById.has(branch.toBusId)) fail(`branch ${branch.id} references unknown bus ${branch.toBusId}`)
    return {
      id: branch.id,
      label: branch.label,
      kind: branch.kind,
      fromBusId: branch.fromBusId,
      toBusId: branch.toBusId,
      nominalKv: branch.nominalKv,
      ...(branch.lengthKm === undefined ? {} : { lengthKm: branch.lengthKm }),
      circuits: branch.circuits,
      osmWayIds: osmWays(branch.id, branch.osmWayIds),
      curationIds: curationIdsOf(branch.provenance),
    }
  })
  const splitBusesOf = splitTerminals(bare)
  const branches = bare.map((branch): AuditBranch => {
    const parts = reference === undefined || branch.osmWayIds.length === 0
      ? undefined
      : branch.osmWayIds.map(id => reference.polylines(id))
    const geometry = parts === undefined || parts.some(part => part === undefined) ? undefined : parts.flatMap(part => part ?? [])
    if (geometry === undefined) return branch
    const split = splitBusesOf.get(branch.id)
    const ends = pairBranchEnds(geometry, terminalDistance(busById.get(branch.fromBusId)!), terminalDistance(busById.get(branch.toBusId)!), {
      from: split?.has(branch.fromBusId) ?? false,
      to: split?.has(branch.toBusId) ?? false,
    })
    return { ...branch, ...(ends === undefined ? {} : { ends }), geometry }
  })
  return {
    modelId: model.id,
    modelKind: 'grid-model-v2',
    busPerVoltageLevel: true,
    referenceHour: model.referenceHour,
    buses,
    branches,
    hvdcLinks: model.hvdcLinks.map(link => ({
      id: link.id,
      label: link.label,
      fromBusId: link.fromBusId,
      toBusId: link.toBusId,
      ratingMw: link.ratingMw,
      osmWayIds: osmWays(link.id, link.osmWayIds),
      curationIds: curationIdsOf(link.provenance),
    })),
    generators: model.generators.map(generator => ({
      id: generator.id,
      label: generator.label,
      kind: generator.kind,
      family: generatorFamilies[generator.kind],
      busId: generator.busId,
      capacityMw: generator.capacityMw,
      priceArea: generator.priceArea,
      attachmentKm: generator.attachmentKm,
      curationIds: curationIdsOf(generator.provenance),
    })),
    loads: model.loads.map(load => ({
      id: load.id,
      label: load.label,
      kind: load.kind,
      family: loadFamilies[load.kind],
      busId: load.busId,
      demandMw: load.referenceDemandMw,
      priceArea: load.priceArea,
      attachmentKm: load.attachmentKm,
      curationIds: curationIdsOf(load.provenance),
    })),
  }
}
