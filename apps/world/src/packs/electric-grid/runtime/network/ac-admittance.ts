import type { AcNetwork } from './ac-network.ts'

/**
 * Bus admittance matrix Y = G + jB of one island in compressed rows over island-local
 * indices, plus each branch's two-port admittances for end flows. Built once per island
 * structure; phase shifters are not modelled, so Y is symmetric.
 */
export interface IslandAdmittance {
  readonly size: number
  readonly rowStart: Int32Array
  readonly column: Int32Array
  readonly conductance: Float64Array
  readonly susceptance: Float64Array
  /** Position of each row's diagonal entry in `column`. */
  readonly diagonalPosition: Int32Array
  /** Diagonal of Im(Y) from series admittances (with taps) only: no line charging, no bus shunts. */
  readonly seriesSusceptanceDiagonal: Float64Array
  /** Island-local ends of each island branch, aligned with the island's branch list. */
  readonly branchFromLocal: Int32Array
  readonly branchToLocal: Int32Array
  /** Two-port admittances [Yff, Yft, Ytf, Ytt] per branch: real parts in `branchG`, imaginary in `branchB`, 4 per branch. */
  readonly branchG: Float64Array
  readonly branchB: Float64Array
}

const positionInRow = (rowStart: Int32Array, column: Int32Array, row: number, target: number): number => {
  for (let entry = rowStart[row]!; entry < rowStart[row + 1]!; entry += 1) if (column[entry] === target) return entry
  throw new Error(`admittance row ${row} has no entry for column ${target}`)
}

/**
 * Assembles the island's Y. `buses` and `branches` are network indices; `localOfBus` is
 * caller scratch of length `network.busCount` whose contents on return are unspecified.
 */
export const islandAdmittance = (
  network: AcNetwork,
  buses: Int32Array,
  branches: Int32Array,
  localOfBus: Int32Array,
): IslandAdmittance => {
  const size = buses.length
  if (localOfBus.length !== network.busCount) throw new Error(`admittance scratch has ${localOfBus.length} entries for ${network.busCount} buses`)
  for (let local = 0; local < size; local += 1) localOfBus[buses[local]!] = local
  const branchCount = branches.length
  const branchFromLocal = new Int32Array(branchCount)
  const branchToLocal = new Int32Array(branchCount)
  const degree = new Int32Array(size + 1)
  for (let entry = 0; entry < branchCount; entry += 1) {
    const branch = branches[entry]!
    const from = localOfBus[network.branchFrom[branch]!]!
    const to = localOfBus[network.branchTo[branch]!]!
    if (buses[from] !== network.branchFrom[branch] || buses[to] !== network.branchTo[branch]) {
      throw new Error(`island branch ${branch} has an end outside the island's buses`)
    }
    branchFromLocal[entry] = from
    branchToLocal[entry] = to
    degree[from + 1] = degree[from + 1]! + 1
    degree[to + 1] = degree[to + 1]! + 1
  }
  for (let row = 0; row < size; row += 1) degree[row + 1] = degree[row + 1]! + degree[row]!
  const neighbours = new Int32Array(degree[size]!)
  const neighbourFill = degree.slice(0, size)
  for (let entry = 0; entry < branchCount; entry += 1) {
    const from = branchFromLocal[entry]!
    const to = branchToLocal[entry]!
    neighbours[neighbourFill[from]!] = to
    neighbourFill[from] = neighbourFill[from]! + 1
    neighbours[neighbourFill[to]!] = from
    neighbourFill[to] = neighbourFill[to]! + 1
  }
  const rowStart = new Int32Array(size + 1)
  const column = new Int32Array(size + neighbours.length)
  const diagonalPosition = new Int32Array(size)
  const seen = new Int32Array(size).fill(-1)
  let count = 0
  for (let row = 0; row < size; row += 1) {
    diagonalPosition[row] = count
    column[count] = row
    count += 1
    seen[row] = row
    for (let entry = degree[row]!; entry < degree[row + 1]!; entry += 1) {
      const other = neighbours[entry]!
      if (seen[other] === row) continue
      seen[other] = row
      column[count] = other
      count += 1
    }
    rowStart[row + 1] = count
  }
  const compactColumn = column.slice(0, count)
  const conductance = new Float64Array(count)
  const susceptance = new Float64Array(count)
  for (let local = 0; local < size; local += 1) {
    conductance[diagonalPosition[local]!] = network.busShuntConductancePu[buses[local]!]!
    susceptance[diagonalPosition[local]!] = network.busShuntSusceptancePu[buses[local]!]!
  }
  const seriesSusceptanceDiagonal = new Float64Array(size)
  const branchG = new Float64Array(4 * branchCount)
  const branchB = new Float64Array(4 * branchCount)
  for (let entry = 0; entry < branchCount; entry += 1) {
    const branch = branches[entry]!
    const r = network.branchResistancePu[branch]!
    const x = network.branchReactancePu[branch]!
    const halfCharging = network.branchChargingSusceptancePu[branch]! / 2
    const tap = network.branchTapRatio[branch]!
    const impedanceSquared = r * r + x * x
    const seriesG = r / impedanceSquared
    const seriesB = -x / impedanceSquared
    const at = 4 * entry
    branchG[at] = seriesG / (tap * tap)
    branchB[at] = (seriesB + halfCharging) / (tap * tap)
    branchG[at + 1] = -seriesG / tap
    branchB[at + 1] = -seriesB / tap
    branchG[at + 2] = -seriesG / tap
    branchB[at + 2] = -seriesB / tap
    branchG[at + 3] = seriesG
    branchB[at + 3] = seriesB + halfCharging
    const from = branchFromLocal[entry]!
    const to = branchToLocal[entry]!
    seriesSusceptanceDiagonal[from] = seriesSusceptanceDiagonal[from]! + seriesB / (tap * tap)
    seriesSusceptanceDiagonal[to] = seriesSusceptanceDiagonal[to]! + seriesB
    const fromFrom = diagonalPosition[from]!
    const fromTo = positionInRow(rowStart, compactColumn, from, to)
    const toFrom = positionInRow(rowStart, compactColumn, to, from)
    const toTo = diagonalPosition[to]!
    conductance[fromFrom] = conductance[fromFrom]! + branchG[at]!
    susceptance[fromFrom] = susceptance[fromFrom]! + branchB[at]!
    conductance[fromTo] = conductance[fromTo]! + branchG[at + 1]!
    susceptance[fromTo] = susceptance[fromTo]! + branchB[at + 1]!
    conductance[toFrom] = conductance[toFrom]! + branchG[at + 2]!
    susceptance[toFrom] = susceptance[toFrom]! + branchB[at + 2]!
    conductance[toTo] = conductance[toTo]! + branchG[at + 3]!
    susceptance[toTo] = susceptance[toTo]! + branchB[at + 3]!
  }
  return {
    size,
    rowStart,
    column: compactColumn,
    conductance,
    susceptance,
    diagonalPosition,
    seriesSusceptanceDiagonal,
    branchFromLocal,
    branchToLocal,
    branchG,
    branchB,
  }
}
