import {
  osmIdPattern,
  type AuditBranch,
  type AuditBus,
  type AuditBusKind,
  type AuditBranchKind,
  type AuditGeneratorFamily,
  type AuditGraph,
  type AuditLoadFamily,
  type LonLat,
} from './audit-graph.ts'
import { pairBranchEnds, type ReferenceGeometry } from './reference-geometry.ts'

// Grid Model v2 → audit graph. Typed structurally against the fields the audit reads, so the
// Pack's v2 schema type is assignable to it. Curated assets name their curation in
// provenance.sources as `curation:<id>`.

interface ProvenanceInput { readonly sources: ReadonlyArray<string> }

export interface GridModelV2AuditInput {
  readonly id: string
  readonly referenceHour: string
  readonly buses: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: AuditBusKind
    readonly substationId?: string
    readonly nominalKv: number
    readonly location: LonLat
    readonly priceArea?: string
    readonly externalArea?: string
    readonly provenance: ProvenanceInput
  }>
  readonly branches: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: AuditBranchKind
    readonly fromBusId: string
    readonly toBusId: string
    readonly nominalKv: number
    readonly lengthKm?: number
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
  }>
  readonly loads: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: 'household' | 'cabin' | 'primary' | 'secondary' | 'tertiary' | 'industry-site' | 'petroleum-site' | 'data-center'
    readonly busId: string
    readonly referenceDemandMw: number
    readonly priceArea: string
    readonly attachmentKm: number
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
  household: 'distributed',
  cabin: 'distributed',
  primary: 'distributed',
  secondary: 'distributed',
  tertiary: 'distributed',
  'industry-site': 'site',
  'petroleum-site': 'site',
  'data-center': 'site',
}

const curationSourcePattern = /^curation:([a-z0-9]+(?:-[a-z0-9]+)*)$/

const curationIdsOf = (provenance: ProvenanceInput): ReadonlyArray<string> =>
  provenance.sources.flatMap(source => {
    const match = curationSourcePattern.exec(source)
    return match ? [match[1]!] : []
  })

export const auditGraphFromGridModelV2 = (model: GridModelV2AuditInput, reference?: ReferenceGeometry): AuditGraph => {
  const fail = (message: string): never => {
    throw new Error(`Grid Model v2 ${model.id}: ${message}`)
  }
  const buses = model.buses.map((bus): AuditBus => {
    if (bus.substationId !== undefined && !osmIdPattern.test(bus.substationId)) {
      fail(`bus ${bus.id} substationId ${bus.substationId} is not an OSM id of the form <node|way|relation>/<number>`)
    }
    const footprint = bus.kind === 'junction'
      ? { kind: 'point' as const, location: bus.location }
      : bus.substationId === undefined ? undefined : reference?.footprint(bus.substationId)
    return {
      id: bus.id,
      label: bus.label,
      kind: bus.kind,
      nominalKv: bus.nominalKv,
      location: bus.location,
      ...(bus.substationId === undefined ? {} : { substationId: bus.substationId }),
      ...(bus.priceArea === undefined ? {} : { priceArea: bus.priceArea }),
      ...(bus.externalArea === undefined ? {} : { externalArea: bus.externalArea }),
      curationIds: curationIdsOf(bus.provenance),
      ...(footprint === undefined ? {} : { footprint }),
    }
  })
  const busById = new Map(buses.map(bus => [bus.id, bus]))
  const branches = model.branches.map((branch): AuditBranch => {
    const parts = reference === undefined || branch.osmWayIds.length === 0
      ? undefined
      : branch.osmWayIds.map(id => reference.polylines(id))
    const geometry = parts === undefined || parts.some(part => part === undefined) ? undefined : parts.flatMap(part => part ?? [])
    const from = busById.get(branch.fromBusId) ?? fail(`branch ${branch.id} references unknown bus ${branch.fromBusId}`)
    const to = busById.get(branch.toBusId) ?? fail(`branch ${branch.id} references unknown bus ${branch.toBusId}`)
    const ends = geometry === undefined ? undefined : pairBranchEnds(geometry, from.location, to.location)
    return {
      id: branch.id,
      label: branch.label,
      kind: branch.kind,
      fromBusId: branch.fromBusId,
      toBusId: branch.toBusId,
      nominalKv: branch.nominalKv,
      ...(branch.lengthKm === undefined ? {} : { lengthKm: branch.lengthKm }),
      circuits: branch.circuits,
      osmWayIds: branch.osmWayIds,
      curationIds: curationIdsOf(branch.provenance),
      ...(ends === undefined ? {} : { ends }),
      ...(geometry === undefined ? {} : { geometry }),
    }
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
      osmWayIds: link.osmWayIds,
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
    })),
  }
}
