import { minimumDegreeOrdering, type SymmetricPattern } from './ordering.ts'
import {
  factorSparseCholesky,
  sparseCholeskyStructure,
  type PermutedSymmetricMatrix,
  type SparseCholeskyFactor,
  type SparseCholeskyStructure,
} from './sparse-cholesky.ts'

/**
 * A symmetric matrix as its diagonal plus off-diagonal couplings (a, b, value) with a ≠ b,
 * each coupling standing for both (a, b) and (b, a). Repeated pairs are summed.
 */
export interface SymmetricCouplings {
  readonly size: number
  readonly diagonal: Float64Array
  readonly entryA: Int32Array
  readonly entryB: Int32Array
  readonly entryValue: Float64Array
}

const couplingPattern = (matrix: SymmetricCouplings): SymmetricPattern => {
  const { size, entryA, entryB } = matrix
  const degree = new Int32Array(size + 1)
  for (let entry = 0; entry < entryA.length; entry += 1) {
    const a = entryA[entry]!
    const b = entryB[entry]!
    if (a === b || a < 0 || b < 0 || a >= size || b >= size) throw new Error(`symmetric coupling ${entry} (${a}, ${b}) is outside 0..${size - 1} or on the diagonal`)
    degree[a + 1] = degree[a + 1]! + 1
    degree[b + 1] = degree[b + 1]! + 1
  }
  for (let vertex = 0; vertex < size; vertex += 1) degree[vertex + 1] = degree[vertex + 1]! + degree[vertex]!
  const listed = new Int32Array(degree[size]!)
  const fill = degree.slice(0, size)
  for (let entry = 0; entry < entryA.length; entry += 1) {
    const a = entryA[entry]!
    const b = entryB[entry]!
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

/** The matrix in the structure's permuted numbering: strictly-lower entries grouped by column, repeated pairs summed. */
const permutedMatrix = (matrix: SymmetricCouplings, iperm: Int32Array): PermutedSymmetricMatrix => {
  const { size, entryA, entryB, entryValue } = matrix
  const diagonal = new Float64Array(size)
  for (let vertex = 0; vertex < size; vertex += 1) diagonal[iperm[vertex]!] = matrix.diagonal[vertex]!
  const columnCount = new Int32Array(size + 1)
  for (let entry = 0; entry < entryA.length; entry += 1) {
    const column = Math.min(iperm[entryA[entry]!]!, iperm[entryB[entry]!]!)
    columnCount[column + 1] = columnCount[column + 1]! + 1
  }
  for (let column = 0; column < size; column += 1) columnCount[column + 1] = columnCount[column + 1]! + columnCount[column]!
  const byColumn = new Int32Array(columnCount[size]!)
  const fill = columnCount.slice(0, size)
  for (let entry = 0; entry < entryA.length; entry += 1) {
    const column = Math.min(iperm[entryA[entry]!]!, iperm[entryB[entry]!]!)
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
      const row = Math.max(iperm[entryA[entry]!]!, iperm[entryB[entry]!]!)
      let slot = slotOfRow[row]!
      if (slot < first) {
        slot = count
        slotOfRow[row] = slot
        lowerRow[slot] = row
        count += 1
      }
      lowerValue[slot] = lowerValue[slot]! + entryValue[entry]!
    }
    lowerStart[column + 1] = count
  }
  return { diagonal, lowerStart, lowerRow: lowerRow.slice(0, count), lowerValue: lowerValue.slice(0, count) }
}

/** Minimum-degree ordering and symbolic Cholesky structure for a symmetric matrix's sparsity pattern. */
export const symmetricFactorStructure = (matrix: SymmetricCouplings): SparseCholeskyStructure =>
  sparseCholeskyStructure(minimumDegreeOrdering(couplingPattern(matrix)))

/**
 * Numeric Cholesky factor of a symmetric positive definite matrix on a structure from
 * `symmetricFactorStructure` of the same pattern. Throws, naming the vertex, when a pivot is
 * not strictly positive (`nameOf` receives the unpermuted vertex).
 */
export const factorSymmetricMatrix = (
  structure: SparseCholeskyStructure,
  matrix: SymmetricCouplings,
  subject: string,
  nameOf: (vertex: number) => string,
): SparseCholeskyFactor => {
  if (structure.size !== matrix.size) throw new Error(`${subject}: structure of size ${structure.size} for a matrix of size ${matrix.size}`)
  return factorSparseCholesky(structure, permutedMatrix(matrix, structure.iperm), subject, nameOf)
}
