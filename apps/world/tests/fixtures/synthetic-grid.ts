// Deterministic synthetic transmission-like grids for network performance budgets.
// A random geometric graph over a Norway-sized box: a spatially local spanning
// tree plus nearest-neighbour meshing up to about 1.4 branches per bus, so the
// fill of a sparse factorisation resembles a real transmission network.
import { nordicFrequencyAutomationRef } from '../../src/packs/electric-grid/definition-refs.ts'
import { compileGridModelIndex, gridAutomationPreset } from '../../src/packs/electric-grid/definitions.ts'
import type {
  CompiledGridDefinition,
  GridBranchDefinition,
  GridBusDefinition,
  GridDemandProfileDefinition,
  GridGeneratorDefinition,
  GridLoadDefinition,
  GridModelDefinition,
} from '../../src/packs/electric-grid/grid-model.ts'

const fixtureProvenance = (note: string): GridDemandProfileDefinition['provenance'] => ({ sources: ['test:hand-built'], method: 'curated', confidence: 'high', note })

/** Constant demand over the day and week: a test sees only the demand it sets. */
export const flatDemandProfile: GridDemandProfileDefinition = {
  id: 'demand-profile:flat',
  label: 'Flat (test fixture)',
  weekday: Array.from({ length: 24 }, () => 1),
  weekend: Array.from({ length: 24 }, () => 1),
  series: null,
  provenance: fixtureProvenance('Test fixture: constant demand.'),
}

/**
 * A declared day with a night trough, a morning rise and an evening peak, weekends 10 % lower:
 * demand moves at every demand sample, as measured profiles move it (values: test fixture).
 */
export const declaredDailyProfile: GridDemandProfileDefinition = {
  id: 'demand-profile:declared-daily',
  label: 'Declared daily shape (test fixture)',
  weekday: [0.86, 0.84, 0.83, 0.82, 0.82, 0.84, 0.9, 0.97, 1, 1, 0.99, 0.98, 0.97, 0.96, 0.96, 0.97, 1, 1.02, 1.01, 0.99, 0.97, 0.95, 0.92, 0.89],
  weekend: [0.79, 0.77, 0.76, 0.75, 0.74, 0.74, 0.76, 0.8, 0.85, 0.89, 0.9, 0.9, 0.89, 0.88, 0.88, 0.89, 0.91, 0.93, 0.92, 0.9, 0.88, 0.86, 0.83, 0.81],
  series: null,
  provenance: fixtureProvenance('Test fixture: a declared daily shape, not measured.'),
}

/** A hand-built test Model: the given assets on a 100 MVA base with nothing else; its loads are flat unless they name another profile. */
export const handBuiltModel = (model: Pick<GridModelDefinition, 'id' | 'title' | 'description' | 'buses' | 'branches' | 'generators' | 'loads'> & Partial<GridModelDefinition>): GridModelDefinition => ({
  demandProfiles: [flatDemandProfile],
  nominalFrequencyHz: 50,
  sBaseMva: 100,
  fidelity: { powerFlow: 'ac-fdlf-or-dc', voltage: 'ac-fdlf', frequency: 'island-swing', recommendedMaximumBusCount: 1000 },
  sourceBuild: { id: 'hand-built-test', generatedAt: '2026-10-10T00:00:00.000Z' },
  sourceIds: [],
  shunts: [],
  storage: [],
  connectionPoints: [],
  externalSystems: [],
  hvdcLinks: [],
  hvdcRampGroups: [],
  ...model,
})

/** A test line without charging; parameters for all circuits together. */
export const testLine = (branch: Pick<GridBranchDefinition, 'id' | 'fromBusId' | 'toBusId' | 'nominalKv' | 'ratingMw' | 'reactancePu' | 'resistancePu'> & Partial<GridBranchDefinition>): GridBranchDefinition => ({
  label: branch.id,
  kind: 'ac_line',
  lengthKm: 50,
  circuits: 1,
  emergencyRatingMw: branch.ratingMw,
  emergencyDurationSeconds: 900,
  chargingSusceptancePu: 0,
  ...branch,
})

/** A test load at unity power factor and flat demand, not critical and with nothing interruptible. */
export const testLoad = (load: Pick<GridLoadDefinition, 'id' | 'busId' | 'demandMw'> & Partial<GridLoadDefinition>): GridLoadDefinition => ({
  label: load.id,
  demandProfileId: flatDemandProfile.id,
  kind: 'industry',
  location: [10, 60],
  criticalMw: 0,
  powerFactor: 1,
  priority: 'normal',
  interruptibleMw: 0,
  networkLossMw: 0,
  ...load,
})

const linearCongruential = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const branchesPerBus = 1.4

/**
 * A synchronous hydro unit with Grid Model v2 machine data: H 3 s on rated MVA at power factor 0.9
 * (Kundur Table 3.2 midpoint; NVF 2025 cos φ), 10 % minimum stable output, a 22 %/min ramp.
 */
export const syntheticHydroUnit = (unit: Pick<GridGeneratorDefinition, 'id' | 'label' | 'busId' | 'location' | 'capacityMw'> & Partial<GridGeneratorDefinition>): GridGeneratorDefinition => ({
  kind: 'hydro',
  ratedMva: unit.capacityMw / 0.9,
  powerFactor: 0.9,
  voltageSetpointPu: 1,
  inertiaSeconds: 3,
  synchronous: true,
  minimumStableMw: unit.capacityMw * 0.1,
  blackStartCapable: false,
  rampRateMwPerMinute: unit.capacityMw * 0.22,
  availableMw: unit.capacityMw,
  initialState: 'online',
  initialTargetMw: null,
  ...unit,
})
const voltageClassesKv = [132, 300, 420] as const

// The fixture puts 400 MW units on buses of every voltage class, so its intact base case loads
// 132 kV lines up to 5.4 times a single circuit's rating. Ratings are the class ratings times the
// smallest whole multiple that leaves every branch of the 10k-bus case below its continuous rating
// (highest loading 89 %), so the fixture as shipped is a steady grid rather than a relay cascade.
const ratingMultiple = 6

const branchFor = (index: number, from: GridBusDefinition, to: GridBusDefinition): GridBranchDefinition => {
  const kv = Math.min(from.nominalKv, to.nominalKv)
  // Rough corridor length from degree offsets at ~60° N (km per degree of longitude/latitude).
  const lengthKm = Math.max(1, Math.hypot((from.location[0] - to.location[0]) * 55, (from.location[1] - to.location[1]) * 111))
  // Typical overhead-line Ω/km per voltage class, converted to per unit on 100 MVA (x = Ω·100/kV²).
  const ohmPerKm = kv >= 400 ? 0.3 : kv >= 300 ? 0.33 : 0.4
  const resistanceOhmPerKm = kv >= 400 ? 0.03 : kv >= 300 ? 0.04 : 0.1
  return {
    id: `L${index}`,
    label: `Line ${index}`,
    kind: 'ac_line',
    fromBusId: from.id,
    toBusId: to.id,
    nominalKv: kv,
    ratingMw: (kv >= 400 ? 1800 : kv >= 300 ? 900 : 200) * ratingMultiple,
    emergencyRatingMw: (kv >= 400 ? 2100 : kv >= 300 ? 1050 : 240) * ratingMultiple,
    lengthKm,
    circuits: 1,
    emergencyDurationSeconds: 900,
    reactancePu: Math.max(1e-4, ohmPerKm * lengthKm * 100 / kv ** 2),
    resistancePu: Math.max(1e-5, resistanceOhmPerKm * lengthKm * 100 / kv ** 2),
    // Typical overhead-line charging, µS/km per voltage class, as B = µS·kV²/100 MVA.
    chargingSusceptancePu: (kv >= 400 ? 4 : kv >= 300 ? 3.8 : 2.8) * 1e-6 * lengthKm * kv ** 2 / 100,
  }
}

export const syntheticGridModel = (busCount: number, seed = 7): GridModelDefinition => {
  if (!Number.isInteger(busCount) || busCount < 2) throw new Error(`synthetic grid needs at least 2 buses, got ${busCount}`)
  const random = linearCongruential(seed)
  const points = Array.from({ length: busCount }, () => [5 + random() * 25, 58 + random() * 13] as const)
  const buses: GridBusDefinition[] = points.map((location, index) => ({
    id: `B${index}`,
    label: `Bus ${index}`,
    kind: 'substation',
    nominalKv: voltageClassesKv[index % voltageClassesKv.length]!,
    location,
  }))
  const cellSize = Math.sqrt((25 * 13) / busCount) * 1.5
  const cellKey = (x: number, y: number): string => `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`
  const cells = new Map<string, number[]>()
  points.forEach((point, index) => {
    const key = cellKey(point[0], point[1])
    const members = cells.get(key)
    if (members) members.push(index)
    else cells.set(key, [index])
  })
  const nearest = (index: number, count: number): ReadonlyArray<number> => {
    const [x, y] = points[index]!
    const cellX = Math.floor(x / cellSize)
    const cellY = Math.floor(y / cellSize)
    const candidates: Array<readonly [number, number]> = []
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (const other of cells.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
          if (other !== index) candidates.push([other, (points[other]![0] - x) ** 2 + (points[other]![1] - y) ** 2])
        }
      }
    }
    return candidates.sort((a, b) => a[1] - b[1]).slice(0, count).map(candidate => candidate[0])
  }
  const edges = new Set<string>()
  const branches: GridBranchDefinition[] = []
  const connect = (a: number, b: number): void => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    if (a === b || edges.has(key)) return
    edges.add(key)
    branches.push(branchFor(branches.length, buses[a]!, buses[b]!))
  }
  // Spanning tree with spatial locality: visit buses in snake cell order and link
  // each to its nearest bus among the previous 60 visited.
  const visitOrder = points.map((_, index) => index).sort((a, b) => {
    const rowA = Math.floor(points[a]![1] / cellSize)
    const rowB = Math.floor(points[b]![1] / cellSize)
    if (rowA !== rowB) return rowA - rowB
    return rowA % 2 === 0 ? points[a]![0] - points[b]![0] : points[b]![0] - points[a]![0]
  })
  for (let position = 1; position < busCount; position += 1) {
    const bus = visitOrder[position]!
    let best = visitOrder[position - 1]!
    let bestDistance = Infinity
    for (let window = Math.max(0, position - 60); window < position; window += 1) {
      const other = visitOrder[window]!
      const distance = (points[other]![0] - points[bus]![0]) ** 2 + (points[other]![1] - points[bus]![1]) ** 2
      if (distance < bestDistance) {
        bestDistance = distance
        best = other
      }
    }
    connect(bus, best)
  }
  let cursor = 0
  while (branches.length < Math.round(branchesPerBus * busCount)) {
    const neighbours = nearest(cursor % busCount, 4)
    connect(cursor % busCount, neighbours[Math.floor(random() * neighbours.length)]!)
    cursor += 7
  }
  const generators: GridGeneratorDefinition[] = []
  const loads: GridLoadDefinition[] = []
  for (let index = 0; index < busCount; index += 1) {
    if (index % 4 === 0) {
      generators.push(syntheticHydroUnit({ id: `G${index}`, label: `Generator ${index}`, busId: `B${index}`, location: points[index]!, capacityMw: 400, availableMw: 380 }))
    }
    if (index % 5 === 1) {
      loads.push({
        id: `D${index}`, label: `Load ${index}`, kind: 'residential', busId: `B${index}`, location: points[index]!,
        // Q/P = 0.25 (40 Mvar at 160 MW): cos φ = 1/√1.0625.
        demandMw: 160, demandProfileId: declaredDailyProfile.id, criticalMw: 30, powerFactor: 1 / Math.sqrt(1.0625), priority: 'normal', interruptibleMw: 0, networkLossMw: 0,
      })
    }
  }
  return {
    id: `synthetic-${busCount}`,
    title: `Synthetic ${busCount}-bus grid`,
    description: 'Deterministic synthetic grid for network performance tests',
    nominalFrequencyHz: 50,
    sBaseMva: 100,
    fidelity: { powerFlow: 'ac-fdlf-or-dc', voltage: 'ac-fdlf', frequency: 'island-swing', recommendedMaximumBusCount: 1000 },
    sourceBuild: { id: 'synthetic', generatedAt: '2026-10-10T00:00:00.000Z' },
    sourceIds: [],
    buses,
    branches,
    shunts: [],
    generators,
    loads,
    demandProfiles: [declaredDailyProfile],
    storage: [],
    connectionPoints: [],
    externalSystems: [],
    hvdcLinks: [],
    hvdcRampGroups: [],
  }
}

/** A runnable Grid Definition for a hand-built or synthetic Model, with neutral operating point and automation. */
export const gridDefinitionForModel = (model: GridModelDefinition): CompiledGridDefinition => ({
  gridId: `grid:${model.id}`,
  model,
  index: compileGridModelIndex(model),
  operatingPoint: {
    id: 'synthetic', title: 'Synthetic', loadScale: 1, generationAvailabilityScale: 1, storageStateOfCharge: 0.5,
    hvdcSetpoints: model.hvdcLinks.map(link => ({ linkId: link.id, setpointMw: 0 })),
    // No exchange: one border per participating area, each at 0 MW.
    externalExchanges: model.externalSystems.filter(system => system.synchronous).map(system => ({
      systemId: system.id,
      scheduledExportMw: 0,
      borders: (system.areaParticipation ?? []).map(entry => ({ label: entry.area, boundaryBusIds: [...entry.boundaryBusIds], scheduledExportMw: 0 })),
    })),
    branchStates: model.branches.map(branch => ({ branchId: branch.id, state: 'closed' as const, availability: 1 })),
  },
  automation: gridAutomationPreset(nordicFrequencyAutomationRef),
  definitionDigest: '0'.repeat(64),
})

export const syntheticGridDefinition = (busCount: number, seed = 7): CompiledGridDefinition =>
  gridDefinitionForModel(syntheticGridModel(busCount, seed))
