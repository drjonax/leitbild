import type { LonLat } from './audit-graph.ts'
import { haversineKm, pointToSegmentKm } from './geodesy.ts'

// NVE Nettanlegg5 coverage oracle: how many kilometres of NVE-registered lines have no model
// line within a buffer. Pure function over pre-fetched geometry; fetching and snapshotting the
// NVE layers belongs to the source snapshot step.

export interface NveLine {
  readonly globalId: string
  readonly name: string | null
  readonly voltageKv: number
  readonly parts: ReadonlyArray<ReadonlyArray<LonLat>>
}

export interface NveLineCoverage {
  readonly globalId: string
  readonly name: string | null
  readonly voltageKv: number
  readonly lengthKm: number
  readonly uncoveredKm: number
}

export interface NveCoverage {
  readonly lineCount: number
  readonly totalKm: number
  readonly uncoveredKm: number
  readonly lines: ReadonlyArray<NveLineCoverage>
}

/** Grid cell size in degrees for the segment index; ~1 km north–south. */
const cellDegrees = 0.01

const cellKey = (x: number, y: number): string => `${x},${y}`

const indexSegments = (polylines: ReadonlyArray<ReadonlyArray<LonLat>>, bufferKm: number): ReadonlyMap<string, ReadonlyArray<readonly [LonLat, LonLat]>> => {
  const index = new Map<string, Array<readonly [LonLat, LonLat]>>()
  // One degree of latitude is ~111 km; longitude cells shrink with latitude, so pad generously.
  const padLat = bufferKm / 111
  for (const line of polylines) {
    for (let position = 1; position < line.length; position += 1) {
      const a = line[position - 1]!
      const b = line[position]!
      const padLon = padLat / Math.max(0.1, Math.cos((a[1] * Math.PI) / 180))
      const minX = Math.floor((Math.min(a[0], b[0]) - padLon) / cellDegrees)
      const maxX = Math.floor((Math.max(a[0], b[0]) + padLon) / cellDegrees)
      const minY = Math.floor((Math.min(a[1], b[1]) - padLat) / cellDegrees)
      const maxY = Math.floor((Math.max(a[1], b[1]) + padLat) / cellDegrees)
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = cellKey(x, y)
          const bucket = index.get(key)
          if (bucket) bucket.push([a, b])
          else index.set(key, [[a, b]])
        }
      }
    }
  }
  return index
}

/**
 * Measures NVE lines at or above `minKv` against model polylines. An NVE span counts as covered
 * when both of its vertices lie within `bufferKm` of a model segment.
 */
export const measureNveCoverage = (
  nveLines: ReadonlyArray<NveLine>,
  modelPolylines: ReadonlyArray<ReadonlyArray<LonLat>>,
  options: { readonly minKv: number; readonly bufferKm: number },
): NveCoverage => {
  const index = indexSegments(modelPolylines, options.bufferKm)
  const covered = (point: LonLat): boolean => {
    const bucket = index.get(cellKey(Math.floor(point[0] / cellDegrees), Math.floor(point[1] / cellDegrees))) ?? []
    return bucket.some(([a, b]) => pointToSegmentKm(point, a, b) <= options.bufferKm)
  }
  const lines = nveLines
    .filter(line => line.voltageKv >= options.minKv)
    .map((line): NveLineCoverage => {
      let lengthKm = 0
      let uncoveredKm = 0
      for (const part of line.parts) {
        let previousCovered = part.length > 0 ? covered(part[0]!) : false
        for (let position = 1; position < part.length; position += 1) {
          const span = haversineKm(part[position - 1]!, part[position]!)
          const currentCovered = covered(part[position]!)
          lengthKm += span
          if (!(previousCovered && currentCovered)) uncoveredKm += span
          previousCovered = currentCovered
        }
      }
      return { globalId: line.globalId, name: line.name, voltageKv: line.voltageKv, lengthKm, uncoveredKm }
    })
    .sort((left, right) => right.uncoveredKm - left.uncoveredKm || (left.globalId < right.globalId ? -1 : 1))
  return {
    lineCount: lines.length,
    totalKm: lines.reduce((sum, line) => sum + line.lengthKm, 0),
    uncoveredKm: lines.reduce((sum, line) => sum + line.uncoveredKm, 0),
    lines,
  }
}
