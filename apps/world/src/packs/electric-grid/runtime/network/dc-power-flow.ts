import type { GridBranchDefinition } from '../../grid-model.ts'
import type { CompiledGridNetwork } from './compiled-network.ts'
import { minimumDegreeOrdering, type SymmetricPattern } from './ordering.ts'
import {
  factorSparseCholesky,
  solveSparseCholesky,
  sparseCholeskyStructure,
  type PermutedSymmetricMatrix,
  type SparseCholeskyFactor,
} from './sparse-cholesky.ts'

/**
 * The DC power-flow system of one island. Its first (lowest-index) bus is the angle
 * reference: its row is dropped, so it would absorb any injection mismatch; the Grid's
 * injections balance each island by construction and the solve's returned sum is checked.
 * The reduced susceptance matrix over the remaining buses is factorised once per structure.
 */
export interface GridIslandSystem {
  readonly islandId: string
  /** Bus indices, ascending; `buses[0]` is the reference bus and reduced index r is `buses[r + 1]`. */
  readonly buses: Int32Array
  /** Closed branch indices inside the island, ascending. */
  readonly branches: Int32Array
  readonly factor: SparseCholeskyFactor
  readonly rhs: Float64Array
  readonly solution: Float64Array
}

/** Reduced indices of each island branch's ends (-1 at the reference bus); `localOfBus` is caller scratch indexed by bus. */
const reducedBranchEnds = (network: CompiledGridNetwork, buses: Int32Array, branches: Int32Array, localOfBus: Int32Array) => {
  for (let local = 0; local < buses.length; local += 1) localOfBus[buses[local]!] = local - 1
  const endA = new Int32Array(branches.length)
  const endB = new Int32Array(branches.length)
  for (let entry = 0; entry < branches.length; entry += 1) {
    endA[entry] = localOfBus[network.branchFrom[branches[entry]!]!]!
    endB[entry] = localOfBus[network.branchTo[branches[entry]!]!]!
  }
  return { endA, endB }
}

/** Symmetric pattern of the reduced matrix; parallel circuits share one off-diagonal entry. */
const reducedPattern = (size: number, endA: Int32Array, endB: Int32Array): SymmetricPattern => {
  const degree = new Int32Array(size + 1)
  for (let entry = 0; entry < endA.length; entry += 1) {
    const a = endA[entry]!
    const b = endB[entry]!
    if (a < 0 || b < 0) continue
    degree[a + 1] = degree[a + 1]! + 1
    degree[b + 1] = degree[b + 1]! + 1
  }
  for (let vertex = 0; vertex < size; vertex += 1) degree[vertex + 1] = degree[vertex + 1]! + degree[vertex]!
  const listed = new Int32Array(degree[size]!)
  const fill = degree.slice(0, size)
  for (let entry = 0; entry < endA.length; entry += 1) {
    const a = endA[entry]!
    const b = endB[entry]!
    if (a < 0 || b < 0) continue
    listed[fill[a]!] = b
    fill[a] = fill[a]! + 1
    listed[fill[b]!] = a
    fill[b] = fill[b]! + 1
  }
  const start = new Int32Array(size + 1)
  const adjacency = new Int32Array(listed.length)
  const seen = new Int32Array(size).fill(-1)
  let count = 0
  for (let vertex = 0; vertex < size; vertex += 1) {
    for (let entry = degree[vertex]!; entry < degree[vertex + 1]!; entry += 1) {
      const other = listed[entry]!
      if (seen[other] === vertex) continue
      seen[other] = vertex
      adjacency[count] = other
      count += 1
    }
    start[vertex + 1] = count
  }
  return { size, start, adjacency: adjacency.slice(0, count) }
}

/** Assembles the reduced B matrix in the factor's permuted numbering, summing parallel circuits. */
const permutedSusceptanceMatrix = (
  susceptancePu: Float64Array,
  size: number,
  iperm: Int32Array,
  endA: Int32Array,
  endB: Int32Array,
): PermutedSymmetricMatrix => {
  const diagonal = new Float64Array(size)
  const columnCount = new Int32Array(size + 1)
  for (let entry = 0; entry < endA.length; entry += 1) {
    const a = endA[entry]!
    const b = endB[entry]!
    if (a < 0 || b < 0) continue
    const column = Math.min(iperm[a]!, iperm[b]!)
    columnCount[column + 1] = columnCount[column + 1]! + 1
  }
  for (let column = 0; column < size; column += 1) columnCount[column + 1] = columnCount[column + 1]! + columnCount[column]!
  const byColumn = new Int32Array(columnCount[size]!)
  const fill = columnCount.slice(0, size)
  for (let entry = 0; entry < endA.length; entry += 1) {
    const a = endA[entry]!
    const b = endB[entry]!
    const susceptance = susceptancePu[entry]!
    if (a >= 0) diagonal[iperm[a]!] = diagonal[iperm[a]!]! + susceptance
    if (b >= 0) diagonal[iperm[b]!] = diagonal[iperm[b]!]! + susceptance
    if (a < 0 || b < 0) continue
    const column = Math.min(iperm[a]!, iperm[b]!)
    byColumn[fill[column]!] = entry
    fill[column] = fill[column]! + 1
  }
  const lowerStart = new Int32Array(size + 1)
  const lowerRow = new Int32Array(byColumn.length)
  const lowerValue = new Float64Array(byColumn.length)
  const slotOfRow = new Int32Array(size).fill(-1)
  let count = 0
  for (let column = 0; column < size; column += 1) {
    const first = count
    for (let position = columnCount[column]!; position < columnCount[column + 1]!; position += 1) {
      const entry = byColumn[position]!
      const row = Math.max(iperm[endA[entry]!]!, iperm[endB[entry]!]!)
      let slot = slotOfRow[row]!
      if (slot < first) {
        slot = count
        slotOfRow[row] = slot
        lowerRow[slot] = row
        count += 1
      }
      lowerValue[slot] = lowerValue[slot]! - susceptancePu[entry]!
    }
    lowerStart[column + 1] = count
  }
  return { diagonal, lowerStart, lowerRow: lowerRow.slice(0, count), lowerValue: lowerValue.slice(0, count) }
}

/**
 * Orders, analyses and factorises one island's reduced susceptance matrix. `localOfBus`
 * is scratch of length `network.busCount`; its contents on return are unspecified.
 */
export const createGridIslandSystem = (config: {
  readonly network: CompiledGridNetwork
  readonly islandId: string
  readonly buses: Int32Array
  readonly branches: Int32Array
  readonly localOfBus: Int32Array
}): GridIslandSystem => {
  const { network, islandId, buses, branches } = config
  if (buses.length === 0) throw new Error(`Grid island ${islandId} has no buses`)
  const size = buses.length - 1
  const { endA, endB } = reducedBranchEnds(network, buses, branches, config.localOfBus)
  const ordering = minimumDegreeOrdering(reducedPattern(size, endA, endB))
  const structure = sparseCholeskyStructure(ordering)
  const susceptancePu = Float64Array.from(branches, branch => network.branchSusceptancePu[branch]!)
  const matrix = permutedSusceptanceMatrix(susceptancePu, size, ordering.iperm, endA, endB)
  const factor = factorSparseCholesky(
    structure,
    matrix,
    `Grid island ${islandId} susceptance matrix`,
    vertex => `bus ${network.busIds[buses[vertex + 1]!]!}`,
  )
  return { islandId, buses, branches, factor, rhs: new Float64Array(size), solution: new Float64Array(size) }
}

/**
 * Solves B·θ = P/S_base for one island: writes bus angles in radians (reference bus 0)
 * and returns the MW its reference bus absorbs, the sum of the island's scheduled injections.
 */
export const solveGridIslandInto = (
  network: CompiledGridNetwork,
  system: GridIslandSystem,
  injectionsMw: Float64Array,
  anglesRad: Float64Array,
): number => {
  const { buses, rhs, solution } = system
  const reference = buses[0]!
  let mismatchMw = injectionsMw[reference]!
  for (let reduced = 0; reduced < rhs.length; reduced += 1) {
    const injectionMw = injectionsMw[buses[reduced + 1]!]!
    mismatchMw += injectionMw
    rhs[reduced] = injectionMw / network.sBaseMva
  }
  solveSparseCholesky(system.factor, rhs, solution)
  anglesRad[reference] = 0
  for (let reduced = 0; reduced < solution.length; reduced += 1) anglesRad[buses[reduced + 1]!] = solution[reduced]!
  return mismatchMw
}

/** DC flow from the from-bus to the to-bus in MW: (θ_from − θ_to)·S_base / x, angles in radians. */
export const gridBranchFlowMw = (anglesRad: ReadonlyMap<string, number>, branch: GridBranchDefinition, sBaseMva: number): number => {
  const from = anglesRad.get(branch.fromBusId)
  const to = anglesRad.get(branch.toBusId)
  if (from === undefined || to === undefined) throw new Error(`branch ${branch.id} has no solved angle at ${from === undefined ? branch.fromBusId : branch.toBusId}`)
  return (from - to) * sBaseMva / branch.reactancePu
}

/** Indexed DC flows in MW for every branch; open branches carry 0. */
export const gridBranchFlowsMwInto = (
  network: CompiledGridNetwork,
  closedBranches: Uint8Array,
  anglesRad: Float64Array,
  flowsMw: Float64Array,
): void => {
  for (let branch = 0; branch < network.branchCount; branch += 1) {
    flowsMw[branch] = closedBranches[branch] === 1
      ? (anglesRad[network.branchFrom[branch]!]! - anglesRad[network.branchTo[branch]!]!) * network.sBaseMva * network.branchSusceptancePu[branch]!
      : 0
  }
}
