import type { GridCurationCollection } from '../schemas/grid-curation.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyBranch } from '../topology/result.ts'
import { curationSourceId } from './curations.ts'
import type { BuildLedger } from './ledger.ts'

// set-circuits curations: the circuit count a published document gives for a line or cable whose
// circuits OSM does not map. They act on the topology's lines before the line rules rate them, so
// rating and impedance follow the curated count. Each record must find exactly one line, and that
// line's count must be the topology's inference: a mapped count makes the record stale.

export interface CuratedCircuits {
  readonly branches: ReadonlyArray<TopologyBranch>
  /** The set-circuits curation source id (`curation:<id>`) of each line it changed. */
  readonly curationOf: ReadonlyMap<string, string>
}

const inferredCircuitNote = /^circuit count inferred \(\d+\)$/

export const withCuratedCircuits = (branches: ReadonlyArray<TopologyBranch>, curations: GridCurationCollection, ledger: BuildLedger): CuratedCircuits => {
  const replaced = new Map<string, TopologyBranch>()
  const curationOf = new Map<string, string>()
  for (const feature of [...curations.features].sort((left, right) => compareText(left.id, right.id))) {
    const properties = feature.properties
    if (properties.kind !== 'set-circuits') continue
    const id = curationSourceId(feature)
    const matches = branches.filter(branch => branch.kind !== 'transformer' && branch.nominalKv === properties.voltageKv
      && properties.wayOsmIds.every(way => branch.osmWayIds.includes(way)))
    if (matches.length !== 1) throw new Error(`${id}: ${matches.length} ${properties.voltageKv} kV lines carry ${properties.wayOsmIds.join(', ')}; the record must name exactly one`)
    const branch = matches[0]!
    if (curationOf.has(branch.id)) throw new Error(`${id}: ${branch.id} already has its circuits from ${curationOf.get(branch.id)}`)
    if (branch.circuitsSource !== 'inferred') {
      throw new Error(`${id}: ${branch.id} has ${branch.circuits} circuits from its ${branch.circuitsSource}; the record is no longer needed`)
    }
    const notes = (branch.provenance.note ?? '').split('; ').filter(note => note.length > 0 && !inferredCircuitNote.test(note))
    ledger.add({
      reason: 'curated-circuits-set',
      elementIds: [branch.id, id],
      detail: `${branch.label}: ${branch.circuits} → ${properties.circuits} circuits: ${properties.reason}`,
    })
    curationOf.set(branch.id, id)
    replaced.set(branch.id, {
      ...branch,
      circuits: properties.circuits,
      provenance: { ...branch.provenance, note: [...notes, `${properties.circuits} circuits by ${id}`].join('; ') },
    })
  }
  return { branches: branches.map(branch => replaced.get(branch.id) ?? branch), curationOf }
}
