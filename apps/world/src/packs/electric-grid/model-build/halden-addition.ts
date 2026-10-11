import type { PriceArea } from '../schemas/grid-ids.ts'
import { composeGridModel, type GridModelAdditionV2 } from '../schemas/grid-model-addition.ts'
import type { GridBranchV2, GridModelV2, GridSourceInput } from '../schemas/grid-model.ts'
import { lineParameters } from './electrical.ts'
import { haversineKm, roundSignificant, roundTo, type LonLat } from './geo.ts'
import { sha256Hex } from './sources.ts'

// The Halden four-unit plant connection as a Grid Model v2 Addition onto the generated Norway
// model: a dedicated 420 kV switchyard, three circuits each to Hasle and Tegneby, and four unit
// bays. The SE3 ties (Hasle – Borgvik, Halden – Skogssäter) and the Nordic equivalent are part of
// the base model (interconnector table); the addition adds only the plant's own assets.

export const haldenDesign = {
  sourceId: 'leitbild:halden-four-unit-design@2026-10-10',
  reviewedAt: '2026-10-10',
  switchyard: { slug: 'halden-pwr-switchyard', label: 'Halden PWR switchyard', location: [11.48, 59.08] as LonLat, kv: 420 },
  circuits: [
    { target: 'bus:osm-way-60495669@420', name: 'Hasle', count: 3 },
    { target: 'bus:osm-way-29578389@420', name: 'Tegneby', count: 3 },
  ],
  units: 4,
  /** Per unit bay: station service drawn from the grid, and unit output into it, MW. */
  bay: { maximumExportMw: 100, maximumImportMw: 1100 },
} as const

export const haldenAdditionId = 'electric-grid.halden.four-unit'

export const buildHaldenAddition = (base: GridModelV2, priceAreaOf: (location: LonLat) => PriceArea): { readonly addition: GridModelAdditionV2; readonly composed: GridModelV2 } => {
  const design = haldenDesign
  const input: GridSourceInput = {
    sourceId: design.sourceId,
    snapshotAt: `${design.reviewedAt}T00:00:00Z`,
    sha256: sha256Hex(JSON.stringify(design)),
    licence: 'repo-owned',
  }
  const note = 'Leitbild engineering design of the Halden four-unit plant connection (formerly the v1 addition halden.grid-model.json)'
  const provenance = { sources: [design.sourceId], method: 'curated' as const, confidence: 'low' as const, note }
  const switchyardId = `bus:curated-${design.switchyard.slug}@${design.switchyard.kv}`
  const busById = new Map(base.buses.map(bus => [bus.id, bus]))
  const branches: GridBranchV2[] = design.circuits.flatMap(circuit => {
    const target = busById.get(circuit.target)
    if (target === undefined) throw new Error(`Halden addition: base model has no bus ${circuit.target}`)
    const lengthKm = haversineKm(design.switchyard.location, target.location)
    const parameters = lineParameters({ nominalKv: design.switchyard.kv, lengthKm, cableLengthKm: 0, circuits: 1 })
    return Array.from({ length: circuit.count }, (_, index): GridBranchV2 => ({
      id: `branch:curated-halden-pwr-${circuit.name.toLowerCase()}-${index + 1}`,
      label: `Halden PWR – ${circuit.name} circuit ${index + 1}`,
      kind: 'ac_line',
      fromBusId: switchyardId,
      toBusId: circuit.target,
      nominalKv: design.switchyard.kv,
      lengthKm: roundTo(lengthKm, 4),
      circuits: 1,
      ratingMw: parameters.ratingMw,
      emergencyRatingMw: parameters.emergencyRatingMw,
      emergencyDurationSeconds: parameters.emergencyDurationSeconds,
      reactancePu: roundSignificant(parameters.reactancePu, 6),
      resistancePu: roundSignificant(parameters.resistancePu, 6),
      chargingSusceptancePu: roundSignificant(parameters.chargingSusceptancePu, 6),
      osmWayIds: [],
      provenance: { ...provenance, note: `${note}; straight-line route, electrical rules ${parameters.ruleIds.join(', ')}` },
    }))
  })
  const addition: GridModelAdditionV2 = {
    schemaVersion: 2,
    id: haldenAdditionId,
    title: 'Halden four-unit transmission connection',
    description: 'Norway transmission grid with a dedicated 420 kV Halden switchyard, three circuits each to Hasle and Tegneby, and four independently connectable unit bays.',
    baseModelRef: base.id,
    sourceInputs: [input],
    buses: [{
      id: switchyardId,
      label: design.switchyard.label,
      kind: 'plant-terminal',
      nominalKv: design.switchyard.kv,
      location: [design.switchyard.location[0], design.switchyard.location[1]],
      priceArea: priceAreaOf(design.switchyard.location),
      provenance,
    }],
    branches,
    hvdcLinks: [],
    externalSystems: [],
    generators: [],
    loads: [],
    shunts: [],
    connectionPoints: Array.from({ length: design.units }, (_, index) => ({
      id: `unit-${index + 1}-420kv`,
      label: `Halden unit ${index + 1} 420 kV bay`,
      busId: switchyardId,
      nominalKv: design.switchyard.kv,
      maximumExportMw: design.bay.maximumExportMw,
      maximumImportMw: design.bay.maximumImportMw,
    })),
  }
  const composed = composeGridModel({ addition, base: { kind: 'model', model: base }, source: `${haldenAdditionId} (build)` })
  return { addition, composed }
}
