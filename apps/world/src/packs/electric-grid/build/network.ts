import type { GridBranchV2, GridBusV2, GridProvenance, GridShuntV2 } from '../schemas/grid-model.ts'
import type { PriceArea } from '../schemas/grid-ids.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyBranch, TopologyBus, TopologyProvenance, TopologyResult } from '../topology/result.ts'
import { lineParameters, sBaseMva, shuntRule, transformerParameters, transformerRule } from './electrical.ts'
import { roundSignificant, roundTo } from './geo.ts'
import type { BuildLedger } from './ledger.ts'

// Topology → Grid Model v2 buses, lines, cables, transformers and shunt reactors.

/** Isolated components at most this many buses are ledgered and left out; a larger split fails the build. */
const maximumDroppedComponentBuses = 10

const stripWay = (id: string): string => {
  const match = /^way\/([1-9]\d*)$/.exec(id)
  if (!match) throw new Error(`expected an OSM way id, got ${id}`)
  return match[1]!
}

export const v2OsmWayIds = (ids: ReadonlyArray<string>): string[] => [...new Set(ids.map(stripWay))].sort(compareText)

const confidenceRank = { high: 2, medium: 1, low: 0 } as const
const capConfidence = (confidence: GridProvenance['confidence'], cap: GridProvenance['confidence']): GridProvenance['confidence'] =>
  confidenceRank[confidence] <= confidenceRank[cap] ? confidence : cap

const roundLocation = (location: readonly [number, number]): [number, number] => [roundTo(location[0], 6), roundTo(location[1], 6)]

/** Connected components over AC branches, boundary buses excluded; largest first. */
const acComponents = (buses: ReadonlyArray<TopologyBus>, branches: ReadonlyArray<TopologyBranch>): ReadonlyArray<ReadonlyArray<string>> => {
  const neighbours = new Map<string, string[]>(buses.filter(bus => bus.kind !== 'boundary').map(bus => [bus.id, []]))
  for (const branch of branches) {
    if (!neighbours.has(branch.fromBusId) || !neighbours.has(branch.toBusId)) continue
    neighbours.get(branch.fromBusId)!.push(branch.toBusId)
    neighbours.get(branch.toBusId)!.push(branch.fromBusId)
  }
  const seen = new Set<string>()
  const components: string[][] = []
  for (const start of [...neighbours.keys()].sort(compareText)) {
    if (seen.has(start)) continue
    const component: string[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length > 0) {
      const bus = stack.pop()!
      component.push(bus)
      for (const next of neighbours.get(bus)!) {
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    components.push(component.sort(compareText))
  }
  return components.sort((left, right) => right.length - left.length || compareText(left[0]!, right[0]!))
}

export interface MainNetwork {
  readonly buses: ReadonlyArray<TopologyBus>
  readonly branches: ReadonlyArray<TopologyBranch>
  readonly mainBusIds: ReadonlySet<string>
}

/** Leaves out small AC islands without a boundary (no load or tie can keep them energised). */
export const mainNetwork = (topology: TopologyResult, ledger: BuildLedger): MainNetwork => {
  const components = acComponents(topology.buses, topology.branches)
  const main = new Set(components[0] ?? [])
  const dropped = new Set<string>()
  for (const component of components.slice(1)) {
    if (component.length > maximumDroppedComponentBuses) {
      throw new Error(`topology splits into a second AC component of ${component.length} buses (${component.slice(0, 5).join(', ')}…); fix the source or add a curation`)
    }
    for (const busId of component) dropped.add(busId)
    const labels = component.map(busId => topology.buses.find(bus => bus.id === busId)!.label)
    ledger.add({ reason: 'component-isolated', elementIds: component, detail: `${component.length}-bus AC island without a mapped connection to the main grid (${[...new Set(labels)].join(', ')})` })
  }
  return {
    buses: topology.buses.filter(bus => !dropped.has(bus.id)),
    branches: topology.branches.filter(branch => !dropped.has(branch.fromBusId) && !dropped.has(branch.toBusId)),
    mainBusIds: main,
  }
}

const busProvenance = (provenance: TopologyProvenance, extraSources: ReadonlyArray<string>, extraNote: string | null): GridProvenance => {
  const note = [provenance.note, extraNote].filter((part): part is string => part !== null).join('; ')
  return {
    sources: [...provenance.sources, ...extraSources],
    method: provenance.method,
    confidence: provenance.confidence,
    ...(note.length > 0 ? { note } : {}),
  }
}

export const toGridBus = (bus: TopologyBus, priceAreaOf: (location: readonly [number, number]) => PriceArea): GridBusV2 => {
  const base = {
    id: bus.id,
    label: bus.label,
    kind: bus.kind,
    nominalKv: bus.nominalKv,
    location: roundLocation(bus.location),
    provenance: busProvenance(bus.provenance, [], bus.mergedBusIds.length > 0 ? `joins ${bus.mergedBusIds.join(', ')} (zero-impedance merge)` : null),
  }
  if (bus.kind === 'boundary') {
    if (bus.externalArea === null) throw new Error(`boundary bus ${bus.id} has no external area`)
    return { ...base, externalArea: bus.externalArea }
  }
  const priceArea = priceAreaOf(bus.location)
  if (bus.kind === 'junction') return { ...base, priceArea }
  if (bus.stationId === null) throw new Error(`${bus.kind} bus ${bus.id} has no station`)
  return { ...base, substationId: bus.stationId, priceArea }
}

export interface BranchCurationLookup {
  /** Curation source ids (`curation:<id>`) that changed this topology branch. */
  readonly ofBranch: (branch: TopologyBranch) => ReadonlyArray<string>
}

export const toGridLine = (branch: TopologyBranch, curations: BranchCurationLookup): GridBranchV2 => {
  if (branch.kind === 'transformer' || branch.lengthKm === null || branch.cableLengthKm === null) throw new Error(`${branch.id} is not a line or cable`)
  const parameters = lineParameters({ nominalKv: branch.nominalKv, lengthKm: branch.lengthKm, cableLengthKm: branch.cableLengthKm, circuits: branch.circuits })
  const curationIds = curations.ofBranch(branch)
  const notes = [
    ...(branch.provenance.note === null ? [] : [branch.provenance.note]),
    `electrical rules ${parameters.ruleIds.join(', ')}`,
  ]
  return {
    id: branch.id,
    label: branch.label,
    kind: branch.kind,
    fromBusId: branch.fromBusId,
    toBusId: branch.toBusId,
    nominalKv: branch.nominalKv,
    lengthKm: roundTo(Math.max(branch.lengthKm, 0.0001), 4),
    circuits: branch.circuits,
    ratingMw: parameters.ratingMw,
    emergencyRatingMw: parameters.emergencyRatingMw,
    emergencyDurationSeconds: parameters.emergencyDurationSeconds,
    reactancePu: roundSignificant(parameters.reactancePu, 6),
    resistancePu: roundSignificant(parameters.resistancePu, 6),
    chargingSusceptancePu: roundSignificant(parameters.chargingSusceptancePu, 6),
    osmWayIds: v2OsmWayIds(branch.osmWayIds),
    provenance: {
      sources: [...branch.provenance.sources, ...curationIds],
      method: curationIds.length > 0 ? 'curated' : 'inferred',
      confidence: capConfidence(branch.provenance.confidence, 'medium'),
      note: notes.join('; '),
    },
  }
}

export interface BusInjections {
  readonly generationMw: (busId: string) => number
  readonly loadMw: (busId: string) => number
}

/** Transformers sized to the line capacity they join (see transformerRule), after injections are known. */
export const toGridTransformer = (branch: TopologyBranch, lines: ReadonlyArray<GridBranchV2>, injections: BusInjections): GridBranchV2 => {
  if (branch.kind !== 'transformer' || branch.lowKv === null) throw new Error(`${branch.id} is not a transformer`)
  const lineCapacity = (busId: string): number => lines
    .filter(line => line.fromBusId === busId || line.toBusId === busId)
    .reduce((sum, line) => sum + line.ratingMw, 0)
  // The topology writes transformers high side first.
  const highBus = branch.fromBusId
  const lowBus = branch.toBusId
  const localMw = Math.max(injections.generationMw(lowBus), injections.loadMw(lowBus))
  // The low-voltage bus passes on what its lines carry plus its own injection.
  const throughMva = Math.min(lineCapacity(highBus), lineCapacity(lowBus) + localMw)
  const inferredMva = Math.max(throughMva, transformerRule.injectionMargin * localMw, transformerRule.stepMva)
  const mapped = branch.ratingMva !== null
  const ratingMva = mapped ? branch.ratingMva! : Math.ceil(inferredMva / transformerRule.stepMva) * transformerRule.stepMva
  const parameters = transformerParameters(ratingMva, branch.circuits)
  const notes = [
    ...(branch.provenance.note === null ? [] : [branch.provenance.note]),
    mapped ? `nameplate ${ratingMva} MVA mapped in OSM; impedance by rule ${transformerRule.id}` : `rating and impedance inferred by rule ${transformerRule.id}`,
  ]
  return {
    id: branch.id,
    label: branch.label,
    kind: 'transformer',
    fromBusId: highBus,
    toBusId: lowBus,
    nominalKv: branch.nominalKv,
    circuits: branch.circuits,
    ratingMw: parameters.ratingMw,
    emergencyRatingMw: parameters.emergencyRatingMw,
    emergencyDurationSeconds: parameters.emergencyDurationSeconds,
    reactancePu: roundSignificant(parameters.reactancePu, 6),
    resistancePu: roundSignificant(parameters.resistancePu, 6),
    chargingSusceptancePu: 0,
    tapRatio: 1,
    osmWayIds: [],
    provenance: {
      sources: [...branch.provenance.sources],
      method: 'inferred',
      confidence: mapped ? 'medium' : 'low',
      note: notes.join('; '),
    },
  }
}

/** Shunt reactors per ≥300 kV bus, absorbing a share of the charging of its connected lines (shuntRule). */
export const inferShunts = (buses: ReadonlyArray<GridBusV2>, lines: ReadonlyArray<GridBranchV2>, osmSourceId: string): ReadonlyArray<GridShuntV2> => {
  const chargingMvar = new Map<string, number>()
  for (const line of lines) {
    if (line.kind === 'transformer' || line.nominalKv < shuntRule.minimumKv) continue
    for (const busId of [line.fromBusId, line.toBusId]) chargingMvar.set(busId, (chargingMvar.get(busId) ?? 0) + line.chargingSusceptancePu * sBaseMva / 2)
  }
  return buses.flatMap((bus): GridShuntV2[] => {
    if (bus.kind === 'boundary' || bus.nominalKv < shuntRule.minimumKv) return []
    const reactorMvar = Math.round(shuntRule.compensatedShare * (chargingMvar.get(bus.id) ?? 0))
    if (reactorMvar < shuntRule.minimumMvar) return []
    return [{
      id: `shunt:${bus.id.slice('bus:'.length)}-1`,
      busId: bus.id,
      mvarAtNominalVoltage: -reactorMvar,
      switchable: true,
      provenance: {
        sources: [osmSourceId],
        method: 'inferred',
        confidence: 'low',
        note: `reactor sized by rule ${shuntRule.id}: ${shuntRule.compensatedShare * 100} % of half the 1-pu charging (${roundTo(chargingMvar.get(bus.id)!, 1)} MVAr) of the connected ≥${shuntRule.minimumKv} kV lines and cables`,
      },
    }]
  })
}
