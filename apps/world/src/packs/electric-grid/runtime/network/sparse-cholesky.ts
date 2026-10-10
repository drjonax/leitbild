import type { EliminationOrdering } from './ordering.ts'

/** Pattern of L in compressed columns over permuted indices; each column starts with its diagonal and its rows ascend. */
export interface SparseCholeskyStructure {
  readonly size: number
  readonly perm: Int32Array
  readonly iperm: Int32Array
  readonly columnStart: Int32Array
  readonly rowIndex: Int32Array
  /** Columns k < j with L(j, k) ≠ 0 for row j: `rowColumns[rowStart[j] .. rowStart[j + 1])`, ascending. */
  readonly rowStart: Int32Array
  readonly rowColumns: Int32Array
}

/** A symmetric matrix in permuted indices: the diagonal plus strictly-lower entries per column (row > column). */
export interface PermutedSymmetricMatrix {
  readonly diagonal: Float64Array
  readonly lowerStart: Int32Array
  readonly lowerRow: Int32Array
  readonly lowerValue: Float64Array
}

export interface SparseCholeskyFactor {
  readonly structure: SparseCholeskyStructure
  /** Values of L aligned with `structure.rowIndex`. */
  readonly values: Float64Array
  /** Preallocated work vector for the triangular solves. */
  readonly work: Float64Array
}

export const sparseCholeskyStructure = (ordering: EliminationOrdering): SparseCholeskyStructure => {
  const { size, perm, iperm, patternStart, pattern } = ordering
  const columnStart = new Int32Array(size + 1)
  for (let column = 0; column < size; column += 1) {
    columnStart[column + 1] = columnStart[column]! + 1 + patternStart[column + 1]! - patternStart[column]!
  }
  const rowIndex = new Int32Array(columnStart[size]!)
  const rowCount = new Int32Array(size + 1)
  for (let column = 0; column < size; column += 1) {
    const first = columnStart[column]!
    rowIndex[first] = column
    let at = first + 1
    for (let entry = patternStart[column]!; entry < patternStart[column + 1]!; entry += 1) {
      const row = iperm[pattern[entry]!]!
      if (row <= column) throw new Error(`elimination pattern of step ${column} lists an earlier step ${row}`)
      rowIndex[at] = row
      rowCount[row + 1] = rowCount[row + 1]! + 1
      at += 1
    }
    rowIndex.subarray(first + 1, at).sort()
  }
  const rowStart = rowCount
  for (let row = 0; row < size; row += 1) rowStart[row + 1] = rowStart[row + 1]! + rowStart[row]!
  const rowColumns = new Int32Array(rowStart[size]!)
  const rowFill = rowStart.slice(0, size)
  for (let column = 0; column < size; column += 1) {
    for (let entry = columnStart[column]! + 1; entry < columnStart[column + 1]!; entry += 1) {
      const row = rowIndex[entry]!
      rowColumns[rowFill[row]!] = column
      rowFill[row] = rowFill[row]! + 1
    }
  }
  return { size, perm, iperm, columnStart, rowIndex, rowStart, rowColumns }
}

/**
 * Left-looking numeric Cholesky A = L·Lᵀ on a precomputed pattern. A pivot that is not
 * strictly positive means A is not positive definite; it throws naming the vertex
 * (`nameOf` receives the vertex in original, unpermuted numbering).
 */
export const factorSparseCholesky = (
  structure: SparseCholeskyStructure,
  matrix: PermutedSymmetricMatrix,
  subject: string,
  nameOf: (vertex: number) => string,
): SparseCholeskyFactor => {
  const { size, perm, columnStart, rowIndex, rowStart, rowColumns } = structure
  const values = new Float64Array(rowIndex.length)
  const nextEntry = new Int32Array(size)
  for (let column = 0; column < size; column += 1) nextEntry[column] = columnStart[column]! + 1
  const accumulator = new Float64Array(size)
  for (let column = 0; column < size; column += 1) {
    const first = columnStart[column]!
    const end = columnStart[column + 1]!
    accumulator[column] = matrix.diagonal[column]!
    for (let entry = first + 1; entry < end; entry += 1) accumulator[rowIndex[entry]!] = 0
    for (let entry = matrix.lowerStart[column]!; entry < matrix.lowerStart[column + 1]!; entry += 1) {
      const row = matrix.lowerRow[entry]!
      accumulator[row] = accumulator[row]! + matrix.lowerValue[entry]!
    }
    for (let link = rowStart[column]!; link < rowStart[column + 1]!; link += 1) {
      const source = rowColumns[link]!
      const at = nextEntry[source]!
      const multiplier = values[at]!
      for (let entry = at; entry < columnStart[source + 1]!; entry += 1) {
        const row = rowIndex[entry]!
        accumulator[row] = accumulator[row]! - values[entry]! * multiplier
      }
      nextEntry[source] = at + 1
    }
    const pivot = accumulator[column]!
    if (!(pivot > 0)) throw new Error(`${subject} is not positive definite: pivot ${pivot} at ${nameOf(perm[column]!)}`)
    const diagonal = Math.sqrt(pivot)
    values[first] = diagonal
    for (let entry = first + 1; entry < end; entry += 1) values[entry] = accumulator[rowIndex[entry]!]! / diagonal
  }
  return { structure, values, work: new Float64Array(size) }
}

/** Solves A·x = b with b and x in original numbering, using the factor's preallocated work vector. */
export const solveSparseCholesky = (factor: SparseCholeskyFactor, rhs: Float64Array, solution: Float64Array): void => {
  const { size, perm, columnStart, rowIndex } = factor.structure
  const { values, work } = factor
  if (rhs.length !== size || solution.length !== size) throw new Error(`sparse solve expects vectors of length ${size}`)
  for (let step = 0; step < size; step += 1) work[step] = rhs[perm[step]!]!
  for (let column = 0; column < size; column += 1) {
    const value = work[column]! / values[columnStart[column]!]!
    work[column] = value
    for (let entry = columnStart[column]! + 1; entry < columnStart[column + 1]!; entry += 1) {
      const row = rowIndex[entry]!
      work[row] = work[row]! - values[entry]! * value
    }
  }
  for (let column = size - 1; column >= 0; column -= 1) {
    let value = work[column]!
    for (let entry = columnStart[column]! + 1; entry < columnStart[column + 1]!; entry += 1) value -= values[entry]! * work[rowIndex[entry]!]!
    work[column] = value / values[columnStart[column]!]!
  }
  for (let step = 0; step < size; step += 1) solution[perm[step]!] = work[step]!
}
