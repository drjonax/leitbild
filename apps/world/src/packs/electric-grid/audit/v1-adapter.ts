import type { GridGenerationKind, GridLoadKind, GridModelDefinition } from '../grid-model.ts'
import type { SourceGridModelData } from '../models/source-data.ts'
import {
  osmIdPattern,
  type AuditBranch,
  type AuditBranchKind,
  type AuditBus,
  type AuditGeneratorFamily,
  type AuditGraph,
  type AuditHvdcLink,
  type AuditLoadFamily,
} from './audit-graph.ts'
import { haversineKm } from './geodesy.ts'
import { pairBranchEnds, type ReferenceGeometry } from './reference-geometry.ts'

// Grid Model v1 → audit graph. v1 has one bus per station at its highest voltage, no circuits,
// no price areas on buses or loads, and synthetic merged branch ids; the reference sidecar
// supplies geometry and OSM way ids where available.

export interface GridModelV1AuditInput {
  readonly model: GridModelDefinition
  /** Source data the model was compiled from; supplies branch lengths. */
  readonly sourceData?: SourceGridModelData
  readonly reference?: ReferenceGeometry
}

const osmSourcePrefix = 'osm:'

const generatorFamilies: Readonly<Record<GridGenerationKind, AuditGeneratorFamily | null>> = {
  hydro: 'hydro',
  wind: 'wind',
  solar: 'solar',
  thermal: 'thermal',
  nuclear: 'nuclear',
  battery: null,
  import: null,
}

const loadFamilies: Readonly<Record<GridLoadKind, AuditLoadFamily>> = {
  residential: 'distributed',
  commercial: 'distributed',
  ev_charging: 'distributed',
  hospital: 'site',
  airport: 'site',
  industry: 'site',
  data_center: 'site',
  process_plant: 'site',
}

const branchKinds: Readonly<Record<string, AuditBranchKind>> = { ac_line: 'ac_line', cable: 'cable', transformer: 'transformer' }

export const auditGraphFromGridModelV1 = (input: GridModelV1AuditInput): AuditGraph => {
  const { model, reference } = input
  const fail = (message: string): never => {
    throw new Error(`Grid Model v1 ${model.id}: ${message}`)
  }
  const lengthBySourceId = new Map((input.sourceData?.branches ?? []).map(branch => [branch.externalId, branch.lengthKm]))
  const buses = model.buses.map((bus): AuditBus => {
    const fromOsm = bus.sourceId?.startsWith(osmSourcePrefix) === true
    if (fromOsm && (bus.sourceFeatureId === undefined || !osmIdPattern.test(bus.sourceFeatureId))) {
      fail(`bus ${bus.id} comes from OSM but has no OSM feature id`)
    }
    const substationId = fromOsm ? bus.sourceFeatureId : undefined
    const footprint = substationId === undefined ? undefined : reference?.footprint(substationId)
    return {
      id: bus.id,
      label: bus.label,
      kind: 'substation',
      nominalKv: bus.nominalKv,
      location: bus.location,
      ...(substationId === undefined ? {} : { substationId }),
      curationIds: [],
      ...(footprint === undefined ? {} : { footprint }),
    }
  })
  const busById = new Map(buses.map(bus => [bus.id, bus]))
  const branches: AuditBranch[] = []
  const hvdcLinks: AuditHvdcLink[] = []
  for (const branch of model.branches) {
    const featureId = branch.sourceFeatureId
    const osmWayIds = featureId === undefined ? undefined : reference?.mergedWayIds(featureId)
    if (branch.kind === 'hvdc_link') {
      hvdcLinks.push({
        id: branch.id,
        label: branch.label,
        fromBusId: branch.fromBusId,
        toBusId: branch.toBusId,
        ratingMw: branch.ratingMw,
        osmWayIds: osmWayIds ?? [],
        curationIds: [],
      })
      continue
    }
    const kind = branchKinds[branch.kind] ?? fail(`branch ${branch.id} has unsupported kind ${branch.kind}`)
    const lengthKm = featureId === undefined ? undefined : lengthBySourceId.get(featureId)
    const geometry = featureId === undefined ? undefined : reference?.polylines(featureId)
    const from = busById.get(branch.fromBusId) ?? fail(`branch ${branch.id} references unknown bus ${branch.fromBusId}`)
    const to = busById.get(branch.toBusId) ?? fail(`branch ${branch.id} references unknown bus ${branch.toBusId}`)
    const ends = geometry === undefined ? undefined : pairBranchEnds(geometry, from.location, to.location)
    branches.push({
      id: branch.id,
      label: branch.label,
      kind,
      fromBusId: branch.fromBusId,
      toBusId: branch.toBusId,
      nominalKv: branch.nominalKv,
      ...(lengthKm === undefined ? {} : { lengthKm }),
      // A v1 branch is one modelled circuit with its own rating.
      circuits: 1,
      osmWayIds: osmWayIds ?? [],
      curationIds: [],
      ...(ends === undefined ? {} : { ends }),
      ...(geometry === undefined ? {} : { geometry }),
    })
  }
  const busLocation = (busId: string, subject: string) => (busById.get(busId) ?? fail(`${subject} references unknown bus ${busId}`)).location
  return {
    modelId: model.id,
    modelKind: 'grid-model-v1',
    busPerVoltageLevel: false,
    buses,
    branches,
    hvdcLinks,
    generators: model.generators.map(generator => ({
      id: generator.id,
      label: generator.label,
      kind: generator.kind,
      family: generatorFamilies[generator.kind] ?? fail(`generator ${generator.id} kind ${generator.kind} is not a generation family`),
      busId: generator.busId,
      capacityMw: generator.capacityMw,
      ...(generator.priceArea === undefined ? {} : { priceArea: generator.priceArea }),
      attachmentKm: haversineKm(generator.location, busLocation(generator.busId, generator.id)),
      curationIds: [],
    })),
    loads: model.loads.map(load => ({
      id: load.id,
      label: load.label,
      kind: load.kind,
      family: loadFamilies[load.kind],
      busId: load.busId,
      demandMw: load.demandMw,
      attachmentKm: haversineKm(load.location, busLocation(load.busId, load.id)),
      curationIds: [],
    })),
  }
}
