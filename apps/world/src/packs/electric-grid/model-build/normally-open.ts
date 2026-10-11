import type { GridCurationCollection } from '../schemas/grid-curation.ts'
import type { GridBranchV2 } from '../schemas/grid-model.ts'
import { compareText } from '../topology/ids.ts'
import { curationSourceId } from './curations.ts'
import type { BuildLedger } from './ledger.ts'
import { v2OsmWayIds } from './network.ts'

// normally-open curations: mapped lines operated open in normal operation (sectioning points).
// The lines stay in the model, carrying the curation in their provenance, and the Operating Points
// start them open. Every listed way must lie on exactly one line or cable of the record's voltage.

export interface NormallyOpenLines {
  readonly lines: ReadonlyArray<GridBranchV2>
  /** Branch ids the Operating Points start open, sorted. */
  readonly openBranchIds: ReadonlyArray<string>
}

export const withNormallyOpenLines = (lines: ReadonlyArray<GridBranchV2>, curations: GridCurationCollection, ledger: BuildLedger): NormallyOpenLines => {
  const curationOf = new Map<string, string>()
  for (const feature of [...curations.features].sort((left, right) => compareText(left.id, right.id))) {
    const properties = feature.properties
    if (properties.kind !== 'normally-open') continue
    const id = curationSourceId(feature)
    const opened = new Set<string>()
    for (const way of v2OsmWayIds(properties.wayOsmIds)) {
      const carriers = lines.filter(line => line.kind !== 'transformer' && line.nominalKv === properties.voltageKv && line.osmWayIds.includes(way))
      if (carriers.length !== 1) throw new Error(`${id}: ${carriers.length} ${properties.voltageKv} kV lines carry way ${way}; each listed way must lie on exactly one`)
      opened.add(carriers[0]!.id)
    }
    for (const branchId of [...opened].sort(compareText)) {
      if (curationOf.has(branchId)) throw new Error(`${id}: ${branchId} is already normally open by ${curationOf.get(branchId)}`)
      curationOf.set(branchId, id)
      ledger.add({ reason: 'branch-normally-open', elementIds: [branchId, id], detail: `${branchId} starts open in the Operating Points: ${properties.reason}` })
    }
  }
  return {
    lines: lines.map(line => {
      const id = curationOf.get(line.id)
      if (id === undefined) return line
      return {
        ...line,
        provenance: {
          ...line.provenance,
          sources: [...line.provenance.sources, id],
          note: `${line.provenance.note === undefined ? '' : `${line.provenance.note}; `}normally open by ${id}`,
        },
      }
    }),
    openBranchIds: [...curationOf.keys()].sort(compareText),
  }
}
